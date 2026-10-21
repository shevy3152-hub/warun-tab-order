import { KitchenOrderSound } from "./KitchenOrderSound.jsx";
import { ProductImageLocation, ProductImageUriField } from "./ProductImageLocation.jsx";
import { adminMenuAvailability } from "./admin-menu-status.js";
import { runWithSubmissionLock } from "./admin-submit-lock.js";
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
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
  PaintBrush,
  Plus,
  Receipt,
  WifiHigh,
  WifiSlash,
  X,
} from "@phosphor-icons/react";
import { Fragment } from "react";
import * as React from "react";
import { createClientOrderId, createCustomerOrderClient, resolveOrderApiConfig } from "./order-outbox.js";
import { claimCustomerDevice, createIndexedDbCredentialStore, loadOrCreateCustomerDevice, pairingClaimErrorMessage, runtimeForCustomerCredentials } from "./device-credentials.js";
import { customerOrderErrorCategory, customerOrderNoticeFromOutboxEvent } from "./customer-order-notice.js";
import { AdminPairingError, configuredAdminToken, createAdminRideGuidanceContact, deleteAdminRideGuidanceContact, fetchAdminBusinessHours, fetchAdminCheckoutRequests, fetchAdminCustomerOrderStartNotice, fetchAdminCustomerThemeConfig, fetchAdminDiagnostics, fetchAdminMenu, fetchAdminSessionMenuAccess, fetchArchivedAdminMenuItems, previewAdminMenuItemLifecycle, executeAdminMenuItemLifecycle, restoreArchivedAdminMenuItem, allowAdminSessionMenuItem, confirmAndCloseAdminEmptySession, revokeAdminSessionMenuItem, fetchAdminOrderHistory, fetchAdminPaymentHistory, fetchAdminPairingPreflight, fetchAdminRideGuidance, issueCustomerPairingCode, revokeAdminDevice, saveAdminBusinessHours, saveAdminCustomerOrderStartNotice, saveAdminCustomerThemeConfig, uploadAdminCustomerThemeImage, saveAdminImageLayouts, saveAdminCategory, saveAdminMenuItem, saveAdminMenuOrdering, saveAdminRideGuidanceOrdering, saveAdminRideGuidancePickup, updateAdminRideGuidanceContact, voidAdminPayment } from "./admin-pairing.js";
import { adjustKitchenItemUnitPrice, adjustKitchenOrderItemQuantity as adjustKitchenItemQuantityRequest, cancelKitchenCheckout, cancelKitchenOrderItem, closeKitchenTableSession, createKitchenOrder, fetchKitchenCheckoutRequests, fetchKitchenOrderHistory, fetchKitchenPaymentHistory, fetchKitchenSnapshot, kitchenAdditionRequestItem, kitchenApiConfigured, KitchenApiError, markKitchenItemServed, payKitchenCheckout, readyKitchenCheckout, resolveKitchenStaffCall, restoreKitchenOrderItem, saveKitchenCheckoutAdjustments, subscribeKitchenInvalidations, voidKitchenPayment } from "./kitchen-api.js";
import { buildKitchenTableGroups } from "./kitchen-order-board.js";
import { bootstrapCustomerOrderClient } from "./customer-bootstrap.js";
import { createCustomerVisitConfigRefresher } from "./customer-visit-config-refresh.js";
import { CUSTOMER_STAFF_CALL_COOLDOWN_MS, customerStaffCallCooldownKey, customerStaffCallCooldownSeconds, isCustomerStaffCallSuccessNotice, isMatchingCustomerStaffCallResolution, parseCustomerStaffCallCooldown } from "./customer-staff-call.js";
import { beginCheckoutRead, isCheckoutModalForCurrentVisit, isPassiveMissingCheckoutSession } from "./customer-checkout-state.js";
import { createCustomerMenuState, customerMenuStateReducer } from "./customer-menu-state.js";
import { createCustomerCheckoutReconnectHandler, isMatchingCustomerCheckoutReconnectVisit } from "./customer-checkout-reconnect.js";
import { addCustomerCartSelection, customerCartRows, removeCustomerCartSelection } from "./customer-cart.js";
import { taxExcludedYen } from "./pricing.js";
import { pairingCodeQrSvg } from "./qr-code.js";
import { compareMenuItems } from "./menu-ordering.js";
import { CUSTOMER_TEST_THEME, normalizeCustomerTheme } from "./customer-theme.js";
import { CUSTOMER_THEME_DEFINITIONS, isAvailableCustomerTheme } from "../../shared/customer-theme-definitions.mjs";
import { customerThemeImageLayout, customerThemePositionAfterDrag, normalizeCustomerThemeLayout, resolveCustomerThemeZoom, MIN_CUSTOMER_THEME_ZOOM, MAX_CUSTOMER_THEME_ZOOM } from "./customer-theme-layout.js";
import { customerThemeGuideImageCoordinates } from "./customer-theme-guide.js";
import { A90_THEME_CONDITION, A90_THEME_REGIONS, customerThemeConditionModel, customerThemePlacementFrames } from "./customer-theme-display-condition.js";
import { buildCustomerThemeGenerationPrompt, customerThemeSpecificGuidance } from "./customer-theme-generation-prompt.js";
import { DEFAULT_BUSINESS_HOURS, businessHoursDisplay, businessHoursHourLabel, combineBusinessHoursTime, normalizeBusinessHours, splitBusinessHoursTime } from "./business-hours.js";
import { DEFAULT_BUSINESS_HOURS_NOTICE, withBusinessHoursNotice } from "./business-hours-notice.js";
import { CHECKOUT_ADJUSTMENT_TYPES, checkoutAdjustmentTotal, normalizeCheckoutAdjustments, parseFixedAdjustment } from "./checkout-adjustments.js";
import { buildCustomerMajorCategories } from "./customer-category-navigation.js";
import { acknowledgeCustomerOrderStartNotice, beginCustomerOrderStartNoticeRefresh, clearCustomerOrderStartNoticeAcknowledgements, createCustomerOrderStartNoticeScopeKey, DEFAULT_CUSTOMER_ORDER_START_NOTICE, hasCustomerOrderStartNoticeAcknowledgement, hasValidCustomerOrderStartNoticeSettings } from "./customer-order-start-notice.js";

const STORAGE_KEY = "izakaya-order-prototype-v3";

function createKitchenOperationId() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  if (typeof globalThis.crypto?.getRandomValues !== "function") throw new Error("この端末では数量操作IDを作成できません。");
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

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

function kitchenAdditionMenuName(item) {
  const alias = typeof item?.kitchenAlias === "string" ? item.kitchenAlias.trim() : "";
  return alias || item?.name || "";
}

