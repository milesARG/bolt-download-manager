<#
  Full install cycle of dist\Bolt-<version>-Windows.exe in a sandbox:
  install -> run without Node.js on PATH -> download a file -> start from the
  browser launcher -> upgrade while running -> uninstall -> nothing left behind.
  Uses a scratch folder, its own data folder and port, a test registry branch
  and a test shortcuts folder, so the real Bolt on this PC is not touched.
    powershell -ExecutionPolicy Bypass -File tools\test-installer.ps1
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$setup = Join-Path $root "dist\Bolt-$version-Windows.exe"
$sys = (Get-Command node).Source
$box = Join-Path $env:TEMP "bolt-installer-test"
if (Test-Path $box) { Remove-Item $box -Recurse -Force }
$inst = Join-Path $box 'Programs\Bolt'
$data = Join-Path $box 'data'
$dl = Join-Path $box 'downloads'
$files = Join-Path $box 'files'
New-Item -ItemType Directory -Force $data, $dl, $files | Out-Null
$port = Get-Random -Minimum 41000 -Maximum 49000
'{"port":' + $port + ',"downloadDir":' + (ConvertTo-Json $dl) + ',"keepAwake":false}' | Set-Content (Join-Path $data 'settings.json') -Encoding ASCII
$regRoot = 'Software\BoltInstallerTest'
$env:BOLT_DATA_DIR = $data
$env:BOLT_TEST_REGROOT = $regRoot
$env:BOLT_TEST_SHORTCUT_DIR = Join-Path $box 'shortcuts'
# no Node.js on PATH: only the bundled runtime may be used
$env:PATH = ($env:PATH -split ';' | Where-Object { $_ -and $_ -notmatch 'nodejs' }) -join ';'

$fails = 0
function Check($name, $ok, $extra = '') { if ($ok) { Write-Host "  PASS  $name $extra" } else { Write-Host "  FAIL  $name $extra" -ForegroundColor Red; $script:fails++ } }
function Ping { try { (Invoke-RestMethod -TimeoutSec 2 "http://127.0.0.1:$port/api/ping").app -eq 'bolt' } catch { $false } }
function WaitFor($what, $sec, [scriptblock]$cond) { $t = [DateTime]::Now; while (-not (& $cond)) { if (([DateTime]::Now - $t).TotalSeconds -gt $sec) { return $false }; Start-Sleep -Milliseconds 250 }; $true }
function OurProcs { Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($inst, [StringComparison]::OrdinalIgnoreCase) } }

Write-Host "Installer test: $setup (port $port)"
Check 'Node.js is not on PATH for this test' (-not (Get-Command node -ErrorAction SilentlyContinue))

# ---- install
$p = Start-Process $setup -ArgumentList '/S', "/D=$inst", '/NoStart' -PassThru -Wait
Check 'silent install exit code 0' ($p.ExitCode -eq 0) "($($p.ExitCode))"
foreach ($f in 'Bolt.exe', 'runtime\node.exe', 'runtime\LICENSE-node.txt', 'app\bin\bolt.js', 'app\extension\manifest.json', 'app\LICENSE', 'app\native-host\bolt-launcher.bat') {
  Check "installed $f" (Test-Path (Join-Path $inst $f))
}
Check 'no private key or test files shipped' (-not (Get-ChildItem $inst -Recurse -File | Where-Object { $_.Extension -in '.pem', '.crx' -or $_.FullName -match '\\test\\' }))
$bat = Get-Content (Join-Path $inst 'app\native-host\bolt-launcher.bat') -Raw
Check 'launcher uses the bundled node.exe' ($bat -like "*$inst\runtime\node.exe*")
$hostJson = Get-Content (Join-Path $inst 'app\native-host\com.bolt.launcher.json') -Raw | ConvertFrom-Json
Check 'launcher manifest valid, allows the extension' ($hostJson.allowed_origins -contains 'chrome-extension://oljpffpdpmcipbelpjbakpgdlmepgebl/')
$keys = foreach ($b in 'Google\Chrome', 'Microsoft\Edge', 'BraveSoftware\Brave-Browser', 'Chromium') { (Get-Item "HKCU:\$regRoot\$b\NativeMessagingHosts\com.bolt.launcher" -ErrorAction SilentlyContinue).GetValue('') }
Check 'browser launcher registered for 4 browsers' (@($keys | Where-Object { $_ -like "$inst*" }).Count -eq 4)
$un = Get-ItemProperty "HKCU:\$regRoot\Microsoft\Windows\CurrentVersion\Uninstall\BoltDownloadManager" -ErrorAction SilentlyContinue
Check 'Apps list entry' ($un -and $un.DisplayVersion -eq $version -and $un.Publisher -eq 'Arnav' -and $un.UninstallString -like "*Bolt.exe*--uninstall*") "$($un.DisplayName) $($un.DisplayVersion)"
$sh = New-Object -ComObject WScript.Shell
$startLnk = $sh.CreateShortcut((Join-Path $env:BOLT_TEST_SHORTCUT_DIR 'Startup\Bolt Download Manager.lnk'))
Check 'start-menu, desktop and startup shortcuts' ((Test-Path (Join-Path $env:BOLT_TEST_SHORTCUT_DIR 'Programs\Bolt Download Manager.lnk')) -and (Test-Path (Join-Path $env:BOLT_TEST_SHORTCUT_DIR 'Desktop\Bolt Download Manager.lnk')) -and $startLnk.TargetPath -eq "$inst\Bolt.exe" -and $startLnk.Arguments -eq '--background')

