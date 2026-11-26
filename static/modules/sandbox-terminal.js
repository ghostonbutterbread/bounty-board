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
 *
 * Terminal UX (docs/integrations/terminal-ux.md): copy on select, Ctrl+C copies
 * a selection, Ctrl+V pastes through the typing filter, a configurable toggle
 * shortcut (default Ctrl+E, plus the fixed Ctrl+`), docking (bottom, top, left,
 * right, maximize), a Settings section, and window.BoardTerminal slot/events.
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
  // -- preferences (localStorage, per browser) ---------------------------------
  // {open, height, width, dock, maximized, copyOnSelect, ctrlCCopy, ctrlVPaste, shortcut}.
  // open and height keep their original meaning; every field is validated on
  // read, so old or corrupt values fall back to the defaults.
  const DOCKS = ['bottom', 'top', 'left', 'right'];
  const narrow = () => window.innerWidth <= 700;   // phones: always the bottom sheet
  // Phones get a taller sheet by default; a saved height always wins.
  const defaultHeight = narrow() ? Math.round(window.innerHeight * 0.6) : 320;
  const DEFAULT_SHORTCUT = Object.freeze({ctrl: true, alt: false, shift: false, code: 'KeyE'});

  // Toggle shortcut: Ctrl or Alt (optionally Shift) plus one key. Letters match
  // by the typed letter (keyboard layouts), other keys by their position.
  const KEY_LABELS = {Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/'};
  for (let i = 0; i < 26; i++) KEY_LABELS[`Key${String.fromCharCode(65 + i)}`] = String.fromCharCode(65 + i);
  for (let i = 0; i < 10; i++) KEY_LABELS[`Digit${i}`] = String(i);
  const KEY_REFUSED = {Backquote: 'Ctrl+` is already the fixed terminal shortcut.', BracketLeft: 'The terminal reads it as Esc.', Backslash: 'It quits the running program in the terminal.',
    Minus: 'Browsers use it to zoom.', Equal: 'Browsers use it to zoom.', Tab: 'Browsers use it to switch tabs.'};
  const TAB = 'Browsers use it to switch tabs.', DEVTOOLS = 'Browsers open their developer tools with it.';
  const RESERVED = {
    'Ctrl+T': 'Browsers open a new tab with it.', 'Ctrl+W': 'Browsers close the tab with it.', 'Ctrl+N': 'Browsers open a new window with it.',
    'Ctrl+Q': 'Some browsers quit with it.', 'Ctrl+L': 'Browsers focus the address bar with it.', 'Ctrl+R': 'Browsers reload the page with it.',
    'Ctrl+C': 'The terminal needs it to interrupt programs and copy.', 'Ctrl+V': 'The terminal needs it to paste.',
    'Ctrl+D': 'The terminal needs it to end input.', 'Ctrl+Z': 'The terminal needs it to suspend programs.',
    'Ctrl+H': 'The terminal reads it as Backspace.', 'Ctrl+I': 'The terminal reads it as Tab.', 'Ctrl+J': 'The terminal reads it as Enter.', 'Ctrl+M': 'The terminal reads it as Enter.',
    'Ctrl+0': 'Browsers reset the zoom with it.',
    'Ctrl+K': 'The Board opens search with it.',
    'Ctrl+Shift+C': 'The terminal copies with it.', 'Ctrl+Shift+V': 'The terminal pastes with it.',
    'Ctrl+Shift+T': 'Browsers reopen a closed tab with it.', 'Ctrl+Shift+N': 'Browsers open a private window with it.', 'Ctrl+Shift+P': 'Firefox opens a private window with it.',
    'Ctrl+Shift+W': 'Browsers close the window with it.', 'Ctrl+Shift+Q': 'Some browsers quit with it.',
    'Ctrl+Shift+I': DEVTOOLS, 'Ctrl+Shift+J': DEVTOOLS, 'Ctrl+Shift+K': DEVTOOLS, 'Ctrl+Shift+E': DEVTOOLS, 'Ctrl+Shift+M': DEVTOOLS,
  };
  for (let i = 1; i < 10; i++) { RESERVED[`Ctrl+${i}`] = TAB; RESERVED[`Alt+${i}`] = TAB; }
  const shortcutLabel = s => [s.ctrl && 'Ctrl', s.alt && 'Alt', s.shift && 'Shift', KEY_LABELS[s.code] || s.code].filter(Boolean).join('+');
  // '' when the shortcut can be used, else a short reason.
  function shortcutProblem(s) {
    if (!s || typeof s !== 'object' || typeof s.code !== 'string') return 'Press Ctrl or Alt with one key.';
    if (KEY_REFUSED[s.code]) return KEY_REFUSED[s.code];
    if (!KEY_LABELS[s.code]) return 'Use a letter, a digit or one of ; \' , . /';
    if (s.ctrl && s.alt) return 'Use Ctrl or Alt, not both (Ctrl+Alt is AltGr on many keyboards).';
    if (!s.ctrl && !s.alt) return 'Hold Ctrl or Alt with the key.';
    return RESERVED[shortcutLabel(s)] || '';
  }
  const eventCode = e => (typeof e.key === 'string' && /^[a-z]$/i.test(e.key) ? `Key${e.key.toUpperCase()}` : e.code);
  const shortcutFromEvent = e => ({ctrl: !!e.ctrlKey, alt: !!e.altKey, shift: !!e.shiftKey, code: e.metaKey ? 'Meta' : eventCode(e)});
  const matches = (e, s) => !e.metaKey && e.ctrlKey === !!s.ctrl && e.altKey === !!s.alt && e.shiftKey === !!s.shift && eventCode(e) === s.code;
  const isFixedToggle = e => e.ctrlKey && !e.altKey && !e.metaKey && (e.code === 'Backquote' || e.key === '`');
  const isToggleKey = e => isFixedToggle(e) || matches(e, prefs.shortcut);

  function readStored() {
    try { const value = JSON.parse(localStorage.getItem(STORE) || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; }
  }
  function cleanPrefs(raw) {
    const size = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.round(v) : fallback);
    const flag = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
    const s = raw.shortcut;
    return {open: raw.open === true, height: size(raw.height, defaultHeight), width: size(raw.width, 520), dock: DOCKS.includes(raw.dock) ? raw.dock : 'bottom',
      maximized: raw.maximized === true, copyOnSelect: flag(raw.copyOnSelect, true), ctrlCCopy: flag(raw.ctrlCCopy, true), ctrlVPaste: flag(raw.ctrlVPaste, true),
      shortcut: shortcutProblem(s) ? {...DEFAULT_SHORTCUT} : {ctrl: !!s.ctrl, alt: !!s.alt, shift: !!s.shift, code: s.code}};
  }
  const prefs = cleanPrefs(readStored());
  // Unknown fields written by a newer Board are kept.
  const savePrefs = () => { try { localStorage.setItem(STORE, JSON.stringify({...readStored(), ...prefs})); } catch {} };
  const prefListeners = new Set();

  // -- extension points for other modules (window.BoardTerminal) ----------------
  // slot(name): a stable, initially empty element in the drawer header (hidden
  // while empty). Events: 'session' {selector, session} on attach/reset and with
  // nulls when the drawer closes or the report changes; 'message' with every
  // parsed server text message.
  const slots = new Map();
  function slot(name) {
    name = String(name);
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) throw new Error(`Invalid terminal slot name: ${name}`);
    let el = slots.get(name);
    if (!el) {
      el = document.createElement('span');
      el.className = 'term-slot';
      el.dataset.termSlot = name;
      slots.set(name, el);
      drawer?.querySelector('[data-term-slots]')?.appendChild(el);
    }
    return el;
  }
  const listeners = {session: new Set(), message: new Set()};
  function on(type, callback) { if (listeners[type] && typeof callback === 'function') listeners[type].add(callback); return () => off(type, callback); }
  function off(type, callback) { listeners[type]?.delete(callback); }
  function emit(type, payload) {
    for (const callback of [...listeners[type]]) { try { callback(payload); } catch (error) { console.error(`Terminal ${type} listener failed:`, error); } }
  }
  let sessionLive = false;
  function emitSession() { sessionLive = true; emit('session', {selector: sel ? {...sel} : null, session: info}); }
  function emitClosed() { if (sessionLive) { sessionLive = false; emit('session', {selector: null, session: null}); } }
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

  // Text that must never be typed into a terminal: ESC (it can end bracketed
  // paste with ESC[201~ and run what follows), any other C0 control except tab
  // and newline, DEL, and C1 controls (U+0080-U+009F, e.g. the 8-bit CSI).
  // Also bidi and invisible characters, which can make the preview show a
  // different command from the one Run sends: soft hyphen, Arabic letter mark,
  // zero-width and directional marks, embeddings/overrides, isolates and word
  // joiners, BOM, and the Unicode line and paragraph separators.
  const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff\u2028\u2029]/;
  const unsafeText = text => UNSAFE.test(String(text));
  const UNSAFE_MESSAGE = 'This block contains control characters and cannot be typed; copy it manually after review.';
  // Pastes go through the same filter. Windows clipboards end lines with CRLF;
  // xterm turns CRLF and LF into the same Enter, so only CRLF is read as a
  // newline here. A lone CR is still refused, and nothing is ever stripped.
  const unsafePaste = text => unsafeText(String(text).replace(/\r\n/g, '\n'));
  const PASTE_REFUSED = 'Paste refused: the clipboard text contains control characters.';

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
    const screenEl = drawer.querySelector('[data-term-screen]');
    term.open(screenEl);
    term.attachCustomKeyEventHandler(onTermKey);
    term.onData(data => send({t: 'in', d: data}));
    term.onResize(({cols, rows}) => send({t: 'resize', cols, rows}));
    // Copy on select: when a mouse selection (drag, double or triple click) ends.
    let selecting = false;
    screenEl.addEventListener('mousedown', event => { if (event.button === 0) selecting = true; });
    document.addEventListener('mouseup', event => {
      if (!selecting || event.button !== 0) return;
      selecting = false;
      // xterm settles the selection in its own mouseup handler; the click's
      // user activation still allows the clipboard write a moment later.
      setTimeout(() => { if (prefs.copyOnSelect && term.hasSelection()) copySelection(false); }, 0);
    });
    // Paste guard: every paste (keys, context menu, middle click) reaches
    // xterm's own listeners below this element, so a capture listener here sees
    // it first and stops unsafe text before xterm can send it.
    screenEl.addEventListener('paste', event => {
      if (!unsafePaste(event.clipboardData?.getData('text/plain') ?? '')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      note(PASTE_REFUSED);
    }, true);
    new ResizeObserver(() => refit()).observe(screenEl);
    new MutationObserver(() => { if (term) term.options.theme = themeColors(); }).observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme']});
    refit();
  }

  // xterm key handler: false means xterm ignores the key (nothing is sent).
  function onTermKey(event) {
    if (isToggleKey(event)) return false;
    if (event.type !== 'keydown') return true;
    const ctrl = event.ctrlKey && !event.altKey && !event.metaKey;
    const code = eventCode(event);
    if (ctrl && code === 'KeyC' && (event.shiftKey || prefs.ctrlCCopy) && term.hasSelection()) {
      event.preventDefault();
      copySelection(true);
      return false;
    }
    if (ctrl && event.shiftKey && code === 'KeyC') return false;   // Ctrl+Shift+C never sends ^C
    if (ctrl && !event.shiftKey && event.key === 'Insert') {
      if (term.hasSelection()) { event.preventDefault(); copySelection(false); }
      return false;
    }
    // Paste keys: let the browser fire its native paste event, which the paste
    // guard and then xterm handle (bracketed paste when the shell has it on).
    if (ctrl && code === 'KeyV' && (event.shiftKey || prefs.ctrlVPaste)) return false;
    if (event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && event.key === 'Insert') return false;
    return true;
  }

  // -- clipboard ---------------------------------------------------------------
  let flashTimer = null;
  function flash(text, tone) {
    const el = drawer?.querySelector('[data-term-flash]');
    if (!el) return;
    el.textContent = text; el.dataset.tone = tone; el.hidden = false;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { el.hidden = true; }, 1600);
  }
  function copySelection(clear) {
    const text = term?.getSelection() || '';
    if (!text) return;
    if (clear) term.clearSelection();
    copyText(text).then(ok => flash(ok ? 'Copied' : 'Copy blocked by the browser', ok ? 'ok' : 'warn'));
  }
  async function copyText(text) {
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(text); return true; } catch {}
    }
    return execCopy(text);
  }
  // Fallback for browsers without the async Clipboard API (or when it refuses).
  function execCopy(text) {
    const area = document.createElement('textarea');
    const previous = document.activeElement;
    area.value = text; area.readOnly = true; area.className = 'term-copy-holder';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    area.remove();
    previous?.focus?.({preventScroll: true});
    return ok;
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
        if (wantFocus) { wantFocus = false; term.focus(); }
        emitSession();
        const queued = pending; pending = [];
        queued.forEach(fn => fn());
      } else if (message.type === 'viewers') { if (info) info.viewers = message.count; paint(); }
      else if (message.type === 'reset') { term.reset(); note('Sandbox reset.'); emitSession(); }
      else if (message.type === 'exit') { if (info) info.running = false; paint(); }
      else if (message.type === 'error') { note(message.message || 'The sandbox could not start.'); setStatus('error'); }
      else if (message.type === 'closed') { note(message.message || 'The sandbox closed.'); }
      emit('message', message);
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

  // Dock picker icons (16px, currentColor): a window with the docked side filled.
  const dockIcon = fill => `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor"/>${fill}</svg>`;
  const DOCK_BUTTONS = [
    ['left', 'Dock left', dockIcon('<rect x="2" y="3" width="4.5" height="10" rx="1" fill="currentColor"/>')],
    ['bottom', 'Dock bottom', dockIcon('<rect x="2" y="8.5" width="12" height="4.5" rx="1" fill="currentColor"/>')],
    ['top', 'Dock top', dockIcon('<rect x="2" y="3" width="12" height="4.5" rx="1" fill="currentColor"/>')],
    ['right', 'Dock right', dockIcon('<rect x="9.5" y="3" width="4.5" height="10" rx="1" fill="currentColor"/>')],
  ];
  const MAX_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const RESTORE_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path d="M6 2.5V6H2.5M13.5 6H10V2.5M10 13.5V10h3.5M2.5 10H6v3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const shortcutText = () => shortcutLabel(prefs.shortcut);

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
        <span class="term-flash" data-term-flash role="status" aria-live="polite" hidden></span>
        <span class="hint term-meta" data-term-meta></span>
        <span class="term-steps" data-term-steps></span>
        <span class="term-tools">
          <span class="term-slots" data-term-slots></span>
          <span class="term-dock" role="group" aria-label="Terminal position" data-term-dock>${DOCK_BUTTONS.map(([dock, label, svg]) => `<button type="button" class="term-dock-btn" data-dock="${dock}" aria-pressed="false" aria-label="${label}" title="${label}">${svg}</button>`).join('')}<span class="term-dock-sep" aria-hidden="true"></span><button type="button" class="term-dock-btn" data-dock-max aria-pressed="false" aria-label="Maximize" title="Maximize">${MAX_ICON}</button></span>
          <span class="term-actions">
            <button type="button" class="button sm" data-term-reset>Reset sandbox</button>
            <button type="button" class="button sm" data-term-evidence>Save output as evidence</button>
            <button type="button" class="button sm ghost icon-only" data-term-close aria-label="Close terminal"><i class="fa fa-times" aria-hidden="true"></i></button>
          </span>
        </span>
      </div>
      <div class="term-note hint" data-term-note role="status" hidden></div>
      <div class="term-body">
        <div class="term-screen" data-term-screen></div>
        <div class="term-signin" data-term-signin hidden><p>Sign in to use the terminal. Your tailnet account is not on the terminal allowlist.</p><a class="button primary" data-term-login href="#">Sign in</a></div>
        <div class="term-signin" data-term-down hidden><p>The terminal service is not running or not reachable. The Board keeps working; try again later.</p><button type="button" class="button" data-term-retry>Try again</button></div>
      </div>`;
    document.body.appendChild(drawer);
    const slotHost = drawer.querySelector('[data-term-slots]');
    slots.forEach(el => slotHost.appendChild(el));
    drawer.addEventListener('click', onDrawerClick);
    const handle = drawer.querySelector('[data-term-resize]');
    handle.addEventListener('pointerdown', event => {
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      // Size follows the pointer from where the handle was grabbed.
      const dock = currentDock(), start = currentSize(), x0 = event.clientX, y0 = event.clientY;
      const move = e => setSize(start + (dock === 'bottom' ? y0 - e.clientY : dock === 'top' ? e.clientY - y0 : dock === 'right' ? x0 - e.clientX : e.clientX - x0));
      const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); savePrefs(); };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
    // Arrow keys on the handle: the key pointing away from the docked edge grows the drawer.
    const GROW = {bottom: ['ArrowUp', 'ArrowDown'], top: ['ArrowDown', 'ArrowUp'], right: ['ArrowLeft', 'ArrowRight'], left: ['ArrowRight', 'ArrowLeft']};
    handle.addEventListener('keydown', event => {
      const dock = currentDock(), [grow, shrink] = GROW[dock];
      if (event.key !== grow && event.key !== shrink) return;
      event.preventDefault();
      setSize(currentSize() + (event.key === grow ? 32 : -32));
      savePrefs();
    });
    window.addEventListener('resize', () => { if (!drawer.hidden) layout(); });
    const sidebar = document.querySelector('.app > .sidebar');
    if (sidebar && window.ResizeObserver) new ResizeObserver(() => { if (!drawer.hidden) layout(); }).observe(sidebar);
    setInterval(paint, 30000);
    paintTitles();
  }

  // -- docking -------------------------------------------------------------------
  const currentDock = () => (narrow() ? 'bottom' : prefs.dock);
  const isMaximized = () => !narrow() && prefs.maximized;
  const vertical = dock => dock === 'top' || dock === 'bottom';
  // The sidebar stays visible: docks and maximize cover only the content column.
  // EasyMDE's full-screen modes cover the sidebar too, so the drawer spans the window then.
  function contentLeft() {
    if (narrow() || document.querySelector('.CodeMirror-fullscreen')) return 0;
    const sidebar = document.querySelector('.app > .sidebar');
    return sidebar ? Math.max(0, Math.round(sidebar.getBoundingClientRect().right)) : 0;
  }
  // Minimum 160 px; at least about 320 px of content stays visible (phones keep a tall sheet).
  function clampSize(dock, px) {
    const room = vertical(dock) ? window.innerHeight - (narrow() ? 96 : 320) : window.innerWidth - contentLeft() - 320;
    return Math.round(Math.min(Math.max(160, room), Math.max(160, px)));
  }
  const currentSize = () => clampSize(currentDock(), vertical(currentDock()) ? prefs.height : prefs.width);
  function setSize(px) {
    const dock = currentDock();
    if (vertical(dock)) prefs.height = clampSize(dock, px); else prefs.width = clampSize(dock, px);
    layout();
  }
  // Positions the drawer and reserves its space through root classes and
  // --term-space-{top,right,bottom,left} (see sandbox-terminal.css).
  function layout() {
    const root = document.documentElement;
    const open = !!drawer && !drawer.hidden, dock = currentDock(), max = isMaximized();
    root.classList.toggle('term-drawer-open', open);
    root.classList.toggle('term-max', open && max);
    for (const side of DOCKS) root.classList.toggle(`term-dock-${side}`, open && !max && dock === side);
    const size = open && !max ? currentSize() : 0;
    for (const side of DOCKS) root.style.setProperty(`--term-space-${side}`, side === dock && size ? `${size}px` : '0px');
    root.style.setProperty('--term-drawer-space', `${size}px`);
    if (!drawer) return;
    const left = contentLeft(), style = drawer.style;
    drawer.dataset.dock = max ? 'max' : dock;
    style.left = max || vertical(dock) || dock === 'left' ? `${left}px` : 'auto';
    style.right = max || vertical(dock) || dock === 'right' ? '0px' : 'auto';
    style.top = max || !vertical(dock) || dock === 'top' ? '0px' : 'auto';
    style.bottom = max || !vertical(dock) || dock === 'bottom' ? '0px' : 'auto';
    style.height = !max && vertical(dock) ? `${size}px` : 'auto';
    style.width = !max && !vertical(dock) ? `${size}px` : 'auto';
    const handle = drawer.querySelector('[data-term-resize]');
    handle.hidden = max;
    handle.setAttribute('aria-orientation', vertical(dock) ? 'horizontal' : 'vertical');
    paintDock();
    if (open) requestAnimationFrame(refit);
  }
  function paintDock() {
    if (!drawer) return;
    const max = !!prefs.maximized;
    drawer.querySelectorAll('[data-dock]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.dock === prefs.dock)));
    const maxButton = drawer.querySelector('[data-dock-max]');
    maxButton.setAttribute('aria-pressed', String(max));
    maxButton.title = max ? 'Restore' : 'Maximize';
    maxButton.setAttribute('aria-label', maxButton.title);
    maxButton.innerHTML = max ? RESTORE_ICON : MAX_ICON;
  }
  // The dock picker and Settings share one stored choice; picking a side leaves maximize.
  function setDock(dock) {
    if (!DOCKS.includes(dock)) return;
    prefs.dock = dock; prefs.maximized = false;
    savePrefs(); layout(); notifyPrefs();
  }
  function setMaximized(value) { prefs.maximized = !!value; savePrefs(); layout(); notifyPrefs(); }

  function showDrawer(visible) {
    if (!drawer) buildDrawer();
    drawer.hidden = !visible;
    layout();
    if (visible) { paint(); refreshSummary(); connect(); refit(); }
    else { disconnect(); emitClosed(); }
    document.querySelectorAll('[data-term-toggle]').forEach(b => b.setAttribute('aria-expanded', String(visible)));
  }
  // Opening focuses the terminal; closing returns focus to where it was before
  // opening (if that element still exists), else to the report editor.
  let returnFocus = null, wantFocus = false;
  function toggle(force) {
    if (!sel || (blocked() && force !== false)) return;
    const next = force === undefined ? !prefs.open : force;
    if (next && !prefs.open) {
      const active = document.activeElement;
      returnFocus = active && active !== document.body && !drawer?.contains(active) ? active : null;
    }
    const closing = !next && prefs.open;
    prefs.open = next;
    savePrefs();
    showDrawer(prefs.open);
    if (prefs.open) { if (term) term.focus(); else wantFocus = true; }
    if (closing) restoreFocus();
  }
  function restoreFocus() {
    const target = returnFocus;
    returnFocus = null; wantFocus = false;
    if (target?.isConnected && !target.closest('[hidden]') && !target.disabled) { target.focus({preventScroll: true}); if (document.activeElement === target) return; }
    const cm = document.querySelector('#live-report-host .CodeMirror')?.CodeMirror;
    if (cm) { cm.focus(); return; }
    (document.getElementById('report-source-editor') || document.querySelector('[data-term-toggle]'))?.focus({preventScroll: true});
  }
  // Tooltips name the current primary shortcut.
  function paintTitles() {
    const keys = shortcutText();
    document.querySelectorAll('[data-term-toggle]').forEach(b => { if (!b.disabled) b.title = `Sandbox terminal (${keys})`; });
    const close = drawer?.querySelector('[data-term-close]');
    if (close) close.title = `Close terminal (${keys})`;
  }
  const notifyPrefs = () => prefListeners.forEach(fn => { try { fn(prefs); } catch (error) { console.error('Terminal settings listener failed:', error); } });
  // Another tab changed the preferences: apply everything except the open state.
  window.addEventListener('storage', event => {
    if (event.key !== STORE && event.key !== null) return;
    const {open, ...next} = cleanPrefs(readStored());
    Object.assign(prefs, next);
    layout(); paintTitles(); notifyPrefs();
  });

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
    else if (target.matches('[data-dock]')) setDock(target.dataset.dock);
    else if (target.matches('[data-dock-max]')) setMaximized(!prefs.maximized);
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
    if (blocked() || unsafeText(text)) return;  // never send control characters, whatever the caller
    text = text.replace(/\n+$/, '');            // typing alone never presses Enter
    if (!prefs.open) toggle(true);
    const action = () => {
      // Without bracketed paste a multi-line block would run line by line; only Run may do that.
      if (!run && text.includes('\n') && !term.modes?.bracketedPasteMode) { note('This shell does not accept multi-line typing safely. Use Run, or type the lines one by one.'); return; }
      term.paste(text);
      if (run) send({t: 'in', d: '\r'});
      term.focus();
    };
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
        const unsafe = unsafeText(texts[i]);
        for (const button of bar.querySelectorAll('[data-term-type],[data-term-run]')) {
          button.disabled = blocked() || unsafe;
          button.title = unsafe ? UNSAFE_MESSAGE : blocked() ? mount.message
            : button.matches('[data-term-run]') ? 'Type and press Enter' : 'Type into terminal. Shift+click to run it.';
        }
        let warning = bar.querySelector('[data-term-unsafe]');
        if (unsafe && !warning) {
          warning = document.createElement('span');
          warning.className = 'term-unsafe';
          warning.dataset.termUnsafe = '';
          warning.setAttribute('role', 'note');
          warning.textContent = UNSAFE_MESSAGE;
          bar.querySelector('.term-lang').after(warning);
        } else if (!unsafe && warning) warning.remove();
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
  // Toggle shortcut (Settings, default Ctrl+E) and the fixed Ctrl+`, from anywhere
  // in the Board, including the terminal and the editor. Whenever the Board has
  // a terminal the keys are kept from the browser (Firefox focuses its search
  // bar on Ctrl+E); they only toggle when the report has a terminal.
  window.addEventListener('keydown', event => {
    if (!base || !isToggleKey(event) || event.target?.closest?.('[data-shortcut-recorder]')) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat && sel && !blocked()) toggle();
  }, true);
  window.addEventListener('focus', () => { if (sel) loadChecks(); });

  // -- module hook --------------------------------------------------------------
  let observer = null, scheduled = false;
  function schedule() { if (!scheduled) { scheduled = true; requestAnimationFrame(() => { scheduled = false; decorate(); if (drawer && !drawer.hidden) layout(); }); } }

  function placeToggle(host) {
    const holder = host.querySelector('.live-bar-actions') || host.closest('section')?.querySelector('h2');
    if (!holder || holder.querySelector('[data-term-toggle]') || (holder.tagName === 'H2' && holder.nextElementSibling?.matches('[data-term-toggle]'))) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button subtle term-toggle';
    button.dataset.termToggle = '';
    button.setAttribute('aria-controls', 'term-drawer');
    button.setAttribute('aria-expanded', String(!!prefs.open));
    button.title = `Sandbox terminal (${shortcutText()})`;
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
      button.title = message || `Sandbox terminal (${shortcutText()})`;
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
        if (sel) { sel = null; selKey = ''; clearInterval(pollTimer); pollTimer = null; if (drawer) { drawer.hidden = true; disconnect(); layout(); } emitClosed(); }
        return;
      }
      placeToggle(host);
      if (!observer) { observer = new MutationObserver(schedule); observer.observe(context.app, {childList: true, subtree: true, attributes: true, attributeFilter: ['class']}); }
      const key = keyOf(next);
      if (key !== selKey) {
        sel = next; selKey = key; checks = {}; checksOk = false; info = null; pending = []; mount = null;
        disconnect(); emitClosed(); retry = 0;
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
  // -- settings section (static/modules/settings.js registry) ------------------
  const SETTING_TOGGLES = [
    ['copyOnSelect', 'Copy on select', 'Selecting text in the terminal copies it to the clipboard.'],
    ['ctrlCCopy', 'Ctrl+C copies a selection', 'With text selected, Ctrl+C copies it instead of interrupting. Without a selection it still interrupts.'],
    ['ctrlVPaste', 'Ctrl+V pastes', 'Off: Ctrl+V goes to the shell. Ctrl+Shift+V and Shift+Insert always paste.'],
  ];
  function renderSettings(host) {
    const id = name => `set-term-${name}`;
    host.innerHTML = `${SETTING_TOGGLES.map(([key, label, hint]) => `<div class="set-row"><div class="set-text"><label for="${id(key)}">${esc(label)}</label><p class="hint" id="${id(key)}-hint">${esc(hint)}</p></div><input type="checkbox" role="switch" class="set-switch" id="${id(key)}" data-term-pref="${key}" aria-describedby="${id(key)}-hint"></div>`).join('')}
      <div class="set-row"><div class="set-text"><span class="set-label" id="${id('shortcut')}-label">Toggle shortcut</span><p class="hint" id="${id('shortcut')}-hint" data-shortcut-msg role="status" aria-live="polite"></p></div>
        <div class="set-controls"><button type="button" class="button sm set-recorder" data-shortcut-recorder aria-labelledby="${id('shortcut')}-label ${id('shortcut')}-key" aria-describedby="${id('shortcut')}-hint"><span id="${id('shortcut')}-key" data-shortcut-key></span></button><button type="button" class="button sm ghost" data-shortcut-reset>Reset to Ctrl+E</button></div></div>
      <div class="set-row"><div class="set-text"><span class="set-label" id="${id('dock')}-label">Default dock</span><p class="hint">The picker in the terminal header changes it too. Phones always use a bottom sheet.</p></div>
        <div class="segmented" role="group" aria-labelledby="${id('dock')}-label">${['bottom', 'top', 'left', 'right'].map(d => `<button type="button" data-set-dock="${d}" aria-pressed="false">${d[0].toUpperCase()}${d.slice(1)}</button>`).join('')}</div></div>`;
    const recorder = host.querySelector('[data-shortcut-recorder]'), message = host.querySelector('[data-shortcut-msg]');
    const idleHint = () => `Opens and closes the terminal of the open report. Ctrl+\` also works.`;
    let recording = false;
    const sync = () => {
      host.querySelectorAll('[data-term-pref]').forEach(box => { box.checked = !!prefs[box.dataset.termPref]; });
      if (!recording) recorder.querySelector('[data-shortcut-key]').textContent = shortcutText();
      recorder.setAttribute('aria-pressed', String(recording));
      host.querySelector('[data-shortcut-reset]').disabled = !shortcutProblem(prefs.shortcut) && shortcutText() === 'Ctrl+E';
      host.querySelectorAll('[data-set-dock]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.setDock === prefs.dock)));
    };
    const stop = text => { recording = false; message.textContent = text || idleHint(); sync(); };
    const saveShortcut = shortcut => {
      prefs.shortcut = shortcut; savePrefs(); paintTitles(); notifyPrefs();
      stop(`Saved. ${shortcutText()} now opens and closes the terminal.${shortcutText() === 'Ctrl+E' ? '' : ' Ctrl+E goes to the shell again.'}`);
    };
    host.addEventListener('change', event => {
      const key = event.target.dataset?.termPref;
      if (!key) return;
      prefs[key] = event.target.checked; savePrefs(); notifyPrefs();
    });
    host.addEventListener('click', event => {
      const target = event.target.closest('button');
      if (!target) return;
      if (target === recorder) {
        recording = !recording;
        if (recording) { recorder.querySelector('[data-shortcut-key]').textContent = 'Press keys'; message.textContent = 'Press Ctrl or Alt (and Shift if you like) with one key. Esc cancels.'; sync(); }
        else stop();
      } else if (target.matches('[data-shortcut-reset]')) saveShortcut({...DEFAULT_SHORTCUT});
      else if (target.dataset.setDock) setDock(target.dataset.setDock);
    });
    recorder.addEventListener('keydown', event => {
      if (!recording || event.key === 'Tab') return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === 'Escape') { stop(); return; }
      if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'OS'].includes(event.key)) return;
      const next = shortcutFromEvent(event), problem = event.metaKey ? 'Use Ctrl or Alt.' : shortcutProblem(next);
      if (problem) { message.textContent = `${shortcutLabel(next)} is not available. ${problem}`; return; }
      saveShortcut(next);
    });
    recorder.addEventListener('blur', () => { if (recording) stop(); });
    message.textContent = idleHint();
    sync();
    prefListeners.add(sync);
    return () => prefListeners.delete(sync);
  }
  window.BoardSettings?.register?.({id: 'terminal', group: 'terminal', title: 'Terminal', order: 0, render: renderSettings});

  // Public API. slot/on/off/selector/session are for other feature modules
  // (documented in docs/integrations/terminal-ux.md); the rest is for synthetic
  // browser tests and diagnostics only.
  window.BoardTerminal = {blockKeys, sha256hex, commandText, unsafeText, unsafePaste, shortcutProblem, shortcutLabel,
    get status() { return status; }, get checks() { return checks; }, get term() { return term; }, get prefs() { return {...prefs, shortcut: {...prefs.shortcut}}; },
    slot, on, off, selector: () => (sel ? {...sel} : null), session: () => (sel && info && drawer && !drawer.hidden ? info : null)};
})();
