import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { pairingCodeFromLocation } from "./admin-pairing.js";
import { claimCustomerDevice, createIndexedDbCredentialStore, loadOrCreateCustomerDevice, pairingClaimErrorMessage } from "./device-credentials.js";
import "./styles.css";

function normalizePairingCode(value) {
  return value.replace(/[\s-]/g, "").toUpperCase();
}

function PairingPage() {
  const [pairingCode, setPairingCode] = useState(() => pairingCodeFromLocation(window.location));
  const [displayName, setDisplayName] = useState("customer tablet");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event) => {
    event.preventDefault();
    if (submitting || !pairingCode.trim() || !displayName.trim()) return;
    setSubmitting(true);
    setError("");
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
    } catch (claimError) {
      setError(pairingClaimErrorMessage(claimError));
    } finally {
      setSubmitting(false);
    }
  };

  return <main className="customer-shell"><section className="empty-state pairing-page"><h1>端末登録</h1><p>{pairingCode ? "QRコードから登録情報を読み込みました。端末名を確認して登録してください。" : "管理者から受け取ったQRコードを読み取ってください。"}</p><form className="inline-form" onSubmit={submit}><label>ペアリングコード<input value={pairingCode} onChange={(event) => setPairingCode(event.target.value)} inputMode="text" autoComplete="off" maxLength={14} placeholder="ABCD-EFGH-IJKL" required /></label><label>端末名<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={80} required /></label><button className="button button--primary" disabled={submitting}>{submitting ? "登録中" : "端末を登録"}</button></form>{error ? <p role="alert">{error}</p> : null}</section></main>;
}

createRoot(document.getElementById("pairing-root")).render(<PairingPage />);
