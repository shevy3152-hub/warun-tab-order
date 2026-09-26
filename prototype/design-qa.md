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

## 厨房レシート型テーブルスロット再調整 2026-09-25

- Source visual: `C:\Users\user\AppData\Local\Temp\codex-clipboard-33ff0370-cc6b-4853-ac59-22967692fe60.png`（縦型レシートをテーブルごとのスロットにして横並びにする概念図）。前回実装では会計欄を含むテーブル全体が縦積みになり、1卓が広い横幅を占めていた点をP1として修正した。
- Implementation evidence: Codex In-app Browserで隔離Vite preview（`http://127.0.0.1:5174/admin.html?demo=1#/kitchen`）を撮影。1280×800 CSS viewportは同寸clip、1637×602は整数CSS viewport 1638×603から同寸clip。スクリーンショットはブラウザー撮影出力としてこのタスクに添付され、ローカル画像ファイルとしては保存していない。
- Layout: 1卓=独立縦スクロールreceipt slot。1280幅では2卓、1637幅では3卓が同一横列に表示され、残りは横スクロールで到達する。2つの同時checkout（テーブル1・2）は先頭の別々のslotとして並ぶ。席料、深夜チャージ、延長料金は1人分・人数入力を含む欄を開いた状態で表示し、注文・会計履歴は下方向のページスクロールに残す。
- Functional/layout evidence: 1280×800でslot幅480px、1638×603で3列各436px。ページ横はみ出しなし。各checkout slotのreceiptは内側スクロール可能。個別スクロール後に会計操作ボタンと先頭の未提供注文行が画面内に入り、未提供行は提供済み行より先。別slotのスクロール状態は独立。ページ下スクロールで注文履歴・会計履歴へ到達可能。会計保存／確定／取消ボタンは押していない。
- Typography/spacing/colors/copy: 既存の角ゴ・高コントラスト赤／生成りを維持。checkout見出しや金額はレシート枠内で縦階層化。領収書希望表示は狭いslotで折り返すが、隣卓のスロットや会計操作と重ならない。画像素材は変更していない。
- Comparison history: 前回の全幅・縦積み構成をP1（複数卓の同時会計を一覧できない）として確認。修正後は横一列スロット、checkout依頼卓の優先配置、固定高さ＋独立縦スクロールに変更。2件同時checkout、縦型charge入力、未提供行、ページ横overflowなしのブラウザー証拠で解消を確認。
- Verification: prototype 131/131（Sites 4/4を含む）、Vite build 4,585 modules、Sites build準備とinline-client生成、`git diff --check`。schema v14・単価調整差分を保持。元のdirty worktree、安全copy、DB、checkout、remoteは変更なし。migration、commit、pushなし。

final result: passed

## Kitchen checkout-per-table redesign 2026-09-25

- Current screen source: user-provided 18:12 kitchen screenshot. Checkout-detail reference: user-provided `kaikeizi  1.jpg` (illustrative; checkout requests are rendered vertically within each table rather than as one horizontal strip). The blue X marks the kitchen logo and business hours as unwanted; staff call, connection state, and time remain on the red rail.
- Isolated implementation screenshots: `C:/Users/user/.codex/visualizations/2026/09/23/01a0ce57-ec42-7d03-a559-db26ed12f8db/kitchen-worktree-1280x800.png` and `.../kitchen-worktree-1637x602.png`. Captures use exact CSS viewport sizes and 100% zoom with fictional demo orders/checkouts only.
- Visual changes: reduced the new-order heading; removed the kitchen brand and hours from the sidebar; moved call/connectivity/time into that rail; replaced the horizontal checkout strip with a per-table vertical stack; put unserved items above served items with drinks first; made completed orders collapsible while checkout is requested; kept order and payment history below the table list in the page scroll.
- Layout QA: PASS at both target viewports. The first checkout's primary actions are within the initial viewport (bottom at 367 px for 1280×800; 344 px for 1637×602). The first two unserved rows fit completely (bottom at 481/539 px and 449/501 px respectively); served rows continue below and remain available by vertical page scroll. No horizontal content overflow. Checkout adjustment inputs are disclosed on demand; saved/preview total stays visible. Collapsed details were reopened successfully in demo mode. No checkout action was activated.
- Difference from the 18:12 source: the former shared horizontal checkout area and left-rail brand/hours are gone; each active checkout is now grouped immediately below its own table heading, so a table's order list follows its own checkout. The supplied `kaikeizi  1.jpg` informs that grouping and its show/hide affordance; it is not treated as a full-screen pixel mock.
- `prototype` tests 130/130, Sites tests 4/4, server tests 395/395, Vite production build (4,585 modules), Sites build preparation, inline-client generation, and `git diff --check` all pass. No migration, DB/API call, checkout operation, safe-copy change, commit, or push was performed. Worktree only; original dirty tree remains untouched.

