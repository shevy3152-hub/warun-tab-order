import { CUSTOMER_THEME_KEYS } from "../../shared/customer-theme-definitions.mjs";

export const CUSTOMER_THEMES = CUSTOMER_THEME_KEYS;
export const CUSTOMER_TEST_THEME = CUSTOMER_THEMES.camellia;

export function normalizeCustomerTheme(theme) {
  return Object.hasOwn(CUSTOMER_THEMES, theme) ? theme : CUSTOMER_THEMES.standard;
}
