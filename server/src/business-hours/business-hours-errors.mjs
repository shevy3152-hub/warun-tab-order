export const BUSINESS_HOURS_ERROR_CODES = Object.freeze({
  INVALID_WRITE_REQUEST: 'INVALID_WRITE_REQUEST',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  DATABASE_FAILURE: 'DATABASE_FAILURE',
});

export class BusinessHoursRepositoryError extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = 'BusinessHoursRepositoryError';
    this.code = code;
  }
}

export function isBusinessHoursRepositoryError(error) {
  return error instanceof BusinessHoursRepositoryError;
}
