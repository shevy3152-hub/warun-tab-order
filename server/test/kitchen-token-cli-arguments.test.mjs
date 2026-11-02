import assert from "node:assert/strict";
import test from "node:test";

import { parseArguments } from "../scripts/provision-safe-copy-kitchen-token.mjs";

test("hyphenated kitchen-token CLI options map to their camelCase names", () => {
  const databasePath = String.raw`C:\isolated\server\var\safe-copies\fixture.sqlite3`;
  const tokenFilePath = String.raw`C:\isolated\WarunTabOrder\safe-copy\kitchen-token`;
  const backupPath = String.raw`C:\isolated\backup.sqlite3`;

  assert.deepEqual(parseArguments([
    "--mode", "check",
    "--db", databasePath,
    "--token-file", tokenFilePath,
    "--backup", backupPath,
  ]), {
    mode: "check",
    db: databasePath,
    tokenFile: tokenFilePath,
    backup: backupPath,
  });
});
