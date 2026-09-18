import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bell,
  Check,
  CheckCircle,
  ChefHat,
  Car,
  ClipboardText,
  ClockCounterClockwise,
  CurrencyJpy,
  Gear,
  ListBullets,
  Minus,
  Monitor,
  Plus,
  Receipt,
  WifiHigh,
  WifiSlash,
  X,
} from "@phosphor-icons/react";
import { createCustomerOrderClient, resolveOrderApiConfig } from "./order-outbox.js";
import { claimCustomerDevice, createIndexedDbCredentialStore, loadOrCreateCustomerDevice, pairingClaimErrorMessage, runtimeForCustomerCredentials } from "./device-credentials.js";
import { customerOrderErrorCategory, customerOrderNoticeFromOutboxEvent } from "./customer-order-notice.js";
import { AdminPairingError, configuredAdminToken, fetchAdminDiagnostics, fetchAdminMenu, fetchAdminOrderHistory, fetchAdminPairingPreflight, issueCustomerPairingCode, revokeAdminDevice, saveAdminMenuItem, saveAdminImageLayouts, saveAdminCategory, saveAdminMenuOrdering } from "./admin-pairing.js";
import { closeKitchenTableSession, fetchKitchenOrderHistory, fetchKitchenSnapshot, kitchenApiConfigured, markKitchenItemServed } from "./kitchen-api.js";
import { bootstrapCustomerOrderClient } from "./customer-bootstrap.js";
import { taxExcludedYen } from "./pricing.js";
import { pairingCodeQrSvg } from "./qr-code.js";
import { CUSTOMER_TEST_THEME, normalizeCustomerTheme } from "./customer-theme.js";

const STORAGE_KEY = "izakaya-order-prototype-v3";

function formatPairingCode(code) {
  return code.match(/.{1,4}/g)?.join("-") ?? code;
}

function normalizePairingCode(code) {
  return code.replace(/[\s-]/g, "").toUpperCase();
}

function pairingPreflightBlockMessage(preflight) {
  if (!preflight) return "preflightを完了するまでQRを発行できません。";
  if (preflight.database?.target !== "safe-copy" || preflight.database?.isProduction) {
    return "safe-copy設定不一致：productionまたは別DBではQRを発行できません。";
  }
  if (preflight.server?.webOriginMatches !== true) {
    return "Web/API URL不一致：現在のLAN URLで管理画面を開き直してください。";
  }
  if (preflight.pairing?.blockedReason === "NO_AVAILABLE_TABLE") {
    return "空きテーブルがありません。既存端末の割当を解除せずに発行できるテーブルを確認してください。";
  }
  return preflight.pairing?.canIssue === true ? "" : "pairing code発行可能状態ではありません。";
}

function pairingErrorMessage(error) {
  if (error instanceof AdminPairingError) {
    if (error.code === "AUTH_TOKEN_MISMATCH" || error.status === 401) return "401：管理者token不一致。実行中safe-copyの管理者認証設定を確認してください。";
    if (error.code === "TABLE_CONFLICT" || error.status === 409) return "409：このテーブルは既存端末に割当済みです。空きテーブルを選択してください。";
    if (error.code === "API_UNAVAILABLE" || error.status === 503) return "503：管理APIが停止しています。API healthを確認してください。";
    if (error.code === "PAIRING_URL_INVALID") return "Web/API URL不一致：現在のLAN pairing URLを取得できませんでした。";
    if (error.code === "DEVICE_NOT_FOUND" || error.status === 404) return "接続解除対象の端末が見つかりません。preflightを再確認してください。";
  }
  return "pairing preflightまたはQR生成に失敗しました。画面の詳細を確認してください。";
}

const DEFAULT_KITCHEN_MENU_ALIASES = {
  edamame: "枝豆",
  dashimaki: "だし巻き",
  beer: "生ビール",
  lemon: "レモンサワー",
  karaage: "唐揚げ",
  yakitori: "もも串",
  otoshi: "お通し",
};

function kitchenMenuName(item, registeredAliases) {
  const base = item.kitchenAlias || registeredAliases[item.menuItemId] || DEFAULT_KITCHEN_MENU_ALIASES[item.menuItemId] || item.nameSnapshot;
  const suffix = kitchenSelectionSuffix(item);
  return suffix ? `${base}（${suffix}）` : base;
}

const defaultState = {
  categories: [
    { id: "recommended", name: "おすすめ", sortOrder: 1, isVisible: true },
    { id: "beer", name: "ビール", sortOrder: 2, isVisible: true },
    { id: "snack", name: "おつまみ", sortOrder: 3, isVisible: true },
    { id: "grill", name: "焼き物", sortOrder: 4, isVisible: true },
    { id: "drink", name: "ドリンク", sortOrder: 5, isVisible: true },
  ],
  menuItems: [
    { id: "edamame", categoryId: "recommended", name: "枝豆", description: "まずは定番。シンプルな塩茹で。", price: 380, isSoldOut: false, sortOrder: 1 },
    { id: "dashimaki", categoryId: "recommended", name: "だし巻き玉子", description: "ふんわり出汁が香るやさしい味わい。", price: 580, isSoldOut: false, sortOrder: 2 },
    { id: "beer", categoryId: "beer", name: "生ビール", description: "のどごし爽快。キンキンに冷えてます。", price: 680, isSoldOut: false, sortOrder: 1 },
    { id: "lemon", categoryId: "drink", name: "レモンサワー", description: "すっきり爽やか。人気の定番サワー。", price: 550, isSoldOut: false, sortOrder: 1 },
    { id: "karaage", categoryId: "snack", name: "唐揚げ", description: "特製ダレに漬け込んだジューシーな一品。", price: 680, isSoldOut: true, sortOrder: 1 },
    { id: "yakitori", categoryId: "grill", name: "焼き鳥（もも）", description: "香ばしく焼き上げた店の定番。", price: 620, isSoldOut: false, sortOrder: 1 },
    { id: "otoshi", categoryId: "snack", name: "お通し", description: "本日のお通し。", price: 300, isSoldOut: false, sortOrder: 2 },
  ],
  devices: [
    { deviceId: "customer-01", label: "客席タブレット 01", tableId: "1" },
    { deviceId: "customer-02", label: "客席タブレット 02", tableId: "2" },
    { deviceId: "customer-03", label: "客席タブレット 03", tableId: "3" },
    { deviceId: "customer-04", label: "客席タブレット 04", tableId: "4" },
  ],
  offlineDevices: [],
  staffCalls: [
    { id: "call-seed-1", tableId: "3", type: "staff", createdAt: "2026-08-09T07:38:00.000Z", resolvedAt: null },
  ],
  orders: [
    {
      id: "ORD-1635-T1",
      tableId: "1",
      createdAt: "2026-08-09T07:35:00.000Z",
      status: "active",
      totalAmount: 2340,
      syncedAt: "2026-08-09T07:35:02.000Z",
      completedAt: null,
      items: [
        { id: "oi-1", menuItemId: "dashimaki", nameSnapshot: "だし巻き玉子", unitPriceSnapshot: 580, quantity: 1, isServed: false, servedAt: null },
        { id: "oi-2", menuItemId: "lemon", nameSnapshot: "レモンサワー", unitPriceSnapshot: 550, quantity: 2, isServed: false, servedAt: null },
        { id: "oi-3", menuItemId: "edamame", nameSnapshot: "枝豆", unitPriceSnapshot: 380, quantity: 1, isServed: true, servedAt: "2026-08-09T07:39:00.000Z" },
        { id: "oi-4", menuItemId: "otoshi", nameSnapshot: "お通し", unitPriceSnapshot: 300, quantity: 1, isServed: true, servedAt: "2026-08-09T07:38:00.000Z" },
      ],
    },
    {
      id: "ORD-1637-T4",
      tableId: "4",
      createdAt: "2026-08-09T07:37:00.000Z",
      status: "new",
      totalAmount: 2940,
      syncedAt: "2026-08-09T07:37:01.000Z",
      completedAt: null,
      items: [
        { id: "oi-5", menuItemId: "otoshi", nameSnapshot: "お通し", unitPriceSnapshot: 300, quantity: 2, isServed: false, servedAt: null },
        { id: "oi-6", menuItemId: "beer", nameSnapshot: "生ビール", unitPriceSnapshot: 680, quantity: 2, isServed: false, servedAt: null },
        { id: "oi-7", menuItemId: "yakitori", nameSnapshot: "焼き鳥（もも）", unitPriceSnapshot: 620, quantity: 1, isServed: false, servedAt: null },
        { id: "oi-16", menuItemId: "edamame", nameSnapshot: "枝豆", unitPriceSnapshot: 380, quantity: 1, isServed: false, servedAt: null },
        { id: "oi-17", menuItemId: "lemon", nameSnapshot: "レモンサワー", unitPriceSnapshot: 550, quantity: 1, isServed: false, servedAt: null },
        { id: "oi-18", menuItemId: "otoshi", nameSnapshot: "お通し", unitPriceSnapshot: 300, quantity: 2, isServed: false, servedAt: null },
        { id: "oi-19", menuItemId: "beer", nameSnapshot: "生ビール", unitPriceSnapshot: 680, quantity: 1, isServed: false, servedAt: null },
        { id: "oi-20", menuItemId: "edamame", nameSnapshot: "枝豆", unitPriceSnapshot: 380, quantity: 1, isServed: false, servedAt: null },
        { id: "oi-21", menuItemId: "lemon", nameSnapshot: "レモンサワー", unitPriceSnapshot: 550, quantity: 1, isServed: false, servedAt: null },
        { id: "oi-8", menuItemId: "dashimaki", nameSnapshot: "だし巻き玉子", unitPriceSnapshot: 580, quantity: 1, isServed: true, servedAt: "2026-08-09T07:40:00.000Z" },
      ],
    },
    {
      id: "ORD-1641-T5",
      tableId: "5",
      createdAt: "2026-08-09T07:41:00.000Z",
      status: "new",
      totalAmount: 2440,
      syncedAt: "2026-08-09T07:41:01.000Z",
      completedAt: null,
      items: [
        { id: "oi-9", menuItemId: "dashimaki", nameSnapshot: "だし巻き玉子", unitPriceSnapshot: 580, quantity: 1, isServed: false, servedAt: null },
        { id: "oi-10", menuItemId: "lemon", nameSnapshot: "レモンサワー", unitPriceSnapshot: 550, quantity: 2, isServed: false, servedAt: null },
        { id: "oi-11", menuItemId: "otoshi", nameSnapshot: "お通し", unitPriceSnapshot: 300, quantity: 1, isServed: false, servedAt: null },
        { id: "oi-22", menuItemId: "karaage", nameSnapshot: "唐揚げ", unitPriceSnapshot: 680, quantity: 1, isServed: false, servedAt: null },
        { id: "oi-23", menuItemId: "edamame", nameSnapshot: "枝豆", unitPriceSnapshot: 380, quantity: 1, isServed: false, servedAt: null },
        { id: "oi-24", menuItemId: "beer", nameSnapshot: "生ビール", unitPriceSnapshot: 680, quantity: 1, isServed: false, servedAt: null },
        { id: "oi-25", menuItemId: "otoshi", nameSnapshot: "お通し", unitPriceSnapshot: 300, quantity: 2, isServed: false, servedAt: null },
        { id: "oi-26", menuItemId: "lemon", nameSnapshot: "レモンサワー", unitPriceSnapshot: 550, quantity: 1, isServed: false, servedAt: null },
        { id: "oi-27", menuItemId: "dashimaki", nameSnapshot: "だし巻き玉子", unitPriceSnapshot: 580, quantity: 1, isServed: false, servedAt: null },
        { id: "oi-28", menuItemId: "edamame", nameSnapshot: "枝豆", unitPriceSnapshot: 380, quantity: 1, isServed: false, servedAt: null },
        { id: "oi-12", menuItemId: "yakitori", nameSnapshot: "焼き鳥（もも）", unitPriceSnapshot: 620, quantity: 1, isServed: true, servedAt: "2026-08-09T07:42:00.000Z" },
      ],
    },
    {
      id: "ORD-1612-T2",
      tableId: "2",
      createdAt: "2026-08-09T07:12:00.000Z",
      status: "completed",
      totalAmount: 1860,
      syncedAt: "2026-08-09T07:12:02.000Z",
      completedAt: "2026-08-09T07:28:00.000Z",
      items: [
        { id: "oi-13", menuItemId: "beer", nameSnapshot: "生ビール", unitPriceSnapshot: 680, quantity: 1, isServed: true, servedAt: "2026-08-09T07:18:00.000Z" },
        { id: "oi-14", menuItemId: "dashimaki", nameSnapshot: "だし巻き玉子", unitPriceSnapshot: 580, quantity: 1, isServed: true, servedAt: "2026-08-09T07:22:00.000Z" },
        { id: "oi-15", menuItemId: "otoshi", nameSnapshot: "お通し", unitPriceSnapshot: 300, quantity: 2, isServed: true, servedAt: "2026-08-09T07:28:00.000Z" },
      ],
    },
  ],
};

const CUSTOMER_DRINK_SUBCATEGORIES = [
  { id: "recommended", name: "おかわり！", categoryIds: [] },
  { id: "beer", name: "ビール", categoryIds: ["beer"] },
  { id: "highball", name: "ハイボール", categoryIds: ["highball"] },
  { id: "sour", name: "サワー・酎ハイ", categoryIds: ["sour"] },
  { id: "shochu", name: "焼酎", categoryIds: ["shochu"] },
  { id: "sake", name: "日本酒", categoryIds: ["sake"] },
  { id: "soft-drink", name: "ソフトドリンク", categoryIds: ["soft-drink", "soft"] },
  { id: "nonalcohol", name: "ノンアル", categoryIds: ["nonalcohol", "non-alcohol"] },
];

const CUSTOMER_MAJOR_CATEGORIES = [
  { id: "drink", name: "ドリンク", subcategories: CUSTOMER_DRINK_SUBCATEGORIES },
  { id: "food", name: "フード", subcategories: [
    { id: "food-ready", name: "とりあえず", categoryIds: ["food-ready"] },
    { id: "food-chicken", name: "鶏料理", categoryIds: ["food-chicken"] },
    { id: "food-kushi", name: "串カツ・揚げ物", categoryIds: ["food-kushi"] },
    { id: "food-gifu", name: "岐阜の味", categoryIds: ["food-gifu"] },
    { id: "food-teppan", name: "鉄板・一品", categoryIds: ["food-teppan"] },
    { id: "special-hine", name: "名物", categoryIds: ["special-hine"] },
    { id: "special-reservation", name: "予約限定", categoryIds: ["special-reservation"] },
  ] },
  { id: "winter", name: "冬季限定", subcategories: [
    { id: "winter-hotpot", name: "鍋料理", categoryIds: ["winter-hotpot"] },
    { id: "winter-shime", name: "追加・〆", categoryIds: ["winter-shime"] },
  ] },
  { id: "seasonal", name: "季節・気まぐれ", subcategories: [
    { id: "seasonal", name: "季節・気まぐれ", categoryIds: [] },
  ] },
];

const CUSTOMER_WINTER_CATEGORY_IDS = new Set(["winter-hotpot", "winter-shime"]);
const FOOD_VARIANT_DEFINITIONS = {
  "special-hine-black": ["小", "中", "大"],
  "food-kushi-kushikatsu": ["塩レモン", "ソース", "おろしポン酢", "味噌"],
};

const CUSTOMER_DRINK_CATEGORY_IDS = new Set(CUSTOMER_DRINK_SUBCATEGORIES.flatMap((subcategory) => subcategory.categoryIds));
const CUSTOMER_FEATURED_MENU_IDS = ["edamame", "dashimaki", "beer", "lemon", "karaage"];

function buildCustomerMajorCategories(categories) {
  if (!Array.isArray(categories) || categories.length === 0) return CUSTOMER_MAJOR_CATEGORIES;
  const rails = [
    { id: "drink", name: "ドリンク" },
    { id: "food", name: "フード" },
    { id: "winter", name: "冬季限定" },
    { id: "seasonal", name: "季節・気まぐれ" },
  ];
  return rails.map((rail) => ({
    ...rail,
    subcategories: [
      ...(rail.id === "drink" ? [{ id: "recommended", name: "おかわり！", categoryIds: [] }] : []),
      ...categories
        .filter((category) => category.sectionKey === rail.id)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.categoryId.localeCompare(b.categoryId, "ja"))
        .map((category) => ({ id: category.categoryId, name: category.name, categoryIds: [category.categoryId] })),
    ],
  }));
}

function mapAdminCatalogState(catalog) {
  return {
    categories: catalog.categories.map((category) => ({ id: category.categoryId, name: category.name, sectionKey: category.sectionKey, sortOrder: category.sortOrder, isVisible: category.isVisible, version: category.version })),
    menuItems: catalog.items.map((item) => ({
      id: item.menuItemId, categoryId: item.categoryId, name: item.formalName, kitchenAlias: item.kitchenAlias,
      description: item.description, price: item.priceYen, imageUri: item.imageUri, sectionKey: item.sectionKey,
      isSoldOut: item.isSoldOut, orderingMode: item.orderingMode ?? "normal", isActive: item.isActive, sortOrder: item.sortOrder, version: item.version,
      detail: item.detail, variants: item.variants ?? [], servingOptions: item.servingOptions ?? [], imageLayouts: item.imageLayouts,
    })),
  };
}
const CUSTOMER_FOOTER_INFORMATION = "";

