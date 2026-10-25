'use strict';
/*
 * Bolt browser integration:
 *  - takes over browser downloads and hands them (with cookies + referrer) to Bolt,
 *    but only after Bolt has checked it can really fetch the link; otherwise
 *    the browser keeps the download, so nothing is ever lost
 *  - shows a download window to pick the folder and speed (optional)
 *  - catches one-time links from game-server panels (Pterodactyl, Pelican...)
 *    before the browser uses them up, so Bolt can download backups too
 *  - right-click menu: download link / media / all links / this page's video (yt-dlp) with Bolt
 *  - detects videos, audio and HLS streams played on a page (popup lists them)
 *  - starts Bolt through native messaging when it isn't running
 */
const DEFAULTS = { enabled: true, port: 9614, minSizeKB: 0, autoLaunch: true, skipExts: '', askEveryTime: true, catchPanelLinks: true };
const NATIVE_HOST = 'com.bolt.launcher';
const PANEL_RULE_ID = 1;
// Pterodactyl / Pelican / Jexactyl "Wings" daemon: backup and file downloads
// use a signed token that works only once.
const PANEL_LINK_RE = '^https?://[^/]+/download/(backup|file)\\?token=[^#]+$';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function settings() { return { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) }; }
const base = (s) => `http://127.0.0.1:${s.port}`;

async function ping(s, timeout = 1200) {
  try {
    const r = await fetch(`${base(s)}/api/ping`, { signal: AbortSignal.timeout(timeout) });
    const d = await r.json();
    return d.app === 'bolt';
  } catch { return false; }
}

async function ensureBolt(s) {
  if (await ping(s)) return true;
  if (!s.autoLaunch) return false;
  try {
    await chrome.runtime.sendNativeMessage(NATIVE_HOST, { cmd: 'launch' });
  } catch { return false; }   // launcher not installed
  for (let i = 0; i < 30; i++) {
    await sleep(250);
    if (await ping(s, 500)) return true;
  }
  return false;
}

async function cookieHeader(url) {
  try {
    const list = await chrome.cookies.getAll({ url });
    return list.length ? list.map((c) => `${c.name}=${c.value}`).join('; ') : null;
  } catch { return null; }
}

