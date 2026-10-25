'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { HttpDownload } = require('./download');
const { HlsDownload } = require('./hls');
const { YtdlpDownload, isSitePage } = require('./ytdlp');
const { Throttle } = require('./throttle');
const { DATA_DIR } = require('./config');
const { KeepAwake } = require('./power');
const util = require('./util');
const log = require('./log');

const ACTIVE = new Set(['connecting', 'downloading', 'retrying', 'finishing']);

// Fields the browser/UI never needs to see (cookies etc.).
const PRIVATE = new Set(['cookies', 'headers', 'segments', 'userAgent', 'hls', 'ytdlp', 'ytdlpPid']);

class Manager extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.file = path.join(DATA_DIR, 'downloads.json');
    this.items = util.readJsonWithBackup(this.file, [], (f, aside) => log.error(`${path.basename(f)} was damaged (kept as ${path.basename(aside)}); using the backup`), [this.file + '.safe']);
    this.tasks = new Map();
    this.ctx = {
      config,
      throttle: new Throttle(config.get('speedLimit')),
      hosts: new Map(),
      reservePath: (dir, name) => this.reservePath(dir, name),
      saveNow: () => this.save(true),
      // unwritten data of all downloads together, so they share one memory budget
      memUsed: () => { let n = 0; for (const t of this.tasks.values()) if (t.memUsed) n += t.memUsed(); return n; },
      // 96 MB per running download (so adding downloads never squeezes the others), at most 1 GB
      memBudget: () => { let n = 0; for (const t of this.tasks.values()) if (t.memUsed) n++; return Math.min(1024, 96 * Math.max(1, n)) * 1048576; },
      resumeDisk: () => { for (const t of this.tasks.values()) if (t.resumeDiskPaused) t.resumeDiskPaused(); },
    };
    this.rewindAfterReboot();
    this.browserSpeed = new Map();
    for (const it of this.items) {
      if (it.type === 'browser') {
        // the browser kept going (or not) while Bolt was closed; the extension reports again
        if (ACTIVE.has(it.status)) Object.assign(it, { status: 'error', error: 'Bolt was closed while your browser downloaded this. Check the browser\'s downloads page.' });
        continue;
      }
      // Anything that was running when the app closed or crashed continues.
      if (ACTIVE.has(it.status)) {
        log.item(it, `was ${it.status} when Bolt last stopped - continuing`);
        it.status = 'queued';
      }
      if (it.type === 'http' && it.status !== 'completed' && it.savePath && !fs.existsSync(it.savePath + '.bolt')) this.checkMissingPart(it);
    }
    this.dirty = true;   // save the cleaned-up state once
    this.saveChain = Promise.resolve();
    this.keepAwake = new KeepAwake();
    this.saveTimer = setInterval(() => { this.save(); if (++this.saveTicks % 10 === 0) this.safeSave(); }, 1000);
    this.saveTicks = 0;
    this.schedTimer = setInterval(() => { this.schedule(); this.updateKeepAwake(); }, 1000);
    this.statsTimer = setInterval(() => this.emitStats(), 500);
    this.schedule();
  }

  /**
   * The list was last saved before this boot of Windows: Bolt was still running when the
   * PC went down, maybe by a power cut, and writes still in Windows' cache may be lost.
   * Continue each piece from its last flushed position (seg.sync) instead, so no byte that
   * may not have reached the disk is ever trusted. Costs a few seconds of re-download.
   */
  rewindAfterReboot() {
    let savedAt;
    try { savedAt = fs.statSync(this.file).mtimeMs; } catch { return; }
    const bootAt = Number(process.env.BOLT_BOOT_TIME) || Date.now() - os.uptime() * 1000;
    if (savedAt >= bootAt) return;
    for (const it of this.items) {
      if (it.type !== 'http' || it.status === 'completed') continue;
      let back = 0;
      for (const s of it.segments || []) {
        if (s.sync != null && s.pos > s.sync) { back += s.pos - s.sync; s.pos = s.sync; }
      }
      if (back) log.item(it, `the PC restarted while downloading: continuing from the last flushed position (${(back / 1048576).toFixed(1)} MB to fetch again)`);
    }
  }

  /** The partial file of an unfinished download isn't where it should be. Work out why before touching anything. */
  checkMissingPart(it) {
    // Bolt stopped between renaming the finished file and saving that: it is done.
    for (const p of [it.finalPath, it.savePath]) {
      let st;
      try { st = p && fs.statSync(p); } catch { continue; }
      if (st && st.isFile() && it.size != null && st.size === it.size && st.mtimeMs >= it.createdAt - 2000) {
        log.item(it, `found the finished file ${p} (Bolt stopped while completing it) - marked as finished`);
        Object.assign(it, { savePath: p, filename: path.basename(p), finalPath: null, status: 'completed', downloaded: it.size, completedAt: st.mtimeMs, error: null, errorKind: null });
        return;
      }
    }
    // Drive unplugged or network share offline: the data may well still be there. Keep the
    // progress; the download waits for the folder to come back instead of starting over.
    if (!fs.existsSync(path.dirname(it.savePath))) {
      log.item(it, `download folder ${path.dirname(it.savePath)} is not available - progress kept until it is back`, 'WARN');
      return;
    }
    // Don't show progress that isn't on disk any more (partial file deleted or moved).
    if ((it.segments || []).some((s) => s.pos > s.start)) {
      log.item(it, 'partial file is missing on disk - its progress is reset', 'WARN');
      it.segments = [];
      it.note = it.note || 'The partial file was missing on disk, so this download will start from zero';
      it.downloaded = 0;
    }
  }

  updateKeepAwake() {
    // a download waiting for its drive or for disk space can wait for days: no reason to stay awake
    // (the browser keeps the PC awake for its own downloads)
    const busy = this.items.some((i) => i.type !== 'browser' && ((ACTIVE.has(i.status) && !i.waitReason) || i.status === 'queued'));
    this.keepAwake.set(busy && this.config.get('keepAwake'));
  }

  // ------------------------------------------------------------ persistence

  /**
   * Save the list (previous version kept as .bak). Writes run one at a time, in order, each
   * with the newest state, and never block the app. They don't wait for the disk to flush:
   * on a hard disk busy with a fast download a flush can take many seconds, and the saved
   * progress would fall behind (measured: up to 1 GB to fetch again after a crash). Windows
   * keeps these writes through an app crash; for power cuts there is safeSave().
   * Returns a promise for when this state is written.
   */
  save(force = false) {
    let dirty = this.dirty;
    for (const t of this.tasks.values()) if (t.dirty) { dirty = true; t.dirty = false; }
    if (!dirty && !force) return this.saveChain;
    this.dirty = false;
    if (this.saveQueued) return this.saveChain;   // the write waiting to start takes the newest state anyway
    this.saveQueued = true;
    this.saveChain = this.saveChain.then(async () => {
      this.saveQueued = false;
      try {
        await util.writeTextAtomic(this.file, JSON.stringify(this.items, null, 1), { backup: true, sync: false });
        this.saveWarned = false;
      } catch (e) {
        if (!this.saveWarned) log.error('saving downloads.json failed: ' + e.message);
        this.saveWarned = true;
        this.dirty = true;   // try again next second
      }
    });
    return this.saveChain;
  }

  /**
   * Every 10 s a copy flushed all the way to the disk (downloads.json.safe), in its own
   * queue so a slow flush never holds up the regular saves. After a power cut that left
   * downloads.json and its .bak damaged, the list comes back from this copy.
   */
  safeSave() {
    if (this.safeSaving) return this.safeSaving;
    const text = JSON.stringify(this.items, null, 1);
    this.safeSaving = util.writeTextAtomic(this.file + '.safe', text, { sync: true })
      .catch((e) => log.warn('saving downloads.json.safe failed: ' + e.message))
      .finally(() => { this.safeSaving = null; });
    return this.safeSaving;
  }

  /** Last-moment save when Bolt is about to exit after a crash. */
  saveSync() {
    util.writeJsonAtomic(this.file, this.items, { backup: true, tmp: this.file + '.tmp-exit' });
  }

  reservePath(dir, name) {
    const taken = new Set();
    for (const it of this.items) if (it.savePath && it.status !== 'completed') taken.add(it.savePath.toLowerCase());
    return util.uniquePath(dir, name, taken);
  }

  // ------------------------------------------------------------ queries

  get(id) { return this.items.find((i) => i.id === id); }

  publicItem(it) {
    const out = {};
    for (const [k, v] of Object.entries(it)) if (!PRIVATE.has(k)) out[k] = v;
    // `connections` below becomes the live count; keep the chosen speed visible too
    out.chosenConnections = it.connections || 0;
    const t = this.tasks.get(it.id);
    if (t) Object.assign(out, t.stats());
    else if (it.type === 'browser') {
      out.speed = it.status === 'downloading' ? this.browserSpeed.get(it.id) || 0 : 0;
      out.connections = 0;
    } else {
      out.speed = 0;
      out.connections = 0;
      if (it.status !== 'completed') {
        let n = 0;
        if (it.type === 'hls' || it.type === 'ytdlp') n = it.downloaded || 0;
        else for (const s of it.segments || []) n += Math.max(0, s.pos - s.start);
        out.downloaded = n;
      }
    }
    return out;
  }

  list() { return this.items.map((i) => this.publicItem(i)); }

  // ------------------------------------------------------------ actions

  add(opts) {
    const url = String(opts.url || '').trim();
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('Invalid URL'); }
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('Only http(s) links can be downloaded');

    // The browser extension can fire twice for the same click.
    const dup = this.items.find((i) => i.url === url && Date.now() - i.createdAt < 3000);
    if (dup) return this.publicItem(dup);

    const isHls = opts.type === 'hls' || /\.m3u8(\?|$)/i.test(parsed.pathname) || /mpegurl/i.test(opts.mime || '');
    // Video pages of DASH sites go to yt-dlp; a real file response (it has a mime) never does.
    const isYtdlp = !isHls && (opts.type === 'ytdlp' || (!opts.type && !opts.mime && isSitePage(parsed)));
    let filename = opts.filename ? util.sanitizeFilename(path.basename(String(opts.filename))) : null;
    if (isHls && filename && /\.m3u8$/i.test(filename)) filename = filename.replace(/\.m3u8$/i, '.mp4');
    const item = {
      id: util.newId(),
      type: isHls ? 'hls' : isYtdlp ? 'ytdlp' : 'http',
      url,
      referrer: opts.referrer || null,
      cookies: opts.cookies || null,
      userAgent: opts.userAgent || null,
      headers: opts.headers && typeof opts.headers === 'object' ? opts.headers : null,
      filename,
      dir: opts.dir || null,
      savePath: null,
      size: null,
      status: opts.start === false ? 'paused' : 'queued',
      // null = Auto (picked from the file size once it's known)
      connections: Number(opts.connections) > 0 ? Math.max(1, Math.min(32, Math.round(Number(opts.connections)))) : null,
      speedLimit: Number(opts.speedLimit) || 0,
      createdAt: Date.now(),
      completedAt: null,
      error: null,
      segments: [],
      source: opts.source || 'manual',
      browserMime: opts.mime || null,
      // game-panel (Pterodactyl/Wings) links work only once: never hang up on them early
      oneTime: !!opts.oneTime || (/\/download\/(backup|file)$/.test(parsed.pathname) && parsed.searchParams.has('token')),
    };
    this.items.unshift(item);
    this.dirty = true;
    this.save(true);
    log.item(item, `added from ${item.source}: ${log.safeUrl(url)}${item.connections ? `, ${item.connections} connections` : ', Auto speed'}${item.dir ? `, to ${item.dir}` : ''}`);
    this.emit('item', this.publicItem(item));
    this.schedule();
    return this.publicItem(item);
  }

  /**
   * A download the browser handles itself (Bolt can't fetch the link: Telegram,
   * MEGA, blob:/data: files, POST forms...). The extension reports its progress
   * so everything shows up in one list. Bolt never starts, pauses or retries it.
   */
  upsertBrowser(b) {
    const bid = String(b.browserId);
    const started = Number(b.startTime ? Date.parse(b.startTime) : 0) || 0;
    let it = this.items.find((i) => i.type === 'browser' && i.browserId === bid && (!started || !i.browserStart || i.browserStart === started));
    const created = !it;
    if (!it) {
      it = { id: util.newId(), type: 'browser', browserId: bid, browserStart: started, createdAt: Date.now(), source: 'browser', status: 'downloading', segments: [] };
      this.items.unshift(it);
    }
    const displayUrl = String(b.url || '');
    const name = b.filename ? path.basename(String(b.filename)) : null;
    const prevBytes = it.downloaded || 0;
    const prevAt = it.reportedAt || Date.now();
    Object.assign(it, {
      url: displayUrl,
      filename: name || it.filename || util.filenameFromUrl(displayUrl) || 'download',
      savePath: b.filename ? String(b.filename) : it.savePath || null,
      size: Number(b.totalBytes) > 0 ? Number(b.totalBytes) : it.size || null,
      downloaded: Math.max(0, Number(b.bytesReceived) || 0),
      mime: b.mime || it.mime || null,
      note: b.reason || it.note || null,
      reportedAt: Date.now(),
    });
    it.category = util.categoryFor(it.filename);
    const was = it.status;
    if (b.state === 'complete') Object.assign(it, { status: 'completed', completedAt: it.completedAt || Date.now(), error: null, downloaded: it.size || it.downloaded });
    else if (b.state === 'interrupted') Object.assign(it, { status: 'error', error: `Your browser stopped this download (${String(b.error || 'interrupted').replace(/_/g, ' ').toLowerCase()})` });
    else Object.assign(it, { status: b.paused ? 'paused' : 'downloading', error: null });
    const dt = (it.reportedAt - prevAt) / 1000;
    if (!created && dt > 0.2) {
      const inst = Math.max(0, (it.downloaded - prevBytes) / dt);
      const old = this.browserSpeed.get(it.id);
      this.browserSpeed.set(it.id, old ? old * 0.6 + inst * 0.4 : inst);
    }
    if (created) log.item(it, `left to the browser: ${it.note || 'Bolt cannot fetch this link'} (${log.safeUrl(displayUrl)})`);
    if (was !== it.status && it.status !== 'downloading') log.item(it, `browser download ${it.status}${it.error ? ': ' + it.error : ''}`);
    this.dirty = true;
    this.emit('item', this.publicItem(it));
    if (was !== 'completed' && it.status === 'completed') this.emit('completed', this.publicItem(it));
    return this.publicItem(it);
  }

  /** Bolt can't pause, retry or re-download what the browser downloads. */
  notBrowser(it) {
    if (it && it.type === 'browser') throw new Error('Your browser is handling this download, so control it from the browser\'s downloads page');
  }

  /**
   * An unfinished download of the same file (same name and size), so a fresh
   * link from the browser can continue it instead of starting a new copy.
   */
  findResumable(filename, size) {
    if (!filename || !size) return null;
    const name = String(filename).toLowerCase();
    return this.items.find((i) => i.type === 'http' && i.status !== 'completed' && i.size === size
      && (i.filename || '').toLowerCase() === name) || null;
  }

  /** Throw away the partial data and download from zero (only when the user asks). */
  async restartFromZero(id) {
    const it = this.get(id);
    if (!it) throw new Error('Not found');
    this.notBrowser(it);
    const t = this.tasks.get(id);
    if (t) { await t.stop('paused'); this.tasks.delete(id); }
    if (it.savePath) {
      for (const ext of ['.bolt', '.bolt-hls', '.bolt-ytdlp']) await fs.promises.rm(it.savePath + ext, { force: true, recursive: true }).catch(() => {});
    }
    log.item(it, 'restarted from zero by the user');
    Object.assign(it, { segments: [], size: null, resumable: null, forceSingle: false, mismatchRestarts: 0, hls: null, ytdlp: null, downloaded: 0, error: null, errorKind: null, note: null, status: 'queued' });
    this.dirty = true;
    this.save(true);
    this.emit('item', this.publicItem(it));
    this.schedule();
    return this.publicItem(it);
  }

  taskFor(item) {
    this.notBrowser(item);
    let t = this.tasks.get(item.id);
    if (t) return t;
    const Task = { hls: HlsDownload, ytdlp: YtdlpDownload }[item.type] || HttpDownload;
    t = new Task(item, this.ctx);
    t.on('update', () => { this.dirty = true; this.emit('item', this.publicItem(item)); });
    t.on('done', () => {
      this.tasks.delete(item.id);
      this.save(true);
      this.emit('item', this.publicItem(item));
      this.emit('completed', this.publicItem(item));
      this.schedule();
    });
    t.on('failed', () => {
      this.tasks.delete(item.id);
      this.save(true);
      this.emit('item', this.publicItem(item));
      this.schedule();
    });
    this.tasks.set(item.id, t);
    return t;
  }

  schedule() {
    const max = this.config.get('maxConcurrent') || Infinity;   // 0 = unlimited
    // waiting for a drive or disk space doesn't take a slot from the other downloads
    let running = this.items.filter((i) => i.type !== 'browser' && ACTIVE.has(i.status) && !i.waitReason).length;
    // oldest queued first
    const queued = this.items.filter((i) => i.status === 'queued' && i.type !== 'browser').reverse();
    for (const it of queued) {
      if (running >= max) break;
      running++;
      this.taskFor(it).start().catch((e) => log.item(it, 'start failed: ' + (e.stack || e), 'ERROR'));
    }
  }

  async pause(id) {
    const it = this.get(id);
    if (!it) throw new Error('Not found');
    if (it.status === 'completed') return this.publicItem(it);
    this.notBrowser(it);
    const t = this.tasks.get(id);
    if (t) { await t.stop('paused'); this.tasks.delete(id); }
    else it.status = 'paused';
    this.dirty = true;
    this.save(true);
    this.emit('item', this.publicItem(it));
    this.schedule();
    return this.publicItem(it);
  }

  resume(id, now = false) {
    const it = this.get(id);
    if (!it) throw new Error('Not found');
    if (it.status === 'completed' || ACTIVE.has(it.status)) return this.publicItem(it);
    this.notBrowser(it);
    it.status = 'queued';
    it.error = null;
    it.errorKind = null;
    this.dirty = true;
    this.emit('item', this.publicItem(it));
    if (now) this.taskFor(it).start().catch((e) => log.item(it, 'start failed: ' + (e.stack || e), 'ERROR'));
    else this.schedule();
    return this.publicItem(it);
  }

  /** Swap in a fresh link (expired signed URL etc.) and keep the progress. */
  async refreshUrl(id, url, extra = {}) {
    const it = this.get(id);
    if (!it) throw new Error('Not found');
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('Invalid URL'); }
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('Only http(s) links can be downloaded');
    this.notBrowser(it);
    const t = this.tasks.get(id);
    const wasActive = ACTIVE.has(it.status) || it.status === 'queued';
    if (t) { await t.stop('paused'); this.tasks.delete(id); }
    log.item(it, `link refreshed -> ${log.safeUrl(url)}`);
    it.url = url;
    it.finalUrl = null;
    // A link from the browser comes with that session's cookies and referrer.
    for (const k of ['cookies', 'referrer', 'userAgent']) if (extra[k]) it[k] = extra[k];
    if (it.type === 'ytdlp') it.ytdlp = null;   // read the video info again from the new page
    it.error = null;
    this.dirty = true;
    if (wasActive || it.status === 'error') return this.resume(id);
    this.emit('item', this.publicItem(it));
    return this.publicItem(it);
  }

  async remove(id, deleteFile = false) {
    const it = this.get(id);
    if (!it) return;
    const t = this.tasks.get(id);
    if (t) { await t.stop('paused'); this.tasks.delete(id); }
    log.item(it, `removed from the list${it.status !== 'completed' ? ' (partial data deleted)' : deleteFile ? ' (file deleted)' : ''}`);
    if (it.savePath && (it.type !== 'browser' || it.status === 'completed')) {
      const rm = (p) => fs.promises.rm(p, { force: true, recursive: true }).catch(() => {});
      if (it.status !== 'completed') { await rm(it.savePath + '.bolt'); await rm(it.savePath + '.bolt-hls'); await rm(it.savePath + '.bolt-ytdlp'); }
      else if (deleteFile) await rm(it.savePath);
    }
    this.items = this.items.filter((i) => i.id !== id);
    this.dirty = true;
    this.save(true);
    this.emit('removed', id);
    this.schedule();
  }

  async pauseAll() { for (const it of this.items) if (it.type !== 'browser' && (ACTIVE.has(it.status) || it.status === 'queued')) await this.pause(it.id); }
  resumeAll() { for (const it of this.items) if (it.type !== 'browser' && ['paused', 'error'].includes(it.status)) this.resume(it.id); }
  clearCompleted() {
    const ids = this.items.filter((i) => i.status === 'completed').map((i) => i.id);
    this.items = this.items.filter((i) => i.status !== 'completed');
    this.dirty = true;
    for (const id of ids) this.emit('removed', id);
  }

  applySettings() {
    this.ctx.throttle.setRate(this.config.get('speedLimit'));
    this.schedule();
  }

  setItemLimit(id, bps) {
    const it = this.get(id);
    if (!it) throw new Error('Not found');
    it.speedLimit = Math.max(0, Number(bps) || 0);
    const t = this.tasks.get(id);
    if (t) t.setLimit(it.speedLimit);
    this.dirty = true;
    return this.publicItem(it);
  }

  emitStats() {
    if (!this.tasks.size) return;
    const stats = [];
    let total = 0;
    for (const [id, t] of this.tasks) {
      const s = t.stats();
      total += s.speed;
      stats.push({ id, ...s, status: t.item.status, size: t.item.size, error: t.item.error });
    }
    this.emit('stats', { items: stats, totalSpeed: total });
  }

  async shutdown() {
    clearInterval(this.saveTimer);
    clearInterval(this.schedTimer);
    clearInterval(this.statsTimer);
    this.keepAwake.set(false);
    const running = [...this.tasks.values()];
    await Promise.all(running.map((t) => t.stop('queued').catch(() => {})));
    await this.save(true);
    await this.safeSaving;
    await this.safeSave();
  }
}

module.exports = { Manager, ACTIVE };
