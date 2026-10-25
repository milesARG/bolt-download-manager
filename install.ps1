<#
  Sets Bolt up for the current Windows user (no admin needed):
    - Desktop + Start menu shortcuts
    - lets the browser extension start Bolt (native messaging, Chrome/Edge/Brave)
    - optional: start Bolt in the background when you sign in   (-Startup)
  Run:  powershell -ExecutionPolicy Bypass -File install.ps1 [-Startup]
  Undo: powershell -ExecutionPolicy Bypass -File uninstall.ps1
#>
param([switch]$Startup)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Error 'Node.js was not found. Install it from https://nodejs.org (version 20 or newer) and run this again.' }
# no inner quotes: Windows PowerShell 5.1 strips them when calling native programs
$ver = [int]((& $node -p 'parseInt(process.versions.node)'))
if ($ver -lt 20) { Write-Error "Node.js $ver is too old; Bolt needs version 20 or newer." }
Set-Content -Path (Join-Path $root 'node-path.txt') -Value $node -Encoding ASCII

# --- native messaging host (lets the extension start Bolt) -----------------
$hostDir = Join-Path $root 'native-host'
$bat = Join-Path $hostDir 'bolt-launcher.bat'
Set-Content -Path $bat -Encoding ASCII -Value "@echo off`r`n`"$node`" `"%~dp0bolt-launcher.js`" %*"
$extId = 'oljpffpdpmcipbelpjbakpgdlmepgebl'
$manifest = [ordered]@{
  name            = 'com.bolt.launcher'
  description     = 'Starts Bolt Download Manager'
  path            = $bat
  type            = 'stdio'
  allowed_origins = @("chrome-extension://$extId/")
}
$manifestPath = Join-Path $hostDir 'com.bolt.launcher.json'
# UTF-8 without BOM (Windows PowerShell's -Encoding UTF8 adds one)
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
foreach ($browser in 'Google\Chrome', 'Microsoft\Edge', 'BraveSoftware\Brave-Browser', 'Chromium') {
  $key = "HKCU:\Software\$browser\NativeMessagingHosts\com.bolt.launcher"
  New-Item -Path $key -Force | Out-Null
  Set-Item -Path $key -Value $manifestPath
}

# --- shortcuts ---------------------------------------------------------------
$shell = New-Object -ComObject WScript.Shell
# IconLocation is "path,index", so a comma in the Bolt folder path breaks it:
# keep a copy of the icon somewhere without one.
$iconDir = Join-Path $env:LOCALAPPDATA 'BoltDM'
New-Item -ItemType Directory -Force $iconDir | Out-Null
$icon = Join-Path $iconDir 'bolt.ico'
Copy-Item (Join-Path $root 'ui\icon.ico') $icon -Force
function New-Shortcut($path, $arguments) {
  $s = $shell.CreateShortcut($path)
  $s.TargetPath = "$env:WINDIR\System32\wscript.exe"
  $s.Arguments = "`"$(Join-Path $root 'Bolt.vbs')`" $arguments"
  $s.WorkingDirectory = $root
  $s.IconLocation = "$icon,0"
  $s.Description = 'Bolt Download Manager'
  $s.Save()
}
New-Shortcut (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Bolt Download Manager.lnk') ''
New-Shortcut (Join-Path ([Environment]::GetFolderPath('Programs')) 'Bolt Download Manager.lnk') ''
$startupLnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Bolt Download Manager.lnk'
if ($Startup) { New-Shortcut $startupLnk '--no-open' } elseif (Test-Path $startupLnk) { Remove-Item $startupLnk }

Write-Host ''
Write-Host 'Bolt is set up.' -ForegroundColor Green
Write-Host '  - Start it from the Desktop or Start menu shortcut "Bolt Download Manager".'
Write-Host '  - Browser extension: open chrome://extensions (or edge://extensions), turn on Developer mode,'
Write-Host "    click 'Load unpacked' and choose: $(Join-Path $root 'extension')"
if ($Startup) { Write-Host '  - Bolt will start in the background when you sign in.' }
