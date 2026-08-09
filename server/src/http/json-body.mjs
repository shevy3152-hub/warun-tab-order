import { TextDecoder } from 'node:util';

export const ORDER_JSON_BODY_LIMIT_BYTES = 16 * 1024;

export const ORDER_JSON_BODY_ERROR_CODES = Object.freeze({
  INVALID_REQUEST_HEADERS: 'INVALID_REQUEST_HEADERS',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  CONTENT_LENGTH_MISMATCH: 'CONTENT_LENGTH_MISMATCH',
  REQUEST_BODY_ABORTED: 'REQUEST_BODY_ABORTED',
  INVALID_JSON: 'INVALID_JSON',
  INVALID_ORDER_REQUEST: 'INVALID_ORDER_REQUEST',
});

const ERROR_DEFINITIONS = Object.freeze({
  [ORDER_JSON_BODY_ERROR_CODES.INVALID_REQUEST_HEADERS]: Object.freeze({
    statusCode: 400,
    message: 'Invalid request headers.',
  }),
  [ORDER_JSON_BODY_ERROR_CODES.UNSUPPORTED_MEDIA_TYPE]: Object.freeze({
    statusCode: 415,
    message: 'Unsupported media type.',
  }),
  [ORDER_JSON_BODY_ERROR_CODES.PAYLOAD_TOO_LARGE]: Object.freeze({
    statusCode: 413,
    message: 'Request body is too large.',
  }),
  [ORDER_JSON_BODY_ERROR_CODES.CONTENT_LENGTH_MISMATCH]: Object.freeze({
    statusCode: 400,
    message: 'Request body length does not match Content-Length.',
  }),
  [ORDER_JSON_BODY_ERROR_CODES.REQUEST_BODY_ABORTED]: Object.freeze({
    statusCode: 400,
    message: 'Request body was not fully received.',
  }),
  [ORDER_JSON_BODY_ERROR_CODES.INVALID_JSON]: Object.freeze({
    statusCode: 400,
    message: 'Invalid JSON request body.',
  }),
  [ORDER_JSON_BODY_ERROR_CODES.INVALID_ORDER_REQUEST]: Object.freeze({
    statusCode: 400,
    message: 'Invalid order request.',
  }),
});

const CLIENT_ORDER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MENU_ITEM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_ORDER_LINES = 50;
const MAX_QUANTITY = 99;
const MAX_JSON_DEPTH = 64;
const JSON_WHITESPACE = new Set([' ', '\t', '\r', '\n']);
const TOP_LEVEL_KEYS = new Set([
  'schemaVersion',
  'clientOrderId',
  'clientCreatedAtMs',
  'items',
]);
const ITEM_KEYS = new Set(['menuItemId', 'quantity']);

function bodyError(code, options = undefined) {
  return new OrderJsonBodyError(code, options);
}

export class OrderJsonBodyError extends Error {
  constructor(code, options = undefined) {
    const definition = ERROR_DEFINITIONS[code];
    if (!definition) throw new TypeError('Unknown order JSON body error code.');
    super(definition.message, options);
    this.name = 'OrderJsonBodyError';
    this.code = code;
    this.statusCode = definition.statusCode;
    this.publicMessage = definition.message;
  }
}

export function isOrderJsonBodyError(error, code = undefined) {
  return error instanceof OrderJsonBodyError && (code === undefined || error.code === code);
}

function collectRawHeaderValues(rawHeaders, targetName) {
  if (!Array.isArray(rawHeaders) || rawHeaders.length % 2 !== 0) {
    throw bodyError(ORDER_JSON_BODY_ERROR_CODES.INVALID_REQUEST_HEADERS);
  }

  const values = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (typeof name !== 'string' || typeof value !== 'string') {
      throw bodyError(ORDER_JSON_BODY_ERROR_CODES.INVALID_REQUEST_HEADERS);
    }
    if (name.toLowerCase() === targetName) values.push(value);
  }
  return values;
}

function validateContentType(rawHeaders) {
  const values = collectRawHeaderValues(rawHeaders, 'content-type');
  if (values.length !== 1) {
    if (values.length === 0) {
      throw bodyError(ORDER_JSON_BODY_ERROR_CODES.UNSUPPORTED_MEDIA_TYPE);
    }
    throw bodyError(ORDER_JSON_BODY_ERROR_CODES.INVALID_REQUEST_HEADERS);
  }

  const value = values[0];
  if (value.includes(',')) {
    throw bodyError(ORDER_JSON_BODY_ERROR_CODES.INVALID_REQUEST_HEADERS);
  }

  const parts = value.split(';');
  if (parts.length > 2 || parts[0].trim().toLowerCase() !== 'application/json') {
    throw bodyError(ORDER_JSON_BODY_ERROR_CODES.UNSUPPORTED_MEDIA_TYPE);
  }
  if (
    parts.length === 2
    && !/^charset[\t ]*=[\t ]*utf-8$/i.test(parts[1].trim())
  ) {
    throw bodyError(ORDER_JSON_BODY_ERROR_CODES.UNSUPPORTED_MEDIA_TYPE);
  }
}

