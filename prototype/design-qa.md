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

## 注文行キャンセル・取消し UI確認 2026-09-26

- 基準commit `04d072651a83c9f4be16aca5fa8df64417375f70`から作成した隔離worktreeのVite demo（`?demo=1#/kitchen`）を、1280×800と1637×602のCSS viewportで確認。架空注文／会計データのみを使用。
- 両サイズでテーブル別slot、展開中の席料・深夜チャージ・延長料金欄、会計操作、注文行ごとの単価／キャンセル操作、提供済み区分を確認。長い注文内容はテーブルslot内の縦スクロールで続けて確認できる。状態変更ボタンは押していない。
- 左レールの「注文・会計履歴」から履歴画面へ遷移することを確認。demo履歴レスポンスは空のため監査情報を含む実表示は未確認。注文snapshot／現在請求額／キャンセル・取消し操作者／時刻／理由のフィールドと表示は関連テストで補完。
- ブラウザー撮影出力は確認したが、ローカルPNGとしては保存していない。safe-copy、実DB、checkout、API書込み、会計操作は未使用。

visual result: isolated kitchen layout inspected at both target viewports; populated cancellation-history rendering remains unverified in browser.

## 厨房注文行の数量調整 UI 2026-09-26（過去の近似viewport記録）

- 商品名のキャンセル確認とは別に「単価と数量を編集」パネルを表示。請求対象数量の−／＋、注文時単価snapshot、現在単価、変更後行合計を確認した。理由欄は0点キャンセルの確認内に任意入力として表示し、通常のキャンセル理由も任意で保存する。
- これは当時の近似viewportによる予備確認記録である。1280×800 CSS viewportと1638×603でDOM geometryを測定し、後者は当時のviewport API制約により1637×602を直接指定できず、記録したPNGを各1px切り詰めた。次項の2026-09-27最終受入では1637×602を無加工で直接撮影しているため、この近似記録は最終判定に使用しない。数量・価格変更は画面上で実行せず、隔離DBテストで検証した。
- 操作なしの厨房画面と数量編集画面のPNG: `C:\Users\user\.codex\visualizations\2026\09\23\01a0ce57-ec42-7d03-a559-db26ed12f8db\kitchen-quantity-board-1280x800.png`、`...\kitchen-quantity-editor-1280x800.png`、`...\kitchen-quantity-board-1637x602.png`、`...\kitchen-quantity-editor-1637x602.png`。safe-copyと実DBは未使用。

visual result: DOM geometry confirms that quantity controls and price-save action fit at the measured CSS viewports; 1637×602 CSS viewport itself was approximated by 1638×603 due browser viewport API granularity.

## 注文キャンセル・数量操作 最終画面受入 2026-09-27

- 1280×800と1637×602のCSS viewport、100% browser zoomで各3状態（通常画面・数量編集・キャンセル確認）を確認。各viewportを直接指定してPNGを取得し、6枚とも切り抜き・リサイズなしで実寸を確認した。
- 1280×800: `C:\Users\user\AppData\Local\Temp\warun-price-ui-acceptance-ceaf-20260926-7d9fa221\normal-1280x800.png`、`...\quantity-1280x800.png`、`...\cancel-1280x800.png`。1637×602: `...\normal-1637x602.png`、`...\quantity-1637x602.png`、`...\cancel-1637x602.png`。
- 通常画面のテーブルslotと横スクロール、数量編集パネルの数量stepper・単価欄・保存操作、キャンセル確認の任意理由欄・金額・戻る／確定ボタンを目視。文字や主要操作の欠け、モーダル下端の切れは見られず、6状態すべてPASS。
- 架空demoデータのみを表示し、キャンセル・数量変更・注文送信は行っていない。ブラウザーとViteは停止済み。監査履歴が複数行ある状態のブラウザー表示は別途未確認で、関連するAPI／保存／lock動作は隔離テストで検証済み。

visual result: passed — six unmodified viewport captures at 1280×800 and 1637×602.

## 厨房左レール折り畳み・展開 2026-09-27

