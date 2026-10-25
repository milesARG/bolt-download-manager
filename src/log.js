'use strict';
// Plain-text log at %APPDATA%\BoltDM\logs\bolt.log (rotated at 5 MB), so a
// failed or stopped download can always be explained afterwards. Links are
// logged without their query string: that's where login tokens live.
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const LOG_DIR = path.join(DATA_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'bolt.log');
const MAX = 5 * 1024 * 1024;
let size = -1;

function rotate() {
  try { fs.renameSync(LOG_FILE, path.join(LOG_DIR, 'bolt.1.log')); } catch { /* ignore */ }
  size = 0;
}

function write(level, msg) {
  const line = `${new Date().toISOString()} ${level.padEnd(5)} ${msg}\n`;
  try {
    if (size < 0) { fs.mkdirSync(LOG_DIR, { recursive: true }); try { size = fs.statSync(LOG_FILE).size; } catch { size = 0; } }
    if (size > MAX) rotate();
    fs.appendFileSync(LOG_FILE, line);
    size += Buffer.byteLength(line);
  } catch { /* logging must never break downloads */ }
  if (process.env.BOLT_LOG_STDOUT) process.stdout.write(line);
}

const safeUrl = (u) => { try { const x = new URL(u); return x.host + x.pathname; } catch { return '?'; } };
const tag = (item) => `[${item.id} ${item.filename || safeUrl(item.url)}]`;

module.exports = {
  LOG_FILE,
  safeUrl,
  info: (msg) => write('INFO', msg),
  warn: (msg) => write('WARN', msg),
  error: (msg) => write('ERROR', msg),
  item: (item, msg, level = 'INFO') => write(level, `${tag(item)} ${msg}`),
};
