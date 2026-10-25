'use strict';
// Do simultaneous downloads slow each other down when the line is NOT the limit?
// A local server limits every connection to 1 MB/s (like many real servers), so
// any slowdown here comes from Bolt itself, not from the internet line.
//   node test/parallel-bench.js [count]
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bolt-par-'));
process.env.BOLT_DATA_DIR = path.join(ROOT, 'data');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'out');
fs.mkdirSync(SRC, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const { startServer } = require('./test-server');
const { Config } = require('../src/config');
const { Manager } = require('../src/manager');

const MB = 1 << 20;
const SIZE = 48 * MB;
const COUNT = Number(process.argv[2] || 4);

function waitDone(m, ids) {
  return new Promise((resolve, reject) => {
    const left = new Set(ids);
    const t0 = Date.now();
    const times = {};
    const on = (it) => {
      if (!left.has(it.id)) return;
      if (it.status === 'error') { m.off('item', on); reject(new Error(it.error)); }
      if (it.status === 'completed') { times[it.id] = (Date.now() - t0) / 1000; left.delete(it.id); if (!left.size) { m.off('item', on); resolve(times); } }
    };
    m.on('item', on);
  });
}

(async () => {
  fs.writeFileSync(path.join(SRC, 'f.bin'), crypto.randomBytes(SIZE));
  // the server runs in its own process, like a real one, so it doesn't share Bolt's CPU thread
  const sport = 40000 + Math.floor(Math.random() * 9000);
  const child = require('child_process').spawn(process.execPath, [path.join(__dirname, 'test-server.js'), SRC, String(sport)], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));
  const server = { port: sport, close: async () => child.kill() };
  const config = new Config();
  config.update({ downloadDir: OUT, keepAwake: false });
  const m = new Manager(config);
  const run = async (label, urls, conns) => {
    const c0 = process.cpuUsage(); const t0 = Date.now();
    const ids = urls.map((u) => m.add({ url: u, dir: OUT, connections: conns }).id);
    const times = await waitDone(m, ids);
    const c = process.cpuUsage(c0); const wall = (Date.now() - t0) * 1000;
    const speeds = Object.values(times).map((s) => SIZE / MB / s);
    const avg = speeds.reduce((a, b) => a + b, 0) / speeds.length;
    const total = (SIZE / MB * urls.length) / ((Date.now() - t0) / 1000);
    console.log(`${label.padEnd(52)} each ${avg.toFixed(1)} MB/s  total ${total.toFixed(0)} MB/s  Bolt's main thread ${Math.round(c.user / wall * 100)}% busy`);
    for (const id of ids) await m.remove(id, true);
    return avg;
  };
  let n = 0;
  const url = (host = '127.0.0.1') => `http://${host}:${server.port}/file/f.bin?rate=${Number(process.env.RATE || MB)}&n=${++n}`;
  console.log(`settings: maxConcurrent=${config.get('maxConcurrent')} maxConnectionsPerHost=${config.get('maxConnectionsPerHost')}`);
  const alone = await run('1 download, 16 connections', [url()], 16);
  const same = await run(`${COUNT} at once, same server, 16 connections each`, Array.from({ length: COUNT }, () => url()), 16);
  const hosts = ['127.0.0.1', 'localhost'];
  const diff = await run(`${COUNT} at once, 2 different servers, 16 each`, Array.from({ length: COUNT }, (_, i) => url(hosts[i % 2])), 16);
  console.log(`\nslowdown vs alone: same server ${((1 - same / alone) * 100).toFixed(0)}%, different servers ${((1 - diff / alone) * 100).toFixed(0)}%`);
  await m.shutdown();
  await server.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
