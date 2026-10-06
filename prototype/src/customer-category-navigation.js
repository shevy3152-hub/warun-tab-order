const CUSTOMER_CATEGORY_RAILS = [
  { id: "drink", name: "飲み物" },
  { id: "food", name: "お食事" },
  { id: "winter", name: "冬季限定" },
  { id: "seasonal", name: "季節・気まぐれ" },
];

export function buildCustomerMajorCategories(categories, fallbackCategories) {
  if (!Array.isArray(categories)) return fallbackCategories;

  return CUSTOMER_CATEGORY_RAILS.map((rail) => {
    const subcategories = categories
      .filter((category) => category.sectionKey === rail.id)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.categoryId.localeCompare(b.categoryId, "ja"))
      .map((category) => ({ id: category.categoryId, name: category.name, categoryIds: [category.categoryId] }));
    const isPlaceholder = rail.id === "seasonal" && subcategories.length === 0;
    return {
      ...rail,
      name: isPlaceholder ? "" : rail.name,
      isPlaceholder,
      subcategories: [
        ...(rail.id === "drink" ? [{ id: "recommended", name: "おかわり！", categoryIds: [] }] : []),
        ...subcategories,
      ],
    };
  });
}
