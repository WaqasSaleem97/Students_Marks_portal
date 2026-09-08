import { initializeApp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import { getAuth, GithubAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, collection, query, where, getDocs, writeBatch, onSnapshot, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);
const githubProvider = new GithubAuthProvider();
githubProvider.addScope("read:user");
githubProvider.addScope("user:email");

const el = (id) => document.getElementById(id);
const views = ["loading-view", "login-view", "registration-view", "pending-view", "blocked-view", "student-view", "admin-view"];
const allowedRegistrations = Array.from({ length: 99 }, (_, i) => `2024-BSE-${String(i + 1).padStart(2, "0")}`);

let currentUser = null;
let currentProfile = null;
let courses = [];
let users = [];
let enrollments = [];
let myEnrollments = [];
let selectedEnrollmentId = null;
let userListMode = "users";
let addingAnotherCourse = false;
let currentReport = [];
let currentReportColumns = [];
let currentReportTitle = "student-report";
let unsubscribeCourses = null;
let unsubscribeUsers = null;
let unsubscribeEnrollments = null;
let unsubscribeProfile = null;
let unsubscribeMyEnrollments = null;

function showView(id) { views.forEach((view) => { el(view).hidden = view !== id; }); }
function enrollmentId(uid, courseId) { return `${uid}__${courseId}`; }
function courseById(id) { return courses.find((course) => course.id === id); }
function profileById(id) { return users.find((user) => user.id === id); }
function displayName(profile = {}) { return [profile.first_name, profile.last_name].filter(Boolean).join(" ") || profile.user_name || "Student"; }
function percent(obtained, total) { return total > 0 ? `${((obtained / total) * 100).toFixed(1)}%` : "—"; }
function markCategories(marks = {}) { return Array.isArray(marks.categories) ? marks.categories : []; }
function friendlyError(error) {
  if (["permission-denied", "firestore/permission-denied"].includes(error?.code)) return "Access denied. Your account is blocked or does not have permission to use this portal.";
  if (error?.code === "auth/popup-closed-by-user") return "GitHub sign-in was cancelled.";
  if (error?.code === "auth/popup-blocked") return "Allow browser pop-ups and try GitHub sign-in again.";
  return error?.message || "The operation could not be completed.";
}

allowedRegistrations.forEach((number) => { const option = document.createElement("option"); option.value = number; el("registration-numbers").append(option); });

async function getGithubProfile(token) {
  const response = await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } });
  if (!response.ok) throw new Error("GitHub profile could not be loaded.");
  return response.json();
}

function splitName(name = "") { const parts = name.trim().split(/\s+/).filter(Boolean); return { first_name: parts.shift() || "", last_name: parts.join(" ") }; }

