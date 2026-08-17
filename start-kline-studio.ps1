param(
  [int]$Port = 4173
)

$ErrorActionPreference = 'Stop'
$projectRoot = Join-Path (Split-Path -Parent $PSCommandPath) 'kline-studio'
& (Join-Path $projectRoot 'start-local.ps1') -Port $Port
