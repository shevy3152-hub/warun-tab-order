const EVENT_EPOCH_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EVENT_TYPE_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const EVENT_AUDIENCES = new Set(['customer', 'kitchen', 'admin']);
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const EVENT_RESOURCES = new Set(['orders', 'menu', 'staffCalls', 'deviceConfig']);
const EVENT_TYPES_BY_AUDIENCE = Object.freeze({
  customer: new Set([
    'order.created', 'order.updated', 'order.completed',
    'menu.updated', 'menu.sold_out_updated',
    'staff_call.created', 'staff_call.resolved',
    'device.revoked', 'table.assignment_updated',
  ]),
  kitchen: new Set([
    'order.created', 'order.updated', 'order.completed',
    'menu.updated', 'menu.sold_out_updated',
    'staff_call.created', 'staff_call.resolved',
    'table.assignment_updated',
  ]),
  admin: new Set([
    'order.created', 'order.updated', 'order.completed',
    'menu.updated', 'menu.sold_out_updated',
    'staff_call.created', 'staff_call.resolved',
    'device.paired', 'device.revoked', 'table.assignment_updated',
  ]),
});

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_MAX_CONNECTION_MS = 300_000;
const DEFAULT_MAX_QUEUE_BYTES = 256 * 1024;
const DEFAULT_MAX_QUEUE_FRAMES = 256;
const DEFAULT_REPLAY_BATCH_SIZE = 200;
const DEFAULT_RETRY_MS = 3_000;

function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function requireEpoch(value) {
  if (typeof value !== 'string' || !EVENT_EPOCH_PATTERN.test(value)) {
    throw new TypeError('eventEpoch must be a canonical UUID v4.');
  }
  return value;
}

function requireEmitter(value, label) {
  if (
    value === null
    || typeof value !== 'object'
    || typeof value.once !== 'function'
    || typeof value.removeListener !== 'function'
  ) {
    throw new TypeError(`${label} must be an event emitter.`);
  }
  return value;
}

function requireResponse(value) {
  requireEmitter(value, 'response');
  if (
    typeof value.write !== 'function'
    || typeof value.end !== 'function'
    || typeof value.destroy !== 'function'
    || typeof value.setHeader !== 'function'
  ) {
    throw new TypeError('response must be a writable HTTP response.');
  }
  return value;
}

function requireReplayResult(
  result,
  expectedAudience,
  expectedEpoch,
  afterEventId,
  throughEventId,
) {
  if (
    result === null
    || typeof result !== 'object'
    || result.audience !== expectedAudience
    || result.eventEpoch !== expectedEpoch
    || !isNonNegativeSafeInteger(result.lastEventId)
    || result.lastEventId < afterEventId
    || (throughEventId !== undefined && result.lastEventId > throughEventId)
    || !Array.isArray(result.events)
    || typeof result.hasMore !== 'boolean'
  ) {
    throw new Error('The event repository returned an invalid committed range.');
  }
  return result;
}

function eventResource(eventType) {
  if (eventType.startsWith('order.')) return 'orders';
  if (eventType.startsWith('menu.')) return 'menu';
  if (eventType.startsWith('staff_call.')) return 'staffCalls';
  return 'deviceConfig';
}