async function api(path, body) {
  const s = await settings();
  const r = await fetch(`${base(s)}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Bolt refused the request');
  return d;
}

async function sendToBolt(info) {
  const s = await settings();
  if (!(await ensureBolt(s))) throw new Error('not-running');
  return api('/api/downloads', { ...info, cookies: await cookieHeader(info.url), userAgent: navigator.userAgent });
}

/** Ask Bolt whether it can fetch this link itself (size, name, resumable). */
async function probeWithBolt(info) {
  try {
    return await api('/api/probe', { ...info, cookies: await cookieHeader(info.url), userAgent: navigator.userAgent });
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

let warnedAt = 0;
function notify(title, message) {
  chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title, message, priority: 0 });
}
function warnNotRunning() {
  if (Date.now() - warnedAt < 60000) return;
  warnedAt = Date.now();
  notify('Bolt is not running', 'This download stays in the browser. Start Bolt, or run install.ps1 once so the extension can start it for you.');
}

const basename = (p) => String(p || '').split(/[\\/]/).pop() || null;

// ------------------------------------------------------------ download window
// Waiting requests live in chrome.storage.session: the service worker can be
// suspended while the window is open.

const pkey = (k) => `pending:${k}`;
async function getPending(k) { return (await chrome.storage.session.get(pkey(k)))[pkey(k)] || null; }
async function setPending(p) { await chrome.storage.session.set({ [pkey(p.key)]: p }); }
async function dropPending(k) { await chrome.storage.session.remove(pkey(k)); }

async function openDialog(p) {
  p.key = p.key || Math.random().toString(36).slice(2) + Date.now().toString(36);
  p.at = Date.now();
  await setPending(p);
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(`dialog.html?k=${encodeURIComponent(p.key)}`),
    type: 'popup', width: 560, height: 640, focused: true,
  });
  p.windowId = win.id;
  await setPending(p);
}

/** Hand the browser's own download back (resume) or drop it (Bolt took it / cancelled). */
async function settleBrowserDownload(p, keepInBrowser) {
  if (p.downloadId == null) {
    if (keepInBrowser) await chrome.downloads.download({ url: p.url }).catch(() => {});
    return;
  }
  if (keepInBrowser) await chrome.downloads.resume(p.downloadId).catch(() => {});
  else {
    await chrome.downloads.cancel(p.downloadId).catch(() => {});
    await chrome.downloads.erase({ id: p.downloadId }).catch(() => {});
  }
}

async function dialogAction(msg) {
  const p = await getPending(msg.key);
  if (!p) return { ok: false, error: 'This download request has expired' };
  if (msg.action === 'browser' || msg.action === 'cancel') {
    await dropPending(p.key);
    await settleBrowserDownload(p, msg.action === 'browser');
    if (msg.action === 'browser' && p.downloadId != null) await leaveToBrowser(p.downloadId, 'You chose to download it with the browser', { quiet: true });
    return { ok: true };
  }
  // start / later
  const s = await settings();
  if (!(await ensureBolt(s))) return { ok: false, error: 'Bolt is not running. Start it and try again, or let the browser download it.' };
  const cookies = await cookieHeader(p.url);
  try {
    if (msg.continueId) {
      await api(`/api/downloads/${encodeURIComponent(msg.continueId)}/refresh`, { url: p.url, cookies, referrer: p.referrer, userAgent: navigator.userAgent });
    } else {
      await api('/api/downloads', {
        url: p.url, referrer: p.referrer, mime: p.mime, cookies, userAgent: navigator.userAgent,
        filename: msg.filename || null, dir: msg.dir || null, connections: msg.connections || 0,
        start: msg.action !== 'later', source: 'browser',
      });
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
  await dropPending(p.key);
  await settleBrowserDownload(p, false);
  return { ok: true };
}

chrome.windows.onRemoved.addListener(async (windowId) => {
  // Closing the download window with X means "cancel", like in IDM.
  const all = await chrome.storage.session.get(null);
  for (const [k, p] of Object.entries(all)) {
    if (k.startsWith('pending:') && p.windowId === windowId) {
      await dropPending(p.key);
      await settleBrowserDownload(p, false);
    }
  }
});

/**
 * Bolt takes a link only if its own test request works. If not (one-time
 * link, login wall, POST form), the browser keeps the download.
 */
async function offerToBolt(p) {
  const s = await settings();
  if (!(await ensureBolt(s))) {
    // the browser's copy was never paused, so it just carries on
    if (p.downloadId == null) await chrome.downloads.download({ url: p.url }).catch(() => {});
    warnNotRunning();
    return;
  }
  if (!p.oneTime) {
    p.probe = await probeWithBolt({ url: p.url, referrer: p.referrer, mime: p.mime, filename: p.filename });
    if (!p.probe.ok && p.downloadId != null) {
      await leaveToBrowser(p.downloadId, `Bolt can't fetch this link itself (${p.probe.error})`);
      return;
    }
  }
  if (p.downloadId != null) {
    // Only now that Bolt can take it over, hold the browser's copy. Pausing
    // earlier can break downloads a page makes itself (they can't be resumed).
    const [d] = await chrome.downloads.search({ id: p.downloadId });
    if (!d || d.state !== 'in_progress') {
      if (d && d.state === 'complete') await leaveToBrowser(p.downloadId, 'Your browser finished it before Bolt could take over');
      return;
    }
    await chrome.downloads.pause(p.downloadId).catch(() => {});
  }
  if (s.askEveryTime) return openDialog(p);
  // No window: continue a matching unfinished download, or add a new one.
  p.key = 'direct-' + Date.now().toString(36);
  await setPending(p);
  const existing = p.probe && p.probe.existing;
  const r = await dialogAction({ key: p.key, action: 'start', continueId: existing ? existing.id : null, filename: p.filename });
  if (!r.ok) {
    await settleBrowserDownload(p, true);
    if (p.downloadId != null) await leaveToBrowser(p.downloadId, `Bolt could not take this download (${r.error})`);
  }
}

// ------------------------------------------------------------ download takeover

/**
 * Files a web page builds itself: they only exist inside that page, so no
 * outside program can fetch them. Telegram Web (its own app streams them
 * through a service worker), MEGA and similar sites, and blob:/data: links.
 */
function inPageSource(url) {
  let u;
  try { u = new URL(url); } catch { return 'This link only exists inside the web page'; }
  if (!/^https?:$/.test(u.protocol)) return 'This file was made by the web page itself, so only the browser can save it';
  if (/(^|\.)web\.telegram\.org$/.test(u.hostname)) return 'Telegram files come from Telegram\'s own app inside the page, so only the browser can save them';
  return null;
}