function startCoursesListener() {
  if (unsubscribeCourses) unsubscribeCourses();
  unsubscribeCourses = onSnapshot(collection(db, "courses"), (snapshot) => {
    courses = snapshot.docs.map((item) => ({ id: item.id, ...item.data() })).sort((a, b) => a.name.localeCompare(b.name));
    populateCourseControls(); renderCourseList(); refreshReportCategories();
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
  if (admin.exists()) { showView("admin-view"); startAdminListeners(); return; }
  const blocked = await getDoc(doc(db, "blocked_users", user.uid));
  if (blocked.exists()) { showView("blocked-view"); return; }
  startStudentListeners(user);
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
  el("cancel-enrollment").hidden = !additional; el("registration-message").textContent = ""; populateCourseControls();
  const existing = new Set(myEnrollments.map((item) => item.course_id)); [...el("registration-course").options].forEach((option) => { if (existing.has(option.value)) option.disabled = true; });
  showView("registration-view");
}

el("registration-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const registration = el("registration-number").value.trim().toUpperCase(); const courseId = el("registration-course").value; const section = el("registration-section").value; const course = courseById(courseId);
  if (!allowedRegistrations.includes(registration)) { el("registration-message").textContent = "Enter a registration number from 2024-BSE-01 through 2024-BSE-99."; return; }
  if (!course || !section) { el("registration-message").textContent = "Select a valid course and section."; return; }
  if (myEnrollments.some((item) => item.course_id === courseId)) { el("registration-message").textContent = "You already have an enrollment for this course."; return; }
  try {
    const batch = writeBatch(db);
    if (!currentProfile) {
      const gh = JSON.parse(sessionStorage.getItem("githubProfile") || "{}"); const names = splitName(gh.name || currentUser.displayName || "");
      batch.set(doc(db, "users", currentUser.uid), { ...names, created_at: serverTimestamp(), email: gh.email || currentUser.email || "", github_id: String(gh.id || ""), photo_url: gh.avatar_url || currentUser.photoURL || "", registration_number: registration, user_name: gh.login || "" });
    }
    batch.set(doc(db, "enrollments", enrollmentId(currentUser.uid, courseId)), { user_id: currentUser.uid, course_id: courseId, course_name: course.name, course_code: course.code, section, approved: false, created_at: serverTimestamp(), marks: { categories: [] } });
    await batch.commit(); addingAnotherCourse = false;
  } catch (error) { el("registration-message").textContent = friendlyError(error); }
});

function renderPendingDashboard() {
  el("pending-avatar").src = currentProfile.photo_url || currentUser.photoURL || ""; el("pending-name").textContent = displayName(currentProfile); el("pending-registration").textContent = currentProfile.registration_number;
  const container = el("pending-courses"); container.replaceChildren();
  myEnrollments.forEach((item) => { const card = document.createElement("article"); card.className = "course-status-card"; card.innerHTML = `<h3></h3><p></p><span class="badge"></span>`; card.children[0].textContent = `${item.course_name} (${item.course_code}) Section ${item.section}`; card.children[1].textContent = item.approved ? "Enrollment approved" : "Waiting for administrator approval"; card.children[2].textContent = item.approved ? "Approved" : "Pending approval"; card.children[2].classList.toggle("published", item.approved); container.append(card); });
}

function renderStudentDashboard(approved) {
  el("student-avatar").src = currentProfile.photo_url || currentUser.photoURL || ""; el("student-name").textContent = displayName(currentProfile); el("student-registration").textContent = currentProfile.registration_number; el("student-username").textContent = currentProfile.user_name || "—"; el("student-email").textContent = currentProfile.email || "Private on GitHub"; el("student-course-count").textContent = approved.length;
  const tabs = el("student-course-tabs"); tabs.replaceChildren(); approved.sort((a, b) => a.course_name.localeCompare(b.course_name)).forEach((enrollment, index) => { const button = document.createElement("button"); button.className = `tab${index === 0 ? " active" : ""}`; button.textContent = `${enrollment.course_name} (${enrollment.course_code}) Section ${enrollment.section}`; button.addEventListener("click", () => { tabs.querySelectorAll(".tab").forEach((tab) => tab.classList.remove("active")); button.classList.add("active"); renderCourseMarks(enrollment); }); tabs.append(button); }); renderCourseMarks(approved[0]);
}

function renderCourseMarks(enrollment) {
  const categories = markCategories(enrollment.marks); const tabs = el("category-tabs"); tabs.replaceChildren(); el("marks-status").textContent = categories.length ? "Published" : "Not published"; el("marks-status").classList.toggle("published", categories.length > 0);
  if (!categories.length) { renderCategoryTable(null); return; }
  categories.forEach((category, index) => { const button = document.createElement("button"); button.className = `tab${index === 0 ? " active" : ""}`; button.textContent = category.name; button.addEventListener("click", () => { tabs.querySelectorAll(".tab").forEach((tab) => tab.classList.remove("active")); button.classList.add("active"); renderCategoryTable(category); }); tabs.append(button); }); renderCategoryTable(categories[0]);
}

function renderCategoryTable(category) {
  const body = el("student-marks-body"); body.replaceChildren(); const items = category?.items || []; let obtained = 0, total = 0;
  items.forEach((item) => { const o = Number(item.obtained || 0), t = Number(item.total || 0); obtained += o; total += t; const row = document.createElement("tr"); [item.name, o, t, percent(o, t)].forEach((value) => { const cell = document.createElement("td"); cell.textContent = value; row.append(cell); }); body.append(row); });
  if (!items.length) { const row = document.createElement("tr"); const cell = document.createElement("td"); cell.colSpan = 4; cell.className = "empty-cell"; cell.textContent = "Marks have not been published."; row.append(cell); body.append(row); }
  el("category-obtained").textContent = items.length ? obtained : "—"; el("category-total").textContent = items.length ? total : "—"; el("category-percent").textContent = items.length ? percent(obtained, total) : "—";
}

function startAdminListeners() {
  if (unsubscribeUsers) unsubscribeUsers(); if (unsubscribeEnrollments) unsubscribeEnrollments();
  unsubscribeUsers = onSnapshot(collection(db, "users"), (snapshot) => { users = snapshot.docs.map((item) => ({ id: item.id, ...item.data() })); renderEnrollmentList(); });
  unsubscribeEnrollments = onSnapshot(collection(db, "enrollments"), (snapshot) => { enrollments = snapshot.docs.map((item) => ({ id: item.id, ...item.data() })); renderEnrollmentList(); refreshReportCategories(); if (!el("report-table").hidden) generateReport(); });
}

function renderCourseList() {
  const container = el("course-list"); if (!container) return; container.replaceChildren(); courses.forEach((course) => { const chip = document.createElement("span"); chip.className = "course-chip"; chip.textContent = `${course.code}: ${course.name} (${(course.sections || []).join(", ")})`; container.append(chip); });
}

el("course-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const name = el("course-name").value.trim(); const code = el("course-code").value.trim().toUpperCase(); const sections = [...new Set(el("course-sections").value.split(",").map((item) => item.trim().toUpperCase()).filter(Boolean))]; const id = code.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  if (!name || !code || !sections.length) return;
  try { await setDoc(doc(db, "courses", id), { name, code, sections, active: true, created_at: serverTimestamp() }); el("course-form").reset(); el("course-message").className = "message success"; el("course-message").textContent = "Course created."; }
  catch (error) { el("course-message").className = "message"; el("course-message").textContent = friendlyError(error); }
});

