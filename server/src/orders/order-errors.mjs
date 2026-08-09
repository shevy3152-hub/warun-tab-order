export const ORDER_ERROR_CODES = Object.freeze({
  INVALID_ORDER_REQUEST: 'INVALID_ORDER_REQUEST',
  DEVICE_NOT_REGISTERED: 'DEVICE_NOT_REGISTERED',
  DEVICE_NOT_AUTHORIZED: 'DEVICE_NOT_AUTHORIZED',
  DEVICE_NOT_ASSIGNED: 'DEVICE_NOT_ASSIGNED',
  TABLE_INACTIVE: 'TABLE_INACTIVE',
  MENU_ITEM_NOT_FOUND: 'MENU_ITEM_NOT_FOUND',
  MENU_ITEM_SOLD_OUT: 'MENU_ITEM_SOLD_OUT',
  ORDER_CONFLICT: 'ORDER_CONFLICT',
  DATABASE_FAILURE: 'DATABASE_FAILURE',
});

export class OrderRepositoryError extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = 'OrderRepositoryError';
    this.code = code;
  }
}

export function isOrderRepositoryError(error, code = undefined) {
  return error instanceof OrderRepositoryError && (code === undefined || error.code === code);
}
