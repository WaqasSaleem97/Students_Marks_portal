import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Window } from "happy-dom";
import * as helpers from "../public/registration-ranges.js";
import * as authHelpers from "../public/auth-flow.js";

const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8").replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "");
const styles = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(saved = [], options = {}) {
  const window = new Window({settings: {enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true}});
  window.document.write(html);
  Object.defineProperty(window.navigator, "userAgent", {configurable: true, value: options.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/140"});
  // Happy DOM omits the browser's Option convenience constructor.
  window.Option = function Option(text, value) { const option = window.document.createElement("option"); option.textContent = text; option.value = value; return option; };
  const data = new Map(saved.map(range => [range.prefix, {...range}]));
  const enrollmentData = new Map((options.enrollments || []).map(item => [item.id, {...item}]));
  const writes = []; const confirmations = []; const popupCalls = []; const redirectCalls = []; let listener, listenerError, failNext = false, confirmResult = options.confirmResult ?? true;
  const publish = () => listener?.({docs: [...data].map(([id, value]) => ({id, data: () => ({...value})}))});
  const applyOperations = operations => operations.forEach(operation => {
    if (operation.operation !== "delete") return;
    if (operation.ref.name === "enrollments") enrollmentData.delete(operation.ref.id);
    if (operation.ref.name === "registration_ranges") { data.delete(operation.ref.id); publish(); }
  });
  const mock = {
    firebaseConfig: {}, initializeApp: () => ({}), getAuth: () => ({}), getFirestore: () => ({}), GithubAuthProvider: class {addScope() {} static credentialFromResult(result) {return result?.credential || null;}}, getAdditionalUserInfo: result => result?.additionalUserInfo || null, getRedirectResult: async () => null, signInWithPopup: async (...args) => {popupCalls.push(args); return {user: {displayName: "Test User", email: "test@example.com", providerData: [{providerId: "github.com", uid: "1"}]}, additionalUserInfo: {username: "test-user", profile: {login: "test-user", id: 1}}};}, signInWithRedirect: async (...args) => {redirectCalls.push(args);}, onAuthStateChanged() {},
    doc: (_db, name, id) => ({name, id}), collection: (_db, name) => ({name}), where: (field, operator, value) => ({field, operator, value}), query: (ref, ...filters) => ({...ref, filters}), serverTimestamp: () => "updated",
    getDocs: async ref => ({docs: [...enrollmentData].filter(([, value]) => ref.name === "enrollments" && (ref.filters || []).every(filter => filter.operator === "==" && value[filter.field] === filter.value)).map(([id, value]) => ({id, data: () => ({...value})}))}),
    onSnapshot: (ref, callback, error) => {assert.equal(ref.name, "registration_ranges"); listener = callback; listenerError = error; publish(); return () => {listener = null;};},
    setDoc: async (ref, value) => {await Promise.resolve(); if (failNext) {failNext = false; throw {code: "permission-denied"};} writes.push({ref, value}); data.set(ref.id, value); publish();},
    deleteDoc: async ref => {const operation = {operation: "delete", ref}; writes.push(operation); applyOperations([operation]);},
    writeBatch: () => {const operations = []; return {set: (ref, value) => operations.push({operation: "set", ref, value}), update: (ref, value) => operations.push({operation: "update", ref, value}), delete: ref => operations.push({operation: "delete", ref}), commit: async () => {writes.push(...operations); applyOperations(operations);}};},
    confirm: message => {confirmations.push(message); return confirmResult;}, alert: () => {}
  };
  Object.assign(window, helpers, authHelpers, mock);
  window.eval(app + `\nwindow.testHooks = {
    startRegistrationRangesListener,
    renderEditorIdentity,
    renderStudentDashboard,
    setAdminRecords(nextUsers, nextEnrollments) { users = nextUsers; enrollments = nextEnrollments; renderEnrollmentList(); },
    setProfile(profile) { currentProfile = profile; updateRegistrationRangeHelp(); },
    setup() { currentUser = {uid: "test-student"}; courses = [{id: "cloud", name: "Cloud Computing", code: "CC", sections: ["A", "B"]}]; populateCourseControls(); renderCourseList(); },
    stopListeners
  };`);
  window.testHooks.setup();
  const el = id => window.document.getElementById(id);
  const submit = async id => {el(id).dispatchEvent(new window.Event("submit", {bubbles: true, cancelable: true})); await flush();};
  const fillRange = (prefix, first, last, digits) => {el("registration-prefix").value = prefix; el("registration-range-start").value = first; el("registration-range-end").value = last; el("registration-range-digits").value = digits;};
  const rangeButton = label => window.document.querySelector(`#registration-range-list button[aria-label="${label}"]`);
  return {window, el, writes, data, enrollmentData, confirmations, popupCalls, redirectCalls, submit, fillRange, rangeButton, start: () => window.testHooks.startRegistrationRangesListener(), setConfirm: value => {confirmResult = value;}, failSave: () => {failNext = true;}, failLoad: () => listenerError({code: "permission-denied"}), close: () => window.happyDOM.close()};
}

test("GitHub login uses a popup in desktop browsers such as Edge", async () => {
  const f = fixture();
  try {
    f.el("github-login").click(); await flush();
    assert.equal(f.popupCalls.length, 1);
    assert.equal(f.redirectCalls.length, 0);
    assert.equal(f.el("github-login").disabled, true);
    assert.equal(f.el("login-message").textContent, "Waiting for GitHub sign-in…");
  } finally {await f.close();}
});

test("GitHub login keeps same-origin redirect authentication on Android", async () => {
  const f = fixture([], {userAgent: "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36"});
  try {
    f.el("github-login").click(); await flush();
    assert.equal(f.popupCalls.length, 0);
    assert.equal(f.redirectCalls.length, 1);
    assert.equal(f.el("login-message").textContent, "Opening GitHub sign-in…");
  } finally {await f.close();}
});

test("admin areas are separated into three accessible tabs", async () => {
  const f = fixture();
  try {
    const management = f.el("admin-panel-management");
    const students = f.el("admin-panel-students");
    const reports = f.el("admin-panel-reports");
    assert.equal(management.hidden, false);
    assert.equal(students.hidden, true);
    assert.equal(reports.hidden, true);
    assert.equal(management.contains(f.window.document.querySelector(".course-admin-card")), true);
    assert.equal(management.contains(f.window.document.querySelector(".registration-ranges-card")), true);
    assert.equal(students.contains(f.window.document.querySelector(".users-card")), true);
    assert.equal(students.contains(f.window.document.querySelector(".editor-card")), true);
    assert.equal(reports.contains(f.window.document.querySelector(".report-card")), true);

    f.el("admin-tab-students").click();
    assert.equal(management.hidden, true);
    assert.equal(students.hidden, false);
    assert.equal(f.el("admin-tab-students").getAttribute("aria-selected"), "true");

    f.el("admin-tab-students").dispatchEvent(new f.window.KeyboardEvent("keydown", {key: "ArrowRight", bubbles: true}));
    assert.equal(students.hidden, true);
    assert.equal(reports.hidden, false);
    assert.equal(f.window.document.activeElement, f.el("admin-tab-reports"));

    f.el("admin-tab-reports").dispatchEvent(new f.window.KeyboardEvent("keydown", {key: "Home", bubbles: true}));
    assert.equal(management.hidden, false);
    assert.equal(reports.hidden, true);
    assert.equal(f.window.document.activeElement, f.el("admin-tab-management"));
  } finally {await f.close();}
});

test("the enrollment list stays within its card without horizontal scrolling", () => {
  const listRule = styles.match(/\.users-list\s*\{([^}]+)\}/)?.[1] || "";
  const itemRule = styles.match(/\.user-item\s*\{([^}]+)\}/)?.[1] || "";
  const contentRule = styles.match(/\.user-item-content\s*\{([^}]+)\}/)?.[1] || "";
  assert.match(listRule, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(listRule, /overflow-x:\s*hidden/);
  assert.match(itemRule, /width:\s*100%/);
  assert.match(itemRule, /min-width:\s*0/);
  assert.match(contentRule, /flex:\s*1 1 0/);
});

