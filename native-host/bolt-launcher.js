'use strict';
// Native messaging host: lets the browser extension start Bolt when it isn't
// running. Registered by install.ps1. Speaks Chrome's length-prefixed JSON.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let replying = false;
function reply(obj) {
  replying = true;
  const body = Buffer.from(JSON.stringify(obj));
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([len, body]), () => process.exit(0));
}

let buf = Buffer.alloc(0);
process.stdin.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  if (buf.length < 4) return;
  const n = buf.readUInt32LE(0);
  if (buf.length < 4 + n) return;
  let msg;
  try { msg = JSON.parse(buf.subarray(4, 4 + n).toString('utf8')); } catch { return reply({ ok: false, error: 'bad message' }); }
  if (msg.cmd !== 'launch') return reply({ ok: false, error: 'unknown command' });
  // Installed copy (<install>\app\native-host): start the tray app, which runs the engine.
  const trayExe = path.join(__dirname, '..', '..', 'Bolt.exe');
  const child = fs.existsSync(trayExe)
    ? spawn(trayExe, ['--background'], { detached: true, stdio: 'ignore', windowsHide: true })
    : spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'bolt.js'), 'start', '--no-open'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  reply({ ok: true });
});
// The browser may close our input right after its message: finish the reply first.
process.stdin.on('end', () => { if (!replying) process.exit(0); });
