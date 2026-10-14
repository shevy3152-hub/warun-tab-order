import { fetchKitchenSnapshot } from "./kitchen-api.js";
import { useEffect, useRef, useState } from "react";
import { createKitchenOrderSound, createKitchenSoundEngine, kitchenSoundStorageKey, DEFAULT_KITCHEN_SOUND_VOLUME } from "./kitchen-order-sound.js";

export function KitchenOrderSound({ orders, staffCalls = [], suppressStaffCalls = false, ready, requestStartedAt, demoMode }) {
  const controller = useRef(null);
  const latestOrders = useRef(orders);
  const latestStaffCalls = useRef(staffCalls);
  latestOrders.current = orders;
  latestStaffCalls.current = staffCalls;
  const [state, setState] = useState({ status: "off", message: "通知音はOFFです。", storageAvailable: true, volume: DEFAULT_KITCHEN_SOUND_VOLUME });
  const storageKey = kitchenSoundStorageKey(window);
  useEffect(() => {
    let storage;
    try { storage = window.localStorage; } catch { /* Report unavailable persistence below. */ }
    const engine = createKitchenSoundEngine({ env: window, onStateChange: (value) => controller.current?.audioStateChanged(value) });
    const instance = createKitchenOrderSound({ storage, storageKey, engine, loadBaseline: async ({ signal }) => demoMode ? { orders: latestOrders.current, staffCalls: latestStaffCalls.current } : fetchKitchenSnapshot({ env: window, signal }), onChange: setState, now: () => window.performance.now() });
    controller.current = instance;
    setState(instance.getState());
    return () => { controller.current = null; instance.dispose(); };
  }, [storageKey, demoMode]);
  useEffect(() => {
    controller.current?.observe(orders, { staffCalls, suppressStaffCalls, ready, requestStartedAt: demoMode ? window.performance.now() : requestStartedAt, allowUnversioned: demoMode });
  }, [orders, staffCalls, suppressStaffCalls, ready, requestStartedAt, demoMode, storageKey]);
  const enabling = state.status === "enabling";
  const enabled = state.status === "on";
  const switchNotification = () => void controller.current?.setEnabled(!["on", "enabling"].includes(controller.current.getState().status));
  return <section className="kitchen-order-sound" aria-label="新着注文・スタッフ呼出の通知音">
    <div className="kitchen-order-sound__actions">
      <div className="kitchen-order-sound__switch-field"><b>新着注文・スタッフ呼出の通知音</b><button type="button" role="switch" aria-label="新着注文・スタッフ呼出の通知音" aria-checked={enabled} aria-busy={enabling} className={`kitchen-order-sound__switch ${enabled ? "is-on" : ""}`} onClick={switchNotification}><i aria-hidden="true" /><span>{enabling ? "有効化中（中止）" : enabled ? "ON" : "OFF"}</span></button></div>
      <label className="kitchen-order-sound__volume"><span>音量 <output>{state.volume === 0 ? "消音（0％）" : `${state.volume}％`}</output></span><input type="range" min="0" max="100" step="1" value={state.volume} aria-label="通知音の音量" aria-valuetext={state.volume === 0 ? "消音" : `${state.volume}％`} onChange={(event) => controller.current?.setVolume(Number(event.target.value))} /></label>
      <button type="button" className="button button--quiet" disabled={enabling} onClick={() => void controller.current?.test()}>音を試す</button>
    </div>
    <small role="status">{state.message}{!state.storageAvailable ? " このブラウザーでは音量・通知済みIDを保存できません。" : ""}</small>
  </section>;
}
