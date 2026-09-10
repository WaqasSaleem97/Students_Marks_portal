// Preserve the original class until an administrator edits, disables, or deletes it.
export const defaultRegistrationRange = Object.freeze({ prefix: "2024-BSE", start: 1, end: 99, digits: 2, active: true });

export function normalizeRegistration(value) { return String(value || "").trim().toUpperCase(); }

export function validateRegistrationRange(range) {
  if (typeof range.prefix !== "string" || !/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(range.prefix) || range.prefix.length > 48) return "Use a prefix such as 2022-BSE, with only letters, numbers, and hyphens.";
  if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 1 || range.end < range.start || range.end > 999999) return "Enter a whole-number range from 1 to 999999, with the last number at least the first.";
  if (!Number.isInteger(range.digits) || range.digits < 1 || range.digits > 6 || String(range.end).length > range.digits) return "Choose enough digits for the last number (for example, 3 digits for 100).";
  if (typeof range.active !== "boolean") return "Choose whether the class is enabled.";
  if (range.deleted !== undefined && (range.deleted !== true || range.active)) return "A deleted class must be inactive.";
  return "";
}

export function effectiveRegistrationRanges(saved) {
  const ranges = saved.some((range) => range.prefix === defaultRegistrationRange.prefix) ? saved : [defaultRegistrationRange, ...saved];
  return ranges.filter((range) => !range.deleted && !validateRegistrationRange(range)).sort((a, b) => a.prefix.localeCompare(b.prefix));
}

export function formatRegistration(range, number) { return `${range.prefix}-${String(number).padStart(range.digits, "0")}`; }
export function describeRegistrationRange(range) { return `${formatRegistration(range, range.start)} to ${formatRegistration(range, range.end)}`; }

export function isRegistrationAllowed(value, ranges) {
  const registration = normalizeRegistration(value);
  const match = registration.match(/^([A-Z0-9]+(?:-[A-Z0-9]+)*)-([0-9]{1,6})$/);
  if (!match || match[1].length > 48) return false;
  return ranges.some((range) => range.active && range.prefix === match[1] && match[2].length === range.digits && Number(match[2]) >= range.start && Number(match[2]) <= range.end);
}
