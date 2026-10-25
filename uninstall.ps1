# Removes what install.ps1 added. Your downloads and settings are kept
# (settings live in %APPDATA%\BoltDM — delete that folder to remove them too).
$root = $PSScriptRoot
& node (Join-Path $root 'bin\bolt.js') quit 2>$null
foreach ($browser in 'Google\Chrome', 'Microsoft\Edge', 'BraveSoftware\Brave-Browser', 'Chromium') {
  Remove-Item -Path "HKCU:\Software\$browser\NativeMessagingHosts\com.bolt.launcher" -Force -ErrorAction SilentlyContinue
}
foreach ($dir in [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Startup')) {
  Remove-Item -Path (Join-Path $dir 'Bolt Download Manager.lnk') -ErrorAction SilentlyContinue
}
Remove-Item -Path (Join-Path $env:LOCALAPPDATA 'BoltDM') -Recurse -ErrorAction SilentlyContinue
Remove-Item -Path (Join-Path $root 'native-host\bolt-launcher.bat'), (Join-Path $root 'native-host\com.bolt.launcher.json'), (Join-Path $root 'node-path.txt') -ErrorAction SilentlyContinue
Write-Host 'Bolt shortcuts and browser launcher removed.'
