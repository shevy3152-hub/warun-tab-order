import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const script = await readFile(new URL('../start-safe-copy.ps1', import.meta.url), 'utf8');
const command = await readFile(new URL('../start-safe-copy.cmd', import.meta.url), 'utf8');

test('safe-copy launcher refuses production and derives LAN URL at runtime', () => {
  assert.match(script, /WARUN_ENV = 'safe-copy'/);
  assert.match(script, /SafeCopiesRoot/);
  assert.match(script, /Refusing the production DB path/);
  assert.match(script, /Get-LanIPv4/);
  assert.match(script, /X-Warun-Database-Target/);
  assert.match(script, /schemaVersion -ne 5/);
  assert.match(script, /AdminTokenPath/);
  assert.match(script, /Read-SafeCopyAdminToken/);
  assert.match(script, /KitchenTokenPath/);
  assert.match(script, /Read-SafeCopyKitchenToken/);
  assert.match(script, /provision-safe-copy-kitchen-token\.mjs/);
  assert.match(script, /Invoke-SafeCopyKitchenTokenOperation -Mode 'check'/);
  assert.match(script, /Invoke-SafeCopyKitchenTokenOperation -Mode 'ensure'/);
  assert.match(script, /safe-copy kitchen token check\/provision failed; startup was stopped/);
  assert.match(script, /WARUN_KITCHEN_API_TOKEN = \$SafeCopyKitchenToken/);
  assert.match(script, /Assert-SafeCopyInjectedKitchenToken/);
  assert.match(script, /Get-AdminPreflight/);
  assert.match(script, /WARUN_ADMIN_API_TOKEN = \$SafeCopyAdminToken/);
  assert.match(script, /PairingDiagnosticLogPath/);
  assert.match(script, /WARUN_PAIRING_DIAGNOSTIC_LOG_PATH = \$PairingDiagnosticLogPath/);
  assert.match(script, /CommunicationDiagnosticLogPath/);
  assert.match(script, /WARUN_COMMUNICATION_DIAGNOSTIC_LOG_PATH = \$CommunicationDiagnosticLogPath/);
  assert.match(script, /safe-copy admin preflight did not return HTTP 200/);
  assert.doesNotMatch(script, /192\\.168\\.1\\./);
});

test('safe-copy command delegates to the dedicated script', () => {
  assert.match(command, /start-safe-copy\.ps1/);
});
