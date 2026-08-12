import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

test("1280x800 viewport rule removes page overflow without changing inner scrollers", () => {
  assert.match(styles, /@media \(min-width: 1000px\) and \(max-width: 1350px\) and \(max-height: 850px\)/);
  assert.match(styles, /html, body, #root \{ height: 100%; overflow: hidden; \}/);
  assert.match(styles, /\.customer-app, \.staff-app \{ height: 100vh; min-height: 0; \}/);
  assert.match(styles, /\.staff-topbar--kitchen \{ min-height: 88px; \}/);
  assert.match(styles, /\.staff-topbar--admin \{ min-height: 96px;/);
});
