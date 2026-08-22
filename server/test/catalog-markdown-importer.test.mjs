import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { importCatalogMarkdown, parseImageMappingMarkdown } from '../src/catalog/catalog-markdown-importer.mjs';
import { initializeDatabase } from '../src/db/database.mjs';

const uuid = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const FIXTURE_MARKDOWN = await readFile(new URL('./fixtures/catalog-fixture.md', import.meta.url), 'utf8');
const FIXTURE_IMAGES = await readFile(new URL('./fixtures/catalog-images.md', import.meta.url), 'utf8');
const FIXED_NOW = 1_800_000_100_000;
const CUSTOMER_ID = uuid(9_101);
const ORDER_ID = uuid(9_102);
const CLIENT_ORDER_ID = uuid(9_103);
const SESSION_ID = uuid(9_104);

function seedExistingDatabase(database) {
  database.prepare(`
    INSERT INTO devices (
      device_id, role, display_name, token_hash, status, paired_at_ms,
      revoked_at_ms, created_at_ms, updated_at_ms
    ) VALUES (?, 'customer', 'Fixture customer', ?, 'active', 1000, NULL, 1000, 1000)
  `).run(CUSTOMER_ID, 'a'.repeat(64));
  database.prepare(`
    INSERT INTO tables (
      table_id, label, assigned_customer_device_id, is_active, version, created_at_ms, updated_at_ms
    ) VALUES (1, 'Fixture table', ?, 1, 1, 1000, 1000)
  `).run(CUSTOMER_ID);
  database.prepare(`
    INSERT INTO table_sessions (
      session_id, table_id, opened_at_ms, closed_at_ms, version, created_at_ms, updated_at_ms
    ) VALUES (?, 1, 1000, NULL, 1, 1000, 1000)
  `).run(SESSION_ID);
  database.prepare(`
    INSERT INTO categories (
      category_id, name, sort_order, is_visible, version, created_at_ms, updated_at_ms
    ) VALUES ('fixture-drinks', 'Old Fixture Drinks', 9, 1, 2, 1000, 2000)
  `).run();
  database.prepare(`
    INSERT INTO menu_items (
      menu_item_id, category_id, formal_name, kitchen_alias, description, price_yen,
      is_sold_out, is_active, sort_order, image_uri, version, created_at_ms, updated_at_ms, section_key
    ) VALUES ('fixture-shochu', 'fixture-drinks', 'Old Fixture Shochu', 'Old F-Shochu', 'Old description', 600, 0, 1, 8, NULL, 3, 1000, 3000, '麦・その他')
  `).run();
  database.prepare(`
    INSERT INTO menu_item_details (
      menu_item_id, detail_enabled, detail_image_uri, reading, item_type, origin, producer, taste,
      aroma, sweetness, finish, recommendation, detail_description, version, created_at_ms, updated_at_ms
    ) VALUES ('fixture-shochu', 1, NULL, 'old', '焼酎', 'old', 'old', 'old', 'old', 'old', 'old', 'old', 'old', 2, 1000, 3000)
  `).run();
  database.prepare(`
    INSERT INTO menu_item_variants (
      variant_id, menu_item_id, name, volume_label, price_yen, is_active, sort_order, version, created_at_ms, updated_at_ms
    ) VALUES ('fixture-old-variant', 'fixture-shochu', 'Old variant', '90ml', 500, 1, 1, 1, 1000, 1000)
  `).run();
  database.prepare(`
    INSERT INTO menu_item_variants (
      variant_id, menu_item_id, name, volume_label, price_yen, is_active, sort_order, version, created_at_ms, updated_at_ms
    ) VALUES ('fixture-shochu-rock', 'fixture-shochu', 'Existing rock', '90ml', 510, 1, 2, 1, 1000, 1000)
  `).run();
  database.prepare(`
    INSERT INTO menu_item_serving_options (
      serving_option_id, menu_item_id, name, is_active, sort_order, version, created_at_ms, updated_at_ms
    ) VALUES ('fixture-old-option', 'fixture-shochu', 'Old option', 1, 1, 1, 1000, 1000)
  `).run();
  database.prepare(`
    INSERT INTO orders (
      order_id, client_order_id, request_fingerprint, canonical_request_json,
      customer_device_id, table_id, session_id, table_number_snapshot, status,
      total_amount_yen, client_created_at_ms, accepted_at_ms, completed_at_ms, version
    ) VALUES (?, ?, ?, '{}', ?, 1, ?, 1, 'completed', 600, NULL, 1000, 2000, 1)
  `).run(ORDER_ID, CLIENT_ORDER_ID, 'a'.repeat(64), CUSTOMER_ID, SESSION_ID);
  database.prepare(`
    INSERT INTO order_items (
      order_id, line_index, menu_item_id, formal_name_snapshot, kitchen_alias_snapshot,
      unit_price_yen_snapshot, quantity, line_total_yen, is_served, served_at_ms,
      served_by_device_id, created_at_ms, updated_at_ms
    ) VALUES (?, 0, 'fixture-shochu', 'Old Fixture Shochu', 'Old F-Shochu', 600, 1, 600, 1, 2000, ?, 1000, 2000)
  `).run(ORDER_ID, CUSTOMER_ID);
  const { event_epoch: eventEpoch } = database.prepare('SELECT event_epoch FROM system_state WHERE singleton_id = 1').get();
  database.prepare(`
    INSERT INTO event_log (
      event_epoch, event_type, aggregate_type, aggregate_id, actor_device_id, payload_json, created_at_ms
    ) VALUES (?, 'order.created', 'order', ?, ?, '{}', 1000)
  `).run(eventEpoch, ORDER_ID, CUSTOMER_ID);
}

