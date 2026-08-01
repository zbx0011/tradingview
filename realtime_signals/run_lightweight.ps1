param(
  [switch]$BypassScheduleGate,
  [switch]$BypassPauseGate
)
$ErrorActionPreference = 'Stop'
$now = Get-Date
if (
  -not $BypassScheduleGate -and
  $now.DayOfWeek -in @('Saturday', 'Sunday')
) { exit 0 }

$pausePath = Join-Path $env:LOCALAPPDATA 'TVFloat\monitor_paused.json'
if (-not $BypassPauseGate -and (Test-Path -LiteralPath $pausePath)) {
  try {
    $pauseState = Get-Content -Raw -Encoding UTF8 -LiteralPath $pausePath |
      ConvertFrom-Json
    if ([bool]$pauseState.paused) {
      $pauseLog = Join-Path $env:LOCALAPPDATA 'TVFloat\lightweight_runner.log'
      $reason = [string]$pauseState.reason
      Add-Content -LiteralPath $pauseLog -Encoding UTF8 -Value (
        "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff') PAUSED $reason"
      )
      exit 0
    }
  } catch {
    throw "Invalid monitor pause state '$pausePath': $($_.Exception.Message)"
  }
}

$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$runtimeScripts = Join-Path $root '.venv\Scripts'
$runtimePython = Join-Path $runtimeScripts 'python.exe'
if (-not (Test-Path -LiteralPath $runtimePython)) {
  throw "Unique production Python runtime missing: $runtimePython"
}
$env:PATH = "$runtimeScripts;$env:PATH"
$runnerLogPath = Join-Path $env:LOCALAPPDATA 'TVFloat\lightweight_runner.log'
function Invoke-VisualBaselineSafely {
  param(
    [switch]$Force,
    [int]$MaxSeconds
  )
  try {
    if ($Force) {
      & .\realtime_signals\update_visual_baseline.ps1 -Force -MaxSeconds $MaxSeconds
    } else {
      & .\realtime_signals\update_visual_baseline.ps1 -MaxSeconds $MaxSeconds
    }
    return $true
  } catch {
    $message = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff') VISUAL_BASELINE_WARN $($_.Exception.Message)"
    Add-Content -LiteralPath $runnerLogPath -Encoding UTF8 -Value $message
    return $false
  }
}
node .\realtime_signals\collect_tv.mjs

python .\realtime_signals\candidate_filter_production.py

# Range-edge warnings are deterministic and token-free.  Orange rectangle
# geometry is already synchronized by collect_tv.mjs.  Every closed 5-minute
# candle touching an upper/lower eighth creates a pending TVFloat warning, and
# TradingView price alerts are re-armed once per bar until a confirmed breakout.
$rangeEdgePlan = Join-Path $env:LOCALAPPDATA 'TVFloat\range_edge_alert_plan.json'
python .\realtime_signals\range_edge_watch.py --output $rangeEdgePlan
node .\realtime_signals\reconcile_range_edge_alerts.mjs --input $rangeEdgePlan

# Start AI review immediately instead of waiting for a second scheduled task.
# The whole run must finish 15 seconds before the next five-minute boundary.
$nowEpoch = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$nextBoundary = ([long]([math]::Floor($nowEpoch / 300) + 1) * 300)
$deadlineEpoch = $nextBoundary - 15
$queuePath = Join-Path $env:LOCALAPPDATA 'TVFloat\candidate_queue.json'
$baselinePath = Join-Path $env:LOCALAPPDATA 'TVFloat\visual_baseline.json'
$candidateCount = 0
$queue = $null
if (Test-Path -LiteralPath $queuePath) {
  try {
    $queue = Get-Content -Raw -Encoding UTF8 -LiteralPath $queuePath | ConvertFrom-Json
    $candidateCount = @($queue.candidates).Count
  } catch {
    $candidateCount = 0
  }
}
if ($candidateCount -gt 0) {
  $baselineAge = [long]::MaxValue
    if (Test-Path -LiteralPath $baselinePath) {
      try {
        $baseline = Get-Content -Raw -Encoding UTF8 -LiteralPath $baselinePath | ConvertFrom-Json
        $rangeMapComplete = $true
        if (-not $baseline.markets -or @($baseline.markets).Count -eq 0) {
          $rangeMapComplete = $false
        } else {
          foreach ($market in @($baseline.markets)) {
            if (-not $market.PSObject.Properties['range_candidates']) {
              $rangeMapComplete = $false
              break
            }
          }
        }
        if ($rangeMapComplete) {
          $baselineAge = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - [long]$baseline.generated_at
        }
      } catch {
        $baselineAge = [long]::MaxValue
      }
  }
  $needsRangeMap = @($queue.candidates | Where-Object {
    -not [bool]$_.range_validation.chart_override -and
    (@($_.reason_families) -contains 'breakout' -or
     @($_.reason_families) -contains 'edge_reversal')
  }).Count -gt 0
  # A range-class candidate may not wait for the hourly baseline.  Force a
  # visual pass immediately so a visible authoritative orange rectangle is
  # either synchronized or the range setup is rejected by the final gates.
  $forceRangeMap = $needsRangeMap
  $regularRangeMap = $baselineAge -ge 3600
  $rangeBudget = [int]($deadlineEpoch - [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - 120)
  if (($forceRangeMap -or $regularRangeMap) -and $rangeBudget -ge 60) {
    if ($forceRangeMap) {
      $baselineUpdated = Invoke-VisualBaselineSafely -Force -MaxSeconds ([math]::Min(150, $rangeBudget))
    } else {
      $baselineUpdated = Invoke-VisualBaselineSafely -MaxSeconds ([math]::Min(150, $rangeBudget))
    }
    if ($baselineUpdated) {
      # The visual pass may have drawn a missing range. Rebuild the candidate
      # package so the final reviewer receives the authoritative rectangle.
      python .\realtime_signals\candidate_filter_production.py
      try {
        $queue = Get-Content -Raw -Encoding UTF8 -LiteralPath $queuePath | ConvertFrom-Json
        $candidateCount = @($queue.candidates).Count
      } catch {
        $candidateCount = 0
      }
    }
  }
}
if ($candidateCount -gt 0 -and $deadlineEpoch - [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() -ge 25) {
  & .\realtime_signals\review_candidates.ps1 -DeadlineEpoch $deadlineEpoch
} elseif ($candidateCount -eq 0) {
  # The hourly visual baseline uses otherwise idle cycles, so it never delays
  # a candidate decision or its TradingView annotation.
  $baselineBudget = [int]($deadlineEpoch - [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - 10)
  if ($baselineBudget -ge 45) {
    $null = Invoke-VisualBaselineSafely -MaxSeconds ([math]::Min(150, $baselineBudget))
  }
}
