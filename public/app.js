import { initializeApp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import { getAuth, GithubAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, updateDoc, collection, getDocs, writeBatch, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GithubAuthProvider();
provider.addScope("read:user");
provider.addScope("user:email");

const allowedRegistrations = Array.from({ length: 99 }, (_, i) => `2024-BSE-${String(1 + i).padStart(2, "0")}`);
const views = ["loading-view", "login-view", "registration-view", "pending-view", "blocked-view", "student-view", "admin-view"];
let currentUser = null;
let selectedUserId = null;
let adminUsers = [];
let currentReport = [];
let currentReportTitle = "student-report";
let userListMode = "users";

const el = (id) => document.getElementById(id);
function showView(id) { views.forEach((view) => { el(view).hidden = view !== id; }); }
function splitName(name = "") { const p = name.trim().split(/\s+/).filter(Boolean); return { first_name: p.shift() || "", last_name: p.join(" ") }; }
function percent(obtained, total) { return total > 0 ? `${((obtained / total) * 100).toFixed(1)}%` : "—"; }

function friendlyLoginError(error) {
  if (error?.code === "permission-denied" || error?.code === "firestore/permission-denied") {
    return "Access denied. Your account has been blocked or is not permitted to use this portal. Please contact the portal administrator if you believe this is a mistake.";
  }
  if (error?.code === "auth/popup-closed-by-user") return "GitHub sign-in was cancelled before completion.";
  if (error?.code === "auth/popup-blocked") return "The GitHub sign-in window was blocked by your browser. Please allow pop-ups and try again.";
  return error?.message || "Unable to sign in. Please try again or contact the portal administrator.";
}

allowedRegistrations.forEach((number) => { const option = document.createElement("option"); option.value = number; el("registration-numbers").append(option); });

async function githubProfile(token) {
  const response = await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } });
  if (!response.ok) throw new Error("GitHub profile could not be loaded.");
  return response.json();
}

async function routeUser(user) {
  currentUser = user;
  const admin = await getDoc(doc(db, "admins", user.uid));
  if (admin.exists()) { showView("admin-view"); await loadUsers(); return; }
  const blocked = await getDoc(doc(db, "blocked_users", user.uid));
  if (blocked.exists()) { showView("blocked-view"); return; }
  const snapshot = await getDoc(doc(db, "users", user.uid));
  if (!snapshot.exists()) { showView("registration-view"); return; }
  const profile = snapshot.data();
  if (!profile.approved) { el("pending-registration").textContent = profile.registration_number; showView("pending-view"); return; }
  renderStudent(user, profile); showView("student-view");
}

el("github-login").addEventListener("click", async () => {
  el("login-message").textContent = "";
  try {
    const result = await signInWithPopup(auth, provider);
    const credential = GithubAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) throw new Error("GitHub did not return an access token.");
    sessionStorage.setItem("githubProfile", JSON.stringify(await githubProfile(credential.accessToken)));
    await routeUser(result.user);
  } catch (error) { el("login-message").textContent = friendlyLoginError(error); }
});

el("registration-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const registration = el("registration-number").value.trim().toUpperCase();
  if (!allowedRegistrations.includes(registration)) { el("registration-message").textContent = "Enter a registration number from 2024-BSE-01 through 2024-BSE-99."; return; }
  try {
    const gh = JSON.parse(sessionStorage.getItem("githubProfile") || "{}");
    const names = splitName(gh.name || currentUser.displayName || "");
    await setDoc(doc(db, "users", currentUser.uid), {
      ...names, registration_number: registration, user_name: gh.login || "", email: gh.email || currentUser.email || "",
      photo_url: gh.avatar_url || currentUser.photoURL || "", github_id: String(gh.id || ""), approved: false, created_at: serverTimestamp()
    });
    el("pending-registration").textContent = registration; showView("pending-view");
  } catch (error) { el("registration-message").textContent = error.message; }
});

