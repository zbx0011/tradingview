param(
  [switch]$BypassScheduleGate
)
$ErrorActionPreference = 'Stop'
$now = Get-Date
if (
  -not $BypassScheduleGate -and (
    $now.DayOfWeek -in @('Saturday', 'Sunday') -or
    $now.TimeOfDay -lt [TimeSpan]'08:30' -or
    $now.TimeOfDay -gt [TimeSpan]'23:00'
  )
) { exit 0 }

$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
node .\realtime_signals\collect_tv.mjs

# Refresh active replay rectangles without calling a model. Unbroken ranges
# follow the newest closed 15-minute candle and project eight bars into the
# future; once a confirmed exit occurs, the right edge is frozen before the
# breakout candle. User-moved/resized rectangles are detected and locked.
$replayRoot = Join-Path $env:LOCALAPPDATA 'TVFloat\replay-15m-5d-20260728'
$replayRanges = Join-Path $replayRoot 'replay_ranges.json'
$replayRangeDrawings = Join-Path $replayRoot 'replay_range_drawings.json'
if (
  (Test-Path -LiteralPath $replayRanges) -and
  (Test-Path -LiteralPath $replayRangeDrawings)
) {
  node .\realtime_signals\draw_replay_15m_ranges.mjs `
    $replayRanges $replayRangeDrawings
}

python .\realtime_signals\candidate_filter_v2.py

# Range-edge warnings are deterministic and token-free.  Orange rectangle
# geometry is already synchronized by collect_tv.mjs.  Every closed 15-minute
# candle touching an upper/lower eighth creates a pending TVFloat warning, and
# TradingView price alerts are re-armed once per bar until a confirmed breakout.
$rangeEdgePlan = Join-Path $env:LOCALAPPDATA 'TVFloat\range_edge_alert_plan.json'
python .\realtime_signals\range_edge_watch.py --output $rangeEdgePlan
node .\realtime_signals\reconcile_range_edge_alerts.mjs --input $rangeEdgePlan

# Start AI review immediately instead of waiting for a second scheduled task.
# The whole run must finish 15 seconds before the next fifteen-minute boundary.
$nowEpoch = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$nextBoundary = ([long]([math]::Floor($nowEpoch / 900) + 1) * 900)
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
  $forceRangeMap = $needsRangeMap -and $baselineAge -ge 1800
  $regularRangeMap = $baselineAge -ge 3600
  $rangeBudget = [int]($deadlineEpoch - [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - 120)
  if (($forceRangeMap -or $regularRangeMap) -and $rangeBudget -ge 60) {
    if ($forceRangeMap) {
      & .\realtime_signals\update_visual_baseline.ps1 -Force -MaxSeconds ([math]::Min(150, $rangeBudget))
    } else {
      & .\realtime_signals\update_visual_baseline.ps1 -MaxSeconds ([math]::Min(150, $rangeBudget))
    }
    # The visual pass may have drawn a missing range. Rebuild the candidate
    # package so the final reviewer receives the authoritative rectangle.
    python .\realtime_signals\candidate_filter_v2.py
    try {
      $queue = Get-Content -Raw -Encoding UTF8 -LiteralPath $queuePath | ConvertFrom-Json
      $candidateCount = @($queue.candidates).Count
    } catch {
      $candidateCount = 0
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
    & .\realtime_signals\update_visual_baseline.ps1 -MaxSeconds ([math]::Min(150, $baselineBudget))
  }
}
