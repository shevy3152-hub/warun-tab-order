import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const v24Start = await readFile(new URL("../start-safe-copy.ps1", import.meta.url), "utf8");
const v24Admin = await readFile(new URL("../open-admin.ps1", import.meta.url), "utf8");
const v25Start = await readFile(new URL("../start-safe-copy-v25.ps1", import.meta.url), "utf8");
const v25Admin = await readFile(new URL("../open-admin-v25.ps1", import.meta.url), "utf8");
const database = await readFile(new URL("../src/db/database.mjs", import.meta.url), "utf8");
const server = await readFile(new URL("../src/run-server.mjs", import.meta.url), "utf8");
const kitchenTokens = await readFile(new URL("../scripts/provision-safe-copy-kitchen-token.mjs", import.meta.url), "utf8");

test("schema 24 launchers remain separate from the versioned schema 25 entry", () => {
  assert.match(v24Start, /\$TargetSchemaVersion = 24/);
  assert.match(v24Admin, /\$TargetSchemaVersion = 24/);
  assert.match(v25Start, /\$TargetSchemaVersion = 25/);
  assert.match(v25Admin, /\$TargetSchemaVersion = 25/);
  assert.match(v25Admin, /\$Launcher = Join-Path \$ServerRoot 'start-safe-copy-v25\.ps1'/);
});

test("schema 25 startup refuses unsafe roots and does not stop a schema 24 runtime", () => {
  assert.match(v25Start, /Refusing the production DB path/);
  assert.match(v25Start, /DB is outside the safe-copy directory/);
  assert.match(v25Start, /Existing safe-copy runtime uses schema v\$\(\$existingCheck\.schemaVersion\)/);
  const startup = v25Start.slice(v25Start.indexOf("if \(\$Action -eq 'status'\)"));
  const guard = startup.indexOf("if ($existingCheck.schemaVersion -lt $TargetSchemaVersion)");
  assert.ok(guard >= 0);
  for (const operation of ["Stop-Process -Id $existingCheck.processId", "Invoke-RuntimeStop", "Invoke-SafeCopyKitchenTokenOperation -Mode 'check'", "$startInfo.Arguments = 'src/run-server.mjs'"]) {
    const operationIndex = startup.indexOf(operation);
    if (operation === "Invoke-RuntimeStop") continue;
    assert.ok(operationIndex < 0 || operationIndex > guard, `${operation} must follow the old-schema guard`);
  }
  assert.match(v25Start, /healthBody\.schemaVersion -ne \$TargetSchemaVersion/);
  assert.match(v25Start, /Get-HealthProcessId/);
  assert.match(v25Start, /\$webPids\[0\] -ne \$processId -or \$apiPids\[0\] -ne \$processId/);
});

test("schema 25 migration belongs to backend initialization; token preflight is read-only", () => {
  assert.match(database, /if \(currentVersion === 24\)[\s\S]*?readFileSync\(resolvedV25MigrationPath, 'utf8'\)/);
  assert.match(server, /initializeDatabase\(\{ databasePath \}\)/);
  assert.match(kitchenTokens, /new DatabaseSync\(resolvedPath, \{ readOnly: true \}\)/);
  assert.match(v25Start, /\$SafeCopyKitchenToken = Invoke-SafeCopyKitchenTokenOperation -Mode 'check'/);
  assert.doesNotMatch(v25Start, /Invoke-SafeCopyKitchenTokenOperation -Mode 'ensure'/);
});

test("kitchen token preflight runs before diagnostic restart can stop the current runtime", () => {
  const startup = v25Start.slice(v25Start.indexOf("if ($existingPids.Count -eq 0)"));
  const tokenCheckIndex = startup.indexOf("$SafeCopyKitchenToken = Invoke-SafeCopyKitchenTokenOperation -Mode 'check'");
  const stopIndex = startup.indexOf("Stop-Process -Id $existingCheck.processId");
  assert.ok(tokenCheckIndex >= 0);
  assert.ok(stopIndex > tokenCheckIndex, "read-only token check must happen before stopping the existing runtime");
});

test("schema 25 admin entry requires the expected DB, WebRoot, process, ports, and health identity", () => {
  assert.match(v25Admin, /RuntimeStatePath/);
  assert.match(v25Admin, /state\.databasePath/);
  assert.match(v25Admin, /state\.webRoot/);
  assert.match(v25Admin, /stateProcessId/);
  assert.match(v25Admin, /X-Warun-Database-Identity/);
  assert.match(v25Admin, /X-Warun-Process-Id/);
  assert.match(v25Admin, /\$webPids\[0\] -ne \$stateProcessId -or \$apiPids\[0\] -ne \$stateProcessId/);
});

test("failed schema 25 startup stops and verifies only its launched process", () => {
  assert.match(v25Start, /function Stop-StartedSafeCopyProcess/);
  assert.match(v25Start, /\$StartedProcess\.StartInfo\.Arguments -ne 'src\/run-server\.mjs'/);
  assert.match(v25Start, /Get-ProcessSnapshot -ProcessId \$startedProcessId/);
  assert.match(v25Start, /\$StartedProcess\.Kill\(\)/);
  assert.match(v25Start, /Stop-StartedSafeCopyProcess -StartedProcess \$process/);
  assert.match(v25Start, /Remove-RuntimeStateIfUnchanged -Expected \$runtimeInfo -Reason 'failed startup cleanup'/);
  assert.doesNotMatch(v25Start, /Stop-Process -Id \$processId/);
});

test("versioned launcher supports an isolated loopback bind and separate runtime inputs", () => {
  assert.match(v25Start, /\[ValidateSet\('0\.0\.0\.0', '127\.0\.0\.1'\)\]/);
  assert.match(v25Start, /\[string\]\$BindHost = '0\.0\.0\.0'/);
  assert.match(v25Start, /WARUN_SERVER_HOST = \$BindHost/);
  assert.match(v25Start, /\[string\]\$DatabasePath/);
  assert.match(v25Start, /\[string\]\$WebRoot/);
  assert.match(v25Start, /\[string\]\$RuntimeRoot/);
  assert.match(v25Start, /\[int\]\$WebPort = 25173/);
  assert.match(v25Start, /\[int\]\$ApiPort = 28787/);
});
