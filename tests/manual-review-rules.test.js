import { after, before, beforeEach, test } from "node:test";
import fs from "node:fs";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { collection, deleteDoc, doc, getDoc, getDocs, serverTimestamp, setDoc, updateDoc } from "firebase/firestore";

let env;
before(async () => { env = await initializeTestEnvironment({ projectId: "demo-student-marks", firestore: { rules: fs.readFileSync("firestore.rules", "utf8") } }); });
after(async () => { await env?.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, "admins", "review-admin"), {});
    await setDoc(doc(db, "grading_runs", "1001"), { status: "reviewing", item_count: 1, pending_count: 1, reviewed_count: 0, course_code: "TEST", assessment: "Test 1" });
    await setDoc(doc(db, "grading_runs", "1001", "items", "item-1"), { decision: "pending", reviewer_note: "", reviewer_uid: "", automatic_points: 0, max_points: 1 });
    await setDoc(doc(db, "grading_runs", "1001", "criteria", "criterion-1"), { criterion_id: "question-1", reference_candidate_ids: ["ref-1", "ref-2"], selected_reference_ids: ["ref-1", "ref-2"], reference_candidates: [{ id: "ref-1", image_url: "https://example.test/1.png" }, { id: "ref-2", image_url: "https://example.test/2.png" }], reviewer_uid: "", reviewed_at: null });
    await setDoc(doc(db, "grading_runs", "1001", "results", "test-student__course"), { result: { obtained: 7, total: 10 } });
  });
});

const adminDb = () => env.authenticatedContext("review-admin").firestore();
const studentDb = () => env.authenticatedContext("test-student").firestore();

test("only administrators can read staged runs, evidence, and provisional results", async () => {
  await assertSucceeds(getDocs(collection(adminDb(), "grading_runs")));
  await assertSucceeds(getDoc(doc(adminDb(), "grading_runs", "1001", "items", "item-1")));
  await assertSucceeds(getDoc(doc(adminDb(), "grading_runs", "1001", "criteria", "criterion-1")));
  await assertSucceeds(getDoc(doc(adminDb(), "grading_runs", "1001", "results", "test-student__course")));
  await assertFails(getDocs(collection(studentDb(), "grading_runs")));
  await assertFails(getDoc(doc(studentDb(), "grading_runs", "1001", "items", "item-1")));
  await assertFails(getDoc(doc(studentDb(), "grading_runs", "1001", "criteria", "criterion-1")));
});

test("an administrator can save a constrained decision and matching progress", async () => {
  const db = adminDb();
  await assertSucceeds(updateDoc(doc(db, "grading_runs", "1001", "items", "item-1"), { decision: "valid", reviewer_note: "Matches the expected output.", reviewer_uid: "review-admin", reviewed_at: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(db, "grading_runs", "1001", "criteria", "criterion-1"), { selected_reference_ids: ["ref-2"], reviewer_uid: "review-admin", reviewed_at: serverTimestamp(), updated_at: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(db, "grading_runs", "1001"), { status: "ready", pending_count: 0, reviewed_count: 1, reviewer_uid: "review-admin", review_completed_at: serverTimestamp(), updated_at: serverTimestamp() }));
});

test("review updates cannot alter marks, criteria, configuration, or create records", async () => {
  const db = adminDb();
  await assertFails(updateDoc(doc(db, "grading_runs", "1001", "items", "item-1"), { automatic_points: 1, decision: "valid", reviewer_note: "", reviewer_uid: "review-admin", reviewed_at: serverTimestamp() }));
  await assertFails(updateDoc(doc(db, "grading_runs", "1001"), { course_code: "CHANGED", status: "ready", pending_count: 0, reviewed_count: 1, reviewer_uid: "review-admin", review_completed_at: serverTimestamp(), updated_at: serverTimestamp() }));
  await assertFails(updateDoc(doc(db, "grading_runs", "1001", "criteria", "criterion-1"), { selected_reference_ids: ["unknown"], reviewer_uid: "review-admin", reviewed_at: serverTimestamp(), updated_at: serverTimestamp() }));
  await assertFails(updateDoc(doc(db, "grading_runs", "1001", "criteria", "criterion-1"), { reference_candidate_ids: ["ref-1", "ref-2", "injected"], selected_reference_ids: ["ref-1"], reviewer_uid: "review-admin", reviewed_at: serverTimestamp(), updated_at: serverTimestamp() }));
  await assertFails(setDoc(doc(db, "grading_runs", "1002"), { status: "reviewing" }));
  await assertFails(updateDoc(doc(db, "grading_runs", "1001", "results", "test-student__course"), { result: { obtained: 10, total: 10 } }));
});

test("only an administrator can delete a grading run and all of its stored review data", async () => {
  const student = studentDb();
  await assertFails(deleteDoc(doc(student, "grading_runs", "1001", "items", "item-1")));
  await assertFails(deleteDoc(doc(student, "grading_runs", "1001")));

  const admin = adminDb();
  await assertSucceeds(deleteDoc(doc(admin, "grading_runs", "1001", "items", "item-1")));
  await assertSucceeds(deleteDoc(doc(admin, "grading_runs", "1001", "criteria", "criterion-1")));
  await assertSucceeds(deleteDoc(doc(admin, "grading_runs", "1001", "results", "test-student__course")));
  await assertSucceeds(deleteDoc(doc(admin, "grading_runs", "1001")));
});