# ---- run it (tray app, background) and download something
Start-Process (Join-Path $inst 'Bolt.exe') -ArgumentList '--background'
Check 'Bolt.exe starts the engine (bundled runtime)' (WaitFor 'ping' 20 { Ping })
Check 'engine runs from the install folder' (@(OurProcs | Where-Object { $_.Name -eq 'node.exe' }).Count -ge 2)
[IO.File]::WriteAllBytes((Join-Path $files 'sample.bin'), [byte[]](1..255 * 40000))
$server = Start-Process $sys -ArgumentList "`"$root\test\test-server.js`"", "`"$files`"", '47555' -PassThru -WindowStyle Hidden
Start-Sleep 1
$add = Invoke-RestMethod -Method Post -ContentType 'application/json' -Body '{"url":"http://127.0.0.1:47555/file/sample.bin"}' "http://127.0.0.1:$port/api/downloads"
$id = $add.added[0].id
$okDl = WaitFor 'download' 30 { (Invoke-RestMethod "http://127.0.0.1:$port/api/downloads" | Where-Object { $_.id -eq $id }).status -eq 'completed' }
$got = Join-Path $dl 'sample.bin'
Check 'download completes, file identical' ($okDl -and (Test-Path $got) -and (Get-FileHash $got).Hash -eq (Get-FileHash (Join-Path $files 'sample.bin')).Hash)

# ---- Quit from the API: the tray app must exit too
Invoke-RestMethod -Method Post -ContentType 'application/json' -Body '{}' "http://127.0.0.1:$port/api/actions/quit" | Out-Null
Check 'Quit closes the engine and the tray app' (WaitFor 'quit' 20 { -not (OurProcs) })

# ---- started by the browser extension (native messaging), still without Node on PATH
# (Chrome-style pipes; .NET's redirected pipes behave differently, so a small Node script plays the browser)
$reply = & "$inst\runtime\node.exe" "$root\tools\native-host-check.js" "$inst\app\native-host\bolt-launcher.bat"
Check 'browser launcher replies ok' ($reply -like '*\"ok\":true*') $reply
Check 'browser launcher starts Bolt.exe and the engine' ((WaitFor 'ping' 20 { Ping }) -and (OurProcs | Where-Object { $_.Name -eq 'Bolt.exe' }))

# ---- upgrade while running: Bolt is closed, files replaced, data kept
$p = Start-Process $setup -ArgumentList '/S', "/D=$inst", '/NoStart' -PassThru -Wait
Check 'upgrade over a running Bolt: exit code 0' ($p.ExitCode -eq 0)
Check 'upgrade closed the running copy' (-not (Ping) -and -not (OurProcs))
Check 'upgrade kept the download list' ((Get-Content (Join-Path $data 'downloads.json') -Raw) -like "*$id*")

# ---- uninstall
Start-Process (Join-Path $inst 'Bolt.exe') -ArgumentList '--background'
WaitFor 'ping' 20 { Ping } | Out-Null
$u = Start-Process (Join-Path $inst 'Bolt.exe') -ArgumentList '--uninstall', '--quiet' -PassThru -Wait
Check 'uninstall exit code 0' ($u.ExitCode -eq 0)
Check 'uninstall: folder removed' (WaitFor 'rd' 15 { -not (Test-Path $inst) })
Check 'uninstall: nothing running' (-not (Ping) -and -not (OurProcs))
Check 'uninstall: registry clean' (-not (Get-ChildItem "HKCU:\$regRoot" -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -in 'com.bolt.launcher', 'BoltDownloadManager' }))
Check 'uninstall: shortcuts removed' (-not (Get-ChildItem $env:BOLT_TEST_SHORTCUT_DIR -Recurse -Filter *.lnk -ErrorAction SilentlyContinue))
Check 'uninstall (quiet) kept the download list' (Test-Path (Join-Path $data 'downloads.json'))

Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
Remove-Item "HKCU:\$regRoot" -Recurse -Force -ErrorAction SilentlyContinue
if (-not $fails) { Remove-Item $box -Recurse -Force -ErrorAction SilentlyContinue }
Write-Host ''
if ($fails) { Write-Host "$fails check(s) failed" -ForegroundColor Red; exit 1 } else { Write-Host 'all installer checks passed' }
