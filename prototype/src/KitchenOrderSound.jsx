import { fetchKitchenSnapshot } from "./kitchen-api.js";
import { useEffect, useRef, useState } from "react";
import { createKitchenOrderSound, createKitchenSoundEngine, initialKitchenOrderSoundState, kitchenSoundStorageKey } from "./kitchen-order-sound.js";

export function KitchenOrderSound({ orders, staffCalls = [], suppressStaffCalls = false, ready, requestStartedAt, demoMode }) {
  const controller = useRef(null);
  const latestOrders = useRef(orders);
  const latestStaffCalls = useRef(staffCalls);
  latestOrders.current = orders;
  latestStaffCalls.current = staffCalls;
  const storageKey = kitchenSoundStorageKey(window);
  const [state, setState] = useState(() => {
    let storage;
    try { storage = window.localStorage; } catch { /* Initial display still uses the default ON preference. */ }
    return initialKitchenOrderSoundState(storage, storageKey);
  });
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
  const enabled = state.requestedOn;
  const playingEnabled = state.status === "on";
  const switchNotification = () => {
    const current = controller.current?.getState();
    if (!current) return;
    if (current.status === "enabling") void controller.current?.setEnabled(false);
    else void controller.current?.setEnabled(!current.requestedOn);
  };
  return <section className="kitchen-order-sound" aria-label="新着注文・スタッフ呼出の通知音">
    <div className="kitchen-order-sound__actions">
      <div className="kitchen-order-sound__switch-field"><b>新着注文・スタッフ呼出の通知音</b><button type="button" role="switch" aria-label="新着注文・スタッフ呼出の通知音設定" aria-checked={enabled} aria-describedby="kitchen-order-sound-status" aria-busy={enabling} className={`kitchen-order-sound__switch ${enabled ? "is-on" : ""}`} onClick={switchNotification}><i aria-hidden="true" /><span>{enabling ? "有効化中（中止）" : playingEnabled ? "ON" : enabled ? "ON（音声未有効）" : "OFF"}</span></button></div>
      <label className="kitchen-order-sound__volume"><span>音量 <output>{state.volume === 0 ? "消音（0％）" : `${state.volume}％`}</output></span><input type="range" min="0" max="100" step="1" value={state.volume} aria-label="通知音の音量" aria-valuetext={state.volume === 0 ? "消音" : `${state.volume}％`} onChange={(event) => controller.current?.setVolume(Number(event.target.value))} /></label>
      {enabled && !playingEnabled && !enabling ? <button type="button" className="button button--primary" onClick={() => void controller.current?.enable()}>音を有効にする</button> : null}
      <button type="button" className="button button--quiet" disabled={enabling} onClick={() => void controller.current?.test()}>音を試す</button>
      {demoMode ? <button type="button" className="button button--quiet" disabled={enabling} onClick={() => void controller.current?.test("staffCall")}>呼出音を試す（隔離）</button> : null}
    </div>
    <small id="kitchen-order-sound-status" role="status">{state.message}{!state.storageAvailable ? " このブラウザーでは音量・通知済みIDを保存できません。" : ""}</small>
  </section>;
}
