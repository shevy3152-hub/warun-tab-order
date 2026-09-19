[CmdletBinding()]
param(
  [ValidateSet('start', 'stop', 'status')]
  [string]$Action = 'start',
  [string]$DatabasePath = '',
  [string]$WebRoot = '',
  [string]$RuntimeRoot = '',
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
$WebRoot = if ([string]::IsNullOrWhiteSpace($WebRoot)) { Join-Path $ProjectRoot 'prototype\dist\client' } else { $WebRoot }
$ProductionPath = [IO.Path]::GetFullPath((Join-Path $ServerRoot 'var\warun.sqlite3'))
$SafeCopiesRoot = [IO.Path]::GetFullPath((Join-Path $ServerRoot 'var\safe-copies'))
$DatabasePath = [IO.Path]::GetFullPath($DatabasePath)
$RuntimeRoot = if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) { Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'WarunTabOrder\safe-copy' } else { $RuntimeRoot }
$RuntimeRoot = [IO.Path]::GetFullPath($RuntimeRoot)
$WebRoot = [IO.Path]::GetFullPath($WebRoot)
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

function Test-SupportedSafeCopySchema {
  param([Parameter(Mandatory)][int]$SchemaVersion)
  return $SchemaVersion -eq 8 -or $SchemaVersion -eq 9
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

function Get-StateProperty {
  param([Parameter(Mandatory)]$State, [Parameter(Mandatory)][string]$Name)
  if (@($State.PSObject.Properties.Name) -contains $Name) { return $State.$Name }
  return $null
}

function Read-RuntimeState {
  if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) { return $null }
  try {
    $raw = Get-Content -LiteralPath $StatePath -Raw -Encoding utf8 -ErrorAction Stop
    if ([string]::IsNullOrWhiteSpace($raw)) { throw 'The runtime-state file is empty.' }
    $state = $raw | ConvertFrom-Json -ErrorAction Stop
    foreach ($required in @('processId', 'databasePath', 'databaseTarget', 'isProduction', 'environment', 'apiPort', 'webPort', 'startedAt')) {
      if (-not (@($state.PSObject.Properties.Name) -contains $required)) { throw "The runtime-state file is missing required field: $required" }
    }
    return $state
  } catch {
    throw "runtime-state.json is invalid. Refusing to overwrite or delete it: $($_.Exception.Message)"
  }
}

function Get-RuntimeStateSummary {
  param([Parameter(Mandatory)]$State)
  [pscustomobject]@{
    processId = Get-StateProperty -State $State -Name 'processId'
    databasePath = Get-StateProperty -State $State -Name 'databasePath'
    databaseTarget = Get-StateProperty -State $State -Name 'databaseTarget'
    environment = Get-StateProperty -State $State -Name 'environment'
    isProduction = Get-StateProperty -State $State -Name 'isProduction'
    webRoot = Get-StateProperty -State $State -Name 'webRoot'
    webPort = Get-StateProperty -State $State -Name 'webPort'
    apiPort = Get-StateProperty -State $State -Name 'apiPort'
    startedAt = Get-StateProperty -State $State -Name 'startedAt'
    instanceId = Get-StateProperty -State $State -Name 'instanceId'
  }
}

function Write-StaleStateSummary {
  param([Parameter(Mandatory)][string]$Reason, [Parameter(Mandatory)]$State)
  $summary = Get-RuntimeStateSummary -State $State
  Write-Output "Runtime-state ${Reason}: PID=$($summary.processId), target=$($summary.databaseTarget), production=$([bool]$summary.isProduction), web=$($summary.webPort), api=$($summary.apiPort), startedAt=$($summary.startedAt), instanceId=$($summary.instanceId)"
  Write-Output "Runtime-state database path: $($summary.databasePath)"
  if (-not [string]::IsNullOrWhiteSpace([string]$summary.webRoot)) { Write-Output "Runtime-state web root: $($summary.webRoot)" }
}

