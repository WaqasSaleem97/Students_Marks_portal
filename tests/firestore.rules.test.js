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
const enrollment = uid => ({user_id: uid, course_id: "cloud", course_name: "Cloud Computing", course_code: "CC", section: "A", approved: false, marks: {categories: []}});

test("only admins can change allowed ranges; authenticated students can read", async () => {
  const admin = dbFor("admin"), student = dbFor("student");
  await assertFails(setDoc(doc(student, "registration_ranges", "2022-BSE"), range("2022-BSE")));
  await assertSucceeds(setDoc(doc(admin, "registration_ranges", "2022-BSE"), range("2022-BSE")));
  await assertSucceeds(getDocs(collection(student, "registration_ranges")));
  await assertFails(getDocs(collection(env.unauthenticatedContext().firestore(), "registration_ranges")));
  await assertFails(deleteDoc(doc(admin, "registration_ranges", "2022-BSE")));
  for (const patch of [{start: 0}, {end: 100}, {digits: 7}, {start: 2.5}, {prefix: "WRONG"}, {active: "yes"}, {updated_at: "not-a-timestamp"}, {unexpected: true}]) await assertFails(setDoc(doc(admin, "registration_ranges", "2022-BSE"), range("2022-BSE", patch)));
});

test("multiple classes and numeric boundaries are enforced on direct profile writes", async () => {
  const admin = dbFor("admin");
  await setDoc(doc(admin, "registration_ranges", "2022-BSE"), range("2022-BSE"));
  await setDoc(doc(admin, "registration_ranges", "2024-BSCS"), range("2024-BSCS", {start: 10, end: 150, digits: 3}));
  await setDoc(doc(admin, "registration_ranges", "2025-BSE"), range("2025-BSE", {start: 49, end: 49, digits: 3}));
  const allowed = ["2024-BSE-01", "2024-BSE-99", "2022-BSE-01", "2022-BSE-99", "2024-BSCS-010", "2024-BSCS-150", "2025-BSE-049"];
  const denied = ["2024-BSE-00", "2024-BSE-100", "2022-BSE-1", "2022-BSE-001", "2024-BSCS-009", "2024-BSCS-151", "2025-BSE-050", "2026-BSE-01", "2022/BSE-01", "2024-BSCS-1e2", "2022-BSE--01", "", 42];
  for (const [i, registration] of allowed.entries()) {const uid = `valid-${i}`; await assertSucceeds(setDoc(doc(dbFor(uid), "users", uid), profile(registration)));}
  for (const [i, registration] of denied.entries()) {const uid = `invalid-${i}`; await assertFails(setDoc(doc(dbFor(uid), "users", uid), profile(registration)));}
});

test("new profile and enrollment succeed together; orphan enrollments and bypasses fail", async () => {
  const db = dbFor("new-student"); const batch = writeBatch(db);
  batch.set(doc(db, "users", "new-student"), profile("2024-BSE-01"));
  batch.set(doc(db, "enrollments", "new-student__cloud"), enrollment("new-student"));
  await assertSucceeds(batch.commit());
  await assertFails(setDoc(doc(dbFor("orphan"), "enrollments", "orphan__cloud"), enrollment("orphan")));
  const invalid = dbFor("invalid"); const invalidBatch = writeBatch(invalid);
  invalidBatch.set(doc(invalid, "users", "invalid"), profile("2026-BSE-01"));
  invalidBatch.set(doc(invalid, "enrollments", "invalid__cloud"), enrollment("invalid"));
  await assertFails(invalidBatch.commit());
  await assertFails(updateDoc(doc(db, "enrollments", "new-student__cloud"), {approved: true}));
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
  await assertFails(setDoc(doc(dbFor("new"), "users", "new"), profile("2024-BSE-01")));
  const existing = dbFor("existing");
  await assertSucceeds(getDoc(doc(existing, "users", "existing")));
  await assertSucceeds(setDoc(doc(existing, "enrollments", "existing__cloud"), enrollment("existing")));
  assert.deepEqual((await getDoc(doc(existing, "enrollments", "existing__old"))).data().marks, marks);
  await assertSucceeds(setDoc(doc(admin, "registration_ranges", "2024-BSE"), range("2024-BSE")));
  await assertSucceeds(setDoc(doc(dbFor("new"), "users", "new"), profile("2024-BSE-01")));
});
