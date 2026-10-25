'use strict';
// Talks to the browser launcher the way Chrome does (cmd /d /c "<bat>" <origin>,
// length-prefixed JSON on stdin/stdout) and prints its reply as JSON.
//   node tools/native-host-check.js <path to bolt-launcher.bat>
const { spawn } = require('child_process');

const bat = process.argv[2];
const p = spawn('cmd.exe', ['/d', '/c', `""${bat}" chrome-extension://oljpffpdpmcipbelpjbakpgdlmepgebl/"`], { windowsVerbatimArguments: true });
let out = Buffer.alloc(0);
let err = '';
p.stdout.on('data', (d) => { out = Buffer.concat([out, d]); });
p.stderr.on('data', (d) => { err += d; });
p.on('exit', (code) => {
  console.log(JSON.stringify({ exit: code, reply: out.length > 4 ? out.subarray(4).toString() : '', err: err.trim() }));
  process.exit(0);
});
const body = Buffer.from(JSON.stringify({ cmd: 'launch' }));
const len = Buffer.alloc(4);
len.writeUInt32LE(body.length);
p.stdin.write(Buffer.concat([len, body]));
setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, 10000);
