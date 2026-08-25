import assert from 'node:assert/strict';
import { readFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createDiagnosticRecorder, diagnosticClassification } from '../src/diagnostics/diagnostic-recorder.mjs';

test('diagnostic recorder keeps only safe allow-listed fields and reloads bounded history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'warun-diagnostic-recorder-'));
  const logPath = join(directory, 'communication.ndjson');
  try {
    const recorder = createDiagnosticRecorder({ logPath, now: () => 1_700_000_000_000, maxEntries: 2 });
    recorder.record({
      endpoint: 'POST /v1/orders',
      requestId: '00000000-0000-4000-8000-000000000001',
      status: 201,
      stage: 'saved',
      durationMs: 12,
      payload: { token: 'must-not-persist' },
    });
    recorder.record({
      endpoint: 'GET /v1/admin/order-history',
      requestId: '00000000-0000-4000-8000-000000000002',
      status: 200,
      stage: 'retrieved',
      resultCount: 1,
    });
    const raw = await readFile(logPath, 'utf8');
    assert.doesNotMatch(raw, /must-not-persist|payload/);
    assert.equal(recorder.list().length, 2);

    const reloaded = createDiagnosticRecorder({ logPath, maxEntries: 2 });
    assert.equal(reloaded.list().length, 2);
    assert.equal(reloaded.list()[0].endpoint, 'GET /v1/admin/order-history');
    assert.equal(reloaded.list()[1].endpoint, 'POST /v1/orders');
    assert.equal(diagnosticClassification({ endpoint: 'POST /v1/orders', status: 422, stage: 'repository-validation' }), 'payload_rejected');

    const catalogRecorder = createDiagnosticRecorder({ logPath: join(directory, 'catalog.ndjson'), now: () => 1_700_000_000_000 });
    catalogRecorder.record({
      endpoint: 'PUT /v1/admin/catalog/menu-item',
      requestId: '00000000-0000-4000-8000-000000000003',
      status: 500,
      stage: 'mutation',
      menuItemId: 'shochu-imo-kuro-kirishima',
      expectedVersion: 6,
      actualVersion: 6,
      payloadHash: 'a'.repeat(64),
      internalCode: 'CATALOG:DATABASE_FAILURE',
      causeCode: 'ERR_SQLITE_ERROR',
      requestBody: { token: 'must-not-persist' },
    });
    assert.deepEqual({
      menuItemId: catalogRecorder.list()[0].menuItemId,
      expectedVersion: catalogRecorder.list()[0].expectedVersion,
      actualVersion: catalogRecorder.list()[0].actualVersion,
      internalCode: catalogRecorder.list()[0].internalCode,
      causeCode: catalogRecorder.list()[0].causeCode,
    }, {
      menuItemId: 'shochu-imo-kuro-kirishima',
      expectedVersion: 6,
      actualVersion: 6,
      internalCode: 'CATALOG:DATABASE_FAILURE',
      causeCode: 'ERR_SQLITE_ERROR',
    });
    assert.doesNotMatch(await readFile(join(directory, 'catalog.ndjson'), 'utf8'), /must-not-persist|requestBody/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
