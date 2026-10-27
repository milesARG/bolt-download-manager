'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readJson, writeJsonAtomic } = require('./util');

const DATA_DIR = process.env.BOLT_DATA_DIR || path.join(
  process.env.APPDATA || path.join(os.homedir(), '.config'), 'BoltDM');

const DEFAULTS = {
  port: 9614,
  downloadDir: path.join(os.homedir(), 'Downloads'),
  sortIntoCategories: false,     // Downloads\Video, Downloads\Music, ...
  connections: 0,                // connections per download, 0 = Auto (by file size)
  // Total connections to one server across ALL downloads, 0 = no total limit:
  // every download keeps its own connections, so one never slows another down.
  // (A server that does limit connections refuses the extras; Bolt then backs off by itself.)
  maxConnectionsPerHost: 0,
  maxConcurrent: 0,              // downloads running at the same time, 0 = unlimited
  speedLimit: 0,                 // bytes/sec across everything, 0 = unlimited
  minSplitSize: 1024 * 1024,     // never split a piece smaller than 2x this
  maxRetries: 0,                 // 0 = keep retrying forever (network loss)
  stallTimeout: 20,              // seconds without data before reconnecting
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  remuxHlsToMp4: true,           // needs ffmpeg on PATH
  notify: true,
  keepAwake: true,               // stop Windows from sleeping while something downloads
  startWithWindows: false,       // Startup-folder shortcut, managed by the server
  extensionSeen: false,          // the browser extension has talked to Bolt at least once
  // your own categories, e.g. { name: 'Games', dir: 'D:\\games', exts: 'iso rar' }:
  // picking one saves to its folder; exts let Bolt pick it by itself
  categories: [],
  configVersion: 3,
};

const LIMITS = {
  port: [1024, 65535], connections: [0, 32], maxConnectionsPerHost: [0, 4096],
  maxConcurrent: [0, 100000], speedLimit: [0, 1e12], minSplitSize: [64 * 1024, 64 * 1024 * 1024],
  maxRetries: [0, 1000], stallTimeout: [5, 600],
};

/** Keep only valid categories: a name and an absolute folder; names unique (case-insensitive). */
function cleanCategories(list) {
  const out = []; const seen = new Set();
  for (const c of list.slice(0, 100)) {
    if (!c || typeof c !== 'object') continue;
    const name = String(c.name || '').replace(/[\x00-\x1f]/g, '').trim().slice(0, 40);
    const dir = String(c.dir || '').trim();
    if (!name || !dir || !path.isAbsolute(dir) || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const exts = String(c.exts || '').toLowerCase().split(/[\s,;]+/).map((e) => e.replace(/^\*?\./, '')).filter((e) => /^[a-z0-9]{1,10}$/.test(e)).join(' ');
    out.push({ name, dir: path.normalize(dir), exts });
  }
  return out;
}

/** The category for a file: the one named, or the first whose file types match. */
function categoryFor(categories, filename, name) {
  if (name) return categories.find((c) => c.name.toLowerCase() === String(name).toLowerCase()) || null;
  const ext = path.extname(filename || '').slice(1).toLowerCase();
  return (ext && categories.find((c) => c.exts.split(' ').includes(ext))) || null;
}

class Config {
  constructor() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    this.file = path.join(DATA_DIR, 'settings.json');
    const saved = readJson(this.file, {});
    this.values = { ...DEFAULTS, ...saved };
    if (!saved.configVersion || saved.configVersion < 2) {
      // v1 had fixed 8 connections and a 16-per-server cap, which kept big
      // files from ever using the Max (32) setting. Move to the new defaults.
      if (saved.connections === 8 || saved.connections == null) this.values.connections = 0;
      if (saved.maxConnectionsPerHost == null || saved.maxConnectionsPerHost === 16) this.values.maxConnectionsPerHost = 32;
    }
    if (!saved.configVersion || saved.configVersion < 3) {
      // v2 capped simultaneous downloads at 3 and shared 32 connections per server
      // between all downloads, so parallel downloads slowed each other (measured: 39%).
      if (saved.maxConcurrent == null || saved.maxConcurrent === 3) this.values.maxConcurrent = 0;
      if (saved.maxConnectionsPerHost == null || [16, 32].includes(saved.maxConnectionsPerHost)) this.values.maxConnectionsPerHost = 0;
    }
    if (saved.configVersion !== DEFAULTS.configVersion) {
      this.values.configVersion = DEFAULTS.configVersion;
      try { writeJsonAtomic(this.file, this.values); } catch { /* read-only is fine */ }
    }
  }
  get(k) { return this.values[k]; }
  all() { return { ...this.values }; }
  update(patch) {
    for (const [k, v] of Object.entries(patch || {})) {
      if (!(k in DEFAULTS) || k === 'configVersion') continue;
      if (k === 'categories') { if (Array.isArray(v)) this.values.categories = cleanCategories(v); continue; }
      if (typeof DEFAULTS[k] === 'number') {
        const n = Number(v);
        if (!Number.isFinite(n)) continue;
        const [lo, hi] = LIMITS[k] || [-Infinity, Infinity];
        this.values[k] = Math.min(hi, Math.max(lo, Math.round(n)));
      } else if (typeof DEFAULTS[k] === 'boolean') {
        this.values[k] = Boolean(v);
      } else if (typeof v === 'string' && v.trim()) {
        this.values[k] = v.trim();
      }
    }
    fs.mkdirSync(this.values.downloadDir, { recursive: true });
    writeJsonAtomic(this.file, this.values);
    return this.all();
  }
}

module.exports = { Config, DATA_DIR, DEFAULTS, cleanCategories, categoryFor };
