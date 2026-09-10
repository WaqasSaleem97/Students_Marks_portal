import test from "node:test";
import assert from "node:assert/strict";
import { defaultRegistrationRange, effectiveRegistrationRanges, formatRegistration, validateRegistrationRange, isRegistrationAllowed } from "../public/registration-ranges.js";

const classes = [
  { prefix: "2022-BSE", start: 1, end: 99, digits: 2, active: true },
  { prefix: "2024-BSCS", start: 10, end: 150, digits: 3, active: true },
  { prefix: "2025-BSE", start: 49, end: 49, digits: 3, active: true }
];

test("multiple classes, inclusive boundaries, normalization, and individual numbers", () => {
  for (const number of ["2022-BSE-01", "2022-BSE-99", "2024-BSCS-010", "2024-BSCS-150", "2025-BSE-049", " 2024-bscs-011 "]) assert.equal(isRegistrationAllowed(number, classes), true, number);
  for (const number of ["2022-BSE-00", "2022-BSE-100", "2024-BSCS-009", "2024-BSCS-151", "2025-BSE-048", "2026-BSE-01", "2022-BSE-1", "2022-BSE-001", "2024-BSCS-1e2", "2024/BSCS-010", "2024-BSCS--010"]) assert.equal(isRegistrationAllowed(number, classes), false, number);
  assert.equal(formatRegistration(classes[1], 10), "2024-BSCS-010");
});

test("the legacy range can be edited and disabled without being restored", () => {
  assert.deepEqual(effectiveRegistrationRanges([]), [defaultRegistrationRange]);
  const disabled = { ...defaultRegistrationRange, active: false };
  const ranges = effectiveRegistrationRanges([...classes, disabled]);
  assert.equal(ranges.filter(range => range.prefix === "2024-BSE").length, 1);
  assert.equal(isRegistrationAllowed("2024-BSE-01", ranges), false);
  assert.equal(isRegistrationAllowed("2022-BSE-01", ranges), true);
  assert.equal(isRegistrationAllowed("2024-BSE-01", effectiveRegistrationRanges([{...defaultRegistrationRange, start: 50}])), false);
  assert.deepEqual(effectiveRegistrationRanges([{...defaultRegistrationRange, active: false, deleted: true}]), []);
});

test("invalid settings are rejected and large ranges need no generated list", () => {
  for (const patch of [{prefix: ""}, {prefix: "a/b"}, {prefix: 123}, {prefix: "A".repeat(49)}, {start: 0}, {start: 2.5}, {end: 0}, {end: 1000000}, {digits: 0}, {digits: 7}, {digits: 1}, {active: "true"}, {deleted: false}, {deleted: "true"}, {deleted: true}]) assert.notEqual(validateRegistrationRange({...classes[0], ...patch}), "", JSON.stringify(patch));
  const large = {prefix: "BS-CS-2026", start: 1, end: 999999, digits: 6, active: true};
  assert.equal(validateRegistrationRange(large), "");
  assert.equal(isRegistrationAllowed("BS-CS-2026-999999", [large]), true);
});
