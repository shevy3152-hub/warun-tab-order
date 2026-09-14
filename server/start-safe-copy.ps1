[CmdletBinding()]
param(
  [string]$DatabasePath = '',
  [ValidateRange(1, 65535)]
  [int]$WebPort = 25173,
  [ValidateRange(1, 65535)]
  [int]$ApiPort = 28787,
  [ValidateRange(5, 300)]
  [int]$TimeoutSeconds = 45,
  [switch]$MutexAlreadyHeld,
  [switch]$NoBrowser,
  [switch]$EnableMenuDiagnostics
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ServerRoot = $PSScriptRoot
$ProjectRoot = Split-Path -Parent $ServerRoot
$DatabasePath = if ([string]::IsNullOrWhiteSpace($DatabasePath)) { Join-Path $ServerRoot 'var\safe-copies\initial-menu-20260818.sqlite3' } else { $DatabasePath }
$WebRoot = Join-Path $ProjectRoot 'prototype\dist\client'
$ProductionPath = [IO.Path]::GetFullPath((Join-Path $ServerRoot 'var\warun.sqlite3'))
$SafeCopiesRoot = [IO.Path]::GetFullPath((Join-Path $ServerRoot 'var\safe-copies'))
$DatabasePath = [IO.Path]::GetFullPath($DatabasePath)
$RuntimeRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'WarunTabOrder\safe-copy'
$StatePath = Join-Path $RuntimeRoot 'runtime-state.json'
$LogRoot = Join-Path $RuntimeRoot 'logs'
$AdminTokenPath = Join-Path $RuntimeRoot 'admin-token'
$KitchenTokenPath = Join-Path $RuntimeRoot 'kitchen-token'
$KitchenTokenProvisionScript = Join-Path $ServerRoot 'scripts\provision-safe-copy-kitchen-token.mjs'
$PairingDiagnosticLogPath = Join-Path $LogRoot 'pairing-claims.ndjson'
$CommunicationDiagnosticLogPath = Join-Path $LogRoot 'communication.ndjson'
$MenuDiagnosticLogPath = Join-Path $LogRoot 'menu-requests.ndjson'
$MutexName = 'WarunTabOrder.SafeCopy.AdminLauncher'
$mutex = $null
$hasMutex = $false

function Test-PathUnder {
  param([Parameter(Mandatory)][string]$Child, [Parameter(Mandatory)][string]$Parent)
  $childPath = [IO.Path]::GetFullPath($Child).TrimEnd('\')
  $parentPath = [IO.Path]::GetFullPath($Parent).TrimEnd('\')
  return $childPath.Equals($parentPath, [StringComparison]::OrdinalIgnoreCase) -or $childPath.StartsWith("$parentPath\", [StringComparison]::OrdinalIgnoreCase)
}

function Get-LanIPv4 {
  $addresses = foreach ($adapter in [Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
    if ($adapter.OperationalStatus -ne [Net.NetworkInformation.OperationalStatus]::Up) { continue }
    foreach ($address in $adapter.GetIPProperties().UnicastAddresses) {
      $ip = $address.Address
      if ($ip.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork -and
          -not [Net.IPAddress]::IsLoopback($ip) -and
          -not $ip.IPAddressToString.StartsWith('169.254.')) {
        $ip.IPAddressToString
      }
    }
  }
  return @($addresses | Sort-Object -Unique)
}

function Get-ListeningProcessIds {
  param([Parameter(Mandatory)][int]$Port)
  $netstat = Join-Path $env:SystemRoot 'System32\netstat.exe'
  $ids = foreach ($line in & $netstat -ano -p TCP) {
    if ($line -match "^\s*TCP\s+\S+:$Port\s+\S+\s+LISTENING\s+(\d+)\s*$") { [int]$Matches[1] }
  }
  return @($ids | Sort-Object -Unique)
}

function Get-Health {
  param([Parameter(Mandatory)][string]$Uri)
  return Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec 5
}

function Get-HealthProcessId {
  param([Parameter(Mandatory)]$HealthResponse)
  $headerValue = @($HealthResponse.Headers['X-Warun-Process-Id']) | Select-Object -First 1
  if ([string]::IsNullOrWhiteSpace([string]$headerValue)) { throw 'Health response did not include a process identity.' }
  return [int]$headerValue
}

function Read-SafeCopyAdminToken {
  if (-not (Test-Path -LiteralPath $AdminTokenPath -PathType Leaf)) {
    throw 'The safe-copy admin token store is missing. Run provision-safe-copy-admin-token.mjs once before starting the server.'
  }
  $token = (Get-Content -LiteralPath $AdminTokenPath -Raw -ErrorAction Stop).Trim()
  if ($token -notmatch '^[A-Za-z0-9_-]{43}$') { throw 'The safe-copy admin token store is invalid.' }
  return $token
}

function Read-SafeCopyKitchenToken {
  if (-not (Test-Path -LiteralPath $KitchenTokenPath -PathType Leaf)) {
    throw 'The safe-copy kitchen token store is missing.'
  }
  $token = (Get-Content -LiteralPath $KitchenTokenPath -Raw -ErrorAction Stop).Trim()
  if ($token -notmatch '^[A-Za-z0-9_-]{43}$') { throw 'The safe-copy kitchen token store is invalid.' }
  return $token
}

function Invoke-SafeCopyKitchenTokenOperation {
  param([Parameter(Mandatory)][ValidateSet('check', 'ensure')][string]$Mode)
  $arguments = @(
    $KitchenTokenProvisionScript,
    '--mode', $Mode,
    '--db', $DatabasePath,
    '--token-file', $KitchenTokenPath
  )
  & $node.Source @arguments | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'The safe-copy kitchen token check/provision failed; startup was stopped.' }
  return Read-SafeCopyKitchenToken
}

function Assert-SafeCopyInjectedKitchenToken {
  param([Parameter(Mandatory)][string]$Token, [Parameter(Mandatory)][int]$Port)
  $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/admin.html" -TimeoutSec 5
  if ($response.StatusCode -ne 200) { throw 'The safe-copy admin shell did not return HTTP 200 for kitchen token verification.' }
  $html = [string]$response.Content
  $metaMatch = [regex]::Match($html, '<meta\s+name=["'']warun-kitchen-token["'']\s+content=["''](?<token>[A-Za-z0-9_-]{43})["'']\s*>', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
  $runtimeMatch = [regex]::Match($html, 'kitchenToken:(?<token>"[A-Za-z0-9_-]{43}")')
  if (-not $metaMatch.Success -or -not $runtimeMatch.Success) { throw 'The safe-copy admin shell did not contain the expected kitchen runtime configuration.' }
  $metaToken = $metaMatch.Groups['token'].Value
  $runtimeToken = $runtimeMatch.Groups['token'].Value.Trim('"')
  if ($metaToken -cne $Token -or $runtimeToken -cne $Token) { throw 'The running safe-copy process is serving a different kitchen token than the persisted store.' }
}

function Get-AdminPreflight {
  param([Parameter(Mandatory)][string]$Token, [Parameter(Mandatory)][int]$Port)
  $headers = @{ Authorization = "Bearer $Token"; Accept = 'application/json' }
  try {
    return Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/v1/admin/pairing-preflight" -Headers $headers -TimeoutSec 5
  } catch {
    $response = $_.Exception.Response
    if ($null -ne $response -and [int]$response.StatusCode -eq 401) { return $null }
    throw
  }
}

function Get-DatabaseIdentity {
  param([Parameter(Mandatory)][string]$Path)
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Path))
    return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 16)
  } finally {
    $sha.Dispose()
  }
}

function Get-ChildProcessEnvironment {
  $environment = @{}
  foreach ($entry in [Environment]::GetEnvironmentVariables('Process').GetEnumerator()) {
    $name = [string]$entry.Key
    if (-not $environment.ContainsKey($name)) {
      $environment[$name] = [string]$entry.Value
    }
  }
  return $environment
}

function Assert-SafeCopyFile {
  if (-not (Test-Path -LiteralPath $DatabasePath -PathType Leaf)) { throw "Safe-copy DB was not found: $DatabasePath" }
  if ($DatabasePath.Equals($ProductionPath, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing the production DB path.' }
  if (-not (Test-PathUnder -Child $DatabasePath -Parent $SafeCopiesRoot)) { throw "DB is outside the safe-copy directory: $DatabasePath" }
  if (-not (Test-Path -LiteralPath (Join-Path $WebRoot 'index.html') -PathType Leaf)) { throw "Web build was not found: $WebRoot" }
}

function Write-RuntimeInfo {
  param([Parameter(Mandatory)][pscustomobject]$RuntimeInfo)
  Write-Output "DB absolute path: $($RuntimeInfo.databasePath)"
  Write-Output "Runtime target: $($RuntimeInfo.databaseTarget) (production: $([bool]$RuntimeInfo.isProduction))"
  Write-Output "Web port: $($RuntimeInfo.webPort)"
  Write-Output "API port: $($RuntimeInfo.apiPort)"
  Write-Output "LAN IPv4: $($RuntimeInfo.lanIPv4 -join ', ')"
  Write-Output "PC admin URL: $($RuntimeInfo.pcAdminUrl)"
  Write-Output "A90 customer URL: $($RuntimeInfo.a90CustomerUrl)"
  Write-Output "Pairing URL generation origin: $($RuntimeInfo.pairingUrlOrigin)"
  Write-Output "Admin token configured in launcher environment: $([bool](-not [string]::IsNullOrWhiteSpace($env:WARUN_ADMIN_API_TOKEN)))"
  Write-Output "GET /v1/menu diagnostics enabled: $([bool]$RuntimeInfo.menuDiagnosticEnabled)"
}

try {
  if (-not $MutexAlreadyHeld) {
    $mutex = [Threading.Mutex]::new($false, $MutexName)
    try {
      $hasMutex = $mutex.WaitOne(0)
    } catch [Threading.AbandonedMutexException] {
      $hasMutex = $true
    }
    if (-not $hasMutex) { throw '別のsafe-copy起動処理が実行中です。起動完了を待ってください。' }
  }

  Assert-SafeCopyFile
  $node = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $node) { throw 'node.exe was not found on PATH.' }
  $SafeCopyAdminToken = Read-SafeCopyAdminToken
  $lanAddresses = @(Get-LanIPv4)
  $webPids = @(Get-ListeningProcessIds $WebPort)
  $apiPids = @(Get-ListeningProcessIds $ApiPort)
  $existingPids = @($webPids + $apiPids | Sort-Object -Unique)
  $processId = $null
  $stdoutLog = $null

if ($existingPids.Count -gt 0) {
  if ($existingPids.Count -ne 1 -or $webPids.Count -ne 1 -or $apiPids.Count -ne 1 -or $webPids[0] -ne $apiPids[0]) {
    throw "Port conflict: Web/API ports are already used by different processes ($($existingPids -join ', '))."
  }
  $processId = $existingPids[0]
  $health = Get-Health "http://127.0.0.1:$ApiPort/v1/health"
  if ($health.StatusCode -ne 200 -or $health.Headers['X-Warun-Environment'] -ne 'safe-copy' -or $health.Headers['X-Warun-Database-Target'] -ne 'safe-copy' -or $health.Headers['X-Warun-Database-Identity'] -ne (Get-DatabaseIdentity $DatabasePath)) {
    throw "Port conflict: an existing process is not the expected safe-copy server (PID $processId)."
  }
  if ((Get-HealthProcessId -HealthResponse $health) -ne $processId) { throw "Port conflict: health belongs to a different process than PID $processId." }
  if ($null -eq (Get-AdminPreflight -Token $SafeCopyAdminToken -Port $ApiPort)) {
    Stop-Process -Id $processId -Force
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
      Start-Sleep -Milliseconds 250
      $webPids = @(Get-ListeningProcessIds $WebPort)
      $apiPids = @(Get-ListeningProcessIds $ApiPort)
    } while (($webPids.Count -gt 0 -or $apiPids.Count -gt 0) -and (Get-Date) -lt $deadline)
    if ($webPids.Count -gt 0 -or $apiPids.Count -gt 0) { throw 'The previous safe-copy process did not release both ports.' }
    $existingPids = @()
  }
}

$existingMenuDiagnosticEnabled = $false
if ($existingPids.Count -gt 0 -and (Test-Path -LiteralPath $StatePath -PathType Leaf)) {
  try {
    $existingState = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
    $existingMenuDiagnosticEnabled = [bool]$existingState.menuDiagnosticEnabled
  } catch {
    $existingMenuDiagnosticEnabled = $false
  }
}
if ($existingPids.Count -gt 0 -and $existingMenuDiagnosticEnabled -ne [bool]$EnableMenuDiagnostics) {
  $healthBodyBeforeRestart = $health.Content | ConvertFrom-Json
  if ($health.StatusCode -ne 200 -or $healthBodyBeforeRestart.status -ne 'ready' -or $healthBodyBeforeRestart.db -ne 'ready' -or $healthBodyBeforeRestart.schemaVersion -ne 6) {
    throw 'safe-copy health/schema check failed before diagnostic-mode restart.'
  }
  Stop-Process -Id $processId -Force
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    Start-Sleep -Milliseconds 250
    $webPids = @(Get-ListeningProcessIds $WebPort)
    $apiPids = @(Get-ListeningProcessIds $ApiPort)
  } while (($webPids.Count -gt 0 -or $apiPids.Count -gt 0) -and (Get-Date) -lt $deadline)
  if ($webPids.Count -gt 0 -or $apiPids.Count -gt 0) { throw 'The previous safe-copy process did not release both ports.' }
  $existingPids = @()
}

$SafeCopyKitchenToken = if ($existingPids.Count -gt 0) {
  Invoke-SafeCopyKitchenTokenOperation -Mode 'check'
} else {
  Invoke-SafeCopyKitchenTokenOperation -Mode 'ensure'
}
if ($existingPids.Count -gt 0) {
  Assert-SafeCopyInjectedKitchenToken -Token $SafeCopyKitchenToken -Port $WebPort
}

if ($existingPids.Count -eq 0) {
  [void](New-Item -ItemType Directory -Path $RuntimeRoot -Force)
  [void](New-Item -ItemType Directory -Path $LogRoot -Force)
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $stdoutLog = Join-Path $LogRoot "server-$stamp.stdout.log"
  $stderrLog = Join-Path $LogRoot "server-$stamp.stderr.log"
  $env:WARUN_ENV = 'safe-copy'
  $env:WARUN_SERVER_HOST = '0.0.0.0'
  $env:WARUN_SERVER_PORT = [string]$ApiPort
  $env:WARUN_WEB_PORT = [string]$WebPort
  $env:WARUN_DB_PATH = $DatabasePath
  $env:WARUN_WEB_ROOT = $WebRoot
  $env:WARUN_ADMIN_API_TOKEN = $SafeCopyAdminToken
  $env:WARUN_KITCHEN_API_TOKEN = $SafeCopyKitchenToken
  $env:WARUN_PAIRING_DIAGNOSTIC_LOG_PATH = $PairingDiagnosticLogPath
  $env:WARUN_COMMUNICATION_DIAGNOSTIC_LOG_PATH = $CommunicationDiagnosticLogPath
  $env:WARUN_MENU_DIAGNOSTIC_ENABLED = if ($EnableMenuDiagnostics) { '1' } else { '0' }
  $env:WARUN_MENU_DIAGNOSTIC_LOG_PATH = if ($EnableMenuDiagnostics) { $MenuDiagnosticLogPath } else { '' }
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $node.Source
  $startInfo.Arguments = 'src/run-server.mjs'
  $startInfo.WorkingDirectory = $ServerRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.EnvironmentVariables.Clear()
  foreach ($entry in (Get-ChildProcessEnvironment).GetEnumerator()) {
    $startInfo.EnvironmentVariables[$entry.Key] = $entry.Value
  }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  $process.Start()
  $processId = $process.Id
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    Start-Sleep -Milliseconds 500
    $process.Refresh()
    if ($process.HasExited) { throw "safe-copy server exited with code $($process.ExitCode). See $stderrLog" }
    try { $health = Get-Health "http://127.0.0.1:$ApiPort/v1/health" } catch { $health = $null }
  } while (($null -eq $health -or $health.StatusCode -ne 200) -and (Get-Date) -lt $deadline)
  if ($null -eq $health -or $health.StatusCode -ne 200) { throw "safe-copy health did not become ready. See $stderrLog" }
  $listeningApiPids = @(Get-ListeningProcessIds $ApiPort)
  if ($listeningApiPids.Count -ne 1) { throw 'The safe-copy API listener identity could not be confirmed.' }
  $processId = $listeningApiPids[0]
}

