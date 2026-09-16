import {before, after, beforeEach, test} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {initializeTestEnvironment, assertSucceeds, assertFails} from "@firebase/rules-unit-testing";
import {doc, getDoc, getDocs, collection, setDoc, deleteDoc, updateDoc, writeBatch, serverTimestamp, setLogLevel} from "firebase/firestore";

assert(process.env.FIRESTORE_EMULATOR_HOST, "Run via npm run test:rules; these tests require an emulator.");
setLogLevel("silent");
let env;
before(async () => {env = await initializeTestEnvironment({projectId: "demo-student-marks", firestore: {rules: fs.readFileSync("firestore.rules", "utf8")}});});
after(async () => {await env?.cleanup();});
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, "admins", "admin"), {});
    await setDoc(doc(db, "courses", "cloud"), {name: "Cloud Computing", code: "CC", sections: ["A", "B"]});
  });
});
const dbFor = uid => env.authenticatedContext(uid).firestore();
const range = (prefix, patch = {}) => ({prefix, start: 1, end: 99, digits: 2, active: true, updated_at: serverTimestamp(), ...patch});
const profile = registration => ({registration_number: registration});
const claim = (uid, registration) => ({registration_number: registration, user_id: uid, user_ids: [uid], conflict: false, updated_at: serverTimestamp()});
const enrollment = uid => ({user_id: uid, course_id: "cloud", course_name: "Cloud Computing", course_code: "CC", section: "A", approved: false, marks: {categories: []}});
const createProfile = (uid, registration, includeEnrollment = false) => {
  const db = dbFor(uid), batch = writeBatch(db);
  batch.set(doc(db, "registration_claims", registration), claim(uid, registration));
  batch.set(doc(db, "users", uid), profile(registration));
  if (includeEnrollment) batch.set(doc(db, "enrollments", `${uid}__cloud`), enrollment(uid));
  return batch.commit();
};

test("only admins can change allowed ranges; authenticated students can read", async () => {
  const admin = dbFor("admin"), student = dbFor("student");
  await assertFails(setDoc(doc(student, "registration_ranges", "2022-BSE"), range("2022-BSE")));
  await assertSucceeds(setDoc(doc(admin, "registration_ranges", "2022-BSE"), range("2022-BSE")));
  await assertSucceeds(getDocs(collection(student, "registration_ranges")));
  await assertFails(getDocs(collection(env.unauthenticatedContext().firestore(), "registration_ranges")));
  await assertFails(deleteDoc(doc(student, "registration_ranges", "2022-BSE")));
  await assertSucceeds(deleteDoc(doc(admin, "registration_ranges", "2022-BSE")));
  await assertSucceeds(setDoc(doc(admin, "registration_ranges", "2024-BSE"), range("2024-BSE")));
  await assertFails(deleteDoc(doc(admin, "registration_ranges", "2024-BSE")));
  await assertSucceeds(setDoc(doc(admin, "registration_ranges", "2024-BSE"), range("2024-BSE", {active: false, deleted: true})));
  await assertFails(createProfile("student", "2024-BSE-01"));
  for (const patch of [{start: 0}, {end: 100}, {digits: 7}, {start: 2.5}, {prefix: "WRONG"}, {active: "yes"}, {deleted: false}, {deleted: "yes"}, {updated_at: "not-a-timestamp"}, {unexpected: true}]) await assertFails(setDoc(doc(admin, "registration_ranges", "2022-BSE"), range("2022-BSE", patch)));
});

test("multiple classes and numeric boundaries are enforced on atomic registration claims", async () => {
  const admin = dbFor("admin");
  await setDoc(doc(admin, "registration_ranges", "2022-BSE"), range("2022-BSE"));
  await setDoc(doc(admin, "registration_ranges", "2024-BSCS"), range("2024-BSCS", {start: 10, end: 150, digits: 3}));
  await setDoc(doc(admin, "registration_ranges", "2025-BSE"), range("2025-BSE", {start: 49, end: 49, digits: 3}));
  const allowed = ["2024-BSE-01", "2024-BSE-99", "2022-BSE-01", "2022-BSE-99", "2024-BSCS-010", "2024-BSCS-150", "2025-BSE-049"];
  const denied = ["2024-BSE-00", "2024-BSE-100", "2022-BSE-1", "2022-BSE-001", "2024-BSCS-009", "2024-BSCS-151", "2025-BSE-050", "2026-BSE-01", "2022/BSE-01", "2024-BSCS-1e2", "2022-BSE--01", "", 42];
  for (const [i, registration] of allowed.entries()) {const uid = `valid-${i}`; await assertSucceeds(createProfile(uid, registration));}
  for (const [i, registration] of denied.entries()) {const uid = `invalid-${i}`; await assertFails(createProfile(uid, registration));}
});

