import { HTTP_ERROR_CODES, createHttpError } from './http-errors.mjs';

const DEVICE_ROLES = new Set(['customer', 'kitchen', 'admin']);
const ORDER_STATUSES = new Set(['new', 'active', 'completed']);
const STAFF_CALL_STATUSES = new Set(['open', 'resolved']);
const EVENT_RESOURCES = new Set(['orders', 'menu', 'staffCalls', 'deviceConfig', 'businessHours', 'rideGuidance', 'checkout']);
const EVENT_TYPES_BY_ROLE = Object.freeze({
  customer: new Set([
    'order.created',
    'order.updated',
    'order.completed',
    'menu.updated',
    'menu.sold_out_updated',
    'staff_call.created',
    'staff_call.resolved',
    'device.revoked',
    'table.assignment_updated',
  ]),
  kitchen: new Set([
    'order.created',
    'order.updated',
    'order.completed',
    'menu.updated',
    'menu.sold_out_updated',
    'staff_call.created',
    'staff_call.resolved',
    'checkout.requested', 'checkout.adjustments_updated', 'checkout.ready', 'checkout.cancelled', 'checkout.paid', 'checkout.voided',
    'table.assignment_updated',
  ]),
  admin: new Set([
    'order.created',
    'order.updated',
    'order.completed',
    'menu.updated',
    'menu.sold_out_updated',
    'staff_call.created',
    'staff_call.resolved',
    'device.paired',
    'device.revoked',
    'business_hours.updated',
    'ride_guidance.pickup_updated', 'ride_guidance.contact_created',
    'ride_guidance.contact_updated', 'ride_guidance.contact_deleted',
    'ride_guidance.contacts_reordered',
    'checkout.requested', 'checkout.adjustments_updated', 'checkout.ready', 'checkout.cancelled', 'checkout.paid', 'checkout.voided',
    'table.assignment_updated',
  ]),
});
const SUPPORTED_SCHEMA_VERSION = 13;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function invalidDto() {
  return createHttpError(HTTP_ERROR_CODES.INTERNAL_ERROR);
}

function requireObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidDto();
  }
  return value;
}

function requireString(value) {
  if (typeof value !== 'string') throw invalidDto();
  return value;
}

function requireExactString(value, expected) {
  if (value !== expected) throw invalidDto();
  return value;
}

function requireOneOf(value, allowed) {
  if (typeof value !== 'string' || !allowed.has(value)) throw invalidDto();
  return value;
}

function requireOpaqueId(value) {
  if (typeof value !== 'string' || !OPAQUE_ID_PATTERN.test(value)) throw invalidDto();
  return value;
}

function requireUuid(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw invalidDto();
  return value;
}

function requireInteger(value, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw invalidDto();
  return value;
}

function requireBoolean(value) {
  if (typeof value !== 'boolean') throw invalidDto();
  return value;
}

function requireArray(value) {
  if (!Array.isArray(value)) throw invalidDto();
  return value;
}

function optionalImageUri(source, target) {
  if (Object.hasOwn(source, 'imageUri')) {
    target.imageUri = requireString(source.imageUri);
  }
  return target;
}

function optionalStringField(source, target, key) {
  if (Object.hasOwn(source, key)) target[key] = requireString(source[key]);
  return target;
}

function mapProductDetail(detail) {
  requireObject(detail);
  const response = { enabled: requireBoolean(detail.enabled) };
  for (const key of ['imageUri', 'reading', 'itemType', 'origin', 'producer', 'taste', 'aroma', 'sweetness', 'finish', 'recommendation', 'description']) {
    optionalStringField(detail, response, key);
  }
  if (Object.hasOwn(detail, 'showImageInList')) response.showImageInList = requireBoolean(detail.showImageInList);
  return response;
}

