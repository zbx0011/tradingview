param(
  [long]$DeadlineEpoch = 0,
  [switch]$DryRun,
  [string]$QueuePath = '',
  [string]$SeenPath = ''
)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
if (-not $QueuePath) { $QueuePath = Join-Path $env:LOCALAPPDATA 'TVFloat\candidate_queue.json' }
if (-not $SeenPath) { $SeenPath = Join-Path $env:LOCALAPPDATA 'TVFloat\candidate_reviewed.json' }
$logPath = Join-Path $env:LOCALAPPDATA 'TVFloat\candidate_review.log'
$statusPath = Join-Path $env:LOCALAPPDATA 'TVFloat\candidate_review_status.json'
$storePath = Join-Path $PSScriptRoot 'kline_store.py'
$promptPath = Join-Path $PSScriptRoot 'review_decision_prompt.txt'
$schemaPath = Join-Path $PSScriptRoot 'review_decision_schema.json'
$executorPath = Join-Path $PSScriptRoot 'execute_signal.mjs'
$rendererPath = Join-Path $PSScriptRoot 'render_candidate_chart.py'
$venvPython = Join-Path $root '.venv\Scripts\python.exe'
$visualBaselinePath = Join-Path $env:LOCALAPPDATA 'TVFloat\visual_baseline.json'
$decisionReserveSeconds = 60
$minimumExecutionSeconds = 25
$absoluteReviewTimeoutSeconds = 180

