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
import { claimCustomerDevice, createIndexedDbCredentialStore, loadOrCreateCustomerDevice, runtimeForCustomerCredentials } from "./device-credentials.js";
import { customerOrderNoticeFromOutboxEvent } from "./customer-order-notice.js";
import { configuredAdminToken, fetchAdminOrderHistory, issueCustomerPairingCode } from "./admin-pairing.js";
import { fetchKitchenOrders, kitchenApiConfigured, markKitchenItemServed } from "./kitchen-api.js";
import { bootstrapCustomerOrderClient } from "./customer-bootstrap.js";

const STORAGE_KEY = "izakaya-order-prototype-v3";

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
  return registeredAliases[item.menuItemId] || DEFAULT_KITCHEN_MENU_ALIASES[item.menuItemId] || item.nameSnapshot;
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

function yen(value) {
  return new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 }).format(value);
}

function customerTransportLabel(order) {
  switch (order.transportState) {
    case "sending": return "送信中";
    case "retrying": return "再送中";
    case "pending": return "送信待ち";
    case "synced": return "送信済み";
    case "rejected": return "業務エラー";
    case "failed": return "送信失敗";
    default: return order.status === "completed" ? "提供済み" : order.status === "queued_offline" ? "送信待ち" : "準備中";
  }
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

function Modal({ title, children, onClose, wide = false }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={`modal ${wide ? "modal--wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal__header"><h2>{title}</h2><button className="icon-only" onClick={onClose} aria-label="閉じる"><X size={26} weight="bold" /></button></header>
        <div className="modal__body">{children}</div>
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

function CustomerScreen({ state, updateState, deviceId, orderClient }) {
  const device = state.devices.find((item) => item.deviceId === deviceId) ?? state.devices[0];
  const apiMode = orderClient.mode === "api";
  const online = apiMode ? typeof navigator === "undefined" || navigator.onLine !== false : !state.offlineDevices.includes(device.deviceId);
  const categories = [...state.categories].filter((category) => category.isVisible).sort((a, b) => a.sortOrder - b.sortOrder);
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? "recommended");
  const [cart, setCart] = useState({ edamame: 1, dashimaki: 1, beer: 2, lemon: 1, karaage: 1, yakitori: 2, otoshi: 2 });
  const [modal, setModal] = useState(null);
  const [notice, setNotice] = useState(null);
  const [apiOrders, setApiOrders] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const submitLock = useRef(false);
  const featuredIds = ["edamame", "dashimaki", "beer", "lemon", "karaage"];
  const currentItems = categoryId === "recommended"
    ? featuredIds.map((id) => state.menuItems.find((item) => item.id === id)).filter(Boolean)
    : [...state.menuItems].filter((item) => item.categoryId === categoryId).sort((a, b) => a.sortOrder - b.sortOrder);
  const cartRows = Object.entries(cart).map(([menuItemId, quantity]) => ({ item: state.menuItems.find((menu) => menu.id === menuItemId), quantity })).filter((row) => row.item && row.quantity > 0);
  const cartCount = cartRows.reduce((sum, row) => sum + row.quantity, 0);
  const customerHistory = (apiMode ? apiOrders : state.orders)
    .filter((order) => order.tableId === device.tableId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  useEffect(() => {
    const unsubscribe = orderClient.subscribe((event) => {
      const nextNotice = customerOrderNoticeFromOutboxEvent(event);
      if (!nextNotice) return;
      setNotice((current) => current?.kind === nextNotice.kind && current?.message === nextNotice.message ? current : nextNotice);
      if (apiMode) {
        setApiOrders((current) => current.map((order) => order.clientOrderId !== event.clientOrderId ? order : {
          ...order,
          status: event.state === "synced" ? "new" : event.state === "rejected" ? "rejected" : event.state === "pending" ? "queued_offline" : order.status,
          transportState: event.displayState || event.state,
          transportErrorCode: event.lastErrorCode || null,
          syncedAt: event.state === "synced" ? new Date().toISOString() : order.syncedAt,
        }));
      }
    });
    return unsubscribe;
  }, [apiMode, orderClient]);

  useEffect(() => {
    if (!apiMode) return;
    const pendingOrder = customerHistory.find((order) => ["sending", "retrying", "pending", "queued_offline", "rejected"].includes(order.transportState) || order.status === "queued_offline");
    if (!pendingOrder) return;
    const nextNotice = customerOrderNoticeFromOutboxEvent({
      clientOrderId: pendingOrder.clientOrderId || pendingOrder.id,
      state: pendingOrder.transportState === "rejected" ? "rejected" : pendingOrder.transportState === "sending" ? "sending" : "pending",
      displayState: pendingOrder.transportState === "retrying" ? "retrying" : pendingOrder.transportState === "failed" ? "failed" : pendingOrder.transportState,
    });
    if (nextNotice) setNotice((current) => current?.kind === nextNotice.kind && current?.message === nextNotice.message ? current : nextNotice);
  }, [apiMode, customerHistory, state.orders]);

  const changeQuantity = (menuItemId, delta) => {
    const item = state.menuItems.find((menu) => menu.id === menuItemId);
    if (!item || item.isSoldOut) return;
    setCart((current) => ({ ...current, [menuItemId]: Math.max(0, (current[menuItemId] ?? 0) + delta) }));
  };

  const submitOrder = async () => {
    if (!cartRows.length || submitLock.current) return;
    submitLock.current = true;
    setSubmitting(true);
    const now = new Date().toISOString();
    const items = cartRows.map((row) => ({
      id: makeId("item"),
      menuItemId: row.item.id,
      nameSnapshot: row.item.name,
      unitPriceSnapshot: row.item.price,
      quantity: row.quantity,
      isServed: false,
      servedAt: null,
    }));

    try {
      if (apiMode) {
        setNotice({ kind: "sending", message: "送信中です。注文を保存しています。" });
        const outboxRecord = await orderClient.enqueue({ items: cartRows.map((row) => ({ menuItemId: row.item.id, quantity: row.quantity })) });
        const order = {
          id: outboxRecord.clientOrderId,
          clientOrderId: outboxRecord.clientOrderId,
          tableId: device.tableId,
          createdAt: now,
          status: "queued_offline",
          transportState: "pending",
          totalAmount: cartRows.reduce((sum, row) => sum + row.item.price * row.quantity, 0),
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
          setNotice({ kind: "error", message: "業務エラーのため送信できませんでした。内容をご確認ください。" });
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
        totalAmount: cartRows.reduce((sum, row) => sum + row.item.price * row.quantity, 0),
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

  return (
    <div className="customer-app">
      <aside className="customer-sidebar">
        <div className="customer-system-label">IZAKAYA<br />ORDER<br />SYSTEM</div>
        <div className="customer-title"><span>お</span><span>品</span><span>書</span><span>き</span></div>
        <p className="vertical-copy">おすすめの逸品を<br />ごゆっくりどうぞ。</p>
        <nav className="category-nav" aria-label="メニューカテゴリ">
          {categories.map((category, index) => <button key={category.id} className={category.id === categoryId ? "is-active" : ""} onClick={() => setCategoryId(category.id)}><b>{String(index + 1).padStart(2, "0")}</b><span>{category.name}</span></button>)}
        </nav>
        <div className="customer-hours"><b>本日の営業時間</b><span>17:00 — 24:00</span><small>（ラストオーダー 23:30）</small></div>
        <Brand compact />
      </aside>

      <section className="customer-main">
        <header className="customer-header">
          <IconButton icon={ClipboardText} onClick={() => setModal("history")}>注文履歴</IconButton>
          <IconButton icon={Bell} onClick={() => setModal("staff")}>スタッフを呼ぶ</IconButton>
          <IconButton icon={CurrencyJpy} onClick={() => setModal("feature")}>お会計</IconButton>
          <IconButton icon={Car} onClick={() => setModal("feature")}>タクシー・運転代行</IconButton>
          <div className="table-label">テーブル <b>{device.tableId}</b></div>
        </header>

        {notice ? <div className={`customer-notice ${noticeKind === "success" ? "is-success" : "is-queued"}`}><span>{noticeKind === "success" ? <CheckCircle size={26} weight="fill" /> : noticeKind === "sending" ? <WifiHigh size={26} weight="bold" /> : <WifiSlash size={26} weight="bold" />}{noticeMessage}</span><button onClick={() => setNotice(null)} aria-label="通知を閉じる"><X size={20} /></button></div> : null}

        <div className="customer-content">
          <section className="menu-panel">
            <div className="menu-heading"><span className="section-kicker">RECOMMENDED</span><h1>{state.categories.find((category) => category.id === categoryId)?.name}</h1><p>まずはこれ。<br />当店自慢の人気メニューをどうぞ。</p></div>
            <div className="menu-list">
              {currentItems.length ? currentItems.map((item, index) => {
                return (
                  <article className={`menu-row ${item.isSoldOut ? "is-sold-out" : ""}`} key={item.id}>
                    <div className="menu-row__index">{String(index + 1).padStart(2, "0")}</div>
                    <div className="menu-row__copy"><h2>{item.name}</h2><p>{item.description}</p></div>
                    {item.isSoldOut ? <div className="sold-out-label"><b>売り切れ</b><small>SOLD OUT</small></div> : null}
                    {item.isSoldOut ? <button className="add-button add-button--disabled" disabled><Minus size={30} weight="bold" /></button> : <button className="add-button" onClick={() => changeQuantity(item.id, 1)} aria-label={`${item.name}を追加`}><Plus size={36} weight="bold" /></button>}
                  </article>
                );
              }) : <div className="empty-state"><ListBullets size={42} /><p>このカテゴリの商品はまだありません。</p></div>}
            </div>
          </section>

          <aside className="cart-panel">
            <header><Receipt size={36} weight="bold" /><div><h2>ご注文内容</h2><span>ORDER SUMMARY</span></div></header>
            <div className="cart-list">
              {cartRows.length ? cartRows.map((row, index) => <div className="cart-row" key={row.item.id}><span className="cart-row__index">{index + 1}</span><b>{row.item.name}</b><span>{row.quantity}点</span><button onClick={() => setCart((current) => ({ ...current, [row.item.id]: 0 }))} aria-label={`${row.item.name}を削除`}><X size={18} /></button></div>) : <div className="cart-empty"><Receipt size={54} weight="thin" /><p>商品を追加すると<br />ここに表示されます。</p></div>}
            </div>
            <button className="confirm-button" disabled={!cartCount} onClick={() => setModal("confirm")}>注文を確定する <ArrowRight size={28} weight="bold" /></button>
          </aside>
        </div>
        <footer className="customer-footer"><b>INFORMATION</b><span>アレルギー・原材料についてはスタッフまでお尋ねください。</span><strong>店内禁煙</strong></footer>
      </section>

      {modal === "confirm" ? <Modal title="注文内容の確認" onClose={() => { if (!submitting) setModal(null); }}><div className="confirm-list">{cartRows.map((row) => <div key={row.item.id}><b>{row.item.name}</b><span>{row.quantity}点</span></div>)}</div><p className="price-hidden-note">内容をご確認のうえ、注文を送信してください。</p><div className="modal-actions"><button className="button button--quiet" onClick={() => setModal(null)} disabled={submitting}>戻る</button><button className="button button--primary button--large" onClick={submitOrder} disabled={submitting}>{submitting ? "送信中" : online ? "注文を送信" : "送信待ちに保存"}</button></div></Modal> : null}
      {modal === "staff" ? <Modal title="スタッフを呼びますか？" onClose={() => setModal(null)}><p className="modal-lead">テーブル {device.tableId} からスタッフへお知らせします。</p><div className="modal-actions"><button className="button button--quiet" onClick={() => setModal(null)}>やめる</button><button className="button button--primary button--large" onClick={callStaff}><Bell size={22} weight="bold" /> 呼び出す</button></div></Modal> : null}
      {modal === "feature" ? <Modal title="確認" onClose={() => setModal(null)}><p className="modal-lead">この機能は次の実装段階で接続します。</p><div className="modal-actions"><button className="button button--primary" onClick={() => setModal(null)}>閉じる</button></div></Modal> : null}
      {modal === "history" ? <Modal title="これまでのご注文" onClose={() => setModal(null)} wide><div className="customer-history">{customerHistory.length ? customerHistory.map((order) => <article key={order.id}><header><b>{formatTime(order.createdAt)} のご注文</b><span className={`status-chip status-${order.status}`}>{customerTransportLabel(order)}</span></header>{order.items.map((item) => <div key={item.id}><span>{item.nameSnapshot}</span><b>{item.quantity}点</b></div>)}</article>) : <div className="empty-state"><ClipboardText size={42} /><p>注文履歴はまだありません。</p></div>}</div></Modal> : null}
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

function StaffShell({ route, title, subtitle, state, children, right }) {
  const activeCalls = state.staffCalls.filter((call) => !call.resolvedAt).length;
  const isKitchen = route === "/kitchen";
  const isAdmin = route.startsWith("/admin");
  const navItems = isAdmin ? adminNavItems : staffNavItems;
  return (
    <div className={`staff-app ${isKitchen ? "staff-app--kitchen" : ""} ${isAdmin ? "staff-app--admin" : ""}`}>
      <aside className="staff-sidebar">
        <Brand />
        <nav>{navItems.map((item) => <button key={item.route} className={route.startsWith(item.route) ? "is-active" : ""} onClick={() => navigate(item.route)}><item.icon size={30} weight="bold" /><span>{item.label}</span>{item.route === "/kitchen" && activeCalls ? <b className="badge">{activeCalls}</b> : null}</button>)}</nav>
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

function KitchenScreen({ state, updateState, apiState, onServe }) {
  const [callPanel, setCallPanel] = useState(false);
  const apiMode = Boolean(apiState);
  const sourceOrders = apiMode ? apiState.orders : state.orders;
  const activeOrders = sourceOrders.filter((order) => order.status === "new" || order.status === "active");
  const tables = [...new Set(activeOrders.map((order) => order.tableId))].sort((a, b) => Number(a) - Number(b));
  const activeCalls = state.staffCalls.filter((call) => !call.resolvedAt);
  const kitchenAliases = Object.fromEntries(state.menuItems.map((item) => [item.id, item.kitchenAlias?.trim()]));

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
    <StaffShell route="/kitchen" title="新着注文" subtitle="新しいご注文を確認してください。提供済みのテーブルは自動的に履歴へ移動します。" state={state} right={<div className="staff-topbar__right"><button className="staff-call-button" onClick={() => setCallPanel(true)}><Bell size={26} weight="fill" /> スタッフ呼出 {activeCalls.length ? <b>{activeCalls.length}</b> : null}</button><ConnectionBadge online /><time className="kitchen-clock">{formatTime(new Date())}</time></div>}>
      <section className="kitchen-content">
        <div className="table-scroll">
          {apiMode && apiState.loading ? <div className="kitchen-empty"><p>注文を読み込み中です。</p></div> : apiMode && apiState.error ? <div className="kitchen-empty"><p>注文を取得できませんでした。</p></div> : tables.length ? tables.map((tableId) => {
            const orders = activeOrders.filter((order) => order.tableId === tableId);
            const rows = orders.flatMap((order) => order.items.map((item) => ({ ...item, orderId: order.id, createdAt: order.createdAt }))).sort((a, b) => Number(a.isServed) - Number(b.isServed));
            const total = orders.reduce((sum, order) => sum + order.totalAmount, 0);
            const oldest = orders.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0];
            return (
              <article className="table-panel" key={tableId}>
                <header><h2>テーブル <b>{tableId}</b></h2><time>{formatTime(oldest.createdAt)}</time></header>
                <div className="table-panel__rows">
                  {rows.filter((row) => !row.isServed).map((row) => <button className="order-item" key={row.id} onClick={() => toggleServed(row.orderId, row.id)}><span><b>{kitchenMenuName(row, kitchenAliases)}</b><small>{row.quantity}点</small></span><i><Check size={19} weight="bold" /></i></button>)}
                  {rows.some((row) => row.isServed) ? <div className="served-divider"><span>提供済み</span></div> : null}
                  {rows.filter((row) => row.isServed).map((row) => <button className="order-item is-served" key={row.id} onClick={() => toggleServed(row.orderId, row.id)}><span><b>{kitchenMenuName(row, kitchenAliases)}</b><small>{row.quantity}点</small></span><i><Check size={19} weight="bold" /></i></button>)}
                </div>
                <footer><span>合計</span><b>{yen(total)}</b></footer>
              </article>
            );
          }) : <div className="kitchen-empty"><CheckCircle size={72} weight="thin" /><h2>すべて提供済みです</h2><p>新しい注文が届くと、ここにテーブルごとに表示されます。</p></div>}
        </div>
        <div className="horizontal-hint"><ArrowLeft size={20} /><span></span><ArrowRight size={20} /></div>
      </section>
      {callPanel ? <Modal title="スタッフ呼び出し" onClose={() => setCallPanel(false)} wide><div className="call-list">{activeCalls.length ? activeCalls.map((call) => <article key={call.id}><Bell size={28} weight="fill" /><div><b>テーブル {call.tableId}</b><span>{formatTime(call.createdAt)} に呼び出し</span></div><button className="button button--primary" onClick={() => resolveCall(call.id)}>対応済みにする</button></article>) : <div className="empty-state"><Bell size={42} /><p>未対応の呼び出しはありません。</p></div>}</div></Modal> : null}
    </StaffShell>
  );
}

function HistoryScreen({ state, apiMode = false }) {
  const [remoteState, setRemoteState] = useState({ loading: apiMode, error: false, orders: [] });
  useEffect(() => {
    if (!apiMode) return undefined;
    let cancelled = false;
    setRemoteState({ loading: true, error: false, orders: [] });
    void fetchAdminOrderHistory({ env: window }).then((orders) => {
      if (!cancelled) setRemoteState({ loading: false, error: false, orders });
    }).catch(() => {
      if (!cancelled) setRemoteState({ loading: false, error: true, orders: [] });
    });
    return () => { cancelled = true; };
  }, [apiMode]);
  const sourceOrders = apiMode ? remoteState.orders.map((order) => ({
    id: order.orderId,
    tableId: String(order.tableId),
    createdAt: new Date(order.acceptedAtMs).toISOString(),
    completedAt: order.completedAtMs ? new Date(order.completedAtMs).toISOString() : null,
    status: order.status,
    totalAmount: order.totalAmountYen,
    items: order.items.map((item) => ({ id: String(item.orderItemId), nameSnapshot: item.formalNameSnapshot, unitPriceSnapshot: item.unitPriceYenSnapshot, quantity: item.quantity })),
  })) : state.orders;
  const completed = sourceOrders.filter((order) => order.status === "completed").sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
  return (
    <StaffShell route="/history" title="提供済み（履歴）" subtitle="完了した注文を、注文時点の品名と単価で確認できます。" state={state} right={<ConnectionBadge online />}>
      <section className="history-content">
        <div className="history-summary"><div><small>本日の提供済み</small><b>{completed.length}</b><span>件</span></div><div><small>履歴合計</small><b>{yen(completed.reduce((sum, order) => sum + order.totalAmount, 0))}</b></div></div>
        {apiMode && remoteState.loading ? <div className="empty-state"><p>注文履歴を読み込み中です。</p></div> : null}
        {apiMode && remoteState.error ? <div className="empty-state"><p>注文履歴を取得できませんでした。</p></div> : null}
        {(!apiMode || (!remoteState.loading && !remoteState.error)) && completed.length === 0 ? <div className="empty-state"><p>注文履歴はありません。</p></div> : null}
        {(!apiMode || (!remoteState.loading && !remoteState.error)) && completed.length > 0 && <div className="history-table-wrap">
          <table className="history-table">
            <thead><tr><th>注文番号</th><th>テーブル</th><th>受付</th><th>完了</th><th>品目</th><th>合計</th></tr></thead>
            <tbody>{completed.map((order) => <tr key={order.id}><td><b>{order.id}</b></td><td><span className="table-pill">T{order.tableId}</span></td><td>{formatDateTime(order.createdAt)}</td><td>{formatDateTime(order.completedAt)}</td><td><div className="history-items">{order.items.map((item) => <span key={item.id}>{item.nameSnapshot} <b>{item.quantity}点</b> <small>{yen(item.unitPriceSnapshot)}</small></span>)}</div></td><td className="history-total">{yen(order.totalAmount)}</td></tr>)}</tbody>
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

function AdminScreen({ state, updateState, section = "menu" }) {
  const [showAdd, setShowAdd] = useState(false);
  const [editingMenuId, setEditingMenuId] = useState(null);
  const [pairingTableId, setPairingTableId] = useState("1");
  const [pairingQr, setPairingQr] = useState(null);
  const [pairingError, setPairingError] = useState(false);
  const categoriesById = Object.fromEntries(state.categories.map((category) => [category.id, category]));
  const editingMenu = state.menuItems.find((item) => item.id === editingMenuId) ?? null;
  const setMenuItem = (id, patch) => updateState((current) => ({ ...current, menuItems: current.menuItems.map((item) => item.id === id ? { ...item, ...patch } : item) }));
  const setCategory = (id, patch) => updateState((current) => ({ ...current, categories: current.categories.map((item) => item.id === id ? { ...item, ...patch } : item) }));
  const addMenu = (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = form.get("name")?.toString().trim();
    const kitchenAlias = form.get("kitchenAlias")?.toString().trim();
    if (!name) return;
    updateState((current) => editingMenuId ? ({
      ...current,
      menuItems: current.menuItems.map((item) => item.id === editingMenuId ? { ...item, categoryId: form.get("categoryId"), name, kitchenAlias, price: Number(form.get("price")) || 0 } : item),
    }) : ({
      ...current,
      menuItems: [...current.menuItems, { id: makeId("menu"), categoryId: form.get("categoryId"), name, kitchenAlias, description: "説明文を入力してください。", price: Number(form.get("price")) || 0, isSoldOut: false, sortOrder: current.menuItems.filter((item) => item.categoryId === form.get("categoryId")).length + 1 }],
    }));
    setShowAdd(false);
    setEditingMenuId(null);
  };
  const addCategory = (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = form.get("name")?.toString().trim();
    if (!name) return;
    updateState((current) => ({ ...current, categories: [...current.categories, { id: makeId("category"), name, sortOrder: current.categories.length + 1, isVisible: true }] }));
    setShowAdd(false);
  };
  const sortedMenus = [...state.menuItems].sort((a, b) => (categoriesById[a.categoryId]?.sortOrder ?? 99) - (categoriesById[b.categoryId]?.sortOrder ?? 99) || a.sortOrder - b.sortOrder);
  const issuePairing = async () => {
    setPairingError(false);
    try {
      const result = await issueCustomerPairingCode({ tableId: Number(pairingTableId), expiresAtMs: Date.now() + 10 * 60 * 1000 });
      setPairingQr(pairingCodeQrSvg(result.code));
    } catch {
      setPairingQr(null);
      setPairingError(true);
    }
  };

  return (
    <StaffShell route={`/admin/${section}`} title="メニュー管理" subtitle="メニューの追加・編集・並び順の変更ができます。" state={state} right={<button className="save-indicator"><Check size={24} weight="bold" /> 保存する</button>}>
      <section className="admin-content">
        <nav className="admin-tabs">{adminTabs.map((tab) => <button key={tab.id} className={section === tab.id ? "is-active" : ""} onClick={() => { setShowAdd(false); setEditingMenuId(null); navigate(`/admin/${tab.id}`); }}><tab.icon size={24} weight="bold" /> {tab.label}</button>)}</nav>

        {section === "menu" ? <>
          <div className="admin-toolbar"><div className="admin-metrics"><span>登録数 <b>24</b> 品</span><span>売り切れ <b>{Math.max(2, state.menuItems.filter((item) => item.isSoldOut).length)}</b> 品</span></div><button className="button button--outline button--large" onClick={() => { setEditingMenuId(null); setShowAdd(!showAdd || Boolean(editingMenuId)); }}><Plus size={28} weight="bold" /> 新しいメニューを追加</button></div>
          {showAdd ? <form className="inline-form inline-form--menu" key={editingMenuId ?? "new-menu"} onSubmit={addMenu}><label>正式名<input name="name" required placeholder="例：だし巻き玉子" defaultValue={editingMenu?.name ?? ""} /></label><label>厨房用の通称<input name="kitchenAlias" required placeholder="例：だし巻き" defaultValue={editingMenu?.kitchenAlias ?? DEFAULT_KITCHEN_MENU_ALIASES[editingMenu?.id] ?? ""} /></label><label>カテゴリ<select name="categoryId" defaultValue={editingMenu?.categoryId}>{state.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label><label>価格<input name="price" type="number" min="0" step="10" defaultValue={editingMenu?.price ?? 500} /></label><button className="button button--primary" type="submit">{editingMenu ? "変更を保存" : "追加する"}</button></form> : null}
          <div className="menu-admin-list"><div className="admin-row admin-row--header"><span>画像</span><span>カテゴリー</span><span>正式名・通称</span><span>価格（税込）</span><span>販売状況</span><span>並び順</span><span>操作</span></div>{sortedMenus.map((item) => <div className={`admin-row ${item.isSoldOut ? "is-muted" : ""}`} key={item.id}><div className="image-placeholder">画像なし</div><span className="category-tag">{categoriesById[item.categoryId]?.name}</span><div className="admin-row__name"><b>{item.name}</b><small>通称：{item.kitchenAlias ?? DEFAULT_KITCHEN_MENU_ALIASES[item.id] ?? item.name}</small></div><label className="price-input"><input type="number" value={item.price} min="0" step="10" onChange={(event) => setMenuItem(item.id, { price: Number(event.target.value) })} /><small>円</small></label><button className={`toggle ${item.isSoldOut ? "" : "is-on"}`} onClick={() => setMenuItem(item.id, { isSoldOut: !item.isSoldOut })}><i></i><span>{item.isSoldOut ? "売り切れ" : "販売中"}</span></button><input className="sort-order-input" value={item.sortOrder} aria-label={`${item.name}の並び順`} onChange={(event) => setMenuItem(item.id, { sortOrder: Number(event.target.value) || 1 })} /><div className="admin-row__actions"><button className="button button--quiet" onClick={() => { setEditingMenuId(item.id); setShowAdd(true); }}>編集</button><button className="delete-button delete-button--icon" aria-label={`${item.name}を削除`} onClick={() => updateState((current) => ({ ...current, menuItems: current.menuItems.filter((menu) => menu.id !== item.id) }))}><X size={20} /></button></div></div>)}</div>
        </> : null}

        {section === "categories" ? <>
          <div className="admin-toolbar"><div><span className="section-kicker">CATEGORY ORDER</span><h2>カテゴリの表示と順番</h2></div><button className="button button--outline button--large" onClick={() => setShowAdd(!showAdd)}><Plus size={28} weight="bold" /> カテゴリを追加</button></div>
          {showAdd ? <form className="inline-form inline-form--category" onSubmit={addCategory}><label>カテゴリ名<input name="name" required placeholder="例：揚げ物" /></label><button className="button button--primary" type="submit">追加する</button></form> : null}
          <div className="category-admin-grid">{[...state.categories].sort((a, b) => a.sortOrder - b.sortOrder).map((category, index) => <article key={category.id}><div className="category-admin-index">{String(index + 1).padStart(2, "0")}</div><div><input value={category.name} aria-label="カテゴリ名" onChange={(event) => setCategory(category.id, { name: event.target.value })} /><small>客席メニューのカテゴリ帯に表示</small></div><button className={`toggle ${category.isVisible ? "is-on" : ""}`} onClick={() => setCategory(category.id, { isVisible: !category.isVisible })}><i></i><span>{category.isVisible ? "表示中" : "非表示"}</span></button></article>)}</div>
        </> : null}

        {section === "devices" ? <>
          <div className="pairing-admin-panel"><div><span className="section-kicker">CUSTOMER PAIRING</span><h2>客席端末をQRで登録</h2><p>管理者だけが発行します。raw codeは文字表示・保存せず、A90のカメラでQRを読み取ってください。</p></div><label>テーブル<select value={pairingTableId} onChange={(event) => setPairingTableId(event.target.value)}>{[1, 2, 3, 4, 5, 6, 7, 8].map((tableId) => <option value={String(tableId)} key={tableId}>テーブル {tableId}</option>)}</select></label><button className="button button--primary" onClick={issuePairing}>QRを発行</button>{pairingError ? <p role="alert">QRを発行できませんでした。管理者API設定と空きテーブルを確認してください。</p> : null}{pairingQr ? <div className="pairing-qr" dangerouslySetInnerHTML={{ __html: pairingQr }} /> : null}</div>
          <div className="admin-toolbar"><div><span className="section-kicker">FIXED ASSIGNMENT</span><h2>客席端末とテーブル</h2><p>客席からは変更できません。端末を置き替えたときだけここで設定します。</p></div></div>
          <div className="device-admin-grid">{state.devices.map((device, index) => <article key={device.deviceId}><div className="device-admin-icon"><Monitor size={38} weight="duotone" /></div><div><small>端末 {String(index + 1).padStart(2, "0")}</small><h3>{device.label}</h3><code>{device.deviceId}</code></div><label>固定テーブル<select value={device.tableId} onChange={(event) => updateState((current) => ({ ...current, devices: current.devices.map((item) => item.deviceId === device.deviceId ? { ...item, tableId: event.target.value } : item) }))}>{[1, 2, 3, 4, 5, 6, 7, 8].map((tableId) => <option value={String(tableId)} key={tableId}>テーブル {tableId}</option>)}</select></label><ConnectionBadge online={!state.offlineDevices.includes(device.deviceId)} compact /></article>)}</div>
        </> : null}
      </section>
    </StaffShell>
  );
}

function PairingScreen({ onClaim, error }) {
  const [pairingCode, setPairingCode] = useState("");
  const [displayName, setDisplayName] = useState("customer tablet");
  const [submitting, setSubmitting] = useState(false);
  const submit = async (event) => {
    event.preventDefault();
    if (submitting || !pairingCode.trim()) return;
    setSubmitting(true);
    try { await onClaim({ pairingCode: pairingCode.trim(), displayName: displayName.trim() }); }
    finally { setSubmitting(false); }
  };
  return <main className="customer-shell"><section className="empty-state"><h1>端末登録</h1><p>管理者から受け取ったペアリングコードを入力してください。</p><form className="inline-form" onSubmit={submit}><label>ペアリングコード<input value={pairingCode} onChange={(event) => setPairingCode(event.target.value)} autoComplete="off" required /></label><label>端末名<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={80} required /></label><button className="button button--primary" disabled={submitting}>{submitting ? "登録中" : "端末を登録"}</button></form>{error ? <p role="alert">ペアリングに失敗しました。管理者へコードの再発行を依頼してください。</p> : null}</section></main>;
}

export function App() {
  const route = useRoute();
  const [orderClient, setOrderClient] = useState(null);
  const [kitchenApiState, setKitchenApiState] = useState(null);
  const [pairingError, setPairingError] = useState(false);
  const [state, setState] = useState(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || defaultState; } catch { return defaultState; }
  });

  const updateState = (updater) => setState((current) => typeof updater === "function" ? updater(current) : updater);

  useEffect(() => {
    if (route !== "/kitchen" || !kitchenApiConfigured(window)) {
      setKitchenApiState(null);
      return undefined;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const orders = await fetchKitchenOrders({ env: window });
        if (!cancelled) setKitchenApiState({ loading: false, error: false, orders });
      } catch {
        if (!cancelled) setKitchenApiState({ loading: false, error: true, orders: [] });
      }
    };
    setKitchenApiState({ loading: true, error: false, orders: [] });
    void load();
    const timer = window.setInterval(load, 2_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [route]);

  const serveKitchenItem = async (orderId, orderItemId) => {
    try {
      await markKitchenItemServed({ env: window, orderId, orderItemId });
      const orders = await fetchKitchenOrders({ env: window });
      setKitchenApiState({ loading: false, error: false, orders });
    } catch {
      setKitchenApiState((current) => current ? { ...current, error: true } : current);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const bootstrap = async () => {
      const client = await bootstrapCustomerOrderClient({ globalObject: window });
      if (!cancelled && client) setOrderClient(client);
    };
    void bootstrap().catch(() => { if (!cancelled) setPairingError(true); });
    return () => { cancelled = true; };
  }, []);

  const claim = async ({ pairingCode, displayName }) => {
    const config = resolveOrderApiConfig({ ...window, location: window.location, navigator: window.navigator, WARUN_ORDER_MODE: "api" });
    const store = createIndexedDbCredentialStore({ indexedDB: window.indexedDB });
    const device = await loadOrCreateCustomerDevice({ store, globalObject: window });
    await claimCustomerDevice({ store, baseUrl: config.baseUrl || new URL("/v1", window.location.origin).toString(), pairingCode, deviceId: device.deviceId, displayName, appVersion: "prototype" });
    const credentials = await store.load();
    const runtime = runtimeForCustomerCredentials({ globalObject: window, baseUrl: config.baseUrl || new URL("/v1", window.location.origin).toString(), token: credentials.token });
    setPairingError(false);
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
    if (route === "/") return <CustomerScreen state={state} updateState={updateState} deviceId="customer-03" orderClient={orderClient} />;
    if (route.startsWith("/customer/")) return <CustomerScreen state={state} updateState={updateState} deviceId={route.split("/")[2]} orderClient={orderClient} />;
    if (route === "/kitchen") return <KitchenScreen state={state} updateState={updateState} apiState={kitchenApiState} onServe={serveKitchenItem} />;
    if (route === "/history") return <HistoryScreen state={state} apiMode={Boolean(configuredAdminToken(window))} />;
    if (route.startsWith("/admin/")) return <AdminScreen state={state} updateState={updateState} section={route.split("/")[2] || "menu"} />;
    if (route === "/devices") return <Launcher state={state} updateState={updateState} />;
    return <CustomerScreen state={state} updateState={updateState} deviceId="customer-03" orderClient={orderClient} />;
  }, [route, state, orderClient, kitchenApiState, pairingError]);

  return content;
}