function mapImageLayouts(value) {
  if (!Object.hasOwn(value, 'imageLayouts')) return undefined;
  requireObject(value.imageLayouts);
  const response = {};
  for (const usage of ['thumbnail', 'detail']) {
    if (!Object.hasOwn(value.imageLayouts, usage)) throw invalidDto();
    const layout = requireObject(value.imageLayouts[usage]);
    const numbers = ['scale', 'positionX', 'positionY', 'rotation'];
    for (const key of numbers) if (typeof layout[key] !== 'number' || !Number.isFinite(layout[key])) throw invalidDto();
    if (layout.scale < 0.5 || layout.scale > 4 || layout.positionX < -1 || layout.positionX > 1 || layout.positionY < -1 || layout.positionY > 1 || layout.rotation < -15 || layout.rotation > 15) throw invalidDto();
    response[usage] = { scale: layout.scale, positionX: layout.positionX, positionY: layout.positionY, rotation: layout.rotation, fit: requireOneOf(layout.fit, new Set(['contain', 'cover'])) };
  }
  return response;
}

function mapMenuVariant(variant, admin = false) {
  requireObject(variant);
  const response = {
    variantId: requireOpaqueId(variant.variantId),
    name: requireString(variant.name),
    volumeLabel: requireString(variant.volumeLabel),
    priceYen: requireInteger(variant.priceYen),
    sortOrder: requireInteger(variant.sortOrder),
  };
  if (admin) {
    response.isActive = requireBoolean(variant.isActive);
    response.version = requireInteger(variant.version, 1);
  }
  if (Object.hasOwn(variant, 'temperatureOptions')) {
    const temperatures = requireArray(variant.temperatureOptions);
    if (temperatures.length === 0 || temperatures.some((temperature) => !['冷酒', '燗酒'].includes(temperature))) throw invalidDto();
    response.temperatureOptions = temperatures.map((temperature) => requireString(temperature));
  }
  return response;
}

function mapServingOption(option, admin = false) {
  requireObject(option);
  const response = {
    servingOptionId: requireOpaqueId(option.servingOptionId),
    name: requireString(option.name),
    sortOrder: requireInteger(option.sortOrder),
  };
  if (admin) {
    response.isActive = requireBoolean(option.isActive);
    response.version = requireInteger(option.version, 1);
  }
  return response;
}

function mapPublicCategory(category) {
  requireObject(category);
  const response = {
    categoryId: requireOpaqueId(category.categoryId),
    name: requireString(category.name),
    sortOrder: requireInteger(category.sortOrder),
  };
  if (Object.hasOwn(category, 'sectionKey')) response.sectionKey = requireOneOf(category.sectionKey, new Set(['drink', 'food', 'winter', 'seasonal']));
  return response;
}

function mapAdminCategory(category) {
  requireObject(category);
  const response = {
    categoryId: requireOpaqueId(category.categoryId),
    name: requireString(category.name),
    sortOrder: requireInteger(category.sortOrder),
    isVisible: requireBoolean(category.isVisible),
    version: requireInteger(category.version, 1),
    updatedAtMs: requireInteger(category.updatedAtMs),
  };
  if (Object.hasOwn(category, 'sectionKey')) response.sectionKey = requireOneOf(category.sectionKey, new Set(['drink', 'food', 'winter', 'seasonal']));
  return response;
}

function mapCustomerMenuItem(item) {
  requireObject(item);
  const response = optionalImageUri(item, {
    menuItemId: requireOpaqueId(item.menuItemId),
    categoryId: requireOpaqueId(item.categoryId),
    formalName: requireString(item.formalName),
    description: requireString(item.description),
    priceYen: requireInteger(item.priceYen),
    isSoldOut: requireBoolean(item.isSoldOut),
    orderingMode: requireOneOf(item.orderingMode ?? 'normal', new Set(['normal', 'reservation_only'])),
    sortOrder: requireInteger(item.sortOrder),
    version: requireInteger(item.version, 1),
    variants: requireArray(item.variants).map((variant) => mapMenuVariant(variant)),
    servingOptions: requireArray(item.servingOptions).map((option) => mapServingOption(option)),
  });
  optionalStringField(item, response, 'sectionKey');
  if (Object.hasOwn(item, 'detail')) response.detail = mapProductDetail(item.detail);
  const imageLayouts = mapImageLayouts(item);
  if (imageLayouts) response.imageLayouts = imageLayouts;
  return response;
}

function mapKitchenMenuItem(item) {
  requireObject(item);
  return {
    menuItemId: requireOpaqueId(item.menuItemId),
    categoryId: requireOpaqueId(item.categoryId),
    formalName: requireString(item.formalName),
    kitchenAlias: requireString(item.kitchenAlias),
    isSoldOut: requireBoolean(item.isSoldOut),
    sortOrder: requireInteger(item.sortOrder),
    version: requireInteger(item.version, 1),
  };
}

