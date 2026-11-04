param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectDirectory,
  [int]$Port = 4173,
  [int]$ParentPid,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedCommit,
  [string]$PreviousServerInstanceId = '',
  [switch]$InstallDependencies
)

$ErrorActionPreference = 'Stop'
$resolvedProject = (Resolve-Path -LiteralPath $ProjectDirectory).Path
$startScript = Join-Path $resolvedProject 'start-local.ps1'
$packageFile = Join-Path $resolvedProject 'package.json'
if (-not (Test-Path -LiteralPath $startScript) -or -not (Test-Path -LiteralPath $packageFile)) {
  throw "Kline Studio restart target is invalid: $resolvedProject"
}

$localAppData = [Environment]::GetFolderPath('LocalApplicationData')
$logDirectory = Join-Path $localAppData 'KlineStudio\logs'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$stdoutLog = Join-Path $logDirectory 'code-update-start.stdout.log'
$stderrLog = Join-Path $logDirectory 'code-update-start.stderr.log'

$receiptPath = Join-Path $localAppData 'KlineStudio\last-code-update.json'
$receipt = [ordered]@{
  commit = $ExpectedCommit
  project = $resolvedProject
  port = $Port
  phase = 'waiting-for-stop'
  startedAt = (Get-Date).ToString('o')
}
function Save-Receipt { $receipt | ConvertTo-Json | Set-Content -LiteralPath $receiptPath -Encoding UTF8 }

try {
  Save-Receipt
  $deadline = (Get-Date).AddSeconds(45)
  while ($ParentPid -gt 0 -and (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
  }
  if ($ParentPid -gt 0 -and (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) {
    throw 'The previous server did not stop; dependencies were not changed.'
  }

  Set-Location -LiteralPath $resolvedProject
  $actualCommit = (& git rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $actualCommit -ne $ExpectedCommit) { throw 'Code changed before restart; restart stopped.' }

  if ($InstallDependencies -or -not (Test-Path -LiteralPath (Join-Path $resolvedProject 'node_modules\.bin\vite.cmd'))) {
    $receipt.phase = 'installing-dependencies'
    Save-Receipt
    & npm.cmd ci --prefer-offline --no-audit --no-fund *> (Join-Path $logDirectory 'code-update-dependencies.log')
    if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed (exit $LASTEXITCODE); see code-update-dependencies.log." }
  }

  $receipt.phase = 'starting'
  Save-Receipt
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $startScript + '"'), '-Port', [string]$Port)
  Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WorkingDirectory $resolvedProject -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog

  $deadline = (Get-Date).AddSeconds(120)
  do {
    try {
      $origin = "http://127.0.0.1:$Port"
      $health = Invoke-RestMethod -Uri "$origin/__kline_studio_code_deploy" -Method Post -Headers @{ Origin = $origin; 'X-Kline-Studio-Deploy' = '1' } -ContentType 'application/json' -Body '{"action":"health"}' -TimeoutSec 5
      if ($health.ok -and $health.localHead -eq $ExpectedCommit -and $health.serverInstanceId -and $health.serverInstanceId -ne $PreviousServerInstanceId) {
        $receipt.phase = 'ready'
        $receipt.restartedAt = (Get-Date).ToString('o')
        $receipt.serverInstanceId = $health.serverInstanceId
        Save-Receipt
        exit 0
      }
    } catch { }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $deadline)
  throw 'The updated server did not become ready within 120 seconds.'
} catch {
  $receipt.phase = 'failed'
  $receipt.error = $_.Exception.Message
  Save-Receipt
  throw
}
