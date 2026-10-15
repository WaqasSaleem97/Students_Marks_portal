import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { groupReviewItems, projectedScore, reviewProgress, selectedReferenceCandidates } from "../public/manual-review.js";

const items = [
  { id: "b", enrollment_id: "test-002__cc", registration_number: "TEST-STUDENT-002", criterion_id: "question-2", criterion_order: 1, criterion_label: "Question 2", decision: "pending", automatic_points: 0, max_points: 1 },
  { id: "a", enrollment_id: "test-001__cc", registration_number: "TEST-STUDENT-001", criterion_id: "question-2", criterion_order: 1, criterion_label: "Question 2", decision: "valid", automatic_points: 0, max_points: 1 },
  { id: "c", enrollment_id: "test-001__cc", registration_number: "TEST-STUDENT-001", criterion_id: "question-3", criterion_order: 2, criterion_label: "Question 3", decision: "invalid", automatic_points: 1, max_points: 1 }
];

test("groups by question and orders students by registration", () => {
  const groups = groupReviewItems(items);
  assert.deepEqual(groups.map((group) => group.id), ["question-2", "question-3"]);
  assert.deepEqual(groups[0].items.map((item) => item.registration_number), ["TEST-STUDENT-001", "TEST-STUDENT-002"]);
});

test("progress treats Review later and pending as unresolved", () => {
  assert.deepEqual(reviewProgress([...items, { decision: "review-later" }]), { total: 4, resolved: 2, pending: 2, deferred: 1 });
});

test("projected score changes only reviewed criterion contributions", () => {
  assert.equal(projectedScore({ obtained: 7, total: 10 }, items.filter((item) => item.enrollment_id === "test-001__cc")), 7);
});

test("expected-image selection can retain several full-credit examples", () => {
  const criterion = {
    selected_reference_ids: ["student-01", "student-02"],
    reference_candidates: [
      { id: "student-01", label: "2024-BSE-01", image_url: "https://example.test/01.png" },
      { id: "student-02", label: "2024-BSE-02", image_url: "https://example.test/02.png" },
      { id: "student-03", label: "2024-BSE-03", image_url: "https://example.test/03.png" }
    ]
  };
  assert.deepEqual(selectedReferenceCandidates(criterion).map((candidate) => candidate.id), ["student-01", "student-02"]);
});

test("the administrator portal exposes question-first comparison and finalization controls", () => {
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /data-admin-panel="admin-panel-review"/);
  assert.match(html, /id="review-reference-image"/);
  assert.match(html, /id="review-reference-options"/);
  assert.match(html, /id="review-reference-invalid"/);
  assert.doesNotMatch(html, /id="review-reference-valid"/);
  assert.doesNotMatch(html, /id="review-reference-checklist"/);
  assert.match(html, />Mark as invalid evidence</);
  assert.ok(html.indexOf('id="review-reference-image"') < html.indexOf('id="review-reference-invalid"'));
  assert.ok(html.indexOf('id="review-reference-image"') < html.indexOf('id="review-reference-count"'));
  assert.match(html, />Save expected images</);
  assert.match(html, /id="review-student-image"/);
  assert.match(html, />Evidence valid</);
  assert.match(html, />Evidence invalid</);
  assert.match(html, />Review later</);
  assert.match(html, /id="review-open-finalize"/);
});