function makeId(prefix) {
  return `${prefix}-${crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

function formatTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function formatDateTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function isSameLocalDate(value, reference = new Date()) {
  const date = new Date(value);
  return Number.isFinite(date.valueOf())
    && date.getFullYear() === reference.getFullYear()
    && date.getMonth() === reference.getMonth()
    && date.getDate() === reference.getDate();
}

function yen(value) {
  const amount = Number(value);
  const normalizedAmount = Number.isFinite(amount) ? Math.round(amount).toLocaleString("en-US", { maximumFractionDigits: 0 }) : "0";
  return `￥${normalizedAmount}`;
}

function customerTransportLabel(order) {
  switch (order.transportState) {
    case "sending": return "送信中";
    case "retrying": return "再送中";
    case "pending": return "送信待ち";
    case "synced": return "送信済み";
    case "rejected": return customerOrderErrorCategory(order.transportErrorCode).label;
    case "failed": return "送信失敗";
    default: return order.status === "completed" ? "提供済み" : order.status === "queued_offline" ? "送信待ち" : "準備中";
  }
}

function mapCustomerHistoryOrder(order) {
  return {
    id: order.orderId,
    clientOrderId: order.clientOrderId,
    tableId: String(order.tableNumberSnapshot),
    createdAt: new Date(order.acceptedAtMs).toISOString(),
    completedAt: order.completedAtMs == null ? null : new Date(order.completedAtMs).toISOString(),
    status: order.status,
    items: order.items.map((item) => ({
      id: String(item.orderItemId),
      menuItemId: item.menuItemId,
      nameSnapshot: item.formalNameSnapshot,
      variantId: item.variantId,
      variantNameSnapshot: item.variantNameSnapshot,
      variantVolumeSnapshot: item.variantVolumeSnapshot,
      temperatureSnapshot: item.temperatureSnapshot,
      servingOptionId: item.servingOptionId,
      servingOptionNameSnapshot: item.servingOptionNameSnapshot,
      quantity: item.quantity,
      isServed: item.isServed,
      servedAt: item.servedAtMs == null ? null : new Date(item.servedAtMs).toISOString(),
    })),
  };
}

function selectionSuffix(value) {
  const name = value.variantNameSnapshot ?? value.variant?.name ?? value.servingOptionNameSnapshot ?? value.servingOption?.name;
  const volume = value.variantVolumeSnapshot ?? value.variant?.volumeLabel;
  const temperature = value.temperatureSnapshot ?? value.temperature;
  return [name, volume, temperature].filter(Boolean).join(" ");
}

function kitchenSakeVariantName(value) {
  const rawName = value.variantNameSnapshot ?? value.variant?.name;
  if (typeof rawName !== "string") return null;
  const normalizedName = rawName.replace(/\s+/g, "");
  if (normalizedName === "グラス" || /^グラス\d+ml$/.test(normalizedName)) return "グラス";
  const tokuriMatch = normalizedName.match(/^(?:徳利)?([12]合)(?:\d+ml)?$/);
  return tokuriMatch?.[1] ?? null;
}

function kitchenSelectionSuffix(value) {
  const shortVariantName = kitchenSakeVariantName(value);
  if (!shortVariantName) return selectionSuffix(value);
  const temperature = value.temperatureSnapshot ?? value.temperature;
  const shortTemperature = temperature === "冷酒" ? "冷" : temperature === "燗酒" ? "燗" : temperature;
  return [shortVariantName, shortTemperature].filter(Boolean).join("・");
}

function selectionDisplayName(item, selection = {}) {
  const suffix = selectionSuffix(selection);
  return suffix ? `${item.name}（${suffix}）` : item.name;
}

const KUSHIKATSU_MENU_ITEM_ID = "food-kushi-kushikatsu";

function PriceDisplay({ priceYen }) {
  return <span className="menu-price"><b>{yen(taxExcludedYen(priceYen))}</b><small>税込 {yen(priceYen)}</small></span>;
}

function shochuThumbUri(uri) {
  return typeof uri === "string" ? uri.replace(/-thumb-v1(\.webp(?:[?#].*)?)$/, "-thumb-v2$1") : uri;
}

function imageLayoutTransform(layout) {
  if (!layout) return undefined;
  return {
    objectFit: layout.fit === "cover" ? "cover" : "contain",
    objectPosition: "center",
    transform: `translate(${Number(layout.positionX) * 100}%, ${Number(layout.positionY) * 100}%) scale(${Number(layout.scale)}) rotate(${Number(layout.rotation)}deg)`,
    transformOrigin: "center",
  };
}

function imageLayoutStyle(item, usage) {
  return imageLayoutTransform(item?.imageLayouts?.[usage]);
}

function listImageVisible(item) {
  if (item?.categoryId === "sake") return true;
  if (Object.hasOwn(item?.detail ?? {}, "showImageInList")) return item.detail.showImageInList === true;
  return item?.categoryId === "shochu";
}

const SHOCHU_SECTION_ORDER = Object.freeze({ "芋": 0, "麦・その他": 1 });

function shochuSectionRank(item) {
  return SHOCHU_SECTION_ORDER[item?.sectionKey] ?? 2;
}

function compareMenuItems(a, b) {
  if (a?.categoryId === "shochu" && b?.categoryId === "shochu") {
    const sectionDifference = shochuSectionRank(a) - shochuSectionRank(b);
    if (sectionDifference !== 0) return sectionDifference;
  }
  return (Number(a?.sortOrder) || 0) - (Number(b?.sortOrder) || 0) || String(a?.id ?? "").localeCompare(String(b?.id ?? ""), "ja");
}

function foodVariantDefinitions(item) {
  return (FOOD_VARIANT_DEFINITIONS[item?.id] ?? []).map((name, index) => ({ name, index }));
}

function expandCustomerMenuItems(items) {
  return items.flatMap((item) => {
    if (item.id !== KUSHIKATSU_MENU_ITEM_ID || !item.variants?.length) return [item];
    return item.variants.map((variant) => ({
      ...item,
      id: `${item.id}::${variant.variantId}`,
      menuItemId: item.id,
      name: `${item.name} ${variant.name}`,
      baseName: item.name,
      price: variant.priceYen,
      sortOrder: (Number(item.sortOrder) || 0) * 10 + (Number(variant.sortOrder) || 0),
      variants: [variant],
      isKushikatsuVirtual: true,
      virtualVariantId: variant.variantId,
    }));
  });
}

const SAKE_COLD = "冷酒";
const SAKE_WARM = "燗酒";

function sakeTemperatureOptions(variant) {
  if (variant?.name === "グラス") return [SAKE_COLD];
  if (Array.isArray(variant?.temperatureOptions) && variant.temperatureOptions.length > 0) {
    return [...new Set(variant.temperatureOptions.filter((temperature) => temperature === SAKE_COLD || temperature === SAKE_WARM))];
  }
  return [SAKE_COLD, SAKE_WARM];
}

function sakeAutoTemperature(variant) {
  const options = sakeTemperatureOptions(variant);
  return options.length === 1 ? options[0] : null;
}

function sakeTemperatureLabel(temperature, exclusive = false) {
  const shortLabel = temperature === SAKE_COLD ? "冷" : temperature === SAKE_WARM ? "燗" : temperature;
  return exclusive ? `${shortLabel}専用` : shortLabel;
}

const SHOCHU_SERVING_ORDER = ["ロック", "水割り", "ソーダ割り", "お湯割り"];

function orderedShochuServingOptions(item) {
  const servingOrder = (name) => {
    const index = SHOCHU_SERVING_ORDER.indexOf(name);
    return index === -1 ? SHOCHU_SERVING_ORDER.length : index;
  };
  return [...(item?.servingOptions ?? [])].sort((a, b) => servingOrder(a.name) - servingOrder(b.name));
}

function sakeVariantLabel(variant) {
  if (variant?.name === "徳利1合") return "徳利 1合";
  if (variant?.name === "徳利2合") return "徳利 2合";
  return variant?.name ?? "提供方法";
}

function navigate(route) {
  window.location.hash = route;
}

function useRoute() {
  const [route, setRoute] = useState(window.location.hash.slice(1) || "/");
  useEffect(() => {
    const handler = () => setRoute(window.location.hash.slice(1) || "/");
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);
  return route;
}

function Brand({ compact = false }) {
  return (
    <div className={`brand ${compact ? "brand--compact" : ""}`}>
      <span className="brand__eyebrow">IZAKAYA<br />ORDER<br />SYSTEM</span>
      <div className="brand__lockup">
        <strong>居酒屋</strong>
        <small>JAPANESE IZAKAYA</small>
      </div>
    </div>
  );
}

function ConnectionBadge({ online = true, compact = false }) {
  return (
    <div className={`connection ${online ? "is-online" : "is-offline"} ${compact ? "connection--compact" : ""}`}>
      {online ? <WifiHigh size={22} weight="bold" /> : <WifiSlash size={22} weight="bold" />}
      <span><small>通信状態</small>{online ? "接続中" : "送信待ち"}</span>
    </div>
  );
}

function IconButton({ icon: Icon, children, badge, onClick, className = "" }) {
  return (
    <button className={`header-action ${className}`} onClick={onClick} type="button">
      <Icon size={30} weight="bold" />
      <span>{children}</span>
      {badge ? <b className="badge">{badge}</b> : null}
    </button>
  );
}

function Modal({ title, titleExtra = null, children, footer = null, onClose, wide = false, className = "" }) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, []);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={`modal ${wide ? "modal--wide" : ""} ${className}`.trim()} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal__header"><div className="modal__title-group"><h2>{title}</h2>{titleExtra}</div><button className="icon-only" onClick={onClose} aria-label="閉じる"><X size={26} weight="bold" /></button></header>
        <div className="modal__body">{children}</div>
        {footer ? <div className="modal__footer">{footer}</div> : null}
      </section>
    </div>
  );
}

function Launcher({ state, updateState }) {
  const pendingByDevice = (device) => state.orders.filter((order) => order.tableId === device.tableId && order.status === "queued_offline").length;
  const toggleOffline = (deviceId) => {
    updateState((current) => {
      const goingOnline = current.offlineDevices.includes(deviceId);
      const offlineDevices = goingOnline ? current.offlineDevices.filter((id) => id !== deviceId) : [...current.offlineDevices, deviceId];
      const now = new Date().toISOString();
      const orders = goingOnline
        ? current.orders.map((order) => {
            const tableId = current.devices.find((device) => device.deviceId === deviceId)?.tableId;
            return order.tableId === tableId && order.status === "queued_offline" ? { ...order, status: "new", syncedAt: now } : order;
          })
        : current.orders;
      return { ...current, offlineDevices, orders };
    });
  };

  return (
    <main className="launcher">
      <header className="launcher__hero">
        <Brand />
        <div>
          <span className="section-kicker">CLICKABLE PROTOTYPE</span>
          <h1>端末を選んで<br />注文体験を確認</h1>
          <p>客席4台とキッチン端末を、同じ注文データで連動させています。</p>
        </div>
        <div className="launcher__stamp"><ChefHat size={58} weight="bold" /><span>一番星<br />試作版</span></div>
      </header>

      <section className="launcher__body">
        <div className="launcher__heading">
          <div><span className="section-kicker">CUSTOMER TABLETS</span><h2>客席タブレット</h2></div>
          <p>固定テーブルのため、客席側には席変更操作がありません。</p>
        </div>
        <div className="device-grid">
          {state.devices.map((device, index) => {
            const offline = state.offlineDevices.includes(device.deviceId);
            return (
              <article className="device-card" key={device.deviceId}>
                <div className="device-card__number">0{index + 1}</div>
                <Monitor size={42} weight="duotone" />
                <div className="device-card__copy"><small>{device.label}</small><h3>テーブル <b>{device.tableId}</b></h3></div>
                <ConnectionBadge online={!offline} compact />
                {pendingByDevice(device) ? <p className="queued-note">送信待ち {pendingByDevice(device)}件</p> : null}
                <div className="device-card__actions">
                  <button className="button button--primary" onClick={() => navigate(`/customer/${device.deviceId}`)}>開く <ArrowRight size={20} weight="bold" /></button>
                  <button className="button button--quiet" onClick={() => toggleOffline(device.deviceId)}>{offline ? "再接続する" : "通信断を再現"}</button>
                </div>
              </article>
            );
          })}
        </div>

        <div className="launcher__heading launcher__heading--staff">
          <div><span className="section-kicker">STAFF TERMINAL</span><h2>キッチン端末</h2></div>
          <p>新着注文、提供済み履歴、メニュー管理を一つの端末に集約。</p>
        </div>
        <div className="staff-grid">
          <button className="staff-card staff-card--red" onClick={() => navigate("/kitchen")}><ChefHat size={48} weight="bold" /><span><small>新着と提供チェック</small><b>キッチン画面</b></span><ArrowRight size={28} weight="bold" /></button>
          <button className="staff-card" onClick={() => navigate("/history")}><ClockCounterClockwise size={48} weight="bold" /><span><small>完了した注文</small><b>提供済み履歴</b></span><ArrowRight size={28} weight="bold" /></button>
          <button className="staff-card" onClick={() => navigate("/admin/menu")}><Gear size={48} weight="bold" /><span><small>価格・売り切れ・割り当て</small><b>管理画面</b></span><ArrowRight size={28} weight="bold" /></button>
        </div>
      </section>
    </main>
  );
}

function CustomerScreen({ state, updateState, deviceId, orderClient, customerDeviceConfig, theme = CUSTOMER_TEST_THEME }) {
  const customerTheme = normalizeCustomerTheme(theme);
  const localDevice = state.devices.find((item) => item.deviceId === deviceId) ?? state.devices[0];
  const apiMode = orderClient.mode === "api";
  const assignedTableId = apiMode && Number.isSafeInteger(customerDeviceConfig?.tableId) ? String(customerDeviceConfig.tableId) : null;
  const device = assignedTableId
    ? { ...localDevice, tableId: assignedTableId, label: customerDeviceConfig.tableLabel || localDevice.label }
    : localDevice;
  const online = apiMode ? typeof navigator === "undefined" || navigator.onLine !== false : !state.offlineDevices.includes(device.deviceId);
  const [apiMenu, setApiMenu] = useState(null);
  const [apiMenuState, setApiMenuState] = useState({ loading: apiMode, error: false });
  const [menuRefreshKey, setMenuRefreshKey] = useState(0);
  const menuItems = apiMenu
    ? apiMenu.items.map((item) => ({
      id: item.menuItemId,
      categoryId: item.categoryId,
      name: item.formalName,
      description: item.description,
      price: item.priceYen,
      imageUri: item.imageUri,
      imageLayouts: item.imageLayouts,
      isSoldOut: item.isSoldOut,
      orderingMode: item.orderingMode ?? "normal",
      sortOrder: item.sortOrder,
      sectionKey: item.sectionKey,
      detail: item.detail,
      variants: item.variants ?? [],
      servingOptions: item.servingOptions ?? [],
    }))
    : state.menuItems.map((item) => ({ ...item, variants: item.variants ?? [], servingOptions: item.servingOptions ?? [] }));
  const [majorCategoryId, setMajorCategoryId] = useState("drink");
  const [majorNavOpen, setMajorNavOpen] = useState(true);
  const [categoryId, setCategoryId] = useState("recommended");
  const [drinkCategoryNavOpen, setDrinkCategoryNavOpen] = useState(true);
  const [cart, setCart] = useState(() => apiMode ? {} : Object.fromEntries([
    ["edamame", 1], ["dashimaki", 1], ["beer", 2], ["lemon", 1], ["karaage", 1], ["yakitori", 2], ["otoshi", 2],
  ].map(([menuItemId, quantity]) => [menuItemId, { menuItemId, quantity }])));
  const [modal, setModal] = useState(null);
  const [detailItem, setDetailItem] = useState(null);
  const [sakeSelection, setSakeSelection] = useState(null);
  const [sakeSelectionError, setSakeSelectionError] = useState("");
  const [shochuSelection, setShochuSelection] = useState(null);
  const [kushikatsuSelection, setKushikatsuSelection] = useState(null);
  const [kushikatsuSelectionError, setKushikatsuSelectionError] = useState("");
  const [notice, setNotice] = useState(null);
  const [isMenuHeaderHidden, setIsMenuHeaderHidden] = useState(false);
  const [apiOrders, setApiOrders] = useState([]);
  const [apiHistoryState, setApiHistoryState] = useState({ loading: false, error: false });
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const submitLock = useRef(false);
  const menuIdleTimerRef = useRef(null);
  const imoRef = useRef(null);
  const otherRef = useRef(null);
  const customerMajorCategories = buildCustomerMajorCategories(apiMenu?.categories);
  const currentMajorCategory = customerMajorCategories.find((category) => category.id === majorCategoryId) ?? customerMajorCategories[0];
  const currentSubcategories = currentMajorCategory.subcategories;
  const currentCategory = currentSubcategories.find((category) => category.id === categoryId) ?? currentSubcategories[0];
  const currentCategoryLabel = currentCategory?.id === "sake" ? "日本酒・地酒" : currentCategory?.name;
  const isDrink = currentMajorCategory.id === "drink";
  const isShochu = currentCategory?.id === "shochu";
  const isSake = currentCategory?.id === "sake";
  const cartRows = Object.entries(cart).map(([key, selection]) => ({
    key,
    ...selection,
    item: menuItems.find((menu) => menu.id === selection.menuItemId),
  })).filter((row) => row.item && row.quantity > 0);
  const cartCount = cartRows.reduce((sum, row) => sum + row.quantity, 0);
  const customerHistory = (apiMode ? apiOrders : state.orders)
    .filter((order) => apiMode || order.tableId === device.tableId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const recentDrinkItemIds = [...new Set(customerHistory.flatMap((order) => order.items ?? [])
    .filter((item) => CUSTOMER_DRINK_CATEGORY_IDS.has(menuItems.find((menu) => menu.id === item.menuItemId)?.categoryId))
    .map((item) => item.menuItemId))];
  const currentItems = currentCategory?.id === "recommended"
    ? recentDrinkItemIds.map((itemId) => menuItems.find((item) => item.id === itemId)).filter(Boolean)
    : expandCustomerMenuItems(menuItems.filter((item) => currentCategory?.categoryIds.includes(item.categoryId))).sort(compareMenuItems);

  useEffect(() => {
    if (!apiMode) return undefined;
    let cancelled = false;
    setApiMenuState({ loading: true, error: false });
    void orderClient.getMenu().then((menu) => {
      if (cancelled) return;
      setApiMenu(menu);
      setApiMenuState({ loading: false, error: false });
    }).catch(() => {
      if (!cancelled) setApiMenuState({ loading: false, error: true });
    });
    return () => { cancelled = true; };
  }, [apiMode, orderClient, menuRefreshKey]);

  useEffect(() => {
    if (currentSubcategories.some((category) => category.id === categoryId)) return;
    setCategoryId(currentSubcategories[0]?.id ?? "recommended");
  }, [categoryId, currentSubcategories]);

  useEffect(() => {
    if (!apiMode || modal !== "history") return undefined;
    let cancelled = false;
    setApiHistoryState({ loading: true, error: false });
    void orderClient.getHistory()
      .then((orders) => {
        if (cancelled) return;
        setApiOrders(orders.map(mapCustomerHistoryOrder));
        setApiHistoryState({ loading: false, error: false });
      })
      .catch(() => {
        if (cancelled) return;
        setApiHistoryState({ loading: false, error: true });
      });
    return () => { cancelled = true; };
  }, [apiMode, modal, orderClient, historyRefreshKey]);

  useEffect(() => {
    if (!apiMode || typeof orderClient.subscribeInvalidations !== "function") return undefined;
    return orderClient.subscribeInvalidations((event) => {
      if (event?.payload?.resource === "menu") setMenuRefreshKey((current) => current + 1);
      if (event?.payload?.resource === "orders") setHistoryRefreshKey((current) => current + 1);
    });
  }, [apiMode, orderClient]);

  useEffect(() => {
    const unsubscribe = orderClient.subscribe((event) => {
      const nextNotice = customerOrderNoticeFromOutboxEvent(event);
      if (!nextNotice) return;
      setNotice((current) => current?.kind === nextNotice.kind && current?.message === nextNotice.message ? current : nextNotice);
      if (apiMode) {
        setApiOrders((current) => current.map((order) => {
          if (order.clientOrderId !== event.clientOrderId) return order;
  return {
            ...order,
            status: event.state === "synced" ? "new" : event.state === "rejected" ? "rejected" : event.state === "pending" ? "queued_offline" : order.status,
            transportState: event.displayState || event.state,
            transportErrorCode: event.lastErrorCode || null,
            syncedAt: event.state === "synced" ? new Date().toISOString() : order.syncedAt,
          };
        }));
      }
    });
    return unsubscribe;
  }, [apiMode, orderClient]);

  useEffect(() => {
    if (notice?.kind !== "success") return undefined;
    const timeoutId = window.setTimeout(() => {
      setNotice((current) => current?.kind === "success" ? null : current);
    }, 4000);
    return () => window.clearTimeout(timeoutId);
  }, [notice]);

  useEffect(() => {
    if (!apiMode) return;
    const pendingOrder = customerHistory.find((order) => ["sending", "retrying", "pending", "queued_offline", "rejected"].includes(order.transportState) || order.status === "queued_offline");
    if (!pendingOrder) return;
    const nextNotice = customerOrderNoticeFromOutboxEvent({
      clientOrderId: pendingOrder.clientOrderId || pendingOrder.id,
      state: pendingOrder.transportState === "rejected" ? "rejected" : pendingOrder.transportState === "sending" ? "sending" : "pending",
      displayState: pendingOrder.transportState === "retrying" ? "retrying" : pendingOrder.transportState === "failed" ? "failed" : pendingOrder.transportState,
      lastErrorCode: pendingOrder.transportErrorCode,
    });
    if (nextNotice) setNotice((current) => current?.kind === nextNotice.kind && current?.message === nextNotice.message ? current : nextNotice);
  }, [apiMode, customerHistory, state.orders]);

  useEffect(() => () => {
    if (menuIdleTimerRef.current) window.clearTimeout(menuIdleTimerRef.current);
  }, []);

  const addSelection = (item, selection = {}, quantity = 1) => {
    if (!item || item.isSoldOut) return;
    const normalizedQuantity = Number.isInteger(quantity) && quantity > 0 ? quantity : 0;
    if (!normalizedQuantity) return;
    const menuItemId = item.menuItemId ?? item.id;
    const key = `${menuItemId}::${selection.variant?.variantId ?? ""}::${selection.servingOption?.servingOptionId ?? ""}::${selection.temperature ?? ""}`;
    setCart((current) => ({
      ...current,
      [key]: {
        menuItemId,
        variant: selection.variant,
        temperature: selection.temperature,
        servingOption: selection.servingOption,
        quantity: (current[key]?.quantity ?? 0) + normalizedQuantity,
      },
    }));
  };
  const decrementCartRow = (key) => {
    setCart((current) => {
      const row = current[key];
      if (!row) return current;
      if (row.quantity <= 1) {
        const next = { ...current };
        delete next[key];
        return next;
      }
      return { ...current, [key]: { ...row, quantity: row.quantity - 1 } };
    });
  };

  const submitOrder = async () => {
    if (!cartRows.length || submitLock.current) return;
    submitLock.current = true;
    setSubmitting(true);
    const now = new Date().toISOString();
    const items = cartRows.map((row) => ({
      id: makeId("item"),
      menuItemId: row.item.menuItemId ?? row.item.id,
      nameSnapshot: row.item.baseName ?? row.item.name,
      variantId: row.variant?.variantId,
      variantNameSnapshot: row.variant?.name,
      variantVolumeSnapshot: row.variant?.volumeLabel,
      temperatureSnapshot: row.temperature,
      servingOptionId: row.servingOption?.servingOptionId,
      servingOptionNameSnapshot: row.servingOption?.name,
      unitPriceSnapshot: row.variant?.priceYen ?? row.item.price,
      quantity: row.quantity,
      isServed: false,
      servedAt: null,
    }));

    try {
      if (apiMode) {
        setNotice({ kind: "sending", message: "送信中です。注文を保存しています。" });
        const outboxRecord = await orderClient.enqueue({ items: cartRows.map((row) => ({
          menuItemId: row.item.menuItemId ?? row.item.id,
          quantity: row.quantity,
          ...(row.variant ? { variantId: row.variant.variantId } : {}),
          ...(row.temperature ? { temperature: row.temperature } : {}),
          ...(row.servingOption ? { servingOptionId: row.servingOption.servingOptionId } : {}),
        })) });
        const order = {
          id: outboxRecord.clientOrderId,
          clientOrderId: outboxRecord.clientOrderId,
          tableId: device.tableId,
          createdAt: now,
          status: "queued_offline",
          transportState: "pending",
          totalAmount: cartRows.reduce((sum, row) => sum + (row.variant?.priceYen ?? row.item.price) * row.quantity, 0),
          syncedAt: null,
          completedAt: null,
          items,
        };
        setApiOrders((current) => [...current, order]);
        setCart({});
        setModal(null);
        const result = await orderClient.flush({ clientOrderId: outboxRecord.clientOrderId });
        if (result.state === "synced") {
          setNotice({ kind: "success", message: "送信済みです。ご注文を承りました。" });
        } else if (result.state === "rejected") {
          setNotice(customerOrderNoticeFromOutboxEvent({
            clientOrderId: outboxRecord.clientOrderId,
            state: "rejected",
            displayState: "business_error",
            lastErrorCode: result.errorCode,
          }));
        } else if (result.errorCode === "API_TOKEN_UNCONFIGURED" || result.errorCode === "API_BASE_UNCONFIGURED") {
          setNotice({ kind: "error", message: "API接続設定が未完了のため、送信待ちです。" });
        } else if (result.errorCode === "OFFLINE" || result.errorCode === "NETWORK_ERROR" || result.errorCode?.startsWith("HTTP_5")) {
          setNotice({ kind: "failed", message: "送信に失敗しました。通信が戻るまで送信待ちです。" });
        } else {
          setNotice({ kind: "pending", message: "送信待ちです。通信が戻ると自動で再送します。" });
        }
        return;
      }

      const order = {
        id: `ORD-${Date.now().toString().slice(-6)}-T${device.tableId}`,
        tableId: device.tableId,
        createdAt: now,
        status: online ? "new" : "queued_offline",
        totalAmount: cartRows.reduce((sum, row) => sum + (row.variant?.priceYen ?? row.item.price) * row.quantity, 0),
        syncedAt: online ? now : null,
        completedAt: null,
        items,
      };
      updateState((current) => ({ ...current, orders: [...current.orders, order] }));
      setCart({});
      setModal(null);
      setNotice(online ? "送信しました。ご注文を承りました。" : "通信が戻るまで、この端末に安全に保存します。送信待ちです。");
    } catch {
      setNotice({ kind: "failed", message: "注文を保存できませんでした。もう一度お試しください。" });
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  };

  const callStaff = () => {
    updateState((current) => ({ ...current, staffCalls: [...current.staffCalls, { id: makeId("call"), tableId: device.tableId, type: "staff", createdAt: new Date().toISOString(), resolvedAt: null }] }));
    setModal(null);
    setNotice("スタッフを呼び出しました。少々お待ちください。");
  };
  const noticeKind = typeof notice === "string" ? (online ? "success" : "pending") : notice?.kind;
  const noticeMessage = typeof notice === "string" ? notice : notice?.message;
  const selectMajorCategory = (nextMajorCategoryId) => {
    const nextMajorCategory = customerMajorCategories.find((category) => category.id === nextMajorCategoryId) ?? customerMajorCategories[0];
    setMajorCategoryId(nextMajorCategory.id);
    setCategoryId(nextMajorCategory.subcategories[0]?.id ?? "recommended");
    setDrinkCategoryNavOpen(true);
    setMajorNavOpen(false);
    setShochuSelection(null);
    setSakeSelection(null);
    setSakeSelectionError("");
  };
  const selectSubcategory = (nextCategoryId) => {
    setCategoryId(nextCategoryId);
    setDrinkCategoryNavOpen(false);
    setMajorNavOpen(false);
    setShochuSelection(null);
    setSakeSelection(null);
    setSakeSelectionError("");
  };
  const restoreDrinkCategoryNavigation = () => {
    setDrinkCategoryNavOpen(true);
    setShochuSelection(null);
    setSakeSelection(null);
    setSakeSelectionError("");
  };
  const collapseMajorNavOnMenuTap = () => {
    if (majorNavOpen) setMajorNavOpen(false);
  };
  const handleMenuClick = () => {
    collapseMajorNavOnMenuTap();
    handleMenuInteraction();
  };
  const handleMenuInteraction = () => {
    setIsMenuHeaderHidden(true);
    if (menuIdleTimerRef.current) window.clearTimeout(menuIdleTimerRef.current);
    menuIdleTimerRef.current = window.setTimeout(() => {
      setIsMenuHeaderHidden(false);
      menuIdleTimerRef.current = null;
    }, 5000);
  };
  const selectedSakeItem = sakeSelection ? menuItems.find((item) => item.id === sakeSelection.itemId) : null;
  const selectedSakeVariant = selectedSakeItem?.variants.find((variant) => variant.variantId === sakeSelection?.variantId) ?? null;
  const shochuSelectionItem = shochuSelection ? menuItems.find((item) => item.id === shochuSelection.itemId) : null;
  const shochuSelectionOptions = orderedShochuServingOptions(shochuSelectionItem);
  const shochuSelectionTotal = Object.values(shochuSelection?.quantities ?? {}).reduce((sum, quantity) => sum + quantity, 0);
  const kushikatsuSelectionItem = kushikatsuSelection ? menuItems.find((item) => item.id === kushikatsuSelection.itemId) : null;
  const kushikatsuSelectionVariant = kushikatsuSelectionItem?.variants.find((variant) => variant.variantId === kushikatsuSelection?.variantId) ?? null;
  const openSakeSelection = (item) => {
    setSakeSelection({ itemId: item.id, variantId: null, temperature: null });
    setSakeSelectionError("");
  };
  const selectSakeVariant = (variant) => {
    setSakeSelection((current) => current ? ({
      ...current,
      variantId: variant.variantId,
      temperature: sakeAutoTemperature(variant),
    }) : current);
    setSakeSelectionError("");
  };
  const selectSakeTemperature = (variant, temperature) => {
    if (!sakeTemperatureOptions(variant).includes(temperature)) return;
    setSakeSelection((current) => current ? ({ ...current, variantId: variant.variantId, temperature }) : current);
    setSakeSelectionError("");
  };
  const openShochuSelection = (item) => {
    const options = orderedShochuServingOptions(item);
    setShochuSelection({
      itemId: item.id,
      quantities: Object.fromEntries(options.map((option) => [option.servingOptionId, 0])),
    });
  };
  const openKushikatsuSelection = (item) => {
    const baseItem = item.isKushikatsuVirtual ? menuItems.find((candidate) => candidate.id === item.menuItemId) : item;
    const variant = baseItem?.variants.find((candidate) => candidate.variantId === item.virtualVariantId && candidate.isActive !== false)
      ?? baseItem?.variants.find((candidate) => candidate.isActive !== false)
      ?? baseItem?.variants[0];
    if (!variant) return;
    setKushikatsuSelection({ itemId: baseItem.id, variantId: variant.variantId, quantity: 2 });
    setKushikatsuSelectionError("");
  };
  const adjustKushikatsuQuantity = (delta) => {
    setKushikatsuSelection((current) => current ? ({ ...current, quantity: Math.max(2, current.quantity + delta) }) : current);
  };
  const commitKushikatsuSelection = () => {
    if (!kushikatsuSelection || !kushikatsuSelectionItem || !kushikatsuSelectionVariant) return;
    if (kushikatsuSelection.quantity < 2) {
      setKushikatsuSelectionError("串カツは各種類2本からご注文いただけます");
      return;
    }
    addSelection(kushikatsuSelectionItem, { variant: kushikatsuSelectionVariant }, kushikatsuSelection.quantity);
    setKushikatsuSelection(null);
    setKushikatsuSelectionError("");
  };
  const chooseShochuFromDetail = (item) => {
    setDetailItem(null);
    openShochuSelection(item);
  };
  const adjustShochuQuantity = (optionId, delta) => {
    setShochuSelection((current) => {
      if (!current) return current;
      const nextQuantity = Math.max(0, (current.quantities[optionId] ?? 0) + delta);
      return { ...current, quantities: { ...current.quantities, [optionId]: nextQuantity } };
    });
  };
  const commitShochuSelection = () => {
    if (!shochuSelection || !shochuSelectionItem || shochuSelectionTotal === 0) return;
    for (const option of shochuSelectionOptions) {
      const quantity = shochuSelection.quantities[option.servingOptionId] ?? 0;
      if (quantity > 0) addSelection(shochuSelectionItem, { servingOption: option }, quantity);
    }
    setShochuSelection(null);
  };
  const addSakeSelection = () => {
    const allowedTemperatures = selectedSakeVariant ? sakeTemperatureOptions(selectedSakeVariant) : [];
    if (!selectedSakeVariant || !sakeSelection?.temperature || !allowedTemperatures.includes(sakeSelection.temperature)) {
      setSakeSelectionError("提供形態と温度を選択してください");
      return;
    }
    addSelection(selectedSakeItem, { variant: selectedSakeVariant, temperature: sakeSelection.temperature });
    setSakeSelection(null);
    setSakeSelectionError("");
  };

  return (
    <div className={`customer-app ${majorNavOpen ? "" : "customer-app--category-collapsed"}`} data-customer-theme={customerTheme}>
      <aside className="customer-sidebar">
        <div className="customer-title customer-title--horizontal"><span>IZAKAYA WARUN</span><strong>お品書き</strong></div>
        {majorNavOpen ? <nav className="category-nav" aria-label="大分類カテゴリー">
          {customerMajorCategories.map((category, index) => <button key={category.id} className={category.id === majorCategoryId ? "is-active" : ""} onClick={() => selectMajorCategory(category.id)}><b>{String(index + 1).padStart(2, "0")}</b><span>{category.name}</span></button>)}
        </nav> : <button className="customer-sidebar__collapsed-toggle" onClick={() => setMajorNavOpen(true)} aria-label="カテゴリーを変更"><span>現在のカテゴリー</span><strong>{currentMajorCategory.name}</strong><span>カテゴリーを変更</span></button>}
        <div className="customer-hours"><b>本日の営業時間</b><span>17:00 — 24:00</span><small>（ラストオーダー 23:30）</small></div>
      </aside>

      <section className={`customer-main ${isMenuHeaderHidden ? "customer-main--menu-active" : ""} ${notice ? "customer-main--has-notice" : ""}`}>
        <header className={`customer-header ${isMenuHeaderHidden ? "customer-header--menu-hidden" : ""}`}>
          <IconButton icon={ClipboardText} onClick={() => setModal("history")}>注文履歴</IconButton>
          <IconButton icon={Bell} onClick={() => setModal("staff")}>スタッフを呼ぶ</IconButton>
          <IconButton icon={CurrencyJpy} onClick={() => setModal("feature")}>お会計</IconButton>
          <IconButton icon={Car} onClick={() => setModal("feature")}>タクシー・運転代行</IconButton>
          <div className="table-label">テーブル <b>{device.tableId}</b></div>
        </header>

        {notice ? <div className={`customer-notice ${noticeKind === "success" ? "is-success" : "is-queued"}`}><span>{noticeKind === "success" ? <CheckCircle size={26} weight="fill" /> : noticeKind === "sending" ? <WifiHigh size={26} weight="bold" /> : <WifiSlash size={26} weight="bold" />}{noticeMessage}</span><button onClick={() => setNotice(null)} aria-label="通知を閉じる"><X size={20} /></button></div> : null}

        <div className="customer-content">
          <section className="menu-panel" onWheel={handleMenuInteraction} onTouchMove={handleMenuInteraction} onClick={handleMenuClick}>
            <div className="menu-heading"><div className="menu-heading__breadcrumb"><span>{currentMajorCategory.name}</span><b>&gt;</b><strong>{currentCategoryLabel}</strong></div>{currentMajorCategory.id === "drink" && !drinkCategoryNavOpen ? <button className="category-return-button category-return-button--inline" type="button" onClick={(event) => { event.stopPropagation(); restoreDrinkCategoryNavigation(); }}>酒類選択に戻る</button> : null}</div>
            {currentMajorCategory.id !== "drink" || drinkCategoryNavOpen ? <nav className={`subcategory-nav ${currentMajorCategory.id === "drink" ? "subcategory-nav--drink" : ""}`} aria-label={`${currentMajorCategory.name}の細分類`}>
              {currentSubcategories.map((category) => <button key={category.id} className={category.id === currentCategory?.id ? "is-active" : ""} onClick={() => selectSubcategory(category.id)}>{category.name}</button>)}
            </nav> : null}
            {isShochu ? <nav className="drink-jump-nav" aria-label="焼酎の分類"><button onClick={() => imoRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>芋</button><button onClick={() => otherRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>麦・その他</button></nav> : null}
            <div className="menu-list">
              {apiMenuState.loading ? <div className="empty-state"><ListBullets size={42} /><p>メニューを読み込んでいます。</p></div> : apiMenuState.error ? <div className="empty-state"><ListBullets size={42} /><p>メニューを取得できません。</p></div> : currentItems.length ? currentItems.map((item, index) => {
                const previous = currentItems[index - 1];
                const isOtherStart = isShochu && item.sectionKey !== "芋" && (index === 0 || previous?.sectionKey === "芋");
                const showListImage = listImageVisible(item);
                const isKushikatsu = item.isKushikatsuVirtual === true;
                const canOpenDetail = Boolean(item.detail?.imageUri || item.imageUri);
                const listComment = isDrink ? item.description?.trim() : "";
                const row = isSake ? (
                  <article className={`menu-row sake-menu-row ${item.isSoldOut ? "is-sold-out" : ""}`} key={item.id}>
                    <div className="menu-row__index">{String(index + 1).padStart(2, "0")}</div>
                    <button className="product-image-button" onClick={() => canOpenDetail ? setDetailItem(item) : undefined} aria-label={`${item.name}の詳細を見る`} disabled={!canOpenDetail}>{item.imageUri ? <img src={item.imageUri} alt="" style={imageLayoutStyle(item, "thumbnail")} /> : <span>画像なし</span>}</button>
                    <button className="menu-row__copy menu-row__copy--button" onClick={() => canOpenDetail ? setDetailItem(item) : undefined} disabled={!canOpenDetail} aria-label={item.name + "の詳細を見る"}>{item.detail?.reading ? <small className="menu-row__reading">{item.detail.reading}</small> : null}<h2>{item.name}</h2>{canOpenDetail || listComment ? <small className="menu-row__detail-hint">{canOpenDetail ? <span className="menu-row__detail-hint__action">タップで明細</span> : null}{canOpenDetail && listComment ? <span className="menu-row__detail-hint__separator" aria-hidden="true">｜</span> : null}{listComment ? <span className="menu-row__comment">{listComment}</span> : null}</small> : null}</button>
                    {item.orderingMode === "reservation_only" ? <div className="reservation-only-label"><b>予約限定</b></div> : <button className="sake-serve-button" onClick={() => openSakeSelection(item)} disabled={item.isSoldOut || !item.variants.length} aria-label={`${item.name}の提供方法を選ぶ`}><span>提供方法を選ぶ</span><small>グラス／徳利</small></button>}
                  </article>
                ) : (
                  <article className={`menu-row ${isShochu ? "shochu-menu-row" : ""} ${showListImage ? "" : "menu-row--no-image"} ${item.isSoldOut ? "is-sold-out" : ""}`} key={item.id} ref={isShochu && item.sectionKey === "芋" && !previous ? imoRef : null}>
                    <div className="menu-row__index">{String(index + 1).padStart(2, "0")}</div>
                    {showListImage ? <button className="product-image-button" onClick={() => canOpenDetail ? setDetailItem(item) : undefined} aria-label={`${item.name}の詳細を見る`} disabled={!canOpenDetail}>{item.imageUri ? <img src={isShochu ? shochuThumbUri(item.imageUri) : item.imageUri} alt="" style={imageLayoutStyle(item, "thumbnail")} /> : <span>画像なし</span>}</button> : null}
                    <button className="menu-row__copy menu-row__copy--button" onClick={() => canOpenDetail ? setDetailItem(item) : undefined} aria-label={`${item.name}の詳細を見る`} disabled={!canOpenDetail}>{item.detail?.reading ? <small className="menu-row__reading">{item.detail.reading}</small> : null}<h2>{item.name}</h2>{canOpenDetail || listComment ? <small className="menu-row__detail-hint">{canOpenDetail ? <span className="menu-row__detail-hint__action">タップで明細</span> : null}{canOpenDetail && listComment ? <span className="menu-row__detail-hint__separator" aria-hidden="true">｜</span> : null}{listComment ? <span className="menu-row__comment">{listComment}</span> : null}</small> : null}</button>
                    {isKushikatsu ? <span className="menu-price kushikatsu-price"><b><span className="kushikatsu-serving-label">1本 </span>{yen(taxExcludedYen(item.price))}</b><small>税込 {yen(item.price)}</small><small className="kushikatsu-condition">各種2本から</small></span> : <PriceDisplay priceYen={item.price} />}
                    {item.orderingMode === "reservation_only" ? <div className="reservation-only-label"><b>予約限定</b></div> : item.isSoldOut ? <div className="sold-out-label"><b>{CUSTOMER_WINTER_CATEGORY_IDS.has(item.categoryId) ? "冬季限定・現在注文できません" : "売り切れ"}</b><small>{CUSTOMER_WINTER_CATEGORY_IDS.has(item.categoryId) ? "SEASONAL PAUSED" : "SOLD OUT"}</small></div> : isKushikatsu ? <button className="add-button" onClick={() => openKushikatsuSelection(item)} aria-label={`${item.name}の本数を選ぶ`}><Plus size={36} weight="bold" /></button> : item.servingOptions.length ? <button className="shochu-serving-button" onClick={() => openShochuSelection(item)} aria-label={`${item.name}の飲み方選択`}>飲み方選択</button> : <button className="add-button" onClick={() => addSelection(item)} aria-label={`${item.name}を追加`}><Plus size={36} weight="bold" /></button>}
                  </article>
                );
                return (
                  <div key={item.id}>{isOtherStart ? <div className="menu-section-divider" ref={otherRef}><b>麦・その他</b><span>麦焼酎・黒糖・泡盛など</span></div> : null}{row}</div>
                );
              }) : <div className="empty-state"><ListBullets size={42} /><p>このカテゴリの商品はまだありません。</p></div>}
            </div>
          </section>

          <aside className="cart-panel">
            <header><Receipt size={36} weight="bold" /><div><h2>ご注文内容</h2><span>ORDER SUMMARY</span></div></header>
            <div className="cart-list">
              {cartRows.length ? cartRows.map((row, index) => <div className="cart-row" key={row.key}><span className="cart-row__index">{index + 1}</span><b>{selectionDisplayName(row.item, row)}</b><span>{row.quantity}点</span><button onClick={() => decrementCartRow(row.key)} aria-label={`${selectionDisplayName(row.item, row)}を1点取り消す`}><X size={18} /></button></div>) : <div className="cart-empty"><Receipt size={54} weight="thin" /><p>商品を追加すると<br />ここに表示されます。</p></div>}
            </div>
            <button className="confirm-button" disabled={!cartCount} onClick={() => setModal("confirm")}>注文を確定する <ArrowRight size={28} weight="bold" /></button>
          </aside>
        </div>
        <footer className="customer-footer"><b>INFORMATION</b>{CUSTOMER_FOOTER_INFORMATION ? <span>{CUSTOMER_FOOTER_INFORMATION}</span> : null}<strong>全席喫煙可能</strong></footer>
      </section>

      {modal === "confirm" ? <Modal title="注文内容の確認" onClose={() => { if (!submitting) setModal(null); }}><div className="confirm-list">{cartRows.map((row) => <div key={row.key}><b>{selectionDisplayName(row.item, row)}</b><span>{row.quantity}点</span></div>)}</div><p className="price-hidden-note">内容をご確認のうえ、注文を送信してください。</p><div className="modal-actions"><button className="button button--quiet" onClick={() => setModal(null)} disabled={submitting}>戻る</button><button className="button button--primary button--large" onClick={submitOrder} disabled={submitting}>{submitting ? "送信中" : online ? "注文を送信" : "送信待ちに保存"}</button></div></Modal> : null}
      {shochuSelection && shochuSelectionItem ? <Modal title={shochuSelectionItem.name} onClose={() => setShochuSelection(null)} className="modal--shochu">
        <div className="shochu-selection-modal">
          <p className="modal-lead">飲み方と数量を選択してください。</p>
          <div className="shochu-selection-list" aria-label={`${shochuSelectionItem.name}の飲み方と数量`}>
            {shochuSelectionOptions.map((option) => {
              const quantity = shochuSelection.quantities[option.servingOptionId] ?? 0;
              return <div className="shochu-selection-row" key={option.servingOptionId}>
                <b>{option.name}</b>
                <div className="shochu-quantity-control" aria-label={`${option.name}の数量`}>
                  <button type="button" onClick={() => adjustShochuQuantity(option.servingOptionId, -1)} disabled={quantity === 0} aria-label={`${option.name}を1点減らす`}><Minus size={22} weight="bold" /></button>
                  <b aria-live="polite">{quantity}</b>
                  <button type="button" onClick={() => adjustShochuQuantity(option.servingOptionId, 1)} aria-label={`${option.name}を1点増やす`}><Plus size={22} weight="bold" /></button>
                </div>
              </div>;
            })}
          </div>
          <div className="shochu-selection-footer">
            <div className="modal-actions"><button type="button" className="button button--quiet" onClick={() => setShochuSelection(null)}>キャンセル</button><button type="button" className="button button--primary button--large" disabled={!shochuSelectionTotal} onClick={commitShochuSelection}>{shochuSelectionTotal}点をカートに追加</button></div>
          </div>
        </div>
      </Modal> : null}
      {kushikatsuSelection && kushikatsuSelectionItem ? <Modal title="串カツ" titleExtra={<span className="kushikatsu-modal-instruction">数量を選択してください</span>} onClose={() => setKushikatsuSelection(null)} className="modal--shochu modal--kushikatsu">
        <div className="shochu-selection-modal kushikatsu-selection-modal">
          <div className="kushikatsu-selected-flavor"><strong>{kushikatsuSelectionVariant?.name}</strong><div className="kushikatsu-unit-price"><span>1本 税込 {yen(kushikatsuSelectionVariant?.priceYen)}</span><span>各種2本から</span></div></div>
          <div className="shochu-selection-row kushikatsu-quantity-row"><b>本数</b><div className="shochu-quantity-control" aria-label="串カツの本数"><button type="button" onClick={() => adjustKushikatsuQuantity(-1)} disabled={kushikatsuSelection.quantity <= 2} aria-label="串カツを1本減らす"><Minus size={22} weight="bold" /></button><b aria-live="polite">{kushikatsuSelection.quantity}</b><button type="button" onClick={() => adjustKushikatsuQuantity(1)} aria-label="串カツを1本増やす"><Plus size={22} weight="bold" /></button></div></div>
          {kushikatsuSelectionError ? <p className="sake-selection-error" role="alert">{kushikatsuSelectionError}</p> : null}
          <div className="shochu-selection-footer"><div className="modal-actions"><button type="button" className="button button--quiet" onClick={() => setKushikatsuSelection(null)}>キャンセル</button><button type="button" className="button button--primary button--large" onClick={commitKushikatsuSelection}>{kushikatsuSelection.quantity}本をカートに追加</button></div></div>
        </div>
      </Modal> : null}
      {sakeSelection && selectedSakeItem ? <Modal title="提供方法・温度を選ぶ" onClose={() => setSakeSelection(null)} wide className="modal--sake">
        <div className="sake-serving-modal">
          <p className="modal-lead">{selectedSakeItem.name}の提供形態と温度を選択してください。</p>
          <div className="sake-serving-options" aria-label={`${selectedSakeItem.name}の提供方法`}>
            {selectedSakeItem.variants.map((variant) => <div className={`sake-serving-row ${variant.variantId === selectedSakeVariant?.variantId ? "is-selected" : ""}`} key={variant.variantId}>
              <button type="button" className="sake-serving-option" onClick={() => selectSakeVariant(variant)} aria-pressed={variant.variantId === selectedSakeVariant?.variantId}>
                <span className="sake-serving-option__heading"><b>{variant.name === "グラス" ? "グラス" : "徳利"}</b><small>{variant.name === "徳利1合" ? "1合" : variant.name === "徳利2合" ? "2合" : variant.volumeLabel}</small></span>
                <PriceDisplay priceYen={variant.priceYen} />
              </button>
              {sakeTemperatureOptions(variant).length === 1 ? <span className="sake-temperature-fixed" aria-label={`${sakeVariantLabel(variant)}は${sakeTemperatureOptions(variant)[0]}固定`}>{sakeTemperatureLabel(sakeTemperatureOptions(variant)[0], true)}</span> : <div className="sake-temperature-options" aria-label={`${sakeVariantLabel(variant)}の温度`}>
                {sakeTemperatureOptions(variant).map((temperature) => <button type="button" key={temperature} className={variant.variantId === selectedSakeVariant?.variantId && temperature === sakeSelection.temperature ? "is-selected" : ""} onClick={() => selectSakeTemperature(variant, temperature)} aria-label={`${sakeVariantLabel(variant)}を${temperature}にする`} aria-pressed={variant.variantId === selectedSakeVariant?.variantId && temperature === sakeSelection.temperature}>{sakeTemperatureLabel(temperature)}</button>)}
              </div>}
            </div>)}
          </div>
          {sakeSelectionError ? <p className="sake-selection-error" role="alert">{sakeSelectionError}</p> : null}
          <div className="modal-actions"><button className="button button--quiet" onClick={() => { setSakeSelection(null); setSakeSelectionError(""); }}>キャンセル</button><button className="button button--primary button--large" onClick={addSakeSelection}><Plus size={24} weight="bold" />追加</button></div>
        </div>
      </Modal> : null}
      {modal === "staff" ? <Modal title="スタッフを呼びますか？" onClose={() => setModal(null)}><p className="modal-lead">テーブル {device.tableId} からスタッフへお知らせします。</p><div className="modal-actions"><button className="button button--quiet" onClick={() => setModal(null)}>やめる</button><button className="button button--primary button--large" onClick={callStaff}><Bell size={22} weight="bold" /> 呼び出す</button></div></Modal> : null}
      {modal === "feature" ? <Modal title="確認" onClose={() => setModal(null)}><p className="modal-lead">この機能は次の実装段階で接続します。</p><div className="modal-actions"><button className="button button--primary" onClick={() => setModal(null)}>閉じる</button></div></Modal> : null}
      {modal === "history" ? <Modal title="これまでのご注文" onClose={() => setModal(null)} wide><div className="customer-history">{apiMode && apiHistoryState.loading ? <div className="empty-state"><ClipboardText size={42} /><p>注文履歴を読み込んでいます。</p></div> : apiMode && apiHistoryState.error ? <div className="empty-state"><ClipboardText size={42} /><p>注文履歴を取得できません。</p></div> : customerHistory.length ? customerHistory.map((order) => <article key={order.id}><header><b>{formatTime(order.createdAt)} のご注文</b><span className={`status-chip status-${order.status}`}>{customerTransportLabel(order)}</span></header>{order.items.map((item) => <div key={item.id}><span>{selectionDisplayName({ name: item.nameSnapshot }, item)}</span><b>{item.quantity}点</b></div>)}</article>) : <div className="empty-state"><ClipboardText size={42} /><p>注文履歴はまだありません。</p></div>}</div></Modal> : null}
      {detailItem ? <Modal title={detailItem.name} titleExtra={detailItem.detail?.reading ? <span className="modal__title-reading">{detailItem.detail.reading}</span> : null} onClose={() => setDetailItem(null)} wide className="modal--product-detail" footer={<div className="modal-actions product-detail__actions"><button className="button button--quiet" onClick={() => setDetailItem(null)}>一覧へ戻る</button>{detailItem.categoryId === "shochu" && detailItem.servingOptions?.length ? <button className="button button--primary button--large" onClick={() => chooseShochuFromDetail(detailItem)}>これにする</button> : null}</div>}><div className="product-detail">{detailItem.detail?.imageUri || detailItem.imageUri ? <div className="product-detail__image"><img src={detailItem.detail?.imageUri || detailItem.imageUri} alt={detailItem.name} style={imageLayoutStyle(detailItem, "detail")} /></div> : null}<div>{detailItem.detail?.itemType ? <span className="category-tag">{detailItem.detail.itemType}</span> : null}<p className="product-detail__description">{detailItem.detail?.description || detailItem.description}</p><dl>{[["産地", "origin"], ["蔵元", "producer"], ["味の特徴", "taste"], ["香り", "aroma"], ["甘辛", "sweetness"], ["キレ", "finish"]].filter(([, key]) => detailItem.detail?.[key]).map(([label, key]) => <div key={key}><dt>{label}</dt><dd>{detailItem.detail[key]}</dd></div>)}</dl>{detailItem.detail?.recommendation ? <blockquote>{detailItem.detail.recommendation}</blockquote> : null}</div></div></Modal> : null}
    </div>
  );
}

const staffNavItems = [
  { route: "/kitchen", label: "新着注文", icon: ChefHat },
  { route: "/history", label: "提供済み（履歴）", icon: ClockCounterClockwise },
  { route: "/admin/menu", label: "設定・管理", icon: Gear },
];

const adminNavItems = [
  { route: "/admin/menu", label: "メニュー管理", icon: ClipboardText },
  { route: "/admin/categories", label: "カテゴリ管理", icon: ListBullets },
  { route: "/history", label: "注文履歴", icon: ClockCounterClockwise },
  { route: "/admin/devices", label: "設定", icon: Gear },
];

function StaffShell({ route, title, subtitle, state, children, right, newOrderCount = 0 }) {
  const isKitchen = route === "/kitchen";
  const isAdmin = route.startsWith("/admin");
  const navItems = isAdmin ? adminNavItems : staffNavItems;
  return (
    <div className={`staff-app ${isKitchen ? "staff-app--kitchen" : ""} ${isAdmin ? "staff-app--admin" : ""}`}>
      <aside className="staff-sidebar">
        <Brand />
        <nav>{navItems.map((item) => <button key={item.route} className={route.startsWith(item.route) ? "is-active" : ""} onClick={() => navigate(item.route)}><item.icon size={30} weight="bold" /><span>{item.label}</span>{item.route === "/kitchen" && newOrderCount ? <b className="badge">{newOrderCount}</b> : null}</button>)}</nav>
        <div className="hours"><b>本日の営業時間</b><span>17:00 — 24:00</span><small>ラストオーダー 23:30</small></div>
      </aside>
      <main className="staff-main">
        {isKitchen ? <>
          <header className="staff-topbar staff-topbar--kitchen">
            <div className="restaurant-name"><ClipboardText size={34} weight="bold" /><b>大衆酒場 一番星</b></div>
            {right}
          </header>
          <div className="kitchen-heading"><h1>{title}</h1><p>{subtitle}</p></div>
        </> : isAdmin ? <header className="staff-topbar staff-topbar--admin">
          <div className="staff-title staff-title--admin"><ClipboardText size={58} weight="bold" /><div><h1>{title}</h1><p>{subtitle}</p></div></div>
          {right}
        </header> : <header className="staff-topbar">
            <div className="restaurant-name"><ClipboardText size={34} weight="bold" /><b>大衆酒場 一番星</b></div>
            <div className="staff-title"><span className="section-kicker">STAFF TERMINAL</span><h1>{title}</h1><p>{subtitle}</p></div>
            {right}
          </header>}
        {children}
        <footer className="staff-footer"><span>自動更新中</span><span>アレルギー・原材料についてはスタッフまでお尋ねください。</span><strong>店内禁煙</strong></footer>
      </main>
    </div>
  );
}

function KitchenScreen({ state, updateState, apiState, onServe, onCloseSession }) {
  const [callPanel, setCallPanel] = useState(false);
  const apiMode = Boolean(apiState);
  const sourceOrders = apiMode ? apiState.orders : state.orders;
  const sessions = apiMode ? apiState.sessions : [];
  const activeOrders = sourceOrders.filter((order) => order.status === "new" || order.status === "active");
  const tables = [...new Set([...activeOrders.map((order) => order.tableId), ...sessions.map((session) => session.tableId)])].sort((a, b) => Number(a) - Number(b));
  const activeCalls = state.staffCalls.filter((call) => !call.resolvedAt);
  const kitchenAliases = Object.fromEntries(state.menuItems.map((item) => [item.id, item.kitchenAlias?.trim()]));
  const [resetTarget, setResetTarget] = useState(null);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState(false);

  const toggleServed = (orderId, itemId) => {
    if (apiMode) {
      void onServe(orderId, itemId);
      return;
    }
    updateState((current) => {
      const now = new Date().toISOString();
      const orders = current.orders.map((order) => {
        if (order.id !== orderId) return order;
        const items = order.items.map((item) => item.id === itemId ? { ...item, isServed: !item.isServed, servedAt: item.isServed ? null : now } : item);
        const completed = items.every((item) => item.isServed);
        const anyServed = items.some((item) => item.isServed);
        return { ...order, items, status: completed ? "completed" : anyServed ? "active" : "new", completedAt: completed ? now : null };
      });
      return { ...current, orders };
    });
  };

  const resolveCall = (callId) => updateState((current) => ({ ...current, staffCalls: current.staffCalls.map((call) => call.id === callId ? { ...call, resolvedAt: new Date().toISOString() } : call) }));

  return (
    <StaffShell route="/kitchen" title="新着注文" subtitle="新しいご注文を確認してください。提供済みのテーブルは自動的に履歴へ移動します。" state={state} newOrderCount={activeOrders.length} right={<div className="staff-topbar__right"><button className="staff-call-button" onClick={() => setCallPanel(true)}><Bell size={26} weight="fill" /> スタッフ呼出 {activeCalls.length ? <b>{activeCalls.length}</b> : null}</button><ConnectionBadge online /><time className="kitchen-clock">{formatTime(new Date())}</time></div>}>
      <section className="kitchen-content">
        <div className="table-scroll">
          {apiMode && apiState.loading ? <div className="kitchen-empty"><p>注文を読み込み中です。</p></div> : apiMode && apiState.error ? <div className="kitchen-empty"><p>注文情報を取得できません。</p></div> : tables.length ? tables.map((tableId) => {
            const orders = activeOrders.filter((order) => order.tableId === tableId);
            const session = sessions.find((candidate) => candidate.tableId === tableId) ?? orders.find((order) => order.sessionId);
            const sessionId = session?.sessionId;
            const rows = orders.flatMap((order) => order.items.map((item) => ({ ...item, orderId: order.id, createdAt: order.createdAt }))).sort((a, b) => Number(a.isServed) - Number(b.isServed));
            const total = orders.reduce((sum, order) => sum + order.totalAmount, 0);
            const oldest = orders.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0] ?? { createdAt: session?.openedAt };
            return (
              <article className="table-panel" key={tableId}>
                <header><h2>テーブル <b>{tableId}</b></h2><time>{formatTime(oldest.createdAt)}</time></header>
                <div className="table-panel__rows">
                  {rows.filter((row) => !row.isServed).map((row) => <button className="order-item" key={row.id} onClick={() => toggleServed(row.orderId, row.id)}><span><b>{kitchenMenuName(row, kitchenAliases)}</b><small>{row.quantity}点</small></span><i><Check size={19} weight="bold" /></i></button>)}
                  {rows.some((row) => row.isServed) ? <div className="served-divider"><span>提供済み</span></div> : null}
                  {rows.filter((row) => row.isServed).map((row) => <button className="order-item is-served" key={row.id} onClick={() => toggleServed(row.orderId, row.id)}><span><b>{kitchenMenuName(row, kitchenAliases)}</b><small>{row.quantity}点</small></span><i><Check size={19} weight="bold" /></i></button>)}
                  {!rows.length ? <div className="empty-state"><p>現在の注文はありません。</p></div> : null}
                </div>
                <footer><span>合計</span><b>{yen(total)}</b>{apiMode && sessionId ? <button className="button button--quiet table-panel__reset" onClick={() => { setResetError(false); setResetTarget({ tableId, sessionId }); }}>会計完了・席をリセット</button> : null}</footer>
              </article>
            );
          }) : <div className="kitchen-empty"><CheckCircle size={72} weight="thin" /><h2>すべて提供済みです</h2><p>新しい注文が届くと、ここにテーブルごとに表示されます。</p></div>}
        </div>
        <div className="horizontal-hint"><ArrowLeft size={20} /><span></span><ArrowRight size={20} /></div>
      </section>
      {resetTarget ? <Modal title="会計完了・席をリセット" onClose={() => { if (!resetting) setResetTarget(null); }}><p className="modal-lead">テーブル{resetTarget.tableId}の現在の来店を終了します。注文データは削除されませんが、客席端末には表示されなくなります。</p>{resetError ? <p role="alert">席のリセットに失敗しました。未提供の注文がないか確認してください。</p> : null}<div className="modal-actions"><button className="button button--quiet" onClick={() => setResetTarget(null)} disabled={resetting}>戻る</button><button className="button button--primary button--large" onClick={async () => { setResetting(true); setResetError(false); try { await onCloseSession(resetTarget); setResetTarget(null); } catch { setResetError(true); } finally { setResetting(false); } }} disabled={resetting}>{resetting ? "処理中" : "会計完了・席をリセット"}</button></div></Modal> : null}
      {callPanel ? <Modal title="スタッフ呼び出し" onClose={() => setCallPanel(false)} wide><div className="call-list">{activeCalls.length ? activeCalls.map((call) => <article key={call.id}><Bell size={28} weight="fill" /><div><b>テーブル {call.tableId}</b><span>{formatTime(call.createdAt)} に呼び出し</span></div><button className="button button--primary" onClick={() => resolveCall(call.id)}>対応済みにする</button></article>) : <div className="empty-state"><Bell size={42} /><p>未対応の呼び出しはありません。</p></div>}</div></Modal> : null}
    </StaffShell>
  );
}

function HistoryScreen({ state, apiMode = false, loadHistory = null }) {
  const [remoteState, setRemoteState] = useState({ loading: apiMode, error: false, orders: [] });
  useEffect(() => {
    if (!apiMode) return undefined;
    if (typeof loadHistory !== "function") {
      setRemoteState({ loading: false, error: true, orders: [] });
      return undefined;
    }
    let cancelled = false;
    setRemoteState({ loading: true, error: false, orders: [] });
    void loadHistory({ env: window }).then((orders) => {
      if (!cancelled) setRemoteState({ loading: false, error: false, orders });
    }).catch(() => {
      if (!cancelled) setRemoteState({ loading: false, error: true, orders: [] });
    });
    return () => { cancelled = true; };
  }, [apiMode, loadHistory]);
  const sourceOrders = apiMode ? remoteState.orders.map((order) => ({
    id: order.orderId,
    tableId: String(order.tableId),
    createdAt: new Date(order.acceptedAtMs).toISOString(),
    completedAt: order.completedAtMs ? new Date(order.completedAtMs).toISOString() : null,
    status: order.status,
    totalAmount: order.totalAmountYen,
    items: order.items.map((item) => ({
      id: String(item.orderItemId),
      nameSnapshot: item.formalNameSnapshot,
      unitPriceSnapshot: item.unitPriceYenSnapshot,
      variantId: item.variantId,
      variantNameSnapshot: item.variantNameSnapshot,
      variantVolumeSnapshot: item.variantVolumeSnapshot,
      temperatureSnapshot: item.temperatureSnapshot,
      servingOptionId: item.servingOptionId,
      servingOptionNameSnapshot: item.servingOptionNameSnapshot,
      quantity: item.quantity,
    })),
  })) : state.orders;
  const completed = sourceOrders.filter((order) => order.status === "completed").sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
  const completedToday = completed.filter((order) => isSameLocalDate(order.completedAt));
  return (
    <StaffShell route="/history" title="提供済み（履歴）" subtitle="完了した注文を、注文時点の品名と単価で確認できます。" state={state} right={<ConnectionBadge online />}>
      <section className="history-content">
        <div className="history-summary"><div><small>本日の提供済み</small><b>{completedToday.length}</b><span>件</span></div><div><small>履歴合計</small><b>{yen(completed.reduce((sum, order) => sum + order.totalAmount, 0))}</b></div></div>
        {apiMode && remoteState.loading ? <div className="empty-state"><p>注文履歴を読み込み中です。</p></div> : null}
        {apiMode && remoteState.error ? <div className="empty-state"><p>注文履歴を取得できませんでした。</p></div> : null}
        {(!apiMode || (!remoteState.loading && !remoteState.error)) && completed.length === 0 ? <div className="empty-state"><p>注文履歴はありません。</p></div> : null}
        {(!apiMode || (!remoteState.loading && !remoteState.error)) && completed.length > 0 && <div className="history-table-wrap">
          <table className="history-table">
            <thead><tr><th>注文番号</th><th>テーブル</th><th>受付</th><th>完了</th><th>品目</th><th>合計</th></tr></thead>
            <tbody>{completed.map((order) => <tr key={order.id}><td><b>{order.id}</b></td><td><span className="table-pill">T{order.tableId}</span></td><td>{formatDateTime(order.createdAt)}</td><td>{formatDateTime(order.completedAt)}</td><td><div className="history-items">{order.items.map((item) => <span key={item.id}>{selectionDisplayName({ name: item.nameSnapshot }, item)} <b>{item.quantity}点</b> <small>{yen(item.unitPriceSnapshot)}</small></span>)}</div></td><td className="history-total">{yen(order.totalAmount)}</td></tr>)}</tbody>
          </table>
        </div>}
      </section>
    </StaffShell>
  );
}

const adminTabs = [
  { id: "menu", label: "メニュー", icon: ClipboardText },
  { id: "categories", label: "カテゴリ", icon: ListBullets },
  { id: "devices", label: "端末割り当て", icon: Monitor },
];

const DEFAULT_IMAGE_LAYOUT = Object.freeze({ scale: 1, positionX: 0, positionY: 0, rotation: 0, fit: "contain" });

function ImageLayoutEditor({ item, onClose, onSaved }) {
  const [usage, setUsage] = useState("thumbnail");
  const [mode, setMode] = useState("manual");
  const [layouts, setLayouts] = useState(() => ({ thumbnail: { ...DEFAULT_IMAGE_LAYOUT, ...(item.imageLayouts?.thumbnail ?? {}) }, detail: { ...DEFAULT_IMAGE_LAYOUT, ...(item.imageLayouts?.detail ?? {}) } }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const frameRef = useRef(null);
  const dragRef = useRef(null);
  const layout = layouts[usage];
  const imageUri = usage === "thumbnail" ? item.imageUri : item.detail?.imageUri || item.imageUri;
  const setLayout = (patch) => setLayouts((current) => ({ ...current, [usage]: { ...current[usage], ...patch } }));
  const adjust = (key, amount) => setLayout({ [key]: Math.max(key === "scale" ? 0.5 : key === "rotation" ? -15 : -1, Math.min(key === "scale" ? 4 : key === "rotation" ? 15 : 1, Number((layout[key] + amount).toFixed(2)))) });
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);
  const reset = () => { setMode("manual"); setLayout({ ...DEFAULT_IMAGE_LAYOUT, rotation: layout.rotation }); };
  const selectMode = (nextMode) => {
    setMode(nextMode);
    if (nextMode === "contain") setLayout({ ...DEFAULT_IMAGE_LAYOUT, rotation: layout.rotation });
    if (nextMode === "cover") setLayout({ ...DEFAULT_IMAGE_LAYOUT, rotation: layout.rotation, fit: "cover" });
  };
  const onPointerDown = (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, positionX: layout.positionX, positionY: layout.positionY };
  };
  const onPointerMove = (event) => {
    if (!dragRef.current || !frameRef.current) return;
    const rect = frameRef.current.getBoundingClientRect();
    setLayout({ positionX: Math.max(-1, Math.min(1, dragRef.current.positionX + (event.clientX - dragRef.current.x) / rect.width)), positionY: Math.max(-1, Math.min(1, dragRef.current.positionY + (event.clientY - dragRef.current.y) / rect.height)) });
  };
  const onPointerUp = () => { dragRef.current = null; };
  const onWheel = (event) => { event.preventDefault(); adjust("scale", event.deltaY < 0 ? 0.05 : -0.05); };
  const save = async () => {
    setSaving(true); setError("");
    try {
      const result = await saveAdminImageLayouts({ env: window, menuItemId: item.id, expectedVersion: item.version, layouts });
      onSaved(layouts, result.version);
    } catch (saveError) {
      setError(saveError?.code === "CATALOG_CONFLICT" ? "別の管理端末で更新されています。再読込してからやり直してください。" : "画像構図を保存できませんでした。");
    } finally { setSaving(false); }
  };
  return <Modal title={`画像を調整：${item.name}`} onClose={onClose} wide>
    <div className="image-layout-editor">
      <div className="image-layout-editor__tabs" role="tablist">{[["thumbnail", "一覧用"], ["detail", "詳細用"]].map(([id, label]) => <button type="button" role="tab" aria-selected={usage === id} className={usage === id ? "is-active" : ""} onClick={() => setUsage(id)} key={id}>{label}</button>)}</div>
      <div className="image-layout-editor__workspace">
        <div className={`image-layout-editor__frame image-layout-editor__frame--${usage}`} ref={frameRef} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onWheel={onWheel} aria-label={`${usage === "thumbnail" ? "一覧" : "詳細"}用画像プレビュー`}>
          {imageUri ? <img src={imageUri} alt="" draggable="false" style={imageLayoutTransform(layout)} /> : <span>画像なし</span>}
        </div>
        <div className="image-layout-editor__controls">
          <p className="image-layout-editor__hint">枠内をドラッグ／ホイールで調整（A90相当プレビュー）</p>
          <label>表示モード<select value={mode} onChange={(event) => selectMode(event.target.value)}><option value="contain">全体を収める</option><option value="cover">枠を埋める</option><option value="manual">手動調整</option></select></label>
          <label>ズーム <output>{layout.scale.toFixed(2)}×</output><input type="range" min="0.5" max="4" step="0.01" value={layout.scale} onChange={(event) => setLayout({ scale: Number(event.target.value) })} /></label>
          <div className="image-layout-editor__button-row"><button type="button" onClick={() => adjust("positionY", -0.01)}>↑ 1px</button><button type="button" onClick={() => adjust("positionY", 0.01)}>↓ 1px</button><button type="button" onClick={() => adjust("positionX", -0.01)}>← 1px</button><button type="button" onClick={() => adjust("positionX", 0.01)}>→ 1px</button></div>
          <div className="image-layout-editor__button-row"><button type="button" onClick={() => adjust("positionY", -0.05)}>↑ 5px</button><button type="button" onClick={() => adjust("positionY", 0.05)}>↓ 5px</button><button type="button" onClick={() => adjust("positionX", -0.05)}>← 5px</button><button type="button" onClick={() => adjust("positionX", 0.05)}>→ 5px</button></div>
          <label>角度 <output>{layout.rotation.toFixed(1)}°</output><input type="range" min="-15" max="15" step="0.1" value={layout.rotation} onChange={(event) => setLayout({ rotation: Number(event.target.value) })} /></label>
          <div className="image-layout-editor__button-row"><button type="button" onClick={() => adjust("rotation", -1)}>↶ 1°</button><button type="button" onClick={() => adjust("rotation", -0.1)}>↶ 0.1°</button><button type="button" onClick={() => adjust("rotation", 0.1)}>↷ 0.1°</button><button type="button" onClick={() => adjust("rotation", 1)}>↷ 1°</button></div>
          <div className="image-layout-editor__actions"><button type="button" className="button button--quiet" onClick={reset}>リセット</button><button type="button" className="button button--quiet" onClick={onClose}>キャンセル</button><button type="button" className="button button--primary" disabled={saving} onClick={save}>{saving ? "保存中" : "保存"}</button></div>
          {error ? <p role="alert" className="image-layout-editor__error">{error}</p> : null}
        </div>
      </div>
    </div>
  </Modal>;
}

function AdminScreen({ state, updateState, section = "menu" }) {
  const [showAdd, setShowAdd] = useState(false);
  const [editingMenuId, setEditingMenuId] = useState(null);
  const [pairingTableId, setPairingTableId] = useState("1");
  const [pairingQr, setPairingQr] = useState(null);
  const [pairingError, setPairingError] = useState("");
  const [disconnectingDeviceId, setDisconnectingDeviceId] = useState("");
  const [disconnectError, setDisconnectError] = useState("");
  const [pairingPreflight, setPairingPreflight] = useState({ loading: false, data: null, error: null });
  const [diagnosticState, setDiagnosticState] = useState({ loading: false, data: null, error: null });
  const [diagnosticRefreshKey, setDiagnosticRefreshKey] = useState(0);
  const [diagnosticExpanded, setDiagnosticExpanded] = useState(false);
  const [imageLayoutItemId, setImageLayoutItemId] = useState(null);
  const [catalogState, setCatalogState] = useState({ loading: Boolean(configuredAdminToken(window)) && section === "menu", error: false, saving: false, message: "" });
  const [reorderMode, setReorderMode] = useState(false);
  const [reorderCategoryId, setReorderCategoryId] = useState("");
  const [reorderDraftIds, setReorderDraftIds] = useState([]);
  const [reorderBaseIds, setReorderBaseIds] = useState([]);
  const [draggedMenuId, setDraggedMenuId] = useState(null);
  const [categoryEditorId, setCategoryEditorId] = useState(null);
  const adminApiMode = Boolean(configuredAdminToken(window));
  useEffect(() => {
    if (!adminApiMode || !["menu", "categories"].includes(section)) return undefined;
    let cancelled = false;
    const load = async () => {
      try {
        const catalog = await fetchAdminMenu({ env: window });
        if (cancelled) return;
        updateState((current) => ({
          ...current,
          ...mapAdminCatalogState(catalog),
        }));
        setCatalogState({ loading: false, error: false, saving: false, message: "" });
      } catch {
        if (!cancelled) setCatalogState({ loading: false, error: true, saving: false, message: "管理カタログを取得できませんでした。" });
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [adminApiMode, section]);
  useEffect(() => {
    if (section !== "devices") {
      setPairingPreflight({ loading: false, data: null, error: null });
      return undefined;
    }
    let cancelled = false;
    setPairingPreflight({ loading: true, data: null, error: null });
    const load = async () => {
      try {
        const data = await fetchAdminPairingPreflight({ env: window });
        if (cancelled) return;
        setPairingPreflight({ loading: false, data, error: null });
        const available = data.tables?.available ?? [];
        if (available.length && !available.some((table) => String(table.tableId) === pairingTableId)) setPairingTableId(String(available[0].tableId));
      } catch (error) {
        if (!cancelled) setPairingPreflight({ loading: false, data: null, error });
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [section, adminApiMode]);
  useEffect(() => {
    if (!adminApiMode || section !== "devices") {
      setDiagnosticState({ loading: false, data: null, error: null });
      return undefined;
    }
    let cancelled = false;
    const load = async () => {
      setDiagnosticState((current) => ({ ...current, loading: true, error: null }));
      try {
        const data = await fetchAdminDiagnostics({ env: window });
        if (!cancelled) setDiagnosticState({ loading: false, data, error: null });
      } catch (error) {
        if (!cancelled) setDiagnosticState({ loading: false, data: null, error });
      }
    };
    void load();
    const timer = window.setInterval(load, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [section, adminApiMode, diagnosticRefreshKey]);
  const categoriesById = Object.fromEntries(state.categories.map((category) => [category.id, category]));
  const editingMenu = state.menuItems.find((item) => item.id === editingMenuId) ?? null;
  const setMenuItem = (id, patch) => updateState((current) => ({ ...current, menuItems: current.menuItems.map((item) => item.id === id ? { ...item, ...patch } : item) }));
  const setCategory = (id, patch) => updateState((current) => ({ ...current, categories: current.categories.map((item) => item.id === id ? { ...item, ...patch } : item) }));
  const addMenu = async (event) => {
    event.preventDefault();
    if (catalogState.saving) return;
    const form = new FormData(event.currentTarget);
    const name = form.get("name")?.toString().trim();
    const kitchenAlias = form.get("kitchenAlias")?.toString().trim();
    if (!name) return;
    const targetId = editingMenuId ?? makeId("menu");
    const variantDefinitions = [
      ["グラス", "110ml", "glassPrice", "glass", "glassCold", "glassHot"],
      ["徳利1合", "180ml", "tokuriPrice", "tokuri", "tokuriCold", "tokuriHot"],
      ["徳利2合", "360ml", "tokuri2Price", "tokuri2", "tokuri2Cold", "tokuri2Hot"],
    ];
    const foodVariants = foodVariantDefinitions(editingMenu).map(({ name: fallbackName, index }) => {
      const existingVariant = editingMenu?.variants?.find((variant) => variant.name === fallbackName) ?? editingMenu?.variants?.[index];
      const name = form.get(`foodVariantName${index}`)?.toString().trim() || fallbackName;
      const priceYen = Number(form.get(`foodVariantPrice${index}`));
      return Number.isSafeInteger(priceYen) && priceYen >= 0 ? {
        variantId: existingVariant?.variantId ?? `${targetId}-variant-${index + 1}`,
        name,
        volumeLabel: existingVariant?.volumeLabel ?? "",
        priceYen,
        sortOrder: index + 1,
        isActive: form.get(`foodVariantActive${index}`) === "on",
      } : null;
    }).filter(Boolean);
    const variants = foodVariants.length ? foodVariants : variantDefinitions.map(([variantName, volumeLabel, priceField, suffix, coldField, hotField], index) => {
      const price = Number(form.get(priceField));
      if (!Number.isSafeInteger(price) || price <= 0) return null;
      const existingVariant = editingMenu?.variants?.find((variant) => variant.name === variantName);
      const defaultTemperatures = variantName === "グラス" ? ["冷酒"] : ["冷酒", "燗酒"];
      const temperatureOptions = [
        ...(form.get(coldField) ? ["冷酒"] : []),
        ...(form.get(hotField) ? ["燗酒"] : []),
      ];
      return {
        variantId: existingVariant?.variantId ?? `${targetId}_${suffix}`.replace(/[^A-Za-z0-9_-]/g, "_"),
        name: variantName,
        volumeLabel,
        priceYen: price,
        sortOrder: index + 1,
        temperatureOptions: temperatureOptions.length ? temperatureOptions : defaultTemperatures,
      };
    }).filter(Boolean);
    const servingOptions = form.get("shochuOptions") ? ["ロック", "水割り", "ソーダ割り", "お湯割り"].map((optionName, index) => ({
      servingOptionId: editingMenu?.servingOptions?.find((option) => option.name === optionName)?.servingOptionId
        ?? `${targetId}-${["rock", "water", "soda", "hot"][index]}`.replace(/[^A-Za-z0-9_-]/g, "_"),
      name: optionName,
      sortOrder: index + 1,
    })) : [];
    const patch = {
      id: targetId,
      categoryId: form.get("categoryId"),
      name,
      kitchenAlias,
      description: form.get("description")?.toString().trim() ?? "",
      orderingMode: form.get("orderingMode") === "reservation_only" ? "reservation_only" : "normal",
      price: Number(form.get("price")) || 0,
      imageUri: form.get("imageUri")?.toString().trim() || undefined,
      sectionKey: form.get("sectionKey")?.toString().trim() || undefined,
      detail: {
        enabled: form.get("detailEnabled") === "on",
        showImageInList: form.get("categoryId") === "sake" || form.get("showImageInList") === "on",
        imageUri: form.get("detailImageUri")?.toString().trim() || undefined,
        reading: form.get("reading")?.toString().trim() || undefined,
        itemType: form.get("itemType")?.toString().trim() || undefined,
        origin: form.get("origin")?.toString().trim() || undefined,
        producer: form.get("producer")?.toString().trim() || undefined,
        taste: form.get("taste")?.toString().trim() || undefined,
        aroma: form.get("aroma")?.toString().trim() || undefined,
        sweetness: form.get("sweetness")?.toString().trim() || undefined,
        finish: form.get("finish")?.toString().trim() || undefined,
        recommendation: form.get("recommendation")?.toString().trim() || undefined,
        description: form.get("detailDescription")?.toString().trim() || undefined,
      },
      variants: servingOptions.length ? [] : variants,
      servingOptions,
    };
    const nextItem = editingMenuId ? {
      ...(editingMenu ?? {}),
      ...patch,
      isSoldOut: form.get("isSoldOut") === "on",
      isActive: form.get("isActive") === "on",
      sortOrder: Number(form.get("sortOrder")) || editingMenu?.sortOrder || 1,
    } : {
      ...patch,
      isSoldOut: false,
      isActive: true,
      sortOrder: state.menuItems.filter((item) => item.categoryId === form.get("categoryId")).length + 1,
    };
    setCatalogState((current) => ({ ...current, saving: adminApiMode, message: "" }));
    if (adminApiMode) {
      try {
        const result = await saveAdminMenuItem({ env: window, item: nextItem, expectedVersion: editingMenu?.version ?? 0 });
        const refreshedCatalog = await fetchAdminMenu({ env: window });
        const refreshedItem = refreshedCatalog.items.find((item) => item.menuItemId === nextItem.id);
        if (!refreshedItem || refreshedItem.version !== result.version) throw new Error("管理カタログの保存結果を再取得できませんでした。");
        const refreshedPatch = {
          id: refreshedItem.menuItemId,
          categoryId: refreshedItem.categoryId,
          name: refreshedItem.formalName,
          kitchenAlias: refreshedItem.kitchenAlias,
          description: refreshedItem.description,
          price: refreshedItem.priceYen,
          imageUri: refreshedItem.imageUri,
          sectionKey: refreshedItem.sectionKey,
          isSoldOut: refreshedItem.isSoldOut,
          orderingMode: refreshedItem.orderingMode ?? "normal",
          isActive: refreshedItem.isActive,
          sortOrder: refreshedItem.sortOrder,
          version: refreshedItem.version,
          detail: refreshedItem.detail,
          variants: refreshedItem.variants ?? [],
          servingOptions: refreshedItem.servingOptions ?? [],
          imageLayouts: refreshedItem.imageLayouts,
        };
        setCatalogState({ loading: false, error: false, saving: false, message: "保存しました。" });
        updateState((current) => editingMenuId ? ({
          ...current,
          menuItems: current.menuItems.map((item) => item.id === editingMenuId ? refreshedPatch : item),
        }) : ({ ...current, menuItems: [...current.menuItems, refreshedPatch] }));
        setShowAdd(false);
        setEditingMenuId(null);
        return;
      } catch (error) {
        const failureDetail = error?.status
          ? `HTTP ${error.status} / ${error.code || "UNKNOWN_ERROR"}${error.requestId ? ` / request ID ${error.requestId}` : ""}`
          : "管理APIへ接続できません";
        setCatalogState({ loading: false, error: false, saving: false, message: error?.code === "CATALOG_CONFLICT" ? "別の管理端末で更新されています。再読込してから保存してください。" : `保存できませんでした（${failureDetail}）。` });
        return;
      }
    }
    updateState((current) => editingMenuId ? ({
      ...current,
      menuItems: current.menuItems.map((item) => item.id === editingMenuId ? { ...item, ...patch } : item),
    }) : ({
      ...current,
      menuItems: [...current.menuItems, { ...nextItem, ...patch }],
    }));
    setShowAdd(false);
    setEditingMenuId(null);
  };
  const refreshAdminCatalog = async () => {
    const catalog = await fetchAdminMenu({ env: window });
    updateState((current) => ({ ...current, ...mapAdminCatalogState(catalog) }));
    return catalog;
  };
  const saveCategory = async (event) => {
    event.preventDefault();
    if (catalogState.saving) return;
    const form = new FormData(event.currentTarget);
    const name = form.get("name")?.toString().trim();
    if (!name) return;
    const current = state.categories.find((category) => category.id === categoryEditorId);
    const category = {
      ...(current ?? {}), id: categoryEditorId ?? undefined, name,
      sectionKey: form.get("sectionKey")?.toString() || "food",
      sortOrder: Number(form.get("sortOrder")) || 0,
      isVisible: form.get("isVisible") === "on",
    };
    setCatalogState((value) => ({ ...value, saving: true, message: "" }));
    try {
      if (adminApiMode) await saveAdminCategory({ env: window, category, expectedVersion: current?.version ?? 0 });
      if (adminApiMode) await refreshAdminCatalog();
      else updateState((value) => ({ ...value, categories: current ? value.categories.map((item) => item.id === current.id ? { ...item, ...category } : item) : [...value.categories, { ...category, id: makeId("category"), version: 1 }] }));
      setCatalogState({ loading: false, error: false, saving: false, message: "カテゴリーを保存しました。" });
      setShowAdd(false);
      setCategoryEditorId(null);
    } catch (error) {
      setCatalogState({ loading: false, error: false, saving: false, message: error?.code === "CATALOG_CONFLICT" ? "別の管理端末で更新されています。再読込してから保存してください。" : `カテゴリーを保存できませんでした（HTTP ${error?.status ?? "?"}）。` });
    }
  };
  const moveCategory = async (category, delta) => {
    if (catalogState.saving || !adminApiMode) return;
    const peers = sortedCategories.filter((item) => item.sectionKey === category.sectionKey);
    const index = peers.findIndex((item) => item.id === category.id);
    const target = peers[index + delta];
    if (!target) return;
    setCatalogState((value) => ({ ...value, saving: true, message: "" }));
    try {
      await saveAdminCategory({ env: window, category: { ...target, sortOrder: category.sortOrder }, expectedVersion: target.version });
      await saveAdminCategory({ env: window, category: { ...category, sortOrder: target.sortOrder }, expectedVersion: category.version });
      await refreshAdminCatalog();
      setCatalogState({ loading: false, error: false, saving: false, message: "表示順を保存しました。" });
    } catch (error) {
      setCatalogState({ loading: false, error: false, saving: false, message: error?.code === "CATALOG_CONFLICT" ? "別の管理端末で更新されています。" : "表示順を保存できませんでした。" });
    }
  };
  const beginReorder = () => {
    const first = reorderCategoryId || menuGroups[0]?.category.id || "";
    const group = menuGroups.find((entry) => entry.category.id === first) ?? menuGroups[0];
    const ids = group?.items.map((item) => item.id) ?? [];
    setReorderCategoryId(group?.category.id ?? "");
    setReorderDraftIds(ids);
    setReorderBaseIds(ids);
    setReorderMode(true);
  };
  const cancelReorder = () => {
    setReorderDraftIds(reorderBaseIds);
    setDraggedMenuId(null);
    setReorderMode(false);
  };
  const moveReorderItem = (fromId, toId) => {
    if (!fromId || !toId || fromId === toId || catalogState.saving) return;
    setReorderDraftIds((ids) => { const next = [...ids]; const from = next.indexOf(fromId); const to = next.indexOf(toId); if (from < 0 || to < 0) return ids; next.splice(from, 1); next.splice(to, 0, fromId); return next; });
  };
  const shiftReorderItem = (id, delta) => setReorderDraftIds((ids) => { const index = ids.indexOf(id); const target = index + delta; if (index < 0 || target < 0 || target >= ids.length) return ids; const next = [...ids]; [next[index], next[target]] = [next[target], next[index]]; return next; });
  const saveReorder = async () => {
    const category = state.categories.find((item) => item.id === reorderCategoryId);
    if (!category || catalogState.saving || reorderDraftIds.length === 0) return;
    setCatalogState((value) => ({ ...value, saving: true, message: "" }));
    try {
      if (adminApiMode) await saveAdminMenuOrdering({ env: window, categoryId: category.id, menuItemIds: reorderDraftIds, expectedVersion: category.version });
      else updateState((current) => ({ ...current, menuItems: current.menuItems.map((item) => { const index = reorderDraftIds.indexOf(item.id); return index < 0 ? item : { ...item, sortOrder: (index + 1) * 10 }; }) }));
      if (adminApiMode) await refreshAdminCatalog();
      setReorderBaseIds(reorderDraftIds);
      setCatalogState({ loading: false, error: false, saving: false, message: "商品の並び順を保存しました。" });
      setReorderMode(false);
    } catch (error) {
      setCatalogState({ loading: false, error: false, saving: false, message: error?.code === "CATALOG_CONFLICT" ? "別の管理端末で更新されています。再読込してから保存してください。" : "商品の並び順を保存できませんでした。" });
    }
  };
  const resetMenuEditor = () => {
    setShowAdd(false);
    setEditingMenuId(null);
  };
  const sortedCategories = [...state.categories].sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id, "ja"));
  const categoryOrder = Object.fromEntries(sortedCategories.map((category, index) => [category.id, index]));
  const sortedMenus = [...state.menuItems].sort((a, b) => categoryOrder[a.categoryId] - categoryOrder[b.categoryId] || compareMenuItems(a, b));
  const knownCategoryIds = new Set(sortedCategories.map((category) => category.id));
  const menuGroups = [
    ...sortedCategories.map((category) => ({ category, items: sortedMenus.filter((item) => item.categoryId === category.id) })).filter((group) => group.items.length > 0),
    { category: { id: "__uncategorized", name: "未分類" }, items: sortedMenus.filter((item) => !knownCategoryIds.has(item.categoryId)) },
  ].filter((group) => group.items.length > 0);
  const selectedReorderGroup = menuGroups.find((group) => group.category.id === reorderCategoryId) ?? menuGroups[0];
  const displayedMenuGroups = reorderMode && selectedReorderGroup ? [selectedReorderGroup] : menuGroups;
  const refreshPairingPreflight = async () => {
    setPairingPreflight((current) => ({ ...current, loading: true, error: null }));
    try {
      const data = await fetchAdminPairingPreflight({ env: window });
      setPairingPreflight({ loading: false, data, error: null });
      const available = data.tables?.available ?? [];
      if (available.length && !available.some((table) => String(table.tableId) === pairingTableId)) setPairingTableId(String(available[0].tableId));
      return data;
    } catch (error) {
      setPairingPreflight({ loading: false, data: null, error });
      throw error;
    }
  };
  const issuePairing = async () => {
    setPairingError("");
    setPairingQr(null);
    let preflight;
    try {
      preflight = await refreshPairingPreflight();
    } catch (error) {
      setPairingError(pairingErrorMessage(error));
      return;
    }
    const blockedMessage = pairingPreflightBlockMessage(preflight);
    const selectedTable = preflight.tables?.available?.find((table) => String(table.tableId) === pairingTableId);
    if (blockedMessage || !selectedTable) {
      setPairingError(blockedMessage || "空きテーブルを選択してください。");
      return;
    }
    let result;
    try {
      result = await issueCustomerPairingCode({ tableId: Number(pairingTableId), expiresAtMs: Date.now() + 10 * 60 * 1000 });
    } catch (error) {
      setPairingError(pairingErrorMessage(error));
      return;
    }
    try {
      const url = new URL(result.pairingUrl);
      if (url.origin !== preflight.server.pairingUrlOrigin || url.pathname !== "/pairing.html" || !url.hash.startsWith("#p=")) throw new Error("PAIRING_URL_INVALID");
      setPairingQr({ svg: pairingCodeQrSvg(result.pairingUrl), origin: url.origin });
    } catch (error) {
      setPairingError(error?.message === "PAIRING_URL_INVALID" ? pairingErrorMessage(new AdminPairingError("", { code: "PAIRING_URL_INVALID" })) : "QR生成失敗：現在のLAN pairing URLからQRを描画できませんでした。");
    }
  };
  const disconnectCustomerDevice = async (table) => {
    if (!table?.deviceId || (typeof window.confirm === "function" && !window.confirm(`テーブル${table.tableId}の端末接続を解除しますか？`))) return;
    setDisconnectError("");
    setDisconnectingDeviceId(table.deviceId);
    try {
      await revokeAdminDevice({ env: window, deviceId: table.deviceId });
      await refreshPairingPreflight();
    } catch (error) {
      setDisconnectError(pairingErrorMessage(error));
    } finally {
      setDisconnectingDeviceId("");
    }
  };
  const availablePairingTables = pairingPreflight.data?.tables?.available ?? [];
  const assignedPairingTables = pairingPreflight.data?.tables?.assigned ?? [];
  const fallbackTableOptions = state.devices.map((device) => ({ tableId: Number(device.tableId), label: `Table ${device.tableId}` })).filter((table) => Number.isSafeInteger(table.tableId) && table.tableId > 0);
  const pairingTableOptions = [...new Map([...availablePairingTables, ...assignedPairingTables, ...fallbackTableOptions].map((table) => [table.tableId, table])).values()]
    .sort((a, b) => a.tableId - b.tableId);
  const adminDeviceRows = adminApiMode && pairingPreflight.data
    ? assignedPairingTables.map((table) => ({ deviceId: table.deviceId, label: table.deviceDisplayName, tableId: String(table.tableId), deviceStatus: table.deviceStatus }))
    : state.devices;
  const pairingBlockedMessage = pairingPreflight.error ? pairingErrorMessage(pairingPreflight.error) : pairingPreflightBlockMessage(pairingPreflight.data);
  const pairingCanIssue = !pairingPreflight.loading && !pairingPreflight.error && pairingBlockedMessage === "";
  const diagnosticData = diagnosticState.data;
  const latestOrderSend = diagnosticData?.latestOrderSend;
  const latestOrderRetrieval = diagnosticData?.latestOrderRetrieval;
  const diagnosticHasIssue = Boolean(diagnosticState.error || (diagnosticData && (
    diagnosticData.runtime?.databaseTarget !== "safe-copy" ||
    diagnosticData.runtime?.isProduction ||
    diagnosticData.health?.status !== "ready" ||
    diagnosticData.health?.db !== "ready" ||
    diagnosticData.authentication?.status !== "valid" ||
    [latestOrderSend, latestOrderRetrieval].some((entry) => entry && Number(entry.status) >= 400)
  )));
  const diagnosticSummaryLabel = diagnosticState.loading ? "通信状態：確認中" : diagnosticHasIssue ? "通信状態：要確認" : "通信状態：正常";
  const diagnosticUpdatedLabel = diagnosticData?.generatedAt
    ? new Date(diagnosticData.generatedAt).toLocaleString("ja-JP")
    : "未取得";
  const diagnosticResultLabel = (entry, emptyLabel) => entry
    ? `${entry.status ?? "?"}${entry.errorCode ? `・${entry.errorCode}` : ""}`
    : emptyLabel;
  useEffect(() => {
    if (diagnosticHasIssue) setDiagnosticExpanded(true);
  }, [diagnosticHasIssue]);

  return (
    <StaffShell route={`/admin/${section}`} title="メニュー管理" subtitle="メニューの追加・編集・並び順の変更ができます。" state={state} right={<button className="save-indicator" type="button"><Check size={24} weight="bold" /> {catalogState.saving ? "保存中" : catalogState.message || "保存する"}</button>}>
      <section className="admin-content">
        <nav className="admin-tabs">{adminTabs.map((tab) => <button key={tab.id} className={section === tab.id ? "is-active" : ""} onClick={() => { resetMenuEditor(); navigate(`/admin/${tab.id}`); }}><tab.icon size={24} weight="bold" /> {tab.label}</button>)}</nav>

        {adminApiMode && catalogState.loading ? <p className="empty-state">管理カタログを読み込み中です。</p> : null}
        {adminApiMode && catalogState.error ? <p className="empty-state" role="alert">{catalogState.message}</p> : null}

        {section === "menu" ? <>
           <div className="admin-toolbar"><div className="admin-metrics"><span>登録数 <b>{state.menuItems.length}</b> 品</span><span>売り切れ <b>{Math.max(2, state.menuItems.filter((item) => item.isSoldOut).length)}</b> 品</span></div><div className="admin-toolbar__actions"><button className="button button--outline" type="button" onClick={() => reorderMode ? cancelReorder() : beginReorder()}>{reorderMode ? "通常編集へ戻る" : "並び替えモード"}</button><button className="button button--outline button--large" onClick={() => showAdd ? resetMenuEditor() : (setEditingMenuId(null), setShowAdd(true))}><Plus size={28} weight="bold" /> {showAdd ? "編集を閉じる" : "新しいメニューを追加"}</button></div></div>
           {reorderMode ? <div className="menu-reorder-toolbar"><label>対象カテゴリー<select value={reorderCategoryId} onChange={(event) => { const next = menuGroups.find((group) => group.category.id === event.target.value); setReorderCategoryId(event.target.value); setReorderDraftIds(next?.items.map((item) => item.id) ?? []); setReorderBaseIds(next?.items.map((item) => item.id) ?? []); }} disabled={catalogState.saving}>{menuGroups.map((group) => <option key={group.category.id} value={group.category.id}>{group.category.name}</option>)}</select></label><button className="button button--quiet" type="button" onClick={cancelReorder} disabled={catalogState.saving}>キャンセル</button><button className="button button--primary" type="button" onClick={saveReorder} disabled={catalogState.saving}>{catalogState.saving ? "保存中" : "並び順を保存"}</button></div> : null}
          {showAdd ? <form className="inline-form inline-form--menu menu-editor" key={editingMenuId ?? "new-menu"} onSubmit={addMenu}>
            <label>正式名<input name="name" required placeholder="例：だし巻き玉子" defaultValue={editingMenu?.name ?? ""} /></label>
            <label>厨房用の通称<input name="kitchenAlias" required placeholder="例：だし巻き" defaultValue={editingMenu?.kitchenAlias ?? DEFAULT_KITCHEN_MENU_ALIASES[editingMenu?.id] ?? ""} /></label>
            <label>カテゴリ<select name="categoryId" defaultValue={editingMenu?.categoryId}>{state.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
            <label>税込マスター価格<input name="price" type="number" min="0" step="1" defaultValue={editingMenu?.price ?? 500} /></label>
            <label className="menu-editor__wide">商品説明／一言コメント<textarea name="description" defaultValue={editingMenu?.description ?? ""} /></label>
            <label className="menu-editor__check"><input type="checkbox" name="isSoldOut" defaultChecked={editingMenu?.isSoldOut ?? false} /> 売り切れ</label>
            <fieldset className="menu-ordering-mode"><legend>注文方法</legend><label><input type="radio" name="orderingMode" value="normal" defaultChecked={(editingMenu?.orderingMode ?? "normal") === "normal"} /> 注文方法：通常注文</label><label><input type="radio" name="orderingMode" value="reservation_only" defaultChecked={editingMenu?.orderingMode === "reservation_only"} /> 注文方法：予約限定</label></fieldset>
            <label className="menu-editor__check"><input type="checkbox" name="isActive" defaultChecked={editingMenu?.isActive !== false} /> 販売中</label>
            <label>並び順<input name="sortOrder" type="number" min="0" step="1" defaultValue={editingMenu?.sortOrder ?? 1} /></label>
            <label>商品画像URI<input name="imageUri" defaultValue={editingMenu?.imageUri ?? ""} /></label>
            <label className="menu-editor__check"><input type="checkbox" name="showImageInList" defaultChecked={editingMenu?.detail?.showImageInList ?? editingMenu?.categoryId === "shochu"} /> 一覧に画像を表示（日本酒は常時表示）</label>
            <label>焼酎内の区分<select name="sectionKey" defaultValue={editingMenu?.sectionKey ?? ""}><option value="">なし</option><option value="芋">芋</option><option value="麦・その他">麦・その他</option></select></label>
            <label className="menu-editor__check"><input type="checkbox" name="shochuOptions" defaultChecked={Boolean(editingMenu?.servingOptions?.length)} /> 焼酎の標準4種の飲み方を使用</label>
            {editingMenu?.id && foodVariantDefinitions(editingMenu).length ? <fieldset className="food-variant-editor"><legend>variant（税込）</legend>{foodVariantDefinitions(editingMenu).map(({ name, index }) => <div key={name}><label>{name}<input name={`foodVariantName${index}`} defaultValue={editingMenu.variants?.[index]?.name ?? name} /></label><label>税込価格<input name={`foodVariantPrice${index}`} type="number" min="0" step="1" defaultValue={editingMenu.variants?.[index]?.priceYen ?? 0} /></label><label className="menu-editor__check"><input type="checkbox" name={`foodVariantActive${index}`} defaultChecked={editingMenu.variants?.[index]?.isActive !== false} /> 販売中</label></div>)}</fieldset> : editingMenu?.categoryId === "sake" ? <fieldset className="sake-variant-editor"><legend>日本酒variant（税込・提供温度）</legend><div><label>グラス 110ml<input name="glassPrice" type="number" min="0" defaultValue={editingMenu?.variants?.find((variant) => variant.name === "グラス")?.priceYen ?? ""} /></label><label><input type="checkbox" name="glassCold" defaultChecked={editingMenu?.variants?.find((variant) => variant.name === "グラス")?.temperatureOptions?.includes("冷酒") ?? true} /> 冷酒</label><label><input type="checkbox" name="glassHot" defaultChecked={editingMenu?.variants?.find((variant) => variant.name === "グラス")?.temperatureOptions?.includes("燗酒") ?? false} /> 燗酒</label></div><div><label>徳利1合 180ml<input name="tokuriPrice" type="number" min="0" defaultValue={editingMenu?.variants?.find((variant) => variant.name === "徳利1合")?.priceYen ?? ""} /></label><label><input type="checkbox" name="tokuriCold" defaultChecked={editingMenu?.variants?.find((variant) => variant.name === "徳利1合")?.temperatureOptions?.includes("冷酒") ?? true} /> 冷酒</label><label><input type="checkbox" name="tokuriHot" defaultChecked={editingMenu?.variants?.find((variant) => variant.name === "徳利1合")?.temperatureOptions?.includes("燗酒") ?? true} /> 燗酒</label></div><div><label>徳利2合 360ml<input name="tokuri2Price" type="number" min="0" defaultValue={editingMenu?.variants?.find((variant) => variant.name === "徳利2合")?.priceYen ?? ""} /></label><label><input type="checkbox" name="tokuri2Cold" defaultChecked={editingMenu?.variants?.find((variant) => variant.name === "徳利2合")?.temperatureOptions?.includes("冷酒") ?? true} /> 冷酒</label><label><input type="checkbox" name="tokuri2Hot" defaultChecked={editingMenu?.variants?.find((variant) => variant.name === "徳利2合")?.temperatureOptions?.includes("燗酒") ?? true} /> 燗酒</label></div></fieldset> : null}
            <label className="menu-editor__check"><input type="checkbox" name="detailEnabled" defaultChecked={editingMenu?.detail?.enabled ?? false} /> 詳細表示を有効にする</label>
            <label>詳細画像URI<input name="detailImageUri" defaultValue={editingMenu?.detail?.imageUri ?? ""} /></label>
            <label>ふりがな<input name="reading" defaultValue={editingMenu?.detail?.reading ?? ""} /></label>
            <label>酒種<input name="itemType" defaultValue={editingMenu?.detail?.itemType ?? ""} /></label>
            <label>産地<input name="origin" defaultValue={editingMenu?.detail?.origin ?? ""} /></label>
            <label>蔵元<input name="producer" defaultValue={editingMenu?.detail?.producer ?? ""} /></label>
            <label>味の特徴<input name="taste" defaultValue={editingMenu?.detail?.taste ?? ""} /></label>
            <label>香り<input name="aroma" defaultValue={editingMenu?.detail?.aroma ?? ""} /></label>
            <label>甘辛<input name="sweetness" defaultValue={editingMenu?.detail?.sweetness ?? ""} /></label>
            <label>キレ<input name="finish" defaultValue={editingMenu?.detail?.finish ?? ""} /></label>
            <label className="menu-editor__wide">詳細説明<textarea name="detailDescription" defaultValue={editingMenu?.detail?.description ?? ""} /></label>
            <label className="menu-editor__wide">おすすめコメント<textarea name="recommendation" defaultValue={editingMenu?.detail?.recommendation ?? ""} /></label>
             <div className="menu-editor__actions"><button className="button button--quiet" type="button" onClick={resetMenuEditor} disabled={catalogState.saving}>キャンセル</button><button className="button button--primary" type="submit" disabled={catalogState.saving}>{catalogState.saving ? "保存中" : editingMenu ? "変更を保存" : "追加する"}</button></div>
           </form> : null}
           {reorderMode ? <div className="menu-reorder-list" aria-label="商品の並び替え">{reorderDraftIds.map((id) => selectedReorderGroup?.items.find((entry) => entry.id === id)).filter(Boolean).map((item) => <div className="menu-reorder-row" key={item.id} onDragOver={(event) => event.preventDefault()} onDrop={() => { moveReorderItem(draggedMenuId, item.id); setDraggedMenuId(null); }}><button className="reorder-handle" type="button" draggable={!catalogState.saving} aria-label={`${item.name}をドラッグして並び替え`} onDragStart={() => setDraggedMenuId(item.id)}>≡</button><b>{String(reorderDraftIds.indexOf(item.id) + 1).padStart(2, "0")}</b><span>{item.name}</span><small>{item.kitchenAlias ?? item.name}</small><button type="button" className="button button--quiet" onClick={() => shiftReorderItem(item.id, -1)} disabled={catalogState.saving}>上へ</button><button type="button" className="button button--quiet" onClick={() => shiftReorderItem(item.id, 1)} disabled={catalogState.saving}>下へ</button></div>)}</div> : <div className="menu-admin-list"><div className="admin-row admin-row--header"><span>画像</span><span>カテゴリー</span><span>正式名・通称</span><span>価格（税込）</span><span>販売状況</span><span>並び順</span><span>操作</span></div>{displayedMenuGroups.map(({ category, items }) => <section className="menu-admin-group" key={category.id}><h3 className="menu-admin-group__heading"><span>{category.name}</span><small>{items.length}品</small></h3>{items.map((item) => <div className={`admin-row ${item.isSoldOut ? "is-muted" : ""}`} key={item.id}><div className="image-placeholder">画像なし</div><span className="category-tag">{category.name}</span><div className="admin-row__name"><b>{item.name}</b><small>通称：{item.kitchenAlias ?? DEFAULT_KITCHEN_MENU_ALIASES[item.id] ?? item.name}</small></div><label className="price-input"><input type="number" value={item.price} min="0" step="10" onChange={(event) => setMenuItem(item.id, { price: Number(event.target.value) })} /><small>円</small></label><button className={`toggle ${item.isSoldOut ? "" : "is-on"}`} onClick={() => setMenuItem(item.id, { isSoldOut: !item.isSoldOut })}><i></i><span>{item.isSoldOut ? "売り切れ" : "販売中"}</span></button><input className="sort-order-input" value={item.sortOrder} aria-label={`${item.name}の並び順`} onChange={(event) => setMenuItem(item.id, { sortOrder: Number(event.target.value) || 1 })} /><div className="admin-row__actions"><button className="button button--quiet" onClick={() => { setEditingMenuId(item.id); setShowAdd(true); }}>編集</button><button className="button button--quiet" onClick={() => setImageLayoutItemId(item.id)}>画像を調整</button><button className="delete-button delete-button--icon" aria-label={`${item.name}を削除`} onClick={() => updateState((current) => ({ ...current, menuItems: current.menuItems.filter((menu) => menu.id !== item.id) }))}><X size={20} /></button></div></div>)}</section>)}</div>}
        </> : null}

        {section === "categories" ? <>
          <div className="admin-toolbar"><div><span className="section-kicker">CATEGORY ORDER</span><h2>カテゴリの表示と順番</h2></div><button className="button button--outline button--large" onClick={() => setShowAdd(!showAdd)}><Plus size={28} weight="bold" /> カテゴリを追加</button></div>
          {showAdd ? <form className="inline-form inline-form--category" onSubmit={saveCategory}><label>カテゴリー名<input name="name" required maxLength="80" placeholder="例：揚げ物" defaultValue={state.categories.find((category) => category.id === categoryEditorId)?.name ?? ""} /></label><label>所属レール<select name="sectionKey" defaultValue={state.categories.find((category) => category.id === categoryEditorId)?.sectionKey ?? "food"}><option value="drink">ドリンク</option><option value="food">フード</option><option value="winter">冬季限定</option><option value="seasonal">季節・気まぐれ</option></select></label><label>表示順<input name="sortOrder" type="number" min="0" defaultValue={state.categories.find((category) => category.id === categoryEditorId)?.sortOrder ?? 0} /></label><label className="menu-editor__check"><input name="isVisible" type="checkbox" defaultChecked={state.categories.find((category) => category.id === categoryEditorId)?.isVisible ?? false} /> 客席に表示</label><button className="button button--primary" type="submit" disabled={catalogState.saving}>{catalogState.saving ? "保存中" : categoryEditorId ? "変更を保存" : "追加する"}</button><button className="button button--quiet" type="button" onClick={() => { setShowAdd(false); setCategoryEditorId(null); }} disabled={catalogState.saving}>キャンセル</button></form> : null}
          <div className="category-admin-grid">{[...state.categories].sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id, "ja")).map((category, index) => <article key={category.id}><div className="category-admin-index">{String(index + 1).padStart(2, "0")}</div><div><b>{category.name}</b><small>{category.sectionKey}・表示順 {category.sortOrder}</small></div><button className={`toggle ${category.isVisible ? "is-on" : ""}`} onClick={() => { setCategoryEditorId(category.id); setShowAdd(true); }}><i></i><span>編集</span></button><button className="button button--quiet" type="button" onClick={() => moveCategory(category, -1)} disabled={catalogState.saving}>上へ</button><button className="button button--quiet" type="button" onClick={() => moveCategory(category, 1)} disabled={catalogState.saving}>下へ</button></article>)}</div>
        </> : null}

        {section === "devices" ? <>
          <div className="pairing-admin-panel">
            <div>
              <span className="section-kicker">CUSTOMER PAIRING</span>
              <h2>客席端末をQRで登録</h2>
              <p>起動中safe-copyのpreflightを通過した場合だけ、現在のLAN URLでQRを発行します。</p>
              {pairingPreflight.loading ? <p role="status">pairing preflightを確認中です。</p> : null}
              {pairingPreflight.data ? <div className="pairing-preflight" aria-label="pairing preflight結果">
                <p><b>認証</b> 管理者token有効</p>
                <p><b>DB</b> {pairingPreflight.data.database.target}（production: {pairingPreflight.data.database.isProduction ? "使用" : "未使用"}）</p>
                <p><b>Web/API</b> {pairingPreflight.data.server.webPort}/{pairingPreflight.data.server.apiPort}・{pairingPreflight.data.server.webOriginMatches ? "URL一致" : "URL不一致"}</p>
                <p><b>LAN IPv4</b> {pairingPreflight.data.server.lanIPv4.join(", ") || "未取得"}</p>
                <p><b>空きテーブル</b> {availablePairingTables.length ? availablePairingTables.map((table) => `T${table.tableId}`).join("・") : "なし"}</p>
                <p><b>割当済み</b> {assignedPairingTables.length ? assignedPairingTables.map((table) => `T${table.tableId}（${table.deviceDisplayName}）`).join("・") : "なし"}</p>
                <p><b>pairing</b> {pairingCanIssue ? "発行可能" : pairingBlockedMessage}</p>
                <small>QR生成元: {pairingPreflight.data.server.pairingUrlOrigin}/pairing.html#p=&lt;code&gt;</small>
              </div> : null}
              {pairingPreflight.error ? <p role="alert">{pairingErrorMessage(pairingPreflight.error)}</p> : null}
            </div>
            <label>空きテーブル
              <select value={pairingTableId} disabled={!pairingCanIssue} onChange={(event) => setPairingTableId(event.target.value)}>
                {availablePairingTables.length ? availablePairingTables.map((table) => <option value={String(table.tableId)} key={table.tableId}>テーブル {table.tableId}（{table.label}）</option>) : <option value="">空きテーブルなし</option>}
              </select>
            </label>
            <button className="button button--primary" disabled={!pairingCanIssue} onClick={issuePairing}>QRを発行</button>
            {pairingError ? <p role="alert">{pairingError}</p> : null}
          </div>
          <section className="pairing-connected-devices" aria-label="接続中端末">
            <div>
              <span className="section-kicker">CONNECTED CUSTOMER DEVICES</span>
              <h2>接続中端末</h2>
              <p>接続解除すると端末tokenを失効し、割当テーブルを空きに戻します。注文・履歴・event_logは変更しません。</p>
            </div>
            {assignedPairingTables.length ? <div className="pairing-connected-devices__list">{assignedPairingTables.map((table) => <article key={table.deviceId ?? table.tableId}><div><b>テーブル {table.tableId}</b><strong>{table.deviceDisplayName}</strong><small>状態：{table.deviceStatus}</small></div><button className="button button--quiet pairing-disconnect-button" type="button" disabled={!table.deviceId || Boolean(disconnectingDeviceId)} onClick={() => disconnectCustomerDevice(table)}>{disconnectingDeviceId === table.deviceId ? "解除中…" : "接続解除"}</button></article>)}</div> : <p className="pairing-connected-devices__empty">接続中の客席端末はありません。</p>}
            {disconnectError ? <p role="alert">{disconnectError}</p> : null}
          </section>
          <div className="admin-toolbar"><div><span className="section-kicker">FIXED ASSIGNMENT</span><h2>客席端末とテーブル</h2><p>客席からは変更できません。端末を置き替えたときだけここで設定します。</p></div></div>
          <div className="device-admin-grid">{adminDeviceRows.map((device, index) => <article key={device.deviceId}><div className="device-admin-icon"><Monitor size={38} weight="duotone" /></div><div><small>端末 {String(index + 1).padStart(2, "0")}</small><h3>{device.label}</h3><code>{device.deviceId}</code></div>{adminApiMode && pairingPreflight.data ? <span className="device-admin-assignment">テーブル {device.tableId}</span> : <label>固定テーブル<select value={device.tableId} onChange={(event) => updateState((current) => ({ ...current, devices: current.devices.map((item) => item.deviceId === device.deviceId ? { ...item, tableId: event.target.value } : item) }))}>{pairingTableOptions.map((table) => <option value={String(table.tableId)} key={table.tableId}>テーブル {table.tableId}</option>)}</select></label>}<ConnectionBadge online={adminApiMode && pairingPreflight.data ? device.deviceStatus === "active" : !state.offlineDevices.includes(device.deviceId)} compact /></article>)}</div>
          <section className={`communication-diagnostics ${diagnosticExpanded ? "is-expanded" : ""} ${diagnosticHasIssue ? "has-issue" : ""}`} aria-label="通信診断">
            <div className="communication-diagnostics__summary">
              <div className="communication-diagnostics__summary-status">
                <span className={`communication-diagnostics__status-dot ${diagnosticHasIssue ? "is-error" : diagnosticState.loading ? "is-loading" : "is-ok"}`} aria-hidden="true"></span>
                <strong>{diagnosticSummaryLabel}</strong>
                <span>最終更新：{diagnosticUpdatedLabel}</span>
              </div>
              <button className="button button--quiet" type="button" aria-expanded={diagnosticExpanded} aria-controls="communication-diagnostics-detail" onClick={() => setDiagnosticExpanded((expanded) => !expanded)}>{diagnosticExpanded ? "詳細を閉じる" : "詳細を見る"}</button>
            </div>
            {diagnosticExpanded ? <div className="communication-diagnostics__detail" id="communication-diagnostics-detail">
              <div className="communication-diagnostics__heading">
                <div><span className="section-kicker">CONNECTION DIAGNOSTICS</span><h2>通信診断</h2><p>safe-copyの実ランタイム、認証、注文送受信の観測結果です。</p></div>
                <button className="button button--quiet" type="button" onClick={() => setDiagnosticRefreshKey((key) => key + 1)}>再取得</button>
              </div>
              {diagnosticState.loading ? <p role="status">通信診断を取得中です。</p> : null}
              {diagnosticState.error ? <p role="alert">通信診断を取得できませんでした。</p> : null}
              {diagnosticData ? <div className="communication-diagnostics__grid">
                <div className="communication-diagnostics__facts">
                  <p><b>LAN IPv4</b><span>{diagnosticData.runtime.lanIPv4?.join("・") || "未取得"}</span></p>
                  <p><b>Web / API</b><span>{diagnosticData.runtime.webPort} / {diagnosticData.runtime.apiPort}</span></p>
                  <p><b>稼働PID</b><span>{diagnosticData.runtime.processId ?? "未確認"}</span></p>
                  <p><b>health</b><span>{diagnosticData.health?.status === "ready" && diagnosticData.health?.db === "ready" ? "HTTP 200 / ready" : "未確認"}</span></p>
                  <p><b>DB</b><span>{diagnosticData.runtime.databaseTarget}{diagnosticData.runtime.isProduction ? "（production）" : "（production未使用）"}</span></p>
                  <p><b>schemaVersion</b><span>{diagnosticData.schemaVersion ?? "未確認"}</span></p>
                  <p><b>管理認証</b><span>{diagnosticData.authentication.status === "valid" ? "有効" : "未確認"}</span></p>
                  <p><b>端末 / 空きテーブル</b><span>{diagnosticData.tables.assigned?.length ?? 0}台 / {diagnosticData.tables.available?.length ?? 0}卓</span></p>
                  <p><b>最終更新</b><span>{diagnosticUpdatedLabel}</span></p>
                </div>
                <div className="communication-diagnostics__results">
                  <article><b>直近の注文送信</b><strong>{diagnosticResultLabel(latestOrderSend, "再起動後の注文送信記録なし")}</strong><small>{latestOrderSend ? `${latestOrderSend.requestId ?? "request ID未確認"}・${latestOrderSend.classification ?? "分類未確認"}` : "記録がない状態です"}</small></article>
                  <article><b>直近の注文取得</b><strong>{diagnosticResultLabel(latestOrderRetrieval, "再起動後の注文取得記録なし")}</strong><small>{latestOrderRetrieval ? `${latestOrderRetrieval.requestId ?? "request ID未確認"}・${latestOrderRetrieval.classification ?? "分類未確認"}` : "記録がない状態です"}</small></article>
                  <article><b>保存件数</b><strong>orders {diagnosticData.storage.orders} / items {diagnosticData.storage.orderItems}</strong><small>event_log {diagnosticData.storage.eventLog}・保存本文は表示しません</small></article>
                </div>
              </div> : null}
            </div> : null}
          </section>
        </> : null}
      </section>
      {pairingQr ? <Modal title="客席端末をQRで登録" onClose={() => setPairingQr(null)} wide><div className="pairing-qr-modal"><p>A90のカメラでこのQRを読み取ってください。登録画面にコードが自動入力されます。</p><div className="pairing-qr-modal__image" dangerouslySetInnerHTML={{ __html: pairingQr.svg }} /><p>QR接続先: {pairingQr.origin}</p><p>QRには現在のLAN URLと一回限りのペアリング情報が含まれています。手入力コードは表示しません。</p><button className="button button--quiet" type="button" onClick={() => setPairingQr(null)}>閉じる</button></div></Modal> : null}
      {imageLayoutItemId ? <ImageLayoutEditor item={state.menuItems.find((item) => item.id === imageLayoutItemId)} onClose={() => setImageLayoutItemId(null)} onSaved={(imageLayouts, version) => { updateState((current) => ({ ...current, menuItems: current.menuItems.map((item) => item.id === imageLayoutItemId ? { ...item, imageLayouts, version } : item) })); setImageLayoutItemId(null); }} /> : null}
    </StaffShell>
  );
}

function PairingScreen({ onClaim, error }) {
  const [pairingCode, setPairingCode] = useState("");
  const [displayName, setDisplayName] = useState("customer tablet");
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState("");
  const submit = async (event) => {
    event.preventDefault();
    if (submitting || !pairingCode.trim()) return;
    setSubmitting(true);
    setLocalError("");
    try { await onClaim({ pairingCode: normalizePairingCode(pairingCode), displayName: displayName.trim() }); }
    catch (claimError) { setLocalError(pairingClaimErrorMessage(claimError)); }
    finally { setSubmitting(false); }
  };
  return <main className="customer-shell"><section className="empty-state"><h1>端末登録</h1><p>管理者から受け取ったペアリングコードを入力してください。</p><form className="inline-form" onSubmit={submit}><label>ペアリングコード<input value={pairingCode} onChange={(event) => setPairingCode(event.target.value)} autoComplete="off" required /></label><label>端末名<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={80} required /></label><button className="button button--primary" disabled={submitting}>{submitting ? "登録中" : "端末を登録"}</button></form>{error || localError ? <p role="alert">{error || localError}</p> : null}</section></main>;
}

export function App() {
  const route = useRoute();
  const [orderClient, setOrderClient] = useState(null);
  const [customerDeviceConfig, setCustomerDeviceConfig] = useState(null);
  const [kitchenApiState, setKitchenApiState] = useState(null);
  const [pairingError, setPairingError] = useState("");
  const [state, setState] = useState(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || defaultState; } catch { return defaultState; }
  });

  const updateState = (updater) => setState((current) => typeof updater === "function" ? updater(current) : updater);

  useEffect(() => {
    if (route !== "/kitchen") {
      setKitchenApiState(null);
      return undefined;
    }
    if (!kitchenApiConfigured(window)) {
      setKitchenApiState(window.WARUN_ORDER_MODE === "demo" ? null : { loading: false, error: true, orders: [], sessions: [] });
      return undefined;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const snapshot = await fetchKitchenSnapshot({ env: window });
        if (!cancelled) setKitchenApiState({ loading: false, error: false, orders: snapshot.orders, sessions: snapshot.sessions });
      } catch {
        if (!cancelled) setKitchenApiState({ loading: false, error: true, orders: [], sessions: [] });
      }
    };
    setKitchenApiState({ loading: true, error: false, orders: [], sessions: [] });
    void load();
    const timer = window.setInterval(load, 2_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [route]);

  const serveKitchenItem = async (orderId, orderItemId) => {
    try {
      await markKitchenItemServed({ env: window, orderId, orderItemId });
      const snapshot = await fetchKitchenSnapshot({ env: window });
      setKitchenApiState({ loading: false, error: false, orders: snapshot.orders, sessions: snapshot.sessions });
    } catch {
      setKitchenApiState((current) => current ? { ...current, error: true } : current);
    }
  };

  const closeKitchenSession = async ({ tableId, sessionId }) => {
    await closeKitchenTableSession({ env: window, tableId, sessionId });
    const snapshot = await fetchKitchenSnapshot({ env: window });
    setKitchenApiState({ loading: false, error: false, orders: snapshot.orders, sessions: snapshot.sessions });
  };

  useEffect(() => {
    let cancelled = false;
    const bootstrap = async () => {
      const client = await bootstrapCustomerOrderClient({
        globalObject: window,
        onConfig: (config) => { if (!cancelled) setCustomerDeviceConfig(config); },
      });
      if (!cancelled && client) setOrderClient(client);
    };
    void bootstrap().catch((error) => { if (!cancelled) setPairingError(pairingClaimErrorMessage(error)); });
    return () => { cancelled = true; };
  }, []);

  const claim = async ({ pairingCode, displayName }) => {
    const config = resolveOrderApiConfig({ ...window, location: window.location, navigator: window.navigator, WARUN_ORDER_MODE: "api" });
    const store = createIndexedDbCredentialStore({ indexedDB: window.indexedDB });
    const device = await loadOrCreateCustomerDevice({ store, globalObject: window });
    await claimCustomerDevice({ store, baseUrl: config.baseUrl || new URL("/v1", window.location.origin).toString(), pairingCode, deviceId: device.deviceId, displayName, appVersion: "prototype" });
    const credentials = await store.load();
    setCustomerDeviceConfig(credentials.config ?? null);
    const runtime = runtimeForCustomerCredentials({ globalObject: window, baseUrl: config.baseUrl || new URL("/v1", window.location.origin).toString(), token: credentials.token });
    setPairingError("");
    setOrderClient(createCustomerOrderClient({ global: runtime, indexedDB: window.indexedDB }));
  };

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* Direct-open previews may not provide storage. */ }
  }, [state]);
  useEffect(() => {
    const sync = (event) => {
      if (event.key === STORAGE_KEY && event.newValue) {
        try { setState(JSON.parse(event.newValue)); } catch { /* ignore malformed external state */ }
      }
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  useEffect(() => {
    if (!orderClient) return undefined;
    const unsubscribe = orderClient.subscribe((event) => {
      setState((current) => {
        const hasOrder = current.orders.some((order) => order.id === event.clientOrderId || order.clientOrderId === event.clientOrderId);
        if (!hasOrder) return current;
        const transportState = event.displayState || event.state;
        return {
          ...current,
          orders: current.orders.map((order) => {
            if (order.id !== event.clientOrderId && order.clientOrderId !== event.clientOrderId) return order;
            const nextStatus = event.state === "synced"
              ? order.status === "queued_offline" ? "new" : order.status
              : event.state === "rejected" ? "rejected" : event.state === "pending" ? "queued_offline" : order.status;
            return {
              ...order,
              status: nextStatus,
              transportState,
              transportErrorCode: event.lastErrorCode || null,
              syncedAt: event.state === "synced" ? new Date().toISOString() : order.syncedAt,
            };
          }),
        };
      });
    });
    void orderClient.start();
    return () => {
      unsubscribe();
      void orderClient.stop();
    };
  }, [orderClient]);

  const content = useMemo(() => {
    const isCustomerRoute = route === "/" || route.startsWith("/customer/");
    if (isCustomerRoute && !orderClient) return <PairingScreen onClaim={claim} error={pairingError} />;
    if (route === "/") return <CustomerScreen state={state} updateState={updateState} deviceId="customer-03" orderClient={orderClient} customerDeviceConfig={customerDeviceConfig} />;
    if (route.startsWith("/customer/")) return <CustomerScreen state={state} updateState={updateState} deviceId={route.split("/")[2]} orderClient={orderClient} customerDeviceConfig={customerDeviceConfig} />;
    if (route === "/kitchen") return <KitchenScreen state={state} updateState={updateState} apiState={kitchenApiState} onServe={serveKitchenItem} onCloseSession={closeKitchenSession} />;
    if (route === "/history") {
      const explicitDemo = window.WARUN_ORDER_MODE === "demo";
      const loadHistory = kitchenApiConfigured(window)
        ? fetchKitchenOrderHistory
        : configuredAdminToken(window) ? fetchAdminOrderHistory : null;
      return <HistoryScreen state={state} apiMode={!explicitDemo} loadHistory={loadHistory} />;
    }
    if (route.startsWith("/admin/")) return <AdminScreen state={state} updateState={updateState} section={route.split("/")[2] || "menu"} />;
    if (route === "/devices") return <Launcher state={state} updateState={updateState} />;
    return <CustomerScreen state={state} updateState={updateState} deviceId="customer-03" orderClient={orderClient} customerDeviceConfig={customerDeviceConfig} />;
  }, [route, state, orderClient, customerDeviceConfig, kitchenApiState, pairingError]);

  return content;
}
