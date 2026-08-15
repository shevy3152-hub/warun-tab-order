[CmdletBinding()]
param(
  [ValidateRange(5, 300)]
  [int]$TimeoutSeconds = 45,

  [switch]$NoBrowser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ServerRoot = $PSScriptRoot
$ProjectRoot = Split-Path -Parent $ServerRoot
$TargetIp = '192.168.1.10'
$WebPort = 5173
$ApiPort = 8787
$KitchenUrl = "http://${TargetIp}:${WebPort}/admin.html#/kitchen"
$LocalHealthUrl = "http://127.0.0.1:${ApiPort}/v1/health"
$LanHealthUrl = "http://${TargetIp}:${ApiPort}/v1/health"
$LocalWebUrl = "http://127.0.0.1:${WebPort}/"
$LanWebUrl = "http://${TargetIp}:${WebPort}/"
$SnapshotUrl = "http://${TargetIp}:${WebPort}/v1/snapshot"
$AdminShellUrl = "http://${TargetIp}:${WebPort}/admin.html"
$RuntimeRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'WarunTabOrder'
$LogRoot = Join-Path $RuntimeRoot 'logs'
$StatePath = Join-Path $RuntimeRoot 'launcher-state.json'

# Keep this file ASCII so Windows PowerShell 5.1 reads it consistently. The
# Japanese user-facing strings are UTF-8 encoded and decoded only for display.
$MessageBase64 = @{
  title = '44KP44KL44KT5rOo5paH44O75Y6o5oi/'
  GENERIC = '6LW35YuV5Yem55CG44Gr5aSx5pWX44GX44G+44GX44Gf44CC'
  TOKEN = '5Y6o5oi/44OI44O844Kv44Oz44GuV2luZG93c+ODpuODvOOCtuODvOeSsOWig+WkieaVsOOBjOimi+OBpOOBi+OCiuOBvuOBm+OCk+OAgueuoeeQhuiAheOBq+mAo+e1oeOBl+OBpuOBj+OBoOOBleOBhOOAgg=='
  IP = '44GT44GuUEPjga5JUOOCouODieODrOOCueOBjDE5Mi4xNjguMS4xMOOBp+OBr+OBguOCiuOBvuOBm+OCk+OAguODjeODg+ODiOODr+ODvOOCr+ioreWumuOCkueiuuiqjeOBl+OBpuOBj+OBoOOBleOBhOOAguioreWumuOBr+WkieabtOOBl+OBpuOBhOOBvuOBm+OCk+OAgg=='
  PORT = '5L2/55So44Od44O844OI44GM5Yil44Gu44OX44Ot44K744K544Gr5L2/44KP44KM44Gm44GE44KL44GL44CB44GT44Gu44OX44Ot44K444Kn44Kv44OI44Gu44K144O844OQ44O844Go56K66KqN44Gn44GN44G+44Gb44KT44CC5L2V44KC57WC5LqG44GX44Gm44GE44G+44Gb44KT44CC'
  TIMEOUT = '44K144O844OQ44O844Gu5rqW5YKZ44GM5pmC6ZaT5YaF44Gr5a6M5LqG44GX44G+44Gb44KT44Gn44GX44Gf44CC6LW35YuV44Ot44Kw44KS56K66KqN44GX44Gm44GP44Gg44GV44GE44CC'
  HTTP = 'V2Vi44G+44Gf44GvQVBJ44Gu56K66KqN44Gr5aSx5pWX44GX44G+44GX44Gf44CC44ON44OD44OI44Ov44O844Kv44Go6LW35YuV44Ot44Kw44KS56K66KqN44GX44Gm44GP44Gg44GV44GE44CC'
  BROWSER = '5Y6o5oi/55S76Z2i44KS44OW44Op44Km44K244O844Gn6ZaL44GR44G+44Gb44KT44Gn44GX44Gf44CC44OW44Op44Km44K244O86Kit5a6a44KS56K66KqN44GX44Gm44GP44Gg44GV44GE44CC'
}

function ConvertFrom-MessageBase64 {
  param([Parameter(Mandatory)][string]$Value)
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Value))
}

function Stop-Launcher {
  param([Parameter(Mandatory)][string]$Code)
  throw [InvalidOperationException]::new("WARUN_LAUNCHER:$Code")
}

function Show-LauncherError {
  param([Parameter(Mandatory)][string]$Code)

  $messageKey = if ($MessageBase64.ContainsKey($Code)) { $Code } else { 'GENERIC' }
  $message = ConvertFrom-MessageBase64 $MessageBase64[$messageKey]
  $title = ConvertFrom-MessageBase64 $MessageBase64.title
  $detail = "$message`r`n`r`nCode: $Code`r`nLog: $LogRoot"

  try {
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show(
      $detail,
      $title,
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Error
    )
  } catch {
    Write-Error $detail
  }
}