- 厨房画面の赤い左レールに開閉操作を追加。展開状態では従来どおり項目名を表示し、折り畳み状態でも厨房・履歴・設定／管理へ遷移可能。スタッフ呼出、通信状態、時刻も残し、アイコンにアクセシブル名を保持する。
- localhostの隔離previewで展開→折り畳み→再展開を実操作し、ナビゲーションとスタッフ情報へのアクセスが維持されることを確認した。取得できたブラウザー画像はそのまま目視した。会計・提供・キャンセル等の操作はしていない。
- 正確なCSS viewport overrideが利用できず、1280×800と1637×602での無加工スクリーンショット／見切れ確認は未達。キャプチャの切り抜き・リサイズで代替せず、画像ファイルとしても保存していない。従って本項目では両viewportの視覚受入をPASS扱いにしない。

visual result: partial — expand/collapse interaction and retained navigation/status verified in isolated preview; target viewport sizing and clipping acceptance remain unverified.

## 厨房左レール実幅修正・画面受入 2026-09-27

- 折り畳み時のgrid列とsidebarの実幅が後段の厨房grid規則により250pxのままだった不具合を修正。展開時250px、折り畳み時78px。main領域はx=250からx=78へ移動し、利用可能幅が172px増えることをブラウザー上の矩形で測定。
- 1280×800と1637×602のCSS viewportをPlaywrightで直接設定、DPR 1、`fullPage: false`のviewport PNGを取得。切り抜き・リサイズは行っていない。展開／折り畳みの4画像: `qa/kitchen-rail-width-fixed-expanded-1280x800.png`、`qa/kitchen-rail-width-fixed-collapsed-1280x800.png`、`qa/kitchen-rail-width-fixed-expanded-1637x602.png`、`qa/kitchen-rail-width-fixed-collapsed-1637x602.png`。PNG実寸も各指定サイズと一致。
- 折り畳み時も新着注文・履歴・設定／管理のナビ、通知数3、スタッフ呼出ボタン、通信状態アイコン、時計がレール内／viewport内に収まり、呼出パネルと履歴・管理遷移へアクセス可能。document/bodyの横overflowなし。厨房テーブル列の横スクロールは既存仕様どおり。
- 既存の `kitchen-rail-toggle-*` QA PNGは削除・上書きしていない。これらは実幅修正前の記録として保持し、最終の幅判定は本項の `-fixed-` PNGで行う。直前の部分受入記録は履歴として残し、本項で完了へ更新。
- 検証: `node --test tests/kitchen-order-board.test.mjs` 9/9、Vite build 4,585 modules、Sites build preparation、inline-client、Sites worker 4/4、`git diff --check` PASS。pnpm launcherはEPERMでbuild前に停止したため、既存Vite build／Sites scriptを隔離worktree内で実行。PlaywrightでAPI／外部要求4件を遮断。page errorなし。
- localhostの隔離previewは終了し、port 5197が閉じていることを確認。API、DB、schema、checkout、safe-copy、実環境、commit、pushは変更・実施していない。

visual result: passed — exact 1280×800 and 1637×602 CSS viewports, DPR 1; sidebar measured 250px expanded and 78px collapsed, with main content gaining 172px.

## 厨房スタッフ呼出のテーブル別通知 2026-09-27

- 隔離worktreeで厨房左レールのスタッフ呼出一覧とテーブル別ベルを確認。テーブル1・2・3の複数呼出を表示し、テーブル1カードのベルから1件だけ「対応完了」。他2卓の呼出は残り、注文／提供状態は変化しない。同じ卓の新規呼出を隔離fixtureへ追加すると、ベルと通知数へ再表示される。
- 折り畳み状態（実幅78px）でも通知数バッジが見え、スタッフ呼出を開くとテーブル1・2・3全件へ到達できる。展開幅は250px。両viewportでdocument横overflowなし。厨房カード列自体は既存の横スクロール仕様。
- CSS viewport 1280×800／1637×602、DPR 1、viewport直接撮影。PNGは切り抜き・リサイズなし、ファイル寸法一致。`prototype/qa/staff-calls-expanded-1280x800.png`、`staff-calls-collapsed-list-1280x800.png`、`staff-calls-expanded-1637x602.png`、`staff-calls-collapsed-list-1637x602.png`。
- 複数同時呼出・個別完了・再呼出後の表示はPASS。客席画面自体は隔離時にpairing画面となるため再呼出はstorage fixtureで作り、API接続を避けて厨房の反映を確認。API／外部通信遮断、page errorなし。`node --test tests/kitchen-order-board.test.mjs tests/sites-worker.test.mjs` 15/15。Sites package build PASS: 生成済み`dist/client`だけを再作成し、Vite build、Sites準備、inline-clientを各1回実行。index.htmlへのJS/CSS埋め込み、pairing bundle、font／画像、Worker／hosting出力を確認。前回inline後処理の失敗は古い生成HTMLを除去して解消した。隔離preview終了、5198閉鎖。
- DB・API・schema・safe-copy・既存の別worktree／PNGは変更なし。注文・会計操作、commit、pushなし。

