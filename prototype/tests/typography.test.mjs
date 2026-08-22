import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const prototypeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("typography uses local Warun font faces and tokens", async () => {
  const css = await readFile(resolve(prototypeRoot, "src/styles.css"), "utf8");
  assert.match(css, /font-family:\s*"Warun JP"/);
  assert.match(css, /font-family:\s*"Warun Display"/);
  assert.match(css, /url\("\.\.\/assets\/fonts\/NotoSansJP-VF\.ttf"\)/);
  assert.match(css, /url\("\.\.\/assets\/fonts\/Oswald-VF\.ttf"\)/);
  assert.match(css, /--text-sm:\s*18px/);
  assert.match(css, /--weight-bold:\s*700/);
  assert.doesNotMatch(css, /fonts\.googleapis\.com|fonts\.gstatic\.com/);

  const font = await stat(resolve(prototypeRoot, "assets/fonts/NotoSansJP-VF.ttf"));
  assert.ok(font.size > 100_000);
  const displayFont = await stat(resolve(prototypeRoot, "assets/fonts/Oswald-VF.ttf"));
  assert.ok(displayFont.size > 100_000);
});
