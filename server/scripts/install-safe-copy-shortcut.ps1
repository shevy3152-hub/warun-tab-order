[CmdletBinding()]
param(
  [string]$ProjectRoot = '',
  [string]$ShortcutPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ProjectRoot = if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
  Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
} else {
  [IO.Path]::GetFullPath($ProjectRoot)
}
$ServerRoot = Join-Path $ProjectRoot 'server'
$SourcePath = Join-Path $ServerRoot 'open-admin.ps1'
$RuntimeRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'WarunTabOrder\safe-copy'
$DestinationPath = Join-Path $RuntimeRoot 'open-admin.ps1'
$ShortcutPath = if ([string]::IsNullOrWhiteSpace($ShortcutPath)) {
  Join-Path ([Environment]::GetFolderPath('Desktop')) 'わるん注文・管理画面.lnk'
} else {
  [IO.Path]::GetFullPath($ShortcutPath)
}
$PowerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

if (-not (Test-Path -LiteralPath $SourcePath -PathType Leaf)) {
  throw "safe-copy admin launcher source was not found: $SourcePath"
}
if (-not (Test-Path -LiteralPath $ServerRoot -PathType Container)) {
  throw "server directory was not found: $ServerRoot"
}

[void](New-Item -ItemType Directory -Path $RuntimeRoot -Force)
$sourceText = [IO.File]::ReadAllText($SourcePath, [Text.Encoding]::UTF8)
[IO.File]::WriteAllText($DestinationPath, $sourceText, [Text.UTF8Encoding]::new($true))

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($ShortcutPath)
$shortcut.TargetPath = $PowerShellPath
$shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$DestinationPath`" -ProjectRoot `"$ProjectRoot`""
$shortcut.WorkingDirectory = $ProjectRoot
$shortcut.IconLocation = "$env:SystemRoot\System32\SHELL32.dll,13"
$shortcut.Save()

Write-Output "Installed safe-copy admin launcher: $DestinationPath"
Write-Output "Updated desktop shortcut: $ShortcutPath"
