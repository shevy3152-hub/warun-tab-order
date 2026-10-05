export const CUSTOMER_THEME_ERROR_CODES = Object.freeze({
  INVALID_WRITE_REQUEST: 'INVALID_WRITE_REQUEST',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  DATABASE_FAILURE: 'DATABASE_FAILURE',
});

export class CustomerThemeRepositoryError extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = 'CustomerThemeRepositoryError';
    this.code = code;
  }
}

export function isCustomerThemeRepositoryError(error) {
  return error instanceof CustomerThemeRepositoryError;
}
