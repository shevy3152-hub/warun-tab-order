import {
  CATALOG_ERROR_CODES,
  isCatalogRepositoryError,
} from '../catalog/catalog-errors.mjs';
import {
  EVENT_ERROR_CODES,
  isEventRepositoryError,
} from './event-errors.mjs';
import {
  SNAPSHOT_ERROR_CODES,
  SnapshotServiceError,
} from './snapshot-errors.mjs';
import { orderItemAmounts, sumCurrentOrderItemTotals } from '../orders/order-pricing.mjs';

const DEVICE_ROLES = Object.freeze(['customer', 'kitchen', 'admin']);
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_ATTEMPTS_LIMIT = 10;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

class InvalidSnapshotCandidate extends Error {}

function serviceError(code, message, options = undefined) {
  return new SnapshotServiceError(code, message, options);
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function requireObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidSnapshotCandidate();
  }
  return value;
}

function requireArray(value) {
  if (!Array.isArray(value)) throw new InvalidSnapshotCandidate();
  return value;
}

function requireString(value) {
  if (typeof value !== 'string') throw new InvalidSnapshotCandidate();
  return value;
}

function requireBoolean(value) {
  if (typeof value !== 'boolean') throw new InvalidSnapshotCandidate();
  return value;
}

function requireInteger(value, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new InvalidSnapshotCandidate();
  return value;
}

function requireSignedInteger(value) {
  if (!Number.isSafeInteger(value)) throw new InvalidSnapshotCandidate();
  return value;
}

function requireOneOf(value, allowed) {
  if (!allowed.has(value)) throw new InvalidSnapshotCandidate();
  return value;
}

function optionalString(target, key, value) {
  if (value !== undefined) target[key] = requireString(value);
}

function optionalInteger(target, key, value, minimum = 0) {
  if (value !== undefined) target[key] = requireInteger(value, minimum);
}

function projectDetail(source) {
  const value = requireObject(source);
  const detail = { enabled: requireBoolean(value.enabled) };
  for (const key of ['imageUri', 'reading', 'itemType', 'origin', 'producer', 'taste', 'aroma', 'sweetness', 'finish', 'recommendation', 'description']) {
    optionalString(detail, key, value[key]);
  }
  return detail;
}

function projectVariant(source, admin = false) {
  const value = requireObject(source);
  const variant = {
    variantId: requireString(value.variantId),
    name: requireString(value.name),
    volumeLabel: requireString(value.volumeLabel),
    priceYen: requireInteger(value.priceYen),
    sortOrder: requireInteger(value.sortOrder),
  };
  if (admin) {
    variant.isActive = requireBoolean(value.isActive);
    variant.version = requireInteger(value.version, 1);
  }
  return variant;
}

function projectServingOption(source, admin = false) {
  const value = requireObject(source);
  const option = {
    servingOptionId: requireString(value.servingOptionId),
    name: requireString(value.name),
    sortOrder: requireInteger(value.sortOrder),
  };
  if (admin) {
    option.isActive = requireBoolean(value.isActive);
    option.version = requireInteger(value.version, 1);
  }
  return option;
}

function validateCursor(value) {
  const object = requireObject(value);
  const eventEpoch = requireString(object.eventEpoch);
  const lastEventId = requireInteger(object.lastEventId);
  if (!UUID_PATTERN.test(eventEpoch)) throw new InvalidSnapshotCandidate();
  return { eventEpoch, lastEventId };
}

function projectDevice(role, source) {
  const value = requireObject(source);
  if (value.role !== role) throw new InvalidSnapshotCandidate();
  const device = {
    deviceId: requireString(value.deviceId),
    role,
    deviceLabel: requireString(value.deviceLabel),
    status: requireString(value.status),
    configVersion: requireInteger(value.configVersion, 1),
    eventEpoch: requireString(value.eventEpoch),
    lastEventId: requireInteger(value.lastEventId),
  };
  if (role === 'customer') {
    device.tableId = requireInteger(value.tableId, 1);
    device.tableLabel = requireString(value.tableLabel);
    device.tableIsActive = requireBoolean(value.tableIsActive);
  }
  return device;
}

function projectCategory(role, source) {
  const value = requireObject(source);
  const category = {
    categoryId: requireString(value.categoryId),
    name: requireString(value.name),
    sortOrder: requireInteger(value.sortOrder),
  };
  if (role === 'admin') {
    category.isVisible = requireBoolean(value.isVisible);
    category.version = requireInteger(value.version, 1);
    category.updatedAtMs = requireInteger(value.updatedAtMs);
  }
  return category;
}

