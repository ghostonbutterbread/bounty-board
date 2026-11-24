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
 * the defaults. Values are only parsed with URLSearchParams and escaped on output. */
(() => {
  'use strict';
  const PREFS = 'bounty-board-recent-reports';
  const PAGE = 50;
  const WINDOWS = [['1d', '24 hours', 86400], ['7d', '7 days', 7 * 86400], ['30d', '30 days', 30 * 86400], ['all', 'All', null]];
  const LANES = ['web', 'api', 'apk', 'exe', 'mac'];
  const DEFAULT_WINDOW = '7d';
  const MAX_PAGE = 20000; // the server accepts offsets up to 1,000,000
  let ctx = null;
  const view = {window: DEFAULT_WINDOW, programs: [], lane: '', q: '', order: 'newest', nav: false, offset: 0,
    data: null, at: 0, source: null, loading: false, error: '', seq: 0, controller: null, retry: 0, timer: 0, qTimer: 0};
  const panel = {data: null, at: 0, source: null, loading: false, error: '', seq: 0, waitTimer: 0, waited: 0, retry: 0};

  try {
    const saved = JSON.parse(localStorage.getItem(PREFS) || 'null');
    if (saved && typeof saved === 'object') {
      if (WINDOWS.some(([k]) => k === saved.window)) view.window = saved.window;
      if (saved.order === 'oldest') view.order = 'oldest';
      view.nav = saved.nav === true;
      if (Array.isArray(saved.programs)) view.programs = saved.programs.filter(p => typeof p === 'string').slice(0, 100);
      if (LANES.includes(saved.lane)) view.lane = saved.lane;
    }
  } catch {}
  const savePrefs = () => { try { localStorage.setItem(PREFS, JSON.stringify({window: view.window, order: view.order, nav: view.nav, programs: view.programs, lane: view.lane})); } catch {} };

  // ---- URL state -----------------------------------------------------------
  function queryFor() {
    const params = new URLSearchParams({within: view.window});
    for (const p of view.programs) params.append('program', p);
    if (view.lane) params.set('lane', view.lane);
    if (view.q.trim()) params.set('q', view.q.trim().slice(0, 200));
    params.set('order', view.order);
    if (view.nav) params.set('nav', '1');
    const page = Math.floor(view.offset / PAGE) + 1;
    if (page > 1) params.set('page', String(page));
    return params.toString();
  }
  function applyQuery(query) {
    const params = new URLSearchParams(query);
    const known = new Set(ctx.programs().map(p => String(p.id)));
    const clean = value => String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    const within = params.get('within');
    view.window = WINDOWS.some(([k]) => k === within) ? within : DEFAULT_WINDOW;
    view.programs = [...new Set(params.getAll('program').map(clean).filter(p => p && p.length <= 200 && (!known.size || known.has(p))))].slice(0, 100);
    view.lane = LANES.includes(params.get('lane')) ? params.get('lane') : '';
    view.q = clean(params.get('q') || '').slice(0, 200);
    view.order = params.get('order') === 'oldest' ? 'oldest' : 'newest';
    view.nav = params.get('nav') === '1';
    const page = /^[0-9]{1,6}$/.test(params.get('page') || '') ? Number(params.get('page')) : 1;
    view.offset = page > 1 && page <= MAX_PAGE ? (page - 1) * PAGE : 0;
  }
  // Keeps ctx.state.recentQuery (what app.js puts in #/recent) equal to the
  // current filters; writes the address bar only while the view is shown.
  function writeUrl(push = false) {
    const query = queryFor();
    ctx.state.recentQuery = query;
    if (ctx.state.view !== 'recent') return;
    const next = ctx.hrefFor({view: 'recent', query});
    if (location.hash !== next) { try { history[push ? 'pushState' : 'replaceState'](null, '', next); } catch {} }
  }

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
  const programHref = item => ctx.hrefFor({program: item.program, lane: item.lane, section: 'findings'});
  const findingCell = item => item.finding
    ? `<a class="link-button" href="${esc(ctx.hrefFor({program: item.program, lane: item.lane, section: 'findings', finding: item.finding.fid}))}" title="${esc(item.finding.title || '')}">${esc(item.finding.fid)}</a> ${ui().severityBadge(item.finding.severity)}`
    : (item.owner_fids && item.owner_fids.length ? `<span class="id">${esc(item.owner_fids[0])}</span>` : '<span class="hint">None</span>');
  const programLabel = id => { const p = ctx.programs().find(x => String(x.id) === id); return p ? String(p.name || p.id) : id.split('/').slice(1).join('/') || id; };

  async function fetchRecent(params, signal) {
    const response = await fetch(`/api/recent-reports?${params}`, {cache: 'no-store', signal});
    if (!response.ok) { const error = new Error('recent reports failed'); error.status = response.status; throw error; }
    const body = await response.json();
    body.receivedAt = Date.now();
    return body;
  }

  // ---- view --------------------------------------------------------------
  function viewParams() {
    const params = new URLSearchParams({limit: String(PAGE), offset: String(view.offset), order: view.order});
    const seconds = WINDOWS.find(([k]) => k === view.window)?.[2];
    if (seconds) params.set('within', String(seconds));
    for (const p of view.programs) params.append('program', p);
    if (view.lane) params.set('lane', view.lane);
    if (view.q.trim()) params.set('q', view.q.trim().slice(0, 200));
    if (view.nav) params.set('nav', '1');
    return params;
  }
  async function loadView({quiet = false} = {}) {
    clearTimeout(view.timer);
    const mine = ++view.seq;
    view.controller?.abort(); view.controller = new AbortController();
    view.loading = true; view.source = ctx.state.data;
    if (!quiet) paintStatus();
    try {
      const body = await fetchRecent(viewParams(), view.controller.signal);
      if (mine !== view.seq) return;
      if (body.offset > 0 && !body.items.length && body.total > 0) { view.offset = Math.floor((body.total - 1) / PAGE) * PAGE; view.loading = false; writeUrl(); return loadView({quiet}); }
      view.data = body; view.at = Date.now(); view.error = '';
      if (body.index_state === 'building' && view.retry++ < 120) view.timer = setTimeout(() => loadView({quiet: true}), 1000);
      else if (body.index_state !== 'building') view.retry = 0;
    } catch (error) {
      if (mine !== view.seq || error.name === 'AbortError') return;
      if (error.status === 503 && view.retry++ < 10) { view.error = 'Recent reports are busy. Retrying.'; view.timer = setTimeout(() => loadView({quiet: true}), 1000); }
      else view.error = 'Recent reports are unavailable. Use Refresh to try again.';
    } finally {
      if (mine === view.seq) { view.loading = false; paintView(); }
    }
  }
  function changed() { view.offset = 0; view.retry = 0; savePrefs(); writeUrl(); paintControls(); loadView(); }

  function controlsHtml() {
    const windowButtons = WINDOWS.map(([key, label]) => `<button type="button" data-recent-window="${key}" aria-pressed="${view.window === key}">${esc(label)}</button>`).join('');
    const lanes = [...new Set([...LANES.filter(l => ctx.programs().some(p => (p.lanes || []).some(x => x.name === l))), ...(view.lane ? [view.lane] : [])])];
    const programsLabel = view.programs.length ? (view.programs.length === 1 ? programLabel(view.programs[0]) : `${view.programs.length} programs`) : 'All programs';
    const chips = view.programs.map(p => `<span class="chip"><span class="chip-key">Program</span><span>${esc(programLabel(p))}</span><button type="button" data-recent-remove-program="${esc(p)}" aria-label="Remove program filter ${esc(programLabel(p))}">${icon('times')}</button></span>`).join('');
    const filtered = view.programs.length || view.lane || view.q || view.window !== DEFAULT_WINDOW;
    return `<div class="recent-toolbar">
      <div class="segmented" role="group" aria-label="Modified within">${windowButtons}</div>
      <button type="button" class="button sm recent-programs-trigger" data-recent-programs aria-haspopup="true" aria-expanded="false" aria-label="Filter programs: ${esc(programsLabel)}">${icon('folder-o')}<span>${esc(programsLabel)}</span>${icon('angle-down')}</button>
      <select id="recent-lane" class="recent-lane" aria-label="Lane"><option value="">All lanes</option>${lanes.map(l => `<option value="${esc(l)}"${l === view.lane ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
      <div class="input-icon recent-filter">${icon('search')}<input id="recent-filter" type="search" aria-label="Filter recent reports by title or path" placeholder="Filter by title or path" value="${esc(view.q)}" autocomplete="off"></div>
      <button type="button" class="button sm" data-recent-order aria-label="Sort: ${view.order === 'oldest' ? 'oldest first' : 'newest first'}">${icon(view.order === 'oldest' ? 'sort-amount-asc' : 'sort-amount-desc')}<span>${view.order === 'oldest' ? 'Oldest first' : 'Newest first'}</span></button>
      <label class="recent-nav"><input type="checkbox" id="recent-nav"${view.nav ? ' checked' : ''}> Include generated navigation</label>
      <button type="button" class="button sm" data-recent-refresh>${icon('refresh')}<span>Refresh list</span></button>
    </div>${chips || filtered ? `<div class="chips">${chips}${filtered ? '<button type="button" class="link-button" data-recent-clear>Clear filters</button>' : ''}</div>` : ''}`;
  }
  function statusHtml() {
    const d = view.data, bits = [];
    if (d) {
      const first = d.total ? d.offset + 1 : 0, last = d.offset + d.items.length;
      bits.push(d.total ? `Showing ${first} to ${last} of ${d.total} ${d.total === 1 ? 'report' : 'reports'}` : 'No reports match');
      if (d.index_state === 'building') bits.push('the report index is still building, so the list may be incomplete');
      if (ctx.state.data?.root_instance && d.root_instance && ctx.state.data.root_instance !== d.root_instance) bits.push('the data root changed: refresh the board');
    }
    if (view.loading) bits.push(d ? 'updating' : 'Loading recent reports');
    return `${esc(bits.join('. '))}${bits.length ? '.' : ''}${view.error ? ` <span class="recent-error">${esc(view.error)}</span>` : ''}`;
  }
  function resultsHtml() {
    const d = view.data;
    if (!d) return view.error ? '' : '<div class="state">Loading recent reports…</div>';
    if (!d.items.length) return `<div class="empty">${icon('inbox')}<strong>${d.index_state === 'building' ? 'Indexing reports…' : 'No reports match these filters.'}</strong>${view.programs.length || view.lane || view.q || view.window !== DEFAULT_WINDOW ? '<button type="button" class="link-button" data-recent-clear>Clear filters</button>' : ''}</div>`;
    const rows = d.items.map(item => `<tr data-recent-row data-program="${esc(item.program)}" data-lane="${esc(item.lane)}" data-path="${esc(item.path)}">
      <td class="recent-report"><a class="recent-link" href="${esc(reportHref(item))}">${esc(item.title || item.name)}</a><span class="recent-path">${esc(item.path)}</span></td>
      <td><a class="link-button" href="${esc(programHref(item))}">${esc(item.program_name)}</a><span class="id">${esc(item.family)}</span></td>
      <td>${esc(item.lane)}</td>
      <td class="recent-finding">${findingCell(item)}</td>
      <td class="date">${timeCell(item.modified, d)}</td></tr>`).join('');
    const page = Math.floor(d.offset / PAGE) + 1, pages = Math.max(1, Math.ceil(d.total / PAGE));
    const pager = pages > 1 ? `<nav class="recent-pager" aria-label="Recent reports pages"><button type="button" class="button sm" data-recent-page="-1"${d.offset ? '' : ' disabled'}>${icon('angle-left')}<span>Previous</span></button><span class="hint num">Page ${page} of ${pages}</span><button type="button" class="button sm" data-recent-page="1"${d.offset + PAGE < d.total ? '' : ' disabled'}><span>Next</span>${icon('angle-right')}</button></nav>` : '';
    return `<div class="table-wrap"><table class="recent-table"><thead><tr><th>Report</th><th>Program</th><th>Lane</th><th>Finding</th><th class="date">Modified</th></tr></thead><tbody>${rows}</tbody></table></div>${pager}`;
  }
  function paintControls() { const box = ctx.app.querySelector('[data-recent-controls]'); if (box) box.innerHTML = controlsHtml(); }
  function paintStatus() { const box = ctx.app.querySelector('[data-recent-status]'); if (box) box.innerHTML = statusHtml(); }
  function paintView() {
    paintStatus();
    const box = ctx.app.querySelector('[data-recent-results]'); if (box) box.innerHTML = resultsHtml();
  }
  function mountView(host) {
    const linked = ctx.state.recentQuery;
    const fromLink = typeof linked === 'string' && linked !== '' && linked !== queryFor();
    if (fromLink) { applyQuery(linked); view.retry = 0; }
    writeUrl();
    host.innerHTML = `<section class="panel recent-panel" aria-label="Recent reports list"><div class="panel-pad recent-controls" data-recent-controls>${controlsHtml()}</div><p class="hint recent-status" data-recent-status role="status">${statusHtml()}</p><div data-recent-results>${resultsHtml()}</div><p class="footnote">Ordered by file modification time. Middle-click or Ctrl/Cmd+click a report to open it in a new tab.</p></section>`;
    host.onclick = onViewClick; host.onchange = onViewChange; host.oninput = onViewInput;
    if (fromLink || !view.data || view.source !== ctx.state.data || Date.now() - view.at > 10000) { view.retry = 0; loadView(); }
  }
  function onViewClick(event) {
    const t = event.target.closest('button'); if (!t) return;
    if (t.dataset.recentWindow) { view.window = t.dataset.recentWindow; changed(); }
    else if (t.hasAttribute('data-recent-order')) { view.order = view.order === 'oldest' ? 'newest' : 'oldest'; changed(); ctx.app.querySelector('[data-recent-order]')?.focus(); }
    else if (t.hasAttribute('data-recent-refresh')) { view.retry = 0; loadView(); }
    else if (t.hasAttribute('data-recent-clear')) { view.window = DEFAULT_WINDOW; view.programs = []; view.lane = ''; view.q = ''; changed(); ctx.app.querySelector('#recent-filter')?.focus(); }
    else if (t.dataset.recentRemoveProgram != null) { view.programs = view.programs.filter(p => p !== t.dataset.recentRemoveProgram); changed(); }
    else if (t.dataset.recentPage) {
      view.offset = Math.max(0, view.offset + Number(t.dataset.recentPage) * PAGE); writeUrl(true); loadView();
      ctx.app.querySelector('.recent-panel')?.scrollIntoView({block: 'start'});
    }
    else if (t.hasAttribute('data-recent-programs')) openPrograms(t);
  }
  function onViewChange(event) {
    if (event.target.id === 'recent-lane') { view.lane = event.target.value; changed(); ctx.app.querySelector('#recent-lane')?.focus(); }
    else if (event.target.id === 'recent-nav') { view.nav = event.target.checked; changed(); ctx.app.querySelector('#recent-nav')?.focus(); }
  }
  function onViewInput(event) {
    if (event.target.id !== 'recent-filter') return;
    view.q = event.target.value; view.offset = 0;
    ctx.state.recentQuery = queryFor(); // the address bar follows after the debounce
    clearTimeout(view.qTimer);
    view.qTimer = setTimeout(() => { view.retry = 0; writeUrl(); loadView(); }, 200);
  }
  // Program multi-select: a searchable checkbox list (counts from the server's
  // facets ignore the program filter itself). Stays open while ticking.
  function openPrograms(trigger) {
    const box = document.createElement('div');
    const counts = new Map((view.data?.facets?.programs || []).map(p => [p.id, p.count]));
    const all = ctx.programs().map(p => ({id: String(p.id), name: String(p.name || p.id), family: p.family || ''}));
    for (const id of view.programs) if (!all.some(p => p.id === id)) all.push({id, name: programLabel(id), family: ''});
    const has = p => (counts.get(p.id) || 0) > 0 ? 0 : 1; // programs with matching reports first
    all.sort((a, b) => has(a) - has(b) || a.name.localeCompare(b.name));
    box.innerHTML = `<div class="menu-label">Programs</div><div class="input-icon recent-program-search">${icon('search')}<input type="search" aria-label="Search programs to filter" placeholder="Search programs" autocomplete="off"></div><div class="menu recent-program-list" role="group" aria-label="Program values">${all.map(p => `<label class="option" data-name="${esc((p.name + ' ' + p.id).toLowerCase())}"><input type="checkbox" value="${esc(p.id)}"${view.programs.includes(p.id) ? ' checked' : ''}><span>${esc(p.name)}<span class="id"> ${esc(p.family)}</span></span><span class="count">${counts.has(p.id) ? counts.get(p.id) : 0}</span></label>`).join('')}</div><div class="menu-foot"><button type="button" class="button sm ghost" data-clear>Clear</button><button type="button" class="button sm" data-done>Done</button></div>`;
    const search = box.querySelector('input[type=search]');
    search.addEventListener('input', () => { const q = search.value.trim().toLowerCase(); box.querySelectorAll('label.option').forEach(o => { o.hidden = !!q && !o.dataset.name.includes(q); }); });
    box.addEventListener('change', event => {
      const input = event.target.closest('input[type=checkbox]'); if (!input) return;
      const set = new Set(view.programs); if (input.checked) set.add(input.value); else set.delete(input.value);
      view.programs = [...set]; view.offset = 0; savePrefs(); writeUrl(); loadView();
      const label = ctx.app.querySelector('[data-recent-programs] span'); if (label) label.textContent = view.programs.length ? (view.programs.length === 1 ? programLabel(view.programs[0]) : `${view.programs.length} programs`) : 'All programs';
    });
    box.addEventListener('click', event => {
      if (event.target.closest('[data-clear]')) { view.programs = []; box.querySelectorAll('input[type=checkbox]').forEach(i => { i.checked = false; }); ui().closePopover(true); changed(); }
      else if (event.target.closest('[data-done]')) { ui().closePopover(true); paintControls(); }
    });
    ui().openPopover(trigger, box, {className: 'filter-popover recent-program-popover', label: 'Filter programs', trapTab: true,
      reanchor: () => ctx.app.querySelector('[data-recent-programs]'), onClose: () => setTimeout(paintControls, 0)});
    search.focus();
  }

  // ---- dashboard panel ---------------------------------------------------
  async function loadPanel() {
    const mine = ++panel.seq;
    panel.loading = true; panel.source = ctx.state.data;
    try {
      const body = await fetchRecent(new URLSearchParams({limit: '8', order: 'newest'}));
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
  function panelHtml() {
    const d = panel.data;
    const body = !d ? `<div class="state">${panel.error ? esc(panel.error) : 'Loading recent reports…'}</div>`
      : !d.items.length ? `<div class="state">${d.index_state === 'building' ? 'Indexing reports…' : 'No reports found.'}</div>`
        : `<ul class="recent-dash-list">${d.items.map(item => `<li data-recent-row data-path="${esc(item.path)}"><span class="recent-dash-main"><a class="recent-link" href="${esc(reportHref(item))}">${esc(item.title || item.name)}</a><span class="recent-where">${esc(item.program_name)} / ${esc(item.lane)}${item.finding ? ` · ${esc(item.finding.fid)}` : ''}</span></span>${item.finding ? ui().severityBadge(item.finding.severity) : ''}<span class="recent-when">${timeCell(item.modified, d)}</span></li>`).join('')}</ul>`;
    return `<section class="panel recent-dash" aria-label="Recently updated reports"><div class="panel-head"><div><h2>Recently updated reports</h2><p class="hint">Newest first across all programs${d?.index_state === 'building' ? '; the report index is still building' : ''}.</p></div><a class="button sm" href="${esc(ctx.hrefFor({view: 'recent', query: `within=${DEFAULT_WINDOW}&order=newest`}))}">${icon('clock-o')}<span>View all</span></a></div>${body}</section>`;
  }
  function paintPanel() { const host = ctx.app.querySelector('#dashboard-recent-host'); if (host) host.innerHTML = panelHtml(); }
  // The panel never delays the dashboard's first paint: it renders from cache
  // and fetches afterwards, once the workspace's own report load has settled
  // (or after 4 s at most).
  function mountPanel(host) {
    host.innerHTML = panelHtml();
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

  // Keep an open view or panel current while the tab is visible.
  setInterval(() => {
    if (!ctx || document.visibilityState !== 'visible') return;
    if (ctx.app.querySelector('#recent-reports-host') && !view.loading) loadView({quiet: true}); // repaints only status and rows
    if (ctx.app.querySelector('#dashboard-recent-host') && !panel.loading && Date.now() - panel.at > 30000) loadPanel();
  }, 30000);

  window.registerBoardModule({
    name: 'recent-reports',
    afterRender(context) {
      ctx = context;
      if (!ctx.state.data || ctx.state.loading) return;
      const host = ctx.app.querySelector('#recent-reports-host');
      if (host) mountView(host);
      const dash = ctx.app.querySelector('#dashboard-recent-host');
      if (dash) mountPanel(dash);
    },
  });
})();
