export const STAFF_CALL_ERROR_CODES = Object.freeze({
  INVALID_REQUEST: 'INVALID_STAFF_CALL_REQUEST',
  DEVICE_NOT_REGISTERED: 'DEVICE_NOT_REGISTERED',
  DEVICE_NOT_AUTHORIZED: 'DEVICE_NOT_AUTHORIZED',
  DEVICE_NOT_ASSIGNED: 'DEVICE_NOT_ASSIGNED',
  VISIT_CONTEXT_STALE: 'VISIT_CONTEXT_STALE',
  CALL_CONFLICT: 'STAFF_CALL_CONFLICT',
  CALL_NOT_FOUND: 'STAFF_CALL_NOT_FOUND',
  DATABASE_FAILURE: 'DATABASE_FAILURE',
});

export class StaffCallRepositoryError extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = 'StaffCallRepositoryError';
    this.code = code;
  }
}

export function isStaffCallRepositoryError(error, code = undefined) {
  return error instanceof StaffCallRepositoryError
    && (code === undefined || error.code === code);
}
