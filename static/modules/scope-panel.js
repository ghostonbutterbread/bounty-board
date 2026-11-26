/* Scope panel: what a program lists in scope, how fresh that list is, and what changed
 * (GET /api/scope?family=&program=; see BACKEND_API.md and docs/integrations/scope-panel.md).
 *  - #scope-panel-host (the program Scope section, #/programs/<program>/<lane>/scope?<query>):
 *    freshness and stale banner, rules checked automatically, program policy, other
 *    assets with binaries lane links, releases, and the scope change log.
 *  - A freshness badge after the program title, linking to the Scope section.
 * Query keys (validated; unknown values fall back to defaults): kind=apps|executables|source|cloud|other,
 * change=added|removed|changed|release, rules=all (every rule chip shown), policy=open.
 * Read-only: the Board never pulls scope. Commands are copied, never run; values with
 * control, bidi or invisible characters are never put on the clipboard. Server strings
 * are display-safe already and are still escaped with ctx.esc before innerHTML; the
 * program policy goes through the Board's safe Markdown renderer (ctx.markdown).
 * While the section is visible the data refreshes quietly every 60 s. */
(function (root) {
  'use strict';
  const RI = typeof module === 'object' && module.exports ? require('./recon-intel.js') : root.BoardReconIntel;
  const {isCopySafe, shellQuote} = RI;
  const KIND_FILTERS = {apps: ['android_app', 'ios_app'], executables: ['executable'], source: ['source_code'], cloud: ['cloud'], other: ['other']};
  const KIND_FILTER_LABELS = {'': 'All', apps: 'Apps', executables: 'Executables', source: 'Source code', cloud: 'Cloud', other: 'Other'};
  const CHANGE_FILTERS = {added: 'Added', removed: 'Removed', changed: 'Changed', release: 'Releases'};
  const KIND_LABELS = {android_app: 'Android app', ios_app: 'iOS app', executable: 'executable', source_code: 'source code', cloud: 'cloud',
    other: 'other', web_host: 'host', web_wildcard: 'wildcard', web_url: 'URL', ip: 'IP', cidr: 'CIDR'};
  const CHIP_CAP = 12;
  const POLL_MS = 60000;

  // ---- pure helpers (exported for Node tests) ------------------------------
  function parseQuery(query) {
    const q = new URLSearchParams(String(query || ''));
    const kind = q.get('kind'), change = q.get('change');
    return {kind: Object.hasOwn(KIND_FILTERS, kind || '') ? kind : '', change: Object.hasOwn(CHANGE_FILTERS, change || '') ? change : '',
      rules: q.get('rules') === 'all', policy: q.get('policy') === 'open'};
  }
  function buildQuery(s) {
    const q = new URLSearchParams();
    if (s.kind) q.set('kind', s.kind);
    if (s.change) q.set('change', s.change);
    if (s.rules) q.set('rules', 'all');
    if (s.policy) q.set('policy', 'open');
    return q.toString();
  }
  const pullCommand = (program, safe = true) => safe && isCopySafe(program) && program ? `bbh agents/scope_puller.py ${shellQuote(program)} --if-older-than 7` : null;
  const rebuildCommand = (program, safe = true) => safe && isCopySafe(program) && program ? `bbh agents/scope_puller.py --rebuild-inventory ${shellQuote(program)}` : null;
  const ageText = days => days == null ? 'at an unknown time' : days === 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`;
  const shortAge = days => days == null ? 'age unknown' : days === 0 ? 'today' : `${days} d old`;
  function fmtDate(ts, now = Date.now() / 1000) {
    if (typeof ts !== 'number' || !Number.isFinite(ts)) return '';
    const d = new Date(ts * 1000), sameYear = d.getFullYear() === new Date(now * 1000).getFullYear();
    return d.toLocaleDateString('en-US', {month: 'short', day: 'numeric', ...(sameYear ? {} : {year: 'numeric'})});
  }
  const matchesKind = (item, kind) => !kind || (KIND_FILTERS[kind] || []).includes(item.kind) || (kind === 'other' && item.known_kind === false);
  const entryHas = (entry, change) => !change || (entry.state === 'ok' && (entry[(change === 'release' ? 'release_changed' : change) + '_count'] || 0) > 0);
  function changeSummary(entry) {
    if (entry.state !== 'ok') return 'Unreadable line';
    if (entry.source === 'baseline') return 'Inventory started';
    const n = name => entry[name + '_count'] || 0;
    const parts = [n('added') && `+${n('added')} added`, n('removed') && `-${n('removed')} removed`,
      n('changed') && `${n('changed')} changed`, n('release_changed') && `${n('release_changed')} release${n('release_changed') === 1 ? '' : 's'} changed`].filter(Boolean);
    return parts.length ? parts.join(', ') : 'No item changes';
  }
  const helpers = {parseQuery, buildQuery, pullCommand, rebuildCommand, ageText, shortAge, fmtDate, matchesKind, entryHas, changeSummary};
  if (typeof module === 'object' && module.exports) { module.exports = helpers; return; }


  // ---- DOM -----------------------------------------------------------------
  let ctx = null;
  const cache = new Map();   // "family|program" -> {data, json, at, loading, error}
  const openEntries = new Set();
  let timer = 0;
  const esc = value => ctx.esc(value);
  const icon = name => `<i class="fa fa-${name}" aria-hidden="true"></i>`;
  const ui = () => ctx.ui || window.BoardUI;
  const keyOf = (family, program) => `${family}|${program}`;
  const state = () => parseQuery(ctx.state.scopeQuery);

  async function fetchScope(family, program, {quiet = false} = {}) {
    const key = keyOf(family, program), entry = cache.get(key) || {};
    if (entry.loading) return;
    entry.loading = true; cache.set(key, entry);
    try {
      const response = await fetch(`/api/scope?family=${encodeURIComponent(family)}&program=${encodeURIComponent(program)}`, {cache: 'no-store'});
      if (!response.ok) throw new Error(`scope request failed (${response.status})`);
      const data = await response.json(), json = JSON.stringify({...data, computed_at: null});
      const changed = json !== entry.json;
      Object.assign(entry, {data, json, at: Date.now(), error: ''});
      if (changed || !quiet) update(key);
    } catch (error) {
      entry.error = 'Scope could not be loaded.'; entry.at = Date.now();
      if (!quiet || !entry.data) update(key);
    } finally { entry.loading = false; }
  }
  function update(key) {
    if (!ctx) return;
    const host = ctx.app.querySelector('#scope-panel-host');
    if (host && keyOf(host.dataset.family, host.dataset.program) === key) paint(host);
    badge();
  }

  // -- header badge --
  function badge() {
    const p = ctx.state.view === 'program' ? ctx.programs().find(x => String(x.id) === ctx.state.program) : null;
    const title = ctx.app.querySelector('.titlebar h1');
    ctx.app.querySelector('[data-scope-badge]')?.remove();
    if (!p || !title) return;
    const entry = cache.get(keyOf(p.family, p.name));
    if (!entry?.data) return;
    const d = entry.data, f = d.freshness;
    let cls = 'success', label;
    if (d.scope?.state === 'none') { cls = 'outline'; label = 'No scope on file'; }
    else if (d.scope?.state !== 'loaded') { cls = 'danger'; label = 'Scope unreadable'; }
    else { label = `Scope ${shortAge(f?.age_days)}${f?.estimated ? ' (est.)' : ''}`; if (f?.stale) cls = 'warning'; }
    const href = ctx.hrefFor({program: p.id, section: 'scope', query: ctx.state.section === 'scope' ? ctx.state.scopeQuery : ''});
    title.classList.add('sp-has-badge');
    title.insertAdjacentHTML('afterend', `<a class="badge ${cls} sp-badge" data-scope-badge="${esc(d.scope?.state || '')}" href="${esc(href)}" title="Open the Scope section">${icon('bullseye')}<span>${esc(label)}</span></a>`);
  }

  // -- panel --
  function copyBtn(value, label, blocked) {
    if (!value) return `<button type="button" class="button sm" disabled data-sp-copy-blocked title="${esc(blocked || 'contains control characters')}">${esc(label)} <span class="hint">(${esc(blocked || 'contains control characters')})</span></button>`;
    return `<button type="button" class="button sm" data-sp-copy="${esc(value)}">${icon('clipboard')}<span>${esc(label)}</span></button>`;
  }
  function cmdLine(command, label) {
    return `<span class="sp-cmd">${command ? `<code>${esc(command)}</code>` : ''}${copyBtn(command, label)}</span>`;
  }
  const qHref = patch => ctx.hrefFor({program: ctx.state.program, section: 'scope', query: buildQuery({...state(), ...patch})});
  const fileError = (d, name) => {
    const f = d.files?.[name];
    return f && !['ok', 'missing'].includes(f.state) ? `<p class="sp-file-error" data-sp-file-error="${esc(name)}">${icon('exclamation-circle')}<span><code>${esc(name)}</code> ${esc(f.state === 'too_large' ? 'is too large' : f.state === 'invalid' ? 'is not valid' : 'cannot be read')}: ${esc(f.error || f.state)}</span></p>` : '';
  };

  function paint(host) {
    const entry = cache.get(keyOf(host.dataset.family, host.dataset.program));
    if (!entry?.data) { host.innerHTML = `<div class="panel state">${entry?.error ? esc(entry.error) : 'Loading scope…'}</div>`; return; }
    const d = entry.data, s = state();
    const prevPolicy = host.querySelector('[data-sp-policy]');
    const program = host.dataset.program;
    const pull = pullCommand(program, d.copy_safe !== false);
    if (d.scope.state === 'none') {
      host.innerHTML = `<section class="panel panel-pad sp-empty" data-sp-state="none"><h2>No scope on file</h2><p class="hint">This program has no scope directory, so agents and the Board treat it as open scope. Pull the scope before testing if the program publishes one.</p>${cmdLine(pull, 'Copy pull command')}</section>`;
      return;
    }
    if (d.scope.state !== 'loaded') {
      host.innerHTML = `<section class="panel panel-pad sp-empty" data-sp-state="failed"><h2>Scope cannot be read</h2><p class="message warning">${esc(d.scope.reason)}</p></section>`;
      return;
    }
    const f = d.freshness || {};
    const pulledText = f.pulled_ts == null ? 'Scope pull time unknown' : `Scope last pulled ${ageText(f.age_days)}${f.estimated ? ' (estimated from the ' + f.source + ' time)' : ''}`;
    const failed = f.failed ? `<p class="sp-attempt" data-sp-attempt>${icon('exclamation-circle')}<span>Last pull attempt failed${f.last_attempt_at?.ts ? ' on ' + esc(fmtDate(f.last_attempt_at.ts)) : ''}${f.last_error ? ': ' + esc(f.last_error) : ''}</span></p>`
      : f.last_attempt_status && f.last_attempt_status !== 'ok' ? `<p class="hint" data-sp-attempt>Last attempt: ${esc(f.last_attempt_status.replace(/_/g, ' '))}${f.last_attempt_at?.ts ? ' on ' + esc(fmtDate(f.last_attempt_at.ts)) : ''}.</p>` : '';
    const banner = f.stale ? `<div class="message warning sp-stale" data-sp-stale role="status"><span>${f.pulled_ts == null ? 'Scope pull time is unknown.' : `Scope last pulled <strong>${esc(ageText(f.age_days))}</strong>.`} Programs change their scope often. An agent re-pulls it when it starts work on this program.</span>${cmdLine(pull, 'Copy re-pull command')}</div>` : '';
    const noInventory = d.inventory?.state !== 'ok' ? `<p class="sp-note" data-sp-no-inventory>${icon('info-circle')}<span>${d.inventory?.state === 'missing' ? 'No scope inventory yet, so apps, releases and changes are not tracked.' : 'The scope inventory cannot be used, so rules come from the text files.'} Backfill from saved files:</span>${cmdLine(rebuildCommand(program, d.copy_safe !== false), 'Copy backfill command')}</p>` : '';
    const rulesTotal = (d.rules?.in?.count || 0) + (d.rules?.out?.count || 0);
    const head = `<section class="panel panel-pad sp-head"><div class="blockhead"><div><h2>Scope</h2><p class="sp-fresh" data-sp-fresh title="${esc(f.pulled_at || '')}">${esc(pulledText)}${f.pulled_ts != null ? ` <span class="hint">(${esc(fmtDate(f.pulled_ts))})</span>` : ''}</p></div><div class="sp-head-meta">${f.platform ? `<span class="badge outline">${esc(f.platform)}</span>` : ''}<span class="badge outline">${esc(rulesTotal)} ${rulesTotal === 1 ? 'rule' : 'rules'}</span>${d.inventory?.state === 'ok' ? `<span class="badge outline">${esc(d.inventory.count)} items</span>` : ''}</div></div>${failed}${noInventory}${['scope-pull.json', 'scope-items.json'].map(n => fileError(d, n)).join('')}</section>`;
    host.innerHTML = `<div class="sp" data-sp-state="loaded">${banner}${head}${d.inventory?.state === 'ok' || (d.history?.entries || []).length ? `<div class="sp-grid"><div class="stack">${rulesHtml(d, s)}${policyHtml(d, s)}</div><div class="stack">${assetsHtml(d, s)}${releasesHtml(d)}${historyHtml(d, s)}</div></div>` : `<div class="sp-grid">${rulesHtml(d, s)}${policyHtml(d, s)}</div>`}</div>`;
    const policy = host.querySelector('[data-sp-policy]');
    if (policy) {
      if (prevPolicy) policy.scrollTop = prevPolicy.scrollTop;
      const toggle = host.querySelector('[data-sp-policy-toggle]');
      if (toggle) toggle.hidden = !s.policy && policy.scrollHeight <= policy.clientHeight + 4;
    }
  }

  function chips(list, cls, expanded, which) {
    const items = list?.items || [], shown = expanded ? items : items.slice(0, CHIP_CAP);
    const more = items.length - shown.length;
    return `<div class="sp-chips" data-sp-chips="${which}">${shown.map(v => `<code class="sp-chip ${cls}">${esc(v)}</code>`).join('')}${more > 0 ? `<button type="button" class="sp-chip sp-more" data-sp-more="${which}" aria-label="Show ${more} more rules">+${esc(more)} more</button>` : ''}${expanded && items.length > CHIP_CAP ? `<button type="button" class="sp-chip sp-more" data-sp-less>Show fewer</button>` : ''}${list?.truncated ? `<span class="hint">${esc(list.count - items.length)} more not shown</span>` : ''}</div>`;
  }
  function rulesHtml(d, s) {
    const r = d.rules || {};
    const source = r.source === 'inventory' ? 'from the scope inventory' : r.source === 'txt' ? 'from in-scope.txt and out-of-scope.txt' : '';
    const body = r.source === 'none' ? '<div class="state">No rules on file.</div>'
      : `<h3 class="sp-sub">In scope <span class="count">${esc(r.in.count)}</span></h3>${r.in.count ? chips(r.in, 'sp-in', s.rules, 'in') : '<p class="hint">None.</p>'}<h3 class="sp-sub">Out of scope <span class="count">${esc(r.out.count)}</span></h3>${r.out.count ? chips(r.out, 'sp-out', s.rules, 'out') : '<p class="hint">None.</p>'}`;
    return `<section class="panel panel-pad" aria-label="Checked automatically" data-sp-rules="${esc(r.source)}"><div class="sp-title"><h2>Checked automatically</h2><span class="hint">enforced by agents, ingest and this Board${source ? ', ' + source : ''}</span></div>${body}${fileError(d, 'in-scope.txt')}${fileError(d, 'out-of-scope.txt')}</section>`;
  }
  function policyHtml(d, s) {
    const err = fileError(d, 'program-policy.md');
    const body = d.policy ? `<div class="preview sp-policy${s.policy ? ' open' : ''}" data-sp-policy tabindex="0" aria-label="Program policy text">${ctx.markdown(d.policy.text)}</div><button type="button" class="link-button sp-policy-toggle" data-sp-policy-toggle aria-expanded="${s.policy}">${s.policy ? 'Show less' : 'Show the full policy'}</button>`
      : err ? '' : '<div class="state">No program policy on file.</div>';
    return `<section class="panel panel-pad" aria-label="Program policy"><div class="sp-title"><h2>Program policy</h2><span class="badge warning">read it yourself</span></div><p class="hint">Not machine-checked. Agents see it in their scope output before testing.</p>${body}${err}</section>`;
  }
  function inPill(value) {
    return value === true ? '<span class="badge success sp-pill">In</span>' : value === false ? '<span class="badge danger sp-pill">Out</span>' : '<span class="badge sp-pill">?</span>';
  }
  function laneLink(item) {
    if (item.lane) return `<a class="badge outline sp-lane" data-sp-lane href="${esc(ctx.hrefFor({program: item.lane.program, lane: item.lane.lane, section: 'findings'}))}">${esc(item.lane.program)}/${esc(item.lane.lane)} ${icon('angle-right')}</a>`;
    return ['android_app', 'ios_app', 'executable'].includes(item.kind) && item.in_scope !== false ? '<span class="badge outline sp-nolane">no lane yet</span>' : '';
  }
  function assetsHtml(d, s) {
    if (d.inventory?.state !== 'ok') return '';
    const all = d.assets || [], items = all.filter(i => matchesKind(i, s.kind));
    const filters = Object.entries(KIND_FILTER_LABELS).filter(([k]) => !k || all.some(i => matchesKind(i, k)))
      .map(([k, label]) => `<a href="${esc(qHref({kind: k}))}" class="sp-filter${s.kind === k ? ' active' : ''}" ${s.kind === k ? 'aria-current="true"' : ''}>${esc(label)}</a>`).join('');
    const rows = items.map(i => `<li class="sp-asset${i.in_scope === false ? ' sp-muted' : ''}" data-sp-asset="${esc(i.kind)}">${inPill(i.in_scope)}<div class="sp-asset-main"><strong>${esc(i.name || i.identifier)}</strong><span class="sp-mono">${esc(i.identifier)} · ${esc(KIND_LABELS[i.kind] || i.kind)}</span>${i.description ? `<span class="hint">${esc(i.description)}</span>` : ''}</div><div class="sp-asset-meta">${i.tier ? `<span class="badge outline">Tier ${esc(i.tier)}</span>` : ''}${laneLink(i)}</div></li>`).join('');
    return `<section class="panel panel-pad" aria-label="Other assets"><div class="sp-title"><h2>Other assets</h2><span class="hint">apps, executables, source code</span></div>${all.length > 1 ? `<nav class="sp-filters" aria-label="Asset kind">${filters}</nav>` : ''}${items.length ? `<ul class="sp-list">${rows}</ul>` : `<div class="state">${all.length ? 'No assets of this kind.' : 'No apps, executables or source code listed.'}</div>`}</section>`;
  }
  function releasesHtml(d) {
    if (d.inventory?.state !== 'ok') return '';
    const items = (d.assets || []).filter(i => i.release);
    if (!items.length) return '';
    const rows = items.map(i => {
      const r = i.release, changed = r.changed_at?.ts, checked = r.checked_at?.ts;
      const status = r.error ? `<span class="hint sp-err" data-sp-release-error>${esc(r.error)}</span>`
        : changed != null ? `<span class="badge accent" data-sp-release="changed">Release changed ${esc(fmtDate(changed))}</span>`
          : `<span class="hint" data-sp-release="same">No change since ${esc(checked != null ? fmtDate(checked) : 'the first check')}</span>`;
      return `<li class="sp-release" data-sp-release-row="${esc(i.kind)}"><div class="sp-asset-main"><strong>${esc(i.name || i.identifier)}</strong><span class="hint">${r.version ? `Version ${esc(r.version)}` : r.signal ? esc(r.signal) : ''}${r.previous_signal && changed != null ? ` (was ${esc(r.previous_signal)})` : ''}</span></div><div class="sp-asset-meta">${status}${r.lane_stale ? `<span class="badge warning" data-sp-lane-stale title="The release changed after the newest file in ${esc(i.lane?.program)}/${esc(i.lane?.lane)}">Lane may be stale</span>` : ''}</div></li>`;
    }).join('');
    return `<section class="panel panel-pad" aria-label="Releases"><div class="sp-title"><h2>Releases</h2><span class="badge info-badge">checked on scope pull</span></div><ul class="sp-list">${rows}</ul></section>`;
  }
  const diffName = e => e.name || e.key || '';
  const fieldVal = v => v === true ? 'in scope' : v === false ? 'out of scope' : v ?? 'none';
  function historyHtml(d, s) {
    if (d.inventory?.state !== 'ok' && !(d.history?.entries || []).length) return '';
    const all = d.history?.entries || [], entries = all.filter(e => entryHas(e, s.change));
    const filters = [['', 'All'], ...Object.entries(CHANGE_FILTERS)].map(([k, label]) => `<a href="${esc(qHref({change: k}))}" class="sp-filter${s.change === k ? ' active' : ''}" ${s.change === k ? 'aria-current="true"' : ''}>${esc(label)}</a>`).join('');
    const rows = entries.map(e => {
      const id = `${e.at?.text || ''}|${e.source || ''}`;
      const when = e.at?.ts != null ? fmtDate(e.at.ts) : e.at?.text || 'unknown time';
      if (e.state !== 'ok' || e.source === 'baseline') return `<li class="sp-change sp-muted" data-sp-change="${e.state !== 'ok' ? 'invalid' : 'baseline'}"><strong>${esc(e.state === 'ok' ? when : '')}</strong> <span>${esc(changeSummary(e))}</span></li>`;
      const lines = [
        ...e.added.map(a => `<li class="sp-add">+ ${esc(KIND_LABELS[a.kind] || a.kind || '')} ${esc(diffName(a))}${a.in_scope === false ? ' (out of scope)' : ''}</li>`),
        ...e.removed.map(a => `<li class="sp-del">- ${esc(KIND_LABELS[a.kind] || a.kind || '')} ${esc(diffName(a))}</li>`),
        ...e.changed.map(c => `<li class="sp-mod">~ ${esc(c.key)}: ${esc(c.field)} ${esc(fieldVal(c.from))} to ${esc(fieldVal(c.to))}</li>`),
        ...e.release_changed.map(r => `<li class="sp-rel">* release ${esc(diffName(r))}: ${esc(r.previous || 'none')} to ${esc(r.signal || 'none')}</li>`)];
      const hidden = ['added', 'removed', 'changed', 'release_changed'].reduce((n, k) => n + (e[k + '_count'] - e[k].length), 0);
      return `<li class="sp-change" data-sp-change="ok"><details data-sp-entry="${esc(id)}"${openEntries.has(id) ? ' open' : ''}><summary><strong>${esc(when)}</strong> <span>${esc(changeSummary(e))}</span>${e.source && e.source !== 'pull' ? ` <span class="badge outline">${esc(e.source)}</span>` : ''}</summary><ul class="sp-diff">${lines.join('')}${hidden > 0 ? `<li class="hint">${esc(hidden)} more not shown</li>` : ''}</ul></details></li>`;
    }).join('');
    return `<section class="panel panel-pad" aria-label="Scope changes"><div class="sp-title"><h2>Scope changes</h2><span class="hint">newest first, last ${esc(all.length)}</span></div>${all.length ? `<nav class="sp-filters" aria-label="Change type">${filters}</nav>` : ''}${entries.length ? `<ul class="sp-list">${rows}</ul>` : `<div class="state">${all.length ? 'No changes of this type in the recent log.' : 'No changes recorded yet.'}</div>`}${d.history?.more ? '<p class="hint">Older changes are in scope-history.jsonl.</p>' : ''}${fileError(d, 'scope-history.jsonl')}</section>`;
  }

  // -- events --
  function setQuery(patch) {
    ctx.state.scopeQuery = buildQuery({...state(), ...patch});
    const next = ctx.hrefFor({program: ctx.state.program, section: 'scope', query: ctx.state.scopeQuery});
    if (location.hash !== next) { try { history.replaceState(null, '', next); } catch {} }
    const host = ctx.app.querySelector('#scope-panel-host'); if (host) paint(host);
    ctx.app.querySelector('a[data-section="scope"]')?.setAttribute('href', next);
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
  function onClick(event) {
    if (!event.target.closest('#scope-panel-host')) return;
    const copy = event.target.closest('[data-sp-copy]');
    if (copy) { copyText(copy.dataset.spCopy); return; }
    if (event.target.closest('[data-sp-more]')) { setQuery({rules: true}); return; }
    if (event.target.closest('[data-sp-less]')) { setQuery({rules: false}); return; }
    if (event.target.closest('[data-sp-policy-toggle]')) { setQuery({policy: !state().policy}); return; }
    const filter = event.target.closest('a.sp-filter');
    if (filter && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      const q = parseQuery(filter.getAttribute('href').split('?')[1] || '');
      setQuery({kind: q.kind, change: q.change});
    }
  }
  function onToggle(event) {
    const entry = event.target.closest?.('[data-sp-entry]');
    if (!entry) return;
    if (entry.open) openEntries.add(entry.dataset.spEntry); else openEntries.delete(entry.dataset.spEntry);
  }
  function poll() {
    if (!ctx || document.hidden) return;
    const host = ctx.app.querySelector('#scope-panel-host');
    if (host) fetchScope(host.dataset.family, host.dataset.program, {quiet: true});
  }

  // Quiet refresh on demand (tests) and when the tab becomes visible again.
  root.BoardScopePanel = {...helpers, refresh: poll};
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  window.registerBoardModule({
    name: 'scope-panel',
    afterRender(context) {
      if (!ctx) {
        context.app.addEventListener('click', onClick);
        context.app.addEventListener('toggle', onToggle, true);
      }
      ctx = context;
      if (ctx.state.loading || ctx.state.view !== 'program') { clearInterval(timer); timer = 0; return; }
      const p = ctx.programs().find(x => String(x.id) === ctx.state.program);
      if (!p) return;
      const key = keyOf(p.family, p.name), entry = cache.get(key);
      const host = ctx.app.querySelector('#scope-panel-host');
      // Normalize the query (unknown keys and values dropped) without a history entry.
      if (host && (ctx.state.scopeQuery || '') !== buildQuery(state())) setQuery({});
      else if (host) paint(host);
      badge();
      if (!entry || (!entry.loading && Date.now() - (entry.at || 0) > POLL_MS)) fetchScope(p.family, p.name, {quiet: !!entry?.data});
      if (host && !timer) timer = setInterval(poll, POLL_MS);
      if (!host && timer) { clearInterval(timer); timer = 0; }
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
