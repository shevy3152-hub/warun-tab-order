import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const launcherPath = fileURLToPath(new URL('../start-safe-copy.ps1', import.meta.url));

async function runStatus(runtimeRoot) {
  return execFileAsync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    launcherPath,
    '-Action',
    'status',
    '-RuntimeRoot',
    runtimeRoot,
  ], { windowsHide: true });
}

test('safe-copy status reports an absent isolated state without touching live runtime', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'warun-safe-copy-state-empty-'));
  try {
    const result = await runStatus(directory);
    assert.match(result.stdout, /Runtime-state absent:/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('corrupt isolated state is rejected and preserved', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'warun-safe-copy-state-corrupt-'));
  const statePath = join(directory, 'runtime-state.json');
  const corrupt = '{ not-json';
  try {
    await writeFile(statePath, corrupt, 'utf8');
    await assert.rejects(runStatus(directory), /runtime-state\.json is invalid/);
    assert.equal(await readFile(statePath, 'utf8'), corrupt);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
