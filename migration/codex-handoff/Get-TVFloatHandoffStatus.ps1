[CmdletBinding()]
param()

$ErrorActionPreference = 'Continue'
$runtimeRoot = Join-Path $env:LOCALAPPDATA 'TVFloat'
$receiptPath = Join-Path $runtimeRoot 'migration_install_receipt.json'
$taskName = 'TVFloat-LowToken-Collector'

function Get-CommandInfo([string]$Name, [string[]]$Arguments) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $command) {
    return [ordered]@{ found = $false; path = $null; version = $null }
  }
  $version = $null
  try {
    $version = (& $command.Source @Arguments 2>&1 | Select-Object -First 1).ToString()
  } catch {
    $version = $_.Exception.Message
  }
  return [ordered]@{ found = $true; path = $command.Source; version = $version }
}

$receipt = $null
if (Test-Path -LiteralPath $receiptPath) {
  try {
    $receipt = Get-Content -Raw -Encoding UTF8 -LiteralPath $receiptPath | ConvertFrom-Json
  } catch {
    $receipt = [ordered]@{ parse_error = $_.Exception.Message }
  }
}

$task = [ordered]@{ exists = $false; raw = $null }
try {
  $rawTask = (& schtasks.exe /Query /TN $taskName /FO LIST /V 2>&1) -join "`n"
  if ($LASTEXITCODE -eq 0) {
    $task.exists = $true
  }
  $task.raw = $rawTask
} catch {
  $task.raw = $_.Exception.Message
}

$cdp = [ordered]@{ reachable = $false; browser = $null; websocket = $null; error = $null }
try {
  $response = Invoke-RestMethod -Uri 'http://127.0.0.1:9222/json/version' -TimeoutSec 3
  $cdp.reachable = [bool]$response.webSocketDebuggerUrl
  $cdp.browser = $response.Browser
  $cdp.websocket = $response.webSocketDebuggerUrl
} catch {
  $cdp.error = $_.Exception.Message
}

$databasePath = Join-Path $runtimeRoot 'market.db'
$database = [ordered]@{
  exists = Test-Path -LiteralPath $databasePath
  path = $databasePath
  bytes = 0
  last_write = $null
  integrity = $null
}
if ($database.exists) {
  $databaseFile = Get-Item -LiteralPath $databasePath
  $database.bytes = $databaseFile.Length
  $database.last_write = $databaseFile.LastWriteTime.ToString('o')
  $python = Get-Command python -ErrorAction SilentlyContinue
  if ($python) {
    $env:TVFLOAT_HANDOFF_DB = $databasePath
    try {
      $database.integrity = (& $python.Source -c "import os,sqlite3; c=sqlite3.connect(os.environ['TVFLOAT_HANDOFF_DB']); print(c.execute('PRAGMA integrity_check').fetchone()[0]); c.close()" 2>&1 | Select-Object -First 1).ToString()
    } catch {
      $database.integrity = $_.Exception.Message
    } finally {
      Remove-Item Env:TVFLOAT_HANDOFF_DB -ErrorAction SilentlyContinue
    }
  }
}

$statusFiles = @(
  'candidate_review_status.json',
  'candidate_review.log',
  'lightweight_runner.log',
  'visual_baseline.json',
  'visual_baseline.log',
  'candidate_queue.json',
  'candidate_memory.json',
  'range_edge_alert_plan.json'
) | ForEach-Object {
  $path = Join-Path $runtimeRoot $_
  if (Test-Path -LiteralPath $path) {
    $item = Get-Item -LiteralPath $path
    [ordered]@{
      name = $_
      exists = $true
      bytes = $item.Length
      last_write = $item.LastWriteTime.ToString('o')
    }
  } else {
    [ordered]@{ name = $_; exists = $false; bytes = 0; last_write = $null }
  }
}

$result = [ordered]@{
  generated_at = [DateTimeOffset]::Now.ToString('o')
  computer = $env:COMPUTERNAME
  user = $env:USERNAME
  powershell = $PSVersionTable.PSVersion.ToString()
  codex = Get-CommandInfo 'codex' @('--version')
  python = Get-CommandInfo 'python' @('--version')
  node = Get-CommandInfo 'node' @('--version')
  receipt_path = $receiptPath
  receipt = $receipt
  tradingview_cdp = $cdp
  database = $database
  scheduled_task = $task
  runtime_files = @($statusFiles)
}

$result | ConvertTo-Json -Depth 8
