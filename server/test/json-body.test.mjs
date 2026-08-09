import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  ORDER_JSON_BODY_ERROR_CODES,
  ORDER_JSON_BODY_LIMIT_BYTES,
  isOrderJsonBodyError,
  parseOrderJsonText,
  readOrderJsonBody,
} from '../src/http/json-body.mjs';

const CLIENT_ORDER_ID = '00000000-0000-4000-8000-000000000123';

function validOrder(overrides = {}) {
  return {
    schemaVersion: 1,
    clientOrderId: CLIENT_ORDER_ID,
    items: [{ menuItemId: 'food', quantity: 1 }],
    ...overrides,
  };
}

function rawHeaders(entries = []) {
  return entries.flatMap(([name, value]) => [name, value]);
}

function makeRequest(chunks, headers = [['Content-Type', 'application/json']]) {
  const request = Readable.from(chunks);
  request.rawHeaders = rawHeaders(headers);
  return request;
}

async function readJson(value, headers = undefined) {
  const bytes = Buffer.from(JSON.stringify(value));
  return readOrderJsonBody(makeRequest(
    [bytes],
    headers ?? [
      ['Content-Type', 'application/json'],
      ['Content-Length', String(bytes.length)],
    ],
  ));
}

function assertBodyError(error, code, statusCode) {
  assert.equal(isOrderJsonBodyError(error, code), true);
  assert.equal(error.code, code);
  assert.equal(error.statusCode, statusCode);
  assert.equal(typeof error.publicMessage, 'string');
  return true;
}

test('accepts application/json with no charset', async () => {
  const result = await readJson(validOrder());
  assert.deepEqual(result, validOrder());
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.items), true);
});

test('accepts an optional case-insensitive UTF-8 charset', async () => {
  const result = await readJson(validOrder(), [['Content-Type', 'Application/JSON; Charset=UTF-8']]);
  assert.equal(result.clientOrderId, CLIENT_ORDER_ID);
});

test('rejects a missing Content-Type', async () => {
  await assert.rejects(readOrderJsonBody(makeRequest([Buffer.from('{}')], [])), (error) => (
    assertBodyError(error, ORDER_JSON_BODY_ERROR_CODES.UNSUPPORTED_MEDIA_TYPE, 415)
  ));
});

test('rejects duplicate and comma-combined Content-Type values', async () => {
  for (const headers of [
    [['Content-Type', 'application/json'], ['content-type', 'application/json']],
    [['Content-Type', 'application/json, application/json']],
  ]) {
    await assert.rejects(readOrderJsonBody(makeRequest([Buffer.from('{}')], headers)), (error) => (
      assertBodyError(error, ORDER_JSON_BODY_ERROR_CODES.INVALID_REQUEST_HEADERS, 400)
    ));
  }
});

test('rejects wrong media types, unsupported charset, and extra parameters', async () => {
  for (const value of [
    'text/json',
    'application/json; charset=shift_jis',
    'application/json; charset=utf-8; profile=test',
  ]) {
    await assert.rejects(
      readOrderJsonBody(makeRequest([Buffer.from('{}')], [['Content-Type', value]])),
      (error) => assertBodyError(error, ORDER_JSON_BODY_ERROR_CODES.UNSUPPORTED_MEDIA_TYPE, 415),
    );
  }
});

test('rejects every Content-Encoding including identity', async () => {
  for (const value of ['gzip', 'br', 'identity']) {
    await assert.rejects(readOrderJsonBody(makeRequest([Buffer.from('{}')], [
      ['Content-Type', 'application/json'],
      ['Content-Encoding', value],
    ])), (error) => assertBodyError(
      error,
      ORDER_JSON_BODY_ERROR_CODES.UNSUPPORTED_MEDIA_TYPE,
      415,
    ));
  }
});

test('rejects invalid, duplicate, and transfer-encoding-conflicted Content-Length', async () => {
  for (const headers of [
    [['Content-Type', 'application/json'], ['Content-Length', '-1']],
    [['Content-Type', 'application/json'], ['Content-Length', '1, 1']],
    [['Content-Type', 'application/json'], ['Content-Length', '1'], ['content-length', '1']],
    [['Content-Type', 'application/json'], ['Content-Length', '1'], ['Transfer-Encoding', 'chunked']],
  ]) {
    await assert.rejects(readOrderJsonBody(makeRequest([Buffer.from('{}')], headers)), (error) => (
      assertBodyError(error, ORDER_JSON_BODY_ERROR_CODES.INVALID_REQUEST_HEADERS, 400)
    ));
  }
});

