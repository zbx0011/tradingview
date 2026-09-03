param(
  [int]$Port = 4173
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSCommandPath
Set-Location -LiteralPath $projectRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js 20+ was not found. Install it from https://nodejs.org/ and run this script again.'
}

if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\.bin\vite.cmd'))) {
  Write-Host 'Installing dependencies for the first run...' -ForegroundColor Cyan
  npm ci
  if ($LASTEXITCODE -ne 0) {
    throw "npm ci failed with exit code $LASTEXITCODE"
  }
}

$internetSettings = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
if ($internetSettings.ProxyEnable -eq 1 -and $internetSettings.ProxyServer) {
  $proxyEntries = @{}
  foreach ($entry in ([string]$internetSettings.ProxyServer -split ';')) {
    if ($entry -match '^\s*([^=]+)=(.+)\s*$') {
      $proxyEntries[$matches[1].Trim().ToLowerInvariant()] = $matches[2].Trim()
    }
  }
  $proxyTarget = if ($proxyEntries.ContainsKey('https')) {
    $proxyEntries['https']
  } elseif ($proxyEntries.ContainsKey('http')) {
    $proxyEntries['http']
  } elseif ($proxyEntries.Count -eq 0) {
    ([string]$internetSettings.ProxyServer).Trim()
  }
  if ($proxyTarget) {
    $proxyUrl = if ($proxyTarget -match '^[a-z][a-z0-9+.-]*://') { $proxyTarget } else { "http://$proxyTarget" }
    if (-not $env:HTTP_PROXY) { $env:HTTP_PROXY = $proxyUrl }
    if (-not $env:HTTPS_PROXY) { $env:HTTPS_PROXY = $proxyUrl }
    $env:NODE_USE_ENV_PROXY = '1'
    Write-Host "Using the Windows proxy for private GitHub sync: $proxyUrl" -ForegroundColor Cyan
  }
}

Write-Host "Kline Studio is starting at http://127.0.0.1:$Port/" -ForegroundColor Green
npm run dev -- --host 127.0.0.1 --port $Port --strictPort
if ($LASTEXITCODE -ne 0) {
  throw "Kline Studio exited with code $LASTEXITCODE"
}