function filteredEnrollments() {
  const courseFilter = el("admin-course-filter").value; const search = el("user-search").value.toLowerCase();
  return enrollments.filter((item) => (courseFilter === "all" || item.course_id === courseFilter) && Boolean(item.approved) === (userListMode === "users") && `${displayName(profileById(item.user_id))} ${profileById(item.user_id)?.registration_number || ""} ${item.course_name} ${item.section}`.toLowerCase().includes(search));
}

function renderEnrollmentList() {
  const courseFilter = el("admin-course-filter")?.value || "all"; const scoped = enrollments.filter((item) => courseFilter === "all" || item.course_id === courseFilter); el("approved-users-count").textContent = scoped.filter((item) => item.approved).length; el("pending-users-count").textContent = scoped.filter((item) => !item.approved).length;
  const list = el("users-list"); list.replaceChildren(); const items = filteredEnrollments();
  items.forEach((enrollment) => { const profile = profileById(enrollment.user_id) || {}; const row = document.createElement("div"); row.className = `user-item${selectedEnrollmentId === enrollment.id ? " active" : ""}`; row.tabIndex = 0; const content = document.createElement("span"); content.className = "user-item-content"; const title = document.createElement("strong"); title.textContent = displayName(profile); const meta = document.createElement("span"); meta.textContent = `${profile.registration_number || "No registration"} · ${enrollment.course_name} (${enrollment.course_code}) Section ${enrollment.section}`; content.append(title, meta); const actions = document.createElement("span"); actions.className = "pending-actions";
    if (!enrollment.approved) actions.append(actionButton("✓", "Approve enrollment", "approve-user", (event) => approveEnrollment(event, enrollment)));
    actions.append(actionButton("E", "Delete enrollment", "delete-enrollment", (event) => deleteEnrollment(event, enrollment)));
    if (enrollment.approved) actions.append(actionButton("🗑", "Delete user and all enrollments", "delete-user", (event) => deleteUserAndEnrollments(event, enrollment.user_id, false)));
    else actions.append(actionButton("×", "Block user", "block-user", (event) => deleteUserAndEnrollments(event, enrollment.user_id, true)));
    row.append(content, actions); row.addEventListener("click", () => selectEnrollment(enrollment.id)); list.append(row); });
  if (!items.length) { const empty = document.createElement("p"); empty.className = "user-list-empty"; empty.textContent = userListMode === "pending" ? "No pending enrollments." : "No approved enrollments."; list.append(empty); }
}

