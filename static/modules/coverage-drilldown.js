/* Coverage drill-down module. Reads lane.coverage as already served by /api/data
 * and turns it into question-level and surface-level views.
 *
 * Semantics (validated against real coverage databases, see docs/integrations/taxonomy-coverage.md):
 *  - A surface is one mapped inventory item. An assessment row is one question about a
 *    surface for one class. A surface can have several questions (1 to 4 observed), so
 *    question counts are NOT surface counts. Both are shown and never mixed.
 *  - "Reviewed" means a recorded bounded review of one class on one surface. It is not
 *    whole-application or whole-surface coverage.
 *  - Freshness needs a fingerprint baseline; where one is missing it is "unknown", never "current".
 * Pure functions are exported for Node tests; the DOM part mounts into #coverage-drilldown-host. */
(function (root) {
  'use strict';
  const DAY = 86400000;
  const ACTIVE = ['blocked', 'in_progress', 'bounded_review'];
  const STATUS_LABEL = {no_assessment: 'Question open', in_progress: 'In progress', blocked: 'Blocked', bounded_review: 'Bounded review', stale: 'Stale'};
  const BLOCK_TAGS = [
    ['Edge, WAF or challenge', /\b(waf|cloudflare|akamai|edge|challenge|captcha|bot|403|429|rate.?limit)\b/i],
    ['Needs account or role', /\b(account|credential|login|role|seat|tenant|org|license|paid|premium|invite)\b/i],
    ['Needs source or build', /\b(source|build|binary|decompil|chunk|bundle|minified|sourcemap)\b/i],
    ['Scope or approval', /\b(scope|approval|permission|authori[sz]ation to|prohibited|out of scope)\b/i],
    ['Transport or tooling', /\b(transport|proxy|mitm|tls|pinning|timeout|tool|browser)\b/i]
  ];

  const age = (iso, now) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / DAY)) : null;
  };
  const surfaceKey = i => String(i.surface_id ?? [i.kind, i.host, i.surface_key, i.input_key, i.consumer].join('|'));

  function blockedTag(reason) {
    const text = String(reason ?? '');
    for (const [label, pattern] of BLOCK_TAGS) if (pattern.test(text)) return label;
    return 'Other or unspecified';
  }

  /* Reconcile denominators and build the numbers shown in the summary. */
  function summarize(cov, opts) {
    const now = opts?.now ?? Date.now(), staleDays = opts?.staleDays ?? 30;
    const items = Array.isArray(cov?.items) ? cov.items : [];
    const unassessed = Array.isArray(cov?.unassessed_surfaces) ? cov.unassessed_surfaces : [];
    const kinds = cov?.mapped_kinds && typeof cov.mapped_kinds === 'object' ? cov.mapped_kinds : {};
    const mapped = Object.values(kinds).reduce((a, n) => a + (Number.isFinite(n) ? n : 0), 0);
    const bySurface = new Map();
    for (const i of items) {
      const k = surfaceKey(i);
      if (!bySurface.has(k)) bySurface.set(k, {kind: i.kind, rows: []});
      bySurface.get(k).rows.push(i);
    }
    const has = (rows, s) => rows.some(r => r.status === s);
    const aged = r => ACTIVE.includes(r.status) && (age(r.updated_at, now) ?? -1) > staleDays;
    const surfaces = {mapped, with_questions: bySurface.size, without_questions: unassessed.length,
      bounded_review: 0, in_progress: 0, blocked: 0, stale: 0, aged: 0, none_started: unassessed.length};
    for (const {rows} of bySurface.values()) {
      if (has(rows, 'bounded_review')) surfaces.bounded_review++;
      if (has(rows, 'in_progress')) surfaces.in_progress++;
      if (has(rows, 'blocked')) surfaces.blocked++;
      if (has(rows, 'stale')) surfaces.stale++;
      if (rows.some(aged)) surfaces.aged++;
      if (rows.every(r => r.status === 'no_assessment')) surfaces.none_started++;
    }
    const questions = {total: items.length, by_status: {}, aged: items.filter(aged).length,
      freshness_unknown: items.filter(r => ACTIVE.includes(r.status) && r.freshness === 'unknown').length,
      without_evidence: items.filter(r => ACTIVE.includes(r.status) && !(Array.isArray(r.evidence_refs) && r.evidence_refs.length)).length};
    for (const i of items) questions.by_status[i.status] = (questions.by_status[i.status] || 0) + 1;
    const reconciled = mapped === bySurface.size + unassessed.length;
    const blocked = {};
    for (const i of items) if (i.status === 'blocked') { const t = blockedTag(i.reason); blocked[t] = (blocked[t] || 0) + 1; }
    return {surfaces, questions, reconciled, blocked_tags: blocked, staleDays};
  }

  /* Question rows grouped by class category (needs BoardTaxonomy; raw class when absent). */
  function byClass(items, normalizeClass) {
    const out = new Map();
    for (const i of items) {
      const label = normalizeClass ? normalizeClass(i.class_name).label.split(' > ')[0] : String(i.class_name ?? 'Unknown');
      const row = out.get(label) || {label, total: 0, by_status: {}};
      row.total++; row.by_status[i.status] = (row.by_status[i.status] || 0) + 1;
      out.set(label, row);
    }
    return [...out.values()].sort((a, b) => b.total - a.total);
  }

  /* Mapped vs reviewed per kind (surfaces, not questions). Largest kinds first. */
  function byKind(cov) {
    const items = Array.isArray(cov?.items) ? cov.items : [];
    const reviewed = new Map();
    for (const i of items) if (i.status === 'bounded_review') { if (!reviewed.has(i.kind)) reviewed.set(i.kind, new Set()); reviewed.get(i.kind).add(surfaceKey(i)); }
    return Object.entries(cov?.mapped_kinds || {}).map(([kind, mapped]) => ({kind, mapped, reviewed: reviewed.get(kind)?.size || 0}))
      .sort((a, b) => b.mapped - a.mapped);
  }

  /* Filter and order question rows. view: attention | all | <status>. */
  function filterQuestions(items, f, opts) {
    const now = opts?.now ?? Date.now(), staleDays = opts?.staleDays ?? 30, norm = opts?.normalizeClass;
    const q = String(f.q || '').trim().toLowerCase();
    const order = {blocked: 0, in_progress: 1, stale: 2, bounded_review: 3, no_assessment: 4};
    return items.filter(i => {
      const aged = ACTIVE.includes(i.status) && (age(i.updated_at, now) ?? -1) > staleDays;
      if (f.view === 'attention' ? !(['blocked', 'in_progress', 'stale'].includes(i.status) || aged) : f.view && f.view !== 'all' && i.status !== f.view) return false;
      if (f.category && (norm ? norm(i.class_name).label.split(' > ')[0] : String(i.class_name)) !== f.category) return false;
      if (f.kind && i.kind !== f.kind) return false;
      if (q && ![i.host, i.surface_key, i.input_key, i.consumer, i.class_name, i.reason, i.boundary].some(v => String(v ?? '').toLowerCase().includes(q))) return false;
      return true;
    }).sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')));
  }

  /* Match an evidence reference to a report in this lane, by relative path. */
  function reportForRef(ref, reports) {
    if (typeof ref !== 'string' || !ref.includes('/') && !ref.endsWith('.md')) return null;
    const clean = ref.replace(/^\.\//, '');
    return (reports || []).find(r => typeof r.path === 'string' && r.path && (clean === r.path || clean === 'reports/' + r.path || clean.endsWith('/' + r.path))) || null;
  }

  const api = {summarize, byClass, byKind, filterQuestions, reportForRef, blockedTag, age, STATUS_LABEL};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (!root || !root.document || !root.registerBoardModule) return;

  const ui = {key: '', view: 'attention', category: '', kind: '', staleDays: 30, q: '', limit: 40};
  const pct = (n, d) => d ? `${Math.round(n / d * 100)}%` : 'n/a';

  function mount(ctx) {
    const host = ctx.app.querySelector('#coverage-drilldown-host');
    if (!host) return;
    const lane = ctx.currentLane(), cov = lane?.coverage;
    const key = JSON.stringify([ctx.state.program, ctx.state.lane]);
    if (ui.key !== key) Object.assign(ui, {key, view: 'attention', category: '', kind: '', staleDays: 30, q: '', limit: 40});
    if (!cov || !Array.isArray(cov.items)) { host.innerHTML = ''; return; }
    const esc = ctx.esc, tax = root.BoardTaxonomy?.ready?.() ? root.BoardTaxonomy : null;
    const norm = tax ? tax.normalizeClass : null;
    const reports = ctx.rows('reports') || [];
    const paint = () => {
      const now = Date.now(), opts = {now, staleDays: ui.staleDays, normalizeClass: norm};
      const s = summarize(cov, opts), S = s.surfaces, Q = s.questions;
      const classes = byClass(cov.items, norm), kinds = byKind(cov);
      const filtered = filterQuestions(cov.items, ui, opts);
      const shown = filtered.slice(0, ui.limit);
      const tile = (n, label, hint) => `<div title="${esc(hint)}"><strong>${esc(n)}</strong><span>${esc(label)}</span></div>`;
      const opt = (v, label, cur) => `<option value="${esc(v)}" ${String(v) === String(cur) ? 'selected' : ''}>${esc(label)}</option>`;
      const statusCell = r => `${esc(STATUS_LABEL[r.status] || r.status)}${r.prior_status ? `<span class="id">Was ${esc(STATUS_LABEL[r.prior_status] || r.prior_status)}; mapped item changed since</span>` : ''}`;
      const refs = r => (Array.isArray(r.evidence_refs) ? r.evidence_refs : []).map(ref => {
        const rep = reportForRef(ref, reports);
        return rep ? `<button class="link-button" data-cd-report="${esc(rep.id)}">${esc(String(ref))}</button>` : `<code>${esc(display(ref))}</code>`;
      }).join('<br>') || '<span class="muted">No evidence recorded</span>';
      const display = ctx.display;
      const rowsHtml = shown.map(r => {
        const a = age(r.updated_at, now);
        const c = norm ? norm(r.class_name) : null;
        const scope = [r.host, r.surface_key, r.input_key, r.consumer].filter(Boolean).map(display).join(' | ');
        return `<tr data-cd-row data-status="${esc(r.status)}"><td><strong>${esc(scope || 'Unnamed surface')}</strong><span class="id">${esc(r.kind || '')}</span></td>
          <td>${esc(c && c.category !== 'unclassified' ? c.label.split(' > ')[0] : display(r.class_name))}<span class="id">${esc(display(r.class_name))}</span></td>
          <td>${statusCell(r)}<span class="id">Freshness: ${esc(r.freshness || 'unknown')}</span></td>
          <td>${a == null ? '<span class="muted">Not recorded</span>' : `${a} d ago`}${r.agent ? `<span class="id">${esc(r.agent)}</span>` : ''}</td>
          <td>${r.boundary ? `<details><summary>Boundary</summary><p>${esc(r.boundary)}</p></details>` : ''}${r.reason ? `<details><summary>${r.status === 'blocked' ? 'Blocked because' : 'Reason'}</summary><p>${esc(r.reason)}</p></details>` : ''}${r.reopen_when ? `<span class="id">Reopen when: ${esc(r.reopen_when)}</span>` : ''}</td>
          <td>${refs(r)}</td></tr>`;
      }).join('');
      const statusCols = ['blocked', 'in_progress', 'stale', 'bounded_review', 'no_assessment'];
      host.innerHTML = `<section class="panel panel-pad cd-panel" aria-label="Coverage drill-down">
        <div class="blockhead"><div><h2>Coverage drill-down</h2>
        <p class="hint">Mapped surfaces are inventory. A bounded review answers one class question on one surface; it is not whole-surface or whole-application coverage.</p></div></div>
        <div class="summary-line" data-cd-surfaces aria-label="Surface counts">
          ${tile(S.mapped, 'Mapped surfaces', 'Inventory count; mapped_kinds total')}
          ${tile(S.bounded_review, 'With a bounded review', 'Surfaces with at least one bounded review for at least one class')}
          ${tile(S.in_progress, 'With work in progress', 'Surfaces with at least one in-progress question')}
          ${tile(S.blocked, 'With a blocked question', 'Surfaces with at least one blocked question')}
          ${tile(S.stale, 'Stale', 'Surfaces whose mapped item changed after the review')}
          ${tile(S.none_started, 'Nothing assessed', 'No question, or every question still open')}
        </div>
        <p class="hint" data-cd-reconcile>${s.reconciled ? `Check: ${S.with_questions} surfaces with questions + ${S.without_questions} without = ${S.mapped} mapped.` : `Counts do not reconcile: ${S.with_questions} + ${S.without_questions} differs from ${S.mapped} mapped. Treat these numbers with caution.`}
        Surface tiles overlap: one surface can be reviewed for one class and blocked for another. ${esc(Q.total)} questions cover ${esc(S.with_questions)} surfaces (up to several classes each).</p>
        <p class="hint" data-cd-quality>Of reviewed, in-progress or blocked questions: ${Q.without_evidence} have no evidence reference, ${Q.freshness_unknown} have unknown freshness (no fingerprint baseline), ${Q.aged} not updated in over ${ui.staleDays} days.</p>
        <div class="filters cd-filters">
          <label class="hint">Show<select id="cd-view" aria-label="Question view">${opt('attention', 'Needs attention', ui.view)}${opt('all', 'All questions', ui.view)}${statusCols.map(x => opt(x, STATUS_LABEL[x], ui.view)).join('')}</select></label>
          <label class="hint">Class<select id="cd-category" aria-label="Class category"><option value="">All classes</option>${classes.map(c => opt(c.label, `${c.label} (${c.total})`, ui.category)).join('')}</select></label>
          <label class="hint">Kind<select id="cd-kind" aria-label="Surface kind"><option value="">All kinds</option>${kinds.slice(0, 40).map(k => opt(k.kind, `${k.kind} (${k.mapped})`, ui.kind)).join('')}</select></label>
          <label class="hint">Stale after<select id="cd-stale" aria-label="Stale after days">${[14, 30, 60, 90].map(n => opt(n, `${n} days`, ui.staleDays)).join('')}</select></label>
          <input id="cd-search" aria-label="Search coverage questions" placeholder="Search surface, class, reason" value="${esc(ui.q)}">
        </div>
        <p class="hint" data-cd-count>${filtered.length} of ${Q.total} questions${filtered.length > shown.length ? `; showing ${shown.length}` : ''}.</p>
        ${shown.length ? `<div class="cd-scroll"><table class="cd-table"><thead><tr><th>Surface</th><th>Class</th><th>State</th><th>Updated</th><th>Boundary and reason</th><th>Evidence</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>` : '<div class="state">No questions match these filters.</div>'}
        ${filtered.length > shown.length ? '<button class="button" id="cd-more">Show more</button>' : ''}
        <h3>Questions by class</h3>
        <div class="cd-scroll"><table class="cd-table" data-cd-classes><thead><tr><th>Class</th><th>Questions</th>${statusCols.map(x => `<th>${esc(STATUS_LABEL[x])}</th>`).join('')}<th>Reviewed share</th></tr></thead><tbody>${classes.map(c => `<tr><td>${esc(c.label)}</td><td>${c.total}</td>${statusCols.map(x => `<td>${c.by_status[x] || 0}</td>`).join('')}<td>${pct(c.by_status.bounded_review || 0, c.total)}</td></tr>`).join('')}</tbody></table></div>
        <p class="hint">Reviewed share is bounded reviews divided by questions recorded for that class, not divided by mapped surfaces.</p>
        <h3>Mapped and reviewed by kind</h3>
        <div class="cd-scroll"><table class="cd-table" data-cd-kinds><thead><tr><th>Kind</th><th>Mapped surfaces</th><th>With a bounded review</th><th>Share</th></tr></thead><tbody>${kinds.slice(0, 15).map(k => `<tr><td>${esc(k.kind)}</td><td>${k.mapped}</td><td>${k.reviewed}</td><td>${pct(k.reviewed, k.mapped)}</td></tr>`).join('')}</tbody></table></div>
        ${kinds.length > 15 ? `<p class="hint">${kinds.length - 15} smaller kinds not shown; use the Kind filter.</p>` : ''}
        ${Object.keys(s.blocked_tags).length ? `<h3>Blocked questions by reason</h3><p class="hint">Grouped by keywords in the recorded reason; the reason text itself is in the table above.</p><div data-cd-blocked>${Object.entries(s.blocked_tags).sort((a, b) => b[1] - a[1]).map(([tag, n]) => `<div class="record"><span>${esc(tag)}</span> <strong>${n}</strong></div>`).join('')}</div>` : ''}
      </section>`;
    };
    paint();
    host.onchange = e => {
      const id = e.target.id;
      if (id === 'cd-view') ui.view = e.target.value; else if (id === 'cd-category') ui.category = e.target.value;
      else if (id === 'cd-kind') ui.kind = e.target.value; else if (id === 'cd-stale') ui.staleDays = Number(e.target.value);
      else return;
      ui.limit = 40; paint();
    };
    host.oninput = e => {
      if (e.target.id !== 'cd-search') return;
      ui.q = e.target.value; ui.limit = 40; paint();
      const box = host.querySelector('#cd-search');
      if (box) { box.focus(); box.setSelectionRange(ui.q.length, ui.q.length); }
    };
    host.onclick = e => {
      if (e.target.id === 'cd-more') { ui.limit += 40; paint(); return; }
      const id = e.target.dataset?.cdReport;
      if (id != null) { ctx.state.section = 'reports'; ctx.state.report = String(id); ctx.render(); }
    };
  }

  root.registerBoardModule({name: 'coverage-drilldown', afterRender: mount});
})(typeof window !== 'undefined' ? window : null);
