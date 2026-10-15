import { initializeApp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import { getAuth, GithubAuthProvider, getAdditionalUserInfo, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, collection, query, where, getDocs, getDocsFromServer, writeBatch, runTransaction, onSnapshot, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { beginMobileGithubSignIn, fetchGithubProfileById, githubAccountId, githubProfileFromFirebaseUser, GITHUB_PROFILE_CACHE_KEY, mergeGithubProfiles, resolveGithubProfile, shouldUseMobileGithubSignIn } from "./auth-flow.js";
import { defaultRegistrationRange, normalizeRegistration, validateRegistrationRange, effectiveRegistrationRanges, formatRegistration, describeRegistrationRange, isRegistrationAllowed } from "./registration-ranges.js";
import { decisionPoints, groupReviewItems, projectedScore, reviewProgress, selectedReferenceCandidates } from "./manual-review.js";

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);
const githubProvider = new GithubAuthProvider();
githubProvider.addScope("read:user");
githubProvider.addScope("user:email");

const el = (id) => document.getElementById(id);
const views = ["loading-view", "login-view", "registration-view", "pending-view", "blocked-view", "student-view", "admin-view"];

let currentUser = null;
let currentProfile = null;
let courses = [];
let users = [];
let enrollments = [];
let privateMarksByEnrollment = new Map();
let myEnrollments = [];
let selectedEnrollmentId = null;
let userListMode = "users";
let addingAnotherCourse = false;
let editingCourseId = null;
let savingCourse = false;
let registrationRanges = [];
let registrationRangesReady = false;
let editingRegistrationPrefix = null;
let savingRegistrationRange = false;
let currentReport = [];
let currentReportColumns = [];
let currentReportTitle = "student-report";
let unsubscribeCourses = null;
let unsubscribeUsers = null;
let unsubscribeEnrollments = null;
let unsubscribePrivateMarks = null;
let unsubscribeProfile = null;
let unsubscribeMyEnrollments = null;
let unsubscribeRegistrationRanges = null;
let unsubscribeGradingRuns = null;
let unsubscribeReviewItems = null;
let unsubscribeReviewResults = null;
let unsubscribeReviewCriteria = null;
let syncingRegistrationClaims = false;
let registrationClaimSyncQueued = false;
let registrationClaimSyncError = "";
let privateMarksReady = false;
let privateMarksFromCache = true;
let enrollmentMarksFromCache = true;
let savingMarkVisibility = false;
const githubProfileRepairAttempts = new Set();
let gradingRuns = [];
let selectedReviewRunId = "";
let reviewItems = [];
let reviewResults = new Map();
let reviewCriteria = new Map();
let reviewQuestionIndex = 0;
let reviewStudentIndex = 0;
let reviewReferenceIndex = 0;
let savingReviewDecision = false;
let savingReferenceSelection = false;
let deletingReviewRunId = "";

function showView(id) { views.forEach((view) => { el(view).hidden = view !== id; }); }
const adminTabs = [...document.querySelectorAll(".admin-tab")];

function activateAdminPanel(panelId, focusTab = false) {
  adminTabs.forEach((tab) => {
    const isActive = tab.dataset.adminPanel === panelId;
    tab.classList.toggle("active", isActive);
    tab.setAttribute("aria-selected", String(isActive));
    tab.tabIndex = isActive ? 0 : -1;
    if (isActive && focusTab) tab.focus();
  });
  document.querySelectorAll(".admin-tab-panel").forEach((panel) => { panel.hidden = panel.id !== panelId; });
}

adminTabs.forEach((tab, index) => {
  tab.addEventListener("click", () => activateAdminPanel(tab.dataset.adminPanel));
  tab.addEventListener("keydown", (event) => {
    let targetIndex = null;
    if (event.key === "ArrowRight") targetIndex = (index + 1) % adminTabs.length;
    if (event.key === "ArrowLeft") targetIndex = (index - 1 + adminTabs.length) % adminTabs.length;
    if (event.key === "Home") targetIndex = 0;
    if (event.key === "End") targetIndex = adminTabs.length - 1;
    if (targetIndex === null) return;
    event.preventDefault();
    activateAdminPanel(adminTabs[targetIndex].dataset.adminPanel, true);
  });
});

function enrollmentId(uid, courseId) { return `${uid}__${courseId}`; }
function courseIdForCode(code) { return code.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }
function courseById(id) { return courses.find((course) => course.id === id); }
function profileById(id) { return users.find((user) => user.id === id); }
function displayName(profile = {}) { return [profile.first_name, profile.last_name].filter(Boolean).join(" ") || profile.user_name || "Student"; }
function claimableRegistration(value) {
  const registration = normalizeRegistration(value);
  return registration.length <= 55 && /^[A-Z0-9]+(?:-[A-Z0-9]+)*-[0-9]{1,6}$/.test(registration) ? registration : "";
}
function registrationGroups(source = users) {
  const groups = new Map();
  source.forEach((profile) => {
    const registration = claimableRegistration(profile.registration_number);
    if (!registration) return;
    if (!groups.has(registration)) groups.set(registration, []);
    groups.get(registration).push(profile);
  });
  return groups;
}
function registrationClaimData(registration, profiles) {
  const userIds = [...new Set(profiles.map((profile) => profile.id).filter(Boolean))].sort();
  return { registration_number: registration, user_id: userIds.length === 1 ? userIds[0] : "", user_ids: userIds, conflict: userIds.length !== 1, updated_at: serverTimestamp() };
}
function registrationClaimMatches(existing, desired) {
  return existing?.registration_number === desired.registration_number
    && existing?.user_id === desired.user_id
    && existing?.conflict === desired.conflict
    && JSON.stringify(existing?.user_ids || []) === JSON.stringify(desired.user_ids);
}
function githubProfileUrl(username) {
  const value = String(username || "").trim();
  return /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(value) ? `https://github.com/${encodeURIComponent(value)}` : "";
}
function createGithubProfileLink(username, label = username) {
  const value = String(username || "").trim(); const profileUrl = githubProfileUrl(value);
  if (!profileUrl) return null;
  const link = document.createElement("a"); link.className = "github-profile-link"; link.href = profileUrl; link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = String(label || value); link.title = `Open ${value} on GitHub in a new tab`; link.addEventListener("click", (event) => event.stopPropagation()); return link;
}
function renderGithubUsername(container, username) {
  const value = String(username || "").trim(); const link = createGithubProfileLink(value);
  container.replaceChildren(link || document.createTextNode(value || "—"));
}
function renderEditorIdentity(profile = {}) {
  const identity = el("editor-identity"); const username = String(profile.user_name || "").trim(); const link = createGithubProfileLink(username);
  identity.replaceChildren(document.createTextNode(`${profile.registration_number || "No registration"} · ${profile.email || "No email"} · `));
  identity.append(link || document.createTextNode(username || "No GitHub username"));
}
function percent(obtained, total) { return total > 0 ? `${((obtained / total) * 100).toFixed(1)}%` : "—"; }
function preciseTotal(values) { return Number(values.reduce((sum, value) => sum + Number(value || 0), 0).toFixed(10)); }
function cleanMarkName(value) { return String(value || "").trim().replace(/\s+/g, " "); }
function categoryKey(name) { return cleanMarkName(name).toLowerCase(); }
function markCategories(marks = {}) {
  const merged = new Map();
  (Array.isArray(marks?.categories) ? marks.categories : []).forEach((sourceCategory) => {
    const name = cleanMarkName(sourceCategory?.name); const key = categoryKey(name); if (!key) return;
    if (!merged.has(key)) merged.set(key, { ...sourceCategory, name, items: [] });
    const category = merged.get(key); const indexes = new Map(category.items.map((item, index) => [categoryKey(item.name), index]));
    (Array.isArray(sourceCategory?.items) ? sourceCategory.items : []).forEach((sourceItem) => {
      const itemName = cleanMarkName(sourceItem?.name); const itemKey = categoryKey(itemName); if (!itemKey) return;
      const candidate = { ...sourceItem, name: itemName };
      if (!indexes.has(itemKey)) { indexes.set(itemKey, category.items.length); category.items.push(candidate); return; }
      const index = indexes.get(itemKey); const existing = category.items[index];
      if ((Date.parse(candidate.graded_at || "") || 0) > (Date.parse(existing.graded_at || "") || 0)) category.items[index] = candidate;
    });
  });
  return [...merged.values()];
}
function mergeMarks(...sources) { return { categories: markCategories({ categories: sources.flatMap((marks) => Array.isArray(marks?.categories) ? marks.categories : []) }) }; }
function hiddenCategoryKeys(course) { return new Set((Array.isArray(course?.hidden_mark_categories) ? course.hidden_mark_categories : []).map(categoryKey).filter(Boolean)); }
function fullMarksForEnrollment(enrollment = {}) { return mergeMarks(privateMarksByEnrollment.get(enrollment.id)?.marks, enrollment.marks); }
function studentMarksForCourse(marks, course) { const hidden = hiddenCategoryKeys(course); return { categories: markCategories(marks).filter((category) => !hidden.has(categoryKey(category.name))) }; }
function privateMarksDocument(enrollment, marks) { return { enrollment_id: enrollment.id, user_id: enrollment.user_id, course_id: enrollment.course_id, marks, updated_at: serverTimestamp() }; }
function friendlyError(error) {
  if (["permission-denied", "firestore/permission-denied"].includes(error?.code)) return "Access denied. Your account is blocked or does not have permission to use this portal.";
  if (error?.code === "auth/popup-closed-by-user") return "GitHub sign-in was cancelled.";
  if (error?.code === "auth/popup-blocked") return "Allow browser pop-ups and try GitHub sign-in again.";
  return error?.message || "The operation could not be completed.";
}

function setRegistrationRangeMessage(message, success = false) {
  el("registration-range-message").className = success ? "message success" : "message";
  el("registration-range-message").textContent = message;
}

function updateRegistrationRangeControls() {
  document.querySelectorAll("#registration-range-form input, #registration-range-form select, #registration-range-form button, #registration-range-list button").forEach((control) => { control.disabled = !registrationRangesReady || savingRegistrationRange; });
  el("registration-range-form").setAttribute("aria-busy", String(savingRegistrationRange));
  el("registration-submit").disabled = !currentProfile && (!registrationRangesReady || !registrationRanges.some((range) => range.active));
}

function updateRegistrationRangeHelp() {
  const active = registrationRanges.filter((range) => range.active);
  const suggestions = el("registration-numbers"); suggestions.replaceChildren();
  active.forEach((range) => [...new Set([range.start, range.end])].forEach((number) => {
    const option = document.createElement("option"); option.value = formatRegistration(range, number); suggestions.append(option);
  }));
  el("registration-number").placeholder = active.length ? `For example: ${formatRegistration(active[0], active[0].start)}` : "Enter your registration number";
  el("registration-range-help").textContent = currentProfile ? "Your saved registration number will be used for this enrollment." : !registrationRangesReady ? "Loading allowed registration numbers…" : active.length ? `Allowed: ${active.map(describeRegistrationRange).join("; ")}.` : "New registrations are currently closed. Contact your administrator.";
  updateRegistrationRangeControls();
}

function startRegistrationRangesListener() {
  if (unsubscribeRegistrationRanges) unsubscribeRegistrationRanges();
  registrationRangesReady = false; updateRegistrationRangeHelp();
  unsubscribeRegistrationRanges = onSnapshot(collection(db, "registration_ranges"), (snapshot) => {
    registrationRanges = effectiveRegistrationRanges(snapshot.docs.map((item) => ({ ...item.data(), prefix: item.id })));
    registrationRangesReady = true; renderRegistrationRanges(); updateRegistrationRangeHelp();
  }, (error) => {
    registrationRangesReady = false; registrationRanges = []; renderRegistrationRanges(); updateRegistrationRangeHelp();
    setRegistrationRangeMessage(`Allowed registrations could not be loaded. ${friendlyError(error)}`);
    if (!currentProfile) el("registration-range-help").textContent = "Allowed registrations could not be loaded. Refresh the page to try again.";
  });
}

function resetRegistrationRangeForm() {
  editingRegistrationPrefix = null; el("registration-range-form").reset(); el("registration-prefix").readOnly = false;
  el("registration-range-submit").textContent = "Add allowed class"; el("registration-range-cancel").hidden = true; updateRegistrationRangePreview();
}

function registrationRangeFromForm() {
  return { prefix: normalizeRegistration(el("registration-prefix").value), start: Number(el("registration-range-start").value), end: Number(el("registration-range-end").value), digits: Number(el("registration-range-digits").value), active: registrationRanges.find((range) => range.prefix === editingRegistrationPrefix)?.active ?? true };
}

function updateRegistrationRangePreview() {
  const range = registrationRangeFromForm();
  el("registration-range-preview").textContent = validateRegistrationRange(range) ? "Example: prefix 2022-BSE, numbers 1–99, 2 digits → 2022-BSE-01 to 2022-BSE-99." : describeRegistrationRange(range);
}

function beginRegistrationRangeEdit(range) {
  if (savingRegistrationRange || !registrationRangesReady) return;
  editingRegistrationPrefix = range.prefix; el("registration-prefix").value = range.prefix; el("registration-prefix").readOnly = true;
  el("registration-range-start").value = range.start; el("registration-range-end").value = range.end; el("registration-range-digits").value = range.digits;
  el("registration-range-submit").textContent = "Save range"; el("registration-range-cancel").hidden = false;
  setRegistrationRangeMessage(""); updateRegistrationRangePreview(); el("registration-range-start").focus();
}

function renderRegistrationRanges() {
  const container = el("registration-range-list"); container.replaceChildren();
  registrationRanges.forEach((range) => {
    const row = document.createElement("article"); row.className = "registration-range-item";
    const title = document.createElement("strong"); title.textContent = range.prefix;
    const status = document.createElement("span"); status.className = `badge${range.active ? " published" : ""}`; status.textContent = range.active ? "Enabled" : "Disabled";
    const heading = document.createElement("div"); heading.className = "registration-range-heading"; heading.append(title, status);
    const description = document.createElement("p"); description.textContent = describeRegistrationRange(range);
    const actions = document.createElement("div"); actions.className = "registration-range-actions";
    const edit = document.createElement("button"); edit.type = "button"; edit.className = "small secondary"; edit.textContent = "Edit"; edit.setAttribute("aria-label", `Edit registration range ${range.prefix}`); edit.addEventListener("click", () => beginRegistrationRangeEdit(range));
    const toggle = document.createElement("button"); toggle.type = "button"; toggle.className = "small secondary"; toggle.textContent = range.active ? "Disable" : "Enable"; toggle.setAttribute("aria-label", `${toggle.textContent} registrations for ${range.prefix}`); toggle.addEventListener("click", () => saveRegistrationRange({ ...range, active: !range.active }));
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "small danger registration-range-delete"; remove.textContent = "Delete"; remove.setAttribute("aria-label", `Delete registration range ${range.prefix}`); remove.addEventListener("click", () => deleteRegistrationRange(range));
    actions.append(edit, toggle, remove); row.append(heading, description, actions); container.append(row);
  });
  updateRegistrationRangeControls();
}

async function deleteRegistrationRange(range) {
  if (savingRegistrationRange || !registrationRangesReady) return;
  if (!confirm(`Delete allowed registrations for ${range.prefix}? New students in ${describeRegistrationRange(range)} will no longer be able to register. Existing student accounts and enrollments will remain. You can add this class again later.`)) return;
  savingRegistrationRange = true; updateRegistrationRangeControls(); setRegistrationRangeMessage("");
  try {
    const rangeRef = doc(db, "registration_ranges", range.prefix);
    if (range.prefix === defaultRegistrationRange.prefix) await setDoc(rangeRef, { prefix: range.prefix, start: range.start, end: range.end, digits: range.digits, active: false, deleted: true, updated_at: serverTimestamp() });
    else await deleteDoc(rangeRef);
    if (editingRegistrationPrefix === range.prefix) resetRegistrationRangeForm();
    setRegistrationRangeMessage(`${range.prefix} deleted. Existing students were not changed.`, true);
  } catch (error) { setRegistrationRangeMessage(friendlyError(error)); }
  finally { savingRegistrationRange = false; updateRegistrationRangeControls(); }
}

async function saveRegistrationRange(range) {
  if (savingRegistrationRange || !registrationRangesReady) return;
  savingRegistrationRange = true; updateRegistrationRangeControls(); setRegistrationRangeMessage("");
  try {
    const { prefix, start, end, digits, active } = range;
    await setDoc(doc(db, "registration_ranges", prefix), { prefix, start, end, digits, active, updated_at: serverTimestamp() });
    resetRegistrationRangeForm(); setRegistrationRangeMessage(`${prefix} saved. ${active ? "New registrations are allowed in this range." : "New registrations are disabled for this class."}`, true);
  } catch (error) { setRegistrationRangeMessage(friendlyError(error)); }
  finally { savingRegistrationRange = false; updateRegistrationRangeControls(); }
}

el("registration-range-form").addEventListener("submit", async (event) => {
  event.preventDefault(); if (savingRegistrationRange || !registrationRangesReady) return;
  const range = registrationRangeFromForm(); const error = validateRegistrationRange(range);
  if (error) { setRegistrationRangeMessage(error); return; }
  if (!editingRegistrationPrefix && registrationRanges.some((item) => item.prefix === range.prefix)) { setRegistrationRangeMessage("This class prefix already exists. Use its Edit button to change the range."); return; }
  await saveRegistrationRange(range);
});
el("registration-range-form").addEventListener("input", updateRegistrationRangePreview);
el("registration-range-cancel").addEventListener("click", () => { resetRegistrationRangeForm(); setRegistrationRangeMessage(""); });

async function getGithubProfile(token) {
  const response = await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } });
  if (!response.ok) throw new Error("GitHub profile could not be loaded.");
  return response.json();
}

