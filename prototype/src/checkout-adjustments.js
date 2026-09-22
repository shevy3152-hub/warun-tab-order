const FIXED_LABEL_PATTERN = /^(.*?)[（(]\s*(\d+)\s*円\s*[×x＊*]\s*(\d+)\s*名\s*[）)]$/u;

export const CHECKOUT_ADJUSTMENT_TYPES = [
  ["seat_charge", "席料"],
  ["late_night_charge", "深夜チャージ"],
  ["extension_charge", "延長料金"],
];

export function parseFixedAdjustment(item, fallbackLabel) {
  const amountYen = Number.isSafeInteger(item?.amountYen) && item.amountYen >= 0 ? item.amountYen : 0;
  const match = String(item?.label || "").match(FIXED_LABEL_PATTERN);
  if (match) {
    return {
      label: match[1].trim() || fallbackLabel,
      unitAmount: match[2],
      people: match[3],
    };
  }
  return {
    label: String(item?.label || fallbackLabel),
    unitAmount: String(amountYen),
    people: "1",
  };
}

export function formatFixedAdjustmentLabel(label, unitAmount, people) {
  return `${String(label).trim()}（${unitAmount}円×${people}名）`;
}

function parseNonNegativeInteger(value) {
  if (!/^\d+$/.test(String(value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

export function normalizeCheckoutAdjustments(draft) {
  const adjustments = [];
  for (const [kind, fallbackLabel] of CHECKOUT_ADJUSTMENT_TYPES) {
    const entry = draft?.[kind] || {};
    const unitAmount = parseNonNegativeInteger(entry.unitAmount);
    const people = /^\d+$/.test(String(entry.people)) ? Number(entry.people) : null;
    if (unitAmount === null || !Number.isInteger(people) || people < 1 || people > 99) {
      return { ok: false, error: `${fallbackLabel}は1人分の金額と人数（1〜99人）を正しく入力してください。` };
    }
    adjustments.push({
      kind,
      label: formatFixedAdjustmentLabel(fallbackLabel, unitAmount, people),
      amountYen: unitAmount * people,
    });
  }
  for (const entry of draft?.other || []) {
    const label = String(entry.label || "").trim();
    const amountYen = parseNonNegativeInteger(entry.amount);
    if (!label || amountYen === null) return { ok: false, error: "任意料金の項目名と金額を正しく入力してください。" };
    adjustments.push({ kind: "other", label, amountYen });
  }
  return { ok: true, adjustments };
}

export function checkoutAdjustmentTotal(draft) {
  const normalized = normalizeCheckoutAdjustments(draft);
  return normalized.ok ? normalized.adjustments.reduce((sum, item) => sum + item.amountYen, 0) : null;
}
