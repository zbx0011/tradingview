[CmdletBinding()]
param(
  [string]$TargetRoot = (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'TVFloatMonitor'),
  [string]$TradingViewMcpRoot = (Join-Path $env:USERPROFILE 'tools\tradingview-mcp'),
  [switch]$EnableMonitor,
  [switch]$EnableFloatAtLogon,
  [switch]$OverwriteExistingState,
  [switch]$SkipDependencyInstall
)

$ErrorActionPreference = 'Stop'
$packageRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$workspaceSource = Join-Path $packageRoot 'workspace'
$mcpSource = Join-Path $packageRoot 'tradingview-mcp'
$skillSource = Join-Path $packageRoot 'codex-skill\tradingview-mcp'
$runtimeSource = Join-Path $packageRoot 'runtime-state'
$taskName = 'TVFloat-LowToken-Collector'

if (-not (Test-Path -LiteralPath (Join-Path $workspaceSource 'realtime_signals\run_lightweight.ps1'))) {
  throw 'The extracted migration package is incomplete. Keep the original folder structure and run this script from workspace\migration.'
}

$targetHasFiles = (Test-Path -LiteralPath $TargetRoot) -and [bool](Get-ChildItem -LiteralPath $TargetRoot -Force | Select-Object -First 1)
if ($targetHasFiles -and -not $OverwriteExistingState) {
  throw "Target folder is not empty: '$TargetRoot'. Choose an empty folder, or use -OverwriteExistingState for the final cutover update."
}
New-Item -ItemType Directory -Path $TargetRoot -Force | Out-Null
Copy-Item -Path (Join-Path $workspaceSource '*') -Destination $TargetRoot -Recurse -Force

if ((Test-Path -LiteralPath $TradingViewMcpRoot) -and (Get-ChildItem -LiteralPath $TradingViewMcpRoot -Force | Select-Object -First 1)) {
  if (-not (Test-Path -LiteralPath (Join-Path $TradingViewMcpRoot 'package-lock.json'))) {
    throw "TradingView MCP target exists but is not a compatible source folder: '$TradingViewMcpRoot'."
  }
} else {
  New-Item -ItemType Directory -Path $TradingViewMcpRoot -Force | Out-Null
}
Copy-Item -Path (Join-Path $mcpSource '*') -Destination $TradingViewMcpRoot -Recurse -Force

[Environment]::SetEnvironmentVariable('TRADINGVIEW_MCP_ROOT', $TradingViewMcpRoot, 'User')
$env:TRADINGVIEW_MCP_ROOT = $TradingViewMcpRoot

if (Test-Path -LiteralPath $skillSource) {
  $skillTarget = Join-Path $env:USERPROFILE '.codex\skills\tradingview-mcp'
  New-Item -ItemType Directory -Path $skillTarget -Force | Out-Null
  Copy-Item -Path (Join-Path $skillSource '*') -Destination $skillTarget -Recurse -Force
}

$runtimeTarget = Join-Path $env:LOCALAPPDATA 'TVFloat'
if ((Test-Path -LiteralPath (Join-Path $runtimeTarget 'market.db')) -and -not $OverwriteExistingState) {
  throw "A TVFloat database already exists at '$runtimeTarget'. Re-run with -OverwriteExistingState only if replacing it is intentional."
}
New-Item -ItemType Directory -Path $runtimeTarget -Force | Out-Null
if (Test-Path -LiteralPath (Join-Path $runtimeTarget 'market.db')) {
  $backupName = 'market.pre-migration-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.db'
  Copy-Item -LiteralPath (Join-Path $runtimeTarget 'market.db') -Destination (Join-Path $runtimeTarget $backupName) -Force
}
Copy-Item -Path (Join-Path $runtimeSource '*') -Destination $runtimeTarget -Force
Remove-Item -LiteralPath (Join-Path $runtimeTarget '.instance.lock') -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $runtimeTarget 'market.db-shm') -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $runtimeTarget 'market.db-wal') -Force -ErrorAction SilentlyContinue

