/* Bootstrap preferences before the app reads its browser fallback.  Only the
 * explicit keys below are shared: draft storage, search text, locks and the
 * current terminal dock never leave the browser. */
(() => {
  'use strict';
  const keys = [
    'bounty-board-theme', 'bounty-board-show-archived', 'bounty-board-sidebar-collapsed',
    'bounty-board-finding-sort', 'bounty-board-dashboard-work', 'bounty-board-class-group',
    'bounty-board-report-list-hide-na', 'bounty-board-report-list-open', 'bounty-board-recent-programs',
    'bounty-board-last-program',
    'bounty-board-recent-panel-show-na',
  ];
  const fields = ['copyOnSelect', 'ctrlCCopy', 'ctrlVPaste', 'shortcut', 'dock'];
  const listFields = ['window', 'order', 'nav', 'hideNa', 'programs', 'lanes', 'subs', 'sevs', 'classes'];
  const lists = {recent: 'bounty-board-recent-reports', submissions: 'bounty-board-submissions'};
  const terminalKey = 'bounty-board-terminal:v1';
  const marker = 'bounty-board-preferences-migrated:v1';
  const pendingPrefix = 'bounty-board-preferences-pending:v1:';
  const pendingBasePrefix = 'bounty-board-preferences-base:v1:';
  const revisionsKey = 'bounty-board-preferences-revisions:v1';
  const allowed = new Set([...keys, ...fields.map(f => `terminal.${f}`), ...Object.keys(lists).flatMap(n => listFields.map(f => `list.${n}.${f}`))]);
  const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
  const put = (key, value) => { try { localStorage.setItem(key, value); return true; } catch { return false; } };
  const parse = (raw, fallback) => { try { return JSON.parse(raw) ?? fallback; } catch { return fallback; } };
  function validLegacy(key, raw) {
    if (new TextEncoder().encode(raw).length > 8192) return false;
    if (key === 'bounty-board-theme') return ['light','dark','dusk'].includes(raw);
    if (['bounty-board-show-archived','bounty-board-sidebar-collapsed','bounty-board-report-list-hide-na','bounty-board-report-list-open'].includes(key)) return ['true','false'].includes(raw);
    if (key === 'bounty-board-recent-panel-show-na') return ['0','1'].includes(raw);
    const value = parse(raw, null);
    if (key === 'bounty-board-dashboard-work') return ['all','open'].includes(value);
    if (key === 'bounty-board-class-group') return ['class','category'].includes(value);
    if (key === 'bounty-board-finding-sort') return value && Object.keys(value).length === 2 && ['', 'title','severity','class','status','id','first_seen','last_seen'].includes(value.key) && ['asc','desc'].includes(value.dir);
    if (['bounty-board-recent-programs','bounty-board-last-program'].includes(key)) {
      const items = key === 'bounty-board-last-program' ? [value] : value;
      return Array.isArray(items) && items.length <= 5 && items.every(v => v && typeof v === 'object' && Object.keys(v).length === 2 && ['program','lane'].every(k => typeof v[k] === 'string' && v[k].length <= 200));
    }
    return false;
  }
  // One localStorage record per preference: two tabs cannot erase each other's
  // unrelated unsent changes by replacing a shared pending object.
  const pending = {}, pendingBases = {}, conflicts = new Set();
  let observed = parse(read(revisionsKey), null);
  for (const key of allowed) {
    const value = read(pendingPrefix + key);
    if (value !== null) {
      pending[key] = value;
      const base = parse(read(pendingBasePrefix + key), null);
      if (Number.isSafeInteger(base) && base >= 0) pendingBases[key] = base;
      else conflicts.add(key);
    }
  }
  let failed = false, readFailed = false, inflight = false;
  const notice = () => {
    const paint = () => {
      let node = document.getElementById('preferences-save-error');
      if (!failed) { node?.remove(); return; }
      if (!node && document.body) {
        node = document.createElement('div'); node.id = 'preferences-save-error'; node.setAttribute('role', 'alert');
        node.style.cssText = 'position:fixed;z-index:9999;bottom:1rem;left:1rem;max-width:28rem;padding:.75rem 1rem;background:#8b2525;color:white;border-radius:.5rem';
        document.body.appendChild(node);
      }
      if (node) node.textContent = conflicts.size ? 'A preference changed on another device. Your unsent choice remains in this browser; review it before retrying.' : 'Preferences could not be saved to the server. Changes remain in this browser; retrying.';
    };
    if (document.body) paint(); else document.addEventListener('DOMContentLoaded', paint, {once: true});
  };
  const setFailed = value => { failed = value; notice(); };

  const syncRequest = (method, payload) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, '/api/user-preferences', false);
    if (payload) { xhr.setRequestHeader('Content-Type', 'application/json'); xhr.setRequestHeader('X-Requested-With', 'Bounty-Board'); }
    xhr.send(payload ? JSON.stringify(payload) : null);
    if (xhr.status !== 200) throw new Error('preferences unavailable');
    return JSON.parse(xhr.responseText);
  };
  try {
    let snapshot = syncRequest('GET'), server = snapshot.preferences;
    if (read(marker) !== '1') {
      const legacy = {};
      for (const key of keys) {
        const value = read(key);
        if (value !== null && !Object.hasOwn(pending, key) && validLegacy(key, value)) legacy[key] = value;
      }
      for (const [name, key] of Object.entries(lists)) {
        const saved = parse(read(key), {});
        for (const field of listFields) {
          const value = field === 'lanes' && !Array.isArray(saved?.lanes) && typeof saved?.lane === 'string' ? [saved.lane] : saved?.[field];
          const valid = field === 'window' ? ['1d','7d','30d','all'].includes(value) :
            field === 'order' ? ['newest','oldest','severity','class'].includes(value) :
            ['nav','hideNa'].includes(field) ? typeof value === 'boolean' :
            Array.isArray(value) && value.length <= 100 && value.every(v => typeof v === 'string' && v.length <= 200);
          const storeKey = `list.${name}.${field}`;
          if (valid && !Object.hasOwn(pending, storeKey)) legacy[storeKey] = JSON.stringify(value);
        }
      }
      const old = parse(read(terminalKey), {});
      for (const field of fields) {
        const v = old?.[field];
        if ((['copyOnSelect', 'ctrlCCopy', 'ctrlVPaste'].includes(field) && typeof v === 'boolean') ||
            (field === 'dock' && ['bottom', 'top', 'left', 'right'].includes(v)) ||
            (field === 'shortcut' && v && typeof v === 'object' && ['ctrl', 'alt', 'shift'].every(k => typeof v[k] === 'boolean') && typeof v.code === 'string' && v.code.length <= 16)) {
          if (!Object.hasOwn(pending, `terminal.${field}`)) legacy[`terminal.${field}`] = field === 'dock' ? v : JSON.stringify(field === 'shortcut' ? {ctrl:v.ctrl, alt:v.alt, shift:v.shift, code:v.code} : v);
        }
      }
      if (Object.keys(legacy).length) { snapshot = syncRequest('POST', {migrate: legacy}); server = snapshot.preferences; }
      put(marker, '1');
    }
    observed = snapshot.revisions;
    if (!observed || typeof observed !== 'object') throw new Error('missing revisions');
    put(revisionsKey, JSON.stringify(observed));
    for (const key of keys) if (Object.hasOwn(server, key) && !Object.hasOwn(pending, key)) put(key, server[key]);
    for (const [name, key] of Object.entries(lists)) {
      const existing = parse(read(key), {});
      const value = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
      for (const field of listFields) {
        const storeKey = `list.${name}.${field}`;
        const raw = Object.hasOwn(pending, storeKey) ? pending[storeKey] : server[storeKey];
        if (raw !== undefined) value[field] = parse(raw, value[field]);
      }
      put(key, JSON.stringify(value));
    }
    const terminal = parse(read(terminalKey), {});
    for (const field of fields) {
      const key = `terminal.${field}`;
      const raw = Object.hasOwn(pending, key) ? pending[key] : server[key];
      if (raw !== undefined) terminal[field] = field === 'dock' ? raw : parse(raw, terminal[field]);
    }
    put(terminalKey, JSON.stringify(terminal));
    for (const key of keys) if (Object.hasOwn(pending, key)) put(key, pending[key]);
    if (conflicts.size) setFailed(true);
  } catch { readFailed = true; setFailed(true); }

  async function flush() {
    const key = Object.keys(pending).find(k => !conflicts.has(k));
    if (inflight || !key) return;
    if (!Number.isSafeInteger(pendingBases[key])) { conflicts.add(key); setFailed(true); return; }
    inflight = true;
    const value = pending[key], base = pendingBases[key];
    let retryImmediately = true;
    try {
      const response = await fetch('/api/user-preferences', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Requested-With': 'Bounty-Board'}, body: JSON.stringify({set: {[key]:value}, expected: {[key]:base}})});
      if (response.status === 409) { conflicts.add(key); setFailed(true); return; }
      if (!response.ok) throw new Error('save failed');
      const result = await response.json();
      observed = {...observed, [key]:result.revisions[key]};
      put(revisionsKey, JSON.stringify(observed));
      if (pending[key] === value) {
        delete pending[key]; delete pendingBases[key];
        try { if (read(pendingPrefix + key) === value) { localStorage.removeItem(pendingPrefix + key); localStorage.removeItem(pendingBasePrefix + key); } } catch {}
      } else {
        pendingBases[key] = observed[key];
        put(pendingBasePrefix + key, JSON.stringify(observed[key]));
      }
      setFailed(readFailed || conflicts.size > 0);
    } catch { retryImmediately = false; setFailed(true); }
    finally { inflight = false; }
    if (retryImmediately && !readFailed && Object.keys(pending).some(k => !conflicts.has(k))) flush();
  }
  function set(key, value) {
    if (!allowed.has(key) || typeof value !== 'string') return;
    if (!Object.hasOwn(pending, key)) {
      if (observed && typeof observed === 'object') {
        pendingBases[key] = observed[key] || 0;
        put(pendingBasePrefix + key, JSON.stringify(pendingBases[key]));
      } else conflicts.add(key);
    }
    pending[key] = value;
    if (!put(pendingPrefix + key, value)) setFailed(true);
    if (conflicts.has(key)) setFailed(true);
    flush();
  }
  window.BoardPreferences = Object.freeze({set, terminal: (field, value) => set(`terminal.${field}`, field === 'dock' ? value : JSON.stringify(value)),
    list: (name, field, value) => set(`list.${name}.${field}`, JSON.stringify(value))});
  window.addEventListener('online', flush);
  setInterval(() => { if (failed) flush(); }, 10000);
  if (Object.keys(pending).length) flush();
})();
