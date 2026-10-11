// Only files confirmed by the build's public asset inventory receive a local path.
export function productImageLocation(uri, { knownPaths = [], publicFolder = "", origin = "" } = {}) {
  const value = String(uri ?? "").trim();
  if (!value) return { kind: "none", message: "画像なし", filename: "" };
  let pathname;
  if (/^https?:\/\//i.test(value) || value.startsWith("//")) {
    try {
      const url = new URL(value, origin || "https://local.invalid");
      if (!origin || url.origin !== origin) return { kind: "external", message: "外部URL：ローカル保存先は特定できません。", filename: decodeURIComponent(url.pathname.split("/").pop() || "") };
      pathname = url.pathname;
    } catch { return { kind: "unknown", message: "保存先を特定できません。", filename: "" }; }
  } else if (/^[a-z][a-z\d+.-]*:/i.test(value)) {
    return { kind: "unknown", message: "埋め込み画像または保存先不明のURIです。", filename: "" };
  } else pathname = value.split(/[?#]/)[0].replace(/^\.\//, "");
  try { pathname = decodeURIComponent(pathname); } catch { return { kind: "unknown", message: "保存先を特定できません。", filename: "" }; }
  pathname = "/" + pathname.replace(/^\/+/, "");
  const filename = pathname.split("/").pop() || "";
  if (pathname.includes("\\") || pathname.split("/").some((part) => part === "." || part === "..") || !knownPaths.includes(pathname)) {
    return { kind: "unknown", message: "このbuildの公開画像として確認できず、保存先を特定できません。", filename };
  }
  const relativeFolder = "prototype/public" + pathname.slice(0, pathname.lastIndexOf("/"));
  const configured = String(publicFolder).trim();
  const absolute = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(configured);
  const separator = configured.includes("\\") ? "\\" : "/";
  const folder = absolute ? configured.replace(/[\\/]+$/, "") + pathname.slice(0, pathname.lastIndexOf("/")).replaceAll("/", separator) : relativeFolder;
  const normalized = folder.replaceAll("\\", "/");
  const folderUrl = absolute ? (normalized.startsWith("//") ? "file:" : normalized.startsWith("/") ? "file://" : "file:///") + normalized.split("/").map((segment, index) => index === 0 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)).join("/") + "/" : "";
  return { kind: "local", filename, folder, absolute, folderUrl, relativeFolder, publicPath: pathname };
}

export async function copyProductImageFolder(folder, input, { clipboard, execCommand } = {}) {
  if (!folder) throw new Error("No confirmed folder");
  if (typeof clipboard?.writeText === "function") { await clipboard.writeText(folder); return; }
  input?.select();
  if (!input || !execCommand?.("copy")) throw new Error("Copy unavailable");
}
