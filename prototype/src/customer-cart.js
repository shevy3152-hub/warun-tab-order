export function customerCartItemSnapshot(item) {
  return {
    name: item.name,
    baseName: item.baseName ?? item.name,
    categoryId: item.categoryId,
  };
}

export function addCustomerCartSelection(cart, item, selection, quantity) {
  const menuItemId = item.menuItemId ?? item.id;
  const key = `${menuItemId}::${selection.variant?.variantId ?? ""}::${selection.servingOption?.servingOptionId ?? ""}::${selection.temperature ?? ""}`;
  const currentRow = cart[key];
  return {
    ...cart,
    [key]: {
      menuItemId,
      variant: selection.variant,
      temperature: selection.temperature,
      servingOption: selection.servingOption,
      displaySnapshot: currentRow?.displaySnapshot ?? customerCartItemSnapshot(item),
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
    } : null);
    return {
      key,
      ...selection,
      item,
      unavailable: !currentItem || currentItem.isSoldOut === true,
    };
  }).filter((row) => row.item && row.quantity > 0);
}

export function removeCustomerCartSelection(cart, key) {
  const next = { ...cart };
  delete next[key];
  return next;
}
