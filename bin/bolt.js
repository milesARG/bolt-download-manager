#!/usr/bin/env node
'use strict';
/*
 * bolt start [--no-open]          run the download manager (opens the window)
 * bolt add <url> [more urls] [--name file] [--dir folder] [--connections n] [--ytdlp]
 * bolt list                       show downloads
 * bolt open                       open the window
 * bolt quit                       stop the background app (progress is saved)
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { Config } = require('../src/config');

const config = new Config();
const PORT = config.get('port');
const UI = `http://127.0.0.1:${PORT}/`;

function api(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method, timeout: 3000,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => {
      let s = '';
      res.on('data', (c) => { s += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(s) }); } catch { resolve({ status: res.statusCode, body: s }); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end(data);
  });
}

async function isRunning() {
  try { const r = await api('GET', '/api/ping'); return r.body && r.body.app === 'bolt'; } catch { return false; }
}

function findAppBrowser() {
  const env = process.env;
  const cands = [
    path.join(env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(env.ProgramFiles || '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(env.ProgramFiles || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(env['ProgramFiles(x86)'] || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(env.ProgramFiles || '', 'BraveSoftware/Brave-Browser/Application/brave.exe'),
  ];
  return cands.find((p) => p && fs.existsSync(p));
}

function openUi() {
  if (process.platform === 'win32') {
    const b = findAppBrowser();
    if (b) {
      spawn(b, [`--app=${UI}`, '--window-size=1180,760'], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('explorer.exe', [UI], { detached: true, stdio: 'ignore' }).unref();
    }
  } else {
    spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [UI], { detached: true, stdio: 'ignore' }).unref();
  }
}

async function ensureRunning() {
  if (await isRunning()) return;
  const child = spawn(process.execPath, [__filename, 'start', '--no-open'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await isRunning()) return;
  }
  throw new Error('Could not start Bolt');
}

const EXIT_PORT_IN_USE = 3;

/**
 * `bolt start` is a small supervisor: it runs the real app (`bolt serve`) in
 * a child process and starts it again within seconds if it ever crashes.
 * Downloads then continue from what is already on disk.
 */
async function start(open) {
  if (await isRunning()) {
    if (open) openUi();
    console.log(`Bolt is already running at ${UI}`);
    return;
  }
  const log = require('../src/log');
  let quitting = false;
  let child = null;
  const crashes = [];
  const launch = (openNow) => {
    let errTail = '';
    child = spawn(process.execPath, [__filename, 'serve', ...(openNow ? [] : ['--no-open'])], {
      stdio: ['ignore', 'inherit', 'pipe'],
      windowsHide: true,
      // more threads for disk writes when 32 connections write at once
      env: { ...process.env, UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE || '16' },
    });
    child.stderr.on('data', (d) => { process.stderr.write(d); errTail = (errTail + d).slice(-3000); });
    child.on('exit', (code, signal) => {
      if (quitting || code === 0) process.exit(0);
      if (code === EXIT_PORT_IN_USE) process.exit(1);
      const now = Date.now();
      crashes.push(now);
      while (crashes.length && now - crashes[0] > 120000) crashes.shift();
      const delay = crashes.length > 5 ? 30000 : 1500;
      log.error(`Bolt stopped unexpectedly (exit ${code != null ? code : signal}); restarting in ${delay / 1000}s.${errTail ? ' Last output: ' + errTail.trim() : ''}`);
      setTimeout(() => launch(false), delay);
    });
  };
  const stopAll = () => {
    if (quitting) return;
    quitting = true;
    // Ask the app to save and exit; only force it if it doesn't within 15s.
    api('POST', '/api/actions/quit', {}).catch(() => {});
    setTimeout(() => { try { child.kill(); } catch { /* gone */ } process.exit(0); }, 15000).unref();
  };
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, stopAll);
  launch(open);
}

/** The app itself: download manager + local server. Run by the supervisor. */
async function serve(open) {
  const log = require('../src/log');
  const { Manager } = require('../src/manager');
  const { createServer } = require('../src/server');
  const manager = new Manager(config);
  const server = createServer(manager, config, { onQuit: () => quit() });
  let quitting = false;
  const quit = async () => {
    if (quitting) return;
    quitting = true;
    log.info('Bolt is closing (progress saved)');
    server.close();
    await manager.shutdown();
    process.exit(0);
  };
  process.on('uncaughtException', (e) => {
    // Save what's on disk, then let the supervisor start a clean copy.
    log.error('crash: ' + (e && e.stack ? e.stack : e));
    try { manager.saveSync(); } catch { /* ignore */ }
    process.exit(70);
  });
  process.on('unhandledRejection', (e) => log.error('unhandled promise rejection: ' + (e && e.stack ? e.stack : e)));
  server.on('error', (e) => {
    const msg = e.code === 'EADDRINUSE' ? `Port ${PORT} is in use by another program. Change "port" in settings.json.` : e.message;
    log.error(msg);
    console.error(msg);
    process.exit(e.code === 'EADDRINUSE' ? EXIT_PORT_IN_USE : 1);
  });
  server.listen(PORT, '127.0.0.1', () => {
    log.info(`Bolt ${require('../package.json').version} running at ${UI} (pid ${process.pid})`);
    console.log(`Bolt Download Manager ${require('../package.json').version} - made by Arnav`);
    console.log(`Running at ${UI}`);
    console.log('Keep this window open (or use the hidden launcher). Ctrl+C to quit - progress is saved.');
    if (open) openUi();
  });
  manager.on('completed', (it) => console.log(`done: ${it.filename}`));
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
  process.on('SIGHUP', quit);
}

async function main() {
  const [cmd = 'start', ...rest] = process.argv.slice(2);
  const flag = (name) => { const i = rest.indexOf(name); if (i < 0) return null; const v = rest[i + 1]; rest.splice(i, 2); return v; };
  if (cmd === 'start') return start(!rest.includes('--no-open'));
  if (cmd === 'serve') return serve(!rest.includes('--no-open'));
  if (cmd === 'open') { await ensureRunning(); return openUi(); }
  if (cmd === 'add') {
    const filename = flag('--name');
    const dir = flag('--dir');
    const connections = flag('--connections');
    const type = rest.includes('--ytdlp') ? 'ytdlp' : undefined;   // video page of any site yt-dlp supports
    const urls = rest.filter((a) => !a.startsWith('--'));
    if (!urls.length) { console.error('usage: bolt add <url> [--name file] [--dir folder] [--connections n] [--ytdlp]'); process.exit(2); }
    await ensureRunning();
    const r = await api('POST', '/api/downloads', { urls, filename, dir: dir ? path.resolve(dir) : null, connections, type, source: 'cli' });
    if (r.status !== 200) { console.error(r.body.error || r.body); process.exit(1); }
    for (const it of r.body.added) console.log(`queued: ${it.url}`);
    for (const e of r.body.errors) console.error(`skipped ${e.url}: ${e.error}`);
    return;
  }
  if (cmd === 'list') {
    if (!(await isRunning())) { console.log('Bolt is not running.'); return; }
    const r = await api('GET', '/api/downloads');
    for (const it of r.body) {
      const pct = it.size ? Math.floor((it.downloaded / it.size) * 100) + '%' : '';
      console.log(`${it.status.padEnd(11)} ${pct.padStart(4)}  ${it.filename || it.url}`);
    }
    return;
  }
  if (cmd === 'quit' || cmd === 'stop') {
    if (await isRunning()) { await api('POST', '/api/actions/quit', {}).catch(() => {}); console.log('Bolt stopped.'); }
    return;
  }
  console.error('commands: start | open | add <url> | list | quit');
  process.exit(2);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