function validateContentEncoding(rawHeaders) {
  const values = collectRawHeaderValues(rawHeaders, 'content-encoding');
  if (values.length > 0) {
    throw bodyError(ORDER_JSON_BODY_ERROR_CODES.UNSUPPORTED_MEDIA_TYPE);
  }
}

function readDeclaredLength(rawHeaders) {
  const values = collectRawHeaderValues(rawHeaders, 'content-length');
  if (values.length > 1) {
    throw bodyError(ORDER_JSON_BODY_ERROR_CODES.INVALID_REQUEST_HEADERS);
  }

  const transferEncoding = collectRawHeaderValues(rawHeaders, 'transfer-encoding');
  if (values.length === 1 && transferEncoding.length > 0) {
    throw bodyError(ORDER_JSON_BODY_ERROR_CODES.INVALID_REQUEST_HEADERS);
  }
  if (values.length === 0) return null;

  const value = values[0];
  if (!/^[0-9]+$/.test(value) || value.includes(',')) {
    throw bodyError(ORDER_JSON_BODY_ERROR_CODES.INVALID_REQUEST_HEADERS);
  }

  let declaredLength;
  try {
    declaredLength = BigInt(value);
  } catch {
    throw bodyError(ORDER_JSON_BODY_ERROR_CODES.INVALID_REQUEST_HEADERS);
  }
  if (declaredLength > BigInt(ORDER_JSON_BODY_LIMIT_BYTES)) {
    throw bodyError(ORDER_JSON_BODY_ERROR_CODES.PAYLOAD_TOO_LARGE);
  }
  return Number(declaredLength);
}

function requestIterator(request) {
  if (request && typeof request.iterator === 'function') {
    return request.iterator({ destroyOnReturn: false });
  }
  if (request && typeof request[Symbol.asyncIterator] === 'function') {
    return request[Symbol.asyncIterator]();
  }
  throw bodyError(ORDER_JSON_BODY_ERROR_CODES.REQUEST_BODY_ABORTED);
}

async function readBodyBytes(request, declaredLength) {
  if (request?.aborted === true) {
    throw bodyError(ORDER_JSON_BODY_ERROR_CODES.REQUEST_BODY_ABORTED);
  }

  const chunks = [];
  let receivedBytes = 0;
  try {
    for await (const chunk of requestIterator(request)) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      receivedBytes += bytes.length;

      if (receivedBytes > ORDER_JSON_BODY_LIMIT_BYTES) {
        request.resume?.();
        throw bodyError(ORDER_JSON_BODY_ERROR_CODES.PAYLOAD_TOO_LARGE);
      }
      if (declaredLength !== null && receivedBytes > declaredLength) {
        request.resume?.();
        throw bodyError(ORDER_JSON_BODY_ERROR_CODES.CONTENT_LENGTH_MISMATCH);
      }
      chunks.push(bytes);
    }
  } catch (error) {
    if (isOrderJsonBodyError(error)) throw error;
    throw bodyError(ORDER_JSON_BODY_ERROR_CODES.REQUEST_BODY_ABORTED, { cause: error });
  }

  if (request?.aborted === true || request?.complete === false) {
    throw bodyError(ORDER_JSON_BODY_ERROR_CODES.REQUEST_BODY_ABORTED);
  }
  if (declaredLength !== null && receivedBytes !== declaredLength) {
    throw bodyError(ORDER_JSON_BODY_ERROR_CODES.CONTENT_LENGTH_MISMATCH);
  }
  return Buffer.concat(chunks, receivedBytes);
}

function decodeUtf8(bytes) {
  if (bytes.length === 0) {
    throw bodyError(ORDER_JSON_BODY_ERROR_CODES.INVALID_JSON);
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw bodyError(ORDER_JSON_BODY_ERROR_CODES.INVALID_JSON);
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw bodyError(ORDER_JSON_BODY_ERROR_CODES.INVALID_JSON, { cause: error });
  }
}

