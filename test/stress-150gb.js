'use strict';
// 150 GB stress test: a real download from a local server, Bolt hard-killed at 10, 25, 50,
// 66.7 (= 100 GB of 150), 75, 90 and 99 % and once while finishing, one 15 s server outage,
// one simulated reboot (Bolt must continue from the flushed positions), then every byte
// compared with what the server sent. Needs <bytes> of free space in <outDir>.
//   node test/stress-150gb.js <outDir> [bytes = 150000000000]
// The report (kills, bytes kept, memory, CPU, timings) is written to <outDir>/report.json.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const [OUT_ARG, SIZE_ARG] = process.argv.slice(2);
if (!OUT_ARG) { console.error('usage: node test/stress-150gb.js <outDir> [bytes]'); process.exit(2); }
const ROOT = path.join(__dirname, '..');
const OUT = path.resolve(OUT_ARG);
const SIZE = Number(SIZE_ARG || 150e9);
const REPORT = path.join(OUT, 'report.json');
fs.mkdirSync(OUT, { recursive: true });
const { startServer, virtualByte } = require(path.join(ROOT, 'test', 'test-server'));
const DATA = path.join(OUT, '_data');
fs.mkdirSync(DATA, { recursive: true });
const report = { size: SIZE, started: new Date().toISOString(), kills: [], outage: null, reboot: null, samples: [] };
const save = () => fs.writeFileSync(REPORT, JSON.stringify(report, null, 1));
const log = (...a) => { console.log(new Date().toISOString().slice(11, 19), ...a); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const KILLS = [0.10, 0.25, 0.50, 100e9 / 150e9, 0.75, 0.90, 0.99];
const OUTAGE_AT = 0.40;
const REBOOT_KILL = 0.90;   // this restart pretends the PC rebooted in between

(async () => {
  let server = await startServer(OUT);
  const port = server.port;
  const url = `${server.url}/virtual/${SIZE}`;
  log('server', url);
  let killIdx = 0; let outageDone = false; let finishingKilled = false; let done = null;
  let lastSampleAt = 0;
  const t0 = Date.now();
  while (!done) {
    const env = { ...process.env, BOLT_DATA_DIR: DATA, UV_THREADPOOL_SIZE: '16' };
    const rebootRun = report.kills.length && report.kills[report.kills.length - 1].reboot;
    if (rebootRun) env.BOLT_BOOT_TIME = String(Date.now());   // "booted" after the last save
    const child = spawn(process.execPath, [path.join(__dirname, 'child-big.js'), ROOT, url, OUT], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = ''; let last = null; let startInfo = null; let killedAt = null; let exited = false;
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('exit', () => { exited = true; });
    const kill = (why, extra = {}) => {
      if (killedAt) return;
      killedAt = { why, at: Date.now(), received: last ? last.downloaded : 0, ...extra };
      spawnSync('taskkill', ['/F', '/PID', String(child.pid)]);
    };
    child.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) {
        let e; try { e = JSON.parse(l); } catch { continue; }
        if (e.ev === 'start') {
          startInfo = e;
          const prev = report.kills[report.kills.length - 1];
          if (prev && prev.resumedAt == null) {
            prev.resumedAt = e.committed;
            prev.lostBytes = Math.max(0, prev.received - e.committed);
            log(`restarted: ${(e.committed / 1e9).toFixed(2)} GB kept of ${(prev.received / 1e9).toFixed(2)} GB received at the kill (${(prev.lostBytes / 1e6).toFixed(0)} MB to fetch again)`);
          }
        } else if (e.ev === 'p') {
          last = e;
          if (Date.now() - lastSampleAt > 10000) { lastSampleAt = Date.now(); report.samples.push({ t: (Date.now() - t0) / 1000, ...e }); save(); }
          const frac = e.downloaded / SIZE;
          if (!outageDone && frac >= OUTAGE_AT && e.status === 'downloading') {
            outageDone = true;
            log(`server outage at ${(frac * 100).toFixed(1)}%`);
            report.outage = { at: frac, start: Date.now() };
            server.close().then(async () => {
              await sleep(15000);
              server = await startServer(OUT, port);
              report.outage.end = Date.now();
              log('server back');
            });
          }
          if (killIdx < KILLS.length && frac >= KILLS[killIdx] && e.status === 'downloading') {
            const target = KILLS[killIdx++];
            log(`kill at ${(frac * 100).toFixed(1)}% (target ${(target * 100).toFixed(1)}%), ${(e.downloaded / 1e9).toFixed(2)} GB, ${e.speed / 1e6 | 0} MB/s, rss ${e.rssMB} MB, cpu ${e.cpuPct}%`);
            kill('percent', { target, reboot: target === REBOOT_KILL, rssMB: e.rssMB, cpuPct: e.cpuPct });
          }
        } else if (e.ev === 'finishing' && !finishingKilled) {
          finishingKilled = true;
          log('kill during finishing');
          kill('finishing');
        } else if (e.ev === 'done') {
          done = e;
        }
      }
    });
    while (!exited) await sleep(200);
    if (killedAt) {
      report.kills.push({ ...killedAt, resumedAt: null });
      save();
      await sleep(1500);   // like the supervisor's restart delay
    } else if (!done) {
      throw new Error('Bolt exited without finishing and without being killed: ' + JSON.stringify(last));
    }
  }
  report.downloadSecs = (Date.now() - t0) / 1000;
  log(`finished in ${(report.downloadSecs / 60).toFixed(1)} min: ${done.savePath}`);
  save();
  // every byte against the server's pattern
  const P = 65521;
  const CH = 8 << 20;
  const rep = Buffer.alloc(CH + P);
  for (let i = 0; i < rep.length; i++) rep[i] = virtualByte(i);
  const fd = fs.openSync(done.savePath, 'r');
  const st = fs.fstatSync(fd);
  if (st.size !== SIZE) throw new Error(`size ${st.size}, want ${SIZE}`);
  const b = Buffer.alloc(CH);
  const v0 = Date.now();
  let bad = null;
  for (let off = 0; off < SIZE; off += CH) {
    const n = fs.readSync(fd, b, 0, Math.min(CH, SIZE - off), off);
    const s = off % P;
    if (Buffer.compare(b.subarray(0, n), rep.subarray(s, s + n)) !== 0) {
      for (let i = 0; i < n; i++) if (b[i] !== rep[s + i]) { bad = off + i; break; }
      break;
    }
    if (off % (10e9 - (10e9 % CH)) === 0 && off) log(`verified ${(off / 1e9).toFixed(0)} GB`);
  }
  fs.closeSync(fd);
  report.verifySecs = (Date.now() - v0) / 1000;
  report.verified = bad == null;
  report.firstBadByte = bad;
  report.finished = new Date().toISOString();
  save();
  log(bad == null ? `ALL ${SIZE} BYTES VERIFIED in ${(report.verifySecs / 60).toFixed(1)} min` : `CORRUPT at byte ${bad}`);
  // a passed run cleans up its (huge) test file, like the test suite does; a failed one keeps it
  if (bad == null && !process.argv.includes('--keep')) { fs.rmSync(done.savePath, { force: true }); fs.rmSync(DATA, { recursive: true, force: true }); }
  await server.close();
  process.exit(bad == null ? 0 : 1);
})().catch((e) => { report.error = e.stack; save(); console.error(e); process.exit(2); });