function markCategories(marks = {}) {
  if (Array.isArray(marks.categories)) return marks.categories;
  const quizzes = Array.isArray(marks.quizzes) ? marks.quizzes : [];
  const assignments = Array.isArray(marks.assignments) ? marks.assignments : [];
  const categories = [];
  if (quizzes.length) categories.push({ name: "Quiz", items: quizzes });
  if (assignments.length) categories.push({ name: "Assignment", items: assignments });
  if (marks.midterm) categories.push({ name: "Midterm", items: [marks.midterm] });
  if (marks.final) categories.push({ name: "Final", items: [marks.final] });
  return categories;
}

function renderStudent(user, profile) {
  el("student-avatar").src = profile.photo_url || user.photoURL || "";
  el("student-name").textContent = [profile.first_name, profile.last_name].filter(Boolean).join(" ") || profile.user_name;
  el("student-registration").textContent = profile.registration_number;
  el("student-username").textContent = profile.user_name || "—";
  el("student-email").textContent = profile.email || "Private on GitHub";
  const categories = markCategories(profile.marks);
  renderCategoryTabs(categories);
  el("marks-status").textContent = categories.length ? "Published" : "Not published"; el("marks-status").classList.toggle("published", categories.length > 0);
}

function renderCategoryTabs(categories) {
  const tabs = el("category-tabs"); tabs.replaceChildren();
  if (!categories.length) { renderCategoryTable(null); return; }
  categories.forEach((category, index) => {
    const button = document.createElement("button"); button.type = "button"; button.className = `tab${index === 0 ? " active" : ""}`; button.textContent = category.name || `Category ${index + 1}`;
    button.addEventListener("click", () => { tabs.querySelectorAll(".tab").forEach((tab) => tab.classList.remove("active")); button.classList.add("active"); renderCategoryTable(category); }); tabs.append(button);
  });
  renderCategoryTable(categories[0]);
}

function renderCategoryTable(category) {
  const body = el("student-marks-body"); body.replaceChildren();
  const items = category?.items || []; let obtained = 0, total = 0;
  items.forEach((mark) => { const o = Number(mark.obtained || 0), t = Number(mark.total || 0); obtained += o; total += t; const tr = document.createElement("tr"); tr.innerHTML = `<td></td><td></td><td></td><td></td>`; tr.children[0].textContent = mark.name; tr.children[1].textContent = o; tr.children[2].textContent = t; tr.children[3].textContent = percent(o, t); body.append(tr); });
  if (!items.length) { const tr = document.createElement("tr"); const td = document.createElement("td"); td.colSpan = 4; td.className = "empty-cell"; td.textContent = "Marks have not been published."; tr.append(td); body.append(tr); }
  el("category-obtained").textContent = items.length ? obtained : "—"; el("category-total").textContent = items.length ? total : "—"; el("category-percent").textContent = items.length ? percent(obtained, total) : "—";
}

async function loadUsers() {
  const snapshot = await getDocs(collection(db, "users"));
  adminUsers = snapshot.docs.map((item) => ({ id: item.id, ...item.data() })).sort((a, b) => (a.registration_number || "").localeCompare(b.registration_number || ""));
  renderUserList();
  refreshReportCategories();
}

function refreshReportCategories() {
  const select = el("report-category"); const previous = select.value; const names = [...new Set(adminUsers.flatMap((user) => markCategories(user.marks).map((category) => category.name)).filter(Boolean))].sort();
  select.replaceChildren(); names.forEach((name) => { const option = document.createElement("option"); option.value = name; option.textContent = name; select.append(option); });
  if (names.includes(previous)) select.value = previous;
}

function categoryScore(user, categoryName) {
  const items = markCategories(user.marks)
    .filter((item) => String(item.name).toLowerCase() === categoryName.toLowerCase())
    .flatMap((category) => Array.isArray(category.items) ? category.items : []);
  if (!items.length) return { obtained: 0, total: 0, available: false };
  return items.reduce((score, item) => ({ obtained: score.obtained + Number(item.obtained || 0), total: score.total + Number(item.total || 0), available: true }), { obtained: 0, total: 0, available: true });
}

function categoryDefinition(categoryName) {
  const definitions = new Map();
  adminUsers.forEach((user) => {
    markCategories(user.marks)
      .filter((category) => String(category.name).toLowerCase() === categoryName.toLowerCase())
      .flatMap((category) => Array.isArray(category.items) ? category.items : [])
      .forEach((item) => {
        const key = String(item.name || "").trim();
        if (key && !definitions.has(key)) definitions.set(key, Number(item.total || 0));
      });
  });
  return [...definitions].map(([name, total]) => ({ name, total }));
}

