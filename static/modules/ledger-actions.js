/* Ledger actions module (feat/board-ledger-actions).
 *
 * Adds to the Findings ledger: severity/date sorting and a date filter, a
 * per-row Actions menu (change class, record submission state, move to
 * Gadgets/MapStore), drag-and-drop onto the Gadgets/MapStore section targets,
 * an Add finding form, and class review from the dashboard class breakdown.
 *
 * Every write goes through a backend endpoint that runs a supported BBH
 * command. Unsupported actions stay visible but disabled with a reason; this
 * module never simulates a successful write.
 */
(() => {
  'use strict';
  const SEVERITY_ORDER = ['EXCEPTIONAL', 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO', 'N/A', 'UNKNOWN'];
  const SEVERITY_ALIASES = {INFORMATIONAL: 'INFO', NA: 'N/A', 'N/A': 'N/A', NONE: 'N/A', 'NOT APPLICABLE': 'N/A'};
  const SEVERITY_LABELS = {INFO: 'Informational (INFO)', 'N/A': 'N/A', UNKNOWN: 'Unknown'};
  const CLASS_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,99}$/;
  const SORTS = [
    ['', 'Ledger order'],
    ['severity-desc', 'Severity, highest first'],
    ['severity-asc', 'Severity, lowest first'],
    ['first-desc', 'First seen, newest first'],
    ['first-asc', 'First seen, oldest first'],
    ['last-desc', 'Last seen, newest first'],
  ];
  const DATE_FILTERS = [['', 'Any date'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['older90', 'Older than 90 days'], ['none', 'No date recorded']];
  const STATE_LABELS = {not_submitted: 'Not submitted', submitted: 'Submitted', dropped: 'Dropped'};
  const RESULT_LABELS = {valid: 'Valid', duplicate: 'Duplicate'};
  const DESTINATIONS = {gadgets: 'Gadgets', map: 'MapStore'};
  const view = {sort: '', date: ''};
  let ctx = null;
  let busy = false;

  const severityKey = value => {
    const text = String(value ?? '').trim().toUpperCase();
    if (!text) return 'UNKNOWN';
    const key = SEVERITY_ALIASES[text] || text;
    return SEVERITY_ORDER.includes(key) ? key : 'UNKNOWN';
  };
  const severityRank = value => SEVERITY_ORDER.indexOf(severityKey(value));
  const time = value => { const t = Date.parse(value ?? ''); return Number.isFinite(t) ? t : null; };
  const dateCompare = (field, direction) => (a, b) => {
    const x = time(a[field]), y = time(b[field]);
    if (x === y) return 0; if (x === null) return 1; if (y === null) return -1;
    return direction * (x - y);
  };
  const COMPARE = {
    'severity-desc': (a, b) => severityRank(a.severity) - severityRank(b.severity),
    'severity-asc': (a, b) => severityRank(b.severity) - severityRank(a.severity),
    'first-desc': dateCompare('first_seen', -1),
    'first-asc': dateCompare('first_seen', 1),
    'last-desc': dateCompare('last_seen', -1),
  };
  function dateFilter(row) {
    if (!view.date) return true;
    const t = time(row.first_seen);
    if (view.date === 'none') return t === null;
    if (t === null) return false;
    const age = (Date.now() - t) / 86400000;
    return view.date === 'older90' ? age > 90 : age <= Number(view.date);
  }
  // After a verified write the server returns {fid: [oldRevision, newRevision]}
  // for entries its write left unchanged (BBH rewrites the whole ledger file).
  // Roll a sibling row forward only if it holds exactly the old revision.
  function rebase(row, revisions) {
    if (!row || !revisions || typeof revisions !== 'object' || !ctx) return;
    const lane = ctx.programs().flatMap(p => Array.isArray(p.lanes) ? p.lanes : []).find(l => Array.isArray(l.findings) && l.findings.includes(row));
    for (const other of lane?.findings || []) {
      const pair = revisions[other.id];
      if (other !== row && Array.isArray(pair) && pair.length === 2 && pair[0] === other.metadata_revision && /^[a-f0-9]{64}$/.test(pair[1])) other.metadata_revision = pair[1];
    }
  }
  // Consumed by app.js findings(): stable sort, so ties keep ledger order.
  window.BoardFindingView = {
    filter: row => dateFilter(row),
    get compare() { return COMPARE[view.sort] || null; },
    rebase,
  };

  // ---------------------------------------------------------------- helpers
  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === false || value == null) continue;
      if (key === 'text') node.textContent = value;
      else if (key === 'className') node.className = value;
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat()) if (child != null) node.append(child);
    return node;
  };
  const caps = () => ctx?.state?.data?.capabilities?.ledger_actions || null;
  const metadataCap = () => ctx?.api?.capability(ctx.state.data, 'findingMetadata');
  const classWritable = () => !!metadataCap()?.textFields?.includes('class');
  const rootInstance = () => /^[a-f0-9]{64}$/.test(ctx?.state?.data?.root_instance || '') ? ctx.state.data.root_instance : null;
  const failure = error => ({
    finding_changed: 'Conflict: the finding changed since it was loaded. Refresh and review before retrying.',
    root_changed: 'Conflict: the source root changed. Refresh before retrying.',
    finding_not_found: 'The finding is no longer available. Refresh.',
    not_added: 'BBH did not add a new finding; it may match an existing one. Refresh and review.',
    writer_unavailable: 'The BBH writer is unavailable. Refresh before retrying.',
    reclassify_unsupported: 'Not supported by BBH yet.',
    already_reclassified: 'A MapStore entry for this finding already exists. Refresh and review it.',
    unsafe_writer_tree: 'The source tree is not safe for the writer. Refresh and inspect it.',
    invalid_ledger_action: 'The request was rejected as invalid.',
  }[error?.code] || 'Update failed or was not verified. Refresh before retrying.');

  async function post(url, body) {
    const response = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Requested-With': 'Bounty-Board'}, body: JSON.stringify(body)});
    let payload = null; try { payload = await response.json(); } catch {}
    if (!response.ok) { const error = new Error(`Request failed (${response.status})`); error.status = response.status; error.code = payload?.error; throw error; }
    return payload;
  }
  const normalized = finding => ({...finding, id: finding.fid, class: finding.class_name});

  // Every loaded finding with the location needed to write it.
  function allFindings() {
    const out = [];
    for (const program of ctx.programs()) for (const lane of Array.isArray(program.lanes) ? program.lanes : [])
      for (const row of Array.isArray(lane.findings) ? lane.findings : []) out.push({program, lane, row});
    return out;
  }
  const knownClasses = () => [...new Set(allFindings().map(({row}) => row.class).filter(v => typeof v === 'string' && v))].sort();
  const currentEntry = id => {
    const program = ctx.currentProgram(), lane = ctx.currentLane();
    const row = (Array.isArray(lane?.findings) ? lane.findings : []).find(r => String(r.id) === String(id));
    return row ? {program, lane, row} : null;
  };
  const location = ({program, lane, row}) => ({family: program.family, program: program.name, lane: lane.name, fid: String(row.id)});
  const label = ({row}) => String(row.title || row.id || 'finding');

  // Writes hold the app's metadata lock so Refresh and other edits wait.
  async function exclusive(task) {
    if (busy || ctx.state.metadataPending) throw Object.assign(new Error('busy'), {code: 'busy'});
    busy = true; ctx.state.metadataPending = true; ctx.render();
    try { return await task(); }
    finally { busy = false; ctx.state.metadataPending = false; }
  }

  // ---------------------------------------------------------------- dialogs
  function dialog(title, describedBy) {
    document.querySelector('dialog.ledger-dialog')?.remove();
    const heading = el('h2', {id: 'ledger-dialog-title', text: title});
    const node = el('dialog', {className: 'ledger-dialog panel', 'aria-labelledby': 'ledger-dialog-title', ...(describedBy ? {'aria-describedby': describedBy} : {})}, heading);
    node.addEventListener('close', () => node.remove());
    document.body.append(node);
    return node;
  }
  const status = () => el('div', {className: 'ledger-status', role: 'status', 'aria-live': 'polite'});
  const show = (box, text, kind = '') => { box.className = `ledger-status${kind ? ` message ${kind}` : ''}`; box.textContent = text; };
  const closeButton = (node, text = 'Cancel') => { const b = el('button', {type: 'button', className: 'button subtle', text}); b.addEventListener('click', () => node.close()); return b; };

  // Searchable class combobox (ARIA 1.2 pattern). Free text is allowed when
  // it is a valid BBH class identifier; existing classes are suggested.
  function classPicker(id, initial, onPick) {
    const classes = knownClasses();
    const wrap = el('div', {className: 'ledger-combobox'});
    const input = el('input', {id, role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': `${id}-list`, autocomplete: 'off', spellcheck: 'false', value: initial || ''});
    const listbox = el('ul', {id: `${id}-list`, role: 'listbox', className: 'ledger-options', hidden: true, 'aria-label': 'Existing classes'});
    const hint = el('p', {className: 'hint', id: `${id}-hint`});
    input.setAttribute('aria-describedby', `${id}-hint`);
    let active = -1, options = [];
    const update = () => {
      const query = input.value.trim().toLowerCase();
      options = classes.filter(c => c.includes(query)).slice(0, 50);
      listbox.replaceChildren(...options.map((c, i) => {
        const count = allFindings().filter(({row}) => row.class === c).length;
        const li = el('li', {role: 'option', id: `${id}-opt-${i}`, 'aria-selected': i === active ? 'true' : 'false', 'data-value': c}, el('span', {text: c}), el('span', {className: 'muted', text: ` ${count}`}));
        li.addEventListener('mousedown', event => { event.preventDefault(); choose(c); });
        return li;
      }));
      const open = options.length > 0 && document.activeElement === input;
      listbox.hidden = !open; input.setAttribute('aria-expanded', String(open));
      if (active >= 0 && options[active]) input.setAttribute('aria-activedescendant', `${id}-opt-${active}`); else input.removeAttribute('aria-activedescendant');
      const value = input.value.trim();
      hint.textContent = !value ? 'Type to search existing classes.' : !CLASS_PATTERN.test(value) ? 'Use lowercase letters, digits, dot, dash or underscore.' : classes.includes(value) ? 'Existing class.' : 'New class; it will be created on save.';
      onPick?.(value, CLASS_PATTERN.test(value));
    };
    const choose = value => { input.value = value; active = -1; update(); listbox.hidden = true; input.setAttribute('aria-expanded', 'false'); };
    input.addEventListener('input', () => { active = -1; update(); });
    input.addEventListener('focus', update);
    input.addEventListener('blur', () => { listbox.hidden = true; input.setAttribute('aria-expanded', 'false'); });
    input.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); if (!options.length) return;
        active = event.key === 'ArrowDown' ? (active + 1) % options.length : (active <= 0 ? options.length - 1 : active - 1); update();
      } else if (event.key === 'Enter' && active >= 0 && options[active]) { event.preventDefault(); choose(options[active]); }
      else if (event.key === 'Escape' && !listbox.hidden) { event.preventDefault(); event.stopPropagation(); listbox.hidden = true; input.setAttribute('aria-expanded', 'false'); }
    });
    wrap.append(input, listbox, hint);
    queueMicrotask(update);
    return {wrap, input};
  }

  async function writeClass(entry, value) {
    const {row} = entry, where = location(entry);
    const response = await ctx.api.write(ctx.state.data, 'findingMetadata', {programId: entry.program.id, program: where.program, family: where.family, lane: where.lane, findingId: where.fid, field: 'class', value, expectedRevision: row.metadata_revision, rootInstance: ctx.state.data?.root_instance});
    if (response?.value !== value) throw new Error('Unverified value');
    row.class = response.value; row.class_name = response.value; row.metadata_revision = response.revision;
    rebase(row, response.revisions);
  }

  function openClassDialog(entry) {
    const node = dialog(`Change class: ${label(entry)}`);
    const box = status();
    let valid = false;
    const save = el('button', {type: 'button', className: 'button', text: 'Save class', disabled: true});
    const picker = classPicker('ledger-class-input', entry.row.class || '', (value, ok) => { valid = ok && value !== entry.row.class; save.disabled = !valid || busy; });
    const writable = classWritable() && entry.row.id != null;
    node.append(
      el('p', {className: 'hint', text: `${entry.program.name} / ${entry.lane.name} / ${entry.row.id}. Current class: ${entry.row.class || 'not recorded'}. Class is separate from severity.`}),
      el('label', {for: 'ledger-class-input', text: 'Class'}), picker.wrap,
      writable ? null : el('p', {className: 'message warning', text: 'Class editing is unavailable: the backend has not enabled the BBH writer.'}),
      box, el('div', {className: 'ledger-dialog-actions'}, save, closeButton(node)));
    if (!writable) { save.disabled = true; picker.input.disabled = true; }
    save.addEventListener('click', async () => {
      const value = picker.input.value.trim(); if (!valid) return;
      save.disabled = true; show(box, 'Saving class through BBH; waiting for confirmation.');
      try { await exclusive(() => writeClass(entry, value)); show(box, `Saved. Class is now ${value}.`, 'success'); ctx.render(); }
      catch (error) { show(box, `${error.code === 'busy' ? 'Another update is in progress.' : failure(error)} Pending value: ${value}`, 'warning'); save.disabled = false; ctx.render(); }
    });
    node.showModal(); picker.input.focus();
  }

  function openSubmissionDialog(entry) {
    const cap = caps()?.submission;
    const current = entry.row.submission && typeof entry.row.submission === 'object' ? entry.row.submission : {};
    const node = dialog(`Submission state: ${label(entry)}`, 'ledger-submission-note');
    const box = status();
    const stateSelect = el('select', {id: 'ledger-submission-state'}, ...(cap?.states || Object.keys(STATE_LABELS)).map(s => el('option', {value: s, text: STATE_LABELS[s] || s, selected: s === (current.state || 'not_submitted')})));
    const results = cap?.results || Object.keys(RESULT_LABELS);
    const resultSelect = el('select', {id: 'ledger-submission-result'},
      el('option', {value: '', text: current.result ? `Keep recorded result (${RESULT_LABELS[current.result] || current.result})` : 'Not known yet'}),
      ...results.map(r => el('option', {value: r, text: RESULT_LABELS[r] || r, selected: false})));
    const report = el('input', {id: 'ledger-submission-report', maxlength: '200', placeholder: 'Optional, for example a report number', value: ''});
    const confirm = el('input', {type: 'checkbox', id: 'ledger-submission-confirm'});
    const save = el('button', {type: 'button', className: 'button', text: 'Record state', disabled: true});
    const enabled = !!cap?.enabled && rootInstance() && entry.row.metadata_revision;
    node.append(
      el('p', {className: 'message warning', id: 'ledger-submission-note', text: 'This records local state in the ledger only. It does not submit or send anything to a platform.'}),
      el('p', {className: 'hint', text: `Recorded now: ${STATE_LABELS[current.state] || current.state || 'not recorded'}${current.result ? `, result ${current.result}` : ''}${current.report ? `, reference ${current.report}` : ''}. BBH cannot clear a recorded result.`}),
      el('div', {className: 'ledger-form'},
        el('label', {for: 'ledger-submission-state', text: 'Submission state'}), stateSelect,
        el('label', {for: 'ledger-submission-result', text: 'Platform result'}), resultSelect,
        el('label', {for: 'ledger-submission-report', text: 'Report reference'}), report),
      el('label', {className: 'ledger-check'}, confirm, ' I understand this only records local state.'),
      enabled ? null : el('p', {className: 'message warning', text: 'Recording submission state is unavailable: the backend has not enabled a BBH writer that supports it.'}),
      box, el('div', {className: 'ledger-dialog-actions'}, save, closeButton(node)));
    const sync = () => { save.disabled = !enabled || !confirm.checked || busy; };
    confirm.addEventListener('change', sync); sync();
    save.addEventListener('click', async () => {
      const submission = {state: stateSelect.value, ...(resultSelect.value ? {result: resultSelect.value} : {}), ...(report.value.trim() ? {report: report.value.trim()} : {})};
      save.disabled = true; show(box, 'Recording state through BBH; waiting for confirmation.');
      try {
        const result = await exclusive(() => post('/api/finding/submission', {...location(entry), expected_revision: entry.row.metadata_revision, root_instance: rootInstance(), submission}));
        if (result?.finding?.fid !== entry.row.id) throw new Error('Unverified finding');
        Object.assign(entry.row, normalized(result.finding)); rebase(entry.row, result.revisions);
        const saved = entry.row.submission || {};
        show(box, `Recorded locally: ${STATE_LABELS[saved.state] || saved.state}${saved.result ? `, result ${saved.result}` : ''}. Nothing was sent to a platform.`, 'success');
        ctx.render();
      } catch (error) { show(box, `${error.code === 'busy' ? 'Another update is in progress.' : failure(error)} Your choice is still selected here.`, 'warning'); sync(); ctx.render(); }
    });
    node.showModal(); stateSelect.focus();
  }

  const slug = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  const CHAIN = [['ready', 'Ready: keep in synthesis'], ['deferred', 'Deferred: revisit on chain_watch'], ['watch', 'Watch: wake on a named condition']];
  const RESIDUAL = ['reachability', 'format', 'enforcement-point', 'trust-anchor', 'oracle', 'capability'];

  function openMoveDialog(entry, destination) {
    const cap = caps()?.reclassify?.[destination];
    const name = DESTINATIONS[destination];
    const row = entry.row;
    const node = dialog(`Move to ${name}: ${label(entry)}`, 'ledger-move-preview');
    const box = status();
    const field = (id, text, input, help) => [el('label', {for: id, text}), help ? el('div', {}, input, el('p', {className: 'hint', text: help})) : input];
    const input = (id, value, attrs = {}) => el('input', {id, value: value ?? '', ...attrs});
    const title = input('ledger-move-title', row.title || row.id, {maxlength: '200'});
    const surface = input('ledger-move-surface', slug(row.class) || 'ledger', {maxlength: '64'});
    const tags = input('ledger-move-tags', '', {placeholder: 'Optional, comma separated'});
    const note = el('textarea', {id: 'ledger-move-note', rows: '3', maxlength: '4000', placeholder: 'Optional context for future agents'});
    const archive = el('input', {type: 'checkbox', id: 'ledger-move-archive'});
    const fields = [
      ...field('ledger-move-title', 'Title', title),
      ...field('ledger-move-surface', 'Surface', surface, 'MapStore surface, for example xss or auth.'),
      ...field('ledger-move-tags', 'Extra tags', tags),
      ...field('ledger-move-note', 'Note', note),
    ];
    const gadget = {};
    if (destination === 'gadgets') {
      gadget.tier = el('select', {id: 'ledger-move-tier'}, el('option', {value: 'confirmed', text: 'Confirmed gadget'}), el('option', {value: 'residual', text: 'Residual (tags gadget, residual)'}));
      gadget.grants = input('ledger-cap-grants', '', {maxlength: '300', placeholder: 'Access or effect this primitive gives'});
      gadget.requires = input('ledger-cap-requires', '', {maxlength: '300', placeholder: 'Preconditions, auth state, user interaction'});
      gadget.crosses = input('ledger-cap-crosses', '', {maxlength: '300', placeholder: 'For example client->server'});
      gadget.crosses_detail = input('ledger-cap-crosses-detail', '', {maxlength: '300', placeholder: 'Optional'});
      gadget.chain_status = el('select', {id: 'ledger-cap-chain'}, ...CHAIN.map(([v, t]) => el('option', {value: v, text: t, selected: v === 'deferred'})));
      gadget.chain_watch = input('ledger-cap-watch', '', {maxlength: '300', placeholder: 'What should wake this gadget'});
      gadget.residual_class = el('select', {id: 'ledger-cap-residual'}, ...RESIDUAL.map(v => el('option', {value: v, text: v})));
      gadget.disclosed_by = input('ledger-cap-disclosed', '', {maxlength: '300', placeholder: 'Defended control and what it enforced'});
      gadget.composes_with = input('ledger-cap-composes', 'none known', {maxlength: '300'});
      fields.push(...field('ledger-move-tier', 'Gadget tier', gadget.tier),
        ...field('ledger-cap-grants', 'Grants', gadget.grants), ...field('ledger-cap-requires', 'Requires', gadget.requires),
        ...field('ledger-cap-crosses', 'Crosses', gadget.crosses), ...field('ledger-cap-crosses-detail', 'Crosses detail', gadget.crosses_detail),
        ...field('ledger-cap-chain', 'Chain status', gadget.chain_status), ...field('ledger-cap-watch', 'Chain watch', gadget.chain_watch));
      const residualRows = [...field('ledger-cap-residual', 'Residual class', gadget.residual_class), ...field('ledger-cap-disclosed', 'Disclosed by', gadget.disclosed_by), ...field('ledger-cap-composes', 'Composes with', gadget.composes_with)];
      residualRows.forEach(n => n.classList.add('ledger-residual'));
      fields.push(...residualRows);
    }
    const form = el('div', {className: 'ledger-form'}, ...fields);
    const preview = el('div', {id: 'ledger-move-preview'});
    const confirm = el('button', {type: 'button', className: 'button', text: `Move to ${name}`, disabled: true, 'aria-describedby': 'ledger-move-reason'});
    const reason = el('p', {className: 'message warning', id: 'ledger-move-reason'});
    const dl = pairs => el('dl', {className: 'ledger-preview'}, ...pairs.flatMap(([k, v]) => [el('dt', {text: k}), el('dd', {className: 'record-value', text: v || 'Not recorded'})]));
    const tagList = () => tags.value.split(',').map(t => slug(t)).filter(Boolean);
    const residual = () => gadget.tier?.value === 'residual';
    const details = () => {
      const out = {title: title.value.trim(), surface: surface.value.trim(), note: note.value, tags: tagList(), archive_original: archive.checked};
      if (destination === 'gadgets') {
        out.tier = gadget.tier.value;
        const keys = ['grants', 'requires', 'crosses', 'crosses_detail', 'chain_status', 'chain_watch', ...(residual() ? ['residual_class', 'disclosed_by', 'composes_with'] : [])];
        out.capability = Object.fromEntries(keys.map(k => [k, gadget[k].value.trim()]));
      }
      return out;
    };
    const problem = () => {
      const d = details();
      if (d.title.length < 3) return 'Enter a title of at least 3 characters.';
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(d.surface)) return 'Surface must be lowercase letters, digits, dash or underscore.';
      if (d.tags.some(t => t === 'gadget' || t === 'residual' || t.startsWith('finding-'))) return 'Extra tags cannot be gadget, residual or finding-*; they are set for you.';
      if (destination === 'gadgets') {
        const missing = ['grants', 'requires', 'crosses', ...(residual() ? ['disclosed_by', 'composes_with'] : [])].filter(k => !d.capability[k]);
        if (missing.length) return `Gadgets need a capability block. Fill in: ${missing.join(', ').replace(/_/g, ' ')}.`;
      }
      return '';
    };
    const refresh = () => {
      const d = details();
      document.querySelectorAll('.ledger-residual').forEach(n => { n.hidden = !residual(); });
      const storeTags = [...(destination === 'gadgets' ? ['gadget', ...(residual() ? ['residual'] : [])] : []), `finding-${String(row.id).toLowerCase()}`, 'from-ledger', ...d.tags];
      preview.replaceChildren(
        el('h3', {text: 'Would create'}),
        dl([['Store', destination === 'gadgets' ? 'MapStore entry tagged gadget (shown under Gadgets)' : 'MapStore observation'], ['Title', d.title], ['Location', `recon/maps/${d.surface || '?'}/_surface/…`], ['Tags', storeTags.join(', ')], ['Provenance', `${row.id} in ${entry.program.name} / ${entry.lane.name}; class ${row.class || 'not recorded'}; evidence ${row.evidence_path || row.report_dir || 'not recorded'}`]]),
        el('h3', {text: 'What happens to the original'}),
        dl([['Ledger entry', `Kept. ${row.id} stays in the ledger with its evidence, report files and history.`], ['Review notes', 'A line pointing to the new entry is appended.'], ['Status', archive.checked ? `Set to archive (now ${row.status || 'not recorded'}).` : `Unchanged (${row.status || 'not recorded'}).`], ['Severity', `${row.severity || 'Unknown'} stays on the finding. Severity and classification are separate.`]]));
      const issue = problem();
      reason.textContent = !cap?.enabled ? (cap?.reason || 'Not supported by BBH yet.') : issue || 'Ready. Runs BBH map_store write, then annotates the finding.';
      reason.className = `message${!cap?.enabled || issue ? ' warning' : ''}`;
      confirm.disabled = !cap?.enabled || !!issue || busy || !rootInstance() || !row.metadata_revision;
    };
    node.append(form, el('label', {className: 'ledger-check'}, archive, ' Also set the finding status to archive'), preview, reason, box,
      el('div', {className: 'ledger-dialog-actions'}, confirm, closeButton(node, 'Close')));
    node.addEventListener('input', refresh); node.addEventListener('change', refresh);
    confirm.addEventListener('click', async () => {
      if (problem()) return;
      confirm.disabled = true; show(box, `Creating the ${name} entry through BBH; waiting for confirmation.`);
      try {
        const result = await exclusive(() => post('/api/finding/reclassify', {...location(entry), expected_revision: row.metadata_revision, root_instance: rootInstance(), destination, details: details()}));
        if (result?.finding?.fid !== row.id || !result?.map_entry?.path) throw new Error('Unverified result');
        Object.assign(row, normalized(result.finding)); rebase(row, result.revisions);
        const lane = entry.lane;
        if (Array.isArray(lane.map)) lane.map.push(result.map_entry);
        if (Array.isArray(lane.gadgets) && (result.map_entry.tags || []).includes('gadget')) lane.gadgets.push(result.map_entry);
        show(box, `Created ${name} entry recon/maps/${result.map_entry.path}. The finding and its evidence were kept.`, 'success');
        ctx.render();
      } catch (error) {
        const partial = error.code === 'partial_reclassify';
        show(box, partial ? 'The MapStore entry was created, but the finding changed and was not annotated. Refresh and review.' : `${error.code === 'busy' ? 'Another update is in progress.' : failure(error)} Your entries are still in this form.`, 'warning');
        refresh(); ctx.render();
      }
    });
    refresh();
    node.showModal(); title.focus();
  }

  function openAddDialog() {
    const cap = caps()?.add_finding, program = ctx.currentProgram(), lane = ctx.currentLane();
    const node = dialog(`Add finding to ${program?.name || 'program'} / ${lane?.name || 'lane'}`);
    const box = status();
    let classOk = false;
    const title = el('input', {id: 'ledger-add-title', maxlength: '200', required: true});
    const severities = metadataCap()?.options?.severity || SEVERITY_ORDER.filter(s => s !== 'N/A');
    const severity = el('select', {id: 'ledger-add-severity'}, ...severities.map(s => el('option', {value: s, text: SEVERITY_LABELS[s] || s, selected: s === 'UNKNOWN'})));
    const file = el('input', {id: 'ledger-add-file', maxlength: '300', placeholder: 'Affected file, asset or route', required: true});
    const description = el('textarea', {id: 'ledger-add-description', rows: '3', maxlength: '2000', placeholder: 'One paragraph', required: true});
    const save = el('button', {type: 'button', className: 'button', text: 'Add finding', disabled: true});
    const picker = classPicker('ledger-add-class', '', (_value, ok) => { classOk = ok; sync(); });
    const enabled = !!cap?.enabled && rootInstance() && program && lane;
    const sync = () => { save.disabled = !enabled || busy || !classOk || title.value.trim().length < 3 || !file.value.trim() || !description.value.trim(); };
    for (const field of [title, file, description]) field.addEventListener('input', sync);
    node.append(
      el('p', {className: 'hint', text: 'BBH records the finding with a new ID and an evidence packet. Title, class, file and description are required. BBH skips a note that matches an existing finding.'}),
      el('div', {className: 'ledger-form'},
        el('label', {for: 'ledger-add-title', text: 'Title'}), title,
        el('label', {for: 'ledger-add-class', text: 'Class'}), picker.wrap,
        el('label', {for: 'ledger-add-severity', text: 'Severity'}), severity,
        el('label', {for: 'ledger-add-file', text: 'File or asset'}), file,
        el('label', {for: 'ledger-add-description', text: 'Description'}), description),
      enabled ? null : el('p', {className: 'message warning', text: 'Adding findings is unavailable: the backend has not enabled a BBH writer that supports it.'}),
      box, el('div', {className: 'ledger-dialog-actions'}, save, closeButton(node)));
    sync();
    save.addEventListener('click', async () => {
      const finding = {title: title.value.trim(), class_name: picker.input.value.trim(), severity: severity.value, file: file.value.trim(), description: description.value.replace(/\s+/g, ' ').trim()};
      save.disabled = true; show(box, 'Adding through BBH; waiting for confirmation.');
      try {
        const result = await exclusive(() => post('/api/finding/new', {family: program.family, program: program.name, lane: lane.name, root_instance: rootInstance(), finding}));
        if (!result?.finding?.fid) throw new Error('Unverified finding');
        if (Array.isArray(lane.findings)) { const added = normalized(result.finding); lane.findings.push(added); rebase(added, result.revisions); }
        show(box, `Added ${result.finding.fid}.`, 'success'); ctx.render();
      } catch (error) { show(box, `${error.code === 'busy' ? 'Another update is in progress.' : failure(error)} Your entries are still in this form.`, 'warning'); sync(); ctx.render(); }
    });
    node.showModal(); title.focus();
  }

  // Review and bulk-reclassify every loaded finding in one class.
  function openClassReview(className) {
    const node = dialog(`Class: ${className}`);
    const box = status();
    const entries = allFindings().filter(({row}) => row.class === className);
    const writable = classWritable();
    let target = '', valid = false;
    const apply = el('button', {type: 'button', className: 'button', text: 'Move selected', disabled: true});
    const picker = classPicker('ledger-review-class', '', (value, ok) => { target = value; valid = ok && value !== className; sync(); });
    const checks = entries.map((entry, i) => el('input', {type: 'checkbox', id: `ledger-review-${i}`, checked: true, disabled: !writable || entry.row.id == null}));
    const sync = () => { apply.disabled = !writable || busy || !valid || !checks.some(c => c.checked && !c.disabled); };
    checks.forEach(c => c.addEventListener('change', sync));
    const list = el('ul', {className: 'ledger-review-list'}, ...entries.map((entry, i) => el('li', {},
      checks[i], el('label', {for: `ledger-review-${i}`}, el('strong', {text: label(entry)}), el('span', {className: 'id', text: `${entry.program.name} / ${entry.lane.name} / ${entry.row.id ?? 'ID unavailable'} · ${entry.row.severity || 'Unknown'}`})))));
    node.append(
      el('p', {className: 'hint', text: `${entries.length} loaded findings in this class. Each change runs a separate BBH edit for that finding.`}),
      list, el('label', {for: 'ledger-review-class', text: 'New class for selected findings'}), picker.wrap,
      writable ? null : el('p', {className: 'message warning', text: 'Class editing is unavailable: the backend has not enabled the BBH writer.'}),
      box, el('div', {className: 'ledger-dialog-actions'}, apply, closeButton(node, 'Close')));
    if (!writable) picker.input.disabled = true;
    apply.addEventListener('click', async () => {
      const chosen = entries.filter((_, i) => checks[i].checked && !checks[i].disabled), value = target;
      apply.disabled = true; let done = 0; const failed = [];
      try {
        await exclusive(async () => {
          for (const entry of chosen) {
            show(box, `Saving ${done + failed.length + 1} of ${chosen.length} through BBH.`);
            try { await writeClass(entry, value); done++; }
            catch (error) { failed.push(`${entry.row.id}: ${failure(error)}`); if (error.code === 'writer_unavailable' || error.status === 502 || error.status === 503) break; }
          }
        });
      } catch (error) { failed.push(error.code === 'busy' ? 'Another update is in progress.' : failure(error)); }
      checks.forEach((c, i) => { if (entries[i].row.class !== className) { c.checked = false; c.disabled = true; } });
      show(box, `Moved ${done} of ${chosen.length} to ${value}.${failed.length ? ` Not moved: ${failed.join(' ')}` : ''}`, failed.length ? 'warning' : 'success');
      sync(); ctx.render();
    });
    sync(); node.showModal(); picker.input.focus();
  }

  // ---------------------------------------------------------------- row menu
  function closeMenus() { document.querySelectorAll('.ledger-menu').forEach(m => m.remove()); document.querySelectorAll('[data-ledger-menu][aria-expanded="true"]').forEach(b => b.setAttribute('aria-expanded', 'false')); }
  function openMenu(button) {
    closeMenus();
    const entry = currentEntry(button.dataset.ledgerMenu); if (!entry) return;
    const items = [['class', 'Change class…'], ['submission', 'Set submission state…'], ['gadgets', 'Move to Gadgets…'], ['map', 'Move to MapStore…']];
    const menu = el('div', {className: 'ledger-menu panel', role: 'menu', 'aria-label': `Actions for ${label(entry)}`},
      ...items.map(([action, text]) => el('button', {type: 'button', role: 'menuitem', tabindex: '-1', 'data-ledger-item': action, text})));
    button.setAttribute('aria-expanded', 'true');
    button.after(menu);
    const buttons = [...menu.querySelectorAll('[role=menuitem]')];
    buttons[0].focus();
    menu.addEventListener('keydown', event => {
      const i = buttons.indexOf(document.activeElement);
      if (event.key === 'ArrowDown') { event.preventDefault(); buttons[(i + 1) % buttons.length].focus(); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); buttons[(i - 1 + buttons.length) % buttons.length].focus(); }
      else if (event.key === 'Home') { event.preventDefault(); buttons[0].focus(); }
      else if (event.key === 'End') { event.preventDefault(); buttons.at(-1).focus(); }
      else if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') event.preventDefault(); closeMenus(); if (event.key === 'Escape') button.focus(); }
    });
    menu.addEventListener('click', event => {
      const item = event.target.closest('[data-ledger-item]'); if (!item) return;
      closeMenus();
      const action = item.dataset.ledgerItem;
      if (action === 'class') openClassDialog(entry);
      else if (action === 'submission') openSubmissionDialog(entry);
      else openMoveDialog(entry, action);
    });
  }

  document.addEventListener('click', event => {
    const menuButton = event.target.closest('[data-ledger-menu]');
    if (menuButton) { event.stopPropagation(); if (menuButton.getAttribute('aria-expanded') === 'true') closeMenus(); else openMenu(menuButton); return; }
    if (!event.target.closest('.ledger-menu')) closeMenus();
    if (event.target.closest('[data-ledger-add]')) openAddDialog();
    const review = event.target.closest('[data-ledger-class-review]');
    if (review) openClassReview(review.dataset.ledgerClassReview);
  }, true);
  document.addEventListener('change', event => {
    const target = event.target;
    if (target.id === 'ledger-sort' || target.id === 'ledger-date') {
      view[target.id === 'ledger-sort' ? 'sort' : 'date'] = target.value;
      ctx?.render(); document.getElementById(target.id)?.focus();
    }
  });

  // ------------------------------------------------------------ drag and drop
  const DRAG_TYPE = 'application/x-bounty-board-finding';
  let dragged = null;
  const dropTarget = event => event.target.closest?.('.workspace-nav [data-section="gadgets"], .workspace-nav [data-section="map"]');
  document.addEventListener('dragstart', event => {
    const row = event.target.closest?.('tr[data-finding-id]');
    if (!row || !ctx) return;
    dragged = row.dataset.findingId;
    event.dataTransfer.setData(DRAG_TYPE, dragged);
    event.dataTransfer.setData('text/plain', dragged);
    event.dataTransfer.effectAllowed = 'move';
    document.body.classList.add('ledger-dragging');
  });
  document.addEventListener('dragend', () => { dragged = null; document.body.classList.remove('ledger-dragging'); document.querySelectorAll('.ledger-drop-active').forEach(n => n.classList.remove('ledger-drop-active')); });
  document.addEventListener('dragover', event => {
    const target = dropTarget(event);
    if (!target || !(dragged || event.dataTransfer?.types?.includes(DRAG_TYPE))) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'move'; target.classList.add('ledger-drop-active');
  });
  document.addEventListener('dragleave', event => { const target = dropTarget(event); if (target && !target.contains(event.relatedTarget)) target.classList.remove('ledger-drop-active'); });
  document.addEventListener('drop', event => {
    const target = dropTarget(event); if (!target) return;
    const id = event.dataTransfer?.getData(DRAG_TYPE) || dragged;
    event.preventDefault(); target.classList.remove('ledger-drop-active'); document.body.classList.remove('ledger-dragging');
    const entry = id && currentEntry(id); dragged = null;
    if (entry) openMoveDialog(entry, target.dataset.section);
  });

  // ------------------------------------------------------------ decoration
  function decorateFindings() {
    const table = ctx.app.querySelector('.ledger-table');
    const panel = ctx.app.querySelector('#metadata-message')?.closest('section.panel');
    if (!panel) return;
    const lane = ctx.currentLane();
    const filters = panel.querySelector('.filters');
    if (filters && !panel.querySelector('.ledger-actions-bar')) {
      const sort = el('select', {id: 'ledger-sort', 'aria-label': 'Sort findings'}, ...SORTS.map(([v, t]) => el('option', {value: v, text: t, selected: view.sort === v})));
      const date = el('select', {id: 'ledger-date', 'aria-label': 'Filter by first seen date'}, ...DATE_FILTERS.map(([v, t]) => el('option', {value: v, text: t, selected: view.date === v})));
      const addCap = caps()?.add_finding?.enabled && Array.isArray(lane?.findings);
      const add = el('button', {type: 'button', className: 'button', 'data-ledger-add': true, text: 'Add finding', title: addCap ? 'Add a finding through BBH' : 'Unavailable: no BBH writer that supports adding findings'});
      filters.after(el('div', {className: 'filters ledger-actions-bar'}, sort, date, add,
        el('span', {className: 'hint', text: 'Drag a row onto Gadgets or MapStore, or use Actions.'})));
    }
    if (!table) return;
    for (const tr of table.querySelectorAll('tbody tr[data-finding-id]')) {
      const id = tr.dataset.findingId; const entry = currentEntry(id); if (!entry) continue;
      tr.draggable = true;
      const cell = tr.querySelector('td');
      const dates = [['First seen', entry.row.first_seen], ['Last seen', entry.row.last_seen]].filter(([, v]) => typeof v === 'string' && v);
      for (const [name, value] of dates) cell.append(el('span', {className: 'id', text: `${name}: ${value.slice(0, 10)}`}));
      cell.append(el('div', {className: 'ledger-row-actions'}, el('button', {type: 'button', className: 'button subtle', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-ledger-menu': id, 'aria-label': `Actions for ${label(entry)}`, text: 'Actions'})));
    }
    // Severity labels: Informational is BBH's INFO; N/A is not a BBH value yet.
    for (const select of table.querySelectorAll('select[data-metadata="severity"]')) {
      for (const option of select.options) if (SEVERITY_LABELS[option.value]) option.textContent = SEVERITY_LABELS[option.value];
      if (!select.disabled && ![...select.options].some(o => o.value === 'N/A'))
        select.append(el('option', {value: 'N/A', disabled: true, text: 'N/A (not supported by BBH yet)'}));
    }
  }

  function decorateDashboard() {
    if (!classWritable()) return;
    for (const row of ctx.app.querySelectorAll('.chart-row[data-class-name]')) {
      const name = row.dataset.className;
      row.append(el('button', {type: 'button', className: 'link-button ledger-class-edit', 'data-ledger-class-review': name, 'aria-label': `Review and reclassify ${name} findings`, text: 'Edit'}));
    }
  }

  window.registerBoardModule({
    name: 'ledger-actions',
    afterRender(context) {
      ctx = context;
      closeMenus();
      if (context.state.view === 'dashboard') decorateDashboard();
      else if (context.state.section === 'findings') decorateFindings();
    },
  });
  // Exposed for tests only; no behaviour depends on it.
  window.BoardLedgerActions = {severityKey, severityRank, SEVERITY_ORDER};
})();
