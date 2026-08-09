# Design QA

## Evidence

- Customer visual source: `../izakaya-preview.png`
- Kitchen visual source: `../design-kitchen-screen.png`
- Admin visual source: `../design-admin-screen.png`
- Normalized browser renders: `qa/customer-render.png`, `qa/kitchen-render.png`, `qa/admin-render.png`
- Same-input side-by-side comparisons: `qa/customer-comparison.png`, `qa/kitchen-comparison.png`, `qa/admin-comparison.png`
- Current kitchen acceptance image: `qa/kitchen-legibility-1280x800.png`
- Viewport and state: 1280 x 800 CSS px at 100% zoom; table 3 customer cart populated; kitchen tables 1, 4, and 5 with mixed served state; menu administration supports formal names and required kitchen aliases.

## Visual findings

- Customer: passed. The 328 px vermilion navigation rail, vertical Japanese title, five numbered recommended rows, price and sold-out treatments, four top actions, table 3 label, seven-line order summary, and fixed confirmation action match the source composition.
- Customer polish: passed. The vertical title is right-aligned with the source-like divider line, while the system label stays anchored at the upper-left of the red rail.
- Kitchen: passed. The vermilion staff rail, compact status header, large new-order title, three equal table cards, vertical item lists, check controls, totals, and horizontal-scroll affordance match the source hierarchy. Table 1 intentionally retains unserved items because the product rule moves a fully served table to history automatically.
- Admin: passed. The 272 px admin rail, large title/save header, 24/2 summary, add-menu action, image/category/name/price/status/order/action columns, and five representative rows match the supplied menu-management source.
- Color and typography: passed. Vermilion, warm paper, black rules, muted sold-out/served states, and bold Japanese gothic hierarchy remain consistent across all three screens.
- Asset and icon consistency: passed. Visible controls use one Phosphor icon family; the MVP keeps menu images as explicit “画像なし” slots.
- Layout integrity: passed. No clipped primary action, overlapping text, document-level overflow, or broken responsive state was found at the landscape tablet viewport.

## Interaction verification

- Customer item add: clicked `枝豆を追加`; order summary changed from 1 to 2 points.
- Customer confirmation: clicked `注文を確定する`; the confirmation dialog opened.
- Kitchen serve check: clicked an unserved table-4 item; it moved below the unserved list into the served section.
- Kitchen data density: verified table row counts of 4, 10, and 11 for tables 1, 4, and 5.
- Admin: verified formal-name and kitchen-alias registration, existing-value editing, newly added row display, and cleanup of the temporary verification row.
- Production build: `pnpm run build` completed successfully after the final visual pass.

## Accepted source-aware differences

- The customer rail uses a flat vermilion fill instead of the source’s subtle gradient; this keeps the current project token system intact while preserving the visual result.
- Customer menu photography remains out of scope; the supplied source also renders the ordering list without food photography.
- Kitchen table 1 is not shown as fully served in the live prototype because the agreed behavior immediately moves fully served tables to history.

final result: passed