function mapAdminMenuItem(item) {
  requireObject(item);
  const response = optionalImageUri(item, {
    menuItemId: requireOpaqueId(item.menuItemId),
    categoryId: requireOpaqueId(item.categoryId),
    formalName: requireString(item.formalName),
    kitchenAlias: requireString(item.kitchenAlias),
    description: requireString(item.description),
    priceYen: requireInteger(item.priceYen),
    isSoldOut: requireBoolean(item.isSoldOut),
    orderingMode: requireOneOf(item.orderingMode ?? 'normal', new Set(['normal', 'reservation_only'])),
    isActive: requireBoolean(item.isActive),
    sortOrder: requireInteger(item.sortOrder),
    version: requireInteger(item.version, 1),
    updatedAtMs: requireInteger(item.updatedAtMs),
    detail: mapProductDetail(item.detail),
    variants: requireArray(item.variants).map((variant) => mapMenuVariant(variant, true)),
    servingOptions: requireArray(item.servingOptions).map((option) => mapServingOption(option, true)),
  });
  optionalStringField(item, response, 'sectionKey');
  const imageLayouts = mapImageLayouts(item);
  if (imageLayouts) response.imageLayouts = imageLayouts;
  return response;
}

function mapCursor(cursor) {
  requireObject(cursor);
  return {
    eventEpoch: requireUuid(cursor.eventEpoch),
    lastEventId: requireInteger(cursor.lastEventId),
  };
}

function requireSameCursor(value, cursor) {
  requireObject(value);
  if (value.eventEpoch !== cursor.eventEpoch || value.lastEventId !== cursor.lastEventId) {
    throw invalidDto();
  }
}

function mapStaffOrderItem(item) {
  requireObject(item);
  const response = {
    orderItemId: requireInteger(item.orderItemId, 1),
    formalNameSnapshot: requireString(item.formalNameSnapshot),
    kitchenAliasSnapshot: requireString(item.kitchenAliasSnapshot),
    unitPriceYenSnapshot: requireInteger(item.unitPriceYenSnapshot),
    quantity: requireInteger(item.quantity, 1),
    lineTotalYen: requireInteger(item.lineTotalYen),
    isServed: requireBoolean(item.isServed),
  };
  if (response.quantity > 99) throw invalidDto();
  if (Object.hasOwn(item, 'menuItemId')) {
    response.menuItemId = requireOpaqueId(item.menuItemId);
  }
  if (Object.hasOwn(item, 'servedAtMs') && item.servedAtMs !== null) {
    response.servedAtMs = requireInteger(item.servedAtMs);
  }
  for (const key of ['variantId', 'variantNameSnapshot', 'variantVolumeSnapshot', 'temperatureSnapshot', 'servingOptionId', 'servingOptionNameSnapshot']) {
    optionalStringField(item, response, key);
  }
  return response;
}

function mapStaffOrder(order) {
  requireObject(order);
  const items = requireArray(order.items);
  if (items.length === 0) throw invalidDto();
  const response = {
    orderId: requireUuid(order.orderId),
    clientOrderId: requireUuid(order.clientOrderId),
    tableId: requireInteger(order.tableId, 1),
    tableNumberSnapshot: requireInteger(order.tableNumberSnapshot, 1),
    status: requireOneOf(order.status, ORDER_STATUSES),
    totalAmountYen: requireInteger(order.totalAmountYen),
    acceptedAtMs: requireInteger(order.acceptedAtMs),
    version: requireInteger(order.version, 1),
    items: items.map(mapStaffOrderItem),
  };
  if (Object.hasOwn(order, 'sessionId')) response.sessionId = requireUuid(order.sessionId);
  if (Object.hasOwn(order, 'completedAtMs') && order.completedAtMs !== null) {
    response.completedAtMs = requireInteger(order.completedAtMs);
  }
  return response;
}