test("new profile and enrollment succeed together; orphan enrollments and bypasses fail", async () => {
  const db = dbFor("new-student");
  await assertSucceeds(createProfile("new-student", "2024-BSE-01", true));
  await assertFails(setDoc(doc(dbFor("orphan"), "enrollments", "orphan__cloud"), enrollment("orphan")));
  const invalid = dbFor("invalid"); const invalidBatch = writeBatch(invalid);
  invalidBatch.set(doc(invalid, "registration_claims", "2026-BSE-01"), claim("invalid", "2026-BSE-01"));
  invalidBatch.set(doc(invalid, "users", "invalid"), profile("2026-BSE-01"));
  invalidBatch.set(doc(invalid, "enrollments", "invalid__cloud"), enrollment("invalid"));
  await assertFails(invalidBatch.commit());
  await assertFails(updateDoc(doc(db, "enrollments", "new-student__cloud"), {approved: true}));
});

test("a registration number can be claimed by only one account", async () => {
  await assertFails(setDoc(doc(dbFor("profile-only"), "users", "profile-only"), profile("2024-BSE-37")));
  await assertFails(setDoc(doc(dbFor("claim-only"), "registration_claims", "2024-BSE-37"), claim("claim-only", "2024-BSE-37")));

  await assertSucceeds(createProfile("first-account", "2024-BSE-38"));
  await assertFails(createProfile("second-account", "2024-BSE-38"));
  assert.equal((await getDoc(doc(dbFor("admin"), "registration_claims", "2024-BSE-38"))).data().user_id, "first-account");
  await assertSucceeds(getDoc(doc(dbFor("second-account"), "registration_claims", "2024-BSE-38")));
  await assertFails(getDocs(collection(dbFor("second-account"), "registration_claims")));
  await assertFails(updateDoc(doc(dbFor("first-account"), "registration_claims", "2024-BSE-38"), {user_id: "second-account"}));
});

test("admins can reserve a legacy duplicate and reassign it when one account is removed", async () => {
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, "users", "legacy-a"), profile("2024-BSE-38"));
    await setDoc(doc(db, "users", "legacy-b"), profile("2024-BSE-38"));
  });
  const admin = dbFor("admin"), claimRef = doc(admin, "registration_claims", "2024-BSE-38");
  await assertSucceeds(setDoc(claimRef, {registration_number: "2024-BSE-38", user_id: "", user_ids: ["legacy-a", "legacy-b"], conflict: true, updated_at: serverTimestamp()}));
  const batch = writeBatch(admin);
  batch.delete(doc(admin, "users", "legacy-a"));
  batch.set(claimRef, {registration_number: "2024-BSE-38", user_id: "legacy-b", user_ids: ["legacy-b"], conflict: false, updated_at: serverTimestamp()});
  await assertSucceeds(batch.commit());
  assert.equal((await getDoc(claimRef)).data().user_id, "legacy-b");
});

test("course deletion is restricted to admins and supports deleting linked enrollments", async () => {
  await env.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), "users", "student"), profile("2024-BSE-01"));
    await setDoc(doc(context.firestore(), "enrollments", "student__cloud"), enrollment("student"));
  });
  await assertFails(deleteDoc(doc(dbFor("student"), "courses", "cloud")));
  const admin = dbFor("admin"), batch = writeBatch(admin);
  batch.delete(doc(admin, "enrollments", "student__cloud"));
  batch.delete(doc(admin, "courses", "cloud"));
  await assertSucceeds(batch.commit());
});

test("disabling the default blocks new profiles and preserves existing students and marks", async () => {
  const admin = dbFor("admin");
  const marks = {categories: [{name: "Quiz", items: [{name: "Quiz 1", obtained: 8, total: 10}]}]};
  await env.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), "users", "existing"), profile("2022-BSE-49"));
    await setDoc(doc(context.firestore(), "enrollments", "existing__old"), {...enrollment("existing"), course_id: "old", approved: true, marks});
  });
  await assertSucceeds(setDoc(doc(admin, "registration_ranges", "2024-BSE"), range("2024-BSE", {active: false})));
  await assertFails(createProfile("new", "2024-BSE-01"));
  const existing = dbFor("existing");
  await assertSucceeds(getDoc(doc(existing, "users", "existing")));
  await assertSucceeds(setDoc(doc(existing, "enrollments", "existing__cloud"), enrollment("existing")));
  assert.deepEqual((await getDoc(doc(existing, "enrollments", "existing__old"))).data().marks, marks);
  await assertSucceeds(setDoc(doc(admin, "registration_ranges", "2024-BSE"), range("2024-BSE")));
  await assertSucceeds(createProfile("new", "2024-BSE-01"));
});