test("registered-user GitHub usernames open the matching profile in a new tab", async () => {
  const f = fixture();
  try {
    const profile = {id: "student-79", first_name: "Nidaa", last_name: "Wajid", registration_number: "2024-BSE-79", email: "nidaawajid624@gmail.com", user_name: "nidaawajid"};
    f.window.testHooks.renderEditorIdentity(profile);
    const identity = f.el("editor-identity"); const link = identity.querySelector("a.github-profile-link");
    assert(link, "A valid GitHub username is linked");
    assert.equal(identity.textContent, "2024-BSE-79 · nidaawajid624@gmail.com · nidaawajid");
    assert.equal(link.textContent, "nidaawajid");
    assert.equal(link.getAttribute("href"), "https://github.com/nidaawajid");
    assert.equal(link.target, "_blank");
    assert.equal(link.rel, "noopener noreferrer");

    f.window.testHooks.setProfile(profile);
    f.window.testHooks.renderStudentDashboard([{id: "student-79__cloud", course_id: "cloud", course_name: "Cloud Computing", course_code: "CC", section: "A", approved: true, marks: {categories: []}}]);
    const studentLink = f.el("student-username").querySelector("a.github-profile-link");
    assert(studentLink, "The registered student's profile shows a link");
    assert.equal(studentLink.textContent, "nidaawajid");
    assert.equal(studentLink.getAttribute("href"), "https://github.com/nidaawajid");
    assert.equal(studentLink.target, "_blank");

    f.window.testHooks.setAdminRecords([profile], [{id: "student-79__cloud", user_id: "student-79", course_id: "cloud", course_name: "Cloud Computing", course_code: "CC", section: "A", approved: true, marks: {categories: []}}]);
    const listLink = f.window.document.querySelector("#users-list a.user-item-github");
    assert(listLink, "The enrollment list shows the GitHub username as a link");
    assert.equal(listLink.textContent, "@nidaawajid");
    assert.equal(listLink.getAttribute("href"), "https://github.com/nidaawajid");
    assert.equal(listLink.target, "_blank");
    assert.equal(listLink.rel, "noopener noreferrer");

    const usernameOnlyProfile = {id: "student-79", registration_number: "2024-BSE-79", email: "nidaawajid624@gmail.com", user_name: "nidaawajid"};
    f.window.testHooks.setAdminRecords([usernameOnlyProfile], [{id: "student-79__cloud", user_id: "student-79", course_id: "cloud", course_name: "Cloud Computing", course_code: "CC", section: "A", approved: true, marks: {categories: []}}]);
    const usernameOnlyLink = f.window.document.querySelector("#users-list a.user-item-github");
    assert(usernameOnlyLink, "A separate GitHub link remains visible when the display name equals the username");
    assert.equal(f.window.document.querySelector("#users-list strong").textContent, "nidaawajid");
    assert.equal(usernameOnlyLink.textContent, "@nidaawajid");
    assert.equal(usernameOnlyLink.getAttribute("href"), "https://github.com/nidaawajid");

    const registrationUsernameProfile = {id: "student-38", registration_number: "2024-BSE-38", email: "fa24b1-se-038@fjwu.edu.pk", user_name: "2024-BSE-38"};
    f.window.testHooks.setAdminRecords([registrationUsernameProfile], [{id: "student-38__cloud", user_id: "student-38", course_id: "cloud", course_name: "Cloud Computing", course_code: "CC", section: "B", approved: true, marks: {categories: []}}]);
    const registrationUsernameLink = f.window.document.querySelector("#users-list a.user-item-github");
    assert(registrationUsernameLink, "A numeric and hyphenated GitHub username has a visible link");
    assert.equal(registrationUsernameLink.textContent, "@2024-BSE-38");
    assert.equal(registrationUsernameLink.getAttribute("href"), "https://github.com/2024-BSE-38");

    f.window.testHooks.renderEditorIdentity({registration_number: "2024-BSE-80", email: "student@example.com", user_name: "not/a/username"});
    assert.equal(identity.querySelector("a"), null, "An invalid username cannot create an unsafe profile link");
    assert.match(identity.textContent, /not\/a\/username$/);
  } finally {await f.close();}
});

