/* Recon intel: URL index, JS library and test depth per program
 * (GET /api/recon/overview, GET /api/recon/program; see BACKEND_API.md).
 *  - #recon-intel-host (the #/recon view): an all-programs overview table, or one
 *    program/lane with depth summary, hosts, what has been looked for, what to
 *    hunt next and JS sections.
 *  - #dashboard-recon-host: a compact card this module inserts into the
 *    dashboard grid (after the recent reports panel), linking into the view.
 * URL: #/recon?p=<family/program>&lane=<lane>&sort=..&dir=..&q=..&hsort=..&hdir=..
 * &hq=..&under=1&hint=<lane> so filtered views can be bookmarked. Values are
 * parsed with URLSearchParams and validated; server strings are escaped with
 * ctx.esc before they reach innerHTML. Hosts and URLs are target data: they are
 * never fetched; links to them are http(s) only and open in a new tab with
 * rel="noopener noreferrer". Commands are copied, never run.
 * The server computes in the background: while a response is partial the view
 * polls every 1.5 s and shows "computing…" with what is already known. */
(function (root) {
  'use strict';
  const OVERVIEW_SORTS = ['program', 'urls', 'hosts', 'parameters', 'js_files', 'js_bytes', 'tested_urls', 'tested_params', 'test_runs', 'findings', 'last_activity'];
  const HOST_SORTS = ['host', 'urls', 'routes', 'param_urls', 'js_files', 'js_bytes', 'test_runs', 'tested_urls', 'findings', 'coverage_reviewed', 'last_test', 'surface_score'];
  const DEFAULTS = {p: '', lane: '', sort: 'urls', dir: 'desc', q: '', hsort: 'surface_score', hdir: 'desc', hq: '', under: false, hint: ''};

  // ---- pure helpers (exported for Node tests) ------------------------------
  const clean = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  function parseQuery(query) {
    const params = new URLSearchParams(String(query || ''));
    const out = {...DEFAULTS};
    const p = clean(params.get('p'));
    if (/^web_bounty\/[^/]{1,200}$/.test(p)) out.p = p;
    const lane = clean(params.get('lane'));
    if (/^[a-z]{1,10}$/.test(lane)) out.lane = lane;
    if (OVERVIEW_SORTS.includes(params.get('sort'))) out.sort = params.get('sort');
    if (params.get('dir') === 'asc') out.dir = 'asc';
    out.q = clean(params.get('q')).slice(0, 200);
    if (HOST_SORTS.includes(params.get('hsort'))) out.hsort = params.get('hsort');
    if (params.get('hdir') === 'asc') out.hdir = 'asc';
    out.hq = clean(params.get('hq')).slice(0, 200);
    out.under = params.get('under') === '1';
    const hint = clean(params.get('hint'));
    if (/^[a-z][a-z-]{0,30}$/.test(hint)) out.hint = hint;
    return out;
  }
  function buildQuery(state) {
    const params = new URLSearchParams();
    if (state.p) {
      params.set('p', state.p);
      if (state.lane) params.set('lane', state.lane);
      if (state.hsort !== DEFAULTS.hsort || state.hdir !== DEFAULTS.hdir) { params.set('hsort', state.hsort); params.set('hdir', state.hdir); }
      if (state.hq) params.set('hq', state.hq);
      if (state.under) params.set('under', '1');
      if (state.hint) params.set('hint', state.hint);
    } else {
      if (state.sort !== DEFAULTS.sort || state.dir !== DEFAULTS.dir) { params.set('sort', state.sort); params.set('dir', state.dir); }
      if (state.q) params.set('q', state.q);
    }
    return params.toString();
  }
  // Metric values arrive as {value, approximate} objects, plain numbers or null.
  const metric = v => v && typeof v === 'object' ? (typeof v.value === 'number' ? v.value : null) : (typeof v === 'number' ? v : null);
  const approx = v => !!(v && typeof v === 'object' && v.approximate);
  function sortRows(rows, key, dir, valueOf) {
    const get = valueOf || ((row, k) => metric(row[k]));
    const sign = dir === 'asc' ? 1 : -1;
    return rows.map((row, index) => ({row, index})).sort((a, b) => {
      const x = get(a.row, key), y = get(b.row, key);
      if (x == null && y == null) return a.index - b.index;
      if (x == null) return 1;   // unknown values always last
      if (y == null) return -1;
      const c = typeof x === 'string' || typeof y === 'string' ? String(x).localeCompare(String(y)) : x - y;
      return c ? c * sign : a.index - b.index;
    }).map(item => item.row);
  }
  function fmtNum(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
    if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (a >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
    return Math.round(n).toLocaleString('en-US');
  }
  function fmtBytes(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return (i ? v.toFixed(v >= 100 ? 0 : 1) : String(Math.round(v))) + ' ' + units[i];
  }
  // Characters a terminal or editor can act on or hide (C0, DEL, C1, soft hyphen,
  // bidi and invisible separators): a pasted ESC[201~ ends bracketed paste and the
  // rest runs as keystrokes, whatever the quoting. Values containing them are never
  // put on the clipboard; command builders return null and the button is disabled.
  const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\u2028\u2029\ufeff]/;
  const isCopySafe = value => value != null && !UNSAFE.test(String(value));
  const shellQuote = value => {
    if (!isCopySafe(value)) throw new Error('refusing to quote a value with control characters');
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
  };
  const safeArgs = (...values) => values.every(v => v == null || v === '' || isCopySafe(v));
  function safeHttpUrl(value) {
    try { const u = new URL(String(value)); return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null; } catch { return null; }
  }
  const curlCommand = url => isCopySafe(url) ? `curl -sS -i --max-time 20 ${shellQuote(url)}` : null;
  const bbhNext = (program, lane, param, host) => !isCopySafe(program) || !isCopySafe(lane) || !safeArgs(param, host) ? null
    : `bbh agents/url_ingest.py next ${shellQuote(program)} --lane ${shellQuote(lane)}`
    + (param ? ` --param ${shellQuote(param)}` : '') + (host ? ` --host ${shellQuote(host)}` : '') + ' --limit 20';
  const bbhStatus = (program, host) => isCopySafe(program) && isCopySafe(host) ? `bbh agents/url_ingest.py status ${shellQuote(program)} --host ${shellQuote(host)} --limit 50` : null;
  // "Surface without testing": what the dashboard card and default ranks use.
  const depthGap = row => {
    const urls = metric(row.urls) || 0, js = metric(row.js_files) || 0, runs = metric(row.test_runs) || 0;
    return (urls + 20 * js) / (1 + runs);
  };
  const helpers = {parseQuery, buildQuery, sortRows, fmtNum, fmtBytes, shellQuote, isCopySafe, safeHttpUrl, curlCommand, bbhNext, bbhStatus, metric, approx, depthGap};
  if (typeof module === 'object' && module.exports) { module.exports = helpers; return; }
  root.BoardReconIntel = helpers;

  // ---- DOM -----------------------------------------------------------------
  let ctx = null;
  const view = {state: {...DEFAULTS}, overview: null, overviewAt: 0, program: null, programKey: '', loading: false, error: '',
    seq: 0, timer: 0, polls: 0, qTimer: 0};
  const card = {data: null, at: 0, loading: false, seq: 0, timer: 0, waited: 0};
  const esc = value => ctx.esc(value);
  const icon = name => `<i class="fa fa-${name}" aria-hidden="true"></i>`;
  const ui = () => ctx.ui || window.BoardUI;
  const num = (v, bytes) => {
    const n = metric(v);
    if (n == null) return '<span class="muted" title="Not available">—</span>';
    const text = bytes ? fmtBytes(n) : fmtNum(n);
    const exact = n.toLocaleString('en-US');
    return approx(v) ? `<span class="ri-approx" title="Approximate (${esc(v.method || 'estimate')}): ${esc(exact)}">≈${esc(text)}</span>`
      : `<span title="${esc(exact)}">${esc(text)}</span>`;
  };
  const when = seconds => typeof seconds === 'number'
    ? `<time datetime="${esc(new Date(seconds * 1000).toISOString())}" title="${esc(ui().absoluteTime ? ui().absoluteTime(seconds) : new Date(seconds * 1000).toISOString())}">${esc(ui().relativeTime(seconds))}</time>`
    : '<span class="muted">—</span>';
  const isoWhen = iso => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? when(t / 1000) : '<span class="muted">—</span>'; };
  // unsafe: the server escaped unsafe characters for display, so the text is not the real URL: no link.
  const ext = (url, label, unsafe) => {
    const href = unsafe ? null : safeHttpUrl(url);
    const text = esc(label ?? url ?? '');
    return href ? `<a class="ri-ext" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${text}${icon('external-link')}</a>` : `<span class="ri-mono">${text}</span>`;
  };
  // unsafe: the server flagged a raw value of this item (unsafe_chars); the displayed text is escaped.
  const copyBtn = (value, label, title, unsafe) => (unsafe || !isCopySafe(value))
    ? `<span class="ri-copy-blocked"><button type="button" class="button sm ghost ri-copy" disabled data-ri-copy-blocked title="Not copied: contains control characters">${icon('ban')}<span>${esc(label)}</span></button><span class="ri-unsafe">contains control characters</span></span>`
    : `<button type="button" class="button sm ghost ri-copy" data-ri-copy="${esc(value)}" title="${esc(title || 'Copy ' + label)}">${icon('clipboard')}<span>${esc(label)}</span></button>`;
  const badge = (text, kind = '') => `<span class="badge ${kind}">${esc(text)}</span>`;
  const statusKind = status => ({validated_signal: 'danger', deep_reviewed: 'success', surface_reviewed: 'accent', dismissed: 'outline', discovered: '',
    open: 'warning', new: 'warning', done: 'success'}[String(status || '').toLowerCase()] || '');
  const sortTh = (label, key, active, dir, attr) => {
    const on = key === active;
    return `<th ${on ? `aria-sort="${dir === 'asc' ? 'ascending' : 'descending'}"` : ''} class="${['host', 'program'].includes(key) ? '' : 'num'}"><button type="button" class="sort-button" ${attr}="${esc(key)}" title="Sort by ${esc(label.toLowerCase())}">${esc(label)}${icon(on ? (dir === 'asc' ? 'sort-asc' : 'sort-desc') : 'sort')}</button></th>`;
  };
  const href = state => ctx.hrefFor({view: 'recon', query: buildQuery({...DEFAULTS, ...state})});
  const programName = id => String(id || '').split('/').slice(1).join('/');

  function writeUrl(push = false) {
    const query = buildQuery(view.state);
    ctx.state.reconQuery = query;
    if (ctx.state.view !== 'recon') return;
    const next = ctx.hrefFor({view: 'recon', query});
    if (location.hash !== next) { try { history[push ? 'pushState' : 'replaceState'](null, '', next); } catch {} }
  }

  async function getJson(url, signal) {
    const response = await fetch(url, {cache: 'no-store', signal});
    if (!response.ok) { const error = new Error('recon request failed'); error.status = response.status; throw error; }
    return response.json();
  }

  async function load({refresh = false, quiet = false} = {}) {
    clearTimeout(view.timer); view.timer = 0;
    const mine = ++view.seq;
    const s = view.state;
    view.loading = true;
    if (!quiet) paintStatus();
    try {
      if (s.p) {
        const params = new URLSearchParams({family: 'web_bounty', program: programName(s.p), lane: s.lane || laneFor(s.p)});
        if (refresh) params.set('refresh', '1');
        const body = await getJson(`/api/recon/program?${params}`);
        if (mine !== view.seq) return;
        view.program = body; view.programKey = `${s.p}|${body.lane}`; view.error = '';
        if (!s.lane) s.lane = body.lane;
      } else {
        const body = await getJson('/api/recon/overview');
        if (mine !== view.seq) return;
        view.overview = body; view.overviewAt = Date.now(); view.error = '';
        card.data = body; card.at = Date.now();
      }
    } catch (error) {
      if (mine !== view.seq) return;
      view.error = error.status === 404 ? 'This program or lane has no recon data source in the Board root.' : 'Recon intel is unavailable. Use Refresh to try again.';
      if (error.status === 404) view.program = null;
    } finally {
      if (mine === view.seq) {
        view.loading = false;
        paint();
        const partial = s.p ? view.program?.partial : view.overview?.partial;
        if (partial && view.polls++ < 400) view.timer = setTimeout(() => { view.timer = 0; load({quiet: true}); }, 1500);
        else { view.polls = 0; view.timer = 0; }
      }
    }
  }
  function laneFor(id) {
    const program = ctx.programs().find(p => String(p.id) === id);
    const lanes = (program?.lanes || []).map(l => String(l.name));
    return lanes.includes('web') ? 'web' : lanes[0] || 'web';
  }

  // ---- overview --------------------------------------------------------------
  function sourceCell(row, key, value, bytes) {
    const st = row.states?.[key];
    if (metric(value) != null) return num(value, bytes);
    if (!st || st.state === 'computing') return '<span class="muted" title="Computing">…</span>';
    if (st.state === 'missing') return `<span class="muted" title="${key === 'js' ? 'No JS library' : 'No URL index'}">—</span>`;
    return `<span class="ri-err" title="${esc(errorText(st.error))}">${icon('exclamation-triangle')}</span>`;
  }
  function overviewHtml() {
    const d = view.overview;
    if (!d) return view.error ? '' : '<div class="state">Loading recon intel…</div>';
    const s = view.state;
    const q = s.q.toLowerCase();
    const valueOf = (row, key) => key === 'program' ? row.program + '/' + row.lane : key === 'last_activity' ? row.last_activity : metric(row[key]);
    const rows = sortRows(d.programs.filter(r => !q || `${r.program} ${r.lane}`.toLowerCase().includes(q)), s.sort, s.dir, valueOf);
    if (!d.programs.length) return `<div class="empty">${icon('crosshairs')}<strong>No web programs found.</strong><span>Recon intel reads web_bounty/&lt;program&gt;/&lt;lane&gt;/recon under the Board root.</span></div>`;
    const th = (label, key) => sortTh(label, key, s.sort, s.dir, 'data-ri-sort');
    const body = rows.map(r => `<tr data-ri-program="${esc(r.id)}" data-lane="${esc(r.lane)}">
      <td><a class="ri-program-link" href="${esc(href({p: r.id, lane: r.lane}))}">${esc(r.program)}</a> <span class="id">${esc(r.lane)}</span>${r.approximate ? ' <span class="badge outline" title="Some values are estimates">approx.</span>' : ''}</td>
      <td class="num">${sourceCell(r, 'url_index', r.urls)}</td><td class="num">${sourceCell(r, 'url_index', r.hosts)}</td><td class="num">${sourceCell(r, 'url_index', r.parameters)}</td>
      <td class="num">${sourceCell(r, 'js', r.js_files)}</td><td class="num">${sourceCell(r, 'js', r.js_bytes, true)}</td>
      <td class="num">${sourceCell(r, 'url_index', r.tested_urls)}</td><td class="num">${sourceCell(r, 'url_index', r.tested_params)}</td>
      <td class="num">${sourceCell(r, 'url_index', r.test_runs)}${r.tests_recent?.last_7d ? ` <span class="hint" title="Test runs in the last 7 days">+${esc(r.tests_recent.last_7d)} 7d</span>` : ''}</td>
      <td class="num">${r.findings == null ? '<span class="muted">—</span>' : esc(r.findings)}</td>
      <td class="date">${when(r.last_activity)}</td></tr>`).join('');
    return `<section class="panel ri-overview-panel" aria-label="All programs"><div class="panel-head"><div><h2>All programs</h2><p class="hint">One row per web lane. Select a program for hosts, tests, hunt-next items and JavaScript.</p></div></div><div class="table-wrap"><table class="ri-table ri-overview"><thead><tr>${th('Program', 'program')}${th('URLs', 'urls')}${th('Hosts', 'hosts')}${th('Params', 'parameters')}${th('JS files', 'js_files')}${th('JS bytes', 'js_bytes')}${th('Tested URLs', 'tested_urls')}${th('Tested params', 'tested_params')}${th('Test runs', 'test_runs')}${th('Findings', 'findings')}${th('Last activity', 'last_activity')}</tr></thead><tbody>${body || '<tr><td colspan="11"><div class="state">No programs match this filter.</div></td></tr>'}</tbody></table></div></section>`;
  }

  // ---- program ---------------------------------------------------------------
  function errorText(error) {
    const code = error?.code;
    return {missing: 'Not found', locked: 'Locked by a writer; retried on the next refresh', timeout: 'Query exceeded the time budget',
      schema_mismatch: 'Schema differs from what this Board expects' + (error?.detail ? ` (${error.detail})` : ''),
      unavailable: 'Unavailable' + (error?.detail ? ` (${String(error.detail).replace(/_/g, ' ')})` : ''), invalid: 'Not a readable SQLite database'}[code] || 'Unavailable';
  }
  const res = (d, key) => d?.sources?.[key]?.result || null;
  function sourceNote(d, key, label) {
    const src = d.sources?.[key] || {};
    if (src.state === 'computing' && !src.result) return `<p class="hint ri-computing">${icon('circle-o-notch fa-spin')} Computing ${esc(label)}…</p>`;
    const bits = [];
    if (src.state === 'error') bits.push(`<span class="ri-err">${icon('exclamation-triangle')} ${esc(label)}: ${esc(errorText(src.error))}</span>`);
    if (src.computed_at) bits.push(`computed ${when(src.computed_at)}${src.elapsed != null ? ` in ${esc(src.elapsed)} s` : ''}`);
    if (src.stale) bits.push('source changed since; refreshing');
    if (src.pending && src.result) bits.push(`${icon('circle-o-notch fa-spin')} updating`);
    const r = src.result;
    if (r?.approximate) bits.push('<span class="ri-approx">≈ approximate values: sampled or estimated on a large store</span>');
    if (r?.errors && Object.keys(r.errors).length) bits.push(`<span class="ri-err">partial: ${esc(Object.keys(r.errors).join(', '))}</span>`);
    if (r?.truncated && Object.keys(r.truncated).length) bits.push(`<span class="ri-approx" data-ri-truncated>truncated to the largest groups: ${esc(Object.keys(r.truncated).join(', ').replace(/_/g, ' '))}</span>`);
    return bits.length ? `<p class="hint ri-source-note" data-ri-source="${esc(key)}">${bits.join(' · ')}</p>` : '';
  }
  function stat(label, value, opts = {}) {
    return `<div class="ri-stat${opts.warn ? ' ri-stat-warn' : ''}" ${opts.attr || ''}><strong>${opts.raw ?? num(value, opts.bytes)}</strong><span>${esc(label)}</span>${opts.sub ? `<small>${opts.sub}</small>` : ''}</div>`;
  }
  function emptyUrlIndex(d) {
    const src = d.sources?.url_index || {};
    if (src.state !== 'missing') return '';
    return `<div class="empty ri-empty" data-ri-empty="url_index">${icon('database')}<strong>No URL index yet</strong><span>Run <code>bbh agents/url_ingest.py ingest ${esc(d.program)} --source &lt;urls.txt&gt;</code> or <code>bbh agents/url_ingest.py aggregate ${esc(d.program)}</code>; it writes <code class="ri-path">${esc(src.expected || '')}</code>.</span>${copyBtn(isCopySafe(d.program) ? `bbh agents/url_ingest.py aggregate ${shellQuote(d.program)}` : null, 'Copy command', '', d.unsafe_chars)}</div>`;
  }
  function emptyJs(d) {
    const src = d.sources?.js || {};
    if (src.state !== 'missing' && !(src.state === 'error' && !src.result)) return '';
    const art = d.artifact_root || {};
    const where = (src.expected || []).map(e => `<li><span class="id">${esc(e.origin)}</span> <code class="ri-path">${esc(e.path)}</code></li>`).join('');
    const tier = !art.configured ? 'No artifact root is configured on this host, so JS libraries on the artifact tier are unavailable here.'
      : !art.available ? `The artifact root ${art.path} is not readable on this host, so its JS libraries are unavailable here.` : 'The artifact root is available but has no library for this lane.';
    return `<div class="empty ri-empty" data-ri-empty="js">${icon('file-code-o')}<strong>${src.state === 'error' ? `JS library: ${esc(errorText(src.error))}` : 'No JS library found'}</strong><span>${esc(tier)} Looked in:</span><ul class="ri-expected">${where}</ul><span>Produced by <code>bbh agents/js_analyzer.py</code> (skills js-pull / js-hunt).</span></div>`;
  }
  function depthHtml(d) {
    const u = res(d, 'url_index') || {}, j = res(d, 'js') || {}, agg = res(d, 'aggregates') || {}, b = res(d, 'board') || {};
    const tr = u.tests_recent || {};
    const findings = b.findings || null, cov = b.coverage || null;
    const sev = findings ? Object.entries(findings.by_severity || {}).sort((a, b2) => ui().severityRank(a[0]) - ui().severityRank(b2[0])) : [];
    const cls = findings ? Object.entries(findings.by_class || {}).slice(0, 8) : [];
    const aggItems = Object.entries(agg.files || {}).concat(Object.entries(agg.js_lists || {}).map(([k, v]) => ['js/' + k, v]));
    return `<section class="panel panel-pad ri-section" id="ri-depth" aria-label="Depth summary"><div class="blockhead"><h2>Depth summary</h2></div>
      ${sourceNote(d, 'url_index', 'URL index')}${emptyUrlIndex(d)}
      <div class="ri-stats" data-ri-depth>
        ${stat('URLs', u.urls)}${stat('Unique routes', u.routes)}${stat('Hosts', u.hosts)}${stat('Parameters', u.parameters)}
        ${stat('URLs with params', u.param_urls)}${stat('Tested URLs', u.tested_urls)}${stat('Tested params', u.tested_params)}
        ${stat('Test runs', u.test_runs, {sub: u.test_runs ? `${esc(tr.last_24h ?? 0)} in 24 h · ${esc(tr.last_7d ?? 0)} in 7 d` : ''})}
        ${stat('URL observations', u.observations)}
        ${stat('JS files', j.files)}${stat('JS bytes', j.bytes, {bytes: true})}${stat('Source maps', j.source_maps)}
        ${stat('JS observations', j.observations, {sub: metric(j.open_observations) ? `${esc(metric(j.open_observations))} open with a next action` : ''})}${stat('JS leads', j.leads)}
        ${stat('Findings', findings ? findings.total : null, {sub: findings?.archived ? `${esc(findings.archived)} archived not counted` : ''})}
        ${stat('Coverage questions', cov ? cov.questions : null, {sub: cov?.by_status?.bounded_review ? `${esc(cov.by_status.bounded_review)} bounded reviews` : ''})}
        ${stat('MapStore entries', b.map_entries ?? null)}
      </div>
      <div class="ri-split">
        <div><h3>Findings by severity</h3>${sev.length ? `<div class="ri-chips">${sev.map(([k, n]) => `${ui().severityBadge(k)} <span class="num">${esc(n)}</span>`).join(' ')}</div>` : '<p class="hint">No findings recorded for this lane.</p>'}
        ${cls.length ? `<h3>Top classes</h3><ul class="ri-bars">${cls.map(([k, n]) => bar(k, n, cls[0][1])).join('')}</ul>` : ''}</div>
        <div><h3>Recon aggregates</h3>${aggItems.length ? `<ul class="ri-kv">${aggItems.map(([k, v]) => `<li><code>${esc(k)}</code><span>${v.error ? `<span class="ri-err">${esc(errorText({code: v.error}))}</span>` : num(v)} lines</span></li>`).join('')}</ul>` : '<p class="hint">No recon/aggregated files. BBH <code>url_ingest.py aggregate</code> writes them.</p>'}</div>
      </div></section>`;
  }
  const bar = (label, n, max, extra = '') => `<li><span class="ri-bar-label">${esc(label)}</span><span class="ri-bar"><span style="width:${Math.max(2, Math.round(100 * n / (max || 1)))}%"></span></span><span class="num">${esc(fmtNum(n))}</span>${extra}</li>`;

  function hostsHtml(d) {
    const h = d.hosts || {rows: []};
    const s = view.state;
    const q = s.hq.toLowerCase();
    const valueOf = (row, key) => key === 'host' ? row.host : key === 'last_test' ? (Date.parse(row.last_test || '') || null) : row[key];
    let rows = h.rows.filter(r => (!q || String(r.host).toLowerCase().includes(q)) && (!s.under || r.under_tested));
    rows = sortRows(rows, s.hsort, s.hdir, valueOf);
    const under = h.rows.filter(r => r.under_tested).length;
    const th = (label, key) => sortTh(label, key, s.hsort, s.hdir, 'data-ri-hsort');
    const cell = (v, approxFlag, bytes) => v == null ? '<span class="muted">—</span>' : approxFlag ? `<span class="ri-approx" title="Sample estimate">≈${esc(bytes ? fmtBytes(v) : fmtNum(v))}</span>` : esc(bytes ? fmtBytes(v) : fmtNum(v));
    const body = rows.map(r => `<tr class="${r.under_tested ? 'ri-under' : ''}" data-ri-host="${esc(r.host)}">
      <td class="ri-host"><span class="ri-mono">${esc(r.host || '(no host)')}</span>${r.under_tested ? ` ${badge('Under-tested', 'warning')}` : ''}</td>
      <td class="num">${cell(r.urls, r.urls_approximate && !r.urls_exact)}</td><td class="num">${cell(r.routes, r.urls_approximate)}</td><td class="num">${cell(r.param_urls, r.urls_approximate)}</td>
      <td class="num">${cell(r.js_files)}</td><td class="num">${cell(r.js_bytes, false, true)}</td>
      <td class="num">${cell(r.test_runs)}</td><td class="num">${cell(r.tested_urls)}</td><td class="num">${cell(r.findings)}</td>
      <td class="num" title="${esc(r.coverage_questions)} coverage questions">${cell(r.coverage_reviewed)}</td>
      <td class="date">${isoWhen(r.last_test)}</td>
      <td class="ri-actions">${r.host ? copyBtn(bbhStatus(d.program, r.host), 'status', 'Copy bbh url_ingest status command for this host', r.unsafe_chars || d.unsafe_chars) : ''}</td></tr>`).join('');
    return `<section class="panel ri-section" id="ri-hosts" aria-label="Hosts"><div class="panel-head"><div><h2>Hosts</h2><p class="hint">Per host: URL index surface, JS library files, test runs, findings and coverage reviews. ${esc(h.rule || '')}</p></div></div>
      <div class="ri-toolbar panel-pad"><div class="input-icon">${icon('search')}<input id="ri-host-filter" type="search" aria-label="Filter hosts" placeholder="Filter hosts" value="${esc(s.hq)}" autocomplete="off"></div>
      <label class="ri-check"><input type="checkbox" id="ri-under"${s.under ? ' checked' : ''}> Under-tested only <span class="count">${esc(under)}</span></label>
      <span class="hint num" data-ri-host-count>${esc(rows.length)} of ${esc(h.total ?? h.rows.length)} hosts${h.truncated ? ` (top ${esc(h.rows.length)} by surface shown)` : ''}${h.urls_approximate ? ' · URL counts are sample estimates where marked ≈' : ''}</span></div>
      ${h.rows.length ? `<div class="table-wrap"><table class="ri-table ri-hosts"><thead><tr>${th('Host', 'host')}${th('URLs', 'urls')}${th('Routes', 'routes')}${th('Param URLs', 'param_urls')}${th('JS files', 'js_files')}${th('JS bytes', 'js_bytes')}${th('Test runs', 'test_runs')}${th('Tested URLs', 'tested_urls')}${th('Findings', 'findings')}${th('Reviewed', 'coverage_reviewed')}${th('Last test', 'last_test')}<th><span class="sr-only">Actions</span></th></tr></thead><tbody>${body || '<tr><td colspan="12"><div class="state">No hosts match these filters.</div></td></tr>'}</tbody></table></div>`
        : `<div class="state">${d.sources?.url_index?.state === 'computing' ? 'Computing hosts…' : 'No host data: the URL index and JS library have no hosts for this lane.'}</div>`}</section>`;
  }

  function evidenceCell(d, path) {
    if (!path) return '<span class="muted">—</span>';
    const lane = String(d.lane_path || '');
    let rel = String(path);
    if (rel.startsWith('/')) rel = lane && rel.startsWith(lane + '/') ? rel.slice(lane.length + 1) : null;
    if (rel && /^reports\/(?!.*(?:^|\/)\.\.?(?:\/|$)).+\.md$/.test(rel)) {
      return `<a class="link-button" href="${esc(ctx.hrefFor({program: d.family + '/' + d.program, lane: d.lane, section: 'reports', report: rel.slice('reports/'.length)}))}" title="Open in the Board">${icon('file-text-o')} ${esc(rel)}</a>`;
    }
    return `<code class="ri-path" title="${rel ? 'Inside the lane' : 'Outside this lane'}">${esc(path)}</code>`;
  }
  function lookedForHtml(d) {
    const det = res(d, 'url_index')?.detail || {};
    const groups = det.coverage_matrix || [];
    const lanes = [...new Set(groups.map(g => g.lane))].sort();
    const fams = [...new Set(groups.map(g => g.test_family))].sort();
    const cellOf = (lane, fam) => groups.filter(g => g.lane === lane && g.test_family === fam);
    const max = Math.max(1, ...groups.map(g => g.runs));
    const matrix = lanes.length ? `<div class="ri-scroll"><table class="ri-table ri-matrix" data-ri-matrix><thead><tr><th>Lane \\ test family</th>${fams.map(f => `<th class="num">${esc(f)}</th>`).join('')}<th class="num">Total</th></tr></thead><tbody>${lanes.map(lane => {
      const total = groups.filter(g => g.lane === lane).reduce((a, g) => a + g.runs, 0);
      return `<tr><th scope="row">${esc(lane)}</th>${fams.map(f => {
        const c = cellOf(lane, f); const runs = c.reduce((a, g) => a + g.runs, 0);
        if (!runs) return '<td class="num ri-cell-empty">·</td>';
        const last = c.map(g => g.last_run).sort().pop();
        const statuses = c.map(g => `${g.status}: ${g.runs}`).join(', ');
        const skills = [...new Set(c.map(g => g.skill))].join(', ');
        return `<td class="num ri-cell" style="--ri-heat:${(0.15 + 0.85 * runs / max).toFixed(2)}" title="${esc(`${runs} runs · ${statuses} · skills ${skills} · last ${last || 'unknown'}`)}">${esc(fmtNum(runs))}</td>`;
      }).join('')}<td class="num"><strong>${esc(fmtNum(total))}</strong></td></tr>`;
    }).join('')}</tbody></table></div>` : '';
    const detailRows = groups.slice().sort((a, b) => String(b.last_run || '').localeCompare(String(a.last_run || ''))).map(g => `<tr><td>${esc(g.lane)}</td><td>${esc(g.skill)}</td><td>${esc(g.test_family)}</td><td>${badge(g.status, statusKind(g.status))}</td><td class="num">${esc(g.runs)}</td><td class="num">${esc(g.urls)}</td><td class="num">${esc(g.last_24h)}</td><td class="num">${esc(g.last_7d)}</td><td class="date">${isoWhen(g.last_run)}</td></tr>`).join('');
    const recent = (det.recent_tests || []).map(t => `<tr><td class="date">${isoWhen(t.completed_at)}</td><td>${esc(t.lane)}<span class="id">${esc(t.skill)} / ${esc(t.test_family)}</span></td><td>${badge(t.status, statusKind(t.status))}</td><td>${esc(t.agent_id || '—')}</td><td class="ri-url">${t.url ? ext(t.url, null, t.unsafe_chars) : '<span class="muted">—</span>'}${t.param_key ? `<span class="id">param ${esc(t.param_key)}</span>` : ''}</td><td><span class="ri-notes" title="${esc(t.notes || t.response_summary || '')}">${esc(t.notes || t.response_summary || '')}</span></td><td>${evidenceCell(d, t.evidence_path)}</td></tr>`).join('');
    const obs = (det.recent_observations || []).map(o => `<tr><td class="date">${isoWhen(o.created_at)}</td><td>${esc(o.lane)}</td><td>${badge(o.status, statusKind(o.status))}</td><td>${esc(o.agent_id || '—')}</td><td class="ri-url">${o.url ? ext(o.url, null, o.unsafe_chars) : '<span class="muted">—</span>'}</td><td><span class="ri-notes" title="${esc(o.notes || '')}">${esc(o.notes || '')}</span></td><td>${evidenceCell(d, o.evidence_path)}</td></tr>`).join('');
    const none = d.sources?.url_index?.state === 'ready' && !groups.length;
    return `<section class="panel panel-pad ri-section" id="ri-looked" aria-label="What has been looked for"><div class="blockhead"><h2>What has been looked for</h2></div>
      <p class="hint">Test runs recorded in the URL index (<code>url_ingest.py mark</code>), by lane and test family. Hover a cell for statuses, skills and the last run.</p>
      ${none ? `<div class="empty" data-ri-empty="tests">${icon('flask')}<strong>No test runs recorded</strong><span>Agents record them with <code>bbh agents/url_ingest.py mark ${esc(d.program)} --url &lt;url&gt; --lane &lt;lane&gt; --status &lt;status&gt; --skill &lt;skill&gt; --test-family &lt;family&gt;</code>.</span></div>` : ''}
      ${matrix}
      ${detailRows ? `<details class="ri-details"><summary>By lane, skill, family and status (${esc(groups.length)})</summary><div class="ri-scroll"><table class="ri-table"><thead><tr><th>Lane</th><th>Skill</th><th>Test family</th><th>Status</th><th class="num">Runs</th><th class="num">URLs</th><th class="num">24 h</th><th class="num">7 d</th><th class="date">Last run</th></tr></thead><tbody>${detailRows}</tbody></table></div></details>` : ''}
      ${recent ? `<h3>Recent test runs</h3><div class="ri-scroll"><table class="ri-table ri-recent" data-ri-recent><thead><tr><th class="date">When</th><th>Lane / skill</th><th>Status</th><th>Agent</th><th>URL</th><th>Notes</th><th>Evidence</th></tr></thead><tbody>${recent}</tbody></table></div>` : ''}
      ${obs ? `<h3>Recent observations</h3><div class="ri-scroll"><table class="ri-table ri-recent"><thead><tr><th class="date">When</th><th>Lane</th><th>Status</th><th>Agent</th><th>URL</th><th>Notes</th><th>Evidence</th></tr></thead><tbody>${obs}</tbody></table></div>` : ''}
    </section>`;
  }

  function huntHtml(d) {
    const det = res(d, 'url_index')?.detail || {};
    const jsd = res(d, 'js')?.detail || {};
    const s = view.state;
    const params = det.untested_params || [];
    const hints = [...new Set(params.flatMap(p => p.untested_lanes || []))].sort();
    const shown = params.filter(p => !s.hint || (p.untested_lanes || []).includes(s.hint));
    const lane = s.hint;
    const paramItems = shown.slice(0, 60).map(p => {
      const target = lane || p.untested_lanes[0];
      return `<li class="ri-hunt-item" data-ri-hunt="param" data-param="${esc(p.param_key)}"><div class="ri-hunt-main"><strong class="ri-mono">${esc(p.param_key)}</strong> ${(p.untested_lanes || []).map(h => badge(h, 'warning')).join(' ')}
        <span class="hint">${esc(p.location || 'query')}${p.value_shape ? ` · ${esc(p.value_shape)}` : ''} · seen ${esc(p.observations_capped ? '1000+' : p.observations)}×</span>
        ${p.example_url ? `<div class="ri-url">${ext(p.example_url, null, p.unsafe_chars)}</div>` : ''}</div>
        <div class="ri-hunt-actions">${p.example_url ? copyBtn(p.example_url, 'URL', '', p.unsafe_chars) + copyBtn(curlCommand(p.example_url), 'curl', 'Copy a curl command for the example URL', p.unsafe_chars) : ''}${copyBtn(bbhNext(d.program, target, p.param_key), 'bbh next', `Copy bbh url_ingest next for lane ${target}`, p.unsafe_chars || d.unsafe_chars)}</div></li>`;
    }).join('');
    const hosts = (d.hosts?.rows || []).filter(r => r.under_tested).slice(0, 10).map(r => `<li class="ri-hunt-item" data-ri-hunt="host"><div class="ri-hunt-main"><strong class="ri-mono">${esc(r.host)}</strong> <span class="hint">${r.urls != null ? `${r.urls_approximate && !r.urls_exact ? '≈' : ''}${esc(fmtNum(r.urls))} URLs · ` : ''}${esc(r.js_files)} JS files · ${esc(r.test_runs)} test runs</span></div><div class="ri-hunt-actions">${copyBtn(r.host, 'host', '', r.unsafe_chars)}${copyBtn(bbhStatus(d.program, r.host), 'bbh status', '', r.unsafe_chars || d.unsafe_chars)}</div></li>`).join('');
    const jsOpen = (jsd.open_observations || []).slice(0, 20).map(o => `<li class="ri-hunt-item" data-ri-hunt="js"><div class="ri-hunt-main"><strong>${esc(o.title || 'Observation')}</strong> ${badge(o.lens || 'lens', 'accent')} ${badge(o.status || 'open', statusKind(o.status))} ${o.confidence ? `<span class="hint">confidence ${esc(o.confidence)}</span>` : ''}
        <div class="ri-next">${icon('arrow-right')} ${esc(o.next_action)}</div>${o.js_url ? `<div class="ri-url">${ext(o.js_url, null, o.unsafe_chars)}</div>` : ''}</div><div class="ri-hunt-actions">${o.js_url ? copyBtn(o.js_url, 'URL', '', o.unsafe_chars) : ''}${copyBtn(o.next_action, 'next action', '', o.unsafe_chars)}</div></li>`).join('');
    const leads = (jsd.leads || []).slice(0, 20).map(l => `<li class="ri-hunt-item" data-ri-hunt="lead"><div class="ri-hunt-main"><strong>${esc(l.related_endpoint || l.lead_id || 'Lead')}</strong> ${l.lane ? badge(l.lane, 'warning') : ''} ${l.confidence ? `<span class="hint">confidence ${esc(l.confidence)}</span>` : ''}<div class="ri-next">${icon('arrow-right')} ${esc(l.next_action || '')}</div>${l.js_url ? `<div class="ri-url">${ext(l.js_url, null, l.unsafe_chars)}</div>` : ''}</div><div class="ri-hunt-actions">${l.js_url ? copyBtn(l.js_url, 'URL', '', l.unsafe_chars) : ''}</div></li>`).join('');
    const hintBar = hints.length ? `<div class="segmented ri-hints" role="group" aria-label="Filter by lane hint"><button type="button" data-ri-hint="" aria-pressed="${!s.hint}">All</button>${hints.map(h => `<button type="button" data-ri-hint="${esc(h)}" aria-pressed="${s.hint === h}">${esc(h)}</button>`).join('')}</div>` : '';
    return `<section class="panel panel-pad ri-section" id="ri-hunt" aria-label="What to hunt next"><div class="blockhead"><h2>What to hunt next</h2></div>
      <p class="hint">Suggestions only: copy a URL or command and run it yourself. Nothing here sends a request.</p>
      <div class="ri-hunt-grid">
        <div><h3>Hinted parameters without a test in that lane <span class="count">${esc(params.length)}</span></h3>${hintBar}
          ${paramItems ? `<ul class="ri-hunt">${paramItems}</ul>${shown.length > 60 ? `<p class="hint">Showing 60 of ${esc(shown.length)}.</p>` : ''}` : `<p class="hint">${d.sources?.url_index?.state === 'computing' ? 'Computing…' : params.length ? 'No parameters for this lane hint.' : 'No hinted parameters without tests. Parameter hints come from url_ingest.py parameter observations.'}</p>`}</div>
        <div><h3>Surface or JS without tests <span class="count">${esc((d.hosts?.rows || []).filter(r => r.under_tested).length)}</span></h3>${hosts ? `<ul class="ri-hunt">${hosts}</ul>` : '<p class="hint">No under-tested hosts.</p>'}
          <h3>Open JS observations and leads <span class="count">${esc((jsd.open_observations || []).length + (jsd.leads || []).length)}</span></h3>${jsOpen || leads ? `<ul class="ri-hunt">${jsOpen}${leads}</ul>` : `<p class="hint">${res(d, 'js') ? 'No JS observations with an open next action.' : 'No JS library for this lane.'}</p>`}</div>
      </div></section>`;
  }

  function jsHtml(d) {
    const j = res(d, 'js');
    const jsd = j?.detail || {};
    const empty = emptyJs(d);
    const hostMax = Math.max(1, ...(jsd.hosts || []).map(h => h.bytes || 0));
    const hosts = (jsd.hosts || []).slice(0, 15).map(h => `<tr><td class="ri-mono">${esc(h.host || '(no host)')}</td><td class="num">${esc(fmtNum(h.files))}</td><td class="num">${esc(fmtBytes(h.bytes))}<span class="ri-bar ri-bar-inline"><span style="width:${Math.max(2, Math.round(100 * (h.bytes || 0) / hostMax))}%"></span></span></td><td class="num">${esc(fmtNum(h.source_maps))}</td></tr>`).join('');
    const sigMax = Math.max(1, ...(jsd.signals || []).map(x => x.count));
    const signals = (jsd.signals || []).slice(0, 16).map(x => bar(x.signal, x.count, sigMax, `<span class="hint">${esc(fmtNum(x.files))} files</span>`)).join('');
    const maps = (jsd.source_map_files || []).slice(0, 15).map(f => `<li><span class="ri-url">${f.js_url ? ext(f.js_url, null, f.unsafe_chars) : `<span class="ri-mono">${esc(String(f.sha256 || '').slice(0, 16))}</span>`}</span><span class="hint">${esc(fmtBytes(f.bytes))} · map ${f.source_map ? ext(f.source_map, 'link', f.unsafe_chars) : ''}</span></li>`).join('');
    const lens = (jsd.lens_counts || []).slice(0, 12).map(l => `<li><span>${badge(l.lens || '—', 'accent')} ${badge(l.status || '—', statusKind(l.status))}</span><span class="num">${esc(l.count)}</span></li>`).join('');
    const obs = (jsd.recent_observations || []).slice(0, 15).map(o => `<tr><td class="date">${isoWhen(o.updated_at || o.created_at)}</td><td>${badge(o.lens || '—', 'accent')}</td><td>${badge(o.status || '—', statusKind(o.status))}</td><td>${esc(o.confidence || '—')}</td><td><strong>${esc(o.title || '')}</strong>${o.summary ? `<span class="ri-notes">${esc(o.summary)}</span>` : ''}</td><td class="ri-url">${o.js_url ? ext(o.js_url) : ''}</td></tr>`).join('');
    return `<section class="panel panel-pad ri-section" id="ri-js" aria-label="JavaScript"><div class="blockhead"><h2>JavaScript</h2>${d.sources?.js?.origin ? `<span class="badge outline" title="Where the JS library was read from">${esc(d.sources.js.origin === 'artifact' ? 'artifact tier' : 'Shared lane')}</span>` : ''}</div>
      ${sourceNote(d, 'js', 'JS library')}${empty}
      ${j ? `<div class="ri-split"><div><h3>Top hosts by JS</h3>${hosts ? `<div class="ri-scroll"><table class="ri-table" data-ri-js-hosts><thead><tr><th>Host</th><th class="num">Files</th><th class="num">Bytes</th><th class="num">Maps</th></tr></thead><tbody>${hosts}</tbody></table></div>` : '<p class="hint">No JS files.</p>'}</div>
        <div><h3>Signals across files</h3>${signals ? `<ul class="ri-bars" data-ri-signals>${signals}</ul>${jsd.signals_capped ? '<p class="hint">≈ first 50,000 files only.</p>' : ''}` : '<p class="hint">No signal counts recorded.</p>'}</div></div>
        <div class="ri-split"><div><h3>Files with source maps <span class="count">${esc(metric(j.source_maps) ?? 0)}</span></h3>${maps ? `<ul class="ri-list">${maps}</ul>` : '<p class="hint">No source maps recorded.</p>'}</div>
        <div><h3>Observations by lens and status</h3>${lens ? `<ul class="ri-kv">${lens}</ul>` : '<p class="hint">No JS observations.</p>'}</div></div>
        ${obs ? `<h3>Latest JS observations</h3><div class="ri-scroll"><table class="ri-table"><thead><tr><th class="date">Updated</th><th>Lens</th><th>Status</th><th>Confidence</th><th>Observation</th><th>JS URL</th></tr></thead><tbody>${obs}</tbody></table></div>` : ''}` : ''}
    </section>`;
  }

  function programHtml() {
    const d = view.program;
    if (!d) return view.error ? '' : '<div class="state">Loading recon intel…</div>';
    return `<nav class="ri-jump" aria-label="Recon sections"><a href="#ri-depth" data-ri-jump="ri-depth">Depth</a><a href="#ri-hosts" data-ri-jump="ri-hosts">Hosts</a><a href="#ri-looked" data-ri-jump="ri-looked">Looked for</a><a href="#ri-hunt" data-ri-jump="ri-hunt">Hunt next</a><a href="#ri-js" data-ri-jump="ri-js">JavaScript</a></nav>
      ${depthHtml(d)}${hostsHtml(d)}${lookedForHtml(d)}${huntHtml(d)}${jsHtml(d)}
      <p class="footnote">Read-only view over BBH stores. Counts from large stores are estimates where marked ≈ (MAX(id) for table sizes, rowid-window samples for distributions); "unique routes" counts distinct paths across hosts. Budget ${esc(d.budget?.query_seconds)} s per query.</p>`;
  }

  // ---- frame ---------------------------------------------------------------
  function controlsHtml() {
    const s = view.state;
    const web = ctx.programs().filter(p => p.family === 'web_bounty');
    const options = web.flatMap(p => (p.lanes || []).map(l => {
      const value = `${p.id}|${l.name}`;
      return `<option value="${esc(value)}"${s.p === String(p.id) && (s.lane || laneFor(s.p)) === String(l.name) ? ' selected' : ''}>${esc(p.name)} / ${esc(l.name)}</option>`;
    })).join('');
    return `<div class="ri-controls">
      <label class="ri-picker"><span class="sr-only">Program</span><select id="ri-program" aria-label="Recon program"><option value=""${s.p ? '' : ' selected'}>All programs (overview)</option>${options}</select></label>
      ${s.p ? `<a class="button sm ghost" href="${esc(href({}))}" data-ri-all>${icon('angle-left')}<span>All programs</span></a>` : `<div class="input-icon ri-filter">${icon('search')}<input id="ri-filter" type="search" aria-label="Filter programs" placeholder="Filter programs" value="${esc(s.q)}" autocomplete="off"></div>`}
      <button type="button" class="button sm" data-ri-refresh>${icon('refresh')}<span>Refresh</span></button></div>`;
  }
  function statusHtml() {
    const s = view.state;
    const d = s.p ? view.program : view.overview;
    const bits = [];
    if (d) {
      bits.push(`Updated ${new Date(d.computed_at * 1000).toLocaleTimeString()}`);
      if (d.partial) bits.push(`<span class="ri-computing">${icon('circle-o-notch fa-spin')} computing… partial results shown</span>`);
      const art = d.artifact_root;
      if (art && !art.available) bits.push(`<span class="hint" data-ri-artifact>${esc(art.message || 'Artifact root unavailable')}</span>`);
      if (!s.p && d.programs?.some(r => r.approximate)) bits.push('<span class="ri-approx">≈ marks approximate values</span>');
    }
    if (view.loading && !d) bits.push('Loading');
    return `${bits.join(' · ')}${view.error ? ` <span class="ri-err" role="alert">${esc(view.error)}</span>` : ''}`;
  }
  function paintStatus() { const box = ctx.app.querySelector('[data-ri-status]'); if (box) box.innerHTML = statusHtml(); }
  function paint() {
    const host = ctx.app.querySelector('#recon-intel-host');
    if (!host) return;
    paintStatus();
    const box = host.querySelector('[data-ri-body]');
    if (!box) return;
    const active = document.activeElement;
    const keep = active && host.contains(active) && active.id ? {id: active.id, start: active.selectionStart, end: active.selectionEnd} : null;
    box.innerHTML = view.state.p ? programHtml() : overviewHtml();
    if (keep) { const el = host.querySelector('#' + CSS.escape(keep.id)); if (el) { el.focus({preventScroll: true}); try { if (keep.start != null) el.setSelectionRange(keep.start, keep.end); } catch {} } }
  }
  function mountView(host) {
    const linked = parseQuery(ctx.state.reconQuery || '');
    const changed = buildQuery(linked) !== buildQuery(view.state);
    view.state = linked;
    if (view.state.p && !ctx.programs().some(p => String(p.id) === view.state.p)) { view.error = 'The linked program was not found in this Board root.'; }
    writeUrl();
    host.innerHTML = `<section class="panel ri-panel" aria-label="Recon intel"><div class="panel-pad" data-ri-controls>${controlsHtml()}</div><p class="hint ri-status" data-ri-status role="status">${statusHtml()}</p></section><div class="ri-body" data-ri-body></div>`;
    host.onclick = onClick; host.onchange = onChange; host.oninput = onInput;
    paint();
    const key = view.state.p ? `${view.state.p}|${view.state.lane || laneFor(view.state.p)}` : '';
    const have = view.state.p ? view.program && view.programKey === key : view.overview && Date.now() - view.overviewAt < 10000;
    if (changed || !have) { if (view.state.p && view.programKey !== key) view.program = null; view.polls = 0; load(); }
  }
  function go(next, push = true) {
    view.state = {...view.state, ...next};
    writeUrl(push);
    const host = ctx.app.querySelector('#recon-intel-host');
    if (host) { host.querySelector('[data-ri-controls]').innerHTML = controlsHtml(); }
  }
  function onClick(event) {
    const copy = event.target.closest('[data-ri-copy]');
    if (copy) { copyText(copy.dataset.riCopy); return; }
    const jump = event.target.closest('[data-ri-jump]');
    if (jump && event.button === 0 && !event.metaKey && !event.ctrlKey) { event.preventDefault(); ctx.app.querySelector('#' + CSS.escape(jump.dataset.riJump))?.scrollIntoView({block: 'start', behavior: 'smooth'}); return; }
    const t = event.target.closest('button'); if (!t) return;
    if (t.dataset.riSort) { const k = t.dataset.riSort; go({sort: k, dir: view.state.sort === k && view.state.dir === 'desc' ? 'asc' : 'desc'}, false); paint(); }
    else if (t.dataset.riHsort) { const k = t.dataset.riHsort; go({hsort: k, hdir: view.state.hsort === k && view.state.hdir === 'desc' ? 'asc' : 'desc'}, false); paint(); }
    else if (t.dataset.riHint != null) { go({hint: t.dataset.riHint}, false); paint(); }
    else if (t.hasAttribute('data-ri-refresh')) { view.polls = 0; load({refresh: true}); }
  }
  function onChange(event) {
    if (event.target.id === 'ri-program') {
      const [p, lane] = event.target.value ? event.target.value.split('|') : ['', ''];
      go({...DEFAULTS, p, lane}, true); view.program = null; view.polls = 0; paint(); load();
    } else if (event.target.id === 'ri-under') { go({under: event.target.checked}, false); paint(); }
  }
  function onInput(event) {
    const id = event.target.id;
    if (id !== 'ri-filter' && id !== 'ri-host-filter') return;
    view.state[id === 'ri-filter' ? 'q' : 'hq'] = clean(event.target.value).slice(0, 200);
    clearTimeout(view.qTimer);
    view.qTimer = setTimeout(() => { writeUrl(); paint(); }, 150);
  }
  async function copyText(value) {
    if (!isCopySafe(value)) { ui().toast('Not copied: the value contains control characters.', 'warning'); return; }
    try { await navigator.clipboard.writeText(value); ui().toast('Copied to the clipboard.', 'success'); return; } catch {}
    const area = document.createElement('textarea');
    area.value = value; area.setAttribute('readonly', ''); area.style.position = 'fixed'; area.style.opacity = '0';
    document.body.append(area); area.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch {}
    area.remove();
    ui().toast(ok ? 'Copied to the clipboard.' : 'Copy is unavailable in this browser.', ok ? 'success' : 'warning');
  }

  // ---- dashboard card ------------------------------------------------------
  function cardHtml() {
    const d = card.data;
    const head = `<div class="panel-head"><div><h2>Recon depth</h2><p class="hint">URL index, JS library and tests across web programs${d?.partial ? '; computing…' : ''}.</p></div><a class="button sm" href="${esc(href({}))}">${icon('crosshairs')}<span>Open recon intel</span></a></div>`;
    if (!d) return `<section class="panel ri-card" aria-label="Recon depth">${head}<div class="state">Loading recon intel…</div></section>`;
    const rows = d.programs || [];
    const sum = key => rows.reduce((a, r) => a + (metric(r[key]) || 0), 0);
    const anyApprox = rows.some(r => approx(r.urls));
    const withIndex = rows.filter(r => metric(r.urls) != null).length;
    const top = rows.filter(r => metric(r.urls) != null || metric(r.js_files) != null).sort((a, b) => depthGap(b) - depthGap(a)).slice(0, 5);
    const list = top.map(r => `<li data-ri-card-row><a class="ri-program-link" href="${esc(href({p: r.id, lane: r.lane}))}">${esc(r.program)}</a> <span class="id">${esc(r.lane)}</span><span class="ri-card-meta">${num(r.urls)} URLs · ${num(r.js_files)} JS · ${num(r.test_runs)} tests</span></li>`).join('');
    return `<section class="panel ri-card" aria-label="Recon depth">${head}<div class="ri-card-stats">
      <div><strong>${anyApprox ? '≈' : ''}${esc(fmtNum(sum('urls')))}</strong><span>URLs in ${esc(withIndex)} indexes</span></div>
      <div><strong>${esc(fmtNum(sum('js_files')))}</strong><span>JS files (${esc(fmtBytes(sum('js_bytes')))})</span></div>
      <div><strong>${esc(fmtNum(sum('tested_urls')))}</strong><span>tested URLs</span></div>
      <div><strong>${esc(fmtNum(rows.reduce((a, r) => a + (r.tests_recent?.last_7d || 0), 0)))}</strong><span>test runs in 7 days</span></div></div>
      ${list ? `<h3 class="ri-card-h">Most surface per test run</h3><ul class="ri-card-list">${list}</ul>` : `<div class="state">${d.partial ? 'Computing…' : 'No URL index or JS library found yet.'}</div>`}
      ${!d.artifact_root?.available ? `<p class="hint ri-card-foot">${esc(d.artifact_root?.message || '')}</p>` : ''}</section>`;
  }
  async function loadCard() {
    const mine = ++card.seq;
    card.loading = true;
    try {
      const body = await getJson('/api/recon/overview');
      if (mine !== card.seq) return;
      card.data = body; card.at = Date.now();
      if (body.partial) card.timer = setTimeout(() => { if (ctx.app.querySelector('#dashboard-recon-host')) loadCard(); }, 2000);
    } catch { if (mine === card.seq && !card.data) card.data = null; }
    finally { if (mine === card.seq) { card.loading = false; paintCard(); } }
  }
  function paintCard() { const host = ctx.app.querySelector('#dashboard-recon-host'); if (host) host.innerHTML = cardHtml(); }
  function mountCard() {
    const grid = ctx.app.querySelector('.dashboard-grid');
    if (!grid) return;
    let host = grid.querySelector('#dashboard-recon-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'dashboard-recon-host'; host.className = 'wide';
      const recent = grid.querySelector('#dashboard-recent-host');
      if (recent) recent.after(host); else grid.prepend(host);
    }
    host.innerHTML = cardHtml();
    if ((card.data && Date.now() - card.at < 30000) || card.loading || card.timer) return;
    // Never delay the dashboard's first paint: fetch once the workspace has settled.
    const attempt = () => {
      card.timer = 0;
      if (!ctx.app.querySelector('#dashboard-recon-host')) { card.waited = 0; return; }
      const busy = ctx.state.loading || ctx.state.data?.reports_loading === true || ctx.state.data?._portfolioLoading;
      if (busy && card.waited < 4000) { card.waited += 250; card.timer = setTimeout(attempt, 250); return; }
      card.waited = 0; loadCard();
    };
    card.timer = setTimeout(attempt, 0);
  }

  setInterval(() => {
    if (!ctx || document.visibilityState !== 'visible') return;
    if (ctx.app.querySelector('#recon-intel-host') && !view.loading && !view.timer) load({quiet: true});
  }, 60000);

  window.registerBoardModule({
    name: 'recon-intel',
    afterRender(context) {
      ctx = context;
      if (!ctx.state.data || ctx.state.loading) return;
      const host = ctx.app.querySelector('#recon-intel-host');
      if (host) mountView(host);
      else { clearTimeout(view.timer); view.timer = 0; }
      if (ctx.state.view === 'dashboard') mountCard();
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
