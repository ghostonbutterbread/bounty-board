/* Recon URL browser: the URLs behind the Recon view's numbers.
 * Data: GET /api/recon/urls (keyset pages by id) and GET /api/recon/url (one URL's
 * test runs and observations). Writes: POST /api/recon/mark, which runs BBH
 * url_ingest.py mark; shown only when the backend enables that writer.
 *
 * recon-intel.js owns the #/recon hash (filters live there, so a filtered list
 * can be bookmarked) and renders the section frame; this module fills it:
 * BoardReconUrls.update(node, opts) with opts = {ctx, program, programName, lane,
 * filters, cursor, hrefWith(filters, cursor), canMark, markOff}. filters.order 'asc' lists oldest first; the default is newest first. State (rows, the
 * open history rows, the selection and a running bulk mark) lives here, so the
 * view's periodic repaints never lose it.
 * Target data: URLs and hosts are escaped; nothing is fetched from a target;
 * links to a URL open in a new tab with rel="noopener noreferrer" and only for
 * values without control characters (unsafe_chars). */
(function (root) {
  'use strict';
  const STATUSES = ['untested', 'tested', 'discovered', 'surface_reviewed', 'deep_reviewed', 'validated_signal', 'dismissed'];
  const MARK_STATUSES = STATUSES.slice(2);
  const LANES = ['recon', 'xss', 'sqli', 'ssrf', 'idor', 'lfi', 'access-control', 'ssti', 'open-redirect', 'xxe', 'race', 'csrf'];
  const LOCATIONS = ['query', 'body', 'header', 'cookie', 'path', 'json'];
  const PAGE = 50;
  const BULK_MAX = 100;
  const STATUS_LABEL = {untested: 'Untested', tested: 'Tested', discovered: 'Discovered', surface_reviewed: 'Surface reviewed',
    deep_reviewed: 'Deep reviewed', validated_signal: 'Validated signal', dismissed: 'Dismissed'};
  const STATUS_KIND = {validated_signal: 'danger', deep_reviewed: 'success', surface_reviewed: 'accent', dismissed: 'outline', discovered: ''};
  const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\u2028\u2029\ufeff]/;

  // ---- pure helpers (exported for Node tests) --------------------------------
  const EMPTY = {host: '', q: '', lane: '', status: '', params: false, param: '', order: ''};
  function cleanFilters(f) {
    const text = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, n);
    const out = {host: text(f?.host, 300).trim(), q: text(f?.q, 300), lane: '', status: '', params: f?.params === true || f?.params === '1', param: text(f?.param, 200).trim(),
      order: f?.order === 'asc' ? 'asc' : ''};
    if (/^[a-z][a-z0-9-]{0,39}$/.test(String(f?.lane || ''))) out.lane = f.lane;
    if (STATUSES.includes(f?.status)) out.status = f.status;
    return out;
  }
  // Keyset cursor: ids below it (newest first, the default) or above it (filters.order 'asc').
  function apiQuery(program, lane, filters, cursor = 0, limit = PAGE) {
    const f = cleanFilters(filters);
    const params = new URLSearchParams({family: 'web_bounty', program, lane});
    if (f.host) params.set('host', f.host);
    if (f.q) params.set('q', f.q);
    if (f.lane) params.set('test_lane', f.lane);
    if (f.status) params.set('status', f.status);
    if (f.params) params.set('params', '1');
    if (f.param) params.set('param', f.param);
    params.set('order', f.order === 'asc' ? 'asc' : 'desc');
    if (cursor > 0) params.set('cursor', String(cursor));
    params.set('limit', String(limit));
    return params.toString();
  }
  const sameFilters = (a, b) => JSON.stringify(cleanFilters(a)) === JSON.stringify(cleanFilters(b));
  // Mark request body; null when the row cannot be marked from the Board.
  function markBody({program, lane, rootInstance, row, testLane, status, param, location, notes}) {
    if (!row || row.unsafe_chars || UNSAFE.test(String(row.url)) || lane !== 'web') return null;
    if (!LANES.includes(testLane) || !MARK_STATUSES.includes(status)) return null;
    const body = {family: 'web_bounty', program, lane, root_instance: rootInstance, url_id: row.id, url: row.url, test_lane: testLane, status};
    const p = String(param || '').trim(), n = String(notes || '').trim();
    if (p) { if (UNSAFE.test(p) || p.length > 120) return null; body.param = p; body.param_location = LOCATIONS.includes(location) ? location : 'query'; }
    if (n) { if (UNSAFE.test(n) || n.length > 500) return null; body.notes = n; }
    return body;
  }
  // Why a row has no Mark button (null when it can be marked).
  function markRefusal(row, lane, canMark) {
    if (!canMark) return 'off';
    if (lane !== 'web') return 'BBH marks only the web lane.';
    if (row.unsafe_chars) return 'Contains control characters.';
    return null;
  }
  const helpers = {STATUSES, MARK_STATUSES, LANES, LOCATIONS, BULK_MAX, EMPTY, cleanFilters, apiQuery, sameFilters, markBody, markRefusal};
  if (typeof module === 'object' && module.exports) { module.exports = helpers; return; }

  // ---- DOM ------------------------------------------------------------------------
  const st = {key: '', opts: null, node: null, page: null, loading: false, error: '', seq: 0,
    open: new Map(), history: new Map(), selected: new Set(), results: new Map(), bulk: null, prev: []};
  let ctx = null;
  const esc = v => ctx.esc(v);
  const icon = name => `<i class="fa fa-${name}" aria-hidden="true"></i>`;
  const ui = () => ctx.ui || window.BoardUI;
  const isoWhen = iso => {
    const t = Date.parse(iso || '');
    return Number.isFinite(t) ? `<time datetime="${esc(new Date(t).toISOString())}" title="${esc(new Date(t).toISOString())}">${esc(ui().relativeTime(t / 1000))}</time>` : '<span class="muted">-</span>';
  };
  const statusBadge = status => `<span class="badge ${STATUS_KIND[status] ?? ''}">${esc(STATUS_LABEL[status] || status || 'unknown')}</span>`;
  const keyOf = o => JSON.stringify([o.program, o.lane, cleanFilters(o.filters), o.cursor || 0]);

  async function fetchPage() {
    const mine = ++st.seq, o = st.opts;
    st.loading = true; paint();
    try {
      const response = await fetch(`/api/recon/urls?${apiQuery(o.programName, o.lane, o.filters, o.cursor)}`, {cache: 'no-store'});
      const body = await response.json().catch(() => ({}));
      if (mine !== st.seq) return;
      if (response.status === 503) { st.error = 'Another URL query is running. Retrying.'; setTimeout(() => { if (mine === st.seq) fetchPage(); }, 1200); return; }
      if (!response.ok) { st.error = 'The URL list is unavailable.'; st.page = null; return; }
      st.page = body; st.error = body.error ? errorText(body) : '';
    } catch {
      if (mine === st.seq) { st.error = 'The URL list is unavailable.'; }
    } finally {
      if (mine === st.seq) { st.loading = false; paint(); }
    }
  }
  function errorText(body) {
    const code = body.error?.code;
    if (code === 'missing') return `No URL index yet at ${body.expected || 'recon/url_index/url_index.sqlite'}. BBH url_ingest.py ingest or aggregate creates it.`;
    if (code === 'timeout') return 'The query exceeded the time budget. Narrow the filters.';
    if (code === 'locked') return 'The URL index is locked by a writer. Try again shortly.';
    return `The URL index is unavailable (${code || 'error'}).`;
  }

  function filtersHtml(o) {
    const f = cleanFilters(o.filters);
    const lanes = [...new Set([...LANES, ...(f.lane ? [f.lane] : [])])];
    return `<form class="ru-filters" data-ru-filters onsubmit="return false">
      <label>Host<input name="host" type="search" value="${esc(f.host)}" placeholder="any host" autocomplete="off" spellcheck="false"></label>
      <label class="ru-grow">Text in URL<input name="q" type="search" value="${esc(f.q)}" placeholder="path, query or host text" autocomplete="off" spellcheck="false"></label>
      <label>Lane<select name="lane"><option value="">Any lane</option>${lanes.map(l => `<option value="${esc(l)}"${l === f.lane ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
      <label>Status<select name="status"><option value="">Any status</option>${STATUSES.map(s => `<option value="${s}"${s === f.status ? ' selected' : ''}>${esc(STATUS_LABEL[s])}</option>`).join('')}</select></label>
      <label>Parameter<input name="param" type="search" value="${esc(f.param)}" placeholder="name" autocomplete="off" spellcheck="false"></label>
      <label class="ru-check"><input name="params" type="checkbox"${f.params ? ' checked' : ''}> Has parameters</label>
      <label class="ru-check"><input name="order" type="checkbox"${f.order === 'asc' ? ' checked' : ''}> Oldest first</label>
      ${Object.entries(f).some(([k, v]) => k !== 'order' && v) ? `<a class="link-button" href="${esc(o.hrefWith({...EMPTY, order: f.order}, 0))}" data-ru-clear>Clear filters</a>` : ''}
    </form>`;
  }
  function statusLine(o) {
    const p = st.page;
    if (st.loading && !p) return 'Loading URLs…';
    const bits = [];
    if (p && !p.error) {
      const n = p.items.length;
      const oldest = cleanFilters(o.filters).order === 'asc';
      bits.push(n ? `Showing ${n} ${n === 1 ? 'URL' : 'URLs'}, ${oldest ? 'oldest' : 'newest'} first${o.cursor ? `, ${oldest ? 'after' : 'before'} id ${o.cursor}` : ''}` : (p.done ? 'No URLs match' : 'No matches in this stretch yet'));
      if (!p.done && p.partial) bits.push(`searched ${oldest ? 'up' : 'down'} to id ${p.next} of ${p.max_id}; use Next to keep searching`);
      if (st.loading) bits.push('updating');
    }
    return `${esc(bits.join(' · '))}${st.error ? ` <span class="ri-err" role="alert">${esc(st.error)}</span>` : ''}`;
  }
  function laneCell(row) {
    if (!row.lanes.length) return '<span class="hint">No status</span>';
    return row.lanes.slice(0, 6).map(l => `<span class="ru-lane" title="${esc(`${l.lane}${l.param_key ? ` param ${l.param_key}` : ''}: ${STATUS_LABEL[l.status] || l.status}${l.at ? `, ${l.at}` : ''}`)}"><span class="ru-lane-name">${esc(l.lane)}${l.param_key ? `<span class="ru-param">${esc(l.param_key)}</span>` : ''}</span>${statusBadge(l.status)}</span>`).join('') + (row.lanes.length > 6 ? `<span class="hint">+${row.lanes.length - 6}</span>` : '');
  }
  function rowHtml(row, o) {
    const open = st.open.has(row.id), refusal = markRefusal(row, o.lane, o.canMark), result = st.results.get(row.id);
    const href = !row.unsafe_chars && /^https?:\/\//i.test(row.url) ? row.url : null;
    const select = o.canMark ? `<td class="ru-select">${refusal ? '' : `<input type="checkbox" class="ru-row-select" data-ru-select="${row.id}" aria-label="Select ${esc(row.path)}"${st.selected.has(row.id) ? ' checked' : ''}>`}</td>` : '';
    return `<tr data-ru-row="${row.id}" class="${open ? 'is-open' : ''}${result?.ok === false ? ' ru-failed' : ''}">${select}
      <td class="ru-url"><span class="ru-host ri-mono">${esc(row.host || '(no host)')}</span><span class="ru-path ri-mono">${esc(row.path)}</span>${row.unsafe_chars ? '<span class="ri-unsafe">contains control characters</span>' : ''}${result ? `<span class="ru-result ${result.ok ? 'is-ok' : 'is-err'}" role="status">${esc(result.text)}</span>` : ''}</td>
      <td class="ru-lanes-cell"><div class="ru-lanes">${laneCell(row)}</div></td>
      <td class="num">${row.tests ? esc(row.tests) : '<span class="hint">0</span>'}</td>
      <td class="date">${isoWhen(row.first_seen)}<span class="ru-sub">${row.last_seen && row.last_seen !== row.first_seen ? `last ${isoWhen(row.last_seen)}` : ''}</span></td>
      <td class="ru-actions"><button type="button" class="button sm ghost" data-ru-history="${row.id}" aria-expanded="${open}" aria-controls="ru-history-${row.id}">${icon(open ? 'angle-up' : 'angle-down')}<span>History</span></button>${o.canMark ? (refusal ? `<span class="hint ru-refusal" title="${esc(refusal)}">${esc(refusal)}</span>` : `<button type="button" class="button sm" data-ru-mark="${row.id}">${icon('check-square-o')}<span>Mark</span></button>`) : ''}${href ? `<a class="row-icon" href="${esc(href)}" target="_blank" rel="noopener noreferrer" aria-label="Open URL in a new tab" data-tip="Open URL in a new tab">${icon('external-link')}</a>` : ''}</td></tr>
      ${open ? `<tr class="ru-history-row" id="ru-history-${row.id}"><td colspan="${o.canMark ? 6 : 5}">${historyHtml(row.id, o)}</td></tr>` : ''}`;
  }
  function evidence(o, path) {
    if (!path) return '<span class="muted">-</span>';
    const rel = String(path).replace(/^\.\//, '');
    if (/^reports\/(?!.*(?:^|\/)\.\.?(?:\/|$)).+\.md$/.test(rel)) {
      return `<a class="link-button" href="${esc(ctx.hrefFor({program: o.program, lane: o.lane, section: 'reports', report: rel.slice('reports/'.length)}))}">${icon('file-text-o')} ${esc(rel)}</a>`;
    }
    return `<code class="ri-path">${esc(path)}</code>`;
  }
  function historyHtml(id, o) {
    const h = st.history.get(id);
    if (!h) return '<div class="state">Loading history…</div>';
    if (h.error) return `<div class="state">${esc(h.error)}</div>`;
    const runs = h.test_runs.map(r => `<tr><td class="date">${isoWhen(r.completed_at)}</td><td>${esc(r.lane)}${r.param_key ? `<span class="ru-sub-value">param ${esc(r.param_key)}</span>` : ''}</td><td>${statusBadge(r.status)}</td><td>${esc(r.skill || '-')}${r.test_family ? `<span class="ru-sub-value">${esc(r.test_family)}</span>` : ''}</td><td>${esc(r.agent_id || '-')}</td><td><span class="ri-notes" title="${esc(r.notes || r.response_summary || '')}">${esc(r.notes || r.response_summary || '')}</span></td><td>${evidence(o, r.evidence_path)}</td></tr>`).join('');
    const obs = h.observations.map(r => `<tr><td class="date">${isoWhen(r.created_at)}</td><td>${esc(r.lane)}${r.param_key ? `<span class="ru-sub-value">param ${esc(r.param_key)}</span>` : ''}</td><td>${statusBadge(r.status)}</td><td>${esc(r.agent_id || '-')}</td><td><span class="ri-notes" title="${esc(r.notes || '')}">${esc(r.notes || '')}</span></td><td>${evidence(o, r.evidence_path)}</td></tr>`).join('');
    return `<div class="ru-history" data-ru-history-panel="${id}"><p class="hint ru-full-url ri-mono">${esc(h.url)}</p>
      <h4>Test runs <span class="count">${h.test_runs.length}</span></h4>${runs ? `<div class="ri-scroll"><table class="ri-table ru-history-table"><thead><tr><th class="date">When</th><th>Lane</th><th>Status</th><th>Skill / family</th><th>Agent</th><th>Notes</th><th>Evidence</th></tr></thead><tbody>${runs}</tbody></table></div>` : '<p class="hint">No test runs recorded.</p>'}
      <h4>Latest status per lane <span class="count">${h.observations.length}</span></h4>${obs ? `<div class="ri-scroll"><table class="ri-table ru-history-table"><thead><tr><th class="date">When</th><th>Lane</th><th>Status</th><th>Agent</th><th>Notes</th><th>Evidence</th></tr></thead><tbody>${obs}</tbody></table></div>` : '<p class="hint">No observations recorded.</p>'}
      ${h.truncated ? '<p class="hint">Showing the newest 200 of each.</p>' : ''}</div>`;
  }
  function bulkHtml(o) {
    const b = st.bulk, n = st.selected.size;
    // A finished run stays visible even when the failure turned editing off.
    if (!o.canMark && !b) return '';
    if (b) {
      const done = b.done.length, failed = b.done.filter(r => !r.ok).length;
      return `<div class="ru-bulk" role="status" data-ru-bulk><strong>${b.running ? `Marking ${Math.min(done + 1, b.total)} of ${b.total}` : `Marked ${done - failed} of ${b.total}`}</strong>
        <span class="ru-progress" aria-hidden="true"><i style="width:${Math.round(100 * done / Math.max(1, b.total))}%"></i></span>
        ${failed ? `<span class="badge danger">${failed} failed</span>` : ''}${b.stopped ? `<span class="hint">${esc(b.stopped)}</span>` : ''}
        ${b.running ? '<button type="button" class="button sm" data-ru-stop>Stop</button>' : '<button type="button" class="button sm ghost" data-ru-bulk-close>Done</button>'}</div>`;
    }
    if (!n || !o.canMark) return '';
    return `<div class="ru-bulk" data-ru-bulk><strong>${n} selected</strong>${n > BULK_MAX ? `<span class="badge warning">At most ${BULK_MAX} per bulk mark</span>` : ''}
      <button type="button" class="button sm primary" data-ru-bulk-mark${n > BULK_MAX ? ' disabled' : ''}>${icon('check-square-o')}<span>Mark selected</span></button>
      <button type="button" class="button sm ghost" data-ru-clear-selection>Clear selection</button></div>`;
  }
  function pagerHtml(o) {
    const p = st.page;
    if (!p || p.error) return '';
    const prev = st.prev.length ? st.prev[st.prev.length - 1] : null;
    return `<nav class="ru-pager" aria-label="URL pages">
      ${o.cursor ? `<a class="button sm" href="${esc(o.hrefWith(o.filters, 0))}" data-ru-page="first">${icon('angle-double-left')}<span>First</span></a>` : ''}
      ${prev != null && o.cursor ? `<a class="button sm" href="${esc(o.hrefWith(o.filters, prev))}" data-ru-page="prev">${icon('angle-left')}<span>Previous</span></a>` : ''}
      ${p.done ? '<span class="hint">End of list</span>' : `<a class="button sm" href="${esc(o.hrefWith(o.filters, p.next))}" data-ru-page="next"><span>Next</span>${icon('angle-right')}</a>`}</nav>`;
  }
  function html(o) {
    const p = st.page;
    const items = p && !p.error ? p.items : [];
    const allSelectable = items.filter(r => !markRefusal(r, o.lane, o.canMark));
    const head = o.canMark ? `<th class="ru-select">${allSelectable.length ? `<input type="checkbox" data-ru-select-page aria-label="Select all marked-able URLs on this page"${allSelectable.every(r => st.selected.has(r.id)) ? ' checked' : ''}>` : ''}</th>` : '';
    const table = items.length ? `<div class="table-wrap ru-table-wrap"><table class="ri-table ru-table"><thead><tr>${head}<th>URL</th><th>Status by lane</th><th class="num">Tests</th><th class="date">First seen</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${items.map(r => rowHtml(r, o)).join('')}</tbody></table></div>`
      : `<div class="state">${st.loading ? 'Loading URLs…' : p && !p.error ? (p.done ? 'No URLs match these filters.' : 'No matches in this stretch of ids. Use Next to keep searching.') : ''}</div>`;
    const off = !o.canMark && o.markOff ? `<p class="hint ru-off">${esc(o.markOff)}</p>` : '';
    return `<div class="panel-head"><div><h2>URLs</h2><p class="hint">From the URL index of this lane. Filters and the page stay in the link.</p>${off}</div><a class="button sm ghost" href="${esc(o.closeHref)}" data-ru-close>${icon('times')}<span>Close</span></a></div>
      <div class="panel-pad ru-controls">${filtersHtml(o)}</div>
      <p class="hint ru-status" role="status" data-ru-status>${statusLine(o)}</p>${bulkHtml(o)}${table}${pagerHtml(o)}`;
  }
  function paint() {
    const node = st.node, o = st.opts;
    if (!node || !node.isConnected || !o) return;
    const active = document.activeElement;
    const keep = active && node.contains(active) ? {name: active.name, attr: [...active.attributes].find(a => a.name.startsWith('data-ru-'))?.name, value: active.getAttribute?.([...active.attributes].find(a => a.name.startsWith('data-ru-'))?.name || ''), start: active.selectionStart, end: active.selectionEnd} : null;
    node.innerHTML = html(o);
    if (keep) {
      const el = keep.name ? node.querySelector(`[data-ru-filters] [name="${CSS.escape(keep.name)}"]`) : keep.attr ? node.querySelector(`[${keep.attr}="${CSS.escape(keep.value || '')}"]`) : null;
      if (el) { el.focus({preventScroll: true}); try { if (keep.start != null) el.setSelectionRange(keep.start, keep.end); } catch {} }
    }
  }

  // ---- events -----------------------------------------------------------------
  let filterTimer = 0;
  function readFilters(form) {
    const v = name => form.elements[name];
    return cleanFilters({host: v('host').value, q: v('q').value, lane: v('lane').value, status: v('status').value, params: v('params').checked, param: v('param').value,
      order: v('order').checked ? 'asc' : ''});
  }
  function onInput(event) {
    const form = event.target.closest('[data-ru-filters]'); if (!form) return;
    clearTimeout(filterTimer);
    const delay = event.target.type === 'search' ? 350 : 0;
    filterTimer = setTimeout(() => { st.prev = []; st.opts.onFilters(readFilters(form), 0); }, delay);
  }
  async function toggleHistory(id) {
    if (st.open.has(id)) { st.open.delete(id); paint(); return; }
    st.open.set(id, true); paint();
    if (st.history.has(id) && !st.history.get(id).error) return;
    const o = st.opts;
    try {
      const response = await fetch(`/api/recon/url?${new URLSearchParams({family: 'web_bounty', program: o.programName, lane: o.lane, id: String(id)})}`, {cache: 'no-store'});
      const body = await response.json().catch(() => ({}));
      st.history.set(id, response.ok && !body.error ? body : {error: response.status === 404 ? 'This URL is no longer in the index.' : 'History is unavailable.'});
    } catch { st.history.set(id, {error: 'History is unavailable.'}); }
    paint();
  }
  const rowById = id => st.page?.items?.find(r => r.id === id);
  function markForm(rows) {
    const params = [...new Set(rows.flatMap(r => r.params || []))].filter(p => !UNSAFE.test(p)).slice(0, 40);
    const box = document.createElement('form');
    box.className = 'ru-mark-form';
    box.innerHTML = `<div class="menu-label">${rows.length === 1 ? 'Mark URL' : `Mark ${rows.length} URLs`}</div>
      <p class="hint">Recorded in the URL index through BBH url_ingest.py mark, agent bounty-board.</p>
      <label>Lane<select name="lane" required>${LANES.map(l => `<option value="${l}"${l === (st.opts.filters.lane || 'recon') ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
      <label>Status<select name="status" required>${MARK_STATUSES.map(s => `<option value="${s}">${esc(STATUS_LABEL[s])}</option>`).join('')}</select></label>
      <label>Parameter (optional)<input name="param" list="ru-param-list" autocomplete="off" spellcheck="false" maxlength="120"><datalist id="ru-param-list">${params.map(p => `<option value="${esc(p)}">`).join('')}</datalist></label>
      <label>Location<select name="location">${LOCATIONS.map(l => `<option value="${l}">${l}</option>`).join('')}</select></label>
      <label>Notes (optional)<input name="notes" maxlength="500" autocomplete="off"></label>
      <p class="ri-err" data-ru-form-error hidden></p>
      <div class="menu-foot"><button type="button" class="button sm ghost" data-ru-cancel>Cancel</button><button type="submit" class="button sm primary">${rows.length === 1 ? 'Mark' : `Mark ${rows.length}`}</button></div>`;
    return box;
  }
  function openMark(trigger, ids) {
    const rows = ids.map(rowById).filter(Boolean);
    if (!rows.length) return;
    const box = markForm(rows);
    box.addEventListener('click', e => { if (e.target.closest('[data-ru-cancel]')) ui().closePopover(true); });
    box.addEventListener('submit', e => {
      e.preventDefault();
      const f = box.elements;
      const fields = {testLane: f.lane.value, status: f.status.value, param: f.param.value, location: f.location.value, notes: f.notes.value};
      const bodies = rows.map(row => markBody({program: st.opts.programName, lane: st.opts.lane, rootInstance: ctx.state.data?.root_instance, row, ...fields}));
      if (bodies.some(b => !b)) { const err = box.querySelector('[data-ru-form-error]'); err.hidden = false; err.textContent = 'Parameter and notes must be one plain line without control characters.'; return; }
      ui().closePopover(true);
      runMarks(rows, bodies);
    });
    ui().openPopover(trigger, box, {className: 'filter-popover ru-mark-popover', label: 'Mark URLs', trapTab: true});
    box.elements.status.focus();
  }
  async function postMark(body) {
    const response = await fetch('/api/recon/mark', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Requested-With': 'Bounty-Board'}, body: JSON.stringify(body)});
    return {status: response.status, body: await response.json().catch(() => ({}))};
  }
  function failureText(status, body) {
    if (body.message) return body.message;
    return {writer_unavailable: 'Editing is off or the writer stopped. Not marked.', url_changed: 'The URL changed. Refresh and retry.',
      url_not_found: 'No longer in the index.', root_changed: 'The data root changed. Refresh the board.', invalid_recon_mark: 'Refused: invalid values.'}[body.error]
      || `Not marked (HTTP ${status}).`;
  }
  // One BBH call per URL, in order, so progress and per-row failures are exact.
  async function runMarks(rows, bodies) {
    const bulk = rows.length > 1;
    st.bulk = bulk ? {total: rows.length, done: [], running: true, stop: false, stopped: ''} : null;
    paint();
    for (let i = 0; i < rows.length; i++) {
      if (st.bulk?.stop) { st.bulk.stopped = `Stopped: ${rows.length - i} not attempted.`; break; }
      const row = rows[i];
      let outcome;
      try {
        const {status, body} = await postMark(bodies[i]);
        if (status === 200 && body.item) {
          Object.assign(row, body.item);
          if (body.url) st.history.set(row.id, body.url);
          outcome = {ok: true, text: `Marked ${bodies[i].test_lane}: ${STATUS_LABEL[bodies[i].status]}`};
          st.selected.delete(row.id);
        } else {
          outcome = {ok: false, text: failureText(status, body)};
          if (body.error === 'writer_unavailable' || status === 502) {
            // The backend disables the writer after a failed write; further calls would only be refused.
            st.results.set(row.id, outcome); st.bulk && st.bulk.done.push(outcome);
            if (st.bulk) st.bulk.stopped = `Stopped after a writer failure: ${rows.length - i - 1} not attempted.`;
            ctx.reload?.();
            break;
          }
        }
      } catch { outcome = {ok: false, text: 'Network error. Not confirmed; refresh to check.'}; }
      st.results.set(row.id, outcome);
      if (st.bulk) st.bulk.done.push(outcome);
      paint();
    }
    if (st.bulk) st.bulk.running = false;
    paint();
    if (!bulk) {
      const r = st.results.get(rows[0].id);
      ui().toast(r?.text || 'Done.', r?.ok ? 'success' : 'warning');
    }
    window.dispatchEvent(new CustomEvent('board-recon-marked', {detail: {program: st.opts.program, lane: st.opts.lane}}));
  }
  function onClick(event) {
    const t = event.target.closest('button, input[type=checkbox]');
    if (!t || !st.node.contains(t)) return;
    if (t.dataset.ruHistory) toggleHistory(Number(t.dataset.ruHistory));
    else if (t.dataset.ruMark) openMark(t, [Number(t.dataset.ruMark)]);
    else if (t.dataset.ruSelect) { const id = Number(t.dataset.ruSelect); if (t.checked) st.selected.add(id); else st.selected.delete(id); paint(); }
    else if (t.hasAttribute('data-ru-select-page')) {
      for (const r of (st.page?.items || []).filter(r => !markRefusal(r, st.opts.lane, st.opts.canMark))) { if (t.checked) st.selected.add(r.id); else st.selected.delete(r.id); }
      paint();
    }
    else if (t.hasAttribute('data-ru-bulk-mark')) {
      const ids = [...st.selected].filter(id => rowById(id));
      if (ids.length > BULK_MAX) return;
      if (ids.length < st.selected.size) ui().toast('Only rows on this page can be marked together.', 'info');
      openMark(t, ids);
    }
    else if (t.hasAttribute('data-ru-clear-selection')) { st.selected.clear(); paint(); }
    else if (t.hasAttribute('data-ru-stop')) { if (st.bulk) st.bulk.stop = true; }
    else if (t.hasAttribute('data-ru-bulk-close')) { st.bulk = null; paint(); }
  }
  function onLinkClick(event) {
    const page = event.target.closest('[data-ru-page]');
    if (page && st.opts) {
      if (page.dataset.ruPage === 'next') st.prev.push(st.opts.cursor || 0);
      else if (page.dataset.ruPage === 'prev') st.prev.pop();
      else st.prev = [];
    }
  }

  // ---- entry point ---------------------------------------------------------------
  function update(node, opts) {
    ctx = opts.ctx;
    const key = keyOf(opts);
    const sameList = st.key === key;
    if (st.opts && (st.opts.program !== opts.program || st.opts.lane !== opts.lane)) {
      st.selected.clear(); st.results.clear(); st.open.clear(); st.history.clear(); st.prev = []; st.bulk = null; st.page = null;
    } else if (st.opts && !sameFilters(st.opts.filters, opts.filters)) {
      st.selected.clear(); st.results.clear(); st.open.clear();
    }
    st.opts = opts; st.node = node; st.key = key;
    if (!node.dataset.ruBound) {
      node.dataset.ruBound = '1';
      node.addEventListener('click', onClick);
      node.addEventListener('click', onLinkClick, true);
      node.addEventListener('input', onInput);
      node.addEventListener('change', event => { if (event.target.closest('[data-ru-filters]') && event.target.type !== 'search') onInput(event); });
    }
    // A new page or filter keeps the previous rows on screen ("updating") until the answer arrives.
    if (!sameList || (!st.page && !st.loading)) { st.error = ''; fetchPage(); }
    else paint();
  }
  // A mark from elsewhere (another tab is not tracked): refresh the open list.
  root.BoardReconUrls = Object.freeze({update, refresh: () => { if (st.opts) fetchPage(); }, ...helpers});
})(typeof window !== 'undefined' ? window : globalThis);