test('rejects a declared Content-Length above 16 KiB before reading', async () => {
  await assert.rejects(readOrderJsonBody(makeRequest([], [
    ['Content-Type', 'application/json'],
    ['Content-Length', String(ORDER_JSON_BODY_LIMIT_BYTES + 1)],
  ])), (error) => assertBodyError(error, ORDER_JSON_BODY_ERROR_CODES.PAYLOAD_TOO_LARGE, 413));
});

test('rejects bodies shorter or longer than Content-Length', async () => {
  for (const declared of [1, 3]) {
    await assert.rejects(readOrderJsonBody(makeRequest([Buffer.from('{}')], [
      ['Content-Type', 'application/json'],
      ['Content-Length', String(declared)],
    ])), (error) => assertBodyError(
      error,
      ORDER_JSON_BODY_ERROR_CODES.CONTENT_LENGTH_MISMATCH,
      400,
    ));
  }
});

test('enforces the measured 16 KiB limit for chunked bodies', async () => {
  const exact = Buffer.alloc(ORDER_JSON_BODY_LIMIT_BYTES, 0x20);
  await assert.rejects(
    readOrderJsonBody(makeRequest([exact.subarray(0, 8_000), exact.subarray(8_000)])),
    (error) => assertBodyError(error, ORDER_JSON_BODY_ERROR_CODES.INVALID_JSON, 400),
  );
  await assert.rejects(
    readOrderJsonBody(makeRequest([exact, Buffer.from('x')])),
    (error) => assertBodyError(error, ORDER_JSON_BODY_ERROR_CODES.PAYLOAD_TOO_LARGE, 413),
  );
});

test('maps stream errors and already-aborted requests to REQUEST_BODY_ABORTED', async () => {
  const failed = new Readable({
    read() {
      this.destroy(new Error('socket reset with private detail'));
    },
  });
  failed.rawHeaders = rawHeaders([['Content-Type', 'application/json']]);
  await assert.rejects(readOrderJsonBody(failed), (error) => {
    assert.equal(error.message.includes('private detail'), false);
    return assertBodyError(error, ORDER_JSON_BODY_ERROR_CODES.REQUEST_BODY_ABORTED, 400);
  });

  const aborted = makeRequest([Buffer.from(JSON.stringify(validOrder()))]);
  aborted.aborted = true;
  await assert.rejects(readOrderJsonBody(aborted), (error) => (
    assertBodyError(error, ORDER_JSON_BODY_ERROR_CODES.REQUEST_BODY_ABORTED, 400)
  ));
});

test('rejects fatal UTF-8 failures and a UTF-8 BOM', async () => {
  for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d])]) {
    await assert.rejects(readOrderJsonBody(makeRequest([bytes])), (error) => (
      assertBodyError(error, ORDER_JSON_BODY_ERROR_CODES.INVALID_JSON, 400)
    ));
  }
});

test('rejects empty, malformed, trailing, scalar, null, and array JSON', () => {
  for (const text of ['', '{', '{} trailing', '1', 'null', '[]']) {
    assert.throws(() => parseOrderJsonText(text), (error) => {
      const code = ['1', 'null', '[]'].includes(text)
        ? ORDER_JSON_BODY_ERROR_CODES.INVALID_ORDER_REQUEST
        : ORDER_JSON_BODY_ERROR_CODES.INVALID_JSON;
      return assertBodyError(error, code, 400);
    });
  }
});

test('rejects duplicate keys at every object level', () => {
  const bodies = [
    `{"schemaVersion":1,"schemaVersion":1,"clientOrderId":"${CLIENT_ORDER_ID}","items":[{"menuItemId":"food","quantity":1}]}`,
    `{"schemaVersion":1,"clientOrderId":"${CLIENT_ORDER_ID}","items":[{"menuItemId":"food","quantity":1,"quantity":1}]}`,
    `{"schemaVersion":1,"clientOrderId":"${CLIENT_ORDER_ID}","items":[{"menuItemId":"food","quantity":1,"nested":{"x":1,"x":2}}]}`,
  ];
  for (const body of bodies) {
    assert.throws(() => parseOrderJsonText(body), (error) => (
      assertBodyError(error, ORDER_JSON_BODY_ERROR_CODES.INVALID_JSON, 400)
    ));
  }
});

