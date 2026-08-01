param(
  [switch]$Force,
  [int]$MaxSeconds = 150
)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$storePath = Join-Path $PSScriptRoot 'kline_store.py'
$rendererPath = Join-Path $PSScriptRoot 'render_candidate_chart.py'
$rangeApplyPath = Join-Path $PSScriptRoot 'apply_range_baseline.mjs'
$promptPath = Join-Path $PSScriptRoot 'visual_baseline_prompt.txt'
$schemaPath = Join-Path $PSScriptRoot 'visual_baseline_schema.json'
$venvPython = Join-Path $root '.venv\Scripts\python.exe'
$cachePath = Join-Path $env:LOCALAPPDATA 'TVFloat\visual_baseline.json'
$logPath = Join-Path $env:LOCALAPPDATA 'TVFloat\visual_baseline.log'
$nowEpoch = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$timeframe = '5'

function Write-BaselineLog([string]$message) {
  Add-Content -LiteralPath $logPath -Encoding UTF8 -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff') $message"
}

function Get-OverlapRatio(
  [double]$a1,
  [double]$a2,
  [double]$b1,
  [double]$b2
) {
  $overlap = [math]::Max(0.0, [math]::Min($a2, $b2) - [math]::Max($a1, $b1))
  $denominator = [math]::Max(0.000000001, [math]::Min($a2 - $a1, $b2 - $b1))
  return $overlap / $denominator
}

function Test-RangeHasDeterministicProof($candidate, $proposals) {
  foreach ($proposal in @($proposals)) {
    $timeOverlap = Get-OverlapRatio `
      ([double]$candidate.start_time) ([double]$candidate.end_time) `
      ([double]$proposal.start_time) ([double]$proposal.end_time)
    $priceOverlap = Get-OverlapRatio `
      ([double]$candidate.lower) ([double]$candidate.upper) `
      ([double]$proposal.lower) ([double]$proposal.upper)
    if ($timeOverlap -ge 0.45 -and $priceOverlap -ge 0.55) {
      return $true
    }
  }
  return $false
}

  if (-not $Force -and (Test-Path -LiteralPath $cachePath)) {
    try {
      $existing = Get-Content -Raw -Encoding UTF8 -LiteralPath $cachePath | ConvertFrom-Json
      $rangeMapComplete = $true
      if (-not $existing.markets -or @($existing.markets).Count -eq 0) {
        $rangeMapComplete = $false
      } else {
        foreach ($market in @($existing.markets)) {
          if (
            -not $market.PSObject.Properties['range_candidates'] -or
            [string]$market.timeframe -ne $timeframe
          ) {
            $rangeMapComplete = $false
            break
          }
        }
      }
      if ($rangeMapComplete -and $nowEpoch - [long]$existing.generated_at -lt 3600) { exit 0 }
    } catch {
      Write-BaselineLog "WARN invalid cache: $($_.Exception.Message)"
    }
}

$markets = @(
  [ordered]@{ vendor='BYBIT'; symbol='BTCUSDT.P'; timeframe=$timeframe },
  [ordered]@{ vendor='OANDA'; symbol='XAGUSD'; timeframe=$timeframe },
  [ordered]@{ vendor='OANDA'; symbol='XAUUSD'; timeframe=$timeframe },
  [ordered]@{ vendor='ICMARKETS'; symbol='US500'; timeframe=$timeframe }
)
$images = [System.Collections.Generic.List[string]]::new()
$metadata = [System.Collections.Generic.List[object]]::new()
$suffix = [guid]::NewGuid().ToString('N')
$promptFile = Join-Path $env:TEMP "tvfloat-baseline-prompt-$suffix.txt"
$outFile = Join-Path $env:TEMP "tvfloat-baseline-output-$suffix.json"
$stdoutFile = Join-Path $env:TEMP "tvfloat-baseline-stdout-$suffix.log"
$stderrFile = Join-Path $env:TEMP "tvfloat-baseline-stderr-$suffix.log"

