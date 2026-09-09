import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Window } from "happy-dom";
import * as helpers from "../public/registration-ranges.js";

const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8").replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "");
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(saved = []) {
  const window = new Window({settings: {enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true}});
  window.document.write(html);
  // Happy DOM omits the browser's Option convenience constructor.
  window.Option = function Option(text, value) { const option = window.document.createElement("option"); option.textContent = text; option.value = value; return option; };
  const data = new Map(saved.map(range => [range.prefix, {...range}]));
  const writes = []; let listener, listenerError, failNext = false;
  const publish = () => listener?.({docs: [...data].map(([id, value]) => ({id, data: () => ({...value})}))});
  const mock = {
    firebaseConfig: {}, initializeApp: () => ({}), getAuth: () => ({}), getFirestore: () => ({}), GithubAuthProvider: class {addScope() {}}, onAuthStateChanged() {},
    doc: (_db, name, id) => ({name, id}), collection: (_db, name) => ({name}), serverTimestamp: () => "updated",
    onSnapshot: (ref, callback, error) => {assert.equal(ref.name, "registration_ranges"); listener = callback; listenerError = error; publish(); return () => {listener = null;};},
    setDoc: async (ref, value) => {await Promise.resolve(); if (failNext) {failNext = false; throw {code: "permission-denied"};} writes.push({ref, value}); data.set(ref.id, value); publish();},
    writeBatch: () => {const operations = []; return {set: (ref, value) => operations.push({ref, value}), commit: async () => {writes.push(...operations);}};}
  };
  Object.assign(window, helpers, mock);
  window.eval(app + `\nwindow.testHooks = {
    startRegistrationRangesListener,
    setProfile(profile) { currentProfile = profile; updateRegistrationRangeHelp(); },
    setup() { currentUser = {uid: "test-student"}; courses = [{id: "cloud", name: "Cloud Computing", code: "CC", sections: ["A", "B"]}]; populateCourseControls(); },
    stopListeners
  };`);
  window.testHooks.setup();
  const el = id => window.document.getElementById(id);
  const submit = async id => {el(id).dispatchEvent(new window.Event("submit", {bubbles: true, cancelable: true})); await flush();};
  const fillRange = (prefix, first, last, digits) => {el("registration-prefix").value = prefix; el("registration-range-start").value = first; el("registration-range-end").value = last; el("registration-range-digits").value = digits;};
  const rangeButton = label => window.document.querySelector(`#registration-range-list button[aria-label="${label}"]`);
  return {window, el, writes, data, submit, fillRange, rangeButton, start: () => window.testHooks.startRegistrationRangesListener(), failSave: () => {failNext = true;}, failLoad: () => listenerError({code: "permission-denied"}), close: () => window.happyDOM.close()};
}

test("card is below Enrollments; add, edit, disable, enable and cancel work", async () => {
  const f = fixture();
  try {
    assert.equal(f.window.document.querySelector(".users-card").nextElementSibling.className, "registration-ranges-card");
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
