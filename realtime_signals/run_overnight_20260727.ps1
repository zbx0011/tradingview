$ErrorActionPreference = 'Stop'
$windowStart = [datetime]'2026-07-27T23:00:00'
$windowEnd = [datetime]'2026-07-28T08:30:00'
$now = Get-Date

if ($now -lt $windowStart -or $now -ge $windowEnd) {
  exit 0
}

& (Join-Path $PSScriptRoot 'run_lightweight.ps1') -BypassScheduleGate
