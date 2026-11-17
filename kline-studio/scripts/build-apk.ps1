# Builds the Android APK (debug-signed, landscape): the phone page mobile.html + NQ 1m history split per session.
# Needs Node.js 20+. Uses Android Studio's SDK/JDK if installed, otherwise downloads portable ones
# (Microsoft OpenJDK 21 + Android command-line tools) into %LOCALAPPDATA%\kline-apk-tools. Run from kline-studio:
#   .\build-apk.cmd

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
Set-Location -LiteralPath $projectRoot
New-Item -ItemType Directory -Force -Path (Join-Path $projectRoot 'apk') | Out-Null
Start-Transcript -LiteralPath (Join-Path $projectRoot 'apk\build-log.txt') -Force | Out-Null

function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Run($exe, [string[]]$arguments) {
  & $exe @arguments
  if ($LASTEXITCODE -ne 0) { throw "$exe $($arguments -join ' ') failed with exit code $LASTEXITCODE" }
}

try {
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 20+ was not found. Install it from https://nodejs.org/ first.' }

# --- Windows proxy for downloads, npm and Gradle -------------------------------------------------
$gradleProxy = @()
$proxyUrl = $null
$internetSettings = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
if ($internetSettings.ProxyEnable -eq 1 -and $internetSettings.ProxyServer) {
  $entries = @{}
  foreach ($entry in ([string]$internetSettings.ProxyServer -split ';')) {
    if ($entry -match '^\s*([^=]+)=(.+)\s*$') { $entries[$matches[1].Trim().ToLowerInvariant()] = $matches[2].Trim() }
  }
  $target = if ($entries.ContainsKey('https')) { $entries['https'] } elseif ($entries.ContainsKey('http')) { $entries['http'] } elseif ($entries.Count -eq 0) { ([string]$internetSettings.ProxyServer).Trim() }
  if ($target) {
    $proxyUrl = if ($target -match '^[a-z][a-z0-9+.-]*://') { $target } else { "http://$target" }
    # npm is left alone: it is set up to use a domestic mirror (npmmirror) that works without the proxy.
    $uri = [Uri]$proxyUrl
    $gradleProxy = @("-Dhttp.proxyHost=$($uri.Host)", "-Dhttp.proxyPort=$($uri.Port)", "-Dhttps.proxyHost=$($uri.Host)", "-Dhttps.proxyPort=$($uri.Port)")
    Write-Host "Using the Windows proxy: $proxyUrl"
  }
}

# --- JDK 21 and Android SDK ------------------------------------------------------------------------
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'
$tools = Join-Path $env:LOCALAPPDATA 'kline-apk-tools'
New-Item -ItemType Directory -Force -Path $tools | Out-Null
function Fetch($url, $file) {
  Write-Host "Downloading $url"
  # curl.exe (built into Windows 10/11) copes with modern TLS and proxies better than Windows PowerShell 5.1.
  $curlArgs = @('-L', '--fail', '--retry', '3', '-o', $file, $url)
  if ($proxyUrl) { $curlArgs = @('--proxy', $proxyUrl) + $curlArgs }
  & "$env:SystemRoot\System32\curl.exe" @curlArgs
  if ($LASTEXITCODE -ne 0) { throw "Download failed ($LASTEXITCODE): $url" }
}

$studioJdk = @("$env:ProgramFiles\Android\Android Studio\jbr", "$env:LOCALAPPDATA\Programs\Android Studio\jbr") | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'bin\java.exe') } | Select-Object -First 1
$portableJdk = Get-ChildItem -LiteralPath $tools -Directory -Filter 'jdk-21*' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($studioJdk) { $env:JAVA_HOME = $studioJdk }
elseif ($portableJdk) { $env:JAVA_HOME = $portableJdk.FullName }
else {
  Step 'Downloading JDK 21 (first run only, ~190 MB)'
  $zip = Join-Path $tools 'jdk21.zip'
  Fetch 'https://aka.ms/download-jdk/microsoft-jdk-21-windows-x64.zip' $zip
  Expand-Archive -LiteralPath $zip -DestinationPath $tools -Force
  Remove-Item -LiteralPath $zip
  $env:JAVA_HOME = (Get-ChildItem -LiteralPath $tools -Directory -Filter 'jdk-21*' | Select-Object -First 1).FullName
}
$env:Path = "$env:JAVA_HOME\bin;$env:Path"

