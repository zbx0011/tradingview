param([switch]$Force)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $root '.tmp_signal_excel'
$workbookName = 'TVFloat_' + [char]0x4FE1 + [char]0x53F7 + [char]0x8BB0 + [char]0x5F55 + '.xlsx'
$outputPath = Join-Path $root (Join-Path 'outputs\tvfloat_signal_excel' $workbookName)
$workingPath = Join-Path $runtimeDir 'TVFloat_signal_records_working.xlsx'
$statePath = Join-Path $env:LOCALAPPDATA 'TVFloat\signal_excel_export_state.json'
$logPath = Join-Path $env:LOCALAPPDATA 'TVFloat\signal_excel_export.log'
$builderPath = Join-Path $runtimeDir 'build_signal_workbook.mjs'
$nodePath = 'C:\Users\zbx00\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$dataScript = Join-Path $PSScriptRoot 'export_signal_records.py'
$mutex = [Threading.Mutex]::new($false, 'Local\TVFloatSignalExcelExport')

function Write-ExportLog([string]$message) {
  Add-Content -LiteralPath $logPath -Encoding UTF8 -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff') $message"
}

$acquired = $false
try {
  $acquired = $mutex.WaitOne([TimeSpan]::FromSeconds(120))
  if (-not $acquired) {
    Write-ExportLog 'SKIP export mutex timeout'
    exit 0
  }
  Start-Sleep -Seconds 2
  $maxId = [int](& python $dataScript --max-id-only)
  if ($LASTEXITCODE -ne 0) { throw 'Unable to read maximum signal ID' }

  $lastExported = -1
  if (Test-Path -LiteralPath $statePath) {
    try {
      $state = Get-Content -Raw -Encoding UTF8 -LiteralPath $statePath | ConvertFrom-Json
      $lastExported = [int]$state.max_signal_id
    } catch {
      $lastExported = -1
    }
  }
  if (-not $Force -and $maxId -eq $lastExported -and (Test-Path -LiteralPath $outputPath)) {
    exit 0
  }

  if (Test-Path -LiteralPath $outputPath) {
    Copy-Item -LiteralPath $outputPath -Destination $workingPath -Force
  }
  $resultText = & $nodePath $builderPath
  if ($LASTEXITCODE -ne 0) { throw "Workbook builder failed: $resultText" }
  $result = ($resultText | Select-Object -Last 1) | ConvertFrom-Json
  if (-not $result.success -or -not (Test-Path -LiteralPath $workingPath)) {
    throw 'Workbook export did not produce the expected file'
  }
  $outputDirectory = Split-Path -Parent $outputPath
  New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
  Copy-Item -LiteralPath $workingPath -Destination $outputPath -Force

  $newState = [ordered]@{
    max_signal_id = [int]$result.max_signal_id
    record_count = [int]$result.record_count
    exported_at = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    output = $outputPath
  }
  $temporary = "$statePath.tmp"
  $json = ConvertTo-Json -InputObject $newState -Compress
  [IO.File]::WriteAllText($temporary, $json, [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $statePath -Force
  Write-ExportLog "COMPLETED max_signal_id=$($result.max_signal_id) records=$($result.record_count) preserved_manual_rows=$($result.preserved_manual_rows)"
} catch {
  Write-ExportLog "ERROR $($_.Exception.Message)"
  throw
} finally {
  if ($acquired) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
