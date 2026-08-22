export const DEFAULT_TAX_RATE_PERCENT = 10;

export function taxExcludedYen(taxIncludedYen, taxRatePercent = DEFAULT_TAX_RATE_PERCENT) {
  if (!Number.isSafeInteger(taxIncludedYen) || taxIncludedYen < 0) {
    throw new TypeError("taxIncludedYen must be a non-negative integer.");
  }
  if (!Number.isSafeInteger(taxRatePercent) || taxRatePercent < 0) {
    throw new TypeError("taxRatePercent must be a non-negative integer.");
  }
  return Math.floor((taxIncludedYen * 100) / (100 + taxRatePercent));
}