function projectMenuItem(role, source) {
  const value = requireObject(source);
  const item = {
    menuItemId: requireString(value.menuItemId),
    categoryId: requireString(value.categoryId),
    formalName: requireString(value.formalName),
  };
  if (role === 'customer' || role === 'admin') item.description = requireString(value.description);
  if (role === 'customer' || role === 'admin') item.priceYen = requireInteger(value.priceYen);
  if (role === 'kitchen' || role === 'admin') {
    item.kitchenAlias = requireString(value.kitchenAlias);
  }
  item.isSoldOut = requireBoolean(value.isSoldOut);
  if (role === 'admin') item.isActive = requireBoolean(value.isActive);
  item.sortOrder = requireInteger(value.sortOrder);
  item.version = requireInteger(value.version, 1);
  if (role === 'admin') item.updatedAtMs = requireInteger(value.updatedAtMs);
  optionalString(item, 'imageUri', value.imageUri);
  optionalString(item, 'sectionKey', value.sectionKey);
  if (role === 'customer' || role === 'admin') {
    item.variants = requireArray(value.variants).map((variant) => projectVariant(variant, role === 'admin'));
    item.servingOptions = requireArray(value.servingOptions).map((option) => projectServingOption(option, role === 'admin'));
    if (value.detail !== undefined) item.detail = projectDetail(value.detail);
  }
  return item;
}

function projectMenu(role, source) {
  const value = requireObject(source);
  if (value.audience !== role) throw new InvalidSnapshotCandidate();
  return {
    audience: role,
    eventEpoch: requireString(value.eventEpoch),
    lastEventId: requireInteger(value.lastEventId),
    categories: requireArray(value.categories).map((entry) => projectCategory(role, entry)),
    items: requireArray(value.items).map((entry) => projectMenuItem(role, entry)),
  };
}

function projectOrderItem(source) {
  const value = requireObject(source);
  const amounts = orderItemAmounts(value);
  const isCancelled = value.isCancelled === undefined ? false : requireBoolean(value.isCancelled);
  const cancellationHistory = requireArray(value.cancellationHistory ?? []).map((sourceEvent) => {
    const event = requireObject(sourceEvent);
    if (event.reason !== null && typeof event.reason !== 'string') throw new InvalidSnapshotCandidate();
    if (event.servedAtMsSnapshot !== null && event.servedAtMsSnapshot !== undefined) requireInteger(event.servedAtMsSnapshot);
    if (event.servedByDeviceIdSnapshot !== null && event.servedByDeviceIdSnapshot !== undefined) requireString(event.servedByDeviceIdSnapshot);
    return {
      eventId: requireInteger(event.eventId, 1),
      operationId: event.operationId == null ? null : requireString(event.operationId),
      action: requireOneOf(event.action, new Set(['cancelled', 'restored'])),
      actorDeviceId: requireString(event.actorDeviceId),
      actorLabel: requireString(event.actorLabel),
      occurredAtMs: requireInteger(event.occurredAtMs),
      reason: event.reason,
      isServedSnapshot: requireBoolean(event.isServedSnapshot),
      servedAtMsSnapshot: event.servedAtMsSnapshot ?? null,
      servedByDeviceIdSnapshot: event.servedByDeviceIdSnapshot ?? null,
    };
  });
  const quantityHistory = requireArray(value.quantityHistory ?? []).map((sourceEvent) => {
    const event = requireObject(sourceEvent);
    if (event.servedAtMsSnapshot !== null && event.servedAtMsSnapshot !== undefined) requireInteger(event.servedAtMsSnapshot);
    if (event.servedByDeviceIdSnapshot !== null && event.servedByDeviceIdSnapshot !== undefined) requireString(event.servedByDeviceIdSnapshot);
    if (event.relatedOrderItemId !== null && event.relatedOrderItemId !== undefined) requireInteger(event.relatedOrderItemId, 1);
    if (event.relatedOrderId !== null && event.relatedOrderId !== undefined) requireString(event.relatedOrderId);
    return {
      eventId: requireInteger(event.eventId, 1),
      operationId: requireString(event.operationId),
      action: requireOneOf(event.action, new Set(['added', 'decreased'])),
      quantityDelta: requireSignedInteger(event.quantityDelta),
      previousBillableQuantity: requireInteger(event.previousBillableQuantity, 1),
      nextBillableQuantity: requireInteger(event.nextBillableQuantity, 1),
      relatedOrderId: event.relatedOrderId ?? null,
      relatedOrderItemId: event.relatedOrderItemId ?? null,
      actorDeviceId: requireString(event.actorDeviceId),
      actorLabel: requireString(event.actorLabel),
      occurredAtMs: requireInteger(event.occurredAtMs),
      isServedSnapshot: requireBoolean(event.isServedSnapshot),
      servedAtMsSnapshot: event.servedAtMsSnapshot ?? null,
      servedByDeviceIdSnapshot: event.servedByDeviceIdSnapshot ?? null,
    };
  });
  const item = {
    orderItemId: requireInteger(value.orderItemId, 1),
    formalNameSnapshot: requireString(value.formalNameSnapshot),
    kitchenAliasSnapshot: requireString(value.kitchenAliasSnapshot),
    unitPriceYenSnapshot: requireInteger(amounts.unitPriceYenSnapshot),
    adjustedUnitPriceYen: amounts.adjustedUnitPriceYen === null
      ? null
      : requireInteger(amounts.adjustedUnitPriceYen),
    currentUnitPriceYen: requireInteger(amounts.currentUnitPriceYen),
    quantity: requireInteger(amounts.quantity, 1),
    quantityReduced: requireInteger(amounts.quantityReduced),
    billableQuantity: requireInteger(amounts.billableQuantity),
    lineTotalYenSnapshot: requireInteger(amounts.lineTotalYenSnapshot),
    lineTotalYen: requireInteger(amounts.lineTotalYen),
    currentBillableAmountYen: requireInteger(value.currentBillableAmountYen ?? (isCancelled ? 0 : amounts.lineTotalYen)),
    isServed: requireBoolean(value.isServed),
    isCancelled,
    cancellationHistory,
    quantityHistory,
  };
  optionalString(item, 'menuItemId', value.menuItemId);
  optionalInteger(item, 'servedAtMs', value.servedAtMs);
  optionalString(item, 'servedByDeviceId', value.servedByDeviceId);
  optionalString(item, 'variantId', value.variantId);
  optionalString(item, 'variantNameSnapshot', value.variantNameSnapshot);
  optionalString(item, 'variantVolumeSnapshot', value.variantVolumeSnapshot);
  optionalString(item, 'temperatureSnapshot', value.temperatureSnapshot);
  optionalString(item, 'servingOptionId', value.servingOptionId);
  optionalString(item, 'servingOptionNameSnapshot', value.servingOptionNameSnapshot);
  return item;
}