test("course deletion requires confirmation and removes enrollments while keeping student accounts", async () => {
  const f = fixture([], {enrollments: [
    {id: "student-1__cloud", user_id: "student-1", course_id: "cloud", marks: {categories: [{name: "Quiz", items: []}]}},
    {id: "student-2__cloud", user_id: "student-2", course_id: "cloud", marks: {categories: []}}
  ]});
  try {
    const edit = f.window.document.querySelector('[aria-label="Edit CC"]');
    const remove = f.window.document.querySelector('[aria-label="Delete CC"]');
    assert(edit, "Edit remains available");
    assert(remove, "Delete is available");

    f.setConfirm(false); remove.click(); await flush();
    assert.equal(f.writes.length, 0);
    assert.match(f.confirmations.at(-1), /2 enrollments and their marks/);
    assert.match(f.confirmations.at(-1), /Student accounts will remain/);

    f.setConfirm(true); remove.click(); await flush();
    const deleted = f.writes.filter(item => item.operation === "delete").map(item => `${item.ref.name}/${item.ref.id}`);
    assert.deepEqual(deleted, ["enrollments/student-1__cloud", "enrollments/student-2__cloud", "courses/cloud"]);
    assert.equal(f.enrollmentData.size, 0);
    assert.match(f.el("course-message").textContent, /2 enrollments and associated marks/);
    assert.equal(f.el("course-message").className, "message success");
  } finally {await f.close();}
});