test('rejects escape-equivalent duplicate keys', () => {
  for (const body of [
    `{"schemaVersion":1,"schema\\u0056ersion":1,"clientOrderId":"${CLIENT_ORDER_ID}","items":[{"menuItemId":"food","quantity":1}]}`,
    `{"schemaVersion":1,"clientOrderId":"${CLIENT_ORDER_ID}","items":[{"menuItemId":"food","quant\\u0069ty":1,"quantity":1}]}`,
  ]) {
    assert.throws(() => parseOrderJsonText(body), (error) => (
      assertBodyError(error, ORDER_JSON_BODY_ERROR_CODES.INVALID_JSON, 400)
    ));
  }
});

test('rejects unknown and server-controlled top-level fields', () => {
  for (const key of [
    'deviceId', 'role', 'tableId', 'tableNumber', 'priceYen', 'totalAmountYen',
    'fingerprint', 'requestFingerprint', 'formalName', 'unknown',
  ]) {
    assert.throws(() => parseOrderJsonText(JSON.stringify(validOrder({ [key]: 'untrusted' }))), (error) => (
      assertBodyError(error, ORDER_JSON_BODY_ERROR_CODES.INVALID_ORDER_REQUEST, 400)
    ));
  }
});

test('rejects unknown and server-controlled item fields', () => {
  for (const key of ['priceYen', 'formalName', 'kitchenAlias', 'unknown']) {
    const order = validOrder({ items: [{ menuItemId: 'food', quantity: 1, [key]: 'untrusted' }] });
    assert.throws(() => parseOrderJsonText(JSON.stringify(order)), (error) => (
      assertBodyError(error, ORDER_JSON_BODY_ERROR_CODES.INVALID_ORDER_REQUEST, 400)
    ));
  }
});

test('validates schemaVersion, clientOrderId, and clientCreatedAtMs', () => {
  const invalidOrders = [
    validOrder({ schemaVersion: 2 }),
    validOrder({ clientOrderId: 'not-a-v4-uuid' }),
    validOrder({ clientCreatedAtMs: -1 }),
    validOrder({ clientCreatedAtMs: 1.5 }),
  ];
  for (const order of invalidOrders) {
    assert.throws(() => parseOrderJsonText(JSON.stringify(order)), (error) => (
      assertBodyError(error, ORDER_JSON_BODY_ERROR_CODES.INVALID_ORDER_REQUEST, 400)
    ));
  }
});

test('accepts a valid clientCreatedAtMs without using it as server state', () => {
  const result = parseOrderJsonText(JSON.stringify(validOrder({ clientCreatedAtMs: 1_786_300_000_000 })));
  assert.equal(result.clientCreatedAtMs, 1_786_300_000_000);
});

test('validates item count, exact item shape, ID format, quantity, and duplicate lines', () => {
  const invalidOrders = [
    validOrder({ items: [] }),
    validOrder({ items: Array.from({ length: 51 }, (_, index) => ({ menuItemId: `i${index}`, quantity: 1 })) }),
    validOrder({ items: [null] }),
    validOrder({ items: [{ menuItemId: 'bad id', quantity: 1 }] }),
    validOrder({ items: [{ menuItemId: 'food', quantity: 0 }] }),
    validOrder({ items: [{ menuItemId: 'food', quantity: 1.5 }] }),
    validOrder({ items: [{ menuItemId: 'food', quantity: 100 }] }),
    validOrder({ items: [{ menuItemId: 'food', quantity: 1 }, { menuItemId: 'food', quantity: 2 }] }),
  ];
  for (const order of invalidOrders) {
    assert.throws(() => parseOrderJsonText(JSON.stringify(order)), (error) => (
      assertBodyError(error, ORDER_JSON_BODY_ERROR_CODES.INVALID_ORDER_REQUEST, 400)
    ));
  }
});

test('does not trim or transform accepted item IDs', () => {
  const result = parseOrderJsonText(JSON.stringify(validOrder({
    items: [{ menuItemId: 'Food_A-1', quantity: 99 }],
  })));
  assert.deepEqual(result.items, [{ menuItemId: 'Food_A-1', quantity: 99 }]);
});

test('rejects excessive JSON nesting before it can exhaust the call stack', () => {
  const nested = `${'['.repeat(70)}0${']'.repeat(70)}`;
  assert.throws(() => parseOrderJsonText(nested), (error) => (
    assertBodyError(error, ORDER_JSON_BODY_ERROR_CODES.INVALID_JSON, 400)
  ));
});