function projectOrder(source) {
  const value = requireObject(source);
  const items = requireArray(value.items).map(projectOrderItem);
  const totalAmountYen = requireInteger(value.totalAmountYen);
  if (sumCurrentOrderItemTotals(items) !== totalAmountYen) throw new InvalidSnapshotCandidate();
  const order = {
    orderId: requireString(value.orderId),
    clientOrderId: requireString(value.clientOrderId),
    tableId: requireInteger(value.tableId, 1),
    tableNumberSnapshot: requireInteger(value.tableNumberSnapshot, 1),
    status: requireString(value.status),
    totalAmountYen,
    acceptedAtMs: requireInteger(value.acceptedAtMs),
    version: requireInteger(value.version, 1),
    items,
  };
  if (Object.hasOwn(value, 'sessionId')) order.sessionId = requireString(value.sessionId);
  if (Object.hasOwn(value, 'orderOrigin')) order.orderOrigin = requireOneOf(value.orderOrigin, new Set(['customer', 'kitchen_addition']));
  optionalString(order, 'createdByDeviceId', value.createdByDeviceId);
  optionalInteger(order, 'completedAtMs', value.completedAtMs);
  return order;
}

function projectOpenSession(source) {
  const value = requireObject(source);
  return {
    sessionId: requireString(value.sessionId),
    tableId: requireInteger(value.tableId, 1),
    openedAtMs: requireInteger(value.openedAtMs),
    version: requireInteger(value.version, 1),
  };
}

function projectStaffCall(source) {
  const value = requireObject(source);
  const call = {
    staffCallId: requireString(value.staffCallId),
    clientCallId: requireString(value.clientCallId),
    tableId: requireInteger(value.tableId, 1),
    tableNumberSnapshot: requireInteger(value.tableNumberSnapshot, 1),
    callType: requireString(value.callType),
    status: requireString(value.status),
    createdAtMs: requireInteger(value.createdAtMs),
    version: requireInteger(value.version, 1),
  };
  optionalInteger(call, 'resolvedAtMs', value.resolvedAtMs);
  return call;
}