test("registration controls add, edit, disable, enable and cancel a class range", async () => {
  const f = fixture();
  try {
    assert.equal(f.el("admin-panel-management").contains(f.window.document.querySelector(".registration-ranges-card")), true);
    assert.equal(f.el("registration-number").hasAttribute("pattern"), false);
    f.start(); f.fillRange("2022-bse", "1", "99", "2"); await f.submit("registration-range-form");
    assert.equal(f.data.get("2022-BSE").digits, 2);
    assert.match(f.el("registration-range-help").textContent, /2022-BSE-01 to 2022-BSE-99/);
    f.rangeButton("Edit registration range 2022-BSE").click();
    assert.equal(f.el("registration-prefix").readOnly, true);
    f.el("registration-range-end").value = "150"; f.el("registration-range-digits").value = "3";
    await f.submit("registration-range-form");
    assert.equal(f.data.get("2022-BSE").end, 150);
    f.rangeButton("Disable registrations for 2022-BSE").click(); await flush();
    assert.equal(f.data.get("2022-BSE").active, false);
    assert.doesNotMatch(f.el("registration-range-help").textContent, /2022-BSE/);
    f.rangeButton("Enable registrations for 2022-BSE").click(); await flush();
    assert.equal(f.data.get("2022-BSE").active, true);
    f.rangeButton("Edit registration range 2022-BSE").click(); f.el("registration-range-start").value = "40";
    f.el("registration-range-cancel").click();
    assert.equal(f.el("registration-prefix").readOnly, false);
    assert.equal(f.el("registration-prefix").value, "");
    assert.equal(f.data.get("2022-BSE").start, 1);
  } finally {await f.close();}
});