$health = Get-Health "http://127.0.0.1:$ApiPort/v1/health"
$healthBody = $health.Content | ConvertFrom-Json
if ($health.StatusCode -ne 200 -or $healthBody.status -ne 'ready' -or $healthBody.db -ne 'ready' -or $healthBody.schemaVersion -ne 6) {
  throw 'safe-copy health/schema check failed.'
}
if ($health.Headers['X-Warun-Environment'] -ne 'safe-copy' -or $health.Headers['X-Warun-Database-Target'] -ne 'safe-copy' -or $health.Headers['X-Warun-Database-Identity'] -ne (Get-DatabaseIdentity $DatabasePath)) {
  throw 'The running process is not identified as the requested safe-copy runtime.'
}
if ((Get-HealthProcessId -HealthResponse $health) -ne $processId) { throw 'Health belongs to a different process than the safe-copy listener.' }
$preflight = Get-AdminPreflight -Token $SafeCopyAdminToken -Port $ApiPort
if ($null -eq $preflight -or $preflight.StatusCode -ne 200) {
  if ($existingPids.Count -eq 0 -and $null -ne $processId) { Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue }
  throw 'safe-copy admin preflight did not return HTTP 200.'
}
Assert-SafeCopyInjectedKitchenToken -Token $SafeCopyKitchenToken -Port $WebPort

