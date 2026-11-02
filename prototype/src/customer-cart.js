export function customerCartItemSnapshot(item) {
  return {
    name: item.name,
    baseName: item.baseName ?? item.name,
    categoryId: item.categoryId,
  };
}

export function customerCartSelectionKey(item, selection = {}) {
  const menuItemId = item.menuItemId ?? item.id;
  return `${menuItemId}::${selection.variant?.variantId ?? ""}::${selection.servingOption?.servingOptionId ?? ""}::${selection.temperature ?? ""}`;
}

export function addCustomerCartSelection(cart, item, selection, quantity) {
  const menuItemId = item.menuItemId ?? item.id;
  const key = customerCartSelectionKey(item, selection);
  const currentRow = cart[key];
  const quantitySelectionEnabled = item.quantitySelectionEnabled === true;
  return {
    ...cart,
    [key]: {
      menuItemId,
      variant: selection.variant,
      temperature: selection.temperature,
      servingOption: selection.servingOption,
      displaySnapshot: currentRow?.displaySnapshot ?? customerCartItemSnapshot(item),
      unitPriceYenSnapshot: currentRow?.unitPriceYenSnapshot ?? (selection.variant?.priceYen ?? item.price),
      quantitySelectionEnabledSnapshot: currentRow?.quantitySelectionEnabledSnapshot ?? quantitySelectionEnabled,
      quantityUnitLabelSnapshot: currentRow?.quantityUnitLabelSnapshot ?? (item.quantityUnitLabel ?? "点"),
      quantity: (currentRow?.quantity ?? 0) + quantity,
    },
  };
}

export function customerCartRows(cart, menuItems) {
  return Object.entries(cart).map(([key, selection]) => {
    const currentItem = menuItems.find((menu) => menu.id === selection.menuItemId);
    const displaySnapshot = selection.displaySnapshot;
    const item = currentItem ?? (displaySnapshot ? {
      id: selection.menuItemId,
      menuItemId: selection.menuItemId,
      name: displaySnapshot.name,
      baseName: displaySnapshot.baseName,
      categoryId: displaySnapshot.categoryId,
      price: 0,
      variants: [],
      servingOptions: [],
      quantitySelectionEnabled: selection.quantitySelectionEnabledSnapshot === true,
      quantityUnitLabel: selection.quantityUnitLabelSnapshot,
    } : null);
    const currentVariant = currentItem && selection.variant?.variantId
      ? currentItem.variants?.find((variant) => variant.variantId === selection.variant.variantId)
      : null;
    const currentUnitPrice = currentVariant?.priceYen ?? currentItem?.price;
    const quantityEnabledNow = currentItem?.quantitySelectionEnabled === true;
    const hasRequiredPriceSnapshot = selection.unitPriceYenSnapshot !== undefined && selection.unitPriceYenSnapshot !== null;
    const currentMinimum = currentItem?.minimumQuantity ?? 1;
    const currentStep = currentItem?.quantityStep ?? 1;
    const quantityConfigurationStale = Boolean(currentItem && (
      (Object.hasOwn(selection, "quantitySelectionEnabledSnapshot")
        && selection.quantitySelectionEnabledSnapshot !== quantityEnabledNow)
      || ((quantityEnabledNow || currentItem.priceAssertionRequired === true)
        && (!hasRequiredPriceSnapshot
          || selection.unitPriceYenSnapshot !== currentUnitPrice
          || selection.quantityUnitLabelSnapshot !== (currentItem.quantityUnitLabel ?? "点")))
      || (quantityEnabledNow
        && (selection.quantity < currentMinimum || (selection.quantity - currentMinimum) % currentStep !== 0))
    ));
    return {
      key,
      ...selection,
      item,
      unavailable: !currentItem || currentItem.isSoldOut === true,
      quantityConfigurationStale,
    };
  }).filter((row) => row.item && row.quantity > 0);
}

export function removeCustomerCartSelection(cart, key) {
  const next = { ...cart };
  delete next[key];
  return next;
}

export function customerCartDecrementAction(row) {
  const item = row?.item;
  const quantitySelectionEnabled = item?.quantitySelectionEnabled === true;
  const minimumQuantity = quantitySelectionEnabled ? (item.minimumQuantity ?? 1) : 1;
  const quantityStep = quantitySelectionEnabled ? (item.quantityStep ?? 1) : 1;
  const nextQuantity = Number(row?.quantity) - quantityStep;
  return {
    kind: !Number.isInteger(nextQuantity) || nextQuantity < minimumQuantity
      || (nextQuantity - minimumQuantity) % quantityStep !== 0 ? "remove" : "decrement",
    quantityStep,
    unitLabel: row?.quantityUnitLabelSnapshot ?? item?.quantityUnitLabel ?? "点",
  };
}

export function decrementCustomerCartSelection(cart, key, item) {
  const selection = cart[key];
  if (!selection) return cart;
  const action = customerCartDecrementAction({ ...selection, item });
  if (action.kind === "remove") return removeCustomerCartSelection(cart, key);
  return { ...cart, [key]: { ...selection, quantity: selection.quantity - action.quantityStep } };
}