$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } elseif ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
if (-not (Test-Path -LiteralPath (Join-Path $sdk 'platforms\android-35'))) { $sdk = Join-Path $tools 'android-sdk' }
$env:ANDROID_HOME = $sdk
$sdkmanager = Join-Path $sdk 'cmdline-tools\latest\bin\sdkmanager.bat'
if (-not (Test-Path -LiteralPath (Join-Path $sdk 'build-tools\35.0.0'))) {
  if (-not (Test-Path -LiteralPath $sdkmanager)) {
    Step 'Downloading Android command-line tools (first run only, ~150 MB)'
    $zip = Join-Path $tools 'cmdline-tools.zip'
    Fetch 'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip' $zip
    $unpack = Join-Path $tools 'cmdline-unpack'
    if (Test-Path -LiteralPath $unpack) { Remove-Item -LiteralPath $unpack -Recurse -Force }
    Expand-Archive -LiteralPath $zip -DestinationPath $unpack -Force
    New-Item -ItemType Directory -Force -Path (Join-Path $sdk 'cmdline-tools') | Out-Null
    $latest = Join-Path $sdk 'cmdline-tools\latest'
    if (Test-Path -LiteralPath $latest) { Remove-Item -LiteralPath $latest -Recurse -Force }
    Move-Item -LiteralPath (Join-Path $unpack 'cmdline-tools') -Destination $latest
    Remove-Item -LiteralPath $unpack -Recurse -Force
    Remove-Item -LiteralPath $zip
  }
  $proxyArgs = @()
  if ($proxyUrl) { $proxyArgs = @('--proxy=http', "--proxy_host=$($uri.Host)", "--proxy_port=$($uri.Port)") }
  Step 'Accepting the Android SDK licenses and installing SDK packages (first run only)'
  (('y' + [Environment]::NewLine) * 30) | & $sdkmanager --licenses @proxyArgs | Out-Null
  & $sdkmanager 'platform-tools' 'platforms;android-35' 'build-tools;35.0.0' @proxyArgs
  if ($LASTEXITCODE -ne 0) { throw "sdkmanager failed with exit code $LASTEXITCODE" }
}
Write-Host "Android SDK: $sdk"
Write-Host "JDK:         $env:JAVA_HOME"

# --- Capacitor (wraps the built web app into an Android project) --------------------------------
if (-not (Test-Path -LiteralPath 'node_modules\.bin\vite.cmd')) { Step 'Installing project dependencies'; Run 'npm' @('ci') }
if (-not (Test-Path -LiteralPath 'node_modules\@capacitor\android')) {
  Step 'Installing Capacitor 7 (first run only)'
  Run 'npm' @('install', '--save-dev', '@capacitor/cli@7')
  Run 'npm' @('install', '@capacitor/core@7', '@capacitor/android@7')
}

Step 'Building the phone page (mobile.html: random trading day, one candle per tap)'
Run 'npx' @('vite', 'build', '--config', 'vite.mobile.config.ts')
Move-Item -LiteralPath 'dist-mobile\mobile.html' -Destination 'dist-mobile\index.html' -Force
Step 'Splitting the NQ 1m history into one file per trading session'
Run 'node' @('scripts/build-mobile-data.mjs', 'dist-mobile/days')

if (-not (Test-Path -LiteralPath 'android')) { Step 'Creating the Android project'; Run 'npx' @('cap', 'add', 'android') }
Step 'Copying the web app into the Android project'
Run 'npx' @('cap', 'sync', 'android')

# Local SDK path, enough memory for Gradle to pack ~150 MB of data, and a large WebView heap for the big JSON files.
Set-Content -LiteralPath 'android\local.properties' -Value ('sdk.dir=' + ($sdk -replace '\\', '\\' -replace ':', '\:')) -Encoding ASCII
$gradleProps = 'android\gradle.properties'
$props = Get-Content -LiteralPath $gradleProps -Raw
if ($props -notmatch 'org\.gradle\.jvmargs=-Xmx4g') {
  $props = ($props -replace '(?m)^org\.gradle\.jvmargs=.*$', '').TrimEnd() + "`r`norg.gradle.jvmargs=-Xmx4g -Dfile.encoding=UTF-8`r`n"
  Set-Content -LiteralPath $gradleProps -Value $props -Encoding ASCII
}
$manifest = 'android\app\src\main\AndroidManifest.xml'
$xml = Get-Content -LiteralPath $manifest -Raw
$newXml = $xml
if ($newXml -notmatch 'largeHeap') { $newXml = $newXml -replace '<application', '<application android:largeHeap="true"' }
# Landscape only (either way up).
if ($newXml -notmatch 'screenOrientation') { $newXml = $newXml -replace '<activity', '<activity android:screenOrientation="sensorLandscape"' }
if ($newXml -ne $xml) { [IO.File]::WriteAllText((Resolve-Path $manifest), $newXml, (New-Object Text.UTF8Encoding $false)) }
# Full screen: no status bar, and draw into the camera cut-out area.
$styles = 'android\app\src\main\res\values\styles.xml'
$css = Get-Content -LiteralPath $styles -Raw
if ($css -notmatch 'windowFullscreen') {
  $css = $css -replace '(<style name="AppTheme\.NoActionBar"[^>]*>)', '$1<item name="android:windowFullscreen">true</item><item name="android:windowLayoutInDisplayCutoutMode">shortEdges</item>'
  [IO.File]::WriteAllText((Resolve-Path $styles), $css, (New-Object Text.UTF8Encoding $false))
}

Step 'Building the APK with Gradle (the first run downloads a few hundred MB)'
Push-Location 'android'
try { Run '.\gradlew.bat' (@('assembleDebug', '--no-daemon') + $gradleProxy) } finally { Pop-Location }

$apkDir = Join-Path $projectRoot 'apk'
$stamp = Get-Date -Format 'yyyyMMdd-HHmm'
$out = Join-Path $apkDir "kline-studio-$stamp.apk"
Copy-Item -LiteralPath 'android\app\build\outputs\apk\debug\app-debug.apk' -Destination $out
$size = [math]::Round((Get-Item -LiteralPath $out).Length / 1MB, 1)
Write-Host "`nDONE: $out ($size MB)" -ForegroundColor Green
Write-Host 'Copy it to the phone and open it to install (allow "install unknown apps" for the file manager).'
} catch {
  Write-Host "`nFAILED: $_" -ForegroundColor Red
  throw
} finally {
  Stop-Transcript | Out-Null
}
