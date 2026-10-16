import { useEffect, useRef, useState } from "react";
import { uploadAdminProductImage } from "./admin-pairing.js";
import { copyProductImageFolder, productImageLocation } from "./product-image-location.js";

const publicImages = import.meta.glob("/public/menu-images/**/*.{png,jpg,jpeg,webp,avif,gif,svg}", { eager: true, query: "?url", import: "default" });
const knownPaths = Object.keys(publicImages).map((path) => path.slice("/public".length));
const publicFolder = import.meta.env.VITE_PRODUCT_IMAGE_PUBLIC_FOLDER ?? "";

export function ProductImageLocation({ uri, label, fallback = false, fallbackUri = "" }) {
  const input = useRef(null);
  const section = useRef(null);
  const [currentFallback, setCurrentFallback] = useState(fallbackUri);
  useEffect(() => {
    if (!fallback) return undefined;
    const form = section.current?.closest("form");
    const refresh = () => setCurrentFallback(form?.elements.namedItem("imageUri")?.value ?? fallbackUri);
    refresh();
    form?.addEventListener("input", refresh);
    return () => form?.removeEventListener("input", refresh);
  }, [fallback, fallbackUri]);
  const [message, setMessage] = useState("");
  useEffect(() => setMessage(""), [uri]);
  const location = productImageLocation(uri || (fallback ? currentFallback : ""), { knownPaths, publicFolder, origin: typeof window === "undefined" ? "" : window.location.origin });
  const copy = async () => {
    try {
      await copyProductImageFolder(location.folder, input.current, { clipboard: window.navigator?.clipboard, execCommand: (command) => document.execCommand(command) });
      setMessage("保存先のパスをコピーしました。");
    } catch { setMessage("コピーできませんでした。パスを選択してコピーしてください。"); }
  };
  return <section ref={section} className="product-image-location" aria-label={label + "の画像ファイルの場所"}>
    <strong>{label}：画像ファイルの場所</strong>
    {fallback && !uri && currentFallback ? <small>詳細画像URIが空の場合は商品画像を使用します。</small> : null}
    {location.filename ? <div>画像ファイル名：{location.filename}</div> : null}
    {location.kind === "local" ? <>
      <label>保存先フォルダ{location.absolute ? "（絶対パス）" : "（プロジェクト内の相対位置）"}<input ref={input} readOnly value={location.folder} onFocus={(event) => event.currentTarget.select()} /></label>
      <div className="product-image-location__actions"><button type="button" className="button button--outline" onClick={() => void copy()}>保存先のパスをコピー</button>{location.folderUrl ? <a href={location.folderUrl} target="_blank" rel="noreferrer">フォルダを開く（対応ブラウザーのみ）</a> : null}</div>
      {!location.absolute ? <small>絶対パスはこのbuildに未設定です。コピーされるのは上記の相対位置です。</small> : <small>リンクを開けないブラウザーではパスコピーをご利用ください。</small>}
      <small>画像欄はURIの指定用です。ファイルのアップロードは行いません。画像ファイルの配置と配信先への反映は別途必要です。一覧用・詳細用のURIをそれぞれ確認してください。</small>
    </> : <small>{location.message}</small>}
    {message ? <small role="status">{message}</small> : null}
  </section>;
}

export function ProductImageUriField({ name, label, initialUri = "", fallbackUri = "", resolveDisplayUri = (uri) => uri }) {
  const [uri, setUri] = useState(initialUri);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [previewError, setPreviewError] = useState(false);
  useEffect(() => setUri(initialUri), [initialUri]);
  useEffect(() => setPreviewError(false), [uri]);
  const upload = async (event) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    setUploadError("");
    setUploading(true);
    try {
      const result = await uploadAdminProductImage({ env: window, file });
      setUri(result.uri);
    } catch (error) {
      const messages = {
        IMAGE_TOO_LARGE: "画像は5MB以下を選択してください。",
        IMAGE_TYPE_UNSUPPORTED: "PNG・JPEG・WebP形式のみアップロードできます。",
        IMAGE_DATA_INVALID: "選択した形式と画像データが一致しません。画像ファイルを確認してください。",
        IMAGE_EMPTY: "画像データが空です。",
        AUTHENTICATION_FAILED: "管理者認証に失敗しました。管理者として再接続してください。",
        AUTHORIZATION_FAILED: "画像のアップロードには管理者権限が必要です。",
      };
      setUploadError(messages[error?.code] ?? error?.message ?? "画像をアップロードできませんでした。");
    } finally { setUploading(false); }
  };
  const displayUri = resolveDisplayUri(uri);
  return <div className="product-image-uri-field">
    <label>{label}<input name={name} value={uri} onChange={(event) => setUri(event.target.value)} /></label>
    <label>{label}をアップロード<input type="file" accept="image/png,image/jpeg,image/webp" onChange={upload} disabled={uploading} /></label>
    <small>{uploading ? "画像をアップロード中です。" : "PNG・JPEG・WebP、5MB以下。選択した画像はアップロード後にプレビューされます。商品への反映は保存ボタンを押した後です。"}</small>
    {uploadError ? <small role="alert">{uploadError}</small> : null}
    {displayUri && !previewError ? <img className="product-image-uri-field__preview" src={displayUri} alt={`${label}のプレビュー`} onError={() => setPreviewError(true)} /> : displayUri ? <small role="status">画像を表示できません。URIまたは配信状態を確認してください。</small> : null}
    {displayUri !== uri ? <small>一覧表示ではURIのthumb-v1をthumb-v2へ読み替えます。</small> : null}
    <ProductImageLocation uri={displayUri} label={name === "detailImageUri" ? "詳細画像" : "一覧・商品画像"} fallback={name === "detailImageUri"} fallbackUri={fallbackUri} />
  </div>;
}
