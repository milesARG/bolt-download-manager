'use strict';
// End-to-end engine tests against a local server. Every case is verified by
// SHA-256 against the source file.   node test/run-tests.js [--big] [--only name]
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bolt-test-'));
process.env.BOLT_DATA_DIR = path.join(ROOT, 'data');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'out');
fs.mkdirSync(SRC, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const { startServer } = require('./test-server');
const { Config } = require('../src/config');
const { Manager } = require('../src/manager');

const args = process.argv.slice(2);
const BIG = args.includes('--big');
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

function makeFile(name, size) {
  const p = path.join(SRC, name);
  const fd = fs.openSync(p, 'w');
  const block = crypto.randomBytes(4 << 20);
  for (let off = 0; off < size; off += block.length) {
    // vary each block so misplaced bytes are detected
    block.writeUInt32LE(off >>> 0, 0);
    fs.writeSync(fd, block, 0, Math.min(block.length, size - off));
  }
  fs.closeSync(fd);
  return p;
}

function sha(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

const fmt = (b) => (b / 1048576).toFixed(1) + ' MB';

function waitFor(m, id, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, timeoutMs);
    const onItem = (it) => {
      if (it.id !== id) return;
      if (it.status === 'completed') { cleanup(); resolve(it); }
      if (it.status === 'error') { cleanup(); reject(new Error('download error: ' + it.error)); }
    };
    const cleanup = () => { clearTimeout(t); m.off('item', onItem); };
    m.on('item', onItem);
  });
}

const results = [];
async function test(name, fn) {
  if (ONLY && !name.includes(ONLY)) return;
  const t0 = Date.now();
  try {
    const note = await fn();
    results.push([name, true, Date.now() - t0, note || '']);
    console.log(`  PASS  ${name}  (${((Date.now() - t0) / 1000).toFixed(1)}s) ${note || ''}`);
  } catch (e) {
    results.push([name, false, Date.now() - t0, e.message]);
    console.log(`  FAIL  ${name}: ${e.stack}`);
  }
}

