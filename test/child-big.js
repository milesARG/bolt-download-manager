'use strict';
// One Bolt process for the 150 GB test: resumes the download from its data folder (or adds
// it), prints a progress line every second, exits when finished.
//   node test/child-big.js <codeRoot> <url> <outDir>      (BOLT_DATA_DIR set by stress-150gb.js)
const path = require('path');
const [ROOT, URL_, OUT] = process.argv.slice(2);
const { Config } = require(path.join(ROOT, 'src/config'));
const { Manager } = require(path.join(ROOT, 'src/manager'));
const config = new Config();
config.update({ downloadDir: OUT, keepAwake: false, connections: 0 });
const m = new Manager(config);
if (!m.items.length) m.add({ url: URL_, dir: OUT });
const id = m.items[0].id;
const first = m.list()[0];
console.log(JSON.stringify({ ev: 'start', committed: first.downloaded || 0, status: first.status, segments: (m.items[0].segments || []).length }));
const cpu0 = process.cpuUsage(); const t0 = Date.now();
setInterval(() => {
  const x = m.list().find((i) => i.id === id);
  const c = process.cpuUsage(cpu0);
  console.log(JSON.stringify({ ev: 'p', status: x.status, downloaded: x.downloaded, size: x.size, speed: x.speed, eta: x.eta, conns: x.connections, error: x.error, waitReason: x.waitReason,
    rssMB: Math.round(process.memoryUsage().rss / 1048576), cpuPct: +(((c.user + c.system) / 1000) / (Date.now() - t0) * 100).toFixed(1) }));
}, 1000);
m.on('item', (x) => { if (x.id === id && x.status === 'finishing') console.log(JSON.stringify({ ev: 'finishing' })); });
m.on('completed', async (x) => {
  await m.shutdown();
  console.log(JSON.stringify({ ev: 'done', savePath: x.savePath, size: x.size }));
  process.exit(0);
});
