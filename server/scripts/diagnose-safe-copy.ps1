param(
  [string]$ProjectRoot = 'C:\Users\user\Documents\ChatGPT\タブレットオーダーシステム',
  [ValidateRange(1, 65535)]
  [int]$WebPort = 25173,
  [ValidateRange(1, 65535)]
  [int]$ApiPort = 28787,
  [string]$PreviousReportPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

function Get-HeaderValue {
  param([Parameter(Mandatory)]$Headers, [Parameter(Mandatory)][string]$Name)
  $value = $Headers[$Name]
  if ($null -eq $value) { $value = $Headers[$Name.ToLowerInvariant()] }
  if ($value -is [Array]) { return [string](@($value) | Select-Object -First 1) }
  return [string]$value
}

function Get-HttpJson {
  param(
    [Parameter(Mandatory)][string]$Uri,
    [hashtable]$Headers = @{}
  )
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -Headers $Headers -Method Get -TimeoutSec 5
    $body = $null
    if (-not [string]::IsNullOrWhiteSpace([string]$response.Content)) {
      try { $body = $response.Content | ConvertFrom-Json } catch { $body = $null }
    }
    return [pscustomobject]@{
      status = [int]$response.StatusCode
      requestId = Get-HeaderValue -Headers $response.Headers -Name 'X-Request-Id'
      headers = $response.Headers
      body = $body
      error = $null
    }
  } catch {
    $status = $null
    $requestId = ''
    $body = $null
    $response = $_.Exception.Response
    if ($null -ne $response) {
      try { $status = [int]$response.StatusCode } catch {}
      try { $requestId = Get-HeaderValue -Headers $response.Headers -Name 'X-Request-Id' } catch {}
      try {
        $reader = [IO.StreamReader]::new($response.GetResponseStream())
        $content = $reader.ReadToEnd()
        $reader.Dispose()
        if (-not [string]::IsNullOrWhiteSpace($content)) { $body = $content | ConvertFrom-Json }
      } catch {}
    }
    return [pscustomobject]@{
      status = $status
      requestId = $requestId
      headers = $null
      body = $body
      error = $_.Exception.Message
    }
  }
}

function Get-ListeningPids {
  param([Parameter(Mandatory)][int]$Port)
  try {
    return @(
      Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
        Select-Object -ExpandProperty OwningProcess |
        Sort-Object -Unique |
        ForEach-Object { [int]$_ }
    )
  } catch {
    $netstat = Join-Path $env:SystemRoot 'System32\netstat.exe'
    return @(
      & $netstat -ano -p TCP 2>$null |
        Where-Object { $_ -match "^\s*TCP\s+\S+:$Port\s+\S+\s+LISTENING\s+(\d+)\s*$" } |
        ForEach-Object { [int]$Matches[1] } |
        Sort-Object -Unique
    )
  }
}

