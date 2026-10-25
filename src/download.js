'use strict';
/*
 * Segmented HTTP(S) download with dynamic re-splitting.
 *
 * How it goes fast: the first request asks for "bytes=0-". If the server
 * answers 206 we know it supports ranges, so we keep that connection and
 * immediately split the remaining range to open more connections. Whenever a
 * connection finishes its piece, it steals the second half of the largest
 * piece still in progress, so every connection stays busy until the very end
 * (no slow tail with one connection left).
 *
 * How it survives failures: each segment records only bytes that have
 * actually been written to disk ("pos"). That state is saved continuously,
 * so after a crash, network loss, sleep or reboot we continue from exactly
 * where the data on disk ends. Failed connections retry with backoff
 * forever (by default) so a dropped Wi-Fi resumes on its own.
 *
 * Progress is never thrown away silently: if the server starts answering
 * strangely mid-download (different size, ignores resume), Bolt retries and
 * then stops with the data kept, instead of starting over by itself.
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const zlib = require('zlib');
const { execFile } = require('child_process');
const { performance } = require('perf_hooks');
const { request, HttpError, parseRetryAfter } = require('./http');
const { Throttle } = require('./throttle');
const util = require('./util');
const log = require('./log');

const MB = 1 << 20;
const KEEP_THRESHOLD = 32 * MB;   // never discard more than this without asking
const WAKE_GAP = 8000;            // a tick this late means sleep/hibernate or a frozen app
const PATIENT_STALL = 180000;     // how long a download that can't resume waits for a quiet server
const WAIT_POLL = 5000;           // how often a download waiting for disk space / its drive checks again
// New connections are opened a few at a time instead of a burst of 16-32 at once, which
// firewalls and anti-abuse systems may count against an address. (During testing a real
// mirror refused this PC entirely right after such a burst; the cause can't be confirmed.)
const RAMP_STEP = 4;              // connections allowed to be connecting at the same time
const GROW_EVERY = 30000;         // after a server limited the connections, try one more this often
// Data received but not yet on disk, across all downloads. When the disk is slower than the
// network, sockets pause at this point instead of piling up hundreds of MB in memory.
const MEM_BUDGET = 96 * MB;
const SYNC_EVERY = 15000;         // flush the file to disk this often; only flushed bytes count after a power cut
                                  // (5 s cost ~4 % on a hard disk at full speed; 15 s means at most 15 s to fetch again)
const ETA_WINDOW = 30;            // seconds of history behind the time-left estimate
const CONNECT_FAIL = /^(ETIMEDOUT|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE)$/;
// Some servers hang up on certain User-Agents. Measured on Hetzner's mirrors: Chrome, Firefox,
// "Mozilla/5.0", python-requests and no User-Agent at all were reset; curl, wget, aria2 and
// this one were accepted. Used when the browser-like identity gets hung up on.
const PLAIN_UA = `Bolt-Download-Manager/${require('../package.json').version}`;
// Antivirus, indexers and backup tools hold files open for a moment: worth trying again.
const LOCKED = new Set(['EBUSY', 'EPERM', 'EACCES', 'EAGAIN']);

// Flushes still running after a pause, by partial file. A resume waits for its file's flush
// before touching the file: on Windows even a quick check of a file being flushed can hold
// up the whole app for seconds (measured: Resume took 4-7 s instead of milliseconds).
const flushes = new Map();

/** Open a file, waiting out a short lock by another program. */
async function openRetry(file, flags) {
  for (let i = 1; ; i++) {
    try { return await fs.promises.open(file, flags); } catch (e) {
      if (!LOCKED.has(e.code) || i >= 10) throw e;
      await new Promise((r) => setTimeout(r, 200 * i));
    }
  }
}

/** Speed presets offered in the download window (connections per file). */
const SPEEDS = { normal: 4, fast: 8, ultra: 16, max: 32 };

/** "Auto" speed: more connections for bigger files; over 100 GB uses Max. */
function autoConnections(size) {
  if (size == null) return 8;
  if (size < 10e6) return 4;
  if (size < 1e9) return 8;
  if (size < 100e9) return 16;
  return SPEEDS.max;
}

// Same units as the window shows (1 GB = 1024³ bytes), so messages and the progress bar agree.
function fmtBytes(n) {
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1) + ' GB';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB';
  return Math.round(n / 1024) + ' KB';
}

function parseContentRange(v) {
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(v || '').trim());
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2]), total: m[3] === '*' ? null : Number(m[3]) };
}

/**
 * On NTFS, writing far past the end of a new file makes Windows zero-fill the
 * gap first (measured: ~24 s for a write at 3.5 GB on an HDD), which stalls
 * every connection. A sparse file skips that. Best effort: FAT/exFAT drives
 * don't support it and simply fall back to normal behaviour.
 */
function makeSparse(file) {
  if (process.platform !== 'win32') return Promise.resolve();
  return new Promise((resolve) => {
    execFile('fsutil', ['sparse', 'setflag', file], { windowsHide: true, timeout: 5000 }, () => resolve());
  });
}

