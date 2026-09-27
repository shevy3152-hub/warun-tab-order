const BILLABLE_ORDER_STATUSES = Object.freeze(['new', 'active', 'completed']);

function valueFrom(row, camelName, snakeName) {
  return row[camelName] ?? row[snakeName];
}

export function orderItemAmounts(row) {
  const unitPriceYenSnapshot = Number(valueFrom(row, 'unitPriceYenSnapshot', 'unit_price_yen_snapshot'));
  const adjustedValue = valueFrom(row, 'adjustedUnitPriceYen', 'adjusted_unit_price_yen');
  const adjustedUnitPriceYen = adjustedValue == null ? null : Number(adjustedValue);
  const quantity = Number(row.quantity);
  const quantityReducedValue = valueFrom(row, 'quantityReduced', 'quantity_reduced');
  const quantityReduced = quantityReducedValue == null ? 0 : Number(quantityReducedValue);
  const billableQuantity = Math.max(0, quantity - quantityReduced);
  const currentUnitPriceYen = adjustedUnitPriceYen ?? unitPriceYenSnapshot;
  const snapshotLineTotalValue = row.lineTotalYenSnapshot
    ?? row.line_total_yen_snapshot
    ?? row.lineTotalYen
    ?? row.line_total_yen
    ?? unitPriceYenSnapshot * quantity;

  return {
    unitPriceYenSnapshot,
    adjustedUnitPriceYen,
    currentUnitPriceYen,
    quantity,
    quantityReduced,
    billableQuantity,
    lineTotalYenSnapshot: Number(snapshotLineTotalValue),
    lineTotalYen: currentUnitPriceYen * billableQuantity,
  };
}

export function isOrderItemCancelled(row) {
  return [row.isCancelled, row.is_cancelled].some((value) => value === true || value === 1);
}

export function sumCurrentOrderItemTotals(rows) {
  return rows.reduce((total, row) => (
    isOrderItemCancelled(row) ? total : total + orderItemAmounts(row).lineTotalYen
  ), 0);
}

export function createOrderPricingRepository(database) {
  const statusPlaceholders = BILLABLE_ORDER_STATUSES.map(() => '?').join(', ');
  const findSessionOrderItems = database.prepare(`
    SELECT
      o.order_id,
      o.accepted_at_ms,
      oi.order_item_id,
      oi.line_index,
      oi.menu_item_id,
      oi.formal_name_snapshot,
      oi.variant_id,
      oi.variant_name_snapshot,
      oi.variant_volume_snapshot,
      oi.temperature_snapshot,
      oi.serving_option_id,
      oi.serving_option_name_snapshot,
      oi.unit_price_yen_snapshot,
      oi.adjusted_unit_price_yen,
      oi.quantity,
      oi.quantity_reduced,
      oi.is_cancelled,
      oi.line_total_yen
    FROM orders AS o
    JOIN order_items AS oi ON oi.order_id = o.order_id
    WHERE o.session_id = ? AND o.status IN (${statusPlaceholders})
    ORDER BY o.accepted_at_ms, o.order_id, oi.line_index, oi.order_item_id
  `);

  function getSessionOrderItems(sessionId) {
    return findSessionOrderItems.all(sessionId, ...BILLABLE_ORDER_STATUSES)
      .filter((row) => !isOrderItemCancelled(row) && orderItemAmounts(row).billableQuantity > 0)
      .map((row) => {
        const amounts = orderItemAmounts(row);
        return {
          ...row,
          current_unit_price_yen: amounts.currentUnitPriceYen,
          quantity_reduced: amounts.quantityReduced,
          billable_quantity: amounts.billableQuantity,
          line_total_yen_snapshot: amounts.lineTotalYenSnapshot,
          line_total_yen: amounts.lineTotalYen,
        };
      });
  }

  return Object.freeze({
    getSessionOrderItems,
    getSessionTotalYen(sessionId) {
      return sumCurrentOrderItemTotals(getSessionOrderItems(sessionId));
    },
  });
}
