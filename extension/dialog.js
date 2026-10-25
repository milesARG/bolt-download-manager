'use strict';
const $ = (s) => document.querySelector(s);
const send = (msg) => chrome.runtime.sendMessage(msg);
const key = new URLSearchParams(location.search).get('k');

function bytes(n) {
  if (n == null || !Number.isFinite(n)) return 'unknown';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n < 10 ? n.toFixed(2) : n < 100 ? n.toFixed(1) : Math.round(n)) + ' ' + u[i];
}

let pending = null;

async function refreshFree() {
  const dir = $('#dir').value.trim();
  const r = await send({ cmd: 'disk-free', dir });
  const el = $('#free');
  if (r && r.free != null) {
    el.textContent = bytes(r.free);
    const size = pending.probe && pending.probe.size;
    el.className = size && r.free < size ? 'bad' : '';
    if (size && r.free < size) $('#err').textContent = `Not enough space on this drive: the file needs ${bytes(size)}.`;
    else if (/^Not enough space/.test($('#err').textContent)) $('#err').textContent = '';
  } else {
    el.textContent = '—';
  }
}

function setBusy(b) {
  for (const id of ['start', 'later', 'cancel', 'browser']) $('#' + id).disabled = b;
}

async function act(action) {
  setBusy(true);
  $('#err').textContent = '';
  const cont = !$('#continueRow').hidden && $('#continue').checked;
  const speed = document.querySelector('input[name=speed]:checked');
  const r = await send({
    cmd: 'dialog', key, action,
    filename: $('#name').value.trim() || null,
    dir: $('#dir').value.trim() || null,
    connections: speed ? Number(speed.value) : 0,
    continueId: cont ? pending.probe.existing.id : null,
  });
  if (r && r.ok) { window.close(); return; }
  setBusy(false);
  $('#err').textContent = (r && r.error) || 'Something went wrong';
}

async function init() {
  const r = await send({ cmd: 'pending', key });
  pending = r && r.pending;
  if (!pending) {
    document.body.innerHTML = '<p>This download request has expired. Start the download again.</p>';
    return;
  }
  const p = pending.probe || {};
  let host = '';
  try { host = new URL(pending.url).host; } catch { /* ignore */ }
  $('#host').textContent = host;
  $('#host').title = pending.url;
  $('#name').value = p.filename || pending.filename || decodeURIComponent((pending.url.split('?')[0].split('/').pop()) || '') || '';
  $('#dir').value = p.downloadDir || '';

  if (pending.oneTime) {
    $('#size').textContent = 'shown when it starts';
    $('#resume').textContent = 'one-time link';
    $('#resume').className = 'warn';
    $('#speedNote').textContent = 'This panel link works only once, so Bolt can\'t test it first. Bolt picks the fastest safe setting when it starts.';
  } else if (!p.ok) {
    $('#problem').hidden = false;
    $('#problemText').textContent = `${p.error || 'No answer'}. You can still try with Bolt, or let the browser download it.`;
    $('#start').textContent = 'Try with Bolt';
  } else {
    $('#size').textContent = bytes(p.size);
    $('#resume').textContent = p.resumable ? 'supported' : 'not supported';
    $('#resume').className = p.resumable ? 'ok' : 'warn';
  }

  // speed
  const def = String(p.defaultConnections || 0);
  const radio = document.querySelector(`input[name=speed][value="${def}"]`) || document.querySelector('input[name=speed][value="0"]');
  radio.checked = true;
  if (p.ok && p.autoConnections) $('#autoHint').textContent = `${p.autoConnections} for this file`;
  if (p.ok && !p.resumable) {
    $('#speedBox').disabled = true;
    $('#speedNote').textContent = 'This server allows only one connection and can\'t resume, so avoid pausing this download.';
  } else if (p.ok && p.size >= 100e9) {
    $('#speedNote').textContent = 'Huge file: Auto uses Max (32 connections). If the site limits connections, Bolt backs off by itself.';
  }

  // an unfinished copy of the same file: continue it instead of starting over
  if (p.existing) {
    $('#continueRow').hidden = false;
    $('#continueInfo').textContent = `${bytes(p.existing.downloaded || 0)} of ${bytes(p.existing.size)} done`;
    const sync = () => {
      const on = $('#continue').checked;
      for (const id of ['name', 'dir', 'browse']) $('#' + id).disabled = on;
      $('#speedBox').disabled = on || (p.ok && !p.resumable);
      $('#start').textContent = on ? 'Continue download' : 'Start download';
    };
    $('#continue').addEventListener('change', sync);
    sync();
  }

  $('#browse').addEventListener('click', async () => {
    const res = await send({ cmd: 'pick-folder', initial: $('#dir').value });
    if (res && res.path) { $('#dir').value = res.path; refreshFree(); }
  });
  $('#dir').addEventListener('change', refreshFree);
  $('#start').addEventListener('click', () => act('start'));
  $('#later').addEventListener('click', () => act('later'));
  $('#cancel').addEventListener('click', () => act('cancel'));
  $('#browser').addEventListener('click', () => act('browser'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.target.closest('button')) { e.preventDefault(); act('start'); }
    if (e.key === 'Escape') act('cancel');
  });
  refreshFree();
  $('#start').focus();
}

init();
