'use strict';
const fs = require('fs');
const path = require('path');

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** Make a string safe to use as a Windows/Linux/macOS file name. */
function sanitizeFilename(name, fallback = 'download') {
  let n = String(name || '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .trim()
    .replace(/[. ]+$/, '');
  if (!n || n === '.' || n === '..') n = fallback;
  if (RESERVED.test(n)) n = '_' + n;
  if (n.length > 200) {
    const ext = path.extname(n).slice(0, 20);
    n = n.slice(0, 200 - ext.length) + ext;
  }
  return n;
}

/** Parse a Content-Disposition header, honouring RFC 5987 filename*=. */
function filenameFromDisposition(header) {
  if (!header) return null;
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (star) {
    try {
      const raw = star[2].trim().replace(/^"|"$/g, '');
      return decodeURIComponent(raw);
    } catch { /* fall through */ }
  }
  const plain = /filename\s*=\s*("((?:\\.|[^"\\])*)"|[^;]+)/i.exec(header);
  if (plain) {
    let v = plain[2] !== undefined ? plain[2].replace(/\\(.)/g, '$1') : plain[1].trim();
    // Servers often send raw UTF-8 bytes decoded as latin1.
    try {
      const bytes = Buffer.from(v, 'latin1');
      const utf8 = bytes.toString('utf8');
      if (!utf8.includes('\uFFFD')) v = utf8;
    } catch { /* keep v */ }
    return v;
  }
  return null;
}

function filenameFromUrl(u) {
  try {
    const p = new URL(u).pathname;
    const last = p.split('/').filter(Boolean).pop();
    if (last) return decodeURIComponent(last);
  } catch { /* ignore */ }
  return null;
}

const MIME_EXT = {
  'application/zip': '.zip', 'application/x-7z-compressed': '.7z', 'application/x-rar-compressed': '.rar',
  'application/vnd.rar': '.rar', 'application/gzip': '.gz', 'application/x-tar': '.tar',
  'application/pdf': '.pdf', 'application/x-msdownload': '.exe', 'application/x-msi': '.msi',
  'application/vnd.android.package-archive': '.apk', 'application/x-iso9660-image': '.iso',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/x-matroska': '.mkv', 'video/quicktime': '.mov',
  'video/mp2t': '.ts', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/ogg': '.ogg', 'audio/wav': '.wav',
  'audio/flac': '.flac', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
  'text/plain': '.txt', 'application/json': '.json', 'text/html': '.html',
};

function extFromMime(mime) {
  if (!mime) return '';
  return MIME_EXT[mime.split(';')[0].trim().toLowerCase()] || '';
}

const CATEGORIES = {
  Video: ['mp4', 'mkv', 'webm', 'avi', 'mov', 'wmv', 'flv', 'm4v', 'mpg', 'mpeg', '3gp', 'ts', 'm2ts'],
  Music: ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus', 'wma', 'alac'],
  Compressed: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'zst', 'tgz', 'iso', 'img', 'cab'],
  Programs: ['exe', 'msi', 'msix', 'appx', 'apk', 'aab', 'dmg', 'pkg', 'deb', 'rpm', 'appimage', 'bat', 'jar'],
  Documents: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'odt', 'ods', 'epub', 'csv', 'md'],
  Images: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'tif', 'tiff', 'heic', 'avif', 'psd'],
};

function categoryFor(filename) {
  const ext = path.extname(filename || '').slice(1).toLowerCase();
  for (const [cat, list] of Object.entries(CATEGORIES)) if (list.includes(ext)) return cat;
  return 'Other';
}

/** Return a path that does not exist yet: "a.zip" -> "a (1).zip" ... */
function uniquePath(dir, name, taken = new Set()) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  let i = 1;
  const exists = (p) => taken.has(p.toLowerCase()) || fs.existsSync(p) || fs.existsSync(p + '.bolt');
  while (exists(candidate)) candidate = path.join(dir, `${base} (${i++})${ext}`);
  return candidate;
}

/** Atomic JSON write: write temp file then rename over the original. */
function writeJsonAtomic(file, data, { backup = false, tmp = file + '.tmp' } = {}) {
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(data, null, 1));
    // on disk before the rename: a power cut must never leave a half-written file
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (backup) {
    // the previous version stays as .bak; readJsonWithBackup falls back to it
    try { renameWithRetrySync(file, file + '.bak'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  renameWithRetrySync(tmp, file);
}

/**
 * The same as writeJsonAtomic, without blocking the app: on a busy hard disk the flush
 * can take seconds, and a synchronous one stopped every download meanwhile.
 */
async function writeTextAtomic(file, text, { backup = false, sync = true } = {}) {
  const tmp = file + '.tmp';
  const fh = await fs.promises.open(tmp, 'w');
  try {
    await fh.writeFile(text);
    if (sync) await fh.sync();
  } finally {
    await fh.close();
  }
  if (backup) {
    try { await renameWithRetry(file, file + '.bak'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  await renameWithRetry(tmp, file);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

/**
 * Read a file written by writeJsonAtomic(…, { backup: true }). A damaged or
 * missing file falls back to the .bak; a damaged one is copied aside, never
 * just overwritten, so nothing about the downloads is lost without a trace.
 */
function readJsonWithBackup(file, fallback, onDamaged = () => {}, more = []) {
  for (const f of [file, file + '.bak', ...more]) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    try { return JSON.parse(text); } catch {
      const aside = `${f}.damaged-${Date.now()}`;
      try { fs.copyFileSync(f, aside); } catch { /* best effort */ }
      onDamaged(f, aside);
    }
  }
  return fallback;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameWithRetrySync(from, to, tries = 10) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(from, to); return; } catch (e) {
      if (i >= tries || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      sleepSync(50 * (i + 1));
    }
  }
}

/** Async rename that survives antivirus / indexer briefly locking the file. */
async function renameWithRetry(from, to, tries = 20) {
  for (let i = 0; ; i++) {
    try { await fs.promises.rename(from, to); return; } catch (e) {
      if (i >= tries || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      await new Promise((r) => setTimeout(r, 100 * (i + 1)));
    }
  }
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

module.exports = {
  sanitizeFilename, filenameFromDisposition, filenameFromUrl, extFromMime, categoryFor, CATEGORIES,
  uniquePath, writeJsonAtomic, writeTextAtomic, readJson, readJsonWithBackup, renameWithRetry, renameWithRetrySync, newId,
};