function cacheGithubProfile(profile) {
  try { sessionStorage.setItem(GITHUB_PROFILE_CACHE_KEY, JSON.stringify(profile)); }
  catch { /* Firebase user data still allows sign-in when browser storage is restricted. */ }
}

function cachedGithubProfile(user = currentUser) {
  try {
    const profile = JSON.parse(sessionStorage.getItem(GITHUB_PROFILE_CACHE_KEY) || "{}");
    return profile.firebase_uid && user?.uid && profile.firebase_uid !== user.uid ? {} : profile;
  }
  catch { return {}; }
}

function clearCachedGithubProfile() {
  try { sessionStorage.removeItem(GITHUB_PROFILE_CACHE_KEY); }
  catch { /* Nothing to clear when browser storage is unavailable. */ }
}

function splitName(name = "") { const parts = name.trim().split(/\s+/).filter(Boolean); return { first_name: parts.shift() || "", last_name: parts.join(" ") }; }

function startCoursesListener() {
  if (unsubscribeCourses) unsubscribeCourses();
  unsubscribeCourses = onSnapshot(collection(db, "courses"), (snapshot) => {
    courses = snapshot.docs.map((item) => ({ id: item.id, ...item.data() })).sort((a, b) => a.name.localeCompare(b.name));
    populateCourseControls(); renderCourseList(); renderMarksVisibility(); refreshReportCategories();
    const selected = enrollments.find((item) => item.id === selectedEnrollmentId);
    if (selected) populateEditorCourse(selected, el("editor-section").value);
    if (!el("report-table").hidden) generateReport();
  });
}

function populateCourseControls() {
  const active = courses.filter((course) => course.active !== false);
  const registrationValue = el("registration-course").value;
  el("registration-course").innerHTML = '<option value="">Select course</option>';
  active.forEach((course) => el("registration-course").add(new Option(`${course.code} — ${course.name}`, course.id)));
  if (active.some((course) => course.id === registrationValue)) el("registration-course").value = registrationValue;

  const adminValue = el("admin-course-filter").value;
  el("admin-course-filter").innerHTML = '<option value="all">All courses</option>';
  courses.forEach((course) => el("admin-course-filter").add(new Option(`${course.code} — ${course.name}`, course.id)));
  if (courses.some((course) => course.id === adminValue)) el("admin-course-filter").value = adminValue;

  const reportValue = el("report-course").value;
  el("report-course").replaceChildren();
  courses.forEach((course) => el("report-course").add(new Option(`${course.code} — ${course.name}`, course.id)));
  if (courses.some((course) => course.id === reportValue)) el("report-course").value = reportValue;

  const visibilityValue = el("visibility-course").value;
  el("visibility-course").replaceChildren();
  courses.forEach((course) => el("visibility-course").add(new Option(`${course.code} — ${course.name}`, course.id)));
  if (courses.some((course) => course.id === visibilityValue)) el("visibility-course").value = visibilityValue;
  updateRegistrationSections(); updateReportSections();
}

function updateRegistrationSections() {
  const course = courseById(el("registration-course").value); el("registration-section").innerHTML = '<option value="">Select section</option>';
  (course?.sections || []).forEach((section) => el("registration-section").add(new Option(`Section ${section}`, section)));
}

function updateReportSections() {
  const course = courseById(el("report-course").value); const previous = el("report-section").value;
  el("report-section").innerHTML = '<option value="both">All Sections</option>';
  (course?.sections || []).forEach((section) => el("report-section").add(new Option(`Section ${section}`, section)));
  if (["both", ...(course?.sections || [])].includes(previous)) el("report-section").value = previous;
  refreshReportCategories();
}

async function routeUser(user) {
  currentUser = user; startCoursesListener();
  const admin = await getDoc(doc(db, "admins", user.uid));
  if (admin.exists()) { showView("admin-view"); startAdminListeners(); startRegistrationRangesListener(); return; }
  const blocked = await getDoc(doc(db, "blocked_users", user.uid));
  if (blocked.exists()) { showView("blocked-view"); return; }
  startRegistrationRangesListener(); startStudentListeners(user);
}

function startStudentListeners(user) {
  if (unsubscribeProfile) unsubscribeProfile(); if (unsubscribeMyEnrollments) unsubscribeMyEnrollments();
  unsubscribeProfile = onSnapshot(doc(db, "users", user.uid), (snapshot) => {
    currentProfile = snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null; renderStudentState();
  }, (error) => { el("login-message").textContent = friendlyError(error); showView("login-view"); });
  unsubscribeMyEnrollments = onSnapshot(query(collection(db, "enrollments"), where("user_id", "==", user.uid)), (snapshot) => {
    myEnrollments = snapshot.docs.map((item) => ({ id: item.id, ...item.data() })); renderStudentState();
  }, (error) => { el("login-message").textContent = friendlyError(error); showView("login-view"); });
}

function renderStudentState() {
  if (!currentUser || courses.length === 0) return;
  if (!currentProfile) { openEnrollmentForm(false); return; }
  if (addingAnotherCourse) return;
  const approved = myEnrollments.filter((item) => item.approved);
  if (approved.length) { renderStudentDashboard(approved); showView("student-view"); }
  else { renderPendingDashboard(); showView("pending-view"); }
}

function openEnrollmentForm(additional) {
  addingAnotherCourse = additional; el("registration-title").textContent = additional ? "Enroll in another course" : "Complete registration";
  el("registration-help").textContent = additional ? "Select another course and section. The new enrollment requires approval." : "Enter your registration number, course and section. The enrollment requires approval.";
  el("registration-number").value = currentProfile?.registration_number || ""; el("registration-number").readOnly = Boolean(currentProfile);
  updateRegistrationRangeHelp();
  el("cancel-enrollment").hidden = !additional; el("registration-message").textContent = ""; populateCourseControls();
  const existing = new Set(myEnrollments.map((item) => item.course_id)); [...el("registration-course").options].forEach((option) => { if (existing.has(option.value)) option.disabled = true; });
  showView("registration-view");
}

