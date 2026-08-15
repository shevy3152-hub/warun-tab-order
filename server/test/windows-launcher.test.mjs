import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const launcherUrl = new URL('../start-windows.ps1', import.meta.url);
const wrapperUrl = new URL('../start-windows.cmd', import.meta.url);

test('Windows launcher keeps the token in the user environment and process memory', async () => {
  const source = await readFile(launcherUrl, 'utf8');

  assert.match(source, /GetEnvironmentVariable\('WARUN_KITCHEN_API_TOKEN', 'User'\)/);
  assert.match(source, /\$env:WARUN_KITCHEN_API_TOKEN = \$token/);
  assert.doesNotMatch(source, /setx/i);
  assert.doesNotMatch(source, /-ArgumentList[^\r\n]*WARUN_KITCHEN_API_TOKEN/);
});

test('Windows launcher verifies identity before reusing occupied ports', async () => {
  const source = await readFile(launcherUrl, 'utf8');

  assert.match(source, /Get-ListeningProcessIds \$WebPort/);
  assert.match(source, /Get-ListeningProcessIds \$ApiPort/);
  assert.match(source, /src\[\\\\\/\]run-server\\\.mjs/);
  assert.match(source, /Test-ProjectHttpSignature/);
  assert.doesNotMatch(source, /Stop-Process|taskkill|kill\s/i);
});

test('Windows launcher starts the documented server entry hidden with local logs', async () => {
  const source = await readFile(launcherUrl, 'utf8');

  assert.match(source, /ArgumentList = @\('src\/run-server\.mjs'\)/);
  assert.match(source, /WorkingDirectory = \$ServerRoot/);
  assert.match(source, /WindowStyle = 'Hidden'/);
  assert.match(source, /RedirectStandardOutput = \$stdoutLog/);
  assert.match(source, /RedirectStandardError = \$stderrLog/);
  assert.match(source, /LocalApplicationData/);
});

test('Windows launcher enforces IP, timeout, LAN checks, and authenticated snapshot', async () => {
  const source = await readFile(launcherUrl, 'utf8');

  assert.match(source, /\$TargetIp = '192\.168\.1\.10'/);
  assert.match(source, /\[int\]\$TimeoutSeconds = 45/);
  assert.match(source, /Wait-ForReady/);
  assert.match(source, /\$LanHealthUrl/);
  assert.match(source, /\$LanWebUrl/);
  assert.match(source, /\$SnapshotUrl/);
  assert.match(source, /Authorization = "Bearer \$Token"/);
});

test('Windows wrapper launches PowerShell rather than a URL shortcut', async () => {
  const source = await readFile(wrapperUrl, 'utf8');

  assert.match(source, /powershell\.exe/);
  assert.match(source, /start-windows\.ps1/);
  assert.doesNotMatch(source, /https?:\/\//i);
});
