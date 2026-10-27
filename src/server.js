'use strict';
/*
 * Local control server: REST API + live events for the UI and the browser
 * extension. Listens on 127.0.0.1 only. Requests are accepted only when the
 * Host header is ours (blocks DNS rebinding) and the Origin, if any, is our
 * own UI or a browser extension (blocks random websites from driving it).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { probe } = require('./download');
const { startWithWindows, setStartWithWindows } = require('./power');
const log = require('./log');

const UI_DIR = path.join(__dirname, '..', 'ui');
const VERSION = require('../package.json').version;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

function openPath(p, select = false) {
  if (process.platform === 'win32') {
    const arg = select ? `/select,"${p}"` : `"${p}"`;
    spawn('explorer.exe', [arg], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore' }).unref();
  } else {
    const target = select ? path.dirname(p) : p;
    spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
  }
}

// The modern Explorer-style folder picker (IFileOpenDialog), not the small old
// tree dialog. It opens over an always-on-top owner window so it can't end
// up behind other apps (Bolt runs in the background, and Windows normally
// keeps background programs from taking the front).
const PICKER_PS = String.raw`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
[ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialogCom {}
[ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IFileDialog {
  [PreserveSig] int Show(IntPtr parent);
  void SetFileTypes(uint c, IntPtr f); void SetFileTypeIndex(uint i); void GetFileTypeIndex(out uint i);
  void Advise(IntPtr p, out uint c); void Unadvise(uint c);
  void SetOptions(uint fos); void GetOptions(out uint fos);
  void SetDefaultFolder(IShellItem si); void SetFolder(IShellItem si);
  void GetFolder(out IShellItem si); void GetCurrentSelection(out IShellItem si);
  void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string n); void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string n);
  void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string t); void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string t);
  void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string l); void GetResult(out IShellItem si);
}
[ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IShellItem {
  void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv); void GetParent(out IShellItem si);
  void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name);
}
public static class BoltPicker {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, ref Guid riid, out IShellItem item);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public static string Pick(string initial, IntPtr owner) {
    var d = (IFileDialog)new FileOpenDialogCom();
    d.SetOptions(0x20 | 0x40 | 0x800);   // pick folders, file system only, must exist
    d.SetTitle("Choose where Bolt saves downloads");
    d.SetOkButtonLabel("Use this folder");
    if (!string.IsNullOrEmpty(initial) && System.IO.Directory.Exists(initial)) {
      try { var g = typeof(IShellItem).GUID; IShellItem si; SHCreateItemFromParsingName(initial, IntPtr.Zero, ref g, out si); d.SetFolder(si); } catch { }
    }
    if (d.Show(owner) != 0) return null;
    IShellItem r; d.GetResult(out r); string p; r.GetDisplayName(0x80058000, out p); return p;
  }
}
'@
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true; $owner.ShowInTaskbar = $false; $owner.Opacity = 0
$owner.StartPosition = 'CenterScreen'; $owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Show(); $owner.Activate(); [BoltPicker]::SetForegroundWindow($owner.Handle) | Out-Null
$path = [BoltPicker]::Pick($env:BOLT_INITIAL, $owner.Handle)
$owner.Close()
if ($path) { [Console]::Out.Write($path) }
`;

function pickFolder(initial) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    const script = path.join(require('os').tmpdir(), 'bolt-pick-folder.ps1');
    try { fs.writeFileSync(script, '﻿' + PICKER_PS); } catch { return resolve(null); }
    const p = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script], { env: { ...process.env, BOLT_INITIAL: initial || '' }, windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('exit', () => resolve(out.trim() || null));
    p.on('error', () => resolve(null));
  });
}

function createServer(manager, config, { onQuit } = {}) {
  const port = config.get('port');
  const okHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const okOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const clients = new Set();
  const EXT_DIR = path.join(__dirname, '..', 'extension');
  const settings = () => ({ ...config.all(), startWithWindows: startWithWindows(), logFile: log.LOG_FILE, extensionDir: EXT_DIR });
  const noteExtension = (req) => {
    if (config.get('extensionSeen') || !/^(chrome|moz)-extension:\/\//.test(req.headers.origin || '')) return;
    config.update({ extensionSeen: true });
    log.info('the browser extension connected for the first time');
    broadcast('settings', settings());
  };

  const allowed = (req) => {
    if (!okHosts.has(String(req.headers.host || '').toLowerCase())) return false;
    const o = req.headers.origin;
    if (!o) return true;   // non-browser clients (CLI); "null" origins are rejected below
    return okOrigins.has(o) || /^(chrome|moz|ms-browser|safari-web)-extension:\/\//.test(o);
  };

  const send = (res, code, body) => {
    const data = JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(data);
  };

  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 4 << 20) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });

  const broadcast = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(msg);
  };
  manager.on('item', (it) => broadcast('item', it));
  manager.on('removed', (id) => broadcast('removed', { id }));
  manager.on('stats', (s) => broadcast('stats', s));
  manager.on('completed', (it) => broadcast('completed', it));

  const serveStatic = (req, res, pathname) => {
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = path.normalize(path.join(UI_DIR, rel));
    if (!file.startsWith(UI_DIR + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
      });
      res.end(data);
    });
  };

  const server = http.createServer(async (req, res) => {
    if (!allowed(req)) { res.writeHead(403); return res.end('Forbidden'); }
    noteExtension(req);
    const u = new URL(req.url, `http://${req.headers.host}`);
    const p = u.pathname;

    if (req.method === 'GET' && !p.startsWith('/api/')) return serveStatic(req, res, p);
    if (req.method === 'OPTIONS') { res.writeHead(403); return res.end(); }
    if (req.method === 'POST' && !/application\/json/i.test(req.headers['content-type'] || '')) {
      return send(res, 415, { error: 'Content-Type must be application/json' });
    }

    try {
      if (req.method === 'GET') {
        if (p === '/api/ping') return send(res, 200, { app: 'bolt', version: VERSION, pid: process.pid });
        if (p === '/api/downloads') return send(res, 200, manager.list());
        if (p === '/api/settings') return send(res, 200, settings());
        if (p === '/api/events') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
          res.write(`event: init\ndata: ${JSON.stringify({ items: manager.list(), settings: settings(), version: VERSION })}\n\n`);
          clients.add(res);
          const ka = setInterval(() => res.write(': ka\n\n'), 20000);
          req.on('close', () => { clearInterval(ka); clients.delete(res); });
          return;
        }
        return send(res, 404, { error: 'Not found' });
      }

      if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
      const body = await readBody(req);

      if (p === '/api/browser-downloads') {
        // progress of a download the browser handles itself, so it shows in Bolt's list too
        if (body.browserId == null) return send(res, 400, { error: 'browserId missing' });
        return send(res, 200, manager.upsertBrowser(body));
      }

      if (p === '/api/probe') {
        // Can Bolt fetch this link itself? The extension asks before taking a
        // download away from the browser, so nothing is lost if it can't.
        let parsed;
        try { parsed = new URL(String(body.url || '')); } catch { return send(res, 200, { ok: false, error: 'Invalid link' }); }
        if (!/^https?:$/.test(parsed.protocol)) return send(res, 200, { ok: false, error: 'Only http(s) links can be downloaded' });
        const info = await probe(body, config);
        if (!info.ok) log.warn(`probe ${log.safeUrl(body.url)}: ${info.error} - leaving it to the browser`);
        const existing = info.ok ? manager.findResumable(info.filename, info.size) : null;
        const settingsNow = config.all();
        return send(res, 200, {
          ...info,
          downloadDir: settingsNow.downloadDir,
          defaultConnections: settingsNow.connections,
          existing: existing ? manager.publicItem(existing) : null,
        });
      }

      if (p === '/api/downloads') {
        const urls = Array.isArray(body.urls) ? body.urls : [body.url];
        const added = []; const errors = [];
        for (const url of urls.filter(Boolean)) {
          try { added.push(manager.add({ ...body, url, filename: urls.length > 1 ? null : body.filename })); } catch (e) { errors.push({ url, error: e.message }); }
        }
        if (!added.length) return send(res, 400, { error: errors[0] ? errors[0].error : 'No URL given', errors });
        return send(res, 200, { added, errors });
      }

      const m = /^\/api\/downloads\/([\w-]+)\/([a-z-]+)$/.exec(p);
      if (m) {
        const [, id, action] = m;
        const it = manager.get(id);
        if (!it) return send(res, 404, { error: 'Not found' });
        switch (action) {
          case 'pause': return send(res, 200, await manager.pause(id));
          case 'resume': return send(res, 200, manager.resume(id, !!body.now));
          case 'retry': return send(res, 200, manager.resume(id, true));
          case 'refresh': return send(res, 200, await manager.refreshUrl(id, String(body.url || ''), body));
          case 'restart': return send(res, 200, await manager.restartFromZero(id));
          case 'limit': return send(res, 200, manager.setItemLimit(id, body.bytesPerSecond));
          case 'remove': await manager.remove(id, !!body.deleteFile); return send(res, 200, { ok: true });
          case 'open':
          case 'folder': {
            // Only paths of known downloads can be opened — never a path from the request.
            const target = it.status === 'completed' ? it.savePath : (it.savePath ? it.savePath + ({ hls: '.bolt-hls', ytdlp: '.bolt-ytdlp' }[it.type] || '.bolt') : null);
            if (!target || !fs.existsSync(target)) {
              if (action === 'folder') { const dir = it.savePath ? path.dirname(it.savePath) : config.get('downloadDir'); openPath(dir); return send(res, 200, { ok: true }); }
              return send(res, 409, { error: 'File is not on disk' });
            }
            if (action === 'open' && it.status !== 'completed') return send(res, 409, { error: 'Download is not finished yet' });
            openPath(target, action === 'folder');
            return send(res, 200, { ok: true });
          }
          default: return send(res, 404, { error: 'Unknown action' });
        }
      }

      if (p === '/api/actions/pause-all') { await manager.pauseAll(); return send(res, 200, { ok: true }); }
      if (p === '/api/actions/resume-all') { manager.resumeAll(); return send(res, 200, { ok: true }); }
      if (p === '/api/actions/clear-completed') { manager.clearCompleted(); return send(res, 200, { ok: true }); }
      if (p === '/api/actions/open-downloads') { openPath(config.get('downloadDir')); return send(res, 200, { ok: true }); }
      if (p === '/api/actions/quit') { send(res, 200, { ok: true }); if (onQuit) setTimeout(onQuit, 50); return; }
      if (p === '/api/actions/pick-folder') return send(res, 200, { path: await pickFolder(body.initial || config.get('downloadDir')) });
      if (p === '/api/actions/disk-free') {
        // nearest existing folder, so a not-yet-created target still answers
        let dir = path.resolve(String(body.dir || config.get('downloadDir')));
        while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
        try { const s = await fs.promises.statfs(dir); return send(res, 200, { free: s.bavail * s.bsize }); } catch { return send(res, 200, { free: null }); }
      }
      if (p === '/api/actions/open-extension-folder') { openPath(EXT_DIR); return send(res, 200, { ok: true, path: EXT_DIR }); }
      if (p === '/api/actions/open-log') { openPath(log.LOG_FILE); return send(res, 200, { ok: true }); }
      if (p === '/api/settings') {
        config.update(body);
        if (typeof body.startWithWindows === 'boolean' && body.startWithWindows !== startWithWindows()) {
          await setStartWithWindows(body.startWithWindows);
        }
        manager.applySettings();
        const s = settings();
        broadcast('settings', s);
        return send(res, 200, s);
      }
      return send(res, 404, { error: 'Not found' });
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  });

  server.keepAliveTimeout = 30000;
  return server;
}

module.exports = { createServer, VERSION };