function Test-TargetIpPresent {
  foreach ($adapter in [Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
    if ($adapter.OperationalStatus -ne [Net.NetworkInformation.OperationalStatus]::Up) { continue }
    foreach ($address in $adapter.GetIPProperties().UnicastAddresses) {
      if ($address.Address.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork -and
          $address.Address.IPAddressToString -eq $TargetIp) {
        return $true
      }
    }
  }
  return $false
}

function Get-ListeningProcessIds {
  param([Parameter(Mandatory)][int]$Port)

  $netstat = Join-Path $env:SystemRoot 'System32\netstat.exe'
  $ids = @()
  foreach ($line in & $netstat -ano -p TCP) {
    if ($line -match "^\s*TCP\s+\S+:$Port\s+\S+\s+LISTENING\s+(\d+)\s*$") {
      $ids += [int]$Matches[1]
    }
  }
  return @($ids | Sort-Object -Unique)
}

function Get-HttpResponse {
  param(
    [Parameter(Mandatory)][string]$Uri,
    [hashtable]$Headers = @{}
  )

  try {
    return Invoke-WebRequest -UseBasicParsing -Uri $Uri -Headers $Headers -TimeoutSec 5
  } catch {
    Stop-Launcher 'HTTP'
  }
}

function Test-ProjectHttpSignature {
  try {
    $health = Invoke-WebRequest -UseBasicParsing -Uri $LocalHealthUrl -TimeoutSec 3
    $healthBody = $health.Content | ConvertFrom-Json
    if ($health.StatusCode -ne 200 -or $healthBody.status -ne 'ready' -or $healthBody.schemaVersion -ne 1) {
      return $false
    }
    $admin = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:${WebPort}/admin.html" -TimeoutSec 3
    return $admin.StatusCode -eq 200 -and $admin.Content.Contains('meta name="warun-kitchen-token"')
  } catch {
    return $false
  }
}

function Test-LauncherState {
  param([Parameter(Mandatory)][int]$ProcessId)

  if (-not (Test-Path -LiteralPath $StatePath)) { return $false }
  try {
    $state = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
    return [int]$state.processId -eq $ProcessId -and
      [string]::Equals([string]$state.serverRoot, $ServerRoot, [StringComparison]::OrdinalIgnoreCase)
  } catch {
    return $false
  }
}

function Get-ExistingWarunServer {
  param([Parameter(Mandatory)][string]$NodePath)

  $webPids = @(Get-ListeningProcessIds $WebPort)
  $apiPids = @(Get-ListeningProcessIds $ApiPort)
  if ($webPids.Count -eq 0 -and $apiPids.Count -eq 0) { return $null }
  if ($webPids.Count -ne 1 -or $apiPids.Count -ne 1 -or $webPids[0] -ne $apiPids[0]) {
    Stop-Launcher 'PORT'
  }

  try {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($webPids[0])"
  } catch {
    Stop-Launcher 'PORT'
  }
  if ($null -eq $process -or [string]::IsNullOrWhiteSpace($process.ExecutablePath) -or
      [string]::IsNullOrWhiteSpace($process.CommandLine)) {
    Stop-Launcher 'PORT'
  }

  $sameExecutable = [string]::Equals(
    [IO.Path]::GetFullPath($process.ExecutablePath),
    [IO.Path]::GetFullPath($NodePath),
    [StringComparison]::OrdinalIgnoreCase
  )
  $expectedCommand = $process.CommandLine -match '(^|["\s])src[\\/]run-server\.mjs(["\s]|$)'
  if (-not $sameExecutable -or -not $expectedCommand) { Stop-Launcher 'PORT' }

  $hasIdentity = (Test-LauncherState $process.ProcessId) -or (Test-ProjectHttpSignature)
  if (-not $hasIdentity) { Stop-Launcher 'PORT' }
  return $process
}

function Wait-ForReady {
  param(
    [Parameter(Mandatory)][int]$ProcessId,
    [Parameter(Mandatory)][datetime]$Deadline
  )

  do {
    if ($null -eq (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) {
      Stop-Launcher 'HTTP'
    }
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $LocalHealthUrl -TimeoutSec 3
      $body = $response.Content | ConvertFrom-Json
      if ($response.StatusCode -eq 200 -and $body.status -eq 'ready') { return }
    } catch {
      # A connection failure is expected while the server is starting.
    }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $Deadline)

  Stop-Launcher 'TIMEOUT'
}

function Assert-RunningEndpoints {
  param([Parameter(Mandatory)][string]$Token)

  $localHealth = Get-HttpResponse $LocalHealthUrl
  $localHealthBody = $localHealth.Content | ConvertFrom-Json
  if ($localHealth.StatusCode -ne 200 -or $localHealthBody.status -ne 'ready') { Stop-Launcher 'HTTP' }

  $lanHealth = Get-HttpResponse $LanHealthUrl
  $lanHealthBody = $lanHealth.Content | ConvertFrom-Json
  if ($lanHealth.StatusCode -ne 200 -or $lanHealthBody.status -ne 'ready') { Stop-Launcher 'HTTP' }

  $localWeb = Get-HttpResponse $LocalWebUrl
  $lanWeb = Get-HttpResponse $LanWebUrl
  if ($localWeb.StatusCode -ne 200 -or $lanWeb.StatusCode -ne 200) { Stop-Launcher 'HTTP' }

  $authorization = @{ Authorization = "Bearer $Token" }
  $snapshot = Get-HttpResponse -Uri $SnapshotUrl -Headers $authorization
  if ($snapshot.StatusCode -ne 200) { Stop-Launcher 'HTTP' }

  $adminShell = Get-HttpResponse $AdminShellUrl
  if (-not $adminShell.Content.Contains($Token)) { Stop-Launcher 'HTTP' }
  if ($lanWeb.Content.Contains($Token)) { Stop-Launcher 'HTTP' }
}

function Open-KitchenPage {
  $chromeCandidates = @()
  if (-not [string]::IsNullOrWhiteSpace($env:ProgramFiles)) {
    $chromeCandidates += Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'
  }
  if (-not [string]::IsNullOrWhiteSpace(${env:ProgramFiles(x86)})) {
    $chromeCandidates += Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'
  }
  if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    $chromeCandidates += Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'
  }

  $chrome = $chromeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  try {
    if ($null -ne $chrome) {
      Start-Process -FilePath $chrome -ArgumentList @($KitchenUrl)
    } else {
      Start-Process $KitchenUrl
    }
  } catch {
    Stop-Launcher 'BROWSER'
  }
}

