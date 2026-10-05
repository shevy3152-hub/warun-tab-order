import { createHash } from 'node:crypto';

// Deliberately excludes the open-session id: the first regular order creates
// that row, but must not invalidate an outbox record made before that order.
export function createCustomerVisitContextId({ tableId, deviceId, assignmentVersion, lastClosedSessionId = null }) {
  const value = JSON.stringify({
    version: 1,
    tableId: Number(tableId),
    deviceId: String(deviceId).toLowerCase(),
    assignmentVersion: Number(assignmentVersion),
    lastClosedSessionId: lastClosedSessionId ?? null,
  });
  return `v1_${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}
