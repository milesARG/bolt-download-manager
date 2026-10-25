'use strict';
/*
 * Video pages of sites that stream DASH / split audio+video (YouTube, Vimeo...)
 * can't be grabbed from network traffic, so they are handed to yt-dlp (found
 * on PATH). Two steps: read the video info once (-J), then download from that
 * info into a temp folder next to the target, merging to .mp4 with ffmpeg.
 * Pausing kills the process; starting again continues the partial files.
 */
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const { findFfmpeg } = require('./hls');
const util = require('./util');

const INSTALL_HINT = 'yt-dlp is needed for this site but was not found. Install it with "winget install yt-dlp" (or get it from github.com/yt-dlp/yt-dlp), then restart Bolt';

// Page hosts that go to yt-dlp instead of being downloaded directly.
const SITES = ['youtube.com', 'youtu.be', 'youtube-nocookie.com', 'vimeo.com', 'dailymotion.com', 'dai.ly', 'twitch.tv',
  'tiktok.com', 'instagram.com', 'facebook.com', 'fb.watch', 'x.com', 'twitter.com', 'reddit.com', 'v.redd.it', 'bilibili.com'];
const FILE_EXTS = new Set([...Object.values(util.CATEGORIES).flat(), 'm3u8', 'mpd']);

/** True for a video page on a site yt-dlp handles (not a direct file link on it). */
function isSitePage(url) {
  let u;
  try { u = url instanceof URL ? url : new URL(url); } catch { return false; }
  const h = u.hostname.toLowerCase();
  if (!SITES.some((s) => h === s || h.endsWith('.' + s))) return false;
  const ext = path.extname(u.pathname).slice(1).toLowerCase();
  return !FILE_EXTS.has(ext);
}

const PROGRESS = 'bolt-dl %(progress.status)s %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.fragment_index)s %(progress.fragment_count)s %(info.format_id)s';

/** Parse one line printed with the PROGRESS template ("NA" = unknown). */
function parseProgress(line) {
  const m = /^bolt-dl (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (.*)$/.exec(String(line).trim());
  if (!m) return null;
  const num = (s) => { const n = Number(s); return Number.isFinite(n) ? n : null; };
  return {
    status: m[1], downloaded: num(m[2]), total: num(m[3]), estimate: num(m[4]), speed: num(m[5]),
    fragIndex: num(m[6]), fragCount: num(m[7]), formatId: m[8].trim(),
  };
}

// The last "ERROR: ..." line of yt-dlp's stderr, without the "[site] id: " prefix.
function lastError(stderr) {
  const lines = String(stderr).split(/\r?\n/).filter((l) => l.startsWith('ERROR:'));
  if (!lines.length) return null;
  return lines.pop().replace(/^ERROR:\s*/, '').replace(/^\[[\w:.-]+\] [\w-]+: /, '').slice(0, 300);
}

// Network trouble worth retrying; anything else (unavailable, private, DRM...) is final.
const TRANSIENT = /timed? ?out|temporar|connection|network|getaddrinfo|unreachable|reset by peer|HTTP Error (429|5\d\d)|WinError 100\d\d/i;

const tmpl = (s) => s.replace(/%/g, '%%');   // literal text inside an output template

let found = null;
/** Locate yt-dlp: PATH first, then winget's folders (for a Bolt started before the install). */
async function findYtdlp() {
  if (found) return found;
  const candidates = ['yt-dlp'];
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const winget = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet');
    candidates.push(path.join(winget, 'Links', 'yt-dlp.exe'));
    // winget doesn't always create the link; the package folder is then only on the new PATH
    try {
      for (const d of fs.readdirSync(path.join(winget, 'Packages'))) {
        if (/^yt-dlp\.yt-dlp_/i.test(d)) candidates.push(path.join(winget, 'Packages', d, 'yt-dlp.exe'));
      }
    } catch { /* no winget packages */ }
  }
  for (const bin of candidates) {
    const version = await new Promise((resolve) => {
      let out = '';
      const p = spawn(bin, ['--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      p.stdout.on('data', (d) => { out += d; });
      p.on('error', () => resolve(null));
      p.on('close', (c) => resolve(c === 0 ? out.trim() : null));
    });
    // a miss is not cached: the user may install it while Bolt runs
    if (version) return (found = { bin, version });
  }
  return null;
}

/**
 * Windows doesn't end child processes with their parent: after Bolt was killed, its yt-dlp
 * may still be writing the partial files. Stop it first, so two never write the same file.
 * Only if that pid really is yt-dlp (pids get reused).
 */
function killLeftover(item) {
  const pid = item.ytdlpPid;
  item.ytdlpPid = null;
  if (!pid || process.platform !== 'win32') return Promise.resolve();
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5000 }, (err, out) => {
      if (err || !/yt-dlp/i.test(out)) return resolve();
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => setTimeout(resolve, 500));
    });
  });
}

