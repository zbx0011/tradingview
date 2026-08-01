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

function Test-AutoRangeHasSourceRuleReview($candidate) {
  return (
    [string]$candidate.source -in @('auto_existing','auto_candidate') -and
    [string]$candidate.status -in @('active','broken','completed') -and
    [long]$candidate.end_time -gt [long]$candidate.start_time -and
    [double]$candidate.upper -gt [double]$candidate.lower -and
    -not [string]::IsNullOrWhiteSpace([string]$candidate.evidence)
  )
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

    # USER RANGE is unconditional and keeps its exact geometry. Automatic
    # ranges use only the visual source-rule review; numeric overlap and
    # confidence thresholds are forbidden.
    $keptRanges = [System.Collections.Generic.List[object]]::new()
    foreach ($candidate in @($outputMarket.range_candidates)) {
      if (
        [string]$candidate.source -eq 'manual_existing' -or
        (Test-AutoRangeHasSourceRuleReview $candidate)
      ) {
        $keptRanges.Add($candidate)
      } else {
        Write-BaselineLog (
          "REJECTED_AUTO_RANGE_WITHOUT_SOURCE_RULE_PROOF " +
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