$mutex = $null
$hasMutex = $false
try {
  $mutex = [Threading.Mutex]::new($false, 'Local\WarunTabOrderKitchenLauncher')
  $hasMutex = $mutex.WaitOne(0)
  if (-not $hasMutex) { exit 0 }

  if (-not (Test-TargetIpPresent)) { Stop-Launcher 'IP' }

  $token = [Environment]::GetEnvironmentVariable('WARUN_KITCHEN_API_TOKEN', 'User')
  if ([string]::IsNullOrWhiteSpace($token)) { Stop-Launcher 'TOKEN' }
  $env:WARUN_KITCHEN_API_TOKEN = $token

  $nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $nodeCommand) { Stop-Launcher 'GENERIC' }
  $nodePath = $nodeCommand.Source

  $server = Get-ExistingWarunServer -NodePath $nodePath
  if ($null -eq $server) {
    $webEntry = Join-Path $ProjectRoot 'prototype\dist\client\index.html'
    $serverEntry = Join-Path $ServerRoot 'src\run-server.mjs'
    if (-not (Test-Path -LiteralPath $webEntry) -or -not (Test-Path -LiteralPath $serverEntry)) {
      Stop-Launcher 'GENERIC'
    }

    [void](New-Item -ItemType Directory -Path $LogRoot -Force)
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $stdoutLog = Join-Path $LogRoot "server-$stamp.stdout.log"
    $stderrLog = Join-Path $LogRoot "server-$stamp.stderr.log"
    $startArguments = @{
      FilePath = $nodePath
      ArgumentList = @('src/run-server.mjs')
      WorkingDirectory = $ServerRoot
      WindowStyle = 'Hidden'
      RedirectStandardOutput = $stdoutLog
      RedirectStandardError = $stderrLog
      PassThru = $true
    }
    $server = Start-Process @startArguments
    $serverPid = $server.Id

    [pscustomobject]@{
      processId = $serverPid
      serverRoot = $ServerRoot
      startedAt = (Get-Date).ToString('o')
    } | ConvertTo-Json | Set-Content -LiteralPath $StatePath -Encoding UTF8
  } else {
    $serverPid = $server.ProcessId
  }

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  Wait-ForReady -ProcessId $serverPid -Deadline $deadline
  Assert-RunningEndpoints -Token $token

  if (-not $NoBrowser) { Open-KitchenPage }
  Remove-Variable token -ErrorAction SilentlyContinue
} catch {
  $code = 'GENERIC'
  if ($_.Exception.Message -match '^WARUN_LAUNCHER:([A-Z]+)$') { $code = $Matches[1] }
  Show-LauncherError -Code $code
  exit 1
} finally {
  if ($hasMutex -and $null -ne $mutex) { [void]$mutex.ReleaseMutex() }
  if ($null -ne $mutex) { $mutex.Dispose() }
}