function categoryItemValues(user, categoryName, definitions) {
  const items = markCategories(user.marks)
    .filter((category) => String(category.name).toLowerCase() === categoryName.toLowerCase())
    .flatMap((category) => Array.isArray(category.items) ? category.items : []);
  return definitions.map((definition) => {
    const item = items.find((candidate) => String(candidate.name).toLowerCase() === definition.name.toLowerCase());
    return item ? Number(item.obtained || 0) : "";
  });
}

function overallScore(user) {
  const items = markCategories(user.marks).flatMap((category) => Array.isArray(category.items) ? category.items : []);
  return items.reduce((score, item) => ({ obtained: score.obtained + Number(item.obtained || 0), total: score.total + Number(item.total || 0), available: true }), { obtained: 0, total: 0, available: items.length > 0 });
}

function generateReport() {
  const type = el("report-type").value; const category = el("report-category").value; const approvedOnly = el("report-students").value === "approved";
  const users = adminUsers.filter((user) => !approvedOnly || user.approved);
  const categoryNames = [...new Set(users.flatMap((user) => markCategories(user.marks).map((item) => item.name)).filter(Boolean))].sort();
  if (type === "category") {
    const definitions = categoryDefinition(category);
    currentReport = users.map((user) => { const values = categoryItemValues(user, category, definitions); const score = categoryScore(user, category); const row = { registration: user.registration_number || "", name: [user.first_name, user.last_name].filter(Boolean).join(" ") || user.user_name || "", categoryTotal: score.available ? score.obtained : "" }; definitions.forEach((definition, index) => { row[definition.name] = values[index]; }); return row; });
    el("report-table").dataset.items = JSON.stringify(definitions);
  } else {
    currentReport = users.map((user) => { const row = { registration: user.registration_number || "", name: [user.first_name, user.last_name].filter(Boolean).join(" ") || user.user_name || "" }; categoryNames.forEach((name) => { const score = categoryScore(user, name); row[name] = score.available ? score.obtained : ""; }); return row; });
  }
  currentReport.sort((a, b) => a.registration.localeCompare(b.registration)); currentReportTitle = type === "category" ? `${category || "category"}-report` : "overall-marks-report";
  const definitions = type === "category" ? categoryDefinition(category) : [];
  const columns = type === "category" ? ["Registration", "Student", ...definitions.map((item) => item.name), "Total"] : ["Registration", "Student", ...categoryNames];
  const header = document.createElement("tr"); columns.forEach((column) => { const th = document.createElement("th"); th.textContent = column; header.append(th); }); el("report-head").replaceChildren(header);
  const body = el("report-body"); body.replaceChildren(); currentReport.forEach((row) => { const values = type === "category" ? [row.registration, row.name, ...definitions.map((item) => row[item.name] === "" ? "—" : row[item.name]), row.categoryTotal === "" ? "—" : row.categoryTotal] : [row.registration, row.name, ...categoryNames.map((name) => row[name] === "" ? "—" : row[name])]; const tr = document.createElement("tr"); values.forEach((value) => { const td = document.createElement("td"); td.textContent = value; tr.append(td); }); body.append(tr); });
  el("report-table").hidden = false; el("download-report").disabled = currentReport.length === 0;
  if (type === "category") { const scored = currentReport.filter((row) => row.categoryTotal !== ""); const average = scored.length ? scored.reduce((sum, row) => sum + Number(row.categoryTotal), 0) / scored.length : 0; el("report-summary").textContent = `${category} report: ${users.length} students, ${scored.length} with marks, average obtained total ${scored.length ? average.toFixed(1) : "not available"}.`; }
  else el("report-summary").textContent = `Overall report: ${users.length} students across ${categoryNames.length} assessment categories.`;
  el("report-table").dataset.columns = JSON.stringify(columns);
  el("csv-import-panel").hidden = false;
  el("csv-description").textContent = type === "category"
    ? `Download the ${category} template, enter obtained marks, then upload the completed CSV.`
    : "Download one template containing every category and assessment, enter obtained marks, then upload it to update all categories.";
}

