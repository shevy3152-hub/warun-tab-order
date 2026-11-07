export function customerMenuSelectionRoute(item) {
  if (!item || item.isSoldOut || item.orderingMode === "reservation_only") return "unavailable";
  if (item.categoryId === "sake") return item.variants?.length ? "sake" : "unavailable";
  if (item.servingOptions?.length) return "serving";
  if (item.quantitySelectionEnabled) return "quantity";
  return "direct";
}

const MEAL_SECTION_KEYS = new Set(["food", "winter"]);

export function isCustomerMealMenuItem(item, categories = []) {
  if (!item) return false;
  if (MEAL_SECTION_KEYS.has(item.sectionKey)) return true;
  return categories.some((category) => {
    if (MEAL_SECTION_KEYS.has(category.id) && Array.isArray(category.subcategories)) {
      return category.subcategories.some((subcategory) => subcategory.categoryIds?.includes(item.categoryId));
    }
    return category.id === item.categoryId && MEAL_SECTION_KEYS.has(category.sectionKey);
  });
}
