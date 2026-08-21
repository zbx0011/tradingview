param(
  [int]$Port = 4173
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSCommandPath
Set-Location -LiteralPath $projectRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw '未找到 Node.js 20+。请先安装 https://nodejs.org/ 后重新运行此脚本。'
}

if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules'))) {
  Write-Host '首次运行，正在安装依赖...' -ForegroundColor Cyan
  npm ci
}

Write-Host "K 线网站启动中：http://127.0.0.1:$Port/" -ForegroundColor Green
npm run dev -- --host 127.0.0.1 --port $Port --strictPort
