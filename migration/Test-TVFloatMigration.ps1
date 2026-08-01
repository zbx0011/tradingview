[CmdletBinding()]
param(
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
  [switch]$RunCollectorSmokeTest
)

$ErrorActionPreference = 'Continue'
$failures = [Collections.Generic.List[string]]::new()
$taskName = 'TVFloat-LowToken-Collector'

function Test-Step([string]$name, [scriptblock]$action) {
  try {
    & $action
    Write-Host "PASS  $name" -ForegroundColor Green
  } catch {
    $failures.Add("$name`: $($_.Exception.Message)")
    Write-Host "FAIL  $name - $($_.Exception.Message)" -ForegroundColor Red
  }
}

Test-Step 'Python' {
  $python = Get-Command python -ErrorAction Stop
  & $python.Source --version | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'python --version failed' }
}
Test-Step 'Node.js' {
  $node = Get-Command node -ErrorAction Stop
  & $node.Source --version | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'node --version failed' }
}
Test-Step 'Codex CLI' {
  $codex = Get-Command codex -ErrorAction Stop
  & $codex.Source --version | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'codex --version failed' }
}
Test-Step 'TradingView MCP files and dependencies' {
  $mcpRoot = if ($env:TRADINGVIEW_MCP_ROOT) { $env:TRADINGVIEW_MCP_ROOT } else { Join-Path $env:USERPROFILE 'tools\tradingview-mcp' }
  foreach ($relative in @('src\server.js', 'node_modules\@modelcontextprotocol\sdk\package.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $mcpRoot $relative))) { throw "missing $relative under $mcpRoot" }
  }
}
Test-Step 'Monitor JavaScript syntax' {
  foreach ($name in @('collect_tv.mjs', 'apply_range_baseline.mjs', 'reconcile_range_edge_alerts.mjs', 'execute_signal.mjs')) {
    & node --check (Join-Path $ProjectRoot "realtime_signals\$name")
    if ($LASTEXITCODE -ne 0) { throw "syntax check failed: $name" }
  }
}
Test-Step 'SQLite database integrity' {
  $database = Join-Path $env:LOCALAPPDATA 'TVFloat\market.db'
  if (-not (Test-Path -LiteralPath $database)) { throw "database not found: $database" }
  $env:TVFLOAT_TEST_DB = $database
  try {
    & python -c "import os,sqlite3; c=sqlite3.connect(os.environ['TVFLOAT_TEST_DB']); r=c.execute('PRAGMA integrity_check').fetchone()[0]; c.close(); assert r == 'ok', r"
    if ($LASTEXITCODE -ne 0) { throw 'integrity_check failed' }
  } finally {
    Remove-Item Env:TVFLOAT_TEST_DB -ErrorAction SilentlyContinue
  }
}
Test-Step 'TradingView CDP port 9222' {
  $response = Invoke-RestMethod -Uri 'http://127.0.0.1:9222/json/version' -TimeoutSec 3
  if (-not $response.webSocketDebuggerUrl) { throw 'CDP endpoint did not return a debugger URL' }
}
Test-Step 'Scheduled task' {
  & schtasks.exe /Query /TN $taskName | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "scheduled task '$taskName' was not found" }
}

if ($RunCollectorSmokeTest -and $failures.Count -eq 0) {
  Test-Step 'Collector smoke test' {
    & schtasks.exe /Run /TN $taskName | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'unable to start collector task' }
    Start-Sleep -Seconds 25
    $statusPath = Join-Path $env:LOCALAPPDATA 'TVFloat\candidate_review_status.json'
    if (-not (Test-Path -LiteralPath $statusPath)) { throw 'collector produced no status file after 25 seconds' }
  }
}

if ($failures.Count -gt 0) {
  Write-Host ''
  Write-Host 'Migration validation failed:' -ForegroundColor Red
  $failures | ForEach-Object { Write-Host " - $_" }
  exit 1
}
Write-Host ''
Write-Host 'Migration validation passed.' -ForegroundColor Green