chrome.downloads.onCreated.addListener(async (item) => {
  const s = await settings();
  if (!s.enabled) return;
  if (item.byExtensionId === chrome.runtime.id) return;   // "download with browser" from our menu
  if (item.state && item.state !== 'in_progress') return;
  const url = item.finalUrl || item.url;
  const inPage = inPageSource(url);
  if (inPage) return leaveToBrowser(item.id, inPage, { quiet: true });
  if (s.minSizeKB && item.totalBytes > 0 && item.totalBytes < s.minSizeKB * 1024) return leaveToBrowser(item.id, 'Smaller than your "only take files bigger than" setting', { quiet: true });
  const skip = s.skipExts.split(/[\s,]+/).map((e) => e.replace(/^\./, '').toLowerCase()).filter(Boolean);
  const name = basename(item.filename) || basename(new URL(url).pathname);
  const ext = (name || '').split('.').pop().toLowerCase();
  if (skip.includes(ext)) return leaveToBrowser(item.id, `You chose to leave .${ext} files to the browser`, { quiet: true });

  // The browser keeps downloading while Bolt checks the link (a second or so).
  try {
    await offerToBolt({ downloadId: item.id, url, filename: basename(item.filename), referrer: item.referrer || null, mime: item.mime || null });
  } catch (e) {
    chrome.downloads.resume(item.id).catch(() => {});
    leaveToBrowser(item.id, e.message);
  }
});

// ------------------------------------------------------------ downloads the browser keeps
// Shown in Bolt's list too, with live progress, so every download is in one place.

const TRACK = 'tracked';
let trackTimer = null;
async function tracked() { return (await chrome.storage.session.get(TRACK))[TRACK] || {}; }

async function reportBrowserDownload(id, reason) {
  const [d] = await chrome.downloads.search({ id: Number(id) });
  if (!d) return null;
  try {
    await api('/api/browser-downloads', {
      browserId: d.id, startTime: d.startTime, url: d.finalUrl || d.url, filename: d.filename,
      totalBytes: d.totalBytes, bytesReceived: d.bytesReceived, state: d.state, paused: d.paused,
      error: d.error || null, mime: d.mime || null, reason: reason || null,
    });
  } catch { /* Bolt isn't running: nothing to show it in */ }
  return d;
}

/** Let the browser do this download, show it in Bolt, and say why if that helps. */
async function leaveToBrowser(id, reason, { quiet = false } = {}) {
  const t = await tracked();
  t[id] = reason;
  await chrome.storage.session.set({ [TRACK]: t });
  if (!quiet) notify('Your browser is downloading this one', `${reason}. You can follow it in Bolt too.`);
  if (await ping(await settings(), 800)) await reportBrowserDownload(id, reason);
  startTracking();
}

function startTracking() {
  if (trackTimer) return;
  trackTimer = setInterval(async () => {
    const t = await tracked();
    const ids = Object.keys(t);
    if (!ids.length) { clearInterval(trackTimer); trackTimer = null; return; }
    for (const id of ids) {
      const d = await reportBrowserDownload(id, t[id]);
      if (!d || d.state !== 'in_progress') delete t[id];
    }
    await chrome.storage.session.set({ [TRACK]: t });
  }, 1000);
}

chrome.downloads.onChanged.addListener(async (delta) => {
  const t = await tracked();
  if (t[delta.id] !== undefined && (delta.state || delta.paused || delta.filename)) reportBrowserDownload(delta.id, t[delta.id]);
});
tracked().then((t) => { if (Object.keys(t).length) startTracking(); });   // after the service worker restarts

// ------------------------------------------------------------ one-time panel links

async function applyPanelRule() {
  const s = await settings();
  const addRules = s.enabled && s.catchPanelLinks ? [{
    id: PANEL_RULE_ID,
    priority: 1,
    action: { type: 'redirect', redirect: { regexSubstitution: `chrome-extension://${chrome.runtime.id}/caught.html#\\0` } },
    condition: { regexFilter: PANEL_LINK_RE, resourceTypes: ['main_frame', 'sub_frame'] },
  }] : [];
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [PANEL_RULE_ID], addRules });
  } catch (e) { console.warn('panel link rule:', e); }
}