function mapCustomerOrderItem(item) {
  requireObject(item);
  const response = {
    orderItemId: requireInteger(item.orderItemId, 1),
    formalNameSnapshot: requireString(item.formalNameSnapshot),
    quantity: requireInteger(item.quantity, 1),
    isServed: requireBoolean(item.isServed),
  };
  if (response.quantity > 99) throw invalidDto();
  if (Object.hasOwn(item, 'menuItemId')) {
    response.menuItemId = requireOpaqueId(item.menuItemId);
  }
  if (Object.hasOwn(item, 'servedAtMs') && item.servedAtMs !== null) {
    response.servedAtMs = requireInteger(item.servedAtMs);
  }
  for (const key of ['variantId', 'variantNameSnapshot', 'variantVolumeSnapshot', 'temperatureSnapshot', 'servingOptionId', 'servingOptionNameSnapshot']) {
    optionalStringField(item, response, key);
  }
  return response;
}

function mapCustomerOrder(order) {
  requireObject(order);
  const items = requireArray(order.items);
  if (items.length === 0) throw invalidDto();
  const response = {
    orderId: requireUuid(order.orderId),
    clientOrderId: requireUuid(order.clientOrderId),
    tableNumberSnapshot: requireInteger(order.tableNumberSnapshot, 1),
    status: requireOneOf(order.status, ORDER_STATUSES),
    acceptedAtMs: requireInteger(order.acceptedAtMs),
    items: items.map(mapCustomerOrderItem),
  };
  if (Object.hasOwn(order, 'completedAtMs') && order.completedAtMs !== null) {
    response.completedAtMs = requireInteger(order.completedAtMs);
  }
  return response;
}

function mapStaffCall(call) {
  requireObject(call);
  const response = {
    staffCallId: requireUuid(call.staffCallId),
    clientCallId: requireUuid(call.clientCallId),
    tableId: requireInteger(call.tableId, 1),
    tableNumberSnapshot: requireInteger(call.tableNumberSnapshot, 1),
    callType: requireExactString(call.callType, 'staff'),
    status: requireOneOf(call.status, STAFF_CALL_STATUSES),
    createdAtMs: requireInteger(call.createdAtMs),
    version: requireInteger(call.version, 1),
  };
  if (Object.hasOwn(call, 'resolvedAtMs') && call.resolvedAtMs !== null) {
    response.resolvedAtMs = requireInteger(call.resolvedAtMs);
  }
  return response;
}

function mapOpenSession(session) {
  requireObject(session);
  return {
    sessionId: requireUuid(session.sessionId),
    tableId: requireInteger(session.tableId, 1),
    openedAtMs: requireInteger(session.openedAtMs),
    version: requireInteger(session.version, 1),
  };
}

function mapEvent(event, audience, eventEpoch, previousEventId, lastEventId) {
  requireObject(event);
  const eventId = requireInteger(event.eventId, 1);
  if (
    event.audience !== audience
    || event.eventEpoch !== eventEpoch
    || eventId <= previousEventId
    || eventId > lastEventId
  ) {
    throw invalidDto();
  }
  const payload = requireObject(event.payload);
  const type = requireOneOf(event.type, EVENT_TYPES_BY_ROLE[audience]);
  const expectedResource = type.startsWith('order.')
    ? 'orders'
    : type.startsWith('menu.')
      ? 'menu'
      : type.startsWith('staff_call.')
        ? 'staffCalls'
        : type === 'business_hours.updated'
          ? 'businessHours'
        : type.startsWith('ride_guidance.')
          ? 'rideGuidance'
          : type.startsWith('checkout.')
            ? 'checkout'
        : 'deviceConfig';
  const resource = requireOneOf(payload.resource, EVENT_RESOURCES);
  if (resource !== expectedResource || requireBoolean(payload.refreshRequired) !== true) {
    throw invalidDto();
  }
  return {
    audience,
    eventEpoch,
    eventId,
    type,
    aggregateId: requireOpaqueId(event.aggregateId),
    occurredAtMs: requireInteger(event.occurredAtMs),
    payload: {
      resource,
      refreshRequired: true,
    },
  };
}

export function mapDeviceConfigResponse(settings) {
  requireObject(settings);
  const eventCursor = mapCursor(settings);
  const role = requireString(settings.role);
  if (!DEVICE_ROLES.has(role)) throw invalidDto();

  const response = {
    deviceId: requireUuid(settings.deviceId),
    role,
    deviceLabel: requireString(settings.deviceLabel),
    status: requireExactString(settings.status, 'active'),
    configVersion: requireInteger(settings.configVersion, 1),
    eventEpoch: eventCursor.eventEpoch,
    lastEventId: eventCursor.lastEventId,
  };

  if (role === 'customer') {
    response.tableId = requireInteger(settings.tableId, 1);
    response.tableLabel = requireString(settings.tableLabel);
    response.tableIsActive = requireBoolean(settings.tableIsActive);
    if (!response.tableIsActive) throw invalidDto();
  }

  return response;
}