el("registration-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const registration = currentProfile?.registration_number || normalizeRegistration(el("registration-number").value); const courseId = el("registration-course").value; const section = el("registration-section").value; const course = courseById(courseId);
  if (!currentProfile && !registrationRangesReady) { el("registration-message").textContent = "Wait for the allowed registration numbers to load, then try again."; return; }
  if (!currentProfile && !isRegistrationAllowed(registration, registrationRanges)) { el("registration-message").textContent = "Enter a registration number in an enabled range shown above, including the required leading zeros. Contact your administrator if your class is missing."; return; }
  if (!course || !section) { el("registration-message").textContent = "Select a valid course and section."; return; }
  if (myEnrollments.some((item) => item.course_id === courseId)) { el("registration-message").textContent = "You already have an enrollment for this course."; return; }
  try {
    if (!currentProfile) {
      const gh = await resolveGithubProfile(currentUser, cachedGithubProfile(currentUser), fetch); cacheGithubProfile(gh); const names = splitName(gh.name || currentUser.displayName || "");
      await runTransaction(db, async (transaction) => {
        const claimRef = doc(db, "registration_claims", registration);
        if ((await transaction.get(claimRef)).exists()) { const error = new Error("Registration number already claimed."); error.code = "registration-already-claimed"; throw error; }
        transaction.set(claimRef, registrationClaimData(registration, [{ id: currentUser.uid }]));
        transaction.set(doc(db, "users", currentUser.uid), { ...names, created_at: serverTimestamp(), email: gh.email || currentUser.email || "", github_id: String(gh.id || ""), photo_url: gh.avatar_url || currentUser.photoURL || "", registration_number: registration, user_name: gh.login || "" });
        transaction.set(doc(db, "enrollments", enrollmentId(currentUser.uid, courseId)), { user_id: currentUser.uid, course_id: courseId, course_name: course.name, course_code: course.code, section, approved: false, created_at: serverTimestamp(), marks: { categories: [] } });
      });
    } else {
      const batch = writeBatch(db);
      batch.set(doc(db, "enrollments", enrollmentId(currentUser.uid, courseId)), { user_id: currentUser.uid, course_id: courseId, course_name: course.name, course_code: course.code, section, approved: false, created_at: serverTimestamp(), marks: { categories: [] } });
      await batch.commit();
    }
    addingAnotherCourse = false;
  } catch (error) {
    el("registration-message").textContent = !currentProfile && ["registration-already-claimed", "permission-denied", "firestore/permission-denied"].includes(error?.code)
      ? "This registration number is already registered. Use the original account or contact the administrator."
      : friendlyError(error);
  }
});

function renderPendingDashboard() {
  el("pending-avatar").src = currentProfile.photo_url || currentUser.photoURL || ""; el("pending-name").textContent = displayName(currentProfile); el("pending-registration").textContent = currentProfile.registration_number;
  const container = el("pending-courses"); container.replaceChildren();
  myEnrollments.forEach((item) => { const card = document.createElement("article"); card.className = "course-status-card"; card.innerHTML = `<h3></h3><p></p><span class="badge"></span>`; card.children[0].textContent = `${item.course_name} (${item.course_code}) Section ${item.section}`; card.children[1].textContent = item.approved ? "Enrollment approved" : "Waiting for administrator approval"; card.children[2].textContent = item.approved ? "Approved" : "Pending approval"; card.children[2].classList.toggle("published", item.approved); container.append(card); });
}

function renderStudentDashboard(approved) {
  el("student-avatar").src = currentProfile.photo_url || currentUser.photoURL || ""; el("student-name").textContent = displayName(currentProfile); el("student-registration").textContent = currentProfile.registration_number; renderGithubUsername(el("student-username"), currentProfile.user_name); el("student-email").textContent = currentProfile.email || "Private on GitHub"; el("student-course-count").textContent = approved.length;
  const tabs = el("student-course-tabs"); tabs.replaceChildren(); approved.sort((a, b) => a.course_name.localeCompare(b.course_name)).forEach((enrollment, index) => { const button = document.createElement("button"); button.className = `tab${index === 0 ? " active" : ""}`; button.textContent = `${enrollment.course_name} (${enrollment.course_code}) Section ${enrollment.section}`; button.addEventListener("click", () => { tabs.querySelectorAll(".tab").forEach((tab) => tab.classList.remove("active")); button.classList.add("active"); renderCourseMarks(enrollment); }); tabs.append(button); }); renderCourseMarks(approved[0]);
}

function renderCourseMarks(enrollment) {
  const categories = markCategories(enrollment.marks); const tabs = el("category-tabs"); tabs.replaceChildren(); el("marks-status").textContent = categories.length ? "Published" : "Not published"; el("marks-status").classList.toggle("published", categories.length > 0);
  if (!categories.length) { renderCategoryTable(null); return; }
  categories.forEach((category, index) => { const button = document.createElement("button"); button.className = `tab${index === 0 ? " active" : ""}`; button.textContent = category.name; button.addEventListener("click", () => { tabs.querySelectorAll(".tab").forEach((tab) => tab.classList.remove("active")); button.classList.add("active"); renderCategoryTable(category); }); tabs.append(button); }); renderCategoryTable(categories[0]);
}

function renderCategoryTable(category) {
  const body = el("student-marks-body"); body.replaceChildren(); const items = category?.items || [];
  items.forEach((item) => { const o = Number(item.obtained || 0), t = Number(item.total || 0); const row = document.createElement("tr"); [item.name, o, t, percent(o, t)].forEach((value) => { const cell = document.createElement("td"); cell.textContent = value; row.append(cell); }); body.append(row); });
  const obtained = preciseTotal(items.map((item) => item.obtained)); const total = preciseTotal(items.map((item) => item.total));
  if (!items.length) { const row = document.createElement("tr"); const cell = document.createElement("td"); cell.colSpan = 4; cell.className = "empty-cell"; cell.textContent = "Marks have not been published."; row.append(cell); body.append(row); }
  el("category-obtained").textContent = items.length ? obtained : "—"; el("category-total").textContent = items.length ? total : "—"; el("category-percent").textContent = items.length ? percent(obtained, total) : "—";
}

function startAdminListeners() {
  if (unsubscribeUsers) unsubscribeUsers(); if (unsubscribeEnrollments) unsubscribeEnrollments(); if (unsubscribePrivateMarks) unsubscribePrivateMarks();
  privateMarksReady = false; privateMarksFromCache = true; enrollmentMarksFromCache = true; privateMarksByEnrollment = new Map(); renderMarksVisibility();
  unsubscribePrivateMarks = onSnapshot(collection(db, "private_marks"), (snapshot) => {
    privateMarksByEnrollment = new Map(snapshot.docs.map((item) => [item.id, { id: item.id, ...item.data() }])); privateMarksReady = true; privateMarksFromCache = Boolean(snapshot.metadata?.fromCache);
    updateReportSyncStatus();
    renderMarksVisibility(); refreshReportCategories(); if (!el("report-table").hidden) generateReport();
  }, (error) => { privateMarksReady = false; renderMarksVisibility(); el("visibility-message").textContent = friendlyError(error); setReportSyncStatus(`Protected marks could not be synchronized. ${friendlyError(error)}`, true); });
  unsubscribeUsers = onSnapshot(collection(db, "users"), (snapshot) => { users = snapshot.docs.map((item) => ({ id: item.id, ...item.data() })); renderEnrollmentList(); void reconcileRegistrationClaims(); void repairMissingGithubProfiles(); });
  unsubscribeEnrollments = onSnapshot(collection(db, "enrollments"), (snapshot) => { enrollments = snapshot.docs.map((item) => ({ id: item.id, ...item.data() })); enrollmentMarksFromCache = Boolean(snapshot.metadata?.fromCache); updateReportSyncStatus(); renderEnrollmentList(); renderMarksVisibility(); refreshReportCategories(); if (!el("report-table").hidden) generateReport(); }, (error) => setReportSyncStatus(`Enrollment marks could not be synchronized. ${friendlyError(error)}`, true));
  startGradingRunsListener();
}

