/* Global search: inline topbar field + Ctrl/Cmd+K command palette.
 * Results come from GET /api/search. Every server string is rendered with
 * textContent (matches are wrapped via <mark> nodes from index ranges); report
 * text is never passed to innerHTML. Navigation goes through ctx.navigate,
 * which is the app's own navigate(): results update the URL hash and history,
 * and a finding result is highlighted with the app's row highlight. */
(() => {
  'use strict';
  const RECENT_KEY = 'bounty-board-recent-searches';
  const GROUPS = [['programs', 'Programs', 'fa-folder-o'], ['findings', 'Findings', 'fa-bug'], ['reports', 'Reports', 'fa-file-text-o']];
  let ctx = null, dialog = null, overlay = null, input = null, list = null, status = null, followup = null;
  let items = [], active = -1, opener = null, timer = 0, controller = null, sequence = 0, retries = 0, followTimer = 0;
  let field = null; // inline topbar field; focusing it with a pointer or typing opens the palette

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };
  const icon = name => { const i = el('i', `fa ${name}`); i.setAttribute('aria-hidden', 'true'); return i; };
  function highlighted(text, ranges) {
    const span = el('span', 'search-text');
    let at = 0;
    for (const [start, end] of Array.isArray(ranges) ? ranges : []) {
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < at || end <= start || end > text.length) continue;
      if (start > at) span.append(text.slice(at, start));
      span.append(el('mark', 'search-mark', text.slice(start, end)));
      at = end;
    }
    if (at < text.length) span.append(text.slice(at));
    return span;
  }
  const recents = () => { try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(v) ? v.filter(x => typeof x === 'string').slice(0, 8) : []; } catch { return []; } };
  const saveRecents = values => { try { localStorage.setItem(RECENT_KEY, JSON.stringify(values.slice(0, 8))); } catch {} };
  function remember(query) {
    const q = query.trim();
    if (q) saveRecents([q, ...recents().filter(x => x !== q)]);
  }

  // ---- DOM -------------------------------------------------------------
  function build() {
    if (overlay) return;
    overlay = el('div', 'search-overlay'); overlay.hidden = true;
    dialog = el('div', 'search-dialog panel'); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-label', 'Search');
    const field = el('div', 'search-field');
    input = el('input'); input.type = 'text'; input.id = 'global-search-input'; input.autocomplete = 'off'; input.spellcheck = false;
    input.placeholder = 'Search programs, findings and reports'; input.setAttribute('aria-label', 'Search programs, findings and reports');
    input.setAttribute('role', 'combobox'); input.setAttribute('aria-expanded', 'true'); input.setAttribute('aria-controls', 'global-search-results'); input.setAttribute('aria-autocomplete', 'list');
    field.append(icon('fa-search'), input, el('kbd', 'kbd search-kbd', 'Esc'));
    status = el('div', 'search-status hint'); status.setAttribute('role', 'status');
    list = el('div', 'search-results'); list.id = 'global-search-results'; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', 'Search results');
    const foot = el('div', 'search-foot hint', 'Up and down to move, Enter to open, Ctrl or Cmd+Enter for a new tab, Shift+Enter to open a finding’s report, Esc to close.');
    dialog.append(field, status, list, foot); overlay.append(dialog); document.body.append(overlay);
    overlay.addEventListener('mousedown', event => { if (event.target === overlay) close(); });
    input.addEventListener('input', () => { clearTimeout(timer); retries = 0; timer = setTimeout(run, 120); if (!input.value.trim()) run(); });
    input.addEventListener('keydown', onKey);
    list.addEventListener('mousedown', event => { if (event.button === 0) event.preventDefault(); }); // keep focus in the input
    // Results are real links: middle-click, Ctrl/Cmd/Shift+click and the context
    // menu open them natively in a new tab; a plain click navigates in-app.
    list.addEventListener('click', event => {
      const row = event.target.closest('[data-index]'); if (!row) return;
      if (event.target.closest('a') && (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)) return;
      event.preventDefault();
      const action = event.target.closest('[data-action]')?.dataset.action;
      choose(Number(row.dataset.index), action === 'report');
    });
    list.addEventListener('mousemove', event => { const row = event.target.closest('[data-index]'); if (row && Number(row.dataset.index) !== active) setActive(Number(row.dataset.index), false); });
    followup = el('div', 'search-followup message'); followup.hidden = true; followup.setAttribute('role', 'status'); document.body.append(followup);
  }
  function open(seed = '') {
    build();
    if (!overlay.hidden) { input.focus(); input.select(); return; }
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    hideFollowup();
    overlay.hidden = false; input.value = seed; items = []; active = -1;
    field?.setAttribute('aria-expanded', 'true');
    input.focus();
    if (seed) { input.setSelectionRange(seed.length, seed.length); run(); } else show();
    fetchSearch('').catch(() => {}); // warm-up: starts the server index
  }
  function close(restore = true) {
    if (!overlay || overlay.hidden) return;
    clearTimeout(timer); controller?.abort(); ++sequence;
    overlay.hidden = true;
    field?.setAttribute('aria-expanded', 'false');
    if (restore && opener?.isConnected) opener.focus({ preventScroll: true });
    else if (restore) document.querySelector('#main')?.focus({ preventScroll: true });
    opener = null;
  }

  // ---- results ---------------------------------------------------------
  function setActive(index, scroll = true) {
    active = index;
    list.querySelectorAll('[role=option]').forEach((row, i) => { row.setAttribute('aria-selected', String(i === index)); row.classList.toggle('active', i === index); });
    const row = list.querySelector(`[data-index="${index}"]`);
    if (row) { input.setAttribute('aria-activedescendant', row.id); if (scroll) row.scrollIntoView({ block: 'nearest' }); }
    else input.removeAttribute('aria-activedescendant');
  }
  function render(groups, emptyText) {
    list.replaceChildren(); items = [];
    for (const [heading, entries] of groups) {
      if (!entries.length) continue;
      const group = el('div', 'search-group'); group.setAttribute('role', 'group'); group.setAttribute('aria-label', heading);
      group.append(el('div', 'search-group-title', heading));
      for (const entry of entries) {
        const index = items.length; items.push(entry);
        const row = el('div', 'search-item'); row.id = `global-search-option-${index}`; row.dataset.index = String(index); row.setAttribute('role', 'option'); row.setAttribute('aria-selected', 'false');
        row.append(icon(entry.icon || 'fa-circle-o'));
        const href = entry.target && ctx.hrefFor ? ctx.hrefFor(entry.target) : '';
        const body = el(href ? 'a' : 'div', href ? 'search-body search-link' : 'search-body');
        if (href) { body.href = href; body.tabIndex = -1; }
        const head = el('div', 'search-head');
        head.append(entry.node || highlighted(entry.title, entry.ranges));
        if (entry.severity) { const badge = el('span', 'search-badge', entry.severity); badge.dataset.severity = entry.severity.toLowerCase(); head.append(badge); }
        body.append(head);
        if (entry.subtitle) body.append(el('div', 'search-sub hint', entry.subtitle));
        if (entry.snippet) { const snippet = el('div', 'search-snippet'); snippet.append(highlighted(entry.snippet, entry.snippetRanges)); body.append(snippet); }
        row.append(body);
        if (entry.reportTarget) { const b = el('a', 'button subtle search-open-report', entry.reportLabel || 'Open report'); b.href = ctx.hrefFor ? ctx.hrefFor(entry.reportTarget) : '#'; b.tabIndex = -1; b.dataset.action = 'report'; row.append(b); }
        group.append(row);
      }
      list.append(group);
    }
    if (!items.length) list.append(el('div', 'state', emptyText || 'No results.'));
    setActive(items.length ? 0 : -1, false);
  }
  function show() {
    const q = input.value.trim();
    delete list.dataset.resultsFor;
    if (q) { status.textContent = 'Searching…'; return; }
    const entries = [];
    const ps = ctx.programs();
    const jump = ps.slice(0, 8).map(p => ({ icon: 'fa-folder-o', title: String(p.name || p.id), subtitle: `${p.family || ''} · ${(p.lanes || []).length} lanes`, target: { program: String(p.id), section: 'findings' } }));
    const rec = recents().map(r => ({ icon: 'fa-history', title: r, subtitle: 'Recent search', recent: r }));
    status.textContent = ps.length ? 'Type to search. Jump to a program or repeat a recent search.' : 'Programs are not loaded yet.';
    render([['Recent searches', rec], ['Jump to program', jump]], 'Nothing to show yet.');
    if (rec.length) { const clear = el('button', 'button subtle search-clear', 'Clear recent searches'); clear.type = 'button'; clear.tabIndex = -1; clear.addEventListener('click', () => { saveRecents([]); show(); }); list.append(clear); }
  }
  async function fetchSearch(q, signal) {
    const params = new URLSearchParams({ q, limit: '8' });
    const response = await fetch(`/api/search?${params}`, { cache: 'no-store', signal });
    if (!response.ok) { const e = new Error('search failed'); e.status = response.status; throw e; }
    return response.json();
  }
  async function run() {
    const q = input.value.trim();
    controller?.abort();
    if (!q) { ++sequence; show(); return; }
    const mine = ++sequence; controller = new AbortController();
    try {
      const data = await fetchSearch(q, controller.signal);
      if (mine !== sequence) return;
      present(data);
      if (data.index_state === 'building' && retries++ < 15) timer = setTimeout(run, 700);
    } catch (error) {
      if (mine !== sequence || error.name === 'AbortError') return;
      status.textContent = error.status === 503 ? 'Search is busy. Retrying.' : 'Search is unavailable.';
      if (error.status === 503 && retries++ < 5) timer = setTimeout(run, 800);
      else render([], 'Search is unavailable.');
    }
  }
  function present(data) {
    const r = data.results || {};
    const place = x => `${x.program_name || x.program} / ${x.lane}`;
    const groups = [
      ['Programs', (r.programs || []).map(p => ({ icon: 'fa-folder-o', title: p.name, ranges: p.title_ranges, subtitle: `${p.family} · ${p.finding_count} findings · ${p.report_count} reports`, target: p.target }))],
      ['Findings', (r.findings || []).map(f => ({ icon: 'fa-bug', title: f.title, ranges: f.title_ranges, severity: f.severity, subtitle: `${f.fid} · ${f.class || 'no class'} · ${f.status || 'no status'} · ${place(f)}${f.report ? (f.report.kind === 'evidence' ? ' · evidence, no report yet' : '') : ' · no linked report'}`, target: f.target, reportTarget: f.report?.target, reportLabel: f.report?.kind === 'evidence' ? 'Open evidence' : 'Open report', finding: f }))],
      ['Reports', (r.reports || []).map(x => ({ icon: 'fa-file-text-o', title: x.title, ranges: x.title_ranges, subtitle: `${x.path} · ${place(x)}${x.owner_fids?.length ? ` · finding ${x.owner_fids[0]}` : ''}`, snippet: x.snippet, snippetRanges: x.snippet_ranges, target: x.target, report: x }))],
    ];
    const state = data.index_state;
    const total = Object.values(data.counts || {}).reduce((a, b) => a + b, 0);
    const bits = [`${total} match${total === 1 ? '' : 'es'}`];
    if (state === 'building') bits.push('index is still building');
    if (state === 'partial') bits.push('index is partial (some content is not searchable)');
    const rootNow = ctx.state.data?.root_instance;
    if (rootNow && data.root_instance && rootNow !== data.root_instance) bits.push('data root changed: refresh the board');
    status.textContent = bits.join('. ') + '.';
    render(groups, state === 'building' ? 'Indexing…' : 'No results.');
    list.dataset.resultsFor = data.query; // which query the list shows (tests, assistive tooling)
  }

  // ---- selection -------------------------------------------------------
  function choose(index, openReport = false) {
    const entry = items[index]; if (!entry) return;
    if (entry.recent) { input.value = entry.recent; retries = 0; run(); return; }
    if (openReport && !entry.reportTarget) return;
    const target = openReport ? entry.reportTarget : entry.target;
    remember(input.value);
    close(false);
    if (!ctx.navigate(target)) { announce('That item is no longer available. Refresh the board and search again.'); return; }
    if (entry.finding && !openReport) {
      announce(`Showing finding ${entry.finding.fid}.`, entry.reportTarget ? { label: entry.reportLabel || 'Open report', target: entry.reportTarget } : null, entry.reportTarget ? '' : 'No linked report.');
    } else if (entry.report && !openReport && entry.report.owner_fids?.length) {
      const fid = entry.report.owner_fids[0];
      announce(`Report for finding ${fid}.`, { label: 'Show finding', target: { program: target.program, lane: target.lane, section: 'findings', finding: fid } });
    }
    const keep = opener?.isConnected && opener !== document.body ? opener : document.querySelector('#main');
    keep?.focus?.({ preventScroll: true }); opener = null;
  }
  // Ctrl/Cmd+Enter: open the active result (Shift: its report) in a new tab; the palette stays open.
  function openInNewTab(index, openReport) {
    const entry = items[index]; if (!entry || !ctx.hrefFor) return;
    const target = openReport ? entry.reportTarget : entry.target; if (!target) return;
    remember(input.value);
    window.open(ctx.hrefFor(target), '_blank', 'noopener');
  }
  function onKey(event) {
    const key = event.key;
    if (key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    else if (key === 'ArrowDown') { event.preventDefault(); if (items.length) setActive((active + 1) % items.length); }
    else if (key === 'ArrowUp') { event.preventDefault(); if (items.length) setActive((active - 1 + items.length) % items.length); }
    else if (key === 'Home' && event.ctrlKey) { event.preventDefault(); if (items.length) setActive(0); }
    else if (key === 'End' && event.ctrlKey) { event.preventDefault(); if (items.length) setActive(items.length - 1); }
    else if (key === 'Enter' && !event.isComposing && (event.ctrlKey || event.metaKey)) { event.preventDefault(); openInNewTab(active, event.shiftKey); }
    else if (key === 'Enter' && !event.isComposing) { event.preventDefault(); choose(active, event.shiftKey); }
    else if (key === 'Tab') event.preventDefault(); // the palette is a single-control modal
  }

  // ---- follow-up notice and row highlight --------------------------------
  function hideFollowup() { clearTimeout(followTimer); if (followup) followup.hidden = true; }
  function announce(text, action, extra) {
    followup.replaceChildren(el('span', 'search-follow-text', extra ? `${text} ${extra}` : text));
    if (action) {
      const button = el('button', 'button', action.label); button.type = 'button';
      button.addEventListener('click', () => { hideFollowup(); ctx.navigate(action.target); });
      followup.append(button);
    }
    const dismiss = el('button', 'button subtle', 'Dismiss'); dismiss.type = 'button'; dismiss.addEventListener('click', hideFollowup);
    followup.append(dismiss);
    followup.hidden = false;
    clearTimeout(followTimer); followTimer = setTimeout(hideFollowup, 20000);
  }
  // ---- mount -----------------------------------------------------------
  // The topbar shows an inline search field (styled like the redesign's
  // .input-icon fields). It is an entry point only: a pointer focus, typing,
  // Enter or ArrowDown opens the palette (seeded with what was typed). Keyboard
  // focus alone does not open it, so Tab can move past the field.
  function mount() {
    const host = document.querySelector('#global-search-host');
    if (!host || host.querySelector('#global-search-field')) return;
    const wrap = el('div', 'search-inline input-icon');
    field = el('input'); field.type = 'search'; field.id = 'global-search-field'; field.autocomplete = 'off'; field.spellcheck = false;
    field.placeholder = 'Search programs, findings, reports';
    field.setAttribute('aria-label', 'Search the workspace'); // distinct from the page's own program/finding search labels
    field.setAttribute('aria-haspopup', 'dialog'); field.setAttribute('aria-expanded', 'false');
    field.setAttribute('aria-keyshortcuts', 'Control+K Meta+K');
    const kbd = el('kbd', 'kbd search-kbd', /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'); kbd.setAttribute('aria-hidden', 'true');
    wrap.append(icon('fa-search'), field, kbd);
    let pointer = false;
    field.addEventListener('pointerdown', () => { pointer = true; });
    field.addEventListener('focus', () => { if (pointer) { pointer = false; queueMicrotask(() => open()); } });
    field.addEventListener('keydown', event => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      if (event.key.length === 1 && /\S/.test(event.key)) { event.preventDefault(); open(event.key); }
      else if (event.key === 'Enter' || event.key === 'ArrowDown') { event.preventDefault(); open(); }
    });
    field.addEventListener('input', () => { const seed = field.value; field.value = ''; if (seed.trim()) open(seed); });
    host.append(wrap);
  }
  if (!window.__boardSearchKeys) {
    window.__boardSearchKeys = true;
    // Capture phase so the shortcut also works inside the report editor.
    document.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k' && ctx) { event.preventDefault(); event.stopPropagation(); open(); }
    }, true);
  }
  window.registerBoardModule({
    name: 'search',
    afterRender(context) { ctx = context; mount(); }, // never moves focus
  });
})();
