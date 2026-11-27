/* Filter bar (feat/board-recent-facets): a row of facet dropdowns along the top
 * of a list, shared by the Recent reports view (#/recent) and the Submissions
 * view (#/submissions); both are lists in recent-reports.js.
 *
 * Pure renderer plus popover wiring; each list owns its state and data.
 *  - One dropdown button per facet ("Severity: High, Critical", "Class: 3" when
 *    long), pressed look when something is selected, aria-haspopup/expanded.
 *  - Its popover (BoardUI.openPopover, the look of the Findings filters and the
 *    old Recent program picker): real checkboxes (or radios), each
 *    "label · count", a filter box for long facets, Clear and Done. Checking
 *    applies at once and keeps the popover open; one popover at a time; Esc or
 *    an outside click closes it with focus back on its button; arrow keys and
 *    Tab move through the options.
 *  - Facet rules: OR within a facet, AND across facets, no selection = no
 *    filter; a facet's counts ignore its own selection (the list provides
 *    them). Zero counts are muted; a checked option is never hidden.
 *  - Active selections also render as chips with "Clear all".
 *  - Every option label and value from data goes through esc.
 *
 * One mapping, two sides: `keys` buckets a finding into its submission,
 * severity and class keys exactly like finding_facets.py does on the server;
 * both run static/tests/facet-cases.json. Works in the browser
 * (window.BoardFilterBar) and in Node (module.exports) for tests. */