function timestampMillis(value) {
  if (value?.toMillis) return value.toMillis();
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function reviewRunLabel(run) {
  const number = run.source_run_number || run.run_id || run.id;
  return `#${number} · ${run.course_code || "Course"} · ${run.assessment || "Assessment"} · ${String(run.status || "unknown").replaceAll("_", " ")}`;
}

function startGradingRunsListener() {
  if (unsubscribeGradingRuns) unsubscribeGradingRuns();
  unsubscribeGradingRuns = onSnapshot(collection(db, "grading_runs"), (snapshot) => {
    gradingRuns = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
      .sort((left, right) => timestampMillis(right.created_at) - timestampMillis(left.created_at) || right.id.localeCompare(left.id));
    const select = el("review-run-select"); const previous = selectedReviewRunId; select.replaceChildren(new Option("Select a staged grading run", ""));
    gradingRuns.forEach((run) => select.add(new Option(reviewRunLabel(run), run.id)));
    if (previous && gradingRuns.some((run) => run.id === previous)) { select.value = previous; renderReviewPanel(); return; }
    const preferred = gradingRuns.find((run) => !["finalized", "staging"].includes(run.status)) || gradingRuns[0];
    select.value = preferred?.id || "";
    selectReviewRun(select.value);
  }, (error) => {
    el("review-run-summary").textContent = `Grading reviews could not be loaded. ${friendlyError(error)}`;
  });
}

function selectReviewRun(runId) {
  if (unsubscribeReviewItems) unsubscribeReviewItems();
  if (unsubscribeReviewResults) unsubscribeReviewResults();
  if (unsubscribeReviewCriteria) unsubscribeReviewCriteria();
  unsubscribeReviewItems = unsubscribeReviewResults = unsubscribeReviewCriteria = null;
  selectedReviewRunId = runId; reviewItems = []; reviewResults = new Map(); reviewCriteria = new Map(); reviewQuestionIndex = 0; reviewStudentIndex = 0; reviewReferenceIndex = 0;
  if (!runId) { renderReviewPanel(); return; }
  unsubscribeReviewItems = onSnapshot(collection(db, "grading_runs", runId, "items"), (snapshot) => {
    reviewItems = snapshot.docs.map((item) => ({ id: item.id, ...item.data() })); renderReviewPanel();
  }, (error) => { el("review-message").textContent = friendlyError(error); });
  unsubscribeReviewResults = onSnapshot(collection(db, "grading_runs", runId, "results"), (snapshot) => {
    reviewResults = new Map(snapshot.docs.map((item) => [item.id, item.data()?.result || {}])); renderReviewPanel();
  }, (error) => { el("review-message").textContent = friendlyError(error); });
  unsubscribeReviewCriteria = onSnapshot(collection(db, "grading_runs", runId, "criteria"), (snapshot) => {
    reviewCriteria = new Map(snapshot.docs.map((item) => {
      const value = { id: item.id, ...item.data() };
      return [String(value.criterion_id || item.id), value];
    }));
    renderReviewPanel();
  }, (error) => { el("review-reference-message").textContent = friendlyError(error); });
  renderReviewPanel();
}

function reviewStatusLabel(status) {
  return ({ staging: "Preparing", reviewing: "Review required", ready: "Ready to finalize", finalizing: "Finalizing", finalization_failed: "Finalization failed", finalized: "Finalized" })[status] || "Unknown";
}

function markNumber(value) { return Number(value || 0).toLocaleString("en-US", { maximumFractionDigits: 2 }); }

function renderReviewPanel() {
  const run = gradingRuns.find((candidate) => candidate.id === selectedReviewRunId);
  const status = el("review-run-status"); status.className = "badge"; status.textContent = run ? reviewStatusLabel(run.status) : "No run selected";
  if (run && ["ready", "finalizing", "finalized"].includes(run.status)) status.classList.add("published");
  el("review-run-settings").textContent = run ? `Publish marks: ${run.requested_update_firestore ? "yes" : "no"} · Email: ${run.requested_send_email ? "yes" : "no"}` : "";
  const sourceLink = el("review-open-source-run"); sourceLink.hidden = !run?.source_workflow_url;
  if (run?.source_workflow_url) sourceLink.href = run.source_workflow_url; else sourceLink.removeAttribute("href");
  const deleteRun = el("review-delete-run"); deleteRun.hidden = !run;
  const activeRun = run && ["staging", "finalizing"].includes(run.status);
  deleteRun.disabled = Boolean(run && (deletingReviewRunId || activeRun));
  deleteRun.title = activeRun ? "Wait for the active grading workflow to finish before deleting this run." : "Permanently remove this grading run from the review portal.";

  if (!run) {
    el("review-run-summary").textContent = "Select a grading run. Only possible false positives and false negatives appear here.";
    el("review-empty").hidden = false; el("review-workspace").hidden = true; return;
  }

  const progress = reviewProgress(reviewItems);
  el("review-run-summary").textContent = `${progress.resolved}/${progress.total} suspicious screenshot(s) decided; ${progress.pending} unresolved${progress.deferred ? `, including ${progress.deferred} marked Review later` : ""}. Automatic score changes are previews until finalization.`;
  el("review-empty").hidden = true; el("review-workspace").hidden = false;
  const groups = groupReviewItems(reviewItems);
  reviewQuestionIndex = Math.min(Math.max(reviewQuestionIndex, 0), Math.max(0, groups.length - 1));
  const group = groups[reviewQuestionIndex];
  reviewStudentIndex = Math.min(Math.max(reviewStudentIndex, 0), Math.max(0, (group?.items.length || 1) - 1));
  const item = group?.items[reviewStudentIndex];
  el("review-progress-row").hidden = !item;
  el("review-evidence-card").hidden = !item;

  if (item) {
    el("review-question-progress").textContent = `Criterion ${reviewQuestionIndex + 1} of ${groups.length}: ${group.label}`;
    el("review-student-progress").textContent = `Student ${reviewStudentIndex + 1} of ${group.items.length}`;
    el("review-prev-question").disabled = reviewQuestionIndex === 0;
    el("review-next-question").disabled = reviewQuestionIndex >= groups.length - 1;
    el("review-prev-student").disabled = reviewStudentIndex === 0;
    el("review-next-student").disabled = reviewStudentIndex >= group.items.length - 1;
    el("review-category").textContent = item.audit_category || "Suspicious evidence";
    el("review-criterion").textContent = group.label;
    el("review-student").textContent = `${item.registration_number || "No registration"} · ${item.github_username || "No username"}`;
    const decisionLabels = { pending: "Pending", valid: "Evidence valid", invalid: "Evidence invalid", "review-later": "Review later" };
    el("review-decision-status").textContent = decisionLabels[item.decision] || "Pending";
    el("review-expected-filename").textContent = item.expected_filename || "";

    const criterion = reviewCriteria.get(String(group.id));
    const legacyReferenceUrl = item.reference_image_url || group.referenceImageUrl;
    const references = criterion
      ? selectedReferenceCandidates(criterion)
      : (legacyReferenceUrl ? [{ id: "legacy-reference", source: "instructor", label: "Instructor reference", image_url: legacyReferenceUrl }] : []);
    reviewReferenceIndex = Math.min(Math.max(reviewReferenceIndex, 0), Math.max(0, references.length - 1));
    const reference = references[reviewReferenceIndex];
    const referenceUrl = String(reference?.image_url || "");
    el("review-reference-link").hidden = !referenceUrl;
    el("review-reference-unavailable").hidden = Boolean(referenceUrl);
    if (referenceUrl) {
      el("review-reference-link").href = referenceUrl;
      el("review-reference-image").src = referenceUrl;
    } else {
      el("review-reference-link").removeAttribute("href");
      el("review-reference-image").removeAttribute("src");
    }
    el("review-reference-count").textContent = references.length ? `Expected image ${reviewReferenceIndex + 1} of ${references.length}` : "No expected image selected";
    el("review-reference-meta").textContent = reference
      ? `${reference.label || "Expected evidence"}${reference.source === "student-full-credit" ? " · received full automatic credit" : ""}`
      : "";
    el("review-reference-prev").disabled = references.length < 2 || reviewReferenceIndex === 0;
    el("review-reference-next").disabled = references.length < 2 || reviewReferenceIndex >= references.length - 1;
    const manager = el("review-reference-manager"); manager.hidden = !criterion;
    const options = el("review-reference-options"); options.replaceChildren();
    if (criterion) {
      const selectedIds = new Set((criterion.selected_reference_ids || []).map(String));
      for (const candidate of criterion.reference_candidates || []) {
        const option = document.createElement("label"); option.className = "review-reference-option";
        const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.value = String(candidate.id || ""); checkbox.checked = selectedIds.has(checkbox.value); checkbox.disabled = savingReferenceSelection || ["staging", "finalizing", "finalized"].includes(run.status);
        const text = document.createElement("span");
        const title = document.createElement("strong"); title.textContent = candidate.label || "Expected image";
        const detail = document.createElement("small"); detail.textContent = candidate.source === "instructor" ? "Instructor-provided reference" : `Clean full-credit submission${candidate.submitted_path ? ` · ${candidate.submitted_path}` : ""}`;
        text.append(title, detail); option.append(checkbox, text); options.append(option);
      }
      if (!(criterion.reference_candidates || []).length) {
        const empty = document.createElement("p"); empty.className = "muted"; empty.textContent = "No clean full-credit image is available for this criterion."; options.append(empty);
      }
      el("review-save-references").disabled = savingReferenceSelection || ["staging", "finalizing", "finalized"].includes(run.status) || !(criterion.reference_candidates || []).length;
    }

    const referenceLocked = savingReferenceSelection || ["staging", "finalizing", "finalized"].includes(run.status) || !criterion || !reference;
    el("review-reference-invalid").disabled = referenceLocked;

    const imageAvailable = Boolean(item.student_image_url);
    el("review-student-image-frame").hidden = !imageAvailable; el("review-image-link").hidden = !imageAvailable; el("review-image-unavailable").hidden = imageAvailable;
    if (imageAvailable) { el("review-student-image-frame").href = item.student_image_url; el("review-student-image").src = item.student_image_url; el("review-image-link").href = item.student_image_url; }
    el("review-automatic-result").textContent = `${item.automatic_status || "Unknown"} — ${item.automatic_reason || "No explanation"}`;
    el("review-flag-reason").textContent = item.audit_reason || "Selected by the risk-based audit.";
    el("review-mark-effect").textContent = `${markNumber(item.automatic_points)} automatic → ${markNumber(decisionPoints(item))}/${markNumber(item.max_points)} with this decision`;
    const result = reviewResults.get(item.enrollment_id) || {};
    const studentItems = reviewItems.filter((candidate) => candidate.enrollment_id === item.enrollment_id);
    el("review-projected-score").textContent = `${markNumber(projectedScore(result, studentItems))}/${markNumber(result.total)}`;
    el("review-ocr-text").textContent = item.ocr_text || "No saved OCR text is available for this image.";
    el("review-note").value = item.reviewer_note || "";
    [["review-valid", "valid"], ["review-invalid", "invalid"], ["review-later", "review-later"]].forEach(([id, decision]) => el(id).classList.toggle("selected", item.decision === decision));
    const locked = savingReviewDecision || ["staging", "finalizing", "finalized"].includes(run.status);
    ["review-valid", "review-invalid", "review-later"].forEach((id) => { el(id).disabled = locked; });
  }

  const complete = progress.pending === 0 && run.status !== "staging";
  el("review-finalize").hidden = !complete;
  const confirmed = Boolean(run.review_completed_at) || ["finalizing", "finalized"].includes(run.status);
  el("review-confirm").hidden = confirmed;
  el("review-finalize-link").hidden = !confirmed || run.status === "finalized";
  el("review-run-id").textContent = run.run_id || run.id;
  el("review-open-finalize").href = run.finalization_workflow_url || "https://github.com/WaqasSaleem97/CC-Autograder/actions/workflows/finalize-review.yml";
  if (run.status === "finalized") el("review-finalize").querySelector("p").textContent = "The reviewed marks were finalized. Requested portal publishing and email delivery have completed.";
}

function currentReviewItem() {
  const groups = groupReviewItems(reviewItems); return groups[reviewQuestionIndex]?.items[reviewStudentIndex] || null;
}

function currentReviewCriterion() {
  const group = groupReviewItems(reviewItems)[reviewQuestionIndex];
  return group ? reviewCriteria.get(String(group.id)) : null;
}

function moveReviewReference(direction) {
  const criterion = currentReviewCriterion();
  const group = groupReviewItems(reviewItems)[reviewQuestionIndex];
  const item = group?.items[reviewStudentIndex];
  const legacyUrl = item?.reference_image_url || group?.referenceImageUrl;
  const references = criterion ? selectedReferenceCandidates(criterion) : (legacyUrl ? [{ image_url: legacyUrl }] : []);
  reviewReferenceIndex = Math.min(Math.max(reviewReferenceIndex + direction, 0), Math.max(0, references.length - 1));
  el("review-reference-decision-message").textContent = "";
  renderReviewPanel();
}

async function invalidateCurrentReference() {
  const criterion = currentReviewCriterion();
  const run = gradingRuns.find((candidate) => candidate.id === selectedReviewRunId);
  const references = criterion ? selectedReferenceCandidates(criterion) : [];
  const reference = references[reviewReferenceIndex];
  if (!criterion || !run || !reference || savingReferenceSelection || ["staging", "finalizing", "finalized"].includes(run.status)) return;
  const allowed = new Set((criterion.reference_candidate_ids || []).map(String));
  const referenceId = String(reference.id || "");
  if (!allowed.has(referenceId)) return;
  const selected = new Set((criterion.selected_reference_ids || []).map(String).filter((id) => allowed.has(id)));
  selected.delete(referenceId);
  const selectedIds = [...selected];
  savingReferenceSelection = true;
  el("review-reference-decision-message").className = "message";
  el("review-reference-decision-message").textContent = "Saving expected-evidence decision…";
  renderReviewPanel();
  try {
    await updateDoc(doc(db, "grading_runs", run.id, "criteria", criterion.id), {
      selected_reference_ids: selectedIds,
      reviewer_uid: currentUser.uid,
      reviewed_at: serverTimestamp(),
      updated_at: serverTimestamp()
    });
    criterion.selected_reference_ids = selectedIds;
    reviewReferenceIndex = Math.min(reviewReferenceIndex, Math.max(0, selectedIds.length - 1));
    el("review-reference-decision-message").className = "message success";
    el("review-reference-decision-message").textContent = reference.source === "student-full-credit"
      ? `${reference.label || "Student evidence"} marked invalid. Only this evidence criterion will be set to zero during finalization; the student's other evidence is unchanged.`
      : "Expected evidence marked invalid and removed from comparisons.";
  } catch (error) {
    el("review-reference-decision-message").className = "message";
    el("review-reference-decision-message").textContent = friendlyError(error);
  } finally {
    savingReferenceSelection = false;
    renderReviewPanel();
  }
}

async function saveReferenceSelection() {
  const criterion = currentReviewCriterion();
  const run = gradingRuns.find((candidate) => candidate.id === selectedReviewRunId);
  if (!criterion || !run || savingReferenceSelection || ["staging", "finalizing", "finalized"].includes(run.status)) return;
  const allowed = new Set((criterion.reference_candidate_ids || []).map(String));
  const selectedIds = [...el("review-reference-options").querySelectorAll('input[type="checkbox"]:checked')]
    .map((input) => input.value)
    .filter((id) => allowed.has(id));
  savingReferenceSelection = true;
  el("review-reference-message").className = "message";
  el("review-reference-message").textContent = "Saving expected images…";
  renderReviewPanel();
  try {
    await updateDoc(doc(db, "grading_runs", run.id, "criteria", criterion.id), {
      selected_reference_ids: selectedIds,
      reviewer_uid: currentUser.uid,
      reviewed_at: serverTimestamp(),
      updated_at: serverTimestamp()
    });
    criterion.selected_reference_ids = selectedIds;
    reviewReferenceIndex = 0;
    el("review-reference-message").className = "message success";
    el("review-reference-message").textContent = `${selectedIds.length} expected image(s) selected for this criterion.`;
  } catch (error) {
    el("review-reference-message").className = "message";
    el("review-reference-message").textContent = friendlyError(error);
  } finally {
    savingReferenceSelection = false;
    renderReviewPanel();
  }
}

async function saveReviewDecision(decision) {
  const item = currentReviewItem(); const runId = selectedReviewRunId;
  if (!item || !runId || savingReviewDecision) return;
  savingReviewDecision = true; el("review-message").textContent = "Saving decision…"; renderReviewPanel();
  try {
    const itemRef = doc(db, "grading_runs", runId, "items", item.id); const runRef = doc(db, "grading_runs", runId);
    const note = el("review-note").value.trim();
    await runTransaction(db, async (transaction) => {
      const [itemSnapshot, runSnapshot] = await Promise.all([transaction.get(itemRef), transaction.get(runRef)]);
      if (!itemSnapshot.exists() || !runSnapshot.exists()) throw new Error("This review item or grading run no longer exists.");
      const savedItem = itemSnapshot.data(); const savedRun = runSnapshot.data();
      if (["staging", "finalizing", "finalized"].includes(savedRun.status)) throw new Error("This grading run cannot be edited in its current state.");
      const wasResolved = ["valid", "invalid"].includes(savedItem.decision); const isResolved = ["valid", "invalid"].includes(decision);
      const pending = Math.max(0, Number(savedRun.pending_count || 0) + (wasResolved ? 1 : 0) - (isResolved ? 1 : 0));
      transaction.update(itemRef, { decision, reviewer_note: note, reviewer_uid: currentUser.uid, reviewed_at: serverTimestamp() });
      transaction.update(runRef, { status: pending === 0 ? "ready" : "reviewing", pending_count: pending, reviewed_count: Math.max(0, Number(savedRun.item_count || 0) - pending), reviewer_uid: currentUser.uid, review_completed_at: null, updated_at: serverTimestamp() });
    });
    item.decision = decision; item.reviewer_note = note; el("review-message").className = "message success"; el("review-message").textContent = "Decision saved.";
  } catch (error) { el("review-message").className = "message"; el("review-message").textContent = friendlyError(error); }
  finally { savingReviewDecision = false; renderReviewPanel(); }
}

function moveReviewQuestion(direction) { const groups = groupReviewItems(reviewItems); reviewQuestionIndex = Math.min(Math.max(reviewQuestionIndex + direction, 0), Math.max(0, groups.length - 1)); reviewStudentIndex = 0; reviewReferenceIndex = 0; el("review-reference-message").textContent = ""; el("review-reference-decision-message").textContent = ""; renderReviewPanel(); }
function moveReviewStudent(direction) { const group = groupReviewItems(reviewItems)[reviewQuestionIndex]; reviewStudentIndex = Math.min(Math.max(reviewStudentIndex + direction, 0), Math.max(0, (group?.items.length || 1) - 1)); renderReviewPanel(); }

async function confirmReviewComplete() {
  const run = gradingRuns.find((candidate) => candidate.id === selectedReviewRunId); const progress = reviewProgress(reviewItems);
  if (!run || progress.pending) return;
  el("review-confirm").disabled = true;
  try {
    await updateDoc(doc(db, "grading_runs", run.id), { status: "ready", pending_count: 0, reviewed_count: progress.total, reviewer_uid: currentUser.uid, review_completed_at: serverTimestamp(), updated_at: serverTimestamp() });
    el("review-message").className = "message success"; el("review-message").textContent = "Review confirmed. Open the finalization workflow below; no grading runner is waiting.";
  } catch (error) { el("review-message").className = "message"; el("review-message").textContent = friendlyError(error); }
  finally { el("review-confirm").disabled = false; }
}

async function deleteDocumentReferences(references) {
  for (let start = 0; start < references.length; start += 450) {
    const batch = writeBatch(db);
    references.slice(start, start + 450).forEach((reference) => batch.delete(reference));
    await batch.commit();
  }
}

async function deleteSelectedGradingRun() {
  const run = gradingRuns.find((candidate) => candidate.id === selectedReviewRunId);
  if (!run || deletingReviewRunId) return;
  if (["staging", "finalizing"].includes(run.status)) {
    el("review-run-message").className = "message";
    el("review-run-message").textContent = "This grading workflow is still active. Wait for it to finish before deleting the run.";
    return;
  }
  const warning = `Delete grading run ${reviewRunLabel(run)}? This permanently removes its review items, expected-evidence selections, and provisional results from this portal. Published marks, sent emails, student submissions, and the GitHub Actions history will not be changed. This cannot be undone.`;
  if (!confirm(warning)) return;
  deletingReviewRunId = run.id;
  el("review-run-message").className = "message";
  el("review-run-message").textContent = "Deleting grading run and its stored review data…";
  renderReviewPanel();
  try {
    const childCollections = ["items", "criteria", "results"];
    const snapshots = await Promise.all(childCollections.map((name) => getDocs(collection(db, "grading_runs", run.id, name))));
    await deleteDocumentReferences(snapshots.flatMap((snapshot) => snapshot.docs.map((item) => item.ref)));
    if (selectedReviewRunId === run.id) selectReviewRun("");
    await deleteDoc(doc(db, "grading_runs", run.id));
    el("review-run-message").className = "message success";
    el("review-run-message").textContent = `Grading run #${run.source_run_number || run.run_id || run.id} was deleted. Published marks and GitHub Actions history were not changed.`;
  } catch (error) {
    if (!selectedReviewRunId) {
      el("review-run-select").value = run.id;
      selectReviewRun(run.id);
    }
    el("review-run-message").className = "message";
    el("review-run-message").textContent = `The grading run could not be completely deleted. ${friendlyError(error)}`;
  } finally {
    deletingReviewRunId = "";
    renderReviewPanel();
  }
}

async function repairMissingGithubProfiles(profiles = users, retry = false) {
  const candidates = profiles.filter((profile) => (!String(profile.github_id || "").trim() || !String(profile.user_name || "").trim()) && githubAccountId(profile));
  await Promise.all(candidates.map(async (profile) => {
    const accountId = githubAccountId(profile); const attemptKey = `${profile.id}:${accountId}`;
    const missingUsername = !String(profile.user_name || "").trim();
    if (retry) githubProfileRepairAttempts.delete(attemptKey);
    if (githubProfileRepairAttempts.has(attemptKey)) return;
    githubProfileRepairAttempts.add(attemptKey);
    const remote = await fetchGithubProfileById(accountId, fetch);
    if (!remote) { githubProfileRepairAttempts.delete(attemptKey); return; }
    const patch = {};
    if (!String(profile.github_id || "").trim()) patch.github_id = String(remote.id || accountId);
    if (missingUsername) patch.user_name = String(remote.login || "").trim();
    if (!Object.keys(patch).length || (missingUsername && !patch.user_name)) return;
    try { await updateDoc(doc(db, "users", profile.id), patch); }
    catch { githubProfileRepairAttempts.delete(attemptKey); }
  }));
}

async function reconcileRegistrationClaims() {
  if (syncingRegistrationClaims) { registrationClaimSyncQueued = true; return; }
  syncingRegistrationClaims = true;
  try {
    do {
      registrationClaimSyncQueued = false;
      const desiredClaims = [...registrationGroups()].map(([registration, profiles]) => registrationClaimData(registration, profiles));
      const snapshot = await getDocs(collection(db, "registration_claims"));
      const existingClaims = new Map(snapshot.docs.map((item) => [item.id, item.data()]));
      const changes = desiredClaims.filter((claim) => !registrationClaimMatches(existingClaims.get(claim.registration_number), claim));
      for (let start = 0; start < changes.length; start += 450) {
        const batch = writeBatch(db);
        changes.slice(start, start + 450).forEach((claim) => batch.set(doc(db, "registration_claims", claim.registration_number), claim));
        await batch.commit();
      }
      registrationClaimSyncError = "";
      renderRegistrationIntegrityMessage();
    } while (registrationClaimSyncQueued);
  } catch (error) {
    registrationClaimSyncError = `Registration-number protection could not be synchronized. ${friendlyError(error)}`;
    renderRegistrationIntegrityMessage();
  } finally { syncingRegistrationClaims = false; }
}

function setCourseMessage(message, success = false) { el("course-message").className = success ? "message success" : "message"; el("course-message").textContent = message; }
function setCourseSaving(saving) {
  savingCourse = saving; el("course-form").setAttribute("aria-busy", String(saving));
  document.querySelectorAll("#course-form input, #course-form button, .course-edit-button, .course-delete-button").forEach((control) => { control.disabled = saving; });
}
function resetCourseForm() {
  editingCourseId = null; el("course-form").reset(); el("course-form-title").textContent = "Create Course"; el("course-submit").textContent = "Create course"; el("course-cancel").hidden = true;
}
function beginCourseEdit(course) {
  if (savingCourse) return;
  editingCourseId = course.id; el("course-form-title").textContent = "Edit Course"; el("course-submit").textContent = "Save changes"; el("course-cancel").hidden = false;
  el("course-name").value = course.name || ""; el("course-code").value = course.code || ""; el("course-sections").value = (course.sections || []).join(", "); setCourseMessage(""); el("course-name").focus();
}
function renderCourseList() {
  const container = el("course-list"); if (!container) return; container.replaceChildren();
  courses.forEach((course) => {
    const chip = document.createElement("div"); chip.className = "course-chip";
    const label = document.createElement("span"); label.className = "course-chip-label"; label.textContent = `${course.code}: ${course.name} (${(course.sections || []).join(", ")})`;
    const edit = document.createElement("button"); edit.type = "button"; edit.className = "course-edit-button"; edit.textContent = "Edit"; edit.disabled = savingCourse; edit.title = `Edit ${course.code || "course"}`; edit.setAttribute("aria-label", `Edit ${course.code || "course"}`); edit.addEventListener("click", () => beginCourseEdit(course));
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "course-delete-button"; remove.textContent = "Delete"; remove.disabled = savingCourse; remove.title = `Delete ${course.code || "course"}`; remove.setAttribute("aria-label", `Delete ${course.code || "course"}`); remove.addEventListener("click", () => deleteCourse(course));
    const actions = document.createElement("span"); actions.className = "course-chip-actions"; actions.append(edit, remove);
    chip.append(label, actions); container.append(chip);
  });
}

function courseAssessmentCategories(courseId) {
  const names = new Map();
  enrollments.filter((enrollment) => enrollment.course_id === courseId).forEach((enrollment) => {
    markCategories(fullMarksForEnrollment(enrollment)).forEach((category) => {
      const key = categoryKey(category.name);
      if (key && !names.has(key)) names.set(key, String(category.name).trim());
    });
  });
  hiddenCategoryKeys(courseById(courseId)).forEach((key) => { if (!names.has(key)) names.set(key, key); });
  return [...names].map(([key, name]) => ({ key, name })).sort((a, b) => a.name.localeCompare(b.name));
}

function setMarkVisibilitySaving(saving) {
  savingMarkVisibility = saving;
  el("visibility-course").disabled = saving;
  el("save-mark-visibility").disabled = saving || !privateMarksReady || !courseAssessmentCategories(el("visibility-course").value).length;
  el("marks-visibility-title").closest("section").setAttribute("aria-busy", String(saving));
}

function renderMarksVisibility() {
  const list = el("visibility-category-list"); if (!list) return; list.replaceChildren();
  const course = courseById(el("visibility-course").value);
  const empty = (message) => { const text = document.createElement("p"); text.className = "visibility-empty"; text.textContent = message; list.append(text); };
  if (!course) { empty("Create a course to manage student marks visibility."); el("save-mark-visibility").disabled = true; return; }
  if (!privateMarksReady) { empty("Loading complete marks securely…"); el("save-mark-visibility").disabled = true; return; }
  const hidden = hiddenCategoryKeys(course); const categories = courseAssessmentCategories(course.id);
  if (!categories.length) { empty("No assessment categories exist for this course yet. Add marks in Students & Marks first."); el("save-mark-visibility").disabled = true; return; }
  categories.forEach(({ key, name }) => {
    const label = document.createElement("label"); label.className = `visibility-category-item${hidden.has(key) ? " is-hidden" : ""}`;
    const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.className = "visibility-category-checkbox"; checkbox.dataset.categoryKey = key; checkbox.checked = !hidden.has(key);
    const categoryName = document.createElement("span"); categoryName.className = "visibility-category-name"; categoryName.textContent = name;
    const status = document.createElement("span"); status.className = "visibility-category-status"; status.textContent = checkbox.checked ? "Visible" : "Admin only";
    checkbox.addEventListener("change", () => { label.classList.toggle("is-hidden", !checkbox.checked); status.textContent = checkbox.checked ? "Visible" : "Admin only"; });
    label.append(checkbox, categoryName, status); list.append(label);
  });
  el("save-mark-visibility").disabled = savingMarkVisibility;
}

async function saveMarksVisibility() {
  if (savingMarkVisibility) return;
  const course = courseById(el("visibility-course").value); if (!course) return;
  if (!privateMarksReady) { el("visibility-message").textContent = "Wait for the complete marks to load, then try again."; return; }
  const hidden = [...el("visibility-category-list").querySelectorAll(".visibility-category-checkbox:not(:checked)")].map((checkbox) => checkbox.dataset.categoryKey).filter(Boolean);
  const related = enrollments.filter((enrollment) => enrollment.course_id === course.id).map((enrollment) => ({ enrollment, marks: fullMarksForEnrollment(enrollment) }));
  setMarkVisibilitySaving(true); el("visibility-message").className = "message"; el("visibility-message").textContent = "";
  try {
    const targetCourse = { ...course, hidden_mark_categories: hidden };
    for (let start = 0; start < related.length; start += 249) {
      const batch = writeBatch(db);
      related.slice(start, start + 249).forEach(({ enrollment, marks }) => {
        batch.set(doc(db, "private_marks", enrollment.id), privateMarksDocument(enrollment, marks));
        batch.update(doc(db, "enrollments", enrollment.id), { marks: studentMarksForCourse(marks, targetCourse), updated_at: serverTimestamp() });
      });
      await batch.commit();
    }
    await updateDoc(doc(db, "courses", course.id), { hidden_mark_categories: hidden, updated_at: serverTimestamp() });
    course.hidden_mark_categories = hidden;
    renderMarksVisibility();
    el("visibility-message").className = "message success";
    el("visibility-message").textContent = hidden.length
      ? `Visibility saved for ${course.name}. ${hidden.length} categor${hidden.length === 1 ? "y is" : "ies are"} administrator-only.`
      : `Visibility saved for ${course.name}. All categories are visible to students.`;
  } catch (error) { el("visibility-message").textContent = friendlyError(error); }
  finally { setMarkVisibilitySaving(false); }
}

async function deleteCourseAndEnrollments(course, related) {
  const courseRef = doc(db, "courses", course.id);
  if (!related.length) { await deleteDoc(courseRef); return; }
  for (let start = 0; start < related.length; start += 249) {
    const batch = writeBatch(db); const group = related.slice(start, start + 249);
    group.forEach((enrollment) => { batch.delete(doc(db, "private_marks", enrollment.id)); batch.delete(doc(db, "enrollments", enrollment.id)); });
    if (start + 249 >= related.length) batch.delete(courseRef);
    await batch.commit();
  }
}

async function deleteCourse(course) {
  if (savingCourse) return;
  setCourseSaving(true); setCourseMessage("");
  try {
    const snapshot = await getDocs(query(collection(db, "enrollments"), where("course_id", "==", course.id)));
    const related = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
    const enrollmentWarning = related.length === 1 ? " It will also permanently delete 1 enrollment and its marks." : related.length > 1 ? ` It will also permanently delete ${related.length} enrollments and their marks.` : "";
    if (!confirm(`Delete ${course.code}: ${course.name}?${enrollmentWarning} Student accounts will remain. This cannot be undone.`)) return;
    await deleteCourseAndEnrollments(course, related);
    if (editingCourseId === course.id) resetCourseForm();
    if (related.some((item) => item.id === selectedEnrollmentId)) clearEditor();
    setCourseMessage(related.length ? `Course deleted with ${related.length} enrollment${related.length === 1 ? "" : "s"} and associated marks. Student accounts were kept.` : "Course deleted.", true);
  } catch (error) { setCourseMessage(friendlyError(error)); }
  finally { setCourseSaving(false); }
}

async function updateCourseAndEnrollments(course, name, code, sections) {
  const snapshot = await getDocs(query(collection(db, "enrollments"), where("course_id", "==", course.id)));
  const related = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
  const removedSections = [...new Set(related.map((item) => item.section).filter((section) => section && !sections.includes(section)))];
  if (removedSections.length) throw new Error(`Sections ${removedSections.join(", ")} still have enrolled students. Move those students to another section before removing these sections.`);
  const courseRef = doc(db, "courses", course.id);
  const firstBatch = writeBatch(db);
  firstBatch.update(courseRef, { name, code, sections, updated_at: serverTimestamp() });
  related.slice(0, 499).forEach((enrollment) => firstBatch.update(doc(db, "enrollments", enrollment.id), { course_name: name, course_code: code, updated_at: serverTimestamp() }));
  await firstBatch.commit();
  for (let start = 499; start < related.length; start += 500) {
    const batch = writeBatch(db);
    related.slice(start, start + 500).forEach((enrollment) => batch.update(doc(db, "enrollments", enrollment.id), { course_name: name, course_code: code, updated_at: serverTimestamp() }));
    await batch.commit();
  }
}

el("course-form").addEventListener("submit", async (event) => {
  event.preventDefault(); if (savingCourse) return; const name = el("course-name").value.trim(); const code = el("course-code").value.trim().toUpperCase(); const sections = [...new Set(el("course-sections").value.split(",").map((item) => item.trim().toUpperCase()).filter(Boolean))]; const id = courseIdForCode(code); const wasEditing = Boolean(editingCourseId);
  if (!name || !code || !sections.length || !id) { setCourseMessage("Enter a course name, code, and at least one section."); return; }
  const duplicate = courses.find((course) => course.id !== editingCourseId && String(course.code || "").trim().toUpperCase() === code);
  if (duplicate) { setCourseMessage(`Course code ${code} is already used by ${duplicate.name}.`); return; }
  const course = editingCourseId ? courseById(editingCourseId) : null;
  if (wasEditing && !course) { resetCourseForm(); setCourseMessage("The course no longer exists. Refresh the page and try again."); return; }
  setCourseSaving(true);
  try {
    if (course) { await updateCourseAndEnrollments(course, name, code, sections); resetCourseForm(); setCourseMessage("Course updated and existing enrollments synchronized.", true); }
    else { if (courseById(id)) { setCourseMessage(`Course code ${code} already exists. Use its Edit button to change it.`); return; } await setDoc(doc(db, "courses", id), { name, code, sections, active: true, hidden_mark_categories: [], created_at: serverTimestamp() }); resetCourseForm(); setCourseMessage("Course created.", true); }
  } catch (error) { setCourseMessage(friendlyError(error)); }
  finally { setCourseSaving(false); }
});
el("course-cancel").addEventListener("click", () => { resetCourseForm(); setCourseMessage(""); });

function filteredEnrollments() {
  const courseFilter = el("admin-course-filter").value; const search = el("user-search").value.toLowerCase();
  return enrollments.filter((item) => (courseFilter === "all" || item.course_id === courseFilter) && Boolean(item.approved) === (userListMode === "users") && `${displayName(profileById(item.user_id))} ${profileById(item.user_id)?.registration_number || ""} ${item.course_name} ${item.section}`.toLowerCase().includes(search));
}

function renderRegistrationIntegrityMessage() {
  const message = el("registration-integrity-message");
  if (!message) return;
  const duplicates = [...registrationGroups()].filter(([, profiles]) => profiles.length > 1).map(([registration]) => registration);
  message.className = "registration-integrity-message";
  if (registrationClaimSyncError) { message.classList.add("error"); message.textContent = registrationClaimSyncError; return; }
  if (duplicates.length) {
    message.classList.add("warning");
    message.textContent = `${duplicates.length} duplicate registration${duplicates.length === 1 ? "" : "s"} found: ${duplicates.join(", ")}. Delete the incorrect account; the remaining account will keep the registration number.`;
  } else message.textContent = "";
}

function renderEnrollmentList() {
  const groups = registrationGroups(); const courseFilter = el("admin-course-filter")?.value || "all"; const scoped = enrollments.filter((item) => courseFilter === "all" || item.course_id === courseFilter); el("approved-users-count").textContent = scoped.filter((item) => item.approved).length; el("pending-users-count").textContent = scoped.filter((item) => !item.approved).length;
  renderRegistrationIntegrityMessage();
  const list = el("users-list"); list.replaceChildren(); const items = filteredEnrollments();
  items.forEach((enrollment) => { const profile = profileById(enrollment.user_id) || {}; const registration = claimableRegistration(profile.registration_number); const duplicate = (groups.get(registration) || []).length > 1; const row = document.createElement("div"); row.className = `user-item${selectedEnrollmentId === enrollment.id ? " active" : ""}${duplicate ? " duplicate-registration" : ""}`; row.tabIndex = 0; const content = document.createElement("span"); content.className = "user-item-content"; const title = document.createElement("strong"); const username = String(profile.user_name || "").trim(); title.textContent = displayName(profile); content.append(title); const usernameLink = createGithubProfileLink(username, `@${username}`); if (usernameLink) { usernameLink.classList.add("user-item-github"); content.append(usernameLink); } const meta = document.createElement("span"); meta.textContent = `${profile.registration_number || "No registration"} · ${enrollment.course_name} (${enrollment.course_code}) Section ${enrollment.section}`; content.append(meta); if (duplicate) { const warning = document.createElement("span"); warning.className = "duplicate-registration-badge"; warning.textContent = "Duplicate registration"; content.append(warning); } const actions = document.createElement("span"); actions.className = "pending-actions";
    if (!enrollment.approved) actions.append(actionButton("✓", "Approve enrollment", "approve-user", (event) => approveEnrollment(event, enrollment)));
    actions.append(actionButton("E", "Delete enrollment", "delete-enrollment", (event) => deleteEnrollment(event, enrollment)));
    if (enrollment.approved) actions.append(actionButton("🗑", "Delete user and all enrollments", "delete-user", (event) => deleteUserAndEnrollments(event, enrollment.user_id, false)));
    else actions.append(actionButton("×", "Block user", "block-user", (event) => deleteUserAndEnrollments(event, enrollment.user_id, true)));
    row.append(content, actions); row.addEventListener("click", () => selectEnrollment(enrollment.id)); list.append(row); });
  if (!items.length) { const empty = document.createElement("p"); empty.className = "user-list-empty"; empty.textContent = userListMode === "pending" ? "No pending enrollments." : "No approved enrollments."; list.append(empty); }
}

function actionButton(text, title, className, handler) { const button = document.createElement("button"); button.type = "button"; button.className = `pending-action ${className}`; button.textContent = text; button.title = title; button.addEventListener("click", (event) => { event.stopPropagation(); handler(event); }); return button; }
async function approveEnrollment(event, enrollment) { event.currentTarget.disabled = true; try { await updateDoc(doc(db, "enrollments", enrollment.id), { approved: true, approved_at: serverTimestamp(), updated_at: serverTimestamp() }); } catch (error) { alert(friendlyError(error)); event.currentTarget.disabled = false; } }
async function deleteEnrollment(event, enrollment) { if (!confirm(`Delete only the ${enrollment.course_code} enrollment? The user profile and other courses will remain.`)) return; event.currentTarget.disabled = true; try { const batch = writeBatch(db); batch.delete(doc(db, "private_marks", enrollment.id)); batch.delete(doc(db, "enrollments", enrollment.id)); await batch.commit(); if (selectedEnrollmentId === enrollment.id) clearEditor(); } catch (error) { alert(friendlyError(error)); } }

async function deleteUserAndEnrollments(event, userId, block) {
  const profile = profileById(userId) || {}; const message = block ? `Delete ${displayName(profile)}, remove every course enrollment and block future access?` : `Delete ${displayName(profile)} and every course enrollment? The person can register again later.`;
  if (!confirm(message)) return; event.currentTarget.disabled = true;
  try {
    const related = enrollments.filter((item) => item.user_id === userId); const groups = [];
    for (let start = 0; start < related.length; start += 247) groups.push(related.slice(start, start + 247));
    if (!groups.length) groups.push([]);
    for (const [index, group] of groups.entries()) {
      const batch = writeBatch(db);
      group.forEach((item) => { batch.delete(doc(db, "private_marks", item.id)); batch.delete(doc(db, "enrollments", item.id)); });
      if (index === groups.length - 1) {
        batch.delete(doc(db, "users", userId));
        const registration = claimableRegistration(profile.registration_number);
        if (registration) {
          const remaining = (registrationGroups().get(registration) || []).filter((item) => item.id !== userId);
          if (remaining.length) batch.set(doc(db, "registration_claims", registration), registrationClaimData(registration, remaining));
          else batch.delete(doc(db, "registration_claims", registration));
        }
        if (block) batch.set(doc(db, "blocked_users", userId), { firebase_uid: userId, github_id: profile.github_id || "", user_name: profile.user_name || "", email: profile.email || "", registration_number: profile.registration_number || "", blocked_at: serverTimestamp(), blocked_by: currentUser.uid });
      }
      await batch.commit();
    }
    if (selectedEnrollmentId && !enrollments.some((item) => item.id === selectedEnrollmentId && item.user_id !== userId)) clearEditor();
  }
  catch (error) { alert(friendlyError(error)); event.currentTarget.disabled = false; }
}

function clearEditor() { selectedEnrollmentId = null; el("student-editor").hidden = true; el("no-user-selected").hidden = false; }
function populateEditorCourse(enrollment, selectedSection = enrollment.section) {
  const course = courseById(enrollment.course_id); const sections = [...new Set([...(course?.sections || []), enrollment.section].filter(Boolean))];
  el("editor-course").value = `${course?.code || enrollment.course_code} — ${course?.name || enrollment.course_name}`;
  el("editor-section").replaceChildren(); sections.forEach((section) => el("editor-section").add(new Option(`Section ${section}`, section)));
  el("editor-section").value = sections.includes(selectedSection) ? selectedSection : enrollment.section;
}
function selectEnrollment(id) { if (!privateMarksReady) { alert("Complete marks are still loading. Try again in a moment."); return; } selectedEnrollmentId = id; const enrollment = enrollments.find((item) => item.id === id); if (!enrollment) return; const profile = profileById(enrollment.user_id) || {}; el("no-user-selected").hidden = true; el("student-editor").hidden = false; el("editor-name").textContent = displayName(profile); renderEditorIdentity(profile); populateEditorCourse(enrollment); el("editor-approved").value = String(Boolean(enrollment.approved)); el("editor-status").textContent = enrollment.approved ? "Approved" : "Pending"; el("editor-status").classList.toggle("published", enrollment.approved); el("category-editor").replaceChildren(); markCategories(fullMarksForEnrollment(enrollment)).forEach(addCategory); renderEnrollmentList(); }

function addMarkRow(container, item = {}) { const row = el("mark-row-template").content.firstElementChild.cloneNode(true); row.querySelector(".mark-name").value = item.name || ""; row.querySelector(".mark-obtained").value = item.obtained ?? ""; row.querySelector(".mark-total").value = item.total ?? ""; row.querySelector(".remove-row").addEventListener("click", () => row.remove()); container.append(row); }
function addCategory(category = {}) { const block = el("category-template").content.firstElementChild.cloneNode(true); block.querySelector(".category-name").value = category.name || ""; const rows = block.querySelector(".category-rows"); (category.items || []).forEach((item) => addMarkRow(rows, item)); block.querySelector(".add-mark").addEventListener("click", () => addMarkRow(rows)); block.querySelector(".remove-category").addEventListener("click", () => block.remove()); el("category-editor").append(block); }
function collectCategories() { return [...el("category-editor").querySelectorAll(".category-block")].map((block) => ({ name: block.querySelector(".category-name").value.trim(), items: [...block.querySelectorAll(".mark-row")].map((row) => ({ name: row.querySelector(".mark-name").value.trim(), obtained: Number(row.querySelector(".mark-obtained").value), total: Number(row.querySelector(".mark-total").value) })) })); }

el("student-editor").addEventListener("submit", async (event) => { event.preventDefault(); const enrollment = enrollments.find((item) => item.id === selectedEnrollmentId); if (!enrollment) return; const categories = collectCategories(); for (const category of categories) { if (!category.name || !category.items.length) { el("admin-message").textContent = "Every category needs a name and at least one entry."; return; } for (const item of category.items) if (item.obtained > item.total) { el("admin-message").textContent = `${item.name}: obtained marks cannot exceed total marks.`; return; } } try { const marks = { categories }; const batch = writeBatch(db); batch.set(doc(db, "private_marks", enrollment.id), privateMarksDocument(enrollment, marks)); batch.update(doc(db, "enrollments", enrollment.id), { section: el("editor-section").value, approved: el("editor-approved").value === "true", marks: studentMarksForCourse(marks, courseById(enrollment.course_id)), updated_at: serverTimestamp() }); await batch.commit(); el("admin-message").className = "message success"; el("admin-message").textContent = "Enrollment and marks saved."; } catch (error) { el("admin-message").className = "message"; el("admin-message").textContent = friendlyError(error); } });

function approvedReportEnrollments() { const courseId = el("report-course").value; const section = el("report-section").value; return enrollments.filter((item) => item.approved && item.course_id === courseId && (section === "both" || item.section === section)); }
function categoryDefinition(categoryName, scoped = approvedReportEnrollments()) { const map = new Map(); scoped.flatMap((item) => markCategories(fullMarksForEnrollment(item)).filter((category) => categoryKey(category.name) === categoryKey(categoryName)).flatMap((category) => category.items || [])).forEach((item) => { const key = categoryKey(item.name); if (key && !map.has(key)) map.set(key, { name: cleanMarkName(item.name), total: Number(item.total || 0) }); }); return [...map.values()]; }
function categoryItems(enrollment, categoryName) { return markCategories(fullMarksForEnrollment(enrollment)).filter((category) => categoryKey(category.name) === categoryKey(categoryName)).flatMap((category) => category.items || []); }
function categoryScore(enrollment, categoryName) { const items = categoryItems(enrollment, categoryName); return { obtained: preciseTotal(items.map((item) => item.obtained)), available: items.length > 0 }; }

function reportCategoryNames(scoped) { const names = new Map(); scoped.flatMap((item) => markCategories(fullMarksForEnrollment(item))).forEach((category) => { const key = categoryKey(category.name); if (key && !names.has(key)) names.set(key, cleanMarkName(category.name)); }); return [...names.values()].sort((a, b) => a.localeCompare(b)); }
function selectedReportCategory() { const select = el("report-category"); return cleanMarkName(select.value || select.options[select.selectedIndex]?.textContent || select.options[0]?.textContent); }
function refreshReportCategories() { const courseId = el("report-course")?.value; if (!courseId) return; const names = reportCategoryNames(enrollments.filter((item) => item.course_id === courseId)); const oldKey = categoryKey(selectedReportCategory()); const select = el("report-category"); select.replaceChildren(); names.forEach((name) => { const option = document.createElement("option"); option.textContent = name; option.value = name; select.add(option); }); const selected = names.find((name) => categoryKey(name) === oldKey); select.selectedIndex = Math.max(0, selected ? names.indexOf(selected) : 0); }

function setReportSyncStatus(message, error = false) { const status = el("report-sync-status"); status.textContent = message; status.className = error ? "message report-sync-status" : "message success report-sync-status"; }
function updateReportSyncStatus() { setReportSyncStatus(privateMarksFromCache || enrollmentMarksFromCache ? "Showing cached marks while the portal reconnects to Firestore…" : "Live marks are synchronized with Firestore.", privateMarksFromCache || enrollmentMarksFromCache); }
async function refreshReportFromServer() {
  const button = el("generate-report"); button.disabled = true; button.textContent = "Refreshing…"; setReportSyncStatus("Loading current enrollment and protected marks directly from Firestore…");
  try {
    const [enrollmentSnapshot, privateSnapshot] = await Promise.all([getDocsFromServer(collection(db, "enrollments")), getDocsFromServer(collection(db, "private_marks"))]);
    enrollments = enrollmentSnapshot.docs.map((item) => ({ id: item.id, ...item.data() })); privateMarksByEnrollment = new Map(privateSnapshot.docs.map((item) => [item.id, { id: item.id, ...item.data() }])); privateMarksReady = true; privateMarksFromCache = false; enrollmentMarksFromCache = false;
    renderEnrollmentList(); renderMarksVisibility(); refreshReportCategories(); generateReport(); setReportSyncStatus(`Current marks loaded directly from Firestore at ${new Date().toLocaleTimeString()}.`);
  } catch (error) { setReportSyncStatus(`Current marks could not be loaded from Firestore. ${friendlyError(error)}`, true); }
  finally { button.disabled = false; button.textContent = "Refresh & generate"; }
}

function generateReport() {
  const scoped = approvedReportEnrollments(); const type = el("report-type").value; const categoryName = selectedReportCategory(); const categoryNames = reportCategoryNames(scoped);
  if (type === "category") { const definitions = categoryDefinition(categoryName, scoped); currentReportColumns = ["Registration", "Student", "Section", ...definitions.map((item) => item.name), "Total"]; currentReport = scoped.map((enrollment) => { const profile = profileById(enrollment.user_id) || {}; const items = categoryItems(enrollment, categoryName); const row = { Registration: profile.registration_number || "", Student: displayName(profile), Section: enrollment.section, Total: preciseTotal(items.map((item) => item.obtained)) }; definitions.forEach((definition) => { const item = items.find((candidate) => categoryKey(candidate.name) === categoryKey(definition.name)); row[definition.name] = item?.obtained ?? ""; }); return row; }); currentReportTitle = `${courseById(el("report-course").value)?.code || "course"}-${categoryName}-report`; }
  else { currentReportColumns = ["Registration", "Student", "Section", ...categoryNames]; currentReport = scoped.map((enrollment) => { const profile = profileById(enrollment.user_id) || {}; const row = { Registration: profile.registration_number || "", Student: displayName(profile), Section: enrollment.section }; categoryNames.forEach((name) => { const score = categoryScore(enrollment, name); row[name] = score.available ? score.obtained : ""; }); return row; }); currentReportTitle = `${courseById(el("report-course").value)?.code || "course"}-overall-report`; }
  currentReport.sort((a, b) => a.Registration.localeCompare(b.Registration)); renderReportTable(); const reportRegistrationCounts = new Map(); currentReport.forEach((row) => reportRegistrationCounts.set(row.Registration, (reportRegistrationCounts.get(row.Registration) || 0) + 1)); const duplicateRegistrations = [...reportRegistrationCounts].filter(([registration, count]) => registration && count > 1).map(([registration]) => registration); const summary = el("report-summary"); summary.textContent = `${courseById(el("report-course").value)?.name || "Course"}, ${el("report-section").value === "both" ? "All Sections" : `Section ${el("report-section").value}`}: ${currentReport.length} approved students.${duplicateRegistrations.length ? ` Warning: duplicate registration${duplicateRegistrations.length === 1 ? "" : "s"} ${duplicateRegistrations.join(", ")}.` : ""}`; summary.classList.toggle("duplicate-warning", duplicateRegistrations.length > 0); el("csv-import-panel").hidden = false;
}

function renderReportTable() { const header = document.createElement("tr"); currentReportColumns.forEach((name) => { const cell = document.createElement("th"); cell.textContent = name; header.append(cell); }); el("report-head").replaceChildren(header); const body = el("report-body"); body.replaceChildren(); currentReport.forEach((row) => { const tr = document.createElement("tr"); currentReportColumns.forEach((column) => { const td = document.createElement("td"); td.textContent = row[column] === "" ? "—" : row[column]; tr.append(td); }); body.append(tr); }); el("report-table").hidden = false; el("download-report").disabled = !currentReport.length; }
function saveCsv(rows, filename) { const escape = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`; const blob = new Blob(["\uFEFF" + rows.map((row) => row.map(escape).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = filename.replaceAll(/[^a-zA-Z0-9._-]/g, "-"); link.click(); URL.revokeObjectURL(link.href); }
function downloadReport() { saveCsv([currentReportColumns, ...currentReport.map((row) => currentReportColumns.map((column) => row[column]))], `${currentReportTitle}.csv`); }

function templateDefinitions() { const scoped = approvedReportEnrollments(); if (el("report-type").value === "category") { const category = selectedReportCategory(); return categoryDefinition(category, scoped).map((item) => ({ category, ...item })); } const map = new Map(); scoped.forEach((enrollment) => markCategories(fullMarksForEnrollment(enrollment)).forEach((category) => (category.items || []).forEach((item) => { const key = `${categoryKey(category.name)}\u0000${categoryKey(item.name)}`; if (!map.has(key)) map.set(key, { category: cleanMarkName(category.name), name: cleanMarkName(item.name), total: Number(item.total || 0) }); }))); return [...map.values()]; }
function downloadTemplate() { const scoped = approvedReportEnrollments(), definitions = templateDefinitions(); if (!definitions.length) { el("csv-message").textContent = "No assessment fields exist for this course and section."; return; } const headers = ["Registration Number", "Student Name", "Section", ...definitions.map((item) => `${item.category} :: ${item.name} [Max:${item.total}]`)]; const rows = [headers, ...scoped.map((enrollment) => { const profile = profileById(enrollment.user_id) || {}; return [profile.registration_number || "", displayName(profile), enrollment.section, ...definitions.map((definition) => { const item = categoryItems(enrollment, definition.category).find((candidate) => categoryKey(candidate.name) === categoryKey(definition.name)); return item?.obtained ?? ""; })]; })]; saveCsv(rows, `${currentReportTitle}-template.csv`); }
function parseCsv(text) { const rows = []; let row = [], field = "", quoted = false; for (let i = 0; i < text.length; i++) { const char = text[i], next = text[i + 1]; if (quoted && char === '"' && next === '"') { field += '"'; i++; } else if (char === '"') quoted = !quoted; else if (char === "," && !quoted) { row.push(field); field = ""; } else if ((char === "\n" || char === "\r") && !quoted) { if (char === "\r" && next === "\n") i++; row.push(field); if (row.some(Boolean)) rows.push(row); row = []; field = ""; } else field += char; } row.push(field); if (row.some(Boolean)) rows.push(row); return rows; }

async function uploadMarksCsv() {
  const file = el("marks-csv").files[0]; if (!file) return; el("upload-marks").disabled = true;
  try {
    const rows = parseCsv((await file.text()).replace(/^\uFEFF/, "")); const headers = rows[0] || [];
    if (headers[0] !== "Registration Number" || headers[2] !== "Section") throw new Error("Use a template downloaded from this course report.");
    const definitions = headers.slice(3).map((header) => { const match = header.match(/^(.*?) :: (.*?) \[Max:([0-9.]+)\]$/); if (!match) throw new Error(`Invalid column: ${header}`); return { category: cleanMarkName(match[1]), name: cleanMarkName(match[2]), total: Number(match[3]) }; });
    const scoped = approvedReportEnrollments();
    const updates = rows.slice(1).map((row, index) => {
      const registration = String(row[0]).trim().toUpperCase(), section = String(row[2]).trim().toUpperCase();
      const enrollment = scoped.find((item) => profileById(item.user_id)?.registration_number === registration && item.section === section);
      if (!enrollment) throw new Error(`Row ${index + 2}: no approved matching enrollment.`);
      const values = definitions.map((definition, itemIndex) => { const obtained = Number(row[itemIndex + 3]); if (!Number.isFinite(obtained) || obtained < 0 || obtained > definition.total) throw new Error(`Row ${index + 2}: ${definition.name} must be 0-${definition.total}.`); return { ...definition, obtained }; });
      const uploadedCategories = new Set(values.map((value) => categoryKey(value.category))); const categories = markCategories(fullMarksForEnrollment(enrollment)).filter((category) => !uploadedCategories.has(categoryKey(category.name))); const grouped = new Map();
      values.forEach((value) => { const key = categoryKey(value.category); if (!grouped.has(key)) grouped.set(key, { name: cleanMarkName(value.category), items: [] }); grouped.get(key).items.push({ name: cleanMarkName(value.name), obtained: value.obtained, total: value.total }); });
      categories.push(...grouped.values()); return { enrollment, marks: { categories } };
    });
    for (let start = 0; start < updates.length; start += 249) {
      const batch = writeBatch(db);
      updates.slice(start, start + 249).forEach(({ enrollment, marks }) => { batch.set(doc(db, "private_marks", enrollment.id), privateMarksDocument(enrollment, marks)); batch.update(doc(db, "enrollments", enrollment.id), { marks: studentMarksForCourse(marks, courseById(enrollment.course_id)), updated_at: serverTimestamp() }); });
      await batch.commit();
    }
    el("csv-message").className = "message success"; el("csv-message").textContent = `${updates.length} enrollments updated.`; el("marks-csv").value = "";
  } catch (error) { el("csv-message").className = "message"; el("csv-message").textContent = friendlyError(error); }
  finally { el("upload-marks").disabled = !el("marks-csv").files.length; }
}

function stopListeners() { [unsubscribeCourses, unsubscribeUsers, unsubscribeEnrollments, unsubscribePrivateMarks, unsubscribeProfile, unsubscribeMyEnrollments, unsubscribeRegistrationRanges, unsubscribeGradingRuns, unsubscribeReviewItems, unsubscribeReviewResults, unsubscribeReviewCriteria].forEach((unsubscribe) => { if (unsubscribe) unsubscribe(); }); unsubscribeCourses = unsubscribeUsers = unsubscribeEnrollments = unsubscribePrivateMarks = unsubscribeProfile = unsubscribeMyEnrollments = unsubscribeRegistrationRanges = unsubscribeGradingRuns = unsubscribeReviewItems = unsubscribeReviewResults = unsubscribeReviewCriteria = null; privateMarksByEnrollment = new Map(); privateMarksReady = false; privateMarksFromCache = true; enrollmentMarksFromCache = true; registrationRanges = []; registrationRangesReady = false; gradingRuns = []; selectedReviewRunId = ""; reviewItems = []; reviewResults = new Map(); reviewCriteria = new Map(); reviewReferenceIndex = 0; resetRegistrationRangeForm(); updateRegistrationRangeHelp(); }

async function captureGithubProfile(result) {
  if (!result) return;
  const additional = getAdditionalUserInfo(result); const provider = result.user?.providerData?.find((item) => item.providerId === "github.com") || {};
  let profile = mergeGithubProfiles(githubProfileFromFirebaseUser(result.user), { ...(additional?.profile || {}), firebase_uid: result.user?.uid || "", login: additional?.profile?.login || additional?.username || "", id: additional?.profile?.id || provider.uid || "", name: additional?.profile?.name || result.user?.displayName || "", email: additional?.profile?.email || result.user?.email || "", avatar_url: additional?.profile?.avatar_url || result.user?.photoURL || "" });
  if (!profile.login) {
    try { const credential = GithubAuthProvider.credentialFromResult(result); if (credential?.accessToken) profile = mergeGithubProfiles(profile, await getGithubProfile(credential.accessToken)); }
    catch { /* The signed-in Firebase user can continue with provider data. */ }
  }
  cacheGithubProfile(profile);
}

let authResultPromise = Promise.resolve();

el("github-login").addEventListener("click", async () => {
  const button = el("github-login"); const mobile = shouldUseMobileGithubSignIn(navigator); button.disabled = true; el("login-message").textContent = mobile ? "Opening mobile GitHub sign-in…" : "Waiting for GitHub sign-in…";
  try {
    if (mobile) { await beginMobileGithubSignIn(firebaseConfig, window); return; }
    authResultPromise = signInWithPopup(auth, githubProvider).then(async (result) => { await captureGithubProfile(result); return result; });
    await authResultPromise;
  }
  catch (error) { button.disabled = false; el("login-message").textContent = friendlyError(error); }
});
el("registration-course").addEventListener("change", updateRegistrationSections); el("report-course").addEventListener("change", updateReportSections); el("visibility-course").addEventListener("change", () => { el("visibility-message").textContent = ""; renderMarksVisibility(); }); el("save-mark-visibility").addEventListener("click", saveMarksVisibility); el("report-type").addEventListener("change", () => { el("report-category-label").hidden = el("report-type").value !== "category"; }); el("admin-course-filter").addEventListener("change", renderEnrollmentList); el("user-search").addEventListener("input", renderEnrollmentList);
el("cancel-enrollment").addEventListener("click", () => { addingAnotherCourse = false; renderStudentState(); }); el("add-course").addEventListener("click", () => openEnrollmentForm(true)); el("pending-add-course").addEventListener("click", () => openEnrollmentForm(true));
el("add-category").addEventListener("click", () => addCategory()); document.querySelectorAll(".user-tab").forEach((button) => button.addEventListener("click", () => { userListMode = button.dataset.userView; document.querySelectorAll(".user-tab").forEach((tab) => tab.classList.toggle("active", tab === button)); renderEnrollmentList(); }));
el("refresh-users").addEventListener("click", () => { renderEnrollmentList(); void reconcileRegistrationClaims(); void repairMissingGithubProfiles(users, true); }); el("generate-report").addEventListener("click", () => { void refreshReportFromServer(); }); el("download-report").addEventListener("click", downloadReport); el("download-template").addEventListener("click", downloadTemplate); el("marks-csv").addEventListener("change", () => { el("upload-marks").disabled = !el("marks-csv").files.length; }); el("upload-marks").addEventListener("click", uploadMarksCsv); document.querySelectorAll(".signout-button").forEach((button) => button.addEventListener("click", () => signOut(auth)));
el("review-run-select").addEventListener("change", () => selectReviewRun(el("review-run-select").value));
el("review-prev-question").addEventListener("click", () => moveReviewQuestion(-1)); el("review-next-question").addEventListener("click", () => moveReviewQuestion(1));
el("review-prev-student").addEventListener("click", () => moveReviewStudent(-1)); el("review-next-student").addEventListener("click", () => moveReviewStudent(1));
el("review-reference-prev").addEventListener("click", () => moveReviewReference(-1)); el("review-reference-next").addEventListener("click", () => moveReviewReference(1));
el("review-reference-invalid").addEventListener("click", () => { void invalidateCurrentReference(); });
el("review-save-references").addEventListener("click", () => { void saveReferenceSelection(); });
el("review-valid").addEventListener("click", () => { void saveReviewDecision("valid"); }); el("review-invalid").addEventListener("click", () => { void saveReviewDecision("invalid"); }); el("review-later").addEventListener("click", () => { void saveReviewDecision("review-later"); });
el("review-confirm").addEventListener("click", () => { void confirmReviewComplete(); });
el("review-delete-run").addEventListener("click", () => { void deleteSelectedGradingRun(); });
el("review-copy-id").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(el("review-run-id").textContent); el("review-message").className = "message success"; el("review-message").textContent = "Grading run ID copied."; }
  catch { el("review-message").className = "message"; el("review-message").textContent = "Copy was blocked by the browser. Select the run ID and copy it manually."; }
});

onAuthStateChanged(auth, async (user) => { await authResultPromise; currentProfile = null; myEnrollments = []; addingAnotherCourse = false; stopListeners(); if (!user) { currentUser = null; clearCachedGithubProfile(); el("github-login").disabled = false; showView("login-view"); return; } try { await routeUser(user); } catch (error) { el("github-login").disabled = false; el("login-message").textContent = friendlyError(error); showView("login-view"); } });
