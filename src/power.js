'use strict';
/*
 * Windows integration that needs no native modules:
 *  - KeepAwake: while downloads run, a tiny PowerShell helper holds
 *    SetThreadExecutionState(ES_SYSTEM_REQUIRED) so Windows doesn't go to
 *    sleep on idle (the same thing media players do). Closing the lid or
 *    choosing Sleep yourself still works.
 *  - Startup shortcut so Bolt starts in the background when you sign in.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const log = require('./log');

const AWAKE_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -Namespace BoltDM -Name Power -MemberDefinition \'[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);\'',
  // ES_CONTINUOUS | ES_SYSTEM_REQUIRED: keep the system on, the screen may still turn off
  '$prev = [BoltDM.Power]::SetThreadExecutionState([uint32]2147483649)',
  'if ($prev -eq 0) { [Console]::Out.WriteLine("failed"); exit 1 }',
  '[Console]::Out.WriteLine("awake")',
  'while ($true) { Start-Sleep -Seconds 15; if (-not (Get-Process -Id $env:BOLT_PID -ErrorAction SilentlyContinue)) { exit 0 } }',
].join('\n');

class KeepAwake {
  constructor() { this.proc = null; this.active = false; this.failures = 0; this.retryAt = 0; }

  set(on) {
    if (process.platform !== 'win32') return;
    if (on && !this.proc && Date.now() >= this.retryAt) this.startHelper();
    else if (!on && this.proc) this.stopHelper();
  }

  /** The helper died without being asked to (blocked PowerShell, antivirus...). Don't respawn it every second. */
  helperFailed(why) {
    this.failures++;
    if (this.failures >= 2) {
      this.retryAt = Date.now() + 10 * 60 * 1000;
      if (this.failures === 2) log.warn(`could not keep the PC awake (${why}); trying again in 10 minutes`);
    } else {
      this.retryAt = Date.now() + 15000;
    }
  }

  startHelper() {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, BOLT_PID: String(process.pid) },
    });
    this.proc = p;
    let err = '';
    p.stdout.on('data', (d) => {
      const s = String(d).trim();
      if (s === 'awake') { this.active = true; this.failures = 0; log.info('keeping the PC awake while downloads run'); }
    });
    p.stderr.on('data', (d) => { err = (err + d).slice(-300); });
    p.on('error', (e) => { if (this.proc === p) { this.proc = null; this.helperFailed(e.message); } });
    p.on('exit', (code) => {
      if (this.proc !== p) return;   // we stopped it ourselves
      this.proc = null;
      this.active = false;
      this.helperFailed(err.trim() || `helper exited with code ${code}`);
    });
    p.stdin.end(AWAKE_SCRIPT);
  }

  stopHelper() {
    const p = this.proc;
    this.proc = null;
    if (this.active) log.info('downloads finished: the PC may sleep again');
    this.active = false;
    try { p.kill(); } catch { /* already gone */ }
  }
}

// ------------------------------------------------------------------ startup

const ROOT = path.join(__dirname, '..');
const startupDir = () => path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const startupLink = () => path.join(startupDir(), 'Bolt Download Manager.lnk');

function startWithWindows() {
  return process.platform === 'win32' && fs.existsSync(startupLink());
}

/** Create or remove the Startup-folder shortcut (runs Bolt hidden, no window). */
function setStartWithWindows(on) {
  if (process.platform !== 'win32') return Promise.resolve(false);
  if (!on) {
    try { fs.rmSync(startupLink(), { force: true }); } catch { /* ignore */ }
    log.info('start with Windows: off');
    return Promise.resolve(false);
  }
  // Paths go through environment variables, so spaces and commas in the
  // Bolt folder can't break the PowerShell command line.
  // Installed copy: <install>\Bolt.exe (tray app). Developer folder: the hidden Bolt.vbs launcher.
  const trayExe = path.join(ROOT, '..', 'Bolt.exe');
  const installed = fs.existsSync(trayExe);
  let icon = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'BoltDM', 'bolt.ico');
  if (installed) icon = trayExe;
  else try { fs.mkdirSync(path.dirname(icon), { recursive: true }); fs.copyFileSync(path.join(ROOT, 'ui', 'icon.ico'), icon); } catch { /* icon is optional */ }
  const target = installed ? trayExe : path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'wscript.exe');
  const args = installed ? '--background' : `"${path.join(ROOT, 'Bolt.vbs')}" --no-open`;
  const ps = [
    '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:BOLT_LNK)',
    '$s.TargetPath = $env:BOLT_TARGET',
    '$s.Arguments = $env:BOLT_ARGS',
    '$s.WorkingDirectory = $env:BOLT_ROOT',
    'if (Test-Path $env:BOLT_ICON) { $s.IconLocation = "$env:BOLT_ICON,0" }',
    '$s.Description = "Bolt Download Manager"',
    '$s.Save()',
  ].join('; ');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      windowsHide: true,
      env: { ...process.env, BOLT_LNK: startupLink(), BOLT_TARGET: target, BOLT_ARGS: args, BOLT_ROOT: installed ? path.dirname(trayExe) : ROOT, BOLT_ICON: icon },
    }, (err) => {
      if (err) log.warn('could not create the startup shortcut: ' + err.message);
      else log.info('start with Windows: on');
      resolve(startWithWindows());
    });
  });
}

module.exports = { KeepAwake, startWithWindows, setStartWithWindows };
