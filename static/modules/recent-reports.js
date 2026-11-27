/* Recent reports: every report across all programs and lanes by last modified
 * time (GET /api/recent-reports, served from the search index).
 *  - #recent-reports-host (the #/recent view): time window, program, lane,
 *    title/path filter, newest/oldest sort, generated-navigation toggle, paging.
 *  - #dashboard-recent-host: the latest 8, loaded after the dashboard has
 *    painted and the workspace data has settled, with "View all".
 * Every report, program and finding is a real <a href> route, so a plain click
 * stays in the app (app.js) and middle-click or Ctrl/Cmd+click opens a new tab.
 * Server strings are escaped with ctx.esc before they reach innerHTML.
 * Freshness: refetched when the view opens (if older than 10 s), on Refresh, when
 * the workspace data is reloaded, and every 30 s while visible.
 * URL: the filters live in the hash (#/recent?within=7d&program=..&lane=..&q=..
 * &order=newest&nav=1&page=2) so a filtered view can be bookmarked or opened in
 * a new tab. Filter changes replace the URL, page changes push it. A link with a
 * query wins over the per-browser memory; unknown or invalid values fall back to
 * the defaults. Values are only parsed with URLSearchParams and escaped on output.
 * Actions (feat/board-recent-actions): a report the server maps to a finding
 * (item.finding) gets the shared severity and submission pills
 * (BoardFindingActions, same write paths, revisions and Undo) and a context
 * menu; every row gets the N/A toggle (report-na.js). N/A rows are hidden by
 * default ("Hide N/A", hide_na=1 on the request, `na=show` in the URL when off),
 * with "N hidden · Show".
 * Facets (feat/board-recent-facets): the filters live in the shared filter rail
 * (filter-rail.js): Submission, Severity, Vulnerability class, Modified, Program,
 * Lane and Report options, with counts from the server's facets (each ignoring
 * its own filter). URL keys sub, sev, class and lane repeat; order is newest,
 * oldest, severity or class. A Class column shows the normalized category. */
