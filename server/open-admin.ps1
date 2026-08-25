[CmdletBinding()]
param(
  [string]$ProjectRoot = '',
  [switch]$NoBrowser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ProjectRoot = if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
  Split-Path -Parent $PSScriptRoot
} else {
  [IO.Path]::GetFullPath($ProjectRoot)
}
$ServerRoot = Join-Path $ProjectRoot 'server'
$Launcher = Join-Path $ServerRoot 'start-safe-copy.ps1'
$DatabasePath = Join-Path $ServerRoot 'var\safe-copies\initial-menu-20260818.sqlite3'
$WebPort = 25173
$ApiPort = 28787
$RuntimeRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'WarunTabOrder\safe-copy'
$AdminTokenPath = Join-Path $RuntimeRoot 'admin-token'
$AdminUrl = "http://127.0.0.1:$WebPort/admin.html#/admin/devices"
$MutexName = 'WarunTabOrder.SafeCopy.AdminLauncher'
$WaitSeconds = 60
$mutex = $null
$hasMutex = $false
$failureMessage = $null

function Get-HeaderFirst {
  param(
    [Parameter(Mandatory)]$Headers,
    [Parameter(Mandatory)][string]$Name
  )
  return @($Headers[$Name]) | Select-Object -First 1
}

function Get-ListeningProcessIds {
  param([Parameter(Mandatory)][int]$Port)
  $netstat = Join-Path $env:SystemRoot 'System32\netstat.exe'
  $ids = foreach ($line in & $netstat -ano -p TCP) {
    if ($line -match "^\s*TCP\s+\S+:$Port\s+\S+\s+LISTENING\s+(\d+)\s*$") { [int]$Matches[1] }
  }
  return @($ids | Sort-Object -Unique)
}

function Get-ReadyHealth {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$ApiPort/v1/health" -Method Get -TimeoutSec 5
    $body = $response.Content | ConvertFrom-Json
    if ($response.StatusCode -eq 200 -and
        $body.status -eq 'ready' -and
        $body.db -eq 'ready' -and
        $body.schemaVersion -eq 5 -and
        (Get-HeaderFirst -Headers $response.Headers -Name 'X-Warun-Environment') -eq 'safe-copy' -and
        (Get-HeaderFirst -Headers $response.Headers -Name 'X-Warun-Database-Target') -eq 'safe-copy') {
      return $response
    }
  } catch {
    return $null
  }
  return $null
}