async function withFixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'warun-markdown-import-'));
  const databasePath = join(directory, 'fixture.sqlite3');
  const connection = initializeDatabase({ databasePath });
  try {
    seedExistingDatabase(connection.database);
    await run({ database: connection.database, databasePath, directory });
  } finally {
    try { connection.close(); } catch {}
    await rm(directory, { recursive: true, force: true });
  }
}

function digest(database) {
  return createHash('sha256').update(database.serialize()).digest('hex');
}

function statuses(result) {
  return result.changes.map((change) => ({ status: change.status, kind: change.kind, id: change.id, code: change.code ?? null }));
}

function allCounts(database) {
  return Object.fromEntries(['orders', 'order_items', 'event_log'].map((table) => [table, database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]));
}

test('valid fixture Markdown supports dry-run without changing the fixture DB', async () => {
  await withFixture(async ({ database, databasePath }) => {
    const before = digest(database);
    const result = await importCatalogMarkdown({
      database,
      databasePath,
      targetKind: 'fixture',
      markdown: FIXTURE_MARKDOWN,
      imageMappingMarkdown: FIXTURE_IMAGES,
      dryRun: true,
      now: () => FIXED_NOW,
    });
    assert.equal(result.applied, false);
    assert.equal(result.errors.length, 0);
    assert.ok(result.changes.some((change) => change.status === 'update' && change.id === 'fixture-shochu'));
    assert.ok(result.changes.some((change) => change.status === 'create' && change.id === 'fixture-sake'));
    assert.ok(result.changes.some((change) => change.status === 'update' && change.id === 'fixture-drinks'));
    assert.equal(digest(database), before);
  });
});

test('fixture Markdown applies atomically and stores details, variants, serving options, section, and mapped images', async () => {
  await withFixture(async ({ database, databasePath, directory }) => {
    const beforeCounts = allCounts(database);
    const dryRun = await importCatalogMarkdown({
      database,
      databasePath,
      targetKind: 'fixture',
      markdown: FIXTURE_MARKDOWN,
      imageMappingMarkdown: FIXTURE_IMAGES,
      dryRun: true,
      now: () => FIXED_NOW,
    });
    const result = await importCatalogMarkdown({
      database,
      databasePath,
      targetKind: 'fixture',
      markdown: FIXTURE_MARKDOWN,
      imageMappingMarkdown: FIXTURE_IMAGES,
      dryRun: false,
      backupPath: join(directory, 'before-import.sqlite3'),
      now: () => FIXED_NOW,
    });
    assert.equal(result.applied, true);
    assert.equal(result.errors.length, 0);
    assert.deepEqual(statuses(result), statuses(dryRun));
    assert.equal(result.backupPath, join(directory, 'before-import.sqlite3'));
    assert.deepEqual(allCounts(database), { orders: beforeCounts.orders, order_items: beforeCounts.order_items, event_log: beforeCounts.event_log + 3 });

    const shochu = database.prepare('SELECT * FROM menu_items WHERE menu_item_id = ?').get('fixture-shochu');
    assert.equal(shochu.formal_name, 'Fixture Shochu');
    assert.equal(shochu.section_key, '芋');
    assert.equal(shochu.image_uri, '/fixture/menu/fixture-shochu.webp');
    const detail = database.prepare('SELECT * FROM menu_item_details WHERE menu_item_id = ?').get('fixture-shochu');
    assert.equal(detail.aroma, 'Fixture Aroma');
    assert.equal(detail.sweetness, 'Fixture Sweetness');
    assert.equal(detail.finish, 'Fixture Finish');
    assert.equal(detail.detail_image_uri, '/fixture/menu/fixture-shochu-detail.webp');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM menu_item_variants WHERE menu_item_id = ? AND is_active = 1').get('fixture-sake').count, 2);
    assert.equal(database.prepare('SELECT temperature_options_json FROM menu_item_variants WHERE variant_id = ?').get('fixture-sake-glass').temperature_options_json, '["冷酒"]');
    assert.equal(database.prepare('SELECT temperature_options_json FROM menu_item_variants WHERE variant_id = ?').get('fixture-sake-tokuri').temperature_options_json, '["冷酒","燗酒"]');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM menu_item_serving_options WHERE menu_item_id = ? AND is_active = 1').get('fixture-shochu').count, 4);
    assert.equal(database.prepare('SELECT is_active FROM menu_item_variants WHERE variant_id = ?').get('fixture-old-variant').is_active, 0);
    assert.equal(database.prepare('SELECT formal_name_snapshot, unit_price_yen_snapshot FROM order_items WHERE order_id = ?').get(ORDER_ID).formal_name_snapshot, 'Old Fixture Shochu');
  });
});

