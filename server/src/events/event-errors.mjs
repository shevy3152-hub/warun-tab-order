export const EVENT_ERROR_CODES = Object.freeze({
  AUTHENTICATION_REQUIRED: 'AUTHENTICATION_REQUIRED',
  DEVICE_NOT_ACTIVE: 'DEVICE_NOT_ACTIVE',
  DEVICE_NOT_ASSIGNED: 'DEVICE_NOT_ASSIGNED',
  DEVICE_STATE_INCONSISTENT: 'DEVICE_STATE_INCONSISTENT',
  AUTHORIZATION_FAILED: 'AUTHORIZATION_FAILED',
  INVALID_EVENT_REQUEST: 'INVALID_EVENT_REQUEST',
  EVENT_HISTORY_UNAVAILABLE: 'EVENT_HISTORY_UNAVAILABLE',
  DATABASE_FAILURE: 'DATABASE_FAILURE',
});

export class EventRepositoryError extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = 'EventRepositoryError';
    this.code = code;
  }
}

export function isEventRepositoryError(error, code = undefined) {
  return error instanceof EventRepositoryError && (code === undefined || error.code === code);
}
