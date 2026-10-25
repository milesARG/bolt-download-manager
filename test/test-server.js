'use strict';
// Local file server for engine tests. Query switches:
//   ?norange=1   ignore Range headers (always 200 full body)
//   ?nolen=1     no Content-Length (chunked), implies norange
//   ?drop=0.01   per-chunk chance to kill the connection mid-stream
//   ?rate=N      limit each connection to N bytes/sec
//   ?cap=N       answer at most N bytes per ranged response (short 206s)
//   ?maxconn=N   refuse (403) more than N connections at once, like file hosts do
//   ?expire=N    the link "expires" (403) once N bytes were sent through it
//   ?once=1      one-time link: the first request works, every later one gets 403
//   ?flaky200=N  the first N resume requests get a 200 with the whole file (CDN hiccup)
//   ?resized=N   after N bytes were sent, resume requests report a different file size
//   ?full0=1     answer "Range: bytes=0-" with a plain 200, other ranges normally
//   /redirect/3/file/x  -> 3 redirects then /file/x
// Per-link state is keyed by the full URL, so changing any query value gives a
// "fresh" link (used to test "Refresh link").
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PATTERN_LEN = 65521;   // prime, so the pattern never lines up with chunk sizes
// Seeded, not random: separate server processes must serve the very same bytes,
// or a test that restarts the server would silently get a different "file".
const BASE = Buffer.alloc(PATTERN_LEN);
for (let i = 0, h = crypto.createHash('sha256').update('bolt').digest(); i < PATTERN_LEN; i += 32) {
  h.copy(BASE, i, 0, Math.min(32, PATTERN_LEN - i));
  h = crypto.createHash('sha256').update(h).digest();
}
// The pattern plus 64 KB of wrap-around, so any 64 KB send is one subarray. Built from
// whole copies: copying the first 64 KB of a buffer only 65521 long left the last
// 15 bytes wrong, and the server then sent wrong bytes now and then.
const PATTERN = Buffer.concat([BASE, BASE, BASE]).subarray(0, PATTERN_LEN + 65536);
for (let i = 0; i < PATTERN.length; i++) if (PATTERN[i] !== BASE[i % PATTERN_LEN]) throw new Error('test pattern broken at ' + i);

/** One shared bandwidth limit for everything on this server, like a real internet line. */
class LinkCap {
  /** swing: the line's speed goes up and down by half over this many seconds (an unsteady connection) */
  constructor(rate, swing = 0, amp = 0.5) { this.base = rate; this.swing = swing; this.amp = amp; this.t0 = Date.now(); this.tokens = 0; this.last = Date.now(); this.burst = Math.max(65536, rate / 20); }
  get rate() { return this.swing ? this.base * (1 + this.amp * Math.sin((2 * Math.PI * (Date.now() - this.t0)) / 1000 / this.swing)) : this.base; }
  /** ms to wait before sending n bytes */
  take(n) {
    const now = Date.now(); const rate = this.rate;
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * rate);
    this.last = now;
    this.tokens -= n;
    return this.tokens >= 0 ? 0 : Math.ceil((-this.tokens / rate) * 1000);
  }
}
/** What byte `i` of a /virtual file is (lets a test verify any downloaded range). */
const virtualByte = (i) => PATTERN[i % PATTERN_LEN];