export function mapMenuResponse(menu) {
  requireObject(menu);
  const audience = requireString(menu.audience);
  const cursor = mapCursor(menu);
  const categoryRows = requireArray(menu.categories);
  const itemRows = requireArray(menu.items);

  if (audience === 'customer') {
    return {
      audience,
      eventEpoch: cursor.eventEpoch,
      lastEventId: cursor.lastEventId,
      categories: categoryRows.map(mapPublicCategory),
      items: itemRows.map(mapCustomerMenuItem),
    };
  }
  if (audience === 'kitchen') {
    return {
      audience,
      eventEpoch: cursor.eventEpoch,
      lastEventId: cursor.lastEventId,
      categories: categoryRows.map(mapPublicCategory),
      items: itemRows.map(mapKitchenMenuItem),
    };
  }
  if (audience === 'admin') {
    return {
      audience,
      eventEpoch: cursor.eventEpoch,
      lastEventId: cursor.lastEventId,
      categories: categoryRows.map(mapAdminCategory),
      items: itemRows.map(mapAdminMenuItem),
    };
  }

  throw invalidDto();
}

export function mapBusinessHoursResponse(settings, { includeVersion = false } = {}) {
  requireObject(settings);
  const response = {
    openTime: requireString(settings.openTime),
    closeTime: requireString(settings.closeTime),
    lastOrderTime: requireString(settings.lastOrderTime),
    isVisible: requireBoolean(settings.isVisible),
    noticeText: requireString(settings.noticeText),
    noticeEnabled: requireBoolean(settings.noticeEnabled),
    displayText: settings.displayText === null ? null : requireString(settings.displayText),
  };
  if (includeVersion) {
    response.version = requireInteger(settings.version);
    response.updatedAtMs = requireInteger(settings.updatedAtMs);
  }
  return response;
}

function mapRideGuidanceContact(contact, { admin = false } = {}) {
  const response = {
    id: requireOpaqueId(contact.id),
    type: requireOneOf(contact.type, new Set(['taxi', 'driver_service'])),
    name: requireString(contact.name),
    phone: requireString(contact.phone),
    note: requireString(contact.note ?? ''),
    sortOrder: requireInteger(contact.sortOrder),
  };
  if (admin) {
    response.isVisible = requireBoolean(contact.isVisible);
    response.version = requireInteger(contact.version);
    response.createdAtMs = requireInteger(contact.createdAtMs);
    response.updatedAtMs = requireInteger(contact.updatedAtMs);
  }
  return response;
}

export function mapRideGuidanceResponse(guidance, { includeHidden = false } = {}) {
  requireObject(guidance);
  const pickup = requireObject(guidance.pickup);
  const contacts = requireArray(guidance.contacts).map((contact) => mapRideGuidanceContact(contact, { admin: includeHidden }));
  const response = {
    pickup: {
      pickupLabel: requireString(pickup.pickupLabel),
      pickupAddress: requireString(pickup.pickupAddress),
    },
    contacts,
  };
  if (includeHidden) {
    response.pickup.version = requireInteger(pickup.version);
    response.pickup.updatedAtMs = requireInteger(pickup.updatedAtMs);
  }
  return response;
}

export function mapRideGuidanceWriteResponse(result) {
  requireObject(result);
  const response = {};
  if (Object.hasOwn(result, 'pickup')) response.pickup = mapRideGuidanceResponse({ pickup: result.pickup, contacts: [] }, { includeHidden: true }).pickup;
  if (Object.hasOwn(result, 'contact')) response.contact = mapRideGuidanceContact(result.contact, { admin: true });
  if (Object.hasOwn(result, 'contacts')) response.type = requireOneOf(result.type, new Set(['taxi', 'driver_service']));
  if (Object.hasOwn(result, 'contacts')) response.contacts = requireArray(result.contacts).map((contact) => mapRideGuidanceContact(contact, { admin: true }));
  if (Object.hasOwn(result, 'id')) response.id = requireOpaqueId(result.id);
  return response;
}

