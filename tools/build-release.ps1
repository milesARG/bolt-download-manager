<#
  Builds the files to ship:
    dist\Bolt-<version>-Windows.exe      the installer (everything inside, no admin rights needed)
    dist\Bolt-<version>-portable.zip     the same files to unzip and run Bolt.exe
  Run:  powershell -ExecutionPolicy Bypass -File tools\build-release.ps1
  Needs only what Windows and this PC already have: Node.js (its node.exe is bundled)
  and the C# compiler that comes with the .NET Framework.
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$csc = Get-ChildItem "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $csc) { throw 'The C# compiler (.NET Framework 4) was not found.' }
$node = (Get-Command node -ErrorAction Stop).Source
$nodeVersion = (& $node --version).TrimStart('v')
$licenseNode = Join-Path $root 'tools\third-party\node-LICENSE.txt'
if (-not (Select-String -Path $licenseNode -Pattern 'Node.js is licensed' -Quiet)) { throw 'tools\third-party\node-LICENSE.txt is missing.' }

# Build in a temp folder: the project path has spaces and a comma, which some tools mishandle.
$work = Join-Path $env:TEMP "bolt-build-$version"
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
$stage = Join-Path $work 'Bolt'
New-Item -ItemType Directory -Force $stage | Out-Null
Write-Host "Building Bolt $version (bundling Node.js $nodeVersion)"

# ---- 1. app files: an explicit list, never "everything" ----------------------------
$include = @(
  'bin\bolt.js',
  'src\*.js',
  'ui\index.html', 'ui\app.js', 'ui\style.css', 'ui\icon.svg', 'ui\icon.ico', 'ui\icon-256.png',
  'extension\*.json', 'extension\*.js', 'extension\*.html', 'extension\*.css', 'extension\icons\*.png',
  'native-host\bolt-launcher.js',
  'package.json', 'LICENSE', 'README.md'
)
foreach ($pattern in $include) {
  $files = Get-ChildItem (Join-Path $root $pattern) -File -ErrorAction SilentlyContinue
  if (-not $files) { throw "Nothing matches $pattern" }
  foreach ($f in $files) {
    $rel = $f.FullName.Substring($root.Length + 1)
    $dest = Join-Path $stage "app\$rel"
    New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
    Copy-Item $f.FullName $dest
  }
}
# The manifest's "key" keeps the extension ID fixed, which the browser launcher relies on.
$manifest = Get-Content (Join-Path $stage 'app\extension\manifest.json') -Raw | ConvertFrom-Json
if ($manifest.version -ne $version) { throw "extension\manifest.json says $($manifest.version), package.json says $version" }

# ---- 2. bundled Node.js runtime + its license -----------------------------------
New-Item -ItemType Directory -Force (Join-Path $stage 'runtime') | Out-Null
Copy-Item $node (Join-Path $stage 'runtime\node.exe')
Copy-Item $licenseNode (Join-Path $stage 'runtime\LICENSE-node.txt')

# ---- 3. Bolt.exe (tray app + uninstaller) -------------------------------------------
$src = Join-Path $root 'launcher'
Copy-Item "$src\*.cs", "$src\app.manifest" $work
Copy-Item (Join-Path $root 'ui\icon.ico') "$work\icon.ico"
"namespace BoltDM { static class Version { public const string Text = `"$version`"; } }" | Set-Content "$work\Version.cs" -Encoding UTF8
$refs = '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Web.Extensions.dll', '/r:System.Core.dll'
Push-Location $work
try {
  & $csc.FullName /nologo /codepage:65001 /optimize+ /target:winexe /platform:anycpu /win32icon:icon.ico /win32manifest:app.manifest `
    @refs /out:"$stage\Bolt.exe" Common.cs Tray.cs Version.cs
  if ($LASTEXITCODE) { throw 'Compiling Bolt.exe failed' }

  # ---- 4. safety checks on what will ship ------------------------------------------
  $bad = Get-ChildItem $stage -Recurse -File | Where-Object { $_.Extension -in '.pem', '.crx', '.key' -or $_.Name -in 'node-path.txt', 'downloads.json', 'settings.json' -or $_.FullName -match '\\(test|tools)\\' }
  if ($bad) { throw "Refusing to ship: $($bad.FullName -join ', ')" }
  if (Get-ChildItem $stage -Recurse -File | Select-String -Pattern 'BEGIN (RSA )?PRIVATE KEY' -SimpleMatch:$false -List) { throw 'A private key ended up in the package' }

  # ---- 5. payload + installer ---------------------------------------------------------
  $payload = Join-Path $work 'payload.zip'
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::CreateFromDirectory($stage, $payload, [IO.Compression.CompressionLevel]::Optimal, $false)
  $setupName = "Bolt-$version-Windows.exe"
  & $csc.FullName /nologo /codepage:65001 /optimize+ /target:winexe /platform:anycpu /win32icon:icon.ico /win32manifest:app.manifest `
    @refs /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll /resource:"$payload,payload.zip" `
    /out:"$work\$setupName" Common.cs Setup.cs Version.cs
  if ($LASTEXITCODE) { throw 'Compiling the installer failed' }
} finally { Pop-Location }

$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null
Copy-Item "$work\$setupName" $dist -Force
$portable = Join-Path $dist "Bolt-$version-portable.zip"
Copy-Item $payload $portable -Force

Write-Host ''
foreach ($f in (Join-Path $dist $setupName), $portable) {
  $h = (Get-FileHash $f -Algorithm SHA256).Hash.ToLower()
  Write-Host ("{0}  {1:N1} MB  sha256 {2}" -f (Split-Path $f -Leaf), ((Get-Item $f).Length / 1MB), $h)
}
Write-Host "Staged files: $stage"