function requireProjectedEvent(
  event,
  expectedAudience,
  expectedEpoch,
  previousEventId,
  lastEventId,
) {
  if (
    event === null
    || typeof event !== 'object'
    || event.audience !== expectedAudience
    || event.eventEpoch !== expectedEpoch
    || !Number.isSafeInteger(event.eventId)
    || event.eventId <= previousEventId
    || event.eventId > lastEventId
    || typeof event.type !== 'string'
    || event.type.length > 80
    || !EVENT_TYPE_PATTERN.test(event.type)
    || !OPAQUE_ID_PATTERN.test(event.aggregateId)
    || !isNonNegativeSafeInteger(event.occurredAtMs)
    || event.payload === null
    || typeof event.payload !== 'object'
    || Array.isArray(event.payload)
  ) {
    throw new Error('The event repository returned an invalid projected event.');
  }
  if (!EVENT_TYPES_BY_AUDIENCE[expectedAudience].has(event.type)) {
    throw new Error('The event repository returned an invalid projected event.');
  }
  const payloadKeys = Object.keys(event.payload).sort();
  const resource = event.payload.resource;
  if (
    payloadKeys.length !== 2
    || payloadKeys[0] !== 'refreshRequired'
    || payloadKeys[1] !== 'resource'
    || !EVENT_RESOURCES.has(resource)
    || resource !== eventResource(event.type)
    || event.payload.refreshRequired !== true
  ) {
    throw new Error('The event repository returned an invalid projected event.');
  }
  return {
    audience: expectedAudience,
    eventEpoch: expectedEpoch,
    eventId: event.eventId,
    type: event.type,
    aggregateId: event.aggregateId,
    occurredAtMs: event.occurredAtMs,
    payload: { resource, refreshRequired: true },
  };
}

function eventFrame(event) {
  const envelope = {
    audience: event.audience,
    eventEpoch: event.eventEpoch,
    eventId: event.eventId,
    type: event.type,
    aggregateId: event.aggregateId,
    occurredAtMs: event.occurredAtMs,
    payload: event.payload,
  };
  return `id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(envelope)}\n\n`;
}

function cursorFrame(eventId) {
  return `id: ${eventId}\n: cursor\n\n`;
}