/** caught.html reports a one-time link that was stopped before the browser used it. */
async function handleCaught(url) {
  if (!/^https?:/i.test(url || '')) return { ok: false };
  const s = await settings();
  if (!(await ensureBolt(s))) {
    // Let the browser download it: the token hasn't been used yet, so it still works.
    await chrome.downloads.download({ url }).catch(() => {});
    warnNotRunning();
    return { ok: true, browser: true };
  }
  await offerToBolt({ downloadId: null, url, oneTime: true, filename: null, referrer: null, mime: null });
  return { ok: true };
}

// ------------------------------------------------------------ context menus

chrome.runtime.onInstalled.addListener(() => {
  applyPanelRule();
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'bolt-link', title: 'Download link with Bolt', contexts: ['link'] });
    chrome.contextMenus.create({ id: 'bolt-media', title: 'Download this with Bolt', contexts: ['image', 'video', 'audio'] });
    chrome.contextMenus.create({ id: 'bolt-page-video', title: "Download this page's video with Bolt", contexts: ['page', 'video'] });
    chrome.contextMenus.create({ id: 'bolt-all', title: 'Download all files linked on this page with Bolt', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'bolt-browser', title: 'Download link with the browser instead', contexts: ['link'] });
  });
});
chrome.runtime.onStartup.addListener(applyPanelRule);
applyPanelRule();   // also on every service-worker start; replacing the rule is harmless

function collectLinks() {
  const re = /\.(zip|rar|7z|tar|gz|bz2|xz|iso|exe|msi|apk|dmg|pkg|deb|rpm|appimage|pdf|epub|docx?|xlsx?|pptx?|mp4|mkv|webm|avi|mov|m4v|mp3|m4a|flac|wav|ogg|opus|jpg|jpeg|png|gif|webp|torrent|bin|img)(\?|#|$)/i;
  const out = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    try {
      const u = new URL(a.href, location.href);
      if (/^https?:$/.test(u.protocol) && re.test(u.pathname)) out.add(u.href);
    } catch { /* ignore */ }
  }
  return [...out].slice(0, 300);
}

async function sendMany(urls, referrer) {
  let ok = 0;
  for (const url of urls) {
    try { await sendToBolt({ url, referrer, source: 'browser' }); ok++; } catch (e) {
      if (e.message === 'not-running') { warnNotRunning(); return ok; }
    }
  }
  return ok;
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const referrer = info.pageUrl || (tab && tab.url) || null;
  try {
    if (info.menuItemId === 'bolt-link' || info.menuItemId === 'bolt-media') {
      const url = info.menuItemId === 'bolt-link' ? info.linkUrl : info.srcUrl;
      if (!/^https?:/i.test(url || '')) {
        notify('Can\'t download this directly', 'This media is streamed. Open the Bolt toolbar button to see the streams found on this page.');
        return;
      }
      const s = await settings();
      if (!(await ensureBolt(s))) { warnNotRunning(); return; }
      if (s.askEveryTime) {
        const probe = await probeWithBolt({ url, referrer });
        await openDialog({ downloadId: null, url, referrer, probe, fromMenu: true });
      } else {
        await sendToBolt({ url, referrer, source: 'browser' });
      }
    } else if (info.menuItemId === 'bolt-page-video') {
      // YouTube & co. stream split DASH pieces; Bolt hands the page itself to yt-dlp.
      const url = (tab && tab.url) || info.pageUrl;
      if (!/^https?:/i.test(url || '')) { notify("Can't download this page", 'Only http(s) pages can be sent to Bolt.'); return; }
      await sendToBolt({ url, type: 'ytdlp', source: 'browser' });
      notify('Sent to Bolt', (tab && tab.title) || url);
    } else if (info.menuItemId === 'bolt-browser') {
      await chrome.downloads.download({ url: info.linkUrl });
    } else if (info.menuItemId === 'bolt-all' && tab) {
      const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: collectLinks });
      const urls = (res && res.result) || [];
      if (!urls.length) { notify('No files found', 'No links to downloadable files on this page.'); return; }
      const n = await sendMany(urls, referrer);
      if (n) notify('Sent to Bolt', `${n} file${n > 1 ? 's' : ''} added.`);
    }
  } catch (e) {
    if (e.message === 'not-running') warnNotRunning();
    else notify('Bolt', e.message);
  }
});

// ------------------------------------------------------------ media detection
// Stored in chrome.storage.session because the service worker gets suspended.

