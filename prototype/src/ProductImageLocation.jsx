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
      <small>商品編集フォームのURI欄から画像を選んでアップロードできます。プレビューが更新された後、「変更を保存」すると商品へ反映されます。URIの直接入力も引き続き利用できます。</small>
    </> : <small>{location.message}</small>}
    {message ? <small role="status">{message}</small> : null}
  </section>;
}

export function ProductImageUriField({ name, label, initialUri = "", fallbackUri = "", resolveDisplayUri = (uri) => uri }) {
  const [uri, setUri] = useState(initialUri);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [uploadSuccess, setUploadSuccess] = useState("");
  const [previewError, setPreviewError] = useState(false);
  useEffect(() => setUri(initialUri), [initialUri]);
  useEffect(() => setPreviewError(false), [uri]);
  const upload = async (event) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    setUploadError("");
    setUploadSuccess("");
    setUploading(true);
    let uploaded = false;
    try {
      const result = await uploadAdminProductImage({ env: window, file });
      uploaded = true;
      const previewUri = resolveDisplayUri(result.uri);
      await new Promise((resolve, reject) => {
        const image = new window.Image();
        image.onload = resolve;
        image.onerror = () => reject(new Error("画像のプレビューを読み込めませんでした。"));
        image.src = previewUri;
      });
      setUri(result.uri);
      setPreviewError(false);
      setUploadSuccess("アップロードに成功し、プレビューを更新しました。商品への反映は「変更を保存」後です。");
    } catch (error) {
      const messages = {
        IMAGE_TOO_LARGE: "画像は5MB以下を選択してください。",
        IMAGE_TYPE_UNSUPPORTED: "PNG・JPEG・WebP形式のみアップロードできます。",
        IMAGE_DATA_INVALID: "選択した形式と画像データが一致しません。画像ファイルを確認してください。",
        IMAGE_EMPTY: "画像データが空です。",
        AUTHENTICATION_FAILED: "管理者認証に失敗しました。管理者として再接続してください。",
        AUTHORIZATION_FAILED: "画像のアップロードには管理者権限が必要です。",
      };
      setUploadError(uploaded
        ? "画像のアップロードは完了しましたが、プレビューを読み込めませんでした。既存のURIと画像は保持しています。"
        : messages[error?.code] ?? error?.message ?? "画像をアップロードできませんでした。既存のURIと画像は保持しています。");
    } finally { setUploading(false); }
  };
  const displayUri = resolveDisplayUri(uri);
  return <div className="product-image-uri-field">
    <label>{label}<input name={name} value={uri} onChange={(event) => setUri(event.target.value)} /></label>
    <label>{label}をアップロード<input type="file" accept="image/png,image/jpeg,image/webp" onChange={upload} disabled={uploading} /></label>
    <small role="status">{uploading ? "画像をアップロード中です。" : uploadSuccess || "PNG・JPEG・WebP、5MB以下。画像のアップロード後、プレビューを確認してから「変更を保存」してください。"}</small>
    {uploadError ? <small role="alert">{uploadError}</small> : null}
    {displayUri && !previewError ? <img className="product-image-uri-field__preview" src={displayUri} alt={`${label}のプレビュー`} onError={() => setPreviewError(true)} /> : displayUri ? <small role="alert">画像を表示できません。URIまたは配信状態を確認してください。</small> : null}
    {displayUri !== uri ? <small>一覧表示ではURIのthumb-v1をthumb-v2へ読み替えます。</small> : null}
    <ProductImageLocation uri={displayUri} label={name === "detailImageUri" ? "詳細画像" : "一覧・商品画像"} fallback={name === "detailImageUri"} fallbackUri={fallbackUri} />
  </div>;
}
