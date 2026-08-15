import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { claimCustomerDevice, createIndexedDbCredentialStore, loadOrCreateCustomerDevice } from "./device-credentials.js";
import "./styles.css";

function normalizePairingCode(value) {
  return value.replace(/[\s-]/g, "").toUpperCase();
}

function PairingPage() {
  const [pairingCode, setPairingCode] = useState("");
  const [displayName, setDisplayName] = useState("customer tablet");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    if (submitting || !pairingCode.trim() || !displayName.trim()) return;
    setSubmitting(true);
    setError(false);
    try {
      const store = createIndexedDbCredentialStore({ indexedDB: window.indexedDB });
      const device = await loadOrCreateCustomerDevice({ store, globalObject: window });
      await claimCustomerDevice({
        store,
        baseUrl: new URL("/v1", window.location.origin).toString(),
        pairingCode: normalizePairingCode(pairingCode),
        deviceId: device.deviceId,
        displayName: displayName.trim(),
        appVersion: "prototype",
      });
      window.location.assign("/");
    } catch {
      setError(true);
    } finally {
      setSubmitting(false);
    }
  };

  return <main className="customer-shell"><section className="empty-state pairing-page"><h1>端末登録</h1><p>管理者から受け取った12文字のコードを入力してください。</p><form className="inline-form" onSubmit={submit}><label>ペアリングコード<input value={pairingCode} onChange={(event) => setPairingCode(event.target.value)} inputMode="text" autoComplete="off" maxLength={14} placeholder="ABCD-EFGH-IJKL" required /></label><label>端末名<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={80} required /></label><button className="button button--primary" disabled={submitting}>{submitting ? "登録中" : "端末を登録"}</button></form>{error ? <p role="alert">登録に失敗しました。コードの有効期限・入力内容を確認してください。</p> : null}</section></main>;
}

createRoot(document.getElementById("pairing-root")).render(<PairingPage />);
