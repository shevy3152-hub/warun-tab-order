import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { rewriteInlineModuleSpecifiers } from "./inline-module-paths.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const clientDir = resolve(scriptDir, "../dist/client");
const indexPath = resolve(clientDir, "index.html");
let html = await readFile(indexPath, "utf8");

const scriptTag = html.match(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/);
const styleTag = html.match(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>/);

if (!scriptTag || !styleTag) {
  throw new Error("Built JavaScript or stylesheet reference was not found.");
}

const assetPath = (urlPath) => resolve(clientDir, urlPath.replace(/^\/+/, ""));
const [javascript, stylesheet] = await Promise.all([
  readFile(assetPath(scriptTag[1]), "utf8"),
  readFile(assetPath(styleTag[1]), "utf8"),
]);
const inlineJavascript = rewriteInlineModuleSpecifiers(javascript, scriptTag[1]);

html = html
  .replace(styleTag[0], () => `<style>${stylesheet.replaceAll("</style", "<\\/style")}</style>`)
  .replace(scriptTag[0], () => `<script type="module">${inlineJavascript.replaceAll("</script", "<\\/script")}</script>`);

await writeFile(indexPath, html, "utf8");
