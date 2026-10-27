'use strict';
// Runs extension/background.js against a fake `chrome` API, with a real Bolt
// and a local file server, to check the browser takeover logic end to end
// without a browser.   node test/extension-logic.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bolt-ext-'));
process.env.BOLT_DATA_DIR = path.join(ROOT, 'data');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'out');
fs.mkdirSync(SRC, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(SRC, 'backup.tar.gz'), crypto.randomBytes(6 << 20));

const { startServer } = require('./test-server');
const { Config } = require('../src/config');
const { Manager } = require('../src/manager');
const { createServer } = require('../src/server');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!ok) fails++; };

(async () => {
  const files = await startServer(SRC);
  const port = 30000 + Math.floor(Math.random() * 20000);
  const config = new Config();
  config.update({ port, downloadDir: OUT, keepAwake: false });
  const manager = new Manager(config);
  const bolt = createServer(manager, config);
  await new Promise((r) => bolt.listen(port, '127.0.0.1', r));
  const list = () => fetch(`http://127.0.0.1:${port}/api/downloads`).then((r) => r.json());

  // ---- fake chrome ----
  const listeners = {};
  const on = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });
  const calls = [];
  const rec = (n, ret) => (...a) => { calls.push([n, ...a]); return Promise.resolve(ret); };
  const store = { enabled: true, port, minSizeKB: 0, autoLaunch: false, skipExts: 'jpg', askEveryTime: false, catchPanelLinks: true };
  const session = new Map();
  const dls = new Map();   // the browser's own download list
  const suggested = new Set();
  const cancelledBeforePrompt = new Set();
  let dnrRules = [];
  let windowSeq = 100;
  const chrome = {
    runtime: { id: 'extid', onInstalled: on('installed'), onStartup: on('startup'), onMessage: on('message'), sendNativeMessage: () => Promise.reject(new Error('no host')), getURL: (p) => `chrome-extension://extid/${p}` },
    storage: {
      local: { get: async (d) => ({ ...d, ...store }), set: async (v) => Object.assign(store, v) },
      session: {
        get: async (k) => (k == null ? Object.fromEntries(session) : session.has(k) ? { [k]: session.get(k) } : {}),
        set: async (o) => { for (const [k, v] of Object.entries(o)) session.set(k, JSON.parse(JSON.stringify(v))); },
        remove: async (k) => { session.delete(k); },
      },
    },
    downloads: {
      onDeterminingFilename: on('determining'), onChanged: on('dlChanged'), pause: rec('pause'), resume: rec('resume'), erase: rec('erase'), download: rec('download'),
      // the browser shows its own "Save as" only after suggest(): cancelling first means it never appears
      cancel: async (id) => { calls.push(['cancel']); if (!suggested.has(id)) cancelledBeforePrompt.add(id); },
      search: async ({ id }) => (dls.has(id) ? [{ ...dls.get(id) }] : []),
    },
    windows: { create: async (o) => { calls.push(['window', o.url]); return { id: ++windowSeq }; }, onRemoved: on('winRemoved') },
    contextMenus: { onClicked: on('menu'), removeAll: (cb) => cb(), create: () => {} },
    cookies: { getAll: async () => [{ name: 'sid', value: 'abc' }] },
    notifications: { create: rec('notify') },
    webRequest: { onHeadersReceived: on('headers') },
    declarativeNetRequest: { updateDynamicRules: async ({ addRules }) => { dnrRules = addRules; } },
    tabs: { onUpdated: on('tabUpdated'), onRemoved: on('tabRemoved') },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    scripting: {},
  };
  const code = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8');
  vm.runInNewContext(code, { chrome, fetch, AbortSignal, URL, navigator: { userAgent: 'TestUA' }, setTimeout, setInterval, clearInterval, console });
  const message = (msg) => new Promise((r) => listeners.message(msg, {}, r));
  // a new browser download: put it in the fake list, then fire the event
  const created = async (d) => {
    dls.set(d.id, { state: 'in_progress', bytesReceived: 0, paused: false, startTime: new Date().toISOString(), ...d });
    const async = listeners.determining(dls.get(d.id), () => suggested.add(d.id));
    if (async !== true) throw new Error('listener must answer asynchronously');
    for (let i = 0; i < 200 && !suggested.has(d.id); i++) await sleep(25);
    await sleep(400);   // let what follows (window, Bolt) finish
  };
  await sleep(50);   // let the start-up rule registration finish
  const names = () => calls.map((c) => c[0]).join();
  const pendingKey = () => [...session.keys()].find((k) => k.startsWith('pending:')).slice(8);
  const f = (q) => `${files.url}/file/backup.tar.gz?${q}`;

  // 1) no window: checked, handed to Bolt, removed from the browser
  calls.length = 0;
  await created({ id: 1, url: f('t=1'), finalUrl: f('t=1'), filename: '', referrer: 'http://ref.test/', mime: 'application/gzip', state: 'in_progress', totalBytes: -1 });
  check('download handed to Bolt after its check', names() === 'cancel,erase', names());
  check('browser\'s own "Save as" never shown (cancelled before it asks)', cancelledBeforePrompt.has(1) && suggested.has(1));
  let it = (await list()).find((i) => i.url === f('t=1'));
  check('Bolt has it, with referrer', !!it && it.referrer === 'http://ref.test/' && it.source === 'browser');

  // 2) download window: Start with a folder and Max speed
  store.askEveryTime = true;
  calls.length = 0;
  await created({ id: 2, url: f('t=2'), filename: 'backup.tar.gz', mime: 'application/gzip', state: 'in_progress', totalBytes: -1 });
  check('Bolt\'s download window opened instead of the browser\'s', names() === 'cancel,erase,window' && /dialog\.html\?k=/.test(calls[2][1]) && cancelledBeforePrompt.has(2), names());
  let k = pendingKey();
  let p = (await message({ cmd: 'pending', key: k })).pending;
  check('window gets size and file name from the check', p.probe.ok && p.probe.size === 6 << 20 && p.probe.filename === 'backup.tar.gz', JSON.stringify(p.probe).slice(0, 120));
  const myDir = path.join(OUT, 'chosen');
  let r = await message({ cmd: 'dialog', key: k, action: 'start', filename: 'my-backup.tar.gz', dir: myDir, connections: 32 });
  it = (await list()).find((i) => i.url === f('t=2'));
  check('Start: Bolt got folder, name and 32 connections', r.ok && it && it.dir === myDir && it.filename === 'my-backup.tar.gz' && it.chosenConnections === 32, JSON.stringify(it && { dir: it.dir, filename: it.filename, chosen: it.chosenConnections }));
  check('Start: browser copy already gone, no browser prompt', names() === 'cancel,erase,window' && cancelledBeforePrompt.has(2), names());

  // 3) "Use browser" gives the download back
  calls.length = 0;
  await created({ id: 3, url: f('t=3'), mime: 'application/gzip', state: 'in_progress', totalBytes: -1 });
  r = await message({ cmd: 'dialog', key: pendingKey(), action: 'browser' });
  check('"Use browser" hands it to the browser (no save prompt)', r.ok && names() === 'cancel,erase,window,download' && calls[3][1].saveAs === false, names());

  // 4) closing the window = cancel
  calls.length = 0;
  await created({ id: 4, url: f('t=4'), mime: 'application/gzip', state: 'in_progress', totalBytes: -1 });
  k = pendingKey();
  await listeners.winRemoved(windowSeq);
  check('closing the window cancels', names() === 'cancel,erase,window' && !session.has('pending:' + k), names());

  // 5) a link Bolt can't fetch (one-time link the browser already used): browser keeps it, no window
  calls.length = 0;
  const used = f('once=1&t=5');
  await fetch(used).then((x) => x.arrayBuffer());
  await created({ id: 5, url: used, mime: 'application/gzip', state: 'in_progress', totalBytes: -1 });
  check('link Bolt cannot fetch: the browser just carries on', names() === 'notify' && suggested.has(5), names());
  let b5 = (await list()).find((i) => i.type === 'browser' && i.browserId === '5');
  check('...and it shows in Bolt as a browser download', !!b5 && /can't fetch/.test(b5.note || ''), JSON.stringify(b5 && b5.note));

  // 6) Bolt not reachable
  store.port = 1;
  calls.length = 0;
  await created({ id: 6, url: f('t=6'), state: 'in_progress', totalBytes: -1 });
  check('Bolt down -> browser keeps it, untouched', !/pause|resume|cancel/.test(names()) && suggested.has(6), names());
  store.port = port;

  // 7) skip list / blob: / our own browser fallback
  calls.length = 0;
  await created({ id: 7, url: 'http://x.test/photo.jpg', filename: 'photo.jpg', state: 'in_progress' });
  await created({ id: 8, url: 'blob:http://x.test/123', state: 'in_progress' });
  await created({ id: 9, url: f('t=9'), byExtensionId: 'extid', state: 'in_progress' });
  check('skip list, blob: and own fallback left alone', calls.length === 0, names());

  // 7b) Telegram Web: never tested by Bolt (the file only exists inside the page), browser
  //     progress shows up in Bolt, then the finished file
  calls.length = 0;
  const reqsBefore = files.stats.requests;
  await created({ id: 11, url: 'https://web.telegram.org/k/d/1561790190', filename: 'C:\\Users\\me\\Downloads\\holiday.mp4', mime: 'video/mp4', totalBytes: 50e6 });
  let tg = (await list()).find((i) => i.browserId === '11');
  check('Telegram file: left to the browser at once, listed in Bolt', !!tg && names() === '' && /Telegram/.test(tg.note || '') && tg.filename === 'holiday.mp4', JSON.stringify(tg && { note: tg.note, name: tg.filename }) + ' ' + names());
  dls.get(11).bytesReceived = 20e6;
  await sleep(1300);
  dls.get(11).bytesReceived = 50e6;
  dls.get(11).state = 'complete';
  await sleep(1300);
  tg = (await list()).find((i) => i.browserId === '11');
  check('Telegram file: browser progress followed to "completed"', tg.status === 'completed' && tg.downloaded === 50e6 && tg.savePath === 'C:\\Users\\me\\Downloads\\holiday.mp4', `${tg.status} ${tg.downloaded}`);
  let refused = false;
  try { await manager.restartFromZero(tg.id); } catch { refused = true; }
  check('Bolt never tries to pause or restart a browser download', refused && files.stats.requests === reqsBefore);

  // 8) a fresh link for an unfinished download continues it
  const slow = f('rate=262144&t=8a');
  const added = manager.add({ url: slow, dir: OUT, filename: 'world-backup.tar.gz' });
  await sleep(2500);
  await manager.pause(added.id);
  const before = manager.publicItem(manager.get(added.id)).downloaded;
  calls.length = 0;
  await created({ id: 10, url: f('t=8b'), filename: 'world-backup.tar.gz', mime: 'application/gzip', state: 'in_progress', totalBytes: -1 });
  p = (await message({ cmd: 'pending', key: pendingKey() })).pending;
  check('window offers to continue the unfinished file', p.probe.existing && p.probe.existing.id === added.id, JSON.stringify(p.probe.existing || null).slice(0, 80));
  r = await message({ cmd: 'dialog', key: p.key, action: 'start', continueId: added.id });
  const g = manager.get(added.id);
  check('continued with the new link, progress kept', r.ok && g.url === f('t=8b') && before > 0 && manager.publicItem(g).downloaded >= before, `${before} bytes kept`);
  await manager.pause(added.id);

  // 9) one-time panel link caught before the browser used it
  const rule = dnrRules[0];
  const re = new RegExp(rule.condition.regexFilter);
  const samples = {
    'https://node1.host.gg:8080/download/backup?token=eyJhbGciOi.eyJzdWIi.sig': true,
    'https://wings.example.com/download/file?token=abc': true,
    'https://panel.example.com/api/client/servers/1/backups': false,
    'https://example.com/download/backup.zip': false,
  };
  check('panel link rule matches backup/file links only', Object.entries(samples).every(([u, w]) => re.test(u) === w) && rule.condition.resourceTypes.includes('main_frame'));
  const once = f('once=1&t=9');
  calls.length = 0;
  r = await message({ cmd: 'caught', url: once });
  p = (await message({ cmd: 'pending', key: pendingKey() })).pending;
  const untouched = !files.links.get(new URL(once).pathname + new URL(once).search);
  check('caught link: window opened without using the link up', r.ok && p.oneTime && untouched, names());
  r = await message({ cmd: 'dialog', key: p.key, action: 'start' });
  const oneId = (await list()).find((i) => i.url === once).id;
  let st;
  for (let i = 0; i < 100; i++) { st = manager.get(oneId).status; if (st === 'completed' || st === 'error') break; await sleep(100); }
  check('caught one-time link downloads completely', st === 'completed', st + ' ' + (manager.get(oneId).error || ''));

  // 9b) categories in the download window
  const gamesDir = path.join(OUT, 'Games folder');
  config.update({ categories: [{ name: 'Games', dir: gamesDir, exts: 'gz' }] });
  calls.length = 0;
  await created({ id: 20, url: f('t=cat'), filename: 'world.tar.gz', mime: 'application/gzip', totalBytes: -1 });
  p = (await message({ cmd: 'pending', key: pendingKey() })).pending;
  check('window gets your categories and suggests the matching one', p.probe.categories.length === 1 && p.probe.suggestedCategory === 'Games', JSON.stringify(p.probe.categories));
  r = await message({ cmd: 'dialog', key: p.key, action: 'start', category: 'Games', dir: null });
  let catIt;
  for (let i = 0; i < 100; i++) { catIt = manager.items.find((x) => x.url === f('t=cat')); if (catIt && catIt.status === 'completed') break; await sleep(100); }
  check('picking "Games" saves into the Games folder', r.ok && catIt && catIt.status === 'completed' && path.dirname(catIt.savePath) === gamesDir, catIt && catIt.savePath);
  const saved = await message({ cmd: 'save-category', name: 'Movies', dir: path.join(OUT, 'movies') });
  check('"Save folder as category" adds one', saved.categories && saved.categories.some((c) => c.name === 'Movies'));
  config.update({ categories: [] });

  // 10) media detection
  listeners.headers({ tabId: 7, statusCode: 200, url: 'https://cdn.test/v/master.m3u8', responseHeaders: [{ name: 'Content-Type', value: 'application/vnd.apple.mpegurl' }] });
  listeners.headers({ tabId: 7, statusCode: 206, url: 'https://cdn.test/clip.mp4', responseHeaders: [{ name: 'Content-Type', value: 'video/mp4' }, { name: 'Content-Range', value: 'bytes 0-1023/50000000' }] });
  listeners.headers({ tabId: 7, statusCode: 200, url: 'https://cdn.test/v/seg1.ts', responseHeaders: [{ name: 'Content-Type', value: 'video/mp2t' }] });
  await sleep(100);
  const media = await message({ cmd: 'media', tabId: 7 });
  check('media detected (stream + mp4, not fragments)', media.items.length === 2, media.items.map((m) => m.kind).join());

  await manager.shutdown();
  bolt.close();
  await files.close();
  if (!fails) fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(fails ? `\n${fails} failed` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
