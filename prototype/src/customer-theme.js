import { CUSTOMER_THEME_KEYS, isSupportedCustomerTheme } from "../../shared/customer-theme-definitions.mjs";

export const CUSTOMER_THEMES = CUSTOMER_THEME_KEYS;
export const CUSTOMER_TEST_THEME = CUSTOMER_THEMES.camellia;

export function normalizeCustomerTheme(theme) {
  return isSupportedCustomerTheme(theme) ? theme : CUSTOMER_THEMES.standard;
}