(async () => {
  console.log('test dir:', ROOT);
  const small = makeFile('small.bin', 3 * 1024 * 1024 + 12345);
  const medium = makeFile('medium.bin', 64 * 1024 * 1024 + 777);
  const speed = makeFile('speed.bin', 8 * 1024 * 1024);
  const hashes = { small: await sha(small), medium: await sha(medium), speed: await sha(speed) };
  fs.writeFileSync(path.join(SRC, 'empty.bin'), '');

  let server = await startServer(SRC);
  const port = server.port;
  const base = () => server.url;
  const config = new Config();
  config.update({ downloadDir: OUT, maxConcurrent: 5, stallTimeout: 5 });
  const m = new Manager(config);

  const check = async (it, key) => {
    const h = await sha(it.savePath);
    if (h !== hashes[key]) throw new Error(`hash mismatch for ${it.savePath}`);
  };

  const dl = async (url, key, opts = {}) => {
    const it = m.add({ url, dir: OUT, ...opts });
    const done = await waitFor(m, it.id, opts.timeout);
    await check(done, key);
    return done;
  };

  await test('multi-connection download', async () => {
    server.stats.maxParallel = 0;
    const t0 = Date.now();
    await dl(`${base()}/file/medium.bin`, 'medium', { connections: 8 });
    const secs = (Date.now() - t0) / 1000;
    if (server.stats.maxParallel < 4) throw new Error('only ' + server.stats.maxParallel + ' parallel connections');
    return `${server.stats.maxParallel} parallel conns, ${fmt(64 * 1048576 / secs)}/s`;
  });

  await test('speed: 1 vs 8 connections on a per-connection-throttled server', async () => {
    const url = `${base()}/file/speed.bin?rate=${512 * 1024}`;
    let t0 = Date.now();
    await dl(url, 'speed', { connections: 1 });
    const one = (Date.now() - t0) / 1000;
    t0 = Date.now();
    await dl(url + '&x=2', 'speed', { connections: 8 });
    const eight = (Date.now() - t0) / 1000;
    if (eight > one / 2.5) throw new Error(`8 conns ${eight}s vs 1 conn ${one}s`);
    return `1 conn ${one.toFixed(1)}s, 8 conns ${eight.toFixed(1)}s (${(one / eight).toFixed(1)}x faster)`;
  });

  await test('connections randomly dropped mid-stream', async () => {
    await dl(`${base()}/file/medium.bin?drop=0.004`, 'medium', { connections: 8 });
  });

  await test('server ignores Range (single connection)', async () => {
    await dl(`${base()}/file/small.bin?norange=1`, 'small');
  });

  await test('no Content-Length (chunked)', async () => {
    await dl(`${base()}/file/small.bin?nolen=1`, 'small');
  });

  await test('redirect chain', async () => {
    const it = await dl(`${base()}/redirect/4/file/small.bin`, 'small');
    if (!it.filename.startsWith('small')) throw new Error('bad filename ' + it.filename);
  });

  await test('server sends short 206 responses', async () => {
    await dl(`${base()}/file/small.bin?cap=${300 * 1024}`, 'small');
  });

  await test('empty file', async () => {
    const it = m.add({ url: `${base()}/file/empty.bin`, dir: OUT });
    const done = await waitFor(m, it.id);
    if (fs.statSync(done.savePath).size !== 0) throw new Error('not empty');
  });

  await test('404 fails cleanly', async () => {
    const it = m.add({ url: `${base()}/file/nope.bin`, dir: OUT });
    try { await waitFor(m, it.id, 10000); } catch (e) {
      if (/404/.test(e.message)) return 'error: ' + m.get(it.id).error;
      throw e;
    }
    throw new Error('should have failed');
  });

  await test('pause and resume keeps progress', async () => {
    const it = m.add({ url: `${base()}/file/medium.bin?rate=${2 << 20}`, dir: OUT, connections: 4 });
    await new Promise((r) => setTimeout(r, 2500));
    await m.pause(it.id);
    const before = m.list().find((i) => i.id === it.id).downloaded;
    if (!before) throw new Error('nothing downloaded before pause');
    server.stats.requests = 0;
    m.resume(it.id);
    const done = await waitFor(m, it.id);
    await check(done, 'medium');
    return `paused at ${fmt(before)}`;
  });

  await test('server offline for 8s, resumes automatically', async () => {
    const it = m.add({ url: `${base()}/file/medium.bin?rate=${3 << 20}`, dir: OUT, connections: 4 });
    await new Promise((r) => setTimeout(r, 2000));
    await server.close();
    await new Promise((r) => setTimeout(r, 8000));
    const st = m.get(it.id).status;
    server = await startServer(SRC, port);
    const done = await waitFor(m, it.id);
    await check(done, 'medium');
    return `status while offline: ${st}`;
  });

  await test('process hard-killed mid-download, resumes from disk', async () => {
    const dataDir = path.join(ROOT, 'killdata');
    const env = { ...process.env, BOLT_DATA_DIR: dataDir };
    const url = `${base()}/file/medium.bin?rate=${3 << 20}`;
    const child = path.join(__dirname, 'child-download.js');
    const p1 = spawn(process.execPath, [child, url, OUT], { env, stdio: 'ignore' });
    // kill once some progress is saved (a fixed delay flaked when the PC was busy)
    const saved = () => {
      try {
        const it = JSON.parse(fs.readFileSync(path.join(dataDir, 'downloads.json'), 'utf8'))[0];
        return it && (it.segments || []).reduce((n, s) => n + s.pos - s.start, 0) > (4 << 20);
      } catch { return false; }
    };
    for (let t = Date.now(); !saved() && Date.now() - t < 20000;) await new Promise((r) => setTimeout(r, 100));
    p1.kill('SIGKILL');
    await new Promise((r) => p1.on('exit', r));
    // async spawn: the test server lives in this process and must keep serving
    const p2 = spawn(process.execPath, [child, url, OUT], { env });
    let stdout = ''; let stderr = '';
    p2.stdout.on('data', (d) => { stdout += d; });
    p2.stderr.on('data', (d) => { stderr += d; });
    await new Promise((r) => p2.on('exit', r));
    let out;
    try { out = JSON.parse(stdout.trim().split('\n').pop()); } catch {
      throw new Error('child output: ' + stdout + stderr);
    }
    if (!out.ok) throw new Error(out.error);
    if (!out.startBytes) throw new Error('no progress kept after kill');
    if ((await sha(out.savePath)) !== hashes.medium) throw new Error('hash mismatch after kill+resume');
    return `${fmt(out.startBytes)} survived the kill`;
  });

  await test('HLS stream (AES-128 encrypted) to mp4', async () => {
    const ff = spawnSync('ffmpeg', ['-version']);
    if (ff.status !== 0) return 'skipped (no ffmpeg)';
    const key = crypto.randomBytes(16);
    fs.writeFileSync(path.join(SRC, 'enc.key'), key);
    fs.writeFileSync(path.join(ROOT, 'keyinfo.txt'), `${base()}/file/enc.key\n${path.join(SRC, 'enc.key')}\n`);
    const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc=duration=12:size=320x240:rate=25',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest',
      '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_key_info_file', path.join(ROOT, 'keyinfo.txt'),
      '-hls_segment_filename', path.join(SRC, 'stream%03d.ts'), path.join(SRC, 'stream.m3u8')], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error('ffmpeg could not build test stream: ' + r.stderr);
    const it = m.add({ url: `${base()}/file/stream.m3u8`, dir: OUT, filename: 'test-video.mp4' });
    const done = await waitFor(m, it.id);
    const probe = spawnSync('ffmpeg', ['-v', 'error', '-i', done.savePath, '-f', 'null', '-'], { encoding: 'utf8' });
    if (probe.status !== 0 || probe.stderr.trim()) throw new Error('output not playable: ' + probe.stderr);
    const info = spawnSync('ffmpeg', ['-i', done.savePath], { encoding: 'utf8' }).stderr;
    const dur = /Duration: ([\d:.]+)/.exec(info);
    if (!/Video:/.test(info) || !/Audio:/.test(info)) throw new Error('missing audio or video track');
    return `${path.basename(done.savePath)} ${dur ? dur[1] : ''}, ${fmt(fs.statSync(done.savePath).size)}`;
  });

  await test('yt-dlp: site pages routed to it, progress lines parsed', async () => {
    const { isSitePage, parseProgress, lastError } = require('../src/ytdlp');
    const want = {
      'https://www.youtube.com/watch?v=jNQXAC9IVRw': true, 'https://youtu.be/jNQXAC9IVRw': true, 'https://vimeo.com/76979871': true,
      'https://rr1---sn-x.googlevideo.com/videoplayback?itag=137': false, 'https://www.reddit.com/media/cat.jpg': false, 'https://example.com/watch?v=1': false,
    };
    for (const [u, w] of Object.entries(want)) if (isSitePage(u) !== w) throw new Error(`isSitePage(${u}) should be ${w}`);
    const p = parseProgress('bolt-dl downloading 1048576 NA 5242880 123456.7 3 40 hls-625');
    if (p.downloaded !== 1048576 || p.total !== null || p.estimate !== 5242880 || p.speed !== 123456.7 || p.fragCount !== 40 || p.formatId !== 'hls-625') throw new Error('bad parse ' + JSON.stringify(p));
    if (parseProgress('[download] Destination: x.mp4')) throw new Error('parsed a non-progress line');
    if (lastError('WARNING: x\nERROR: [youtube] abc: Video unavailable\n') !== 'Video unavailable') throw new Error('bad error line');
    const it = m.add({ url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', dir: OUT, start: false });
    const direct = m.add({ url: 'https://www.youtube.com/watch?v=x', mime: 'video/mp4', dir: OUT, start: false });
    const forced = m.add({ url: `${base()}/file/page.html`, type: 'ytdlp', dir: OUT, start: false });
    const types = [it.type, direct.type, forced.type].join();
    for (const x of [it, direct, forced]) await m.remove(x.id);
    if (types !== 'ytdlp,http,ytdlp') throw new Error('types ' + types);
  });

  await test('yt-dlp: video page to mp4, paused and resumed', async () => {
    const { findYtdlp } = require('../src/ytdlp');
    if (!(await findYtdlp())) {
      // without yt-dlp the download must fail with the install hint
      const it = m.add({ url: `${base()}/file/page.html`, type: 'ytdlp', dir: OUT });
      try { await waitFor(m, it.id, 20000); } catch (e) {
        if (/winget install yt-dlp/.test(e.message)) { await m.remove(it.id); return 'skipped (no yt-dlp); install hint shown'; }
        throw e;
      }
      throw new Error('should have failed');
    }
    if (spawnSync('ffmpeg', ['-version']).status !== 0) return 'skipped (no ffmpeg)';
    const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc=duration=20:size=640x360:rate=25',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '800k', '-c:a', 'aac', '-shortest', '-movflags', '+faststart',
      path.join(SRC, 'clip.mp4')], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error('ffmpeg could not build test clip: ' + r.stderr);
    // a page with a <video>, like a real site; yt-dlp's generic extractor finds it. Non-ASCII title on purpose.
    fs.writeFileSync(path.join(SRC, 'page.html'), `<!doctype html><html><head><meta charset="utf-8"><title>Bolt clip ✓ été</title></head>
<body><video controls src="${base()}/file/clip.mp4?rate=${400 * 1024}"></video></body></html>`);
    const it = m.add({ url: `${base()}/file/page.html`, type: 'ytdlp', dir: OUT });
    const t0 = Date.now();
    while (!(m.list().find((i) => i.id === it.id).downloaded > 0)) {
      if (m.get(it.id).status === 'error') throw new Error(m.get(it.id).error);
      if (Date.now() - t0 > 30000) throw new Error('no progress from yt-dlp');
      await new Promise((res) => setTimeout(res, 200));
    }
    await new Promise((res) => setTimeout(res, 1000));
    await m.pause(it.id);
    const before = m.list().find((i) => i.id === it.id).downloaded;
    server.stats.ranged = 0;
    m.resume(it.id);
    const done = await waitFor(m, it.id);
    if (path.extname(done.savePath) !== '.mp4') throw new Error('not an mp4: ' + done.savePath);
    if (!server.stats.ranged) throw new Error('resume did not continue the partial file');
    if (fs.existsSync(done.savePath + '.bolt-ytdlp')) throw new Error('temp folder left behind');
    const info = spawnSync('ffmpeg', ['-i', done.savePath], { encoding: 'utf8' }).stderr;
    if (!/Video:/.test(info) || !/Audio:/.test(info)) throw new Error('missing audio or video track');
    return `${path.basename(done.savePath)}, paused at ${fmt(before)}, ${fmt(done.size)}`;
  });

  // ---------------------------------------------------------------- the bugs from real use
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitUntil = async (fn, timeoutMs, what) => {
    const t0 = Date.now();
    while (!(await fn())) {
      if (Date.now() - t0 > timeoutMs) throw new Error('timed out waiting for ' + what);
      await sleep(100);
    }
  };
  const doneBytes = (id) => m.list().find((i) => i.id === id).downloaded;
  const logText = () => { try { return fs.readFileSync(path.join(process.env.BOLT_DATA_DIR, 'logs', 'bolt.log'), 'utf8'); } catch { return ''; } };
  const servedVia = (q) => { let n = 0; for (const [k, v] of server.links) if (k.includes(q)) n += v.served; return n; };

  await test('file host allows only 3 connections: keeps going with fewer', async () => {
    server.stats.refused = 0;
    await dl(`${base()}/file/medium.bin?maxconn=3&rate=${4 << 20}`, 'medium', { connections: 16 });
    if (!server.stats.refused) throw new Error('the server never refused a connection, so the limit was not tested');
    return `${server.stats.refused} extra connections refused, finished anyway`;
  });

  await test('link expires mid-download: data kept, "Refresh link" continues it', async () => {
    // cap: short answers, so Bolt keeps making new requests after the link expires
    const it = m.add({ url: `${base()}/file/medium.bin?expire=${40 << 20}&cap=${4 << 20}&t=exp`, dir: OUT, connections: 4 });
    await waitUntil(() => ['error', 'completed'].includes(m.get(it.id).status), 90000, 'the link to expire');
    const g = m.get(it.id);
    if (g.status !== 'error' || g.errorKind !== 'http' || !/403/.test(g.error)) throw new Error(`unexpected: ${g.status} ${g.error}`);
    const kept = doneBytes(it.id);
    if (kept < 30 << 20) throw new Error('progress not kept: ' + fmt(kept));
    if (!fs.existsSync(g.savePath + '.bolt')) throw new Error('the partial file was deleted');
    await m.refreshUrl(it.id, `${base()}/file/medium.bin?t=fresh`);
    const done = await waitFor(m, it.id);
    await check(done, 'medium');
    const second = servedVia('t=fresh');
    if (second > (64 << 20) - kept + (8 << 20)) throw new Error(`new link re-downloaded ${fmt(second)}: it started over`);
    return `${fmt(kept)} kept; the new link only fetched the missing ${fmt(second)}`;
  });

  await test('host sends the whole file on resume (twice): no progress thrown away', async () => {
    const it = m.add({ url: `${base()}/file/medium.bin?cap=${8 << 20}&flaky200=2&after=${40 << 20}&t=f200`, dir: OUT, connections: 2 });
    const done = await waitFor(m, it.id);
    await check(done, 'medium');
    const served = servedVia('t=f200');
    if (!/ignored the resume request/.test(logText())) throw new Error('the hiccup never happened, so nothing was tested');
    if (served > (64 << 20) * 1.3) throw new Error(`downloaded ${fmt(served)} for a 64 MB file: progress was thrown away`);
    return `${fmt(served)} transferred for 64 MB`;
  });

  await test('file size changes on the server: stops with the data kept', async () => {
    const it = m.add({ url: `${base()}/file/medium.bin?cap=${8 << 20}&resized=${40 << 20}&t=rsz`, dir: OUT, connections: 2 });
    await waitUntil(() => ['error', 'completed'].includes(m.get(it.id).status), 120000, 'the size change to be reported');
    const g = m.get(it.id);
    if (g.status !== 'error' || g.errorKind !== 'mismatch') throw new Error(`unexpected: ${g.status} ${g.error}`);
    const kept = doneBytes(it.id);
    if (kept < 32 << 20 || !fs.existsSync(g.savePath + '.bolt')) throw new Error('data was not kept');
    await m.remove(it.id);
    return `${fmt(kept)} kept; message: "${g.error.split('.')[0]}"`;
  });

  await test('restart while data is buffered: no freeze (the 17:45 bug)', async () => {
    const it = m.add({ url: `${base()}/file/small.bin?cap=${256 << 10}&resized=${1 << 20}&rate=${1 << 20}&t=frz`, dir: OUT, connections: 8 });
    const done = await waitFor(m, it.id, 60000);
    await check(done, 'small');
    const buffered = /still buffered/.test(logText());
    return buffered ? 'restarted with unwritten data and still finished' : 'finished (restart happened without buffered data this run)';
  });

  await test('one-time link (game panel backup)', async () => {
    const { probe } = require('../src/download');
    // The browser used the link first: Bolt's check must fail so the browser keeps the download.
    const used = `${base()}/file/small.bin?once=1&t=a`;
    await fetch(used).then((r) => r.arrayBuffer());
    const p = await probe({ url: used }, config);
    if (p.ok) throw new Error('the check should fail on a used one-time link');
    // Caught before the browser used it: Bolt's first request is the download itself.
    server.stats.refused = 0;
    await dl(`${base()}/file/small.bin?once=1&t=b`, 'small', { connections: 8 });
    return `used link: "${p.error}"; fresh link downloaded on 1 connection (${server.stats.refused} extra refused)`;
  });

  await test('panel backup: server goes quiet for 25 s, Bolt waits (the backup bug)', async () => {
    // a real .tar.gz (tar header + data, gzipped), like a Pterodactyl backup
    const zlib = require('zlib');
    const header = Buffer.alloc(512);
    header.write('world/level.dat', 0);
    header.write('ustar', 257, 'latin1');
    const tar = Buffer.concat([header, crypto.randomBytes(6 << 20), Buffer.alloc(1024)]);
    fs.writeFileSync(path.join(SRC, 'panel-backup.bin'), zlib.gzipSync(tar, { level: 1 }));
    hashes.panel = await sha(path.join(SRC, 'panel-backup.bin'));
    // test config has a 5 s stall timeout: the old code hung up after 5 s and the used-up link then gave 404
    const it = m.add({ url: `${base()}/download/backup?token=eyJ0b2tlbiI6MX0&pause=${1 << 20}&pauseMs=25000`, dir: OUT });
    const done = await waitFor(m, it.id, 120000);
    await check(done, 'panel');
    if (!done.filename.endsWith('.tar.gz')) throw new Error('saved without the right extension: ' + done.filename);
    if (!/waiting up to 3 min/.test(logText())) throw new Error('the quiet period was not noticed');
    return `waited through 25 s of silence; saved as ${done.filename}`;
  });

  await test('PC sleeps / app freezes: reconnects right after', async () => {
    const it = m.add({ url: `${base()}/file/medium.bin?rate=${2 << 20}&t=slp`, dir: OUT, connections: 4 });
    await waitUntil(() => doneBytes(it.id) > 4 << 20, 30000, 'some progress');
    const end = Date.now() + 9000;
    while (Date.now() < end) { /* block everything for 9 s, like a sleep */ }
    const done = await waitFor(m, it.id);
    await check(done, 'medium');
    if (!/sleep or freeze/.test(logText())) throw new Error('the wake-up was not detected');
    return 'wake-up detected, all connections reopened';
  });

  await test('Auto speed: over 100 GB uses Max (32 connections)', async () => {
    const { autoConnections } = require('../src/download');
    const want = [[5e6, 4], [500e6, 8], [5e9, 16], [50e9, 16], [100e9, 32], [166e9, 32]];
    for (const [s, c] of want) if (autoConnections(s) !== c) throw new Error(`autoConnections(${s}) = ${autoConnections(s)}, want ${c}`);
    const { virtualByte } = require('./test-server');
    const bigDir = path.join(__dirname, '.tmp-150gb');
    fs.mkdirSync(bigDir, { recursive: true });
    const free = fs.statfsSync(bigDir);
    if (free.bavail * free.bsize < 151e9) { fs.rmSync(bigDir, { recursive: true, force: true }); return 'rule checked; live part skipped (no drive with 150 GB free)'; }
    server.stats.maxParallel = 0;
    const it = m.add({ url: `${base()}/virtual/150000000000`, dir: bigDir });
    try {
      await waitUntil(() => server.stats.maxParallel >= 32 || m.get(it.id).status === 'error', 30000, '32 connections');
      if (m.get(it.id).status === 'error') throw new Error(m.get(it.id).error);
      await sleep(3000);
      await m.pause(it.id);
      // the bytes on disk must be exactly the server's bytes, in every piece
      const g = m.get(it.id);
      const fd = fs.openSync(g.savePath + '.bolt', 'r');
      let verified = 0;
      for (const s of g.segments) {
        const n = Math.min(s.pos - s.start, 1 << 20);
        if (n <= 0) continue;
        const buf = Buffer.alloc(n);
        fs.readSync(fd, buf, 0, n, s.start);
        for (let i = 0; i < n; i += 997) if (buf[i] !== virtualByte(s.start + i)) { fs.closeSync(fd); throw new Error(`wrong byte at ${s.start + i}`); }
        verified += n;
      }
      fs.closeSync(fd);
      return `${server.stats.maxParallel} parallel connections; ${fmt(verified)} spot-checked across ${g.segments.length} pieces`;
    } finally {
      await m.remove(it.id);
      fs.rmSync(bigDir, { recursive: true, force: true });
    }
  });

  await test('Bolt crashes: it restarts by itself and the download continues', async () => {
    const dataDir = path.join(ROOT, 'supdata');
    fs.mkdirSync(dataDir, { recursive: true });
    const bport = 20000 + Math.floor(Math.random() * 20000);
    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ port: bport, downloadDir: OUT, keepAwake: false }));
    const sup = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'bolt.js'), 'start', '--no-open'], { env: { ...process.env, BOLT_DATA_DIR: dataDir }, stdio: 'ignore' });
    const call = (method, p, body) => fetch(`http://127.0.0.1:${bport}${p}`, {
      method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
    }).then((r) => r.json());
    const ping = async () => { try { return await call('GET', '/api/ping'); } catch { return {}; } };
    try {
      await waitUntil(async () => (await ping()).app === 'bolt', 15000, 'Bolt to start');
      const pid1 = (await ping()).pid;
      const add = await call('POST', '/api/downloads', { url: `${base()}/file/medium.bin?rate=${3 << 20}&t=crash`, dir: OUT, connections: 4 });
      const id = add.added[0].id;
      await sleep(2500);
      spawnSync('taskkill', ['/F', '/PID', String(pid1)]);
      await waitUntil(async () => { const p = await ping(); return p.pid && p.pid !== pid1; }, 20000, 'Bolt to come back');
      let x;
      await waitUntil(async () => {
        x = (await call('GET', '/api/downloads')).find((i) => i.id === id);
        if (x && x.status === 'error') throw new Error(x.error);
        return x && x.status === 'completed';
      }, 90000, 'the download to finish');
      if ((await sha(x.savePath)) !== hashes.medium) throw new Error('hash mismatch');
      return 'restarted within seconds of a forced kill; file intact';
    } finally {
      await call('POST', '/api/actions/quit', {}).catch(() => {});
      await Promise.race([new Promise((r) => sup.on('exit', r)), sleep(5000)]);
      try { sup.kill(); } catch { /* gone */ }
    }
  });

  // ---------------------------------------------------------------- connection behaviour on real-world servers
  const { virtualByte } = require('./test-server');
  /** Every byte of a downloaded /virtual file must be the server's byte. */
  const checkVirtual = (file, size) => {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(1 << 20);
    try {
      if (fs.fstatSync(fd).size !== size) throw new Error(`size ${fs.fstatSync(fd).size}, want ${size}`);
      for (let off = 0; off < size; off += buf.length) {
        const n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - off), off);
        for (let i = 0; i < n; i++) if (buf[i] !== virtualByte(off + i)) throw new Error(`wrong byte at ${off + i}`);
      }
    } finally { fs.closeSync(fd); }
  };

  await test('server answers "bytes=0-" with a plain 200 but supports ranges: still multi-connection', async () => {
    server.stats.maxParallel = 0;
    const t0 = Date.now();
    await dl(`${base()}/file/medium.bin?full0=1&rate=${4 << 20}`, 'medium', { connections: 8 });
    const secs = (Date.now() - t0) / 1000;
    if (server.stats.maxParallel < 4) throw new Error(`only ${server.stats.maxParallel} connection(s): treated as "can't resume"`);
    return `${server.stats.maxParallel} parallel connections, ${secs.toFixed(1)} s (one connection would need ~16 s)`;
  });

  await test('firewall silently drops extra connections: no connection storm, file intact', async () => {
    const size = 40 << 20;
    server.stats.refused = 0;
    const it = m.add({ url: `${base()}/virtual/${size}?maxconn=3&blackhole=1&rate=${3 << 20}&t=bh`, dir: OUT, connections: 16 });
    const done = await waitFor(m, it.id, 120000);
    checkVirtual(done.savePath, size);
    if (server.stats.refused > 6) throw new Error(`${server.stats.refused} connection attempts went into the void (a storm)`);
    return `${server.stats.refused} dropped connection attempt(s) for 16 wanted; every byte verified`;
  });

  await test('server down for 12 s: comes back with one connection first, then speeds up', async () => {
    const size = 160 << 20;
    const age = (Date.now() - server.startedAt) / 1000;
    const from = Math.ceil(age + 3); const to = from + 12;
    const it = m.add({ url: `${base()}/virtual/${size}?rate=${2 << 20}&outage=${from}-${to}&t=out`, dir: OUT, connections: 8 });
    await waitUntil(() => (Date.now() - server.startedAt) / 1000 > from + 1, 10000, 'the outage');
    server.stats.refused = 0;
    await waitUntil(() => (Date.now() - server.startedAt) / 1000 > to, 20000, 'the end of the outage');
    const during = server.stats.refused;
    server.stats.maxParallel = 0;
    const done = await waitFor(m, it.id, 120000);
    checkVirtual(done.savePath, size);
    if (during > 12) throw new Error(`${during} connection attempts while the server was down (a storm)`);
    if (server.stats.maxParallel < 4) throw new Error(`only ${server.stats.maxParallel} connections after the outage`);
    return `${during} attempts during 12 s down; back to ${server.stats.maxParallel} connections; every byte verified`;
  });

  await test('three downloads at once, one of them paused and resumed: all intact', async () => {
    const sizes = [48 << 20, 40 << 20, 56 << 20];
    const its = sizes.map((n, i) => m.add({ url: `${base()}/virtual/${n}?rate=${3 << 20}&t=multi${i}`, dir: OUT, connections: 8 }));
    await waitUntil(() => doneBytes(its[1].id) > 8 << 20, 30000, 'progress');
    await m.pause(its[1].id);
    await sleep(500);
    m.resume(its[1].id);
    const done = await Promise.all(its.map((it) => waitFor(m, it.id, 120000)));
    done.forEach((d, i) => checkVirtual(d.savePath, sizes[i]));
    return 'every byte of all three verified';
  });

  await test('bot protection hangs up on browser User-Agents: Bolt asks as itself and finishes', async () => {
    const size = 24 << 20;
    const it = m.add({ url: `${base()}/virtual/${size}?botcheck=1&t=bot`, dir: OUT, connections: 8 });
    const done = await waitFor(m, it.id, 60000);
    checkVirtual(done.savePath, size);
    if (!/asking again as Bolt-Download-Manager/.test(logText())) throw new Error('fallback not used');
    return 'browser identity was reset; download-manager identity worked; every byte verified';
  });

  await test('power cut (simulated): bytes not flushed to disk are fetched again, file intact', async () => {
    const dataDir = path.join(ROOT, 'powerdata');
    const dir = path.join(ROOT, 'power');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(dir, { recursive: true });
    const size = fs.statSync(small).size;
    // what was on disk after the cut: the first 2 MB were written, but the second MB only
    // ever reached Windows' cache and is gone (zeros); the state file still counts it
    const part = Buffer.from(fs.readFileSync(small).subarray(0, 2 << 20));
    part.fill(0, 1 << 20);
    fs.writeFileSync(path.join(dir, 'small.bin.bolt'), part);
    const item = { id: 'pwr1', type: 'http', url: `${base()}/file/small.bin?t=pwr`, status: 'downloading', size, resumable: true,
      savePath: path.join(dir, 'small.bin'), filename: 'small.bin', createdAt: Date.now() - 60000,
      segments: [{ start: 0, end: size - 1, pos: 2 << 20, sync: 1 << 20 }] };
    const stateFile = path.join(dataDir, 'downloads.json');
    fs.writeFileSync(stateFile, JSON.stringify([item]));
    const saved = new Date(Date.now() - 120000);
    fs.utimesSync(stateFile, saved, saved);   // last saved two minutes ago...
    const env = { ...process.env, BOLT_DATA_DIR: dataDir, BOLT_BOOT_TIME: String(Date.now() - 60000) };   // ...booted one minute ago
    const p = spawn(process.execPath, [path.join(__dirname, 'child-download.js'), item.url, dir], { env });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    await new Promise((r) => p.on('exit', r));
    const res = JSON.parse(out.trim().split('\n').pop());
    if (!res.ok) throw new Error(res.error);
    if ((await sha(res.savePath)) !== hashes.small) throw new Error('the lost megabyte is still zeros: file corrupt');
    const log = fs.readFileSync(path.join(dataDir, 'logs', 'bolt.log'), 'utf8');
    if (!/PC restarted while downloading/.test(log)) throw new Error('reboot not detected');
    return '1 MB that never reached the disk was downloaded again; SHA-256 matches';
  });

  // ---------------------------------------------------------------- disk and state faults
  // Injected in this process: download.js calls fs.writev / fs.promises.statfs through the module.
  const realWrite = fs.writev;
  const realStatfs = fs.promises.statfs;
  const faults = { full: false, busy: 0 };
  fs.writev = function (fd, ...rest) {
    const cb = rest[rest.length - 1];
    if (faults.full) return process.nextTick(cb, Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }));
    if (faults.busy > 0) { faults.busy--; return process.nextTick(cb, Object.assign(new Error('EBUSY: resource busy or locked, write'), { code: 'EBUSY' })); }
    return realWrite.call(fs, fd, ...rest);
  };
  fs.promises.statfs = async (p, o) => (faults.full ? { bavail: 1000, bsize: 4096, blocks: 1e6 } : realStatfs(p, o));

  await test('disk full mid-download: waits with the data kept, continues when space is back', async () => {
    const it = m.add({ url: `${base()}/file/medium.bin?rate=${4 << 20}&t=full`, dir: OUT, connections: 4 });
    await waitUntil(() => doneBytes(it.id) > 10 << 20, 30000, 'some progress');
    faults.full = true;
    try {
      await waitUntil(() => m.get(it.id).waitReason === 'space', 15000, 'the wait for disk space');
      const kept = doneBytes(it.id);
      const g = m.get(it.id);
      if (g.status !== 'retrying' || !/drive is full/.test(g.error)) throw new Error(`unexpected: ${g.status} ${g.error}`);
      await sleep(6000);
      if (m.get(it.id).status !== 'retrying') throw new Error('gave up while the disk was full: ' + m.get(it.id).status);
      if (doneBytes(it.id) < kept) throw new Error('progress went down while waiting');
      faults.full = false;
      const done = await waitFor(m, it.id);
      await check(done, 'medium');
      return `waited at ${fmt(kept)} for 6+ s, then finished; file intact`;
    } finally { faults.full = false; }
  });

  await test('file briefly locked by another program (antivirus): writes retried', async () => {
    const it = m.add({ url: `${base()}/file/medium.bin?rate=${8 << 20}&t=busy`, dir: OUT, connections: 4 });
    await waitUntil(() => doneBytes(it.id) > 4 << 20, 30000, 'some progress');
    faults.busy = 6;
    const done = await waitFor(m, it.id);
    await check(done, 'medium');
    if (faults.busy > 0) throw new Error('the lock was never hit');
    if (!/disk write blocked/.test(logText())) throw new Error('lock not noticed');
    return 'six locked writes retried; file intact';
  });

  fs.writev = realWrite;
  fs.promises.statfs = realStatfs;

  await test('drive unplugged while paused: progress kept, continues when it is back', async () => {
    if (process.platform !== 'win32') return 'skipped (needs subst)';
    const real = path.join(ROOT, 'usbdrive');
    fs.mkdirSync(real, { recursive: true });
    const letter = [...'RSTUVWXYZ'].find((l) => !fs.existsSync(l + ':\\'));
    if (!letter || spawnSync('subst', [`${letter}:`, real]).status !== 0) return 'skipped (subst not available)';
    const drive = `${letter}:\\`;
    try {
      const it = m.add({ url: `${base()}/file/medium.bin?rate=${4 << 20}&t=usb`, dir: drive, connections: 4 });
      await waitUntil(() => doneBytes(it.id) > 12 << 20, 30000, 'some progress');
      await m.pause(it.id);
      const kept = doneBytes(it.id);
      spawnSync('subst', [`${letter}:`, '/d']);   // "unplug"
      m.resume(it.id);
      await waitUntil(() => m.get(it.id).waitReason === 'drive', 15000, 'the wait for the drive');
      await sleep(6000);
      const g = m.get(it.id);
      if (g.status !== 'retrying' || doneBytes(it.id) < kept) throw new Error(`progress not kept: ${g.status}, ${fmt(doneBytes(it.id))}`);
      const part = path.join(real, path.basename(g.savePath) + '.bolt');
      if (!fs.existsSync(part)) throw new Error('the partial file was deleted');
      spawnSync('subst', [`${letter}:`, real]);   // "plug back in"
      const done = await waitFor(m, it.id);
      await check(done, 'medium');
      const second = servedVia('t=usb');
      if (second > (64 << 20) + (16 << 20)) throw new Error(`downloaded ${fmt(second)}: it started over`);
      return `${fmt(kept)} kept while the drive was gone; resumed and finished`;
    } finally {
      spawnSync('subst', [`${letter}:`, '/d']);
    }
  });

  // A fresh Bolt (own data folder) loading a state file made up by the test.
  const loadState = (name, files) => {
    const dataDir = path.join(ROOT, name);
    fs.mkdirSync(dataDir, { recursive: true });
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dataDir, f), text);
    const code = `const { Config } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'config'))});
      const { Manager } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'manager'))});
      const m = new Manager(new Config()); m.save(true);
      console.log(JSON.stringify(m.items)); m.shutdown().then(() => process.exit(0));`;
    const r = spawnSync(process.execPath, ['-e', code], { env: { ...process.env, BOLT_DATA_DIR: dataDir }, encoding: 'utf8' });
    if (r.status !== 0) throw new Error('child failed: ' + r.stderr);
    return { items: JSON.parse(r.stdout.trim().split('\n').pop()), dataDir };
  };
  const fakeItem = (extra) => ({ id: 'x' + Math.random().toString(36).slice(2), type: 'http', url: `${base()}/file/small.bin`, status: 'downloading', size: fs.statSync(small).size, createdAt: Date.now() - 60000, segments: [{ start: 0, end: fs.statSync(small).size - 1, pos: fs.statSync(small).size }], ...extra });

  await test('Bolt killed before the server first answered: starts cleanly next time', async () => {
    const dataDir = path.join(ROOT, 'earlykill');
    const dir = path.join(ROOT, 'early');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(dir, { recursive: true });
    // what is saved in that moment: a first piece, but no file name or size yet
    const item = { id: 'early1', type: 'http', url: `${base()}/file/small.bin?t=early`, status: 'connecting', size: null, savePath: null,
      dir, createdAt: Date.now() - 5000, segments: [{ start: 0, end: null, pos: 0, sync: 0 }] };
    fs.writeFileSync(path.join(dataDir, 'downloads.json'), JSON.stringify([item]));
    const p = spawn(process.execPath, [path.join(__dirname, 'child-download.js'), item.url, dir], { env: { ...process.env, BOLT_DATA_DIR: dataDir } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    const timer = setTimeout(() => p.kill(), 30000);
    await new Promise((r) => p.on('exit', r));
    clearTimeout(timer);
    const res = JSON.parse(out.trim().split('\n').pop() || '{}');
    if (!res.ok) throw new Error('restart failed: ' + (res.error || out));
    if ((await sha(res.savePath)) !== hashes.small) throw new Error('hash mismatch');
    return 'downloaded normally after the restart';
  });

  await test('Bolt stopped during the final rename: finished file found, not downloaded again', async () => {
    const dir = path.join(ROOT, 'renamed');
    fs.mkdirSync(dir, { recursive: true });
    const finalPath = path.join(dir, 'small.bin');
    fs.copyFileSync(small, finalPath);   // the rename happened; the state file still says "downloading"
    fs.utimesSync(finalPath, new Date(), new Date());   // written during the download, like the real file
    const it = fakeItem({ savePath: path.join(dir, 'small.bin'), finalPath });
    const { items } = loadState('state-rename', { 'downloads.json': JSON.stringify([it]) });
    if (items[0].status !== 'completed' || items[0].savePath !== finalPath) throw new Error(`unexpected: ${items[0].status} ${items[0].savePath}`);
    return 'marked finished from the file on disk';
  });

  await test('downloads.json damaged (power cut): the backup is used', async () => {
    const dir = path.join(ROOT, 'damaged');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'small.bin.bolt'), 'x');
    const it = fakeItem({ savePath: path.join(dir, 'small.bin'), status: 'paused' });
    const { items, dataDir } = loadState('state-damaged', { 'downloads.json': '\0\0\0\0[{"id":', 'downloads.json.bak': JSON.stringify([it]) });
    if (items.length !== 1 || items[0].id !== it.id || !items[0].segments.length) throw new Error('list lost: ' + JSON.stringify(items));
    if (!fs.readdirSync(dataDir).some((f) => f.includes('damaged'))) throw new Error('damaged file not kept aside');
    return 'list and progress restored from downloads.json.bak';
  });

  await test('downloads.json and its .bak both damaged: the flushed .safe copy is used', async () => {
    const dir = path.join(ROOT, 'damaged2');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'small.bin.bolt'), 'x');
    const it = fakeItem({ savePath: path.join(dir, 'small.bin'), status: 'paused' });
    const { items } = loadState('state-damaged2', { 'downloads.json': '\0\0\0\0', 'downloads.json.bak': '\0\0', 'downloads.json.safe': JSON.stringify([it]) });
    if (items.length !== 1 || items[0].id !== it.id) throw new Error('list lost: ' + JSON.stringify(items));
    return 'list restored from downloads.json.safe';
  });

  if (BIG) {
    await test('4 GB file, 16 connections', async () => {
      const big = makeFile('big.bin', 4 * 1024 * 1024 * 1024 + 5);
      hashes.big = await sha(big);
      const t0 = Date.now();
      await dl(`${base()}/file/big.bin`, 'big', { connections: 16, timeout: 15 * 60000 });
      const secs = (Date.now() - t0) / 1000;
      return `${secs.toFixed(1)}s, ${fmt(4 * 1073741824 / secs)}/s`;
    });
  }

  await m.shutdown();
  await server.close();
  const failed = results.filter((r) => !r[1]);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (!failed.length) fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(failed.length ? 1 : 0);
})();
