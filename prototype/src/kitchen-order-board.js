export function buildKitchenTableGroups({ orders, sessions, menuItems, drinkCategoryIds }) {
  const activeOrders = orders.filter((order) => order.status === "new" || order.status === "active");
  const menuById = new Map(menuItems.map((item) => [item.id, item]));
  const tableIds = new Set([
    ...activeOrders.map((order) => String(order.tableId)),
    ...sessions.map((session) => String(session.tableId)),
  ]);

  const groups = [...tableIds].map((tableId) => {
    const tableOrders = activeOrders
      .filter((order) => String(order.tableId) === tableId)
      .map((order) => ({
        ...order,
        hasUnservedItems: order.items.some((item) => !item.isServed),
        isDrinkOrder: order.items.length > 0 && order.items.every((item) => drinkCategoryIds.has(menuById.get(item.menuItemId)?.categoryId)),
      }))
      .sort((a, b) => Number(b.hasUnservedItems) - Number(a.hasUnservedItems)
        || Number(b.isDrinkOrder) - Number(a.isDrinkOrder)
        || new Date(b.createdAt) - new Date(a.createdAt));
    const session = sessions.find((candidate) => String(candidate.tableId) === tableId)
      ?? tableOrders.find((order) => order.sessionId);
    const oldestOrder = [...tableOrders].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0];

    return {
      tableId,
      session,
      orders: tableOrders,
      hasUnservedOrders: tableOrders.some((order) => order.hasUnservedItems),
      isCompletedSide: tableOrders.length === 0,
      oldestActivityAt: oldestOrder?.createdAt ?? session?.openedAt ?? "",
    };
  });

  return groups.sort((a, b) => Number(a.isCompletedSide) - Number(b.isCompletedSide)
    || (a.isCompletedSide
      ? Number(a.tableId) - Number(b.tableId)
      : new Date(a.oldestActivityAt) - new Date(b.oldestActivityAt) || Number(a.tableId) - Number(b.tableId)));
}
