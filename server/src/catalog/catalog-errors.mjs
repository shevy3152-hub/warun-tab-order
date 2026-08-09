export const CATALOG_ERROR_CODES = Object.freeze({
  AUTHENTICATION_REQUIRED: 'AUTHENTICATION_REQUIRED',
  DEVICE_NOT_ACTIVE: 'DEVICE_NOT_ACTIVE',
  DEVICE_NOT_ASSIGNED: 'DEVICE_NOT_ASSIGNED',
  DEVICE_STATE_INCONSISTENT: 'DEVICE_STATE_INCONSISTENT',
  AUTHORIZATION_FAILED: 'AUTHORIZATION_FAILED',
  DATABASE_FAILURE: 'DATABASE_FAILURE',
});

export class CatalogRepositoryError extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = 'CatalogRepositoryError';
    this.code = code;
  }
}

export function isCatalogRepositoryError(error, code = undefined) {
  return error instanceof CatalogRepositoryError && (code === undefined || error.code === code);
}
