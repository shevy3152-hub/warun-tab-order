export function buildKitchenTableGroups({ orders, sessions, menuItems, drinkCategoryIds, checkouts = [], staffCalls = [] }) {
  const activeOrders = orders.filter((order) => order.status === "new" || order.status === "active");
  const requestedCheckoutSessions = new Set(checkouts
    .filter((checkout) => checkout.status === "requested")
    .map((checkout) => checkout.tableSessionId));
  const completedCheckoutOrders = orders.filter((order) => order.status === "completed"
    && order.sessionId
    && requestedCheckoutSessions.has(order.sessionId));
  const cancelledCheckoutOrders = orders.filter((order) => order.status === "cancelled"
    && order.sessionId
    && requestedCheckoutSessions.has(order.sessionId));
  const boardOrders = [...activeOrders, ...completedCheckoutOrders, ...cancelledCheckoutOrders];
  const menuById = new Map(menuItems.map((item) => [item.id, item]));
  const activeCallsByTable = new Map();
  staffCalls.filter((call) => !call.resolvedAt).forEach((call) => {
    const tableId = String(call.tableId);
    const calls = activeCallsByTable.get(tableId) ?? [];
    calls.push(call);
    activeCallsByTable.set(tableId, calls);
  });
  const tableIds = new Set([
    ...boardOrders.map((order) => String(order.tableId)),
    ...sessions.map((session) => String(session.tableId)),
    ...activeCallsByTable.keys(),
  ]);

  const groups = [...tableIds].map((tableId) => {
    const tableOrders = boardOrders
      .filter((order) => String(order.tableId) === tableId)
      .map((order) => ({
        ...order,
        hasUnservedItems: order.items.some((item) => !item.isServed && !item.isCancelled),
        isDrinkOrder: order.items.some((item) => !item.isCancelled)
          && order.items.filter((item) => !item.isCancelled).every((item) => drinkCategoryIds.has(menuById.get(item.menuItemId)?.categoryId)),
      }))
      .sort((a, b) => Number(b.hasUnservedItems) - Number(a.hasUnservedItems)
        || Number(b.isDrinkOrder) - Number(a.isDrinkOrder)
        || new Date(b.createdAt) - new Date(a.createdAt));
    const session = sessions.find((candidate) => String(candidate.tableId) === tableId)
      ?? tableOrders.find((order) => order.sessionId);
    const tableCalls = activeCallsByTable.get(tableId) ?? [];
    const oldestOrder = [...tableOrders].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0];
    const hasRequestedCheckout = Boolean(session && requestedCheckoutSessions.has(session.sessionId));
    const oldestCallAt = tableCalls.map((call) => call.createdAt).filter(Boolean).sort()[0];
    const hasUnservedOrders = tableOrders.some((order) => order.hasUnservedItems);

    return {
      tableId,
      session,
      orders: tableOrders,
      staffCalls: tableCalls,
      hasActiveCalls: tableCalls.length > 0,
      hasRequestedCheckout,
      hasUnservedOrders,
      isCompletedSide: !hasUnservedOrders && !tableCalls.length,
      oldestActivityAt: oldestOrder?.createdAt ?? session?.openedAt ?? oldestCallAt ?? "",
    };
  });

  return groups.sort((a, b) => Number(b.hasRequestedCheckout) - Number(a.hasRequestedCheckout)
    || Number(a.isCompletedSide) - Number(b.isCompletedSide)
    || (a.isCompletedSide
      ? Number(a.tableId) - Number(b.tableId)
      : new Date(a.oldestActivityAt) - new Date(b.oldestActivityAt) || Number(a.tableId) - Number(b.tableId)));
}