class YtdlpDownload extends EventEmitter {
  constructor(item, ctx) {
    super();
    this.item = item;
    this.ctx = ctx;
    this.running = false;
    this.proc = null;
    this.restart = false;
    this.speed = 0;
    this.dirty = false;
  }

  get tmpDir() { return this.item.savePath + '.bolt-ytdlp'; }
  get infoFile() { return path.join(this.tmpDir, 'info.json'); }

  setStatus(s) {
    if (this.item.status === s) return;
    this.item.status = s;
    this.dirty = true;
    this.emit('update');
  }

  /** yt-dlp takes its rate limit at launch, so a running download is restarted. */
  setLimit(bps) {
    this.item.speedLimit = bps;
    if (this.proc && this.phase === 'download') { this.restart = true; this.kill(); }
  }

  commonArgs(y) {
    const cfg = this.ctx.config;
    const retries = String(cfg.get('maxRetries') || 'infinite');
    const a = ['--ignore-config', '--no-playlist', '--newline', '--no-mtime', '--socket-timeout', String(cfg.get('stallTimeout')),
      '--retries', retries, '--fragment-retries', retries];
    // Recent yt-dlp needs a JavaScript runtime for YouTube; Node is already here.
    if (y.version >= '2025.11.12') a.push('--js-runtimes', 'node:' + process.execPath);
    const it = this.item;
    if (it.referrer && it.referrer !== it.url) a.push('--referer', it.referrer);
    return a;
  }

  formatArgs(ffmpeg) {
    // Best resolution; at equal resolution H.264 + AAC, which every player opens
    // (YouTube's AV1/VP9 need extra codecs on Windows). Above 1080p only those exist.
    // Without ffmpeg nothing can be merged: take the best single-file mp4.
    return ffmpeg ? ['-f', 'bv*+ba/b', '-S', 'res,vcodec:h264,ext:mp4:m4a', '--merge-output-format', 'mp4'] : ['-f', 'b[ext=mp4]/b'];
  }