function mapCheckoutBase(request) {
  requireObject(request);
  return {
    checkoutRequestId: requireUuid(request.checkoutRequestId),
    status: requireOneOf(request.status, new Set(['requested', 'ready', 'cancelled'])),
    receiptRequested: requireBoolean(request.receiptRequested),
    version: requireInteger(request.version, 1),
    requestedAtMs: requireInteger(request.requestedAtMs),
    readyAtMs: request.readyAtMs === null ? null : requireInteger(request.readyAtMs),
  };
}

export function mapCheckoutPublicResponse(request) {
  const response = mapCheckoutBase(request);
  if (request.status === 'ready') response.grandTotalYen = requireInteger(request.grandTotalYen);
  return response;
}

export function mapCheckoutStaffResponse(request) {
  const response = mapCheckoutBase(request);
  response.tableSessionId = requireUuid(request.tableSessionId);
  response.orderedItemsTotalYen = requireInteger(request.orderedItemsTotalYen);
  response.adjustmentsTotalYen = requireInteger(request.adjustmentsTotalYen);
  response.grandTotalYen = request.grandTotalYen === null ? null : requireInteger(request.grandTotalYen);
  response.updatedAtMs = requireInteger(request.updatedAtMs);
  response.adjustments = requireArray(request.adjustments).map((adjustment) => ({
    adjustmentId: requireInteger(adjustment.adjustmentId, 1),
    checkoutRequestId: requireUuid(adjustment.checkoutRequestId),
    kind: requireString(adjustment.kind),
    label: requireString(adjustment.label),
    amountYen: requireInteger(adjustment.amountYen),
    sortOrder: requireInteger(adjustment.sortOrder),
  }));
  return response;
}

export function mapCheckoutStaffListResponse(requests) {
  return { checkouts: requireArray(requests).map(mapCheckoutStaffResponse) };
}

export function mapPaymentRecordResponse(record) {
  requireObject(record);
  return {
    paymentRecordId: requireUuid(record.paymentRecordId),
    checkoutRequestId: requireUuid(record.checkoutRequestId),
    tableSessionId: requireUuid(record.tableSessionId),
    tableId: requireInteger(record.tableId, 1),
    paymentMethod: requireOneOf(record.paymentMethod, new Set(['cash', 'card', 'qr', 'other'])),
    confirmedTotalYen: requireInteger(record.confirmedTotalYen),
    paidAtMs: requireInteger(record.paidAtMs),
    status: requireOneOf(record.status, new Set(['paid', 'voided'])),
    voidedAtMs: record.voidedAtMs === null ? null : requireInteger(record.voidedAtMs),
    voidReason: record.voidReason === null ? null : requireString(record.voidReason),
    version: requireInteger(record.version, 1),
    createdAtMs: requireInteger(record.createdAtMs),
    updatedAtMs: requireInteger(record.updatedAtMs),
    orderItems: requireArray(record.orderItems).map((item) => ({
      orderId: requireUuid(item.orderId),
      orderItemId: requireInteger(item.orderItemId, 1),
      formalNameSnapshot: requireString(item.formalNameSnapshot),
      variantNameSnapshot: item.variantNameSnapshot === null ? null : requireString(item.variantNameSnapshot),
      variantVolumeSnapshot: item.variantVolumeSnapshot === null ? null : requireString(item.variantVolumeSnapshot),
      temperatureSnapshot: item.temperatureSnapshot === null ? null : requireString(item.temperatureSnapshot),
      servingOptionNameSnapshot: item.servingOptionNameSnapshot === null ? null : requireString(item.servingOptionNameSnapshot),
      unitPriceYenSnapshot: requireInteger(item.unitPriceYenSnapshot),
      quantity: requireInteger(item.quantity, 1),
      lineTotalYen: requireInteger(item.lineTotalYen),
      sortOrder: requireInteger(item.sortOrder),
    })),
    adjustments: requireArray(record.adjustments).map((item) => ({
      kind: requireString(item.kind),
      label: requireString(item.label),
      amountYen: requireInteger(item.amountYen),
      sortOrder: requireInteger(item.sortOrder),
    })),
  };
}

