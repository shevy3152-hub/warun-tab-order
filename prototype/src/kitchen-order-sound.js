export const KITCHEN_NOTIFICATION_GAIN = 0.35;
export const DEFAULT_KITCHEN_SOUND_VOLUME = 50;
export function normalizeKitchenSoundVolume(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(Math.max(0, Math.min(100, value))) : DEFAULT_KITCHEN_SOUND_VOLUME;
}

function readKitchenSoundSettings(storage, storageKey) {
  let stored = {};
  let storageAvailable = true;
  try {
    if (typeof storage?.getItem !== "function") throw new Error("Storage unavailable");
    stored = JSON.parse(storage.getItem(storageKey) || "{}");
  } catch { storageAvailable = false; }
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) stored = {};
  return {
    requestedOn: typeof stored.requestedOn === "boolean" ? stored.requestedOn : true,
    volume: normalizeKitchenSoundVolume(stored.volume),
    seenIds: Array.isArray(stored.seenIds) ? stored.seenIds.filter((id) => typeof id === "string") : [],
    seenCallIds: Array.isArray(stored.seenCallIds) ? stored.seenCallIds.filter((id) => typeof id === "string") : [],
    seenCheckoutIds: Array.isArray(stored.seenCheckoutIds) ? stored.seenCheckoutIds.filter((id) => typeof id === "string") : [],
    storageAvailable,
  };
}

export function initialKitchenOrderSoundState(storage, storageKey) {
  const { requestedOn, volume, storageAvailable } = readKitchenSoundSettings(storage, storageKey);
  return {
    status: requestedOn ? "needs-activation" : "off",
    message: requestedOn
      ? "通知音の設定はONです。ブラウザーの再生制限により音声は未有効です。「音を有効にする」を押してください。"
      : "通知音はOFFです。スイッチをONにすると有効になります。",
    audioStatus: "idle",
    baselineStatus: "idle",
    storageAvailable,
    volume,
    requestedOn,
  };
}

export function kitchenSoundStorageKey(env = globalThis) {
  try {
    const endpoint = new URL(env.WARUN_API_BASE || "/v1", env.location?.origin);
    return "warun:kitchen-order-sound:v1:" + endpoint.origin + endpoint.pathname.replace(/\/+$/, "") + (env.WARUN_ORDER_MODE === "demo" || new URLSearchParams(env.location?.search).get("demo") === "1" ? ":demo" : ":api");
  } catch { return "warun:kitchen-order-sound:v1:local"; }
}

export function createKitchenSoundEngine({ env = globalThis, onStateChange = () => {} } = {}) {
  let context = null;
  let nextStart = 0;
  let volume = DEFAULT_KITCHEN_SOUND_VOLUME;
  const nodes = new Set();
  return {
    async activate() {
      const Constructor = env.AudioContext || env.webkitAudioContext;
      if (!Constructor) throw new Error("Audio unavailable");
      if (!context) {
        context = new Constructor();
        context.onstatechange = () => onStateChange(context.state);
      }
      await context.resume();
      if (context.state !== "running") throw new Error("Audio not running");
    },
    setVolume(value) { volume = normalizeKitchenSoundVolume(value); if (volume === 0) this.stop(); },
    isRunning() { return context?.state === "running"; },
    play(kind = "order") {
      if (context?.state !== "running") throw new Error("Audio not running");
      if (volume === 0) return;
      const peak = KITCHEN_NOTIFICATION_GAIN * volume / DEFAULT_KITCHEN_SOUND_VOLUME;
      const reservationStart = Math.max(context.currentTime, nextStart);
      const isStaffCall = kind === "staffCall";
      const isCheckout = kind === "checkout";
      const start = reservationStart + (isStaffCall ? 0.5 : 0);
      nextStart = start + (isStaffCall ? 2.2 : isCheckout ? 1.5 : 0.42);
      const callPair = [{ frequency: 523, duration: 0.18, holdAt: 0.12 }, { frequency: 659, duration: 0.18, holdAt: 0.12 }];
      const notes = isStaffCall
        ? Array.from({ length: 3 }, (_, repeat) => callPair.map((note, index) => ({ ...note, at: repeat * 0.85 + index * 0.27 }))).flat()
        : Array.from({ length: isCheckout ? 3 : 1 }, (_, repeat) => ({ frequency: 880, at: repeat * 0.5, endFrequency: 1174, sweepAt: 0.14, duration: 0.34, holdAt: 0.20 }));
      for (const note of notes) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const noteStart = start + note.at;
        nodes.add(oscillator);
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(note.frequency, noteStart);
        if (note.endFrequency) oscillator.frequency.setValueAtTime(note.endFrequency, noteStart + note.sweepAt);
        gain.gain.setValueAtTime(0, noteStart);
        gain.gain.linearRampToValueAtTime(peak, noteStart + 0.015);
        gain.gain.setValueAtTime(peak, noteStart + note.holdAt);
        gain.gain.exponentialRampToValueAtTime(0.001, noteStart + note.duration);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.onended = () => { nodes.delete(oscillator); oscillator.disconnect(); gain.disconnect(); };
        oscillator.start(noteStart);
        oscillator.stop(noteStart + note.duration);
      }
    },
    stop() {
      for (const oscillator of nodes) { try { oscillator.stop(); oscillator.disconnect(); } catch { /* Already ended. */ } }
      nodes.clear();
      nextStart = 0;
    },
    dispose() {
      this.stop();
      if (context) { context.onstatechange = null; void context.close().catch(() => {}); }
    },
  };
}