visual result: passed — simultaneous per-table call indicators, single-call resolution, re-call visibility, and collapsed-rail list access at exact 1280×800 and 1637×602 CSS viewports; unmodified DPR 1 captures.

## 商品のテーブル別表示設定 UI 2026-10-06

- 管理画面の商品編集欄で「全テーブルに表示」「指定テーブルだけに表示」「指定テーブルだけで非表示」の3方式と複数テーブル選択を確認。文字・checkbox・配置の重なりや切れは見られなかった。demo画面のみで、保存やAPI接続は行っていない。
- browser viewport APIがdevice pixel寸法の整数指定のみを受け付け、環境DPRは0.5。1280×800 CSS viewportは640×400 device pixelsで確認。1637×602は1638×603 CSS viewport（819×301 device pixels）での近似確認となった。fullPage=false。
- 指定のDPR 1および厳密な1637×602 viewportでのスクリーンショットは取得できず、画面受入は未達。キャプチャ画像はセッション内表示のみでファイル保存していない。

visual result: partial — controls and clipping inspected in demo at 1280×800 and approximate 1638×603 CSS viewports; DPR 1 and exact 1637×602 capture requirements remain unmet.

## 商品のテーブル別表示・来店許可 利用者手動機能QA 2026-10-06

- 対象: 隔離worktree `codex/table-menu-visibility`、HEAD `f03fd0eea407b9be511b1c61fa532df6701abb19`、schema v19の使い捨てQA DB。下記は利用者による手動機能確認の報告で、画面viewport受入とは別記録。
- PASS: 指定テーブルだけに表示／指定テーブルだけで非表示。保存後に編集を開き直しても方式と対象テーブルが維持される。
- PASS: カート追加後に商品を非表示へ変更してもカート行を保持し、案内を表示して注文確定を停止。全テーブル表示へ戻すと、カート1点を保持したまま確定操作が再有効化される。
- PASS: 来店許可なしでは両客席に非表示。客席1へ来店許可すると客席1だけに表示。許可済みでもテーブル別非表示が適用され、テーブル別表示を戻すと客席1だけに再表示され、来店許可は維持される。
- 残件: 指定viewport 1280×800／1637×602、DPR 1、`fullPage=false`の画面QAは未達。客席2ではAPIの空カテゴリ応答とは別に、クライアントが静的な飲み物・お食事カテゴリーを表示する挙動があり、その扱いは未判定。いずれも本手動機能QAのPASSには含めず、全受入完了とはしない。
- 自動検証（実装時）: 関連serverテスト215/215、outbox 44/44、Sites 4/4、Vite build PASS、`git diff --check` PASS。
- QA runtime停止前の照合: health ready、schema 19、DB target other、runtime PIDとAPI/Web listener PID一致。runtime停止後は別途最終報告に停止確認を記録する。

functional result: passed — user-confirmed table visibility modes, cart blocking/recovery, and independent session-grant interaction; viewport acceptance and empty-category presentation remain open.

## 空カテゴリ修正・指定viewport画面QA追補 2026-10-06