export function mapPaymentRecordListResponse(records) {
  return { payments: requireArray(records).map(mapPaymentRecordResponse) };
}

export function mapCatalogWriteResponse(result) {
  requireObject(result);
  return {
    menuItemId: requireOpaqueId(result.menuItemId),
    version: requireInteger(result.version, 1),
    eventEpoch: requireUuid(result.event?.eventEpoch),
    eventId: requireInteger(result.event?.eventId, 1),
  };
}

export function mapCategoryWriteResponse(result) {
  requireObject(result);
  return {
    categoryId: requireOpaqueId(result.categoryId),
    version: requireInteger(result.version, 1),
    eventEpoch: requireUuid(result.event?.eventEpoch),
    eventId: requireInteger(result.event?.eventId, 1),
  };
}

export function mapMenuOrderingWriteResponse(result) {
  requireObject(result);
  return {
    categoryId: requireOpaqueId(result.categoryId),
    version: requireInteger(result.version, 1),
    menuItemIds: requireArray(result.menuItemIds).map(requireOpaqueId),
    eventEpoch: requireUuid(result.event?.eventEpoch),
    eventId: requireInteger(result.event?.eventId, 1),
  };
}

function mapPairingTable(table) {
  requireObject(table);
  const response = {
    tableId: requireInteger(table.tableId, 1),
    label: requireString(table.label),
  };
  if (Object.hasOwn(table, 'deviceId')) response.deviceId = requireUuid(table.deviceId);
  if (Object.hasOwn(table, 'deviceDisplayName')) response.deviceDisplayName = requireString(table.deviceDisplayName);
  if (Object.hasOwn(table, 'deviceStatus')) response.deviceStatus = requireString(table.deviceStatus);
  return response;
}

export function mapPairingPreflightResponse({ runtimeInfo, tables, requestOrigin = '' } = {}) {
  requireObject(runtimeInfo);
  requireObject(tables);
  const available = requireArray(tables.available).map(mapPairingTable);
  const assigned = requireArray(tables.assigned).map(mapPairingTable);
  const databaseTarget = requireOneOf(runtimeInfo.databaseTarget, new Set(['safe-copy', 'production', 'other', 'unknown']));
  const isProduction = requireBoolean(runtimeInfo.isProduction);
  const webOrigins = requireArray(runtimeInfo.webOrigins).map(requireString);
  const webOriginMatches = requestOrigin === '' || webOrigins.includes(requestOrigin);
  let blockedReason = null;
  if (databaseTarget !== 'safe-copy' || isProduction) blockedReason = 'SAFE_COPY_MISMATCH';
  else if (!webOriginMatches) blockedReason = 'WEB_API_URL_MISMATCH';
  else if (available.length === 0) blockedReason = 'NO_AVAILABLE_TABLE';
  return {
    authentication: { status: 'valid', role: 'admin' },
    database: {
      path: requireString(runtimeInfo.databasePath),
      target: databaseTarget,
      isProduction,
      environment: requireString(runtimeInfo.environment),
    },
    server: {
      apiPort: requireInteger(runtimeInfo.apiPort, 1),
      webPort: requireInteger(runtimeInfo.webPort, 1),
      lanIPv4: requireArray(runtimeInfo.lanIPv4).map(requireString),
      webOrigins,
      requestedOrigin: requireString(requestOrigin),
      webOriginMatches,
      apiBasePath: '/v1',
      pairingUrlOrigin: requireString(runtimeInfo.pairingUrlOrigin),
      pairingUrlTemplate: requireString(runtimeInfo.pairingUrlTemplate),
    },
    tables: { available, assigned },
    pairing: {
      canIssue: blockedReason === null,
      blockedReason,
    },
  };
}

export function mapOrderReceiptResponse(result) {
  requireObject(result);
  const idempotencyResult = requireOneOf(
    result.idempotencyResult,
    new Set(['created', 'replayed']),
  );
  const order = requireObject(result.order);
  return {
    orderId: requireUuid(order.orderId),
    clientOrderId: requireUuid(order.clientOrderId),
    status: requireOneOf(order.status, ORDER_STATUSES),
    acceptedAtMs: requireInteger(order.acceptedAtMs),
    idempotencyResult,
  };
}

