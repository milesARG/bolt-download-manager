'use strict';
/*
 * HLS (.m3u8) stream downloader. Fetches the playlist, picks the best
 * quality, downloads the media segments over many parallel connections
 * (AES-128 decrypted on the fly), then joins them into one file. With ffmpeg
 * on PATH the result is remuxed to .mp4 and separate audio tracks are merged.
 * Finished segments are kept on disk, so it resumes after any interruption.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { request, HttpError, parseRetryAfter } = require('./http');
const { Throttle } = require('./throttle');
const util = require('./util');

function parseAttrs(s) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[2].replace(/^"|"$/g, '');
  return out;
}

function parsePlaylist(text, base) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U') throw new Error('Not an HLS playlist');
  const abs = (u) => new URL(u, base).href;
  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
    const variants = [];
    const media = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.startsWith('#EXT-X-STREAM-INF:')) {
        const a = parseAttrs(l.slice(18));
        let j = i + 1;
        while (j < lines.length && lines[j].startsWith('#')) j++;
        if (lines[j]) variants.push({ url: abs(lines[j]), bandwidth: Number(a.BANDWIDTH) || 0, resolution: a.RESOLUTION || '', audio: a.AUDIO || null });
      } else if (l.startsWith('#EXT-X-MEDIA:')) {
        const a = parseAttrs(l.slice(13));
        media.push({ type: a.TYPE, group: a['GROUP-ID'], uri: a.URI ? abs(a.URI) : null, isDefault: a.DEFAULT === 'YES', name: a.NAME });
      }
    }
    return { master: true, variants, media };
  }
  const segs = [];
  let seq = 0; let key = null; let map = null; let br = null; let lastEnd = 0; let ended = false;
  for (const l of lines) {
    if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = Number(l.slice(22)) || 0;
    else if (l.startsWith('#EXT-X-KEY:')) {
      const a = parseAttrs(l.slice(11));
      if (a.METHOD === 'NONE') key = null;
      else if (a.METHOD === 'AES-128') key = { uri: abs(a.URI), iv: a.IV || null };
      else throw new Error(`Encrypted stream (${a.METHOD}) is DRM protected and can't be downloaded`);
    } else if (l.startsWith('#EXT-X-MAP:')) {
      const a = parseAttrs(l.slice(11));
      map = { uri: abs(a.URI) };
      if (a.BYTERANGE) { const [n, o] = a.BYTERANGE.split('@').map(Number); map.range = [o || 0, (o || 0) + n - 1]; }
    } else if (l.startsWith('#EXT-X-BYTERANGE:')) {
      const [n, o] = l.slice(17).split('@').map(Number);
      const off = Number.isFinite(o) ? o : lastEnd;
      br = [off, off + n - 1];
      lastEnd = off + n;
    } else if (l === '#EXT-X-ENDLIST') ended = true;
    else if (!l.startsWith('#')) {
      segs.push({ uri: abs(l), seq, key, range: br, done: false });
      seq++;
      br = null;
    }
  }
  return { master: false, segments: segs, map, ended };
}

class HlsDownload extends EventEmitter {
  constructor(item, ctx) {
    super();
    this.item = item;
    this.ctx = ctx;
    this.throttle = new Throttle(item.speedLimit || 0);
    this.running = false;
    this.received = 0;
    this.speed = 0;
    this.active = new Set();
    this.keys = new Map();
    this.dirty = false;
  }

  get tmpDir() { return this.item.savePath + '.bolt-hls'; }

  headers() {
    const it = this.item;
    const h = { 'User-Agent': it.userAgent || this.ctx.config.get('userAgent') };
    if (it.referrer) { h.Referer = it.referrer; try { h.Origin = new URL(it.referrer).origin; } catch { /* ignore */ } }
    if (it.cookies) h.Cookie = it.cookies;
    return { ...h, ...(it.headers || {}) };
  }

  setStatus(s) {
    if (this.item.status === s) return;
    this.item.status = s;
    this.dirty = true;
    this.emit('update');
  }

  setLimit(bps) { this.item.speedLimit = bps; this.throttle.setRate(bps); }

  async fetchBuffer(url, range, signal) {
    const headers = this.headers();
    if (range) headers.Range = `bytes=${range[0]}-${range[1]}`;
    const { res, url: finalUrl } = await request(url, { headers, signal });
    if (res.statusCode >= 400) {
      res.resume();
      throw new HttpError(res.statusCode, `Server responded ${res.statusCode}`, parseRetryAfter(res.headers['retry-after']));
    }
    const chunks = [];
    const stall = this.ctx.config.get('stallTimeout') * 1000;
    await new Promise((resolve, reject) => {
      let timer = setTimeout(() => res.destroy(new Error('Connection stalled')), stall);
      res.on('data', (c) => {
        chunks.push(c);
        this.received += c.length;
        clearTimeout(timer);
        timer = setTimeout(() => res.destroy(new Error('Connection stalled')), stall);
        const d = Math.max(this.ctx.throttle.consume(c.length), this.throttle.consume(c.length));
        if (d > 0) { res.pause(); setTimeout(() => res.resume(), d); }
      });
      res.on('end', () => { clearTimeout(timer); resolve(); });
      res.on('error', (e) => { clearTimeout(timer); reject(e); });
      res.on('close', () => { clearTimeout(timer); if (!res.complete) reject(new Error('Connection lost')); });
    });
    return { buf: Buffer.concat(chunks), url: finalUrl, type: res.headers['content-type'] };
  }

  async withRetry(fn) {
    const maxRetries = this.ctx.config.get('maxRetries');
    for (let attempt = 1; ; attempt++) {
      try { return await fn(); } catch (e) {
        if (!this.running || e.name === 'AbortError') throw e;
        const fatal = e instanceof HttpError && ![408, 425, 429].includes(e.status) && e.status < 500;
        if (fatal || (maxRetries > 0 && attempt > maxRetries)) throw e;
        const delay = Math.max(e.retryAfter || 0, Math.min(30000, 1000 * 2 ** Math.min(attempt - 1, 5)));
        this.item.error = `${e.message} — retrying in ${Math.round(delay / 1000)}s`;
        this.emit('update');
        await new Promise((r) => setTimeout(r, delay));
        if (!this.running) throw Object.assign(new Error('stopped'), { name: 'AbortError' });
        this.item.error = null;
      }
    }
  }

  async loadPlaylist() {
    const item = this.item;
    const { buf, url } = await this.withRetry(() => this.fetchBuffer(item.url));
    let pl = parsePlaylist(buf.toString('utf8'), url);
    const tracks = [];
    if (pl.master) {
      const best = pl.variants.sort((a, b) => b.bandwidth - a.bandwidth)[0];
      if (!best) throw new Error('Playlist has no streams');
      item.quality = best.resolution || `${Math.round(best.bandwidth / 1000)} kbps`;
      const v = await this.withRetry(() => this.fetchBuffer(best.url));
      tracks.push({ name: 'v', ...parsePlaylist(v.buf.toString('utf8'), v.url) });
      if (best.audio) {
        const group = pl.media.filter((m) => m.type === 'AUDIO' && m.group === best.audio && m.uri);
        const a = group.find((m) => m.isDefault) || group[0];
        if (a) {
          const ab = await this.withRetry(() => this.fetchBuffer(a.uri));
          tracks.push({ name: 'a', ...parsePlaylist(ab.buf.toString('utf8'), ab.url) });
        }
      }
    } else {
      tracks.push({ name: 'v', ...pl });
    }
    for (const t of tracks) {
      if (!t.ended) throw new Error('This is a live stream; only finished videos (VOD) can be downloaded');
      if (!t.segments.length) throw new Error('Playlist has no segments');
    }

    if (!item.savePath) {
      let name = item.filename || util.filenameFromUrl(url) || 'video';
      name = util.sanitizeFilename(name).replace(/\.m3u8$/i, '');
      const ext = path.extname(name).toLowerCase();
      if (!['.mp4', '.ts', '.mkv'].includes(ext)) name += '.mp4';
      const cfg = this.ctx.config;
      const dir = item.dir || (cfg.get('sortIntoCategories') ? path.join(cfg.get('downloadDir'), 'Video') : cfg.get('downloadDir'));
      await fs.promises.mkdir(dir, { recursive: true });
      item.savePath = this.ctx.reservePath(dir, name);
      item.filename = path.basename(item.savePath);
    }
    item.category = 'Video';
    item.hls = { tracks: tracks.map((t) => ({ name: t.name, map: t.map, segments: t.segments.map((s) => ({ uri: s.uri, seq: s.seq, key: s.key, range: s.range, done: false, bytes: 0 })) })) };
    item.resumable = true;
    this.dirty = true;
  }

  async start() {
    if (this.running) return;
    const item = this.item;
    this.running = true;
    this.ac = new AbortController();
    item.error = null;
    this.setStatus('connecting');
    this.ticker = setInterval(() => this.tick(), 1000);
    this.lastTick = Date.now();
    this.lastReceived = this.received;
    try {
      if (!item.hls) await this.loadPlaylist();
      await fs.promises.mkdir(this.tmpDir, { recursive: true });
      // trust only segments whose file is really there
      for (const t of item.hls.tracks) for (const s of t.segments) {
        if (s.done && !fs.existsSync(this.segFile(t, s))) s.done = false;
      }
      this.setStatus('downloading');
      await this.downloadAll();
      if (!this.running) return;
      await this.join();
    } catch (e) {
      if (!this.running || e.name === 'AbortError') return;
      this.running = false;
      clearInterval(this.ticker);
      item.error = e.message;
      this.setStatus('error');
      this.emit('failed', e);
    }
  }

  segFile(t, s) { return path.join(this.tmpDir, `${t.name}_${String(s.seq).padStart(7, '0')}`); }

  async key(k) {
    if (!this.keys.has(k.uri)) {
      this.keys.set(k.uri, this.withRetry(() => this.fetchBuffer(k.uri, null, this.ac.signal)).then((r) => r.buf));
    }
    return this.keys.get(k.uri);
  }

  async downloadAll() {
    const item = this.item;
    const jobs = [];
    for (const t of item.hls.tracks) {
      if (t.map && !fs.existsSync(path.join(this.tmpDir, `${t.name}_init`))) jobs.push({ t, init: true });
      for (const s of t.segments) if (!s.done) jobs.push({ t, s });
    }
    const n = Math.max(1, item.connections || this.ctx.config.get('connections'));
    let next = 0;
    const worker = async () => {
      while (this.running && next < jobs.length) {
        const job = jobs[next++];
        this.active.add(job);
        try { await this.withRetry(() => this.fetchJob(job)); } finally { this.active.delete(job); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, worker));
  }

  async fetchJob({ t, s, init }) {
    if (init) {
      const { buf } = await this.fetchBuffer(t.map.uri, t.map.range, this.ac.signal);
      await fs.promises.writeFile(path.join(this.tmpDir, `${t.name}_init`), buf);
      return;
    }
    let { buf } = await this.fetchBuffer(s.uri, s.range, this.ac.signal);
    if (s.key) {
      const key = await this.key(s.key);
      let iv;
      if (s.key.iv) iv = Buffer.from(s.key.iv.replace(/^0x/i, '').padStart(32, '0'), 'hex');
      else { iv = Buffer.alloc(16); iv.writeBigUInt64BE(BigInt(s.seq), 8); }
      const d = crypto.createDecipheriv('aes-128-cbc', key, iv);
      buf = Buffer.concat([d.update(buf), d.final()]);
    }
    const f = this.segFile(t, s);
    await fs.promises.writeFile(f + '.tmp', buf);
    await util.renameWithRetry(f + '.tmp', f);
    s.done = true;
    s.bytes = buf.length;
    this.dirty = true;
  }

  async concatTrack(t, out) {
    const fh = await fs.promises.open(out, 'w');
    try {
      if (t.map) await fh.write(await fs.promises.readFile(path.join(this.tmpDir, `${t.name}_init`)));
      for (const s of t.segments) await fh.write(await fs.promises.readFile(this.segFile(t, s)));
    } finally {
      await fh.close();
    }
  }

  async join() {
    const item = this.item;
    this.setStatus('finishing');
    clearInterval(this.ticker);
    const tracks = item.hls.tracks;
    const parts = [];
    for (const t of tracks) {
      const ext = t.map ? '.mp4' : '.ts';
      const out = path.join(this.tmpDir, `joined_${t.name}${ext}`);
      await this.concatTrack(t, out);
      parts.push(out);
    }
    let target = item.savePath;
    const wantMp4 = path.extname(target).toLowerCase() === '.mp4';
    const ffmpeg = this.ctx.config.get('remuxHlsToMp4') ? await findFfmpeg() : null;
    if (ffmpeg && (wantMp4 || parts.length > 1)) {
      const args = ['-y', '-loglevel', 'error'];
      for (const p of parts) args.push('-i', p);
      args.push('-map', '0:v?', '-map', '0:a?');
      if (parts.length > 1) args.push('-map', '1:a?');
      args.push('-c', 'copy');
      if (wantMp4) args.push('-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart');
      const tmpOut = path.join(this.tmpDir, 'final' + path.extname(target));
      await runFfmpeg(ffmpeg, [...args, tmpOut]);
      if (fs.existsSync(target)) target = util.uniquePath(path.dirname(target), path.basename(target));
      await util.renameWithRetry(tmpOut, target);
    } else {
      // No ffmpeg: keep the stream as a .ts (plays in VLC / most players).
      const ext = path.extname(parts[0]);
      if (path.extname(target).toLowerCase() !== ext) target = target.replace(/\.[^.\\/]+$/, '') + ext;
      if (fs.existsSync(target)) target = util.uniquePath(path.dirname(target), path.basename(target));
      await util.renameWithRetry(parts[0], target);
      if (parts.length > 1) item.note = 'Audio is a separate track; install ffmpeg to merge it automatically';
    }
    await fs.promises.rm(this.tmpDir, { recursive: true, force: true });
    const st = await fs.promises.stat(target);
    item.savePath = target;
    item.filename = path.basename(target);
    item.size = st.size;
    item.downloaded = st.size;
    item.completedAt = Date.now();
    item.hls = null;
    this.running = false;
    this.speed = 0;
    this.dirty = true;
    this.setStatus('completed');
    this.emit('done');
  }

  async stop(status = 'paused') {
    if (this.running) {
      this.running = false;
      try { this.ac.abort(); } catch { /* ignore */ }
      clearInterval(this.ticker);
    }
    this.speed = 0;
    this.dirty = true;
    this.setStatus(status);
  }

  tick() {
    const now = Date.now();
    const inst = (this.received - this.lastReceived) / Math.max((now - this.lastTick) / 1000, 0.001);
    this.speed = this.speed ? this.speed * 0.6 + inst * 0.4 : inst;
    this.lastTick = now;
    this.lastReceived = this.received;
  }

  stats() {
    const item = this.item;
    let done = 0; let total = 0; let bytes = 0;
    if (item.hls) for (const t of item.hls.tracks) for (const s of t.segments) { total++; if (s.done) { done++; bytes += s.bytes; } }
    if (item.status === 'completed') return { downloaded: item.size, speed: 0, connections: 0, segments: null };
    item.downloaded = bytes;
    return {
      downloaded: bytes,
      // estimated final size from the average segment so far
      estSize: done ? Math.round((bytes / done) * total) : null,
      progress: total ? done / total : 0,
      hlsDone: done,
      hlsTotal: total,
      speed: this.running ? Math.round(this.speed) : 0,
      connections: this.active.size,
      segments: null,
    };
  }
}

let ffmpegPath;
function findFfmpeg() {
  if (ffmpegPath !== undefined) return Promise.resolve(ffmpegPath);
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-version'], { stdio: 'ignore', windowsHide: true });
    p.on('error', () => resolve((ffmpegPath = null)));
    p.on('exit', (c) => resolve((ffmpegPath = c === 0 ? 'ffmpeg' : null)));
  });
}

function runFfmpeg(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error('ffmpeg failed: ' + err.trim().slice(-300)))));
  });
}

module.exports = { HlsDownload, parsePlaylist, findFfmpeg };