export function createKitchenOrderSound({ storage, storageKey, engine, loadBaseline = async () => [], now = () => performance.now(), nowEpoch = () => Date.now(), onChange = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, timeoutMs = 8000 } = {}) {
  const settings = readKitchenSoundSettings(storage, storageKey);
  let storageAvailable = settings.storageAvailable;
  const seen = new Set(settings.seenIds);
  const seenCallIds = new Set(settings.seenCallIds);
  const seenCheckoutIds = new Set(settings.seenCheckoutIds);
  let volume = settings.volume;
  engine.setVolume?.(volume);
  let requestedOn = settings.requestedOn;
  let initialized = false;
  let enabledAt = Infinity;
  let activationEpochAt = Infinity;
  let enablingCheckouts = new Map();
  let generation = 0;
  let disposed = false;
  let status = requestedOn ? "needs-activation" : "off";
  let message = requestedOn
    ? "通知音の設定はONです。ブラウザーの再生制限により音声は未有効です。「音を有効にする」を押してください。"
    : "通知音はOFFです。スイッチをONにすると有効になります。";
  let pending = null;
  let audioStatus = "idle";
  let baselineStatus = "idle";
  const state = () => ({ status, message, storageAvailable, audioStatus, baselineStatus, volume, requestedOn });
  const cancelPending = () => { pending?.abort(); pending = null; };
  const bounded = (operation, stage, signal) => new Promise((resolve, reject) => {
    let timer;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      signal.removeEventListener("abort", abort);
      callback(value);
    };
    const abort = () => finish(reject, { stage, code: "CANCELLED" });
    signal.addEventListener("abort", abort, { once: true });
    timer = setTimer(() => finish(reject, { stage, code: "TIMEOUT" }), timeoutMs);
    Promise.resolve(operation).then(value => finish(resolve, value), error => finish(reject, { stage, code: error?.code, status: error?.status, name: error?.name, message: error?.message }));
  });
  const publish = () => onChange(state());
  const persist = () => {
    if (!storageAvailable) return;
    try {
      if (!storage?.setItem) throw new Error("Storage unavailable");
      storage.setItem(storageKey, JSON.stringify({ requestedOn, seenIds: [...seen], seenCallIds: [...seenCallIds], seenCheckoutIds: [...seenCheckoutIds], volume }));
    } catch { storageAvailable = false; publish(); }
  };
  const fail = (error = {}, stage = error.stage || "audio") => {
    generation += 1;
    cancelPending();
    enabledAt = Infinity;
    for (const checkout of enablingCheckouts.values()) seenCheckoutIds.add(checkout.checkoutRequestId);
    enablingCheckouts.clear();
    persist();
    engine.stop();
    status = "blocked";
    if (stage === "audio") audioStatus = "failed";
    else baselineStatus = "failed";
    const reason = stage === "audio"
      ? error.code === "TIMEOUT" ? "音声有効化が8秒以内に完了しませんでした"
        : error.message === "Audio unavailable" ? "このブラウザーは音声機能に対応していません"
        : error.name === "NotAllowedError" ? "ブラウザーが音声の有効化を拒否しました"
        : "音声を実行中にできませんでした（停止・再生失敗）"
      : error.code === "TIMEOUT" ? "厨房の新着一覧取得が8秒以内に完了しませんでした"
        : error.code === "API_UNAVAILABLE" ? "厨房APIの接続先または認証設定がありません"
        : error.status ? `厨房の新着一覧取得に失敗しました（HTTP ${error.status}）`
        : error.code === "INVALID_RESPONSE" ? "厨房の新着一覧応答形式が不正です"
        : "厨房の新着一覧を取得できませんでした（通信・応答エラー）";
    message = `${reason}。通知音の設定はONですが、音声は再生できる状態ではありません。注文・スタッフ呼出・会計依頼の画面表示は続きます。「音を有効にする」を押して再試行してください。`;
    publish();
  };
  return {
    getState: state,
    setEnabled(value) { return value ? this.enable() : this.disable(); },
    setVolume(value) {
      if (disposed) return;
      volume = normalizeKitchenSoundVolume(value);
      engine.setVolume?.(volume);
      persist();
      publish();
    },
    async enable() {
      if (disposed) return;
      cancelPending();
      const attempt = ++generation;
      pending = new AbortController();
      const signal = pending.signal;
      status = "enabling";
      requestedOn = true;
      persist();
      audioStatus = "pending";
      baselineStatus = "pending";
      enabledAt = Infinity;
      activationEpochAt = nowEpoch();
      enablingCheckouts.clear();
      const activationStartedAt = now();
      message = "有効化中：音声と厨房の新着一覧を確認しています。クリックで中止できます。";
      publish();
      const progress = (stage) => {
        if (disposed || attempt !== generation) return;
        if (stage === "audio") audioStatus = "ready";
        else baselineStatus = "ready";
        message = audioStatus !== "ready" ? "有効化中：音声の有効化を待っています。クリックで中止できます。"
          : baselineStatus !== "ready" ? "有効化中：音声は準備済み、厨房の新着一覧取得を待っています。クリックで中止できます。"
          : "有効化中：ONを確定しています。";
        publish();
      };
      try {
        // Both operations start in the click handler; only a completed baseline can confirm ON.
        const activation = bounded(engine.activate(), "audio", signal).then(() => progress("audio"));
        const baselineRead = bounded(loadBaseline({ signal }), "baseline", signal).then(baseline => {
          if (!Array.isArray(baseline) && (!baseline || !Array.isArray(baseline.orders) || !Array.isArray(baseline.staffCalls ?? []) || !Array.isArray(baseline.checkoutRequests ?? []))) throw { stage: "baseline", code: "INVALID_RESPONSE" };
          progress("baseline");
          return baseline;
        });
        const [, baseline] = await Promise.all([activation, baselineRead]);
        if (disposed || attempt !== generation) return;
        if (engine.isRunning?.() === false) throw { stage: "audio", message: "Audio not running" };
        pending = null;
        const baselineOrders = Array.isArray(baseline) ? baseline : baseline.orders;
        const baselineCalls = Array.isArray(baseline) ? [] : baseline.staffCalls ?? [];
        const baselineCheckouts = Array.isArray(baseline) ? [] : baseline.checkoutRequests ?? [];
        for (const order of baselineOrders) if (typeof order?.id === "string" && order.id) seen.add(order.id);
        for (const call of baselineCalls) {
          const id = call?.id ?? call?.staffCallId;
          if (typeof id === "string" && id) seenCallIds.add(id);
        }
        for (const checkout of baselineCheckouts) {
          if (typeof checkout?.checkoutRequestId === "string" && checkout.checkoutRequestId) seenCheckoutIds.add(checkout.checkoutRequestId);
        }
        initialized = true;
        status = "on";
        requestedOn = true;
        enabledAt = activationStartedAt;
        message = "通知音ON：新着注文・スタッフ呼出・お会計依頼を受信すると鳴ります。";
        const baselineCheckoutIds = new Set(baselineCheckouts.map((checkout) => checkout?.checkoutRequestId).filter((id) => typeof id === "string" && id));
        for (const checkout of enablingCheckouts.values()) {
          const requestedAt = Number(checkout.requestedAtMs);
          const createdAfterActivation = Number.isFinite(requestedAt) ? requestedAt >= activationEpochAt : !baselineCheckoutIds.has(checkout.checkoutRequestId);
          if (checkout.status === "requested" && createdAfterActivation && volume > 0) {
            try { engine.play("checkout"); } catch (error) { fail(error); break; }
          }
          seenCheckoutIds.add(checkout.checkoutRequestId);
        }
        enablingCheckouts.clear();
        persist();
        publish();
      } catch (error) { if (!disposed && attempt === generation) fail(error); }
    },
    disable() {
      if (disposed) return;
      generation += 1;
      cancelPending();
      audioStatus = "idle";
      baselineStatus = "idle";
      enabledAt = Infinity;
      for (const checkout of enablingCheckouts.values()) seenCheckoutIds.add(checkout.checkoutRequestId);
      enablingCheckouts.clear();
      requestedOn = false;
      engine.stop();
      status = "off";
      message = "通知音はOFFです。";
      persist();
      publish();
    },
    async test(kind = "order") {
      if (disposed) return;
      const attempt = generation;
      if (volume === 0) { message = "消音（音量0％）のため試聴音は鳴りません。"; publish(); return; }
      try {
        await engine.activate();
        if (disposed || attempt !== generation) return;
        if (volume > 0) engine.play(kind);
        message = volume === 0 ? "消音（音量0％）のため試聴音は鳴りません。" : status === "on" ? "通知音ON：試聴音を再生しました。" : requestedOn ? "試聴音を再生しました。通知音設定はONですが、通知を有効にするには「音を有効にする」を押してください。" : "試聴音を再生しました。新着通知の設定はOFFです。";
        publish();
      } catch (error) {
        if (disposed || attempt !== generation) return;
        if (status === "on" && engine.isRunning?.() === false) { fail(error); return; }
        message = "試聴できませんでした（音声の有効化・再生失敗）。通知スイッチの状態は変更していません。音を試すを再度クリックしてください。";
        publish();
      }
    },
    observe(orders, { staffCalls = [], checkoutRequests = [], suppressStaffCalls = false, ready = true, requestStartedAt, allowUnversioned = false } = {}) {
      if (disposed || !ready || !Array.isArray(orders) || !Array.isArray(staffCalls) || !Array.isArray(checkoutRequests)) return;
      const first = !initialized;
      initialized = true;
      const startedBeforeActivation = status === "on" && Number.isFinite(requestStartedAt) && requestStartedAt < enabledAt;
      // Keep post-activation IDs unknown until an activation-current read can notify.
      // Baseline/OFF IDs stay in the seen sets; absent creation times stay conservative.
      const awaitsFreshRead = (createdAt) => volume > 0 && startedBeforeActivation && Number.isFinite(createdAt) && createdAt >= activationEpochAt;
      const addedOrders = [];
      const addedCalls = [];
      const addedCheckouts = [];
      for (const order of orders) {
        if (typeof order?.id !== "string" || !order.id || seen.has(order.id)) continue;
        if (awaitsFreshRead(Date.parse(order.createdAt))) continue;
        seen.add(order.id);
        addedOrders.push(order);
      }
      for (const call of staffCalls) {
        const id = call?.id ?? call?.staffCallId;
        if (typeof id !== "string" || !id || seenCallIds.has(id) || call.status === "resolved") continue;
        const createdAt = Number(call.createdAtMs ?? (call.createdAt ? Date.parse(call.createdAt) : NaN));
        if (!suppressStaffCalls && awaitsFreshRead(createdAt)) continue;
        seenCallIds.add(id);
        if (!suppressStaffCalls) addedCalls.push(call);
      }
      for (const checkout of checkoutRequests) {
        const id = checkout?.checkoutRequestId;
        if (typeof id !== "string" || !id || seenCheckoutIds.has(id)) continue;
        if (status === "enabling" && requestedOn) {
          enablingCheckouts.set(id, checkout);
          continue;
        }
        seenCheckoutIds.add(id);
        addedCheckouts.push(checkout);
      }
      if (addedOrders.length || addedCalls.length || addedCheckouts.length) persist();
      if (first) return;
      const notifications = [];
      const freshSnapshot = status === "on" && Number.isFinite(requestStartedAt) && requestStartedAt >= enabledAt;
      for (const order of addedOrders) {
        if (!freshSnapshot) continue;
        // An unseen restored/edited order is not a newly created order.
        if (!["new", "active"].includes(order.status) || (order.version !== 1 && !(allowUnversioned && order.version == null))) continue;
        notifications.push("order");
      }
      for (const call of addedCalls) {
        if (!freshSnapshot) continue;
        if (!Number.isFinite(Number(call.createdAtMs ?? (call.createdAt ? Date.parse(call.createdAt) : NaN)))) continue;
        notifications.push("staffCall");
      }
      for (const checkout of addedCheckouts) {
        const requestedAt = Number(checkout.requestedAtMs);
        const createdAfterActivation = Number.isFinite(requestedAt) ? requestedAt >= activationEpochAt : freshSnapshot;
        if (status === "on" && checkout.status === "requested" && createdAfterActivation) notifications.push("checkout");
      }
      for (const notification of notifications) {
        try { if (volume > 0) engine.play(notification); } catch { fail(); break; }
      }
    },
    audioStateChanged(value) { if (!disposed && status === "on" && value !== "running") fail(); },
    dispose() { disposed = true; generation += 1; cancelPending(); engine.dispose(); },
  };
}
