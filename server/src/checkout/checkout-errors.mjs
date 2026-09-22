export const CHECKOUT_ERROR_CODES = Object.freeze({
  INVALID_CHECKOUT_REQUEST: 'INVALID_CHECKOUT_REQUEST',
  CHECKOUT_CONFLICT: 'CHECKOUT_CONFLICT',
  CHECKOUT_NOT_FOUND: 'CHECKOUT_NOT_FOUND',
  SESSION_NOT_FOUND: 'CHECKOUT_SESSION_NOT_FOUND',
  VERSION_CONFLICT: 'CHECKOUT_VERSION_CONFLICT',
  PAYMENT_CONFLICT: 'PAYMENT_CONFLICT',
  PAYMENT_NOT_FOUND: 'PAYMENT_NOT_FOUND',
  PAYMENT_VERSION_CONFLICT: 'PAYMENT_VERSION_CONFLICT',
  PAYMENT_ORDER_CHANGED: 'PAYMENT_ORDER_CHANGED',
  INVALID_PAYMENT_REQUEST: 'INVALID_PAYMENT_REQUEST',
  DATABASE_FAILURE: 'CHECKOUT_DATABASE_FAILURE',
});

export class CheckoutRepositoryError extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = 'CheckoutRepositoryError';
    this.code = code;
  }
}

export function isCheckoutRepositoryError(error) {
  return error instanceof CheckoutRepositoryError;
}
