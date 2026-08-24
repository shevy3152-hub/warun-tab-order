# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## Product decisions for this prototype

- Optimize the core UI and every visual review for a 10-inch landscape tablet at an exact 1280 x 800 CSS viewport and 100% browser zoom. Use the supplied larger mockups only as visual references; never review the implementation at 1600 x 1000.
- Customer devices are fixed to tables 1 through 4 and never expose a table selector to guests.
- Customer menu cards show a derived tax-exclusive price with the tax-included master price. Customer carts and customer order history never show subtotals or totals.
- Kitchen order cards keep unserved items above served items and move an order to history immediately after its final item is checked.
- Payment, taxi booking, QR mirroring, menu imagery, sound, and completion animation remain outside this prototype.
- 客席の商品行は番号／画像／商品情報／価格／操作の固定列を基本とし、商品情報だけを可変幅にする。商品名の下は「タップで明細」を優先し、長い売り文句やフリガナは詳細画面へ置く。画像を表示しない商品は画像列・枠を描画せず、価格と操作の間隔と操作列の固定タップ領域を守る。
- 客席一覧画像は日本酒の既存表示と、明示設定または既存互換がある焼酎表示を維持し、その他カテゴリは一覧画像表示設定がONのときだけ表示する。商品画像URIと詳細画像URIは既存の分離構造を使い、文章を画像へ焼き込まない。
- Preserve the vermilion, warm-paper, black-rule, bold-Japanese visual language of the supplied izakaya reference.
- Keep the current kitchen layout and information structure; improve legibility by using heavy weights and high-contrast text instead of introducing a new visual concept.
- Use a heavy square-gothic Japanese typeface for all Japanese UI going forward; prefer BIZ UDPGothic and use weight 800-900 for operational text.
- Give the kitchen sidebar enough width to keep navigation readable, make each table panel correspondingly narrower, and use short staff-facing aliases for long menu names without changing the stored order-history name snapshots.
- Menu administration stores both a formal menu name and a required kitchen-facing alias. Customer ordering and order-history snapshots use the formal name; the kitchen screen prefers the alias.
- Do not use paid APIs, paid SaaS products, or designs that depend on a temporary free tier. Keep the production system self-hosted on the local network with open-source components wherever practical.
- Before starting any implementation or modification, tell the user the estimated work time and the scope covered by that estimate, then begin the work.