final result: passed

## Kitchen realtime visibility and history routing 2026-09-25

- Before: the live kitchen route rendered order and payment history panels beneath the table slots and named the rail entry `提供済み（履歴）`. After: the live route is limited to the real-time horizontal table receipts; the rail entry is `注文・会計履歴` and opens the existing screen that contains both completed orders and payment records. Completed orders needed by an open checkout remain in that table receipt.
- The table row now fills the available height. To preserve live-order visibility without hiding checkout controls, per-table charge details start collapsed under the visible `追加料金合計／入力・編集` summary. Opening it exposes seat charge, late-night charge, and extension charge inputs. The added total and current order total remain visible; no fee or checkout value was edited.
- Exact 100% CSS viewport screenshots (DPR 1): `C:\Users\user\.codex\visualizations\2026\09\23\01a0ce57-ec42-7d03-a559-db26ed12f8db\kitchen-history-rail-1280x800.png` and `...\kitchen-history-rail-1637x602.png`. At 1280×800 the first two table slots are fully visible; at 1637×602 three full slots are visible, with further tables horizontally reachable. In both, checkout actions are entirely in-view and the first two unserved rows fit inside the active receipt. The document width equals the viewport width.
- Measured 1280×800: table 1's checkout actions end at y=379 and first two unserved rows end at y=490 / y=548. Measured 1637×602: table 1 actions end at y=367 and first two unserved rows at y=472 / y=524; table 2 actions end at y=405. The second table's served-only order can still be collapsed/reopened while its checkout remains visible.
- Comparison with the prior kitchen view: the lower history area no longer competes for height, and the empty lower space is now used by the independently scrollable table receipts. The image references show the final state; the code diff records removal of the previous lower history panels and change to the rail label. No checkout, payment, cancellation, or serving control was activated.
- Runtime route smoke: `注文・会計履歴` rendered one fictional completed session and one fictional payment card from intercepted, mocked responses; no error or loading state remained. No real API/DB history was read. The charge disclosure opened and exposed all three expected labels.
- Verification: prototype 131/131; Sites 4/4; direct Vite production build (4,585 modules); Sites build preparation; inline-client; `git diff --check`. No schema migration, DB/API write, safe-copy change, commit, or push.

final result: passed

## Checkout charge inputs open by default 2026-09-25

- User clarified that charge inputs should already be visible with an incoming checkout request, with collapsing as an option. This supersedes the prior collapsed-by-default decision.
- `追加料金合計／入力・編集` is expanded on initial render. The summary still collapses/reopens the fields; seat, late-night, and extension charges each expose the per-person amount, people count, and calculated row amount. Optional fee addition remains available without toggling the disclosure.
- Compact receipt layout keeps checkout actions and live orders visible at both exact CSS viewports. At 1280×800, both checkout action rows and table 1's first two unserved rows (y=447–563) are inside its receipt (y=108–741). At 1637×602, both active checkout action rows (y=343–383 and 382–422) and table 1's first two unserved rows (y=435–539) fit within the receipt (y=96–555); the second active table contains only served rows in this fictional fixture. No document-level horizontal overflow.
- Screenshots: `C:\Users\user\.codex\visualizations\2026\09\23\01a0ce57-ec42-7d03-a559-db26ed12f8db\kitchen-fees-always-open-1280x800.png` and `...\kitchen-fees-always-open-1637x602.png`. Built-in fictional demo checkouts/orders only; all requests outside local Vite 5174 were blocked and none occurred. Disclosure collapse/reopen and optional-fee row addition were verified in ephemeral page state; no checkout control was activated.
- Verification: prototype 131/131, Sites 4/4, Vite build (4,585 modules), Sites build preparation, inline-client generation. The pnpm launcher stopped on its ignored-esbuild-build-script safety check; the existing Vite binary and build scripts were run directly without approving or running that install script.