function Get-NowEpoch {
  return [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
}
function Write-ReviewLog([string]$message) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff') $message"
  Add-Content -LiteralPath $logPath -Encoding UTF8 -Value $line
}
function Write-ReviewStatus(
  [string]$status,
  [object]$candidate,
  [string]$message,
  [string]$model = '',
  [int]$jobRunId = 0
) {
  $value = [ordered]@{
    status = $status
    updated_at = Get-NowEpoch
    key = "$($candidate.vendor):$($candidate.symbol):$($candidate.timeframe):$($candidate.bar_time):$($candidate.reason)"
    vendor = [string]$candidate.vendor
    symbol = [string]$candidate.symbol
    timeframe = [string]$candidate.timeframe
    bar_time = [long]$candidate.bar_time
    model = $model
    message = $message
    job_run_id = $jobRunId
  }
  $json = ConvertTo-Json -InputObject $value -Compress
  $temporary = "$statusPath.tmp"
  [System.IO.File]::WriteAllText($temporary, $json, [System.Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $statusPath -Force
}
function Invoke-StorePayload([string]$command, [hashtable]$payload) {
  $json = ConvertTo-Json -InputObject $payload -Compress -Depth 12
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
  $output = & python $storePath $command --payload-base64 $encoded
  if ($LASTEXITCODE -ne 0) { throw "kline_store $command failed" }
  return $output | ConvertFrom-Json
}
function Finish-Run([int]$jobRunId, [string]$status, [hashtable]$detail) {
  Invoke-StorePayload 'finish-job-run' @{
    job_run_id = $jobRunId
    status = $status
    detail = $detail
  } | Out-Null
}
function Save-Seen([System.Collections.Generic.List[string]]$seen) {
  $seenJson = ConvertTo-Json -InputObject @($seen | ForEach-Object { [string]$_ }) -Compress
  [System.IO.File]::WriteAllText(
    $SeenPath,
    $seenJson,
    [System.Text.UTF8Encoding]::new($false)
  )
}
function Stop-ReviewProcess([object]$item) {
  if ($item.Process -and -not $item.Process.HasExited) {
    Stop-Process -Id $item.Process.Id -Force -ErrorAction SilentlyContinue
  }
}
function Remove-ReviewFiles([object]$item) {
  $files = @($item.PromptFile,$item.StdoutFile,$item.StderrFile,$item.ImageFile) |
    Where-Object { $_ }
  Remove-Item -LiteralPath $files -Force -ErrorAction SilentlyContinue
}
function Get-TokenUsage([object]$item) {
  $usageText = @(
    if (Test-Path -LiteralPath $item.StdoutFile) {
      Get-Content -Raw -Encoding UTF8 -LiteralPath $item.StdoutFile
    }
    if (Test-Path -LiteralPath $item.StderrFile) {
      Get-Content -Raw -Encoding UTF8 -LiteralPath $item.StderrFile
    }
  ) -join "`n"
  if ($usageText -match 'tokens used\s+([\d,]+)') {
    return [int64](($Matches[1]) -replace ',', '')
  }
  return 0
}

if (-not (Test-Path -LiteralPath $QueuePath)) { exit 0 }
$queue = Get-Content -Raw -Encoding UTF8 -LiteralPath $QueuePath | ConvertFrom-Json
if (-not $queue.candidates -or $queue.candidates.Count -eq 0) { exit 0 }

if ($DeadlineEpoch -le 0) {
  $now = Get-NowEpoch
  $DeadlineEpoch = ([long]([math]::Floor($now / 900) + 1) * 900) - 15
}
$decisionDeadline = [math]::Min(
  $DeadlineEpoch - $decisionReserveSeconds,
  (Get-NowEpoch) + $absoluteReviewTimeoutSeconds
)
if ($decisionDeadline -le (Get-NowEpoch)) {
  Write-ReviewLog "SKIP no decision budget deadline=$DeadlineEpoch"
  exit 0
}

$seen = [System.Collections.Generic.List[string]]::new()
if (Test-Path -LiteralPath $SeenPath) {
  try {
    $parsedSeen = Get-Content -Raw -Encoding UTF8 -LiteralPath $SeenPath | ConvertFrom-Json
    foreach ($entry in @($parsedSeen)) {
      if ($entry -is [string]) { $seen.Add([string]$entry) }
    }
  } catch {
    Write-ReviewLog "WARN invalid seen file: $($_.Exception.Message)"
  }
}
$promptTemplate = Get-Content -Raw -Encoding UTF8 -LiteralPath $promptPath
$codexPath = (Get-Command codex -ErrorAction Stop).Source
$running = [System.Collections.Generic.List[object]]::new()

foreach ($candidate in $queue.candidates) {
  $key = "$($candidate.vendor):$($candidate.symbol):$($candidate.timeframe):$($candidate.bar_time):$($candidate.reason)"
  if ($seen.Contains($key)) { continue }
  $model = if ($candidate.needs_sol) { 'gpt-5.6-sol' } else { 'gpt-5.6-terra' }
  $effort = if ($candidate.needs_sol) { 'high' } else { 'medium' }
  $suffix = "$($candidate.symbol)-$($candidate.bar_time)-$([guid]::NewGuid().ToString('N'))"
  $imageFile = Join-Path $env:TEMP "tvfloat-candidate-$suffix.png"
  try {
    if (-not (Test-Path -LiteralPath $venvPython)) {
      throw "Candidate renderer Python missing: $venvPython"
    }
    $renderOutput = @(& $venvPython $rendererPath `
      --vendor ([string]$candidate.vendor) --symbol ([string]$candidate.symbol) `
      --timeframe ([string]$candidate.timeframe) --bar-time ([long]$candidate.bar_time) `
      --output $imageFile 2>&1)
    $renderExitCode = $LASTEXITCODE
    $renderText = ($renderOutput | ForEach-Object { [string]$_ }) -join "`n"
    if ($renderExitCode -ne 0 -or -not (Test-Path -LiteralPath $imageFile)) {
      if ($renderText.Length -gt 2000) {
        $renderText = $renderText.Substring($renderText.Length - 2000)
      }
      throw "Candidate chart rendering failed for $key (exit=$renderExitCode): $renderText"
    }
    $renderResult = $renderText | ConvertFrom-Json
  } catch {
    $message = $_.Exception.Message
    $failedRun = Invoke-StorePayload 'start-job-run' @{
      status = 'running'
      detail = @{ key=$key; stage='candidate_chart_render'; message=$message }
    }
    Finish-Run ([int]$failedRun.job_run_id) 'failed' @{
      key=$key; stage='candidate_chart_render'; message=$message
    }
    Write-ReviewStatus 'failed' $candidate $message $model ([int]$failedRun.job_run_id)
    Write-ReviewLog "RENDER_ERROR key=$key $message"
    Remove-Item -LiteralPath $imageFile -Force -ErrorAction SilentlyContinue
    continue
  }
  # Keep the market data and structural fields intact, but do not resend the
  # full historical prose for the last three signals on every fifteen-minute run.
  $candidateForModel = $candidate | ConvertTo-Json -Compress -Depth 12 | ConvertFrom-Json
  foreach ($previous in @($candidateForModel.recent_signals)) {
    if ($previous.PSObject.Properties['reasons']) {
      $firstReason = @($previous.reasons | Select-Object -First 1)
      $summary = if ($firstReason.Count) { [string]$firstReason[0] } else { '' }
      if ($summary.Length -gt 240) { $summary = $summary.Substring(0, 237) + '...' }
      $previous.PSObject.Properties.Remove('reasons')
      Add-Member -InputObject $previous -NotePropertyName reason_summary -NotePropertyValue $summary
    }
  }
  Add-Member -InputObject $candidateForModel -NotePropertyName visual_context -NotePropertyValue ([ordered]@{
    type = 'fresh_candidate_composite'
    attached_image = $true
    outer_bars = [int]$renderResult.outer.bars
    inner_bars = [int]$renderResult.inner.bars
    through_bar_time = [long]$renderResult.bar_time
    no_future_bars = [bool]$renderResult.no_future_bars
    sha256 = [string]$renderResult.sha256
  }) -Force
  if (Test-Path -LiteralPath $visualBaselinePath) {
    try {
      $baseline = Get-Content -Raw -Encoding UTF8 -LiteralPath $visualBaselinePath | ConvertFrom-Json
      if ((Get-NowEpoch) - [long]$baseline.generated_at -le 7200) {
        $matchingBaseline = @($baseline.markets | Where-Object {
          $_.vendor -eq $candidate.vendor -and
          $_.symbol -eq $candidate.symbol -and
          [string]$_.timeframe -eq [string]$candidate.timeframe
        } | Select-Object -First 1)
        if ($matchingBaseline.Count -gt 0) {
          Add-Member -InputObject $candidateForModel -NotePropertyName visual_baseline -NotePropertyValue $matchingBaseline[0] -Force
        }
      }
    } catch {
      Write-ReviewLog "WARN invalid visual baseline: $($_.Exception.Message)"
    }
  }
  $payload = $candidateForModel | ConvertTo-Json -Compress -Depth 12
  $prompt = $promptTemplate.Replace('{{CANDIDATE_JSON}}', $payload)
  $outFile = Join-Path $env:TEMP "tvfloat-decision-$suffix.json"
  $promptFile = Join-Path $env:TEMP "tvfloat-decision-prompt-$suffix.txt"
  $stdoutFile = Join-Path $env:TEMP "tvfloat-decision-stdout-$suffix.log"
  $stderrFile = Join-Path $env:TEMP "tvfloat-decision-stderr-$suffix.log"
  [System.IO.File]::WriteAllText($promptFile, $prompt, [System.Text.UTF8Encoding]::new($false))
  $jobRun = Invoke-StorePayload 'start-job-run' @{
    status = 'running'
    detail = @{
      key = $key
      vendor = [string]$candidate.vendor
      symbol = [string]$candidate.symbol
      timeframe = [string]$candidate.timeframe
      bar_time = [long]$candidate.bar_time
      model = $model
      effort = $effort
      deadline_epoch = $DeadlineEpoch
      mode = 'decision_only_parallel'
    }
  }
  $jobRunId = [int]$jobRun.job_run_id
  Write-ReviewLog "START key=$key model=$model effort=$effort deadline=$DeadlineEpoch"
  $arguments = @(
    'exec',
    '--ephemeral',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '--ignore-rules',
    '--sandbox', 'read-only',
    '-C', "`"$root`"",
    '-m', $model,
    '-c', "model_reasoning_effort=$effort",
    '-i', "`"$imageFile`"",
    '--output-schema', "`"$schemaPath`"",
    '-o', "`"$outFile`"",
    '-'
  ) -join ' '
  $process = Start-Process -FilePath $codexPath -ArgumentList $arguments `
    -RedirectStandardInput $promptFile -RedirectStandardOutput $stdoutFile `
    -RedirectStandardError $stderrFile -WindowStyle Hidden -PassThru
  $running.Add([pscustomobject]@{
    Candidate = $candidate
    Key = $key
    Model = $model
    Effort = $effort
    JobRunId = $jobRunId
    Process = $process
    OutFile = $outFile
    PromptFile = $promptFile
    StdoutFile = $stdoutFile
    StderrFile = $stderrFile
    ImageFile = $imageFile
    StartedAt = Get-NowEpoch
    TokensUsed = 0
    Handled = $false
  })
}

if ($running.Count -eq 0) { exit 0 }
Write-ReviewStatus 'running' $running[0].Candidate "$($running.Count) AI decision review(s) running in parallel" $running[0].Model $running[0].JobRunId

while (@($running | Where-Object { -not $_.Handled -and -not $_.Process.HasExited }).Count -gt 0 -and (Get-NowEpoch) -lt $decisionDeadline) {
  Start-Sleep -Milliseconds 250
}

$signalItems = [System.Collections.Generic.List[object]]::new()
foreach ($item in $running) {
  try {
    if (-not $item.Process.HasExited) {
      Stop-ReviewProcess $item
      $message = "AI decision missed hard cutoff $decisionDeadline"
      Write-ReviewLog "DEADLINE key=$($item.Key) cutoff=$decisionDeadline"
      Write-ReviewStatus 'deadline_timeout' $item.Candidate $message $item.Model $item.JobRunId
      Finish-Run $item.JobRunId 'deadline_timeout' @{
        key = $item.Key; message = $message; model = $item.Model; deadline_epoch = $DeadlineEpoch
      }
      $seen.Add($item.Key)
      continue
    }
    $item.Process.WaitForExit()
    $item.Process.Refresh()
    if (-not (Test-Path $item.OutFile)) {
      $stderr = if (Test-Path $item.StderrFile) { Get-Content -Raw -Encoding UTF8 $item.StderrFile } else { '' }
      throw "AI decision output missing; exit_code=$($item.Process.ExitCode): $stderr"
    }
    $decision = Get-Content -Raw -Encoding UTF8 $item.OutFile | ConvertFrom-Json
    $duration = (Get-NowEpoch) - [long]$item.StartedAt
    $tokensUsed = Get-TokenUsage $item
    $item.TokensUsed = $tokensUsed
    Write-ReviewLog "DECISION key=$($item.Key) verdict=$($decision.verdict) duration=${duration}s tokens=$tokensUsed"
    $hardReject = ''
    if ($decision.verdict -eq 'SIGNAL') {
      $setupTypeBase64 = [Convert]::ToBase64String(
        [Text.Encoding]::UTF8.GetBytes([string]$decision.setup_type)
      )
      if (
        $setupTypeBase64 -in @(
          '6ZyH6I2h5YaF6YOo77ya6L6557yY5Y+N5ZCR',
          '6ZyH6I2h56qB56C077ya5L2N56e756qB56C0'
        ) -and
        -not [bool]$item.Candidate.range_validation.valid
      ) {
        $hardReject = "range hard gate rejected setup=$($decision.setup_type)"
      }
      if (
        $setupTypeBase64 -in @(
          '5a696YCa6YGT6L6557yY77ya5Y+N5ZCR5rOi5q61',
          '5a696YCa6YGT56qB56C077ya5pu05aSn57qn5Yir5Y+N6L2s',
          '5a696YCa6YGT6aG65Yq/77ya5Zyo5pyJ5Yip6L6557yY6Lef6ZqP5Li75pa55ZCR'
        ) -and -not [bool]$item.Candidate.wide_channel_validation.valid
      ) {
        $hardReject = "wide-channel hard gate rejected setup=$($decision.setup_type)"
      }
      $narrowSetupBase64 = '56qE6YCa6YGT77ya562J5b6F5Zue6Lip6aG65Yq/5Y+C5LiO'
      if ($setupTypeBase64 -eq $narrowSetupBase64) {
        $expectedNarrowDirection = if ($decision.direction -eq 'long') { 'up' } else { 'down' }
        $validNarrowDirections = @($item.Candidate.narrow_channel_validation.valid_directions)
        if (-not ($validNarrowDirections -contains $expectedNarrowDirection)) {
          $hardReject = "narrow-channel hard gate rejected setup=$($decision.setup_type) direction=$($decision.direction)"
        }
      }
    }
    if ($hardReject) {
      Write-ReviewLog "HARD_REJECT key=$($item.Key) $hardReject"
      Write-ReviewStatus 'completed' $item.Candidate $hardReject $item.Model $item.JobRunId
      Finish-Run $item.JobRunId 'completed' @{
        key=$item.Key; message=$hardReject; model=$item.Model
        duration_seconds=$duration; tokens_used=$tokensUsed; hard_gate_rejected=$true
      }
      $seen.Add($item.Key)
      continue
    }
    if ($decision.verdict -eq 'SIGNAL') {
      $signalItems.Add([pscustomobject]@{ Item = $item; Decision = $decision })
    } else {
      Write-ReviewStatus 'completed' $item.Candidate 'Review completed: no A/B signal' $item.Model $item.JobRunId
      Finish-Run $item.JobRunId 'completed' @{
        key = $item.Key; message = 'Review completed: no A/B signal'; model = $item.Model
        duration_seconds = $duration; tokens_used = $tokensUsed; mode = 'decision_only_parallel'
      }
      $seen.Add($item.Key)
    }
  } catch {
    $message = $_.Exception.Message
    Write-ReviewLog "ERROR key=$($item.Key) $message"
    Write-ReviewStatus 'failed' $item.Candidate $message $item.Model $item.JobRunId
    Finish-Run $item.JobRunId 'failed' @{
      key = $item.Key; message = $message; model = $item.Model
    }
    $seen.Add($item.Key)
  } finally {
    Remove-ReviewFiles $item
  }
}

foreach ($signal in $signalItems) {
  $item = $signal.Item
  try {
    $remaining = $DeadlineEpoch - (Get-NowEpoch)
    if ($remaining -lt $minimumExecutionSeconds) {
      throw "Signal accepted but only ${remaining}s remain before hard deadline"
    }
    if ($DryRun) {
      Write-ReviewLog "DRYRUN SIGNAL key=$($item.Key)"
      Write-ReviewStatus 'dry_run_signal' $item.Candidate 'A/B decision found; execution skipped by DryRun' $item.Model $item.JobRunId
      Finish-Run $item.JobRunId 'dry_run_signal' @{
        key = $item.Key; model = $item.Model; tokens_used = $item.TokensUsed
        decision = $signal.Decision
      }
      $seen.Add($item.Key)
      continue
    }
    $executionFile = Join-Path $env:TEMP "tvfloat-execute-$($item.Candidate.symbol)-$($item.Candidate.bar_time)-$([guid]::NewGuid().ToString('N')).json"
    $executionPayload = @{
      candidate = $item.Candidate
      decision = $signal.Decision
    } | ConvertTo-Json -Compress -Depth 14
    [System.IO.File]::WriteAllText($executionFile, $executionPayload, [System.Text.UTF8Encoding]::new($false))
    try {
      $output = & node $executorPath --input $executionFile --deadline-epoch $DeadlineEpoch
      if ($LASTEXITCODE -ne 0) { throw "local TradingView executor failed: $output" }
      $executionResult = $output | ConvertFrom-Json
      if (-not $executionResult.success -and -not $executionResult.duplicate) {
        throw "local TradingView executor returned unsuccessful result"
      }
    } finally {
      Remove-Item -LiteralPath $executionFile -Force -ErrorAction SilentlyContinue
    }
    $message = if ($executionResult.duplicate) { 'Signal already existed; no duplicate execution' } else { 'A/B signal saved, drawn, and alerts created' }
    Write-ReviewLog "EXECUTED key=$($item.Key) signal_id=$($executionResult.signal_id)"
    Write-ReviewStatus 'completed' $item.Candidate $message $item.Model $item.JobRunId
    Finish-Run $item.JobRunId 'completed' @{
      key = $item.Key; message = $message; model = $item.Model; execution = $executionResult
      tokens_used = $item.TokensUsed
      completed_before_deadline = ((Get-NowEpoch) -lt $DeadlineEpoch)
    }
    $seen.Add($item.Key)
  } catch {
    $message = $_.Exception.Message
    Write-ReviewLog "EXECUTION_ERROR key=$($item.Key) $message"
    Write-ReviewStatus 'execution_failed' $item.Candidate $message $item.Model $item.JobRunId
    Finish-Run $item.JobRunId 'execution_failed' @{
      key = $item.Key; message = $message; model = $item.Model; deadline_epoch = $DeadlineEpoch
    }
    $seen.Add($item.Key)
  }
}

Save-Seen $seen