function Test-PathUnder {
  param([Parameter(Mandatory)][string]$Child, [Parameter(Mandatory)][string]$Parent)
  $childPath = [IO.Path]::GetFullPath($Child).TrimEnd('\')
  $parentPath = [IO.Path]::GetFullPath($Parent).TrimEnd('\')
  return $childPath.Equals($parentPath, [StringComparison]::OrdinalIgnoreCase) -or $childPath.StartsWith("$parentPath\", [StringComparison]::OrdinalIgnoreCase)
}

function Get-LanIPv4 {
  try {
    return @(
      Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
        Select-Object -ExpandProperty IPAddress |
        Sort-Object -Unique
    )
  } catch {
    return @(
      Get-CimInstance Win32_NetworkAdapterConfiguration -Filter 'IPEnabled = True' -ErrorAction SilentlyContinue |
        ForEach-Object { $_.IPAddress } |
        Where-Object { $_ -and $_ -notlike '127.*' -and $_ -notlike '169.254.*' } |
        Sort-Object -Unique
    )
  }
}

function Get-JsonFile {
  param([Parameter(Mandatory)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json } catch { return $null }
}

function Get-PublicErrorCode {
  param($Body)
  if ($null -eq $Body) { return $null }
  $errorProperty = $Body.PSObject.Properties['error']
  if ($null -eq $errorProperty -or $null -eq $errorProperty.Value) { return $null }
  $codeProperty = $errorProperty.Value.PSObject.Properties['code']
  if ($null -eq $codeProperty) { return $null }
  return [string]$codeProperty.Value
}

function Get-SafeTableSummary {
  param($Body)
  if ($null -eq $Body -or $null -eq $Body.tables) { return $null }
  return [ordered]@{
    available = @($Body.tables.available | ForEach-Object { [ordered]@{ tableId = $_.tableId; label = $_.label } })
    assigned = @($Body.tables.assigned | ForEach-Object { [ordered]@{ tableId = $_.tableId; status = $_.deviceStatus } })
  }
}

function Read-RecentDiagnosticEntries {
  param([Parameter(Mandatory)][string[]]$Paths)
  $entries = @()
  foreach ($path in $Paths) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
    try {
      $lines = Get-Content -LiteralPath $path -Tail 80 -ErrorAction Stop
      foreach ($line in $lines) {
        try {
          $entry = $line | ConvertFrom-Json
          $entries += [pscustomobject]@{
            timestamp = $entry.timestamp
            requestId = $entry.requestId
            endpoint = $entry.endpoint
            status = $entry.status
            errorCode = $entry.errorCode
            durationMs = $entry.durationMs
            stage = $entry.stage
            classification = $entry.classification
            result = $entry.result
          }
        } catch {}
      }
    } catch {}
  }
  return @($entries | Sort-Object timestamp -Descending | Select-Object -First 40)
}

function Invoke-ReadOnlyDbSummary {
  param([Parameter(Mandatory)][string]$DatabasePath)
  $node = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $node) { return [pscustomobject]@{ status = 'unverified'; reason = 'node.exe not found' } }
  $dbScript = @'
import { DatabaseSync } from 'node:sqlite';
const dbPath = process.argv[2];
try {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const counts = db.prepare("SELECT (SELECT COUNT(*) FROM orders) AS orders, (SELECT COUNT(*) FROM order_items) AS order_items, (SELECT COUNT(*) FROM event_log) AS event_log").get();
  const statuses = db.prepare("SELECT status, COUNT(*) AS count FROM orders GROUP BY status ORDER BY status").all();
  const latestEvent = db.prepare("SELECT event_type, created_at_ms FROM event_log ORDER BY event_id DESC LIMIT 1").get();
  const schema = db.prepare("SELECT schema_version FROM system_state WHERE singleton_id = 1").get();
  db.close();
  console.log(JSON.stringify({ status: "read-only", schemaVersion: schema?.schema_version ?? null, counts, statuses, latestEvent }));
} catch (error) {
  console.log(JSON.stringify({ status: "error", code: error?.code ?? null, name: error?.name ?? null, message: error?.message ?? null }));
  process.exitCode = 1;
}
'@
  $tempBase = Join-Path ([IO.Path]::GetTempPath()) ("warun-diagnostic-" + [guid]::NewGuid().ToString('N'))
  $scriptPath = "$tempBase.mjs"
  $outputPath = "$tempBase.stdout"
  $errorPath = "$tempBase.stderr"
  try {
    [IO.File]::WriteAllText($scriptPath, $dbScript, [Text.UTF8Encoding]::new($false))
    $process = Start-Process -FilePath $node.Source -ArgumentList @("`"$scriptPath`"", "`"$DatabasePath`"") -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput $outputPath -RedirectStandardError $errorPath
    $json = if (Test-Path -LiteralPath $outputPath -PathType Leaf) { (Get-Content -LiteralPath $outputPath -Raw).Trim() } else { '' }
    if ([string]::IsNullOrWhiteSpace($json)) { return [pscustomobject]@{ status = 'unverified'; reason = "read-only SQLite query failed (exit $($process.ExitCode))" } }
    $parsed = $json | ConvertFrom-Json
    if ($parsed.status -eq 'read-only') { return $parsed }
    $failureCode = if ($parsed.code) { $parsed.code } elseif ($parsed.name) { $parsed.name } else { 'unknown' }
    $failureMessage = if ($parsed.message) { [string]$parsed.message } else { '' }
    return [pscustomobject]@{ status = 'unverified'; reason = "read-only SQLite query failed ($failureCode${failureMessage})" }
  } catch {
    return [pscustomobject]@{ status = 'unverified'; reason = 'read-only SQLite query unavailable' }
  } finally {
    foreach ($path in @($scriptPath, $outputPath, $errorPath)) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
  }
}

$root = [IO.Path]::GetFullPath($ProjectRoot)
$serverRoot = Join-Path $root 'server'
$databasePath = Join-Path $serverRoot 'var\safe-copies\initial-menu-20260818.sqlite3'
$productionPath = Join-Path $serverRoot 'var\warun.sqlite3'
$safeCopiesRoot = Join-Path $serverRoot 'var\safe-copies'
$runtimeRoot = Join-Path $env:LOCALAPPDATA 'WarunTabOrder\safe-copy'
$runtimePath = Join-Path $runtimeRoot 'runtime-state.json'
$tokenPath = Join-Path $runtimeRoot 'admin-token'
$logRoot = Join-Path $runtimeRoot 'logs'
$diagnosticPaths = @(
  (Join-Path $logRoot 'communication.ndjson'),
  (Join-Path $logRoot 'pairing-claims.ndjson')
)
$state = Get-JsonFile -Path $runtimePath
$lan = @(Get-LanIPv4)
$webPids = @(Get-ListeningPids -Port $WebPort)
$apiPids = @(Get-ListeningPids -Port $ApiPort)
$listenerPids = @($webPids + $apiPids | Sort-Object -Unique)
$nodeRows = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
  [pscustomobject]@{ pid = [int]$_.ProcessId; command = [string]$_.CommandLine }
})
$matchingNode = @($nodeRows | Where-Object { $listenerPids -contains $_.pid })

$health = Get-HttpJson -Uri "http://127.0.0.1:$ApiPort/v1/health"
$healthPid = Get-HeaderValue -Headers $health.headers -Name 'X-Warun-Process-Id'
$healthTarget = Get-HeaderValue -Headers $health.headers -Name 'X-Warun-Database-Target'
$tokenValid = Test-Path -LiteralPath $tokenPath -PathType Leaf
$token = ''
if ($tokenValid) {
  try { $token = (Get-Content -LiteralPath $tokenPath -Raw).Trim() } catch { $token = '' }
  $tokenValid = $token -match '^[A-Za-z0-9_-]{43}$'
}
$headers = @{}
if ($tokenValid) { $headers = @{ Authorization = "Bearer $token"; Accept = 'application/json' } }
$preflight = if ($tokenValid) { Get-HttpJson -Uri "http://127.0.0.1:$WebPort/v1/admin/pairing-preflight" -Headers $headers } else { $null }
$history = if ($tokenValid) { Get-HttpJson -Uri "http://127.0.0.1:$WebPort/v1/admin/order-history" -Headers $headers } else { $null }
$snapshot = if ($tokenValid) { Get-HttpJson -Uri "http://127.0.0.1:$WebPort/v1/snapshot" -Headers $headers } else { $null }
$preflightTables = if ($null -eq $preflight) { $null } else { Get-SafeTableSummary -Body $preflight.body }
$dbPathSafe = [IO.Path]::GetFullPath($databasePath)
$productionPathSafe = [IO.Path]::GetFullPath($productionPath)
$databaseTarget = if ($dbPathSafe.Equals($productionPathSafe, [StringComparison]::OrdinalIgnoreCase)) { 'production' } elseif ((Test-Path -LiteralPath $dbPathSafe -PathType Leaf) -and (Test-PathUnder -Child $dbPathSafe -Parent $safeCopiesRoot)) { 'safe-copy' } elseif (Test-Path -LiteralPath $dbPathSafe -PathType Leaf) { 'other' } else { 'missing' }
$dbSummary = if ($databaseTarget -eq 'safe-copy') { Invoke-ReadOnlyDbSummary -DatabasePath $dbPathSafe } else { [pscustomobject]@{ status = 'not-run'; reason = 'production, other, or missing path' } }
$recent = @(Read-RecentDiagnosticEntries -Paths $diagnosticPaths)
$previousReport = if (-not [string]::IsNullOrWhiteSpace($PreviousReportPath)) { Get-JsonFile -Path $PreviousReportPath } else { $null }
$previousCounts = $null
if ($null -ne $previousReport) {
  $previousDatabase = $previousReport.PSObject.Properties['database']
  if ($null -ne $previousDatabase -and $null -ne $previousDatabase.Value) {
    $previousSummary = $previousDatabase.Value.PSObject.Properties['summary']
    if ($null -ne $previousSummary -and $null -ne $previousSummary.Value) {
      $previousCountsProperty = $previousSummary.Value.PSObject.Properties['counts']
      if ($null -ne $previousCountsProperty) { $previousCounts = $previousCountsProperty.Value }
    }
  }
}
$countDelta = $null
if ($null -ne $previousCounts -and $null -ne $dbSummary -and $null -ne $dbSummary.counts) {
  $countDelta = [ordered]@{
    orders = [int]$dbSummary.counts.orders - [int]$previousCounts.orders
    order_items = [int]$dbSummary.counts.order_items - [int]$previousCounts.order_items
    event_log = [int]$dbSummary.counts.event_log - [int]$previousCounts.event_log
  }
}
$stateIsSafeCopy = $null -ne $state -and [string]$state.databaseTarget -eq 'safe-copy' -and -not [bool]$state.isProduction
$healthIsSafeCopy = [string]$healthTarget -eq 'safe-copy'
$historySucceeded = $null -ne $history -and $history.status -eq 200
$snapshotSucceeded = $null -ne $snapshot -and $snapshot.status -eq 200
$sourceState = @{}
$devStatePath = Join-Path $root 'DEV_STATE.md'
if (Test-Path -LiteralPath $devStatePath -PathType Leaf) {
  $devText = Get-Content -LiteralPath $devStatePath -Raw
  $headMatch = [regex]::Match($devText, '(?m)^HEAD:\s*`?([0-9a-f]{7,40})`?')
  $pidMatch = [regex]::Match($devText, '(?m)待受.*?PID\s+(\d+)')
  if ($headMatch.Success) { $sourceState.devStateHead = $headMatch.Groups[1].Value }
  if ($pidMatch.Success) { $sourceState.devStatePid = [int]$pidMatch.Groups[1].Value }
}
$devStateHead = if ($sourceState.ContainsKey('devStateHead')) { [string]$sourceState['devStateHead'] } else { $null }
$gitBranch = ''
$gitHead = ''
$gitStatus = @()
try {
  $gitBranch = (& git -C $root branch --show-current 2>$null | Select-Object -First 1).Trim()
  $gitHead = (& git -C $root rev-parse HEAD 2>$null | Select-Object -First 1).Trim()
  $gitStatus = @(& git -C $root status --short 2>$null)
} catch {}

$report = [ordered]@{
  generatedAt = (Get-Date).ToUniversalTime().ToString('o')
  safety = [ordered]@{
    mode = 'read-only'
    postProbesSent = $false
    productionDbOpened = $false
    secretOutput = $false
    gitMutation = $false
  }
  git = [ordered]@{ branch = $gitBranch; head = $gitHead; dirty = $gitStatus.Count -gt 0; statusCount = $gitStatus.Count; devStateHead = $devStateHead }
  network = [ordered]@{ lanIPv4 = $lan; webPort = $WebPort; apiPort = $ApiPort; webListenerPids = $webPids; apiListenerPids = $apiPids; commonPid = if ($webPids.Count -eq 1 -and $apiPids.Count -eq 1 -and $webPids[0] -eq $apiPids[0]) { $webPids[0] } else { $null } }
  node = [ordered]@{ matchingProcesses = $matchingNode }
  runtimeState = if ($null -eq $state) { [ordered]@{ status = 'missing' } } else { [ordered]@{ status = 'present'; processId = $state.processId; databasePath = $state.databasePath; databaseTarget = $state.databaseTarget; isProduction = $state.isProduction; apiPort = $state.apiPort; webPort = $state.webPort; lanIPv4 = @($state.lanIPv4); pcAdminUrl = $state.pcAdminUrl; a90CustomerUrl = $state.a90CustomerUrl } }
  health = [ordered]@{ status = $health.status; requestId = $health.requestId; body = if ($null -eq $health.body) { $null } else { [ordered]@{ status = $health.body.status; db = $health.body.db; schemaVersion = $health.body.schemaVersion } }; processId = $healthPid; databaseTarget = $healthTarget }
  database = [ordered]@{ requestedPath = $dbPathSafe; target = $databaseTarget; isProduction = $databaseTarget -eq 'production'; summary = $dbSummary }
  admin = [ordered]@{ tokenFileShapeValid = $tokenValid; preflight = if ($null -eq $preflight) { $null } else { [ordered]@{ status = $preflight.status; requestId = $preflight.requestId; authentication = $preflight.body.authentication; database = $preflight.body.database; server = $preflight.body.server; tables = $preflightTables; pairing = $preflight.body.pairing; errorCode = Get-PublicErrorCode -Body $preflight.body } }; orderHistory = if ($null -eq $history) { $null } else { [ordered]@{ status = $history.status; requestId = $history.requestId; count = if ($null -eq $history.body) { $null } else { @($history.body.orders).Count }; errorCode = Get-PublicErrorCode -Body $history.body } }; snapshot = if ($null -eq $snapshot) { $null } else { [ordered]@{ status = $snapshot.status; requestId = $snapshot.requestId; activeOrderCount = if ($null -eq $snapshot.body) { $null } else { @($snapshot.body.activeOrders).Count }; openSessionCount = if ($null -eq $snapshot.body) { $null } else { @($snapshot.body.openSessions).Count }; errorCode = Get-PublicErrorCode -Body $snapshot.body } } }
  recentDiagnostics = $recent
  classification = [ordered]@{
    listener = if ($listenerPids.Count -eq 0) { 'not_listening' } elseif ($webPids.Count -eq 1 -and $apiPids.Count -eq 1 -and $webPids[0] -eq $apiPids[0]) { 'common_listener_pid' } else { 'port_pid_mismatch' }
    safeCopy = if ($stateIsSafeCopy -and $healthIsSafeCopy -and $databaseTarget -eq 'safe-copy') { 'confirmed' } else { 'mismatch_or_unverified' }
    adminAuth = if ($null -eq $preflight) { if ($tokenValid) { 'unverified_or_unreachable' } else { 'token_store_missing_or_invalid' } } elseif ($preflight.status -eq 200) { 'valid' } elseif ($preflight.status -eq 401) { 'invalid' } else { 'unclassified_http_' + [string]$preflight.status }
    orderTransport = if (@($recent | Where-Object { $_.endpoint -eq 'POST /v1/orders' }).Count -gt 0) { 'server_record_observed' } else { 'A90_request_unobserved_no_mutating_probe_sent' }
    orderDisplay = if ($historySucceeded -and $snapshotSucceeded) { 'compare_history_and_active_snapshot_before_classifying' } else { 'unverified' }
  }
}

if (-not [string]::IsNullOrWhiteSpace($PreviousReportPath) -and (Test-Path -LiteralPath $PreviousReportPath -PathType Leaf)) {
  $report.previousReport = [ordered]@{ path = [IO.Path]::GetFullPath($PreviousReportPath); available = $true; countDelta = $countDelta }
} else {
  $report.previousReport = [ordered]@{ available = $false; countDelta = $null }
}

$report | ConvertTo-Json -Depth 12
