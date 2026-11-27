/* Live report editor (feature module).
 *
 * Every edit autosaves to the Board server, which merges it with changes from
 * agents, other tabs and sync clients (see live_editing.py and
 * docs/integrations/live-report-editing.md). This module never decides what
 * wins: overlapping edits come back as conflict markers for the person editing.
 *
 * No-loss rules kept here:
 * - `base` is the server revision the editor text is based on.
 * - Unsaved text is mirrored to localStorage (with its base) on every edit and
 *   only cleared once the server confirms text equal to the editor.
 * - One save is in flight per report; text typed meanwhile is saved next with
 *   the revision the server stored for the earlier save as its base.
 * - Remote updates are applied only while the editor holds no unsaved text.
 */
(() => {
  'use strict';
  const SAVE_DELAY = 700;
  const MAX_BACKOFF = 30000;
  const BACKUP_PREFIX = 'bounty-board-live:v1:';
  const LOCK_PREFIX = 'bounty-board-live-client:';
  const OUTSIDE = 'Changed outside the Board';
  const CLIENT = (crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join(''));
  const AUTHOR = (() => {
    try { const name = localStorage.getItem('bounty-board-live-author'); if (name && name.length <= 60 && !/[\u0000-\u001f]/.test(name)) return name; } catch {}
    return 'Board editor';
  })();
  // Each tab holds a Web Lock for its lifetime, so a newly opened tab can tell
  // backups of live tabs apart from backups left by closed or crashed ones.
  const lockHeld = navigator.locks?.request
    ? new Promise(resolve => navigator.locks.request(LOCK_PREFIX + CLIENT, () => { resolve(true); return new Promise(() => {}); }).catch(() => resolve(false)))
    : Promise.resolve(false);
  const sessions = new Map();
  let ctx = null;

  const esc = value => (ctx?.esc ? ctx.esc(value) : String(value ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`));
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const backoff = previous => Math.min(MAX_BACKOFF, Math.max(1000, previous * 2));
  // Matches the server: 7 or more angle brackets, a space, a label ending in '(Bounty Board)'.
  const MARKER = /^(<{7,}|>{7,}) (.*)\(Bounty Board\)$/;
  const isMarker = line => MARKER.test(line);
  const hasMarkers = text => text.split('\n').some(isMarker);
  const parse = raw => { try { return JSON.parse(raw); } catch { return null; } };
  const selectorOf = data => ({family: data.family || '', program: data.program || '', lane: data.lane || '', path: data.path || ''});
  const keyOf = sel => JSON.stringify([sel.family, sel.program, sel.lane, sel.path]);

  // -- transport ---------------------------------------------------------
  async function call(view, sel, extra = {}, body = null) {
    const query = new URLSearchParams({family: sel.family, program: sel.program, lane: sel.lane, path: sel.path, ...extra});
    const options = body
      ? {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Requested-With': 'Bounty-Board'}, body: JSON.stringify(body), signal: AbortSignal.timeout(30000)}
      : {cache: 'no-store', signal: AbortSignal.timeout(15000)};
    let response;
    try { response = await fetch(`/api/live/${view}?${query}`, options); }
    catch { const error = new Error('offline'); error.offline = true; throw error; }
    let data = null;
    try { data = await response.json(); } catch {}
    if (!response.ok) {
      const error = new Error(`Request failed (${response.status})`);
      Object.assign(error, {status: response.status, code: data?.error, reason: data?.reason, offline: response.status >= 500 || response.status === 429});
      throw error;
    }
    if (!data || typeof data !== 'object') { const error = new Error('bad response'); error.offline = true; throw error; }
    return data;
  }

  // -- browser backups -----------------------------------------------------
  const rootTag = () => (/^[a-f0-9]{64}$/.test(ctx?.state?.data?.root_identity || '') ? ctx.state.data.root_identity : '');
  const backupPrefix = s => `${BACKUP_PREFIX}${JSON.stringify([s.root, s.sel.family, s.sel.program, s.sel.lane, s.sel.path])}|`;

  function writeBackup(s) {
    try {
      localStorage.setItem(s.backupKey, JSON.stringify({v: 1, base: s.base, text: s.cm.getValue(), client: CLIENT, updated: Date.now(), copy: s.resolvingCopy || null}));
      s.storageError = false;
    } catch { s.storageError = true; }
  }
  function clearBackup(s) { try { localStorage.removeItem(s.backupKey); } catch {} }

  async function orphanBackups(s) {
    const prefix = backupPrefix(s), found = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith(prefix) || key === s.backupKey) continue;
        const backup = parse(localStorage.getItem(key));
        if (backup && typeof backup.text === 'string' && typeof backup.base === 'string') found.push({key, backup});
      }
    } catch { return []; }
    if (!found.length) return [];
    let held = null;
    if (await lockHeld && navigator.locks?.query) {
      try { held = new Set((await navigator.locks.query()).held.map(lock => lock.name)); } catch {}
    }
    return found
      // Without Web Locks (insecure origins), live tabs refresh `updated`
      // every few seconds while they hold unsaved text; see the heartbeat.
      .filter(({backup}) => (held ? !held.has(LOCK_PREFIX + backup.client) : Date.now() - (backup.updated || 0) > 60000))
      .sort((a, b) => (a.backup.updated || 0) - (b.backup.updated || 0));
  }

  // -- editor text ---------------------------------------------------------
  // Replace only the differing middle so the cursor, selection and scroll
  // position survive remote updates.
  function applyText(s, next) {
    const cm = s.cm, current = cm.getValue();
    if (current === next) return;
    const max = Math.min(current.length, next.length);
    let start = 0;
    while (start < max && current.charCodeAt(start) === next.charCodeAt(start)) start++;
    let end = 0;
    while (end < max - start && current.charCodeAt(current.length - 1 - end) === next.charCodeAt(next.length - 1 - end)) end++;
    const from = cm.posFromIndex(start), to = cm.posFromIndex(current.length - end);
    const scroll = cm.getScrollInfo();
    const anchor = cm.lineAtHeight(scroll.top, 'local');
    const offset = scroll.top - cm.heightAtLine(anchor, 'local');
    const linesBefore = cm.lineCount();
    s.applying = true;
    try {
      cm.operation(() => {
        cm.replaceRange(next.slice(start, next.length - end), from, to, '+live');
        if (to.line < anchor) cm.scrollTo(null, cm.heightAtLine(anchor + cm.lineCount() - linesBefore, 'local') + offset);
      });
    } finally { s.applying = false; }
    // Undo must never remove text written by someone else and save that, so
    // the undo history restarts whenever foreign text enters the editor.
    cm.clearHistory();
    if (s.conflict) refreshConflict(s);
    refreshPreview(s);
  }

  // EasyMDE renders the full Preview only when it is switched on (side by side
  // follows edits by itself), so text arriving while someone reads the
  // Preview must be rendered into it here, keeping the reading position.
  function refreshPreview(s) {
    if (!s.mde?.isPreviewActive()) return;
    const preview = s.cm.getWrapperElement().lastChild;
    const top = preview.scrollTop;
    const html = s.mde.options.previewRender(s.cm.getValue(), preview);
    if (html != null) preview.innerHTML = html;
    preview.scrollTop = top;
  }

  function conflictBlocks(cm) {
    const blocks = [];
    let block = null;
    for (let i = 0; i < cm.lineCount(); i++) {
      const line = cm.getLine(i);
      const marker = line.match(MARKER);
      // Separator lines have exactly the opening marker's width, so a Markdown
      // underline inside a side is not taken for one.
      if (marker && marker[1][0] === '<') block = {start: i, size: marker[1].length, first: marker[2].trim(), split: null, mid: null};
      else if (block && block.mid === null && block.split === null && line.startsWith('|'.repeat(block.size) + ' ')) block.split = i;
      else if (block && block.mid === null && line === '='.repeat(block.size)) block.mid = i;
      else if (block && block.mid !== null && marker && marker[1] === '>'.repeat(block.size)) {
        blocks.push({...block, end: i, second: marker[2].trim()});
        block = null;
      }
    }
    return blocks;
  }

  function sideNames(block) {
    const mine = block.first.startsWith('your edit') ? 'mine' : block.first.startsWith('current file') ? 'current file' : 'first';
    const theirs = block.second.startsWith('saved version') ? 'saved' : block.second.startsWith('Syncthing') ? 'Syncthing copy' : 'second';
    return [mine, theirs];
  }

  function keepSide(s, block, side) {
    const cm = s.cm;
    const lines = [];
    const [from, to] = side === 0 ? [block.start + 1, (block.split ?? block.mid) - 1] : [block.mid + 1, block.end - 1];
    for (let i = from; i <= to; i++) lines.push(cm.getLine(i));
    const last = block.end === cm.lastLine();
    const text = lines.map(line => line + '\n').join('');
    cm.replaceRange(last ? text.replace(/\n$/, '') : text, {line: block.start, ch: 0}, last ? {line: block.end, ch: cm.getLine(block.end).length} : {line: block.end + 1, ch: 0}, '+resolve');
  }

  function keepAll(s, side) {
    const blocks = conflictBlocks(s.cm);
    s.cm.operation(() => { for (const block of blocks.reverse()) keepSide(s, block, side); });
  }

  function highlight(s, blocks) {
    const cm = s.cm;
    for (const [handle, cls] of s.marks) cm.removeLineClass(handle, 'background', cls);
    s.marks = [];
    for (const block of blocks) {
      for (let i = block.start; i <= block.end; i++) {
        const cls = i === block.start || i === block.end || i === block.mid || i === block.split ? 'live-conflict-marker'
          : i < (block.split ?? block.mid) ? 'live-conflict-mine' : i > block.mid ? 'live-conflict-saved' : 'live-conflict-base';
        s.marks.push([cm.addLineClass(i, 'background', cls), cls]);
      }
    }
  }

  function enterConflict(s) {
    clearTimeout(s.timer);
    s.conflict = true;
    s.dirty = true;
    refreshConflict(s);
  }

  function refreshConflict(s) {
    const blocks = conflictBlocks(s.cm);
    highlight(s, blocks);
    s.blocks = blocks;
    if (!hasMarkers(s.cm.getValue())) {
      s.conflict = false;
      s.blocks = [];
      flash(s, 'Conflict resolved. Saving.');
      schedule(s, 0);
    }
    paint(s);
  }

  // -- saving ----------------------------------------------------------------
  function schedule(s, delay) {
    clearTimeout(s.timer);
    s.timer = setTimeout(() => { s.timer = null; flush(s); }, delay);
  }

  function onLocalEdit(s) {
    s.dirty = true;
    s.lastStatus = null;
    writeBackup(s);
    if (s.conflict) refreshConflict(s);
    else { schedule(s, SAVE_DELAY); paint(s); }
  }

  async function flush(s) {
    clearTimeout(s.timer); s.timer = null;
    if (s.closed || s.inflight !== null || !s.dirty || !s.editable || s.conflict || s.missing || s.blocked) return;
    const text = s.cm.getValue(), base = s.base, copy = s.resolvingCopy;
    s.inflight = text;
    paint(s);
    let result;
    try {
      const body = {base, content: text, client: CLIENT, author: AUTHOR};
      result = copy ? await call('sync-conflict', s.sel, {name: copy}, {...body, action: 'apply'}) : await call('save', s.sel, {}, body);
    } catch (error) {
      s.inflight = null;
      saveFailed(s, error, copy);
      return;
    }
    s.inflight = null;
    s.offline = false;
    s.retryDelay = 0;
    const unchanged = s.cm.getValue() === text;
    if (result.status === 'conflict') {
      if (unchanged) {
        applyText(s, result.content);
        s.base = result.revision;
        s.epoch++;
        enterConflict(s);
        writeBackup(s);
      } else {
        // The person kept typing: keep the original base so the server marks
        // the overlap again against the newest text, then show that.
        schedule(s, SAVE_DELAY);
      }
    } else {
      if (copy) s.resolvingCopy = null;
      s.epoch++;
      if (unchanged) {
        applyText(s, result.content);
        s.base = result.revision;
        s.dirty = false;
        s.lastStatus = result.status;
        clearBackup(s);
        if (result.status === 'merged') flash(s, 'Merged with changes saved elsewhere.');
        if (s.recovering) { s.recovering = false; s.recovered = true; }
      } else {
        // The server stored what was sent; newer typing is saved on top of it.
        s.base = result.sent_revision;
        writeBackup(s);
        schedule(s, SAVE_DELAY);
      }
    }
    paint(s);
    if (!s.dirty && s.pendingRemote) { s.pendingRemote = false; refresh(s); }
    if (s.parked && !s.dirty && s.inflight === null) destroy(s);
  }

  function saveFailed(s, error, copy) {
    if (error.status === 422) { enterConflict(s); return; }
    if (error.status === 403 && error.code === 'not_editable') {
      s.editable = false; s.reason = error.reason;
      s.error = 'This report became read-only. Your text is kept in this browser.';
      applyEditable(s);
    } else if (error.status === 404 && copy) {
      // The conflict copy vanished (resolved elsewhere): save as a normal edit.
      s.resolvingCopy = null; writeBackup(s); schedule(s, 0);
    } else if (error.status === 404) {
      s.missing = true; watchMissing(s);
    } else if (error.offline) {
      s.offline = true;
      s.retryDelay = backoff(s.retryDelay);
      schedule(s, s.retryDelay);
    } else {
      s.blocked = true;
      s.error = error.code === 'root_changed' ? 'The data root changed. Restart the Board. Your text is kept in this browser.'
        : error.code === 'untrusted_origin' ? 'The Board refused this save from this address. Your text is kept in this browser.'
          : `The Board refused this save (${error.status}). Your text is kept in this browser.`;
    }
    paint(s);
  }

  function watchMissing(s) {
    clearTimeout(s.missingTimer);
    s.missingDelay = backoff(s.missingDelay || 0);
    s.missingTimer = setTimeout(() => refresh(s), s.missingDelay);
  }

  // Resolve once nothing is waiting to be saved (or saving cannot proceed).
  async function settle(s, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline && !s.closed) {
      if (s.inflight === null && (!s.dirty || s.conflict || s.blocked || s.missing || s.offline || !s.editable)) break;
      if (s.inflight === null && s.dirty && !s.offline) flush(s);
      await sleep(50);
    }
    return s.inflight === null && !s.dirty;
  }

  // -- reading -------------------------------------------------------------
  async function refresh(s, author) {
    if (s.closed) return;
    if (s.refreshing) { s.refreshAgain = author || s.refreshAgain || true; return; }
    s.refreshing = true;
    const epoch = s.epoch;
    try {
      const data = await call('report', s.sel);
      if (s.closed) return;
      if (s.missing) { s.missing = false; s.missingDelay = 0; clearTimeout(s.missingTimer); if (s.dirty) schedule(s, 0); }
      const wasReadOnly = !s.editable;
      s.editable = !!data.editable; s.reason = data.reason || null;
      applyEditable(s);
      if (wasReadOnly && s.editable && s.dirty) { s.error = null; schedule(s, 0); }
      s.copies = Array.isArray(data.sync_conflicts) ? data.sync_conflicts : [];
      if (epoch !== s.epoch) { s.refreshAgain = s.refreshAgain || true; return; }
      if (s.dirty || s.inflight !== null || s.conflict) { s.pendingRemote = true; return; }
      if (data.revision !== s.base) {
        applyText(s, data.content);
        s.base = data.revision;
        s.lastStatus = null;
        if (typeof author === 'string') flash(s, author === OUTSIDE ? 'Updated outside the Board' : `Updated by ${author}`);
      }
    } catch (error) {
      if (error.status === 404) { s.missing = true; watchMissing(s); }
    } finally {
      s.refreshing = false;
      paint(s);
      if (s.refreshAgain && !s.closed) { const again = s.refreshAgain; s.refreshAgain = false; refresh(s, typeof again === 'string' ? again : undefined); }
    }
  }

  function connect(s) {
    if (s.es || s.closed) return;
    const query = new URLSearchParams(s.sel);
    const es = new EventSource(`/api/live/events?${query}`);
    s.es = es;
    es.addEventListener('open', () => {
      s.streamDelay = 0;
      if (s.streamDown) { s.streamDown = false; refresh(s); }
    });
    es.addEventListener('changed', event => {
      const data = parse(event.data);
      if (!data || data.client === CLIENT) return;
      if (s.missing) { refresh(s); return; }
      if (data.revision === s.base) return;
      if (s.dirty || s.inflight !== null || s.conflict) { s.pendingRemote = true; if (!s.conflict) flash(s, 'New changes saved elsewhere. They will be merged when this saves.'); return; }
      const author = data.author === OUTSIDE ? OUTSIDE : data.client ? `${data.author || 'Board editor'} in another tab` : (data.author || OUTSIDE);
      refresh(s, author);
    });
    es.addEventListener('sync_conflicts', event => {
      const data = parse(event.data);
      s.copies = Array.isArray(data?.copies) ? data.copies : [];
      if (s.review && !s.copies.some(copy => copy.name === s.review.name)) s.review = null;
      paint(s);
    });
    es.addEventListener('missing', () => { s.missing = true; watchMissing(s); paint(s); });
    es.onerror = () => {
      es.close();
      if (s.es === es) s.es = null;
      s.streamDown = true;
      if (s.closed || s.parked) return;
      s.streamDelay = backoff(s.streamDelay || 0);
      clearTimeout(s.streamTimer);
      s.streamTimer = setTimeout(() => connect(s), s.streamDelay);
    };
  }

  // -- session lifecycle ---------------------------------------------------
  function createSession(sel, host) {
    const el = document.createElement('div');
    el.className = 'live-editor';
    el.dataset.liveSession = '';
    const id = `live-source-${sessions.size}-${Date.now().toString(36)}`;
    el.innerHTML = `<div class="live-bar"><span class="live-pill" data-live-status role="status" aria-live="polite" data-state="opening">Opening</span><span class="hint live-note" data-live-note aria-live="polite"></span><span class="live-bar-actions"><button type="button" class="button subtle" data-live-history aria-expanded="false">History</button></span></div><div data-live-banners></div><label class="hint" for="${id}">Report text</label><textarea id="${id}" data-live-source></textarea><section class="live-history" data-live-drawer hidden aria-label="Report history"></section>`;
    const s = {
      sel, key: keyOf(sel), root: rootTag(), el, mde: null, cm: null, base: null, editable: false, reason: null,
      ready: false, dirty: false, inflight: null, conflict: false, blocks: [], marks: [], offline: false, missing: false,
      blocked: false, error: null, copies: [], review: null, resolvingCopy: null, lastStatus: null, recovered: false,
      recovering: false, pendingRemote: false, epoch: 0, retryDelay: 0, streamDelay: 0, timer: null, es: null,
      parked: false, closed: false, hadFocus: false, history: {open: false, events: [], more: false, view: null},
      orphans: [], storageError: false,
    };
    s.backupKey = backupPrefix(s) + CLIENT;
    el.addEventListener('click', event => onClick(s, event));
    host.replaceChildren(el);
    open(s);
    return s;
  }

  async function open(s) {
    let data;
    try { data = await call('report', s.sel); }
    catch (error) {
      if (s.closed) return;
      const note = s.el.querySelector('[data-live-banners]');
      if (error.status === 404) { note.innerHTML = '<div class="message warning" role="alert">This report file is missing or unreadable.</div>'; s.missing = true; }
      else note.innerHTML = '<div class="message warning" role="alert">The editor could not open this report. Retrying.</div>';
      s.retryDelay = backoff(s.retryDelay);
      s.openTimer = setTimeout(() => open(s), s.retryDelay);
      return;
    }
    if (s.closed) return;
    s.retryDelay = 0; s.missing = false;
    s.base = data.revision; s.editable = !!data.editable; s.reason = data.reason || null;
    s.copies = Array.isArray(data.sync_conflicts) ? data.sync_conflicts : [];
    const source = s.el.querySelector('[data-live-source]');
    source.value = data.content;
    s.mde = new EasyMDE({
      element: source, autoDownloadFontAwesome: false, autosave: {enabled: false}, forceSync: false, spellChecker: false, status: false,
      previewRender: text => (ctx?.markdown ? ctx.markdown(text) : esc(text)),
      toolbar: ['bold', 'italic', 'heading', '|', 'quote', 'unordered-list', 'ordered-list', 'code', '|', 'preview', 'side-by-side'],
    });
    const cm = s.cm = s.mde.codemirror;
    const fieldId = source.id;
    source.removeAttribute('id');
    cm.getInputField().id = fieldId;
    cm.clearHistory();
    const saveNow = () => { flush(s); };
    cm.setOption('extraKeys', {...(cm.getOption('extraKeys') || {}), 'Ctrl-S': saveNow, 'Cmd-S': saveNow});
    cm.on('change', () => { if (!s.applying) onLocalEdit(s); });
    cm.on('focus', () => { s.hadFocus = true; });
    // An app re-render removes the focused editor and fires blur first; it
    // reattaches us synchronously, so only a blur that outlives the current
    // task means the person moved focus away.
    cm.on('blur', () => { s.blurPending = true; queueMicrotask(() => { if (s.blurPending) { s.blurPending = false; s.hadFocus = false; } }); });
    s.ready = true;
    applyEditable(s);
    paint(s);
    s.streamDown = true; // refresh once subscribed: catches changes made while opening
    connect(s);
    await recover(s);
  }

  // Send text left in this browser by a closed or crashed tab with the base it
  // was written against, so the server merges it with what changed since.
  async function recover(s) {
    for (const {key, backup} of await orphanBackups(s)) {
      if (s.closed) return;
      let still = null;
      try { still = localStorage.getItem(key); } catch {}
      if (still === null) continue; // another tab recovered it meanwhile
      if (backup.text === s.cm.getValue() && !s.dirty) { try { localStorage.removeItem(key); } catch {} continue; }
      if (!s.editable) { s.orphans.push({key, text: backup.text}); continue; }
      if (s.dirty || s.inflight !== null) { await settle(s); if (s.dirty) return; }
      try { if (localStorage.getItem(key) !== still) continue; } catch { continue; }
      applyText(s, backup.text);
      s.base = backup.base;
      s.dirty = true;
      s.resolvingCopy = backup.copy || null;
      writeBackup(s);
      try { localStorage.removeItem(key); } catch {}
      if (hasMarkers(backup.text)) { s.recovered = true; enterConflict(s); return; }
      s.recovering = true;
      paint(s);
      await settle(s);
      if (s.dirty) return;
    }
    paint(s);
  }

  function applyEditable(s) {
    if (!s.cm) return;
    s.cm.setOption('readOnly', !s.editable);
    s.el.classList.toggle('live-readonly', !s.editable);
  }

  function park(s) {
    s.parked = true;
    s.hadFocus = false;
    // Parked sessions do not need live updates: their next save merges, and
    // unpark reconnects and refreshes. This also frees browser connections.
    clearTimeout(s.streamTimer);
    if (s.es) { s.es.close(); s.es = null; }
    if (s.dirty && !s.conflict) flush(s);
    if (!s.dirty && s.inflight === null) destroy(s);
  }

  function unpark(s) {
    s.parked = false;
    if (!s.es) { s.streamDown = true; connect(s); }
  }

  function destroy(s) {
    s.closed = true;
    for (const timer of [s.timer, s.streamTimer, s.missingTimer, s.openTimer, s.flashTimer]) clearTimeout(timer);
    s.es?.close();
    try { s.mde?.toTextArea(); } catch {}
    s.el.remove();
    if (sessions.get(s.key) === s) sessions.delete(s.key);
  }

  // -- view ------------------------------------------------------------------
  function status(s) {
    if (!s.ready) return ['opening', 'Opening'];
    if (!s.editable) return ['readonly', 'Read-only'];
    if (s.conflict) return ['conflict', 'Conflict'];
    if (s.offline || s.missing || s.blocked) return ['offline', s.offline ? 'Offline' : 'Not saved'];
    if (s.inflight !== null) return ['saving', 'Saving'];
    if (s.dirty) return ['unsaved', 'Unsaved'];
    if (s.lastStatus === 'merged') return ['merged', 'Merged'];
    return ['saved', 'Saved'];
  }

  function flash(s, text) {
    const note = s.el.querySelector('[data-live-note]');
    if (!note) return;
    note.textContent = text;
    clearTimeout(s.flashTimer);
    s.flashTimer = setTimeout(() => { note.textContent = ''; }, 6000);
  }

  function relativeTime(seconds) {
    const diff = seconds - Date.now() / 1000, abs = Math.abs(diff);
    const format = new Intl.RelativeTimeFormat('en', {numeric: 'auto'});
    if (abs < 45) return 'just now';
    if (abs < 3600) return format.format(Math.round(diff / 60), 'minute');
    if (abs < 86400) return format.format(Math.round(diff / 3600), 'hour');
    return format.format(Math.round(diff / 86400), 'day');
  }

  function historyLabel(event) {
    const author = event.author || 'Board editor';
    switch (event.kind) {
      case 'observed': return 'Opened from disk';
      case 'external': return OUTSIDE;
      case 'board': return `Edited by ${author}${event.client === CLIENT ? ' (this tab)' : ''}`;
      case 'merged': return author === 'Board editor' ? 'Merged changes' : author;
      case 'restore': return `Restored by ${author}`;
      case 'conflict_draft': return 'Conflicting edit kept for review';
      case 'sync_conflict': return 'Syncthing copy archived';
      default: return String(event.kind || 'Change');
    }
  }

  function paint(s) {
    if (s.closed) return;
    const [state, label] = status(s);
    const pill = s.el.querySelector('[data-live-status]');
    if (pill.textContent !== label) pill.textContent = label;
    pill.dataset.state = state;
    const banners = [];
    if (s.recovered) banners.push(`<div class="message" role="status">Recovered unsaved text from this browser and merged it with the saved report. <button type="button" class="button" data-live-dismiss="recovered">Dismiss</button></div>`);
    if (!s.editable && s.ready) banners.push(`<div class="message" role="status">${s.reason === 'generated_navigation' ? 'Generated navigation is read-only.' : 'This report is read-only.'}</div>`);
    for (const orphan of s.orphans) banners.push(`<div class="message warning" role="alert">Unsaved text from an earlier visit is kept in this browser, but this report is read-only. Copy it before discarding.<textarea readonly rows="4" aria-label="Unsaved text">${esc(orphan.text)}</textarea><button type="button" class="button" data-live-drop-orphan="${esc(orphan.key)}">Discard kept text</button></div>`);
    if (s.offline) banners.push('<div class="message warning" role="status">Offline, kept in this browser, retrying.</div>');
    if (s.missing) banners.push('<div class="message warning" role="alert">This report file is missing or was moved. Your text is kept in this browser.</div>');
    if (s.error) banners.push(`<div class="message warning" role="alert">${esc(s.error)}${s.blocked ? ' <button type="button" class="button" data-live-retry>Retry</button>' : ''}</div>`);
    if (s.storageError) banners.push('<div class="message warning" role="alert">Browser storage is unavailable. Keep this tab open until the status shows Saved.</div>');
    if (s.conflict) {
      const items = s.blocks.map((block, index) => {
        const [mine, theirs] = sideNames(block);
        return `<li>Line ${block.start + 1}: <button type="button" class="button" data-live-keep="${index}" data-side="0">Keep ${esc(mine)}</button> <button type="button" class="button" data-live-keep="${index}" data-side="1">Keep ${esc(theirs)}</button> <button type="button" class="button subtle" data-live-goto="${index}">Show</button></li>`;
      }).join('');
      const [mine, theirs] = s.blocks[0] ? sideNames(s.blocks[0]) : ['mine', 'saved'];
      banners.push(`<div class="message warning live-conflict" role="alert"><strong>Your edit overlaps a change saved elsewhere.</strong> Choose what to keep for each marked block, or edit the text by hand. Autosave is paused until no markers remain.${items ? `<ol class="live-conflict-list">${items}</ol>` : '<p>Remove the remaining marker lines to continue.</p>'}${s.blocks.length ? `<button type="button" class="button" data-live-keep-all="0">Keep all ${esc(mine)}</button> <button type="button" class="button" data-live-keep-all="1">Keep all ${esc(theirs)}</button>` : ''}</div>`);
    }
    for (const copy of s.copies) {
      const reviewing = s.review?.name === copy.name;
      let body = '';
      if (reviewing && s.review.data) {
        const data = s.review.data;
        body = `<div class="live-review"><p class="hint">${data.conflicted ? 'Both versions changed the same lines. Load the merge into the editor to choose.' : 'Merged preview of the report and the copy.'}</p><div class="live-preview">${ctx?.markdown ? ctx.markdown(data.merged) : esc(data.merged)}</div>${data.conflicted ? '' : '<button type="button" class="button" data-live-copy-apply>Apply</button> '}<button type="button" class="button" data-live-copy-load>Load into editor to resolve</button> <button type="button" class="button subtle" data-live-copy-close>Close</button></div>`;
      } else if (reviewing) body = '<p class="hint">Loading the copy.</p>';
      banners.push(`<div class="message warning live-copy" role="status" data-live-copy="${esc(copy.name)}">Syncthing kept a conflicting copy from device ${esc(copy.device || 'unknown')}. <button type="button" class="button" data-live-copy-review>Review</button> <button type="button" class="button subtle" data-live-copy-discard>Discard</button> <span class="hint">Discarded copies are kept in history.</span>${body}</div>`);
    }
    const html = banners.join('');
    const box = s.el.querySelector('[data-live-banners]');
    if (box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; }
    paintHistory(s);
  }

  function paintHistory(s) {
    const drawer = s.el.querySelector('[data-live-drawer]');
    const toggle = s.el.querySelector('[data-live-history]');
    toggle.setAttribute('aria-expanded', String(s.history.open));
    drawer.hidden = !s.history.open;
    if (!s.history.open) return;
    const view = s.history.view;
    const items = s.history.events.map(event => `<li><button type="button" class="live-history-entry${view?.revision === event.revision && view?.id === event.id ? ' active' : ''}" data-live-view="${esc(event.id)}">${esc(historyLabel(event))}</button> <span class="hint" title="${esc(new Date(event.created * 1000).toLocaleString())}">${esc(relativeTime(event.created))}</span></li>`).join('');
    const viewing = view ? `<div class="live-history-view"><h3>${esc(view.label)}</h3>${view.content == null ? '<p class="hint">Loading.</p>' : `<div class="live-preview">${ctx?.markdown ? ctx.markdown(view.content) : esc(view.content)}</div>${s.editable ? '<button type="button" class="button" data-live-restore>Restore this version</button> ' : ''}`}<button type="button" class="button subtle" data-live-view-close>Close</button></div>` : '';
    const html = `<div class="live-history-head"><h3>History</h3><button type="button" class="button subtle" data-live-history-close>Close</button></div>${s.history.error ? `<p class="hint">${esc(s.history.error)}</p>` : ''}<ol class="live-history-list">${items || '<li class="hint">No history yet.</li>'}</ol>${s.history.more ? '<button type="button" class="button" data-live-history-more>Load older</button>' : ''}${viewing}`;
    if (drawer.dataset.html !== html) { drawer.innerHTML = html; drawer.dataset.html = html; }
  }

  async function loadHistory(s, older) {
    const before = older ? s.history.events.at(-1)?.id : undefined;
    try {
      const data = await call('history', s.sel, before ? {before: String(before)} : {});
      const events = Array.isArray(data.events) ? data.events : [];
      s.history.events = older ? [...s.history.events, ...events] : events;
      s.history.more = events.length >= 50;
      s.history.error = null;
    } catch { s.history.error = 'History is unavailable right now.'; }
    paint(s);
  }

  // Shared handling for restore and conflict-copy apply results.
  function applyResult(s, result, textBefore) {
    if (result.status === 'conflict') { flash(s, 'The report changed meanwhile. Review again.'); return false; }
    s.epoch++;
    if (s.cm.getValue() === textBefore && !s.dirty) {
      applyText(s, result.content);
      s.base = result.revision;
      s.lastStatus = result.status;
    } else s.pendingRemote = true; // typed meanwhile; the next save merges with the base it started from
    return true;
  }

  async function onClick(s, event) {
    const button = event.target.closest('button');
    if (!button || !s.el.contains(button)) return;
    const data = button.dataset;
    if ('liveHistory' in data) { s.history.open = !s.history.open; if (s.history.open) loadHistory(s); paint(s); return; }
    if ('liveHistoryClose' in data) { s.history.open = false; s.history.view = null; paint(s); return; }
    if ('liveHistoryMore' in data) { loadHistory(s, true); return; }
    if ('liveView' in data) {
      const entry = s.history.events.find(item => String(item.id) === data.liveView);
      if (!entry) return;
      s.history.view = {id: entry.id, revision: entry.revision, label: historyLabel(entry), content: null};
      paint(s);
      try { const result = await call('revision', s.sel, {revision: entry.revision}); if (s.history.view?.id === entry.id) s.history.view.content = String(result.content ?? ''); }
      catch { if (s.history.view?.id === entry.id) s.history.view = null; s.history.error = 'That version is unavailable.'; }
      paint(s); return;
    }
    if ('liveViewClose' in data) { s.history.view = null; paint(s); return; }
    if ('liveRestore' in data) {
      const view = s.history.view;
      if (!view || !s.editable) return;
      if (!(await settle(s))) { flash(s, 'Finish the pending save or conflict before restoring.'); return; }
      const before = s.cm.getValue();
      try {
        const result = await call('restore', s.sel, {}, {base: s.base, revision: view.revision, client: CLIENT, author: AUTHOR});
        if (applyResult(s, result, before)) { flash(s, 'Version restored.'); s.history.view = null; loadHistory(s); }
      } catch (error) { flash(s, error.offline ? 'Offline. Restore again when connected.' : 'Restore failed.'); }
      paint(s); return;
    }
    if (data.liveKeep !== undefined) { const block = s.blocks[Number(data.liveKeep)]; if (block) keepSide(s, block, Number(data.side)); return; }
    if (data.liveKeepAll !== undefined) { keepAll(s, Number(data.liveKeepAll)); return; }
    if (data.liveGoto !== undefined) {
      const block = s.blocks[Number(data.liveGoto)];
      if (block) { s.cm.focus(); s.cm.setCursor({line: block.start, ch: 0}); s.cm.scrollIntoView({line: block.start, ch: 0}, 80); }
      return;
    }
    if (data.liveDismiss === 'recovered') { s.recovered = false; paint(s); return; }
    if ('liveRetry' in data) { s.blocked = false; s.error = null; schedule(s, 0); paint(s); return; }
    if (data.liveDropOrphan) { try { localStorage.removeItem(data.liveDropOrphan); } catch {} s.orphans = s.orphans.filter(o => o.key !== data.liveDropOrphan); paint(s); return; }
    const name = button.closest('[data-live-copy]')?.dataset.liveCopy;
    if (!name) return;
    if ('liveCopyReview' in data) {
      s.review = {name, data: null}; paint(s);
      try { const result = await call('sync-conflict', s.sel, {name}); if (s.review?.name === name) s.review.data = result; }
      catch { if (s.review?.name === name) s.review = null; flash(s, 'That copy is no longer available.'); }
      paint(s); return;
    }
    if ('liveCopyClose' in data) { s.review = null; paint(s); return; }
    if ('liveCopyDiscard' in data) {
      if (!(await settle(s))) { flash(s, 'Finish the pending save before discarding.'); return; }
      try { await call('sync-conflict', s.sel, {name}, {action: 'discard', base: s.base, client: CLIENT, author: AUTHOR}); s.review = null; s.copies = s.copies.filter(c => c.name !== name); flash(s, 'Copy discarded and kept in history.'); }
      catch (error) { flash(s, error.offline ? 'Offline. Try again when connected.' : 'Could not discard the copy.'); }
      paint(s); return;
    }
    const review = s.review?.name === name ? s.review.data : null;
    if (!review) return;
    if ('liveCopyApply' in data && !review.conflicted) {
      if (!(await settle(s))) { flash(s, 'Finish the pending save before applying.'); return; }
      const before = s.cm.getValue();
      try {
        const result = await call('sync-conflict', s.sel, {name}, {action: 'apply', base: review.revision, content: review.merged, client: CLIENT, author: AUTHOR});
        if (applyResult(s, result, before)) { s.review = null; s.copies = s.copies.filter(c => c.name !== name); flash(s, 'Copy applied.'); }
        else { s.review = {name, data: null}; s.review.data = await call('sync-conflict', s.sel, {name}).catch(() => null); if (!s.review.data) s.review = null; }
      } catch (error) { flash(s, error.offline ? 'Offline. Try again when connected.' : 'Could not apply the copy.'); }
      paint(s); return;
    }
    if ('liveCopyLoad' in data) {
      if (!(await settle(s))) { flash(s, 'Finish the pending save before loading the copy.'); return; }
      applyText(s, review.merged);
      s.base = review.revision;
      s.epoch++;
      s.resolvingCopy = name;
      s.review = null;
      s.dirty = true;
      writeBackup(s);
      if (hasMarkers(review.merged)) enterConflict(s); else schedule(s, 0);
      paint(s);
    }
  }

  window.addEventListener('beforeunload', event => {
    for (const s of sessions.values()) if (!s.closed && (s.dirty || s.inflight !== null)) { event.preventDefault(); event.returnValue = ''; return; }
  });
  setInterval(() => { for (const s of sessions.values()) if (!s.closed && s.dirty && s.cm) writeBackup(s); }, 10000);
  window.addEventListener('online', () => { for (const s of sessions.values()) if (s.offline) schedule(s, 0); });

  window.registerBoardModule?.({
    name: 'live-editor',
    afterRender(context) {
      ctx = context;
      if (!context.state?.data?.capabilities?.live_edit) return;
      const host = document.getElementById('live-report-host');
      const sel = host ? selectorOf(host.dataset) : null;
      const key = sel ? keyOf(sel) : null;
      for (const s of [...sessions.values()]) if (s.key !== key && !s.parked) park(s);
      if (!host || !sel.path || typeof EasyMDE === 'undefined') return;
      let s = sessions.get(key);
      if (!s || s.closed) { s = createSession(sel, host); sessions.set(key, s); return; }
      if (s.parked) unpark(s);
      // The app keeps an unchanged host node across renders (it is detached
      // and reinserted), so the session may already be in place. Either way a
      // render that removed the focused editor must give focus back.
      const refocus = s.hadFocus && s.blurPending && (!document.activeElement || document.activeElement === document.body);
      const moved = s.el.parentNode !== host;
      if (moved) host.replaceChildren(s.el);
      if (moved || refocus) {
        s.blurPending = false;
        if (s.cm) { s.cm.refresh(); if (refocus) s.cm.focus(); }
      }
    },
  });
  // Exposed for synthetic browser tests and diagnostics only.
  window.BoardLiveEditor = {client: CLIENT, sessions, flush: () => Promise.all([...sessions.values()].map(s => flush(s)))};
})();