function actionButton(text, title, className, handler) { const button = document.createElement("button"); button.type = "button"; button.className = `pending-action ${className}`; button.textContent = text; button.title = title; button.addEventListener("click", (event) => { event.stopPropagation(); handler(event); }); return button; }
async function approveEnrollment(event, enrollment) { event.currentTarget.disabled = true; try { await updateDoc(doc(db, "enrollments", enrollment.id), { approved: true, approved_at: serverTimestamp(), updated_at: serverTimestamp() }); } catch (error) { alert(friendlyError(error)); event.currentTarget.disabled = false; } }
async function deleteEnrollment(event, enrollment) { if (!confirm(`Delete only the ${enrollment.course_code} enrollment? The user profile and other courses will remain.`)) return; event.currentTarget.disabled = true; try { await deleteDoc(doc(db, "enrollments", enrollment.id)); if (selectedEnrollmentId === enrollment.id) clearEditor(); } catch (error) { alert(friendlyError(error)); } }

async function deleteUserAndEnrollments(event, userId, block) {
  const profile = profileById(userId) || {}; const message = block ? `Delete ${displayName(profile)}, remove every course enrollment and block future access?` : `Delete ${displayName(profile)} and every course enrollment? The person can register again later.`;
  if (!confirm(message)) return; event.currentTarget.disabled = true;
  try { const batch = writeBatch(db); enrollments.filter((item) => item.user_id === userId).forEach((item) => batch.delete(doc(db, "enrollments", item.id))); batch.delete(doc(db, "users", userId)); if (block) batch.set(doc(db, "blocked_users", userId), { firebase_uid: userId, github_id: profile.github_id || "", user_name: profile.user_name || "", email: profile.email || "", registration_number: profile.registration_number || "", blocked_at: serverTimestamp(), blocked_by: currentUser.uid }); await batch.commit(); if (selectedEnrollmentId && !enrollments.some((item) => item.id === selectedEnrollmentId && item.user_id !== userId)) clearEditor(); }
  catch (error) { alert(friendlyError(error)); event.currentTarget.disabled = false; }
}

function clearEditor() { selectedEnrollmentId = null; el("student-editor").hidden = true; el("no-user-selected").hidden = false; }
function selectEnrollment(id) { selectedEnrollmentId = id; const enrollment = enrollments.find((item) => item.id === id); const profile = profileById(enrollment.user_id) || {}; const course = courseById(enrollment.course_id); el("no-user-selected").hidden = true; el("student-editor").hidden = false; el("editor-name").textContent = displayName(profile); el("editor-identity").textContent = `${profile.registration_number || ""} · ${profile.email || ""} · ${profile.user_name || ""}`; el("editor-course").value = `${enrollment.course_code} — ${enrollment.course_name}`; el("editor-section").replaceChildren(); (course?.sections || []).forEach((section) => el("editor-section").add(new Option(`Section ${section}`, section))); el("editor-section").value = enrollment.section; el("editor-approved").value = String(Boolean(enrollment.approved)); el("editor-status").textContent = enrollment.approved ? "Approved" : "Pending"; el("editor-status").classList.toggle("published", enrollment.approved); el("category-editor").replaceChildren(); markCategories(enrollment.marks).forEach(addCategory); renderEnrollmentList(); }

function addMarkRow(container, item = {}) { const row = el("mark-row-template").content.firstElementChild.cloneNode(true); row.querySelector(".mark-name").value = item.name || ""; row.querySelector(".mark-obtained").value = item.obtained ?? ""; row.querySelector(".mark-total").value = item.total ?? ""; row.querySelector(".remove-row").addEventListener("click", () => row.remove()); container.append(row); }
function addCategory(category = {}) { const block = el("category-template").content.firstElementChild.cloneNode(true); block.querySelector(".category-name").value = category.name || ""; const rows = block.querySelector(".category-rows"); (category.items || []).forEach((item) => addMarkRow(rows, item)); block.querySelector(".add-mark").addEventListener("click", () => addMarkRow(rows)); block.querySelector(".remove-category").addEventListener("click", () => block.remove()); el("category-editor").append(block); }
function collectCategories() { return [...el("category-editor").querySelectorAll(".category-block")].map((block) => ({ name: block.querySelector(".category-name").value.trim(), items: [...block.querySelectorAll(".mark-row")].map((row) => ({ name: row.querySelector(".mark-name").value.trim(), obtained: Number(row.querySelector(".mark-obtained").value), total: Number(row.querySelector(".mark-total").value) })) })); }

