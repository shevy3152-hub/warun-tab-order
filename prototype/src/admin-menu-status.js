export function adminMenuAvailability(item) {
  if (item.isActive === false) return { label: "客席非表示", className: "is-inactive" };
  if (item.isSoldOut === true) return { label: "売り切れ", className: "is-soldout" };
  return { label: "販売中", className: "" };
}
