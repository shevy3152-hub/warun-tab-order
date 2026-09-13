export const CUSTOMER_THEMES = Object.freeze({ standard: "standard", camellia: "camellia" });
export const CUSTOMER_TEST_THEME = CUSTOMER_THEMES.camellia;

export function normalizeCustomerTheme(theme) {
  return Object.values(CUSTOMER_THEMES).includes(theme) ? theme : CUSTOMER_THEMES.standard;
}