test('applying the same fixture Markdown twice produces unchanged results without duplicate rows or events', async () => {
  await withFixture(async ({ database, databasePath, directory }) => {
    const first = await importCatalogMarkdown({ database, databasePath, targetKind: 'fixture', markdown: FIXTURE_MARKDOWN, imageMappingMarkdown: FIXTURE_IMAGES, dryRun: false, backupPath: join(directory, 'first.sqlite3'), now: () => FIXED_NOW });
    assert.equal(first.errors.length, 0);
    const eventCount = database.prepare('SELECT COUNT(*) AS count FROM event_log').get().count;
    const itemCount = database.prepare('SELECT COUNT(*) AS count FROM menu_items').get().count;
    const second = await importCatalogMarkdown({ database, databasePath, targetKind: 'fixture', markdown: FIXTURE_MARKDOWN, imageMappingMarkdown: FIXTURE_IMAGES, dryRun: false, backupPath: join(directory, 'second.sqlite3'), now: () => FIXED_NOW });
    assert.equal(second.errors.length, 0);
    assert.equal(second.changes.filter((change) => change.status === 'create' || change.status === 'update').length, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM event_log').get().count, eventCount);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM menu_items').get().count, itemCount);
  });
});

test('missing image mappings are warnings and preserve an existing image', async () => {
  await withFixture(async ({ database, databasePath }) => {
    const result = await importCatalogMarkdown({
      database,
      databasePath,
      targetKind: 'fixture',
      markdown: FIXTURE_MARKDOWN,
      imageMap: { 'fixture-shochu': '/fixture/menu/only-shochu.webp' },
      dryRun: true,
    });
    assert.equal(result.errors.length, 0);
    assert.ok(result.warnings.some((warning) => warning.code === 'IMAGE_MAPPING_MISSING' && warning.target === 'fixture-sake'));
    assert.ok(result.changes.some((change) => change.status === 'warning'));
  });
});

test('invalid fields, duplicate stable ids, and unknown image references fail before apply', async () => {
  await withFixture(async ({ database, databasePath }) => {
    const invalid = await importCatalogMarkdown({ database, databasePath, targetKind: 'fixture', markdown: '## category: duplicate\n- name: One\n- sort_order: 1\n- is_visible: true\n\n## category: duplicate\n- name: Two\n- sort_order: 2\n- is_visible: true', dryRun: false, backupPath: `${databasePath}.backup` });
    assert.equal(invalid.applied, false);
    assert.equal(invalid.errors[0].code, 'DUPLICATE_STABLE_ID');
    assert.equal(invalid.changes.at(-1).status, 'error');
    const unknownImage = await importCatalogMarkdown({ database, databasePath, targetKind: 'fixture', markdown: FIXTURE_MARKDOWN, imageMap: { unknown: '/fixture/unknown.webp' }, dryRun: true });
    assert.equal(unknownImage.errors[0].code, 'IMAGE_REFERENCE_NOT_FOUND');
  });
});

test('a mid-apply database constraint rolls back all catalog rows and events', async () => {
  await withFixture(async ({ database, databasePath, directory }) => {
    const conflictingMarkdown = FIXTURE_MARKDOWN.replace('fixture-sake-glass', 'fixture-shochu-rock');
    const beforeDigest = digest(database);
    const beforeCounts = allCounts(database);
    const result = await importCatalogMarkdown({ database, databasePath, targetKind: 'fixture', markdown: conflictingMarkdown, imageMappingMarkdown: FIXTURE_IMAGES, dryRun: false, backupPath: join(directory, 'rollback.sqlite3'), now: () => FIXED_NOW });
    assert.equal(result.applied, false);
    assert.equal(result.errors[0].code, 'IMPORT_ROLLED_BACK');
    assert.deepEqual(allCounts(database), beforeCounts);
    assert.equal(database.prepare('SELECT formal_name FROM menu_items WHERE menu_item_id = ?').get('fixture-shochu').formal_name, 'Old Fixture Shochu');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM menu_items WHERE menu_item_id = ?').get('fixture-sake').count, 0);
    assert.equal(digest(database), beforeDigest);
  });
});

test('production target kind is rejected and image mapping parser requires stable targets', async () => {
  await withFixture(async ({ database, databasePath }) => {
    const unsafe = await importCatalogMarkdown({ database, databasePath, targetKind: 'production', markdown: FIXTURE_MARKDOWN, dryRun: true });
    assert.equal(unsafe.errors[0].code, 'UNSAFE_TARGET');
  });
  assert.throws(() => parseImageMappingMarkdown('| target | image_uri |\n| --- | --- |\n| fixture | |'), (error) => error.code === 'IMAGE_URI_REQUIRED');
});