el("student-editor").addEventListener("submit", async (event) => { event.preventDefault(); const enrollment = enrollments.find((item) => item.id === selectedEnrollmentId); if (!enrollment) return; const categories = collectCategories(); for (const category of categories) { if (!category.name || !category.items.length) { el("admin-message").textContent = "Every category needs a name and at least one entry."; return; } for (const item of category.items) if (item.obtained > item.total) { el("admin-message").textContent = `${item.name}: obtained marks cannot exceed total marks.`; return; } } try { await updateDoc(doc(db, "enrollments", enrollment.id), { section: el("editor-section").value, approved: el("editor-approved").value === "true", marks: { categories }, updated_at: serverTimestamp() }); el("admin-message").className = "message success"; el("admin-message").textContent = "Enrollment and marks saved."; } catch (error) { el("admin-message").className = "message"; el("admin-message").textContent = friendlyError(error); } });

function approvedReportEnrollments() { const courseId = el("report-course").value; const section = el("report-section").value; return enrollments.filter((item) => item.approved && item.course_id === courseId && (section === "both" || item.section === section)); }
function categoryDefinition(categoryName, scoped = approvedReportEnrollments()) { const map = new Map(); scoped.flatMap((item) => markCategories(item.marks).filter((category) => category.name.toLowerCase() === categoryName.toLowerCase()).flatMap((category) => category.items || [])).forEach((item) => { if (!map.has(item.name)) map.set(item.name, Number(item.total || 0)); }); return [...map].map(([name, total]) => ({ name, total })); }
function categoryItems(enrollment, categoryName) { return markCategories(enrollment.marks).filter((category) => category.name.toLowerCase() === categoryName.toLowerCase()).flatMap((category) => category.items || []); }
function categoryScore(enrollment, categoryName) { const items = categoryItems(enrollment, categoryName); return { obtained: items.reduce((sum, item) => sum + Number(item.obtained || 0), 0), available: items.length > 0 }; }

function refreshReportCategories() { const courseId = el("report-course")?.value; if (!courseId) return; const names = [...new Set(enrollments.filter((item) => item.course_id === courseId).flatMap((item) => markCategories(item.marks).map((category) => category.name)))].sort(); const old = el("report-category").value; el("report-category").replaceChildren(); names.forEach((name) => el("report-category").add(new Option(name, name))); if (names.includes(old)) el("report-category").value = old; }

function generateReport() {
  const scoped = approvedReportEnrollments(); const type = el("report-type").value; const categoryName = el("report-category").value; const categoryNames = [...new Set(scoped.flatMap((item) => markCategories(item.marks).map((category) => category.name)))].sort();
  if (type === "category") { const definitions = categoryDefinition(categoryName, scoped); currentReportColumns = ["Registration", "Student", "Section", ...definitions.map((item) => item.name), "Total"]; currentReport = scoped.map((enrollment) => { const profile = profileById(enrollment.user_id) || {}; const items = categoryItems(enrollment, categoryName); const row = { Registration: profile.registration_number || "", Student: displayName(profile), Section: enrollment.section, Total: items.reduce((sum, item) => sum + Number(item.obtained || 0), 0) }; definitions.forEach((definition) => { const item = items.find((candidate) => candidate.name.toLowerCase() === definition.name.toLowerCase()); row[definition.name] = item?.obtained ?? ""; }); return row; }); currentReportTitle = `${courseById(el("report-course").value)?.code || "course"}-${categoryName}-report`; }
  else { currentReportColumns = ["Registration", "Student", "Section", ...categoryNames]; currentReport = scoped.map((enrollment) => { const profile = profileById(enrollment.user_id) || {}; const row = { Registration: profile.registration_number || "", Student: displayName(profile), Section: enrollment.section }; categoryNames.forEach((name) => { const score = categoryScore(enrollment, name); row[name] = score.available ? score.obtained : ""; }); return row; }); currentReportTitle = `${courseById(el("report-course").value)?.code || "course"}-overall-report`; }
  currentReport.sort((a, b) => a.Registration.localeCompare(b.Registration)); renderReportTable(); el("report-summary").textContent = `${courseById(el("report-course").value)?.name || "Course"}, ${el("report-section").value === "both" ? "All Sections" : `Section ${el("report-section").value}`}: ${currentReport.length} approved students.`; el("csv-import-panel").hidden = false;
}

