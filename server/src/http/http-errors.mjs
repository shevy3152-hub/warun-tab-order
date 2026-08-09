export const HTTP_ERROR_CODES = Object.freeze({
  AUTHENTICATION_FAILED: 'AUTHENTICATION_FAILED',
  AUTHORIZATION_FAILED: 'AUTHORIZATION_FAILED',
  BAD_REQUEST: 'BAD_REQUEST',
  INVALID_ORDER_REQUEST: 'INVALID_ORDER_REQUEST',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  ORDER_CONFLICT: 'ORDER_CONFLICT',
  MENU_ITEM_NOT_FOUND: 'MENU_ITEM_NOT_FOUND',
  MENU_ITEM_SOLD_OUT: 'MENU_ITEM_SOLD_OUT',
  EVENT_HISTORY_UNAVAILABLE: 'EVENT_HISTORY_UNAVAILABLE',
  NOT_FOUND: 'NOT_FOUND',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  URI_TOO_LONG: 'URI_TOO_LONG',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
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
  [HTTP_ERROR_CODES.MENU_ITEM_NOT_FOUND]: Object.freeze({
    statusCode: 422,
    message: 'A requested menu item is unavailable.',
  }),
  [HTTP_ERROR_CODES.MENU_ITEM_SOLD_OUT]: Object.freeze({
    statusCode: 422,
    message: 'A requested menu item is sold out.',
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
