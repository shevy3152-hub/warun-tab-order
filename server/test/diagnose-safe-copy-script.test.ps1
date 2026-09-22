$ErrorActionPreference = 'Stop'

$script = Join-Path $PSScriptRoot '..\scripts\diagnose-safe-copy.ps1'
$project = Join-Path ([IO.Path]::GetTempPath()) ('warun-diagnostic-script-test-' + [guid]::NewGuid().ToString('N'))
$stdout = Join-Path $project 'stdout.json'
$stderr = Join-Path $project 'stderr.log'

try {
  New-Item -ItemType Directory -Path $project -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $project 'DEV_STATE.md') -Value '# No legacy HEAD record' -Encoding utf8
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script -ProjectRoot $project -WebPort 25173 -ApiPort 28787 1> $stdout 2> $stderr
  if ($LASTEXITCODE -ne 0) { throw "diagnostic script exited with $LASTEXITCODE" }

  $report = Get-Content -LiteralPath $stdout -Raw | ConvertFrom-Json
  if ($report.safety.mode -ne 'read-only') { throw 'diagnostic script did not report read-only mode' }
  if ($report.safety.postProbesSent -ne $false) { throw 'diagnostic script reported a mutating probe' }
  if ($null -ne $report.git.devStateHead) { throw 'missing DEV_STATE HEAD should remain null' }
} finally {
  if (Test-Path -LiteralPath $project) { Remove-Item -LiteralPath $project -Recurse -Force }
}

Write-Output 'diagnose-safe-copy-script.test.ps1 PASS'
