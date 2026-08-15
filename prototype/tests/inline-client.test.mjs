import assert from "node:assert/strict";
import test from "node:test";

import { rewriteInlineModuleSpecifiers } from "../scripts/inline-module-paths.mjs";

test("inlined production modules keep imports under their original asset directory", () => {
  const source = [
    'import{render}from"./styles-abc.js";',
    'const lazy=import("../chunks/lazy.js?x=1#part");',
    'import "/already-absolute.js";',
  ].join("");

  const rewritten = rewriteInlineModuleSpecifiers(source, "/assets/main-def.js");

  assert.match(rewritten, /from"\/assets\/styles-abc\.js"/);
  assert.match(rewritten, /import\("\/chunks\/lazy\.js\?x=1#part"\)/);
  assert.match(rewritten, /import "\/already-absolute\.js"/);
  assert.doesNotMatch(rewritten, /from"\.\/styles-abc\.js"/);
});
