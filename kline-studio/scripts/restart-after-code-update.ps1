param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectDirectory,
  [int]$Port = 4173,
  [int]$ParentPid,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedCommit
)

$ErrorActionPreference = 'Stop'
$resolvedProject = (Resolve-Path -LiteralPath $ProjectDirectory).Path
$startScript = Join-Path $resolvedProject 'start-local.ps1'
$packageFile = Join-Path $resolvedProject 'package.json'
if (-not (Test-Path -LiteralPath $startScript) -or -not (Test-Path -LiteralPath $packageFile)) {
  throw "Kline Studio restart target is invalid: $resolvedProject"
}

$deadline = (Get-Date).AddSeconds(45)
while ($ParentPid -gt 0 -and (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 250
}

$localAppData = [Environment]::GetFolderPath('LocalApplicationData')
$logDirectory = Join-Path $localAppData 'KlineStudio\logs'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$stdoutLog = Join-Path $logDirectory 'code-update-start.stdout.log'
$stderrLog = Join-Path $logDirectory 'code-update-start.stderr.log'

$arguments = @(
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-File', $startScript,
  '-Port', [string]$Port
)
Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WorkingDirectory $resolvedProject -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog

$receipt = [ordered]@{
  commit = $ExpectedCommit
  project = $resolvedProject
  port = $Port
  restartedAt = (Get-Date).ToString('o')
}
$receipt | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $localAppData 'KlineStudio\last-code-update.json') -Encoding UTF8