  async start() {
    if (this.running) return;
    const item = this.item;
    this.running = true;
    item.error = null;
    this.setStatus('connecting');
    try {
      await killLeftover(item);
      const y = await findYtdlp();
      if (!y) throw new Error(INSTALL_HINT);
      const ffmpeg = await findFfmpeg();
      if (!ffmpeg) item.note = 'ffmpeg is not installed, so only single-file qualities (often 720p or less) can be downloaded';
      const maxRetries = this.ctx.config.get('maxRetries');
      for (let attempt = 1; ; attempt++) {
        try {
          if (!item.ytdlp || !item.savePath || !fs.existsSync(this.infoFile)) await this.probe(y, ffmpeg);
          await this.download(y, ffmpeg);
          break;
        } catch (e) {
          if (!this.running || e.name === 'AbortError') throw e;
          if (!TRANSIENT.test(e.message) || (maxRetries > 0 && attempt > maxRetries)) throw e;
          const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt - 1, 5));
          item.error = `${e.message} — retrying in ${Math.round(delay / 1000)}s`;
          this.setStatus('retrying');
          await new Promise((r) => setTimeout(r, delay));
          if (!this.running) throw Object.assign(new Error('stopped'), { name: 'AbortError' });
          item.error = null;
          this.setStatus('connecting');
        }
      }
      if (!this.running) return;
      await this.finish();
    } catch (e) {
      if (!this.running || e.name === 'AbortError') return;
      this.running = false;
      this.speed = 0;
      item.error = e.message;
      this.setStatus('error');
      this.emit('failed', e);
    }
  }

  /** Read the video info, pick the file name and remember the streams to fetch. */
  async probe(y, ffmpeg) {
    const item = this.item;
    this.phase = 'probe';
    const out = await this.run(y.bin, [...this.commonArgs(y), ...this.formatArgs(ffmpeg), '--flat-playlist', '-J', '--', item.url], true);
    let info;
    try { info = JSON.parse(out); } catch { throw new Error('yt-dlp returned no video information'); }
    if (info._type === 'playlist') {
      const n = Array.isArray(info.entries) ? info.entries.length : 0;
      throw new Error(`This is a playlist${n ? ` of ${n} videos` : ''}; add the page of a single video`);
    }
    if (!item.savePath) {
      const base = item.filename ? item.filename.replace(/\.[^.]+$/, '') : (info.title || info.id || 'video');
      const name = `${util.sanitizeFilename(base, 'video').slice(0, 150).trim()}.${info.ext || 'mp4'}`;
      const cfg = this.ctx.config;
      const dir = item.dir || (cfg.get('sortIntoCategories') ? path.join(cfg.get('downloadDir'), 'Video') : cfg.get('downloadDir'));
      await fs.promises.mkdir(dir, { recursive: true });
      item.savePath = this.ctx.reservePath(dir, name);
      item.filename = path.basename(item.savePath);
    }
    await fs.promises.mkdir(this.tmpDir, { recursive: true });
    await fs.promises.writeFile(this.infoFile, out);
    const formats = Array.isArray(info.requested_formats) && info.requested_formats.length ? info.requested_formats : [info];
    item.ytdlp = { parts: formats.map((f) => ({ id: String(f.format_id), size: f.filesize || f.filesize_approx || null, exact: !!f.filesize, done: 0, finished: false })) };
    item.quality = info.height ? `${info.height}p` : info.resolution || null;
    item.category = 'Video';
    item.resumable = true;
    this.dirty = true;
    this.emit('update');
  }

  async download(y, ffmpeg) {
    const item = this.item;
    const cfg = this.ctx.config;
    this.phase = 'download';
    do {
      this.restart = false;
      // Short names inside the temp folder: "<title>.f137.mp4.part" next to a long title
      // would pass Windows' 260-character path limit. finish() gives the file its name.
      const args = [...this.commonArgs(y), ...this.formatArgs(ffmpeg),
        '--load-info-json', this.infoFile, '--continue',
        '-P', this.tmpDir, '-o', 'video.%(ext)s',
        '-N', String(Math.max(1, item.connections || cfg.get('connections'))),
        '--progress', '--progress-template', 'download:' + PROGRESS,
        '--progress-template', 'postprocess:bolt-pp %(progress.status)s',
        // the final path is written as UTF-8; piped stdout may not be on Windows
        '--print-to-file', 'after_move:filepath', tmpl(path.join(this.tmpDir, 'done.txt'))];
      // the global limit can't be shared with another process, so use the lower of the two
      const limits = [item.speedLimit, cfg.get('speedLimit')].filter((n) => n > 0);
      if (limits.length) args.push('--limit-rate', String(Math.min(...limits)));
      await this.run(y.bin, args);
    } while (this.restart && this.running);
  }

  /** Run yt-dlp. Resolves with stdout when `capture`, else feeds the progress lines. */
  run(bin, args, capture = false) {
    // paused while looking for yt-dlp / between steps: never start a process nobody will kill
    if (!this.running) return Promise.reject(Object.assign(new Error('stopped'), { name: 'AbortError' }));
    return new Promise((resolve, reject) => {
      const p = spawn(bin, args, {
        windowsHide: true,
        detached: process.platform !== 'win32',   // own process group, so ffmpeg dies with it
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      });
      this.proc = p;
      // remembered so a Bolt that was killed can stop this yt-dlp before starting another
      this.item.ytdlpPid = p.pid;
      this.dirty = true;
      const out = []; let buf = ''; let err = '';
      p.stdout.on('data', (d) => {
        if (capture) { out.push(d); return; }
        buf += d;
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        for (const l of lines) this.onLine(l);
      });
      p.stderr.on('data', (d) => {
        err = (err + d).slice(-16000);
        // yt-dlp retries network errors itself and says so here
        const retry = String(d).split(/\r?\n/).filter((l) => /Retrying/.test(l)).pop();
        if (retry && this.running) { this.item.error = retry.replace(/^WARNING:\s*/, '').slice(0, 300); this.speed = 0; this.setStatus('retrying'); }
      });
      p.on('error', (e) => { this.proc = null; reject(e.code === 'ENOENT' ? new Error(INSTALL_HINT) : e); });
      p.on('close', (code) => {
        this.proc = null;
        this.item.ytdlpPid = null;
        if (!this.running) return reject(Object.assign(new Error('stopped'), { name: 'AbortError' }));
        if (this.restart) return resolve(null);
        if (code === 0) return resolve(Buffer.concat(out).toString('utf8'));
        reject(new Error(lastError(err) || `yt-dlp stopped with exit code ${code}`));
      });
    });
  }

  onLine(line) {
    if (line.startsWith('bolt-pp ')) { this.speed = 0; this.setStatus('finishing'); return; }
    const p = parseProgress(line);
    if (!p || !this.item.ytdlp) return;
    const parts = this.item.ytdlp.parts;
    let part = parts.find((x) => x.id === p.formatId);
    if (!part) { part = { id: p.formatId, size: null, done: 0, finished: false }; parts.push(part); }
    if (p.total) { part.size = p.total; part.exact = true; }
    // fragmented streams (HLS/DASH) only have a running estimate: smooth it
    else if (p.estimate && !part.exact) part.size = part.size ? Math.round(part.size * 0.8 + p.estimate * 0.2) : p.estimate;
    if (p.fragCount) part.frac = Math.min(1, (p.fragIndex || 0) / p.fragCount);
    if (p.status === 'finished') {
      part.done = (part.exact && part.size) || p.downloaded || part.done;
      part.size = part.done || part.size;
      part.finished = true;
      part.frac = 1;
      this.speed = 0;
    } else {
      if (p.downloaded != null) part.done = p.downloaded;
      if (p.speed != null) this.speed = p.speed;
    }
    this.lastProgress = Date.now();
    this.dirty = true;
    if (this.item.status !== 'downloading' && this.item.status !== 'finishing') { this.item.error = null; this.setStatus('downloading'); }
  }

  async finish() {
    const item = this.item;
    this.setStatus('finishing');
    let result = null;
    try {
      result = (await fs.promises.readFile(path.join(this.tmpDir, 'done.txt'), 'utf8')).split(/\r?\n/).filter(Boolean).pop();
    } catch { /* look for it below */ }
    if (!result || !fs.existsSync(result)) {
      const hit = (await fs.promises.readdir(this.tmpDir)).find((f) => /^video\.\w+$/.test(f) && !/\.(part|ytdl|temp)$/i.test(f));
      result = hit ? path.join(this.tmpDir, hit) : null;
    }
    if (!result) throw new Error('yt-dlp finished, but the downloaded file was not found');
    // the reserved name, with the extension yt-dlp really produced
    let target = item.savePath.slice(0, item.savePath.length - path.extname(item.savePath).length) + path.extname(result);
    if (fs.existsSync(target)) target = util.uniquePath(path.dirname(target), path.basename(target));
    await util.renameWithRetry(result, target);
    await fs.promises.rm(this.tmpDir, { recursive: true, force: true });
    const st = await fs.promises.stat(target);
    item.savePath = target;
    item.filename = path.basename(target);
    item.size = st.size;
    item.downloaded = st.size;
    item.category = util.categoryFor(target) === 'Music' ? 'Music' : 'Video';
    item.completedAt = Date.now();
    item.ytdlp = null;
    this.running = false;
    this.speed = 0;
    this.dirty = true;
    this.setStatus('completed');
    this.emit('done');
  }

  /** Kill yt-dlp and whatever it started (ffmpeg); resolves once it is gone. */
  kill() {
    const p = this.proc;
    if (!p) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, 5000);
      // the PyInstaller child can finish a last write just after the pipes close
      p.once('close', () => { clearTimeout(t); setTimeout(resolve, 500); });
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => p.kill());
      } else {
        try { process.kill(-p.pid, 'SIGTERM'); } catch { p.kill('SIGTERM'); }
      }
    });
  }

  async stop(status = 'paused') {
    if (this.running) {
      this.running = false;
      await this.kill();
    }
    this.speed = 0;
    this.dirty = true;
    this.setStatus(status);
  }

  stats() {
    const item = this.item;
    if (item.status === 'completed') return { downloaded: item.size, speed: 0, connections: 0, segments: null };
    const parts = (item.ytdlp && item.ytdlp.parts) || [];
    // progress per stream (by fragments when it has them, as byte estimates jump), weighted by size
    let done = 0; let total = 0; let known = parts.length > 0; let weighted = 0;
    for (const p of parts) {
      done += p.done || 0;
      if (p.size) total += p.size; else known = false;
      const frac = p.finished ? 1 : p.frac != null ? p.frac : p.size ? Math.min(1, (p.done || 0) / p.size) : 0;
      weighted += frac * (p.size || 0);
    }
    item.downloaded = done;
    const finished = parts.filter((p) => p.finished).length;
    return {
      downloaded: done,
      estSize: known ? Math.max(total, done) : null,
      progress: known && total ? Math.min(1, weighted / total) : parts.length ? finished / parts.length : 0,
      // no progress lines for a while (yt-dlp retrying, stalled): don't show the old speed
      speed: this.running && Date.now() - (this.lastProgress || 0) < 3000 ? Math.round(this.speed) : 0,
      connections: 0,
      segments: null,
    };
  }
}

module.exports = { YtdlpDownload, findYtdlp, isSitePage, parseProgress, lastError, INSTALL_HINT };