function startServer(dir, port = 0) {
  const sockets = new Set();
  const stats = { requests: 0, ranged: 0, maxParallel: 0, active: 0, refused: 0, virtualActive: 0 };
  const links = new Map();
  const linkCaps = new Map();
  const startedAt = Date.now();
  const link = (k) => { if (!links.has(k)) links.set(k, { served: 0, requests: 0, active: 0, resumes: 0 }); return links.get(k); };
  const server = http.createServer((req, res) => {
    stats.requests++;
    const u = new URL(req.url, 'http://x');
    const red = /^\/redirect\/(\d+)(\/.*)$/.exec(u.pathname);
    if (red) {
      const n = Number(red[1]);
      const next = n > 1 ? `/redirect/${n - 1}${red[2]}` : red[2];
      res.writeHead(302, { Location: next + u.search });
      return res.end();
    }
    // /virtual/<bytes>: a huge file made up on the fly (repeating pattern), for
    // testing 100+ GB downloads without a 100 GB file on disk. Switches:
    //   ?link=N     all connections together get N bytes/s (a real line's limit)
    //   ?swing=S    ...going up and down over S seconds (an unsteady line), by half or &amp=A
    //   ?rate=N     each connection gets N bytes/s (CDNs that throttle per connection)
    //   ?latency=N  wait N ms before answering (round trip + TLS handshake)
    //   ?maxconn=N  more than N connections at once: 403, or with &blackhole=1 no
    //               answer at all (firewalls that silently drop extra connections)
    //   ?drop=P     per-64 KB chance to cut the connection
    //   ?outage=A-B the server refuses everything between A and B seconds after it started
    const v = /^\/virtual\/(\d+)$/.exec(u.pathname);
    if (v) {
      const q = u.searchParams;
      const total = Number(v[1]);
      const outage = /^(\d+)-(\d+)$/.exec(q.get('outage') || '');
      const age = (Date.now() - startedAt) / 1000;
      if (outage && age >= Number(outage[1]) && age < Number(outage[2])) { stats.refused++; return req.socket.destroy(); }
      // ?botcheck=1: hang up on browser User-Agents, like Hetzner's mirrors do with requests
      // from download tools that name a browser
      if (q.get('botcheck') === '1' && /^Mozilla/.test(req.headers['user-agent'] || '')) { stats.refused++; return req.socket.destroy(); }
      const maxconn = Number(q.get('maxconn') || 0);
      if (maxconn && stats.virtualActive >= maxconn) {
        stats.refused++;
        if (q.get('blackhole') === '1') return;   // keep the socket, never answer
        res.writeHead(403); return res.end('too many connections');
      }
      stats.virtualActive++;
      let s = 0; let e = total - 1; let code = 200;
      const r = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
      const h = { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', ETag: `"v${total}"` };
      if (r) {
        s = r[1] ? Number(r[1]) : 0;
        e = r[2] ? Math.min(Number(r[2]), total - 1) : total - 1;
        code = 206;
        h['Content-Range'] = `bytes ${s}-${e}/${total}`;
        stats.ranged++;
      }
      h['Content-Length'] = e - s + 1;
      const rate = Number(q.get('rate') || 0);
      const linkRate = Number(q.get('link') || 0);
      const swing = Number(q.get('swing') || 0);
      const amp = Number(q.get('amp') || 0.5);
      const capKey = `${linkRate}/${swing}/${amp}`;
      const cap = linkRate ? (linkCaps.get(capKey) || linkCaps.set(capKey, new LinkCap(linkRate, swing, amp)).get(capKey)) : null;
      const drop = Number(q.get('drop') || 0);
      let pos = s; let closed = false; let begun = false; const t0 = Date.now(); let sent = 0;
      res.on('close', () => { closed = true; stats.virtualActive--; if (begun) stats.active--; });
      const pump = () => {
        while (!closed && pos <= e) {
          const n = Math.min(65536, e - pos + 1);
          // the shared cap's tokens are taken now, so other connections wait their turn
          let wait = cap ? cap.take(n) : 0;
          if (rate) wait = Math.max(wait, (sent + n) / rate * 1000 - (Date.now() - t0));
          if (wait > 0) return setTimeout(() => send(n), wait);
          if (!send(n, true)) return;
        }
        if (!closed) res.end();
      };
      // returns false when the caller must wait for 'drain'
      const send = (n, inline) => {
        if (closed) return false;
        if (drop && Math.random() < drop) { req.socket.destroy(); return false; }
        const now = (Date.now() - startedAt) / 1000;
        if (outage && now >= Number(outage[1]) && now < Number(outage[2])) { req.socket.destroy(); return false; }   // running transfers die too
        const off = pos % PATTERN_LEN;
        pos += n; sent += n;
        const ok = res.write(PATTERN.subarray(off, off + n));
        if (!ok) { res.once('drain', pump); return false; }
        if (!inline) pump();
        return true;
      };
      const begin = () => {
        if (closed) return;
        res.writeHead(code, h);
        begun = true;
        stats.active++;
        stats.maxParallel = Math.max(stats.maxParallel, stats.active);
        pump();
      };
      const latency = Number(q.get('latency') || 0);
      if (latency) setTimeout(begin, latency); else begin();
      return;
    }
    // /download/backup?token=...: like a game-panel (Wings) backup link. No
    // resume support, works once, and no file name in the answer.
    const wings = u.pathname === '/download/backup';
    if (wings) { u.searchParams.set('norange', '1'); u.searchParams.set('once', '1'); }
    const m = wings ? [null, 'panel-backup.bin'] : /^\/file\/(.+)$/.exec(u.pathname);
    if (!m) { res.writeHead(404); return res.end('not found'); }
    const file = path.join(dir, path.basename(decodeURIComponent(m[1])));
    let st;
    try { st = fs.statSync(file); } catch { res.writeHead(404); return res.end('not found'); }
    const q = u.searchParams;
    const nolen = q.get('nolen') === '1';
    const norange = nolen || q.get('norange') === '1';
    const drop = Number(q.get('drop') || 0);
    const rate = Number(q.get('rate') || 0);
    const cap = Number(q.get('cap') || 0);
    const L = link(req.url);
    L.requests++;
    const refuse = (why) => { stats.refused++; res.writeHead(403, { 'Content-Type': 'text/plain', 'X-Why': why }); res.end('forbidden: ' + why); };
    if (q.get('once') === '1' && L.requests > 1) return refuse('one-time link already used');
    if (q.get('expire') && L.served >= Number(q.get('expire'))) return refuse('link expired');
    if (q.get('maxconn') && L.active >= Number(q.get('maxconn'))) return refuse('too many connections');
    const size = st.size;
    let start = 0; let end = size - 1; let status = 200;
    const rangeStart = /bytes=(\d+)-/.exec(req.headers.range || '');
    const isResume = rangeStart && Number(rangeStart[1]) > 0;
    if (isResume) L.resumes++;
    // with &after=N the hiccups only start once N bytes went through this link
    if (isResume && L.served < Number(q.get('after') || 0)) L.resumes--;
    // ?full0=1: "bytes=0-" is the whole file, so this server answers it with a plain 200
    // (allowed by the HTTP spec) although it handles every other range fine
    const full0 = q.get('full0') === '1' && /^bytes=0-$/.test(req.headers.range || '');
    const send200 = full0 || (isResume && L.served >= Number(q.get('after') || 0) && L.resumes <= Number(q.get('flaky200') || 0));
    const resized = q.get('resized') && isResume && L.served >= Number(q.get('resized'));
    const pauseAt = Number(q.get('pause') || 0);      // go quiet once after this many bytes...
    const pauseMs = Number(q.get('pauseMs') || 0);    // ...for this long
    const type = { '.html': 'text/html; charset=utf-8', '.mp4': 'video/mp4' }[path.extname(file)] || 'application/octet-stream';
    const headers = { 'Content-Type': type, ETag: `"${size}-${st.mtimeMs}"`, 'Last-Modified': st.mtime.toUTCString() };
    if (!norange) headers['Accept-Ranges'] = 'bytes';
    const range = req.headers.range;
    if (range && !norange && !send200) {
      const r = /bytes=(\d*)-(\d*)/.exec(range);
      if (r) {
        start = r[1] ? Number(r[1]) : 0;
        end = r[2] ? Math.min(Number(r[2]), size - 1) : size - 1;
        if (start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
        if (cap && end - start + 1 > cap) end = start + cap - 1;
        status = 206;
        stats.ranged++;
        headers['Content-Range'] = `bytes ${start}-${end}/${resized ? size + 12345 : size}`;
      }
    }
    if (!nolen) headers['Content-Length'] = end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') return res.end();
    stats.active++;
    L.active++;
    stats.maxParallel = Math.max(stats.maxParallel, stats.active);
    const stream = fs.createReadStream(file, { start, end, highWaterMark: 64 * 1024 });
    let sent = 0; const t0 = Date.now();
    const holds = new Set();
    const hold = (k) => { holds.add(k); stream.pause(); };
    const release = (k) => { holds.delete(k); if (!holds.size) stream.resume(); };
    stream.on('data', (chunk) => {
      if (drop && Math.random() < drop) { stream.destroy(); req.socket.destroy(); return; }
      if (!res.write(chunk)) { hold('drain'); res.once('drain', () => release('drain')); }
      sent += chunk.length;
      L.served += chunk.length;
      if (pauseAt && sent >= pauseAt && !holds.has('quiet') && !stream.wentQuiet) {
        stream.wentQuiet = true;
        hold('quiet');
        setTimeout(() => release('quiet'), pauseMs);
      }
      if (rate) {
        const ahead = sent / rate * 1000 - (Date.now() - t0);
        if (ahead > 0) { hold('rate'); setTimeout(() => release('rate'), ahead); }
      }
    });
    stream.on('end', () => res.end());
    const done = () => { stats.active--; L.active--; stream.destroy(); };
    res.on('close', done);
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const p = server.address().port;
      resolve({
        port: p,
        url: `http://127.0.0.1:${p}`,
        stats,
        links,
        startedAt,
        close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
      });
    });
  });
}

module.exports = { startServer, virtualByte };

if (require.main === module) {
  const dir = process.argv[2] || '.';
  startServer(dir, Number(process.argv[3] || 8765)).then((s) => console.log('serving', dir, 'at', s.url));
}
