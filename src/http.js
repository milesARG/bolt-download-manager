'use strict';
const http = require('http');
const https = require('https');

// Shared keep-alive agents: re-using warm TCP/TLS connections makes a big
// difference when segments are re-split and new ranges are requested.
const agentOpts = { keepAlive: true, keepAliveMsecs: 15000, maxSockets: 256, maxFreeSockets: 64, scheduling: 'lifo' };
const agents = { 'http:': new http.Agent(agentOpts), 'https:': new https.Agent(agentOpts) };

class HttpError extends Error {
  constructor(status, message, retryAfter) {
    super(message || `HTTP ${status}`);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function parseRetryAfter(v) {
  if (!v) return 0;
  const n = Number(v);
  if (Number.isFinite(n)) return n * 1000;
  const d = Date.parse(v);
  return Number.isFinite(d) ? Math.max(0, d - Date.now()) : 0;
}

/**
 * Issue a request and follow redirects. Resolves with { res, url } once
 * response headers arrive. The caller owns the response stream.
 */
function request(url, { method = 'GET', headers = {}, signal, maxRedirects = 10, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    let redirects = 0;
    let current = url;
    let hdrs = { ...headers };
    let curMethod = method;

    const go = () => {
      let u;
      try { u = new URL(current); } catch { return reject(new Error('Invalid URL: ' + current)); }
      const lib = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
      if (!lib) return reject(new Error('Unsupported protocol: ' + u.protocol));

      const req = lib.request(u, {
        method: curMethod,
        agent: agents[u.protocol],
        headers: { 'Accept-Encoding': 'identity', Accept: '*/*', Connection: 'keep-alive', ...hdrs },
        signal,
      });
      const timer = setTimeout(() => req.destroy(new Error('Connection timed out')), timeout);
      // TCP keep-alive probes make a connection that died silently (Wi-Fi
      // switch, router reboot) fail instead of hanging forever.
      req.on('socket', (s) => { s.setNoDelay(true); s.setKeepAlive(true, 30000); });
      req.on('error', (e) => { clearTimeout(timer); reject(e); });
      req.on('response', (res) => {
        clearTimeout(timer);
        // A response with no 'error' listener crashes the whole app if its
        // socket resets (e.g. while we drain a redirect or error body). Callers
        // add their own listeners on top of this one.
        res.on('error', () => {});
        const s = res.statusCode;
        if ([301, 302, 303, 307, 308].includes(s) && res.headers.location) {
          res.resume();
          if (++redirects > maxRedirects) return reject(new Error('Too many redirects'));
          const next = new URL(res.headers.location, current);
          if (next.host !== u.host) {
            // Credentials belong to the original site only.
            for (const k of Object.keys(hdrs)) if (/^(cookie|authorization)$/i.test(k)) delete hdrs[k];
          }
          if (s === 303) curMethod = 'GET';
          current = next.href;
          return go();
        }
        resolve({ res, url: current });
      });
      req.end();
    };
    go();
  });
}

module.exports = { request, HttpError, parseRetryAfter, agents };