[void](New-Item -ItemType Directory -Path $RuntimeRoot -Force)
$lanOrigin = if ($lanAddresses.Count -gt 0) { "http://$($lanAddresses[0]):$WebPort" } else { "http://127.0.0.1:$WebPort" }
$runtimeInfo = [pscustomobject]@{
  processId = $processId
  databasePath = $DatabasePath
  databaseTarget = 'safe-copy'
  isProduction = $false
  environment = 'safe-copy'
  apiPort = $ApiPort
  webPort = $WebPort
  lanIPv4 = $lanAddresses
  pcAdminUrl = "http://127.0.0.1:$WebPort/admin.html#/admin/devices"
  a90CustomerUrl = "$lanOrigin/customer/customer-01"
  pairingUrlOrigin = $lanOrigin
  pairingUrlTemplate = "$lanOrigin/pairing.html#p={code}"
  menuDiagnosticEnabled = [bool]$EnableMenuDiagnostics
  startedAt = (Get-Date).ToString('o')
}
$runtimeInfo | ConvertTo-Json | Set-Content -LiteralPath $StatePath -Encoding UTF8

$webHealth = Get-Health "http://127.0.0.1:$WebPort/admin.html"
if ($webHealth.StatusCode -ne 200) { throw 'The local admin web endpoint did not return HTTP 200.' }
Write-RuntimeInfo -RuntimeInfo $runtimeInfo
Write-Output "Health: HTTP $($health.StatusCode), status=$($healthBody.status), db=$($healthBody.db), schemaVersion=$($healthBody.schemaVersion)"
Write-Output "Process: PID $processId, safe-copy DB identity confirmed"

Remove-Variable SafeCopyAdminToken, SafeCopyKitchenToken -ErrorAction SilentlyContinue

  if (-not $NoBrowser) {
    $adminUrl = "http://127.0.0.1:$WebPort/admin.html#/admin/devices"
    Start-Process $adminUrl
  }
} finally {
  try {
    if ($hasMutex -and $null -ne $mutex) { [void]$mutex.ReleaseMutex() }
  } finally {
    if ($null -ne $mutex) { $mutex.Dispose() }
  }
}
