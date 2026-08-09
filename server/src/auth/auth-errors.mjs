export const AUTH_ERROR_CODES = Object.freeze({
  AUTHENTICATION_FAILED: 'AUTHENTICATION_FAILED',
  AUTHORIZATION_FAILED: 'AUTHORIZATION_FAILED',
  DATABASE_FAILURE: 'DATABASE_FAILURE',
});

export class DeviceAuthError extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = 'DeviceAuthError';
    this.code = code;
  }
}

export function isDeviceAuthError(error, code = undefined) {
  return error instanceof DeviceAuthError && (code === undefined || error.code === code);
}