if (-not $SkipDependencyInstall) {
  $python = (Get-Command python -ErrorAction Stop).Source
  $npm = (Get-Command npm -ErrorAction Stop).Source
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js was not found in PATH.' }
  if (-not (Get-Command codex -ErrorAction SilentlyContinue)) { throw 'Codex CLI was not found in PATH. Install Codex and sign in first.' }

  & $python -m venv (Join-Path $TargetRoot '.venv')
  if ($LASTEXITCODE -ne 0) { throw 'Unable to create the Python virtual environment.' }
  $venvPython = Join-Path $TargetRoot '.venv\Scripts\python.exe'
  & $venvPython -m pip install --disable-pip-version-check -r (Join-Path $TargetRoot 'requirements.txt')
  if ($LASTEXITCODE -ne 0) { throw 'Python dependency installation failed.' }
  & $npm ci --prefix $TradingViewMcpRoot
  if ($LASTEXITCODE -ne 0) { throw 'TradingView MCP dependency installation failed.' }
}

$templatePath = Join-Path $TargetRoot 'realtime_signals\TVFloat-LowToken-Collector.xml'
[xml]$taskXml = Get-Content -LiteralPath $templatePath -Raw
$namespace = [Xml.XmlNamespaceManager]::new($taskXml.NameTable)
$namespace.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
$argumentNode = $taskXml.SelectSingleNode('//t:Actions/t:Exec/t:Arguments', $namespace)
$argumentNode.InnerText = '"' + (Join-Path $TargetRoot 'realtime_signals\run_hidden.vbs') + '" run_lightweight.ps1'
$startNode = $taskXml.SelectSingleNode('//t:CalendarTrigger/t:StartBoundary', $namespace)
$now = [DateTimeOffset]::Now
$midnight = [DateTimeOffset]::new($now.Year, $now.Month, $now.Day, 0, 0, 0, $now.Offset)
$startNode.InnerText = $midnight.ToString('yyyy-MM-ddTHH:mm:sszzz')
$temporaryXml = Join-Path $env:TEMP "TVFloat-Collector-$([guid]::NewGuid().ToString('N')).xml"
$settings = [Xml.XmlWriterSettings]::new()
$settings.Encoding = [Text.UnicodeEncoding]::new($false, $true)
$settings.Indent = $true
$writer = [Xml.XmlWriter]::Create($temporaryXml, $settings)
try { $taskXml.Save($writer) } finally { $writer.Dispose() }
try {
  & schtasks.exe /Create /TN $taskName /XML $temporaryXml /F | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Unable to register scheduled task '$taskName'." }
  if ($EnableMonitor) {
    & schtasks.exe /Change /TN $taskName /Enable | Out-Null
  } else {
    & schtasks.exe /Change /TN $taskName /Disable | Out-Null
  }
} finally {
  Remove-Item -LiteralPath $temporaryXml -Force -ErrorAction SilentlyContinue
}

if ($EnableFloatAtLogon) {
  $startup = [Environment]::GetFolderPath('Startup')
  $shortcutPath = Join-Path $startup 'TVFloat.lnk'
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = Join-Path $TargetRoot 'Start-TVFloat.vbs'
  $shortcut.WorkingDirectory = $TargetRoot
  $shortcut.Save()
}

$receipt = [ordered]@{
  installed_at = [DateTimeOffset]::Now.ToString('o')
  target_root = $TargetRoot
  tradingview_mcp_root = $TradingViewMcpRoot
  scheduled_task = $taskName
  monitor_enabled = [bool]$EnableMonitor
}
$receipt | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtimeTarget 'migration_install_receipt.json') -Encoding UTF8

Write-Host 'Installation completed.' -ForegroundColor Green
Write-Host "Project: $TargetRoot"
Write-Host "Monitor task: $taskName (enabled=$([bool]$EnableMonitor))"
Write-Host "Next: launch TradingView with CDP port 9222, sign in to Codex, then run Test-TVFloatMigration.ps1."