- 空API応答時、客席クライアントが静的な下位カテゴリ一覧へfallbackする共通経路を確認した。QA DBの商品が1件だけだったためテーブル2のメニューカテゴリが空になったが、原因はQA専用表示ではなく、API categoriesが空の場合に全客席で使われるfallbackだった。API応答後は表示対象商品を持つカテゴリだけを出す要件に合わせ、空配列の場合は下位カテゴリを隠すよう最小修正した。
- 「飲み物」「お食事」など既存の大分類レール、固定操作「おかわり！」、APIカテゴリがまだないデモ時の静的fallbackは維持。大分類レールの表示は空API応答から商品や非表示商品を推測させる案内として追加したものではない。
- 関連テスト57/57、Sitesテスト4/4、直接Vite production build（4,587 modules）、Sites build preparation、inline-client生成、`git diff --check`はPASS。通常の`pnpm run build`は未承認esbuild build scriptの安全チェックでbuild前に停止し、承認設定は変更していない。記載のテスト／buildは今回の確認時の結果で、終了処理では再実行していない。
- 指定CSS viewport 1280×800／1637×602、DPR 1、`fullPage=false`の画面QAとPNG保存は未実施。管理編集欄・3方式・テーブル選択・保存ボタン、客席の表示差および注文不可カートの画面状態は未確認。Computer UseがWindows上のChrome URLを十分な確度で判定できず、ブラウザー操作を停止したため。既往の利用者手動機能QA PASSは前項に記録し、本画面QAの結果には含めない。
- 画面QA用の新規使い捨てruntimeはhealth/db ready、schema v19、environment `table-menu-qa`、database target `other`。DB: `C:\Users\user\AppData\Local\Temp\warun-table-menu-visibility-screen-20261006-16a81a048e8a4f2882ffb4470ea5dd8a\database\qa.sqlite3`。runtime PID 8956、API listener 52537、Web listener 52538はいずれも同一PIDとして照合した。照合後に起動wrapperのCtrl+C／SIGINT経路で今回のQAだけへ停止を送り、対象PIDの終了および両listener消失を確認した。停止後の終了コード表示は取得できなかった。QA DB・bundle・起動資材・登録リンクは保持。

visual result: incomplete — the empty-category fallback was corrected and automated checks passed, but neither exact viewport/DPR screen QA nor PNG capture was completed.

## 空カテゴリ修正後の利用者手動確認 2026-10-07

- 対象: `codex/table-menu-visibility`、HEAD `be43b5adae145190f33bc53d569ffc63583bce22`。下記は利用者による手動機能確認の報告。
- PASS: 「飲み物・お食事」の空の下位カテゴリは表示されない。
- PASS: 大分類と固定操作「おかわり！」は維持される。
- このPASSは上記2点の利用者手動確認のみ。指定CSS viewport 1280×800／1637×602、DPR 1、`fullPage=false`の画面QAおよびPNG取得は未実施のまま。利用可能なComputer Useのブラウザー画面ではviewport／DPRを指定できず、今回も画面QAは行っていない。
- 終了したQA runtime: schema v19、環境 `table-menu-qa`、DB target `other`。DB `C:\Users\user\AppData\Local\Temp\warun-table-menu-visibility-empty-category-20261007-a02\database\qa.sqlite3`、PID 12292、API listener 57355、Web listener 57356。起動launcher端末へCtrl+C（SIGINT）を送り、停止後にPID終了と両listener消失を確認した。launcherの停止完了markerは出力されなかったが、`run-server.mjs`のSIGINT処理はWeb/APIをcloseする実装であり、両listenerの終了を確認済み。
- QA DB・bundle・起動資材・登録情報を上記QA資材ディレクトリに保持。追加QA・テスト・build・実装・commit・pushは行っていない。

functional result: passed — user-confirmed empty subcategories are hidden while major categories and the fixed “おかわり！” action remain; exact viewport/DPR screen QA remains incomplete.

## 空session終了UI 利用者手動機能QA 2026-10-07

