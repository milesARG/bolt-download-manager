'use strict';
const $ = (s) => document.querySelector(s);
const send = (msg) => chrome.runtime.sendMessage(msg);

function bytes(n) {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (n < 10 ? n.toFixed(1) : Math.round(n)) + ' ' + u[i];
}

function nameFor(m, title) {
  let name = '';
  try { name = decodeURIComponent(new URL(m.url).pathname.split('/').pop() || ''); } catch { /* ignore */ }
  // Stream playlists are usually called index.m3u8 / master.m3u8: use the page title instead.
  if (m.kind === 'hls' || !name || /^(index|master|playlist|manifest|video|chunklist)/i.test(name)) {
    const ext = m.kind === 'audio' ? '.m4a' : '.mp4';
    name = (title || 'video').replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) + ext;
  }
  return name;
}

function setStatus(running) {
  const el = $('#status');
  el.className = 'status ' + (running ? 'ok' : 'bad');
  el.lastChild.textContent = running ? 'Running' : 'Not running';
  $('#notRunning').hidden = running;
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const st = await send({ cmd: 'status' });
  const s = st.settings;
  setStatus(st.running);
  $('#enabled').checked = s.enabled;
  $('#minSize').value = s.minSizeKB;
  $('#skipExts').value = s.skipExts;
  $('#autoLaunch').checked = s.autoLaunch;
  $('#askEveryTime').checked = s.askEveryTime;
  $('#catchPanelLinks').checked = s.catchPanelLinks;
  $('#port').value = s.port;

  $('#enabled').addEventListener('change', (e) => send({ cmd: 'save-settings', settings: { enabled: e.target.checked } }));
  $('#save').addEventListener('click', async () => {
    await send({ cmd: 'save-settings', settings: {
      minSizeKB: Number($('#minSize').value) || 0,
      skipExts: $('#skipExts').value.trim(),
      autoLaunch: $('#autoLaunch').checked,
      askEveryTime: $('#askEveryTime').checked,
      catchPanelLinks: $('#catchPanelLinks').checked,
      port: Number($('#port').value) || 9614,
    } });
    $('#save').textContent = 'Saved';
    setTimeout(() => { $('#save').textContent = 'Save options'; }, 1200);
  });
  $('#open').addEventListener('click', async () => {
    const r = await send({ cmd: 'launch' });
    if (r.running) chrome.tabs.create({ url: `http://127.0.0.1:${s.port}/` });
    else { setStatus(false); $('#launchHelp').hidden = false; }
  });
  $('#launch').addEventListener('click', async () => {
    $('#launch').disabled = true;
    $('#launch').textContent = 'Starting…';
    const r = await send({ cmd: 'launch' });
    setStatus(r.running);
    $('#launch').disabled = false;
    $('#launch').textContent = 'Start Bolt';
    if (!r.running) $('#launchHelp').hidden = false;
  });

  if (!tab) return;
  const pv = $('#pageVideo');
  if (!/^https?:/i.test(tab.url || '')) pv.disabled = true;
  pv.addEventListener('click', async () => {
    pv.disabled = true;
    pv.textContent = 'Sending…';
    const r = await send({ cmd: 'send', url: tab.url, type: 'ytdlp' });
    pv.textContent = r.ok ? 'Added to Bolt ✓' : "Download this page's video with Bolt";
    if (!r.ok) {
      pv.disabled = false;
      $('#pageVideoInfo').textContent = r.error;
      if (/not running/i.test(r.error)) setStatus(false);
    }
  });

  const { items } = await send({ cmd: 'media', tabId: tab.id });
  const box = $('#media');
  if (!items.length) return;
  box.innerHTML = '';
  // Show HLS master playlists first; Bolt picks the best quality from them.
  items.sort((a, b) => (b.kind === 'hls') - (a.kind === 'hls'));
  for (const m of items) {
    const row = document.createElement('div');
    row.className = 'm';
    const name = nameFor(m, tab.title);
    let host = '';
    try { host = new URL(m.url).host; } catch { /* ignore */ }
    const label = m.kind === 'hls' ? 'STREAM' : m.kind.toUpperCase();
    row.innerHTML = `<div class="t"></div><div class="s"><span class="chip ${m.kind}">${label}</span><span class="info"></span></div><button class="btn small primary">Download</button>`;
    row.querySelector('.t').textContent = name;
    row.querySelector('.t').title = m.url;
    row.querySelector('.info').textContent = [bytes(m.size), host].filter(Boolean).join(' · ');
    const btn = row.querySelector('button');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '…';
      const r = await send({ cmd: 'send', url: m.url, kind: m.kind, filename: name, referrer: tab.url });
      btn.textContent = r.ok ? 'Added ✓' : 'Failed';
      if (!r.ok) { btn.title = r.error; btn.disabled = false; if (/not running/i.test(r.error)) setStatus(false); }
    });
    box.appendChild(row);
  }
}

init();
