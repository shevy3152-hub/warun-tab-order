import assert from 'node:assert/strict';
import test from 'node:test';

import { runWithSubmissionLock } from '../src/admin-submit-lock.js';

test('admin save lock ignores concurrent submits and releases after completion', async () => {
  const lockRef = { current: false };
  let finishFirst;
  let submissions = 0;
  const pending = new Promise((resolve) => { finishFirst = resolve; });
  const first = runWithSubmissionLock(lockRef, async () => {
    submissions += 1;
    await pending;
  });

  assert.equal(lockRef.current, true);
  assert.equal(await runWithSubmissionLock(lockRef, async () => { submissions += 1; }), false);
  assert.equal(submissions, 1);
  finishFirst();
  assert.equal(await first, true);
  assert.equal(lockRef.current, false);
  assert.equal(await runWithSubmissionLock(lockRef, async () => { submissions += 1; }), true);
  assert.equal(submissions, 2);
});

test('admin save lock releases after a failed request', async () => {
  const lockRef = { current: false };
  await assert.rejects(runWithSubmissionLock(lockRef, async () => { throw new Error('isolated failure'); }), /isolated failure/);
  assert.equal(lockRef.current, false);
});
