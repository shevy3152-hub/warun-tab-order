export const CUSTOMER_ORDER_NOTICE_ERROR_CODES = Object.freeze({
  INVALID_WRITE_REQUEST: 'INVALID_WRITE_REQUEST',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  DATABASE_FAILURE: 'DATABASE_FAILURE',
});

export class CustomerOrderNoticeRepositoryError extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = 'CustomerOrderNoticeRepositoryError';
    this.code = code;
  }
}

export function isCustomerOrderNoticeRepositoryError(error) {
  return error instanceof CustomerOrderNoticeRepositoryError;
}
