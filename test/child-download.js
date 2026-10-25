'use strict';
// Runs one download in its own process so the test can hard-kill it.
// usage: node child-download.js <url> <outDir>   (BOLT_DATA_DIR must be set)
const { Config } = require('../src/config');
const { Manager } = require('../src/manager');

const [url, outDir] = process.argv.slice(2);
const config = new Config();
const m = new Manager(config);
if (!m.items.length) m.add({ url, dir: outDir, connections: 8 });
const startBytes = m.list()[0].downloaded || 0;
m.on('completed', async (it) => {
  await m.shutdown();
  console.log(JSON.stringify({ ok: true, savePath: it.savePath, startBytes }));
  process.exit(0);
});
m.on('item', (it) => {
  if (it.status === 'error') { console.log(JSON.stringify({ ok: false, error: it.error })); process.exit(1); }
});