export function mapOrderHistoryResponse(orders) {
  if (!Array.isArray(orders)) throw invalidDto();
  return { orders: orders.map(mapStaffOrder) };
}

export function mapTableSessionCloseResponse(result) {
  requireObject(result);
  return {
    tableId: requireInteger(result.tableId, 1),
    sessionId: requireUuid(result.sessionId),
    closedAtMs: requireInteger(result.closedAtMs),
    idempotencyResult: requireOneOf(result.idempotencyResult, new Set(['created', 'replayed'])),
  };
}

export function mapCustomerOrderHistoryResponse(orders) {
  if (!Array.isArray(orders)) throw invalidDto();
  return { orders: orders.map(mapCustomerOrder) };
}

export function mapEventReplayResponse(replay) {
  requireObject(replay);
  const audience = requireOneOf(replay.audience, DEVICE_ROLES);
  const eventEpoch = requireUuid(replay.eventEpoch);
  const lastEventId = requireInteger(replay.lastEventId);
  const eventRows = requireArray(replay.events);
  const events = [];
  let previousEventId = 0;
  for (const event of eventRows) {
    const mapped = mapEvent(event, audience, eventEpoch, previousEventId, lastEventId);
    events.push(mapped);
    previousEventId = mapped.eventId;
  }
  return {
    audience,
    eventEpoch,
    events,
    lastEventId,
    hasMore: requireBoolean(replay.hasMore),
  };
}

export function mapSnapshotResponse(snapshot) {
  requireObject(snapshot);
  const audience = requireOneOf(snapshot.audience, DEVICE_ROLES);
  const cursor = mapCursor(snapshot);
  const device = mapDeviceConfigResponse(snapshot.device);
  const menu = mapMenuResponse(snapshot.menu);
  if (device.role !== audience || menu.audience !== audience) throw invalidDto();
  requireSameCursor(device, cursor);
  requireSameCursor(menu, cursor);

  const response = {
    audience,
    eventEpoch: cursor.eventEpoch,
    lastEventId: cursor.lastEventId,
    device,
    menu,
  };
  if (audience === 'kitchen' || audience === 'admin') {
    response.activeOrders = requireArray(snapshot.activeOrders).map(mapStaffOrder);
    response.openStaffCalls = requireArray(snapshot.openStaffCalls).map(mapStaffCall);
    if (Object.hasOwn(snapshot, 'openSessions')) {
      response.openSessions = requireArray(snapshot.openSessions).map(mapOpenSession);
    }
  }
  return response;
}

export function createEventHistoryUnavailableResponse(error, requestId, recoveryCursor) {
  requireObject(error);
  if (error.code !== HTTP_ERROR_CODES.EVENT_HISTORY_UNAVAILABLE) throw invalidDto();
  const cursor = mapCursor(recoveryCursor);
  return {
    error: {
      code: HTTP_ERROR_CODES.EVENT_HISTORY_UNAVAILABLE,
      message: 'Event history is unavailable.',
    },
    requestId: requireUuid(requestId),
    recovery: {
      strategy: 'snapshot',
      snapshotUrl: '/v1/snapshot',
      currentEventEpoch: cursor.eventEpoch,
      lastEventId: cursor.lastEventId,
    },
  };
}

export function mapHealthResponse(serviceState, serverTimeMs) {
  requireObject(serviceState);
  const schemaVersion = requireInteger(serviceState.schemaVersion, 1);
  if (schemaVersion !== SUPPORTED_SCHEMA_VERSION) throw invalidDto();
  return {
    status: 'ready',
    db: 'ready',
    serverTimeMs: requireInteger(serverTimeMs),
    schemaVersion,
    eventEpoch: requireUuid(serviceState.eventEpoch),
  };
}

export function createErrorResponse(error, requestId) {
  return {
    error: {
      code: error.code,
      message: error.publicMessage,
    },
    requestId: requireUuid(requestId),
  };
}

export function writeJsonResponse(
  response,
  {
    statusCode,
    body,
    requestId,
    headers = undefined,
    omitBody = false,
  },
) {
  const json = JSON.stringify(body);
  const baseHeaders = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Request-Id': requireUuid(requestId),
    'Content-Length': Buffer.byteLength(json, 'utf8'),
  };
  response.writeHead(statusCode, { ...baseHeaders, ...headers });
  response.end(omitBody ? undefined : json);
}