function adminCategorySection(category) {
  if (category?.sectionKey) return category.sectionKey;
  return ["beer", "drink", "sake", "shochu"].includes(category?.id) ? "drink" : "food";
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

const kitchenDemoCheckouts = [
  { checkoutRequestId: "demo-checkout-1", tableSessionId: "demo-session-1", status: "requested", requestedAt: "2026-09-25T09:05:00.000Z", orderedItemsTotalYen: 2340, adjustments: [], receiptRequested: false },
  { checkoutRequestId: "demo-checkout-2", tableSessionId: "demo-session-2", status: "requested", requestedAt: "2026-09-25T09:00:00.000Z", orderedItemsTotalYen: 1860, adjustments: [], receiptRequested: true },
];

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
  { id: "drink", name: "飲み物", subcategories: CUSTOMER_DRINK_SUBCATEGORIES },
  { id: "food", name: "お食事", subcategories: [
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
  { id: "seasonal", name: "", isPlaceholder: true, subcategories: [] },
];

const CUSTOMER_WINTER_CATEGORY_IDS = new Set(["winter-hotpot", "winter-shime"]);
const FOOD_VARIANT_DEFINITIONS = {
  "special-hine-black": ["小", "中", "大"],
  "food-kushi-kushikatsu": ["塩レモン", "ソース", "おろしポン酢", "味噌"],
};

const CUSTOMER_DRINK_CATEGORY_IDS = new Set(CUSTOMER_DRINK_SUBCATEGORIES.flatMap((subcategory) => subcategory.categoryIds));
const KITCHEN_DRINK_CATEGORY_IDS = new Set([...CUSTOMER_DRINK_CATEGORY_IDS, "drink", "soft"]);
const CUSTOMER_FEATURED_MENU_IDS = ["edamame", "dashimaki", "beer", "lemon", "karaage"];

function mapAdminCatalogState(catalog) {
  return {
    categories: catalog.categories.map((category) => ({ id: category.categoryId, name: category.name, sectionKey: category.sectionKey, sortOrder: category.sortOrder, isVisible: category.isVisible, version: category.version })),
    menuItems: catalog.items.map((item) => ({
      id: item.menuItemId, categoryId: item.categoryId, name: item.formalName, kitchenAlias: item.kitchenAlias,
      description: item.description, price: item.priceYen, imageUri: item.imageUri, sectionKey: item.sectionKey,
      isSoldOut: item.isSoldOut, orderingMode: item.orderingMode ?? "normal", customerVisibilityMode: item.customerVisibilityMode ?? "all_tables", tableVisibilityMode: item.tableVisibilityMode ?? "all_tables", tableVisibilityTableIds: item.tableVisibilityTableIds ?? [], isActive: item.isActive, sortOrder: item.sortOrder, version: item.version,
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
    case "review_required": return "スタッフ確認が必要";
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

function prepareCheckoutBell(audioRef) {
  try {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return;
    if (!audioRef.current) audioRef.current = new AudioContextCtor();
    void audioRef.current.resume().catch(() => {});
  } catch { /* Sound is optional; the visual state remains authoritative. */ }
}

function playCheckoutBell(audioRef) {
  try {
    const context = audioRef.current;
    if (!context) return;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(660, context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(880, context.currentTime + 0.12);
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, context.currentTime + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.28);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.3);
  } catch { /* Browsers may reject audio; never make that a visible error. */ }
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

function ConnectionBadge({ online = true, compact = false, announceStatus = false }) {
  return (
    <div className={`connection ${online ? "is-online" : "is-offline"} ${compact ? "connection--compact" : ""}`} role={announceStatus ? "status" : undefined} aria-label={announceStatus ? `通信状態：${online ? "接続中" : "送信待ち"}` : undefined} title={announceStatus ? `通信状態：${online ? "接続中" : "送信待ち"}` : undefined}>
      {online ? <WifiHigh size={22} weight="bold" /> : <WifiSlash size={22} weight="bold" />}
      <span><small>通信状態</small>{online ? "接続中" : "送信待ち"}</span>
    </div>
  );
}

function usePublicBusinessHours(enabled = true) {
  const [settings, setSettings] = useState(() => withBusinessHoursNotice({ ...DEFAULT_BUSINESS_HOURS, ...DEFAULT_BUSINESS_HOURS_NOTICE }));
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    void fetchPublicBusinessHoursWithNotice({ env: window }).then((next) => {
      if (!cancelled) setSettings(withBusinessHoursNotice(next));
    });
    return () => { cancelled = true; };
  }, [enabled]);
  return settings;
}

async function fetchPublicBusinessHoursWithNotice({ env = globalThis } = {}) {
  const configured = typeof env?.WARUN_API_BASE === "string" ? env.WARUN_API_BASE.trim() : "";
  let base;
  try {
    base = new URL(configured || "/v1", env.location?.origin).toString().replace(/\/+$/, "");
  } catch {
    return withBusinessHoursNotice({ ...DEFAULT_BUSINESS_HOURS, ...DEFAULT_BUSINESS_HOURS_NOTICE });
  }
  try {
    const response = await env.fetch(`${base}/business-hours`, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    return withBusinessHoursNotice({
      ...normalizeBusinessHours(body),
      noticeText: body.noticeText,
      noticeEnabled: body.noticeEnabled,
    });
  } catch {
    return withBusinessHoursNotice({ ...DEFAULT_BUSINESS_HOURS, ...DEFAULT_BUSINESS_HOURS_NOTICE });
  }
}

async function fetchPublicRideGuidance({ env = globalThis } = {}) {
  const configured = typeof env?.WARUN_API_BASE === "string" ? env.WARUN_API_BASE.trim() : "";
  let base;
  try {
    base = new URL(configured || "/v1", env.location?.origin).toString().replace(/\/+$/, "");
  } catch {
    throw new Error("RIDE_GUIDANCE_API_UNAVAILABLE");
  }
  const response = await env.fetch(`${base}/ride-guidance`, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  if (!body?.pickup || !Array.isArray(body.contacts)) throw new Error("RIDE_GUIDANCE_RESPONSE_INVALID");
  return {
    pickup: {
      pickupLabel: typeof body.pickup.pickupLabel === "string" ? body.pickup.pickupLabel : "",
      pickupAddress: typeof body.pickup.pickupAddress === "string" ? body.pickup.pickupAddress : "",
    },
    contacts: body.contacts
      .filter((contact) => contact?.isVisible !== false)
      .filter((contact) => contact?.type === "taxi" || contact?.type === "driver_service")
      .map((contact) => ({
        type: contact.type,
        name: typeof contact.name === "string" ? contact.name : "",
        phone: typeof contact.phone === "string" ? contact.phone : "",
        note: typeof contact.note === "string" ? contact.note : "",
        sortOrder: Number.isSafeInteger(contact.sortOrder) ? contact.sortOrder : 0,
      })),
  };
}

function BusinessHoursText({ settings, className }) {
  if (!settings?.isVisible) return null;
  const display = businessHoursDisplay(settings);
  return <div className={className}><b>本日の営業時間</b><span>{display.range}</span><small>{display.lastOrder}</small></div>;
}

function CustomerBusinessHours({ settings, onOpenNotice, guideKey = undefined }) {
  const showHours = settings?.isVisible === true;
  const showNotice = settings?.noticeEnabled === true && Boolean(settings.noticeText?.trim());
  if (!showHours && !showNotice) return null;
  const display = businessHoursDisplay(settings);
  return <div className={`customer-hours${guideKey ? " customer-theme-preview__hours" : ""}`} style={guideKey ? { color: "var(--customer-theme-rail-foreground, #fff)", borderTopColor: "var(--customer-theme-rail-separator, rgb(255 255 255 / 65%))" } : undefined} {...(guideKey ? { "data-customer-guide": guideKey } : {})}>
    {showHours ? <><b>本日の営業時間</b><span>{display.range}</span><small>{display.lastOrder}</small></> : null}
    {showNotice ? <button type="button" className="business-hours-notice-button" onClick={onOpenNotice}>その他ご案内</button> : null}
  </div>;
}

function CustomerRailContent({ expanded, categories, currentCategoryId, onSelectCategory, onExpand, businessHours, onOpenNotice }) {
  return <>
    <div className="customer-title customer-title--horizontal" data-customer-guide="brand"><span>居酒屋 わるん</span></div>
    {expanded ? <nav className="category-nav" aria-label="大分類カテゴリー" data-customer-guide="categories">
      {categories.map((category, index) => category.isPlaceholder
        ? <span key={category.id} className="category-nav__placeholder" aria-hidden="true"><b>{String(index + 1).padStart(2, "0")}</b><span></span></span>
        : <button key={category.id} type="button" className={category.id === currentCategoryId ? "is-active" : ""} onClick={() => onSelectCategory?.(category.id)}><b>{String(index + 1).padStart(2, "0")}</b><span>{category.name}</span></button>)}
    </nav> : <button type="button" className="customer-sidebar__collapsed-toggle" onClick={onExpand} aria-label="メインカテゴリーに戻る"><span>現在</span><strong>{categories.find((category) => category.id === currentCategoryId)?.name || "メニュー"}</strong><span>メインカテゴリーに戻る</span></button>}
    <CustomerBusinessHours settings={businessHours} onOpenNotice={onOpenNotice} guideKey="hours" />
  </>;
}

function normalizeCustomerThemeConfig(value, fallbackTheme = CUSTOMER_TEST_THEME) {
  const theme = normalizeCustomerTheme(value?.theme ?? fallbackTheme);
  const positionX = typeof value?.positionX === "number" && Number.isFinite(value.positionX) && value.positionX >= 0 && value.positionX <= 1 ? value.positionX : 0.5;
  const positionY = typeof value?.positionY === "number" && Number.isFinite(value.positionY) && value.positionY >= 0 && value.positionY <= 1 ? value.positionY : 0.5;
  const zoom = typeof value?.zoom === "number" && Number.isFinite(value.zoom) && value.zoom >= 0.5 && value.zoom <= 3 ? value.zoom : 1;
  return { theme, positionX, positionY, zoom };
}

function IconButton({ icon: Icon, children, badge, onClick, className = "", disabled = false }) {
  return (
    <button className={`header-action ${className}`} onClick={onClick} type="button" disabled={disabled}>
      <Icon size={30} weight="bold" />
      <span>{children}</span>
      {badge ? <b className="badge">{badge}</b> : null}
    </button>
  );
}

function Modal({ title, titleExtra = null, children, footer = null, onClose, wide = false, className = "", titleId = "modal-title" }) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener("keydown", onKeyDown); };
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={`modal ${wide ? "modal--wide" : ""} ${className}`.trim()} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="modal__header"><div className="modal__title-group"><h2 id={titleId}>{title}</h2>{titleExtra}</div><button className="icon-only" onClick={onClose} aria-label="閉じる"><X size={26} weight="bold" /></button></header>
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

function RideGuidanceModal({ dataState, selectedType, onSelectType, onBack, onClose }) {
  const typeLabel = selectedType === "taxi" ? "タクシー" : "運転代行";
  const contacts = dataState.data?.contacts.filter((contact) => contact.type === selectedType).sort((a, b) => a.sortOrder - b.sortOrder) ?? [];
  const pickupLabel = dataState.data?.pickup.pickupLabel || "お迎え先";
  const pickupLabelMatch = pickupLabel.match(/^(.*?)(\s*\(.+\))$/);
  return <Modal title={selectedType ? typeLabel : "タクシー・運転代行"} titleId="ride-guidance-title" onClose={onClose} wide className="modal--ride-guidance" footer={<div className={`modal-actions ride-guidance-customer__footer${selectedType ? " ride-guidance-customer__footer--list" : ""}`}>{selectedType ? <button type="button" className="button button--quiet button--large" onClick={onBack}>戻る</button> : null}<button type="button" className="button button--primary button--large" onClick={onClose}>閉じる</button></div>}>
    {selectedType ? <div className="ride-guidance-customer__view">
      <div className="ride-guidance-customer__pickup"><span className="section-kicker">PICKUP LOCATION</span><strong>{pickupLabelMatch ? <><span>{pickupLabelMatch[1]}</span><span className="ride-guidance-customer__pickup-place">{pickupLabelMatch[2]}</span></> : pickupLabel}</strong><p>{dataState.data?.pickup.pickupAddress || "お迎え先住所は現在準備中です"}</p></div>
      {dataState.loading ? <p className="ride-guidance-customer__state" role="status">連絡先を読み込み中です</p> : dataState.error ? <p className="ride-guidance-customer__state is-error" role="alert">現在、連絡先を表示できません</p> : contacts.length ? <div className="ride-guidance-customer__contacts">{contacts.map((contact, index) => <article key={`${contact.type}-${contact.sortOrder}-${index}`}><h4>{contact.name}</h4><strong>{contact.phone}</strong>{contact.note ? <p>{contact.note}</p> : null}</article>)}</div> : <p className="ride-guidance-customer__state">現在登録されている連絡先はありません</p>}
    </div> : <div className="ride-guidance-customer__select"><p className="ride-guidance-customer__lead">お呼び出しはお客様からお願いします</p>{dataState.error ? <p className="ride-guidance-customer__state is-error" role="alert">現在、連絡先を表示できません</p> : null}<div className="ride-guidance-customer__choices"><button type="button" className="button button--primary button--large" onClick={() => onSelectType("taxi")}>タクシー</button><button type="button" className="button button--primary button--large" onClick={() => onSelectType("driver_service")}>運転代行</button></div></div>}
  </Modal>;
}

function CustomerCheckoutModal({ checkoutState, checkoutRequestError, receiptRequested, onReceiptChange, onRequest, onRetry, onResetCancelled, onClose, submitting }) {
  const [splitCount, setSplitCount] = useState(2);
  const checkout = checkoutState.checkout;
  const ready = checkout?.status === "ready" && Number.isSafeInteger(checkout.grandTotalYen);
  const waiting = checkout?.status === "requested";
  const cancelled = checkout?.status === "cancelled";
  const splitAmount = ready ? Math.ceil(checkout.grandTotalYen / splitCount) : null;
  const error = checkoutState.error;
  return <Modal title="お会計" onClose={onClose} className="modal--checkout">
    {checkoutState.loading ? <div className="checkout-customer-state"><p className="checkout-customer-state__large">会計状態を確認中です</p></div> : error ? <div className="checkout-customer-state"><p className="checkout-customer-state__error" role="alert">会計状態を取得できませんでした。</p><p className="checkout-customer-state__diagnostic">失敗段階: {checkoutState.errorDetails?.stage ?? "unknown"} / HTTP status: {checkoutState.errorDetails?.status ?? "なし"} / error code: {checkoutState.errorDetails?.code ?? "UNKNOWN_ERROR"}</p><button type="button" className="button button--primary button--large" onClick={onRetry}>再試行</button></div> : ready ? <div className="checkout-customer-ready"><p className="checkout-customer-state__large">お会計金額</p><strong className="checkout-customer-total" aria-live="polite">税込 {yen(checkout.grandTotalYen)}</strong>{checkout.receiptRequested ? <p className="checkout-receipt-note">手書き領収書を希望済み</p> : null}<section className="checkout-split" aria-label="割り勘"><h3>割り勘</h3><div className="checkout-split__control"><button type="button" aria-label="人数を1人減らす" onClick={() => setSplitCount((current) => Math.max(2, current - 1))} disabled={splitCount <= 2}>−</button><strong>{splitCount}人</strong><button type="button" aria-label="人数を1人増やす" onClick={() => setSplitCount((current) => Math.min(20, current + 1))} disabled={splitCount >= 20}>＋</button></div><p className="checkout-split__amount">おひとり {checkout.grandTotalYen % splitCount === 0 ? "" : "約"}{yen(splitAmount)}</p></section></div> : waiting ? <div className="checkout-customer-state"><p className="checkout-customer-state__large">しばらくお待ちください</p><p>ただいま会計を確認しています</p>{checkout.receiptRequested ? <p className="checkout-receipt-note">手書き領収書を希望済み</p> : null}</div> : cancelled ? <div className="checkout-customer-state"><p className="checkout-customer-state__error" role="alert">会計依頼が取り消されました</p><p>必要であれば、あらためて会計を依頼できます。</p><button type="button" className="button button--primary button--large" onClick={onResetCancelled}>新しく会計を依頼する</button></div> : <div className="checkout-customer-request"><p className="modal-lead">会計の準備をスタッフへ依頼します</p><p className="checkout-customer-exit-notice">会計後は10分ほどで退店して頂きます。</p><button type="button" className={`checkout-receipt-toggle ${receiptRequested ? "is-selected" : ""}`} aria-pressed={receiptRequested} onClick={() => onReceiptChange(!receiptRequested)} disabled={submitting}><Receipt size={26} weight={receiptRequested ? "fill" : "regular"} /><span>手書き領収書を希望する</span><b>{receiptRequested ? "選択中" : ""}</b></button>{checkoutRequestError ? <p className="checkout-customer-state__error" role="alert">会計依頼を送信できませんでした。もう一度お試しください。</p> : null}<div className="modal-actions checkout-modal__actions"><button type="button" className="button button--quiet" onClick={onClose} disabled={submitting}>キャンセル</button><button type="button" className="button button--primary button--large" onClick={onRequest} disabled={submitting}>{submitting ? "送信中…" : "お会計を依頼する"}</button></div></div>}
  </Modal>;
}

function CustomerOrderStartNotice({ ready, settings, loading, error, onContinue, onRetry }) {
  return <main className="customer-order-start-notice">
    <section className="customer-order-start-notice__card" aria-labelledby="customer-order-start-notice-title">
      <header className="customer-order-start-notice__heading">
        <h1 id="customer-order-start-notice-title">{settings?.heading || "注文前の確認"}</h1>
      </header>
      <div className="customer-order-start-notice__body-scroll">
        {settings ? <p className="customer-order-start-notice__body">{settings.body}</p> : null}
      </div>
      <div className="customer-order-start-notice__feedback">
        {loading ? <p className="customer-order-start-notice__status" role="status">注意事項を読み込んでいます。</p> : null}
        {error ? <div className="customer-order-start-notice__error" role="alert"><p>注意事項を取得できません。通信状態を確認してください。</p><button type="button" className="button button--outline" onClick={onRetry}>再取得</button></div> : null}
        {!ready && !loading && !error ? <p className="customer-order-start-notice__status" role="status">来店情報を確認しています。</p> : null}
      </div>
      <button className="customer-order-start-notice__continue" type="button" disabled={!ready} onClick={onContinue}>了承して注文へ進む</button>
    </section>
  </main>;
}

function CustomerScreen({ state, updateState, deviceId, orderClient, customerDeviceConfig, onCustomerDeviceConfigChange, theme = CUSTOMER_TEST_THEME }) {
  const fallbackCustomerTheme = normalizeCustomerTheme(theme);
  const fallbackCustomerThemeConfig = normalizeCustomerThemeConfig({ theme: fallbackCustomerTheme }, fallbackCustomerTheme);
  const localDevice = state.devices.find((item) => item.deviceId === deviceId) ?? state.devices[0];
  const apiMode = orderClient.mode === "api";
  const initialCustomerThemeConfig = apiMode
    ? normalizeCustomerThemeConfig({ theme: "standard" }, "standard")
    : fallbackCustomerThemeConfig;
  const [customerThemeState, setCustomerThemeState] = useState({ loading: apiMode, error: false, ...initialCustomerThemeConfig });
  const customerThemeRequestRef = useRef(null);
  const customerThemeRefreshPendingRef = useRef(false);
  const customerThemeRefreshRef = useRef(null);
  const [customerThemeImageFailed, setCustomerThemeImageFailed] = useState(false);
  const [acknowledgedOrderStartNoticeScope, setAcknowledgedOrderStartNoticeScope] = useState(null);
  const [orderStartNoticeRefreshKey, setOrderStartNoticeRefreshKey] = useState(0);
  const [orderStartNoticeState, setOrderStartNoticeState] = useState({ loading: apiMode, error: false, settings: apiMode ? null : DEFAULT_CUSTOMER_ORDER_START_NOTICE });
  const customerThemeConfig = normalizeCustomerThemeConfig(apiMode ? customerThemeState : fallbackCustomerThemeConfig, apiMode ? "standard" : fallbackCustomerTheme);
  const customerTheme = customerThemeConfig.theme;
  const businessHours = usePublicBusinessHours(apiMode);
  useEffect(() => {
    let cancelled = false;
    const loadCustomerTheme = async () => {
      if (!apiMode || (typeof orderClient?.getThemeConfig !== "function" && typeof orderClient?.getTheme !== "function")) {
        if (!cancelled) setCustomerThemeState({ loading: false, error: false, ...fallbackCustomerThemeConfig });
        return;
      }
      if (customerThemeRequestRef.current) {
        customerThemeRefreshPendingRef.current = true;
        return customerThemeRequestRef.current;
      }
      setCustomerThemeState((current) => ({ ...current, loading: true, error: false }));
      const themeRequest = typeof orderClient.getThemeConfig === "function"
        ? orderClient.getThemeConfig()
        : orderClient.getTheme();
      customerThemeRequestRef.current = themeRequest;
      try {
        const result = await themeRequest;
        if (!cancelled) setCustomerThemeState({ loading: false, error: false, ...normalizeCustomerThemeConfig(result, "standard") });
      } catch {
        if (!cancelled) setCustomerThemeState({ loading: false, error: true, ...normalizeCustomerThemeConfig({ theme: "standard" }, "standard") });
      } finally {
        if (customerThemeRequestRef.current === themeRequest) customerThemeRequestRef.current = null;
        if (!cancelled && customerThemeRefreshPendingRef.current) {
          customerThemeRefreshPendingRef.current = false;
          void loadCustomerTheme();
        }
      }
    };
    customerThemeRefreshRef.current = loadCustomerTheme;
    void loadCustomerTheme();
    return () => {
      cancelled = true;
      if (customerThemeRefreshRef.current === loadCustomerTheme) customerThemeRefreshRef.current = null;
    };
  }, [apiMode, orderClient, fallbackCustomerTheme]);
  useEffect(() => {
    if (!apiMode || typeof orderClient?.subscribeInvalidations !== "function") return undefined;
    const refreshTheme = () => { void customerThemeRefreshRef.current?.(); };
    return orderClient.subscribeInvalidations((event) => {
      if (event?.resource === "customerTheme" || event?.payload?.resource === "customerTheme" || event?.type === "customer_theme.updated") refreshTheme();
    }, { onReconnect: refreshTheme });
  }, [apiMode, orderClient]);
  useEffect(() => {
    if (!apiMode) {
      setOrderStartNoticeState({ loading: false, error: false, settings: DEFAULT_CUSTOMER_ORDER_START_NOTICE });
      return undefined;
    }
    let cancelled = false;
    const refreshNotice = async () => {
      if (typeof orderClient?.getOrderStartNotice !== "function") {
        if (!cancelled) setOrderStartNoticeState({ loading: false, error: true, settings: null });
        return;
      }
      setOrderStartNoticeState(beginCustomerOrderStartNoticeRefresh);
      try {
        const settings = await orderClient.getOrderStartNotice();
        if (!cancelled) setOrderStartNoticeState({ loading: false, error: false, settings });
      } catch {
        if (!cancelled) setOrderStartNoticeState({ loading: false, error: true, settings: null });
      }
    };
    void refreshNotice();
    const unsubscribe = typeof orderClient?.subscribeInvalidations === "function"
      ? orderClient.subscribeInvalidations((event) => {
        const resource = event?.payload?.resource ?? event?.resource;
        if (resource === "customerOrderStartNotice" || event?.type === "customer_order_start_notice.updated") void refreshNotice();
      }, { onReconnect: refreshNotice })
      : null;
    return () => { cancelled = true; unsubscribe?.(); };
  }, [apiMode, orderClient, orderStartNoticeRefreshKey]);
  useEffect(() => { setCustomerThemeImageFailed(false); }, [customerTheme, customerThemeConfig.positionX, customerThemeConfig.positionY, customerThemeConfig.zoom]);
  const visibleCustomerTheme = customerThemeImageFailed || !isAvailableCustomerTheme(customerTheme) ? "standard" : customerTheme;
  const customerThemeAssetPath = CUSTOMER_THEME_DEFINITIONS[customerTheme]?.assetPath;
  const assignedTableId = apiMode && Number.isSafeInteger(customerDeviceConfig?.tableId) ? String(customerDeviceConfig.tableId) : null;
  const device = assignedTableId
    ? { ...localDevice, tableId: assignedTableId, label: customerDeviceConfig.tableLabel || localDevice.label }
    : localDevice;
  const online = apiMode ? typeof navigator === "undefined" || navigator.onLine !== false : !state.offlineDevices.includes(device.deviceId);
  const [apiMenuState, dispatchApiMenuState] = useReducer(customerMenuStateReducer, apiMode, createCustomerMenuState);
  const apiMenu = apiMenuState.menu;
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
  const cartRef = useRef(cart);
  const cartVisitContextIdRef = useRef(null);
  const cartContextCapturedRef = useRef(false);
  const cartContextCaptureRef = useRef(null);
  const [cartContextLoading, setCartContextLoading] = useState(false);
  const [cartContextStale, setCartContextStale] = useState(false);
  const [cartAuthorizationRequired, setCartAuthorizationRequired] = useState(false);
  const [modal, setModal] = useState(null);
  const [rideGuidanceType, setRideGuidanceType] = useState(null);
  const [rideGuidanceState, setRideGuidanceState] = useState({ loading: true, error: false, data: null });
  const [rideGuidanceRefreshKey, setRideGuidanceRefreshKey] = useState(0);
  const [showBusinessNotice, setShowBusinessNotice] = useState(false);
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
  const [checkoutState, setCheckoutState] = useState({ loading: false, error: false, errorDetails: null, checkout: null, visitContextId: null, loaded: false });
  const [checkoutRequestError, setCheckoutRequestError] = useState(false);
  const [checkoutReceiptRequested, setCheckoutReceiptRequested] = useState(false);
  const [checkoutSubmitting, setCheckoutSubmitting] = useState(false);
  const [checkoutRefreshKey, setCheckoutRefreshKey] = useState(0);
  const [checkoutReconnectRefresh, setCheckoutReconnectRefresh] = useState({ sequence: 0, visitContextId: null });
  const [submitting, setSubmitting] = useState(false);
  const submitLock = useRef(false);
  const staffCallSubmitLock = useRef(false);
  const staffCallIdRef = useRef(null);
  const staffCallResolvedIdsRef = useRef(new Set());
  const [staffCallSubmitting, setStaffCallSubmitting] = useState(false);
  const [staffCallCooldown, setStaffCallCooldown] = useState(null);
  const [staffCallClock, setStaffCallClock] = useState(Date.now());
  const staffCallVisitContextId = apiMode ? (customerDeviceConfig?.visitContextId ?? null) : "demo";
  const checkoutVisitContextId = apiMode ? (customerDeviceConfig?.visitContextId ?? null) : "demo";
  const staffCallStorageKey = customerStaffCallCooldownKey(customerDeviceConfig?.deviceId ?? deviceId, staffCallVisitContextId);
  const staffCallCooldownKeyRef = useRef(null);
  const staffCallCooldownUntilRef = useRef({ key: staffCallStorageKey, untilAtMs: 0 });
  const staffCallCurrentStorageKeyRef = useRef(staffCallStorageKey);
  staffCallCurrentStorageKeyRef.current = staffCallStorageKey;
  const currentStaffCallCooldown = staffCallCooldown?.visitContextId === staffCallVisitContextId ? staffCallCooldown : null;
  const staffCallCooldownRemainingSeconds = Math.max(
    customerStaffCallCooldownSeconds(currentStaffCallCooldown, staffCallClock),
    staffCallCooldownUntilRef.current.key === staffCallStorageKey
      ? Math.max(0, Math.ceil((staffCallCooldownUntilRef.current.untilAtMs - staffCallClock) / 1000))
      : 0,
  );

  useEffect(() => {
    if (staffCallCooldownKeyRef.current !== staffCallStorageKey) staffCallIdRef.current = null;
    staffCallCooldownKeyRef.current = staffCallStorageKey;
    if (!staffCallStorageKey) {
      staffCallCooldownUntilRef.current = { key: null, untilAtMs: 0 };
      setStaffCallCooldown(null);
      return;
    }
    let saved = null;
    try { saved = parseCustomerStaffCallCooldown(window.localStorage.getItem(staffCallStorageKey)); } catch { /* storage may be unavailable */ }
    staffCallCooldownUntilRef.current = { key: staffCallStorageKey, untilAtMs: saved?.untilAtMs ?? 0 };
    setStaffCallCooldown(saved);
    setStaffCallClock(Date.now());
  }, [staffCallStorageKey]);

  useEffect(() => {
    if (!staffCallStorageKey) return undefined;
    const onStorage = (event) => {
      if (event.key !== staffCallStorageKey) return;
      const saved = parseCustomerStaffCallCooldown(event.newValue);
      staffCallCooldownUntilRef.current = { key: staffCallStorageKey, untilAtMs: saved?.untilAtMs ?? 0 };
      setStaffCallCooldown(saved);
      setStaffCallClock(Date.now());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [staffCallStorageKey]);

  useEffect(() => {
    if (!currentStaffCallCooldown && !(staffCallCooldownUntilRef.current.key === staffCallStorageKey && staffCallCooldownUntilRef.current.untilAtMs > Date.now())) return undefined;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setStaffCallClock(now);
      if (staffCallCooldownUntilRef.current.key !== staffCallStorageKey || staffCallCooldownUntilRef.current.untilAtMs <= now) window.clearInterval(timer);
    }, 250);
    return () => window.clearInterval(timer);
  }, [currentStaffCallCooldown, staffCallStorageKey]);

  useEffect(() => {
    if (!apiMode || !staffCallCooldown || !staffCallVisitContextId || !staffCallStorageKey
      || typeof orderClient?.subscribeInvalidations !== "function"
      || staffCallCooldown.visitContextId !== staffCallVisitContextId) return undefined;
    return orderClient.subscribeInvalidations((event) => {
      if (!isMatchingCustomerStaffCallResolution(event, {
        staffCallId: staffCallCooldown.staffCallId,
        visitContextId: staffCallVisitContextId,
      })) return;
      staffCallResolvedIdsRef.current.add(staffCallCooldown.staffCallId);
      setNotice((current) => isCustomerStaffCallSuccessNotice(current, staffCallCooldown.staffCallId) ? null : current);
    });
  }, [apiMode, orderClient, staffCallCooldown, staffCallVisitContextId, staffCallStorageKey]);
  useEffect(() => {
    if (staffCallCooldownRemainingSeconds > 0 || !staffCallCooldown?.staffCallId) return;
    setNotice((current) => isCustomerStaffCallSuccessNotice(current, staffCallCooldown.staffCallId) ? null : current);
  }, [staffCallCooldown?.staffCallId, staffCallCooldownRemainingSeconds]);
  const checkoutRequestIdRef = useRef(null);
  const checkoutPreviousRef = useRef(null);
  const checkoutModalVisitContextRef = useRef(checkoutVisitContextId);
  const checkoutExplicitReadRef = useRef(false);
  const checkoutReadGenerationRef = useRef(0);
  const checkoutRefreshHandledRef = useRef(0);
  const checkoutReconnectRefreshAppliedSequenceRef = useRef(0);
  const checkoutVisitContextRef = useRef(checkoutVisitContextId);
  const checkoutAudioRef = useRef(null);
  const checkoutSoundKeysRef = useRef(new Set());
  const menuIdleTimerRef = useRef(null);
  const imoRef = useRef(null);
  const otherRef = useRef(null);
  useEffect(() => {
    if (checkoutVisitContextRef.current === checkoutVisitContextId) return;
    const previousVisitContextId = checkoutVisitContextRef.current;
    checkoutVisitContextRef.current = checkoutVisitContextId;
    checkoutModalVisitContextRef.current = null;
    checkoutExplicitReadRef.current = false;
    checkoutReadGenerationRef.current += 1;
    checkoutRequestIdRef.current = null;
    checkoutPreviousRef.current = null;
    setCheckoutReceiptRequested(false);
    setCheckoutState({ loading: false, error: false, errorDetails: null, checkout: null, visitContextId: checkoutVisitContextId, loaded: false });
    setCheckoutRequestError(false);
    if (previousVisitContextId) setModal((current) => current === "checkout" ? null : current);
    else if (checkoutVisitContextId && modal === "checkout") setCheckoutRefreshKey((current) => current + 1);
  }, [checkoutVisitContextId, modal]);
  const customerMajorCategories = buildCustomerMajorCategories(apiMenu?.categories, CUSTOMER_MAJOR_CATEGORIES);
  const currentMajorCategory = customerMajorCategories.find((category) => category.id === majorCategoryId) ?? customerMajorCategories[0];
  const currentSubcategories = currentMajorCategory.subcategories;
  const currentCategory = currentSubcategories.find((category) => category.id === categoryId) ?? currentSubcategories[0];
  const currentCategoryLabel = currentCategory?.id === "sake" ? "日本酒・地酒" : currentCategory?.name;
  const isDrink = currentMajorCategory.id === "drink";
  const isFood = currentMajorCategory.id === "food";
  const isShochu = currentCategory?.id === "shochu";
  const isSake = currentCategory?.id === "sake";
  const cartRows = customerCartRows(cart, menuItems);
  const cartCount = cartRows.reduce((sum, row) => sum + row.quantity, 0);
  const hasUnavailableCartRows = cartRows.some((row) => row.unavailable);
  const customerHistory = (apiMode ? apiOrders : state.orders)
    .filter((order) => apiMode || order.tableId === device.tableId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const recentDrinkItemIds = [...new Set(customerHistory.flatMap((order) => order.items ?? [])
    .filter((item) => CUSTOMER_DRINK_CATEGORY_IDS.has(menuItems.find((menu) => menu.id === item.menuItemId)?.categoryId))
    .map((item) => item.menuItemId))];
  const currentItems = currentCategory?.id === "recommended"
    ? recentDrinkItemIds.map((itemId) => menuItems.find((item) => item.id === itemId)).filter(Boolean)
    : expandCustomerMenuItems(menuItems.filter((item) => currentCategory?.categoryIds.includes(item.categoryId))).sort(compareMenuItems);
  const blockCartAfterAuthenticationFailure = () => {
    if (!Object.keys(cartRef.current).length) {
      setNotice({ kind: "error", message: "端末の接続を確認できません。送信待ちの注文は保持されています。スタッフへ確認してください。" });
      return;
    }
    setCartContextStale(true);
    setCartAuthorizationRequired(true);
    setModal(null);
    setNotice({ kind: "error", message: "端末の接続を確認できません。カート内容は保持しています。注文を停止しています。スタッフへ確認してください。" });
  };

  useEffect(() => {
    if (!apiMode) return undefined;
    let cancelled = false;
    dispatchApiMenuState({ type: "load-started" });
    void orderClient.getMenu().then((menu) => {
      if (cancelled) return;
      dispatchApiMenuState({ type: "load-succeeded", menu });
    }).catch(() => {
      if (!cancelled) dispatchApiMenuState({ type: "load-failed" });
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
    let cancelled = false;
    setRideGuidanceState((current) => ({ ...current, loading: true, error: false }));
    void fetchPublicRideGuidance({ env: window }).then((data) => {
      if (cancelled) return;
      setRideGuidanceState({ loading: false, error: false, data });
    }).catch(() => {
      if (!cancelled) setRideGuidanceState({ loading: false, error: true, data: null });
    });
    return () => { cancelled = true; };
  }, [rideGuidanceRefreshKey]);

  useEffect(() => {
    if (!apiMode || typeof orderClient.getDeviceConfig !== "function") return undefined;
    let cancelled = false;
    const applyVisitConfig = (currentConfig) => {
      if (cancelled) return;
      onCustomerDeviceConfigChange?.({ ...currentConfig, deviceId: customerDeviceConfig?.deviceId });
      const pinnedVisitContextId = cartVisitContextIdRef.current;
      if (
        Object.keys(cartRef.current).length > 0
        && pinnedVisitContextId
        && currentConfig.visitContextId !== pinnedVisitContextId
      ) {
        setCartContextStale(true);
        setCartAuthorizationRequired(false);
        setModal(null);
        setNotice({ kind: "error", message: "来店または端末の割当が変わりました。カートの内容は保持しています。確認後、破棄してください。" });
      }
    };
    const visitConfigRefresher = createCustomerVisitConfigRefresher({
      getConfig: (options) => orderClient.getDeviceConfig(options),
      onConfig: applyVisitConfig,
      onAuthorizationFailure: blockCartAfterAuthenticationFailure,
    });
    const refreshVisitState = () => {
      setMenuRefreshKey((current) => current + 1);
      return visitConfigRefresher.refresh();
    };
    const refreshCheckoutAfterReconnect = createCustomerCheckoutReconnectHandler({
      refreshVisitState,
      onRefreshReady: (visitContextId) => {
        if (!cancelled) setCheckoutReconnectRefresh((current) => ({ sequence: current.sequence + 1, visitContextId }));
      },
    });
    const unsubscribe = typeof orderClient.subscribeInvalidations === "function" ? orderClient.subscribeInvalidations((event) => {
      const resource = event?.payload?.resource ?? event?.resource;
      if (resource === "menu") setMenuRefreshKey((current) => current + 1);
      if (resource === "deviceConfig") {
        checkoutReadGenerationRef.current += 1;
        const visitContextBeforeRefresh = checkoutVisitContextId;
        void refreshVisitState().then((refreshedConfig) => {
          if (!refreshedConfig || refreshedConfig.visitContextId !== visitContextBeforeRefresh) return;
          setCheckoutRefreshKey((current) => current + 1);
        });
      }
      if (resource === "orders") setHistoryRefreshKey((current) => current + 1);
      if (resource === "checkout" || String(event?.payload?.type || event?.type || "").startsWith("checkout.")) setCheckoutRefreshKey((current) => current + 1);
    }, { onReconnect: refreshCheckoutAfterReconnect, onAuthorizationFailure: blockCartAfterAuthenticationFailure }) : () => {};
    return () => {
      cancelled = true;
      visitConfigRefresher.stop();
      unsubscribe();
    };
  }, [apiMode, orderClient, onCustomerDeviceConfigChange, customerDeviceConfig?.deviceId, checkoutVisitContextId]);

  useEffect(() => {
    if (!apiMode || checkoutReconnectRefresh.sequence <= checkoutReconnectRefreshAppliedSequenceRef.current) return undefined;
    if (!isMatchingCustomerCheckoutReconnectVisit({ refreshedVisitContextId: checkoutReconnectRefresh.visitContextId, currentVisitContextId: checkoutVisitContextId })) return undefined;
    checkoutReconnectRefreshAppliedSequenceRef.current = checkoutReconnectRefresh.sequence;
    setCheckoutRefreshKey((current) => current + 1);
  }, [apiMode, checkoutReconnectRefresh.sequence, checkoutReconnectRefresh.visitContextId, checkoutVisitContextId]);

  useEffect(() => {
    if (!apiMode || !orderClient?.getCheckout) return undefined;
    const refreshRequested = checkoutRefreshKey !== checkoutRefreshHandledRef.current;
    if (modal !== "checkout" && !refreshRequested) return undefined;
    if (refreshRequested) checkoutRefreshHandledRef.current = checkoutRefreshKey;
    let cancelled = false;
    const requestGeneration = checkoutReadGenerationRef.current;
    const explicitlyOpened = modal === "checkout" && checkoutExplicitReadRef.current;
    if (modal === "checkout") {
      checkoutExplicitReadRef.current = false;
      setCheckoutState((current) => beginCheckoutRead(current, checkoutVisitContextId));
    }
    void orderClient.getCheckout().then((nextCheckout) => {
      if (cancelled || requestGeneration !== checkoutReadGenerationRef.current) return;
      const previous = checkoutPreviousRef.current;
      checkoutPreviousRef.current = nextCheckout;
      if (previous?.status === "requested" && nextCheckout?.status === "ready") {
        const soundKey = `${nextCheckout.checkoutRequestId}:${nextCheckout.version}`;
        let alreadyPlayed = checkoutSoundKeysRef.current.has(soundKey);
        try { alreadyPlayed = alreadyPlayed || sessionStorage.getItem(`warun-checkout-ready:${soundKey}`) === "1"; } catch { /* sessionStorage can be unavailable */ }
        if (!alreadyPlayed) {
          checkoutSoundKeysRef.current.add(soundKey);
          try { sessionStorage.setItem(`warun-checkout-ready:${soundKey}`, "1"); } catch { /* best effort dedupe */ }
          playCheckoutBell(checkoutAudioRef);
        }
      }
      if (nextCheckout) setCheckoutReceiptRequested(nextCheckout.receiptRequested === true);
      setCheckoutState({ loading: false, error: false, errorDetails: null, checkout: nextCheckout, visitContextId: checkoutVisitContextId, loaded: true });
    }).catch((error) => {
      if (!cancelled && requestGeneration === checkoutReadGenerationRef.current) {
        if (isPassiveMissingCheckoutSession(error, { explicitlyOpened })) {
          checkoutReadGenerationRef.current += 1;
          checkoutRequestIdRef.current = null;
          checkoutPreviousRef.current = null;
          checkoutModalVisitContextRef.current = null;
          setCheckoutReceiptRequested(false);
          setCheckoutRequestError(false);
          setCheckoutState({ loading: false, error: false, errorDetails: null, checkout: null, visitContextId: checkoutVisitContextId, loaded: true });
          setModal((current) => current === "checkout" ? null : current);
          return;
        }
        const code = typeof error?.code === "string" && /^[A-Z0-9_:-]{1,64}$/.test(error.code) ? error.code : "UNKNOWN_ERROR";
        const status = Number.isInteger(error?.status) && error.status > 0 ? error.status : null;
        const stage = ["configuration", "network", "http", "response"].includes(error?.stage) ? error.stage : "client";
        setCheckoutState((current) => ({ ...current, loading: false, error: true, errorDetails: { stage, status, code }, checkout: null, visitContextId: checkoutVisitContextId, loaded: true }));
      }
    });
    return () => { cancelled = true; };
  }, [apiMode, modal, orderClient, checkoutRefreshKey, checkoutVisitContextId]);

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
            status: event.state === "synced" ? "new" : event.state === "rejected" ? "rejected" : event.state === "pending" || event.state === "review_required" ? "queued_offline" : order.status,
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
    if (notice?.kind !== "success" || notice.staffCallId) return undefined;
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

  const replaceCart = (nextCart) => {
    cartRef.current = nextCart;
    setCart(nextCart);
  };
  const clearCart = () => {
    replaceCart({});
    cartVisitContextIdRef.current = null;
    cartContextCapturedRef.current = false;
    cartContextCaptureRef.current = null;
    setCartContextLoading(false);
    setCartContextStale(false);
    setCartAuthorizationRequired(false);
  };
  const captureCartVisitContext = () => {
    if (!apiMode || cartContextCapturedRef.current) return cartContextCaptureRef.current || Promise.resolve(cartVisitContextIdRef.current);
    cartContextCapturedRef.current = true;
    setCartContextLoading(true);
    const capture = Promise.resolve()
      .then(() => typeof orderClient.getVisitContextId === "function"
        ? orderClient.getVisitContextId()
        : customerDeviceConfig?.visitContextId ?? null)
      .catch(() => customerDeviceConfig?.visitContextId ?? null)
      .then((visitContextId) => {
        cartVisitContextIdRef.current = visitContextId || null;
        return cartVisitContextIdRef.current;
      })
      .finally(() => {
        setCartContextLoading(false);
        cartContextCaptureRef.current = null;
      });
    cartContextCaptureRef.current = capture;
    return capture;
  };
  const addSelectionNow = (item, selection, normalizedQuantity) => {
    replaceCart(addCustomerCartSelection(cartRef.current, item, selection, normalizedQuantity));
  };
  const addSelection = (item, selection = {}, quantity = 1) => {
    if (!item || item.isSoldOut || submitLock.current) return;
    const normalizedQuantity = Number.isInteger(quantity) && quantity > 0 ? quantity : 0;
    if (!normalizedQuantity) return;
    if (!apiMode || Object.keys(cartRef.current).length > 0) {
      addSelectionNow(item, selection, normalizedQuantity);
      return;
    }
    void captureCartVisitContext().then(() => addSelectionNow(item, selection, normalizedQuantity));
  };
  const discardStaleCart = () => {
    clearCart();
    setModal(null);
  };
  const decrementCartRow = (key) => {
    const current = cartRef.current;
    const row = current[key];
    if (!row) return;
    const next = { ...current };
    if (row.quantity <= 1) delete next[key];
    else next[key] = { ...row, quantity: row.quantity - 1 };
    replaceCart(next);
    if (Object.keys(next).length === 0) clearCart();
  };
  const removeCartRow = (key) => {
    const next = removeCustomerCartSelection(cartRef.current, key);
    replaceCart(next);
    if (Object.keys(next).length === 0) clearCart();
  };

  const submitOrder = async () => {
    if (!cartRows.length || hasUnavailableCartRows || cartContextStale || submitLock.current) return;
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
        const pinnedVisitContextId = cartVisitContextIdRef.current;
        if (typeof orderClient.checkVisitContext === "function" && pinnedVisitContextId) {
          const contextCheck = await orderClient.checkVisitContext(pinnedVisitContextId);
          if (contextCheck?.status === "unauthorized" || ["HTTP_401", "HTTP_403", "AUTHENTICATION_FAILED", "AUTHORIZATION_FAILED"].includes(contextCheck?.errorCode)) {
            blockCartAfterAuthenticationFailure();
            return;
          }
          if (contextCheck?.status === "stale") {
            setCartContextStale(true);
            setCartAuthorizationRequired(false);
            setModal(null);
            setNotice({ kind: "error", message: "来店または端末の割当が変わりました。カートの内容は保持しています。確認後、破棄してください。" });
            return;
          }
        }
        setNotice({ kind: "sending", message: "送信中です。注文を保存しています。" });
        const outboxRecord = await orderClient.enqueue({ visitContextId: pinnedVisitContextId, items: cartRows.map((row) => ({
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
          transportState: outboxRecord.state,
          totalAmount: cartRows.reduce((sum, row) => sum + (row.variant?.priceYen ?? row.item.price) * row.quantity, 0),
          syncedAt: null,
          completedAt: null,
          items,
        };
        setApiOrders((current) => [...current, order]);
        clearCart();
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
        } else if (result.state === "review_required") {
          setNotice(customerOrderNoticeFromOutboxEvent({
            clientOrderId: outboxRecord.clientOrderId,
            state: "review_required",
            displayState: "review_required",
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
      clearCart();
      setModal(null);
      setNotice(online ? "送信しました。ご注文を承りました。" : "通信が戻るまで、この端末に安全に保存します。送信待ちです。");
    } catch {
      setNotice({ kind: "failed", message: "注文を保存できませんでした。もう一度お試しください。" });
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  };

  const callStaff = async () => {
    if (staffCallSubmitLock.current) return;
    if (staffCallCooldownRemainingSeconds > 0
      || (staffCallCooldownUntilRef.current.key === staffCallStorageKey && staffCallCooldownUntilRef.current.untilAtMs > Date.now())) return;
    if (!apiMode) {
      const staffCallId = makeId("call");
      updateState((current) => ({ ...current, staffCalls: [...current.staffCalls, { id: staffCallId, tableId: device.tableId, type: "staff", createdAt: new Date().toISOString(), resolvedAt: null }] }));
      const cooldown = { staffCallId, visitContextId: "demo", untilAtMs: Date.now() + CUSTOMER_STAFF_CALL_COOLDOWN_MS };
      staffCallCooldownUntilRef.current = { key: staffCallStorageKey, untilAtMs: cooldown.untilAtMs };
      try { window.localStorage.setItem(staffCallStorageKey, JSON.stringify(cooldown)); } catch { /* in-page lock still enforces the limit */ }
      setStaffCallCooldown(cooldown);
      setStaffCallClock(Date.now());
      setModal(null);
      setNotice({ kind: "success", message: "スタッフを呼び出しました。", staffCallId });
      return;
    }
    staffCallSubmitLock.current = true;
    setStaffCallSubmitting(true);
    let callVisitContextId = staffCallVisitContextId;
    try {
      callVisitContextId = callVisitContextId || await orderClient.getVisitContextId?.();
      const callStorageKey = customerStaffCallCooldownKey(customerDeviceConfig?.deviceId ?? deviceId, callVisitContextId);
      if (!callVisitContextId || !callStorageKey) throw new Error("VISIT_CONTEXT_UNAVAILABLE");
      let savedCooldown = null;
      try { savedCooldown = parseCustomerStaffCallCooldown(window.localStorage.getItem(callStorageKey)); } catch { /* storage may be unavailable */ }
      const savedCooldownSeconds = customerStaffCallCooldownSeconds(savedCooldown);
      if (savedCooldownSeconds > 0) {
        staffCallCooldownUntilRef.current = { key: callStorageKey, untilAtMs: savedCooldown.untilAtMs };
        setStaffCallCooldown(savedCooldown);
        setStaffCallClock(Date.now());
        setModal(null);
        return;
      }
      const pendingCallKey = `warun-pending-staff-call-id:${customerDeviceConfig?.deviceId ?? deviceId}:${callVisitContextId}`;
      let clientCallId = staffCallIdRef.current;
      if (!clientCallId) {
        try { clientCallId = window.sessionStorage.getItem(pendingCallKey); } catch { /* session storage may be unavailable */ }
      }
      if (!clientCallId || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientCallId)) {
        clientCallId = createClientOrderId();
      }
      staffCallIdRef.current = clientCallId;
      try { window.sessionStorage.setItem(pendingCallKey, clientCallId); } catch { /* server idempotency remains active for in-page retries */ }
      const result = await orderClient.createStaffCall({ clientCallId, expectedVisitContextId: callVisitContextId });
      staffCallIdRef.current = null;
      try { window.sessionStorage.removeItem(pendingCallKey); } catch { /* best effort cleanup */ }
      const cooldown = { staffCallId: result.staffCallId, visitContextId: callVisitContextId, untilAtMs: Date.now() + CUSTOMER_STAFF_CALL_COOLDOWN_MS };
      try { window.localStorage.setItem(callStorageKey, JSON.stringify(cooldown)); } catch { /* the in-page lock still protects this visit */ }
      const stillCurrentVisit = staffCallCurrentStorageKeyRef.current === callStorageKey || staffCallCurrentStorageKeyRef.current === null;
      if (stillCurrentVisit) {
        staffCallCooldownUntilRef.current = { key: callStorageKey, untilAtMs: cooldown.untilAtMs };
        setStaffCallCooldown(cooldown);
        setStaffCallClock(Date.now());
      }
      setModal(null);
      if (stillCurrentVisit && !staffCallResolvedIdsRef.current.has(cooldown.staffCallId)) {
        setNotice({ kind: "success", message: "スタッフを呼び出しました。", staffCallId: cooldown.staffCallId });
      }
    } catch {
      if (staffCallCurrentStorageKeyRef.current === customerStaffCallCooldownKey(customerDeviceConfig?.deviceId ?? deviceId, callVisitContextId)) {
        setNotice({ kind: "failed", message: "呼出を保存できませんでした。呼出画面を開いたまま再試行してください。" });
      }
    } finally {
      staffCallSubmitLock.current = false;
      setStaffCallSubmitting(false);
    }
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
  const chooseSakeFromDetail = (item) => {
    setDetailItem(null);
    openSakeSelection(item);
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
  const openRideGuidance = () => {
    setRideGuidanceType(null);
    setRideGuidanceRefreshKey((current) => current + 1);
    setModal("ride-guidance");
  };
  const openCheckout = () => {
    setCheckoutRequestError(false);
    checkoutModalVisitContextRef.current = checkoutVisitContextId;
    checkoutExplicitReadRef.current = true;
    if (!apiMode) {
      setCheckoutState({ loading: false, error: true, errorDetails: { stage: "configuration", status: null, code: "API_UNAVAILABLE" }, checkout: null, visitContextId: checkoutVisitContextId });
      setModal("checkout");
      return;
    }
    setModal("checkout");
    setCheckoutRefreshKey((current) => current + 1);
  };
  const requestCheckout = async () => {
    if (checkoutSubmitting || checkoutState.checkout?.status === "requested" || checkoutState.checkout?.status === "ready") return;
    const requestVisitContextId = checkoutVisitContextId;
    prepareCheckoutBell(checkoutAudioRef);
    setCheckoutSubmitting(true);
    setCheckoutRequestError(false);
    setCheckoutState((current) => ({ ...current, loading: true, error: false, errorDetails: null, visitContextId: requestVisitContextId }));
    const checkoutRequestId = checkoutRequestIdRef.current || createClientOrderId();
    checkoutRequestIdRef.current = checkoutRequestId;
    try {
      const checkout = await orderClient.requestCheckout({ checkoutRequestId, receiptRequested: checkoutReceiptRequested });
      if (checkoutVisitContextRef.current !== requestVisitContextId) return;
      checkoutPreviousRef.current = checkout;
      setCheckoutRequestError(false);
      setCheckoutState({ loading: false, error: false, errorDetails: null, checkout, visitContextId: requestVisitContextId, loaded: true });
    } catch (error) {
      if (checkoutVisitContextRef.current === requestVisitContextId) {
        setCheckoutRequestError(true);
        setCheckoutState((current) => ({ ...current, loading: false, error: false, errorDetails: null, visitContextId: requestVisitContextId, loaded: true }));

      }
    } finally { setCheckoutSubmitting(false); }
  };
  const retryCheckout = () => {
    setCheckoutRequestError(false);
    checkoutExplicitReadRef.current = true;
    setCheckoutRefreshKey((current) => current + 1);
  };
  const resetCancelledCheckout = () => {
    checkoutRequestIdRef.current = null;
    checkoutPreviousRef.current = null;
    setCheckoutReceiptRequested(false);
    setCheckoutState({ loading: false, error: false, errorDetails: null, checkout: null, visitContextId: checkoutVisitContextId, loaded: true });
        setCheckoutRequestError(false);
  };
  const closeRideGuidance = () => {
    setRideGuidanceType(null);
    setModal(null);
  };
  const selectedRideContacts = rideGuidanceState.data?.contacts
    .filter((contact) => contact.type === rideGuidanceType)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const rideGuidanceTypeLabel = rideGuidanceType === "taxi" ? "タクシー" : "運転代行";

  const orderStartNoticeScopeKey = createCustomerOrderStartNoticeScopeKey(apiMode
    ? { deviceId: customerDeviceConfig?.deviceId, tableId: customerDeviceConfig?.tableId, visitContextId: customerDeviceConfig?.visitContextId }
    : { deviceId: device.deviceId, tableId: device.tableId, visitContextId: "demo" });
  const orderStartNoticeReady = Boolean(orderStartNoticeScopeKey);
  const orderStartNoticeCanContinue = orderStartNoticeReady && !orderStartNoticeState.loading && !orderStartNoticeState.error && hasValidCustomerOrderStartNoticeSettings(orderStartNoticeState.settings);
  const orderStartNoticeAcknowledged = orderStartNoticeReady && (
    acknowledgedOrderStartNoticeScope === orderStartNoticeScopeKey
    || hasCustomerOrderStartNoticeAcknowledgement({ scopeKey: orderStartNoticeScopeKey })
  );
  const continueAfterOrderStartNotice = () => {
    if (!orderStartNoticeCanContinue || !acknowledgeCustomerOrderStartNotice({ scopeKey: orderStartNoticeScopeKey })) return;
    setAcknowledgedOrderStartNoticeScope(orderStartNoticeScopeKey);
  };

  if (!orderStartNoticeAcknowledged) return <CustomerOrderStartNotice
    ready={orderStartNoticeCanContinue}
    settings={orderStartNoticeState.settings}
    loading={orderStartNoticeState.loading}
    error={orderStartNoticeState.error}
    onRetry={() => setOrderStartNoticeRefreshKey((current) => current + 1)}
    onContinue={continueAfterOrderStartNotice}
  />;

  return (
    <div className={`customer-app ${majorNavOpen ? "" : "customer-app--category-collapsed"}`} data-customer-theme={visibleCustomerTheme} style={customerThemePaletteStyle(visibleCustomerTheme)}>
      {modal === "ride-guidance" ? <RideGuidanceModal dataState={rideGuidanceState} selectedType={rideGuidanceType} onSelectType={setRideGuidanceType} onBack={() => setRideGuidanceType(null)} onClose={closeRideGuidance} /> : null}
      {isCheckoutModalForCurrentVisit({ modal, openedForVisitContextId: checkoutModalVisitContextRef.current, currentVisitContextId: checkoutVisitContextId }) && (!apiMode || checkoutState.visitContextId === checkoutVisitContextId) ? <CustomerCheckoutModal checkoutState={checkoutState} checkoutRequestError={checkoutRequestError} receiptRequested={checkoutReceiptRequested} onReceiptChange={setCheckoutReceiptRequested} onRequest={requestCheckout} onRetry={retryCheckout} onResetCancelled={resetCancelledCheckout} onClose={() => { checkoutModalVisitContextRef.current = null; setModal(null); }} submitting={checkoutSubmitting} /> : null}
      <aside className="customer-sidebar">
        {majorNavOpen && customerThemeAssetPath && visibleCustomerTheme === customerTheme ? <CustomerThemeImage theme={customerTheme} variant={customerThemeConfig} alt={`${CUSTOMER_THEME_DEFINITIONS[customerTheme]?.label ?? "客席テーマ"}のレール画像`} onError={() => setCustomerThemeImageFailed(true)} /> : null}
        <CustomerRailContent expanded={majorNavOpen} categories={customerMajorCategories} currentCategoryId={majorCategoryId} onSelectCategory={selectMajorCategory} onExpand={() => setMajorNavOpen(true)} businessHours={businessHours} onOpenNotice={() => setShowBusinessNotice(true)} />
      </aside>

      <section className={`customer-main ${isMenuHeaderHidden ? "customer-main--menu-active" : ""} ${notice ? "customer-main--has-notice" : ""}`}>
        <header className={`customer-header ${isMenuHeaderHidden ? "customer-header--menu-hidden" : ""}`}>
          <IconButton icon={ClipboardText} onClick={() => setModal("history")}>注文履歴</IconButton>
          <IconButton icon={Bell} disabled={staffCallSubmitting || staffCallCooldownRemainingSeconds > 0} onClick={() => { if (staffCallCooldownRemainingSeconds === 0) setModal("staff"); }}>{staffCallCooldownRemainingSeconds > 0 ? `スタッフ呼出 あと${staffCallCooldownRemainingSeconds}秒` : "スタッフを呼ぶ"}</IconButton>
          <IconButton icon={CurrencyJpy} onClick={openCheckout}>お会計</IconButton>
          <IconButton icon={Car} onClick={openRideGuidance}>タクシー・運転代行</IconButton>
          <div className="table-label">テーブル <b>{device.tableId}</b></div>
        </header>

        {notice ? <div className={`customer-notice ${noticeKind === "success" ? "is-success" : "is-queued"}`}><span>{noticeKind === "success" ? <CheckCircle size={26} weight="fill" /> : noticeKind === "sending" ? <WifiHigh size={26} weight="bold" /> : <WifiSlash size={26} weight="bold" />}{noticeMessage}</span><button onClick={() => setNotice(null)} aria-label="通知を閉じる"><X size={20} /></button></div> : null}

        <div className="customer-content">
          <section className="menu-panel" onWheel={handleMenuInteraction} onTouchMove={handleMenuInteraction} onClick={handleMenuClick}>
            <div className={`menu-heading ${currentMajorCategory.id === "drink" ? "menu-heading--drink" : ""} ${currentCategory?.id === "shochu" ? "menu-heading--shochu" : ""}`}><div className="menu-heading__breadcrumb"><span>{currentMajorCategory.name}</span>{currentCategory ? <><b>&gt;</b><strong>{currentCategoryLabel}</strong></> : null}</div>{currentMajorCategory.id === "drink" && !drinkCategoryNavOpen ? <button className="category-return-button category-return-button--inline" type="button" onClick={(event) => { event.stopPropagation(); restoreDrinkCategoryNavigation(); }}>飲み物一覧に戻る</button> : null}</div>
            {currentSubcategories.length > 0 && (currentMajorCategory.id !== "drink" || drinkCategoryNavOpen) ? <nav className={`subcategory-nav ${currentMajorCategory.id === "drink" ? "subcategory-nav--drink" : ""}`} aria-label={`${currentMajorCategory.name}の細分類`}>
              {currentSubcategories.map((category) => <button key={category.id} className={category.id === currentCategory?.id ? "is-active" : ""} onClick={() => selectSubcategory(category.id)}>{category.name}</button>)}
            </nav> : null}
            {isShochu ? <nav className="drink-jump-nav" aria-label="焼酎の分類"><button onClick={() => imoRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>芋</button><button onClick={() => otherRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>麦・その他</button></nav> : null}
            <div className="menu-list">
              {apiMenuState.loading && !apiMenu ? <div className="empty-state"><ListBullets size={42} /><p>メニューを読み込んでいます。</p></div> : apiMenuState.error && !apiMenu ? <div className="empty-state"><ListBullets size={42} /><p>メニューを取得できません。</p></div> : <>
                {apiMenuState.error ? <div className="cart-context-status" role="status">メニューを更新できません。通信状態を確認してください。<ConnectionBadge online={online} compact announceStatus /></div> : null}
                {currentItems.length ? currentItems.map((item, index) => {
                const previous = currentItems[index - 1];
                const shochuGroup = (entry) => entry?.sectionKey === "芋" ? "芋" : "麦・その他";
                const isShochuGroupStart = isShochu && (index === 0 || shochuGroup(previous) !== shochuGroup(item));
                const isFirstShochuImo = isShochu && item.sectionKey === "芋" && currentItems.findIndex((entry) => entry.sectionKey === "芋") === index;
                const isFirstShochuOther = isShochu && shochuGroup(item) === "麦・その他" && currentItems.findIndex((entry) => shochuGroup(entry) === "麦・その他") === index;
                const showListImage = listImageVisible(item) && Boolean(item.imageUri);
                const isKushikatsu = item.isKushikatsuVirtual === true;
                const canOpenDetail = Boolean(item.detail?.imageUri || item.imageUri);
                const listComment = isDrink ? item.description?.trim() : "";
                const foodDescription = isFood ? item.description?.trim() : "";
                const row = isSake ? (
                  <article className={`menu-row sake-menu-row ${item.isSoldOut ? "is-sold-out" : ""}`} key={item.id}>
                    <div className="menu-row__index">{String(index + 1).padStart(2, "0")}</div>
                    <button className="product-image-button" onClick={() => canOpenDetail ? setDetailItem(item) : undefined} aria-label={`${item.name}の詳細を見る`} disabled={!canOpenDetail}>{item.imageUri ? <img src={item.imageUri} alt="" style={imageLayoutStyle(item, "thumbnail")} /> : <span>画像なし</span>}</button>
                    <button className="menu-row__copy menu-row__copy--button" onClick={() => canOpenDetail ? setDetailItem(item) : undefined} disabled={!canOpenDetail} aria-label={item.name + "の詳細を見る"}>{item.detail?.reading ? <small className="menu-row__reading">{item.detail.reading}</small> : null}<h2>{item.name}</h2>{canOpenDetail || listComment ? <small className="menu-row__detail-hint">{canOpenDetail ? <span className="menu-row__detail-hint__action">タップで明細</span> : null}{canOpenDetail && listComment ? <span className="menu-row__detail-hint__separator" aria-hidden="true">｜</span> : null}{listComment ? <span className="menu-row__comment">{listComment}</span> : null}</small> : null}</button>
                    {item.orderingMode === "reservation_only" ? <div className="reservation-only-label"><b>予約限定</b></div> : <button className="sake-serve-button" onClick={() => openSakeSelection(item)} disabled={item.isSoldOut || !item.variants.length} aria-label={`${item.name}の提供方法を選ぶ`}><span>提供方法を選ぶ</span><small>グラス／徳利</small></button>}
                  </article>
                ) : (
                  <article className={`menu-row ${isFood ? "food-menu-row" : ""} ${isShochu ? "shochu-menu-row" : ""} ${showListImage ? "" : "menu-row--no-image"} ${item.isSoldOut ? "is-sold-out" : ""}`} key={item.id} ref={isFirstShochuImo ? imoRef : null}>
                    <div className="menu-row__index">{String(index + 1).padStart(2, "0")}</div>
                    {showListImage ? <button className="product-image-button" onClick={() => canOpenDetail ? setDetailItem(item) : undefined} aria-label={`${item.name}の詳細を見る`} disabled={!canOpenDetail}>{item.imageUri ? <img src={isShochu ? shochuThumbUri(item.imageUri) : item.imageUri} alt="" style={imageLayoutStyle(item, "thumbnail")} /> : <span>画像なし</span>}</button> : null}
                    <button className="menu-row__copy menu-row__copy--button" onClick={() => canOpenDetail ? setDetailItem(item) : undefined} aria-label={`${item.name}の詳細を見る`} disabled={!canOpenDetail}>{item.detail?.reading ? <small className="menu-row__reading">{item.detail.reading}</small> : null}<h2>{item.name}</h2>{foodDescription ? <small className="menu-row__food-description">{foodDescription}</small> : null}{canOpenDetail || listComment ? <small className="menu-row__detail-hint">{canOpenDetail ? <span className="menu-row__detail-hint__action">タップで明細</span> : null}{canOpenDetail && listComment ? <span className="menu-row__detail-hint__separator" aria-hidden="true">｜</span> : null}{listComment ? <span className="menu-row__comment">{listComment}</span> : null}</small> : null}</button>
                    {isKushikatsu ? <span className="menu-price kushikatsu-price"><b><span className="kushikatsu-serving-label">1本 </span>{yen(taxExcludedYen(item.price))}</b><small>税込 {yen(item.price)}</small><small className="kushikatsu-condition">各種2本から</small></span> : <PriceDisplay priceYen={item.price} />}
                    {item.orderingMode === "reservation_only" ? <div className="reservation-only-label"><b>予約限定</b></div> : item.isSoldOut ? <div className="sold-out-label"><b>{CUSTOMER_WINTER_CATEGORY_IDS.has(item.categoryId) ? "冬季限定・現在注文できません" : "売り切れ"}</b><small>{CUSTOMER_WINTER_CATEGORY_IDS.has(item.categoryId) ? "SEASONAL PAUSED" : "SOLD OUT"}</small></div> : isKushikatsu ? <button className="add-button" onClick={() => openKushikatsuSelection(item)} aria-label={`${item.name}の本数を選ぶ`}><Plus size={36} weight="bold" /></button> : item.servingOptions.length ? <button className="shochu-serving-button" onClick={() => openShochuSelection(item)} aria-label={`${item.name}の飲み方選択`}>飲み方選択</button> : <button className="add-button" onClick={() => addSelection(item)} aria-label={`${item.name}を追加`}><Plus size={36} weight="bold" /></button>}
                  </article>
                );
                return (
                  <div key={item.id} ref={isFirstShochuOther ? otherRef : null}>{isShochuGroupStart && (index > 0 || shochuGroup(item) === "麦・その他") ? <div className="menu-section-divider"><b>{shochuGroup(item)}</b><span>{shochuGroup(item) === "芋" ? "芋焼酎" : "麦焼酎・黒糖・泡盛など"}</span></div> : null}{row}</div>
                );
                }) : <div className="empty-state"><ListBullets size={42} /><p>このカテゴリの商品はまだありません。</p></div>}
              </>}
            </div>
          </section>

          <aside className="cart-panel">
            <header><Receipt size={36} weight="bold" /><div><h2>ご注文内容</h2><span>ORDER SUMMARY</span></div></header>
            <div className="cart-list">
              {cartRows.length ? cartRows.map((row, index) => <div className={`cart-row${row.unavailable ? " cart-row--unavailable" : ""}`} key={row.key}><span className="cart-row__index">{index + 1}</span><b>{selectionDisplayName(row.item, row)}</b><span>{row.quantity}点</span><button onClick={() => row.unavailable ? removeCartRow(row.key) : decrementCartRow(row.key)} aria-label={`${selectionDisplayName(row.item, row)}${row.unavailable ? "をカートから削除" : "を1点取り消す"}`}><X size={18} /></button></div>) : <div className="cart-empty"><Receipt size={54} weight="thin" /><p>商品を追加すると<br />ここに表示されます。</p></div>}
            </div>
            {hasUnavailableCartRows ? <p className="cart-context-warning" role="alert">現在注文できない商品があります。内容をご確認ください</p> : null}
            {apiMode && cartRows.length && cartContextLoading ? <p className="cart-context-status" role="status">来店情報を確認しています…</p> : null}
            {apiMode && Object.keys(cart).length > 0 && cartContextStale ? <div className="cart-context-warning" role="alert"><p>{cartAuthorizationRequired ? "端末の接続を確認できません。カート内容は保持しています。注文は送信されません。スタッフへ確認してください。" : "来店または端末の割当が変わりました。注文は送信されません。カート内容を確認して破棄してください。"}</p><button type="button" onClick={discardStaleCart} disabled={submitting}>このカートを破棄</button></div> : null}
            <button className="confirm-button" disabled={!cartCount || hasUnavailableCartRows || cartContextLoading || cartContextStale} onClick={() => setModal("confirm")}>注文を確定する <ArrowRight size={28} weight="bold" /></button>
          </aside>
        </div>
        <footer className="customer-footer"><b>INFORMATION</b>{CUSTOMER_FOOTER_INFORMATION ? <span>{CUSTOMER_FOOTER_INFORMATION}</span> : null}<strong>全席喫煙可能</strong></footer>
      </section>

      {modal === "confirm" ? <Modal title="注文内容の確認" onClose={() => { if (!submitting) setModal(null); }}><div className="confirm-list">{cartRows.map((row) => <div key={row.key}><b>{selectionDisplayName(row.item, row)}</b><span>{row.quantity}点</span></div>)}</div>{hasUnavailableCartRows ? <p className="cart-context-warning" role="alert">現在注文できない商品があります。内容をご確認ください</p> : <p className="price-hidden-note">内容をご確認のうえ、注文を送信してください。</p>}<div className="modal-actions"><button className="button button--quiet" onClick={() => setModal(null)} disabled={submitting}>戻る</button><button className="button button--primary button--large" onClick={submitOrder} disabled={submitting || hasUnavailableCartRows || cartContextStale}>{submitting ? "送信中" : online ? "注文を送信" : "送信待ちに保存"}</button></div></Modal> : null}
      {shochuSelection && shochuSelectionItem ? <Modal title={shochuSelectionItem.name} onClose={() => setShochuSelection(null)} className="modal--shochu" footer={<div className="shochu-selection-footer"><div className="modal-actions"><button type="button" className="button button--quiet" onClick={() => setShochuSelection(null)}>キャンセル</button><button type="button" className="button button--primary button--large" disabled={!shochuSelectionTotal} onClick={commitShochuSelection}>{shochuSelectionTotal}点をカートに追加</button></div></div>}>
        <div className="shochu-selection-modal">
          <p className="modal-lead">飲み方と数量を選択してください。</p>
          <div className="shochu-selection-list" aria-label={`${shochuSelectionItem.name}の飲み方と数量`}>
            {shochuSelectionOptions.map((option) => {
              const quantity = shochuSelection.quantities[option.servingOptionId] ?? 0;
              return <div className="shochu-selection-row" key={option.servingOptionId}>
                <b>{option.name}</b>
                <div className="shochu-quantity-control" aria-label={`${option.name}の数量`}>
                  <button type="button" onClick={() => adjustShochuQuantity(option.servingOptionId, -1)} disabled={quantity === 0} aria-label={`${option.name}を1点減らす`}><Minus size={28} weight="bold" /></button>
                  <b aria-live="polite">{quantity}</b>
                  <button type="button" onClick={() => adjustShochuQuantity(option.servingOptionId, 1)} aria-label={`${option.name}を1点増やす`}><Plus size={28} weight="bold" /></button>
                </div>
              </div>;
            })}
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
      {sakeSelection && selectedSakeItem ? <Modal title="提供方法・温度を選ぶ" onClose={() => setSakeSelection(null)} wide className="modal--sake" footer={<div className="modal-actions"><button className="button button--quiet" onClick={() => { setSakeSelection(null); setSakeSelectionError(""); }}>キャンセル</button>{selectedSakeVariant && sakeSelection.temperature && sakeTemperatureOptions(selectedSakeVariant).includes(sakeSelection.temperature) ? <button className="button button--primary button--large" onClick={addSakeSelection}>これにする</button> : null}</div>}>
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
        </div>
      </Modal> : null}
      {modal === "staff" ? <Modal title="スタッフを呼びますか？" onClose={() => { if (!staffCallSubmitting) setModal(null); }}><p className="modal-lead">テーブル {device.tableId} からスタッフへお知らせします。</p>{staffCallCooldownRemainingSeconds > 0 ? <p role="status">次の呼び出しまであと {staffCallCooldownRemainingSeconds} 秒です。</p> : null}<div className="modal-actions"><button className="button button--quiet" disabled={staffCallSubmitting} onClick={() => setModal(null)}>やめる</button><button className="button button--primary button--large" disabled={staffCallSubmitting || staffCallCooldownRemainingSeconds > 0} onClick={callStaff}><Bell size={22} weight="bold" /> {staffCallSubmitting ? "送信中" : staffCallCooldownRemainingSeconds > 0 ? `あと${staffCallCooldownRemainingSeconds}秒` : "呼び出す"}</button></div></Modal> : null}
      {modal === "feature" ? <Modal title="確認" onClose={() => setModal(null)}><p className="modal-lead">この機能は次の実装段階で接続します。</p><div className="modal-actions"><button className="button button--primary" onClick={() => setModal(null)}>閉じる</button></div></Modal> : null}
      {modal === "history" ? <Modal title="これまでのご注文" onClose={() => setModal(null)} wide><div className="customer-history">{apiMode && apiHistoryState.loading ? <div className="empty-state"><ClipboardText size={42} /><p>注文履歴を読み込んでいます。</p></div> : apiMode && apiHistoryState.error ? <div className="empty-state"><ClipboardText size={42} /><p>注文履歴を取得できません。</p></div> : customerHistory.length ? customerHistory.map((order) => <article key={order.id}><header><b>{formatTime(order.createdAt)} のご注文</b><span className={`status-chip status-${order.status}`}>{customerTransportLabel(order)}</span></header>{order.items.map((item) => <div key={item.id}><span>{selectionDisplayName({ name: item.nameSnapshot }, item)}</span><b>{item.quantity}点</b></div>)}</article>) : <div className="empty-state"><ClipboardText size={42} /><p>注文履歴はまだありません。</p></div>}</div></Modal> : null}
      {detailItem ? <Modal title={detailItem.name} titleExtra={detailItem.detail?.reading ? <span className="modal__title-reading">{detailItem.detail.reading}</span> : null} onClose={() => setDetailItem(null)} wide className="modal--product-detail" footer={<div className="modal-actions product-detail__actions"><button className="button button--quiet" onClick={() => setDetailItem(null)}>一覧へ戻る</button>{detailItem.categoryId === "shochu" && detailItem.servingOptions?.length ? <button className="button button--primary button--large" onClick={() => chooseShochuFromDetail(detailItem)}>これにする</button> : detailItem.categoryId === "sake" && detailItem.variants?.length ? <button className="button button--primary button--large" onClick={() => chooseSakeFromDetail(detailItem)}>これにする</button> : null}</div>}><div className="product-detail">{detailItem.detail?.imageUri || detailItem.imageUri ? <div className="product-detail__image"><img src={detailItem.detail?.imageUri || detailItem.imageUri} alt={detailItem.name} style={imageLayoutStyle(detailItem, "detail")} /></div> : null}<div>{detailItem.detail?.itemType ? <span className="category-tag">{detailItem.detail.itemType}</span> : null}<p className="product-detail__description">{detailItem.detail?.description || detailItem.description}</p><dl>{[["産地", "origin"], ["蔵元", "producer"], ["味の特徴", "taste"], ["香り", "aroma"], ["甘辛", "sweetness"], ["キレ", "finish"]].filter(([, key]) => detailItem.detail?.[key]).map(([label, key]) => <div key={key}><dt>{label}</dt><dd>{detailItem.detail[key]}</dd></div>)}</dl>{detailItem.detail?.recommendation ? <blockquote>{detailItem.detail.recommendation}</blockquote> : null}</div></div></Modal> : null}
      {showBusinessNotice && businessHours.noticeEnabled && businessHours.noticeText.trim() ? <Modal title="営業日・営業時間のご案内" titleId="business-hours-notice-title" onClose={() => setShowBusinessNotice(false)} className="modal--business-hours-notice" footer={<div className="modal-actions"><button type="button" className="button button--primary" onClick={() => setShowBusinessNotice(false)}>閉じる</button></div>}><div className="business-hours-notice__body"><p>{businessHours.noticeText}</p></div></Modal> : null}
    </div>
  );
}

const staffNavItems = [
  { route: "/kitchen", label: "新着注文", icon: ChefHat },
  { route: "/history", label: "注文・会計履歴", icon: ClockCounterClockwise },
  { route: "/admin/menu", label: "設定・管理", icon: Gear },
];

const adminNavItems = [
  { route: "/admin/menu", label: "メニュー管理", icon: ClipboardText },
  { route: "/admin/menu-access", label: "来店限定商品", icon: CheckCircle },
  { route: "/admin/categories", label: "カテゴリ管理", icon: ListBullets },
  { route: "/admin/hours", label: "営業時間", icon: ClockCounterClockwise },
  { route: "/admin/ride-guidance", label: "タクシー／代行料金", icon: Car },
  { route: "/history", label: "注文履歴", icon: ClockCounterClockwise },
  { route: "/admin/devices", label: "設定", icon: Gear },
];

function StaffShell({ route, title, subtitle, state, children, right, status = null, clock = null, newOrderCount = 0 }) {
  const isKitchen = route === "/kitchen";
  const isAdmin = route.startsWith("/admin");
  const [kitchenRailCollapsed, setKitchenRailCollapsed] = useState(false);
  const businessHours = usePublicBusinessHours(true);
  const navItems = staffNavItems;
  const railClock = clock ?? <time className="kitchen-clock" aria-label={`現在時刻 ${formatTime(new Date())}`}>{formatTime(new Date())}</time>;
  const railStatus = status ?? <div className="staff-topbar__right"><ConnectionBadge online announceStatus /></div>;
  return (
    <div className={`staff-app ${isKitchen ? "staff-app--kitchen" : ""} ${isAdmin ? "staff-app--admin" : ""} ${kitchenRailCollapsed ? "staff-app--rail-collapsed" : ""} ${isKitchen && kitchenRailCollapsed ? "staff-app--kitchen-rail-collapsed" : ""}`}>
      <aside className="staff-sidebar" aria-label={isKitchen ? "厨房レール" : "スタッフレール"}>
        <div className="kitchen-sidebar__clock">{railClock}</div>
        <button
          type="button"
          className="kitchen-rail-toggle"
          aria-label={kitchenRailCollapsed ? "厨房レールを展開" : "厨房レールを折りたたむ"}
          title={kitchenRailCollapsed ? "厨房レールを展開" : "厨房レールを折りたたむ"}
          aria-expanded={!kitchenRailCollapsed}
          aria-controls="kitchen-staff-navigation"
          onClick={() => setKitchenRailCollapsed((collapsed) => !collapsed)}
        >
          {kitchenRailCollapsed ? <ArrowRight size={22} weight="bold" /> : <ArrowLeft size={22} weight="bold" />}
          <span>{kitchenRailCollapsed ? "展開" : "レールを閉じる"}</span>
        </button>
        <nav id="kitchen-staff-navigation" aria-label={isKitchen ? "厨房ナビゲーション" : "スタッフナビゲーション"}>{navItems.map((item) => <button key={item.route} className={route.startsWith(item.route) ? "is-active" : ""} aria-label={isKitchen ? item.label : undefined} aria-current={isKitchen && route.startsWith(item.route) ? "page" : undefined} title={isKitchen ? item.label : undefined} onClick={() => navigate(item.route)}><item.icon size={30} weight="bold" /><span className="staff-sidebar__nav-label">{item.label}</span>{item.route === "/kitchen" && newOrderCount ? <b className="badge">{newOrderCount}</b> : null}</button>)}</nav>
        <div className="staff-sidebar__status">{railStatus}</div>
        <BusinessHoursText settings={businessHours} className="hours" />
      </aside>
      <main className="staff-main">
        {isKitchen ? <>
          <div className="kitchen-heading"><h1>{title}</h1><p>{subtitle}</p></div>
        </> : isAdmin ? <header className="staff-topbar staff-topbar--admin">
          <div className="staff-title staff-title--admin"><ClipboardText size={58} weight="bold" /><div><h1>{title}</h1><p>{subtitle}</p></div></div>
          {right}
        </header> : <header className="staff-topbar">
            <div className="staff-title"><span className="section-kicker">STAFF TERMINAL</span><h1>{title}</h1><p>{subtitle}</p></div>
            {right}
          </header>}
        {children}
      </main>
    </div>
  );
}

function checkoutStatusLabel(status) {
  return status === "ready" ? "会計準備完了" : status === "cancelled" ? "取消済み" : "会計依頼";
}

function checkoutErrorMessage(error, fallback) {
  if (error instanceof KitchenApiError) {
    if (error.code === "PAYMENT_ORDER_CHANGED") return "ready後に注文または金額が変わりました。会計済みにせず、最新内容を再確認してください。";
    if (error.code === "PAYMENT_CONFLICT") return "会計済みにできません。支払状態と席の状態を再確認してください。";
    if (error.status === 409 || error.code === "CHECKOUT_VERSION_CONFLICT") return "他の端末で更新されました。最新状態を再取得してください。";
    if (error.status === 400) return "入力内容を確認してください。";
    if (error.status === 401) return "認証が切れました。厨房画面を開き直してください。";
  }
  return fallback;
}

function servingErrorMessage(error) {
  if (error?.code === "ORDER_CONFLICT") return "注文または明細の状態が変わったため、提供状態を保存できませんでした。最新状態を確認してください。";
  if (error?.code === "ORDER_NOT_FOUND" || error?.code === "INVALID_ORDER_REQUEST") return "対象の注文・明細を確認できませんでした。注文一覧を再取得してください。";
  if (error?.code === "AUTHORIZATION_FAILED" || error?.status === 401 || error?.status === 403) return "厨房端末の認証が拒否されました。接続状態を確認してください。";
  if (error?.code === "SERVE_REFRESH_FAILED") return "提供更新の応答後に最新状態を再取得できませんでした。保存状態を確認するため、通信を確認して再試行してください。";
  if (error?.code === "API_UNAVAILABLE") return "厨房APIに接続できません。接続状態を確認して再試行してください。";
  if (error instanceof TypeError) return "通信に失敗しました。接続状態を確認して再試行してください。";
  return "提供状態を保存できませんでした。接続状態と注文の状態を確認して再試行してください。";
}

function CheckoutAdjustmentInput({ label, value, onChange, disabled, onDelete = null, optional = false }) {
  return <div className={`checkout-adjustment-row ${label ? "" : "checkout-adjustment-row--optional"}`}>
    {label ? <><span className="checkout-adjustment-label">{label}</span><div className="checkout-adjustment-fields"><label><span>1人分</span><input aria-label={`${label}の1人分`} className="checkout-unit-input" inputMode="numeric" pattern="[0-9]*" value={value.unitAmount} onChange={(event) => { if (/^\d*$/.test(event.target.value)) onChange({ ...value, unitAmount: event.target.value }); }} placeholder="0" disabled={disabled} /><small>円</small></label><label><span>人数</span><input aria-label={`${label}の人数`} className="checkout-people-input" inputMode="numeric" pattern="[0-9]*" min="1" max="99" value={value.people} onChange={(event) => { if (/^\d*$/.test(event.target.value)) onChange({ ...value, people: event.target.value }); }} placeholder="1" disabled={disabled} /><small>名</small></label><output aria-label={`${label}の金額`}>{Number.isInteger(Number(value.unitAmount)) && Number.isInteger(Number(value.people)) ? yen(Number(value.unitAmount) * Number(value.people)) : "入力確認"}</output></div></> : <label className="checkout-other-fields"><span>任意料金</span><input aria-label="任意料金の項目名" value={value.label} onChange={(event) => onChange({ ...value, label: event.target.value })} placeholder="項目名" maxLength={100} disabled={disabled} /><input aria-label="任意料金の金額" className="checkout-amount-input" inputMode="numeric" pattern="[0-9]*" value={value.amount} onChange={(event) => { if (/^\d*$/.test(event.target.value)) onChange({ ...value, amount: event.target.value }); }} placeholder="0" disabled={disabled} /><small>円</small></label>}
    {optional && onDelete ? <button type="button" className="button button--quiet checkout-adjustment-delete" onClick={onDelete} disabled={disabled}>削除</button> : null}
  </div>;
}

function KitchenCheckoutPanel({ checkouts, sessions, loading, error, onRefresh, onSave, onReady, onCancel, onPay, tableId = null }) {
  const [selectedId, setSelectedId] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [confirmAction, setConfirmAction] = useState(null);
  const [paymentMethod, setPaymentMethod] = useState("cash");
  const sessionTable = (checkout) => sessions.find((session) => session.sessionId === checkout?.tableSessionId)?.tableId || "—";
  const active = checkouts.filter((checkout) => checkout.status === "requested" || checkout.status === "ready")
    .filter((checkout) => tableId === null || String(sessionTable(checkout)) === String(tableId));
  const selected = active.find((checkout) => checkout.checkoutRequestId === selectedId) || active[0] || null;
  const draftFor = (checkout) => {
    const current = drafts[checkout.checkoutRequestId];
    if (current) return current;
    const fixed = Object.fromEntries(CHECKOUT_ADJUSTMENT_TYPES.map(([kind, label]) => [kind, parseFixedAdjustment(checkout.adjustments.find((item) => item.kind === kind), label)]));
    const other = checkout.adjustments.filter((item) => item.kind === "other").map((item) => ({ label: item.label, amount: String(item.amountYen) }));
    return { ...fixed, other };
  };
  const setDraft = (checkout, next) => setDrafts((current) => ({ ...current, [checkout.checkoutRequestId]: next }));
  const normalizedAdjustments = (checkout) => {
    const draft = draftFor(checkout);
    return normalizeCheckoutAdjustments(draft);
  };
  const previewTotal = (checkout) => checkout.orderedItemsTotalYen + (checkoutAdjustmentTotal(draftFor(checkout)) ?? 0);
  const hasDraftError = (checkout) => !normalizeCheckoutAdjustments(draftFor(checkout)).ok;
  const hasUnsavedDraft = (checkout) => {
    const draft = draftFor(checkout);
    const saved = { ...Object.fromEntries(CHECKOUT_ADJUSTMENT_TYPES.map(([kind, label]) => [kind, parseFixedAdjustment(checkout.adjustments.find((item) => item.kind === kind), label)])), other: checkout.adjustments.filter((item) => item.kind === "other").map((item) => ({ label: item.label, amount: String(item.amountYen) })) };
    return JSON.stringify(draft) !== JSON.stringify(saved);
  };
  const runAction = async (action, fallback) => {
    setBusy(action); setMessage(""); setErrorMessage("");
    try {
      const apiAction = action === "cancel-ready" ? "cancel" : action;
      if (apiAction === "ready" && hasUnsavedDraft(selected)) throw new Error("保存前確認");
      const normalized = apiAction === "save" ? normalizedAdjustments(selected) : undefined;
      if (apiAction === "save" && !normalized.ok) throw new Error(normalized.error);
      const result = await ({ save: onSave, ready: onReady, cancel: onCancel }[apiAction])(selected, apiAction === "save" ? normalized.adjustments : undefined);
      if (apiAction === "ready") setMessage(`合計${yen(result.grandTotalYen)}で会計準備完了です。`);
      else if (apiAction === "cancel") setMessage("会計依頼を取り消しました。");
      else setMessage("追加料金を保存しました。");
      await onRefresh();
      if (result?.status === "cancelled") setSelectedId(null);
    } catch (actionError) {
      setErrorMessage(actionError.message === "保存前確認" ? "変更内容を保存してから、合計金額を確定してください。" : actionError instanceof KitchenApiError ? checkoutErrorMessage(actionError, fallback) : actionError.message || fallback);
      await onRefresh().catch(() => {});
    } finally { setBusy(""); setConfirmAction(null); }
  };
  const runPay = async () => {
    setBusy("pay"); setMessage(""); setErrorMessage("");
    try {
      const result = await onPay(selected, paymentMethod);
      setMessage(`会計済み（${yen(result.confirmedTotalYen)}）として保存し、席をリセットしました。`);
      await onRefresh();
    } catch (actionError) {
      setErrorMessage(checkoutErrorMessage(actionError, "会計済み記録を保存できませんでした。注文内容と金額を再確認してください。"));
      await onRefresh().catch(() => {});
    } finally { setBusy(""); setConfirmAction(null); }
  };
  if (tableId !== null && !loading && !error && !active.length) return null;
  const titleId = `checkout-panel-title-${tableId ?? "all"}`;
  return <section className={`checkout-panel ${tableId !== null ? "checkout-panel--table" : ""}`} aria-labelledby={titleId}>
    <header className="checkout-panel__header"><div><span className="section-kicker">CHECKOUT</span><h2 id={titleId}>会計依頼</h2></div><span className="checkout-panel__count">{active.length}件</span></header>
    {loading ? <div className="checkout-empty">会計依頼を読み込み中です。</div> : error ? <div className="checkout-empty" role="alert">会計依頼を取得できません。<button type="button" className="button button--quiet" onClick={onRefresh}>再読み込み</button></div> : !active.length ? <div className="checkout-empty">現在、会計依頼はありません。</div> : <div className="checkout-list">
      {tableId === null ? <div className="checkout-list__cards">{active.map((checkout) => <button type="button" key={checkout.checkoutRequestId} className={`checkout-card ${selected?.checkoutRequestId === checkout.checkoutRequestId ? "is-selected" : ""}`} onClick={() => { setSelectedId(checkout.checkoutRequestId); setErrorMessage(""); }}>
        <span className="checkout-card__table">テーブル <b>{sessionTable(checkout)}</b></span><span className={`checkout-status checkout-status--${checkout.status}`}>{checkoutStatusLabel(checkout.status)}</span><time>{formatTime(checkout.requestedAt)}</time><strong>{yen(checkout.orderedItemsTotalYen)}</strong>{checkout.receiptRequested ? <em>手書き領収書希望</em> : null}
      </button>)}</div> : null}
      {selected ? <div className="checkout-editor">
        <div className="checkout-editor__title"><div><h3>テーブル {sessionTable(selected)} の会計</h3><p>{formatTime(selected.requestedAt)} 依頼・{checkoutStatusLabel(selected.status)}</p></div>{selected.receiptRequested ? <strong className="receipt-notice"><Receipt size={24} weight="fill" /> 手書き領収書希望</strong> : null}</div>
        <div className="checkout-breakdown"><div className="checkout-breakdown__line"><span>注文済み商品合計</span><b>{yen(selected.orderedItemsTotalYen)}</b></div><details open className="checkout-adjustments-disclosure"><summary><h4>追加料金合計</h4><b>{yen(checkoutAdjustmentTotal(draftFor(selected)) ?? 0)}</b><span>入力・編集</span></summary><div className="checkout-adjustments">{CHECKOUT_ADJUSTMENT_TYPES.map(([kind, label]) => <CheckoutAdjustmentInput key={kind} label={label} value={draftFor(selected)[kind]} disabled={selected.status !== "requested" || Boolean(busy)} onChange={(value) => setDraft(selected, { ...draftFor(selected), [kind]: value })} />)}{draftFor(selected).other.map((value, index) => <CheckoutAdjustmentInput key={`other-${index}`} value={value} optional disabled={selected.status !== "requested" || Boolean(busy)} onChange={(next) => setDraft(selected, { ...draftFor(selected), other: draftFor(selected).other.map((item, itemIndex) => itemIndex === index ? next : item) })} onDelete={() => setDraft(selected, { ...draftFor(selected), other: draftFor(selected).other.filter((_, itemIndex) => itemIndex === index) })} />)}{selected.status === "requested" ? <button type="button" className="button button--quiet checkout-add-other" onClick={() => setDraft(selected, { ...draftFor(selected), other: [...draftFor(selected).other, { label: "", amount: "0" }] })} disabled={Boolean(busy)}><Plus size={18} weight="bold" /> 任意料金を追加</button> : null}</div></details><div className="checkout-total-preview"><span>確認用合計</span><b>{yen(previewTotal(selected))}</b></div></div>
        {selected.status === "requested" && hasDraftError(selected) ? <p className="checkout-feedback checkout-feedback--error" role="alert">入力未完了の料金は保存できません。単価と人数、任意料金を確認してください。</p> : null}
        {errorMessage ? <p className="checkout-feedback checkout-feedback--error" role="alert">{errorMessage}</p> : null}{message ? <p className="checkout-feedback" role="status">{message}</p> : null}
        {selected.status === "requested" ? <div className="checkout-editor__actions"><button type="button" className="button button--quiet" onClick={() => setConfirmAction("cancel")} disabled={Boolean(busy)}>会計依頼を取り消す</button><button type="button" className="button button--quiet" onClick={() => void runAction("save", "追加料金を保存できませんでした。")} disabled={Boolean(busy)}>{busy === "save" ? "保存中…" : "追加料金を保存"}</button><button type="button" className="button button--primary" onClick={() => setConfirmAction("ready")} disabled={Boolean(busy) || hasDraftError(selected) || hasUnsavedDraft(selected)}>{busy === "ready" ? "確定中…" : "合計金額を確定"}</button></div> : selected.status === "ready" ? <div className="checkout-editor__actions checkout-editor__actions--payment"><button type="button" className="button button--quiet" onClick={() => setConfirmAction("cancel-ready")} disabled={Boolean(busy)}>{busy === "cancel-ready" ? "解除中…" : "会計準備を解除"}</button><span className="checkout-payment-note">readyは金額確定のみ。実際の支払い確認後に操作してください。</span><button type="button" className="button button--primary" onClick={() => setConfirmAction("pay")} disabled={Boolean(busy)}>{busy === "pay" ? "記録中…" : "支払を確認して会計済みにする"}</button></div> : <div className="checkout-ready-note">正式合計 <b>{yen(selected.grandTotalYen)}</b>・この依頼は操作できません</div>}
      </div> : null}
    </div>}
    {confirmAction ? <Modal title={confirmAction === "ready" ? "合計金額を確定しますか？" : confirmAction === "pay" ? "支払いを確認して会計済みにしますか？" : confirmAction === "cancel-ready" ? "会計準備を解除しますか？" : "会計依頼を取り消しますか？"} onClose={() => { if (!busy) setConfirmAction(null); }}><p className="modal-lead">{confirmAction === "ready" ? `readyは金額確定のみです。${yen(selected ? previewTotal(selected) : 0)}で確認用金額を確定します。` : confirmAction === "pay" ? "実際の支払いを確認済みであることを確認してください。注文内容・金額を再検証し、支払記録と席リセットを一括で保存します。" : confirmAction === "cancel-ready" ? "これは支払済みにする操作ではありません。現在の確定額を取り消し、客席から会計を再依頼してもらいます。追加料金は新しい依頼へ自動継承されません。" : "この会計依頼を取り消します。客席側には会計準備完了として表示されません。"}</p>{confirmAction === "pay" ? <label className="checkout-payment-method"><span>支払方法</span><select value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)} disabled={Boolean(busy)}><option value="cash">現金</option><option value="card">クレジットカード</option><option value="qr">QR決済</option><option value="other">その他</option></select></label> : null}<div className="modal-actions"><button type="button" className="button button--quiet" onClick={() => setConfirmAction(null)} disabled={Boolean(busy)}>戻る</button><button type="button" className="button button--primary button--large" onClick={() => confirmAction === "pay" ? void runPay() : void runAction(confirmAction, confirmAction === "ready" ? "会計を確定できませんでした。" : confirmAction === "cancel-ready" ? "会計準備を解除できませんでした。最新状態を再取得してください。" : "会計依頼を取り消せませんでした。")} disabled={Boolean(busy)}>{busy ? "処理中…" : confirmAction === "ready" ? "確定する" : confirmAction === "pay" ? "会計済みにする" : confirmAction === "cancel-ready" ? "解除する" : "取り消す"}</button></div></Modal> : null}
  </section>;
}

function KitchenScreen({ state, updateState, apiState, checkoutState, onServe, onSaveItemPrice, onAdjustItemQuantity, onChangeItemCancellation, onRefreshCheckouts, onSaveCheckout, onReadyCheckout, onCancelCheckout, onPayCheckout }) {
  const demoMode = window.WARUN_ORDER_MODE === "demo" || new URLSearchParams(window.location.search).get("demo") === "1";
  const [callPanel, setCallPanel] = useState(false);
  const [callPanelTableId, setCallPanelTableId] = useState(null);
  const [resolvingCallId, setResolvingCallId] = useState(null);
  const [callResolutionError, setCallResolutionError] = useState("");
  const [priceTarget, setPriceTarget] = useState(null);
  const [priceDraft, setPriceDraft] = useState("");
  const [priceBusy, setPriceBusy] = useState(false);
  const [priceError, setPriceError] = useState("");
  const [quantityBusy, setQuantityBusy] = useState(false);
  const [quantityError, setQuantityError] = useState("");
  const [quantityZeroConfirm, setQuantityZeroConfirm] = useState(false);
  const [quantityReason, setQuantityReason] = useState("");
  const [cancellationTarget, setCancellationTarget] = useState(null);
  const [collapsedOrders, setCollapsedOrders] = useState({});
  const [servingItemKey, setServingItemKey] = useState("");
  const servingItemLockRef = useRef(false);
  const [servingErrors, setServingErrors] = useState({});
  const [historyState, setHistoryState] = useState({ loading: false, error: false, orders: [] });
  const [additionTarget, setAdditionTarget] = useState(null);
  const apiMode = Boolean(apiState);
  const sessions = apiMode ? apiState.sessions : demoMode ? [
    { sessionId: "demo-session-1", tableId: "1", openedAt: "2026-09-25T08:50:00.000Z" },
    { sessionId: "demo-session-2", tableId: "2", openedAt: "2026-09-25T08:40:00.000Z" },
  ] : [];
  const activeCheckouts = (checkoutState?.checkouts || []).filter((checkout) => checkout.status === "requested" || checkout.status === "ready");
  const activeCalls = (apiMode ? apiState.staffCalls ?? [] : state.staffCalls).filter((call) => call.status !== "resolved" && !call.resolvedAt);
  const activeCallGroups = Object.values(activeCalls.reduce((groups, call) => {
    const tableId = String(call.tableId);
    const group = groups[tableId] || { tableId, calls: [] };
    group.calls.push(call);
    groups[tableId] = group;
    return groups;
  }, {})).sort((a, b) => a.tableId.localeCompare(b.tableId, undefined, { numeric: true }));
  const kitchenAliases = Object.fromEntries(state.menuItems.map((item) => [item.id, item.kitchenAlias?.trim()]));

  const loadHistory = async () => {
    if (!apiMode) return;
    setHistoryState((current) => ({ ...current, loading: true, error: false }));
    try {
      const orders = await fetchKitchenOrderHistory({ env: window });
      setHistoryState({ loading: false, error: false, orders });
    } catch {
      setHistoryState((current) => ({ ...current, loading: false, error: true }));
    }
  };
  useEffect(() => {
    if (!apiMode) return undefined;
    void loadHistory();
    const timer = window.setInterval(loadHistory, 30_000);
    return () => window.clearInterval(timer);
  }, [apiMode]);

  const historyOrders = apiMode ? historyState.orders.map((order) => ({
    id: order.orderId,
    tableId: String(order.tableId),
    sessionId: order.sessionId || null,
    createdAt: new Date(order.acceptedAtMs).toISOString(),
    completedAt: order.completedAtMs ? new Date(order.completedAtMs).toISOString() : null,
    sessionClosedAtMs: order.sessionClosedAtMs ?? null,
    status: order.status,
    totalAmount: order.totalAmountYen,
    items: order.items.map((item) => ({
      id: String(item.orderItemId), menuItemId: item.menuItemId, nameSnapshot: item.formalNameSnapshot,
      kitchenAlias: item.kitchenAliasSnapshot, unitPriceYenSnapshot: item.unitPriceYenSnapshot,
      adjustedUnitPriceYen: item.adjustedUnitPriceYen ?? null,
      currentUnitPriceYen: item.currentUnitPriceYen ?? item.unitPriceYenSnapshot,
      currentBillableAmountYen: item.currentBillableAmountYen ?? item.lineTotalYen,
      quantity: item.quantity, quantityReduced: item.quantityReduced ?? 0,
      billableQuantity: item.billableQuantity ?? item.quantity,
      lineTotalYen: item.lineTotalYen, isServed: item.isServed, servedAt: item.servedAtMs ? new Date(item.servedAtMs).toISOString() : null,
      servedByDeviceId: item.servedByDeviceId ?? null,
      isCancelled: item.isCancelled === true,
      cancellationHistory: item.cancellationHistory ?? [],
      quantityHistory: item.quantityHistory ?? [],
    })),
  })) : state.orders.filter((order) => order.status === "completed" || order.status === "cancelled");
  const liveOrders = apiMode ? apiState.orders : state.orders.filter((order) => order.status === "new" || order.status === "active");
  const liveOrderIds = new Set(liveOrders.map((order) => String(order.id ?? order.orderId)));
  const boardOrders = [...liveOrders, ...historyOrders.filter((order) => !liveOrderIds.has(String(order.id ?? order.orderId)))].map((order) => demoMode && order.tableId === "1" ? { ...order, sessionId: "demo-session-1" } : demoMode && order.tableId === "2" ? { ...order, sessionId: "demo-session-2" } : order);
  const activeOrders = liveOrders.filter((order) => order.status === "new" || order.status === "active");
  const tables = buildKitchenTableGroups({ orders: boardOrders, sessions, menuItems: state.menuItems, drinkCategoryIds: CUSTOMER_DRINK_CATEGORY_IDS, checkouts: activeCheckouts, staffCalls: activeCalls });

  const submitKitchenAddition = async ({ tableId, sessionId, item }) => {
    const clientOrderId = createKitchenOperationId();
    if (apiMode) {
      await createKitchenOrder({ env: window, tableId, sessionId, clientOrderId, items: [kitchenAdditionRequestItem(item)] });
      const snapshot = await fetchKitchenSnapshot({ env: window });
      window.dispatchEvent(new CustomEvent("warun-kitchen-refresh"));
      return snapshot;
    }
    const now = new Date().toISOString();
    const localItem = { id: `${clientOrderId}-item`, menuItemId: item.menuItemId ?? null, nameSnapshot: item.name, kitchenAlias: item.name.slice(0, 40), unitPriceSnapshot: item.priceYen, unitPriceYenSnapshot: item.priceYen, currentUnitPriceYen: item.priceYen, quantity: item.quantity, billableQuantity: item.quantity, lineTotalYen: item.priceYen * item.quantity, isServed: false, isCancelled: false, servedAt: null };
    updateState((current) => ({ ...current, orders: [...current.orders, { id: clientOrderId, clientOrderId, tableId: String(tableId), sessionId, createdAt: now, status: "new", orderOrigin: "kitchen_addition", totalAmount: localItem.lineTotalYen, items: [localItem] }] }));
  };

  const toggleServed = async (orderId, itemId) => {
    if (servingItemLockRef.current) return;
    const itemKey = `${orderId}:${itemId}`;
    servingItemLockRef.current = true;
    setServingItemKey(itemKey);
    setServingErrors((current) => {
      const next = { ...current };
      delete next[itemKey];
      return next;
    });
    try {
      if (apiMode) {
        await onServe(orderId, itemId);
        await loadHistory();
      } else {
        updateState((current) => {
          const now = new Date().toISOString();
          const orders = current.orders.map((order) => {
            if (order.id !== orderId) return order;
            const items = order.items.map((item) => item.id === itemId ? { ...item, isServed: !item.isServed, servedAt: item.isServed ? null : now } : item);
            const billableItems = items.filter((item) => !item.isCancelled);
            const completed = billableItems.length > 0 && billableItems.every((item) => item.isServed);
            const anyServed = billableItems.some((item) => item.isServed);
            return { ...order, items, status: completed ? "completed" : anyServed ? "active" : "new", completedAt: completed ? now : null };
          });
          return { ...current, orders };
        });
      }
    } catch (error) {
      setServingErrors((current) => ({ ...current, [itemKey]: servingErrorMessage(error) }));
    } finally {
      servingItemLockRef.current = false;
      setServingItemKey("");
    }
  };

  const submitQuantityAdjustment = async (direction, confirmZero = false) => {
    const target = priceTarget;
    if (!target || target.locked) return;
    const currentQuantity = Number(target.billableQuantity ?? target.quantity ?? 0);
    if (!Number.isSafeInteger(currentQuantity) || currentQuantity < 1) return;
    if (direction === "decrease" && currentQuantity === 1 && !confirmZero) {
      setQuantityZeroConfirm(true);
      setQuantityReason("");
      setQuantityError("");
      return;
    }
    const operationId = createKitchenOperationId();
    setQuantityBusy(true);
    setQuantityError("");
    try {
      if (apiMode) {
        await onAdjustItemQuantity({
          orderId: target.orderId,
          orderItemId: target.id,
          direction,
          operationId,
          expectedBillableQuantity: currentQuantity,
          confirmZero,
          reason: confirmZero ? quantityReason.trim() || null : null,
        });
      } else {
        updateState((current) => {
          const occurredAtMs = Date.now();
          let addedOrder = null;
          const orders = current.orders.map((order) => {
            if (String(order.id ?? order.orderId) !== target.orderId) return order;
            const items = order.items.map((item) => {
              if (String(item.id ?? item.orderItemId) !== String(target.id)) return item;
              const quantity = Number(item.quantity ?? 0);
              const quantityReduced = Number(item.quantityReduced ?? 0);
              const billableQuantity = Number(item.billableQuantity ?? quantity - quantityReduced);
              const currentUnitPriceYen = Number(item.currentUnitPriceYen ?? item.adjustedUnitPriceYen ?? item.unitPriceYenSnapshot ?? item.unitPriceSnapshot ?? 0);
              if (direction === "increase") {
                const relatedOrderId = `demo-added-${operationId}`;
                const relatedOrderItemId = `demo-item-${operationId}`;
                addedOrder = {
                  id: relatedOrderId,
                  clientOrderId: operationId,
                  tableId: String(order.tableId),
                  sessionId: order.sessionId ?? null,
                  createdAt: new Date(occurredAtMs).toISOString(),
                  status: "new",
                  orderOrigin: "kitchen_addition",
                  totalAmount: currentUnitPriceYen,
                  items: [{
                    ...item,
                    id: relatedOrderItemId,
                    quantity: 1,
                    quantityReduced: 0,
                    billableQuantity: 1,
                    isServed: false,
                    isCancelled: false,
                    servedAt: null,
                    servedByDeviceId: null,
                    currentUnitPriceYen,
                    adjustedUnitPriceYen: null,
                    unitPriceYenSnapshot: currentUnitPriceYen,
                    lineTotalYenSnapshot: currentUnitPriceYen,
                    lineTotalYen: currentUnitPriceYen,
                    currentBillableAmountYen: currentUnitPriceYen,
                    cancellationHistory: [],
                    quantityHistory: [],
                  }],
                };
                return {
                  ...item,
                  quantityHistory: [...(item.quantityHistory ?? []), {
                    eventId: occurredAtMs,
                    operationId,
                    action: "added",
                    quantityDelta: 1,
                    previousBillableQuantity: billableQuantity,
                    nextBillableQuantity: billableQuantity,
                    relatedOrderId,
                    relatedOrderItemId,
                    actorLabel: "厨房スタッフ",
                    occurredAtMs,
                    isServedSnapshot: item.isServed === true,
                    servedAtMsSnapshot: item.servedAt ? new Date(item.servedAt).getTime() : null,
                    servedByDeviceIdSnapshot: item.servedByDeviceId ?? null,
                  }],
                };
              }
              if (billableQuantity === 1 && confirmZero) {
                return {
                  ...item,
                  isCancelled: true,
                  currentBillableAmountYen: 0,
                  cancellationHistory: [...(item.cancellationHistory ?? []), {
                    eventId: occurredAtMs,
                    action: "cancelled",
                    actorLabel: "厨房スタッフ",
                    occurredAtMs,
                    reason: quantityReason.trim() || null,
                    isServedSnapshot: item.isServed === true,
                    servedAtMsSnapshot: item.servedAt ? new Date(item.servedAt).getTime() : null,
                  }],
                };
              }
              const nextReduced = quantityReduced + 1;
              const nextBillable = quantity - nextReduced;
              return {
                ...item,
                quantityReduced: nextReduced,
                billableQuantity: nextBillable,
                lineTotalYen: currentUnitPriceYen * nextBillable,
                currentBillableAmountYen: currentUnitPriceYen * nextBillable,
                quantityHistory: [...(item.quantityHistory ?? []), {
                  eventId: occurredAtMs,
                  operationId,
                  action: "decreased",
                  quantityDelta: -1,
                  previousBillableQuantity: billableQuantity,
                  nextBillableQuantity: nextBillable,
                  relatedOrderId: null,
                  relatedOrderItemId: null,
                  actorLabel: "厨房スタッフ",
                  occurredAtMs,
                  isServedSnapshot: item.isServed === true,
                  servedAtMsSnapshot: item.servedAt ? new Date(item.servedAt).getTime() : null,
                  servedByDeviceIdSnapshot: item.servedByDeviceId ?? null,
                }],
              };
            });
            const billableItems = items.filter((item) => !item.isCancelled && Number(item.billableQuantity ?? item.quantity ?? 0) > 0);
            const totalAmount = billableItems.reduce((sum, item) => sum + Number(item.currentUnitPriceYen ?? item.adjustedUnitPriceYen ?? item.unitPriceYenSnapshot ?? item.unitPriceSnapshot ?? 0) * Number(item.billableQuantity ?? item.quantity ?? 0), 0);
            const status = !billableItems.length ? "cancelled" : billableItems.every((item) => item.isServed) ? "completed" : billableItems.some((item) => item.isServed) ? "active" : "new";
            return { ...order, items, status, totalAmount, totalAmountYen: totalAmount };
          });
          return { ...current, orders: addedOrder ? [...orders, addedOrder] : orders };
        });
      }
      setQuantityZeroConfirm(false);
      setQuantityReason("");
      setPriceTarget(null);
    } catch (error) {
      setQuantityError(error?.status === 409 ? "注文数量または会計状態が更新されています。最新状態を再読み込みしてください。" : error?.message || "数量を変更できませんでした。");
    } finally {
      setQuantityBusy(false);
    }
  };

  const saveItemPrice = async () => {
    const ceiling = Number(priceTarget?.unitPriceYenSnapshot ?? priceTarget?.unitPriceSnapshot ?? 0);
    const nextPrice = Number(priceDraft);
    if (!Number.isSafeInteger(nextPrice) || nextPrice < 0 || nextPrice > ceiling) {
      setPriceError(`0円以上、注文時単価の${yen(ceiling)}以下で入力してください。`);
      return;
    }
    setPriceBusy(true); setPriceError("");
    try {
      if (apiMode) await onSaveItemPrice(priceTarget.orderId ?? priceTarget.id, priceTarget.id, nextPrice);
      else updateState((current) => ({ ...current, orders: current.orders.map((order) => {
        const orderId = order.id ?? order.orderId;
        if (orderId !== priceTarget.orderId) return order;
        const items = order.items.map((item) => item.id !== priceTarget.id ? item : { ...item, adjustedUnitPriceYen: nextPrice, currentUnitPriceYen: nextPrice, lineTotalYen: nextPrice * Number(item.billableQuantity ?? item.quantity) });
        return { ...order, items, totalAmount: items.filter((item) => !item.isCancelled).reduce((sum, item) => sum + Number(item.currentUnitPriceYen ?? item.unitPriceYenSnapshot ?? item.unitPriceSnapshot ?? 0) * Number(item.billableQuantity ?? item.quantity), 0) };
      }) }));
      setPriceTarget(null);
    } catch (error) {
      setPriceError(error?.code === "PRICE_CEILING_EXCEEDED" ? "注文時単価を超える変更はできません。" : "単価を保存できませんでした。最新状態を再読み込みしてください。");
    } finally { setPriceBusy(false); }
  };

  const saveCancellation = async (reason) => {
    const target = cancellationTarget;
    if (!target) return;
    const cancelled = target.action === "cancel";
    if (apiMode) {
      await onChangeItemCancellation({ orderId: target.orderId, orderItemId: target.item.id, reason, action: target.action });
    } else {
      updateState((current) => ({ ...current, orders: current.orders.map((order) => {
        if (String(order.id ?? order.orderId) !== target.orderId) return order;
        const changedAtMs = Date.now();
        const items = order.items.map((item) => {
          if (String(item.id ?? item.orderItemId) !== String(target.item.id)) return item;
          return {
            ...item,
            isCancelled: cancelled,
            cancellationHistory: [...(item.cancellationHistory ?? []), {
              eventId: changedAtMs,
              action: cancelled ? "cancelled" : "restored",
              actorLabel: "厨房スタッフ",
              occurredAtMs: changedAtMs,
              reason: reason || null,
              isServedSnapshot: item.isServed === true,
              servedAtMsSnapshot: item.servedAt ? new Date(item.servedAt).getTime() : null,
            }],
          };
        });
        const billableItems = items.filter((item) => !item.isCancelled && Number(item.billableQuantity ?? item.quantity ?? 0) > 0);
        const status = !billableItems.length ? "cancelled" : billableItems.every((item) => item.isServed) ? "completed" : billableItems.some((item) => item.isServed) ? "active" : "new";
        const totalAmount = billableItems.reduce((sum, item) => sum + Number(item.currentUnitPriceYen ?? item.adjustedUnitPriceYen ?? item.unitPriceYenSnapshot ?? item.unitPriceSnapshot ?? 0) * Number(item.billableQuantity ?? item.quantity ?? 0), 0);
        return { ...order, items, status, totalAmount, totalAmountYen: totalAmount };
      }) }));
    }
    await loadHistory();
    setCancellationTarget(null);
  };

  const resolveCall = async (call) => {
    if (!apiMode) {
      updateState((current) => ({ ...current, staffCalls: current.staffCalls.map((entry) => entry.id === call.id ? { ...entry, resolvedAt: new Date().toISOString() } : entry) }));
      return;
    }
    if (resolvingCallId) return;
    setResolvingCallId(call.id);
    setCallResolutionError("");
    try {
      await resolveKitchenStaffCall({ env: window, staffCallId: call.id, expectedVersion: call.version });
    } catch {
      setCallResolutionError("呼出を対応済みにできませんでした。厨房の接続を確認してください。");
    } finally {
      setResolvingCallId(null);
    }
  };
  const openCallPanel = (tableId = null) => { setCallPanelTableId(tableId); setCallPanel(true); };
  const closeCallPanel = () => { setCallPanel(false); setCallPanelTableId(null); };
  const displayedCalls = callPanelTableId === null ? activeCalls : activeCalls.filter((call) => String(call.tableId) === callPanelTableId);
  return <StaffShell route="/kitchen" title="新着注文" subtitle="未提供の注文をテーブルごとに表示します。提供完了後も来店・注文履歴は保持されます。" state={state} newOrderCount={activeOrders.length} clock={<time className="kitchen-clock" aria-label={`現在時刻 ${formatTime(new Date())}`}>{formatTime(new Date())}</time>} status={<div className="staff-topbar__right"><div className="staff-call-rail"><button type="button" className="staff-call-button" aria-label="スタッフ呼出" title="スタッフ呼出" onClick={() => openCallPanel()}><Bell size={26} weight="fill" /><span className="kitchen-sidebar__call-label">スタッフ呼出</span> {activeCalls.length ? <b>{activeCalls.length}</b> : null}</button></div>{activeCallGroups.length ? <div className="staff-call-rail__list" aria-label="未対応のスタッフ呼び出し一覧">{activeCallGroups.map((group) => <button type="button" className="staff-call-rail__item" key={group.tableId} aria-label={`テーブル ${group.tableId} のスタッフ呼び出し ${group.calls.length}件を確認`} onClick={() => openCallPanel(group.tableId)}><span>T{group.tableId}</span></button>)}</div> : null}<ConnectionBadge online announceStatus /></div>}>
    <section className="kitchen-content">
      <KitchenOrderSound orders={activeOrders} staffCalls={activeCalls} checkoutRequests={activeCheckouts} suppressStaffCalls={apiState?.suppressStaffCalls} ready={demoMode || (apiMode && !apiState.loading && !apiState.error)} requestStartedAt={apiState?.notificationRequestStartedAt} demoMode={demoMode} />
      {apiMode && apiState.loading ? <div className="kitchen-empty"><p>注文を読み込み中です。</p></div> : null}
      {apiMode && apiState.error ? <div className="kitchen-empty" role="alert"><p>注文情報を取得できません。</p></div> : null}
      {!apiMode && !tables.length ? <div className="kitchen-empty"><CheckCircle size={54} weight="thin" /><h2>すべて提供済みです</h2><p>新しい注文が届くと、テーブルごとに表示されます。</p></div> : null}
      {tables.length ? <div className="table-scroll">
        {tables.map((table) => {
              const { tableId, orders, session, isCompletedSide, staffCalls: tableCalls } = table;
          const sessionId = session?.sessionId;
          const tableCheckouts = activeCheckouts.filter((checkout) => sessions.some((entry) => entry.sessionId === checkout.tableSessionId && String(entry.tableId) === tableId));
          const checkoutPending = tableCheckouts.some((checkout) => checkout.status === "requested");
          const cancellationLocked = Boolean(!checkoutState || checkoutState.loading || checkoutState.error || session?.closedAtMs || orders.some((order) => order.sessionClosedAtMs) || tableCheckouts.some((checkout) => checkout.status === "ready"));
          const servingLocked = Boolean(!checkoutState || checkoutState.loading || checkoutState.error || session?.closedAtMs || orders.some((order) => order.sessionClosedAtMs));
          const total = orders.reduce((sum, order) => sum + Number(order.totalAmount ?? order.totalAmountYen ?? 0), 0);
          const sessionForTable = sessions.find((session) => String(session.tableId) === String(tableId));
          return <article className={`table-panel ${isCompletedSide ? "is-completed-side" : ""}`} key={tableId}>
            <header><h2>テーブル <b>{tableId}</b>{tableCalls.length ? <button type="button" className="table-panel__call" aria-label={`テーブル ${tableId} のスタッフ呼び出し ${tableCalls.length}件を確認`} title={`スタッフ呼び出し ${tableCalls.length}件`} onClick={() => openCallPanel(tableId)}><Bell size={20} weight="fill" /><span>{tableCalls.length}</span></button> : null}</h2><div className="table-panel__header-actions"><span className="table-panel__state">{!orders.length && tableCalls.length ? "スタッフ呼出中" : checkoutPending ? "会計依頼中" : isCompletedSide ? "提供完了" : `${orders.length}件の注文`}</span>{sessionForTable ? <button type="button" className="button button--small kitchen-add-order-button" onClick={() => setAdditionTarget({ tableId: String(tableId), sessionId: sessionForTable.sessionId })}>メニュー追加</button> : null}</div></header>
            <div className="table-panel__receipt">
            {(apiMode || demoMode) && (tableCheckouts.length || checkoutState?.loading || checkoutState?.error) ? <KitchenCheckoutPanel checkouts={tableCheckouts} sessions={sessions} loading={checkoutState?.loading} error={checkoutState?.error} onRefresh={demoMode ? async () => {} : onRefreshCheckouts} onSave={demoMode ? async () => ({}) : onSaveCheckout} onReady={demoMode ? async () => ({}) : onReadyCheckout} onCancel={demoMode ? async () => ({}) : onCancelCheckout} onPay={demoMode ? async () => ({}) : onPayCheckout} tableId={tableId} /> : null}
            <div className="table-panel__orders">
              {!orders.length && tableCalls.length ? <p className="table-panel__call-empty">スタッフの呼び出しがあります。</p> : null}
              {orders.map((order) => {
              const orderId = String(order.id ?? order.orderId);
                const unserved = order.items.filter((item) => !item.isServed && !item.isCancelled && Number(item.billableQuantity ?? item.quantity ?? 0) > 0);
                const served = order.items.filter((item) => item.isServed && !item.isCancelled && Number(item.billableQuantity ?? item.quantity ?? 0) > 0);
                const cancelled = order.items.filter((item) => item.isCancelled);
                const canCollapse = !unserved.length && served.length > 0;
                const expanded = !collapsedOrders[order.id];
                const renderItem = (item) => <div className={`order-item-row ${item.isServed ? "is-served" : ""}`} key={item.id}>
                  <div className={`order-item ${item.isServed ? "is-served" : ""}`}>
                    <button type="button" className="order-item__name" aria-label={`${kitchenMenuName(item, kitchenAliases)}のキャンセル確認を開く`} onClick={() => setCancellationTarget({ action: "cancel", orderId, item, order })} disabled={cancellationLocked}>
                      <span><b>{kitchenMenuName(item, kitchenAliases)}</b><small>{Number(item.billableQuantity ?? item.quantity ?? 0)}点</small></span>
                    </button>
                    <button type="button" className={`order-item__serve${item.isServed ? " is-served" : ""}`} aria-label={item.isServed ? `${kitchenMenuName(item, kitchenAliases)}は提供済み` : `${kitchenMenuName(item, kitchenAliases)}を提供済みにする`} aria-pressed={item.isServed} aria-busy={servingItemKey === `${orderId}:${item.id}`} onClick={() => void toggleServed(orderId, item.id)} disabled={item.isServed || servingLocked || Boolean(servingItemKey)}>{servingItemKey === `${orderId}:${item.id}` ? <span aria-hidden="true">…</span> : item.isServed ? <Check size={20} weight="bold" aria-hidden="true" /> : null}</button>
                  </div>
                  {servingErrors[`${orderId}:${item.id}`] ? <p className="order-item-serve-error" role="alert">{servingErrors[`${orderId}:${item.id}`]}</p> : null}
                  <button type="button" className="order-item-price" aria-label={`${kitchenMenuName(item, kitchenAliases)}の単価と数量を編集`} onClick={() => { setPriceTarget({ ...item, id: item.id, orderId, locked: cancellationLocked }); setPriceDraft(String(item.currentUnitPriceYen ?? item.adjustedUnitPriceYen ?? item.unitPriceYenSnapshot ?? item.unitPriceSnapshot ?? 0)); setPriceError(""); setQuantityError(""); setQuantityZeroConfirm(false); }} disabled={cancellationLocked}>単価 {yen(item.currentUnitPriceYen ?? item.adjustedUnitPriceYen ?? item.unitPriceYenSnapshot ?? item.unitPriceSnapshot ?? 0)}</button>
                  {item.quantityHistory?.length ? <details className="order-item-quantity-history"><summary>数量操作 {item.quantityHistory.length}件</summary>{item.quantityHistory.map((event) => <p key={event.eventId}>{event.action === "added" ? "追加注文 +1点" : "数量 −1点"}・{event.actorLabel || event.actorDeviceId}・{formatDateTime(new Date(event.occurredAtMs))}・{event.isServedSnapshot ? "操作時：提供済み" : "操作時：未提供"}{event.relatedOrderId ? `・追加注文 ${event.relatedOrderId.slice(0, 8)}` : ""}</p>)}</details> : null}
                </div>;
                return <section className={`kitchen-order-card ${order.isDrinkOrder ? "is-drink-order" : ""}`} key={order.id} aria-label={`${order.isDrinkOrder ? "ドリンク注文" : "注文"} ${formatTime(order.createdAt)}`}>
                  <header>{canCollapse ? <button type="button" className="order-details-toggle" aria-expanded={expanded} onClick={() => setCollapsedOrders((current) => ({ ...current, [order.id]: !current[order.id] }))}><b>注文内容を{expanded ? "非表示" : "表示"}</b></button> : <b>{order.isDrinkOrder ? "ドリンク注文" : "注文"}</b>}<time>{formatTime(order.createdAt)}</time><small>{order.items.length}品</small></header>
                  {expanded ? <div className="kitchen-order-card__details">
                    {unserved.map(renderItem)}
                    {served.length ? <><div className="served-divider"><span>提供済み</span></div>{served.map(renderItem)}</> : null}
                    {cancelled.length ? <><div className="served-divider cancelled-divider"><span>キャンセル済み</span></div>{cancelled.map((item) => {
                      const cancellationEvent = item.cancellationHistory?.at(-1);
                      const cancelledQuantity = cancelledQuantityForDisplay(item);
                      const currentUnitPrice = Number(item.currentUnitPriceYen ?? item.adjustedUnitPriceYen ?? item.unitPriceYenSnapshot ?? item.unitPriceSnapshot ?? 0);
                      const excludedAmount = currentUnitPrice * cancelledQuantity;
                      return <div className="order-item-row order-item-row--cancelled" key={item.id}>
                        <div className="cancelled-order-item"><b>{kitchenMenuName(item, kitchenAliases)}</b><span>キャンセル済み{cancellationEvent?.operationId ? "（数量0点化）" : ""}・会計から除外 {cancelledQuantity}点／{yen(excludedAmount)}（現在請求 0円）</span>
                          {item.cancellationHistory?.length ? <details><summary>取消履歴 {item.cancellationHistory.length}件</summary>{item.cancellationHistory.map((event) => <p key={event.eventId}>{event.action === "cancelled" ? event.operationId ? "数量0点化によるキャンセル" : "商品キャンセル" : "キャンセル取消し"}・{event.actorLabel || event.actorDeviceId}・{formatDateTime(new Date(event.occurredAtMs))}{event.reason ? `・理由：${event.reason}` : ""}・提供状態：{event.isServedSnapshot ? "提供済み" : "未提供"}</p>)}</details> : null}
                        </div>
                        <button type="button" className="order-item-restore" onClick={() => setCancellationTarget({ action: "restore", orderId, item, order })} disabled={cancellationLocked}>キャンセルを取り消す</button>
                      </div>;
                    })}</> : null}
                  </div> : null}
                </section>;
              })}
              {!orders.length ? <div className="table-panel__completed-note">この来店に未提供の注文はありません。sessionは保持されています。</div> : null}
            </div>
            <footer><span>表示中の注文商品合計</span><b>{yen(total)}</b></footer>
            </div>
          </article>;
        })}
      </div> : null}
    </section>
    {priceTarget ? <Modal title="注文単価・数量の変更" onClose={() => { if (!priceBusy && !quantityBusy) { setPriceTarget(null); setQuantityZeroConfirm(false); } }}>
      <p className="modal-lead">{kitchenMenuName(priceTarget, kitchenAliases)}<br />注文時数量 {priceTarget.quantity}点・請求対象 {Number(priceTarget.billableQuantity ?? priceTarget.quantity)}点<br />注文時単価（変更上限）：{yen(priceTarget.unitPriceYenSnapshot ?? priceTarget.unitPriceSnapshot ?? 0)}／現在の単価：{yen(priceTarget.currentUnitPriceYen ?? priceTarget.adjustedUnitPriceYen ?? priceTarget.unitPriceYenSnapshot ?? priceTarget.unitPriceSnapshot ?? 0)}</p>
      <div className="kitchen-quantity-editor" aria-label="注文数量の編集">
        <span>請求対象数量</span>
        <button type="button" onClick={() => void submitQuantityAdjustment("decrease")} disabled={quantityBusy || priceTarget.locked} aria-label="数量を1点減らす"><Minus size={20} weight="bold" /></button>
        <b aria-live="polite">{Number(priceTarget.billableQuantity ?? priceTarget.quantity)}点</b>
        <button type="button" onClick={() => void submitQuantityAdjustment("increase")} disabled={quantityBusy || priceTarget.locked} aria-label="同じ商品を1点追加注文"><Plus size={20} weight="bold" /></button>
      </div>
      {quantityZeroConfirm ? <div className="quantity-zero-confirm" role="alert"><b>最後の1点を請求対象から外しますか？</b><p>確認後、この注文行は削除されずキャンセル扱いで履歴に残ります。取消し復元で1点に戻せます。</p><label><span>理由（任意）</span><textarea value={quantityReason} onChange={(event) => setQuantityReason(event.target.value)} maxLength={300} disabled={quantityBusy} /></label><div className="modal-actions"><button type="button" className="button button--quiet" onClick={() => setQuantityZeroConfirm(false)} disabled={quantityBusy}>戻る</button><button type="button" className="button button--primary" onClick={() => void submitQuantityAdjustment("decrease", true)} disabled={quantityBusy || priceTarget.locked}>{quantityBusy ? "保存中…" : "0点にしてキャンセル"}</button></div></div> : null}
      <label className="price-adjustment-field">変更後の単価<input aria-label="変更後の単価" type="number" min="0" max={priceTarget.unitPriceYenSnapshot ?? priceTarget.unitPriceSnapshot} step="1" value={priceDraft} onChange={(event) => setPriceDraft(event.target.value)} disabled={priceBusy || quantityBusy || priceTarget.locked} />円</label>
      <p className="price-adjustment-total">変更後の行合計：<b>{yen((Number(priceDraft) || 0) * Number(priceTarget.billableQuantity ?? priceTarget.quantity))}</b></p>
      {quantityError ? <p role="alert" className="checkout-feedback checkout-feedback--error">{quantityError}</p> : null}{priceError ? <p role="alert" className="checkout-feedback checkout-feedback--error">{priceError}</p> : null}
      <div className="modal-actions"><button type="button" className="button button--quiet" onClick={() => { setPriceTarget(null); setQuantityZeroConfirm(false); }} disabled={priceBusy || quantityBusy}>閉じる</button><button type="button" className="button button--primary button--large" onClick={() => void saveItemPrice()} disabled={priceBusy || quantityBusy || priceTarget.locked}>{priceBusy ? "保存中…" : "単価を保存"}</button></div>
    </Modal> : null}
    {cancellationTarget ? <OrderItemCancellationModal key={`${cancellationTarget.action}-${cancellationTarget.orderId}-${cancellationTarget.item.id}`} target={cancellationTarget} onClose={() => setCancellationTarget(null)} onSave={saveCancellation} /> : null}
    {additionTarget ? <KitchenAdditionModal target={additionTarget} menuItems={state.menuItems} busy={false} onClose={() => setAdditionTarget(null)} onSubmit={(item) => submitKitchenAddition({ ...additionTarget, item }).then(() => setAdditionTarget(null))} /> : null}
    {callPanel ? <Modal title={callPanelTableId === null ? "スタッフ呼び出し" : `テーブル ${callPanelTableId} のスタッフ呼び出し`} onClose={closeCallPanel} wide><div className="call-list">{callResolutionError ? <p className="checkout-feedback checkout-feedback--error" role="alert">{callResolutionError}</p> : null}{displayedCalls.length ? displayedCalls.map((call) => <article key={call.id}><Bell size={28} weight="fill" /><div><b>テーブル {call.tableId}</b><span>{formatTime(call.createdAt)} に呼び出し</span></div><button type="button" className="button button--primary" disabled={Boolean(resolvingCallId)} onClick={() => void resolveCall(call)}>{resolvingCallId === call.id ? "保存中" : "対応完了"}</button></article>) : <div className="empty-state"><Bell size={42} /><p>未対応の呼び出しはありません。</p></div>}</div></Modal> : null}
  </StaffShell>;
}

function KitchenAdditionModal({ target, menuItems, busy, onClose, onSubmit }) {
  const [kind, setKind] = useState("menu");
  const [menuSection, setMenuSection] = useState("food");
  const availableMenuItems = menuItems.filter((item) => !item.isSoldOut && item.isActive !== false);
  const menuItemsForSection = availableMenuItems.filter((item) => menuSection === "drink" ? KITCHEN_DRINK_CATEGORY_IDS.has(item.categoryId) : !KITCHEN_DRINK_CATEGORY_IDS.has(item.categoryId));
  const [menuItemId, setMenuItemId] = useState(menuItemsForSection[0]?.id ?? availableMenuItems[0]?.id ?? "");
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [error, setError] = useState("");
  const selectedMenuItem = availableMenuItems.find((item) => item.id === menuItemId) ?? null;
  const quantityValue = Number(quantity) || 1;
  const adjustQuantity = (delta) => setQuantity(String(Math.min(99, Math.max(1, quantityValue + delta))));
  const selectMenuSection = (section) => {
    setMenuSection(section);
    const firstItem = availableMenuItems.find((item) => section === "drink" ? KITCHEN_DRINK_CATEGORY_IDS.has(item.categoryId) : !KITCHEN_DRINK_CATEGORY_IDS.has(item.categoryId));
    setMenuItemId(firstItem?.id ?? "");
  };
  const submit = async (event) => {
    event.preventDefault();
    const count = Number(quantity);
    if (!Number.isInteger(count) || count < 1 || count > 99) { setError("数量は1〜99点で入力してください。"); return; }
    const selected = kind === "menu" ? menuItems.find((item) => item.id === menuItemId) : null;
    if (kind === "menu" && (!selected || selected.isSoldOut || selected.isActive === false)) { setError("販売中の商品を選択してください。"); return; }
    if (kind !== "menu" && (!name.trim() || !Number.isSafeInteger(Number(price)) || Number(price) < 0)) { setError("商品名と0円以上の金額を入力してください。"); return; }
    setError("");
    await onSubmit(kind === "menu"
      ? { menuItemId: selected.id, name: selected.name, priceYen: Number(selected.price), quantity: count }
      : { name: name.trim(), priceYen: Number(price), quantity: count });
  };
  return <Modal title={`テーブル ${target.tableId} にメニュー追加`} onClose={onClose} className="kitchen-add-order-modal" footer={<div className="kitchen-add-order-actions"><button type="button" className="button button--quiet" onClick={onClose} disabled={busy}>閉じる</button><button type="submit" form="kitchen-add-order-form" className="button button--primary button--large" disabled={busy}>追加注文を保存</button></div>}>
    <form id="kitchen-add-order-form" className="kitchen-add-order-form" onSubmit={submit}>
      <div className="kitchen-add-order-scroll">
        <div className="kitchen-add-order-tabs"><button type="button" className={kind === "menu" ? "is-active" : ""} onClick={() => setKind("menu")}>既存メニュー</button><button type="button" className={kind === "food" ? "is-active" : ""} onClick={() => setKind("food")}>その他フード</button><button type="button" className={kind === "drink" ? "is-active" : ""} onClick={() => setKind("drink")}>その他ドリンク</button></div>
        {kind === "menu" ? <>
          <div className="kitchen-add-order-menu-sections" role="tablist" aria-label="メニュー区分">
            <button type="button" role="tab" aria-selected={menuSection === "food"} className={menuSection === "food" ? "is-active" : ""} onClick={() => selectMenuSection("food")}>フード</button>
            <button type="button" role="tab" aria-selected={menuSection === "drink"} className={menuSection === "drink" ? "is-active" : ""} onClick={() => selectMenuSection("drink")}>ドリンク</button>
          </div>
          <div className="kitchen-add-order-menu-grid" role="tabpanel" aria-label={`${menuSection === "food" ? "フード" : "ドリンク"}の商品一覧`}>
            {menuItemsForSection.length ? menuItemsForSection.map((item) => <button key={item.id} type="button" className={item.id === menuItemId ? "is-selected" : ""} aria-pressed={item.id === menuItemId} onClick={() => { setMenuItemId(item.id); setError(""); }}><span>{kitchenAdditionMenuName(item)}</span></button>) : <p className="kitchen-add-order-empty">販売中の商品がありません。</p>}
          </div>
          {selectedMenuItem ? <div className="kitchen-add-order-selection"><span>選択中</span><b>{kitchenAdditionMenuName(selectedMenuItem)}</b><small>単価 {yen(selectedMenuItem.price)}</small></div> : null}
        </> : <div className="kitchen-add-order-custom-fields"><label>商品名<input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} autoFocus /></label><label>金額<input type="number" min="0" max="10000000" step="1" value={price} onChange={(event) => setPrice(event.target.value)} />円</label></div>}
        <div className="kitchen-add-order-quantity"><span>数量</span><div className="kitchen-add-order-quantity-control"><button type="button" aria-label="数量を1減らす" onClick={() => adjustQuantity(-1)} disabled={busy || quantityValue <= 1}>−</button><output aria-label="数量">{quantityValue}点</output><button type="button" aria-label="数量を1増やす" onClick={() => adjustQuantity(1)} disabled={busy || quantityValue >= 99}>＋</button></div></div>
        {error ? <p className="checkout-feedback checkout-feedback--error" role="alert">{error}</p> : null}
        <p className="modal-lead">この追加注文は現在のsessionに未提供品として登録されます。</p>
      </div>
    </form>
  </Modal>;
}

function cancelledQuantityForDisplay(item) {
  const latestCancellation = item?.cancellationHistory?.at(-1);
  return item?.isCancelled === true && latestCancellation?.action === "cancelled" && latestCancellation.operationId
    ? 0
    : Number(item?.billableQuantity ?? item?.quantity ?? 0);
}

function paymentMethodLabel(method) {
  return { cash: "現金", card: "クレジットカード", qr: "QR決済", other: "その他" }[method] || method;
}

function OrderItemCancellationModal({ target, onClose, onSave }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const restoring = target.action === "restore";
  const cancellationProductName = kitchenMenuName(target.item, {});
  const cancellationQuantity = Number(target.item.billableQuantity ?? target.item.quantity ?? 0);
  const cancellationUnitPrice = Number(target.item.currentUnitPriceYen ?? target.item.adjustedUnitPriceYen ?? target.item.unitPriceYenSnapshot ?? target.item.unitPriceSnapshot ?? 0);
  const cancellationAmount = cancellationUnitPrice * cancellationQuantity;
  const cancelButtonLabel = `${cancellationProductName} ${cancellationQuantity}点をキャンセル`;
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      await onSave(reason.trim() || null);
    } catch (saveError) {
      setError(saveError?.message || (restoring ? "キャンセルを取り消せませんでした。" : "注文商品をキャンセルできませんでした。"));
    } finally {
      setBusy(false);
    }
  };
  return <Modal title={restoring ? "キャンセルを取り消しますか？" : "注文商品をキャンセルしますか？"} onClose={() => { if (!busy) onClose(); }}>
    <p className="modal-lead">{restoring ? `${cancellationProductName} のキャンセルを取り消します。提供状態は現在のまま維持します。` : `${cancellationProductName} ${cancellationQuantity}点をキャンセルし、今回の会計から外します。注文の記録は残ります。提供済みの場合、提供した記録も残ります。`}</p>
    {!restoring ? <p className="cancellation-amount-preview">今回の会計から外す金額：{yen(cancellationUnitPrice)} × {cancellationQuantity}点 = <b>{yen(cancellationAmount)}</b></p> : null}
    <label className="payment-void-form"><span>理由（任意）</span><textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={300} placeholder="必要な場合だけ入力してください" disabled={busy} /></label>
    {error ? <p className="checkout-feedback checkout-feedback--error" role="alert">{error}</p> : null}
    <div className="modal-actions"><button type="button" className="button button--quiet" onClick={onClose} disabled={busy}>戻る</button><button type="button" className="button button--primary" onClick={() => void submit()} disabled={busy}>{busy ? "処理中…" : restoring ? "キャンセルを取り消す" : cancelButtonLabel}</button></div>
  </Modal>;
}

function HistoryScreen({ state, apiMode = false, loadHistory = null, loadPaymentHistory = null, loadCheckoutRequests = null, onVoidPayment = null, onChangeItemCancellation = null }) {
  const [remoteState, setRemoteState] = useState({ loading: apiMode, error: false, orders: [] });
  const [paymentRemoteState, setPaymentRemoteState] = useState({ loading: apiMode, error: false, payments: [] });
  const [checkoutRemoteState, setCheckoutRemoteState] = useState({ loading: apiMode, error: false, checkouts: [] });
  const [showPastOrders, setShowPastOrders] = useState(false);
  const [voidTarget, setVoidTarget] = useState(null);
  const [voidReason, setVoidReason] = useState("");
  const [voidError, setVoidError] = useState("");
  const [cancellationTarget, setCancellationTarget] = useState(null);
  useEffect(() => {
    if (!apiMode) return undefined;
    if (typeof loadHistory !== "function") {
      setRemoteState({ loading: false, error: true, orders: [] });
      return undefined;
    }
    let cancelled = false;
    setRemoteState({ loading: true, error: false, orders: [] });
    setPaymentRemoteState({ loading: true, error: false, payments: [] });
    void Promise.all([loadHistory({ env: window }), typeof loadPaymentHistory === "function" ? loadPaymentHistory({ env: window }) : Promise.reject(new Error("payment history unavailable"))]).then(([orders, payments]) => {
      if (!cancelled) { setRemoteState({ loading: false, error: false, orders }); setPaymentRemoteState({ loading: false, error: false, payments }); }
    }).catch(() => {
      if (!cancelled) { setRemoteState({ loading: false, error: true, orders: [] }); setPaymentRemoteState({ loading: false, error: true, payments: [] }); }
    });
    return () => { cancelled = true; };
  }, [apiMode, loadHistory, loadPaymentHistory]);
  useEffect(() => {
    if (!apiMode) return undefined;
    let cancelled = false;
    setCheckoutRemoteState({ loading: true, error: false, checkouts: [] });
    if (typeof loadCheckoutRequests !== "function") {
      setCheckoutRemoteState({ loading: false, error: true, checkouts: [] });
      return undefined;
    }
    void loadCheckoutRequests({ env: window }).then((checkouts) => {
      if (!cancelled) setCheckoutRemoteState({ loading: false, error: false, checkouts });
    }).catch(() => {
      if (!cancelled) setCheckoutRemoteState({ loading: false, error: true, checkouts: [] });
    });
    return () => { cancelled = true; };
  }, [apiMode, loadCheckoutRequests]);
  const sourceOrders = apiMode ? remoteState.orders.map((order) => ({
    id: order.orderId,
    tableId: String(order.tableId),
    createdAt: new Date(order.acceptedAtMs).toISOString(),
    completedAt: order.completedAtMs ? new Date(order.completedAtMs).toISOString() : null,
    status: order.status,
    totalAmount: order.totalAmountYen,
    sessionId: order.sessionId || null,
    sessionOpenedAtMs: order.sessionOpenedAtMs || null,
    sessionClosedAtMs: order.sessionClosedAtMs || null,
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
      quantityReduced: item.quantityReduced ?? 0,
      billableQuantity: item.billableQuantity ?? item.quantity,
      isServed: item.isServed === true,
      servedAtMs: item.servedAtMs ?? null,
      servedByDeviceId: item.servedByDeviceId ?? null,
      lineTotalYenSnapshot: item.lineTotalYenSnapshot ?? item.unitPriceYenSnapshot * item.quantity,
      lineTotalYen: item.lineTotalYen,
      currentUnitPriceYen: item.currentUnitPriceYen ?? item.unitPriceYenSnapshot,
      currentBillableAmountYen: item.currentBillableAmountYen ?? item.lineTotalYen,
      isCancelled: item.isCancelled === true,
      cancellationHistory: item.cancellationHistory ?? [],
      quantityHistory: item.quantityHistory ?? [],
    })),
  })) : state.orders;
  const historyOrders = sourceOrders.filter((order) => order.status === "completed" || order.status === "cancelled").sort((a, b) => new Date(b.completedAt ?? b.createdAt) - new Date(a.completedAt ?? a.createdAt));
  const completed = historyOrders.filter((order) => order.status === "completed");
  const completedToday = completed.filter((order) => isSameLocalDate(order.completedAt ?? order.createdAt));
  const visibleToday = historyOrders.filter((order) => isSameLocalDate(order.completedAt ?? order.createdAt));
  const pastHistoryCount = historyOrders.length - visibleToday.length;
  const visibleOrders = showPastOrders ? historyOrders : visibleToday;
  const todayTotal = completedToday.reduce((sum, order) => sum + order.totalAmount, 0);
  const sessionGroups = [...visibleOrders.reduce((groups, order) => {
    const sessionId = order.sessionId || `order-${order.id}`;
    const existing = groups.get(sessionId) || {
      sessionId,
      tableId: order.tableId,
      openedAtMs: order.sessionOpenedAtMs || new Date(order.createdAt).getTime(),
      closedAtMs: order.sessionClosedAtMs || null,
      orders: [],
    };
    existing.orders.push(order);
    if (!existing.openedAtMs && order.sessionOpenedAtMs) existing.openedAtMs = order.sessionOpenedAtMs;
    if (!existing.closedAtMs && order.sessionClosedAtMs) existing.closedAtMs = order.sessionClosedAtMs;
    groups.set(sessionId, existing);
    return groups;
  }, new Map()).values()].map((group) => {
    const payment = paymentRemoteState.payments.find((record) => record.tableSessionId === group.sessionId && record.status === "paid");
    return { ...group, paymentStatus: payment ? "会計済み" : group.closedAtMs ? "終了・会計記録なし" : "会計前" };
  });
  const readySessionIds = new Set(checkoutRemoteState.checkouts.filter((checkout) => checkout.status === "ready").map((checkout) => checkout.tableSessionId));
  const paidSessionIds = new Set(paymentRemoteState.payments.filter((payment) => payment.status === "paid").map((payment) => payment.tableSessionId));
  const historyOperationsUnavailable = apiMode && (remoteState.loading || remoteState.error || paymentRemoteState.loading || paymentRemoteState.error || checkoutRemoteState.loading || checkoutRemoteState.error);
  const historyOperationLocked = (order) => historyOperationsUnavailable
    || order.sessionClosedAtMs != null
    || readySessionIds.has(order.sessionId)
    || paidSessionIds.has(order.sessionId);
  const saveHistoryCancellation = async (reason) => {
    if (!cancellationTarget || typeof onChangeItemCancellation !== "function") return;
    await onChangeItemCancellation({ orderId: cancellationTarget.order.id, orderItemId: cancellationTarget.item.id, reason, action: cancellationTarget.action });
    const orders = await loadHistory({ env: window });
    setRemoteState({ loading: false, error: false, orders });
    setCancellationTarget(null);
  };
  return (
    <StaffShell route="/history" title="注文・会計履歴" subtitle="提供済みの注文内容と、会計記録を確認できます。" state={state}>
      <section className="history-content">
        <div className="history-summary"><div><small>本日の提供済み注文</small><b>{completedToday.length}</b><span>件</span></div><div><small>本日の注文商品合計</small><b>{yen(todayTotal)}</b></div></div>
        {apiMode && remoteState.loading ? <div className="empty-state"><p>注文履歴を読み込み中です。</p></div> : null}
        {apiMode && remoteState.error ? <div className="empty-state"><p>注文履歴を取得できませんでした。</p></div> : null}
        {(!apiMode || (!remoteState.loading && !remoteState.error)) && historyOrders.length === 0 ? <div className="empty-state"><p>注文履歴はありません。</p></div> : null}
        {(!apiMode || (!remoteState.loading && !remoteState.error)) && historyOrders.length > 0 && visibleToday.length === 0 && !showPastOrders ? <div className="history-past-notice"><p>本日完了・キャンセルになった注文はありません。</p><p>過去の注文を確認する場合は、下のボタンを押してください。</p></div> : null}
        {(!apiMode || (!remoteState.loading && !remoteState.error)) && pastHistoryCount > 0 ? <div className="history-past-actions"><button type="button" className="button button--outline" onClick={() => setShowPastOrders((current) => !current)}>{showPastOrders ? "本日の注文だけ表示" : "過去の注文も表示"}</button>{showPastOrders ? <span>過去の注文を含めて表示中です。</span> : null}</div> : null}
        {(!apiMode || (!remoteState.loading && !remoteState.error)) && sessionGroups.length > 0 && <div className="history-table-wrap">
          {sessionGroups.map((group) => <section className="history-session" key={group.sessionId}>
            <header className="history-session-divider"><div><b>テーブル {group.tableId}</b><span>来店日時 {formatDateTime(new Date(group.openedAtMs))}</span></div><strong>{group.paymentStatus}</strong></header>
            <table className="history-table">
              <thead><tr><th>注文番号・状態</th><th>テーブル</th><th>受付</th><th>完了</th><th>品目・操作履歴</th><th>現在の注文合計</th></tr></thead>
              <tbody>{group.orders.map((order) => <tr key={order.id}>
                <td><b>{order.id}</b><span className={`order-history-status ${order.status === "cancelled" ? "is-cancelled" : ""}`}>{order.status === "cancelled" ? "全品キャンセル" : "提供完了"}</span></td>
                <td><span className="table-pill">T{order.tableId}</span></td>
                <td>{formatDateTime(order.createdAt)}</td>
                <td>{order.completedAt ? formatDateTime(order.completedAt) : "—"}</td>
                <td><div className="history-items">{order.items.map((item) => {
                  const latestCancellation = item.cancellationHistory.at(-1);
                  const cancelledQuantity = cancelledQuantityForDisplay(item);
                  const currentUnitPrice = Number(item.currentUnitPriceYen ?? item.unitPriceSnapshot ?? 0);
                  const billableQuantity = Number(item.billableQuantity ?? item.quantity);
                  return <span className={`history-order-item ${item.isCancelled ? "is-cancelled" : ""}`} key={item.id}>
                    <span>{selectionDisplayName({ nameSnapshot: item.nameSnapshot }, item)} <b>{item.isCancelled ? `注文時 ${item.quantity}点` : `${billableQuantity}点請求対象`}</b></span>
                    <small>注文時 {yen(item.lineTotalYenSnapshot ?? item.unitPriceSnapshot * item.quantity)}{item.isCancelled ? `・キャンセル対象 ${cancelledQuantity}点／${yen(currentUnitPrice * cancelledQuantity)}` : ""}・現在請求 {yen(item.currentBillableAmountYen ?? item.lineTotalYen ?? item.unitPriceSnapshot * item.quantity)}</small>
                    {(item.quantityHistory ?? []).map((event) => <small className="cancellation-audit-entry" key={event.eventId}>{event.action === "added" ? "追加注文 +1点" : "数量 −1点"}・{event.actorLabel || event.actorDeviceId}・{formatDateTime(new Date(event.occurredAtMs))}・操作時{event.isServedSnapshot ? "提供済み" : "未提供"}</small>)}
                    {(item.cancellationHistory ?? []).map((event) => <small className="cancellation-audit-entry" key={event.eventId}>{event.action === "cancelled" ? event.operationId ? "数量0点化によるキャンセル" : "商品キャンセル" : "キャンセル取消し"}・{event.actorLabel || event.actorDeviceId}・{formatDateTime(new Date(event.occurredAtMs))}{event.reason ? `・${event.reason}` : ""}・当時{event.isServedSnapshot ? "提供済み" : "未提供"}</small>)}
                    {apiMode && onChangeItemCancellation ? <button type="button" className={item.isCancelled ? "order-item-restore" : "order-item-cancel"} onClick={() => setCancellationTarget({ action: item.isCancelled ? "restore" : "cancel", order, item })} disabled={historyOperationLocked(order)}>{item.isCancelled ? "キャンセルを取り消す" : "商品をキャンセル"}</button> : null}
                  </span>;
                })}</div></td>
                <td className="history-total">{yen(order.totalAmount)}</td>
              </tr>)}</tbody>
            </table>
          </section>)}
        </div>}
        <section className="payment-history" aria-labelledby="payment-history-title">
          <div className="payment-history__heading"><div><span className="section-kicker">PAYMENT HISTORY</span><h2 id="payment-history-title">会計履歴</h2><p>支払確認後に保存した記録です。席リセットだけの操作は含みません。</p></div></div>
          {apiMode && paymentRemoteState.loading ? <div className="empty-state"><p>会計履歴を読み込み中です。</p></div> : null}
          {apiMode && paymentRemoteState.error ? <div className="empty-state"><p>会計履歴を取得できませんでした。</p></div> : null}
          {!apiMode || (!paymentRemoteState.loading && !paymentRemoteState.error) ? paymentRemoteState.payments.length ? <div className="payment-history-list">{paymentRemoteState.payments.map((payment) => <article className={`payment-history-card payment-history-card--${payment.status}`} key={payment.paymentRecordId}><header><div><b>テーブル {payment.tableId}</b><span>{formatDateTime(new Date(payment.paidAtMs))}・{paymentMethodLabel(payment.paymentMethod)}</span></div><strong>{yen(payment.confirmedTotalYen)}</strong></header><p className="payment-history-card__meta">会計記録 {payment.paymentRecordId}・session {payment.tableSessionId}</p><details><summary>注文商品・追加料金の内訳</summary><div className="payment-history-card__details"><h4>注文商品</h4>{payment.orderItems.map((item) => <div key={`${payment.paymentRecordId}-${item.orderItemId}`}><span>{item.formalNameSnapshot}{item.variantNameSnapshot ? ` ${item.variantNameSnapshot}` : ""} × {item.quantity}</span><b>{yen(item.lineTotalYen)}</b></div>)}{payment.adjustments.length ? <><h4>追加料金</h4>{payment.adjustments.map((item) => <div key={`${payment.paymentRecordId}-${item.sortOrder}`}><span>{item.label}</span><b>{yen(item.amountYen)}</b></div>)}</> : null}</div></details>{payment.status === "voided" ? <p className="payment-history-card__void">取消済み：{payment.voidReason}</p> : onVoidPayment ? <button type="button" className="button button--quiet" onClick={() => { setVoidError(""); setVoidReason(""); setVoidTarget(payment); }}>誤記録として取消</button> : null}</article>)}</div> : <div className="empty-state"><p>会計履歴はありません。</p></div> : null}
        </section>
      </section>
      {cancellationTarget ? <OrderItemCancellationModal key={`${cancellationTarget.action}-${cancellationTarget.order.id}-${cancellationTarget.item.id}`} target={cancellationTarget} onClose={() => setCancellationTarget(null)} onSave={saveHistoryCancellation} /> : null}
      {voidTarget ? <Modal title="会計記録を取消" onClose={() => setVoidTarget(null)}><p className="modal-lead">この記録は物理削除せず、取消理由を残して無効化します。</p><label className="payment-void-form"><span>取消理由</span><textarea value={voidReason} onChange={(event) => setVoidReason(event.target.value)} maxLength={300} placeholder="例：支払方法の選択誤り" /></label>{voidError ? <p className="checkout-feedback checkout-feedback--error" role="alert">{voidError}</p> : null}<div className="modal-actions"><button type="button" className="button button--quiet" onClick={() => setVoidTarget(null)}>戻る</button><button type="button" className="button button--primary" onClick={async () => { try { const updated = await onVoidPayment(voidTarget, voidReason); setPaymentRemoteState((current) => ({ ...current, payments: current.payments.map((item) => item.paymentRecordId === updated.paymentRecordId ? updated : item) })); setVoidTarget(null); } catch (error) { setVoidError(error.message || "取消できませんでした。"); } }} disabled={!voidReason.trim()}>取消を保存</button></div></Modal> : null}
    </StaffShell>
  );
}

const adminTabs = [
  { id: "menu", label: "メニュー", icon: ClipboardText },
  { id: "menu-access", label: "来店許可", icon: CheckCircle },
  { id: "categories", label: "カテゴリ", icon: ListBullets },
  { id: "customer-theme", label: "客席レール", icon: PaintBrush },
  { id: "customer-order-notice", label: "注文前注意事項", icon: ClipboardText },
  { id: "hours", label: "営業時間", icon: ClockCounterClockwise },
  { id: "ride-guidance", label: "タクシー／代行料金", icon: Car },
  { id: "devices", label: "端末割り当て", icon: Monitor },
];

function customerThemeErrorMessage(error, action = "操作") {
  if (error?.status === 409 || error?.code === "CUSTOMER_THEME_CONFLICT") return "409：別の管理端末で更新されています。再読込してから保存してください。";
  if (error?.status === 401 || error?.code === "AUTH_TOKEN_MISMATCH") return "401：管理者tokenを確認してください。";
  if (error?.status === 400) return "400：テーマの選択内容を確認してください。";
  if (error?.status === 503 || error?.code === "API_UNAVAILABLE") return `${action}できません。管理APIを確認してください。`;
  return `${action}できませんでした。`;
}

const DEFAULT_CUSTOMER_THEME_VARIANTS = Object.freeze(Object.fromEntries(Object.entries(CUSTOMER_THEME_DEFINITIONS).map(([theme, definition]) => [theme, Object.freeze({
  prompt: definition.prompt,
  notes: definition.notes,
  positionX: definition.initialPositionX ?? 0.5,
  positionY: 0.5,
  zoom: 1,
})])));

function cloneCustomerThemeVariants(source = DEFAULT_CUSTOMER_THEME_VARIANTS, definitions = CUSTOMER_THEME_DEFINITIONS) {
  return Object.fromEntries(Object.entries(definitions).map(([theme, definition]) => {
    const fallback = DEFAULT_CUSTOMER_THEME_VARIANTS[theme] ?? { prompt: definition.prompt ?? "", notes: definition.notes ?? "", positionX: definition.initialPositionX ?? 0.5, positionY: 0.5, zoom: 1 };
    const variant = { ...fallback, ...(source?.[theme] ?? {}) };
    return [theme, { ...variant, ...normalizeCustomerThemeLayout(variant) }];
  }));
}

const CUSTOMER_THEME_PREVIEW_SCALE = 0.62;
const configuredImageSourceFolder = String(import.meta.env.VITE_CUSTOMER_THEME_IMAGE_SOURCE_FOLDER ?? "").trim();
const CUSTOMER_THEME_IMAGE_SOURCE_FOLDER = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(configuredImageSourceFolder) ? configuredImageSourceFolder : "";
const normalizedImageSourceFolder = CUSTOMER_THEME_IMAGE_SOURCE_FOLDER.replaceAll("\\", "/");
const CUSTOMER_THEME_IMAGE_SOURCE_FOLDER_URL = CUSTOMER_THEME_IMAGE_SOURCE_FOLDER
  ? encodeURI(`${normalizedImageSourceFolder.startsWith("//") ? "file:" : normalizedImageSourceFolder.startsWith("/") ? "file://" : "file:///"}${normalizedImageSourceFolder.replace(/\/$/, "")}/`).replaceAll("#", "%23").replaceAll("?", "%3F")
  : "";

function CustomerThemeImage({ theme, variant, alt, onError, onMetrics, imageSize }) {
  const viewportRef = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const definition = CUSTOMER_THEME_DEFINITIONS[theme];
  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return undefined;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    if (typeof ResizeObserver !== "function") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const normalized = normalizeCustomerThemeLayout(variant);
  const layout = useMemo(() => customerThemeImageLayout(imageSize ?? definition?.image, normalized, size.width, size.height), [imageSize, definition?.image, normalized.positionX, normalized.positionY, normalized.zoom, size.width, size.height]);
  useEffect(() => { onMetrics?.(layout?.metrics ?? null); }, [layout, onMetrics]);
  if (!definition?.assetPath) return null;
  return <div ref={viewportRef} className="customer-sidebar__theme-viewport" aria-hidden="true">
    {layout ? <img className="customer-sidebar__theme-image" src={definition.assetPath} alt={alt} style={layout.style} onError={onError} draggable="false" /> : null}
  </div>;
}

function customerThemePaletteStyle(theme) {
  const palette = CUSTOMER_THEME_DEFINITIONS[theme]?.railPalette;
  if (!palette) return undefined;
  return {
    "--customer-theme-rail-background": palette.background,
    "--customer-theme-rail-foreground": palette.foreground,
    "--customer-theme-rail-separator": palette.separator,
    "--customer-theme-rail-selected-background": palette.selectedBackground,
    "--customer-theme-rail-selected-foreground": palette.selectedForeground,
    "--customer-theme-rail-selected-marker-background": palette.selectedMarkerBackground,
    "--customer-theme-rail-selected-marker-foreground": palette.selectedMarkerForeground,
    "--customer-theme-rail-focus": palette.focus,
  };
}

function CustomerThemePlacementOverlay({ frames, metrics, image, variant }) {
  if (!frames || !metrics || !image) return null;
  const x = value => value * metrics.renderWidth / image.width - metrics.deltaX * variant.positionX;
  const y = value => value * metrics.renderHeight / image.height + metrics.offsetY;
  return Object.entries({title:'文字全体の配置枠',subject:'主役全体の配置枠'}).map(([key,label])=>frames[key] ? <div key={key} className="customer-theme-placement-frame" style={{left:x(frames[key].left),top:y(frames[key].top),width:(frames[key].right-frames[key].left)*metrics.renderWidth/image.width,height:(frames[key].bottom-frames[key].top)*metrics.renderHeight/image.height}}><span>{label}</span></div> : null);
}

function CustomerThemePreview({ theme, variant, imageSize, placementFrames, collapsed, onChangePosition, onImageError, metrics, onMetrics, onGuideMeasurements }) {
  const railRef = useRef(null);
  const dragRef = useRef(null);
  const [guides, setGuides] = useState([]);
  const [imageFailed, setImageFailed] = useState(false);
  const guideLabels = { brand: "店名・ブランド", categories: "カテゴリ／画像が重なる領域", hours: "営業時間" };
  const measureGuides = () => {
    const rail = railRef.current;
    if (!rail) return;
    const railRect = rail.getBoundingClientRect();
    const image = rail.querySelector(".customer-sidebar__theme-image");
    const frame = rail.querySelector(".customer-sidebar__theme-viewport");
    const imageRect = image?.complete && image.naturalWidth > 0 ? image.getBoundingClientRect() : null;
    const clipRects = [frame, rail, rail.parentElement].filter(Boolean).map((element) => element.getBoundingClientRect());
    const regions = Object.entries({ ...guideLabels, notice: "案内ボタン" }).map(([key, label]) => {
      const element = rail.querySelector(key === "notice" ? ".business-hours-notice-button" : `[data-customer-guide="${key}"]`);
      const rect = element?.getBoundingClientRect();
      const hidden = !element || window.getComputedStyle(element).display === "none" || window.getComputedStyle(element).visibility !== "visible" || element.getClientRects().length === 0;
      return { key, label, backgroundOnly: key === "categories", ...customerThemeGuideImageCoordinates({ image: imageSize, imageRect, clipRects, regionRect: rect, hidden }) };
    });
    for (const [index, element] of [...rail.querySelectorAll('.category-nav button, .category-nav__placeholder')].entries()) {
      regions.push({ key: 'category-' + index, label: 'カテゴリ行' + (index + 1), ...customerThemeGuideImageCoordinates({ image: imageSize, imageRect, clipRects, regionRect: element.getBoundingClientRect() }) });
    }
    const visibleImage = customerThemeGuideImageCoordinates({ image: imageSize, imageRect, clipRects, regionRect: imageRect });
    const imageHidden = collapsed || imageFailed || !assetPath;
    const metricsCurrent = metrics?.storedZoom === variant.zoom && metrics.frameWidth === frame?.clientWidth && metrics.frameHeight === frame?.clientHeight;
    onGuideMeasurements?.({ conditionId: "management", conditionLabel: "現在の管理画面条件", imageWidth: imageSize?.width, imageHeight: imageSize?.height, theme, collapsed, imageHidden, frameWidth: frame?.clientWidth, frameHeight: frame?.clientHeight, zoom: metrics?.zoom, minimumZoom: metrics?.minimumZoom, storedZoom: imageHidden || metricsCurrent ? variant.zoom : null, positionX: variant.positionX, positionY: variant.positionY, spaceX: metrics?.spaceX, spaceY: metrics?.spaceY, rangeX: metrics?.rangeX, rangeY: metrics?.rangeY, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, dpr: window.devicePixelRatio, visibleImage, categoryCount: rail.querySelectorAll(".category-nav button").length, placeholderCount: rail.querySelectorAll(".category-nav__placeholder").length, regions });
    const next = Object.entries(guideLabels).map(([key, label]) => {
      const element = rail.querySelector(`[data-customer-guide="${key}"]`);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        key,
        label,
        left: ((rect.left - railRect.left) / railRect.width) * 100,
        top: ((rect.top - railRect.top) / railRect.height) * 100,
        width: (rect.width / railRect.width) * 100,
        height: (rect.height / railRect.height) * 100,
      };
    }).filter(Boolean);
    setGuides(next);
  };
  useLayoutEffect(() => {
    const rail = railRef.current;
    if (!rail || typeof ResizeObserver !== "function") return undefined;
    // Measure after image style and frame metrics have reached the DOM.
    let animationFrame;
    const schedule = () => { window.cancelAnimationFrame(animationFrame); animationFrame = window.requestAnimationFrame(measureGuides); };
    const observer = new ResizeObserver(schedule);
    [rail, rail.parentElement, ...rail.querySelectorAll(".customer-sidebar__theme-viewport, .customer-sidebar__theme-image, [data-customer-guide], .business-hours-notice-button")].forEach((element) => observer.observe(element));
    const image = rail.querySelector(".customer-sidebar__theme-image");
    image?.addEventListener("load", schedule);
    window.addEventListener("resize", schedule);
    schedule();
    return () => { observer.disconnect(); window.cancelAnimationFrame(animationFrame); image?.removeEventListener("load", schedule); window.removeEventListener("resize", schedule); };
  }, [collapsed, theme, imageSize, imageFailed, variant.positionX, variant.positionY, variant.zoom, metrics, onGuideMeasurements]);
  useEffect(() => { setImageFailed(false); }, [theme, variant?.prompt]);
  const onPointerDown = (event) => {
    if (collapsed || !assetPath || !themeAvailable || imageFailed) return;
    if (event.button !== undefined && event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, positionX: variant.positionX, positionY: variant.positionY };
  };
  const onPointerMove = (event) => {
    if (!dragRef.current || !railRef.current) return;
    const deltaX = metrics?.deltaX ?? 0;
    const deltaY = metrics?.rangeY ?? 0;
    onChangePosition({
      positionX: customerThemePositionAfterDrag(dragRef.current.positionX, event.clientX - dragRef.current.x, deltaX, CUSTOMER_THEME_PREVIEW_SCALE),
      positionY: customerThemePositionAfterDrag(dragRef.current.positionY, event.clientY - dragRef.current.y, deltaY, CUSTOMER_THEME_PREVIEW_SCALE),
    });
  };
  const stopDrag = () => { dragRef.current = null; };
  const handleImageError = () => {
    setImageFailed(true);
    onImageError?.();
  };
  const assetPath = CUSTOMER_THEME_DEFINITIONS[theme]?.assetPath;
  const themeAvailable = isAvailableCustomerTheme(theme);
  useEffect(() => {
    if (collapsed || !assetPath || !themeAvailable || imageFailed) onMetrics?.(null);
  }, [collapsed, assetPath, themeAvailable, imageFailed, onMetrics]);
  return <div className="customer-theme-preview" aria-label={`${collapsed ? "折り畳み時" : "展開時"}の客席レールプレビュー`}>
    <div className={`customer-theme-preview__viewport ${collapsed ? "is-collapsed" : ""}`}>
      <div
        ref={railRef}
        className={`customer-theme-preview__rail customer-sidebar ${collapsed ? "is-collapsed" : ""}`}
        data-customer-theme={imageFailed || !themeAvailable ? "standard" : theme}
        style={{ ...customerThemePaletteStyle(imageFailed || !themeAvailable ? "standard" : theme), "--customer-theme-preview-scale": CUSTOMER_THEME_PREVIEW_SCALE }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stopDrag}
      onPointerCancel={stopDrag}
      >
        {!collapsed && assetPath && themeAvailable && !imageFailed ? <CustomerThemeImage theme={theme} variant={variant} imageSize={imageSize} alt={`${CUSTOMER_THEME_DEFINITIONS[theme].label}のレール画像配置プレビュー`} onError={handleImageError} onMetrics={onMetrics} /> : null}
        <CustomerRailContent expanded={!collapsed} categories={CUSTOMER_MAJOR_CATEGORIES} currentCategoryId="drink" onSelectCategory={() => {}} onExpand={() => {}} businessHours={DEFAULT_BUSINESS_HOURS} />
        {!collapsed ? <CustomerThemePlacementOverlay frames={placementFrames} metrics={metrics} image={imageSize} variant={variant} /> : null}
        {!collapsed ? guides.map((guide) => <span key={guide.key} className="customer-theme-preview__guide" style={{ left: `${guide.left}%`, top: `${guide.top}%`, width: `${guide.width}%`, height: `${guide.height}%` }}><b>{guide.label}</b></span>) : null}
      </div>
    </div>
    {!themeAvailable && theme !== "standard" ? <p className="customer-theme-preview__fallback" role="status">画像未配置のため選択・保存できません。素材配置後にプレビューを有効にします。</p> : null}
    {imageFailed ? <p className="customer-theme-preview__fallback" role="status">画像を読み込めない場合は標準の赤レールへfallbackします。</p> : null}
    {!collapsed && !imageFailed && assetPath && themeAvailable ? null : <p className="customer-theme-preview__hint">{collapsed ? "折り畳み時は画像を表示せず、従来の赤レールに戻ります。" : "標準表示では画像を使用しません。"}</p>}
  </div>;
}

function A90CustomerThemePreview({ definition, variant, model, collapsed, onChangePosition }) {
  const drag = useRef(null);
  if (!model || collapsed) return <p className="customer-theme-preview__hint">{collapsed ? "A90の折り畳み配置は未再現。画像座標は使用しません。" : "実画像寸法の読込待ち"}</p>;
  const scale = CUSTOMER_THEME_PREVIEW_SCALE;
  const pointerDown = event => { if (event.button !== 0) return;event.currentTarget.setPointerCapture(event.pointerId);drag.current={x:event.clientX,y:event.clientY,positionX:variant.positionX,positionY:variant.positionY}; };
  const pointerMove = event => { if (!drag.current) return;onChangePosition({positionX:customerThemePositionAfterDrag(drag.current.positionX,event.clientX-drag.current.x,model.layout.metrics.deltaX,scale),positionY:customerThemePositionAfterDrag(drag.current.positionY,event.clientY-drag.current.y,model.layout.metrics.rangeY,scale)}); };
  const stop = () => {drag.current=null;};
  return <div className="customer-theme-a90-stage" style={{width:A90_THEME_CONDITION.frameWidth*scale,height:A90_THEME_CONDITION.frameHeight*scale}}><div className="customer-theme-a90-rail" data-customer-theme={definition.id} style={{...customerThemePaletteStyle(definition.id),width:A90_THEME_CONDITION.frameWidth,height:A90_THEME_CONDITION.frameHeight,transform:'scale('+scale+')'}} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={stop} onPointerCancel={stop}>
    <img src={definition.assetPath} alt={definition.label+'のA90実測矩形プレビュー'} draggable="false" style={{position:'absolute',...model.layout.style}} />
    <CustomerThemePlacementOverlay frames={customerThemePlacementFrames(model.measurement,definition.image)} metrics={model.layout.metrics} image={definition.image} variant={variant} />
    {A90_THEME_REGIONS.map(r=><div key={r.key} className={'customer-theme-a90-region '+(r.backgroundOnly?'is-background':'')} style={{left:r.rect.left,top:r.rect.top,width:r.rect.right-r.rect.left,height:r.rect.bottom-r.rect.top}}>{r.backgroundOnly?'':r.label}</div>)}
  </div></div>;
}

function CustomerThemeEditor({ adminApiMode }) {
  const [state, setState] = useState({ loading: adminApiMode, saving: false, error: "", message: "", formal: null, draft: "standard", editingTheme: "standard", draftThemes: cloneCustomerThemeVariants() });
  const [displayCondition, setDisplayCondition] = useState("management");
  const [actualImage, setActualImage] = useState(null);
  const [previewCollapsed, setPreviewCollapsed] = useState(false);
  const [previewMetrics, setPreviewMetrics] = useState(null);
  const [guideMeasurements, setGuideMeasurements] = useState(null);
  const [copyMessage, setCopyMessage] = useState("");
  const [generationCopyMessage, setGenerationCopyMessage] = useState("");
  const [imageFolderCopyMessage, setImageFolderCopyMessage] = useState("");
  const [themeUploadLabel, setThemeUploadLabel] = useState("");
  const [themeUploadFile, setThemeUploadFile] = useState(null);
  const [themeUploading, setThemeUploading] = useState(false);

  const load = async ({ keepMessage = false } = {}) => {
    if (!adminApiMode) return null;
    setState((current) => ({ ...current, loading: true, error: "", ...(keepMessage ? {} : { message: "" }) }));
    try {
      const formal = await fetchAdminCustomerThemeConfig({ env: window });
      setState((current) => ({ ...current, loading: false, saving: false, error: "", formal, draft: formal.theme, editingTheme: formal.theme, draftThemes: cloneCustomerThemeVariants(formal.themes), ...(keepMessage ? {} : { message: "" }) }));
      return formal;
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: customerThemeErrorMessage(error, "テーマ設定の取得"), formal: current.formal }));
      return null;
    }
  };

  useEffect(() => {
    if (!adminApiMode) {
      setState({ loading: false, saving: false, error: "", message: "", formal: null, draft: "standard", editingTheme: "standard", draftThemes: cloneCustomerThemeVariants() });
      return undefined;
    }
    void load();
    return undefined;
  }, [adminApiMode]);

  const selectedVariant = state.draftThemes[state.editingTheme] ?? DEFAULT_CUSTOMER_THEME_VARIANTS.standard;
  const availableDefinitions = state.formal?.definitions ?? CUSTOMER_THEME_DEFINITIONS;
  const sourceDefinition = availableDefinitions[state.editingTheme] ?? CUSTOMER_THEME_DEFINITIONS.standard;
  useEffect(() => {
    let active = true;setActualImage(null);
    if (!sourceDefinition.assetPath) return undefined;
    const image = new Image();image.onload = () => { if (active && image.naturalWidth > 0) setActualImage({assetPath:sourceDefinition.assetPath,width:image.naturalWidth,height:image.naturalHeight}); };image.src=sourceDefinition.assetPath;
    return () => {active=false;};
  }, [sourceDefinition.assetPath]);
  const actualSize = actualImage?.assetPath === sourceDefinition.assetPath ? actualImage : null;
  const selectedDefinition = {...sourceDefinition, image:actualSize};
  const a90Model = useMemo(() => customerThemeConditionModel({image:actualSize,variant:{...selectedVariant,theme:state.editingTheme},collapsed:previewCollapsed}),[actualSize,selectedVariant.zoom,selectedVariant.positionX,selectedVariant.positionY,state.editingTheme,previewCollapsed]);
  const activeMetrics = displayCondition === "a90" ? a90Model?.layout.metrics : previewMetrics;
  const currentGuideMeasurement = displayCondition === "a90" ? a90Model?.measurement : guideMeasurements?.theme === state.editingTheme && guideMeasurements.collapsed === previewCollapsed && guideMeasurements.storedZoom === selectedVariant.zoom && guideMeasurements.positionX === selectedVariant.positionX && guideMeasurements.positionY === selectedVariant.positionY && guideMeasurements.imageWidth === actualSize?.width && guideMeasurements.imageHeight === actualSize?.height ? guideMeasurements : null;
  const generationPrompt = buildCustomerThemeGenerationPrompt({ definition: selectedDefinition, variant: selectedVariant, measurement: currentGuideMeasurement });
  useEffect(() => { setGenerationCopyMessage(""); }, [generationPrompt]);
  const minimumZoom = activeMetrics?.minimumZoom ?? 0.5;
  const visualZoom = resolveCustomerThemeZoom(selectedVariant.zoom, minimumZoom);
  const setSelectedVariant = (patch) => setState((current) => ({
    ...current,
    draftThemes: { ...current.draftThemes, [current.editingTheme]: { ...current.draftThemes[current.editingTheme], ...patch } },
    message: "",
  }));
  const copyPrompt = async () => {
    try {
      if (typeof window.navigator?.clipboard?.writeText === "function") {
        await window.navigator.clipboard.writeText(selectedVariant.prompt);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = selectedVariant.prompt;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        if (!document.execCommand("copy")) throw new Error("copy failed");
        textarea.remove();
      }
      setCopyMessage("プロンプトをコピーしました。");
    } catch {
      setCopyMessage("コピーできませんでした。欄の文字を選択してコピーしてください。");
    }
  };
  const copyImageFolderPath = async () => {
    if (!CUSTOMER_THEME_IMAGE_SOURCE_FOLDER) return;
    try {
      if (typeof window.navigator?.clipboard?.writeText === "function") {
        await window.navigator.clipboard.writeText(CUSTOMER_THEME_IMAGE_SOURCE_FOLDER);
      } else {
        const input = document.getElementById("customer-theme-image-folder-path");
        input?.select();
        if (!input || !document.execCommand("copy")) throw new Error("copy failed");
      }
      setImageFolderCopyMessage("フォルダのパスをコピーしました。");
    } catch {
      setImageFolderCopyMessage("コピーできませんでした。上のパスを選択してコピーしてください。");
    }
  };
  const copyGenerationPrompt = async () => {
    if (!generationPrompt || !currentGuideMeasurement) return;
    let temporaryTextarea;
    try {
      if (typeof window.navigator?.clipboard?.writeText === "function") {
        await window.navigator.clipboard.writeText(generationPrompt);
      } else {
        // The full text may be inside a closed disclosure; copy from a mounted fallback.
        temporaryTextarea = document.createElement("textarea");
        temporaryTextarea.value = generationPrompt;
        temporaryTextarea.readOnly = true;
        temporaryTextarea.style.position = "fixed";
        temporaryTextarea.style.opacity = "0";
        document.body.appendChild(temporaryTextarea);
        temporaryTextarea.select();
        if (!document.execCommand("copy")) throw new Error("copy failed");
      }
      setGenerationCopyMessage("ベースプロンプトとイメージ指示の全文をコピーしました。");
    } catch {
      setGenerationCopyMessage("コピーできませんでした。「生成プロンプト全文を確認」を開き、全文を選択してコピーしてください。");
    } finally {
      temporaryTextarea?.remove();
    }
  };
  const save = async () => {
    if (!adminApiMode || state.saving || !state.formal) return;
    setState((current) => ({ ...current, saving: true, error: "", message: "" }));
    try {
      const formal = await saveAdminCustomerThemeConfig({ env: window, theme: state.draft, themes: state.draftThemes, expectedVersion: state.formal.version });
      setState({ loading: false, saving: false, error: "", message: `保存しました（version ${formal.version}）。`, formal, draft: formal.theme, editingTheme: formal.theme, draftThemes: cloneCustomerThemeVariants(formal.themes) });
    } catch (error) {
      if (error?.status === 409 || error?.code === "CUSTOMER_THEME_CONFLICT") await load({ keepMessage: true });
      setState((current) => ({ ...current, saving: false, error: customerThemeErrorMessage(error, "テーマ設定の保存"), message: "" }));
    }
  };
  const uploadThemeImage = async (replace = false) => {
    if (!themeUploadFile || themeUploading) return;
    if (!replace && !themeUploadLabel.trim()) {
      setState((current) => ({ ...current, error: "追加するテーマ名を入力してください。" }));
      return;
    }
    setThemeUploading(true);
    setState((current) => ({ ...current, error: "", message: "" }));
    try {
      const result = await uploadAdminCustomerThemeImage({
        env: window,
        file: themeUploadFile,
        themeKey: replace ? state.editingTheme : undefined,
        label: themeUploadLabel.trim() || sourceDefinition.label,
      });
      const formal = await fetchAdminCustomerThemeConfig({ env: window });
      setState((current) => ({ ...current, formal, draft: replace ? current.draft : result.themeKey, editingTheme: result.themeKey, draftThemes: cloneCustomerThemeVariants(formal.themes), error: "", message: replace ? "画像を差し替えました。旧画像は保全されています。" : "テーマを追加しました。選択状態は未保存です。配置を調整してテーマを保存してください。" }));
      setThemeUploadFile(null);
      setThemeUploadLabel("");
      const input = document.getElementById("customer-theme-image-upload");
      if (input) input.value = "";
    } catch (error) {
      setState((current) => ({ ...current, error: customerThemeErrorMessage(error, "客席レール画像の登録") }));
    } finally {
      setThemeUploading(false);
    }
  };
  const discard = () => setState((current) => current.formal ? ({ ...current, draft: current.formal.theme, editingTheme: current.formal.theme, draftThemes: cloneCustomerThemeVariants(current.formal.themes), message: "", error: "" }) : current);
  const previewTheme = state.editingTheme;
  return <section className="customer-theme-editor" aria-label="客席左レールテーマ設定">
    <header className="customer-theme-editor__heading"><div><span className="section-kicker">CUSTOMER RAIL THEME</span><h2>客席左レールのテーマ</h2></div><span className="customer-theme-editor__version">正式version {state.formal?.version ?? "—"}</span></header>
    {state.loading ? <p className="customer-theme-editor__status" role="status">正式値を読み込み中です。</p> : null}
    {!adminApiMode ? <p className="customer-theme-editor__status">管理API接続時に編集できます。</p> : null}
    <fieldset className="customer-theme-editor__options" disabled={!adminApiMode || state.loading || state.saving}>
      <legend className="sr-only">客席レールテーマ</legend>
      {Object.values(availableDefinitions).map((definition) => {
        const available = definition.available;
        const isSelected = state.draft === definition.id;
        return <div className={`customer-theme-option${available ? "" : " customer-theme-option--unavailable"}`} key={definition.id}>
          <label className="customer-theme-option__select"><input type="radio" name="customer-rail-theme" value={definition.id} checked={isSelected} disabled={!available} onChange={() => setState((current) => ({ ...current, draft: definition.id, editingTheme: definition.id, message: "" }))} /><span className="customer-theme-option__copy"><strong>{definition.label}</strong><small>{available ? (definition.id === "standard" ? "未設定・画像読込失敗時のfallback" : "画像を展開時だけ表示") : "画像未配置・テーマ選択不可"}</small>{definition.assetPath ? <img className="customer-theme-option__preview" src={definition.assetPath} alt={`${definition.label}の客席レールプレビュー`} /> : !available ? <span className="customer-theme-option__preview customer-theme-option__preview--missing">画像未配置</span> : <span className="customer-theme-option__preview customer-theme-option__preview--standard">STANDARD</span>}</span></label>
          {!available ? <button type="button" className="customer-theme-option__metadata" aria-pressed={state.editingTheme === definition.id} onClick={() => setState((current) => ({ ...current, editingTheme: definition.id, message: "" }))}>制作情報を編集</button> : null}
        </div>;
      })}
    </fieldset>
    <section className="customer-theme-upload" aria-label="客席レール画像の追加・差替え">
      <strong>レール画像を追加・差替え</strong>
      <label>テーマ名<input type="text" maxLength={80} value={themeUploadLabel} onChange={(event) => setThemeUploadLabel(event.target.value)} placeholder="例：春の桜" disabled={!adminApiMode || themeUploading} /></label>
      <label>画像ファイル<input id="customer-theme-image-upload" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => setThemeUploadFile(event.target.files?.[0] ?? null)} disabled={!adminApiMode || themeUploading} /></label>
      <small>PNG・JPEG・WebP、5MB以下。実寸は画像から取得します。旧画像は削除せず保全します。</small>
      <div><button type="button" className="button button--outline" onClick={() => void uploadThemeImage(false)} disabled={!adminApiMode || !themeUploadFile || !themeUploadLabel.trim() || themeUploading}>{themeUploading ? "登録中…" : "新しいテーマとして追加"}</button>
        {sourceDefinition.assetPath ? <button type="button" className="button button--quiet" onClick={() => void uploadThemeImage(true)} disabled={!adminApiMode || !themeUploadFile || themeUploading}>「{sourceDefinition.label}」の画像を差替え</button> : null}</div>
    </section>
    <div className="customer-theme-editor__details">
      <div className="customer-theme-editor__metadata">
        <label className="customer-theme-editor__field" htmlFor="customer-theme-display-condition">制作する表示条件<select id="customer-theme-display-condition" value={displayCondition} onChange={event => { setDisplayCondition(event.target.value); setGuideMeasurements(null); setPreviewMetrics(null); }}><option value="management">現在の管理画面条件</option><option value="a90">A90キオスク実測条件</option></select></label>
        <div className="customer-theme-editor__field"><label htmlFor="customer-theme-prompt">イメージ指示</label><textarea id="customer-theme-prompt" rows={6} maxLength={4000} value={selectedVariant.prompt} disabled={!adminApiMode || state.loading || state.saving} onChange={(event) => setSelectedVariant({ prompt: event.target.value })} /><small>{[...selectedVariant.prompt].length} / 4000</small></div>

        {selectedDefinition.image ? <>
          <button type="button" className="button button--outline" disabled={!currentGuideMeasurement || state.loading} onClick={() => void copyGenerationPrompt()}>画像生成プロンプトを全文コピー</button>
          {generationCopyMessage ? <small role="status">{generationCopyMessage}</small> : null}
          <details className="customer-theme-editor__disclosure" aria-label="生成プロンプト全文を確認">
            <summary>生成プロンプト全文を確認</summary>
            <div className="customer-theme-editor__field"><label htmlFor="customer-theme-generation-prompt">生成プロンプト全文</label><textarea id="customer-theme-generation-prompt" rows={20} readOnly value={generationPrompt} /></div>
          </details>
        </> : null}
        <details className="customer-theme-editor__disclosure" aria-label="制作ガイド・詳細">
          <summary>制作ガイド・詳細</summary>
          <div className="customer-theme-editor__metadata">
        <label className="customer-theme-editor__field" htmlFor="customer-theme-notes"><span>制作・仕様メモ</span><textarea id="customer-theme-notes" rows={5} maxLength={4000} value={selectedVariant.notes} disabled={!adminApiMode || state.loading || state.saving} onChange={(event) => setSelectedVariant({ notes: event.target.value })} /><small>{[...selectedVariant.notes].length} / 4000</small></label>
        <div><button type="button" className="button button--outline" onClick={() => void copyPrompt()} disabled={!selectedVariant.prompt}>イメージ指示だけをコピー</button>{copyMessage ? <small role="status">{copyMessage}</small> : null}</div>
        {selectedDefinition.assetPath ? <div className="customer-theme-editor__field" aria-label="制作メモの重なり回避補足">
          <strong>重なり回避</strong>
          {customerThemeSpecificGuidance(selectedDefinition) ? <small>{customerThemeSpecificGuidance(selectedDefinition)}</small> : null}
          {previewTheme === "japanese-halloween" ? <small>20261012新画像候補のA90実例：保存倍率1.0315／X51.5%／Y18.16%。主役周囲の余裕に改善余地があります。共通初期値や新しい画像の保証にはしません。</small> : null}
          <p>重要な文字・主役は、破線で示す店名・カテゴリ・営業時間などを避け、表示範囲の端から余裕を取ってください。カテゴリ枠には上側の余白も含まれます。枠側の余白は画像の一部ではありません。</p>
        </div> : null}
        {selectedDefinition.image ? <section className="customer-theme-editor__field" aria-label="現在のプレビューでUIが重なる画像座標">
          <strong>現在のプレビューでUIが重なる画像座標</strong>
          <p>{displayCondition === "a90" ? "A90：viewport1313×820 CSS px、枠220×820.5 CSS px。DPR約1.4625は情報のみ。UI矩形を再現し、文言・字形・配色・件数変更・案内ボタン・折り畳みは未再現。空き行はナビ残余の推定。" : "現在の管理画面の実測参考値。実客席の条件ではありません。"}</p>
          <small>元画像{selectedDefinition.image.width}×{selectedDefinition.image.height}pxの左上が原点です。単位は画像px。クリップ後の交差部分を小数第1位まで表示します。</small>
          {currentGuideMeasurement?.theme !== previewTheme ? <p>計測待ち</p> : currentGuideMeasurement.imageHidden ? <p>画像が非表示のため座標は表示しません。</p> : <>
            <p>枠 {currentGuideMeasurement.frameWidth ?? "—"}×{currentGuideMeasurement.frameHeight ?? "—"} CSS px ／ 倍率 {currentGuideMeasurement.zoom?.toFixed(3) ?? "—"}×（枠いっぱい＝1.00） ／ X {(currentGuideMeasurement.positionX * 100).toFixed(0)}%・Y {(currentGuideMeasurement.positionY * 100).toFixed(0)}% ／ カテゴリ {currentGuideMeasurement.categoryCount}件{currentGuideMeasurement.placeholderCount ? `＋空き行${currentGuideMeasurement.placeholderCount}件` : ""}</p>
            <dl>{currentGuideMeasurement.regions.map((region) => <div key={region.key}><dt>{region.label}</dt><dd>{region.status === "hidden" ? "要素が非表示" : region.status === "pending" ? "計測待ち" : region.status === "none" ? "画像との交差なし" : `左 ${region.left.toFixed(1)} ／ 上 ${region.top.toFixed(1)} ／ 右 ${region.right.toFixed(1)} ／ 下 ${region.bottom.toFixed(1)}`}</dd></div>)}</dl>
          </>}
        </section> : null}
        <section className="customer-theme-editor__image-location" aria-label="画像ファイルの場所">
          <strong>画像ファイルの場所</strong>
          <dl><div><dt>画像名</dt><dd>{selectedDefinition.assetPath ? selectedDefinition.assetPath.split("/").pop() : "画像なし"}</dd></div><div><dt>画像寸法</dt><dd>{selectedDefinition.image ? `${selectedDefinition.image.width}×${selectedDefinition.image.height}px` : "—"}</dd></div></dl>
          <label htmlFor="customer-theme-image-folder-path">編集元フォルダ<input id="customer-theme-image-folder-path" type="text" readOnly value={CUSTOMER_THEME_IMAGE_SOURCE_FOLDER || "prototype/public（プロジェクト内）"} onFocus={(event) => event.currentTarget.select()} onClick={(event) => event.currentTarget.select()} /></label>
          {CUSTOMER_THEME_IMAGE_SOURCE_FOLDER ? <div className="customer-theme-editor__image-location-actions"><button type="button" className="button button--outline" onClick={() => void copyImageFolderPath()}>フォルダのパスをコピー</button><a href={CUSTOMER_THEME_IMAGE_SOURCE_FOLDER_URL} target="_blank" rel="noreferrer">フォルダを開く（対応ブラウザーのみ）</a></div> : <small>このbuildには編集元フォルダの絶対パスが設定されていません。</small>}
          {imageFolderCopyMessage ? <small role="status">{imageFolderCopyMessage}</small> : null}
          <p>同じ名前・同じ寸法のPNGへ差し替える場合、コード変更は不要です。旧画像を別名または別フォルダで保管してから、新画像を入れてください。表示中のQAへの反映は別途必要です。</p>
        </section>
        <dl className="customer-theme-editor__spec"><div><dt>制作テーマ</dt><dd>{selectedDefinition.label}{!selectedDefinition.available ? "（画像未配置）" : ""}</dd></div><div><dt>実画像寸法</dt><dd>{selectedDefinition.image ? `${selectedDefinition.image.width} × ${selectedDefinition.image.height} px` : sourceDefinition.assetPath ? "実画像寸法の読込待ち／未取得" : "画像なし（標準の赤レール）"}</dd></div><div><dt>画像比率</dt><dd>{selectedDefinition.image ? `${(selectedDefinition.image.width / selectedDefinition.image.height).toFixed(3)}:1（幅:高さ）` : "—"}</dd></div><div><dt>描画条件</dt><dd>{displayCondition === "a90" ? "A90：枠220×820.5 CSS px、viewport1313×820 CSS px、DPR約1.4625（倍率へ不使用）" : "現在の管理画面で計測したレール条件"}。倍率1.00×は枠いっぱいです。</dd></div><div><dt>適用範囲</dt><dd>客席画面の展開時のみ</dd></div></dl>
          </div>
        </details>
      </div>
      <div className="customer-theme-editor__preview-panel">
        <div className="customer-theme-editor__preview-heading"><div><strong>配置プレビュー</strong></div><div className="customer-theme-editor__preview-toggle"><button type="button" className={previewCollapsed ? "" : "is-active"} aria-pressed={!previewCollapsed} onClick={() => setPreviewCollapsed(false)}>展開時</button><button type="button" className={previewCollapsed ? "is-active" : ""} aria-pressed={previewCollapsed} onClick={() => setPreviewCollapsed(true)}>折り畳み時</button></div></div>
        {displayCondition === "a90" ? <A90CustomerThemePreview definition={selectedDefinition} variant={selectedVariant} model={a90Model} collapsed={previewCollapsed} onChangePosition={setSelectedVariant} /> : <CustomerThemePreview theme={previewTheme} variant={selectedVariant} imageSize={actualSize} placementFrames={customerThemePlacementFrames(currentGuideMeasurement,actualSize)} collapsed={previewCollapsed} onChangePosition={setSelectedVariant} metrics={previewMetrics} onMetrics={setPreviewMetrics} onGuideMeasurements={setGuideMeasurements} />}
        {!previewCollapsed ? <div className="customer-theme-editor__position-controls">
          <label>ズーム <output>{visualZoom.toFixed(2)}×</output><input aria-label="テーマ画像ズーム" type="range" min="0.5" max={MAX_CUSTOMER_THEME_ZOOM} step="0.01" value={selectedVariant.zoom} disabled={!adminApiMode || state.loading || state.saving || !actualSize || !activeMetrics} onChange={(event) => setSelectedVariant({ zoom: Number(event.target.value) })} /><small>1.00×は枠いっぱい、最小{minimumZoom.toFixed(2)}×は画像全体が収まる倍率です。</small></label>
          <label>横位置 X <output>{Math.round(selectedVariant.positionX * 100)}%</output><input aria-label="テーマ画像の横位置" type="range" min="0" max="1" step="0.005" value={selectedVariant.positionX} disabled={!adminApiMode || state.loading || state.saving || !activeMetrics?.canMoveX} onChange={(event) => setSelectedVariant({ positionX: Number(event.target.value) })} /><small>{activeMetrics?.canMoveX ? `${activeMetrics.overflowX > 0 ? "切り抜き" : "余白"}範囲で左右に最大${Math.round(activeMetrics.rangeX)}px移動できます。` : "この方向は枠に一致しているため移動不要です。"}</small></label>
          <label>縦位置 Y <output>{Math.round(selectedVariant.positionY * 100)}%</output><input aria-label="テーマ画像の縦位置" type="range" min="0" max="1" step="0.005" value={selectedVariant.positionY} disabled={!adminApiMode || state.loading || state.saving || !activeMetrics?.canMoveY} onChange={(event) => setSelectedVariant({ positionY: Number(event.target.value) })} /><small>{activeMetrics?.canMoveY ? `中央50%を基準に上下へ移動できます。端から端まで${Math.round(activeMetrics.rangeY)}px。位置によって余白や切り抜きができます。` : "画像と表示枠の計測待ちです。"}</small></label>
          <div className="customer-theme-editor__fit-actions"><span>中央位置はX・Yとも50%です。</span><button type="button" className="button button--quiet" onClick={() => setSelectedVariant({ positionX: 0.5, positionY: 0.5, zoom: 0.5 })} disabled={!adminApiMode || state.loading || state.saving}>画像全体を表示</button><button type="button" className="button button--quiet" onClick={() => setSelectedVariant({ positionX: 0.5, positionY: 0.5, zoom: MIN_CUSTOMER_THEME_ZOOM })} disabled={!adminApiMode || state.loading || state.saving}>枠いっぱいに表示</button></div>
        </div> : null}
      </div>
    </div>
    {state.error ? <p className="customer-theme-editor__message is-error" role="alert">{state.error}</p> : null}
    {state.message ? <p className="customer-theme-editor__message is-success" role="status">{state.message}</p> : null}
    <div className="customer-theme-editor__actions"><button type="button" className="button button--quiet" onClick={discard} disabled={state.saving || !state.formal}>変更を破棄</button><button type="button" className="button button--outline" onClick={() => void load()} disabled={state.loading || state.saving || !adminApiMode}>再読込</button><button type="button" className="button button--primary" onClick={() => void save()} disabled={!adminApiMode || state.loading || state.saving || !state.formal}>{state.saving ? "保存中" : "テーマを保存"}</button></div>
  </section>;
}

function BusinessHoursTimeFields({ label, value, maxHour, disabled, onChange }) {
  const selected = splitBusinessHoursTime(value);
  return <fieldset className="business-hours-time" disabled={disabled}>
    <legend>{label}</legend>
    <select aria-label={`${label} 時`} value={selected.hour} onChange={(event) => onChange(combineBusinessHoursTime(event.target.value, selected.minute))}>
      {Array.from({ length: maxHour + 1 }, (_, hour) => <option key={hour} value={String(hour).padStart(2, "0")}>{businessHoursHourLabel(hour)}</option>)}
    </select>
    <span>：</span>
    <select aria-label={`${label} 分`} value={selected.minute} onChange={(event) => onChange(combineBusinessHoursTime(selected.hour, event.target.value))}>
      {Array.from({ length: 60 }, (_, minute) => <option key={minute} value={String(minute).padStart(2, "0")}>{String(minute).padStart(2, "0")}分</option>)}
    </select>
    {Number(selected.hour) >= 24 ? <small>翌日</small> : null}
  </fieldset>;
}

function CustomerOrderStartNoticeEditor({ adminApiMode }) {
  const [state, setState] = useState({ loading: Boolean(adminApiMode), saving: false, error: "", message: "", formal: null, draft: { heading: "", body: "" } });
  const load = async () => {
    if (!adminApiMode) return;
    setState((current) => ({ ...current, loading: true, error: "", message: "" }));
    try {
      const formal = await fetchAdminCustomerOrderStartNotice({ env: window });
      setState({ loading: false, saving: false, error: "", message: "", formal, draft: { heading: formal.heading, body: formal.body } });
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: error?.status === 401 ? "管理者認証を確認してください。" : "注意事項を取得できません。管理APIを確認してください。" }));
    }
  };
  useEffect(() => { void load(); }, [adminApiMode]);
  const updateDraft = (changes) => setState((current) => ({ ...current, draft: { ...current.draft, ...changes }, message: "", error: "" }));
  const save = async () => {
    if (!adminApiMode || !state.formal || state.saving) return;
    setState((current) => ({ ...current, saving: true, error: "", message: "" }));
    try {
      const formal = await saveAdminCustomerOrderStartNotice({ env: window, ...state.draft, expectedVersion: state.formal.version });
      setState({ loading: false, saving: false, error: "", message: "注意事項を保存しました。客席へ共有されました。", formal, draft: { heading: formal.heading, body: formal.body } });
    } catch (error) {
      setState((current) => ({
        ...current,
        saving: false,
        error: error?.status === 409 || error?.code === "CUSTOMER_ORDER_NOTICE_CONFLICT"
          ? "別の管理端末で更新されています。再読込してから編集してください。"
          : error?.status === 400 ? "見出しと本文を入力してください。" : "注意事項を保存できません。管理APIを確認してください。",
      }));
    }
  };
  const dirty = Boolean(state.formal && (state.draft.heading !== state.formal.heading || state.draft.body !== state.formal.body));
  return <section className="customer-order-notice-editor" aria-label="注文開始前の注意事項設定">
    <header><span className="section-kicker">CUSTOMER ORDER START</span><h2>注文前の注意事項</h2><p>同じ来店中は、文章を更新しても確認済み状態を保ちます。次の来店から最新の文章を表示します。</p></header>
    {!adminApiMode ? <p className="customer-order-notice-editor__status">管理者API接続時に編集できます。</p> : null}
    <div className="customer-order-notice-editor__layout">
      <div className="customer-order-notice-editor__fields">
        <label htmlFor="customer-order-notice-heading">見出し<input id="customer-order-notice-heading" maxLength={120} value={state.draft.heading} disabled={!adminApiMode || state.loading || state.saving || !state.formal} onChange={(event) => updateDraft({ heading: event.target.value })} /></label>
        <label htmlFor="customer-order-notice-body">本文（改行できます）<textarea id="customer-order-notice-body" maxLength={4000} rows={10} value={state.draft.body} disabled={!adminApiMode || state.loading || state.saving || !state.formal} onChange={(event) => updateDraft({ body: event.target.value })} /></label>
        <small>{[...state.draft.body].length} / 4000文字</small>
      </div>
      <section className="customer-order-notice-editor__preview" aria-label="客席表示プレビュー">
        <span>客席プレビュー</span><h3>{state.draft.heading || "見出し"}</h3><p>{state.draft.body || "本文"}</p><button type="button" disabled>了承して注文へ進む</button>
      </section>
    </div>
    {state.loading ? <p role="status">設定を読み込んでいます。</p> : null}
    {state.error ? <p className="customer-order-notice-editor__error" role="alert">{state.error}</p> : null}
    {state.message ? <p className="customer-order-notice-editor__success" role="status">{state.message}</p> : null}
    <div className="customer-order-notice-editor__actions"><button type="button" className="button button--quiet" onClick={() => setState((current) => ({ ...current, draft: { heading: current.formal?.heading ?? "", body: current.formal?.body ?? "" }, message: "", error: "" }))} disabled={!state.formal || state.saving || !dirty}>変更を破棄</button><button type="button" className="button button--outline" onClick={() => void load()} disabled={!adminApiMode || state.loading || state.saving}>再読込</button><button type="button" className="button button--primary" onClick={() => void save()} disabled={!adminApiMode || state.loading || state.saving || !state.formal || !dirty}>{state.saving ? "保存中" : "注意事項を保存"}</button></div>
  </section>;
}

function BusinessHoursEditor({ state, adminApiMode, onChange, onSave, onDiscard, onReload }) {
  const draft = state.draft ?? DEFAULT_BUSINESS_HOURS;
  return <section className="business-hours-editor" aria-label="本日の営業時間設定">
    <div className="business-hours-editor__heading"><div><span className="section-kicker">TODAY&apos;S HOURS</span><h2>本日の営業時間</h2><p>客席レールとスタッフ画面に表示する営業時間を設定します。</p></div><span className="business-hours-editor__version">正式version {state.formal?.version ?? "—"}</span></div>
    {state.loading ? <p className="business-hours-editor__status">正式値を読み込み中です。</p> : null}
    {!adminApiMode ? <p className="business-hours-editor__status">管理API接続時に編集できます。</p> : null}
    <div className="business-hours-editor__fields">
      <BusinessHoursTimeFields label="営業開始" value={draft.openTime} maxHour={23} disabled={!adminApiMode || state.loading || state.saving} onChange={(openTime) => onChange({ openTime })} />
      <BusinessHoursTimeFields label="営業終了" value={draft.closeTime} maxHour={29} disabled={!adminApiMode || state.loading || state.saving} onChange={(closeTime) => onChange({ closeTime })} />
      <BusinessHoursTimeFields label="ラストオーダー" value={draft.lastOrderTime} maxHour={29} disabled={!adminApiMode || state.loading || state.saving} onChange={(lastOrderTime) => onChange({ lastOrderTime })} />
      <label className="business-hours-visible"><input type="checkbox" checked={draft.isVisible} disabled={!adminApiMode || state.loading || state.saving} onChange={(event) => onChange({ isVisible: event.target.checked })} /> 客席画面に表示する</label>
    </div>
    <div className="business-hours-notice-editor">
      <label htmlFor="business-hours-notice-text">その他ご案内（定休日・臨時営業時間など）</label>
      <textarea id="business-hours-notice-text" maxLength={500} value={draft.noticeText ?? ""} disabled={!adminApiMode || state.loading || state.saving} onChange={(event) => onChange({ noticeText: event.target.value })} rows={4} />
      <div className="business-hours-notice-editor__meta"><span>{[...(draft.noticeText ?? "")].length} / 500</span><label><input type="checkbox" checked={draft.noticeEnabled === true} disabled={!adminApiMode || state.loading || state.saving} onChange={(event) => onChange({ noticeEnabled: event.target.checked })} /> 客席画面に表示する</label></div>
      {draft.noticeEnabled === true && !(draft.noticeText ?? "").trim() ? <p className="business-hours-editor__message is-error" role="alert">案内を表示する場合は本文を入力してください。</p> : null}
    </div>
    {state.message ? <p className={`business-hours-editor__message ${state.messageKind === "error" ? "is-error" : state.messageKind === "success" ? "is-success" : ""}`} role={state.messageKind === "error" ? "alert" : "status"}>{state.message}</p> : null}
    <div className="business-hours-editor__actions"><button type="button" className="button button--quiet" onClick={onDiscard} disabled={state.saving || !state.formal}>変更を破棄</button><button type="button" className="button button--outline" onClick={onReload} disabled={state.loading || state.saving || !adminApiMode}>再読込</button><button type="button" className="button button--primary" onClick={onSave} disabled={!adminApiMode || state.loading || state.saving || !state.formal}>{state.saving ? "保存中" : "営業時間を保存"}</button></div>
  </section>;
}

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

function rideGuidanceErrorMessage(error, action = "操作") {
  if (error?.status === 409) return "409：別の管理端末で更新されています。最新値を再取得しました。";
  if (error?.status === 401 || error?.code === "AUTH_TOKEN_MISMATCH") return "401：管理者tokenを確認してください。";
  if (error?.status === 400) return "400：入力内容を確認してください。";
  if (error?.status === 503 || error?.code === "API_UNAVAILABLE") return `${action}できません。管理APIを確認してください。`;
  return `${action}できませんでした。`;
}

const RIDE_GUIDANCE_TYPES = [
  ["taxi", "タクシー"],
  ["driver_service", "運転代行"],
];

function RideGuidanceEditor({ adminApiMode }) {
  const [expanded, setExpanded] = useState(true);
  const [state, setState] = useState({ loading: adminApiMode, saving: false, error: "", message: "", pickup: null, contacts: [], rowMessages: {} });
  const [pickupDraft, setPickupDraft] = useState({ pickupLabel: "", pickupAddress: "" });
  const [newContact, setNewContact] = useState({ type: "taxi", name: "", phone: "", note: "", isVisible: true });

  const load = async ({ keepMessage = false } = {}) => {
    if (!adminApiMode) return null;
    setState((current) => ({ ...current, loading: true, error: "", ...(keepMessage ? {} : { message: "" }) }));
    try {
      const data = await fetchAdminRideGuidance({ env: window });
      const contacts = [...data.contacts].sort((a, b) => a.type.localeCompare(b.type) || a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
      setState((current) => ({ ...current, loading: false, error: "", pickup: data.pickup, contacts, ...(keepMessage ? {} : { message: "" }) }));
      setPickupDraft({ pickupLabel: data.pickup.pickupLabel ?? "", pickupAddress: data.pickup.pickupAddress ?? "" });
      return { ...data, contacts };
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: rideGuidanceErrorMessage(error, "案内設定を取得"), pickup: current.pickup, contacts: current.contacts }));
      throw error;
    }
  };

  useEffect(() => {
    if (!adminApiMode) {
      setState((current) => ({ ...current, loading: false }));
      return undefined;
    }
    void load();
    return undefined;
  }, [adminApiMode]);

  const runMutation = async (key, mutation, action) => {
    if (state.saving) return;
    setState((current) => ({ ...current, saving: true, error: "", message: "", rowMessages: key && key !== "pickup" ? { ...current.rowMessages, [key]: "" } : current.rowMessages }));
    try {
      await mutation();
      await load();
      setState((current) => ({ ...current, saving: false, message: "保存しました。", rowMessages: key && key !== "pickup" ? { ...current.rowMessages, [key]: "保存しました。" } : current.rowMessages }));
      return true;
    } catch (error) {
      if (error?.status === 409) {
        try { await load({ keepMessage: true }); } catch { /* Preserve the conflict message if refetch also fails. */ }
      }
      const message = rideGuidanceErrorMessage(error, action);
      setState((current) => ({ ...current, saving: false, error: key === "pickup" ? message : current.error, message: key === "pickup" ? message : current.message, rowMessages: key && key !== "pickup" ? { ...current.rowMessages, [key]: message } : current.rowMessages }));
      return false;
    }
  };

  const savePickup = () => {
    if (!state.pickup) return;
    void runMutation("pickup", () => saveAdminRideGuidancePickup({ env: window, pickup: pickupDraft, expectedVersion: state.pickup.version }), "お迎え先を保存");
  };
  const addContact = (event) => {
    event.preventDefault();
    void (async () => {
      const saved = await runMutation("new-contact", () => createAdminRideGuidanceContact({ env: window, contact: { ...newContact, name: newContact.name.trim(), phone: newContact.phone.trim(), note: newContact.note.trim() } }), "連絡先を追加");
      if (saved) setNewContact((current) => ({ ...current, name: "", phone: "", note: "" }));
    })();
  };
  const updateContact = (contact) => {
    void runMutation(contact.id, () => updateAdminRideGuidanceContact({ env: window, contact: { ...contact, name: contact.name.trim(), phone: contact.phone.trim(), note: contact.note.trim() }, expectedVersion: contact.version }), "連絡先を保存");
  };
  const deleteContact = (contact) => {
    if (typeof window.confirm === "function" && !window.confirm(`「${contact.name}」を削除しますか？`)) return;
    void runMutation(contact.id, () => deleteAdminRideGuidanceContact({ env: window, contactId: contact.id, expectedVersion: contact.version }), "連絡先を削除");
  };
  const moveContact = (type, index, direction) => {
    const group = state.contacts.filter((contact) => contact.type === type);
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= group.length) return;
    const ids = group.map((contact) => contact.id);
    [ids[index], ids[targetIndex]] = [ids[targetIndex], ids[index]];
    void runMutation(`order-${type}`, () => saveAdminRideGuidanceOrdering({ env: window, type, contactIds: ids }), "連絡先の並び順を保存");
  };

  const updateContactDraft = (id, patch) => setState((current) => ({ ...current, message: "", rowMessages: { ...current.rowMessages, [id]: "" }, contacts: current.contacts.map((contact) => contact.id === id ? { ...contact, ...patch } : contact) }));

  return <section className="ride-guidance-editor" aria-label="タクシー・運転代行案内">
    <header className="ride-guidance-editor__header">
      <div><span className="section-kicker">RIDE GUIDANCE</span><h2>タクシー・運転代行案内</h2><p>客席へ案内するお迎え先と連絡先を管理します。電話発信や外部配車は行いません。</p></div>
      <button className="button button--quiet" type="button" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>{expanded ? "閉じる" : "開く"}</button>
    </header>
    {expanded ? <div className="ride-guidance-editor__body">
      {state.loading && !state.pickup ? <p role="status">案内設定を読み込み中です。</p> : null}
      {!adminApiMode ? <p className="ride-guidance-editor__hint">管理API接続時に案内設定を編集できます。</p> : null}
      {state.error ? <p className="ride-guidance-editor__message is-error" role="alert">{state.error}</p> : null}
      <section className="ride-guidance-pickup" aria-label="お迎え先設定">
        <div className="ride-guidance-subheading"><div><h3>お迎え先</h3><p>客席から案内する店舗のお迎え先です。</p></div>{state.message ? <p className="ride-guidance-editor__message is-success" role="status">{state.message}</p> : null}</div>
        <div className="ride-guidance-pickup__fields"><label>呼び出し先名称<input value={pickupDraft.pickupLabel} maxLength={100} placeholder="例：お迎え先（当店）" onChange={(event) => { setPickupDraft((current) => ({ ...current, pickupLabel: event.target.value })); setState((current) => ({ ...current, message: "" })); }} disabled={!state.pickup || state.saving} /></label><label>店舗住所<input value={pickupDraft.pickupAddress} maxLength={300} onChange={(event) => { setPickupDraft((current) => ({ ...current, pickupAddress: event.target.value })); setState((current) => ({ ...current, message: "" })); }} disabled={!state.pickup || state.saving} /></label><button className="button button--primary" type="button" onClick={savePickup} disabled={!state.pickup || state.saving}>{state.saving ? "保存中" : "保存"}</button></div>
      </section>
      <section className="ride-guidance-contacts" aria-label="連絡先一覧">
        <div className="ride-guidance-subheading"><div><h3>連絡先一覧</h3><p>表示中の連絡先だけが客席向け公開APIに含まれます。</p></div>{state.message ? <p className="ride-guidance-editor__message is-success" role="status">{state.message}</p> : null}</div>
        <form className="ride-guidance-add" onSubmit={addContact}><label>種別<select value={newContact.type} onChange={(event) => setNewContact((current) => ({ ...current, type: event.target.value }))} disabled={state.saving}><option value="taxi">タクシー</option><option value="driver_service">運転代行</option></select></label><label>会社名<input required maxLength={100} value={newContact.name} onChange={(event) => setNewContact((current) => ({ ...current, name: event.target.value }))} disabled={state.saving} /></label><label>電話番号<input required maxLength={30} pattern="[0-9 +()\\-]+" value={newContact.phone} onChange={(event) => setNewContact((current) => ({ ...current, phone: event.target.value }))} disabled={state.saving} /></label><label>備考<input maxLength={200} value={newContact.note} onChange={(event) => setNewContact((current) => ({ ...current, note: event.target.value }))} disabled={state.saving} /></label><label className="ride-guidance-checkbox"><input type="checkbox" checked={newContact.isVisible} onChange={(event) => setNewContact((current) => ({ ...current, isVisible: event.target.checked }))} disabled={state.saving} /> 表示する</label><button className="button button--primary" type="submit" disabled={state.saving}>新規追加</button></form>
        <div className="ride-guidance-groups">{RIDE_GUIDANCE_TYPES.map(([type, label]) => { const group = state.contacts.filter((contact) => contact.type === type); return <section className="ride-guidance-group" key={type} aria-label={label}><h4>{label}</h4>{group.length ? group.map((contact, index) => <article className="ride-guidance-row" key={contact.id}><div className="ride-guidance-row__fields"><label>会社名<input maxLength={100} value={contact.name} onChange={(event) => updateContactDraft(contact.id, { name: event.target.value })} disabled={state.saving} /></label><label>電話番号<input maxLength={30} pattern="[0-9 +()\\-]+" value={contact.phone} onChange={(event) => updateContactDraft(contact.id, { phone: event.target.value })} disabled={state.saving} /></label><label>備考<input maxLength={200} value={contact.note} onChange={(event) => updateContactDraft(contact.id, { note: event.target.value })} disabled={state.saving} /></label><label>種別<select value={contact.type} onChange={(event) => updateContactDraft(contact.id, { type: event.target.value })} disabled={state.saving}><option value="taxi">タクシー</option><option value="driver_service">運転代行</option></select></label><label className="ride-guidance-checkbox"><input type="checkbox" checked={contact.isVisible} onChange={(event) => updateContactDraft(contact.id, { isVisible: event.target.checked })} disabled={state.saving} /> 表示する</label></div><div className="ride-guidance-row__actions"><button className="button button--quiet" type="button" onClick={() => moveContact(type, index, -1)} disabled={state.saving || index === 0}>上へ</button><button className="button button--quiet" type="button" onClick={() => moveContact(type, index, 1)} disabled={state.saving || index === group.length - 1}>下へ</button><button className="button button--primary" type="button" onClick={() => updateContact(contact)} disabled={state.saving}>保存</button><button className="button button--danger" type="button" onClick={() => deleteContact(contact)} disabled={state.saving}>削除</button></div>{state.rowMessages[contact.id] ? <p className={`ride-guidance-row__message ${state.rowMessages[contact.id].startsWith("保存しました") ? "is-success" : "is-error"}`} role={state.rowMessages[contact.id].startsWith("保存しました") ? "status" : "alert"}>{state.rowMessages[contact.id]}</p> : null}</article>) : <p className="ride-guidance-empty">登録されている連絡先はありません</p>}</section>; })}</div>
      </section>
    </div> : null}
  </section>;
}

function SessionMenuAccessPanel({ adminApiMode, menuItems }) {
  const [data, setData] = useState({ loading: Boolean(adminApiMode), saving: false, error: "", message: "", tables: [] });
  const [tableId, setTableId] = useState("");
  const [menuItemId, setMenuItemId] = useState("");
  const actionLockRef = useRef(false);
  const load = async () => {
    if (!adminApiMode) return;
    setData((current) => ({ ...current, loading: true, error: "" }));
    try {
      const result = await fetchAdminSessionMenuAccess({ env: window });
      setData((current) => ({ ...current, loading: false, tables: result.tables, error: "" }));
      if (result.tables.length && !result.tables.some((table) => String(table.tableId) === tableId)) setTableId(String(result.tables[0].tableId));
    } catch (error) {
      setData((current) => ({ ...current, loading: false, error: error?.status === 401 ? "401：管理者tokenを確認してください。" : "来店限定商品の状態を取得できませんでした。" }));
    }
  };
  useEffect(() => { void load(); }, [adminApiMode]);
  const table = data.tables.find((entry) => String(entry.tableId) === tableId);
  const restrictedItems = menuItems.filter((item) => item.customerVisibilityMode === "per_session" && item.isActive !== false);
  const grantedIds = new Set(table?.openSession?.menuItemIds ?? []);
  const availableItems = restrictedItems.filter((item) => !grantedIds.has(item.id));
  useEffect(() => { if (availableItems.length && !availableItems.some((item) => item.id === menuItemId)) setMenuItemId(availableItems[0].id); }, [tableId, menuItems, data.tables]);
  const mutate = async (action, itemId) => {
    if (!table || data.saving || actionLockRef.current) return;
    actionLockRef.current = true;
    setData((current) => ({ ...current, saving: true, error: "", message: "" }));
    try {
      if (action === "grant") await allowAdminSessionMenuItem({ env: window, tableId: table.tableId, menuItemId: itemId, expectedSessionId: table.openSession?.sessionId ?? null, expectedMenuItemIds: table.openSession?.menuItemIds ?? [], startIfMissing: !table.openSession });
      else await revokeAdminSessionMenuItem({ env: window, tableId: table.tableId, expectedSessionId: table.openSession.sessionId, expectedMenuItemIds: table.openSession.menuItemIds, menuItemId: itemId });
      const result = await fetchAdminSessionMenuAccess({ env: window });
      setData((current) => ({ ...current, saving: false, tables: result.tables, message: action === "grant" ? "現在の来店へ表示を許可しました。" : "現在の来店から表示許可を解除しました。" }));
    } catch (error) {
      const message = error?.status === 409 ? "来店状態が更新されています。最新状態を読み直してください。" : error?.status === 401 ? "401：管理者tokenを確認してください。" : "変更を保存できませんでした。";
      setData((current) => ({ ...current, saving: false, error: message }));
      if (error?.status === 409) await load();
    } finally {
      actionLockRef.current = false;
    }
  };
  const closeEmptySession = async () => {
    const selectedTable = table;
    const session = selectedTable?.openSession;
    if (!adminApiMode || !selectedTable || !session?.canCloseEmptySession || data.saving || actionLockRef.current) return;
    try {
      const outcome = await confirmAndCloseAdminEmptySession({
        env: window,
        tableId: selectedTable.tableId,
        tableLabel: selectedTable.label,
        sessionId: session.sessionId,
        actionLock: actionLockRef,
        onConfirmed: () => setData((current) => ({ ...current, saving: true, error: "", message: "" })),
      });
      if (outcome.cancelled) return;
      const refreshed = await fetchAdminSessionMenuAccess({ env: window });
      setData((current) => ({ ...current, loading: false, saving: false, tables: refreshed.tables, error: "", message: `${selectedTable.label}の注文のない来店を終了し、来店許可を解除しました。` }));
    } catch (error) {
      const message = error?.status === 409
        ? "来店状態が変わったか、注文または会計記録があるため終了できません。最新状態を再読込してください。"
        : error?.status === 401
          ? "401：管理者tokenを確認してください。"
          : "注文のない来店を終了できませんでした。状態を再読込してください。";
      try {
        const refreshed = await fetchAdminSessionMenuAccess({ env: window });
        setData((current) => ({ ...current, loading: false, saving: false, tables: refreshed.tables, error: message }));
      } catch {
        setData((current) => ({ ...current, loading: false, saving: false, error: message }));
      }
    }
  };
  return <section className="session-menu-access" aria-label="来店限定商品の許可管理">
    <header><div><span className="section-kicker">CURRENT VISIT</span><h2>来店ごとの表示許可</h2><p>表示方式の設定とは別に、選んだ商品の現在の来店への許可を管理します。席リセット後の来店には引き継がれません。</p></div><button type="button" className="button button--quiet" onClick={() => void load()} disabled={data.loading || data.saving}>状態を再読込</button></header>
    {!adminApiMode ? <p className="session-menu-access__notice" role="status">管理者API接続時に利用できます。</p> : null}
    {data.loading ? <p role="status">来店状態を読み込み中です。</p> : null}
    {data.error ? <p className="session-menu-access__error" role="alert">{data.error}</p> : null}
    {data.message ? <p className="session-menu-access__message" role="status">{data.message}</p> : null}
    {adminApiMode && !data.loading ? <>
      <div className="session-menu-access__controls"><label>テーブル<select value={tableId} onChange={(event) => setTableId(event.target.value)}>{data.tables.map((entry) => <option key={entry.tableId} value={entry.tableId}>{entry.label}</option>)}</select></label><label>来店限定商品<select value={menuItemId} onChange={(event) => setMenuItemId(event.target.value)} disabled={!availableItems.length}>{availableItems.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><button type="button" className="button button--primary" disabled={!table || !menuItemId || data.saving || !restrictedItems.length} onClick={() => void mutate("grant", menuItemId)}>{data.saving ? "保存中" : table?.openSession ? "現在の来店に許可" : "来店開始・許可"}</button></div>
      {table ? <div className="session-menu-access__status"><b>テーブル {table.tableId}・{table.label}</b>{table.openSession ? <span>現在の来店・開始 {formatDateTime(table.openSession.openedAtMs)}</span> : <span>open sessionなし。許可操作で来店を開始します。</span>}{table.openSession?.canCloseEmptySession ? <button type="button" className="button button--danger" disabled={data.saving} onClick={() => void closeEmptySession()}>{data.saving ? "終了中…" : "注文のない来店を終了"}</button> : null}</div> : <p>テーブルがありません。</p>}
      <h3>現在許可されている商品</h3>
      {table?.openSession && table.openSession.menuItemIds.length ? <ul>{table.openSession.menuItemIds.map((id) => { const item = menuItems.find((entry) => entry.id === id); return <li key={id}><span>{item?.name ?? "登録商品"}</span><button type="button" className="button button--quiet" disabled={data.saving} onClick={() => void mutate("revoke", id)}>許可を解除</button></li>; })}</ul> : <p className="session-menu-access__empty">この来店で許可された商品はありません。</p>}
      {!restrictedItems.length ? <p className="session-menu-access__empty">商品編集で「来店ごとに許可」にした商品がありません。</p> : null}
    </> : null}
  </section>;
}
function TableVisibilityFields({ tables, mode = "all_tables", selectedTableIds = [], disabled = false }) {
  const [currentMode, setCurrentMode] = useState(mode);
  const [currentTableIds, setCurrentTableIds] = useState(selectedTableIds);
  return <fieldset className="menu-table-visibility" disabled={disabled}>
    <legend>テーブル別表示</legend>
    <label><input type="radio" name="tableVisibilityMode" value="all_tables" checked={currentMode === "all_tables"} onChange={() => setCurrentMode("all_tables")} /> 全テーブルに表示</label>
    <label><input type="radio" name="tableVisibilityMode" value="selected_tables" checked={currentMode === "selected_tables"} disabled={!tables.length} onChange={() => setCurrentMode("selected_tables")} /> 指定テーブルだけに表示</label>
    <label><input type="radio" name="tableVisibilityMode" value="except_selected_tables" checked={currentMode === "except_selected_tables"} disabled={!tables.length} onChange={() => setCurrentMode("except_selected_tables")} /> 指定テーブルだけで非表示</label>
    {currentMode !== "all_tables" ? <div className="menu-table-visibility__tables" aria-label="対象テーブル">
      {tables.map((table) => <label key={table.tableId}><input type="checkbox" name="tableVisibilityTableIds" value={table.tableId} checked={currentTableIds.includes(table.tableId)} onChange={(event) => setCurrentTableIds((ids) => event.target.checked ? [...ids, table.tableId] : ids.filter((id) => id !== table.tableId))} /> {table.label}</label>)}
      {!tables.length ? <span>テーブル一覧を取得できません。</span> : null}
    </div> : null}
  </fieldset>;
}

function AdminScreen({ state, updateState, section = "menu" }) {
  const adminApiMode = Boolean(configuredAdminToken(window));
  const [showAdd, setShowAdd] = useState(false);
  const [editingMenuId, setEditingMenuId] = useState(null);
  const [menuEditorCategoryId, setMenuEditorCategoryId] = useState("");
  const [menuEditorSortOrder, setMenuEditorSortOrder] = useState(1);
  const [menuEditorPlacementEdge, setMenuEditorPlacementEdge] = useState(null);
  const [menuEditorDirty, setMenuEditorDirty] = useState(false);
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
  const [tableVisibilityTables, setTableVisibilityTables] = useState(adminApiMode ? [] : [1, 2, 3, 4].map((tableId) => ({ tableId, label: `テーブル ${tableId}` })));
  const [tableVisibilityTablesError, setTableVisibilityTablesError] = useState(false);
  const [reorderMode, setReorderMode] = useState(false);
  const [reorderCategoryId, setReorderCategoryId] = useState("");
  const [reorderDraftIds, setReorderDraftIds] = useState([]);
  const [reorderBaseIds, setReorderBaseIds] = useState([]);
  const [draggedMenuId, setDraggedMenuId] = useState(null);
  const [categoryEditorId, setCategoryEditorId] = useState(null);
  const [adminMenuSection, setAdminMenuSection] = useState("all");
  const [adminMenuCategory, setAdminMenuCategory] = useState("all");
  const [showArchivedMenuItems, setShowArchivedMenuItems] = useState(false);
  const [archivedMenuItems, setArchivedMenuItems] = useState([]);
  const [menuItemLifecycle, setMenuItemLifecycle] = useState(null);
  const [menuLifecycleDiscardPrompt, setMenuLifecycleDiscardPrompt] = useState(null);
  const menuCardRefs = useRef(new Map());
  const menuScrollAnchor = useRef(null);
  const menuSaveLockRef = useRef(false);
  const menuCreateIdRef = useRef(null);
  const menuCreateMayHaveCommittedRef = useRef(false);
  const menuCreateAttemptRef = useRef(null);
  const [businessHoursState, setBusinessHoursState] = useState({ loading: adminApiMode && section === "hours", saving: false, error: false, message: "", messageKind: "", formal: null, draft: DEFAULT_BUSINESS_HOURS });
  useEffect(() => {
    if (!adminApiMode || !["menu", "categories", "menu-access"].includes(section)) return undefined;
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
    if (!adminApiMode || section !== "menu") return undefined;
    let cancelled = false;
    fetchAdminSessionMenuAccess({ env: window }).then((result) => {
      if (!cancelled) {
        setTableVisibilityTables(result.tables.map(({ tableId, label }) => ({ tableId, label })));
        setTableVisibilityTablesError(false);
      }
    }).catch(() => { if (!cancelled) setTableVisibilityTablesError(true); });
    return () => { cancelled = true; };
  }, [adminApiMode, section]);
  const loadBusinessHours = async () => {
    if (!adminApiMode) return null;
    setBusinessHoursState((current) => ({ ...current, loading: true, error: false, message: "", messageKind: "" }));
    try {
      const formal = await fetchAdminBusinessHours({ env: window });
      setBusinessHoursState({ loading: false, saving: false, error: false, message: "", messageKind: "", formal, draft: formal });
      return formal;
    } catch (error) {
      const message = error?.code === "AUTH_TOKEN_MISMATCH" || error?.status === 401
        ? "401：管理者tokenを確認してください。"
        : error?.code === "API_UNAVAILABLE" || error?.status === 503
          ? "営業時間設定を取得できません。管理APIを確認してください。"
          : "営業時間設定を取得できません。";
      setBusinessHoursState((current) => ({ ...current, loading: false, error: true, message, messageKind: "error" }));
      return null;
    }
  };
  useEffect(() => {
    if (!adminApiMode || section !== "hours") {
      setBusinessHoursState({ loading: false, saving: false, error: false, message: "", messageKind: "", formal: null, draft: DEFAULT_BUSINESS_HOURS });
      return undefined;
    }
    void loadBusinessHours();
    return undefined;
  }, [adminApiMode, section]);
  const updateBusinessHoursDraft = (patch) => setBusinessHoursState((current) => ({ ...current, draft: { ...current.draft, ...patch }, message: "", messageKind: "" }));
  const discardBusinessHours = () => setBusinessHoursState((current) => current.formal ? ({ ...current, draft: current.formal, message: "", messageKind: "" }) : current);
  const saveBusinessHours = async () => {
    if (!adminApiMode || businessHoursState.saving || !businessHoursState.formal) return;
    if (businessHoursState.draft.noticeEnabled === true && !(businessHoursState.draft.noticeText ?? "").trim()) {
      setBusinessHoursState((current) => ({ ...current, error: true, message: "案内を表示する場合は本文を入力してください。", messageKind: "error" }));
      return;
    }
    setBusinessHoursState((current) => ({ ...current, saving: true, error: false, message: "", messageKind: "" }));
    try {
      const requested = withBusinessHoursNotice(businessHoursState.draft);
      await saveAdminBusinessHours({ env: window, settings: requested, expectedVersion: businessHoursState.formal.version });
      const formal = await fetchAdminBusinessHours({ env: window });
      const matches = formal.openTime === requested.openTime
        && formal.closeTime === requested.closeTime
        && formal.lastOrderTime === requested.lastOrderTime
        && formal.isVisible === requested.isVisible
        && formal.noticeText === requested.noticeText
        && formal.noticeEnabled === requested.noticeEnabled;
      if (!matches) throw new Error("営業時間設定の再取得値が保存値と一致しません。");
      setBusinessHoursState({ loading: false, saving: false, error: false, message: `保存しました（version ${formal.version}）。`, messageKind: "success", formal, draft: formal });
    } catch (error) {
      const message = error?.code === "BUSINESS_HOURS_CONFLICT" || error?.status === 409
        ? "409：別の管理端末で更新されています。再読込してから保存してください。"
        : error?.code === "AUTH_TOKEN_MISMATCH" || error?.status === 401
          ? "401：管理者tokenを確認してください。"
          : "営業時間を保存できませんでした。正式値は変更していません。";
      setBusinessHoursState((current) => ({ ...current, saving: false, error: true, message, messageKind: "error" }));
    }
  };
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
  const selectedMenuCategoryId = menuEditorCategoryId || editingMenu?.categoryId || state.categories[0]?.id || "";
  const selectedMenuCategoryItems = state.menuItems.filter((item) => item.categoryId === selectedMenuCategoryId);
  const selectedMenuCategoryItemsForPlacement = selectedMenuCategoryItems.filter((item) => item.id !== editingMenuId);
  const selectedMenuCategoryCount = selectedMenuCategoryItemsForPlacement.length + (editingMenu ? 1 : 0);
  const menuPlacementValue = (edge) => {
    if (!selectedMenuCategoryItemsForPlacement.length) return 1;
    const orders = selectedMenuCategoryItemsForPlacement.map((item) => Number(item.sortOrder) || 0);
    return edge === "first" ? Math.max(0, Math.min(...orders) - 1) : Math.max(...orders) + 1;
  };
  const setMenuEditorEdge = (edge, form) => {
    const value = menuPlacementValue(edge);
    setMenuEditorPlacementEdge(edge);
    setMenuEditorSortOrder(value);
    const input = form?.elements.namedItem("sortOrder");
    if (input) input.value = String(value);
  };
  const menuIdsForPlacement = (items, categoryId, itemId, edge) => {
    const otherIds = items.filter((item) => item.categoryId === categoryId && item.id !== itemId).sort(compareMenuItems).map((item) => item.id);
    return edge === "first" ? [itemId, ...otherIds] : [...otherIds, itemId];
  };
  const persistMenuEdgePlacement = async (categoryId, itemId, edge) => {
    const persist = async (items, categories) => {
      const category = categories.find((entry) => entry.id === categoryId);
      if (!category) throw new Error("商品カテゴリーを再取得してください。");
      return saveAdminMenuOrdering({ env: window, categoryId, menuItemIds: menuIdsForPlacement(items, categoryId, itemId, edge), expectedVersion: category.version ?? 0 });
    };
    try {
      await persist(state.menuItems, state.categories);
      return true;
    } catch {
      try {
        const latest = mapAdminCatalogState(await fetchAdminMenu({ env: window }));
        await persist(latest.menuItems, latest.categories);
        return true;
      } catch {
        return false;
      }
    }
  };
  const applyLocalMenuPlacement = (items, categoryId, itemId, edge) => {
    const orderedIds = menuIdsForPlacement(items, categoryId, itemId, edge);
    const orderById = new Map(orderedIds.map((id, index) => [id, (index + 1) * 10]));
    return items.map((item) => orderById.has(item.id) ? { ...item, sortOrder: orderById.get(item.id) } : item);
  };
  const openNewMenuEditor = () => {
    setMenuEditorDirty(false);
    menuCreateIdRef.current = makeId("menu");
    menuCreateMayHaveCommittedRef.current = false;
    menuCreateAttemptRef.current = null;
    const categoryId = state.categories[0]?.id ?? "";
    setEditingMenuId(null);
    setMenuEditorCategoryId(categoryId);
    setMenuEditorSortOrder(state.menuItems.filter((item) => item.categoryId === categoryId).length + 1);
    setMenuEditorPlacementEdge(null);
    setShowAdd(true);
  };
  const selectedMenuCategory = state.categories.find((category) => category.id === selectedMenuCategoryId);
  const editingMenuIsFood = selectedMenuCategory?.sectionKey === "food" || /^(food-|special-)/.test(selectedMenuCategoryId);
  const descriptionFieldLabel = editingMenuIsFood ? "料理説明" : "商品説明／一言コメント";
  const setMenuItem = (id, patch) => updateState((current) => ({ ...current, menuItems: current.menuItems.map((item) => item.id === id ? { ...item, ...patch } : item) }));
  const setCategory = (id, patch) => updateState((current) => ({ ...current, categories: current.categories.map((item) => item.id === id ? { ...item, ...patch } : item) }));
  const rememberMenuPosition = (id) => {
    const node = menuCardRefs.current.get(id);
    if (node) menuScrollAnchor.current = { id, top: node.getBoundingClientRect().top };
  };
  const openMenuEditor = (id) => {
    setMenuEditorDirty(false);
    menuCreateIdRef.current = null;
    menuCreateMayHaveCommittedRef.current = false;
    menuCreateAttemptRef.current = null;
    rememberMenuPosition(id);
    setEditingMenuId(id);
    const item = state.menuItems.find((entry) => entry.id === id);
    setMenuEditorCategoryId(item?.categoryId ?? "");
    setMenuEditorSortOrder(item?.sortOrder ?? 1);
    setMenuEditorPlacementEdge(null);
    setShowAdd(true);
  };
  const closeMenuEditor = () => {
    const anchor = menuScrollAnchor.current;
    menuCreateIdRef.current = null;
    menuCreateAttemptRef.current = null;
    setShowAdd(false);
    setMenuEditorDirty(false);
    setEditingMenuId(null);
    if (anchor) window.requestAnimationFrame(() => {
      const node = menuCardRefs.current.get(anchor.id);
      if (node) window.scrollBy(0, node.getBoundingClientRect().top - anchor.top);
      menuScrollAnchor.current = null;
    });
  };
  useEffect(() => {
    if (!editingMenuId || !showAdd) return undefined;
    const timer = window.requestAnimationFrame(() => document.querySelector(".menu-editor--editing")?.scrollIntoView({ behavior: "smooth", block: "start" }));
    return () => window.cancelAnimationFrame(timer);
  }, [editingMenuId, showAdd]);
  const addMenu = async (event) => {
    event.preventDefault();
    if (catalogState.saving) return;
    await runWithSubmissionLock(menuSaveLockRef, () => saveMenuEditor(event));
  };
  const saveMenuEditor = async (event) => {
    const form = new FormData(event.currentTarget);
    const name = form.get("name")?.toString().trim();
    const kitchenAlias = form.get("kitchenAlias")?.toString().trim();
    if (!name) return;
    const tableVisibilityMode = form.get("tableVisibilityMode")?.toString() || "all_tables";
    const tableVisibilityTableIds = form.getAll("tableVisibilityTableIds").map(Number);
    if (tableVisibilityMode !== "all_tables" && tableVisibilityTableIds.length === 0) {
      setCatalogState((current) => ({ ...current, message: "指定モードでは対象テーブルを1つ以上選択してください。" }));
      return;
    }
    const targetId = editingMenuId ?? (menuCreateIdRef.current ??= makeId("menu"));
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
      customerVisibilityMode: form.get("customerVisibilityMode") === "per_session" ? "per_session" : "all_tables",
      tableVisibilityMode,
      tableVisibilityTableIds: tableVisibilityMode === "all_tables" ? [] : tableVisibilityTableIds,
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
      sortOrder: Number.isSafeInteger(Number(form.get("sortOrder"))) ? Number(form.get("sortOrder")) : editingMenu?.sortOrder ?? 1,
    } : {
      ...patch,
      isSoldOut: false,
      isActive: true,
      sortOrder: Number.isSafeInteger(Number(form.get("sortOrder"))) ? Number(form.get("sortOrder")) : state.menuItems.filter((item) => item.categoryId === form.get("categoryId")).length + 1,
    };
    setCatalogState((current) => ({ ...current, saving: adminApiMode, message: "" }));
    if (adminApiMode) {
      try {
        let retryItem = null;
        if (!editingMenuId && menuCreateMayHaveCommittedRef.current) {
          const latest = await fetchAdminMenu({ env: window });
          retryItem = latest.items.find((item) => item.menuItemId === targetId) ?? null;
        }
        let result;
        if (!editingMenuId && retryItem && JSON.stringify(nextItem) === JSON.stringify(menuCreateAttemptRef.current)) {
          result = { version: retryItem.version };
        } else {
          if (!editingMenuId) menuCreateAttemptRef.current = nextItem;
          result = await saveAdminMenuItem({ env: window, item: nextItem, expectedVersion: editingMenu?.version ?? retryItem?.version ?? 0 });
        }
        const placementSaved = menuEditorPlacementEdge ? await persistMenuEdgePlacement(nextItem.categoryId, nextItem.id, menuEditorPlacementEdge) : true;
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
          customerVisibilityMode: refreshedItem.customerVisibilityMode ?? "all_tables",
          tableVisibilityMode: refreshedItem.tableVisibilityMode ?? "all_tables",
          tableVisibilityTableIds: refreshedItem.tableVisibilityTableIds ?? [],
          isActive: refreshedItem.isActive,
          sortOrder: refreshedItem.sortOrder,
          version: refreshedItem.version,
          detail: refreshedItem.detail,
          variants: refreshedItem.variants ?? [],
          servingOptions: refreshedItem.servingOptions ?? [],
          imageLayouts: refreshedItem.imageLayouts,
        };
        setCatalogState({ loading: false, error: false, saving: false, message: placementSaved ? "保存しました。" : "商品は保存しましたが、並び順を確定できませんでした。並び替えモードで確認してください。" });
        updateState((current) => editingMenuId || retryItem ? ({
          ...current,
          menuItems: current.menuItems.some((item) => item.id === targetId)
            ? current.menuItems.map((item) => item.id === targetId ? refreshedPatch : item)
            : [...current.menuItems, refreshedPatch],
        }) : ({ ...current, menuItems: [...current.menuItems, refreshedPatch] }));
        setShowAdd(false);
        setEditingMenuId(null);
        setMenuEditorPlacementEdge(null);
        menuCreateMayHaveCommittedRef.current = false;
        menuCreateIdRef.current = null;
        menuCreateAttemptRef.current = null;
        return;
      } catch (error) {
        if (!editingMenuId) menuCreateMayHaveCommittedRef.current = true;
        const failureDetail = error?.status
          ? `HTTP ${error.status} / ${error.code || "UNKNOWN_ERROR"}${error.requestId ? ` / request ID ${error.requestId}` : ""}`
          : "管理APIへ接続できません";
        setCatalogState({ loading: false, error: false, saving: false, message: error?.code === "CATALOG_CONFLICT" ? "別の管理端末で更新されています。再読込してから保存してください。" : `保存できませんでした（${failureDetail}）。` });
        return;
      }
    }
    updateState((current) => editingMenuId ? ({
      ...current,
      menuItems: (() => {
        const editedItems = current.menuItems.map((item) => item.id === editingMenuId ? { ...item, ...nextItem } : item);
        return menuEditorPlacementEdge
          ? applyLocalMenuPlacement(editedItems, nextItem.categoryId, editingMenuId, menuEditorPlacementEdge)
          : editedItems;
      })(),
    }) : ({
      ...current,
      menuItems: menuEditorPlacementEdge
        ? applyLocalMenuPlacement([...current.menuItems, { ...nextItem, ...patch }], nextItem.categoryId, nextItem.id, menuEditorPlacementEdge)
        : [...current.menuItems, { ...nextItem, ...patch }],
    }));
    setShowAdd(false);
    setEditingMenuId(null);
    setMenuEditorPlacementEdge(null);
    menuCreateMayHaveCommittedRef.current = false;
    menuCreateIdRef.current = null;
    menuCreateAttemptRef.current = null;
  };
  const refreshAdminCatalog = async () => {
    const catalog = await fetchAdminMenu({ env: window });
    updateState((current) => ({ ...current, ...mapAdminCatalogState(catalog) }));
    return catalog;
  };
  const refreshArchivedMenuItems = async () => {
    const items = await fetchArchivedAdminMenuItems({ env: window });
    setArchivedMenuItems(items);
    return items;
  };
  const requestMenuItemLifecycle = (item) => {
    if (editingMenuId === item.id && menuEditorDirty) {
      setMenuLifecycleDiscardPrompt(item);
      return;
    }
    void openMenuItemLifecycle(item);
  };
  const discardMenuEditsAndOpenLifecycle = () => {
    const item = menuLifecycleDiscardPrompt;
    setMenuLifecycleDiscardPrompt(null);
    if (!item) return;
    closeMenuEditor();
    void openMenuItemLifecycle(item);
  };
  const openMenuItemLifecycle = async (item) => {
    if (!adminApiMode) {
      setCatalogState((current) => ({ ...current, message: "削除・アーカイブは認証済み管理API接続時に利用できます。" }));
      return;
    }
    setMenuItemLifecycle({ kind: "checking", item, busy: true, error: "" });
    try {
      const preview = await previewAdminMenuItemLifecycle({ env: window, menuItemId: item.id, expectedVersion: item.version });
      setMenuItemLifecycle({ kind: preview.disposition, item: { ...item, name: preview.formalName }, expectedVersion: preview.version, disposition: preview.disposition, busy: false, error: "" });
    } catch (error) {
      setMenuItemLifecycle(null);
      setCatalogState({ loading: false, error: false, saving: false, message: error?.status === 409 ? "商品が更新されています。管理一覧を再読込してから操作してください。" : "商品を処理できるか確認できませんでした。" });
    }
  };
  const openArchivedRestore = (item) => setMenuItemLifecycle({ kind: "restore", item: { id: item.menuItemId, name: item.formalName, categoryId: item.categoryId, version: item.version }, expectedVersion: item.version, busy: false, error: "" });
  const confirmMenuItemLifecycle = async () => {
    if (!menuItemLifecycle || menuItemLifecycle.busy || menuItemLifecycle.kind === "checking") return;
    const current = menuItemLifecycle;
    setMenuItemLifecycle((value) => ({ ...value, busy: true, error: "" }));
    try {
      if (current.kind === "restore") {
        await restoreArchivedAdminMenuItem({ env: window, menuItemId: current.item.id, expectedVersion: current.expectedVersion });
      } else {
        await executeAdminMenuItemLifecycle({ env: window, menuItemId: current.item.id, expectedVersion: current.expectedVersion, expectedDisposition: current.disposition });
      }
      await refreshAdminCatalog();
      await refreshArchivedMenuItems();
      setMenuItemLifecycle(null);
      setCatalogState({ loading: false, error: false, saving: false, message: current.kind === "restore" ? "商品を客席非表示で復帰しました。表示する場合は通常編集から変更してください。" : current.disposition === "archive" ? "商品をアーカイブしました。注文履歴と画像ファイルは保持されています。" : "商品を削除しました。画像ファイルは保持されています。" });
    } catch (error) {
      setMenuItemLifecycle((value) => ({ ...value, busy: false, error: error?.status === 409 ? "確認後に商品または注文履歴が更新されました。管理一覧を再読込し、内容を確認してから再操作してください。" : "処理を完了できませんでした。商品は変更されていません。" }));
      if (error?.status === 409) {
        try { await refreshAdminCatalog(); await refreshArchivedMenuItems(); } catch { /* Keep the confirmation error visible. */ }
      }
    }
  };
  const toggleArchivedMenuItems = async () => {
    const next = !showArchivedMenuItems;
    setShowArchivedMenuItems(next);
    if (next && adminApiMode) {
      try { await refreshArchivedMenuItems(); }
      catch { setCatalogState((value) => ({ ...value, message: "アーカイブ商品を取得できませんでした。" })); }
    }
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
    closeMenuEditor();
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
  const adminSectionOptions = [...new Set(sortedCategories.map(adminCategorySection))];
  const filteredMenuGroups = menuGroups
    .filter(({ category }) => adminMenuCategory === "all" || category.id === adminMenuCategory)
    .filter(({ category }) => adminMenuSection === "all" || adminCategorySection(category) === adminMenuSection);
  const displayedMenuGroups = reorderMode && selectedReorderGroup ? [selectedReorderGroup] : filteredMenuGroups;
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
    <StaffShell route={`/admin/${section}`} title={section === "hours" ? "営業時間" : section === "ride-guidance" ? "タクシー／代行料金" : section === "categories" ? "カテゴリ管理" : section === "customer-theme" ? "客席レール" : section === "customer-order-notice" ? "注文前注意事項" : section === "menu-access" ? "来店限定商品" : "メニュー管理"} subtitle={section === "hours" ? "客席とスタッフ画面に表示する営業時間を設定します。" : section === "ride-guidance" ? "タクシー・運転代行の案内と料金情報を管理します。" : section === "customer-theme" ? "客席画面だけに表示する左レールテーマを設定します。" : section === "customer-order-notice" ? "客席が注文を始める前に確認する店舗ルールを設定します。" : section === "menu-access" ? "商品ごとの現在の来店許可を管理します。" : "メニューの追加・編集・並び順の変更ができます。"} state={state}>
      <section className="admin-content">
        <nav className="admin-tabs">{adminTabs.map((tab) => <button key={tab.id} className={section === tab.id ? "is-active" : ""} onClick={() => { resetMenuEditor(); navigate(`/admin/${tab.id}`); }}><tab.icon size={24} weight="bold" /> {tab.label}</button>)}</nav>

        {adminApiMode && catalogState.loading ? <p className="empty-state">管理カタログを読み込み中です。</p> : null}
        {adminApiMode && catalogState.error ? <p className="empty-state" role="alert">{catalogState.message}</p> : null}
        {section === "menu" && tableVisibilityTablesError ? <p className="session-menu-access__error" role="alert">テーブル別表示の対象一覧を取得できません。管理APIへ接続して再読込してください。</p> : null}
        {section === "menu" && catalogState.message && !catalogState.error ? <p className="session-menu-access__message" role="status">{catalogState.message}</p> : null}

        {section === "menu-access" ? <SessionMenuAccessPanel adminApiMode={adminApiMode} menuItems={state.menuItems} /> : null}
        {section === "menu" ? <>
           <div className="admin-toolbar"><div className="admin-metrics"><span>登録数 <b>{state.menuItems.length}</b> 品</span><span>売り切れ <b>{Math.max(2, state.menuItems.filter((item) => item.isSoldOut).length)}</b> 品</span></div><div className="admin-toolbar__actions"><button className="button button--outline" type="button" disabled={!adminApiMode} onClick={() => void toggleArchivedMenuItems()}>{showArchivedMenuItems ? "通常の商品一覧" : "アーカイブ商品"}</button><button className="button button--outline" type="button" onClick={() => reorderMode ? cancelReorder() : beginReorder()}>{reorderMode ? "通常編集へ戻る" : "並び替えモード"}</button><button className="button button--outline button--large" onClick={() => showAdd ? closeMenuEditor() : openNewMenuEditor()}><Plus size={28} weight="bold" /> {showAdd ? "編集を閉じる" : "新しいメニューを追加"}</button></div></div>
           {showArchivedMenuItems ? <section className="menu-archive-list" aria-label="アーカイブ商品"><h2>アーカイブ商品</h2>{archivedMenuItems.length ? archivedMenuItems.map((item) => <article key={item.menuItemId}><div><b>{item.formalName}</b><span>{categoriesById[item.categoryId]?.name ?? item.categoryId} ・ {yen(item.priceYen)} ・ {new Date(item.archivedAtMs).toLocaleString("ja-JP")}にアーカイブ</span></div><button className="button button--outline" type="button" onClick={() => openArchivedRestore(item)}>復帰</button></article>) : <p>アーカイブ商品はありません。</p>}</section> : null}
           <div className="admin-menu-filters" aria-label="メニューカテゴリ切替">
             <div className="admin-menu-filters__row" role="tablist" aria-label="大分類">
               {[['all', 'すべて'], ...adminSectionOptions.map((id) => [id, ({ food: 'フード', drink: 'ドリンク', winter: '冬季限定', seasonal: '季節・気まぐれ' }[id] || id)])].map(([id, label]) => <button type="button" role="tab" aria-selected={adminMenuSection === id} className={adminMenuSection === id ? 'is-active' : ''} key={id} onClick={() => { setAdminMenuSection(id); setAdminMenuCategory('all'); }}>{label}</button>)}
             </div>
             <div className="admin-menu-filters__row admin-menu-filters__row--sub" role="tablist" aria-label="細分類">
               <button type="button" role="tab" aria-selected={adminMenuCategory === 'all'} className={adminMenuCategory === 'all' ? 'is-active' : ''} onClick={() => setAdminMenuCategory('all')}>すべて</button>
               {sortedCategories.filter((category) => adminMenuSection === 'all' || adminCategorySection(category) === adminMenuSection).map((category) => <button type="button" role="tab" aria-selected={adminMenuCategory === category.id} className={adminMenuCategory === category.id ? 'is-active' : ''} key={category.id} onClick={() => setAdminMenuCategory(category.id)}>{category.name}</button>)}
             </div>
           </div>
           {reorderMode ? <div className="menu-reorder-toolbar"><label>対象カテゴリー<select value={reorderCategoryId} onChange={(event) => { const next = menuGroups.find((group) => group.category.id === event.target.value); setReorderCategoryId(event.target.value); setReorderDraftIds(next?.items.map((item) => item.id) ?? []); setReorderBaseIds(next?.items.map((item) => item.id) ?? []); }} disabled={catalogState.saving}>{menuGroups.map((group) => <option key={group.category.id} value={group.category.id}>{group.category.name}</option>)}</select></label><button className="button button--quiet" type="button" onClick={cancelReorder} disabled={catalogState.saving}>キャンセル</button><button className="button button--primary" type="button" onClick={saveReorder} disabled={catalogState.saving}>{catalogState.saving ? "保存中" : "並び順を保存"}</button></div> : null}
          {showAdd ? <form className={`inline-form inline-form--menu menu-editor${editingMenu ? " menu-editor--editing" : ""}`} key={editingMenuId ?? "new-menu"} onSubmit={addMenu} onChange={() => setMenuEditorDirty(true)}>
            <div className="menu-editor__heading"><b>{editingMenu ? `${editingMenu.name}を編集` : "新しい商品を追加"}</b><span>{editingMenu ? "既存の商品IDを保ったまま更新します。" : "商品を新規登録します。"}</span></div>
            <label>正式名<input name="name" required placeholder="例：だし巻き玉子" defaultValue={editingMenu?.name ?? ""} /></label>
            <label>厨房用の通称<input name="kitchenAlias" required placeholder="例：だし巻き" defaultValue={editingMenu?.kitchenAlias ?? DEFAULT_KITCHEN_MENU_ALIASES[editingMenu?.id] ?? ""} /></label>
            <label>カテゴリ<select name="categoryId" value={selectedMenuCategoryId} onChange={(event) => { const nextCategoryId = event.target.value; const peers = state.menuItems.filter((item) => item.categoryId === nextCategoryId && item.id !== editingMenuId); setMenuEditorCategoryId(nextCategoryId); setMenuEditorSortOrder(peers.length ? Math.max(...peers.map((item) => Number(item.sortOrder) || 0)) + 1 : 1); setMenuEditorPlacementEdge(null); }}>{state.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
            <label>税込マスター価格<input name="price" type="number" min="0" step="1" defaultValue={editingMenu?.price ?? 500} /></label>
            <label className="menu-editor__wide">{descriptionFieldLabel}<textarea name="description" defaultValue={editingMenu?.description ?? ""} /></label>
            <div className="menu-editor__sort-order"><label><span>並び順 <small>{selectedMenuCategoryCount}品</small></span><input name="sortOrder" type="number" min="0" step="1" value={menuEditorSortOrder} onChange={(event) => { setMenuEditorSortOrder(event.target.value === "" ? "" : Number(event.target.value)); setMenuEditorPlacementEdge(null); }} /></label><div className="menu-editor__sort-order-actions"><button className="button button--quiet" type="button" onClick={(event) => setMenuEditorEdge("first", event.currentTarget.form)}>{editingMenu ? "最上段へ移動" : "最上段に追加"}</button><button className="button button--quiet" type="button" onClick={(event) => setMenuEditorEdge("last", event.currentTarget.form)}>{editingMenu ? "最下段へ移動" : "最下段に追加"}</button></div></div>
            <details className="menu-editor__section"><summary>商品詳細（ふりがな・産地・蔵元・味・説明・おすすめ）</summary><div className="menu-editor__section-body">
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
            </div></details>
            <details className="menu-editor__section"><summary>販売・客席表示（売り切れ・注文方法・表示先）</summary><div className="menu-editor__section-body">
            <label>客席での表示<select name="customerVisibilityMode" defaultValue={editingMenu?.customerVisibilityMode ?? "all_tables"}><option value="all_tables">全テーブル</option><option value="per_session">来店ごとに許可</option></select></label>
            <TableVisibilityFields tables={tableVisibilityTables} mode={editingMenu?.tableVisibilityMode ?? "all_tables"} selectedTableIds={editingMenu?.tableVisibilityTableIds ?? []} />
            <label className="menu-editor__check"><input type="checkbox" name="isSoldOut" defaultChecked={editingMenu?.isSoldOut ?? false} /> 売り切れ</label>
            <fieldset className="menu-ordering-mode"><legend>注文方法</legend><label><input type="radio" name="orderingMode" value="normal" defaultChecked={(editingMenu?.orderingMode ?? "normal") === "normal"} /> 注文方法：通常注文</label><label><input type="radio" name="orderingMode" value="reservation_only" defaultChecked={editingMenu?.orderingMode === "reservation_only"} /> 注文方法：予約限定</label></fieldset>
            <label className="menu-editor__check"><input type="checkbox" name="isActive" defaultChecked={editingMenu?.isActive !== false} /> 客席に表示</label>
            </div></details>
            <details className="menu-editor__section"><summary>画像・一覧／詳細表示</summary><div className="menu-editor__section-body">
            <ProductImageUriField name="imageUri" label="商品画像URI" initialUri={editingMenu?.imageUri ?? ""} resolveDisplayUri={selectedMenuCategoryId === "shochu" ? shochuThumbUri : undefined} />
            <label className="menu-editor__check"><input type="checkbox" name="showImageInList" defaultChecked={editingMenu?.detail?.showImageInList ?? selectedMenuCategoryId === "shochu"} /> 一覧に画像を表示（日本酒は常時表示）</label>
            <label className="menu-editor__check"><input type="checkbox" name="detailEnabled" defaultChecked={editingMenu?.detail?.enabled ?? false} /> 詳細表示を有効にする</label>
            <ProductImageUriField name="detailImageUri" label="詳細画像URI" initialUri={editingMenu?.detail?.imageUri ?? ""} fallbackUri={editingMenu?.imageUri ?? ""} />
            </div></details>
            <details className="menu-editor__section"><summary>提供方法・容量・温度・価格</summary><div className="menu-editor__section-body">
            <label>焼酎内の区分<select name="sectionKey" defaultValue={editingMenu?.sectionKey ?? ""}><option value="">なし</option><option value="芋">芋</option><option value="麦・その他">麦・その他</option></select></label>
            <label className="menu-editor__check"><input type="checkbox" name="shochuOptions" defaultChecked={Boolean(editingMenu?.servingOptions?.length)} /> 焼酎の標準4種の飲み方を使用</label>
            {editingMenu?.id && foodVariantDefinitions(editingMenu).length ? <fieldset className="food-variant-editor"><legend>variant（税込）</legend>{foodVariantDefinitions(editingMenu).map(({ name, index }) => <div key={name}><label>{name}<input name={`foodVariantName${index}`} defaultValue={editingMenu.variants?.[index]?.name ?? name} /></label><label>税込価格<input name={`foodVariantPrice${index}`} type="number" min="0" step="1" defaultValue={editingMenu.variants?.[index]?.priceYen ?? 0} /></label><label className="menu-editor__check"><input type="checkbox" name={`foodVariantActive${index}`} defaultChecked={editingMenu.variants?.[index]?.isActive !== false} /> 販売中</label></div>)}</fieldset> : selectedMenuCategoryId === "sake" || editingMenu?.categoryId === "sake" ? <fieldset className="sake-variant-editor"><legend>日本酒variant（税込・提供温度）</legend><div><label>グラス 110ml<input name="glassPrice" type="number" min="0" defaultValue={editingMenu?.variants?.find((variant) => variant.name === "グラス")?.priceYen ?? ""} /></label><label><input type="checkbox" name="glassCold" defaultChecked={editingMenu?.variants?.find((variant) => variant.name === "グラス")?.temperatureOptions?.includes("冷酒") ?? true} /> 冷酒</label><label><input type="checkbox" name="glassHot" defaultChecked={editingMenu?.variants?.find((variant) => variant.name === "グラス")?.temperatureOptions?.includes("燗酒") ?? false} /> 燗酒</label></div><div><label>徳利1合 180ml<input name="tokuriPrice" type="number" min="0" defaultValue={editingMenu?.variants?.find((variant) => variant.name === "徳利1合")?.priceYen ?? ""} /></label><label><input type="checkbox" name="tokuriCold" defaultChecked={editingMenu?.variants?.find((variant) => variant.name === "徳利1合")?.temperatureOptions?.includes("冷酒") ?? true} /> 冷酒</label><label><input type="checkbox" name="tokuriHot" defaultChecked={editingMenu?.variants?.find((variant) => variant.name === "徳利1合")?.temperatureOptions?.includes("燗酒") ?? true} /> 燗酒</label></div><div><label>徳利2合 360ml<input name="tokuri2Price" type="number" min="0" defaultValue={editingMenu?.variants?.find((variant) => variant.name === "徳利2合")?.priceYen ?? ""} /></label><label><input type="checkbox" name="tokuri2Cold" defaultChecked={editingMenu?.variants?.find((variant) => variant.name === "徳利2合")?.temperatureOptions?.includes("冷酒") ?? true} /> 冷酒</label><label><input type="checkbox" name="tokuri2Hot" defaultChecked={editingMenu?.variants?.find((variant) => variant.name === "徳利2合")?.temperatureOptions?.includes("燗酒") ?? true} /> 燗酒</label></div></fieldset> : null}
            </div></details>
             <div className="menu-editor__actions"><button className="button button--quiet" type="button" onClick={resetMenuEditor} disabled={catalogState.saving}>キャンセル</button><button className="button button--primary" type="submit" disabled={catalogState.saving}>{catalogState.saving ? "保存中" : editingMenu ? "変更を保存" : "追加する"}</button></div>
             {editingMenu ? <div className="menu-editor__lifecycle"><div><b>削除・アーカイブ</b><small>保存済みの商品に対する操作です。未保存の変更がある場合は、先に選択してください。</small></div><button className="button button--quiet" type="button" onClick={() => requestMenuItemLifecycle(editingMenu)} disabled={catalogState.saving || !adminApiMode}>この商品を削除・アーカイブ</button></div> : null}
           </form> : null}
          {reorderMode ? <div className="menu-reorder-list" aria-label="商品の並び替え">{reorderDraftIds.map((id) => selectedReorderGroup?.items.find((entry) => entry.id === id)).filter(Boolean).map((item) => <div className="menu-reorder-row" key={item.id} onDragOver={(event) => event.preventDefault()} onDrop={() => { moveReorderItem(draggedMenuId, item.id); setDraggedMenuId(null); }}><button className="reorder-handle" type="button" draggable={!catalogState.saving} aria-label={`${item.name}をドラッグして並び替え`} onDragStart={() => setDraggedMenuId(item.id)}>≡</button><b>{String(reorderDraftIds.indexOf(item.id) + 1).padStart(2, "0")}</b><span>{item.name}</span><small>{item.kitchenAlias ?? item.name}</small><button type="button" className="button button--quiet" onClick={() => shiftReorderItem(item.id, -1)} disabled={catalogState.saving}>上へ</button><button type="button" className="button button--quiet" onClick={() => shiftReorderItem(item.id, 1)} disabled={catalogState.saving}>下へ</button></div>)}</div> : <div className="menu-admin-list"><div className="admin-row admin-row--header"><span>画像</span><span>カテゴリー</span><span>正式名・通称</span><span>価格（税込）</span><span>販売状況</span><span>並び順</span><span>操作</span></div>{displayedMenuGroups.map(({ category, items }) => <section className="menu-admin-group" key={category.id}><h3 className="menu-admin-group__heading"><span>{category.name}</span><small>{items.length}品</small></h3>{items.map((item) => <React.Fragment key={item.id}><div className={`admin-row ${item.isSoldOut ? "is-muted" : ""}`} ref={(node) => { if (node) menuCardRefs.current.set(item.id, node); else menuCardRefs.current.delete(item.id); }}><div className="admin-menu-card__image">{item.imageUri || item.detail?.imageUri ? <div className="admin-menu-card__image-frame"><img src={item.imageUri || item.detail.imageUri} alt="" style={imageLayoutStyle(item, "thumbnail")} /></div> : <span>画像なし</span>}</div><span className="category-tag">{category.name}</span><div className="admin-row__name"><b>{item.name}</b><small>通称：{item.kitchenAlias ?? DEFAULT_KITCHEN_MENU_ALIASES[item.id] ?? item.name}</small></div><div className="admin-menu-card__price"><small>税込</small><strong>{yen(item.price)}</strong></div><div className={`admin-menu-card__status ${adminMenuAvailability(item).className}`}><i></i>{adminMenuAvailability(item).label}</div><span className="admin-menu-card__sort-order">{item.sortOrder}</span><div className="admin-row__actions"><button className="button button--primary" type="button" onClick={() => openMenuEditor(item.id)}>{editingMenuId === item.id ? "編集中" : "編集"}</button><button className="button button--quiet" type="button" onClick={() => setMenuItem(item.id, { isSoldOut: !item.isSoldOut })}>{item.isSoldOut ? "販売再開" : "売り切れ"}</button><button className="button button--quiet" type="button" onClick={() => setImageLayoutItemId(item.id)}>画像</button></div></div>{null}</React.Fragment>)}</section>)}</div>}
        </> : null}

        {section === "categories" ? <>
          <div className="admin-toolbar"><div><span className="section-kicker">CATEGORY ORDER</span><h2>カテゴリの表示と順番</h2></div><button className="button button--outline button--large" onClick={() => setShowAdd(!showAdd)}><Plus size={28} weight="bold" /> カテゴリを追加</button></div>
          {showAdd ? <form className="inline-form inline-form--category" onSubmit={saveCategory}><label>カテゴリー名<input name="name" required maxLength="80" placeholder="例：揚げ物" defaultValue={state.categories.find((category) => category.id === categoryEditorId)?.name ?? ""} /></label><label>所属レール<select name="sectionKey" defaultValue={state.categories.find((category) => category.id === categoryEditorId)?.sectionKey ?? "food"}><option value="drink">ドリンク</option><option value="food">フード</option><option value="winter">冬季限定</option><option value="seasonal">季節・気まぐれ</option></select></label><label>表示順<input name="sortOrder" type="number" min="0" defaultValue={state.categories.find((category) => category.id === categoryEditorId)?.sortOrder ?? 0} /></label><label className="menu-editor__check"><input name="isVisible" type="checkbox" defaultChecked={state.categories.find((category) => category.id === categoryEditorId)?.isVisible ?? false} /> 客席に表示</label><button className="button button--primary" type="submit" disabled={catalogState.saving}>{catalogState.saving ? "保存中" : categoryEditorId ? "変更を保存" : "追加する"}</button><button className="button button--quiet" type="button" onClick={() => { setShowAdd(false); setCategoryEditorId(null); }} disabled={catalogState.saving}>キャンセル</button></form> : null}
          <div className="category-admin-grid">{[...state.categories].sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id, "ja")).map((category, index) => <article key={category.id}><div className="category-admin-index">{String(index + 1).padStart(2, "0")}</div><div><b>{category.name}</b><small>{category.sectionKey}・表示順 {category.sortOrder}</small></div><button className={`toggle ${category.isVisible ? "is-on" : ""}`} onClick={() => { setCategoryEditorId(category.id); setShowAdd(true); }}><i></i><span>編集</span></button><button className="button button--quiet" type="button" onClick={() => moveCategory(category, -1)} disabled={catalogState.saving}>上へ</button><button className="button button--quiet" type="button" onClick={() => moveCategory(category, 1)} disabled={catalogState.saving}>下へ</button></article>)}</div>
        </> : null}

        {section === "hours" ? <section className="admin-settings-content"><BusinessHoursEditor state={businessHoursState} adminApiMode={adminApiMode} onChange={updateBusinessHoursDraft} onSave={saveBusinessHours} onDiscard={discardBusinessHours} onReload={loadBusinessHours} /></section> : null}

        {section === "customer-theme" ? <section className="admin-settings-content"><CustomerThemeEditor adminApiMode={adminApiMode} /></section> : null}

        {section === "customer-order-notice" ? <section className="admin-settings-content"><CustomerOrderStartNoticeEditor adminApiMode={adminApiMode} /></section> : null}

        {section === "ride-guidance" ? <section className="admin-settings-content"><RideGuidanceEditor adminApiMode={adminApiMode} /></section> : null}

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
      {menuLifecycleDiscardPrompt ? <Modal title="未保存の変更があります" onClose={() => setMenuLifecycleDiscardPrompt(null)}><div className="modal-lead"><b>{menuLifecycleDiscardPrompt.name}</b><p>編集内容を保存せずに削除・アーカイブの確認へ進みますか？編集を続ける場合は、入力内容を保持します。</p></div><div className="modal-actions"><button type="button" className="button button--quiet" onClick={() => setMenuLifecycleDiscardPrompt(null)}>編集を続ける</button><button type="button" className="button button--primary" onClick={discardMenuEditsAndOpenLifecycle}>変更を破棄して確認へ</button></div></Modal> : null}
      {menuItemLifecycle ? <Modal title={menuItemLifecycle.kind === "checking" ? "商品情報を確認しています" : menuItemLifecycle.kind === "restore" ? "アーカイブ商品を復帰しますか？" : menuItemLifecycle.disposition === "archive" ? "商品をアーカイブしますか？" : "商品を削除しますか？"} onClose={() => { if (!menuItemLifecycle.busy && menuItemLifecycle.kind !== "checking") setMenuItemLifecycle(null); }}>
        <div className="modal-lead"><b>{menuItemLifecycle.item.name}</b>{menuItemLifecycle.kind === "checking" ? <p>商品参照を確認しています。</p> : menuItemLifecycle.kind === "restore" ? <p>この商品を通常の商品一覧へ戻します。安全のため「客席非表示」で復帰します。客席へ表示する場合は、復帰後に通常編集から変更してください。注文履歴と画像ファイルは保持されます。</p> : menuItemLifecycle.disposition === "archive" ? <p>注文履歴などの参照があるため、商品をアーカイブします。注文履歴と画像ファイルは削除しません。</p> : <p>保持対象の参照がないため、商品登録を削除します。画像ファイルは共有・履歴利用の可能性があるため削除しません。</p>}</div>
        {menuItemLifecycle.error ? <p className="checkout-feedback checkout-feedback--error" role="alert">{menuItemLifecycle.error}</p> : null}
        {menuItemLifecycle.kind !== "checking" ? <div className="modal-actions"><button type="button" className="button button--quiet" onClick={() => setMenuItemLifecycle(null)} disabled={menuItemLifecycle.busy}>キャンセル</button><button type="button" className="button button--primary button--large" onClick={() => void confirmMenuItemLifecycle()} disabled={menuItemLifecycle.busy}>{menuItemLifecycle.busy ? "処理中…" : menuItemLifecycle.kind === "restore" ? "客席非表示で復帰" : menuItemLifecycle.disposition === "archive" ? "アーカイブする" : "削除する"}</button></div> : null}
      </Modal> : null}
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
  const [kitchenCheckoutState, setKitchenCheckoutState] = useState(null);
  const [pairingError, setPairingError] = useState("");
  const [state, setState] = useState(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || defaultState; } catch { return defaultState; }
  });

  const updateState = (updater) => setState((current) => typeof updater === "function" ? updater(current) : updater);

  useEffect(() => {
    if (route !== "/kitchen") {
      setKitchenApiState(null);
      setKitchenCheckoutState(null);
      return undefined;
    }
    const explicitDemo = window.WARUN_ORDER_MODE === "demo" || new URLSearchParams(window.location.search).get("demo") === "1";
    if (explicitDemo || !kitchenApiConfigured(window)) {
      setKitchenApiState(explicitDemo ? null : { loading: false, error: true, orders: [], sessions: [] });
      setKitchenCheckoutState(explicitDemo ? { loading: false, error: false, checkouts: kitchenDemoCheckouts } : { loading: false, error: true, checkouts: [] });
      return undefined;
    }
    let cancelled = false;
    let suppressStaffCallsUntilSnapshot = false;
    let kitchenSnapshotRequest = 0;
    const load = async () => {
      const requestNumber = ++kitchenSnapshotRequest;
      const suppressStaffCalls = suppressStaffCallsUntilSnapshot;
      try {
        const [snapshot, checkouts] = await Promise.all([fetchKitchenSnapshot({ env: window }), fetchKitchenCheckoutRequests({ env: window })]);
        if (cancelled || requestNumber !== kitchenSnapshotRequest) return;
        if (suppressStaffCalls) suppressStaffCallsUntilSnapshot = false;
        setKitchenApiState({ loading: false, error: false, orders: snapshot.orders, staffCalls: snapshot.staffCalls, suppressStaffCalls, sessions: snapshot.sessions, notificationRequestStartedAt: snapshot.notificationRequestStartedAt });
        setKitchenCheckoutState({ loading: false, error: false, checkouts });
      } catch {
        if (requestNumber !== kitchenSnapshotRequest) return;
        suppressStaffCallsUntilSnapshot = true;
        if (!cancelled) setKitchenApiState({ loading: false, error: true, orders: [], staffCalls: [], sessions: [] });
        if (!cancelled) setKitchenCheckoutState((current) => current ? { ...current, loading: false, error: true } : { loading: false, error: true, checkouts: [] });
      }
    };
    setKitchenApiState({ loading: true, error: false, orders: [], sessions: [] });
    void load();
    const unsubscribe = subscribeKitchenInvalidations({ env: window, onEvent: (event) => { if (event?.resource === "checkout" || event?.resource === "staffCalls" || String(event?.type || "").startsWith("checkout.") || String(event?.type || "").startsWith("staff_call.")) void load(); }, onReconnect: () => { suppressStaffCallsUntilSnapshot = true; void load(); } });
    const timer = window.setInterval(load, 2_000);
    return () => { cancelled = true; window.clearInterval(timer); unsubscribe(); };
  }, [route]);

  const serveKitchenItem = async (orderId, orderItemId) => {
    await markKitchenItemServed({ env: window, orderId, orderItemId });
    try {
      const snapshot = await fetchKitchenSnapshot({ env: window });
      setKitchenApiState({ loading: false, error: false, orders: snapshot.orders, staffCalls: snapshot.staffCalls, sessions: snapshot.sessions, notificationRequestStartedAt: snapshot.notificationRequestStartedAt });
    } catch (error) {
      throw new KitchenApiError("提供更新後の注文一覧を再取得できませんでした。", { code: "SERVE_REFRESH_FAILED", status: error?.status ?? 0 });
    }
  };

  const saveKitchenItemPrice = async (orderId, orderItemId, unitPriceYen) => {
    await adjustKitchenItemUnitPrice({ env: window, orderId, orderItemId, unitPriceYen });
    const [snapshot, checkouts] = await Promise.all([fetchKitchenSnapshot({ env: window }), fetchKitchenCheckoutRequests({ env: window })]);
    setKitchenApiState({ loading: false, error: false, orders: snapshot.orders, staffCalls: snapshot.staffCalls, sessions: snapshot.sessions, notificationRequestStartedAt: snapshot.notificationRequestStartedAt });
    setKitchenCheckoutState({ loading: false, error: false, checkouts });
  };

  const adjustKitchenItemQuantity = async (operation) => {
    await adjustKitchenItemQuantityRequest({ env: window, ...operation });
    const [snapshot, checkouts] = await Promise.all([fetchKitchenSnapshot({ env: window }), fetchKitchenCheckoutRequests({ env: window })]);
    setKitchenApiState({ loading: false, error: false, orders: snapshot.orders, staffCalls: snapshot.staffCalls, sessions: snapshot.sessions, notificationRequestStartedAt: snapshot.notificationRequestStartedAt });
    setKitchenCheckoutState({ loading: false, error: false, checkouts });
  };

  const changeKitchenOrderItemCancellation = async ({ orderId, orderItemId, reason, action }) => {
    const change = action === "restore" ? restoreKitchenOrderItem : cancelKitchenOrderItem;
    const result = await change({ env: window, orderId, orderItemId, reason });
    if (kitchenApiConfigured(window)) {
      const [snapshot, checkouts] = await Promise.all([fetchKitchenSnapshot({ env: window }), fetchKitchenCheckoutRequests({ env: window })]);
      setKitchenApiState({ loading: false, error: false, orders: snapshot.orders, staffCalls: snapshot.staffCalls, sessions: snapshot.sessions, notificationRequestStartedAt: snapshot.notificationRequestStartedAt });
      setKitchenCheckoutState({ loading: false, error: false, checkouts });
    }
    return result;
  };

  const refreshKitchenCheckouts = async () => {
    const checkouts = await fetchKitchenCheckoutRequests({ env: window });
    setKitchenCheckoutState({ loading: false, error: false, checkouts });
    return checkouts;
  };

  const saveCheckout = async (checkout, adjustments) => {
    const result = await saveKitchenCheckoutAdjustments({ env: window, checkoutRequestId: checkout.checkoutRequestId, expectedVersion: checkout.version, adjustments });
    await refreshKitchenCheckouts();
    return result;
  };

  const readyCheckout = async (checkout) => {
    const result = await readyKitchenCheckout({ env: window, checkoutRequestId: checkout.checkoutRequestId, expectedVersion: checkout.version });
    await refreshKitchenCheckouts();
    return result;
  };

  const cancelCheckout = async (checkout) => {
    const result = await cancelKitchenCheckout({ env: window, checkoutRequestId: checkout.checkoutRequestId, expectedVersion: checkout.version });
    await refreshKitchenCheckouts();
    return result;
  };

  const payCheckout = async (checkout, paymentMethod) => {
    const result = await payKitchenCheckout({ env: window, checkoutRequestId: checkout.checkoutRequestId, expectedVersion: checkout.version, paymentMethod });
    await refreshKitchenCheckouts();
    const snapshot = await fetchKitchenSnapshot({ env: window });
    setKitchenApiState({ loading: false, error: false, orders: snapshot.orders, staffCalls: snapshot.staffCalls, sessions: snapshot.sessions, notificationRequestStartedAt: snapshot.notificationRequestStartedAt });
    return result;
  };

  const voidPayment = async (payment, reason) => {
    if (kitchenApiConfigured(window)) return voidKitchenPayment({ env: window, paymentRecordId: payment.paymentRecordId, expectedVersion: payment.version, reason });
    return voidAdminPayment({ env: window, paymentRecordId: payment.paymentRecordId, expectedVersion: payment.version, reason });
  };

  const closeKitchenSession = async ({ tableId, sessionId }) => {
    await closeKitchenTableSession({ env: window, tableId, sessionId });
    const snapshot = await fetchKitchenSnapshot({ env: window });
    setKitchenApiState({ loading: false, error: false, orders: snapshot.orders, staffCalls: snapshot.staffCalls, sessions: snapshot.sessions, notificationRequestStartedAt: snapshot.notificationRequestStartedAt });
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
    clearCustomerOrderStartNoticeAcknowledgements({ deviceId: device.deviceId });
    const credentials = await store.load();
    setCustomerDeviceConfig(credentials.config ? { ...credentials.config, deviceId: credentials.deviceId } : null);
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
    if (route === "/") return <CustomerScreen state={state} updateState={updateState} deviceId="customer-03" orderClient={orderClient} customerDeviceConfig={customerDeviceConfig} onCustomerDeviceConfigChange={setCustomerDeviceConfig} />;
    if (route.startsWith("/customer/")) return <CustomerScreen state={state} updateState={updateState} deviceId={route.split("/")[2]} orderClient={orderClient} customerDeviceConfig={customerDeviceConfig} onCustomerDeviceConfigChange={setCustomerDeviceConfig} />;
    if (route === "/kitchen") return <KitchenScreen state={state} updateState={updateState} apiState={kitchenApiState} checkoutState={kitchenCheckoutState} onServe={serveKitchenItem} onSaveItemPrice={saveKitchenItemPrice} onAdjustItemQuantity={adjustKitchenItemQuantity} onChangeItemCancellation={changeKitchenOrderItemCancellation} onRefreshCheckouts={refreshKitchenCheckouts} onSaveCheckout={saveCheckout} onReadyCheckout={readyCheckout} onCancelCheckout={cancelCheckout} onPayCheckout={payCheckout} />;
    if (route === "/history") {
      const explicitDemo = window.WARUN_ORDER_MODE === "demo" || new URLSearchParams(window.location.search).get("demo") === "1";
      const kitchenConfigured = kitchenApiConfigured(window);
      const adminConfigured = configuredAdminToken(window);
      const loadHistory = kitchenConfigured
        ? fetchKitchenOrderHistory
        : adminConfigured ? fetchAdminOrderHistory : null;
      const loadPaymentHistory = kitchenConfigured
        ? fetchKitchenPaymentHistory
        : adminConfigured ? fetchAdminPaymentHistory : null;
      const loadCheckoutRequests = kitchenConfigured
        ? fetchKitchenCheckoutRequests
        : adminConfigured ? fetchAdminCheckoutRequests : null;
      return <HistoryScreen state={state} apiMode={!explicitDemo} loadHistory={loadHistory} loadPaymentHistory={loadPaymentHistory} loadCheckoutRequests={loadCheckoutRequests} onVoidPayment={!explicitDemo && (kitchenConfigured || adminConfigured) ? voidPayment : null} onChangeItemCancellation={!explicitDemo && (kitchenConfigured || adminConfigured) ? changeKitchenOrderItemCancellation : null} />;
    }
    if (route.startsWith("/admin/")) return <AdminScreen state={state} updateState={updateState} section={route.split("/")[2] || "menu"} />;
    if (route === "/devices") return <Launcher state={state} updateState={updateState} />;
    return <CustomerScreen state={state} updateState={updateState} deviceId="customer-03" orderClient={orderClient} customerDeviceConfig={customerDeviceConfig} onCustomerDeviceConfigChange={setCustomerDeviceConfig} />;
  }, [route, state, orderClient, customerDeviceConfig, kitchenApiState, pairingError, kitchenCheckoutState]);

  return content;
}
