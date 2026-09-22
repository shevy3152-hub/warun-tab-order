export const HTTP_ERROR_CODES = Object.freeze({
  AUTHENTICATION_FAILED: 'AUTHENTICATION_FAILED',
  AUTHORIZATION_FAILED: 'AUTHORIZATION_FAILED',
  BAD_REQUEST: 'BAD_REQUEST',
  INVALID_ORDER_REQUEST: 'INVALID_ORDER_REQUEST',
  INVALID_CATALOG_REQUEST: 'INVALID_CATALOG_REQUEST',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  ORDER_CONFLICT: 'ORDER_CONFLICT',
  CATALOG_CONFLICT: 'CATALOG_CONFLICT',
  BUSINESS_HOURS_CONFLICT: 'BUSINESS_HOURS_CONFLICT',
  RIDE_GUIDANCE_CONFLICT: 'RIDE_GUIDANCE_CONFLICT',
  CHECKOUT_CONFLICT: 'CHECKOUT_CONFLICT',
  CHECKOUT_NOT_FOUND: 'CHECKOUT_NOT_FOUND',
  CHECKOUT_VERSION_CONFLICT: 'CHECKOUT_VERSION_CONFLICT',
  INVALID_CHECKOUT_REQUEST: 'INVALID_CHECKOUT_REQUEST',
  CHECKOUT_SESSION_NOT_FOUND: 'CHECKOUT_SESSION_NOT_FOUND',
  PAYMENT_CONFLICT: 'PAYMENT_CONFLICT',
  PAYMENT_NOT_FOUND: 'PAYMENT_NOT_FOUND',
  PAYMENT_VERSION_CONFLICT: 'PAYMENT_VERSION_CONFLICT',
  PAYMENT_ORDER_CHANGED: 'PAYMENT_ORDER_CHANGED',
  INVALID_PAYMENT_REQUEST: 'INVALID_PAYMENT_REQUEST',
  ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_CONFLICT: 'SESSION_CONFLICT',
  SESSION_HAS_ACTIVE_ORDERS: 'SESSION_HAS_ACTIVE_ORDERS',
  MENU_ITEM_NOT_FOUND: 'MENU_ITEM_NOT_FOUND',
  CATALOG_ITEM_NOT_FOUND: 'CATALOG_ITEM_NOT_FOUND',
  MENU_ITEM_SOLD_OUT: 'MENU_ITEM_SOLD_OUT',
  MENU_ITEM_RESERVATION_ONLY: 'MENU_ITEM_RESERVATION_ONLY',
  EVENT_HISTORY_UNAVAILABLE: 'EVENT_HISTORY_UNAVAILABLE',
  NOT_FOUND: 'NOT_FOUND',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  URI_TOO_LONG: 'URI_TOO_LONG',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  PAIRING_INVALID: 'PAIRING_INVALID',
  PAIRING_CONFLICT: 'PAIRING_CONFLICT',
  PAIRING_EXPIRED: 'PAIRING_EXPIRED',
  TOO_MANY_REQUESTS: 'TOO_MANY_REQUESTS',
  DEVICE_NOT_FOUND: 'DEVICE_NOT_FOUND',
});

