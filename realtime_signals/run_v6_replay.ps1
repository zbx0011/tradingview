[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string]$DataPath,

    [Parameter(Mandatory = $true)]
    [string]$WorkPath,

    [Parameter(Mandatory = $true)]
    [string]$OutputPath,

    [Parameter(Mandatory = $true)]
    [ValidateRange(0, 2147483647)]
    [int]$StartIdx,

    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 2147483647)]
    [int]$BarCount,

    [switch]$Resume
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\")).Path
$python = $env:CAUSAL_PYTHON_EXECUTABLE
if ([string]::IsNullOrWhiteSpace($python)) {
    $candidate = Join-Path $repoRoot ".venv\Scripts\python.exe"
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        $python = $candidate
    } else {
        $python = "python"
    }
}

$data = (Resolve-Path -LiteralPath $DataPath).Path
$work = [System.IO.Path]::GetFullPath($WorkPath)
$output = [System.IO.Path]::GetFullPath($OutputPath)
$isolatedCodexHome = Join-Path $work ".codex-home"

# The wrapper intentionally locks the V6 identity and runtime defaults.  A
# different data hash, model, effort, or service tier is a different run.
$env:CAUSAL_DATA = $data
$env:CAUSAL_LUNA_IMAGE_WORK = $work
$env:CAUSAL_LUNA_IMAGE_OUTPUT = $output
$env:CAUSAL_LUNA_IMAGE_HOME = $isolatedCodexHome
$env:CAUSAL_START_IDX = [string]$StartIdx
$env:CAUSAL_BAR_COUNT = [string]$BarCount
$env:CAUSAL_MODEL = "gpt-5.6-luna"
$env:CAUSAL_EFFORT = "max"
$env:CAUSAL_SERVICE_TIER = "default"
$env:CAUSAL_RULE_SET = "louie_structural_trailing_v6_nextbar_opposite"

$preflight = Join-Path $repoRoot "realtime_signals\v6_package_preflight.py"
$runner = Join-Path $repoRoot "realtime_signals\run_xau_causal_luna_image_replay.py"
$finalizer = Join-Path $repoRoot "realtime_signals\finalize_v6_replay.py"

Write-Host "[V6] package/data preflight"
& $python $preflight --data-file $data --start-idx $StartIdx --bar-count $BarCount
if ($LASTEXITCODE -ne 0) { throw "V6 preflight failed with exit code $LASTEXITCODE" }

Write-Host "[V6] causal PNG replay: $StartIdx .. $($StartIdx + $BarCount - 1)"
$runnerArgs = @()
if ($Resume) { $runnerArgs += "--resume" }
& $python $runner @runnerArgs
if ($LASTEXITCODE -ne 0) { throw "V6 replay failed with exit code $LASTEXITCODE; preserve the work/output directories and resume only after checking the error" }

Write-Host "[V6] deterministic signal/trade-plan/fixed-risk finalization"
& $python $finalizer --raw-dir $output --data-file $data --risk-usd 100
if ($LASTEXITCODE -ne 0) { throw "V6 finalization failed with exit code $LASTEXITCODE" }

Write-Host "[V6] complete; no K-line Studio upload was performed"
