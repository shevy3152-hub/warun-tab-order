export const SNAPSHOT_ERROR_CODES = Object.freeze({
  AUTHENTICATION_REQUIRED: 'AUTHENTICATION_REQUIRED',
  DEVICE_NOT_ACTIVE: 'DEVICE_NOT_ACTIVE',
  DEVICE_NOT_ASSIGNED: 'DEVICE_NOT_ASSIGNED',
  DEVICE_STATE_INCONSISTENT: 'DEVICE_STATE_INCONSISTENT',
  AUTHORIZATION_FAILED: 'AUTHORIZATION_FAILED',
  SNAPSHOT_UNAVAILABLE: 'SNAPSHOT_UNAVAILABLE',
  DATABASE_FAILURE: 'DATABASE_FAILURE',
});

export class SnapshotServiceError extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = 'SnapshotServiceError';
    this.code = code;
  }
}

export function isSnapshotServiceError(error, code = undefined) {
  return error instanceof SnapshotServiceError && (code === undefined || error.code === code);
}