function Write-AtomicRuntimeState {
  param([Parameter(Mandatory)]$RuntimeInfo)
  [void](New-Item -ItemType Directory -Path $RuntimeRoot -Force)
  $temporaryPath = Join-Path $RuntimeRoot ('.runtime-state-' + [Guid]::NewGuid().ToString('N') + '.tmp')
  $replacementBackupPath = Join-Path $RuntimeRoot ('.runtime-state-backup-' + [Guid]::NewGuid().ToString('N') + '.tmp')
  $encoding = [Text.UTF8Encoding]::new($false)
  $stream = $null
  try {
    $payload = ($RuntimeInfo | ConvertTo-Json -Depth 8)
    $bytes = $encoding.GetBytes($payload)
    $stream = [IO.File]::Open($temporaryPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
    $stream.Dispose()
    $stream = $null
    if (Test-Path -LiteralPath $StatePath -PathType Leaf) {
      [IO.File]::Replace($temporaryPath, $StatePath, $replacementBackupPath, $true)
    } else {
      [IO.File]::Move($temporaryPath, $StatePath)
    }
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
    if (Test-Path -LiteralPath $temporaryPath -PathType Any) {
      Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $replacementBackupPath -PathType Any) {
      Remove-Item -LiteralPath $replacementBackupPath -Force -ErrorAction SilentlyContinue
    }
  }
}

function Test-RuntimeStateIdentity {
  param([Parameter(Mandatory)]$Expected, [Parameter(Mandatory)]$Actual)
  $expectedProcessId = [int](Get-StateProperty -State $Expected -Name 'processId')
  $actualProcessId = [int](Get-StateProperty -State $Actual -Name 'processId')
  if ($expectedProcessId -ne $actualProcessId) { return $false }
  $expectedDatabase = [IO.Path]::GetFullPath([string](Get-StateProperty -State $Expected -Name 'databasePath'))
  $actualDatabase = [IO.Path]::GetFullPath([string](Get-StateProperty -State $Actual -Name 'databasePath'))
  if (-not $expectedDatabase.Equals($actualDatabase, [StringComparison]::OrdinalIgnoreCase)) { return $false }
  foreach ($name in @('webPort', 'apiPort')) {
    if ([int](Get-StateProperty -State $Expected -Name $name) -ne [int](Get-StateProperty -State $Actual -Name $name)) { return $false }
  }
  $expectedInstance = [string](Get-StateProperty -State $Expected -Name 'instanceId')
  $actualInstance = [string](Get-StateProperty -State $Actual -Name 'instanceId')
  if (-not [string]::IsNullOrWhiteSpace($expectedInstance) -or -not [string]::IsNullOrWhiteSpace($actualInstance)) {
    return $expectedInstance -eq $actualInstance
  }
  $expectedStartedAt = [string](Get-StateProperty -State $Expected -Name 'startedAt')
  $actualStartedAt = [string](Get-StateProperty -State $Actual -Name 'startedAt')
  return -not [string]::IsNullOrWhiteSpace($expectedStartedAt) -and $expectedStartedAt -eq $actualStartedAt
}

function Remove-RuntimeStateIfUnchanged {
  param([Parameter(Mandatory)]$Expected, [Parameter(Mandatory)][string]$Reason)
  $actual = Read-RuntimeState
  if ($null -eq $actual) { return $false }
  if (-not (Test-RuntimeStateIdentity -Expected $Expected -Actual $actual)) {
    throw "Refusing to remove runtime-state because it changed during $Reason."
  }
  Remove-Item -LiteralPath $StatePath -Force -ErrorAction Stop
  Write-Output "Removed runtime-state after ${Reason}: $StatePath"
  return $true
}

function Get-ProcessSnapshot {
  param([Parameter(Mandatory)][int]$ProcessId)
  $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if ($null -eq $process) { return $null }
  try {
    $record = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop
  } catch {
    throw "Could not inspect process $ProcessId command line safely: $($_.Exception.Message)"
  }
  if ($null -eq $record) { return $null }
  [pscustomobject]@{
    processId = $ProcessId
    executablePath = [string]$record.ExecutablePath
    commandLine = [string]$record.CommandLine
    isNodeServer = ([IO.Path]::GetFileName([string]$record.ExecutablePath)).Equals('node.exe', [StringComparison]::OrdinalIgnoreCase) -and ([string]$record.CommandLine -match 'src[\\/]run-server\.mjs(?:\s|$)')
  }
}

function Assert-SafeCopyDatabasePath {
  param([Parameter(Mandatory)][string]$Path)
  $resolved = [IO.Path]::GetFullPath($Path)
  if ($resolved.Equals($ProductionPath, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing the production DB path.' }
  if (-not (Test-PathUnder -Child $resolved -Parent $SafeCopiesRoot)) { throw "DB is outside the safe-copy directory: $resolved" }
  return $resolved
}

function Test-ExistingRuntime {
  param([Parameter(Mandatory)]$State)
  $stateDatabasePath = Assert-SafeCopyDatabasePath -Path ([string](Get-StateProperty -State $State -Name 'databasePath'))
  $stateWebPort = [int](Get-StateProperty -State $State -Name 'webPort')
  $stateApiPort = [int](Get-StateProperty -State $State -Name 'apiPort')
  $stateProcessId = [int](Get-StateProperty -State $State -Name 'processId')
  $stateWebRoot = [string](Get-StateProperty -State $State -Name 'webRoot')
  if ([string]::IsNullOrWhiteSpace($stateWebRoot)) { $stateWebRoot = $WebRoot }
  $stateWebRoot = [IO.Path]::GetFullPath($stateWebRoot)
  if (-not $stateDatabasePath.Equals($DatabasePath, [StringComparison]::OrdinalIgnoreCase)) { return [pscustomobject]@{ valid = $false; reason = 'database path mismatch' } }
  if (-not $stateWebRoot.Equals($WebRoot, [StringComparison]::OrdinalIgnoreCase)) { return [pscustomobject]@{ valid = $false; reason = 'web root mismatch' } }
  if ([string](Get-StateProperty -State $State -Name 'databaseTarget') -ne 'safe-copy' -or [bool](Get-StateProperty -State $State -Name 'isProduction') -or [string](Get-StateProperty -State $State -Name 'environment') -ne 'safe-copy') { return [pscustomobject]@{ valid = $false; reason = 'state is not safe-copy' } }
  $process = Get-ProcessSnapshot -ProcessId $stateProcessId
  if ($null -eq $process) { return [pscustomobject]@{ valid = $false; reason = 'PID is not running'; processId = $stateProcessId; webPort = $stateWebPort; apiPort = $stateApiPort } }
  if (-not $process.isNodeServer) { return [pscustomobject]@{ valid = $false; reason = 'PID command line is not run-server.mjs'; processId = $stateProcessId; webPort = $stateWebPort; apiPort = $stateApiPort } }
  $webPids = @(Get-ListeningProcessIds -Port $stateWebPort)
  $apiPids = @(Get-ListeningProcessIds -Port $stateApiPort)
  if ($webPids.Count -ne 1 -or $apiPids.Count -ne 1 -or $webPids[0] -ne $stateProcessId -or $apiPids[0] -ne $stateProcessId) { return [pscustomobject]@{ valid = $false; reason = 'Web/API listener identity mismatch'; processId = $stateProcessId; webPort = $stateWebPort; apiPort = $stateApiPort; webPids = $webPids; apiPids = $apiPids } }
  try { $health = Get-Health "http://127.0.0.1:$stateApiPort/v1/health" } catch { return [pscustomobject]@{ valid = $false; reason = "health unavailable: $($_.Exception.Message)"; processId = $stateProcessId; webPort = $stateWebPort; apiPort = $stateApiPort } }
  try { $healthBody = $health.Content | ConvertFrom-Json } catch { return [pscustomobject]@{ valid = $false; reason = 'health JSON invalid'; processId = $stateProcessId; webPort = $stateWebPort; apiPort = $stateApiPort } }
  $identity = Get-DatabaseIdentity -Path $stateDatabasePath
  $schemaVersion = [int]$healthBody.schemaVersion
  if ($health.StatusCode -ne 200 -or $healthBody.status -ne 'ready' -or $healthBody.db -ne 'ready' -or -not (Test-SupportedSafeCopySchema -SchemaVersion $schemaVersion) -or $health.Headers['X-Warun-Environment'] -ne 'safe-copy' -or $health.Headers['X-Warun-Database-Target'] -ne 'safe-copy' -or $health.Headers['X-Warun-Database-Identity'] -ne $identity -or (Get-HealthProcessId -HealthResponse $health) -ne $stateProcessId) { return [pscustomobject]@{ valid = $false; reason = 'health identity mismatch'; processId = $stateProcessId; webPort = $stateWebPort; apiPort = $stateApiPort; schemaVersion = $schemaVersion } }
  [pscustomobject]@{ valid = $true; reason = 'matched'; migrationRequired = ($schemaVersion -eq 8); schemaVersion = $schemaVersion; processId = $stateProcessId; webPort = $stateWebPort; apiPort = $stateApiPort; webPids = $webPids; apiPids = $apiPids; health = $health; healthBody = $healthBody; process = $process }
}

function Invoke-RuntimeStatus {
  $state = Read-RuntimeState
  if ($null -eq $state) { Write-Output "Runtime-state absent: $StatePath"; return }
  Write-StaleStateSummary -Reason 'status' -State $state
  try {
    $result = Test-ExistingRuntime -State $state
    Write-Output "Runtime identity: $($result.reason)"
    if ($result.valid) {
      $migrationState = if ($result.migrationRequired) { 'migration required (schema v8)' } else { 'schema v9' }
      Write-Output "Runtime process: PID $($result.processId), Web/API listeners verified, $migrationState"
    }
  } catch {
    Write-Output "Runtime identity: unverified ($($_.Exception.Message))"
  }
}

function Invoke-RuntimeStop {
  $state = Read-RuntimeState
  if ($null -eq $state) { Write-Output "Runtime-state absent: $StatePath"; return }
  $result = Test-ExistingRuntime -State $state
  if (-not $result.valid) { throw "Refusing to stop or delete runtime-state: $($result.reason)." }
  $stateProcessId = [int](Get-StateProperty -State $state -Name 'processId')
  Stop-Process -Id $stateProcessId -ErrorAction Stop
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    Start-Sleep -Milliseconds 250
    $process = Get-Process -Id $stateProcessId -ErrorAction SilentlyContinue
    $webPids = @(Get-ListeningProcessIds -Port $result.webPort)
    $apiPids = @(Get-ListeningProcessIds -Port $result.apiPort)
  } while (($null -ne $process -or $webPids.Count -gt 0 -or $apiPids.Count -gt 0) -and (Get-Date) -lt $deadline)
  if ($null -ne $process -or $webPids.Count -gt 0 -or $apiPids.Count -gt 0) {
    throw "safe-copy stop did not complete; runtime-state was kept: $StatePath"
  }
  Remove-RuntimeStateIfUnchanged -Expected $state -Reason 'normal stop'
  Write-Output "Stopped safe-copy PID $stateProcessId and verified listener shutdown."
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

  if ($Action -eq 'status') { Invoke-RuntimeStatus; return }
  Assert-SafeCopyFile
  if ($Action -eq 'stop') { Invoke-RuntimeStop; return }

  $node = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $node) { throw 'node.exe was not found on PATH.' }
  $SafeCopyAdminToken = Read-SafeCopyAdminToken
  $lanAddresses = @(Get-LanIPv4)
  $state = Read-RuntimeState
  $existingPids = @()
  $health = $null
  $healthBody = $null
  $existingCheck = $null

  if ($null -ne $state) {
    $existingCheck = Test-ExistingRuntime -State $state
    if ($existingCheck.valid) {
      $existingPids = @($existingCheck.processId)
      $health = $existingCheck.health
      $healthBody = $existingCheck.healthBody
    } else {
      Write-StaleStateSummary -Reason $existingCheck.reason -State $state
      $webPids = @(Get-ListeningProcessIds -Port $WebPort)
      $apiPids = @(Get-ListeningProcessIds -Port $ApiPort)
      if ($webPids.Count -gt 0 -or $apiPids.Count -gt 0) {
        throw "Runtime-state conflict: requested Web/API ports are occupied; no process was stopped and state was kept."
      }
      Remove-RuntimeStateIfUnchanged -Expected $state -Reason 'stale-state cleanup'
      $state = $null
    }
  }

  if ($existingPids.Count -eq 0) {
    $webPids = @(Get-ListeningProcessIds -Port $WebPort)
    $apiPids = @(Get-ListeningProcessIds -Port $ApiPort)
    if ($webPids.Count -gt 0 -or $apiPids.Count -gt 0) {
      throw "Port conflict: requested Web/API ports are already occupied ($(@($webPids + $apiPids | Sort-Object -Unique) -join ', '))."
    }
  }

  if ($existingPids.Count -gt 0 -and [bool](Get-StateProperty -State $state -Name 'menuDiagnosticEnabled') -ne [bool]$EnableMenuDiagnostics) {
    $oldState = $state
    Stop-Process -Id $existingCheck.processId -ErrorAction Stop
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
      Start-Sleep -Milliseconds 250
      $process = Get-Process -Id $existingCheck.processId -ErrorAction SilentlyContinue
      $webPids = @(Get-ListeningProcessIds -Port $existingCheck.webPort)
      $apiPids = @(Get-ListeningProcessIds -Port $existingCheck.apiPort)
    } while (($null -ne $process -or $webPids.Count -gt 0 -or $apiPids.Count -gt 0) -and (Get-Date) -lt $deadline)
    if ($null -ne $process -or $webPids.Count -gt 0 -or $apiPids.Count -gt 0) { throw 'The previous safe-copy process did not release both ports for diagnostic-mode restart.' }
    Remove-RuntimeStateIfUnchanged -Expected $oldState -Reason 'diagnostic-mode restart'
    $state = $null
    $existingPids = @()
  }

  $SafeCopyKitchenToken = if ($existingPids.Count -gt 0) { Invoke-SafeCopyKitchenTokenOperation -Mode 'check' } else { Invoke-SafeCopyKitchenTokenOperation -Mode 'ensure' }
  if ($existingPids.Count -gt 0) { Assert-SafeCopyInjectedKitchenToken -Token $SafeCopyKitchenToken -Port $WebPort }

  $processId = if ($existingPids.Count -gt 0) { $existingCheck.processId } else { $null }
  $stdoutLog = $null
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
    foreach ($entry in (Get-ChildProcessEnvironment).GetEnumerator()) { $startInfo.EnvironmentVariables[$entry.Key] = $entry.Value }
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
    $healthBody = $health.Content | ConvertFrom-Json
    $webPids = @(Get-ListeningProcessIds -Port $WebPort)
    $apiPids = @(Get-ListeningProcessIds -Port $ApiPort)
    if ($webPids.Count -ne 1 -or $apiPids.Count -ne 1 -or $webPids[0] -ne $processId -or $apiPids[0] -ne $processId) { throw 'The safe-copy Web/API listener identity could not be confirmed.' }
  }

  $health = Get-Health "http://127.0.0.1:$ApiPort/v1/health"
  $healthBody = $health.Content | ConvertFrom-Json
  if ($health.StatusCode -ne 200 -or $healthBody.status -ne 'ready' -or $healthBody.db -ne 'ready' -or $healthBody.schemaVersion -ne 9) { throw 'safe-copy health/schema check failed.' }
  if ($health.Headers['X-Warun-Environment'] -ne 'safe-copy' -or $health.Headers['X-Warun-Database-Target'] -ne 'safe-copy' -or $health.Headers['X-Warun-Database-Identity'] -ne (Get-DatabaseIdentity $DatabasePath)) { throw 'The running process is not identified as the requested safe-copy runtime.' }
  if ((Get-HealthProcessId -HealthResponse $health) -ne $processId) { throw 'Health belongs to a different process than the safe-copy listener.' }
  $preflight = Get-AdminPreflight -Token $SafeCopyAdminToken -Port $ApiPort
  if ($null -eq $preflight -or $preflight.StatusCode -ne 200) {
    if ($existingPids.Count -eq 0 -and $null -ne $processId) { Stop-Process -Id $processId -ErrorAction SilentlyContinue }
    throw 'safe-copy admin preflight did not return HTTP 200.'
  }
  Assert-SafeCopyInjectedKitchenToken -Token $SafeCopyKitchenToken -Port $WebPort

  [void](New-Item -ItemType Directory -Path $RuntimeRoot -Force)
  $lanOrigin = if ($lanAddresses.Count -gt 0) { "http://$($lanAddresses[0]):$WebPort" } else { "http://127.0.0.1:$WebPort" }
  $instanceId = if ($null -ne $state -and -not [string]::IsNullOrWhiteSpace([string](Get-StateProperty -State $state -Name 'instanceId'))) { [string](Get-StateProperty -State $state -Name 'instanceId') } else { [Guid]::NewGuid().ToString('D') }
  $startedAt = if ($null -ne $state -and -not [string]::IsNullOrWhiteSpace([string](Get-StateProperty -State $state -Name 'startedAt'))) { [string](Get-StateProperty -State $state -Name 'startedAt') } else { (Get-Date).ToString('o') }
  $runtimeInfo = [pscustomobject]@{
    processId = $processId
    instanceId = $instanceId
    startedAt = $startedAt
    databasePath = $DatabasePath
    databaseTarget = 'safe-copy'
    isProduction = $false
    environment = 'safe-copy'
    webRoot = $WebRoot
    apiPort = $ApiPort
    webPort = $WebPort
    lanIPv4 = $lanAddresses
    pcAdminUrl = "http://127.0.0.1:$WebPort/admin.html#/admin/devices"
    a90CustomerUrl = "$lanOrigin/customer/customer-01"
    pairingUrlOrigin = $lanOrigin
    pairingUrlTemplate = "$lanOrigin/pairing.html#p={code}"
    menuDiagnosticEnabled = [bool]$EnableMenuDiagnostics
  }
  $webHealth = Get-Health "http://127.0.0.1:$WebPort/admin.html"
  if ($webHealth.StatusCode -ne 200) { throw 'The local admin web endpoint did not return HTTP 200.' }
  Write-AtomicRuntimeState -RuntimeInfo $runtimeInfo
  Write-RuntimeInfo -RuntimeInfo $runtimeInfo
  Write-Output "Health: HTTP $($health.StatusCode), status=$($healthBody.status), db=$($healthBody.db), schemaVersion=$($healthBody.schemaVersion)"
  Write-Output "Process: PID $processId, safe-copy DB identity confirmed"

  Remove-Variable SafeCopyAdminToken, SafeCopyKitchenToken -ErrorAction SilentlyContinue
  if (-not $NoBrowser) { Start-Process "http://127.0.0.1:$WebPort/admin.html#/admin/devices" }
} finally {
  try {
    if ($hasMutex -and $null -ne $mutex) { [void]$mutex.ReleaseMutex() }
  } finally {
    if ($null -ne $mutex) { $mutex.Dispose() }
  }
}