function defaultTimers() {
  return {
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
}

export function createSseHub({
  eventRepository,
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
  maxConnectionMs = DEFAULT_MAX_CONNECTION_MS,
  maxQueueBytes = DEFAULT_MAX_QUEUE_BYTES,
  maxQueueFrames = DEFAULT_MAX_QUEUE_FRAMES,
  replayBatchSize = DEFAULT_REPLAY_BATCH_SIZE,
  retryMs = DEFAULT_RETRY_MS,
  timers = defaultTimers(),
} = {}) {
  if (
    !eventRepository
    || typeof eventRepository.readCommittedForPrincipal !== 'function'
  ) {
    throw new TypeError('eventRepository.readCommittedForPrincipal is required.');
  }

  requirePositiveInteger(heartbeatIntervalMs, 'heartbeatIntervalMs');
  requirePositiveInteger(maxConnectionMs, 'maxConnectionMs');
  requirePositiveInteger(maxQueueBytes, 'maxQueueBytes');
  requirePositiveInteger(maxQueueFrames, 'maxQueueFrames');
  requirePositiveInteger(replayBatchSize, 'replayBatchSize');
  requirePositiveInteger(retryMs, 'retryMs');

  if (
    !timers
    || typeof timers.setInterval !== 'function'
    || typeof timers.clearInterval !== 'function'
    || typeof timers.setTimeout !== 'function'
    || typeof timers.clearTimeout !== 'function'
  ) {
    throw new TypeError('A complete timer implementation is required.');
  }

  const connections = new Set();
  let closed = false;

  function removeConnection(connection, { destroy = false, preserveResponse = false } = {}) {
    if (!connection.active) return;
    connection.active = false;
    connections.delete(connection);
    connection.request.removeListener('aborted', connection.onAborted);
    connection.response.removeListener('close', connection.onResponseClose);
    connection.response.removeListener('error', connection.onResponseError);
    connection.response.removeListener('drain', connection.onDrain);
    if (connection.lifetimeTimer !== undefined) {
      timers.clearTimeout(connection.lifetimeTimer);
      connection.lifetimeTimer = undefined;
    }
    connection.queue.length = 0;
    connection.queueBytes = 0;

    if (preserveResponse) return;
    try {
      if (destroy) {
        connection.response.destroy();
      } else if (!connection.response.writableEnded && !connection.response.destroyed) {
        connection.response.end();
      }
    } catch {
      try {
        connection.response.destroy();
      } catch {
        // Cleanup must not leak a socket failure to other subscribers.
      }
    }
  }

  function overflow(connection) {
    removeConnection(connection, { destroy: true });
  }

  function markBlocked(connection) {
    if (!connection.active || connection.blocked) return;
    connection.blocked = true;
    connection.response.once('drain', connection.onDrain);
  }

  function writeFrame(connection, frame) {
    if (!connection.active) return false;
    try {
      const accepted = connection.response.write(frame, 'utf8');
      if (!accepted) markBlocked(connection);
      return true;
    } catch {
      removeConnection(connection, { destroy: true });
      return false;
    }
  }

  function flushQueue(connection) {
    while (connection.active && !connection.blocked && connection.queue.length > 0) {
      const queued = connection.queue.shift();
      connection.queueBytes -= queued.bytes;
      if (!writeFrame(connection, queued.frame)) return;
    }
  }

  function enqueueFrame(connection, frame) {
    if (!connection.active) return false;
    const bytes = Buffer.byteLength(frame, 'utf8');
    if (bytes > maxQueueBytes) {
      overflow(connection);
      return false;
    }

    if (!connection.blocked && connection.queue.length === 0) {
      return writeFrame(connection, frame);
    }

    if (
      connection.queue.length + 1 > maxQueueFrames
      || connection.queueBytes + bytes > maxQueueBytes
    ) {
      overflow(connection);
      return false;
    }

    connection.queue.push({ frame, bytes });
    connection.queueBytes += bytes;
    return true;
  }

  function openStream(connection) {
    if (connection.headersOpened || !connection.active) return;
    const { response } = connection;
    response.statusCode = 200;
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store, no-transform');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Connection', 'keep-alive');
    if (typeof response.flushHeaders === 'function') response.flushHeaders();
    connection.headersOpened = true;
    enqueueFrame(connection, `retry: ${retryMs}\n\n`);
  }

  function applyRange(connection, result, requestedThroughId) {
    let projectedCursor = connection.cursor;
    for (const candidate of result.events) {
      if (candidate?.eventId <= projectedCursor) continue;
      const event = requireProjectedEvent(
        candidate,
        connection.audience,
        connection.eventEpoch,
        projectedCursor,
        result.lastEventId,
      );
      if (!enqueueFrame(connection, eventFrame(event))) return;
      projectedCursor = event.eventId;
      connection.cursor = projectedCursor;
    }

    if (connection.active && result.lastEventId > projectedCursor) {
      if (!enqueueFrame(connection, cursorFrame(result.lastEventId))) return;
      connection.cursor = result.lastEventId;
    }

    if (
      requestedThroughId !== undefined
      && connection.cursor > requestedThroughId
    ) {
      throw new Error('The event repository read past the requested committed event.');
    }
  }

  async function pump(connection) {
    while (connection.active) {
      const afterEventId = connection.cursor;
      const requestedThroughId = connection.targetEventId > afterEventId
        ? connection.targetEventId
        : undefined;
      const result = requireReplayResult(
        await eventRepository.readCommittedForPrincipal(connection.principal, {
          eventEpoch: connection.eventEpoch,
          afterEventId,
          throughEventId: requestedThroughId,
          limit: replayBatchSize,
        }),
        connection.audience,
        connection.eventEpoch,
        afterEventId,
        requestedThroughId,
      );

      if (!connection.active) return;
      openStream(connection);
      applyRange(connection, result, requestedThroughId);
      if (!connection.active) return;

      const progressed = connection.cursor > afterEventId;
      if (result.hasMore) {
        if (!progressed) {
          throw new Error('The event repository did not advance a paged committed range.');
        }
        continue;
      }
      if (requestedThroughId !== undefined && connection.cursor < requestedThroughId) {
        if (!progressed) {
          throw new Error('The committed event notification was not readable.');
        }
        continue;
      }
      if (connection.targetEventId > connection.cursor) continue;
      return;
    }
  }

  function schedulePump(connection) {
    if (!connection.active) return Promise.resolve();
    if (connection.pumpPromise) return connection.pumpPromise;

    const running = pump(connection);
    connection.pumpPromise = running;
    running.then(
      () => {
        connection.pumpPromise = undefined;
        if (connection.active && connection.targetEventId > connection.cursor) {
          schedulePump(connection);
        }
      },
      () => {
        connection.pumpPromise = undefined;
        removeConnection(connection, {
          destroy: connection.headersOpened,
          preserveResponse: !connection.headersOpened,
        });
      },
    );
    // A route may await `ready`; this catch also prevents an ignored live wake
    // failure from becoming an unhandled rejection.
    running.catch(() => {});
    return running;
  }

  function attach({ request, response, principal, eventEpoch, afterEventId } = {}) {
    if (closed) throw new Error('The SSE hub is closed.');
    requireEmitter(request, 'request');
    requireResponse(response);
    requireEpoch(eventEpoch);
    if (!isNonNegativeSafeInteger(afterEventId)) {
      throw new TypeError('afterEventId must be a non-negative safe integer.');
    }
    if (
      principal === null
      || typeof principal !== 'object'
      || !EVENT_AUDIENCES.has(principal.role)
    ) {
      throw new TypeError('An authenticated principal is required.');
    }

    const connection = {
      request,
      response,
      principal,
      audience: principal.role,
      eventEpoch,
      cursor: afterEventId,
      targetEventId: afterEventId,
      queue: [],
      queueBytes: 0,
      active: true,
      blocked: false,
      headersOpened: false,
      lifetimeTimer: undefined,
      pumpPromise: undefined,
      onAborted: undefined,
      onResponseClose: undefined,
      onResponseError: undefined,
      onDrain: undefined,
    };

    connection.onAborted = () => removeConnection(connection);
    connection.onResponseClose = () => removeConnection(connection);
    connection.onResponseError = () => removeConnection(connection, { destroy: true });
    connection.onDrain = () => {
      if (!connection.active) return;
      connection.blocked = false;
      flushQueue(connection);
    };

    request.once('aborted', connection.onAborted);
    response.once('close', connection.onResponseClose);
    response.once('error', connection.onResponseError);
    connection.lifetimeTimer = timers.setTimeout(() => {
      removeConnection(connection);
    }, maxConnectionMs);
    connection.lifetimeTimer?.unref?.();
    connections.add(connection);

    const ready = schedulePump(connection);
    return Object.freeze({
      ready,
      close() {
        removeConnection(connection);
      },
      get active() {
        return connection.active;
      },
      get lastEventId() {
        return connection.cursor;
      },
    });
  }

  function notifyCommitted(notification) {
    if (
      closed
      || notification === null
      || typeof notification !== 'object'
      || typeof notification.eventEpoch !== 'string'
      || !EVENT_EPOCH_PATTERN.test(notification.eventEpoch)
      || !Number.isSafeInteger(notification.eventId)
      || notification.eventId < 1
    ) {
      return 0;
    }

    let awakened = 0;
    for (const connection of [...connections]) {
      if (connection.eventEpoch !== notification.eventEpoch) {
        removeConnection(connection);
        continue;
      }
      if (notification.eventId <= connection.cursor) continue;
      connection.targetEventId = Math.max(connection.targetEventId, notification.eventId);
      schedulePump(connection);
      awakened += 1;
    }
    return awakened;
  }

  const heartbeatTimer = timers.setInterval(() => {
    for (const connection of [...connections]) {
      if (
        connection.active
        && connection.headersOpened
        && !connection.blocked
        && connection.queue.length === 0
      ) {
        enqueueFrame(connection, ': keepalive\n\n');
      }
    }
  }, heartbeatIntervalMs);
  heartbeatTimer?.unref?.();

  return Object.freeze({
    attach,
    notifyCommitted,
    close() {
      if (closed) return;
      closed = true;
      timers.clearInterval(heartbeatTimer);
      for (const connection of [...connections]) {
        removeConnection(connection, { destroy: true });
      }
    },
    get size() {
      return connections.size;
    },
  });
}
