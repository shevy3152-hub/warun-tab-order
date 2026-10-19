import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CUSTOMER_THEMES, CUSTOMER_TEST_THEME, normalizeCustomerTheme } from "../src/customer-theme.js";
import { adminMenuAvailability } from "../src/admin-menu-status.js";
import { compareMenuItems } from "../src/menu-ordering.js";
import { CUSTOMER_THEME_DEFINITIONS, isAvailableCustomerTheme } from "../../shared/customer-theme-definitions.mjs";
import { MIN_CUSTOMER_THEME_ZOOM, customerThemeImageLayout, customerThemeImageMinimumZoom, customerThemePositionAfterDrag, customerThemeStoredZoomForVisualZoom, normalizeCustomerThemeLayout, resolveCustomerThemeZoom } from "../src/customer-theme-layout.js";

const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const customerScreen = appSource.slice(appSource.indexOf("function CustomerScreen"), appSource.indexOf("const staffNavItems"));
const visitConfigRefreshSource = await readFile(new URL("../src/customer-visit-config-refresh.js", import.meta.url), "utf8");
const staffCallSource = await readFile(new URL("../src/customer-staff-call.js", import.meta.url), "utf8");

test("CustomerScreen renders menu prices but no cart or customer-history totals", () => {
  assert.match(customerScreen, /PriceDisplay/);
  assert.match(appSource, /taxExcludedYen/);
  assert.doesNotMatch(customerScreen, /totalAmount.*yen\(|yen\(.*totalAmount/);
  assert.match(customerScreen, /price-hidden-note/);
  const cartPanel = customerScreen.slice(customerScreen.indexOf('<aside className="cart-panel">'), customerScreen.indexOf('</aside>', customerScreen.indexOf('<aside className="cart-panel">')));
  assert.doesNotMatch(cartPanel, /menu-price|totalAmount|合計/);
});

test("CustomerScreen exposes a normalized rail theme with camellia as the active test theme", () => {
  assert.deepEqual(CUSTOMER_THEMES, { standard: "standard", camellia: "camellia", "autumn-leaves": "autumn-leaves", "moon-susuki": "moon-susuki", "japanese-halloween": "japanese-halloween" });
  assert.equal(CUSTOMER_TEST_THEME, "camellia");
  assert.equal(normalizeCustomerTheme("unknown"), "standard");
  assert.equal(normalizeCustomerTheme("standard"), "standard");
  assert.equal(normalizeCustomerTheme("camellia"), "camellia");
  assert.equal(normalizeCustomerTheme("autumn-leaves"), "autumn-leaves");
  assert.equal(isAvailableCustomerTheme("camellia"), true);
  assert.equal(isAvailableCustomerTheme("autumn-leaves"), true);
  assert.equal(isAvailableCustomerTheme("moon-susuki"), true);
  assert.equal(isAvailableCustomerTheme("japanese-halloween"), true);
  assert.match(appSource, /normalizeCustomerTheme\(theme\)/);
  assert.match(customerScreen, /data-customer-theme=\{visibleCustomerTheme\}/);
});

test("seasonal customer rail themes point to the supplied original-size PNG assets", async () => {
  const expected = {
    "autumn-leaves": [1008, 1561],
    "moon-susuki": [1007, 1561],
    "japanese-halloween": [803, 2018],
  };
  for (const [theme, [width, height]] of Object.entries(expected)) {
    const assetPath = CUSTOMER_THEME_DEFINITIONS[theme].assetPath;
    assert.ok(assetPath);
    const bytes = await readFile(new URL(`../public${assetPath}`, import.meta.url));
    assert.equal(bytes.toString("ascii", 1, 4), "PNG");
    assert.equal(bytes.readUInt32BE(16), width);
    assert.equal(bytes.readUInt32BE(20), height);
  }
});

test("Customer rail keeps standard red as the safe fallback and scopes camellia imagery", () => {
  assert.match(styles, /\.customer-sidebar \{[^}]*background: var\(--customer-theme-rail-background, var\(--red\)\);/);
  assert.match(styles, /\.customer-theme-option__preview \{[^}]*object-fit: cover/);
  assert.match(customerScreen, /customerThemeAssetPath && visibleCustomerTheme === customerTheme \? <CustomerThemeImage/);
  assert.match(appSource, /function CustomerThemeImage[\s\S]*customerThemeImageLayout/);
  assert.match(appSource, /function CustomerThemePreview[\s\S]*<CustomerThemeImage/);
  assert.match(appSource, /disabled={!available}/);
  assert.match(appSource, /画像未配置・テーマ選択不可/);
  assert.match(appSource, /onError=\{\(\) => setCustomerThemeImageFailed\(true\)\}/);
  assert.match(styles, /\.customer-app--category-collapsed \.customer-sidebar \{ background: var\(--red\); padding: 18px 10px; \}/);
  assert.doesNotMatch(styles, /customer-sidebar::before|customer-sidebar::after|customer-sidebar \{ background: var\(--red\) url/);
  const standardRailRule = styles.match(/\.customer-sidebar \{[^}]*\}/)?.[0] ?? "";
  assert.doesNotMatch(standardRailRule, /customer-rail-washi-camellia/);
});

test("Japanese Halloween palette is theme-scoped and returns to the original rail palette when collapsed or unavailable", () => {
  const palette = CUSTOMER_THEME_DEFINITIONS["japanese-halloween"].railPalette;
  assert.equal(palette.background, "#f3eadb");
  assert.equal(palette.foreground, "#482c1d");
  assert.equal(CUSTOMER_THEME_DEFINITIONS.standard.railPalette, undefined);
  assert.equal(CUSTOMER_THEME_DEFINITIONS.camellia.railPalette, undefined);
  assert.equal(CUSTOMER_THEME_DEFINITIONS["autumn-leaves"].railPalette, undefined);
  assert.equal(CUSTOMER_THEME_DEFINITIONS["moon-susuki"].railPalette, undefined);
  assert.match(appSource, /customerThemePaletteStyle\(visibleCustomerTheme\)/);
  assert.ok(appSource.includes('customerThemePaletteStyle(imageFailed || !themeAvailable ? "standard" : theme)'));
  assert.ok(styles.includes('.customer-app[data-customer-theme="japanese-halloween"]:not(.customer-app--category-collapsed) .customer-sidebar'));
  assert.ok(styles.includes('.category-nav button.is-active { background: var(--customer-theme-rail-selected-background)'));
  assert.ok(styles.includes('button:focus-visible { outline: 3px solid var(--customer-theme-rail-focus)'));
  assert.ok(styles.includes('.customer-theme-preview__rail[data-customer-theme="japanese-halloween"]:not(.is-collapsed)'));
  assert.match(appSource, /customer-hours\$\{guideKey \? " customer-theme-preview__hours"/);
  assert.match(appSource, /style=\{guideKey \? \{ color: "var\(--customer-theme-rail-foreground, #fff\)"/);
});

test("API customer themes are fetched with auth, refreshed by the existing invalidation stream, and fall back on image failure", () => {
  assert.match(customerScreen, /orderClient\.getTheme\(\)/);
  assert.match(customerScreen, /event\?\.resource === "customerTheme"/);
  assert.match(customerScreen, /event\?\.type === "customer_theme\.updated"/);
  assert.match(customerScreen, /setCustomerThemeImageFailed\(true\)/);
  assert.match(customerScreen, /const visibleCustomerTheme = customerThemeImageFailed \|\| !isAvailableCustomerTheme\(customerTheme\) \? "standard" : customerTheme/);
  assert.match(customerScreen, /data-customer-theme=\{visibleCustomerTheme\}/);
  assert.match(customerScreen, /orderClient\.getThemeConfig\(\)/);
  assert.match(customerScreen, /customerThemeConfig\.positionX/);
  assert.match(appSource, /normalizeCustomerThemeLayout\(variant\)/);
});

test("admin customer theme editor includes production notes, measured guide preview, and bounded placement controls", () => {
  assert.match(appSource, /画像生成プロンプト/);
  assert.match(appSource, /プロンプトをコピー/);
  assert.match(appSource, /制作メモ/);
  assert.match(appSource, /画像ファイルの場所/);
  assert.match(appSource, /フォルダのパスをコピー/);
  assert.match(appSource, /selectedDefinition\.assetPath/);
  assert.match(appSource, /selectedDefinition\.image\.width/);
  assert.match(appSource, /selectedDefinition\.image\.height/);
  assert.match(appSource, /実画像寸法/);
  assert.match(appSource, /data-customer-guide/);
  assert.match(appSource, /画像全体を表示/);
  assert.match(appSource, /枠いっぱいに表示/);
  assert.match(appSource, /onPointerMove/);
  assert.match(appSource, /aria-label="テーマ画像の横位置"/);
  assert.match(appSource, /aria-label="テーマ画像の縦位置"/);
  assert.match(appSource, /この方向は枠に一致しているため移動不要です/);
  assert.match(appSource, /setSelectedVariant\(\{ positionX: 0\.5, positionY: 0\.5, zoom: 0\.5 \}\)/);
  assert.match(appSource, /MIN_CUSTOMER_THEME_ZOOM/);
  assert.match(styles, /\.customer-theme-option__preview \{[^}]*width: 82px; height: 200px/);
  assert.match(styles, /\.customer-theme-preview__viewport \{[^}]*\.62/);
  assert.match(styles, /\.customer-theme-preview__rail \{[^}]*transform-origin: top left/);
  assert.match(styles, /\.customer-theme-preview__rail \.customer-theme-preview__hours \{/);
  assert.doesNotMatch(styles, /(?:^|\n)\.customer-theme-preview__hours(?:\s+(?:b|span))?\s*\{/);
  assert.match(appSource, /折り畳み時/);
  assert.match(styles, /customer-theme-preview__guide/);
});

test("customer theme placement supports cover and full-image fit with shared drag positioning", () => {
  assert.equal(MIN_CUSTOMER_THEME_ZOOM, 1);
  assert.deepEqual(normalizeCustomerThemeLayout({ zoom: 0.4, positionX: -1, positionY: 2 }), { zoom: 0.5, positionX: 0, positionY: 1 });
  assert.equal(resolveCustomerThemeZoom(0.5, 0.6), 0.6);
  assert.equal(resolveCustomerThemeZoom(1, 0.6), 1);
  assert.equal(resolveCustomerThemeZoom(1.75, 0.6), 1.75);
  assert.equal(customerThemeStoredZoomForVisualZoom(0.6, 0.6), 0.5);
  assert.equal(resolveCustomerThemeZoom(customerThemeStoredZoomForVisualZoom(0.8, 0.6), 0.6), 0.8);
  for (const theme of ["camellia", "autumn-leaves", "moon-susuki", "japanese-halloween"]) {
    const image = CUSTOMER_THEME_DEFINITIONS[theme].image;
    const minZoom = customerThemeImageMinimumZoom(image, 328, 800);
    for (const zoom of [0.5, minZoom, 1, 1.75, 3]) {
      for (const positionX of [0, 0.5, 1]) {
        for (const positionY of [0, 0.5, 1]) {
          const layout = customerThemeImageLayout(image, { zoom, positionX, positionY }, 328, 800);
          assert.ok(Math.abs((parseFloat(layout.style.width) / parseFloat(layout.style.height)) - (image.width / image.height)) < 1e-10);
          const left = parseFloat(layout.style.left);
          const top = parseFloat(layout.style.top);
          assert.ok(left >= Math.min(0, -layout.metrics.deltaX) - 1e-8 && left <= Math.max(0, -layout.metrics.deltaX) + 1e-8);
          assert.ok(Math.abs(top + layout.metrics.deltaY / 2) <= layout.metrics.rangeY / 2 + 1e-8);
          if (layout.metrics.deltaX >= 0) assert.ok(left <= 0 && left + layout.metrics.renderWidth >= 328 - 1e-8);
          else assert.ok(left >= 0 && left + layout.metrics.renderWidth <= 328 + 1e-8);
          assert.ok(top < 800 && top + layout.metrics.renderHeight > 0);
          assert.ok(layout.metrics.zoom >= layout.metrics.minimumZoom);
        }
      }
    }
  }
  const image = CUSTOMER_THEME_DEFINITIONS["japanese-halloween"].image;
  const minZoom = customerThemeImageMinimumZoom(image, 328, 602);
  assert.ok(minZoom < 1);
  const fit = customerThemeImageLayout(image, { zoom: 0.5, positionX: 0.5, positionY: 0.5 }, 328, 602);
  assert.ok(fit.metrics.renderWidth <= 328 + 1e-8);
  assert.ok(fit.metrics.renderHeight <= 602 + 1e-8);
  assert.equal(fit.style.left, `${fit.metrics.spaceX / 2}px`);
  assert.ok(Math.abs(parseFloat(fit.style.top) - fit.metrics.spaceY / 2) < 1e-8);
  assert.equal(customerThemePositionAfterDrag(0.5, 10, -80, 0.5), 0.75);
  assert.equal(customerThemePositionAfterDrag(0.5, 10, 80, 0.5), 0.25);
  assert.equal(customerThemePositionAfterDrag(0.5, 10, 0, 0.5), 0.5);
  assert.equal(customerThemePositionAfterDrag(0.5, -10, -80, 0.5), 0.25);
  assert.equal(customerThemePositionAfterDrag(0.5, -10, 80, 0.5), 0.75);
  const wide = customerThemeImageLayout(CUSTOMER_THEME_DEFINITIONS["moon-susuki"].image, { zoom: 1, positionX: 0.5, positionY: 0.5 }, 328, 800);
  assert.equal(wide.metrics.canMoveX, true);
  assert.equal(wide.metrics.canMoveY, true);
  const zoomed = customerThemeImageLayout(CUSTOMER_THEME_DEFINITIONS.camellia.image, { zoom: 1.5, positionX: 0.5, positionY: 0.5 }, 328, 800);
  assert.equal(zoomed.metrics.canMoveX, true);
  assert.equal(zoomed.metrics.canMoveY, true);
});

test("customer menu uses major category navigation with a collapsible rail", () => {
  assert.match(appSource, /CUSTOMER_MAJOR_CATEGORIES/);
  assert.match(appSource, /ドリンク/);
  assert.match(appSource, /フード/);
  assert.match(appSource, /名物/);
  assert.match(appSource, /冬季限定/);
  assert.match(appSource, /季節・気まぐれ/);
  assert.match(appSource, /とりあえず/);
  assert.match(appSource, /串カツ・揚げ物/);
  assert.match(appSource, /food-gifu/);
  assert.match(appSource, /CUSTOMER_WINTER_CATEGORY_IDS/);
  assert.match(customerScreen, /冬季限定・現在注文できません/);
  assert.match(customerScreen, /<Modal title="串カツ"/);
  assert.match(customerScreen, /各種2本から/);
  assert.match(customerScreen, /Math\.max\(2/);
  assert.match(customerScreen, /majorNavOpen/);
  assert.match(customerScreen, /customer-app--category-collapsed/);
  assert.match(appSource, /大分類カテゴリー/);
  assert.match(appSource, /IZAKAYA WARUN/);
  assert.doesNotMatch(customerScreen, /IZAKAYA WARUN[\s\S]*お品書き/);
  assert.match(appSource, /id: "drink", name: "飲み物"/);
  assert.match(appSource, /id: "food", name: "お食事"/);
  assert.match(appSource, /id: "seasonal", name: "", isPlaceholder: true/);
  assert.doesNotMatch(customerScreen, /customer-system-label|vertical-copy|IZAKAYA<br \/>ORDER<br \/>SYSTEM/);
  assert.match(styles, /\.customer-title--horizontal \{[\s\S]*transform: translateY\(-5px\)/);
  assert.match(styles, /\.category-nav \{ margin-top: 18px; padding-top: 155px; display: grid; \}/);
  assert.match(styles, /\.customer-title--horizontal strong \{ font-size: clamp\(36px, 4vw, 44px\); \}/);
  assert.match(appSource, /<span>現在<\/span>[\s\S]*メインカテゴリーに戻る/);
  assert.match(customerScreen, /setMajorNavOpen\(true\)/);
  assert.match(customerScreen, /setMajorNavOpen\(false\)/);
  assert.match(customerScreen, /subcategory-nav/);
  assert.match(customerScreen, /menu-heading__breadcrumb/);
  assert.match(customerScreen, /currentMajorCategory\.name/);
  assert.match(customerScreen, /currentCategoryLabel/);
  assert.match(customerScreen, /recentDrinkItemIds = \[\.\.\.new Set\(customerHistory\.flatMap/);
  assert.match(customerScreen, /CUSTOMER_DRINK_CATEGORY_IDS\.has\(menuItems\.find\(\(menu\) => menu\.id === item\.menuItemId\)\?\.categoryId\)/);
  assert.doesNotMatch(customerScreen, /お好みの商品をお選びください。/);
  assert.doesNotMatch(customerScreen, /menu-heading__body/);
  assert.match(customerScreen, /subcategory-nav--drink/);
  assert.match(customerScreen, /shochu-menu-row[\s\S]*product-image-button/);
  assert.match(styles, /\.shochu-menu-row \.product-image-button img \{[\s\S]*object-fit: cover[\s\S]*object-position: center/);
  assert.match(appSource, /おかわり！/);
  assert.match(appSource, /ビール/);
  assert.match(appSource, /ハイボール/);
  assert.match(appSource, /サワー・酎ハイ/);
  assert.match(appSource, /焼酎/);
  assert.match(appSource, /日本酒/);
  assert.match(appSource, /ソフトドリンク/);
  assert.match(appSource, /ノンアル/);
});

test("customer categories collapse after selection while the product list keeps its own scroll", () => {
  assert.match(customerScreen, /const \[drinkCategoryNavOpen, setDrinkCategoryNavOpen\] = useState\(true\)/);
  assert.match(customerScreen, /currentMajorCategory\.id === "drink" && !drinkCategoryNavOpen \? <button className="category-return-button category-return-button--inline"/);
  assert.match(customerScreen, />飲み物一覧に戻る<\/button>/);
  assert.match(customerScreen, /const restoreDrinkCategoryNavigation = \(\) => \{[\s\S]*setDrinkCategoryNavOpen\(true\)[\s\S]*setShochuSelection\(null\)[\s\S]*setSakeSelection\(null\)/);
  assert.match(customerScreen, /onClick=\{\(event\) => \{ event\.stopPropagation\(\); restoreDrinkCategoryNavigation\(\); \}\}/);
  const restoreBlock = customerScreen.slice(customerScreen.indexOf("const restoreDrinkCategoryNavigation"), customerScreen.indexOf("const collapseMajorNavOnMenuTap"));
  assert.doesNotMatch(restoreBlock, /setModal\(/);
  assert.match(customerScreen, /setDrinkCategoryNavOpen\(false\)/);
  assert.match(customerScreen, /menu-heading[\s\S]*menu-heading__breadcrumb[\s\S]*category-return-button category-return-button--inline/);
  assert.match(customerScreen, /menu-heading \$\{currentMajorCategory\.id === "drink" \? "menu-heading--drink" : ""\}/);
  assert.match(styles, /\.menu-heading--drink \{ padding-bottom: 12px; \}/);
  assert.match(customerScreen, /currentCategory\?\.id === "shochu" \? "menu-heading--shochu" : ""/);
  assert.match(styles, /\.menu-heading--shochu \{ padding-top: 7px; padding-bottom: 24px; \}/);
  assert.match(styles, /\.menu-heading--shochu \.menu-heading__breadcrumb \{ margin-top: 8px; \}/);
  assert.match(styles, /\.menu-heading--shochu \.category-return-button--inline \{ position: relative; top: 2px; \}/);
  assert.match(styles, /@media \(max-width: 1350px\) \{[\s\S]*\.menu-heading\.menu-heading--shochu \{ padding-bottom: 24px; \}/);
  assert.match(styles, /\.category-return-button--inline \{[\s\S]*min-height: 52px[\s\S]*padding: 0 12px[\s\S]*border: 3px solid var\(--red\)[\s\S]*background: #fff1d8[\s\S]*font-size: 18px/);
  assert.match(styles, /\.menu-list \{[\s\S]*overflow-y: auto/);
  assert.match(styles, /\.category-return-button \{[\s\S]*min-height: 44px/);
  assert.doesNotMatch(customerScreen, /category-nav-toggle|▲ 商品を見る|▼ カテゴリー/);
  assert.doesNotMatch(customerScreen, /setTimeout\([\s\S]*20[\s\S]*000/);
});

test("tapping the central menu folds only the expanded major rail and keeps the original action", () => {
  assert.match(customerScreen, /const collapseMajorNavOnMenuTap = \(\) => \{[\s\S]*if \(majorNavOpen\) setMajorNavOpen\(false\)/);
  assert.match(customerScreen, /const handleMenuClick = \(\) => \{[\s\S]*collapseMajorNavOnMenuTap\(\);[\s\S]*handleMenuInteraction\(\);/);
  assert.match(customerScreen, /<section className="menu-panel" onWheel=\{handleMenuInteraction\} onTouchMove=\{handleMenuInteraction\} onClick=\{handleMenuClick\}>/);
  assert.match(customerScreen, /onClick=\{\(\) => canOpenDetail \? setDetailItem\(item\) : undefined\}/);
  assert.match(customerScreen, /onClick=\{\(\) => selectSubcategory\(category\.id\)\}/);
  assert.match(customerScreen, /scrollIntoView\(\{ behavior: "smooth", block: "start" \}\)/);
  assert.doesNotMatch(customerScreen, /customer-content" onClick|cart-panel" onClick|customer-header" onClick|customer-footer" onClick/);
});

test("menu interaction stores the common action row offscreen and restores it after five seconds", () => {
  assert.match(customerScreen, /const \[isMenuHeaderHidden, setIsMenuHeaderHidden\] = useState\(false\)/);
  assert.match(customerScreen, /const handleMenuInteraction = \(\) => \{[\s\S]*setIsMenuHeaderHidden\(true\)[\s\S]*}, 5000\);/);
  assert.match(customerScreen, /<header className=\{`customer-header \$\{isMenuHeaderHidden \? "customer-header--menu-hidden" : ""\}`\}>/);
  assert.match(customerScreen, /<section className=\{`customer-main \$\{isMenuHeaderHidden \? "customer-main--menu-active" : ""\} \$\{notice \? "customer-main--has-notice" : ""\}`\}>/);
  assert.match(customerScreen, /<section className="menu-panel" onWheel=\{handleMenuInteraction\} onTouchMove=\{handleMenuInteraction\} onClick=\{handleMenuClick\}>/);
  assert.match(styles, /\.customer-header--menu-hidden \{ transform: translateY\(-100%\); pointer-events: none; opacity: 0/);
  assert.match(styles, /\.customer-main--menu-active \{ grid-template-rows: 0 minmax\(0, 1fr\) auto; \}/);
  assert.match(styles, /\.customer-main--menu-active \.customer-header \{ min-height: 0; height: 0; padding-block: 0[\s\S]*visibility: hidden/);
});

test("customer common actions stay outside the independently scrolling content row", () => {
  assert.match(customerScreen, /<header className=\{`customer-header \$\{isMenuHeaderHidden \? "customer-header--menu-hidden" : ""\}`\}>[\s\S]*<div className="customer-content">/);
  assert.match(styles, /\.customer-main \{[\s\S]*display: grid;[\s\S]*grid-template-rows: auto minmax\(0, 1fr\) auto/);
  assert.match(styles, /\.customer-content \{[\s\S]*min-height: 0;[\s\S]*grid-template-columns/);
  assert.match(styles, /\.menu-list \{[\s\S]*overflow-y: auto/);
  assert.match(customerScreen, /注文履歴/);
  assert.match(customerScreen, /スタッフを呼ぶ/);
  assert.match(customerScreen, /お会計/);
  assert.match(customerScreen, /タクシー・運転代行/);
});

test("customer ride guidance uses public data and keeps the flow separate from ordering", () => {
  assert.match(appSource, /async function fetchPublicRideGuidance/);
  assert.match(appSource, /fetch\(`\$\{base\}\/ride-guidance`/);
  assert.match(appSource, /function RideGuidanceModal/);
  assert.match(appSource, /title=\{selectedType \? typeLabel : "タクシー・運転代行"\}/);
  assert.match(appSource, /ride-guidance-customer__pickup-place/);
assert.match(appSource, /const typeLabel = selectedType === "taxi" \? "タクシー" : "運転代行";/);
assert.match(appSource, /title=\{selectedType \? typeLabel : "タクシー・運転代行"\}/);
  assert.doesNotMatch(appSource, /ride-guidance-customer__heading/);
  assert.match(customerScreen, /const \[rideGuidanceType, setRideGuidanceType\] = useState\(null\)/);
  assert.match(customerScreen, /const \[rideGuidanceState, setRideGuidanceState\]/);
  assert.match(customerScreen, /onClick=\{openRideGuidance\}>タクシー・運転代行/);
  assert.match(appSource, /お呼び出しはお客様からお願いします/);
  assert.doesNotMatch(appSource, /種類選択に戻る/);
  assert.match(appSource, /ride-guidance-customer__footer--list/);
  assert.match(appSource, /onClick=\{onBack\}>戻る/);
  assert.match(appSource, /現在、連絡先を表示できません/);
  assert.match(appSource, /現在登録されている連絡先はありません/);
  assert.match(appSource, /お迎え先住所は現在準備中です/);
  assert.match(appSource, /role="dialog" aria-modal="true" aria-labelledby=\{titleId\}/);
  assert.match(styles, /\.modal--ride-guidance \{/);
  assert.match(styles, /\.ride-guidance-customer__pickup \{ position: sticky/);
  assert.match(styles, /\.ride-guidance-customer__contacts strong \{/);
  assert.match(styles, /\.modal--ride-guidance \.modal__body \{[\s\S]*overflow-y: auto/);
  assert.match(styles, /\.ride-guidance-customer__footer \.button \{[\s\S]*min-height: 52px/);
  assert.match(styles, /\.ride-guidance-customer__footer--list \{ grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\); \}/);
  assert.match(styles, /\.modal--ride-guidance \.modal__body \{[\s\S]*padding: 10px 22px 14px/);
  assert.match(styles, /\.ride-guidance-customer__pickup \{ position: sticky; top: 0;[\s\S]*padding: 8px 14px 10px/);
  assert.match(styles, /\.ride-guidance-customer__pickup p \{ margin: 0; font-size: 22px; line-height: 1\.5; font-weight: 600; overflow-wrap: normal; white-space: nowrap;/);
  assert.doesNotMatch(styles, /\.ride-guidance-customer__pickup[^}]*transform:/);
  assert.doesNotMatch(styles, /\.ride-guidance-customer__pickup[^}]*margin-top:\s*-/);
});

test("customer footer keeps information replaceable and shows smoking availability", () => {
  assert.match(appSource, /const CUSTOMER_FOOTER_INFORMATION = ""/);
  assert.match(customerScreen, /CUSTOMER_FOOTER_INFORMATION \? <span>\{CUSTOMER_FOOTER_INFORMATION\}<\/span> : null/);
  assert.match(customerScreen, /<strong>全席喫煙可能<\/strong>/);
  assert.doesNotMatch(customerScreen, /アレルギー・原材料についてはスタッフまでお尋ねください。|<strong>店内禁煙<\/strong>/);
});

test("cart cancel buttons decrement one quantity at a time", () => {
  assert.match(customerScreen, /const decrementCartRow = \(key\) => \{[\s\S]*if \(row\.quantity <= 1\)[\s\S]*row\.quantity - 1/);
  assert.match(customerScreen, /row\.unavailable \? removeCartRow\(row\.key\) : decrementCartRow\(row\.key\)/);
  assert.match(customerScreen, /を1点取り消す/);
});


test("API cart pins the first visit context and keeps stale cart contents available for discard", () => {
  assert.match(customerScreen, /const captureCartVisitContext = \(\) => \{/);
  assert.match(customerScreen, /cartContextCapturedRef\.current = true/);
  assert.match(customerScreen, /getVisitContextId\(\)/);
  assert.match(customerScreen, /const pinnedVisitContextId = cartVisitContextIdRef\.current/);
  assert.match(customerScreen, /enqueue\(\{ visitContextId: pinnedVisitContextId/);
  assert.match(customerScreen, /setCartContextStale\(true\)[\s\S]*setModal\(null\)/);
  assert.match(customerScreen, /カート内容を確認して破棄してください/);
  assert.match(customerScreen, /onClick=\{discardStaleCart\}/);
  assert.match(customerScreen, /apiMode && Object\.keys\(cart\)\.length > 0 && cartContextStale/);
  assert.match(customerScreen, /const discardStaleCart = \(\) => \{[\s\S]*clearCart\(\)/);
  assert.match(customerScreen, /disabled=\{!cartCount \|\| hasUnavailableCartRows \|\| cartContextLoading \|\| cartContextStale\}/);
  assert.match(styles, /\.cart-context-warning \{[^}]*border: 2px solid var\(--red\)/);
});

function extractIfStatementBody(source, conditionPattern) {
  const match = conditionPattern.exec(source);
  assert.ok(match, "expected conditional branch to exist");
  let cursor = match.index + match[0].length;
  while (/\s/.test(source[cursor] ?? "")) cursor += 1;
  if (source[cursor] !== "{") {
    const statementEnd = [source.indexOf(";", cursor), source.indexOf("\n", cursor)]
      .filter((index) => index !== -1)
      .sort((left, right) => left - right)[0];
    assert.notEqual(statementEnd, undefined, "expected conditional statement to end");
    return source.slice(cursor, statementEnd + 1);
  }
  const bodyStart = cursor;
  let depth = 0;
  for (; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return source.slice(bodyStart + 1, cursor);
  }
  assert.fail("expected conditional block to end");
}

test("customer refreshes menu and device context after session invalidations and reconnect", () => {
  const deviceConfigBody = extractIfStatementBody(
    customerScreen,
    /if\s*\(\s*resource\s*===\s*["']deviceConfig["']\s*\)/,
  );
  assert.match(deviceConfigBody, /\brefreshVisitState\s*\(\s*\)/);
  assert.match(customerScreen, /onReconnect: refreshVisitState/);
  assert.match(customerScreen, /getConfig: \(options\) => orderClient\.getDeviceConfig\(options\)/);
  assert.match(customerScreen, /onCustomerDeviceConfigChange\?\.\(\{ \.\.\.currentConfig, deviceId: customerDeviceConfig\?\.deviceId \}\)/);
  assert.match(customerScreen, /currentConfig\.visitContextId !== pinnedVisitContextId/);
  assert.match(customerScreen, /setCartContextStale\(true\)/);
  assert.match(customerScreen, /setMenuRefreshKey\(\(current\) => current \+ 1\)/);
});

test("a menu refresh keeps the loaded list mounted and reports refresh failure with connection status", () => {
  assert.match(customerScreen, /dispatchApiMenuState\(\{ type: "load-started" \}\)/);
  assert.match(customerScreen, /apiMenuState\.loading && !apiMenu/);
  assert.match(customerScreen, /apiMenuState\.error && !apiMenu/);
  assert.match(customerScreen, /apiMenuState\.error \? <div className="cart-context-status" role="status">[\s\S]*ConnectionBadge online=\{online\} compact announceStatus/);
  assert.match(customerScreen, /setMenuRefreshKey\(\(current\) => current \+ 1\)/);
});

test("API customer staff call submits an idempotent request and shows success only after acknowledgement", () => {
  const callStart = customerScreen.indexOf("const callStaff = async () =>");
  const callEnd = customerScreen.indexOf("const noticeKind", callStart);
  const callHandler = customerScreen.slice(callStart, callEnd);
  assert.match(callHandler, /await orderClient\.createStaffCall\(\{ clientCallId, expectedVisitContextId: callVisitContextId \}\)/);
  assert.match(callHandler, /staffCallSubmitLock\.current/);
  assert.match(callHandler, /warun-pending-staff-call-id:\$\{customerDeviceConfig\?\.deviceId \?\? deviceId\}:\$\{callVisitContextId\}/);
  const apiCallHandler = callHandler.slice(callHandler.indexOf("staffCallSubmitLock.current = true"));
  assert.ok(apiCallHandler.indexOf("await orderClient.createStaffCall") < apiCallHandler.indexOf("スタッフを呼び出しました"));
  assert.match(callHandler, /呼出を保存できませんでした。呼出画面を開いたまま再試行してください。/);
  assert.match(customerScreen, /disabled=\{staffCallSubmitting\}/);
  assert.match(customerScreen, /staffCallCooldownRemainingSeconds/);
  assert.match(callHandler, /expectedVisitContextId: callVisitContextId/);
  assert.match(customerScreen, /isMatchingCustomerStaffCallResolution/);
  assert.match(customerScreen, /message: "スタッフを呼び出しました。", staffCallId: cooldown\.staffCallId/);
  assert.match(customerScreen, /isCustomerStaffCallSuccessNotice\(current, staffCallCooldown\.staffCallId\) \? null : current/);
  assert.match(customerScreen, /notice\?\.kind !== "success" \|\| notice\.staffCallId/);
  assert.doesNotMatch(customerScreen, /スタッフが対応しました/);
  assert.match(customerScreen, /staffCallResolvedIdsRef\.current\.has\(cooldown\.staffCallId\)/);
  const successfulCall = callHandler.slice(callHandler.indexOf("const result = await orderClient.createStaffCall"));
  assert.ok(successfulCall.indexOf("await orderClient.createStaffCall") < successfulCall.indexOf("setStaffCallCooldown(cooldown)"));
  assert.ok(successfulCall.indexOf("setStaffCallCooldown(cooldown)") < successfulCall.indexOf("スタッフを呼び出しました"));
  const failedCallPath = callHandler.slice(callHandler.lastIndexOf("} catch {"), callHandler.indexOf("} finally {"));
  assert.doesNotMatch(failedCallPath, /setStaffCallCooldown\(/);
  assert.match(customerScreen, /staffCallCooldownRemainingSeconds > 0 \|\| !staffCallCooldown\?\.staffCallId/);
  assert.match(customerScreen, /disabled=\{staffCallSubmitting \|\| staffCallCooldownRemainingSeconds > 0\}/);
  assert.ok(customerScreen.indexOf("const staffCallStorageKey =") < customerScreen.indexOf("useRef({ key: staffCallStorageKey"));
  assert.match(staffCallSource, /warun-staff-call-cooldown/);
});

test("revoked customer authorization keeps the cart visible and blocks enqueue until discard", () => {
  assert.match(customerScreen, /onAuthorizationFailure: blockCartAfterAuthenticationFailure/);
  assert.match(visitConfigRefreshSource, /config\?\.status === "unauthorized"/);
  assert.match(customerScreen, /contextCheck\?\.status === "unauthorized"/);
  assert.match(customerScreen, /setCartAuthorizationRequired\(true\)/);
  assert.match(customerScreen, /端末の接続を確認できません。カート内容は保持しています。注文を停止しています。スタッフへ確認してください。/);
  assert.match(customerScreen, /cartAuthorizationRequired \? "端末の接続を確認できません。カート内容は保持しています。注文は送信されません。スタッフへ確認してください。"/);
  const submitOrder = customerScreen.slice(customerScreen.indexOf("const submitOrder"), customerScreen.indexOf("const callStaff", customerScreen.indexOf("const submitOrder")));
  assert.ok(submitOrder.indexOf("blockCartAfterAuthenticationFailure();") < submitOrder.indexOf("orderClient.enqueue"));
  assert.match(submitOrder, /blockCartAfterAuthenticationFailure\(\);\s*return;/);
});

test("cart retains display snapshots for unavailable menu items and blocks the complete order", () => {
  assert.match(customerScreen, /const cartRows = customerCartRows\(cart, menuItems\)/);
  assert.match(customerScreen, /const hasUnavailableCartRows = cartRows\.some\(\(row\) => row\.unavailable\)/);
  assert.match(customerScreen, /replaceCart\(addCustomerCartSelection\(cartRef\.current, item, selection, normalizedQuantity\)\)/);
  assert.match(customerScreen, /現在注文できない商品があります。内容をご確認ください/);
  assert.match(customerScreen, /if \(!cartRows\.length \|\| hasUnavailableCartRows \|\| cartContextStale \|\| submitLock\.current\) return/);
  assert.match(customerScreen, /disabled=\{!cartCount \|\| hasUnavailableCartRows \|\| cartContextLoading \|\| cartContextStale\}/);
  assert.match(customerScreen, /row\.unavailable \? removeCartRow\(row\.key\) : decrementCartRow\(row\.key\)/);
  assert.match(customerScreen, /items: cartRows\.map\(\(row\) => \(\{[\s\S]*menuItemId: row\.item\.menuItemId \?\? row\.item\.id,[\s\S]*quantity: row\.quantity,[\s\S]*variantId: row\.variant\.variantId/);
  const enqueueBlockStart = customerScreen.indexOf("const outboxRecord = await orderClient.enqueue");
  const enqueueBlock = customerScreen.slice(enqueueBlockStart, customerScreen.indexOf("const order = {", enqueueBlockStart));
  assert.doesNotMatch(enqueueBlock, /displaySnapshot/);
  assert.match(styles, /\.cart-row--unavailable \{ color: #5a2118; background: #fff0e8; \}/);
});
test("A90 landscape keeps product information readable beside a compact cart", () => {
  const a90Styles = styles.slice(styles.indexOf("@media (max-width: 1350px)"), styles.indexOf("@media (orientation: landscape) and (max-height: 700px)"));
  assert.match(a90Styles, /\.customer-content \{[\s\S]*grid-template-columns: minmax\(0, 1fr\) clamp\(280px, 30vw, 320px\)/);
  assert.match(a90Styles, /\.cart-panel > header \{[\s\S]*min-height: 58px[\s\S]*padding: 8px 12px/);
  assert.match(a90Styles, /\.cart-panel > header h2 \{ font-size: 16px; \}/);
  assert.match(a90Styles, /\.menu-row \{[\s\S]*grid-template-columns: 48px 64px minmax\(140px, 1fr\) 86px 156px/);
  assert.match(a90Styles, /\.shochu-menu-row \{[\s\S]*grid-template-columns: 48px 64px minmax\(140px, 1fr\) 84px 148px/);
  assert.match(a90Styles, /\.menu-row__copy \{ min-width: 140px/);
  assert.match(a90Styles, /\.menu-row__copy p \{[\s\S]*-webkit-line-clamp: 3[\s\S]*white-space: normal/);
  assert.match(styles, /\.menu-row__copy h2 \{[\s\S]*white-space: nowrap/);
  assert.match(styles, /\.cart-list \{ flex: 1; min-height: 0; overflow-y: auto/);
});

test("customer route fits A90 and 1024x499 geometry without document overflow", () => {
  assert.match(styles, /\.customer-app \{ width: 100%; height: 100dvh; min-width: 0; min-height: 0/);
  assert.match(styles, /#root:has\(\.customer-app\) \{ width: 100%; height: 100%; min-width: 0; min-height: 0; \}/);
  assert.doesNotMatch(styles, /\.customer-app \{[^}]*overflow:\s*hidden/);
  assert.doesNotMatch(styles, /\.customer-main \{[^}]*overflow:\s*hidden/);
  assert.doesNotMatch(styles, /\.customer-sidebar \{[^}]*overflow:\s*hidden/);
  assert.match(styles, /\.customer-content \{ min-width: 0; min-height: 0;[\s\S]*grid-template-columns: minmax\(0, 1fr\) minmax\(0, 454px\)/);
  assert.match(styles, /@media \(min-width: 901px\) and \(max-width: 1100px\)[\s\S]*\.customer-header \{[\s\S]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.customer-header > \* \{ min-width: 0; box-sizing: border-box; \}/);
  assert.match(styles, /@media \(min-width: 901px\) and \(max-width: 1100px\)[\s\S]*\.menu-row \{ grid-template-columns: 40px 52px minmax\(0, 1fr\) 70px 112px/);
  assert.match(styles, /@media \(min-width: 901px\) and \(max-height: 600px\)[\s\S]*\.customer-sidebar \{ height: 100%; box-sizing: border-box; padding: 12px 16px; display: grid; grid-template-rows: auto minmax\(0, 1fr\) auto auto/);
  assert.match(styles, /@media \(min-width: 901px\) and \(max-height: 600px\)[\s\S]*\.category-nav button \{ min-height: 44px; height: 100%/);
  assert.match(styles, /@media \(min-width: 901px\) and \(max-height: 600px\)[\s\S]*\.cart-empty \{ min-height: 0; \}/);
  assert.match(styles, /@media \(min-width: 901px\) and \(max-height: 600px\)[\s\S]*\.confirm-button \{ width: calc\(100% - 28px\); box-sizing: border-box/);
  assert.match(styles, /\.customer-footer \{ width: 100%; height: 32px; min-width: 0/);
  assert.match(styles, /\.customer-main \{ min-width: 0; min-height: 0; display: grid; grid-template-rows: auto minmax\(0, 1fr\) auto; \}/);
  assert.match(styles, /\.customer-footer \{ width: 100%; height: 32px; min-width: 0; min-height: 32px; box-sizing: border-box;[\s\S]*line-height: 1;[\s\S]*white-space: nowrap; \}/);
  assert.match(styles, /\.customer-footer span \{ min-width: 0; white-space: nowrap; \}/);
});

test("shochu rows keep fixed image, price, and action columns without changing the detail image", () => {
  assert.match(customerScreen, /shochuThumbUri\(item\.imageUri\)/);
  assert.match(customerScreen, />飲み方選択<\/button>/);
  assert.match(customerScreen, /menu-row__detail-hint[\s\S]*タップで明細/);
  assert.match(styles, /\.shochu-menu-row \{[\s\S]*grid-template-columns: 60px 84px minmax\(0, 1fr\) 104px 160px;[\s\S]*column-gap: 10px/);
  assert.match(styles, /\.shochu-menu-row \.product-image-button \{ width: 84px; height: 108px; \}/);
  assert.match(styles, /\.shochu-serving-button \{[\s\S]*width: 160px[\s\S]*white-space: nowrap/);
  assert.match(styles, /\.shochu-menu-row\.menu-row--no-image \{ grid-template-columns: 60px minmax\(0, 1fr\) 104px 160px; \}/);
  assert.match(styles, /\.shochu-menu-row \{ grid-template-columns: 48px 64px minmax\(140px, 1fr\) 84px 148px; column-gap: 10px/);
  assert.match(styles, /\.shochu-serving-button \{ width: 138px; min-width: 138px/);
  assert.match(styles, /\.shochu-menu-row \.menu-price b \{ font-size: 28px; line-height: 1\.05; font-weight: 900/);
  assert.match(styles, /\.menu-price b \{ font: 900 30px\/1\.05 var\(--font-ui\); font-variant-numeric: tabular-nums; font-feature-settings: "tnum" 1/);
  assert.match(styles, /\.menu-price small \{[\s\S]*font-family: var\(--font-ui\)[\s\S]*font-variant-numeric: tabular-nums; font-feature-settings: "tnum" 1/);
  assert.match(appSource, /return `￥\$\{normalizedAmount\}`/);
  assert.match(appSource, /showImageInList/);
  assert.match(appSource, /listImageVisible\(item\)/);
  assert.match(appSource, /detailItem\.detail\?\.imageUri \|\| detailItem\.imageUri/);
  assert.match(appSource, /import \{ compareMenuItems \} from "\.\/menu-ordering\.js"/);
});

test("shochu display honors persisted order across section groups", () => {
  const items = [
    { id: "mugi-first", categoryId: "shochu", sectionKey: "麦・その他", sortOrder: 10 },
    { id: "imo-second", categoryId: "shochu", sectionKey: "芋", sortOrder: 20 },
    { id: "imo-last-tie", categoryId: "shochu", sectionKey: "芋", sortOrder: 20 },
  ];
  assert.deepEqual(items.sort(compareMenuItems).map((item) => item.id), ["mugi-first", "imo-last-tie", "imo-second"]);
  assert.match(appSource, /import \{ compareMenuItems \} from "\.\/menu-ordering\.js"/);
  assert.match(customerScreen, /const isShochuGroupStart = isShochu && \(index === 0 \|\| shochuGroup\(previous\) !== shochuGroup\(item\)\)/);
  assert.match(customerScreen, /<b>\{shochuGroup\(item\)\}<\/b>/);
  assert.match(customerScreen, /ref=\{isFirstShochuImo \? imoRef : null\}/);
  assert.match(customerScreen, /ref=\{isFirstShochuOther \? otherRef : null\}/);
});

test("customer cards show only stored readings and keep the detail hint separate", () => {
  assert.match(appSource, /item\.detail\?\.reading \? <small className="menu-row__reading">\{item\.detail\.reading\}<\/small> : null/);
  assert.match(appSource, /className="menu-row__detail-hint"/);
  assert.match(appSource, /className="modal__title-reading"/);
  assert.match(customerScreen, /menu-row__reading[\s\S]*<h2>\{item\.name\}<\/h2>/);
  assert.doesNotMatch(appSource, /kitchenAlias[^\n]*menu-row__reading/);
  assert.match(styles, /\.menu-row__copy h2 \{[\s\S]*white-space: nowrap/);
  assert.match(styles, /\.menu-row__reading \{[\s\S]*white-space: nowrap[\s\S]*overflow: hidden/);
});

test("product details keep stored readings conditional and let shochu continue to serving selection", () => {
  assert.match(appSource, /function Modal\(\{ title, titleExtra = null, children, footer = null, onClose/);
  assert.match(appSource, /className="modal__title-group"><h2 id=\{titleId\}>\{title\}<\/h2>\{titleExtra\}/);
  assert.match(appSource, /\{footer \? <div className="modal__footer">\{footer\}<\/div> : null\}/);
  assert.match(appSource, /className="modal--product-detail" footer=\{<div className="modal-actions product-detail__actions">/);
  assert.match(appSource, /titleExtra=\{detailItem\.detail\?\.reading \? <span className="modal__title-reading">\{detailItem\.detail\.reading\}<\/span> : null\}/);
  assert.doesNotMatch(appSource, /className="product-detail__reading"/);
  assert.match(appSource, /const chooseShochuFromDetail = \(item\) => \{[\s\S]*setDetailItem\(null\)[\s\S]*openShochuSelection\(item\)/);
  assert.match(appSource, /const chooseSakeFromDetail = \(item\) => \{[\s\S]*setDetailItem\(null\)[\s\S]*openSakeSelection\(item\)/);
  assert.match(appSource, /detailItem\.categoryId === "shochu" && detailItem\.servingOptions\?\.length/);
  assert.match(appSource, /detailItem\.categoryId === "sake" && detailItem\.variants\?\.length/);
  assert.match(appSource, />これにする<\/button>/);
  assert.match(appSource, /className="button button--quiet" onClick=\{\(\) => setDetailItem\(null\)\}>一覧へ戻る<\/button>/);
  assert.match(styles, /\.modal--product-detail \.modal__body \{[\s\S]*overflow: hidden/);
  assert.match(styles, /\.product-detail__actions \.button \{ min-height: 48px; \}/);
  assert.match(styles, /\.modal__title-group \{[\s\S]*display: flex[\s\S]*align-items: baseline/);
  assert.match(styles, /\.modal__title-reading \{[\s\S]*white-space: nowrap/);
  assert.match(styles, /\.modal--product-detail \.modal__footer \{[\s\S]*flex: 0 0 auto/);
  assert.match(appSource, /className="product-detail__image"><img src=\{detailItem\.detail\?\.imageUri \|\| detailItem\.imageUri\}/);
  assert.match(styles, /\.product-detail \{[\s\S]*grid-template-columns: minmax\(220px, 45%\) minmax\(0, 1fr\)[\s\S]*align-items: center/);
  assert.match(styles, /\.product-detail__image \{[\s\S]*height: var\(--product-detail-image-height, min\(550px, calc\(100dvh - 170px\)\)\)[\s\S]*overflow: hidden[\s\S]*background: transparent/);
  assert.match(styles, /\.product-detail__image > img \{[\s\S]*object-fit: contain[\s\S]*object-position: center[\s\S]*transform: scale\(1\.05\)/);
  assert.match(styles, /@media \(orientation: portrait\) \{[\s\S]*\.product-detail \{[\s\S]*grid-template-columns: minmax\(220px, 45%\)/);
  assert.match(styles, /@media \(orientation: landscape\) \{[\s\S]*\.modal--product-detail \{ display: grid; grid-template-rows: auto minmax\(0, 1fr\) auto; \}[\s\S]*\.modal--product-detail \.modal__body \{ overflow: hidden; display: grid; grid-template-rows: minmax\(0, 1fr\); \}[\s\S]*\.product-detail \{ height: auto;[\s\S]*grid-template-columns: minmax\(0, calc\(38% - 20px\)\) minmax\(0, 1fr\)[\s\S]*column-gap: 20px; align-items: start/);
  assert.match(styles, /@media \(orientation: landscape\) \{[\s\S]*\.product-detail__image \{ height: 100%; padding: 0 0 0 40px; place-items: end start; \}[\s\S]*\.product-detail__image > img \{ min-height: 0; max-height: 100%; transform: translateY\(10%\) scale\(1\.1\); transform-origin: left bottom; object-position: left bottom; \}/);
  assert.match(styles, /\.modal--product-detail \.product-detail__actions \{ position: relative; top: -5px; margin-top: 0/);
  assert.match(styles, /@media \(orientation: landscape\) and \(max-height: 700px\) \{[\s\S]*\.modal--product-detail \.modal__body \{ overflow-y: auto/);
  assert.match(styles, /@media \(orientation: landscape\) and \(max-height: 700px\) \{[\s\S]*\.product-detail__image > img \{ min-height: 0; max-height: 100%; transform: translateY\(10%\) scale\(1\.1\); transform-origin: left bottom; \}/);
  assert.match(styles, /@media \(min-width: 900px\) and \(max-height: 800px\) \{[\s\S]*\.product-detail \{ height: auto;[\s\S]*grid-template-columns: minmax\(0, calc\(38% - 20px\)\) minmax\(0, 1fr\)[\s\S]*column-gap: 20px; align-items: start/);
  assert.match(styles, /\.product-detail > :not\(\.product-detail__image\) \{ margin: 0; padding: 10px 0 0; align-self: start; \}/);
  assert.match(styles, /@media \(min-width: 900px\) and \(max-height: 800px\) \{[\s\S]*\.product-detail__image \{ height: 100%; padding: 0 0 0 40px; place-items: end start; \}[\s\S]*\.product-detail__image > img \{ min-height: 0; max-height: 100%; transform: translateY\(10%\) scale\(1\.1\); transform-origin: left bottom; object-position: left bottom; \}/);
  assert.match(styles, /\.modal--product-detail \.modal__header \{[\s\S]*min-height: 64px; padding: 4px 16px/);
  assert.match(styles, /\.modal--product-detail \.modal__body \{[\s\S]*padding: 0 8px/);
  assert.match(styles, /\.modal--product-detail \.modal__footer \{[\s\S]*padding: 0 18px 4px/);
  assert.match(styles, /\.product-detail__actions \.button \{ min-height: 48px; \}/);
  assert.match(styles, /@media \(min-width: 900px\) and \(max-height: 700px\) \{[\s\S]*\.modal--product-detail \{ display: grid; grid-template-rows: auto minmax\(0, 1fr\) auto; height: calc\(100dvh - 16px\); \}[\s\S]*\.modal--product-detail \.modal__body \{ overflow-y: auto/);
  assert.match(styles, /@media \(min-width: 900px\) and \(min-height: 701px\) and \(max-height: 800px\) \{[\s\S]*\.modal--product-detail \.modal__body \{ overflow: hidden; display: grid/);
  assert.match(styles, /@media \(min-width: 900px\) and \(max-height: 700px\) \{[\s\S]*\.modal--product-detail \.modal__body \{ overflow-y: auto/);
  assert.match(appSource, /document\.body\.style\.overflow = "hidden"/);
});

test("admin menu editing is grouped, cancellable, and keeps edit ordering data", () => {
  assert.match(appSource, /const menuGroups = \[/);
  assert.match(appSource, /menu-admin-group__heading/);
  assert.match(appSource, /const resetMenuEditor = \(\)/);
  assert.match(appSource, /type="button" onClick=\{resetMenuEditor\} disabled=\{catalogState\.saving\}>キャンセル/);
  assert.match(appSource, /name="sortOrder"/);
  assert.match(appSource, /name="isSoldOut"/);
  assert.match(appSource, /name="sortOrder"/);
  assert.match(appSource, /foodVariantDefinitions\(editingMenu\)/);
  assert.match(appSource, /const refreshedCatalog = await fetchAdminMenu/);
  assert.match(appSource, /refreshedItem\.version !== result\.version/);
  assert.match(appSource, /disabled=\{catalogState\.saving\}/);
  assert.match(styles, /\.menu-admin-group__heading \{/);
  assert.match(styles, /\.menu-editor__actions \{/);
});

test("admin menu creation and editing share the full form and preserve the existing item identity", () => {
  assert.match(appSource, /\{showAdd \? <form className=\{`inline-form inline-form--menu menu-editor/);
  assert.match(appSource, /onSubmit=\{addMenu\}/);
  assert.doesNotMatch(appSource, /saveInlineMenu|admin-menu-inline-editor/);
  assert.match(appSource, /const targetId = editingMenuId \?\? \(menuCreateIdRef\.current \?\?= makeId\("menu"\)\)/);
  assert.match(appSource, /expectedVersion: editingMenu\?\.version \?\? retryItem\?\.version \?\? 0/);
  assert.match(appSource, /updateState\(\(current\) => editingMenuId \|\| retryItem \? \(\{[\s\S]*current\.menuItems\.some\(\(item\) => item\.id === targetId\)/);
  assert.match(appSource, /\[\.\.\.current\.menuItems, \{ \.\.\.nextItem, \.\.\.patch/);
  assert.match(appSource, /const editedItems = current\.menuItems\.map\(\(item\) => item\.id === editingMenuId \? \{ \.\.\.item, \.\.\.nextItem \}/);
  assert.match(appSource, /isSoldOut: form\.get\("isSoldOut"\) === "on"/);
  assert.match(appSource, /isActive: form\.get\("isActive"\) === "on"/);
  assert.match(appSource, /sortOrder: Number\.isSafeInteger\(Number\(form\.get\("sortOrder"\)\)\)/);
  assert.match(appSource, /onClick=\{resetMenuEditor\} disabled=\{catalogState\.saving\}>キャンセル/);
  assert.match(appSource, /name="detailImageUri"/);
  assert.match(appSource, /name="glassCold"/);
  assert.match(appSource, /name="tokuri2Hot"/);
  assert.match(appSource, /name="shochuOptions" defaultChecked=\{Boolean\(editingMenu\?\.servingOptions\?\.length\)\}/);
  assert.match(appSource, /mode=\{editingMenu\?\.tableVisibilityMode \?\? "all_tables"\}/);
  assert.match(appSource, /setMenuEditorPlacementEdge\(null\)/);
});

test("admin menu add and edit ordering controls count category items and save edge placement", () => {
  assert.match(appSource, /const selectedMenuCategoryItems = state\.menuItems\.filter\(\(item\) => item\.categoryId === selectedMenuCategoryId\)/);
  assert.match(appSource, /const selectedMenuCategoryCount = selectedMenuCategoryItemsForPlacement\.length \+ \(editingMenu \? 1 : 0\)/);
  assert.match(appSource, /name="sortOrder" type="number" min="0" step="1"/);
  assert.match(appSource, /最上段に追加/);
  assert.match(appSource, /最下段に追加/);
  assert.match(appSource, /最上段へ移動/);
  assert.match(appSource, /最下段へ移動/);
  assert.match(appSource, /setMenuEditorPlacementEdge\(edge\)/);
  assert.match(appSource, /const persistMenuEdgePlacement = async \(categoryId, itemId, edge\)/);
  assert.match(appSource, /saveAdminMenuOrdering\(\{ env: window, categoryId, menuItemIds: menuIdsForPlacement/);
  assert.match(appSource, /applyLocalMenuPlacement\(/);
  assert.match(appSource, /const openNewMenuEditor = \(\) =>/);
  assert.match(styles, /\.menu-editor__sort-order-actions/);
});

test("admin menu create blocks same-tick duplicate submits and retries ambiguous creates with the same id", () => {
  assert.match(appSource, /const menuSaveLockRef = useRef\(false\)/);
  assert.match(appSource, /import \{ runWithSubmissionLock \} from "\.\/admin-submit-lock\.js"/);
  assert.match(appSource, /await runWithSubmissionLock\(menuSaveLockRef, \(\) => saveMenuEditor\(event\)\)/);
  assert.match(appSource, /menuCreateIdRef\.current = makeId\("menu"\)/);
  assert.match(appSource, /const targetId = editingMenuId \?\? \(menuCreateIdRef\.current \?\?= makeId\("menu"\)\)/);
  assert.match(appSource, /if \(!editingMenuId && menuCreateMayHaveCommittedRef\.current\) \{[\s\S]*fetchAdminMenu\(\{ env: window \}\)[\s\S]*latest\.items\.find\(\(item\) => item\.menuItemId === targetId\)/);
  assert.match(appSource, /retryItem && JSON\.stringify\(nextItem\) === JSON\.stringify\(menuCreateAttemptRef\.current\)[\s\S]*result = \{ version: retryItem\.version \}/);
  assert.match(appSource, /expectedVersion: editingMenu\?\.version \?\? retryItem\?\.version \?\? 0/);
  assert.match(appSource, /menuItems: current\.menuItems\.some\(\(item\) => item\.id === targetId\)[\s\S]*\? current\.menuItems\.map[\s\S]*: \[\.\.\.current\.menuItems, refreshedPatch\]/);
  assert.match(appSource, /if \(!editingMenuId\) menuCreateMayHaveCommittedRef\.current = true/);
});

test("admin deletion and archive actions live only at the bottom of existing edit forms", () => {
  assert.match(appSource, /editingMenu \? <div className="menu-editor__lifecycle"/);
  assert.match(appSource, /この商品を削除・アーカイブ/);
  assert.doesNotMatch(appSource, /onClick=\{\(\) => void openMenuItemLifecycle\(item\)\}/);
  assert.match(appSource, /const requestMenuItemLifecycle = \(item\) => \{[\s\S]*editingMenuId === item\.id && menuEditorDirty[\s\S]*setMenuLifecycleDiscardPrompt\(item\)/);
  assert.match(appSource, /編集を続ける/);
  assert.match(appSource, /変更を破棄して確認へ/);
  assert.match(appSource, /const discardMenuEditsAndOpenLifecycle = \(\) => \{[\s\S]*closeMenuEditor\(\);[\s\S]*openMenuItemLifecycle\(item\)/);
  assert.match(appSource, /商品を削除しますか？[\s\S]*menuItemLifecycle\.item\.name/);
  assert.match(appSource, /<button type="button" className="button button--quiet" onClick=\{\(\) => setMenuItemLifecycle\(null\)\}[^>]*>キャンセル/);
});

test("shared product editor groups related settings and keeps section headings descriptive", () => {
  for (const heading of ["販売・客席表示（売り切れ・注文方法・表示先）", "画像・一覧／詳細表示", "提供方法・容量・温度・価格", "商品詳細（ふりがな・産地・蔵元・味・説明・おすすめ）"]) assert.ok(appSource.includes(heading));
  assert.match(appSource, /name="name"[\s\S]*name="categoryId"[\s\S]*name="price"[\s\S]*name="description"/);
  assert.match(styles, /.menu-editor__section-body \{ display: grid/);
  assert.match(styles, /.menu-editor__lifecycle \{[\s\S]*border-top: 2px dashed/);
  assert.match(styles, /.menu-admin-list \{[\s\S]*overflow-x: auto/);
  assert.match(styles, /.admin-row__actions \{ display: grid/);
});

test("admin shochu edits reuse canonical serving option IDs", () => {
  assert.match(appSource, /editingMenu\?\.servingOptions\?\.find\(\(option\) => option\.name === optionName\)\?\.servingOptionId/);
  assert.match(appSource, /`\$\{targetId\}-\$\{\["rock", "water", "soda", "hot"\]\[index\]\}`/);
});

test("major category selection collapses to a 78px rail and the rail reopens it", () => {
  assert.match(customerScreen, /const \[majorNavOpen, setMajorNavOpen\] = useState\(true\)/);
  assert.match(appSource, /onClick=\{\(\) => onSelectCategory\?\.\(category\.id\)\}/);
  assert.match(customerScreen, /setMajorNavOpen\(false\)/);
  assert.match(customerScreen, /const selectSubcategory = \(nextCategoryId\) => \{[\s\S]*setMajorNavOpen\(false\)/);
  assert.match(appSource, /customer-sidebar__collapsed-toggle.*onExpand/s);
  assert.match(appSource, /<span>現在<\/span>[\s\S]*メインカテゴリーに戻る/);
  assert.match(appSource, /category-nav__placeholder/);
  assert.match(styles, /--customer-rail-collapsed-width: 78px/);
  assert.match(styles, /\.customer-app\.customer-app--category-collapsed \{ grid-template-columns: var\(--customer-rail-collapsed-width\)/);
  assert.match(styles, /\.customer-sidebar__collapsed-toggle \{/);
});

test("business-hours settings use the management API and shared public display", () => {
  assert.match(appSource, /fetchAdminBusinessHours/);
  assert.match(appSource, /saveAdminBusinessHours/);
  assert.match(appSource, /fetchPublicBusinessHoursWithNotice/);
  assert.match(appSource, /formal\.noticeText === requested\.noticeText/);
  assert.match(appSource, /formal\.noticeEnabled === requested\.noticeEnabled/);
  assert.match(appSource, /expectedVersion: businessHoursState\.formal\.version/);
  assert.match(appSource, /CustomerBusinessHours settings={businessHours}/);
  assert.match(appSource, /BusinessHoursText settings={businessHours} className="hours"/);
  assert.match(appSource, /BusinessHoursTimeFields label="営業開始"/);
  assert.match(appSource, /BusinessHoursTimeFields label="営業終了"/);
  assert.match(appSource, /BusinessHoursTimeFields label="ラストオーダー"/);
  assert.match(appSource, /客席画面に表示する/);
  assert.match(appSource, /保存しました（version/);
  assert.match(styles, /\.business-hours-editor__/);
  assert.doesNotMatch(appSource, /<div className="customer-hours"><b>本日の営業時間<\/b><span>17:00/);
  assert.doesNotMatch(appSource, /<div className="hours"><b>本日の営業時間<\/b><span>17:00/);
});

test("ride guidance management stays in an independent collapsible section", () => {
  assert.match(appSource, /function RideGuidanceEditor\(\{ adminApiMode \}\)/);
  assert.match(appSource, /<RideGuidanceEditor adminApiMode=\{adminApiMode\} \/>/);
  assert.match(appSource, /aria-label="タクシー・運転代行案内"/);
  assert.match(appSource, /aria-expanded=\{expanded\}/);
  assert.match(appSource, /fetchAdminRideGuidance/);
  assert.match(appSource, /await load\(\);/);
  assert.match(appSource, /expectedVersion: state\.pickup\.version/);
  assert.match(appSource, /saveAdminRideGuidancePickup/);
  assert.match(appSource, /createAdminRideGuidanceContact/);
  assert.match(appSource, /updateAdminRideGuidanceContact/);
  assert.match(appSource, /deleteAdminRideGuidanceContact/);
  assert.match(appSource, /saveAdminRideGuidanceOrdering/);
  assert.match(appSource, /window\.confirm\(`「\$\{contact\.name\}」を削除しますか？`\)/);
  assert.match(appSource, /登録されている連絡先はありません/);
  assert.match(appSource, /disabled=\{state\.saving\}/);
  assert.match(styles, /\.ride-guidance-editor \{/);
  assert.match(styles, /\.ride-guidance-row__actions \{/);
  assert.match(styles, /\.ride-guidance-groups \{ display: grid; grid-template-columns: repeat\(2/);
});

test("expanded customer rail uses a smaller wrapping subcategory label while collapsed stays at 20px", () => {
  assert.match(styles, /\.customer-app:not\(\.customer-app--category-collapsed\) \.subcategory-nav button \{[\s\S]*padding-inline: 4px;[\s\S]*font-size: 18px;[\s\S]*line-height: 1\.18;[\s\S]*white-space: normal;/);
  const subcategoryCss = styles.slice(styles.indexOf(".subcategory-nav button {"), styles.indexOf(".subcategory-nav button.is-active"));
  assert.match(subcategoryCss, /font-size: 20px/);
  assert.match(subcategoryCss, /min-height: 52px/);
});

test("all customer product lists use a shared compact header", () => {
  const menuHeaderCss = styles.slice(styles.indexOf(".menu-heading {"), styles.indexOf(".menu-list {"));
  assert.match(menuHeaderCss, /\.menu-heading \{[\s\S]*min-height: 44px[\s\S]*display: flex/);
  assert.match(menuHeaderCss, /\.menu-heading__breadcrumb strong \{[\s\S]*font-size: 2em/);
  assert.doesNotMatch(menuHeaderCss, /menu-heading__body|menu-heading h1|menu-heading p/);
  assert.match(menuHeaderCss, /\.subcategory-nav \{[\s\S]*grid-template-columns: repeat\(4/);
  assert.match(menuHeaderCss, /padding: 6px 0 8px/);
  assert.match(styles, /\.empty-state \{/);
  assert.match(customerScreen, /menu-heading/);
  assert.match(customerScreen, /currentItems\.length/);
  assert.match(customerScreen, /このカテゴリの商品はまだありません/);
});

test("shochu uses a zero-based multi-quantity serving popup", () => {
  assert.match(customerScreen, /drink-jump-nav/);
  assert.match(customerScreen, /scrollIntoView/);
  assert.match(customerScreen, /menu-section-divider/);
  assert.match(customerScreen, /const \[shochuSelection, setShochuSelection\] = useState\(null\)/);
  assert.match(customerScreen, /const openShochuSelection = \(item\)/);
  assert.match(customerScreen, /quantities: Object\.fromEntries\(options\.map\(\(option\) => \[option\.servingOptionId, 0\]\)\)/);
  assert.match(customerScreen, /const adjustShochuQuantity = \(optionId, delta\)/);
  assert.match(customerScreen, /const commitShochuSelection = \(\)/);
  assert.match(customerScreen, /shochuSelectionTotal/);
  assert.match(appSource, /ロック/);
  assert.match(appSource, /水割り/);
  assert.match(appSource, /ソーダ割り/);
  assert.match(appSource, /お湯割り/);
  assert.doesNotMatch(customerScreen, /shochu-selection-summary|今回の選択/);
  assert.match(customerScreen, /点をカートに追加/);
  assert.match(customerScreen, /shochu-selection-footer/);
  assert.match(customerScreen, /disabled=\{!shochuSelectionTotal\}/);
  assert.match(customerScreen, /addSelection\(shochuSelectionItem, \{ servingOption: option \}, quantity\)/);
  assert.match(customerScreen, /onClose=\{\(\) => setShochuSelection\(null\)\}/);
  assert.match(customerScreen, /onClick=\{\(\) => setShochuSelection\(null\)\}>キャンセル/);
  assert.match(customerScreen, /className="modal--shochu" footer=\{<div className="shochu-selection-footer">/);
  assert.match(customerScreen, /className="shochu-serving-button"/);
  assert.match(customerScreen, /className="shochu-quantity-control"/);
  const adjustBlock = customerScreen.slice(customerScreen.indexOf("const adjustShochuQuantity"), customerScreen.indexOf("const commitShochuSelection"));
  assert.doesNotMatch(adjustBlock, /addSelection|setShochuSelection\(null\)/);
  const commitBlock = customerScreen.slice(customerScreen.indexOf("const commitShochuSelection"), customerScreen.indexOf("const addSakeSelection"));
  assert.match(commitBlock, /quantity > 0/);
  assert.match(commitBlock, /setShochuSelection\(null\)/);
  assert.doesNotMatch(customerScreen, /shochu-serving-status|shochuSelections|expandedShochuId/);
  assert.doesNotMatch(customerScreen, /addSelection\(item, \{ servingOption: option \}\)/);
  assert.match(styles, /\.modal--shochu \{[^}]*overflow: visible/);
  assert.match(styles, /\.modal--shochu:not\(\.modal--kushikatsu\) \{ width: min\(800px, 94vw\);[\s\S]*overflow: hidden; display: flex/);
  assert.match(styles, /\.modal--shochu:not\(\.modal--kushikatsu\) \.modal__body \{[\s\S]*overflow-y: auto/);
  assert.match(styles, /\.modal--shochu:not\(\.modal--kushikatsu\) \.modal__footer \{ flex: 0 0 auto/);
  assert.match(styles, /\.shochu-selection-row \{[\s\S]*grid-template-columns/);
  assert.match(styles, /\.shochu-quantity-control \{[\s\S]*min-height: 52px/);
  assert.match(styles, /\.shochu-quantity-control button \{[\s\S]*display: grid/);
  assert.match(styles, /\.shochu-selection-row \{[\s\S]*touch-action: manipulation[\s\S]*user-select: none[\s\S]*-webkit-tap-highlight-color: transparent/);
  assert.match(styles, /\.shochu-quantity-control \{[\s\S]*touch-action: manipulation[\s\S]*user-select: none[\s\S]*-webkit-tap-highlight-color: transparent/);
  assert.match(styles, /\.shochu-quantity-control button \{[\s\S]*touch-action: manipulation[\s\S]*user-select: none[\s\S]*-webkit-tap-highlight-color: transparent/);
  assert.match(styles, /\.shochu-selection-footer \{[\s\S]*display: flex[\s\S]*visibility: visible[\s\S]*opacity: 1/);
  assert.match(styles, /\.shochu-selection-footer \{[\s\S]*border: 2px solid var\(--line\)[\s\S]*background: #fff/);
  assert.match(styles, /\.modal--shochu \.modal-actions \{[\s\S]*width: 100%[\s\S]*grid-template-columns/);
  assert.match(styles, /\.modal--shochu \.modal-actions \.button \{[\s\S]*min-width: 0[\s\S]*width: 100%/);
  assert.match(styles, /\.modal--shochu \.modal__header h2 \{[\s\S]*font-size: clamp/);
  assert.match(styles, /\.modal--shochu \.modal__header h2 \{[\s\S]*flex: 1 1 auto[\s\S]*min-width: 0[\s\S]*white-space: nowrap[\s\S]*word-break: keep-all/);
  assert.match(styles, /\.modal--shochu \{[\s\S]*max-height: calc\(100dvh - 40px\)[\s\S]*overflow: visible/);
  assert.match(styles, /@media \(orientation: landscape\) and \(max-height: 700px\)/);
  assert.match(styles, /\.modal--shochu \{[\s\S]*max-height: calc\(100dvh - 16px\)/);
  assert.match(styles, /\.shochu-selection-row \{[\s\S]*min-height: 54px/);
  assert.match(styles, /\.shochu-quantity-control \{[\s\S]*min-height: 52px/);
  assert.match(styles, /\.modal--shochu:not\(\.modal--kushikatsu\) \.shochu-quantity-control \{ grid-template-columns: 72px 1fr 72px; min-height: 68px/);
  assert.match(styles, /\.modal--shochu:not\(\.modal--kushikatsu\) \.modal-actions \.button \{ min-height: 66px/);
  assert.doesNotMatch(styles, /user-scalable\s*=\s*no/);
});

test("sake rows use one serving-method button and a direct serving-temperature popup", () => {
  assert.match(customerScreen, /sake-serve-button/);
  assert.match(customerScreen, /提供方法を選ぶ/);
  assert.match(customerScreen, /sakeSelection/);
  assert.match(customerScreen, /提供方法・温度を選ぶ/);
  assert.match(customerScreen, /sake-serving-row/);
  assert.match(customerScreen, /sake-temperature-options/);
  assert.match(customerScreen, /sake-temperature-fixed/);
  assert.match(customerScreen, /variant\.name === "グラス"/);
  assert.match(customerScreen, /variantId: null, temperature: null/);
  assert.match(customerScreen, /sakeSelectionError/);
  assert.match(customerScreen, /提供形態と温度を選択してください/);
  assert.match(customerScreen, /onClick=\{addSakeSelection\}/);
  assert.match(customerScreen, /selectedSakeVariant && sakeSelection\.temperature && sakeTemperatureOptions\(selectedSakeVariant\)\.includes\(sakeSelection\.temperature\)/);
  assert.match(appSource, /addSelection\(selectedSakeItem, \{ variant: selectedSakeVariant, temperature: sakeSelection\.temperature \}\)/);
  assert.match(appSource, /const addSelection = \(item, selection = \{\}, quantity = 1\)/);
  assert.match(customerScreen, /<PriceDisplay priceYen=\{variant\.priceYen\} \/>/);
  assert.match(customerScreen, /onClick=\{addSakeSelection\}>これにする<\/button>/);
  assert.match(customerScreen, /className="modal--sake" footer=\{<div className="modal-actions">/);
  assert.match(styles, /\.modal--sake\.modal--wide \{ width: min\(1060px, 94vw\)/);
  assert.match(styles, /\.modal--sake \.modal__body \{[\s\S]*overflow-y: auto/);
  assert.match(styles, /\.modal--sake \.modal__footer \{ flex: 0 0 auto/);
  assert.match(styles, /\.modal--sake\.modal--wide,\s*\.modal--shochu:not\(\.modal--kushikatsu\) \{ margin-top: 8px; max-height: calc\(100dvh - 32px\)/);
  assert.match(styles, /\.modal--sake \.sake-serving-option__heading b \{ font-size: 22px/);
  assert.match(styles, /\.modal--sake \.sake-temperature-options button \{ min-height: 68px; font-size: 20px/);
  assert.match(customerScreen, /temperature/);
  assert.match(appSource, /const SAKE_COLD = "冷酒"/);
  assert.match(appSource, /const SAKE_WARM = "燗酒"/);
  assert.match(appSource, /sakeTemperatureOptions\(variant\)/);
  assert.match(appSource, /sakeAutoTemperature\(variant\)/);
  assert.match(appSource, /sakeTemperatureLabel\(temperature\)/);
  assert.match(customerScreen, /allowedTemperatures\.includes\(sakeSelection\.temperature\)/);
  assert.doesNotMatch(customerScreen, /sake-selection-confirm/);
  assert.doesNotMatch(customerScreen, /selectedSakeTemperatures/);
  assert.match(customerScreen, /className="add-button"/);
});

test("sake variant temperature restrictions and kitchen labels are applied per variant", () => {
  assert.match(appSource, /if \(variant\?\.name === "グラス"\) return \[SAKE_COLD\]/);
  assert.match(appSource, /return options\.length === 1 \? options\[0\] : null/);
  assert.match(customerScreen, /sakeTemperatureOptions\(variant\)\.length === 1/);
  assert.match(customerScreen, /sakeTemperatureOptions\(variant\)\.map\(\(temperature\)/);
  assert.match(customerScreen, /sakeTemperatureLabel\(sakeTemperatureOptions\(variant\)\[0\], true\)/);
  assert.match(customerScreen, /if \(!sakeTemperatureOptions\(variant\)\.includes\(temperature\)\) return/);
  assert.match(appSource, /addSelection\(selectedSakeItem, \{ variant: selectedSakeVariant, temperature: sakeSelection\.temperature \}\)/);
  const kitchenBlock = appSource.slice(appSource.indexOf("function kitchenSakeVariantName"), appSource.indexOf("function PriceDisplay"));
  assert.match(kitchenBlock, /徳利/);
  assert.match(kitchenBlock, /\[12\]合/);
  assert.match(kitchenBlock, /rawName\.replace\(\/\\s\+\/g, ""\)/);
  assert.match(kitchenBlock, /return "グラス"/);
  assert.match(kitchenBlock, /match\(\/\^\(\?:徳利\)\?\(\[12\]合\)\(\?:\\d\+ml\)\?\$\//);
  assert.match(kitchenBlock, /const shortVariantName = kitchenSakeVariantName\(value\)/);
  assert.match(kitchenBlock, /temperature === "冷酒" \? "冷"/);
  assert.match(kitchenBlock, /temperature === "燗酒" \? "燗"/);
  assert.match(kitchenBlock, /join\("・"\)/);
  assert.doesNotMatch(kitchenBlock, /variantVolumeSnapshot|volumeLabel/);
  assert.match(appSource, /const suffix = kitchenSelectionSuffix\(item\)/);
});

test("sake serving popup keeps shared price formatting and A90 tap sizing", () => {
  assert.match(styles, /\.sake-serve-button \{[\s\S]*min-height: 58px/);
  assert.match(styles, /\.modal--sake \{[\s\S]*align-self: start[\s\S]*overflow: hidden/);
  assert.match(styles, /\.sake-serving-row \{[\s\S]*grid-template-columns/);
  assert.match(styles, /\.sake-temperature-options button \{[\s\S]*min-height: 56px/);
  assert.match(styles, /\.sake-serving-option \.menu-price \{[\s\S]*align-items: flex-end/);
  assert.match(styles, /\.sake-menu-row \.product-image-button \{[\s\S]*width: 64px/);
  assert.match(styles, /\.sake-serving-option \{[\s\S]*min-height: 72px/);
});

test("sake product details and order snapshots retain the shared selection model", () => {
  assert.match(customerScreen, /setDetailItem\(item\)/);
  assert.match(customerScreen, /<Modal title=\{detailItem\.name\}/);
  assert.match(customerScreen, /variantNameSnapshot|servingOptionNameSnapshot/);
  assert.match(customerScreen, /variantVolumeSnapshot/);
  assert.match(customerScreen, /temperatureSnapshot/);
  assert.match(customerScreen, /unitPriceSnapshot: row\.variant\?\.priceYen/);
});

test("串カツ keeps the selected variant visible without a second flavor picker", () => {
  assert.match(appSource, /KUSHIKATSU_MENU_ITEM_ID/);
  assert.match(appSource, /串カツは各種類2本からご注文いただけます/);
  assert.match(appSource, /variant: kushikatsuSelectionVariant/);
  assert.match(customerScreen, /<Modal title="串カツ"/);
  assert.match(customerScreen, /titleExtra=\{<span className="kushikatsu-modal-instruction">数量を選択してください<\/span>\}/);
  assert.doesNotMatch(customerScreen, /選択中の味/);
  assert.match(customerScreen, /kushikatsuSelectionVariant\?\.name/);
  assert.match(customerScreen, /1本 税込 \{yen\(kushikatsuSelectionVariant\?\.priceYen\)\}/);
  assert.match(customerScreen, /className="kushikatsu-unit-price"/);
  assert.match(styles, /\.kushikatsu-unit-price \{[\s\S]*display: flex[\s\S]*justify-content: space-between/);
  assert.match(styles, /\.kushikatsu-quantity-row \{[\s\S]*width: 100%[\s\S]*display: flex[\s\S]*box-sizing: border-box/);
  assert.match(styles, /\.kushikatsu-quantity-row > b \{[\s\S]*min-width: 0[\s\S]*flex: 1 1 auto/);
  assert.match(styles, /\.kushikatsu-quantity-row \.shochu-quantity-control \{[\s\S]*flex: 0 0 220px[\s\S]*64px 92px 64px[\s\S]*min-height: 64px/);
  assert.match(styles, /\.kushikatsu-quantity-row \.shochu-quantity-control > button \{[\s\S]*width: 64px[\s\S]*min-width: 64px[\s\S]*max-width: 64px[\s\S]*padding: 0[\s\S]*margin: 0/);
  assert.match(styles, /\.kushikatsu-quantity-row \.shochu-quantity-control > b \{[\s\S]*width: 92px[\s\S]*min-width: 92px[\s\S]*max-width: 92px[\s\S]*height: 64px/);
  assert.match(styles, /@media \(max-width: 600px\)[\s\S]*flex-basis: 200px[\s\S]*56px 88px 56px/);
  assert.doesNotMatch(customerScreen, /kushikatsu-variant-list|味を1種類選び/);
  assert.match(customerScreen, /className="add-button" onClick=\{\(\) => openKushikatsuSelection\(item\)\}/);
  assert.match(customerScreen, /\{kushikatsuSelection\.quantity\}本をカートに追加/);
  assert.doesNotMatch(customerScreen, /kushikatsuSelectionVariant\?\.name\} \{kushikatsuSelection\.quantity\}本をカートに追加/);
  assert.match(customerScreen, /taxExcludedYen\(item\.price\)/);
});

test("customer expands only the menu model for individual kushikatsu rows", () => {
  assert.match(appSource, /function expandCustomerMenuItems/);
  assert.match(appSource, /isKushikatsuVirtual: true/);
  assert.match(appSource, /menuItemId: item\.id/);
  assert.match(customerScreen, /expandCustomerMenuItems\(menuItems\.filter/);
  assert.match(customerScreen, /item\.isKushikatsuVirtual === true/);
  assert.match(customerScreen, /本数を選ぶ/);
  assert.doesNotMatch(appSource, /id: "special", name: "名物"/);
  assert.match(appSource, /\{ id: "special-hine", name: "名物", categoryIds/);
  assert.match(appSource, /\{ id: "special-reservation", name: "予約限定", categoryIds/);
});

test("customer detail affordance requires an actual image", () => {
  assert.match(customerScreen, /const canOpenDetail = Boolean\(item\.detail\?\.imageUri \|\| item\.imageUri\)/);
  assert.match(customerScreen, /className="menu-row__detail-hint__action">タップで明細<\/span>/);
  assert.match(customerScreen, /disabled=\{!canOpenDetail\}/);
});

test("drink list comments reuse description without changing detail behavior", () => {
  assert.match(appSource, /const isDrink = currentMajorCategory\.id === "drink"/);
  assert.match(customerScreen, /const listComment = isDrink \? item\.description\?\.trim\(\) : ""/);
  assert.match(customerScreen, /className="menu-row__detail-hint__action">タップで明細<\/span>/);
  assert.match(customerScreen, /className="menu-row__detail-hint__separator" aria-hidden="true">｜<\/span>/);
  assert.match(customerScreen, /className="menu-row__comment">\{listComment\}<\/span>/);
  assert.match(styles, /\.menu-row__detail-hint \{[\s\S]*display: flex[\s\S]*min-width: 0/);
  assert.match(styles, /\.menu-row__detail-hint__action, \.menu-row__detail-hint__separator \{[\s\S]*flex: 0 0 auto/);
  assert.match(styles, /\.menu-row__comment \{ min-width: 0;[\s\S]*text-overflow: ellipsis[\s\S]*white-space: nowrap/);
  assert.match(appSource, /detailItem\.detail\?\.description \|\| detailItem\.description/);
  assert.match(appSource, /descriptionFieldLabel = editingMenuIsFood \? "料理説明" : "商品説明／一言コメント"/);
  assert.match(customerScreen, /const canOpenDetail = Boolean\(item\.detail\?\.imageUri \|\| item\.imageUri\)/);
});

test("food rows show a clamped description and reserve the thumbnail column only for real images", () => {
  assert.match(appSource, /const isFood = currentMajorCategory\.id === "food"/);
  assert.match(customerScreen, /const showListImage = listImageVisible\(item\) && Boolean\(item\.imageUri\)/);
  assert.match(customerScreen, /const foodDescription = isFood \? item\.description\?\.trim\(\) : ""/);
  assert.match(customerScreen, /className=\{`menu-row \$\{isFood \? "food-menu-row" : ""\}/);
  assert.match(customerScreen, /className="menu-row__food-description">\{foodDescription\}<\/small>/);
  assert.match(styles, /\.food-menu-row \{[\s\S]*grid-template-columns: 60px 72px minmax\(0, 1fr\) 104px 160px[\s\S]*min-height: 112px/);
  assert.match(styles, /\.food-menu-row\.menu-row--no-image \{ grid-template-columns: 60px minmax\(0, 1fr\) 104px 160px; \}/);
  assert.match(styles, /\.food-menu-row \.product-image-button \{ width: 72px; height: 88px; \}/);
  assert.match(styles, /\.menu-row__food-description \{[\s\S]*font-weight: 400[\s\S]*-webkit-line-clamp: 2/);
  assert.match(styles, /@media \(max-width: 1350px\)[\s\S]*\.food-menu-row \{ min-height: 108px; grid-template-columns: 48px 72px minmax\(140px, 1fr\) 86px 156px/);
  assert.match(appSource, /const descriptionFieldLabel = editingMenuIsFood \? "料理説明" : "商品説明／一言コメント"/);
  assert.match(appSource, /\{descriptionFieldLabel\}<textarea name="description"/);
});

test("reservation-only customer rows show only the reservation label", () => {
  assert.match(customerScreen, /className="reservation-only-label"><b>予約限定<\/b><\/div>/);
  assert.doesNotMatch(customerScreen, /スタッフへお声がけください/);
});

test("image layout editor rotates only the inner image and preserves layout controls", () => {
  const transformSource = appSource.slice(appSource.indexOf("function imageLayoutTransform"), appSource.indexOf("function listImageVisible"));
  assert.match(transformSource, /transform: `translate\(\$\{Number\(layout\.positionX\) \* 100\}%\, \$\{Number\(layout\.positionY\) \* 100\}%\) scale\(\$\{Number\(layout\.scale\)\}\) rotate\(\$\{Number\(layout\.rotation\)\}deg\)`/);
  assert.doesNotMatch(transformSource, /image-layout-editor__frame/);
  const editor = appSource.slice(appSource.indexOf("function ImageLayoutEditor"), appSource.indexOf("function AdminScreen"));
  assert.match(editor, /<img src=\{imageUri\} alt="" draggable="false" style=\{imageLayoutTransform\(layout\)\} \/>/);
  assert.match(editor, /角度 <output>\{layout\.rotation\.toFixed\(1\)\}°<\/output><input type="range" min="-15" max="15" step="0\.1" value=\{layout\.rotation\}/);
  assert.match(editor, /adjust\("rotation", -1\)/);
  assert.match(editor, /adjust\("rotation", -0\.1\)/);
  assert.match(editor, /adjust\("rotation", 0\.1\)/);
  assert.match(editor, /adjust\("rotation", 1\)/);
  assert.match(editor, /positionY/);
  assert.match(editor, /positionX/);
  assert.match(editor, /scale/);
  assert.match(editor, /thumbnail.*detail|\[\["thumbnail", "一覧用"\].*\["detail", "詳細用"\]\]/s);
  assert.match(editor, /const handleKeyDown = \(event\) => \{[\s\S]*event\.key === "Escape"[\s\S]*event\.preventDefault\(\)[\s\S]*onClose\(\)[\s\S]*\};[\s\S]*window\.addEventListener\("keydown", handleKeyDown\);[\s\S]*return \(\) => window\.removeEventListener\("keydown", handleKeyDown\);/);
  assert.match(editor, /const save = async \(\) => \{[\s\S]*saveAdminImageLayouts\(/);
  assert.match(editor, /リセット/);
  assert.match(editor, /キャンセル/);
  assert.match(editor, /保存/);
  assert.match(editor, /rotation: layout\.rotation/);
  assert.match(styles, /\.image-layout-editor__frame \{[^}]*overflow: hidden[^}]*\}/);
  assert.doesNotMatch(styles, /\.image-layout-editor__frame \{[^}]*transform:/);
});

test("admin menu thumbnails apply the saved thumbnail layout in the same portrait frame as the editor", () => {
  assert.match(appSource, /className="admin-menu-card__image">\{item\.imageUri \|\| item\.detail\?\.imageUri \? <div className="admin-menu-card__image-frame"><img src=\{item\.imageUri \|\| item\.detail\.imageUri\} alt="" style=\{imageLayoutStyle\(item, "thumbnail"\)\} \/><\/div>/);
  assert.match(styles, /\.admin-menu-card__image-frame \{ width: 76\.1905%; height: 100%; overflow: hidden; \}/);
  assert.match(styles, /\.image-layout-editor__frame \{[^}]*aspect-ratio: 64 \/ 84/);
  assert.match(customerScreen, /imageLayoutStyle\(item, "thumbnail"\)/);
  assert.match(customerScreen, /imageLayoutStyle\(detailItem, "detail"\)/);
});

test("shared menu editor saves the detail image URI without replacing the list URI or image layouts", () => {
  assert.match(appSource, /<ProductImageUriField name="detailImageUri" label="詳細画像URI" initialUri=\{editingMenu\?\.detail\?\.imageUri \?\? ""\} fallbackUri=\{editingMenu\?\.imageUri \?\? ""\} \/>/);
  assert.doesNotMatch(appSource, /<ProductImageLocation uri=\{editingMenu\?\.detail\?\.imageUri\}/);

  const sharedSaveStart = appSource.indexOf("const saveMenuEditor = async");
  const sharedSaveEnd = appSource.indexOf("const refreshAdminCatalog =", sharedSaveStart);
  const sharedSave = appSource.slice(sharedSaveStart, sharedSaveEnd);
  assert.match(sharedSave, /const targetId = editingMenuId \?\? \(menuCreateIdRef\.current \?\?= makeId\("menu"\)\)/);
  assert.match(sharedSave, /imageUri: form\.get\("imageUri"\)\?\.toString\(\)\.trim\(\) \|\| undefined,/);
  assert.match(sharedSave, /imageUri: form\.get\("detailImageUri"\)\?\.toString\(\)\.trim\(\) \|\| undefined,/);
  const menuPatch = sharedSave.slice(sharedSave.indexOf("const patch = {"), sharedSave.indexOf("const nextItem ="));
  assert.doesNotMatch(menuPatch, /imageLayouts\s*:/);
});
test("admin detail editing covers every displayed tasting field", () => {
  assert.match(appSource, /name="aroma"/);
  assert.match(appSource, /name="sweetness"/);
  assert.match(appSource, /name="finish"/);
  assert.match(appSource, /form\.get\("aroma"\)/);
  assert.match(appSource, /form\.get\("sweetness"\)/);
  assert.match(appSource, /form\.get\("finish"\)/);
});

test("admin devices screen includes safe communication diagnostics without exposing request bodies", () => {
  assert.match(appSource, /fetchAdminDiagnostics/);
  assert.match(appSource, /communication-diagnostics/);
  assert.match(appSource, /diagnosticExpanded/);
  assert.match(appSource, /通信状態：正常/);
  assert.match(appSource, /詳細を見る/);
  assert.match(appSource, /Number\(entry\.status\) >= 400/);
  assert.match(appSource, /setDiagnosticExpanded\(true\)/);
  assert.match(appSource, /LAN IPv4/);
  assert.match(appSource, /schemaVersion/);
  assert.match(appSource, /直近の注文送信/);
  assert.match(appSource, /直近の注文取得/);
  assert.match(appSource, /再起動後の注文送信記録なし/);
  assert.match(appSource, /再起動後の注文取得記録なし/);
  assert.doesNotMatch(appSource, /実リクエスト未確認/);
  assert.ok(appSource.indexOf("pairing-admin-panel") < appSource.indexOf("communication-diagnostics"));
  assert.match(styles, /\.communication-diagnostics \{/);
  assert.match(styles, /\.communication-diagnostics__summary/);
  assert.match(styles, /\.communication-diagnostics__status-dot\.is-ok/);
  assert.match(styles, /\.communication-diagnostics\.has-issue/);
  assert.match(styles, /\.communication-diagnostics__results/);
});

test("API customer orders stay in memory instead of localStorage state", () => {
  const apiBranch = customerScreen.slice(customerScreen.indexOf('if (apiMode) {'), customerScreen.indexOf('      const order = {', customerScreen.indexOf('if (apiMode) {')));
  assert.match(apiBranch, /setApiOrders/);
  assert.doesNotMatch(apiBranch, /updateState/);
  assert.match(customerScreen, /const customerHistory = \(apiMode \? apiOrders : state\.orders\)/);
  assert.match(customerScreen, /\.filter\(\(order\) => apiMode \|\| order\.tableId === device\.tableId\)/);
  assert.match(customerScreen, /disabled=\{submitting\}/);
});

test("production customer history loads authenticated SQLite data and fails closed", () => {
  assert.match(customerScreen, /modal !== "history"/);
  assert.match(customerScreen, /orderClient\.getHistory\(\)/);
  assert.match(customerScreen, /orders\.map\(mapCustomerHistoryOrder\)/);
  assert.match(customerScreen, /apiMode && apiHistoryState\.error/);
  assert.match(customerScreen, /注文履歴を取得できません。/);
  assert.match(appSource, /order\.status === "completed" \? "提供済み"/);
});

test("customer success notice clears itself without clearing other notices", () => {
  assert.match(customerScreen, /if \(notice\?\.kind !== "success" \|\| notice\.staffCallId\) return undefined/);
  assert.match(customerScreen, /window\.setTimeout/);
  assert.match(customerScreen, /current\?\.kind === "success" \? null : current/);
  assert.match(customerScreen, /\}, 4000\);/);
  assert.match(customerScreen, /window\.clearTimeout\(timeoutId\)/);
});

test("API customer display uses the server-assigned table", () => {
  assert.match(customerScreen, /customerDeviceConfig/);
  assert.match(customerScreen, /customerDeviceConfig\?\.tableId/);
  assert.match(customerScreen, /const device = assignedTableId/);
});

test("kitchen new-order badge follows active orders, not staff calls", () => {
  const kitchenScreen = appSource.slice(appSource.indexOf("function KitchenScreen"), appSource.indexOf("function HistoryScreen"));
  const staffShell = appSource.slice(appSource.indexOf("function StaffShell"), appSource.indexOf("function KitchenScreen"));
  assert.match(kitchenScreen, /newOrderCount=\{activeOrders\.length\}/);
  assert.match(staffShell, /newOrderCount = 0/);
  assert.match(staffShell, /newOrderCount \? <b className="badge">\{newOrderCount\}<\/b>/);
  assert.doesNotMatch(staffShell, /activeCalls \? <b className="badge">/);
});

test("kitchen does not present local fallback as a persisted empty state", () => {
  const kitchenBootstrap = appSource.slice(appSource.indexOf('useEffect(() => {', appSource.indexOf('export function App')), appSource.indexOf('const serveKitchenItem'));
  assert.match(kitchenBootstrap, /!kitchenApiConfigured\(window\)/);
  assert.match(kitchenBootstrap, /WARUN_ORDER_MODE === "demo"/);
  assert.match(kitchenBootstrap, /error: true, orders: \[\]/);
});

test("kitchen API state changes reach the memoized screen", () => {
  assert.match(appSource, /customerDeviceConfig, kitchenApiState, pairingError/);
  assert.match(appSource, /注文情報を取得できません。/);
});

test("kitchen serving keeps the session and does not expose a serve-triggered reset action", () => {
  const kitchenScreen = appSource.slice(appSource.indexOf("function KitchenScreen"), appSource.indexOf("function HistoryScreen"));
  assert.match(kitchenScreen, /openSessions|apiState\.sessions/);
  assert.match(kitchenScreen, /sessionId/);
  assert.doesNotMatch(kitchenScreen, /席をリセット/);
  assert.doesNotMatch(kitchenScreen, /onCloseSession/);
});

test("customer history refreshes when the authenticated SSE invalidation arrives", () => {
  assert.match(customerScreen, /orderClient\.subscribeInvalidations/);
  assert.match(customerScreen, /setHistoryRefreshKey/);
  assert.match(customerScreen, /historyRefreshKey/);
});

test("production history requires an authenticated API and never falls back to local state", () => {
  const historyScreen = appSource.slice(appSource.indexOf("function HistoryScreen"), appSource.indexOf("const adminTabs"));
  const historyRoute = appSource.slice(appSource.indexOf('if (route === "/history")'), appSource.indexOf('if (route.startsWith("/admin/"))'));
  assert.match(historyScreen, /apiMode \? remoteState\.orders/);
  assert.match(historyScreen, /typeof loadHistory !== "function"/);
  assert.match(historyRoute, /WARUN_ORDER_MODE === "demo"/);
  assert.match(historyRoute, /fetchKitchenOrderHistory/);
  assert.match(historyRoute, /apiMode=\{!explicitDemo\}/);
  assert.match(historyScreen, /completedToday\.length/);
});

test('session limited menu administration separates item mode from current visit permission', async () => {
  const adminApi = await readFile(new URL('../src/admin-pairing.js', import.meta.url), 'utf8');
  assert.match(appSource, /customerVisibilityMode.*per_session/);
  assert.match(appSource, /来店ごとに許可/);
  assert.match(appSource, /SessionMenuAccessPanel/);
  assert.match(appSource, /来店開始・許可/);
  assert.match(appSource, /注文のない来店を終了/);
  assert.match(appSource, /canCloseEmptySession/);
  assert.match(appSource, /現在の来店・開始/);
  assert.match(appSource, /期待|現在の来店に許可/);
  assert.match(appSource, /expectedMenuItemIds: table\.openSession\.menuItemIds/);
  assert.match(adminApi, /admin\/session-menu-access\/grants/);
  assert.match(adminApi, /confirmAndCloseAdminEmptySession/);
});


test("admin menu availability label distinguishes hidden, sold out, and available states", () => {
  assert.deepEqual(adminMenuAvailability({ isActive: false, isSoldOut: false }), { label: "客席非表示", className: "is-inactive" });
  assert.deepEqual(adminMenuAvailability({ isActive: true, isSoldOut: true }), { label: "売り切れ", className: "is-soldout" });
  assert.deepEqual(adminMenuAvailability({ isActive: true, isSoldOut: false }), { label: "販売中", className: "" });
  assert.deepEqual(adminMenuAvailability({ isActive: false, isSoldOut: true }), { label: "客席非表示", className: "is-inactive" });
  assert.ok(appSource.includes("adminMenuAvailability(item).label"));
  assert.equal((appSource.match(/name="isActive"[^>]*\/> 客席に表示/g) ?? []).length, 1);
});
