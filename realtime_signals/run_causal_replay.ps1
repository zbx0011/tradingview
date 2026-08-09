param(
    [ValidateSet("watchdog", "resume", "fresh")]
    [string]$Mode = "watchdog",
    [switch]$Stateless,
    [switch]$NewThread,
    [string]$Work = "",
    [string]$Home = "",
    [string]$Data = ""
)

# One-click launcher for the Louie causal replay (see
# louie-causal-replay-runbook-20260808.md for the full manual).
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$py = Join-Path $root ".venv\Scripts\python.exe"
$runner = Join-Path $PSScriptRoot "run_xau_causal_replay_v2.py"
$watchdog = Join-Path $PSScriptRoot "run_xau_causal_watchdog.py"

if (-not $Work) { $Work = Join-Path $env:LOCALAPPDATA "Temp\codex-xau-causal-work" }
if (-not $Home) { $Home = Join-Path $env:LOCALAPPDATA "Temp\codex-xau-causal-home" }
if (-not $Data) { $Data = Join-Path $env:LOCALAPPDATA "Temp\xauusd_causal_extended_20260807.json" }

$env:CAUSAL_WORK = $Work
$env:CAUSAL_HOME = $Home
$env:CAUSAL_DATA = $Data

if ($Stateless) { $env:CAUSAL_STATELESS = "1" } else { Remove-Item Env:CAUSAL_STATELESS -ErrorAction SilentlyContinue }
if ($NewThread) { $env:CAUSAL_NEW_THREAD = "1" } else { Remove-Item Env:CAUSAL_NEW_THREAD -ErrorAction SilentlyContinue }

Write-Host "CAUSAL_WORK = $Work"
Write-Host "CAUSAL_HOME = $Home"
Write-Host "CAUSAL_DATA = $Data"
Write-Host "STATELESS    = $Stateless"
Write-Host "NEW_THREAD   = $NewThread"

switch ($Mode) {
    "watchdog" { & $py $watchdog }
    "resume"   { & $py $runner --resume }
    "fresh"    {
        if (Test-Path (Join-Path $Work "ledger\gate_state.json")) {
            Write-Warning "Target work dir already has a ledger; 'fresh' will RESET it. Use -Mode resume to continue."
        }
        & $py $runner
    }
}
