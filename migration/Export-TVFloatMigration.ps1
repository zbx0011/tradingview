[CmdletBinding()]
param(
  [string]$DestinationDirectory = [Environment]::GetFolderPath('Desktop'),
  [switch]$FinalCutover
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $env:LOCALAPPDATA 'TVFloat'
$mcpRoot = if ($env:TRADINGVIEW_MCP_ROOT) {
  $env:TRADINGVIEW_MCP_ROOT
} else {
  Join-Path $env:USERPROFILE 'tools\tradingview-mcp'
}
$skillRoot = Join-Path $env:USERPROFILE '.codex\skills\tradingview-mcp'
$taskName = 'TVFloat-LowToken-Collector'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$stagingRoot = Join-Path $env:TEMP "TVFloat-Migration-$stamp"
$packageRoot = Join-Path $stagingRoot 'TVFloat-Migration'
$zipPath = Join-Path $DestinationDirectory "TVFloat-Migration-$stamp.zip"

function Copy-DirectoryFiltered {
  param(
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][string]$Destination,
    [string[]]$ExcludedSegments = @(),
    [string[]]$ExcludedExtensions = @()
  )
  if (-not (Test-Path -LiteralPath $Source)) { return }
  $pathSeparators = [char[]]@('\', '/')
  $resolvedSource = (Resolve-Path -LiteralPath $Source).Path.TrimEnd($pathSeparators)
  foreach ($file in Get-ChildItem -LiteralPath $Source -Recurse -File -Force) {
    $relative = $file.FullName.Substring($resolvedSource.Length).TrimStart($pathSeparators)
    $segments = $relative -split '[\\/]'
    if ($segments | Where-Object { $ExcludedSegments -contains $_ }) { continue }
    if ($ExcludedExtensions -contains $file.Extension.ToLowerInvariant()) { continue }
    $target = Join-Path $Destination $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Copy-Item -LiteralPath $file.FullName -Destination $target -Force
  }
}

if ($FinalCutover) {
  & schtasks.exe /Change /TN $taskName /Disable | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to disable scheduled task '$taskName'. Run PowerShell as the same Windows user that owns the task."
  }
  Write-Host "Source monitor disabled. Do not re-enable it after the new computer is activated." -ForegroundColor Yellow
}

New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null
$workspaceDestination = Join-Path $packageRoot 'workspace'
New-Item -ItemType Directory -Path $workspaceDestination -Force | Out-Null

$rootFiles = @(
  'README.md',
  'requirements.txt',
  'tv_float.py',
  'tv_sync_client.py',
  'tv_sync_host.py',
  'tv_sync_protocol.py',
  'Start-TVFloat.vbs',
  'TradingView悬浮行情.spec',
  'A电脑-行情主机.spec',
  'B电脑-同步悬浮窗.spec',
  '同步版使用说明.txt'
)
foreach ($name in $rootFiles) {
  $source = Join-Path $projectRoot $name
  if (Test-Path -LiteralPath $source) {
    Copy-Item -LiteralPath $source -Destination (Join-Path $workspaceDestination $name) -Force
  }
}
Copy-DirectoryFiltered `
  -Source (Join-Path $projectRoot 'realtime_signals') `
  -Destination (Join-Path $workspaceDestination 'realtime_signals') `
  -ExcludedSegments @('__pycache__') `
  -ExcludedExtensions @('.pyc')
Copy-DirectoryFiltered `
  -Source (Join-Path $projectRoot '.tmp_signal_excel') `
  -Destination (Join-Path $workspaceDestination '.tmp_signal_excel') `
  -ExcludedSegments @('previews')
Copy-DirectoryFiltered `
  -Source (Join-Path $projectRoot 'outputs\tvfloat_signal_excel') `
  -Destination (Join-Path $workspaceDestination 'outputs\tvfloat_signal_excel')
Copy-DirectoryFiltered `
  -Source $PSScriptRoot `
  -Destination (Join-Path $workspaceDestination 'migration') `
  -ExcludedSegments @('__pycache__', 'packages') `
  -ExcludedExtensions @('.pyc')

if (-not (Test-Path -LiteralPath (Join-Path $mcpRoot 'package-lock.json'))) {
  throw "TradingView MCP source was not found at '$mcpRoot'."
}
Copy-DirectoryFiltered `
  -Source $mcpRoot `
  -Destination (Join-Path $packageRoot 'tradingview-mcp') `
  -ExcludedSegments @('.git', 'node_modules', 'screenshots', '__pycache__') `
  -ExcludedExtensions @('.pyc')

if (Test-Path -LiteralPath $skillRoot) {
  Copy-DirectoryFiltered `
    -Source $skillRoot `
    -Destination (Join-Path $packageRoot 'codex-skill\tradingview-mcp') `
    -ExcludedSegments @('__pycache__') `
    -ExcludedExtensions @('.pyc')
}

$runtimeDestination = Join-Path $packageRoot 'runtime-state'
New-Item -ItemType Directory -Path $runtimeDestination -Force | Out-Null
if (Test-Path -LiteralPath $runtimeRoot) {
  Get-ChildItem -LiteralPath $runtimeRoot -File -Filter '*.json' | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $runtimeDestination $_.Name) -Force
  }
}

$sourceDb = Join-Path $runtimeRoot 'market.db'
$destinationDb = Join-Path $runtimeDestination 'market.db'
if (-not (Test-Path -LiteralPath $sourceDb)) {
  throw "TVFloat database was not found at '$sourceDb'."
}
$python = (Get-Command python -ErrorAction Stop).Source
$env:TVFLOAT_BACKUP_SOURCE = $sourceDb
$env:TVFLOAT_BACKUP_DESTINATION = $destinationDb
try {
  & $python -c "import os,sqlite3; s=sqlite3.connect(os.environ['TVFLOAT_BACKUP_SOURCE']); d=sqlite3.connect(os.environ['TVFLOAT_BACKUP_DESTINATION']); s.backup(d); d.execute('PRAGMA integrity_check').fetchone(); d.close(); s.close()"
  if ($LASTEXITCODE -ne 0) { throw 'SQLite online backup failed.' }
} finally {
  Remove-Item Env:TVFLOAT_BACKUP_SOURCE -ErrorAction SilentlyContinue
  Remove-Item Env:TVFLOAT_BACKUP_DESTINATION -ErrorAction SilentlyContinue
}

$manifest = [ordered]@{
  format_version = 1
  exported_at = [DateTimeOffset]::Now.ToString('o')
  source_computer = $env:COMPUTERNAME
  final_cutover = [bool]$FinalCutover
  project_source = $projectRoot
  mcp_source = $mcpRoot
  task_name = $taskName
  monitor_timeframe = '5'
  monitor_schedule = 'Monday-Friday, 24 hours, every 5 minutes'
  watchlist = @('BYBIT:BTCUSDT.P', 'OANDA:XAGUSD', 'OANDA:XAUUSD', 'ICMARKETS:US500')
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $packageRoot 'migration-manifest.json') -Encoding UTF8

New-Item -ItemType Directory -Path $DestinationDirectory -Force | Out-Null
Compress-Archive -Path (Join-Path $packageRoot '*') -DestinationPath $zipPath -CompressionLevel Optimal -Force
Remove-Item -LiteralPath $stagingRoot -Recurse -Force

Write-Host "Migration package created:" -ForegroundColor Green
Write-Host $zipPath
if (-not $FinalCutover) {
  Write-Host 'This is a rehearsal package. Run again with -FinalCutover immediately before activating the new computer.' -ForegroundColor Yellow
}