function assertNoDuplicateJsonKeys(text) {
  let index = 0;

  function invalidJson() {
    throw bodyError(ORDER_JSON_BODY_ERROR_CODES.INVALID_JSON);
  }

  function skipWhitespace() {
    while (index < text.length && JSON_WHITESPACE.has(text[index])) index += 1;
  }

  function parseString() {
    if (text[index] !== '"') invalidJson();
    const start = index;
    index += 1;
    while (index < text.length) {
      const character = text[index];
      if (character === '"') {
        index += 1;
        try {
          return JSON.parse(text.slice(start, index));
        } catch {
          invalidJson();
        }
      }
      if (character === '\\') {
        index += 1;
        if (index >= text.length) invalidJson();
        const escape = text[index];
        if ('"\\/bfnrt'.includes(escape)) {
          index += 1;
          continue;
        }
        if (escape === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(index + 1, index + 5))) invalidJson();
          index += 5;
          continue;
        }
        invalidJson();
      }
      if (character.charCodeAt(0) <= 0x1f) invalidJson();
      index += 1;
    }
    invalidJson();
  }

  function parseNumber() {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(index));
    if (!match) invalidJson();
    index += match[0].length;
  }

  function parseValue(depth) {
    if (depth > MAX_JSON_DEPTH) invalidJson();
    skipWhitespace();
    const character = text[index];
    if (character === '{') {
      parseObject(depth + 1);
      return;
    }
    if (character === '[') {
      parseArray(depth + 1);
      return;
    }
    if (character === '"') {
      parseString();
      return;
    }
    for (const literal of ['true', 'false', 'null']) {
      if (text.startsWith(literal, index)) {
        index += literal.length;
        return;
      }
    }
    parseNumber();
  }

  function parseObject(depth) {
    index += 1;
    skipWhitespace();
    if (text[index] === '}') {
      index += 1;
      return;
    }

    const keys = new Set();
    while (index < text.length) {
      skipWhitespace();
      const key = parseString();
      if (keys.has(key)) invalidJson();
      keys.add(key);
      skipWhitespace();
      if (text[index] !== ':') invalidJson();
      index += 1;
      parseValue(depth);
      skipWhitespace();
      if (text[index] === '}') {
        index += 1;
        return;
      }
      if (text[index] !== ',') invalidJson();
      index += 1;
    }
    invalidJson();
  }

  function parseArray(depth) {
    index += 1;
    skipWhitespace();
    if (text[index] === ']') {
      index += 1;
      return;
    }
    while (index < text.length) {
      parseValue(depth);
      skipWhitespace();
      if (text[index] === ']') {
        index += 1;
        return;
      }
      if (text[index] !== ',') invalidJson();
      index += 1;
    }
    invalidJson();
  }

  skipWhitespace();
  if (index >= text.length) invalidJson();
  parseValue(0);
  skipWhitespace();
  if (index !== text.length) invalidJson();
}

function requireExactKeys(value, allowedKeys, requiredKeys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw bodyError(ORDER_JSON_BODY_ERROR_CODES.INVALID_ORDER_REQUEST);
  }
  const keys = Object.keys(value);
  if (
    keys.some((key) => !allowedKeys.has(key))
    || requiredKeys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw bodyError(ORDER_JSON_BODY_ERROR_CODES.INVALID_ORDER_REQUEST);
  }
}

function validateOrderRequest(value) {
  requireExactKeys(value, TOP_LEVEL_KEYS, ['schemaVersion', 'clientOrderId', 'items']);
  if (value.schemaVersion !== 1 || !CLIENT_ORDER_ID_PATTERN.test(value.clientOrderId)) {
    throw bodyError(ORDER_JSON_BODY_ERROR_CODES.INVALID_ORDER_REQUEST);
  }
  if (
    Object.hasOwn(value, 'clientCreatedAtMs')
    && (!Number.isSafeInteger(value.clientCreatedAtMs) || value.clientCreatedAtMs < 0)
  ) {
    throw bodyError(ORDER_JSON_BODY_ERROR_CODES.INVALID_ORDER_REQUEST);
  }
  if (!Array.isArray(value.items) || value.items.length < 1 || value.items.length > MAX_ORDER_LINES) {
    throw bodyError(ORDER_JSON_BODY_ERROR_CODES.INVALID_ORDER_REQUEST);
  }

  const seenMenuItemIds = new Set();
  const items = value.items.map((item) => {
    requireExactKeys(item, ITEM_KEYS, ['menuItemId', 'quantity']);
    if (
      typeof item.menuItemId !== 'string'
      || !MENU_ITEM_ID_PATTERN.test(item.menuItemId)
      || !Number.isInteger(item.quantity)
      || item.quantity < 1
      || item.quantity > MAX_QUANTITY
      || seenMenuItemIds.has(item.menuItemId)
    ) {
      throw bodyError(ORDER_JSON_BODY_ERROR_CODES.INVALID_ORDER_REQUEST);
    }
    seenMenuItemIds.add(item.menuItemId);
    return Object.freeze({ menuItemId: item.menuItemId, quantity: item.quantity });
  });

  const normalized = {
    schemaVersion: 1,
    clientOrderId: value.clientOrderId,
    items: Object.freeze(items),
  };
  if (Object.hasOwn(value, 'clientCreatedAtMs')) {
    normalized.clientCreatedAtMs = value.clientCreatedAtMs;
  }
  return Object.freeze(normalized);
}

export function parseOrderJsonText(text) {
  if (typeof text !== 'string' || text === '') {
    throw bodyError(ORDER_JSON_BODY_ERROR_CODES.INVALID_JSON);
  }
  assertNoDuplicateJsonKeys(text);

  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw bodyError(ORDER_JSON_BODY_ERROR_CODES.INVALID_JSON, { cause: error });
  }
  return validateOrderRequest(value);
}

export async function readOrderJsonBody(request) {
  const rawHeaders = request?.rawHeaders;
  validateContentType(rawHeaders);
  validateContentEncoding(rawHeaders);
  const declaredLength = readDeclaredLength(rawHeaders);
  const bodyBytes = await readBodyBytes(request, declaredLength);
  return parseOrderJsonText(decodeUtf8(bodyBytes));
}