const DEFINITIONS = Object.freeze({
  [HTTP_ERROR_CODES.AUTHENTICATION_FAILED]: Object.freeze({
    statusCode: 401,
    message: 'Authentication failed.',
  }),
  [HTTP_ERROR_CODES.AUTHORIZATION_FAILED]: Object.freeze({
    statusCode: 403,
    message: 'Authorization failed.',
  }),
  [HTTP_ERROR_CODES.BAD_REQUEST]: Object.freeze({
    statusCode: 400,
    message: 'Bad request.',
  }),
  [HTTP_ERROR_CODES.INVALID_ORDER_REQUEST]: Object.freeze({
    statusCode: 400,
    message: 'Invalid order request.',
  }),
  [HTTP_ERROR_CODES.INVALID_CATALOG_REQUEST]: Object.freeze({
    statusCode: 400,
    message: 'Invalid catalog request.',
  }),
  [HTTP_ERROR_CODES.PAYLOAD_TOO_LARGE]: Object.freeze({
    statusCode: 413,
    message: 'Request body is too large.',
  }),
  [HTTP_ERROR_CODES.UNSUPPORTED_MEDIA_TYPE]: Object.freeze({
    statusCode: 415,
    message: 'Unsupported media type.',
  }),
  [HTTP_ERROR_CODES.ORDER_CONFLICT]: Object.freeze({
    statusCode: 409,
    message: 'Order conflicts with an existing request.',
  }),
  [HTTP_ERROR_CODES.CATALOG_CONFLICT]: Object.freeze({
    statusCode: 409,
    message: 'Catalog conflicts with a newer version.',
  }),
  [HTTP_ERROR_CODES.BUSINESS_HOURS_CONFLICT]: Object.freeze({
    statusCode: 409,
    message: 'Business hours conflict with a newer version.',
  }),
  [HTTP_ERROR_CODES.RIDE_GUIDANCE_CONFLICT]: Object.freeze({
    statusCode: 409,
    message: 'Ride guidance conflicts with a newer version.',
  }),
  [HTTP_ERROR_CODES.CHECKOUT_CONFLICT]: Object.freeze({
    statusCode: 409,
    message: 'Checkout conflicts with an existing request.',
  }),
  [HTTP_ERROR_CODES.CHECKOUT_VERSION_CONFLICT]: Object.freeze({
    statusCode: 409,
    message: 'Checkout conflicts with a newer version.',
  }),
  [HTTP_ERROR_CODES.INVALID_CHECKOUT_REQUEST]: Object.freeze({
    statusCode: 400,
    message: 'Invalid checkout request.',
  }),
  [HTTP_ERROR_CODES.CHECKOUT_SESSION_NOT_FOUND]: Object.freeze({
    statusCode: 404,
    message: 'The current table session was not found.',
  }),
  [HTTP_ERROR_CODES.PAYMENT_CONFLICT]: Object.freeze({ statusCode: 409, message: 'Payment conflicts with the current checkout.' }),
  [HTTP_ERROR_CODES.PAYMENT_NOT_FOUND]: Object.freeze({ statusCode: 404, message: 'Payment record was not found.' }),
  [HTTP_ERROR_CODES.PAYMENT_VERSION_CONFLICT]: Object.freeze({ statusCode: 409, message: 'Payment record conflicts with a newer version.' }),
  [HTTP_ERROR_CODES.PAYMENT_ORDER_CHANGED]: Object.freeze({ statusCode: 409, message: 'The order changed after ready; confirm the current total before recording payment.' }),
  [HTTP_ERROR_CODES.INVALID_PAYMENT_REQUEST]: Object.freeze({ statusCode: 400, message: 'Invalid payment request.' }),
  [HTTP_ERROR_CODES.CHECKOUT_NOT_FOUND]: Object.freeze({
    statusCode: 404,
    message: 'Checkout request was not found.',
  }),
  [HTTP_ERROR_CODES.ORDER_NOT_FOUND]: Object.freeze({
    statusCode: 404,
    message: 'Order was not found.',
  }),
  [HTTP_ERROR_CODES.SESSION_NOT_FOUND]: Object.freeze({
    statusCode: 404,
    message: 'Table session was not found.',
  }),
  [HTTP_ERROR_CODES.SESSION_CONFLICT]: Object.freeze({
    statusCode: 409,
    message: 'Table session conflicts with the requested table.',
  }),
  [HTTP_ERROR_CODES.SESSION_HAS_ACTIVE_ORDERS]: Object.freeze({
    statusCode: 409,
    message: 'Table session still has active orders.',
  }),
  [HTTP_ERROR_CODES.MENU_ITEM_NOT_FOUND]: Object.freeze({
    statusCode: 422,
    message: 'A requested menu item is unavailable.',
  }),
  [HTTP_ERROR_CODES.CATALOG_ITEM_NOT_FOUND]: Object.freeze({
    statusCode: 404,
    message: 'Catalog item was not found.',
  }),
  [HTTP_ERROR_CODES.MENU_ITEM_SOLD_OUT]: Object.freeze({
    statusCode: 422,
    message: 'A requested menu item is sold out.',
  }),
  [HTTP_ERROR_CODES.MENU_ITEM_RESERVATION_ONLY]: Object.freeze({
    statusCode: 422,
    message: 'この商品は予約限定のため注文できません',
  }),
  [HTTP_ERROR_CODES.EVENT_HISTORY_UNAVAILABLE]: Object.freeze({
    statusCode: 410,
    message: 'Event history is unavailable.',
  }),
  [HTTP_ERROR_CODES.NOT_FOUND]: Object.freeze({
    statusCode: 404,
    message: 'Resource not found.',
  }),
  [HTTP_ERROR_CODES.METHOD_NOT_ALLOWED]: Object.freeze({
    statusCode: 405,
    message: 'Method not allowed.',
  }),
  [HTTP_ERROR_CODES.URI_TOO_LONG]: Object.freeze({
    statusCode: 414,
    message: 'Request URI is too long.',
  }),
  [HTTP_ERROR_CODES.INTERNAL_ERROR]: Object.freeze({
    statusCode: 500,
    message: 'Internal server error.',
  }),
  [HTTP_ERROR_CODES.SERVICE_UNAVAILABLE]: Object.freeze({
    statusCode: 503,
    message: 'Service unavailable.',
  }),
  [HTTP_ERROR_CODES.PAIRING_INVALID]: Object.freeze({ statusCode: 400, message: 'Pairing request is invalid.' }),
  [HTTP_ERROR_CODES.PAIRING_CONFLICT]: Object.freeze({ statusCode: 409, message: 'Pairing conflicts with an existing device or assignment.' }),
  [HTTP_ERROR_CODES.PAIRING_EXPIRED]: Object.freeze({ statusCode: 410, message: 'Pairing code expired.' }),
  [HTTP_ERROR_CODES.TOO_MANY_REQUESTS]: Object.freeze({ statusCode: 429, message: 'Too many pairing attempts.' }),
  [HTTP_ERROR_CODES.DEVICE_NOT_FOUND]: Object.freeze({ statusCode: 404, message: 'Device was not found.' }),
});

export class ReadOnlyHttpError extends Error {
  constructor(code, options = undefined) {
    const definition = DEFINITIONS[code];
    if (!definition) {
      throw new TypeError('Unknown read-only HTTP error code.');
    }
    super(definition.message, options);
    this.name = 'ReadOnlyHttpError';
    this.code = code;
    this.statusCode = definition.statusCode;
    this.publicMessage = definition.message;
  }
}

export function createHttpError(code, options = undefined) {
  return new ReadOnlyHttpError(code, options);
}

export function isReadOnlyHttpError(error, code = undefined) {
  return error instanceof ReadOnlyHttpError && (code === undefined || error.code === code);
}
