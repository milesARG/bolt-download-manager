'use strict';
// One benchmark download in a fresh process, for comparing two versions of Bolt.
//   node test/bench.js <codeRoot> <url> <outDir> [connections] [timeoutSec]
// <codeRoot> is a Bolt folder (this one, or a copy of an older version). Run versions
// alternately, each in a new process.
// Prints one JSON line: time, MB/s, CPU %, peak RSS, and the ETA the UI would show each second.
const fs = require('fs');
const os = require('os');
const path = require('path');
const [ROOT, URL_, OUT, CONNS, TIMEOUT] = process.argv.slice(2);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bolt-bench-'));
process.env.BOLT_DATA_DIR = dataDir;
fs.mkdirSync(OUT, { recursive: true });
const { Config } = require(path.join(ROOT, 'src/config'));
const { Manager } = require(path.join(ROOT, 'src/manager'));
const config = new Config();
config.update({ downloadDir: OUT, keepAwake: false });
const m = new Manager(config);
const t0 = performance.now();
const cpu0 = process.cpuUsage();
let peakRss = 0;
const samples = [];
const it = m.add({ url: URL_, dir: OUT, connections: Number(CONNS) || undefined });
const timer = setInterval(() => {
  const x = m.list().find((i) => i.id === it.id);
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  if (!x) return;
  const size = x.size || x.estSize;
  // what the UI shows: the engine's eta if it has one, else (size - done) / speed
  const eta = x.eta != null ? x.eta : (x.speed > 0 && size ? (size - x.downloaded) / x.speed : null);
  samples.push({ t: (performance.now() - t0) / 1000, done: x.downloaded, size, speed: x.speed, eta, status: x.status, conns: x.connections });
}, 1000);
const finish = async (ok, err) => {
  clearInterval(timer);
  const secs = (performance.now() - t0) / 1000;
  const c = process.cpuUsage(cpu0);
  const x = m.get(it.id);
  const out = {
    ok, err, secs: +secs.toFixed(2), size: x.size, mbps: x.size ? +(x.size / 1e6 / secs).toFixed(2) : null,
    cpuPct: +(((c.user + c.system) / 1000) / (secs * 1000) * 100).toFixed(1), peakRssMB: +(peakRss / 1048576).toFixed(0),
    file: x.savePath, bytesDoneAt, dataDir: ok ? null : dataDir, samples,
  };
  console.log(JSON.stringify(out));
  await m.shutdown();
  if (ok) fs.rmSync(dataDir, { recursive: true, force: true });   // keep the log of a failed run
  process.exit(0);
};
m.on('completed', (x) => { if (x.id === it.id) finish(true); });
let bytesDoneAt = null;
m.on('item', (x) => {
  if (x.id !== it.id) return;
  if (x.status === 'finishing' && bytesDoneAt == null) bytesDoneAt = (performance.now() - t0) / 1000;
  if (x.status === 'error') finish(false, x.error);
});
setTimeout(() => finish(false, 'timeout'), (Number(TIMEOUT) || 600) * 1000);
