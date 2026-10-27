<#
  Makes dist\Bolt-<version>-share.zip: the installer, the "Browser extension"
  folder for Load unpacked, and READ ME FIRST.txt. Run after build-release.ps1.
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$v = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$work = Join-Path $env:TEMP "bolt-share-$v"
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
$s = Join-Path $work "Bolt-$v"
New-Item -ItemType Directory -Force "$s\Browser extension" | Out-Null
Copy-Item (Join-Path $root "dist\Bolt-$v-Windows.exe") "$s\Install Bolt $v.exe"
Copy-Item "$env:TEMP\bolt-build-$v\Bolt\app\extension\*" "$s\Browser extension" -Recurse
@"
BOLT DOWNLOAD MANAGER $v  -  by Arnav
==========================================

1) INSTALL
   Double-click "Install Bolt $v.exe" and click Install.
   If Windows shows "Windows protected your PC", click "More info" -> "Run anyway".
   (No admin rights or Node.js needed.)

2) ADD THE BROWSER EXTENSION (Edge, Chrome or Brave)
   First move the "Browser extension" folder somewhere permanent
   (for example Documents). The browser loads it from there, so don't delete it later.
   a. Open edge://extensions  (or chrome://extensions)
   b. Turn on "Developer mode"
   c. Click "Load unpacked" and choose the "Browser extension" folder
   Updating from an older Bolt? Click the reload button on Bolt in that page.

3) CATEGORIES (optional)
   In Bolt: Settings -> Categories -> "+ Add category", e.g. Games -> D:\games.
   Then pick "Games" in the download window and the file goes straight there.

To uninstall: Settings -> Apps -> Bolt Download Manager -> Uninstall.
"@ | Set-Content "$s\READ ME FIRST.txt" -Encoding UTF8
if (Get-ChildItem $s -Recurse -Include *.pem, *.crx) { throw 'Refusing to ship: private key found' }
$zip = Join-Path $root "dist\Bolt-$v-share.zip"
Remove-Item $zip -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($work, $zip, 'Optimal', $false)
Write-Host ("{0}  {1:N1} MB" -f (Split-Path $zip -Leaf), ((Get-Item $zip).Length / 1MB))