function mapDependencyError(error) {
  if (!isCatalogRepositoryError(error) && !isEventRepositoryError(error)) {
    return serviceError(
      SNAPSHOT_ERROR_CODES.DATABASE_FAILURE,
      'Snapshot storage is unavailable.',
      { cause: error },
    );
  }

  const mappings = new Map([
    [CATALOG_ERROR_CODES.AUTHENTICATION_REQUIRED, SNAPSHOT_ERROR_CODES.AUTHENTICATION_REQUIRED],
    [CATALOG_ERROR_CODES.DEVICE_NOT_ACTIVE, SNAPSHOT_ERROR_CODES.DEVICE_NOT_ACTIVE],
    [CATALOG_ERROR_CODES.DEVICE_NOT_ASSIGNED, SNAPSHOT_ERROR_CODES.DEVICE_NOT_ASSIGNED],
    [CATALOG_ERROR_CODES.DEVICE_STATE_INCONSISTENT, SNAPSHOT_ERROR_CODES.DEVICE_STATE_INCONSISTENT],
    [CATALOG_ERROR_CODES.AUTHORIZATION_FAILED, SNAPSHOT_ERROR_CODES.AUTHORIZATION_FAILED],
    [EVENT_ERROR_CODES.EVENT_HISTORY_UNAVAILABLE, SNAPSHOT_ERROR_CODES.SNAPSHOT_UNAVAILABLE],
    [EVENT_ERROR_CODES.INVALID_EVENT_REQUEST, SNAPSHOT_ERROR_CODES.SNAPSHOT_UNAVAILABLE],
  ]);
  const mappedCode = mappings.get(error.code);
  if (mappedCode) return serviceError(mappedCode, 'Snapshot request could not be completed.');
  if (error.code === CATALOG_ERROR_CODES.DATABASE_FAILURE
    || error.code === EVENT_ERROR_CODES.DATABASE_FAILURE) {
    return serviceError(
      SNAPSHOT_ERROR_CODES.DATABASE_FAILURE,
      'Snapshot storage is unavailable.',
      { cause: error },
    );
  }
  return serviceError(
    SNAPSHOT_ERROR_CODES.DATABASE_FAILURE,
    'Snapshot storage is unavailable.',
    { cause: error },
  );
}

export function createSnapshotService({
  catalog,
  eventRepository,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
} = {}) {
  if (
    !catalog
    || typeof catalog.getDeviceSettings !== 'function'
    || typeof catalog.getMenuForPrincipal !== 'function'
    || !eventRepository
    || typeof eventRepository.getSnapshotOrders !== 'function'
    || !Number.isSafeInteger(maxAttempts)
    || maxAttempts < 1
    || maxAttempts > MAX_ATTEMPTS_LIMIT
  ) {
    throw serviceError(
      SNAPSHOT_ERROR_CODES.DATABASE_FAILURE,
      'Ready snapshot dependencies and a bounded retry count are required.',
    );
  }

  function getSnapshot(principal) {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      let deviceSource;
      let menuSource;
      let orderSource;
      try {
        deviceSource = catalog.getDeviceSettings(principal);
        menuSource = catalog.getMenuForPrincipal(principal);
        orderSource = eventRepository.getSnapshotOrders(principal);
      } catch (error) {
        throw mapDependencyError(error);
      }

      try {
        const deviceCursor = validateCursor(deviceSource);
        const menuCursor = validateCursor(menuSource);
        const orderCursor = validateCursor(orderSource);
        const role = requireString(deviceSource.role);
        if (
          !DEVICE_ROLES.includes(role)
          || menuSource.audience !== role
          || orderSource.audience !== role
          || deviceCursor.eventEpoch !== menuCursor.eventEpoch
          || deviceCursor.eventEpoch !== orderCursor.eventEpoch
          || deviceCursor.lastEventId !== menuCursor.lastEventId
          || deviceCursor.lastEventId !== orderCursor.lastEventId
        ) {
          continue;
        }

        const snapshot = {
          audience: role,
          eventEpoch: deviceCursor.eventEpoch,
          lastEventId: deviceCursor.lastEventId,
          device: projectDevice(role, deviceSource),
          menu: projectMenu(role, menuSource),
        };
        if (role === 'kitchen' || role === 'admin') {
          snapshot.activeOrders = requireArray(orderSource.activeOrders).map(projectOrder);
          snapshot.openStaffCalls = requireArray(orderSource.openStaffCalls).map(projectStaffCall);
          snapshot.openSessions = requireArray(orderSource.openSessions ?? []).map(projectOpenSession);
        }
        return deepFreeze(snapshot);
      } catch (error) {
        if (!(error instanceof InvalidSnapshotCandidate)) throw error;
      }
    }

    throw serviceError(
      SNAPSHOT_ERROR_CODES.SNAPSHOT_UNAVAILABLE,
      'A stable role-scoped snapshot is temporarily unavailable.',
    );
  }

  return Object.freeze({ getSnapshot });
}
