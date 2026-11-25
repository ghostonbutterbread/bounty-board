/* Sandbox terminal drawer (feature module).
 *
 * A bottom drawer in the report view with a terminal attached to this report's
 * sandbox (terminal_service.py, a separate process published on the Board's
 * origin under capabilities.terminal_url). The shell starts in the report's
 * real folder, mounted at /report.
 *
 * In the rendered preview every fenced code block gets a play button (types
 * the block into the terminal without Enter; Shift+click or "Run" also sends
 * Enter) and a "Checked" box. These controls exist only in the Board's DOM:
 * nothing is written into the report Markdown, and copying from the preview
 * strips them. Check marks are stored by the terminal service, keyed by a
 * fingerprint of each block (see terminal_checks.py; blockKeys mirrors it).
 */
(() => {
  'use strict';
  const STORE = 'bounty-board-terminal:v1';
  const SHELLISH = new Set(['', 'shell', 'bash', 'sh', 'zsh', 'console', 'shell-session', 'sh-session', 'terminal', 'curl']);
  const PROMPTED = new Set(['console', 'shell-session', 'sh-session', 'terminal']);
  const PREVIEWS = '.editor-preview, .editor-preview-side, #report-preview';
  let ctx = null, base = null, sel = null, selKey = '';
  let drawer = null, term = null, fit = null, ws = null, wsKey = '', xtermLoad = null;
  let status = 'idle', info = null, connectTimer = null, retry = 0, pending = [];
  let checks = {}, checksKey = '', checksOk = false, pollTimer = null, resetArmed = null;
  // Result of /api/mount for this report: null while unknown (then the button stays usable),
  // {ok: false, message} for navigation pages and files outside a finding folder.
  let mount = null;
  const blocked = () => mount?.ok === false;
  // Phones get a taller sheet by default; a saved height always wins.
  const defaultHeight = window.innerWidth <= 700 ? Math.round(window.innerHeight * 0.6) : 320;
  const prefs = (() => { try { return {open: false, height: defaultHeight, ...JSON.parse(localStorage.getItem(STORE) || '{}')}; } catch { return {open: false, height: defaultHeight}; } })();
  const savePrefs = () => { try { localStorage.setItem(STORE, JSON.stringify({open: !!prefs.open, height: prefs.height | 0})); } catch {} };
  const esc = value => (ctx?.esc ? ctx.esc(value) : String(value ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`));
  const keyOf = s => JSON.stringify([s.family, s.program, s.lane, s.path]);
  const query = s => new URLSearchParams({family: s.family, program: s.program, lane: s.lane, path: s.path}).toString();

  // -- block fingerprints (mirror of terminal_checks.block_keys) -------------
  const K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  function sha256hex(text) {
    const bytes = new TextEncoder().encode(text), bits = bytes.length * 8;
    const n = ((bytes.length + 9 + 63) >> 6) << 6, m = new Uint8Array(n);
    m.set(bytes); m[bytes.length] = 0x80;
    const view = new DataView(m.buffer);
    view.setUint32(n - 8, Math.floor(bits / 0x100000000)); view.setUint32(n - 4, bits >>> 0);
    const h = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    const w = new Uint32Array(64), r = (x, k) => (x >>> k) | (x << (32 - k));
    for (let o = 0; o < n; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = view.getUint32(o + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = r(w[i-15], 7) ^ r(w[i-15], 18) ^ (w[i-15] >>> 3), s1 = r(w[i-2], 17) ^ r(w[i-2], 19) ^ (w[i-2] >>> 10);
        w[i] = (w[i-16] + s0 + w[i-7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i++) {
        const t1 = (hh + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
        const t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
    }
    return Array.from(h, x => x.toString(16).padStart(8, '0')).join('');
  }
  function normalise(text) {
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/\s+$/, ''));
    while (lines.length && !lines[0]) lines.shift();
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    return lines.join('\n');
  }
  function blockKeys(texts) {
    const seen = new Map();
    return texts.map(text => { const d = sha256hex(normalise(text)).slice(0, 32), i = seen.get(d) || 0; seen.set(d, i + 1); return `${d}:${i}`; });
  }
  // What the play button types: console blocks keep only their "$ " lines.
  function commandText(text, lang) {
    let lines = normalise(text).split('\n');
    if (PROMPTED.has(lang) && lines.some(l => /^\$ /.test(l))) lines = lines.filter(l => /^\$ /.test(l)).map(l => l.slice(2));
    return lines.join('\n');
  }

  // -- transport -------------------------------------------------------------
  async function api(path, body) {
    const options = body
      ? {method: 'POST', credentials: 'same-origin', headers: {'Content-Type': 'application/json', 'X-Requested-With': 'Bounty-Board'}, body: JSON.stringify(body)}
      : {credentials: 'same-origin', cache: 'no-store'};
    const response = await fetch(base + path, {...options, signal: AbortSignal.timeout(body ? 60000 : 15000)});
    let data = null;
    try { data = await response.json(); } catch {}
    if (!response.ok) { const error = new Error(data?.message || `Request failed (${response.status})`); error.status = response.status; error.code = data?.error; throw error; }
    return data || {};
  }

  function loadXterm() {
    if (window.Terminal && window.FitAddon) return Promise.resolve();
    if (xtermLoad) return xtermLoad;
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = '/vendor/xterm/xterm.css';
    document.head.appendChild(css);
    const script = src => new Promise((resolve, reject) => { const s = document.createElement('script'); s.src = src; s.onload = resolve; s.onerror = reject; document.head.appendChild(s); });
    xtermLoad = script('/vendor/xterm/xterm.js').then(() => script('/vendor/xterm/addon-fit.js')).catch(error => { xtermLoad = null; throw error; });
    return xtermLoad;
  }

  function themeColors() {
    const css = getComputedStyle(document.documentElement), v = name => css.getPropertyValue(name).trim();
    return {background: v('--surface-2') || v('--bg'), foreground: v('--text'), cursor: v('--accent'), cursorAccent: v('--surface-2'), selectionBackground: v('--accent-soft')};
  }

  function ensureTerm() {
    if (term) return;
    term = new window.Terminal({convertEol: false, cursorBlink: true, fontSize: 13, scrollback: 5000, theme: themeColors(),
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'monospace'});
    fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(drawer.querySelector('[data-term-screen]'));
    term.attachCustomKeyEventHandler(event => !(event.ctrlKey && (event.code === 'Backquote' || event.key === '`')));
    term.onData(data => send({t: 'in', d: data}));
    term.onResize(({cols, rows}) => send({t: 'resize', cols, rows}));
    new ResizeObserver(() => refit()).observe(drawer.querySelector('[data-term-screen]'));
    new MutationObserver(() => { if (term) term.options.theme = themeColors(); }).observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme']});
    refit();
  }
  function refit() { if (fit && drawer && !drawer.hidden) { try { fit.fit(); } catch {} } }
  function send(message) { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(message)); return true; } return false; }

  function disconnect() {
    clearTimeout(connectTimer); connectTimer = null;
    if (ws) { const old = ws; ws = null; wsKey = ''; try { old.close(); } catch {} }
  }

  async function connect() {
    clearTimeout(connectTimer); connectTimer = null;
    if (!sel || !prefs.open || !drawer || drawer.hidden) return;
    const key = selKey;
    if (ws && wsKey === key && ws.readyState <= 1) return;
    disconnect();
    setStatus(retry ? 'reconnecting' : 'connecting');
    try { await api('api/status'); }
    catch (error) {
      if (key !== selKey) return;
      if (error.status === 401) { setStatus('signin'); return; }
      setStatus('unavailable'); scheduleRetry(); return;
    }
    try { await loadXterm(); } catch { setStatus('unavailable'); note('The terminal library could not be loaded.'); return; }
    if (key !== selKey || !prefs.open) return;
    ensureTerm();
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${base}ws?${query(sel)}`);
    socket.binaryType = 'arraybuffer';
    ws = socket; wsKey = key;
    socket.onopen = () => { if (ws !== socket) return; refit(); send({t: 'resize', cols: term.cols, rows: term.rows}); };
    socket.onmessage = event => {
      if (ws !== socket) return;
      if (typeof event.data !== 'string') { term.write(new Uint8Array(event.data)); return; }
      let message; try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'hello') {
        term.reset(); info = message.session; retry = 0; setStatus('connected');
        const notes = [];
        if (message.event === 'recreated_idle') notes.push(`This sandbox was removed after ${span(info.remove_after)} idle; started a fresh one.`);
        if (message.event === 'recreated_vanished') notes.push('The previous sandbox was gone; started a fresh one.');
        if (info?.mount_rule === 'ledger') notes.push(`Opened the finding folder ${info.folder}/ (${info.fid}, from the ledger).`);
        if (info?.notes?.includes('folder_moved')) notes.push('The report folder moved or was renamed. Reset sandbox to open the new location.');
        if (message.event !== 'reset') note(notes.join(' '));
        if (message.event === 'resumed') window.BoardUI?.toast?.('Resumed', 'success', {timeout: 4000});
        send({t: 'resize', cols: term.cols, rows: term.rows});
        const queued = pending; pending = [];
        queued.forEach(fn => fn());
      } else if (message.type === 'viewers') { if (info) info.viewers = message.count; paint(); }
      else if (message.type === 'reset') { term.reset(); note('Sandbox reset.'); }
      else if (message.type === 'exit') { if (info) info.running = false; paint(); }
      else if (message.type === 'error') { note(message.message || 'The sandbox could not start.'); setStatus('error'); }
      else if (message.type === 'closed') { note(message.message || 'The sandbox closed.'); }
    };
    socket.onclose = () => {
      if (ws !== socket) return;
      ws = null; wsKey = '';
      if (status !== 'error') { setStatus('reconnecting'); scheduleRetry(); }
    };
  }
  function scheduleRetry() {
    retry = Math.min((retry || 1000) * 2, 30000);
    clearTimeout(connectTimer);
    connectTimer = setTimeout(connect, retry);
  }

  // -- drawer ------------------------------------------------------------------
  const LABELS = {idle: 'Not connected', connecting: 'Connecting', connected: 'Connected', reconnecting: 'Reconnecting',
    signin: 'Sign-in needed', unavailable: 'Service unavailable', error: 'Error'};
  function setStatus(next) { status = next; paint(); }
  function note(text) { const el = drawer?.querySelector('[data-term-note]'); if (el) { el.textContent = text || ''; el.hidden = !text; } }
  const span = s => (s % 3600 === 0 ? `${s / 3600} ${s === 3600 ? 'hour' : 'hours'}` : s % 60 === 0 ? `${s / 60} min` : `${s} s`);
  const minutes = s => (s < 60 ? 'under a minute' : s < 3600 ? `${Math.floor(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`);

  function buildDrawer() {
    drawer = document.createElement('section');
    drawer.className = 'term-drawer';
    drawer.id = 'term-drawer';
    drawer.setAttribute('aria-label', 'Sandbox terminal');
    drawer.hidden = true;
    drawer.innerHTML = `<div class="term-resize" data-term-resize role="separator" aria-orientation="horizontal" aria-label="Resize terminal" tabindex="0"></div>
      <div class="term-head">
        <span class="term-title"><i class="fa fa-terminal" aria-hidden="true"></i> Sandbox</span>
        <span class="term-pill" data-term-status role="status" aria-live="polite"></span>
        <span class="hint term-meta" data-term-meta></span>
        <span class="term-steps" data-term-steps></span>
        <span class="term-actions">
          <button type="button" class="button sm" data-term-reset>Reset sandbox</button>
          <button type="button" class="button sm" data-term-evidence>Save output as evidence</button>
          <button type="button" class="button sm ghost icon-only" data-term-close aria-label="Close terminal" title="Close terminal (Ctrl+\`)"><i class="fa fa-times" aria-hidden="true"></i></button>
        </span>
      </div>
      <div class="term-note hint" data-term-note role="status" hidden></div>
      <div class="term-body">
        <div class="term-screen" data-term-screen></div>
        <div class="term-signin" data-term-signin hidden><p>Sign in to use the terminal. Your tailnet account is not on the terminal allowlist.</p><a class="button primary" data-term-login href="#">Sign in</a></div>
        <div class="term-signin" data-term-down hidden><p>The terminal service is not running or not reachable. The Board keeps working; try again later.</p><button type="button" class="button" data-term-retry>Try again</button></div>
      </div>`;
    document.body.appendChild(drawer);
    drawer.addEventListener('click', onDrawerClick);
    const handle = drawer.querySelector('[data-term-resize]');
    handle.addEventListener('pointerdown', event => {
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      const move = e => setHeight(window.innerHeight - e.clientY);
      const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); savePrefs(); };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
    handle.addEventListener('keydown', event => {
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); setHeight(prefs.height + (event.key === 'ArrowUp' ? 32 : -32)); savePrefs(); }
    });
    window.addEventListener('resize', () => { if (!drawer.hidden) { setHeight(prefs.height); place(); } });
    setInterval(paint, 30000);
  }

  function setHeight(px) {
    const max = Math.max(200, window.innerHeight - 96);
    prefs.height = Math.round(Math.min(max, Math.max(160, px)));
    if (drawer) drawer.style.height = `${prefs.height}px`;
    document.documentElement.style.setProperty('--term-drawer-space', drawer && !drawer.hidden ? `${prefs.height}px` : '0px');
  }
  function place() {
    const body = document.querySelector('.app > .body');
    // EasyMDE's full-screen modes cover the sidebar too, so the drawer spans the window then.
    const fullscreen = document.querySelector('.CodeMirror-fullscreen');
    const left = body && window.innerWidth > 700 && !fullscreen ? Math.max(0, body.getBoundingClientRect().left) : 0;
    drawer.style.left = `${left}px`;
  }

  function showDrawer(visible) {
    if (!drawer) buildDrawer();
    drawer.hidden = !visible;
    document.documentElement.classList.toggle('term-drawer-open', visible);
    setHeight(prefs.height);
    if (visible) { place(); paint(); refreshSummary(); connect(); refit(); }
    else disconnect();
    document.querySelectorAll('[data-term-toggle]').forEach(b => b.setAttribute('aria-expanded', String(visible)));
  }
  function toggle(force) {
    if (!sel || (blocked() && force !== false)) return;
    prefs.open = force === undefined ? !prefs.open : force;
    savePrefs();
    showDrawer(prefs.open);
    if (prefs.open && term) term.focus();
  }

  function paint() {
    if (!drawer) return;
    const pill = drawer.querySelector('[data-term-status]');
    pill.textContent = LABELS[status] || status; pill.dataset.state = status;
    // Lifecycle timing only matters once nobody is watching, so it stays in a tooltip.
    pill.title = info?.pause_after ? `Pauses ${span(info.pause_after)} after the last viewer leaves and is removed after ${span(info.remove_after)}. Files in the report folder are kept.` : '';
    const meta = [];
    if (info && status === 'connected') {
      meta.push(`Session ${minutes(Math.max(0, Date.now() / 1000 - info.created))}`);
      if (info.viewers > 1) meta.push(`${info.viewers} viewers`);
      if (info.folder) meta.push(`Folder ${info.folder}`);
    }
    drawer.querySelector('[data-term-meta]').textContent = meta.join(' · ');
    drawer.querySelector('[data-term-signin]').hidden = status !== 'signin';
    drawer.querySelector('[data-term-down]').hidden = status !== 'unavailable';
    drawer.querySelector('[data-term-screen]').hidden = status === 'signin' || status === 'unavailable';
    const login = drawer.querySelector('[data-term-login]');
    login.href = `${base || '/terminal/'}login?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`;
    drawer.querySelector('[data-term-reset]').disabled = status !== 'connected';
    drawer.querySelector('[data-term-evidence]').disabled = status !== 'connected';
  }

  async function onDrawerClick(event) {
    const target = event.target.closest('button,a');
    if (!target) return;
    if (target.matches('[data-term-close]')) toggle(false);
    else if (target.matches('[data-term-retry]')) { retry = 0; connect(); }
    else if (target.matches('[data-term-reset]')) {
      if (!resetArmed) {
        target.textContent = 'Confirm reset';
        resetArmed = setTimeout(() => { resetArmed = null; target.textContent = 'Reset sandbox'; }, 5000);
        return;
      }
      clearTimeout(resetArmed); resetArmed = null; target.textContent = 'Reset sandbox';
      target.disabled = true; note('Resetting the sandbox.');
      try { await api('api/reset', sel); note('Sandbox reset. The shell restarted in the report folder.'); }
      catch (error) { note(`Reset failed: ${error.message}`); }
      finally { paint(); }
    } else if (target.matches('[data-term-evidence]')) {
      target.disabled = true;
      try {
        const result = await api('api/evidence', sel);
        note(`Saved ${result.relative} in the report folder.`);
        const reload = [...document.querySelectorAll('#report-artifacts-host button')].find(b => /reload list/i.test(b.textContent));
        reload?.click();
      } catch (error) { note(`Not saved: ${error.message}`); }
      finally { paint(); }
    }
  }

  // -- play buttons and check marks ------------------------------------------
  function typeText(text, run) {
    if (blocked()) return;
    if (!prefs.open) toggle(true);
    const action = () => { term.paste(text); if (run) send({t: 'in', d: '\r'}); term.focus(); };
    if (ws && ws.readyState === 1 && status === 'connected') action();
    else { pending.push(action); connect(); }
  }

  function decorate() {
    if (!base || !sel) return;
    const host = document.getElementById('live-report-host') || document.getElementById('report-artifacts-host');
    const scope = host?.closest('section') || document;
    for (const container of scope.querySelectorAll(PREVIEWS)) {
      const blocks = [...container.querySelectorAll('pre')].filter(pre => !pre.closest('[data-term-controls]'));
      if (!blocks.length) continue;
      const texts = blocks.map(pre => (pre.querySelector('code') || pre).textContent);
      const keys = blockKeys(texts);
      blocks.forEach((pre, i) => {
        const lang = (pre.dataset.lang || '').toLowerCase();
        let bar = pre.previousElementSibling;
        if (!bar?.matches('[data-term-controls]')) {
          bar = document.createElement('div');
          bar.className = 'term-block-bar';
          bar.dataset.termControls = '';
          bar.contentEditable = 'false';
          bar.innerHTML = `<span class="term-lang">${esc(lang || 'text')}</span><button type="button" class="button sm term-play" data-term-type aria-label="Type into terminal" title="Type into terminal. Shift+click to run it."><i class="fa fa-play" aria-hidden="true"></i></button>${SHELLISH.has(lang) ? '<button type="button" class="button sm subtle" data-term-run title="Type and press Enter">Run</button>' : ''}<label class="term-check"><input type="checkbox" data-term-check> Checked</label>`;
          pre.before(bar);
        }
        for (const button of bar.querySelectorAll('[data-term-type],[data-term-run]')) {
          button.disabled = blocked();
          if (blocked()) button.title = mount.message; else button.title = button.matches('[data-term-run]') ? 'Type and press Enter' : 'Type into terminal. Shift+click to run it.';
        }
        bar.dataset.key = keys[i];
        bar.dataset.lang = lang;
        bar._text = texts[i];
        const box = bar.querySelector('[data-term-check]');
        box.checked = !!checks[keys[i]];
        box.disabled = !checksOk;
        box.title = checksOk ? '' : 'Check marks are unavailable while the terminal service is unreachable.';
      });
    }
    refreshSummary();
  }

  function sourceText() {
    const live = window.BoardLiveEditor?.sessions?.get(selKey);
    if (live?.cm) return live.cm.getValue();
    return document.getElementById('report-source')?.value ?? null;
  }
  function refreshSummary() {
    const el = drawer?.querySelector('[data-term-steps]');
    if (!el || !ctx?.markdown) return;
    const text = sourceText();
    if (text == null) { el.textContent = ''; return; }
    const tpl = document.createElement('template');
    tpl.innerHTML = ctx.markdown(text);
    const keys = blockKeys([...tpl.content.querySelectorAll('pre')].map(pre => (pre.querySelector('code') || pre).textContent));
    const done = keys.filter(k => checks[k]).length;
    el.textContent = !keys.length ? 'No code blocks in this report' : `${done} of ${keys.length} steps checked`;
    el.dataset.done = String(done); el.dataset.total = String(keys.length);
  }

  async function loadChecks() {
    if (!base || !sel) return;
    const key = selKey;
    try {
      const data = await api(`api/checks?${query(sel)}`);
      if (key !== selKey) return;
      checks = data.checks || {}; checksKey = key; checksOk = true;
    } catch { if (key === selKey) checksOk = false; }
    decorate();
  }
  async function setCheck(blockKey, checked) {
    checks = {...checks};
    if (checked) checks[blockKey] = Date.now() / 1000; else delete checks[blockKey];
    decorate();
    try { const data = await api('api/checks', {...sel, key: blockKey, checked}); if (checksKey === selKey) checks = data.checks || {}; }
    catch { await loadChecks(); }
    decorate();
  }

  document.addEventListener('click', event => {
    const bar = event.target.closest?.('[data-term-controls]');
    if (!bar) return;
    const text = commandText(bar._text || '', bar.dataset.lang || '');
    if (event.target.closest('[data-term-type]')) { event.preventDefault(); typeText(text, event.shiftKey); }
    else if (event.target.closest('[data-term-run]')) { event.preventDefault(); typeText(text, true); }
  });
  document.addEventListener('change', event => {
    if (event.target.matches?.('[data-term-check]')) setCheck(event.target.closest('[data-term-controls]').dataset.key, event.target.checked);
  });
  // Copying from the preview never includes the controls.
  document.addEventListener('copy', event => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return;
    const fragment = selection.getRangeAt(0).cloneContents();
    if (!fragment.querySelector('[data-term-controls]')) return;
    fragment.querySelectorAll('[data-term-controls]').forEach(el => el.remove());
    const holder = document.createElement('div');
    holder.className = 'term-copy-holder';
    holder.appendChild(fragment);
    document.body.appendChild(holder);
    event.clipboardData.setData('text/plain', holder.innerText);
    event.clipboardData.setData('text/html', holder.innerHTML);
    holder.remove();
    event.preventDefault();
  });
  window.addEventListener('keydown', event => {
    if (event.ctrlKey && !event.altKey && !event.metaKey && (event.code === 'Backquote' || event.key === '`') && sel && base) { event.preventDefault(); if (!blocked()) toggle(); }
  }, true);
  window.addEventListener('focus', () => { if (sel) loadChecks(); });

  // -- module hook --------------------------------------------------------------
  let observer = null, scheduled = false;
  function schedule() { if (!scheduled) { scheduled = true; requestAnimationFrame(() => { scheduled = false; decorate(); if (drawer && !drawer.hidden) place(); }); } }

  function placeToggle(host) {
    const holder = host.querySelector('.live-bar-actions') || host.closest('section')?.querySelector('h2');
    if (!holder || holder.querySelector('[data-term-toggle]') || (holder.tagName === 'H2' && holder.nextElementSibling?.matches('[data-term-toggle]'))) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button subtle term-toggle';
    button.dataset.termToggle = '';
    button.setAttribute('aria-controls', 'term-drawer');
    button.setAttribute('aria-expanded', String(!!prefs.open));
    button.title = 'Sandbox terminal (Ctrl+`)';
    button.innerHTML = '<i class="fa fa-terminal" aria-hidden="true"></i><span>Terminal</span>';
    button.addEventListener('click', () => toggle());
    const reason = document.createElement('span');
    reason.className = 'hint term-reason';
    reason.dataset.termReason = '';
    reason.id = `term-reason-${Date.now().toString(36)}`;
    reason.hidden = true;
    button.setAttribute('aria-describedby', reason.id);
    if (holder.tagName === 'H2') holder.after(button, reason); else holder.prepend(button, reason);
    applyMount();
  }

  // Disable the Terminal button (with the reason next to it) when the report has no finding folder.
  function applyMount() {
    const message = blocked() ? mount.message : '';
    document.querySelectorAll('[data-term-toggle]').forEach(button => {
      button.disabled = !!message;
      button.title = message || 'Sandbox terminal (Ctrl+`)';
    });
    document.querySelectorAll('[data-term-reason]').forEach(el => { el.textContent = message; el.hidden = !message; });
    if (message && drawer && !drawer.hidden) showDrawer(false);
    else if (!message && prefs.open && drawer?.hidden && sel) showDrawer(true);
  }
  async function loadMount() {
    const key = selKey;
    let result = null;
    try { result = await api(`api/mount?${query(sel)}`); } catch { result = null; }
    if (key !== selKey) return;
    mount = result;
    applyMount();
    schedule();
  }

  window.registerBoardModule?.({
    name: 'sandbox-terminal',
    afterRender(context) {
      ctx = context;
      base = context.state?.data?.capabilities?.terminal_url || null;
      const host = document.getElementById('live-report-host') || document.getElementById('report-artifacts-host');
      const next = base && host?.dataset.path ? {family: host.dataset.family, program: host.dataset.program, lane: host.dataset.lane, path: host.dataset.path} : null;
      if (!next) {
        document.querySelectorAll('[data-term-toggle],[data-term-reason],[data-term-controls]').forEach(el => el.remove());
        if (sel) { sel = null; selKey = ''; clearInterval(pollTimer); pollTimer = null; if (drawer) { drawer.hidden = true; document.documentElement.classList.remove('term-drawer-open'); disconnect(); setHeight(prefs.height); } }
        return;
      }
      placeToggle(host);
      if (!observer) { observer = new MutationObserver(schedule); observer.observe(context.app, {childList: true, subtree: true, attributes: true, attributeFilter: ['class']}); }
      const key = keyOf(next);
      if (key !== selKey) {
        sel = next; selKey = key; checks = {}; checksOk = false; info = null; pending = []; mount = null;
        disconnect(); retry = 0;
        if (term) term.reset();
        loadChecks();
        loadMount();
        clearInterval(pollTimer);
        pollTimer = setInterval(() => { if (!document.hidden) loadChecks(); }, 5000);
        showDrawer(!!prefs.open);
      }
      schedule();
    },
  });
  // Exposed for synthetic browser tests and diagnostics only.
  window.BoardTerminal = {blockKeys, sha256hex, commandText, get status() { return status; }, get checks() { return checks; }, get term() { return term; }};
})();