/** File type from the first bytes, for files saved without an extension. */
async function sniffExtension(file) {
  let fh;
  try {
    fh = await fs.promises.open(file, 'r');
    const buf = Buffer.alloc(65536);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const b = buf.subarray(0, bytesRead);
    const starts = (...sig) => b.length >= sig.length && sig.every((x, i) => b[i] === x);
    const isTar = (x) => x.length > 262 && x.toString('latin1', 257, 262) === 'ustar';
    if (starts(0x1f, 0x8b)) {
      try {
        // inflate just the start to see whether a tar archive is inside
        if (isTar(zlib.gunzipSync(b, { finishFlush: zlib.constants.Z_SYNC_FLUSH }))) return '.tar.gz';
      } catch { /* too little data to tell */ }
      return '.gz';
    }
    if (starts(0x50, 0x4b, 0x03, 0x04)) return '.zip';
    if (starts(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)) return '.7z';
    if (starts(0x52, 0x61, 0x72, 0x21)) return '.rar';
    if (starts(0x28, 0xb5, 0x2f, 0xfd)) return '.zst';
    if (starts(0x25, 0x50, 0x44, 0x46)) return '.pdf';
    if (isTar(b)) return '.tar';
    return '';
  } catch {
    return '';
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

/** The buffers left after the first n bytes were written. */
function dropFront(bufs, n) {
  const out = [];
  for (const b of bufs) {
    if (n >= b.length) { n -= b.length; continue; }
    out.push(n ? b.subarray(n) : b);
    n = 0;
  }
  return out;
}

function isRetryableStatus(s) {
  return s === 408 || s === 425 || s === 429 || s >= 500;
}

/** Errors no retry can fix: disk full, no permission, bad link, web page instead of file. */
function isFatal(err) {
  return ['ENOSPC', 'EACCES', 'EPERM', 'EROFS', 'EISDIR', 'ENOTDIR', 'ERR_INVALID_URL', 'NOT_A_FILE'].includes(err.code)
    || /Unsupported protocol|Invalid URL/.test(err.message);
}

function friendlyHttp(status, kept, oneTime) {
  if (oneTime && [400, 401, 403, 404, 410].includes(status)) {
    return `This download link works only once and is used up (HTTP ${status}). Click Download in the panel again to get a new link.`;
  }
  const keep = kept
    ? ` Your ${fmtBytes(kept)} are kept: click "Refresh link", or start the same download again in your browser and Bolt continues it.`
    : ' Try starting the download again from the website.';
  if (status === 401 || status === 403) return `The server refused access (HTTP ${status}). The link has probably expired or needs your login.${keep}`;
  if (status === 404 || status === 410) return `The file is no longer at this link (HTTP ${status}).${keep}`;
  return `The server rejected the download (HTTP ${status}).${keep}`;
}

/**
 * Ask the server about a link without downloading it (Range: bytes=0-0).
 * Used before taking a download away from the browser, so Bolt only takes
 * links it can really fetch.
 */
async function probe(opts, config) {
  const headers = { 'User-Agent': opts.userAgent || config.get('userAgent'), Range: 'bytes=0-0' };
  if (opts.referrer) headers.Referer = opts.referrer;
  if (opts.cookies) headers.Cookie = opts.cookies;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12000);
  try {
    const { res, url } = await request(opts.url, { headers, signal: ac.signal, timeout: 12000 });
    const h = res.headers;
    const st = res.statusCode;
    res.destroy();
    if (st >= 400) return { ok: false, status: st, error: `The server answered HTTP ${st} ${res.statusMessage || ''}`.trim() };
    if (st !== 200 && st !== 206) return { ok: false, status: st, error: `Unexpected answer from the server (HTTP ${st})` };
    const mime = h['content-type'] || null;
    if (opts.mime && !/html/i.test(opts.mime) && /text\/html/i.test(mime || '')) {
      return { ok: false, status: st, error: 'The site sent a web page instead of the file (this link only works inside the browser)' };
    }
    let size = null; let resumable = false;
    if (st === 206) {
      const cr = parseContentRange(h['content-range']);
      if (cr && cr.start === 0) { size = cr.total; resumable = cr.total != null; }
    } else if (h['content-length'] != null && Number.isFinite(Number(h['content-length']))) {
      size = Number(h['content-length']);
    }
    let name = opts.filename
      || util.filenameFromDisposition(h['content-disposition'])
      || util.filenameFromUrl(url) || util.filenameFromUrl(opts.url) || 'download';
    name = util.sanitizeFilename(path.basename(name));
    if (!path.extname(name)) name += util.extFromMime(mime);
    return { ok: true, status: st, size, resumable, mime, finalUrl: url, filename: name, autoConnections: autoConnections(size) };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'The server did not answer in time' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

class HttpDownload extends EventEmitter {
  /**
   * @param item persistent record (mutated in place, saved by the manager)
   * @param ctx  { config, throttle, reservePath(dir, name), hosts: Map }
   */
  constructor(item, ctx) {
    super();
    this.item = item;
    this.ctx = ctx;
    this.throttle = new Throttle(item.speedLimit || 0);
    this.rt = new Map();        // segment -> runtime state (not persisted)
    this.workers = new Set();
    this.running = false;
    this.stopping = false;
    this.fd = null;
    this.failures = 0;
    this.retryTimer = null;
    this.received = 0;
    this.speed = 0;
    this.dirty = false;
    this.drainWaiters = [];
    this.hist = [];
    this.lastSync = 0;
    this.setBuffers(item.size);
    if (!Array.isArray(item.segments)) item.segments = [];
  }

  get partPath() { return this.item.savePath + '.bolt'; }

  /**
   * Bigger disk writes for big files: fewer seeks, which matters a lot on HDDs.
   * With many connections each one gets less, so they all fit in MEM_BUDGET.
   */
  setBuffers(size, conns = 8) {
    const want = size != null && size >= 1e9 ? 4 * MB : MB;
    this.flushBytes = Math.max(MB, Math.min(want, Math.floor(MEM_BUDGET / 2 / Math.max(1, conns) / MB) * MB));
    this.highWater = this.flushBytes * 4;   // pause a socket when this much waits for disk
    this.lowWater = this.flushBytes;
  }

  /** Bytes received but not on disk yet. */
  memUsed() {
    let n = 0;
    for (const rt of this.rt.values()) n += rt.bufLen + rt.queued;
    return n;
  }

  globalMem() { return this.ctx.memUsed ? this.ctx.memUsed() : this.memUsed(); }

  /** Memory all downloads together may hold: one budget per running download, so they never squeeze each other. */
  globalBudget() { return this.ctx.memBudget ? this.ctx.memBudget() : MEM_BUDGET; }

  /** The disk caught up: let paused sockets go again (also those of other downloads). */
  resumeDiskPaused() {
    if (this.globalMem() > this.globalBudget() * 0.75) return;
    for (const w of this.workers) {
      const rt = this.rt.get(w.seg);
      if (w.pauses.has('disk') && (!rt || rt.queued < this.lowWater)) this.resumeWorker(w, 'disk');
    }
  }

  /** Connections to use: the download's own choice, else the default, else Auto. */
  wantedConns() {
    const item = this.item;
    if (item.forceSingle || item.resumable === false) return 1;
    const c = Number(item.connections) || Number(this.ctx.config.get('connections')) || 0;
    return c > 0 ? Math.min(32, c) : autoConnections(item.size);
  }

  committedBytes() {
    let n = 0;
    for (const s of this.item.segments) n += Math.max(0, s.pos - s.start);
    return n;
  }

  // ---------------------------------------------------------------- control

  async start() {
    if (this.running) return;
    const item = this.item;
    this.running = true;
    this.stopping = false;
    this.failures = 0;
    this.httpFailures = 0;
    this.mismatches = 0;
    item.error = null;
    item.errorKind = null;
    item.waitReason = null;
    this.rt.clear();
    this.setStatus('connecting');
    const flushing = item.savePath && flushes.get(this.partPath);
    if (flushing) {
      await flushing.catch(() => {});
      if (!this.running || this.stopping) return;   // paused again meanwhile
    }

    try {
      const partExists = item.savePath && fs.existsSync(this.partPath);
      // (no savePath yet: Bolt stopped before the server's first answer, nothing to keep)
      if (item.savePath && item.segments.length && !partExists && !fs.existsSync(path.dirname(item.savePath))) {
        // USB drive unplugged / network share offline: never start over because of that
        this.running = false;
        return this.waitFor('drive');
      }
      if (item.segments.length && !partExists) {
        const lost = this.committedBytes();
        if (lost) {
          log.item(item, `partial file ${this.partPath} is missing (${fmtBytes(lost)} recorded) - starting over`, 'WARN');
          item.note = 'The partial file was missing on disk, so the download started over';
        }
        item.segments = [];
      } else if (item.segments.length && item.resumable === false) {
        // Before throwing the data away, ask once more: the first answer may have been a fluke.
        const kept = this.committedBytes();
        if (kept > 0 && item.size && !item.oneTime && await this.rangesWork(item.finalUrl || item.url)) {
          log.item(item, `server can resume after all - continuing at ${fmtBytes(kept)}`);
          item.resumable = true;
          item.forceSingle = false;
        } else {
          log.item(item, 'server cannot resume - starting over');
          item.segments = [];
        }
      }
      if (!item.segments.length) {
        item.size = null;
        item.resumable = item.forceSingle ? false : null;
        if (item.savePath) await fs.promises.rm(this.partPath, { force: true });
      } else {
        this.fd = await openRetry(this.partPath, 'r+');
      }
    } catch (e) {
      return this.fail(e);
    }

    this.maxConns = this.wantedConns();
    this.setBuffers(item.size, this.maxConns);
    this.ticker = setInterval(() => this.tick(), 1000);
    this.lastWall = Date.now();
    this.lastMono = performance.now();
    this.lastReceived = this.received;
    this.hist = [];
    this.lastSync = performance.now();
    item.retryKind = null;

    if (!item.segments.length) {
      log.item(item, `starting ${log.safeUrl(item.url)}`);
      const seg = { start: 0, end: null, pos: 0, sync: 0 };
      item.segments.push(seg);
      this.probing = true;
      this.openWorker(seg);
    } else {
      log.item(item, `resuming at ${fmtBytes(this.committedBytes())} of ${item.size != null ? fmtBytes(item.size) : '?'} with up to ${this.maxConns} connections`);
      this.probing = false;
      this.fill();
    }
  }

  /** Stop all connections, flush everything to disk and keep the progress. */
  async stop(status = 'paused') {
    // also ends a wait for the network, disk space or the drive
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (status !== 'retrying') this.item.waitReason = null;
    if (!this.running) { this.setStatus(status); return; }
    this.stopping = true;
    clearInterval(this.ticker);
    for (const w of [...this.workers]) this.killWorker(w);
    this.flushAll();
    await this.drainAll();
    // Flush to disk and mark it safe, without making the user wait: on a hard disk with
    // seconds of data still in Windows' cache that took 6-8 s per Pause. The flush finishes
    // in the background (the file closes after it); until then the saved "flushed"
    // positions simply stay at the previous flush, which is older and still correct.
    const fd = this.fd;
    this.fd = null;
    if (fd) {
      const file = this.partPath;
      const done = this.syncNow(fd).finally(() => fd.close().catch(() => {}));
      flushes.set(file, done);
      done.finally(() => { if (flushes.get(file) === done) flushes.delete(file); });
    }
    this.running = false;
    this.stopping = false;
    this.speed = 0;
    this.dirty = true;
    if (status !== 'error') log.item(this.item, `${status} at ${fmtBytes(this.committedBytes())}`);
    this.setStatus(status);
  }

  /**
   * Something outside Bolt has to change first: the disk is full, or the drive
   * or network share with the file is gone. Everything that reached the disk
   * is kept; Bolt looks again every few seconds and continues by itself.
   */
  async waitFor(reason) {
    const item = this.item;
    if (this.waiting) return;
    this.waiting = true;
    try { if (this.running) await this.stop('retrying'); } finally { this.waiting = false; }
    this.running = false;
    item.waitReason = reason;
    const kept = fmtBytes(this.committedBytes());
    const dir = path.dirname(item.savePath);
    item.error = reason === 'space'
      ? `The drive is full. Your ${kept} are safe: free up some space and Bolt continues by itself.`
      : `The download folder ${dir} is not available (drive unplugged or network share offline). Your ${kept} are kept; Bolt continues as soon as it is back.`;
    log.item(item, `waiting: ${reason === 'space' ? 'disk full' : `${dir} not available`} (${kept} kept)`, 'WARN');
    this.setStatus('retrying');
    this.emit('update');
    const check = async () => {
      this.retryTimer = null;
      if (item.status !== 'retrying' || item.waitReason !== reason) return;
      if (await this.waitOver(reason)) {
        log.item(item, `${reason === 'space' ? 'disk space is available' : 'download folder is back'} - continuing`);
        item.waitReason = null;
        item.error = null;
        return this.start().catch((e) => this.fail(e));
      }
      if (item.status === 'retrying' && item.waitReason === reason) this.retryTimer = setTimeout(check, WAIT_POLL);
    };
    this.retryTimer = setTimeout(check, WAIT_POLL);
  }

  async waitOver(reason) {
    const dir = path.dirname(this.item.savePath);
    if (reason === 'drive') return fs.existsSync(dir);
    try {
      const s = await fs.promises.statfs(dir);
      const left = this.item.size != null ? this.item.size - this.committedBytes() : 512 * MB;
      // enough for the rest, or at least for a good chunk of it
      return s.bavail * s.bsize >= Math.min(left, 512 * MB) + 64 * MB;
    } catch { return false; }
  }

  /** A disk write failed for good: wait for space or the drive if that's the cause, else stop with the data kept. */
  diskError(err) {
    if (err.code === 'ENOSPC') return this.waitFor('space');
    if (this.item.savePath && !fs.existsSync(path.dirname(this.item.savePath))) return this.waitFor('drive');
    return this.fail(err);
  }

  async fail(err) {
    const item = this.item;
    item.error = err && err.message ? err.message : String(err);
    log.item(item, `failed: ${item.error}`, 'ERROR');
    if (this.running && !this.stopping) await this.stop('error');
    else { this.running = false; this.setStatus('error'); }
    this.emit('failed', err);
  }

  setLimit(bps) {
    this.item.speedLimit = bps;
    this.throttle.setRate(bps);
  }

  setStatus(s) {
    if (this.item.status === s) return;
    this.item.status = s;
    this.dirty = true;
    this.emit('update');
  }

  // ---------------------------------------------------------------- workers

  rtFor(seg) {
    let rt = this.rt.get(seg);
    if (!rt) {
      rt = { worker: null, recvPos: seg.pos, buf: [], bufLen: 0, bufStart: 0, bufSince: 0, queue: [], queued: 0, writing: false };
      this.rt.set(seg, rt);
    }
    return rt;
  }

  baseHeaders() {
    const item = this.item;
    const h = { 'User-Agent': item.plainUA ? PLAIN_UA : item.userAgent || this.ctx.config.get('userAgent') };
    if (item.referrer) h.Referer = item.referrer;
    if (item.cookies) h.Cookie = item.cookies;
    return { ...h, ...(item.headers || {}) };
  }

  /** Does the server answer a range request for this file properly? (one tiny request) */
  async rangesWork(url) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15000);
    try {
      const { res } = await request(url, { headers: { ...this.baseHeaders(), Range: 'bytes=1-1' }, signal: ac.signal, timeout: 15000 });
      const cr = res.statusCode === 206 ? parseContentRange(res.headers['content-range']) : null;
      res.destroy();
      return !!cr && cr.start === 1 && cr.total != null && cr.total === this.item.size;
    } catch { return false; } finally { clearTimeout(timer); }
  }

  /**
   * Some servers answer "bytes=0-" (the whole file) with a plain 200 although they
   * handle other ranges fine. Check once instead of crawling along on one connection.
   */
  async confirmRanges(url) {
    if (!(await this.rangesWork(url)) || !this.running || this.stopping || this.restarting) return;
    const item = this.item;
    if (item.resumable !== false || item.forceSingle) return;
    item.resumable = true;
    this.maxConns = this.wantedConns();
    log.item(item, `server answered the first request without a range but supports ranges; using up to ${this.maxConns} connections`);
    this.dirty = true;
    this.fill();
  }

  hostKey() {
    try { return new URL(this.item.url).host; } catch { return ''; }
  }

  hostCount(delta = 0) {
    const hosts = this.ctx.hosts;
    const k = this.hostKey();
    const n = (hosts.get(k) || 0) + delta;
    if (delta) { if (n <= 0) hosts.delete(k); else hosts.set(k, n); }
    return n;
  }

  async openWorker(seg) {
    const item = this.item;
    const rt = this.rtFor(seg);
    const w = { seg, ac: new AbortController(), res: null, alive: true, pauses: new Set(), lastData: performance.now(), openedAt: performance.now(), got: 0, expect: null };
    rt.worker = w;
    this.workers.add(w);
    this.hostCount(1);

    const start = rt.recvPos;
    const headers = this.baseHeaders();
    const ranged = item.resumable !== false;
    if (ranged) headers.Range = seg.end == null ? `bytes=${start}-` : `bytes=${start}-${seg.end}`;
    w.reqEnd = ranged ? seg.end : null;

    // An extra connection that gets no answer while the others transfer is being dropped
    // by the server or a firewall: give up on it sooner, so its piece isn't stuck for long.
    const others = this.transferring();
    let res, url;
    try {
      ({ res, url } = await request(item.url, { headers, signal: w.ac.signal, timeout: others > 0 ? 15000 : 30000 }));
    } catch (e) {
      return this.workerFailed(w, e);
    }
    if (!w.alive) { res.destroy(); return; }
    w.res = res;
    // how fast this server usually answers (to spot connections it silently drops)
    const answer = performance.now() - w.openedAt;
    this.answerMs = this.answerMs ? this.answerMs * 0.7 + answer * 0.3 : answer;
    this.lastAnswerAt = performance.now();
    this.peakCur = Math.max(this.peakCur || 0, this.transferring());
    const st = res.statusCode;
    const h = res.headers;

    try {
      if (st === 206) {
        const cr = parseContentRange(h['content-range']);
        if (!cr || cr.start !== start) {
          return this.badResponse(w, 'The server sent the wrong part of the file', { single: this.probing });
        }
        if (!this.probing && item.size != null && cr.total != null && cr.total !== item.size) {
          return this.badResponse(w, `The file size on the server changed (${fmtBytes(item.size)} before, ${fmtBytes(cr.total)} now)`);
        }
        if (!this.probing) this.noteValidators(h);
        w.expect = cr.end - cr.start + 1;
        if (this.probing) {
          item.resumable = cr.total != null;
          item.size = cr.total;
          seg.end = cr.total == null ? null : cr.total - 1;
        }
      } else if (st === 200) {
        if (!this.probing) {
          return this.badResponse(w, 'The server ignored the resume request and sent the whole file again');
        }
        const len = h['content-length'] != null ? Number(h['content-length']) : null;
        item.resumable = false;
        item.size = Number.isFinite(len) ? len : null;
        seg.end = item.size == null ? null : item.size - 1;
        w.expect = item.size;
        if (/bytes/i.test(h['accept-ranges'] || '') && item.size > 4 * MB && !item.oneTime && !item.forceSingle) {
          // keeps downloading on this connection meanwhile; more join if the check passes
          setImmediate(() => this.confirmRanges(url).catch(() => {}));
        }
      } else if (st === 416 && this.probing) {
        // "bytes=0-" on an empty file.
        res.resume();
        item.resumable = false;
        item.size = 0;
        seg.end = -1;
        w.expect = 0;
      } else if (st === 416) {
        return this.badResponse(w, 'The server says this part of the file does not exist (HTTP 416)');
      } else {
        res.resume();
        throw new HttpError(st, `Server responded ${st} ${res.statusMessage || ''}`.trim(), parseRetryAfter(h['retry-after']));
      }

      if (this.probing) await this.acceptProbe(res, url);
    } catch (e) {
      return this.workerFailed(w, e);
    }
    if (!w.alive) { res.destroy(); return; }

    res.on('data', (chunk) => this.onData(w, chunk));
    res.on('end', () => this.onEnd(w));
    res.on('error', (e) => this.workerFailed(w, e));
    res.on('close', () => { if (w.alive && !res.complete) this.workerFailed(w, new Error('Connection lost')); });

    // A connection works again: after a total outage that is the signal to open the rest.
    this.rampOne = false;
    if (item.status !== 'downloading') {
      item.retryKind = null;
      this.hist = [];   // the time-left estimate starts fresh after an interruption
    }
    if (this.probing) {
      this.probing = false;
      this.setStatus('downloading');
      if (item.size === 0) { this.finishWorker(w); return; }
      this.fill();
    } else {
      if (item.status !== 'downloading') this.setStatus('downloading');
      this.fill();   // each answered connection lets the next few open
    }
  }

  /** The server was answering other connections when this one was opened. */
  answeredAround(w) {
    return this.lastAnswerAt != null && this.lastAnswerAt >= w.openedAt - Math.max(4000, 6 * (this.answerMs || 0));
  }

  /** Connections that got an answer and are moving data. */
  transferring() {
    let n = 0;
    for (const w of this.workers) if (w.res) n++;
    return n;
  }

  /** Connections still waiting for the server to answer. */
  connecting() {
    let n = 0;
    for (const w of this.workers) if (!w.res) n++;
    return n;
  }

  /** ETag/Last-Modified often differ between a host's mirrors; the size is what matters. */
  noteValidators(h) {
    const item = this.item;
    const etagChanged = item.etag && h.etag && h.etag.replace(/^W\//, '') !== item.etag.replace(/^W\//, '');
    if (etagChanged && !this.warnedEtag) {
      this.warnedEtag = true;
      log.item(item, `server sent a different ETag (${item.etag} -> ${h.etag}) with the same size; continuing`, 'WARN');
    }
  }

  /**
   * The server answered in a way that doesn't fit the download so far. Small
   * downloads just start over; big ones are retried and then paused with the
   * data kept, so a flaky server can never wipe out hours of downloading.
   */
  badResponse(w, reason, { single = false } = {}) {
    this.killWorker(w);
    this.flush(w.seg, this.rt.get(w.seg));
    if (this.stopping || !this.running) return;
    const kept = this.committedBytes();
    if (this.probing || this.item.resumable === false || kept < KEEP_THRESHOLD) {
      this.probing = false;
      // A server that keeps contradicting itself gets one plain connection,
      // which never needs resume requests, so this can't loop forever.
      this.item.mismatchRestarts = (this.item.mismatchRestarts || 0) + 1;
      if (this.item.mismatchRestarts >= 2) single = true;
      log.item(this.item, `${reason} - starting over (only ${fmtBytes(kept)} done${single ? ', using one connection' : ''})`, 'WARN');
      return this.restartFresh(reason, { single });
    }
    this.mismatches++;
    log.item(this.item, `${reason} (${this.mismatches}/4, ${fmtBytes(kept)} kept)`, 'WARN');
    if (this.mismatches >= 4) {
      this.item.errorKind = 'mismatch';
      return this.fail(new Error(`${reason}. Your ${fmtBytes(kept)} are kept: click Retry later, "Refresh link" with a new link, or "Restart" to download from zero.`));
    }
    this.scheduleRetry(Object.assign(new Error(reason), { status: 'mismatch' }));
  }

  /** First successful response: learn file name, size and validators, create the file. */
  async acceptProbe(res, finalUrl) {
    const item = this.item;
    const h = res.headers;
    const cfg = this.ctx.config;
    item.finalUrl = finalUrl;
    item.mime = h['content-type'] || null;
    if (item.browserMime && !/html/i.test(item.browserMime) && /text\/html/i.test(item.mime || '')) {
      // The browser got a file but we got a web page: usually a login wall or a
      // POST-only download that can't be replayed.
      const e = new Error('The site sent a web page instead of the file (this link only works inside the browser)');
      e.code = 'NOT_A_FILE';
      throw e;
    }
    item.etag = h.etag || null;
    item.lastModified = h['last-modified'] || null;

    if (!item.savePath) {
      let name = item.filename
        || util.filenameFromDisposition(h['content-disposition'])
        || util.filenameFromUrl(finalUrl)
        || util.filenameFromUrl(item.url)
        || 'download';
      name = util.sanitizeFilename(name);
      if (!path.extname(name)) name += util.extFromMime(item.mime);
      const dir = item.dir || (cfg.get('sortIntoCategories')
        ? path.join(cfg.get('downloadDir'), util.categoryFor(name))
        : cfg.get('downloadDir'));
      await fs.promises.mkdir(dir, { recursive: true });
      item.savePath = this.ctx.reservePath(dir, name);
    }
    item.filename = path.basename(item.savePath);
    item.category = util.categoryFor(item.filename);

    if (item.size) {
      try {
        const s = await fs.promises.statfs(path.dirname(item.savePath));
        if (s.bavail * s.bsize < item.size) {
          const e = new Error(`Not enough disk space: the file needs ${fmtBytes(item.size)}, the drive has ${fmtBytes(s.bavail * s.bsize)} free`);
          e.code = 'ENOSPC';
          throw e;
        }
      } catch (e) { if (e.code === 'ENOSPC') throw e; }
    }
    await fs.promises.mkdir(path.dirname(item.savePath), { recursive: true });
    this.fd = await fs.promises.open(this.partPath, 'w+');
    if (item.resumable && item.size > 32 * MB) await makeSparse(this.partPath);
    this.maxConns = this.wantedConns();
    this.setBuffers(item.size, this.maxConns);
    log.item(item, `size ${item.size != null ? fmtBytes(item.size) : 'unknown'}, ${item.resumable ? 'resumable' : 'NOT resumable'}, using ${this.maxConns} connection(s), saving to ${item.savePath}`);
    this.dirty = true;
    // the file name is known now: save it at once, so a crash in the first second can't leave a
    // partial file behind that the next start doesn't know about
    if (this.ctx.saveNow) this.ctx.saveNow();
    this.emit('update');
  }

  onData(w, chunk) {
    if (!w.alive) return;
    const seg = w.seg;
    const rt = this.rt.get(seg);
    w.lastData = performance.now();
    w.warnedQuiet = false;
    if (seg.end != null) {
      const room = seg.end - rt.recvPos + 1;
      if (room <= 0) return this.finishWorker(w);
      if (chunk.length > room) chunk = chunk.subarray(0, room);
    }
    w.got += chunk.length;
    this.received += chunk.length;
    this.failures = 0;
    this.httpFailures = 0;
    if (w.got > 4 * MB) this.mismatches = 0;
    this.enqueue(seg, rt, chunk);

    const delay = Math.max(this.ctx.throttle.consume(chunk.length), this.throttle.consume(chunk.length));
    if (delay > 0) {
      this.pauseWorker(w, 'rate');
      setTimeout(() => this.resumeWorker(w, 'rate'), delay);
    }
    if (seg.end != null && rt.recvPos > seg.end) this.finishWorker(w);
  }

  onEnd(w) {
    if (!w.alive) return;
    const seg = w.seg;
    const rt = this.rt.get(seg);
    if (seg.end == null) {
      // Unknown length: the server closing the stream cleanly marks the end.
      seg.end = rt.recvPos - 1;
      this.item.size = rt.recvPos;
      return this.finishWorker(w);
    }
    if (rt.recvPos > seg.end) return this.finishWorker(w);
    if (w.expect != null && w.got >= w.expect && this.item.resumable) {
      // Server sent a shorter range than asked for; just ask for the rest.
      return this.finishWorker(w);
    }
    this.workerFailed(w, new Error('Connection closed early'));
  }

  pauseWorker(w, reason) {
    w.pauses.add(reason);
    if (w.res && w.alive) w.res.pause();
  }

  resumeWorker(w, reason) {
    w.pauses.delete(reason);
    if (!w.pauses.size && w.res && w.alive) w.res.resume();
    w.lastData = performance.now();
  }

  cleanupWorker(w) {
    const rt = this.rt.get(w.seg);
    if (rt && rt.worker === w) rt.worker = null;
    if (this.workers.delete(w)) this.hostCount(-1);
  }

  killWorker(w) {
    w.alive = false;
    try { w.ac.abort(); } catch { /* ignore */ }
    if (w.res) w.res.destroy();
    this.cleanupWorker(w);
  }

  finishWorker(w) {
    if (!w.alive) return;
    if (w.res && w.reqEnd != null && w.reqEnd === w.seg.end) {
      // The response ends exactly here: let it finish so the keep-alive
      // socket goes back to the pool for the next range request.
      w.alive = false;
      this.cleanupWorker(w);
      w.res.resume();
    } else {
      this.killWorker(w);
    }
    const rt = this.rt.get(w.seg);
    this.flush(w.seg, rt);
    this.checkDone();
    this.fill();
  }

  workerFailed(w, err) {
    if (!w.alive) return;
    this.killWorker(w);
    const rt = this.rt.get(w.seg);
    if (rt) this.flush(w.seg, rt);
    if (this.stopping || !this.running) return;
    if (err.name === 'AbortError') return;

    if (isFatal(err)) return this.fail(err);
    if (err instanceof HttpError && !isRetryableStatus(err.status)) return this.httpRefused(w, err);

    const othersAnswered = this.transferring() > 0 || this.answeredAround(w);
    if (!w.res && !this.probing && this.item.resumable !== false && othersAnswered
      && (CONNECT_FAIL.test(err.code || '') || /timed out|socket hang up/i.test(err.message))) {
      // An extra connection got no answer while others did: the server (or a firewall)
      // allows only that many. Stay at that number instead of knocking again and again;
      // try one more later.
      const working = Math.max(1, this.transferring(), this.peakCur || 0, this.peakPrev || 0);
      if (this.maxConns > working) {
        log.item(this.item, `extra connection failed (${err.code || err.message}); continuing with ${working} connection(s)`, 'WARN');
        this.maxConns = working;
      }
      this.growAt = performance.now() + 2 * GROW_EVERY;
      if (this.mergeBack(w.seg)) return;
      return this.scheduleRetry(err);
    }

    if (this.probing && !w.res && !this.item.plainUA && /ECONNRESET|socket hang up/i.test(`${err.code} ${err.message}`)) {
      // Hung up on before any answer: likely bot protection reacting to the browser-like
      // identity. Ask again right away as what Bolt really is, a download manager.
      this.item.plainUA = true;
      log.item(this.item, `server hung up before answering (${err.code || err.message}); asking again as ${PLAIN_UA}`, 'WARN');
      this.probing = false;
      return this.restartFresh(null);
    }
    if (this.probing || this.item.resumable === false) {
      // Nothing can be kept; retry the whole thing from zero.
      this.probing = false;
      if (this.committedBytes() > KEEP_THRESHOLD) log.item(this.item, `${err.message}; this server can't resume, so the download has to start over`, 'WARN');
      return this.restartFresh(null, { err });
    }

    const status = err.status;
    if (status === 429 || status === 503) {
      // Server is asking us to back off: use fewer connections.
      const before = this.maxConns;
      this.maxConns = Math.max(1, Math.min(this.maxConns, this.workers.size));
      if (this.maxConns < before) log.item(this.item, `server is busy (HTTP ${status}); using ${this.maxConns} connection(s)`, 'WARN');
      this.growAt = performance.now() + 2 * GROW_EVERY;   // and slowly back up once it is quiet
    }
    // Never reconnect instantly: a refused connection would spin in a hot loop.
    this.scheduleRetry(err);
  }

  /**
   * Give a refused, still-empty piece back to the connection in front of it,
   * when that connection's request already covers it. One-time links and
   * hosts that allow a single connection then simply finish on that one.
   */
  mergeBack(seg) {
    const segs = this.item.segments;
    const i = segs.indexOf(seg);
    if (i <= 0 || !this.idleEmpty(seg)) return false;
    // Walk back over other refused (empty, idle) pieces to the connection in front...
    let j = i - 1;
    while (j >= 0 && this.idleEmpty(segs[j])) j--;
    if (j < 0) return false;
    const owner = segs[j];
    const ort = this.rt.get(owner);
    const w = ort && ort.worker;
    if (!w || !w.alive || !w.res || owner.end == null) return false;
    // ...and forward over refused pieces behind this one, as far as its request reaches.
    let k = i;
    while (k + 1 < segs.length && this.idleEmpty(segs[k + 1])) k++;
    while (k >= i && w.reqEnd != null && w.reqEnd < segs[k].end) k--;
    if (k < i) return false;
    owner.end = segs[k].end;
    for (const s of segs.splice(j + 1, k - j)) this.rt.delete(s);
    this.dirty = true;
    return true;
  }

  /** A piece nobody is working on and that has no data yet. */
  idleEmpty(s) {
    const rt = this.rt.get(s);
    if (s.end == null || s.pos !== s.start) return false;
    return !rt || (!rt.worker && rt.recvPos === s.start && !rt.bufLen && !rt.queue.length && !rt.writing);
  }

  /** 4xx answers: an extra connection being refused is normal; the whole link failing is not. */
  httpRefused(w, err) {
    const s = err.status;
    if (this.workers.size > 0 && !this.probing) {
      // Many file hosts allow only a few connections per user (and one-time
      // links only one). Keep going with the ones that work.
      const before = this.maxConns;
      this.maxConns = Math.max(1, this.workers.size);
      if (this.maxConns < before) log.item(this.item, `server refused an extra connection (HTTP ${s}); continuing with ${this.maxConns}`, 'WARN');
      this.growAt = performance.now() + 4 * GROW_EVERY;
      if (this.mergeBack(w.seg)) return;
      return this.scheduleRetry(err);
    }
    this.httpFailures++;
    const limit = s === 404 || s === 410 ? 2 : 3;
    if (this.httpFailures >= limit) {
      this.item.errorKind = 'http';
      return this.fail(Object.assign(new Error(friendlyHttp(s, this.committedBytes(), this.item.oneTime)), { status: s }));
    }
    log.item(this.item, `HTTP ${s} (attempt ${this.httpFailures}/${limit})`, 'WARN');
    if (this.probing) { this.probing = false; return this.restartFresh(null, { err }); }
    this.scheduleRetry(err);
  }

  scheduleRetry(err) {
    if (this.workers.size === 0) {
      // nothing gets through at all: is it the network, or the server?
      this.item.retryKind = err.status ? 'server' : 'network';
      this.setStatus('retrying');
    }
    if (this.retryTimer) return;
    const maxRetries = this.ctx.config.get('maxRetries');
    this.failures++;
    if (maxRetries > 0 && this.failures > maxRetries) return this.fail(err);
    // Network-level errors: retry often (≤10s) so a dropped connection picks up
    // quickly once it's back. Server errors back off further (≤60s).
    const cap = err.status ? 60000 : 10000;
    const backoff = Math.min(cap, 1000 * 2 ** Math.min(this.failures - 1, 6));
    const delay = Math.max(err.retryAfter || 0, backoff * (0.75 + Math.random() * 0.5));
    if (this.workers.size === 0) this.item.error = `${err.message} - retrying in ${Math.round(delay / 1000)}s`;
    if (this.failures <= 5 || this.failures % 20 === 0) {
      log.item(this.item, `${err.message}; retry #${this.failures} in ${Math.round(delay / 1000)}s (${this.workers.size} connection(s) still running)`, 'WARN');
    }
    this.emit('update');
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.running || this.stopping) return;
      this.item.error = null;
      // Everything failed: knock with one connection; the others follow once it gets through.
      if (this.workers.size === 0) this.rampOne = true;
      if (this.item.segments.length && this.probing === false && this.item.size != null) this.fill();
      else this.restartFresh(null);
    }, delay);
  }

  /**
   * Begin again from zero. Only used when there is little to lose (or the
   * server can't resume at all, or the user asked for it).
   */
  async restartFresh(reason, { single = false, err = null } = {}) {
    if (this.restarting) return;
    this.restarting = true;
    const item = this.item;
    this.stopping = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    clearInterval(this.ticker);
    for (const w of [...this.workers]) this.killWorker(w);
    // Buffered data must be written before waiting for writes to finish,
    // otherwise the wait never ends (this used to freeze downloads for good).
    let buffered = 0;
    for (const rt of this.rt.values()) buffered += rt.bufLen;
    if (buffered) log.item(item, `restarting with ${fmtBytes(buffered)} still buffered (flushed first)`);
    this.flushAll();
    await this.drainAll();
    await this.closeFd();
    item.segments = [];
    item.size = null;
    if (single) item.forceSingle = true;
    item.resumable = item.forceSingle ? false : null;
    this.running = false;
    this.stopping = false;
    this.restarting = false;
    if (reason) item.note = reason;
    if (err) {
      // Restarting because a non-resumable transfer broke: back off first.
      const maxRetries = this.ctx.config.get('maxRetries');
      this.failures++;
      if (maxRetries > 0 && this.failures > maxRetries) return this.fail(err);
      const delay = Math.min(30000, 1000 * 2 ** Math.min(this.failures - 1, 5));
      item.error = `${err.message} - retrying in ${Math.round(delay / 1000)}s`;
      if (this.failures <= 5 || this.failures % 20 === 0) log.item(item, `${err.message}; starting again in ${Math.round(delay / 1000)}s`, 'WARN');
      this.setStatus('retrying');
      this.emit('update');
      const failures = this.failures;
      const httpFailures = this.httpFailures;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (item.status !== 'retrying') return;
        this.start().then(() => { this.failures = failures; this.httpFailures = httpFailures; }).catch((e) => this.fail(e));
      }, delay);
      return;
    }
    return this.start();
  }

  /** Called after the PC wakes up: every socket is dead, so reconnect right away. */
  reconnectAll(gapMs) {
    if (!this.running || this.stopping || this.restarting || this.probing) return;
    log.item(this.item, `no activity for ${Math.round(gapMs / 1000)}s (sleep or freeze) - reconnecting all connections`, 'WARN');
    this.hist = [];
    for (const w of [...this.workers]) this.killWorker(w);
    this.flushAll();
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.failures = 0;
    this.maxConns = this.wantedConns();
    this.fill();
  }

  /** Give every free connection slot something to do. */
  fill() {
    const item = this.item;
    if (!this.running || this.stopping || this.probing || this.restarting) return;
    if (this.checkDone() || this.retryTimer) return;
    const maxHost = this.ctx.config.get('maxConnectionsPerHost') || Infinity;   // 0 = no total limit per server
    // a few at a time (each answered connection lets more open), only one after an outage
    const maxPending = this.rampOne ? 1 : RAMP_STEP;
    const canOpen = () => this.workers.size < this.maxConns && this.hostCount() < maxHost && this.connecting() < maxPending;

    // 1) a piece for every allowed connection: split the biggest one left (worked on or
    //    not yet) in half. All pieces are planned at once, so even a small file is split
    //    evenly although the connections themselves open a few at a time.
    if (item.resumable && item.size != null && !item.forceSingle) {
      const minSplit = this.ctx.config.get('minSplitSize');
      const recv = (s) => { const rt = this.rt.get(s); return rt ? rt.recvPos : s.pos; };
      for (;;) {
        let pieces = 0; let best = null; let bestRem = 0;
        for (const s of item.segments) {
          if (s.end == null) continue;
          const rem = s.end - recv(s) + 1;
          if (rem > 0) pieces++;
          if (rem > bestRem) { best = s; bestRem = rem; }
        }
        if (pieces >= this.maxConns || !best || bestRem < 2 * minSplit) break;
        const cut = recv(best) + Math.ceil(bestRem / 2);
        const seg = { start: cut, end: best.end, pos: cut, sync: cut };
        best.end = cut - 1;
        item.segments.splice(item.segments.indexOf(best) + 1, 0, seg);
        this.dirty = true;
      }
    }

    // 2) every piece nobody works on gets a connection, as many as may open now
    for (const seg of item.segments) {
      if (!canOpen()) break;
      const rt = this.rtFor(seg);
      if (rt.worker || (seg.end != null && rt.recvPos > seg.end)) continue;
      this.openWorker(seg);
    }
  }

  // ---------------------------------------------------------------- disk I/O

  enqueue(seg, rt, chunk) {
    if (!rt.bufLen) { rt.bufStart = rt.recvPos; rt.bufSince = performance.now(); }
    rt.buf.push(chunk);
    rt.bufLen += chunk.length;
    rt.recvPos += chunk.length;
    if (rt.bufLen >= this.flushBytes || performance.now() - rt.bufSince > 1000) this.flush(seg, rt);
  }

  flush(seg, rt) {
    if (!rt || !rt.bufLen) return;
    // the received chunks go to disk as they are, in one vectored write: no copy
    // (measured ~9% faster to an HDD at 600 MB/s, and less CPU)
    rt.queue.push({ pos: rt.bufStart, bufs: rt.buf, len: rt.bufLen });
    rt.queued += rt.bufLen;
    rt.buf = [];
    rt.bufLen = 0;
    this.pumpWrites(seg, rt);
    if (rt.worker && (rt.queued > this.highWater || this.globalMem() > this.globalBudget())) this.pauseWorker(rt.worker, 'disk');
  }

  flushAll() {
    for (const [seg, rt] of this.rt) this.flush(seg, rt);
  }

  pumpWrites(seg, rt) {
    if (rt.writing || !rt.queue.length) return;
    if (!this.fd) { rt.queue = []; rt.queued = 0; this.resolveDrain(); return; }
    const job = rt.queue[0];
    rt.writing = true;
    fs.writev(this.fd.fd, job.bufs, job.pos, (err, written) => {
      rt.writing = false;
      if (err) {
        if (LOCKED.has(err.code) && !this.stopping && (job.tries = (job.tries || 0) + 1) <= 10) {
          // another program has the file locked for a moment: write the same data again shortly
          if (job.tries === 1) log.item(this.item, `disk write blocked (${err.code}), trying again`, 'WARN');
          setTimeout(() => this.pumpWrites(seg, rt), 200 * job.tries);
          return;
        }
        // nothing is lost: seg.pos only ever counts bytes that were written
        rt.queue = []; rt.queued = 0;
        this.resolveDrain();
        if (!this.stopping) this.diskError(err);
        return;
      }
      const wroteAt = job.pos;
      if (written < job.len) {
        job.bufs = dropFront(job.bufs, written);
        job.len -= written;
        job.pos += written;
      } else {
        rt.queue.shift();
      }
      rt.queued -= written;
      seg.pos = wroteAt + written;   // only bytes that are really on disk
      this.dirty = true;
      if (this.ctx.resumeDisk) this.ctx.resumeDisk(); else this.resumeDiskPaused();
      if (rt.queue.length) this.pumpWrites(seg, rt);
      else { this.resolveDrain(); this.checkDone(); }
    });
  }

  pending() {
    for (const rt of this.rt.values()) if (rt.writing || rt.queue.length || rt.bufLen) return true;
    return false;
  }

  resolveDrain() {
    if (this.pending()) return;
    const ws = this.drainWaiters;
    this.drainWaiters = [];
    for (const r of ws) r();
  }

  /** Wait for pending disk writes. Never forever: a stuck disk must not freeze the app. */
  drainAll() {
    if (!this.pending()) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        log.item(this.item, 'disk writes did not finish within 60s; continuing anyway', 'WARN');
        resolve();
      }, 60000);
      this.drainWaiters.push(() => { clearTimeout(timer); resolve(); });
    });
  }

  /**
   * Flush the file to disk, then mark what was written before as safe (seg.sync). After a
   * power cut, Windows may lose writes that were still in its cache; Bolt then continues
   * from the safe positions instead of trusting bytes that may never have reached the disk.
   */
  async syncNow(fd = this.fd) {
    this.lastSync = performance.now();
    if (!fd || this.syncing) return;
    const snap = [];
    for (const s of this.item.segments) if (s.pos > (s.sync ?? s.start)) snap.push([s, s.pos]);
    if (!snap.length) return;
    this.syncing = true;
    try {
      await fd.sync();
      // a position can only move back by a repair, never past what was flushed
      for (const [s, p] of snap) s.sync = Math.min(p, s.pos);
      this.dirty = true;
    } catch { /* try again next time */ } finally {
      this.syncing = false;
    }
  }

  async closeFd() {
    const fd = this.fd;
    this.fd = null;
    if (fd) { try { await fd.close(); } catch { /* ignore */ } }
  }

  // ---------------------------------------------------------------- finishing

  isComplete() {
    const item = this.item;
    if (item.size == null || this.probing) return false;
    let covered = 0;
    for (const seg of item.segments) {
      if (seg.end == null || seg.pos <= seg.end) return false;
      covered += seg.end - seg.start + 1;
    }
    return covered === item.size;
  }

  checkDone() {
    if (!this.running || this.stopping || this.finishing) return false;
    if (this.workers.size || this.pending() || !this.isComplete()) return false;
    this.finishing = true;
    this.finalize().catch((e) => this.fail(e)).finally(() => { this.finishing = false; });
    return true;
  }

  async finalize() {
    const item = this.item;
    clearInterval(this.ticker);
    clearTimeout(this.retryTimer);
    this.setStatus('finishing');
    if (this.fd) { try { await this.fd.sync(); } catch { /* ignore */ } }
    // Check before calling it finished: the file must be exactly as long as the download.
    const st = await fs.promises.stat(this.partPath);
    if (st.size < item.size) {
      // Pieces recorded as done that aren't on disk (should never happen): fetch them again.
      let fixed = 0;
      for (const s of item.segments) {
        const realEnd = Math.max(s.start, Math.min(s.pos, st.size));
        if (s.pos > realEnd) { fixed += s.pos - realEnd; s.pos = realEnd; if (s.sync != null) s.sync = Math.min(s.sync, realEnd); }
      }
      log.item(item, `check failed: the file is ${st.size} bytes, expected ${item.size}; downloading the missing ${fmtBytes(fixed)} again`, 'WARN');
      this.rt.clear();
      this.dirty = true;
      this.setStatus('downloading');
      this.ticker = setInterval(() => this.tick(), 1000);
      setImmediate(() => this.fill());
      return;
    }
    if (st.size > item.size) {
      item.errorKind = 'verify';
      throw new Error(`Check failed: the file on disk is larger (${fmtBytes(st.size)}) than the download (${fmtBytes(item.size)}). Nothing was deleted.`);
    }
    await this.closeFd();
    let target = item.savePath;
    if (!path.extname(target)) {
      // e.g. panel backups arrive as just "backup": name them by their content
      const ext = await sniffExtension(this.partPath);
      if (ext) { target += ext; log.item(item, `the server gave no file type; the content is ${ext}`); }
    }
    if (fs.existsSync(target)) {
      target = util.uniquePath(path.dirname(target), path.basename(target));
    }
    // Saved before the rename: if Bolt stops right after it, the next start finds the
    // finished file instead of downloading everything again.
    item.finalPath = target;
    if (this.ctx.saveNow) await this.ctx.saveNow();
    await util.renameWithRetry(this.partPath, target);
    item.finalPath = null;
    item.savePath = target;
    item.filename = path.basename(target);
    item.downloaded = item.size;
    item.completedAt = Date.now();
    item.error = null;
    item.errorKind = null;
    item.mismatchRestarts = 0;
    this.running = false;
    this.speed = 0;
    this.dirty = true;
    log.item(item, `completed (${fmtBytes(item.size)}) -> ${target}`);
    this.setStatus('completed');
    this.emit('done');
  }

  // ---------------------------------------------------------------- stats

  tick() {
    const wall = Date.now();
    const mono = performance.now();
    const wallGap = wall - this.lastWall;
    const monoGap = mono - this.lastMono;
    this.lastWall = wall;
    this.lastMono = mono;
    // Timers don't run while Windows sleeps, so the first tick after waking
    // comes late. All sockets are dead by then: reconnect now instead of
    // waiting for each one to time out.
    if (Math.max(wallGap, monoGap) > WAKE_GAP) {
      this.lastReceived = this.received;
      return this.reconnectAll(Math.max(wallGap, monoGap));
    }
    const inst = (this.received - this.lastReceived) / Math.max(monoGap / 1000, 0.001);
    this.speed = this.speed ? this.speed * 0.6 + inst * 0.4 : inst;
    this.lastReceived = this.received;
    if (this.item.status === 'downloading') {
      this.hist.push({ mono, received: this.received });
      if (this.hist.length > ETA_WINDOW + 1) this.hist.shift();
    }
    // flush to disk now and then; only flushed bytes count after a power cut
    if (mono - this.lastSync > SYNC_EVERY) this.syncNow();
    // a server that limited the connections: once it has been quiet for a while, try one more
    if (this.growAt && mono > this.growAt && this.maxConns < this.wantedConns() && this.workers.size >= this.maxConns && !this.retryTimer) {
      this.maxConns++;
      this.growAt = mono + GROW_EVERY;
      log.item(this.item, `trying ${this.maxConns} connections again`);
      this.fill();
    }
    this.resumeDiskPaused();
    // A new connection the server leaves unanswered much longer than it took to answer the
    // others is being dropped (firewalls do that silently). Don't let it hold its piece.
    if (!this.probing && this.lastAnswerAt != null) {
      const limit = Math.max(4000, 6 * (this.answerMs || 0));
      for (const w of [...this.workers]) {
        if (!w.res && this.answeredAround(w) && mono - w.openedAt > limit) {
          this.workerFailed(w, Object.assign(new Error('The server did not answer this connection'), { code: 'ETIMEDOUT' }));
        }
      }
    }
    // how many connections worked at once lately (a limit learned from dropped ones uses it)
    if (!this.peakAt) this.peakAt = mono;
    else if (mono - this.peakAt > GROW_EVERY) { this.peakPrev = this.peakCur || 0; this.peakCur = this.transferring(); this.peakAt = mono; }
    const stall = this.ctx.config.get('stallTimeout') * 1000;
    // Hanging up on a download that can't resume (or a one-time link) throws
    // all of it away, so a quiet server gets minutes, not seconds.
    const fragile = this.item.resumable === false || this.item.oneTime;
    const limit = fragile ? Math.max(stall, PATIENT_STALL) : stall;
    for (const w of [...this.workers]) {
      if (!w.res || w.pauses.size) continue;
      const quiet = mono - w.lastData;
      if (fragile && quiet > stall && !w.warnedQuiet) {
        w.warnedQuiet = true;
        log.item(this.item, `server has sent nothing for ${Math.round(quiet / 1000)}s; waiting up to ${Math.round(limit / 60000)} min (this download can't be resumed)`, 'WARN');
      }
      if (quiet > limit) this.workerFailed(w, new Error('Connection stalled'));
    }
    // flush slow trickles so progress keeps getting saved
    for (const [seg, rt] of this.rt) if (rt.bufLen && mono - rt.bufSince > 1000) this.flush(seg, rt);
  }

  downloadedBytes() {
    let n = 0;
    for (const seg of this.item.segments) {
      const rt = this.rt.get(seg);
      const p = rt ? rt.recvPos : seg.pos;
      n += Math.max(0, (seg.end == null ? p : Math.min(p, seg.end + 1)) - seg.start);
    }
    return n;
  }

  stats() {
    const item = this.item;
    const downloaded = item.status === 'completed' ? item.size : this.downloadedBytes();
    // [start, end, receivedUpTo, active] — finished neighbours merged for the UI bar
    const segs = [];
    for (const s of item.segments) {
      const rt = this.rt.get(s);
      const p = rt ? rt.recvPos : s.pos;
      const active = rt && rt.worker ? 1 : 0;
      const done = s.end != null && p > s.end;
      const prev = segs[segs.length - 1];
      if (done && prev && prev[2] > prev[1] && !prev[3] && prev[1] + 1 === s.start) { prev[1] = s.end; prev[2] = s.end + 1; continue; }
      segs.push([s.start, s.end, p, active]);
    }
    return {
      downloaded,
      speed: this.running ? Math.round(this.speed) : 0,
      eta: this.eta(downloaded),
      connections: this.workers.size,
      maxConnections: this.running ? this.maxConns : 0,
      segments: segs.length > 200 ? null : segs,
    };
  }

  /**
   * Seconds left. Based on the average speed over the last half minute (since the
   * download last (re)started), blended with the current speed so real changes still
   * show within seconds. null while there is nothing honest to say (reconnecting,
   * waiting, size unknown, or not enough data yet).
   */
  eta(downloaded) {
    const item = this.item;
    if (!this.running || item.status !== 'downloading' || item.size == null) return null;
    const h = this.hist;
    if (h.length < 4) return null;
    const a = h[0]; const b = h[h.length - 1];
    const avg = (b.received - a.received) / ((b.mono - a.mono) / 1000);
    const rate = avg > 0 ? 0.8 * avg + 0.2 * this.speed : this.speed;
    if (!(rate > 0)) return null;
    return Math.max(0, Math.round((item.size - downloaded) / rate));
  }
}

module.exports = { HttpDownload, parseContentRange, probe, autoConnections, SPEEDS };