function downloadReport() {
  const escape = (value) => `"${String(value).replaceAll('"', '""')}"`; const columns = JSON.parse(el("report-table").dataset.columns || "[]"); const isCategory = el("report-type").value === "category"; const rows = [columns, ...currentReport.map((row) => isCategory ? [row.registration, row.name, ...columns.slice(2, -1).map((name) => row[name]), row.categoryTotal] : [row.registration, row.name, ...columns.slice(2).map((name) => row[name])])];
  const blob = new Blob(["\uFEFF" + rows.map((row) => row.map(escape).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `${currentReportTitle}.csv`; link.click(); URL.revokeObjectURL(link.href);
}

function downloadMarksTemplate() {
  const type = el("report-type").value;
  if (type === "category") {
    const category = el("report-category").value; const definitions = categoryDefinition(category);
    if (!category || !definitions.length) { el("csv-message").textContent = "The selected category has no assessment entries to use as template fields."; return; }
    const users = adminUsers.filter((user) => user.approved); const headers = ["Registration Number", "Student Name", ...definitions.map((item) => `${item.name} [Max:${item.total}]`)];
    const rows = [headers, ...users.map((user) => { const existing = categoryItemValues(user, category, definitions); return [user.registration_number || "", [user.first_name, user.last_name].filter(Boolean).join(" ") || user.user_name || "", ...existing]; })];
    saveCsv(rows, `${category}-marks-template.csv`);
    return;
  }

  const definitions = overallDefinitions();
  if (!definitions.length) { el("csv-message").textContent = "No assessment categories exist yet. Add marks fields to at least one student first."; return; }
  const users = adminUsers.filter((user) => user.approved);
  const headers = ["Registration Number", "Student Name", ...definitions.map((item) => `${item.category} :: ${item.name} [Max:${item.total}]`)];
  const rows = [headers, ...users.map((user) => [
    user.registration_number || "",
    [user.first_name, user.last_name].filter(Boolean).join(" ") || user.user_name || "",
    ...overallItemValues(user, definitions)
  ])];
  saveCsv(rows, "overall-marks-template.csv");
}

function overallDefinitions() {
  const definitions = new Map();
  adminUsers.forEach((user) => markCategories(user.marks).forEach((category) => {
    (Array.isArray(category.items) ? category.items : []).forEach((item) => {
      const categoryName = String(category.name || "").trim(); const itemName = String(item.name || "").trim(); const key = `${categoryName.toLowerCase()}\u0000${itemName.toLowerCase()}`;
      if (categoryName && itemName && !definitions.has(key)) definitions.set(key, { category: categoryName, name: itemName, total: Number(item.total || 0) });
    });
  }));
  return [...definitions.values()].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

function overallItemValues(user, definitions) {
  const categories = markCategories(user.marks);
  return definitions.map((definition) => {
    const category = categories.find((candidate) => String(candidate.name).toLowerCase() === definition.category.toLowerCase());
    const item = (category?.items || []).find((candidate) => String(candidate.name).toLowerCase() === definition.name.toLowerCase());
    return item ? Number(item.obtained || 0) : "";
  });
}

function saveCsv(rows, filename) {
  const escape = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`; const blob = new Blob(["\uFEFF" + rows.map((row) => row.map(escape).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = filename.replaceAll(/[^a-zA-Z0-9._-]/g, "-"); link.click(); URL.revokeObjectURL(link.href);
}

function parseCsv(text) {
  const rows = []; let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) { const char = text[i], next = text[i + 1]; if (quoted && char === '"' && next === '"') { field += '"'; i++; } else if (char === '"') quoted = !quoted; else if (char === "," && !quoted) { row.push(field); field = ""; } else if ((char === "\n" || char === "\r") && !quoted) { if (char === "\r" && next === "\n") i++; row.push(field); if (row.some((value) => value !== "")) rows.push(row); row = []; field = ""; } else field += char; }
  row.push(field); if (row.some((value) => value !== "")) rows.push(row); return rows;
}

async function uploadMarksCsv() {
  const file = el("marks-csv").files[0]; if (!file) return; const button = el("upload-marks"); button.disabled = true; el("csv-message").className = "message"; el("csv-message").textContent = "Validating CSV…";
  try {
    const categoryName = el("report-category").value; const rows = parseCsv((await file.text()).replace(/^\uFEFF/, "")); if (rows.length < 2) throw new Error("The CSV does not contain student rows.");
    const headers = rows[0]; if (headers[0] !== "Registration Number" || headers[1] !== "Student Name") throw new Error("This file is not a valid marks template.");
    const isOverallTemplate = headers.slice(2).every((header) => header.includes(" :: "));
    const definitions = headers.slice(2).map((header) => {
      const match = isOverallTemplate
        ? header.match(/^(.*?) :: (.*?) \[Max:([0-9.]+)\]$/)
        : header.match(/^(.*) \[Max:([0-9.]+)\]$/);
      if (!match) throw new Error(`Invalid assessment column: ${header}`);
      return isOverallTemplate
        ? { category: match[1].trim(), name: match[2].trim(), total: Number(match[3]) }
        : { category: categoryName, name: match[1].trim(), total: Number(match[2]) };
    });
    if (!definitions.length) throw new Error("The template contains no assessment columns.");
    const updates = [];
    rows.slice(1).forEach((row, index) => {
      const registration = String(row[0] || "").trim().toUpperCase(); const user = adminUsers.find((candidate) => candidate.registration_number === registration);
      if (!user) throw new Error(`Row ${index + 2}: registration ${registration || "is empty"} was not found.`);
      const values = definitions.map((definition, itemIndex) => { const raw = String(row[itemIndex + 2] ?? "").trim(); if (raw === "") throw new Error(`Row ${index + 2}: ${definition.category} / ${definition.name} is empty.`); const obtained = Number(raw); if (!Number.isFinite(obtained) || obtained < 0 || obtained > definition.total) throw new Error(`Row ${index + 2}: ${definition.category} / ${definition.name} must be between 0 and ${definition.total}.`); return { ...definition, obtained }; });
      updates.push({ user, values });
    });
    if (updates.length > 500) throw new Error("A single upload can update at most 500 students.");
    const batch = writeBatch(db);
    updates.forEach(({ user, values }) => {
      let categories;
      if (isOverallTemplate) {
        const uploadedNames = new Set(values.map((value) => value.category.toLowerCase()));
        categories = markCategories(user.marks).filter((category) => !uploadedNames.has(String(category.name).toLowerCase()));
        const grouped = new Map(); values.forEach((value) => { const key = value.category.toLowerCase(); if (!grouped.has(key)) grouped.set(key, { name: value.category, items: [] }); grouped.get(key).items.push({ name: value.name, obtained: value.obtained, total: value.total }); }); categories.push(...grouped.values());
      } else {
        categories = markCategories(user.marks).filter((category) => String(category.name).toLowerCase() !== categoryName.toLowerCase());
        categories.push({ name: categoryName, items: values.map((value) => ({ name: value.name, obtained: value.obtained, total: value.total })) });
      }
      batch.update(doc(db, "users", user.id), { marks: { categories }, updated_at: serverTimestamp() });
    });
    await batch.commit();
    el("csv-message").className = "message success"; el("csv-message").textContent = `${updates.length} student records updated successfully from the ${isOverallTemplate ? "overall" : categoryName} template.`; await loadUsers(); generateReport(); el("marks-csv").value = "";
  } catch (error) { el("csv-message").textContent = error.message; } finally { button.disabled = !el("marks-csv").files.length; }
}

function renderUserList() {
  const query = el("user-search").value.toLowerCase(); const list = el("users-list"); list.replaceChildren();
  const approvedUsers = adminUsers.filter((user) => user.approved);
  const pendingUsers = adminUsers.filter((user) => !user.approved);
  el("approved-users-count").textContent = approvedUsers.length;
  el("pending-users-count").textContent = pendingUsers.length;
  const selectedUsers = userListMode === "pending" ? pendingUsers : approvedUsers;
  const filteredUsers = selectedUsers.filter((u) => `${u.first_name} ${u.last_name} ${u.registration_number} ${u.user_name}`.toLowerCase().includes(query));
  filteredUsers.forEach((user) => {
    const button = document.createElement("div"); button.className = `user-item${user.id === selectedUserId ? " active" : ""}`; button.tabIndex = 0; button.setAttribute("role", "button");
    const content = document.createElement("span"); content.className = "user-item-content";
    const title = document.createElement("strong"); title.textContent = [user.first_name, user.last_name].filter(Boolean).join(" ") || user.user_name;
    const meta = document.createElement("span"); meta.textContent = `${user.registration_number || "No registration"} · ${user.approved ? "Approved" : "Pending"}`;
    content.append(title, meta); button.append(content);
    if (userListMode === "pending") {
      const actions = document.createElement("span"); actions.className = "pending-actions";
      const approve = document.createElement("button"); approve.type = "button"; approve.className = "pending-action approve-user"; approve.title = "Approve user"; approve.setAttribute("aria-label", `Approve ${title.textContent}`); approve.textContent = "✓";
      const block = document.createElement("button"); block.type = "button"; block.className = "pending-action block-user"; block.title = "Delete and block user"; block.setAttribute("aria-label", `Delete and block ${title.textContent}`); block.textContent = "×";
      approve.addEventListener("click", async (event) => { event.stopPropagation(); await approvePendingUser(user, approve); });
      block.addEventListener("click", async (event) => { event.stopPropagation(); await blockPendingUser(user, block); });
      actions.append(approve, block); button.append(actions);
    }
    button.addEventListener("click", () => selectUser(user.id));
    button.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectUser(user.id); } });
    list.append(button);
  });
  if (!filteredUsers.length) {
    const empty = document.createElement("p"); empty.className = "user-list-empty";
    empty.textContent = query ? "No matching users found." : userListMode === "pending" ? "No pending users." : "No approved users.";
    list.append(empty);
  }
}

async function approvePendingUser(user, button) {
  button.disabled = true;
  try {
    await updateDoc(doc(db, "users", user.id), { approved: true, approved_at: serverTimestamp(), updated_at: serverTimestamp() });
    if (selectedUserId === user.id) selectedUserId = null;
    await loadUsers();
  } catch (error) { alert(`Could not approve user: ${error.message}`); button.disabled = false; }
}

async function blockPendingUser(user, button) {
  const identity = `${[user.first_name, user.last_name].filter(Boolean).join(" ") || user.user_name} (${user.registration_number || "no registration"})`;
  if (!confirm(`Delete and permanently block ${identity}? This user will not be able to register again with the same GitHub account.`)) return;
  button.disabled = true;
  try {
    const batch = writeBatch(db);
    batch.set(doc(db, "blocked_users", user.id), {
      firebase_uid: user.id,
      github_id: user.github_id || "",
      user_name: user.user_name || "",
      email: user.email || "",
      registration_number: user.registration_number || "",
      blocked_at: serverTimestamp(),
      blocked_by: currentUser.uid
    });
    batch.delete(doc(db, "users", user.id));
    await batch.commit();
    if (selectedUserId === user.id) { selectedUserId = null; el("student-editor").hidden = true; el("no-user-selected").hidden = false; }
    await loadUsers();
  } catch (error) { alert(`Could not block user: ${error.message}`); button.disabled = false; }
}

function changeUserListMode(mode) {
  userListMode = mode;
  document.querySelectorAll(".user-tab").forEach((button) => {
    const active = button.dataset.userView === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  el("user-search").value = "";
  renderUserList();
}

function addMarkRow(container, mark = {}) {
  const row = el("mark-row-template").content.firstElementChild.cloneNode(true);
  row.querySelector(".mark-name").value = mark.name || ""; row.querySelector(".mark-obtained").value = mark.obtained ?? ""; row.querySelector(".mark-total").value = mark.total ?? "";
  row.querySelector(".remove-row").addEventListener("click", () => row.remove()); container.append(row);
}

function legacyCategories(marks = {}) {
  if (Array.isArray(marks.categories)) return marks.categories;
  const categories = [];
  if (marks.quizzes?.length) categories.push({ name: "Quiz", items: marks.quizzes });
  if (marks.assignments?.length) categories.push({ name: "Assignment", items: marks.assignments });
  if (marks.midterm) categories.push({ name: "Midterm", items: [marks.midterm] });
  if (marks.final) categories.push({ name: "Final", items: [marks.final] });
  return categories;
}

function addCategory(category = {}) {
  const block = el("category-template").content.firstElementChild.cloneNode(true);
  block.querySelector(".category-name").value = category.name || "";
  const rows = block.querySelector(".category-rows");
  (category.items || []).forEach((mark) => addMarkRow(rows, mark));
  block.querySelector(".add-mark").addEventListener("click", () => addMarkRow(rows));
  block.querySelector(".remove-category").addEventListener("click", () => block.remove());
  el("category-editor").append(block);
}

function selectUser(id) {
  selectedUserId = id; const user = adminUsers.find((item) => item.id === id); const marks = user.marks || {};
  el("no-user-selected").hidden = true; el("student-editor").hidden = false; el("editor-name").textContent = [user.first_name, user.last_name].filter(Boolean).join(" ") || user.user_name;
  el("editor-identity").textContent = `${user.email || "No email"} · ${user.user_name || "No username"}`; el("editor-registration").value = user.registration_number || ""; el("editor-approved").value = String(Boolean(user.approved));
  el("editor-status").textContent = user.approved ? "Approved" : "Pending"; el("editor-status").classList.toggle("published", Boolean(user.approved));
  el("category-editor").replaceChildren(); legacyCategories(marks).forEach(addCategory); renderUserList();
}

function collectCategories() {
  return [...el("category-editor").querySelectorAll(".category-block")].map((block) => ({
    name: block.querySelector(".category-name").value.trim(),
    items: [...block.querySelectorAll(".mark-row")].map((row) => ({
      name: row.querySelector(".mark-name").value.trim(),
      obtained: Number(row.querySelector(".mark-obtained").value),
      total: Number(row.querySelector(".mark-total").value)
    }))
  }));
}

el("student-editor").addEventListener("submit", async (event) => {
  event.preventDefault(); if (!selectedUserId) return;
  const save = el("save-student"); save.disabled = true; el("admin-message").textContent = "";
  try {
    const categories = collectCategories();
    for (const category of categories) {
      if (!category.items.length) throw new Error(`Add at least one entry inside ${category.name || "each category"}.`);
      for (const item of category.items) if (item.obtained > item.total) throw new Error(`${item.name}: obtained marks cannot exceed total marks.`);
    }
    await updateDoc(doc(db, "users", selectedUserId), { registration_number: el("editor-registration").value.trim().toUpperCase(), approved: el("editor-approved").value === "true", marks: { categories }, updated_at: serverTimestamp() });
    el("admin-message").className = "message success"; el("admin-message").textContent = "Student record saved."; await loadUsers(); selectUser(selectedUserId);
  } catch (error) { el("admin-message").className = "message"; el("admin-message").textContent = error.message; } finally { save.disabled = false; }
});

el("add-category").addEventListener("click", () => addCategory());
document.querySelectorAll(".signout-button").forEach((button) => button.addEventListener("click", () => signOut(auth)));
el("refresh-users").addEventListener("click", loadUsers); el("user-search").addEventListener("input", renderUserList);
document.querySelectorAll(".user-tab").forEach((button) => button.addEventListener("click", () => changeUserListMode(button.dataset.userView)));
el("report-type").addEventListener("change", () => { el("report-category-label").hidden = el("report-type").value !== "category"; });
el("generate-report").addEventListener("click", generateReport); el("download-report").addEventListener("click", downloadReport);
el("download-template").addEventListener("click", downloadMarksTemplate); el("marks-csv").addEventListener("change", () => { el("upload-marks").disabled = !el("marks-csv").files.length; el("csv-message").textContent = ""; }); el("upload-marks").addEventListener("click", uploadMarksCsv);
onAuthStateChanged(auth, async (user) => { if (!user) { currentUser = null; sessionStorage.removeItem("githubProfile"); showView("login-view"); return; } try { await routeUser(user); } catch (error) { el("login-message").textContent = friendlyLoginError(error); showView("login-view"); } });