test("registration ranges can be deleted without restoring the legacy default", async () => {
  const f = fixture([{prefix: "2023-BSCS", start: 1, end: 99, digits: 2, active: true}]);
  try {
    f.start();
    const removeClass = f.rangeButton("Delete registration range 2023-BSCS");
    assert(removeClass, "Delete is available for a saved class");
    f.setConfirm(false); removeClass.click(); await flush();
    assert.equal(f.data.has("2023-BSCS"), true);
    assert.match(f.confirmations.at(-1), /Existing student accounts and enrollments will remain/);

    f.setConfirm(true); removeClass.click(); await flush();
    assert.equal(f.data.has("2023-BSCS"), false);
    assert.equal(f.rangeButton("Delete registration range 2023-BSCS"), null);

    const removeLegacy = f.rangeButton("Delete registration range 2024-BSE");
    assert(removeLegacy, "Delete is available for the legacy fallback");
    removeLegacy.click(); await flush();
    assert.equal(f.data.get("2024-BSE").deleted, true);
    assert.equal(f.data.get("2024-BSE").active, false);
    assert.equal(f.rangeButton("Delete registration range 2024-BSE"), null);
    assert.match(f.el("registration-range-help").textContent, /currently closed/);

    f.fillRange("2024-BSE", "1", "99", "2"); await f.submit("registration-range-form");
    assert.equal(f.data.get("2024-BSE").deleted, undefined);
    assert.equal(f.data.get("2024-BSE").active, true);
    assert(f.rangeButton("Delete registration range 2024-BSE"), "A deleted class can be added again later");
  } finally {await f.close();}
});

test("disabling every class closes new registrations but keeps existing students enabled", async () => {
  const f = fixture([{prefix: "2024-BSE", start: 1, end: 99, digits: 2, active: false}]);
  try {
    f.start();
    assert.equal(f.el("registration-submit").disabled, true);
    assert.match(f.el("registration-range-help").textContent, /currently closed/);
    f.window.testHooks.setProfile({registration_number: "2024-BSE-01"});
    assert.equal(f.el("registration-submit").disabled, false);
  } finally {await f.close();}
});

test("duplicate prefixes and failed saves retain settings and permit retry", async () => {
  const f = fixture();
  try {
    f.start(); f.fillRange("2024-BSE", "1", "10", "2"); await f.submit("registration-range-form");
    assert.match(f.el("registration-range-message").textContent, /already exists/); assert.equal(f.writes.length, 0);
    f.fillRange("2024-BSCS", "1", "150", "2"); await f.submit("registration-range-form");
    assert.match(f.el("registration-range-message").textContent, /enough digits/); assert.equal(f.writes.length, 0);
    f.el("registration-range-digits").value = "3"; f.failSave(); await f.submit("registration-range-form");
    assert.match(f.el("registration-range-message").textContent, /Access denied/);
    assert.equal(f.el("registration-prefix").value, "2024-BSCS"); assert.equal(f.el("registration-range-submit").disabled, false);
    await f.submit("registration-range-form"); assert.equal(f.data.get("2024-BSCS").end, 150);
  } finally {await f.close();}
});

test("student signup uses saved ranges and fails closed when settings cannot load", async () => {
  const f = fixture([{prefix: "2024-BSCS", start: 1, end: 150, digits: 3, active: true}]);
  try {
    f.el("registration-course").value = "cloud"; f.el("registration-section").add(new f.window.Option("Section A", "A")); f.el("registration-section").value = "A";
    f.el("registration-number").value = "2024-BSCS-150";
    await f.submit("registration-form"); assert.equal(f.writes.length, 0);
    f.start(); f.el("registration-number").value = "2024-BSCS-151"; await f.submit("registration-form"); assert.equal(f.writes.length, 0);
    f.el("registration-number").value = " 2024-bscs-150 "; await f.submit("registration-form");
    assert.equal(f.writes[0].value.registration_number, "2024-BSCS-150"); assert.equal(f.writes[1].value.approved, false);
    f.failLoad(); assert.equal(f.el("registration-submit").disabled, true);
    await f.submit("registration-form"); assert.equal(f.writes.length, 2);
    f.window.testHooks.setProfile({registration_number: "2022-BSE-49"});
    assert.equal(f.el("registration-submit").disabled, false);
    await f.submit("registration-form");
    assert.equal(f.writes.length, 3); assert.equal(f.writes[2].ref.name, "enrollments");
  } finally {await f.close();}
});