function renderReportTable() { const header = document.createElement("tr"); currentReportColumns.forEach((name) => { const cell = document.createElement("th"); cell.textContent = name; header.append(cell); }); el("report-head").replaceChildren(header); const body = el("report-body"); body.replaceChildren(); currentReport.forEach((row) => { const tr = document.createElement("tr"); currentReportColumns.forEach((column) => { const td = document.createElement("td"); td.textContent = row[column] === "" ? "—" : row[column]; tr.append(td); }); body.append(tr); }); el("report-table").hidden = false; el("download-report").disabled = !currentReport.length; }
function saveCsv(rows, filename) { const escape = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`; const blob = new Blob(["\uFEFF" + rows.map((row) => row.map(escape).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = filename.replaceAll(/[^a-zA-Z0-9._-]/g, "-"); link.click(); URL.revokeObjectURL(link.href); }
function downloadReport() { saveCsv([currentReportColumns, ...currentReport.map((row) => currentReportColumns.map((column) => row[column]))], `${currentReportTitle}.csv`); }

function templateDefinitions() { const scoped = approvedReportEnrollments(); if (el("report-type").value === "category") return categoryDefinition(el("report-category").value, scoped).map((item) => ({ category: el("report-category").value, ...item })); const map = new Map(); scoped.forEach((enrollment) => markCategories(enrollment.marks).forEach((category) => (category.items || []).forEach((item) => { const key = `${category.name}\u0000${item.name}`; if (!map.has(key)) map.set(key, { category: category.name, name: item.name, total: Number(item.total || 0) }); }))); return [...map.values()]; }
function downloadTemplate() { const scoped = approvedReportEnrollments(), definitions = templateDefinitions(); if (!definitions.length) { el("csv-message").textContent = "No assessment fields exist for this course and section."; return; } const headers = ["Registration Number", "Student Name", "Section", ...definitions.map((item) => `${item.category} :: ${item.name} [Max:${item.total}]`)]; const rows = [headers, ...scoped.map((enrollment) => { const profile = profileById(enrollment.user_id) || {}; return [profile.registration_number || "", displayName(profile), enrollment.section, ...definitions.map((definition) => { const item = categoryItems(enrollment, definition.category).find((candidate) => candidate.name.toLowerCase() === definition.name.toLowerCase()); return item?.obtained ?? ""; })]; })]; saveCsv(rows, `${currentReportTitle}-template.csv`); }
function parseCsv(text) { const rows = []; let row = [], field = "", quoted = false; for (let i = 0; i < text.length; i++) { const char = text[i], next = text[i + 1]; if (quoted && char === '"' && next === '"') { field += '"'; i++; } else if (char === '"') quoted = !quoted; else if (char === "," && !quoted) { row.push(field); field = ""; } else if ((char === "\n" || char === "\r") && !quoted) { if (char === "\r" && next === "\n") i++; row.push(field); if (row.some(Boolean)) rows.push(row); row = []; field = ""; } else field += char; } row.push(field); if (row.some(Boolean)) rows.push(row); return rows; }

async function uploadMarksCsv() { const file = el("marks-csv").files[0]; if (!file) return; el("upload-marks").disabled = true; try { const rows = parseCsv((await file.text()).replace(/^\uFEFF/, "")); const headers = rows[0] || []; if (headers[0] !== "Registration Number" || headers[2] !== "Section") throw new Error("Use a template downloaded from this course report."); const definitions = headers.slice(3).map((header) => { const match = header.match(/^(.*?) :: (.*?) \[Max:([0-9.]+)\]$/); if (!match) throw new Error(`Invalid column: ${header}`); return { category: match[1], name: match[2], total: Number(match[3]) }; }); const scoped = approvedReportEnrollments(); const updates = rows.slice(1).map((row, index) => { const registration = String(row[0]).trim().toUpperCase(), section = String(row[2]).trim().toUpperCase(); const enrollment = scoped.find((item) => profileById(item.user_id)?.registration_number === registration && item.section === section); if (!enrollment) throw new Error(`Row ${index + 2}: no approved matching enrollment.`); const values = definitions.map((definition, itemIndex) => { const obtained = Number(row[itemIndex + 3]); if (!Number.isFinite(obtained) || obtained < 0 || obtained > definition.total) throw new Error(`Row ${index + 2}: ${definition.name} must be 0-${definition.total}.`); return { ...definition, obtained }; }); return { enrollment, values }; }); const batch = writeBatch(db); updates.forEach(({ enrollment, values }) => { const uploadedCategories = new Set(values.map((value) => value.category.toLowerCase())); const categories = markCategories(enrollment.marks).filter((category) => !uploadedCategories.has(category.name.toLowerCase())); const grouped = new Map(); values.forEach((value) => { const key = value.category.toLowerCase(); if (!grouped.has(key)) grouped.set(key, { name: value.category, items: [] }); grouped.get(key).items.push({ name: value.name, obtained: value.obtained, total: value.total }); }); categories.push(...grouped.values()); batch.update(doc(db, "enrollments", enrollment.id), { marks: { categories }, updated_at: serverTimestamp() }); }); await batch.commit(); el("csv-message").className = "message success"; el("csv-message").textContent = `${updates.length} enrollments updated.`; el("marks-csv").value = ""; }
  catch (error) { el("csv-message").className = "message"; el("csv-message").textContent = friendlyError(error); } finally { el("upload-marks").disabled = !el("marks-csv").files.length; } }

function stopListeners() { ["unsubscribeCourses", "unsubscribeUsers", "unsubscribeEnrollments", "unsubscribeProfile", "unsubscribeMyEnrollments"].forEach((name) => { const fn = ({ unsubscribeCourses, unsubscribeUsers, unsubscribeEnrollments, unsubscribeProfile, unsubscribeMyEnrollments })[name]; if (fn) fn(); }); unsubscribeCourses = unsubscribeUsers = unsubscribeEnrollments = unsubscribeProfile = unsubscribeMyEnrollments = null; }

el("github-login").addEventListener("click", async () => { try { const result = await signInWithPopup(auth, githubProvider); const credential = GithubAuthProvider.credentialFromResult(result); sessionStorage.setItem("githubProfile", JSON.stringify(await getGithubProfile(credential.accessToken))); await routeUser(result.user); } catch (error) { el("login-message").textContent = friendlyError(error); } });
el("registration-course").addEventListener("change", updateRegistrationSections); el("report-course").addEventListener("change", updateReportSections); el("report-type").addEventListener("change", () => { el("report-category-label").hidden = el("report-type").value !== "category"; }); el("admin-course-filter").addEventListener("change", renderEnrollmentList); el("user-search").addEventListener("input", renderEnrollmentList);
el("cancel-enrollment").addEventListener("click", () => { addingAnotherCourse = false; renderStudentState(); }); el("add-course").addEventListener("click", () => openEnrollmentForm(true)); el("pending-add-course").addEventListener("click", () => openEnrollmentForm(true));
el("add-category").addEventListener("click", () => addCategory()); document.querySelectorAll(".user-tab").forEach((button) => button.addEventListener("click", () => { userListMode = button.dataset.userView; document.querySelectorAll(".user-tab").forEach((tab) => tab.classList.toggle("active", tab === button)); renderEnrollmentList(); }));
el("refresh-users").addEventListener("click", renderEnrollmentList); el("generate-report").addEventListener("click", generateReport); el("download-report").addEventListener("click", downloadReport); el("download-template").addEventListener("click", downloadTemplate); el("marks-csv").addEventListener("change", () => { el("upload-marks").disabled = !el("marks-csv").files.length; }); el("upload-marks").addEventListener("click", uploadMarksCsv); document.querySelectorAll(".signout-button").forEach((button) => button.addEventListener("click", () => signOut(auth)));

onAuthStateChanged(auth, async (user) => { stopListeners(); currentProfile = null; myEnrollments = []; addingAnotherCourse = false; if (!user) { currentUser = null; sessionStorage.removeItem("githubProfile"); showView("login-view"); return; } try { await routeUser(user); } catch (error) { el("login-message").textContent = friendlyError(error); showView("login-view"); } });
