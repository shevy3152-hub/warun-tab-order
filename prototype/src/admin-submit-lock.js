export async function runWithSubmissionLock(lockRef, action) {
  if (lockRef.current) return false;
  lockRef.current = true;
  try {
    await action();
    return true;
  } finally {
    lockRef.current = false;
  }
}