(() => {
  'use strict';
  const PREFS = 'bounty-board-recent-reports';
  const PAGE = 50;
  const WINDOWS = [['1d', '24 hours', 86400], ['7d', '7 days', 7 * 86400], ['30d', '30 days', 30 * 86400], ['all', 'All', null]];
  const LANES = ['web', 'api', 'apk', 'exe', 'mac'];
  const DEFAULT_WINDOW = '7d';
  const MAX_PAGE = 20000; // the server accepts offsets up to 1,000,000
  let ctx = null;
  const ORDERS = [['newest', 'Newest first'], ['oldest', 'Oldest first'], ['severity', 'Severity'], ['class', 'Class']];
  const FB = () => window.BoardFilterBar;
  const panel = {data: null, at: 0, source: null, loading: false, error: '', seq: 0, waitTimer: 0, waited: 0, retry: 0, showNa: false};
  // #recon-reports-host (Recon program page): the same rows, one program and lane.
  const scoped = {data: null, at: 0, key: '', loading: false, error: '', seq: 0, retry: 0, showNa: false};
  const SCOPED_LIMIT = 20;
  // Which list a row or button belongs to: the dashboard panel, the Recon reports panel or the view.
  const scopeOf = node => node.closest('#dashboard-recent-host') ? '#dashboard-recent-host' : node.closest('#recon-reports-host') ? '#recon-reports-host' : node.closest('#submissions-host') ? '#submissions-host' : '#recent-reports-host';
  const PANEL_NA = 'bounty-board-recent-panel-show-na'; // per browser, like the view's filters
  try { panel.showNa = localStorage.getItem(PANEL_NA) === '1'; } catch {}
  // Rows for mapped findings that are not in the loaded workspace data yet
  // (cold start): one shared object per finding, so the view and the panel
  // show the same values after a save.
  const fallback = new Map();

  const esc = value => ctx.esc(value);
  const icon = name => `<i class="fa fa-${name}" aria-hidden="true"></i>`;
  const ui = () => ctx.ui || window.BoardUI;
  // Relative times use the server clock (the browser may be on another device).
  const nowFor = data => data && typeof data.now === 'number' ? data.now + (Date.now() - data.receivedAt) / 1000 : Date.now() / 1000;
  const timeCell = (seconds, data) => {
    if (typeof seconds !== 'number') return '<span class="hint">Unknown</span>';
    return `<time datetime="${esc(new Date(seconds * 1000).toISOString())}" title="${esc(ui().absoluteTime(seconds))}">${esc(ui().relativeTime(seconds, nowFor(data)))}</time>`;
  };
  const reportHref = item => ctx.hrefFor(item.target || {program: item.program, lane: item.lane, section: 'reports', report: item.path});
  // One row per finding packet: when another packet file is newer than the
  // main report (an agent edited SUBMISSION.md or added a PoC), say which.
  const updatedHtml = item => item.updated_file ? `<span class="recent-updated">Updated ${esc(item.updated_file)}</span>` : '';
  const programHref = item => ctx.hrefFor({program: item.program, lane: item.lane, section: 'findings'});
  // ---- finding actions on mapped rows ------------------------------------
  const FA = () => window.BoardFindingActions;
  const NA = () => window.BoardReportNa;
  function entryFor(item) {
    const f = item.finding; if (!f || !f.fid) return null;
    const loaded = FA()?.entry?.(item.program, item.lane, f.fid);
    if (loaded) return loaded;
    const key = JSON.stringify([String(item.program), String(item.lane), String(f.fid)]);
    if (!fallback.has(key)) fallback.set(key, {...f, id: f.fid});
    return {key, program: {id: item.program, name: item.program_name, family: item.family}, lane: {name: item.lane, findings: []}, row: fallback.get(key)};
  }
  // Fresh server values replace the cold-start copies (a save refreshes the index first).
  function adopt(body) {
    for (const item of body.items || []) if (item.finding?.fid && !FA()?.entry?.(item.program, item.lane, item.finding.fid))
      fallback.set(JSON.stringify([String(item.program), String(item.lane), String(item.finding.fid)]), {...item.finding, id: item.finding.fid});
  }
  // The ledger write path accepts only standard FIDs (letter + 2 or more digits; app.py PATCH check).
  const WRITABLE_FID = /^[A-Za-z][0-9]{2,}$/;
  const pickHtml = (item, kind) => {
    const row = entryFor(item)?.row; if (!row) return '';
    const writable = WRITABLE_FID.test(String(row.id));
    const attrs = `data-recent-pick="${kind}" data-program="${esc(item.program)}" data-lane="${esc(item.lane)}" data-fid="${esc(row.id)}" aria-haspopup="menu" aria-expanded="false"${writable ? '' : ` disabled title="${esc(`${row.id} is not a standard finding ID, so it cannot be edited from the Board`)}"`}`;
    const readOnly = writable ? '' : ' (read-only: non-standard finding ID)';
    if (kind === 'sev') return `<button type="button" class="pick-trigger" ${attrs} aria-label="Severity ${esc(row.severity || 'not recorded')}${writable ? `. Change severity of ${esc(row.id)}` : esc(readOnly)}">${ui().severityBadge(row.severity)}</button>`;
    const label = ui().submissionLabel ? ui().submissionLabel(row) : '';
    return `<button type="button" class="pick-trigger" ${attrs} aria-label="Submission: ${esc(label)}${writable ? `. Change submission of ${esc(row.id)}` : esc(readOnly)}">${ui().submissionBadge ? ui().submissionBadge(row) : esc(label)}</button>`;
  };
  const naHtml = item => NA() ? NA().toggleHtml({program: item.program, lane: item.lane, path: item.path, na: item.na === true, label: item.title || item.name, disabled: item.naAvailable === false ? true : null}) : '';
  const findingCell = item => item.finding
    ? `<span class="recent-finding-cell"><a class="link-button id-link" href="${esc(ctx.hrefFor({program: item.program, lane: item.lane, section: 'findings', finding: item.finding.fid}))}" title="${esc(item.finding.title || '')}">${esc(item.finding.fid)}</a>${pickHtml(item, 'sev')}${pickHtml(item, 'sub')}</span>`
    : (item.owner_fids && item.owner_fids.length ? `<span class="id">${esc(item.owner_fids[0])}</span>` : '<span class="hint">None</span>');
  // Class column: normalized category, subclass muted, raw class in the tooltip.
  const classCell = item => {
    const c = item.finding?.class;
    if (!item.finding) return '<span class="hint">No finding</span>';
    if (!c || c.category === 'unclassified') return `<span class="hint"${c?.raw ? ` title="${esc(`Recorded class: ${c.raw}`)}"` : ''}>Unclassified</span>`;
    return `<span class="recent-class-label" title="${esc(`Recorded class: ${c.raw ?? ''}`)}">${esc(c.label)}${c.subclass_label && c.subclass !== 'other' ? ` <span class="recent-class-sub">${esc(c.subclass_label)}</span>` : ''}</span>`;
  };
  const classText = item => item.finding?.class && item.finding.class.category !== 'unclassified' ? item.finding.class.label : '';
  const programLabel = id => { const p = ctx.programs().find(x => String(x.id) === id); return p ? String(p.name || p.id) : id.split('/').slice(1).join('/') || id; };

  async function fetchRecent(params, signal) {
    const response = await fetch(`/api/recent-reports?${params}`, {cache: 'no-store', signal});
    if (!response.ok) { const error = new Error('recent reports failed'); error.status = response.status; throw error; }
    const body = await response.json();
    body.receivedAt = Date.now();
    for (const item of body.items || []) item.naAvailable = body.na_available !== false;
    adopt(body);
    return body;
  }

  // Background refreshes repaint rows; keep keyboard focus on the same control.
  function keepFocus(box, paint) {
    const active = document.activeElement;
    if (!box || !active || !box.contains(active)) return paint();
    const row = active.closest('[data-recent-row]');
    const which = active.matches('[data-na-toggle]') ? '[data-na-toggle]' : active.dataset.recentPick ? `[data-recent-pick="${active.dataset.recentPick}"]` : active.matches('a.recent-link') ? 'a.recent-link' : null;
    const path = row?.dataset.path, program = row?.dataset.program, lane = row?.dataset.lane;
    paint();
    if (!which || path == null || box.contains(document.activeElement)) return;
    const again = [...box.querySelectorAll('[data-recent-row]')].find(r => r.dataset.path === path && r.dataset.program === program && r.dataset.lane === lane);
    again?.querySelector(which)?.focus();
  }
  // ---- lists: the Recent view and the Submissions view -------------------------
  // One code path, two instances with their own state, URL keys, memory and
  // defaults. Submissions is Recent with the submission filter fixed to the
  // submitted buckets (submitted, valid, duplicate; none checked = all three).
  function createList(cfg) {
    const L = {window: cfg.defaultWindow, programs: [], lanes: [], subs: [], sevs: [], classes: [], q: '', order: 'newest', nav: false, hideNa: true, offset: 0,
      data: null, at: 0, source: null, loading: false, error: '', seq: 0, controller: null, retry: 0, timer: 0, qTimer: 0, keep: true, taxWaited: false};
    const P = cfg.id; // id prefix for controls (#recent-filter, #submissions-filter, ...)
    const subKeys = () => new Set(cfg.subOptions().map(([k]) => k));
    const sevOptions = () => (FB()?.SEVERITIES || []).filter(([k]) => cfg.withNone || k !== FB().NONE);
    const classOptionList = () => (FB()?.classOptions() || []).filter(([k]) => cfg.withNone || k !== FB().NONE);
    const host = () => ctx.app.querySelector(cfg.host);
    const inHost = selector => host()?.querySelector(selector) || null;
    try {
      const saved = JSON.parse(localStorage.getItem(cfg.prefs) || 'null');
      if (saved && typeof saved === 'object') {
        if (WINDOWS.some(([k]) => k === saved.window)) L.window = saved.window;
        if (ORDERS.some(([k]) => k === saved.order)) L.order = saved.order;
        L.nav = saved.nav === true;
        L.hideNa = saved.hideNa !== false;
        const strings = value => Array.isArray(value) ? value.filter(v => typeof v === 'string').slice(0, 100) : [];
        L.programs = strings(saved.programs);
        L.lanes = Array.isArray(saved.lanes) ? strings(saved.lanes).filter(l => LANES.includes(l)) : LANES.includes(saved.lane) ? [saved.lane] : [];
        // Facet keys are checked against the option lists once the taxonomy is ready (mount).
        L.subs = strings(saved.subs); L.sevs = strings(saved.sevs); L.classes = strings(saved.classes);
      }
    } catch {}
    const savePrefs = () => { try { localStorage.setItem(cfg.prefs, JSON.stringify({window: L.window, order: L.order, nav: L.nav, hideNa: L.hideNa, programs: L.programs, lanes: L.lanes, subs: L.subs, sevs: L.sevs, classes: L.classes})); } catch {} };
    // Drop facet values that are not options (old prefs, edited links); true when something changed.
    function validateFacets() {
      const before = JSON.stringify([L.subs, L.sevs, L.classes]);
      const keep = (values, allowed) => [...new Set(values)].filter(v => allowed.has(v));
      L.subs = keep(L.subs, subKeys()); L.sevs = keep(L.sevs, new Set(sevOptions().map(([k]) => k))); L.classes = keep(L.classes, new Set(classOptionList().map(([k]) => k)));
      return before !== JSON.stringify([L.subs, L.sevs, L.classes]);
    }

    // ---- URL state ---------------------------------------------------------
    function queryFor() {
      const params = new URLSearchParams({within: L.window});
      for (const v of L.subs) params.append('sub', v);
      for (const v of L.sevs) params.append('sev', v);
      for (const v of L.classes) params.append('class', v);
      for (const p of L.programs) params.append('program', p);
      for (const l of L.lanes) params.append('lane', l);
      if (L.q.trim()) params.set('q', L.q.trim().slice(0, 200));
      params.set('order', L.order);
      if (L.nav) params.set('nav', '1');
      if (!L.hideNa) params.set('na', 'show');
      const page = Math.floor(L.offset / PAGE) + 1;
      if (page > 1) params.set('page', String(page));
      return params.toString();
    }
    function applyQuery(query) {
      const params = new URLSearchParams(query);
      const known = new Set(ctx.programs().map(p => String(p.id)));
      const clean = value => String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
      const within = params.get('within');
      L.window = WINDOWS.some(([k]) => k === within) ? within : cfg.defaultWindow;
      L.programs = [...new Set(params.getAll('program').map(clean).filter(p => p && p.length <= 200 && (!known.size || known.has(p))))].slice(0, 100);
      L.lanes = [...new Set(params.getAll('lane').filter(l => LANES.includes(l)))];
      L.subs = params.getAll('sub').slice(0, 20); L.sevs = params.getAll('sev').slice(0, 20); L.classes = params.getAll('class').slice(0, 40);
      validateFacets();
      L.q = clean(params.get('q') || '').slice(0, 200);
      L.order = ORDERS.some(([k]) => k === params.get('order')) ? params.get('order') : 'newest';
      L.nav = params.get('nav') === '1';
      L.hideNa = params.get('na') !== 'show';
      const page = /^[0-9]{1,6}$/.test(params.get('page') || '') ? Number(params.get('page')) : 1;
      L.offset = page > 1 && page <= MAX_PAGE ? (page - 1) * PAGE : 0;
    }
    // Keeps ctx.state[cfg.stateKey] (what app.js puts in the route) equal to the
    // current filters; writes the address bar only while the view is shown.
    function writeUrl(push = false) {
      const query = queryFor();
      ctx.state[cfg.stateKey] = query;
      if (ctx.state.view !== cfg.view) return;
      const next = ctx.hrefFor({view: cfg.view, query});
      if (location.hash !== next) { try { history[push ? 'pushState' : 'replaceState'](null, '', next); } catch {} }
    }

    // ---- "No longer matches" -------------------------------------------------
    // A pill edit can move a row out of the filter. Such a row stays where it is,
    // dimmed, until the next filter change or "Refresh list" (also across polls).
    const effectiveSubs = () => L.subs.length ? L.subs : cfg.baseSubs;
    function matchesNow(item) {
      if (!item.finding || !FB()) return true;
      const row = entryFor(item)?.row; if (!row) return true;
      const subs = effectiveSubs();
      return (!subs.length || subs.includes(FB().keys.submission(row))) && (!L.sevs.length || L.sevs.includes(FB().keys.severity(row))) &&
        (!L.classes.length || L.classes.includes(FB().keys.classKey(row)));
    }
    const itemKey = i => JSON.stringify([String(i.program), String(i.lane), i.path]);
    function carryKept(body) {
      if (!L.keep || !L.data || !body.items) return;
      const fresh = new Set(body.items.map(itemKey));
      L.data.items.forEach((item, index) => {
        if (fresh.has(itemKey(item)) || matchesNow(item)) return;
        body.items.splice(Math.min(index, body.items.length), 0, {...item, kept: true});
      });
    }

    // ---- loading -------------------------------------------------------------
    function params() {
      const out = new URLSearchParams({limit: String(PAGE), offset: String(L.offset), order: L.order});
      const seconds = WINDOWS.find(([k]) => k === L.window)?.[2];
      if (seconds) out.set('within', String(seconds));
      for (const p of L.programs) out.append('program', p);
      for (const l of L.lanes) out.append('lane', l);
      for (const v of effectiveSubs()) out.append('submission', v);
      for (const v of L.sevs) out.append('severity', v);
      for (const v of L.classes) out.append('class', v);
      if (L.q.trim()) out.set('q', L.q.trim().slice(0, 200));
      if (L.nav) out.set('nav', '1');
      if (L.hideNa) out.set('hide_na', '1');
      return out;
    }
    async function load({quiet = false} = {}) {
      clearTimeout(L.timer);
      const mine = ++L.seq;
      L.controller?.abort(); L.controller = new AbortController();
      L.loading = true; L.source = ctx.state.data;
      if (!quiet) paintStatus();
      try {
        const body = await fetchRecent(params(), L.controller.signal);
        if (mine !== L.seq) return;
        if (body.offset > 0 && !body.items.length && body.total > 0) { L.offset = Math.floor((body.total - 1) / PAGE) * PAGE; L.loading = false; writeUrl(); return load({quiet}); }
        carryKept(body);
        L.keep = true;
        L.data = body; L.at = Date.now(); L.error = '';
        if (body.index_state === 'building' && L.retry++ < 120) L.timer = setTimeout(() => load({quiet: true}), 1000);
        else if (body.index_state !== 'building') L.retry = 0;
      } catch (error) {
        if (mine !== L.seq || error.name === 'AbortError') return;
        if (error.status === 503 && L.retry++ < 10) { L.error = 'Recent reports are busy. Retrying.'; L.timer = setTimeout(() => load({quiet: true}), 1000); }
        else L.error = `${cfg.noun} are unavailable. Use Refresh to try again.`;
      } finally {
        if (mine === L.seq) { L.loading = false; paint(); }
      }
    }
    // A filter, sort or page change, or Refresh list: kept rows leave.
    function fresh() { L.keep = false; L.retry = 0; load(); }
    function changed() { L.offset = 0; savePrefs(); writeUrl(); paintControls(); fresh(); }
    const filtered = () => !!(L.programs.length || L.lanes.length || L.subs.length || L.sevs.length || L.classes.length || L.q || L.window !== cfg.defaultWindow);

    // ---- filter bar ------------------------------------------------------------
    function model() {
      const f = L.data?.facets || {};
      const counted = (list, key = 'key') => new Map((list || []).map(x => [String(x[key]), x.count]));
      const subs = counted(f.submissions), sevs = counted(f.severities), programs = counted(f.programs, 'id'), lanes = counted(f.lanes, 'name');
      const has = !!L.data;
      const count = (map, key) => has ? (map.get(key) || 0) : undefined;
      const classes = new Map((f.classes || []).map(c => [c.key, c]));
      const classOptions = classOptionList().filter(([k]) => classes.has(k) || L.classes.includes(k))
        .map(([value, label]) => ({value, label: classes.get(value)?.label || label, count: has ? (classes.get(value)?.count || 0) : undefined}));
      const allPrograms = ctx.programs().map(p => ({value: String(p.id), label: String(p.name || p.id), search: `${p.id} ${p.family || ''}`, hint: String(p.id)}));
      for (const id of L.programs) if (!allPrograms.some(p => p.value === id)) allPrograms.push({value: id, label: programLabel(id), hint: id});
      const programOptions = allPrograms.map(o => ({...o, count: count(programs, o.value)}))
        .sort((a, b) => (b.count || 0) - (a.count || 0) || a.label.localeCompare(b.label));
      const laneNames = [...new Set([...LANES.filter(l => ctx.programs().some(p => (p.lanes || []).some(x => x.name === l))), ...L.lanes])];
      const optsOff = !L.hideNa || L.nav;
      return {view: cfg.id, groups: [
        {key: 'sub', label: 'Submission', options: cfg.subOptions().map(([value, label]) => ({value, label, count: count(subs, value)})), selected: L.subs, note: cfg.subNote},
        {key: 'sev', label: 'Severity', options: sevOptions().map(([value, label]) => ({value, label, count: count(sevs, value)})), selected: L.sevs},
        {key: 'class', label: 'Class', search: true, options: classOptions, selected: L.classes},
        {key: 'window', label: 'Modified', type: 'radio', defaultValue: cfg.defaultWindow, options: WINDOWS.map(([value, label]) => ({value, label, attrs: ` data-recent-window="${value}"`})), selected: [L.window]},
        {key: 'program', label: 'Program', search: true, options: programOptions, selected: L.programs},
        {key: 'lane', label: 'Lane', options: laneNames.map(l => ({value: l, label: l, count: count(lanes, l)})), selected: L.lanes},
        {key: 'opts', label: 'Options', chips: false, clear: false, countSelections: false, active: optsOff, summaryOff: () => optsOff ? [!L.hideNa ? 'N/A shown' : '', L.nav ? 'generated' : ''].filter(Boolean).join(', ') : '', options: [
          {value: 'hide_na', label: 'Hide N/A', attrs: ` id="${P}-hide-na"`},
          {value: 'nav', label: 'Include generated and _meta files', attrs: ` id="${P}-nav"`}],
        selected: [...(L.hideNa ? ['hide_na'] : []), ...(L.nav ? ['nav'] : [])]},
      ]};
    }
    const FIELD = {sub: 'subs', sev: 'sevs', class: 'classes', program: 'programs', lane: 'lanes'};
    function facetChange(group, values) {
      if (group === 'window') L.window = WINDOWS.some(([k]) => k === values[0]) ? values[0] : cfg.defaultWindow;
      else if (group === 'opts') { L.hideNa = values.includes('hide_na'); L.nav = values.includes('nav'); }
      else if (FIELD[group]) L[FIELD[group]] = [...new Set(values)];
      changed();
    }
    function clearFilters(group) {
      if (group && FIELD[group]) L[FIELD[group]] = [];
      else if (!group) { L.window = cfg.defaultWindow; L.programs = []; L.lanes = []; L.subs = []; L.sevs = []; L.classes = []; L.q = ''; }
      changed();
      if (!group) { FB()?.close(); const input = inHost(`#${P}-filter`); if (input) { input.value = ''; input.focus(); } }
    }
    function removeChip(button) {
      const group = button.dataset.facetRemove, value = button.dataset.value;
      if (group === 'window') L.window = cfg.defaultWindow;
      else if (FIELD[group]) L[FIELD[group]] = L[FIELD[group]].filter(v => v !== value);
      changed();
      (inHost('[data-facet-remove]') || inHost(`#${P}-filter`))?.focus();
    }
    function openFacet(button) {
      const key = button.dataset.facetOpen;
      if (FB().openKey() === key) { FB().close(); button.focus(); return; }
      FB().openFacet(button, model(), key, {change: facetChange, clear: clearFilters,
        anchor: () => inHost(`[data-facet-open="${CSS.escape(key)}"]`)});
    }

    // ---- rendering ---------------------------------------------------------------
    function controlsHtml() {
      const m = FB() ? model() : null;
      const sort = `<label class="recent-sort"><span>Sort</span><select id="${P}-order" aria-label="Sort">${ORDERS.map(([k, label]) => `<option value="${k}"${k === L.order ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select></label>`;
      return `<div class="recent-toolbar facet-toolbar"><div class="facet-bar-host" data-facet-bar>${m ? FB().barHtml(m) : ''}</div>
        <div class="input-icon recent-filter">${icon('search')}<input id="${P}-filter" type="search" aria-label="${esc(cfg.searchLabel)}" placeholder="Filter by title or path" value="${esc(L.q)}" autocomplete="off"></div>
        ${sort}
        <button type="button" class="button sm" data-recent-refresh>${icon('refresh')}<span>Refresh list</span></button>
      </div><div data-facet-chips>${chipsHtml(m)}</div>`;
    }
    const chipsHtml = m => (m ? FB().chipsHtml(m, {clearAttrs: 'data-recent-clear'}) : '') || (filtered() ? '<div class="chips facet-chips"><button type="button" class="link-button" data-facet-clear-all data-recent-clear>Clear filters</button></div>' : '');
    function statusHtml() {
      const d = L.data, bits = [];
      if (d) {
        const first = d.total ? d.offset + 1 : 0, last = d.offset + d.items.filter(i => !i.kept).length;
        bits.push(d.total ? `Showing ${first} to ${last} of ${d.total} ${d.total === 1 ? 'report' : 'reports'}` : 'No reports match');
        if (d.index_state === 'building') bits.push('the report index is still building, so the list may be incomplete');
        if (d.na_available === false) bits.push('N/A marks are unavailable');
        if (ctx.state.data?.root_instance && d.root_instance && ctx.state.data.root_instance !== d.root_instance) bits.push('the data root changed: refresh the board');
        const stale = d.items.filter(i => i.kept || !matchesNow(i)).length;
        if (stale) bits.push(`${stale} ${stale === 1 ? 'row no longer matches' : 'rows no longer match'} the filters and ${stale === 1 ? 'stays' : 'stay'} until you change a filter or refresh the list`);
      }
      if (L.loading) bits.push(d ? 'updating' : `Loading ${cfg.noun.toLowerCase()}`);
      const hidden = L.hideNa && d?.na_hidden > 0 ? ` <span class="na-hidden-note">${d.na_hidden} N/A hidden · <button type="button" class="link-button" data-na-show-hidden data-recent-show-na>Show</button></span>` : '';
      return `${esc(bits.join('. '))}${bits.length ? '.' : ''}${hidden}${L.error ? ` <span class="recent-error">${esc(L.error)}</span>` : ''}`;
    }
    function resultsHtml() {
      const d = L.data;
      if (!d) return L.error ? '' : `<div class="state">Loading ${esc(cfg.noun.toLowerCase())}…</div>`;
      if (!d.items.length) {
        const text = d.index_state === 'building' ? 'Indexing reports…' : L.hideNa && d.na_hidden ? 'Every matching report is marked N/A.' : filtered() ? 'No reports match these filters.' : cfg.emptyDefault;
        return `<div class="empty">${icon('inbox')}<strong>${esc(text)}</strong>${filtered() ? '<button type="button" class="link-button" data-recent-clear>Clear filters</button>' : ''}</div>`;
      }
      const rows = d.items.map(item => {
        const stale = item.kept || !matchesNow(item);
        return `<tr data-recent-row data-program="${esc(item.program)}" data-lane="${esc(item.lane)}" data-path="${esc(item.path)}"${item.na || stale ? ` class="${[item.na ? 'is-na' : '', stale ? 'is-stale' : ''].filter(Boolean).join(' ')}"` : ''}${stale ? ' data-stale="true"' : ''}>
        <td class="recent-report"><a class="recent-link na-title" href="${esc(reportHref(item))}">${esc(item.title || item.name)}</a><span class="recent-path">${esc(item.path)}</span>${updatedHtml(item)}${stale ? '<span class="stale-note">No longer matches</span>' : ''}</td>
        <td class="recent-class">${classCell(item)}</td>
        <td class="recent-program"><a class="link-button" href="${esc(programHref(item))}">${esc(item.program_name)}</a><span class="id">${esc(item.family)}</span></td>
        <td class="recent-lane-cell">${esc(item.lane)}</td>
        <td class="recent-finding">${findingCell(item)}</td>
        <td class="date">${timeCell(item.modified, d)}</td>
        <td class="recent-na">${naHtml(item)}</td></tr>`;
      }).join('');
      const page = Math.floor(d.offset / PAGE) + 1, pages = Math.max(1, Math.ceil(d.total / PAGE));
      const pager = pages > 1 ? `<nav class="recent-pager" aria-label="${esc(cfg.noun)} pages"><button type="button" class="button sm" data-recent-page="-1"${d.offset ? '' : ' disabled'}>${icon('angle-left')}<span>Previous</span></button><span class="hint num">Page ${page} of ${pages}</span><button type="button" class="button sm" data-recent-page="1"${d.offset + PAGE < d.total ? '' : ' disabled'}><span>Next</span>${icon('angle-right')}</button></nav>` : '';
      return `<div class="table-wrap"><table class="recent-table"><thead><tr><th>Report</th><th class="recent-class">Class</th><th class="recent-program">Program</th><th class="recent-lane-cell">Lane</th><th class="recent-finding">Finding</th><th class="date">Modified</th><th class="recent-na"><span class="sr-only">N/A</span></th></tr></thead><tbody>${rows}</tbody></table></div>${pager}`;
    }
    function paintControls() {
      const m = FB() ? model() : null;
      const bar = inHost('[data-facet-bar]');
      if (bar && m) FB().paintBar(bar, m);
      const chips = inHost('[data-facet-chips]');
      if (chips) { const html = chipsHtml(m); if (chips.innerHTML !== html) { const focused = chips.contains(document.activeElement); chips.innerHTML = html; if (focused) (chips.querySelector('[data-facet-remove]') || inHost(`#${P}-filter`))?.focus(); } }
      const order = inHost(`#${P}-order`); if (order && order.value !== L.order) order.value = L.order;
      if (m) FB().refresh(m);
    }
    function paintStatus() { const box = inHost('[data-recent-status]'); if (box) box.innerHTML = statusHtml(); }
    function paint() {
      paintStatus();
      const box = inHost('[data-recent-results]'); if (box) keepFocus(box, () => { box.innerHTML = resultsHtml(); });
      paintControls(); // counts and chips follow the server's facets
    }
    function mount(el) {
      // Class keys need the taxonomy rules (filter-bar.js); they load with the page, well before the workspace data.
      if (FB() && window.BoardTaxonomy && !window.BoardTaxonomy.ready() && !L.taxWaited) {
        el.innerHTML = `<div class="panel state">Loading ${esc(cfg.noun.toLowerCase())}…</div>`;
        FB().whenReady().then(() => { L.taxWaited = true; const again = host(); if (again && !again.querySelector('[data-recent-results]')) mount(again); });
        return;
      }
      const linked = ctx.state[cfg.stateKey];
      const fromLink = typeof linked === 'string' && linked !== '' && linked !== queryFor();
      if (fromLink) { applyQuery(linked); L.retry = 0; L.keep = false; }
      else if (validateFacets()) savePrefs();
      writeUrl();
      el.innerHTML = `<section class="panel recent-panel" aria-label="${esc(cfg.listLabel)}" data-na-scope="${cfg.naScope}"><div class="panel-pad recent-controls" data-recent-controls>${controlsHtml()}</div><p class="hint recent-status" data-recent-status role="status">${statusHtml()}</p><div data-recent-results>${resultsHtml()}</div><p class="footnote">${esc(cfg.footnote)} Middle-click or Ctrl/Cmd+click a report to open it in a new tab.</p></section>`;
      el.onclick = onClick; el.onchange = onChange; el.oninput = onInput; el.oncontextmenu = onRowMenu; el.onkeydown = onRowKey;
      if (fromLink || !L.data || L.source !== ctx.state.data || Date.now() - L.at > 10000) { L.retry = 0; load(); }
    }
    function onClick(event) {
      const t = event.target.closest('button'); if (!t) return;
      if (t.dataset.recentPick) return openPick(t);
      if (t.dataset.facetOpen) return openFacet(t);
      if (t.hasAttribute('data-recent-show-na')) { L.hideNa = false; changed(); inHost('[data-facet-open="opts"]')?.focus(); return; }
      if (t.hasAttribute('data-recent-refresh')) fresh();
      else if (t.hasAttribute('data-recent-clear')) clearFilters(null);
      else if (t.dataset.facetRemove != null) removeChip(t);
      else if (t.dataset.recentPage) {
        L.offset = Math.max(0, L.offset + Number(t.dataset.recentPage) * PAGE); writeUrl(true); fresh();
        inHost('.recent-panel')?.scrollIntoView({block: 'start'});
      }
    }
    function onChange(event) {
      if (event.target.id === `${P}-order`) { L.order = ORDERS.some(([k]) => k === event.target.value) ? event.target.value : 'newest'; changed(); }
    }
    function onInput(event) {
      if (event.target.id !== `${P}-filter`) return;
      L.q = event.target.value; L.offset = 0;
      ctx.state[cfg.stateKey] = queryFor(); // the address bar follows after the debounce
      clearTimeout(L.qTimer);
      L.qTimer = setTimeout(() => { writeUrl(); savePrefs(); paintControls(); fresh(); }, 200);
    }
    return {L, cfg, mount, load, paint, host, get data() { return L.data; }};
  }
  const SUBMITTED = ['submitted', 'valid', 'duplicate'];
  const lists = {
    recent: createList({id: 'recent', view: 'recent', host: '#recent-reports-host', stateKey: 'recentQuery', prefs: PREFS, defaultWindow: DEFAULT_WINDOW,
      subOptions: () => FB()?.SUBMISSIONS || [], baseSubs: [], withNone: true, noun: 'Recent reports', listLabel: 'Recent reports list', naScope: 'recent-view',
      searchLabel: 'Filter recent reports by title or path', emptyDefault: 'No reports match these filters.',
      footnote: 'Ordered by file modification time unless sorted otherwise; a finding packet shows once, at its newest file.'}),
    // Submissions: reports whose finding is submitted (awaiting a result), valid or
    // duplicate. Dropped findings are not submissions.
    submissions: createList({id: 'submissions', view: 'submissions', host: '#submissions-host', stateKey: 'submissionsQuery', prefs: 'bounty-board-submissions', defaultWindow: 'all',
      subOptions: () => [['submitted', 'Awaiting result'], ['valid', 'Valid'], ['duplicate', 'Duplicate']], baseSubs: SUBMITTED, withNone: false,
      subNote: 'None checked shows all three.', noun: 'Submitted reports', listLabel: 'Submitted reports list', naScope: 'submissions-view',
      searchLabel: 'Filter submitted reports by title or path', emptyDefault: 'No submitted reports yet',
      footnote: 'Reports whose finding is submitted, valid or duplicate; dropped findings are not listed. Newest first by the packet\'s newest file.'}),
  };

  // ---- dashboard panel ---------------------------------------------------
  async function loadPanel() {
    const mine = ++panel.seq;
    panel.loading = true; panel.source = ctx.state.data;
    try {
      const body = await fetchRecent(new URLSearchParams({limit: '8', order: 'newest', ...(panel.showNa ? {} : {hide_na: '1'})}));
      if (mine !== panel.seq) return;
      panel.data = body; panel.at = Date.now(); panel.error = '';
      if (body.index_state === 'building' && panel.retry++ < 120) setTimeout(() => { if (mine === panel.seq) loadPanel(); }, 1000);
      else if (body.index_state !== 'building') panel.retry = 0;
    } catch (error) {
      if (mine !== panel.seq) return;
      if (error.status === 503 && panel.retry++ < 10) setTimeout(() => { if (mine === panel.seq) loadPanel(); }, 1000);
      else panel.error = 'Recent reports are unavailable.';
    } finally {
      if (mine === panel.seq) { panel.loading = false; paintPanel(); }
    }
  }
  // The Recent row (reference row design), shared by the dashboard and Recon panels.
  const dashRow = (item, d) => `<li data-recent-row data-program="${esc(item.program)}" data-lane="${esc(item.lane)}" data-path="${esc(item.path)}"${item.na ? ' class="is-na"' : ''}><span class="recent-dash-main"><a class="recent-link na-title" href="${esc(reportHref(item))}">${esc(item.title || item.name)}</a><span class="recent-where">${esc(item.program_name)} / ${esc(item.lane)}${item.finding ? ` · ${esc(item.finding.fid)}` : ''}${classText(item) ? ` · <span class="recent-class-label" title="${esc(`Recorded class: ${item.finding.class.raw ?? ''}`)}">${esc(classText(item))}</span>` : ''}${item.updated_file ? ` · <span class="recent-updated">Updated ${esc(item.updated_file)}</span>` : ''}</span></span><span class="frow-sev">${pickHtml(item, 'sev')}</span><span class="frow-subm">${pickHtml(item, 'sub')}</span><span class="recent-when">${timeCell(item.modified, d)}</span><span class="recent-na">${naHtml(item)}</span></li>`;
  function panelHtml() {
    const d = panel.data;
    const row = item => dashRow(item, d);
    const body = !d ? `<div class="state">${panel.error ? esc(panel.error) : 'Loading recent reports…'}</div>`
      : !d.items.length ? `<div class="state">${d.index_state === 'building' ? 'Indexing reports…' : d.na_hidden ? 'Every recent report is marked N/A.' : 'No reports found.'}</div>`
        : `<ul class="recent-dash-list">${d.items.map(row).join('')}</ul>`;
    const hidden = !d ? '' : panel.showNa ? '<span class="na-hidden-note"><button type="button" class="link-button" data-recent-panel-na="hide">Hide N/A</button></span>'
      : d.na_hidden_page > 0 || (!d.items.length && d.na_hidden > 0) ? `<span class="na-hidden-note">${d.na_hidden_page || d.na_hidden} N/A hidden · <button type="button" class="link-button" data-na-show-hidden data-recent-panel-na="show">show</button></span>` : '';
    return `<section class="panel recent-dash" aria-label="Recently updated reports" data-na-scope="recent-panel"><div class="panel-head"><div><h2>Recently updated reports</h2><p class="hint">Newest first across all programs${d?.index_state === 'building' ? '; the report index is still building' : ''}.${hidden ? ' ' : ''}${hidden}</p></div><a class="button sm" href="${esc(ctx.hrefFor({view: 'recent', query: `within=${DEFAULT_WINDOW}&order=newest`}))}">${icon('clock-o')}<span>View all</span></a></div>${body}</section>`;
  }
  function paintPanel() { const host = ctx.app.querySelector('#dashboard-recent-host'); if (host) keepFocus(host, () => { host.innerHTML = panelHtml(); }); }

  // ---- Recon program page: reports of one program and lane -------------------
  async function loadScoped(program, lane) {
    const mine = ++scoped.seq;
    scoped.loading = true;
    try {
      const body = await fetchRecent(new URLSearchParams({limit: String(SCOPED_LIMIT), order: 'newest', program, lane, ...(scoped.showNa ? {} : {hide_na: '1'})}));
      if (mine !== scoped.seq) return;
      scoped.data = body; scoped.at = Date.now(); scoped.error = ''; scoped.key = `${program}|${lane}`;
      if (body.index_state === 'building' && scoped.retry++ < 120) setTimeout(() => { if (mine === scoped.seq) loadScoped(program, lane); }, 1000);
      else if (body.index_state !== 'building') scoped.retry = 0;
    } catch (error) {
      if (mine !== scoped.seq) return;
      if (error.status === 503 && scoped.retry++ < 10) setTimeout(() => { if (mine === scoped.seq) loadScoped(program, lane); }, 1000);
      else scoped.error = 'Reports are unavailable.';
    } finally {
      if (mine === scoped.seq) { scoped.loading = false; paintScoped(); }
    }
  }
  function scopedHtml(host) {
    const {program, lane} = host.dataset;
    const d = scoped.key === `${program}|${lane}` ? scoped.data : null;
    const all = ctx.hrefFor({program, lane, section: 'reports'});
    const body = !d ? `<div class="state">${scoped.error ? esc(scoped.error) : 'Loading reports…'}</div>`
      : !d.items.length ? `<div class="state">${d.index_state === 'building' ? 'Indexing reports…' : d.na_hidden ? 'Every report here is marked N/A.' : 'No reports in this lane yet.'}</div>`
        : `<ul class="recent-dash-list">${d.items.map(item => dashRow(item, d)).join('')}</ul>`;
    const hidden = !d ? '' : scoped.showNa ? '<span class="na-hidden-note"><button type="button" class="link-button" data-recent-scoped-na="hide">Hide N/A</button></span>'
      : d.na_hidden_page > 0 || (!d.items.length && d.na_hidden > 0) ? `<span class="na-hidden-note">${d.na_hidden_page || d.na_hidden} N/A hidden · <button type="button" class="link-button" data-na-show-hidden data-recent-scoped-na="show">show</button></span>` : '';
    const count = d ? (d.total > d.items.length ? `Newest ${d.items.length} of ${d.total}` : `${d.total} ${d.total === 1 ? 'report' : 'reports'}`) : 'Reports';
    return `<section class="panel recent-dash" aria-label="Reports in this lane" data-na-scope="recon-reports"><div class="panel-head"><div><h2>Reports</h2><p class="hint">${esc(count)}, newest first.${hidden ? ' ' : ''}${hidden}</p></div><a class="button sm" href="${esc(all)}">${icon('file-text-o')}<span>All reports</span></a></div>${body}</section>`;
  }
  function paintScoped() { const host = ctx.app.querySelector('#recon-reports-host'); if (host) keepFocus(host, () => { host.innerHTML = scopedHtml(host); }); }
  function mountScoped(host) {
    host.innerHTML = scopedHtml(host);
    host.onclick = onPanelClick; host.oncontextmenu = onRowMenu; host.onkeydown = onRowKey;
    const key = `${host.dataset.program}|${host.dataset.lane}`;
    if ((scoped.key === key && Date.now() - scoped.at < 30000) || scoped.loading) return;
    scoped.retry = 0; loadScoped(host.dataset.program, host.dataset.lane);
  }
  // The panel never delays the dashboard's first paint: it renders from cache
  // and fetches afterwards, once the workspace's own report load has settled
  // (or after 4 s at most).
  function mountPanel(host) {
    host.innerHTML = panelHtml();
    host.onclick = onPanelClick; host.oncontextmenu = onRowMenu; host.onkeydown = onRowKey;
    const stale = !panel.data || panel.source !== ctx.state.data || Date.now() - panel.at > 60000;
    if (!stale || panel.loading || panel.waitTimer) return;
    const attempt = () => {
      panel.waitTimer = 0;
      if (!ctx.app.querySelector('#dashboard-recent-host')) { panel.waited = 0; return; }
      const busy = ctx.state.loading || ctx.state.data?.reports_loading === true || ctx.state.data?._portfolioLoading;
      if (busy && panel.waited < 4000) { panel.waited += 250; panel.waitTimer = setTimeout(attempt, 250); return; }
      panel.waited = 0; panel.retry = 0; loadPanel();
    };
    panel.waitTimer = setTimeout(attempt, 0);
  }

  // ---- row actions ---------------------------------------------------------
  function onPanelClick(event) {
    const t = event.target.closest('button'); if (!t) return;
    if (t.dataset.recentPick) return openPick(t);
    if (t.dataset.recentScopedNa) {
      const host = t.closest('#recon-reports-host');
      scoped.showNa = t.dataset.recentScopedNa === 'show'; scoped.retry = 0;
      loadScoped(host.dataset.program, host.dataset.lane).then(() => ctx.app.querySelector('#recon-reports-host [data-recent-scoped-na]')?.focus());
      return;
    }
    if (t.dataset.recentPanelNa) {
      panel.showNa = t.dataset.recentPanelNa === 'show'; panel.retry = 0;
      try { localStorage.setItem(PANEL_NA, panel.showNa ? '1' : '0'); } catch {}
      loadPanel().then(() => ctx.app.querySelector('#dashboard-recent-host [data-recent-panel-na]')?.focus());
    }
  }
  // The item behind a row: the same report may be in the view and the panel.
  function itemFor(node) {
    const row = node?.closest?.('[data-recent-row]'); if (!row) return null;
    const where = scopeOf(row);
    const list = where === '#dashboard-recent-host' ? panel.data?.items : where === '#recon-reports-host' ? scoped.data?.items : where === '#submissions-host' ? lists.submissions.data?.items : lists.recent.data?.items;
    return (list || []).find(i => i.path === row.dataset.path && String(i.program) === row.dataset.program && String(i.lane) === row.dataset.lane) || null;
  }
  function refocus(selector) { return () => requestAnimationFrame(() => ctx.app.querySelector(selector)?.focus()); }
  const pickSelector = (item, kind, scope) => `${scope} [data-recent-pick="${kind}"][data-program="${CSS.escape(String(item.program))}"][data-lane="${CSS.escape(String(item.lane))}"][data-fid="${CSS.escape(String(item.finding.fid))}"]`;
  function openPick(button) {
    const item = itemFor(button), entry = item && entryFor(item);
    if (!entry || !FA() || button.disabled || !WRITABLE_FID.test(String(entry.row.id))) return;
    const scope = scopeOf(button);
    const kind = button.dataset.recentPick;
    FA()[kind === 'sev' ? 'severityPills' : 'submissionPills'](button, [entry], refocus(pickSelector(item, kind, scope)));
  }
  function pointAnchor(x, y) {
    const anchor = document.createElement('span');
    anchor.className = 'point-anchor'; anchor.setAttribute('aria-hidden', 'true');
    anchor.style.left = `${Math.round(x)}px`; anchor.style.top = `${Math.round(y)}px`;
    (document.querySelector('#ui-layer') || document.body).append(anchor);
    return anchor;
  }
  // Report-centred menu; the finding parts reuse the finding-actions pickers.
  function openRowMenu(node, x, y) {
    const item = itemFor(node); if (!item) return;
    const entry = entryFor(item), fa = FA();
    const scope = scopeOf(node);
    const focusBack = () => node.isConnected ? node.querySelector('a.recent-link')?.focus() : null;
    const at = () => pointAnchor(x, y);
    const openTab = href => window.open(new URL(href, location.href).href, '_blank', 'noopener');
    const naOff = !NA() || item.naAvailable === false || !NA().available();
    const items = [{heading: item.finding ? `${item.finding.fid} · ${item.name}` : item.name},
      {label: 'Open report in new tab', icon: 'external-link', onSelect: () => openTab(reportHref(item))}];
    const fidWritable = entry ? WRITABLE_FID.test(String(entry.row.id)) : false;
    if (entry) {
      items.push({label: 'Open finding', icon: 'bug', onSelect: () => ctx.navigate({program: item.program, lane: item.lane, section: 'findings', finding: String(entry.row.id)})},
        {separator: true},
        {label: 'Change severity…', icon: 'signal', disabled: !fidWritable || !fa?.canEdit('severity'), onSelect: () => fa.severityPills(at(), [entry], refocus(pickSelector(item, 'sev', scope)))},
        {label: 'Submission…', icon: 'paper-plane-o', disabled: !fidWritable || !fa?.canSubmit(), onSelect: () => fa.submissionPills(at(), [entry], refocus(pickSelector(item, 'sub', scope)))},
        {label: 'Copy ID', icon: 'clipboard', onSelect: () => fa.copyIds([entry])});
      if (!fa?.canEdit('severity')) items.splice(1, 0, {heading: fa?.OFF_HINT || ''});
    }
    items.push({separator: true}, {label: item.na ? 'Unmark N/A' : 'Mark N/A', icon: 'check', disabled: naOff,
      onSelect: () => NA().set(item.program, item.lane, item.path, !item.na, {focusKey: scope === '#dashboard-recent-host' ? 'recent-panel' : scope === '#recon-reports-host' ? 'recon-reports' : scope === '#submissions-host' ? 'submissions-view' : 'recent-view'})});
    const anchor = pointAnchor(x, y);
    ui().openMenu(anchor, items, {label: `Actions for ${item.title || item.name}`, reanchor: () => null, onClose: () => { anchor.remove(); focusBack(); }});
    document.querySelector('.menu-popover')?.classList.add('context-menu');
    window.dispatchEvent(new Event('resize'));
  }
  let keyboardMenuAt = 0;
  function onRowMenu(event) {
    if (Date.now() - keyboardMenuAt < 1000 && document.querySelector('#ui-layer .context-menu')) { event.preventDefault(); return; }
    if (event.shiftKey) return; // Shift+right-click keeps the browser menu.
    const node = event.target.closest('[data-recent-row]'); if (!node || event.target.closest('input, select, textarea')) return;
    event.preventDefault();
    const r = node.getBoundingClientRect(), keyboard = event.clientX === 0 && event.clientY === 0;
    openRowMenu(node, keyboard ? r.left + 24 : event.clientX, keyboard ? r.bottom : event.clientY);
  }
  function onRowKey(event) {
    if (!(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) return;
    const node = event.target.closest('[data-recent-row]'); if (!node) return;
    event.preventDefault(); keyboardMenuAt = Date.now();
    const r = node.getBoundingClientRect();
    openRowMenu(node, r.left + 24, r.bottom);
  }
  // A saved N/A mark (report-na.js): update both lists now, then refetch so
  // totals and paging match the server.
  window.addEventListener('board-report-na', event => {
    const {program, lane, path, na} = event.detail || {};
    for (const [d, hide] of [[lists.recent.L.data, lists.recent.L.hideNa], [lists.submissions.L.data, lists.submissions.L.hideNa], [panel.data, !panel.showNa], [scoped.data, !scoped.showNa]]) {
      if (!d) continue;
      const index = d.items.findIndex(i => i.path === path && String(i.program) === program && String(i.lane) === lane);
      if (index < 0) continue;
      d.items[index].na = na;
      if (hide && na) { d.items.splice(index, 1); d.total = Math.max(0, d.total - 1); d.na_hidden = (d.na_hidden || 0) + 1; d.na_hidden_page = (d.na_hidden_page || 0) + 1; }
    }
    if (!ctx) return;
    for (const list of Object.values(lists)) if (list.host()) { list.paint(); list.load({quiet: true}); }
    if (ctx.app.querySelector('#dashboard-recent-host')) { paintPanel(); loadPanel(); }
    const reconHost = ctx.app.querySelector('#recon-reports-host');
    if (reconHost) { paintScoped(); loadScoped(reconHost.dataset.program, reconHost.dataset.lane); }
  });

  // Keep an open view or panel current while the tab is visible.
  setInterval(() => {
    if (!ctx || document.visibilityState !== 'visible') return;
    for (const list of Object.values(lists)) if (list.host() && !list.L.loading) list.load({quiet: true}); // repaints only status and rows; kept rows stay
    if (ctx.app.querySelector('#dashboard-recent-host') && !panel.loading && Date.now() - panel.at > 30000) loadPanel();
  }, 30000);

  window.registerBoardModule({
    name: 'recent-reports',
    afterRender(context) {
      ctx = context;
      if (!ctx.state.data || ctx.state.loading) return;
      for (const list of Object.values(lists)) { const host = list.host(); if (host) list.mount(host); }
      const dash = ctx.app.querySelector('#dashboard-recent-host');
      if (dash) mountPanel(dash);
      const recon = ctx.app.querySelector('#recon-reports-host');
      if (recon) mountScoped(recon);
    },
  });
})();