try {
  foreach ($market in $markets) {
    $latest = & python $storePath latest --vendor $market.vendor --symbol $market.symbol --timeframe $timeframe |
      ConvertFrom-Json
    if (-not $latest.open_time) {
      throw "No closed candle for $($market.vendor):$($market.symbol)"
    }
    $imagePath = Join-Path $env:TEMP "tvfloat-baseline-$($market.symbol)-$suffix.png"
    $renderOutput = & $venvPython $rendererPath `
      --vendor $market.vendor --symbol $market.symbol --timeframe $timeframe `
      --bar-time ([long]$latest.open_time) --output $imagePath
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $imagePath)) {
      throw "Baseline chart rendering failed for $($market.vendor):$($market.symbol)"
    }
    $render = $renderOutput | ConvertFrom-Json
    $images.Add($imagePath)
    $metadata.Add([ordered]@{
      vendor = $market.vendor
      symbol = $market.symbol
      timeframe = $timeframe
      through_bar_time = [long]$latest.open_time
      no_future_bars = [bool]$render.no_future_bars
      chart_ranges = @($render.chart_ranges)
      local_range_proposals = @($render.local_range_proposals)
      outer_start_time = [long]$render.outer.start_time
      outer_end_time = [long]$render.outer.end_time
      inner_start_time = [long]$render.inner.start_time
      inner_end_time = [long]$render.inner.end_time
      bar_seconds = [long]$render.outer.bar_seconds
    })
  }

  $request = [ordered]@{
    generated_at = $nowEpoch
    markets = @($metadata)
  } | ConvertTo-Json -Compress -Depth 6
  $template = Get-Content -Raw -Encoding UTF8 -LiteralPath $promptPath
  $prompt = $template.Replace('{{MARKETS_JSON}}', $request)
  [System.IO.File]::WriteAllText($promptFile, $prompt, [System.Text.UTF8Encoding]::new($false))

  $codexPath = (Get-Command codex -ErrorAction Stop).Source
  $arguments = [System.Collections.Generic.List[string]]::new()
  foreach ($value in @(
    'exec','--ephemeral','--skip-git-repo-check','--ignore-user-config',
    '--ignore-rules','--sandbox','read-only','-C',"`"$root`"",
    '-m','gpt-5.6-terra','-c','model_reasoning_effort=low'
  )) { $arguments.Add($value) }
  foreach ($imagePath in @($images)) {
    $arguments.Add('-i')
    $arguments.Add("`"$imagePath`"")
  }
  foreach ($value in @('--output-schema',"`"$schemaPath`"",'-o',"`"$outFile`"",'-')) {
    $arguments.Add($value)
  }
  $process = Start-Process -FilePath $codexPath -ArgumentList ($arguments -join ' ') `
    -RedirectStandardInput $promptFile -RedirectStandardOutput $stdoutFile `
    -RedirectStandardError $stderrFile -WindowStyle Hidden -PassThru
  if (-not $process.WaitForExit([math]::Max(30, $MaxSeconds) * 1000)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw "Hourly visual baseline timed out after ${MaxSeconds}s"
  }
  $process.WaitForExit()
  $process.Refresh()
  if (-not (Test-Path -LiteralPath $outFile)) {
    $stderr = if (Test-Path -LiteralPath $stderrFile) {
      Get-Content -Raw -Encoding UTF8 -LiteralPath $stderrFile
    } else { '' }
    throw "Hourly visual baseline failed exit=$($process.ExitCode): $stderr"
  }
  $result = Get-Content -Raw -Encoding UTF8 -LiteralPath $outFile | ConvertFrom-Json
  if (@($result.markets).Count -ne 4) {
    throw "Hourly visual baseline returned $(@($result.markets).Count) markets"
  }
  foreach ($market in @($markets)) {
    $inputMarket = @($metadata | Where-Object {
      $_.vendor -eq $market.vendor -and $_.symbol -eq $market.symbol
    })[0]
    $outputMarket = @($result.markets | Where-Object {
      $_.vendor -eq $market.vendor -and $_.symbol -eq $market.symbol
    })[0]
    if (-not $outputMarket -or -not [bool]$outputMarket.range_scan_complete) {
      throw "Incomplete range scan for $($market.vendor):$($market.symbol)"
    }
    $reviewedIds = @($outputMarket.proposal_reviews | ForEach-Object {
      [string]$_.proposal_id
    })
    foreach ($proposal in @($inputMarket.local_range_proposals)) {
      if ($reviewedIds -notcontains [string]$proposal.proposal_id) {
        throw "Unreviewed local range proposal $($proposal.proposal_id) for $($market.vendor):$($market.symbol)"
      }
    }

    # Image review may not relax the exact-OHLC range proof.  Only manual
    # rectangles bypass this gate.  Every automatic range must overlap a
    # deterministic proposal whose detector already proved two independent
    # upper tests, two independent lower tests, and alternating rotations.
    $keptRanges = [System.Collections.Generic.List[object]]::new()
    foreach ($candidate in @($outputMarket.range_candidates)) {
      if (
        [string]$candidate.source -eq 'manual_existing' -or
        (Test-RangeHasDeterministicProof $candidate @($inputMarket.local_range_proposals))
      ) {
        $keptRanges.Add($candidate)
      } else {
        Write-BaselineLog (
          "REJECTED_UNPROVEN_AUTO_RANGE " +
          "$($market.vendor):$($market.symbol) " +
          "$($candidate.start_time)-$($candidate.end_time) " +
          "$($candidate.lower)-$($candidate.upper)"
        )
      }
    }
    $outputMarket.range_candidates = @($keptRanges)

    if (@($keptRanges).Count -eq 0) {
      $outputMarket.horizontal_range_status = 'not_proven'
      $outputMarket.range_upper = 0
      $outputMarket.range_lower = 0
    } else {
      $referenceRange = @($keptRanges | Sort-Object -Property end_time)[-1]
      $outputMarket.range_upper = [double]$referenceRange.upper
      $outputMarket.range_lower = [double]$referenceRange.lower
      $outputMarket.horizontal_range_status = if (
        [string]$referenceRange.status -eq 'active'
      ) { 'active' } else { 'broken' }
    }
  }
  $temporary = "$cachePath.tmp"
  $json = ConvertTo-Json -InputObject $result -Compress -Depth 8
  [System.IO.File]::WriteAllText($temporary, $json, [System.Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $cachePath -Force
  $rangeApplyOutput = & node $rangeApplyPath $cachePath
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to synchronize visual range candidates to TradingView: $rangeApplyOutput"
  }
  $tokenUsage = 0
  $usageText = @(
    if (Test-Path -LiteralPath $stdoutFile) { Get-Content -Raw -Encoding UTF8 -LiteralPath $stdoutFile }
    if (Test-Path -LiteralPath $stderrFile) { Get-Content -Raw -Encoding UTF8 -LiteralPath $stderrFile }
  ) -join "`n"
  if ($usageText -match 'tokens used\s+([\d,]+)') {
    $tokenUsage = [int64](($Matches[1]) -replace ',', '')
  }
  if ($process.ExitCode -ne 0) {
    Write-BaselineLog "WARN codex exit code was $($process.ExitCode), but schema-valid output was produced"
  }
  Write-BaselineLog "COMPLETED generated_at=$($result.generated_at) tokens=$tokenUsage ranges=$rangeApplyOutput"
} catch {
  Write-BaselineLog "ERROR $($_.Exception.Message)"
  throw
} finally {
  if ($images.Count -gt 0) {
    Remove-Item -LiteralPath @($images) -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $promptFile,$outFile,$stdoutFile,$stderrFile -Force -ErrorAction SilentlyContinue
}