try {
  if (-not (Test-Path -LiteralPath $Launcher -PathType Leaf)) {
    throw '正式safe-copy起動スクリプトが見つかりません。'
  }
  if (-not (Test-Path -LiteralPath $DatabasePath -PathType Leaf)) {
    throw 'safe-copy DBが見つかりません。production DBは使用しません。'
  }

  $health = Get-ReadyHealth
  if ($null -eq $health) {
    $mutex = [Threading.Mutex]::new($false, $MutexName)
    $deadline = (Get-Date).AddSeconds($WaitSeconds)
    do {
      try {
        $hasMutex = $mutex.WaitOne(0)
      } catch [Threading.AbandonedMutexException] {
        $hasMutex = $true
      }
      if ($hasMutex) { break }

      $health = Get-ReadyHealth
      if ($null -ne $health) { break }
      if ((Get-Date) -ge $deadline) { break }
      Start-Sleep -Milliseconds 500
    } while ($true)

    if (-not $hasMutex -and $null -eq $health) {
      throw '別のsafe-copy起動処理が60秒以内に終了せず、25173のhealthもreadyになりませんでした。起動処理が停止・待機状態で残っている可能性があります。'
    }

    if ($hasMutex) {
      $health = Get-ReadyHealth
      if ($null -eq $health) {
        $webPids = @(Get-ListeningProcessIds -Port $WebPort)
        if ($webPids.Count -gt 0) {
          throw '25173は待受中ですがsafe-copy healthがreadyではありません。既存プロセスを再起動せず、起動失敗として扱いました。'
        }

        $child = Start-Process -FilePath 'powershell.exe' -ArgumentList @(
          '-NoProfile',
          '-ExecutionPolicy', 'Bypass',
          '-File', $Launcher,
          '-DatabasePath', $DatabasePath,
          '-WebPort', $WebPort,
          '-ApiPort', $ApiPort,
          '-TimeoutSeconds', $WaitSeconds,
          '-MutexAlreadyHeld',
          '-NoBrowser'
        ) -WorkingDirectory $ServerRoot -WindowStyle Hidden -PassThru
        $childDeadline = (Get-Date).AddSeconds($WaitSeconds)
        do {
          $child.Refresh()
          if ($child.HasExited) { break }
          $health = Get-ReadyHealth
          if ($null -ne $health) { break }
          if ((Get-Date) -ge $childDeadline) { break }
          Start-Sleep -Milliseconds 500
        } while ($true)
        $child.Refresh()
        if ($child.HasExited -and $child.ExitCode -ne 0) {
          throw "safe-copy起動スクリプトが終了コード $($child.ExitCode) で失敗しました。25173とhealthを再確認してください。"
        }
        if ($null -eq $health) { $health = Get-ReadyHealth }
        if ($null -eq $health) {
          throw '起動処理は終了しましたが、25173のhealthがHTTP 200/readyになりませんでした。'
        }
      }
    }
  }

  if ($null -eq $health) {
    $health = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$ApiPort/v1/health" -Method Get -TimeoutSec 5
  }
  $healthBody = $health.Content | ConvertFrom-Json
  if ($health.StatusCode -ne 200 -or $healthBody.status -ne 'ready' -or $healthBody.db -ne 'ready' -or $healthBody.schemaVersion -ne 5) {
    throw 'safe-copy healthがreadyになりませんでした。'
  }
  if ((Get-HeaderFirst -Headers $health.Headers -Name 'X-Warun-Environment') -ne 'safe-copy' -or
      (Get-HeaderFirst -Headers $health.Headers -Name 'X-Warun-Database-Target') -ne 'safe-copy') {
    throw '起動先がsafe-copyとして確認できませんでした。'
  }

  if (-not (Test-Path -LiteralPath $AdminTokenPath -PathType Leaf)) {
    throw 'safe-copy管理token保存先が見つかりません。'
  }
  $adminToken = ([IO.File]::ReadAllText($AdminTokenPath)).Trim()
  if ($adminToken -notmatch '^[A-Za-z0-9_-]{43}$') {
    throw 'safe-copy管理token保存先が不正です。'
  }
  $preflight = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$ApiPort/v1/admin/pairing-preflight" -Headers @{ Authorization = "Bearer $adminToken"; Accept = 'application/json' } -Method Get -TimeoutSec 5
  if ($preflight.StatusCode -ne 200) {
    throw 'safe-copy管理preflightがHTTP 200になりませんでした。'
  }

  $admin = Invoke-WebRequest -UseBasicParsing -Uri $AdminUrl -Method Get -TimeoutSec 5
  if ($admin.StatusCode -ne 200) {
    throw '管理画面がHTTP 200になりませんでした。'
  }

  if (-not $NoBrowser) {
    Start-Process $AdminUrl
  }
}
catch {
  $failureMessage = "safe-copyを起動できませんでした。原因: $($_.Exception.Message)"
}
finally {
  try {
    if ($hasMutex -and $null -ne $mutex) {
      [void]$mutex.ReleaseMutex()
    }
  } finally {
    if ($null -ne $mutex) {
      $mutex.Dispose()
    }
  }
}

if ($null -ne $failureMessage) {
  if ($NoBrowser) {
    Write-Error $failureMessage
  } else {
    try {
      Add-Type -AssemblyName PresentationFramework -ErrorAction Stop
      [System.Windows.MessageBox]::Show(
        $failureMessage,
        'わるん注文・管理画面',
        [System.Windows.MessageBoxButton]::OK,
        [System.Windows.MessageBoxImage]::Error
      ) | Out-Null
    } catch {
      Write-Error $failureMessage
    }
  }
  exit 1
}
