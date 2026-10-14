export const FINAL_REVIEW_DECISIONS = new Set(["valid", "invalid"]);

export function groupReviewItems(items = []) {
  const groups = new Map();
  for (const item of items) {
    const key = String(item.criterion_id || item.expected_filename || "unknown");
    if (!groups.has(key)) {
      groups.set(key, {
        id: key,
        order: Number.isFinite(Number(item.criterion_order)) ? Number(item.criterion_order) : Number.MAX_SAFE_INTEGER,
        label: String(item.criterion_label || item.expected_filename || "Evidence"),
        expectedFilename: String(item.expected_filename || ""),
        expectedEvidence: Array.isArray(item.expected_evidence) ? item.expected_evidence.map(String) : [],
        referenceImageUrl: String(item.reference_image_url || ""),
        items: []
      });
    }
    const group = groups.get(key);
    if (!group.referenceImageUrl && item.reference_image_url) group.referenceImageUrl = String(item.reference_image_url);
    group.items.push(item);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, items: group.items.sort((left, right) => String(left.registration_number || "").localeCompare(String(right.registration_number || ""))) }))
    .sort((left, right) => left.order - right.order || left.label.localeCompare(right.label));
}

export function reviewProgress(items = []) {
  const resolved = items.filter((item) => FINAL_REVIEW_DECISIONS.has(item.decision)).length;
  const deferred = items.filter((item) => item.decision === "review-later").length;
  return { total: items.length, resolved, pending: items.length - resolved, deferred };
}

export function selectedReferenceCandidates(criterion = {}) {
  const candidates = Array.isArray(criterion.reference_candidates) ? criterion.reference_candidates : [];
  const selected = new Set(Array.isArray(criterion.selected_reference_ids) ? criterion.selected_reference_ids.map(String) : []);
  return candidates.filter((candidate) => selected.has(String(candidate.id || "")) && candidate.image_url);
}

export function decisionPoints(item) {
  if (item.decision === "valid") return Number(item.max_points || 0);
  if (item.decision === "invalid") return 0;
  return Number(item.automatic_points || 0);
}

export function projectedScore(result = {}, items = []) {
  if (Number.isFinite(Number(result.review_base_points)) && Array.isArray(result.review_items) && result.review_items.length) {
    const decisions = new Map(items.map((item) => [reviewItemKey(item), item]));
    const value = Number(result.review_base_points) + result.review_items.reduce((sum, criterion) => {
      const reviewed = decisions.get(reviewItemKey(criterion));
      return sum + (reviewed ? decisionPoints(reviewed) : Number(criterion.automatic_points || 0));
    }, 0);
    return Number(Math.min(Number(result.total || 0), Math.max(0, value)).toFixed(2));
  }
  const automatic = Number(result.obtained || 0);
  const delta = items.reduce((sum, item) => sum + decisionPoints(item) - Number(item.automatic_points || 0), 0);
  return Number(Math.min(Number(result.total || 0), Math.max(0, automatic + delta)).toFixed(2));
}

function reviewItemKey(item = {}) {
  return String(item.criterion_id || item.expected_filename || "").trim().toLowerCase();
}
