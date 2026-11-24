param([Parameter(Mandatory = $true)][string]$LogPath)

$ErrorActionPreference = 'Continue'
for ($attempt = 1; $attempt -le 2; $attempt++) {
  & npm.cmd ci --include=dev --prefer-offline --no-audit --no-fund --fetch-retries=1 --fetch-timeout=30000 *> $LogPath
  $installExit = $LASTEXITCODE
  if ($installExit -eq 0) { exit 0 }
  $details = Get-Content -LiteralPath $LogPath -Raw -ErrorAction SilentlyContinue
  $permanent = $details -match 'EINTEGRITY|ERESOLVE|EUSAGE|CERT_HAS_EXPIRED|SELF_SIGNED_CERT|UNABLE_TO_VERIFY|unable to verify|certificate.*(expired|invalid)|npm (error|ERR!).*code (1|127)'
  $transient = $details -match 'ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|socket hang up|network|Exit handler never called'
  if ($attempt -eq 2 -or $permanent -or -not $transient) {
    Write-Error "Dependency installation failed (exit $installExit); see $LogPath."
    exit $installExit
  }
  Write-Host 'Dependency download interrupted; retrying once using the cache...'
  Start-Sleep -Seconds 1
}