- 対象: 隔離worktree `codex/empty-session-close-ui`。この記録は利用者による管理画面の手動機能確認であり、画面viewportの受入記録とは分けて扱う。
- PASS: 「注文のない来店を終了」の確認ダイアログでキャンセルすると、来店と許可商品が残る。
- PASS: 同じ操作を確認すると終了成功が表示され、open sessionなし・許可商品なしへ画面が更新される。
- 確認は管理画面の上記2操作のみ。客席登録・注文・会計は操作していない。注文・会計記録は0件の架空QAデータを使用。
- 指定CSS viewport 1280×800／1637×602、DPR 1、`fullPage=false`の画面QAおよびPNG取得は未実施。この手動機能PASSをviewport／DPRの画面QA PASSとして扱わない。
- QA runtime停止前にhealth ready、schema v19、DB絶対パスとdatabase identity一致、runtime PID 17472、API listener 43721、Web listener 43722を照合。DB上もopen session 0・許可0、注文0・会計依頼0・会計記録0を確認した。
- 起動launcher `server/src/run-server.mjs` のSIGINT正常停止経路を、照合済みPID 17472だけに送り停止。停止後にPID終了とAPI／Web両listener消失を確認。使い捨てQA DB・bundle・起動／照合資材は `C:\Users\user\AppData\Local\Temp\warun-empty-session-close-ui-20261007-193536` に保持。
- 今回はQA記録の追記のみ。追加QA・実装・テスト・build・commit・pushは実施していない。safe-copy・実DB・A90・実注文・会計は操作していない。

functional result: passed — user-confirmed cancellation preserves the open visit and grant; confirmation closes the empty visit, clears the grant, and refreshes management state. Viewport/DPR screen QA remains unverified.

## 別テーブル再割当QAの受付照合・未検証記録 2026-10-07

- 利用者報告: 客席端末のテーブル1への登録は成功。
- QA DBの読み取り確認: 注文1件が2026-10-07 20:53:21 JSTに受付済み。テーブル1、`new`、注文明細1行・数量1点で、open sessionに紐づく。
- 利用者が送信待ちを保存した20:50〜20:51頃より受付時刻は後。保持ログ（runtime stdout/stderr）に`POST /v1/orders`の記録はなく、この注文が送信待ち操作と同一かは確認できない。今回の操作による受付かどうかは未確定。
- この記録では接続解除・再登録・コード発行を行っていない。未受付outboxが別テーブルへの再割当・再登録後に転送されないこと、元の内容とcontextを保ってスタッフ確認状態になることは未検証。今回をPASS扱いせず、過去の手動PASS記録は変更しない。
- QA資材: `C:\Users\user\AppData\Local\Temp\warun-table-reassign-qa-20261007-200411`。使い捨てDB、bundle、登録情報、起動資材は保持。
- 終了処理: health ready／schema v19、上記QA DB絶対パスとruntime PID 7828を再照合し、API 43861・Web 43862のlistener所有PIDも7828で一致。起動した`server/src/run-server.mjs`だけへ通常SIGINTを送り、PID終了と両listener消失を確認した。QA DB・bundle・登録情報・起動資材は保持。
## 注文前注意事項QA・再読み込み結果 2026-10-07

- 利用者手動確認PASS: 注意事項を確認してメニューへ進んだ後、再読み込みすると注意事項は再表示されず、メニューへ戻る。直前に未確認としていた最新画面動作を、この利用者結果で更新する。
- 管理者が文章を更新した後、同じ来店で再確認を強制しないことの手動確認は未実施。表示速度の実測および1280×800／1637×602、DPR 1、`fullPage=false`の画面QAも未実施。
- 遅い再読み込みの調査で、客席画面のテーマ・注意事項・来店状態がそれぞれ独立したSSE購読を作る実装と、ChromeからQA Web originへの6接続維持を確認。購読を1本へ共有する修正を反映し、関連テスト46/46、Vite build、Sites 4/4を確認。QA bundleはschema v20環境へ反映し、DB・登録情報を保持。
- QA runtime停止: PID 23188と使い捨てDB、Web 55262／API 55263のlistener所有PIDを照合。記録済みterminal sessionへのCtrl+Cを試したが、PIDと両listenerが残り、正常停止を確認できていない。強制終了は行っていない。QA資材・DB・登録情報は保持。
- 今回の利用者手動PASSは画面viewport／表示速度の受入や、管理者編集後の再確認に関するPASSを意味しない。
