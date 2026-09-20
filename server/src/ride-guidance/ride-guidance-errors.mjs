export const RIDE_GUIDANCE_ERROR_CODES = Object.freeze({
  INVALID_WRITE_REQUEST: 'INVALID_WRITE_REQUEST',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  CONTACT_NOT_FOUND: 'CONTACT_NOT_FOUND',
  CONTACT_ORDER_MISMATCH: 'CONTACT_ORDER_MISMATCH',
  DATABASE_FAILURE: 'DATABASE_FAILURE',
});

export class RideGuidanceRepositoryError extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = 'RideGuidanceRepositoryError';
    this.code = code;
  }
}

export function isRideGuidanceRepositoryError(error) {
  return error instanceof RideGuidanceRepositoryError;
}
