const SHOCHU_SECTION_ORDER = Object.freeze({ "芋": 0, "麦・その他": 1 });

function shochuSectionRank(item) {
  return SHOCHU_SECTION_ORDER[item?.sectionKey] ?? 2;
}

export function compareMenuItems(a, b) {
  const orderDifference = (Number(a?.sortOrder) || 0) - (Number(b?.sortOrder) || 0);
  if (orderDifference !== 0) return orderDifference;
  if (a?.categoryId === "shochu" && b?.categoryId === "shochu") {
    const sectionDifference = shochuSectionRank(a) - shochuSectionRank(b);
    if (sectionDifference !== 0) return sectionDifference;
  }
  return String(a?.id ?? "").localeCompare(String(b?.id ?? ""), "ja");
}