const key = (tabId) => `media:${tabId}`;
const cache = new Map();
const queues = new Map();
async function getMedia(tabId) {
  if (cache.has(tabId)) return cache.get(tabId);
  const v = (await chrome.storage.session.get(key(tabId)))[key(tabId)] || [];
  cache.set(tabId, v);
  return v;
}
async function setMedia(tabId, list) {
  cache.set(tabId, list);
  if (list.length) await chrome.storage.session.set({ [key(tabId)]: list });
  else await chrome.storage.session.remove(key(tabId));
  chrome.action.setBadgeText({ tabId, text: list.length ? String(list.length) : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#5b8cff' }).catch(() => {});
}

function classify(url, headers) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (/(^|\.)googlevideo\.com$/.test(u.hostname)) return null;   // YouTube DASH pieces
  const ct = (headers['content-type'] || '').toLowerCase();
  const p = u.pathname.toLowerCase();
  if (/\.(ts|m4s|aac)$/.test(p) || /mp2t|iso.segment/.test(ct)) return null;  // stream fragments
  if (/mpegurl/.test(ct) || p.endsWith('.m3u8')) return 'hls';
  if (/dash\+xml/.test(ct) || p.endsWith('.mpd')) return null;
  if (/^video\//.test(ct) || /\.(mp4|webm|mkv|mov|m4v|flv)$/.test(p)) return 'video';
  if (/^audio\//.test(ct) || /\.(mp3|m4a|flac|wav|ogg|opus)$/.test(p)) return 'audio';
  return null;
}

chrome.webRequest.onHeadersReceived.addListener((d) => {
  if (d.tabId < 0 || d.statusCode >= 400) return;
  const h = {};
  for (const x of d.responseHeaders || []) h[x.name.toLowerCase()] = x.value || '';
  const kind = classify(d.url, h);
  if (!kind) return;
  let size = null;
  const cr = /\/(\d+)\s*$/.exec(h['content-range'] || '');
  if (cr) size = Number(cr[1]);
  else if (h['content-length']) size = Number(h['content-length']);
  if (kind !== 'hls' && size != null && size < 300 * 1024) return;   // thumbnails, previews, ads
  // Updates for one tab run one after another so simultaneous hits don't overwrite each other.
  const prev = queues.get(d.tabId) || Promise.resolve();
  const next = prev.then(async () => {
    const list = await getMedia(d.tabId);
    const id = d.url.replace(/([?&])(range|rn|rbuf)=[^&]*/g, '$1');
    if (list.some((m) => m.id === id)) return;
    list.unshift({ id, url: d.url, kind, size, mime: h['content-type'] || null, at: Date.now() });
    await setMedia(d.tabId, list.slice(0, 40));
  }).catch(() => {});
  queues.set(d.tabId, next);
}, { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'object'] }, ['responseHeaders']);

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading' && info.url) setMedia(tabId, []);
});
chrome.tabs.onRemoved.addListener((tabId) => { cache.delete(tabId); queues.delete(tabId); chrome.storage.session.remove(key(tabId)); });

// ------------------------------------------------------------ popup / dialog API

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    const s = await settings();
    switch (msg.cmd) {
      case 'status': return { running: await ping(s), settings: s };
      case 'launch': return { running: await ensureBolt({ ...s, autoLaunch: true }) };
      case 'media': return { items: await getMedia(msg.tabId) };
      case 'send':
        try { await sendToBolt({ url: msg.url, filename: msg.filename || null, referrer: msg.referrer || null, type: msg.type || (msg.kind === 'hls' ? 'hls' : undefined), source: 'browser' }); return { ok: true }; } catch (e) { return { ok: false, error: e.message === 'not-running' ? 'Bolt is not running' : e.message }; }
      case 'pending': return { pending: await getPending(msg.key) };
      case 'dialog': return dialogAction(msg);
      case 'pick-folder':
        try { return await api('/api/actions/pick-folder', { initial: msg.initial }); } catch (e) { return { path: null, error: e.message }; }
      case 'disk-free':
        try { return await api('/api/actions/disk-free', { dir: msg.dir }); } catch { return { free: null }; }
      case 'caught': return handleCaught(msg.url);
      case 'save-settings':
        await chrome.storage.local.set(msg.settings);
        await applyPanelRule();
        return { ok: true };
      default: return { error: 'unknown' };
    }
  })().then(reply, (e) => reply({ ok: false, error: e.message }));
  return true;
});
