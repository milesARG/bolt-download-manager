'use strict';
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const state = {
    items: new Map(),
    order: [],
    rows: new Map(),
    filter: 'all',
    search: '',
    open: new Set(),
    settings: {},
    history: new Array(60).fill(0),
    totalSpeed: 0,
  };

  const ACTIVE = new Set(['connecting', 'downloading', 'retrying', 'finishing']);
  const EXT_LABEL = { Video: 'VID', Music: 'MUS', Compressed: 'ZIP', Programs: 'APP', Documents: 'DOC', Images: 'IMG', Other: 'FILE' };
  const STATUS_TEXT = { queued: 'Queued', connecting: 'Connecting…', downloading: 'Downloading', retrying: 'Reconnecting…', paused: 'Paused', error: 'Failed', finishing: 'Verifying…', completed: 'Finished' };
  const WAIT_TEXT = { space: 'Waiting for disk space', drive: 'Waiting for the drive', network: 'Waiting for network', server: 'Server busy — retrying' };
  /** What the user should read: not just the raw status, but why it is waiting and whether the data is safe. */
  function statusLabel(it) {
    const st = it.status;
    if (st === 'retrying') return WAIT_TEXT[it.waitReason] || WAIT_TEXT[it.retryKind] || STATUS_TEXT.retrying;
    if (st === 'connecting' && it.downloaded > 0) return 'Resuming…';
    if (st === 'error' && it.downloaded > 0) return 'Action required';
    return STATUS_TEXT[st] || st;
  }

  // ------------------------------------------------------------ formatting
  function bytes(n) {
    if (n == null || !Number.isFinite(n)) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n < 10 ? n.toFixed(2) : n < 100 ? n.toFixed(1) : Math.round(n)) + ' ' + u[i];
  }
  const rate = (n) => (n ? bytes(n) + '/s' : '—');
  function eta(sec) {
    if (!Number.isFinite(sec) || sec <= 0) return '—';
    sec = Math.round(sec);
    if (sec < 60) return sec + 's';
    if (sec < 3600) return Math.floor(sec / 60) + 'm ' + String(sec % 60).padStart(2, '0') + 's';
    if (sec < 86400) return Math.floor(sec / 3600) + 'h ' + String(Math.floor((sec % 3600) / 60)).padStart(2, '0') + 'm';
    return Math.floor(sec / 86400) + 'd ' + Math.floor((sec % 86400) / 3600) + 'h';
  }
  const ago = (t) => {
    const s = (Date.now() - t) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return new Date(t).toLocaleDateString();
  };
  const host = (u) => { try { return new URL(u).host; } catch { return u; } };
  const urlName = (u) => {
    try { return decodeURIComponent(new URL(u).pathname.split('/').filter(Boolean).pop() || '') || host(u); } catch { return u; }
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function guessCategory(name) {
    const ext = (String(name || '').split('.').pop() || '').toLowerCase();
    const map = {
      Video: 'mp4 mkv webm avi mov wmv flv m4v ts m3u8', Music: 'mp3 m4a aac flac wav ogg opus',
      Compressed: 'zip rar 7z tar gz bz2 xz iso', Programs: 'exe msi apk dmg deb rpm msix appx',
      Documents: 'pdf doc docx xls xlsx ppt pptx txt epub csv', Images: 'jpg jpeg png gif webp svg bmp avif',
    };
    for (const [c, l] of Object.entries(map)) if (l.split(' ').includes(ext)) return c;
    return 'Other';
  }
  // stream downloads (HLS, yt-dlp) report progress as a fraction, size is only an estimate
  const isStream = (it) => it.type === 'hls' || it.type === 'ytdlp';
  const catOf = (it) => it.category || (isStream(it) ? 'Video' : guessCategory(it.filename || it.url));

  // ------------------------------------------------------------ api
  async function api(path, body) {
    const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Request failed');
    return data;
  }
  function toast(msg, kind = '') {
    const t = document.createElement('div');
    t.className = 'toast ' + kind;
    t.textContent = msg;
    $('#toasts').appendChild(t);
    setTimeout(() => t.remove(), 4200);
  }
  const act = (fn) => (...a) => fn(...a).catch((e) => toast(e.message, 'bad'));

  // ------------------------------------------------------------ live events
  function connect() {
    const es = new EventSource('/api/events');
    const cs = $('#connState');
    es.addEventListener('init', (e) => {
      const d = JSON.parse(e.data);
      state.items.clear();
      for (const it of d.items) state.items.set(it.id, it);
      state.settings = d.settings;
      showExtBanner();
      renderUserCats();
      $('#verLabel').textContent = 'Bolt v' + d.version + ' · Made by Arnav';
      $('#aboutVer').textContent = 'Version ' + d.version;
      cs.className = 'conn ok'; cs.lastChild.textContent = 'Running';
      fullRender();
    });
    es.addEventListener('item', (e) => {
      const it = JSON.parse(e.data);
      const prev = state.items.get(it.id);
      state.items.set(it.id, prev ? { ...prev, ...it } : it);
      if (!prev) fullRender(); else { updateRow(it.id); renderCounts(); }
    });
    es.addEventListener('removed', (e) => {
      const { id } = JSON.parse(e.data);
      state.items.delete(id);
      fullRender();
    });
    es.addEventListener('stats', (e) => {
      const d = JSON.parse(e.data);
      state.totalSpeed = d.totalSpeed;
      for (const s of d.items) {
        const it = state.items.get(s.id);
        if (!it) continue;
        Object.assign(it, s);
        updateRow(s.id);
      }
    });
    es.addEventListener('settings', (e) => { state.settings = JSON.parse(e.data); showExtBanner(); renderUserCats(); });
    es.addEventListener('completed', (e) => {
      const it = JSON.parse(e.data);
      toast('Finished: ' + it.filename, 'ok');
      if (state.settings.notify && 'Notification' in window && Notification.permission === 'granted') {
        const n = new Notification('Download complete', { body: it.filename, icon: 'icon.svg' });
        n.onclick = () => api(`/api/downloads/${it.id}/open`, {}).catch(() => {});
      }
    });
    es.onerror = () => { cs.className = 'conn bad'; cs.lastChild.textContent = 'App not running — reconnecting…'; };
  }

  // ------------------------------------------------------------ rendering
  function matches(it) {
    const f = state.filter;
    if (state.search) {
      const q = state.search.toLowerCase();
      if (!(`${it.filename || ''} ${it.url}`.toLowerCase().includes(q))) return false;
    }
    if (f === 'all') return true;
    if (f === 'active') return ACTIVE.has(it.status);
    if (f === 'queued') return it.status === 'queued';
    if (f === 'completed') return it.status === 'completed';
    if (f === 'unfinished') return it.status !== 'completed';
    if (f.startsWith('cat:')) return catOf(it) === f.slice(4);
    if (f.startsWith('ucat:')) return it.userCategory === f.slice(5);
    return true;
  }

  function renderCounts() {
    const c = { all: 0, active: 0, queued: 0, unfinished: 0, completed: 0 };
    for (const it of state.items.values()) {
      c.all++;
      if (ACTIVE.has(it.status)) c.active++;
      if (it.status === 'queued') c.queued++;
      if (it.status === 'completed') c.completed++; else c.unfinished++;
      const k = 'cat:' + catOf(it);
      c[k] = (c[k] || 0) + 1;
      if (it.userCategory) c['ucat:' + it.userCategory] = (c['ucat:' + it.userCategory] || 0) + 1;
    }
    for (const b of $$('[data-count]')) b.textContent = c[b.dataset.count] || 0;
  }

  // ---- your own categories ("Games" -> D:\games)
  const cats = () => state.settings.categories || [];
  function renderUserCats() {
    const box = $('#userCats');
    box.textContent = '';
    for (const c of cats()) {
      const b = document.createElement('button');
      b.className = 'nav' + (state.filter === 'ucat:' + c.name ? ' active' : '');
      b.dataset.filter = 'ucat:' + c.name;
      b.title = c.dir;
      b.innerHTML = '<span></span><b></b>';
      b.firstChild.textContent = c.name;
      b.lastChild.dataset.count = 'ucat:' + c.name;
      box.appendChild(b);
    }
    if (!cats().length) box.innerHTML = '<div class="hint" style="padding:2px 10px 6px">e.g. Games → D:\\games</div>';
    const sel = $('#addCat');
    const keep = sel.value;
    sel.length = 1;
    for (const c of cats()) sel.add(new Option(c.name, c.name));
    sel.value = cats().some((c) => c.name === keep) ? keep : '';
    renderCounts();
  }
  $('#userCats').addEventListener('click', (e) => {
    const b = e.target.closest('.nav');
    if (!b) return;
    $$('.nav').forEach((x) => x.classList.toggle('active', x === b));
    state.filter = b.dataset.filter;
    fullRender();
  });
  $('#addCat').addEventListener('change', () => {
    const c = cats().find((x) => x.name === $('#addCat').value);
    $('#addDir').value = c ? c.dir : '';
  });

  function catRow(c = { name: '', dir: '', exts: '' }) {
    const row = document.createElement('div');
    row.className = 'catrow';
    row.innerHTML = `<input class="cn" placeholder="Name (e.g. Games)" spellcheck="false">
      <input class="cd" placeholder="Folder, e.g. D:\\games" spellcheck="false">
      <button type="button" class="btn cb">Browse…</button>
      <input class="ce" placeholder="Types: iso rar" spellcheck="false" title="Optional: file types that go here by themselves">
      <button type="button" class="btn icon cx" title="Remove"><svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg></button>`;
    row.querySelector('.cn').value = c.name;
    row.querySelector('.cd').value = c.dir;
    row.querySelector('.ce').value = c.exts || '';
    row.querySelector('.cb').addEventListener('click', act(async () => {
      const r = await api('/api/actions/pick-folder', { initial: row.querySelector('.cd').value || state.settings.downloadDir });
      if (r.path) row.querySelector('.cd').value = r.path;
    }));
    row.querySelector('.cx').addEventListener('click', () => row.remove());
    return row;
  }
  $('#catAdd').addEventListener('click', () => { const r = catRow(); $('#catRows').appendChild(r); r.querySelector('.cn').focus(); });
  $('#btnManageCats').addEventListener('click', () => { openSettings(); if (!cats().length) $('#catAdd').click(); });
  const readCatRows = () => [...$$('#catRows .catrow')].map((r) => ({
    name: r.querySelector('.cn').value.trim(), dir: r.querySelector('.cd').value.trim(), exts: r.querySelector('.ce').value.trim(),
  })).filter((c) => c.name || c.dir);

  function fullRender() {
    const list = $('#list');
    const items = [...state.items.values()].sort((a, b) => b.createdAt - a.createdAt).filter(matches);
    const keep = new Set(items.map((i) => i.id));
    for (const [id, el] of state.rows) if (!keep.has(id)) { el.remove(); state.rows.delete(id); }
    let prev = null;
    for (const it of items) {
      let el = state.rows.get(it.id);
      if (!el) { el = buildRow(it.id); state.rows.set(it.id, el); }
      const want = prev ? prev.nextSibling : list.firstChild;
      if (el !== want) list.insertBefore(el, want);
      updateRow(it.id);
      prev = el;
    }
    $('#empty').hidden = state.items.size > 0;
    renderCounts();
  }

  function buildRow(id) {
    const el = document.createElement('div');
    el.className = 'row';
    el.dataset.id = id;
    el.innerHTML = `
      <div class="row-main">
        <div class="name"><div class="ficon"></div><div class="ntext"><div class="fname"></div><div class="sub"></div></div></div>
        <div class="num size"></div>
        <div class="prog"><div class="bar"></div><div class="pct"><span class="p1"></span><span class="p2"></span></div></div>
        <div class="speedv"></div>
        <div class="num eta"></div>
        <div class="acts"></div>
      </div>`;
    el.querySelector('.row-main').addEventListener('dblclick', (e) => {
      if (e.target.closest('.acts')) return;
      const it = state.items.get(id);
      if (it && it.status === 'completed') api(`/api/downloads/${id}/open`, {}).catch((er) => toast(er.message, 'bad'));
      else toggleDetails(id);
    });
    el.querySelector('.row-main').addEventListener('click', (e) => { if (!e.target.closest('.acts')) toggleDetails(id); });
    el.querySelector('.acts').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b) onAction(id, b.dataset.a);
    });
    return el;
  }

  function toggleDetails(id) {
    if (state.open.has(id)) state.open.delete(id); else state.open.add(id);
    updateRow(id);
  }

  const ICONS = {
    pause: '<path d="M8 5v14M16 5v14"/>',
    resume: '<path d="M7 5l12 7-12 7z"/>',
    retry: '<path d="M4 4v6h6M20 20v-6h-6"/><path d="M20 10a8 8 0 0 0-14.3-4.3L4 10M4 14a8 8 0 0 0 14.3 4.3L20 14"/>',
    open: '<path d="M14 3h7v7M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    remove: '<path d="M18 6 6 18M6 6l12 12"/>',
    refresh: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
    restart: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5"/>',
  };
  const TITLES = { pause: 'Pause', resume: 'Resume', retry: 'Retry', open: 'Open file', folder: 'Show in folder', remove: 'Remove', refresh: 'Refresh link (keeps what is downloaded)', restart: 'Restart from zero' };
  const ib = (a, cls = '') => `<button class="ib ${cls}" data-a="${a}" title="${TITLES[a]}"><svg viewBox="0 0 24 24">${ICONS[a]}</svg></button>`;

  function updateRow(id) {
    const el = state.rows.get(id);
    const it = state.items.get(id);
    if (!el || !it) return;
    const st = it.status;
    el.className = `row ${st}${state.open.has(id) ? ' open' : ''}`;
    const cat = catOf(it);
    const fi = el.querySelector('.ficon');
    fi.className = 'ficon ' + cat;
    fi.textContent = EXT_LABEL[cat];
    el.querySelector('.fname').textContent = it.filename || urlName(it.url);
    el.querySelector('.fname').title = it.filename || it.url;

    const size = it.size ?? it.estSize ?? null;
    const done = it.downloaded || 0;
    const frac = isStream(it) && st !== 'completed' ? (it.progress || 0) : size ? Math.min(1, done / size) : st === 'completed' ? 1 : 0;

    const sub = el.querySelector('.sub');
    let subText; let subCls = 'sub';
    const safe = done > 0 && st !== 'completed' && it.type !== 'browser' ? `${bytes(done)} safe on disk` : '';
    if (it.type === 'browser') {
      // downloaded by the browser itself (Telegram, MEGA, page-made files...)
      const what = st === 'completed' ? `${ago(it.completedAt || it.createdAt)}` : st === 'error' ? (it.error || 'Failed') : st === 'paused' ? 'Paused in your browser' : 'Downloading in your browser';
      subText = `${what} · via browser${it.note ? ' · ' + it.note : ''}`;
      if (st === 'error') subCls += ' err';
    } else if (st === 'error') { subText = (safe ? `${statusLabel(it)} · ${safe} · ` : '') + (it.error || 'Failed'); subCls += ' err'; }
    else if (st === 'retrying') {
      // the disk/drive messages are written for people; network errors are not, so they go in the tooltip
      subText = it.waitReason ? it.error : [statusLabel(it), safe].filter(Boolean).join(' · ');
      subCls += ' warn';
    }
    else if (st === 'completed') subText = `${host(it.url)} · ${ago(it.completedAt || it.createdAt)}`;
    else if (ACTIVE.has(st)) subText = `${statusLabel(it)}${it.connections ? ` · ${it.connections}${it.maxConnections > it.connections ? '/' + it.maxConnections : ''} connection${it.connections > 1 ? 's' : ''}` : ''}${it.hlsTotal ? ` · part ${it.hlsDone}/${it.hlsTotal}` : ''}${it.quality ? ' · ' + it.quality : ''}${it.type === 'ytdlp' ? ' · yt-dlp' : ''}${it.resumable === false ? ' · can\'t resume' : ''}`;
    else subText = `${statusLabel(it)}${st === 'paused' && safe ? ' · ' + safe : ''} · ${host(it.url)}`;
    sub.className = subCls;
    sub.textContent = subText;
    sub.title = st === 'retrying' && it.error && !it.waitReason ? `${subText}
${it.error}` : subText;

    el.querySelector('.size').textContent = st === 'completed' ? bytes(it.size) : size ? (it.estSize && !it.size ? '~' : '') + bytes(size) : '—';
    renderBar(el.querySelector('.bar'), it, frac, size);
    el.querySelector('.p1').textContent = st === 'completed' ? '100%' : size || isStream(it) ? (frac * 100).toFixed(frac < 0.1 ? 1 : 0) + '%' : bytes(done);
    el.querySelector('.p2').textContent = st === 'completed' ? '' : size ? bytes(done) : '';
    el.querySelector('.speedv').textContent = ACTIVE.has(st) ? rate(it.speed) : '';
    let left = NaN;
    // the engine's estimate averages the speed over the last half minute, so it doesn't jump around
    if (st === 'downloading' && it.eta != null) left = it.eta;
    else if (st === 'downloading' && it.speed > 0) {
      if (isStream(it) && it.estSize) left = (it.estSize - done) / it.speed;
      else if (it.size) left = (it.size - done) / it.speed;
    }
    el.querySelector('.eta').textContent = ACTIVE.has(st) ? eta(left) : st === 'completed' ? '' : '';

    const acts = [];
    const own = it.type !== 'browser';   // the browser controls its own downloads
    if (own && (ACTIVE.has(st) || st === 'queued')) acts.push(ib('pause'));
    if (own && st === 'paused') acts.push(ib('resume', 'go'));
    if (own && st === 'error') acts.push(ib('retry', 'go'));
    if (own && st === 'error' && it.errorKind === 'http') acts.push(ib('refresh', 'go'));
    if (own && st === 'error' && it.errorKind === 'mismatch') acts.push(ib('restart'));
    if (st === 'completed') acts.push(ib('open', 'go'));
    acts.push(ib('folder'), ib('remove'));
    const html = acts.join('');
    const ae = el.querySelector('.acts');
    if (ae.dataset.h !== html) { ae.innerHTML = html; ae.dataset.h = html; }

    let det = el.querySelector('.details');
    if (state.open.has(id)) {
      if (!det) { det = document.createElement('div'); det.className = 'details'; el.appendChild(det); buildDetails(det, id); }
      fillDetails(det, it, frac, size);
    } else if (det) det.remove();
  }

  function renderBar(bar, it, frac, size) {
    const segs = it.status !== 'completed' && Array.isArray(it.segments) && size ? it.segments : null;
    bar.classList.toggle('indeterminate', !size && !isStream(it) && ACTIVE.has(it.status));
    let html;
    if (segs && segs.length > 1) {
      html = segs.map(([s, e, p, live]) => {
        const end = e == null ? p : Math.min(p, e + 1);
        const w = ((end - s) / size) * 100;
        return w > 0 ? `<div class="seg${live ? ' live' : ''}" style="left:${(s / size) * 100}%;width:${w}%"></div>` : '';
      }).join('');
    } else {
      html = `<div class="fill" style="width:${(frac * 100).toFixed(2)}%"></div>`;
    }
    if (bar.dataset.h !== html) { bar.innerHTML = html; bar.dataset.h = html; }
  }

  function buildDetails(det, id) {
    det.innerHTML = `
      <div class="bar bigbar"></div>
      <dl class="kv"></dl>
      <div class="dbtns">
        <button class="btn" data-d="copy">Copy link</button>
        <button class="btn" data-d="refresh">Refresh link…</button>
        <button class="btn" data-d="restart" title="Delete what is downloaded so far and start again">Restart from zero</button>
        <span class="limit">Speed limit <input type="number" min="0" step="0.1" placeholder="none" data-d="limit"> MB/s</span>
      </div>`;
    det.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-d]');
      if (!b) return;
      const it = state.items.get(id);
      if (b.dataset.d === 'copy') navigator.clipboard.writeText(it.url).then(() => toast('Link copied'));
      if (b.dataset.d === 'refresh') openRefresh(id);
      if (b.dataset.d === 'restart') onAction(id, 'restart');
    });
    const lim = det.querySelector('[data-d=limit]');
    const it = state.items.get(id);
    if (it.type === 'browser') {
      // nothing Bolt can change about a download the browser makes
      for (const sel of ['[data-d=refresh]', '[data-d=restart]', '.limit']) det.querySelector(sel).remove();
      return;
    }
    if (it.speedLimit) lim.value = +(it.speedLimit / 1048576).toFixed(2);
    lim.addEventListener('change', act(async () => {
      const v = parseFloat(lim.value) || 0;
      await api(`/api/downloads/${id}/limit`, { bytesPerSecond: Math.round(v * 1048576) });
      toast(v ? `Limited to ${v} MB/s` : 'Speed limit removed');
    }));
  }

  function fillDetails(det, it, frac, size) {
    renderBar(det.querySelector('.bigbar'), it, frac, size);
    const rows = [
      ['Address', it.url],
      it.finalUrl && it.finalUrl !== it.url ? ['Redirected to', it.finalUrl] : null,
      ['Saved to', it.savePath || '(decided when the download starts)'],
      ['Status', statusLabel(it) + (it.error && it.status !== 'error' ? ' — ' + it.error : '')],
      ['Size', size ? bytes(size) + (it.estSize && !it.size ? ' (estimated)' : '') : 'unknown'],
      it.type === 'browser' ? ['Downloaded by', `Your browser. ${it.note || 'Bolt can\'t fetch this link itself.'} Pause or cancel it from the browser's downloads page.`] : null,
      ['Downloaded', bytes(it.downloaded || 0)],
      it.type === 'browser' ? null : ['Resume', it.resumable === true ? 'Supported — safe to pause or lose connection' : it.resumable === false ? 'Not supported by this server (will restart if interrupted)' : 'Checking…'],
      it.type === 'hls' ? ['Stream', `HLS video${it.quality ? ' · ' + it.quality : ''}${it.hlsTotal ? ` · ${it.hlsTotal} parts` : ''}`] : null,
      it.type === 'ytdlp' ? ['Stream', `Video page, downloaded with yt-dlp${it.quality ? ' · ' + it.quality : ''}`] : null,
      it.note && it.type !== 'browser' ? ['Note', it.note] : null,
      ['Added', new Date(it.createdAt).toLocaleString() + (it.source && it.source !== 'manual' ? ` · from ${it.source}` : '')],
    ].filter(Boolean);
    const html = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
    const kv = det.querySelector('.kv');
    if (kv.dataset.h !== html) { kv.innerHTML = html; kv.dataset.h = html; }
  }

  // ------------------------------------------------------------ actions
  let removeId = null;
  function onAction(id, a) {
    const it = state.items.get(id);
    if (!it) return;
    if (a === 'remove') {
      removeId = id;
      $('#removeName').textContent = it.filename || it.url;
      $('#removeFileRow').hidden = it.status !== 'completed';
      // an unfinished download's partial file goes with it: say how much that is
      const kept = it.status !== 'completed' ? it.downloaded || 0 : 0;
      $('#removeWarn').hidden = !kept;
      $('#removeWarn').textContent = kept ? `This also deletes the ${bytes(kept)} downloaded so far. To keep it, pause the download instead.` : '';
      $('#removeFile').checked = false;
      $('#dlgRemove').showModal();
      return;
    }
    if (a === 'refresh') { openRefresh(id); return; }
    if (a === 'restart') {
      if (it.status === 'completed') return;
      if (!confirm(`Delete the ${bytes(it.downloaded || 0)} downloaded so far and start "${it.filename || urlName(it.url)}" again from zero?`)) return;
      api(`/api/downloads/${id}/restart`, {}).then(() => toast('Restarted from zero')).catch((e) => toast(e.message, 'bad'));
      return;
    }
    const path = { pause: 'pause', resume: 'resume', retry: 'retry', open: 'open', folder: 'folder' }[a];
    if (path) api(`/api/downloads/${id}/${path}`, a === 'resume' ? { now: true } : {}).catch((e) => toast(e.message, 'bad'));
  }
  $('#dlgRemove').addEventListener('close', act(async () => {
    if ($('#dlgRemove').returnValue !== 'ok' || !removeId) return;
    await api(`/api/downloads/${removeId}/remove`, { deleteFile: $('#removeFile').checked });
    removeId = null;
  }));

  let refreshId = null;
  function openRefresh(id) {
    refreshId = id;
    $('#refreshUrl').value = '';
    $('#dlgRefresh').showModal();
  }
  $('#dlgRefresh').addEventListener('close', act(async () => {
    const url = $('#refreshUrl').value.trim();
    if ($('#dlgRefresh').returnValue !== 'ok' || !url) return;
    await api(`/api/downloads/${refreshId}/refresh`, { url });
    toast('Link updated, resuming');
  }));

  // add dialog
  const urlRe = /\b(https?:\/\/[^\s<>"']+)/gi;
  const extractUrls = (text) => [...new Set((String(text || '').match(urlRe) || []).map((u) => u.replace(/[),.;]+$/, '')))];

  async function openAdd(prefill) {
    const dlg = $('#dlgAdd');
    $('#formAdd').reset();
    $('#addErr').textContent = '';
    if (prefill && prefill.length) $('#addUrls').value = prefill.join('\n');
    if (!dlg.open) dlg.showModal();
    $('#addUrls').focus();
    askNotify();
    if (!prefill && navigator.clipboard && navigator.clipboard.readText) {
      // Pre-fill with a copied link. Never block the dialog on the permission prompt.
      navigator.clipboard.readText().then((clip) => {
        const u = extractUrls(clip);
        if (u.length && !$('#addUrls').value) { $('#addUrls').value = u.join('\n'); $('#addUrls').select(); }
      }).catch(() => {});
    }
  }
  $('#btnAdd').addEventListener('click', () => openAdd());
  $('#formAdd').addEventListener('submit', async (e) => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    const urls = extractUrls($('#addUrls').value);
    if (!urls.length) { $('#addErr').textContent = 'Enter at least one http(s) link.'; return; }
    try {
      const body = {
        urls,
        filename: $('#addName').value.trim() || null,
        dir: $('#addDir').value.trim() || null,
        connections: Number($('#addSpeed').value) || 0,
        referrer: $('#addRef').value.trim() || null,
        cookies: $('#addCookie').value.trim() || null,
        start: !$('#addLater').checked,
        type: $('#addYtdlp').checked ? 'ytdlp' : undefined,
        category: $('#addCat').value || '',
      };
      const r = await api('/api/downloads', body);
      $('#dlgAdd').close();
      toast(r.added.length > 1 ? `Added ${r.added.length} downloads` : 'Download added', 'ok');
      for (const er of r.errors) toast(`${er.url}: ${er.error}`, 'bad');
    } catch (er) { $('#addErr').textContent = er.message; }
  });
  $('#addBrowse').addEventListener('click', act(async () => {
    const r = await api('/api/actions/pick-folder', { initial: $('#addDir').value || state.settings.downloadDir });
    if (r.path) $('#addDir').value = r.path;
  }));

  // settings
  function openSettings() {
    const s = state.settings;
    $('#setDir').value = s.downloadDir || '';
    $('#setSort').checked = !!s.sortIntoCategories;
    $('#setSpeed').value = String([0, 4, 8, 16, 32].includes(Number(s.connections)) ? Number(s.connections) : 0);
    // keep a custom number someone typed into settings.json selectable
    const conc = String(Number(s.maxConcurrent) || 0);
    if (![...$('#setConc').options].some((o) => o.value === conc)) $('#setConc').add(new Option(conc, conc));
    $('#setConc').value = conc;
    $('#setAwake').checked = !!s.keepAwake;
    $('#setStartup').checked = !!s.startWithWindows;
    $('#setLimit').value = s.speedLimit ? +(s.speedLimit / 1048576).toFixed(2) : 0;
    $('#setStall').value = s.stallTimeout;
    $('#setRetries').value = s.maxRetries;
    $('#setPerHost').value = s.maxConnectionsPerHost;
    $('#setRemux').checked = !!s.remuxHlsToMp4;
    $('#setNotify').checked = !!s.notify;
    $('#catRows').textContent = '';
    for (const c of cats()) $('#catRows').appendChild(catRow(c));
    $('#dlgSettings').showModal();
  }
  $('#btnLog').addEventListener('click', act(() => api('/api/actions/open-log', {})));
  $('#btnAbout').addEventListener('click', () => $('#dlgAbout').showModal());
  $('#btnSettings').addEventListener('click', openSettings);
  $('#setBrowse').addEventListener('click', act(async () => {
    const r = await api('/api/actions/pick-folder', { initial: $('#setDir').value });
    if (r.path) $('#setDir').value = r.path;
  }));
  $('#formSettings').addEventListener('submit', async (e) => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    const catList = readCatRows();
    const bad = catList.find((c) => !c.name || !/^([a-zA-Z]:\\|\\\\)/.test(c.dir));
    if (bad) { toast(`Category "${bad.name || '(no name)'}" needs a name and a full folder path like D:\\games`, 'bad'); return; }
    try {
      state.settings = await api('/api/settings', {
        categories: catList,
        downloadDir: $('#setDir').value,
        sortIntoCategories: $('#setSort').checked,
        connections: Number($('#setSpeed').value),
        keepAwake: $('#setAwake').checked,
        startWithWindows: $('#setStartup').checked,
        maxConcurrent: Number($('#setConc').value),
        speedLimit: Math.round((parseFloat($('#setLimit').value) || 0) * 1048576),
        stallTimeout: Number($('#setStall').value),
        maxRetries: Number($('#setRetries').value),
        maxConnectionsPerHost: Number($('#setPerHost').value),
        remuxHlsToMp4: $('#setRemux').checked,
        notify: $('#setNotify').checked,
      });
      if (state.settings.notify) askNotify();
      renderUserCats();
      $('#dlgSettings').close();
      toast('Settings saved', 'ok');
    } catch (er) { toast(er.message, 'bad'); }
  });

  function askNotify() {
    if (state.settings.notify && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  }

  // toolbar
  $('#btnPauseAll').addEventListener('click', act(() => api('/api/actions/pause-all', {})));
  $('#btnResumeAll').addEventListener('click', act(() => api('/api/actions/resume-all', {})));
  $('#btnClear').addEventListener('click', act(() => api('/api/actions/clear-completed', {})));
  $('#btnFolder').addEventListener('click', act(() => api('/api/actions/open-downloads', {})));
  $('#search').addEventListener('input', (e) => { state.search = e.target.value.trim(); fullRender(); });
  for (const b of $$('.nav')) {
    b.addEventListener('click', () => {
      $$('.nav').forEach((x) => x.classList.toggle('active', x === b));
      state.filter = b.dataset.filter;
      fullRender();
    });
  }

  // paste / drop links anywhere
  document.addEventListener('paste', (e) => {
    if (e.target.closest('input, textarea')) return;
    const urls = extractUrls(e.clipboardData.getData('text'));
    if (urls.length) { e.preventDefault(); openAdd(urls); }
  });
  const main = $('.main');
  main.addEventListener('dragover', (e) => { e.preventDefault(); main.classList.add('drag'); });
  main.addEventListener('dragleave', (e) => { if (!main.contains(e.relatedTarget)) main.classList.remove('drag'); });
  main.addEventListener('drop', (e) => {
    e.preventDefault();
    main.classList.remove('drag');
    const urls = extractUrls(e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text'));
    if (urls.length) openAdd(urls);
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); openAdd(); }
    if (e.key === '/' && !e.target.closest('input, textarea')) { e.preventDefault(); $('#search').focus(); }
  });

  // total speed + sparkline
  const spark = $('#spark');
  const ctx = spark.getContext('2d');
  setInterval(() => {
    let active = false;
    for (const it of state.items.values()) if (ACTIVE.has(it.status)) active = true;
    const v = active ? state.totalSpeed : 0;
    state.history.push(v);
    state.history.shift();
    $('#totalSpeed').textContent = rate(v) === '—' ? '0 B/s' : rate(v);
    document.title = active && v ? `${rate(v)} · Bolt` : 'Bolt Download Manager';
    const dpr = window.devicePixelRatio || 1;
    const W = 120; const H = 28;
    if (spark.width !== W * dpr) { spark.width = W * dpr; spark.height = H * dpr; spark.style.width = W + 'px'; spark.style.height = H + 'px'; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const max = Math.max(1, ...state.history);
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#5b8cff';
    ctx.beginPath();
    state.history.forEach((s, i) => {
      const x = (i / (state.history.length - 1)) * W;
      const y = H - 2 - (s / max) * (H - 4);
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    });
    ctx.strokeStyle = accent; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
    ctx.globalAlpha = 0.18; ctx.fillStyle = accent; ctx.fill(); ctx.globalAlpha = 1;
  }, 1000);

  // keep "x min ago" fresh
  setInterval(() => { for (const id of state.rows.keys()) { const it = state.items.get(id); if (it && it.status === 'completed') updateRow(id); } }, 60000);

  // "add the extension" banner until the extension first talks to Bolt
  function showExtBanner() {
    let hidden = false;
    try { hidden = localStorage.getItem('boltExtBannerHidden') === '1'; } catch { /* storage blocked */ }
    $('#extBanner').hidden = !!state.settings.extensionSeen || hidden;
  }
  $('#btnExtFolder').addEventListener('click', act(() => api('/api/actions/open-extension-folder', {})));
  $('#btnExtCopy').addEventListener('click', () => navigator.clipboard.writeText('edge://extensions').then(() => toast('Copied: paste it into the address bar')).catch(() => toast('Type edge://extensions into the address bar')));
  $('#btnExtHide').addEventListener('click', () => {
    try { localStorage.setItem('boltExtBannerHidden', '1'); } catch { /* fine */ }
    $('#extBanner').hidden = true;
  });

  connect();
})();