(function (root) {
  'use strict';
  const NONE = 'none';
  const SUBMISSIONS = [['not_submitted', 'Not submitted'], ['submitted', 'Submitted, awaiting result'], ['valid', 'Valid'],
    ['duplicate', 'Duplicate'], ['dropped', 'Dropped'], ['other', 'Other'], [NONE, 'No linked finding']];
  const SEVERITIES = [['exceptional', 'Exceptional'], ['critical', 'Critical'], ['high', 'High'], ['medium', 'Medium'],
    ['low', 'Low'], ['info', 'Info'], ['unknown', 'Unknown'], [NONE, 'No linked finding']];
  const SEVERITY_RANK = Object.fromEntries(SEVERITIES.map(([k], i) => [k, i]));
  const UNCLASSIFIED = 'unclassified';
  const NOT_SUBMITTED = new Set(['', 'not_submitted', 'not submitted', 'none', 'draft', 'unsubmitted']);

  // ---- facet keys (mirror of finding_facets.py) ------------------------------
  let taxonomy = root && root.BoardTaxonomy ? root.BoardTaxonomy : null;
  const tax = () => taxonomy || (root && root.BoardTaxonomy) || null;
  const text = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
  function submissionKey(finding) {
    if (finding == null) return NONE;
    const nested = finding.submission && typeof finding.submission === 'object' && !Array.isArray(finding.submission) ? finding.submission : {};
    const result = text(nested.result);
    if (result === 'valid' || result === 'duplicate') return result;
    const state = text(nested.state) || text(finding.submission_status);
    if (NOT_SUBMITTED.has(state)) return 'not_submitted';
    return state === 'submitted' || state === 'dropped' ? state : 'other';
  }
  function severityKey(finding) {
    if (finding == null) return NONE;
    const t = tax(), value = t && t.ready() ? String(t.normalizeSeverity(finding.severity).value).toLowerCase() : 'unknown';
    return Object.prototype.hasOwnProperty.call(SEVERITY_RANK, value) && value !== NONE ? value : 'unknown';
  }
  // {raw, category, subclass, label, subclass_label}; the browser rows carry `class`, the ledger `class_name`.
  function classInfo(finding) {
    if (finding == null) return null;
    let raw = finding.class !== undefined ? finding.class : finding.class_name;
    // A cold-start row is a copy of the server's item.finding, where class is {raw, category, ...}:
    // bucket its recorded raw class, exactly as the server did.
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) raw = raw.raw;
    const t = tax();
    const result = t && t.ready() ? t.normalizeClass(typeof raw === 'string' ? raw : null) : {category: UNCLASSIFIED, subclass: null, label: 'Unclassified'};
    const [label, subLabel] = String(result.label).split(' > ');
    return {raw: typeof raw === 'string' ? raw : null, category: result.category, subclass: result.subclass || null, label, subclass_label: subLabel || null};
  }
  const classKey = finding => finding == null ? NONE : classInfo(finding).category;
  function classOptions() {
    const t = tax();
    return [...(t ? t.categories() : []).map(c => [c.id, c.label]), [UNCLASSIFIED, 'Unclassified'], [NONE, 'No linked finding']];
  }
  // Class order: labels A to Z, then Unclassified, then No linked finding.
  const classSort = (key, label) => [key === NONE ? 2 : key === UNCLASSIFIED ? 1 : 0, String(label).toLowerCase()];
  const compareClass = (a, b) => { const x = classSort(...a), y = classSort(...b); return x[0] - y[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0); };
  // Resolves when the taxonomy rules are loaded (class keys need them), or after 3 s.
  function whenReady() {
    return new Promise(resolve => {
      const started = Date.now();
      const check = () => { const t = tax(); if ((t && t.ready()) || Date.now() - started > 3000) resolve(); else setTimeout(check, 40); };
      check();
    });
  }
  const keys = {submission: submissionKey, severity: severityKey, classInfo, classKey};

  // ---- rendering -------------------------------------------------------------
  const ESC = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ESC[c]);
  const icon = name => `<i class="fa fa-${name}" aria-hidden="true"></i>`;
  const SEARCH_AT = 8; // facets with more options get a filter box
  const picked = group => new Set((group.selected || []).map(String));
  const isActive = group => typeof group.active === 'boolean' ? group.active : group.type === 'radio' ? !!group.selected && String(group.selected[0]) !== String(group.defaultValue) : group.countSelections !== false && picked(group).size > 0;
  const activeCount = group => !isActive(group) ? 0 : group.type === 'radio' || group.countSelections === false ? 1 : picked(group).size;
  const totalActive = model => model.groups.reduce((n, g) => n + activeCount(g), 0);
  const labelOf = (group, value) => group.options.find(o => String(o.value) === String(value))?.short || group.options.find(o => String(o.value) === String(value))?.label || String(value);
  // "Severity", "Severity: High, Critical", "Class: 3" (long summaries become a count).
  function summary(group) {
    if (group.type === 'radio') return `${group.label}: ${labelOf(group, group.selected?.[0] ?? group.defaultValue)}`;
    const values = [...picked(group)];
    if (!values.length || group.countSelections === false) { const extra = group.summaryOff?.(values); return extra ? `${group.label}: ${extra}` : group.label; }
    const text = values.map(v => labelOf(group, v)).join(', ');
    return values.length > 2 || text.length > 24 ? `${group.label}: ${values.length}` : `${group.label}: ${text}`;
  }
  const buttonInner = group => `<span class="facet-text">${esc(summary(group))}</span>${icon('angle-down')}`;
  function barHtml(model) {
    return `<div class="facet-bar" role="group" aria-label="Filters">${model.groups.map(g => `<button type="button" class="button sm facet-button${isActive(g) ? ' is-active' : ''}" data-facet-open="${esc(g.key)}" aria-haspopup="true" aria-expanded="false" aria-label="${esc(`Filter ${g.label}: ${summary(g)}`)}">${buttonInner(g)}</button>`).join('')}</div>`;
  }
  // Updates button labels in place (an open popover keeps its anchor), else renders.
  function paintBar(host, model) {
    if (!host) return;
    const buttons = host.querySelectorAll('[data-facet-open]');
    if (buttons.length !== model.groups.length || [...buttons].some((b, i) => b.dataset.facetOpen !== model.groups[i].key)) { host.innerHTML = barHtml(model); return; }
    buttons.forEach((b, i) => {
      const g = model.groups[i];
      b.classList.toggle('is-active', isActive(g));
      b.setAttribute('aria-label', `Filter ${g.label}: ${summary(g)}`);
      const inner = buttonInner(g); if (b.innerHTML !== inner) b.innerHTML = inner;
    });
  }
  // Active selections as chips (existing .chips/.chip styles) with "Clear all".
  function chipsHtml(model, {clearAttrs = ''} = {}) {
    const chips = [];
    for (const g of model.groups) {
      if (g.chips === false) continue;
      if (g.type === 'radio') { if (isActive(g)) chips.push([g, g.selected[0], true]); continue; }
      for (const value of picked(g)) chips.push([g, value, false]);
    }
    if (!chips.length) return '';
    return `<div class="chips facet-chips" aria-label="Active filters">${chips.map(([g, value, radio]) => `<span class="chip" data-facet-chip="${esc(g.key)}"><span class="chip-key">${esc(g.chipLabel || g.label)}</span><span>${esc(labelOf(g, value))}</span><button type="button" data-facet-remove="${esc(g.key)}" data-value="${esc(value)}"${radio ? ' data-radio' : ''} aria-label="Remove filter ${esc(g.chipLabel || g.label)} ${esc(labelOf(g, value))}">${icon('times')}</button></span>`).join('')}<button type="button" class="link-button" data-facet-clear-all ${clearAttrs}>Clear all</button></div>`;
  }

  // ---- popover -------------------------------------------------------------------
  let open = null; // {key, box, model, handlers, filter}
  function optionsHtml(group, filter) {
    const on = picked(group), q = filter.trim().toLowerCase();
    const shown = group.options.filter(o => on.has(String(o.value)) || !q || `${o.label} ${o.search || o.value}`.toLowerCase().includes(q));
    if (!shown.length) return '<p class="hint facet-none">No matches</p>';
    return shown.map(o => {
      const checked = on.has(String(o.value)) || (group.type === 'radio' && !group.selected?.length && String(o.value) === String(group.defaultValue));
      const zero = typeof o.count === 'number' && o.count === 0 && !checked;
      const count = typeof o.count === 'number' ? `<span class="sr-only">, </span><span class="count">${esc(o.count)}</span>` : '';
      return `<label class="option${zero ? ' is-zero' : ''}"${o.hint ? ` title="${esc(o.hint)}"` : ''}><input type="${group.type === 'radio' ? 'radio' : 'checkbox'}" name="facet-${esc(group.key)}" value="${esc(o.value)}" data-facet-input="${esc(group.key)}"${o.attrs || ''}${checked ? ' checked' : ''}><span class="facet-option-label">${esc(o.label)}${o.sub ? ` <span class="id">${esc(o.sub)}</span>` : ''}</span>${count}</label>`;
    }).join('');
  }
  function drawOptions() {
    if (!open) return;
    const group = open.model.groups.find(g => g.key === open.key); if (!group) return;
    const list = open.box.querySelector('[data-facet-list]');
    const active = list.contains(document.activeElement) ? document.activeElement.value : null;
    const html = optionsHtml(group, open.filter);
    if (list.innerHTML !== html) {
      list.innerHTML = html;
      if (active != null) list.querySelector(`input[value="${CSS.escape(active)}"]`)?.focus({preventScroll: true});
    }
    const clear = open.box.querySelector('[data-facet-clear]'); if (clear) clear.disabled = !isActive(group);
  }
  // handlers: {change(key, values, input), clear(key), anchor() -> the button now in the page}
  function openFacet(trigger, model, key, handlers) {
    const group = model.groups.find(g => g.key === key); const ui = root.BoardUI; if (!group || !ui) return;
    const box = document.createElement('div');
    const long = group.search || group.options.length > SEARCH_AT;
    box.innerHTML = `<div class="menu-label">${esc(group.label)}</div>${long ? `<div class="input-icon facet-search">${icon('search')}<input type="search" data-facet-search aria-label="Filter ${esc(group.label)} options" placeholder="Filter ${esc(group.label.toLowerCase())}" autocomplete="off"></div>` : ''}<div class="menu facet-list" role="group" aria-label="${esc(group.label)} values" data-facet-list></div>${group.note ? `<p class="hint facet-note">${esc(group.note)}</p>` : ''}<div class="menu-foot">${group.type === 'radio' || group.clear === false ? '<span></span>' : `<button type="button" class="button sm ghost" data-facet-clear>Clear</button>`}<button type="button" class="button sm" data-facet-done>Done</button></div>`;
    open = {key, box, model, handlers, filter: ''};
    drawOptions();
    box.addEventListener('change', event => {
      const input = event.target.closest('[data-facet-input]'); if (!input || !open) return;
      const g = open.model.groups.find(x => x.key === open.key);
      const values = g.type === 'radio' ? [input.value] : (() => { const set = picked(g); if (input.checked) set.add(input.value); else set.delete(input.value); return [...set]; })();
      open.handlers.change(open.key, values, input);
    });
    box.addEventListener('input', event => { if (event.target.matches('[data-facet-search]') && open) { open.filter = event.target.value; drawOptions(); } });
    box.addEventListener('click', event => {
      if (event.target.closest('[data-facet-clear]') && open) { open.handlers.clear(open.key); box.querySelector('[data-facet-input], [data-facet-search]')?.focus(); }
      else if (event.target.closest('[data-facet-done]')) ui.closePopover(true);
    });
    // Arrow keys move through the filter box and options; Tab moves too (trapped inside).
    box.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const items = [...box.querySelectorAll('[data-facet-search], [data-facet-input]')];
      const i = items.indexOf(document.activeElement); if (i < 0 && document.activeElement?.matches('[data-facet-search]')) return;
      const next = event.key === 'ArrowDown' ? items[Math.min(items.length - 1, i + 1)] : event.key === 'ArrowUp' ? items[Math.max(0, i - 1)] : event.key === 'Home' ? items[0] : items[items.length - 1];
      if (next) { event.preventDefault(); next.focus(); }
    });
    const mine = open;
    ui.openPopover(trigger, box, {className: 'filter-popover facet-popover', label: `Filter ${group.label}`, trapTab: true,
      reanchor: () => handlers.anchor?.() || null,
      onClose: () => {
        if (open === mine) open = null;
        // An outside click on nothing focusable returns focus to the button.
        setTimeout(() => { if (!document.activeElement || document.activeElement === document.body) handlers.anchor?.()?.focus(); }, 0);
        handlers.closed?.();
      }});
    (box.querySelector('[data-facet-search]') || box.querySelector('[data-facet-input]:checked') || box.querySelector('[data-facet-input]'))?.focus();
  }
  // The list's model changed (a pick, fresh counts): redraw the open popover in place.
  function refresh(model) { if (open) { open.model = model; drawOptions(); } }
  const openKey = () => open?.key || null;
  const close = () => { if (open) root.BoardUI?.closePopover(false); };

  const api = {NONE, SUBMISSIONS, SEVERITIES, SEVERITY_RANK, UNCLASSIFIED, keys, classOptions, classSort, compareClass, whenReady,
    barHtml, paintBar, chipsHtml, openFacet, refresh, openKey, close, summary, totalActive, activeCount,
    useTaxonomy: t => { taxonomy = t; }};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && root.document) root.BoardFilterBar = api;
})(typeof window !== 'undefined' ? window : null);
