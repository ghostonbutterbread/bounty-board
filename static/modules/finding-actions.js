/* Finding actions module (feat/board-bulk-actions).
 *
 * Acts on findings where they are listed: the dashboard drill-down lists and
 * the Findings table.
 *  - Severity and submission "pills": click a finding's severity or
 *    submission badge to pick a new value.
 *  - Right-click (or Shift+F10 / the ContextMenu key) on a row opens a
 *    context menu for that row, or for the whole selection when the row is
 *    selected.
 *  - Multi-select: checkbox per row, Shift+click for a range, Ctrl/Cmd+click
 *    on a row, Select all for the current list, Escape clears. A sticky bar
 *    offers bulk actions.
 *  - Drag selected dashboard rows onto a class, category or severity row.
 *  - "Delete" archives (status archive). Archived findings are hidden unless
 *    "Show archived" is on; from there they can be restored or, when the BBH
 *    writer supports it, deleted permanently.
 *  - Report markers: "No report" with the reason, and "Possible report" for
 *    an unregistered report file in the same lane whose path has the ID.
 *
 * Every write goes through the existing endpoints, one finding at a time,
 * each with its own expected_revision: PATCH /api/finding (severity, class,
 * status), POST /api/finding/submission, POST /api/finding/delete. A changed
 * finding is reported as stale, never overwritten.
 *
 * Hooks in app.js (commented there): data-finding-row/-id/-program/-lane on
 * drill-down rows, data-sev-pick / data-submission-pick badge buttons, the
 * "Show archived" toggle and ctx.reload / ctx.reportIdFor.
 */
(() => {
  'use strict';
  const SEVERITIES = ['EXCEPTIONAL', 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO', 'UNKNOWN'];
  const SEV_LABELS = {EXCEPTIONAL: 'Exceptional', CRITICAL: 'Critical', HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low', INFO: 'Info', UNKNOWN: 'Unknown'};
  const STATES = [['not_submitted', 'Not submitted'], ['submitted', 'Submitted'], ['dropped', 'Dropped']];
  const RESULTS = [['valid', 'Valid'], ['duplicate', 'Duplicate']];
  const ARCHIVE_STATUSES = ['archive', 'archived'];
  const STATUS_TOKEN = /^[a-z0-9][a-z0-9-]{0,39}$/; // what BBH and the Board accept as a status
  const RESTORE_FALLBACK = 'confirmed';
  const PLACEHOLDER_TITLES = new Set(['short vulnerability label', 'short novel pattern label']);
  const POSSIBLE_KINDS = new Set(['unregistered', 'generated_report', 'unknown']);
  const NOTE_SEEN_KEY = 'bounty-board-submission-note-seen';
  const ROWS = '[data-finding-row][data-finding-id], tbody tr[data-finding-id]';
  const DRAG_TYPE = 'application/x-bounty-board-findings';
  const OFF_HINT = 'Editing is off: the backend has not enabled the BBH writer.';

  let ctx = null;
  const selected = new Set();
  let anchorKey = null;
  let lastUndo = null;
  let running = false;
  let barStatus = null; // {text, kind, failures, undo, progress}
  let keyboardMenuAt = 0;

  // ------------------------------------------------------------- data access
  const LA = () => window.BoardLedgerActions;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const keyOf = (programId, lane, fid) => JSON.stringify([String(programId), String(lane), String(fid)]);
  const rowKey = node => node?.dataset?.findingId ? keyOf(node.dataset.program, node.dataset.lane, node.dataset.findingId) : null;
  const findings = lane => Array.isArray(lane?.findings) ? lane.findings : [];
  function resolve(key) {
    let parts; try { parts = JSON.parse(key); } catch { return null; }
    const [pid, laneName, fid] = parts;
    const program = ctx.programs().find(p => String(p.id) === pid);
    const lane = (Array.isArray(program?.lanes) ? program.lanes : []).find(l => String(l.name) === laneName);
    const row = findings(lane).find(r => String(r.id) === fid);
    return row ? {key, program, lane, row} : null;
  }
  const allEntries = () => ctx.programs().flatMap(program => (Array.isArray(program.lanes) ? program.lanes : [])
    .flatMap(lane => findings(lane).map(row => ({key: keyOf(program.id, lane.name, row.id), program, lane, row}))));
  const rowNodes = () => ctx ? [...ctx.app.querySelectorAll(ROWS)].filter(n => n.dataset.findingId) : [];
  const visibleKeys = () => rowNodes().map(rowKey);
  const selectedEntries = () => visibleKeys().filter(k => selected.has(k)).map(resolve).filter(Boolean);
  const isArchived = row => ARCHIVE_STATUSES.includes(String(row?.status ?? '').trim().toLowerCase());
  const submission = row => {
    const nested = row?.submission && typeof row.submission === 'object' ? row.submission : {};
    const state = String(nested.state || row?.submission_status || 'not_submitted').toLowerCase();
    return {state: ['', 'not submitted', 'none', 'draft', 'unsubmitted'].includes(state) ? 'not_submitted' : state, result: nested.result || null};
  };
  const isPlaceholder = row => {
    const sev = String(row?.severity ?? '');
    const tax = window.BoardTaxonomy?.ready?.() ? window.BoardTaxonomy.normalizeSeverity(sev) : null;
    return tax?.kind === 'placeholder' || /^[A-Z]+(\|[A-Z]+){2,}$/i.test(sev.trim()) ||
      PLACEHOLDER_TITLES.has(String(row?.title ?? '').trim().toLowerCase()) || PLACEHOLDER_TITLES.has(String(row?.type ?? '').trim().toLowerCase());
  };

  // ------------------------------------------------------------ capabilities
  const metaCap = () => ctx?.api?.capability(ctx.state.data, 'findingMetadata');
  const canEdit = field => {
    const cap = metaCap(); if (!cap) return false;
    return field === 'class' ? !!cap.textFields?.includes('class') : Array.isArray(cap.options?.[field]) && cap.options[field].length > 0;
  };
  const ledgerCaps = () => ctx?.state?.data?.capabilities?.ledger_actions || {};
  const rootInstance = () => /^[a-f0-9]{64}$/.test(ctx?.state?.data?.root_instance || '') ? ctx.state.data.root_instance : null;
  const canSubmit = () => !!ledgerCaps().submission?.enabled && !!rootInstance();
  const canDelete = () => !!ledgerCaps().delete?.enabled && !!rootInstance();
  const writerOn = () => !!metaCap();

  // ------------------------------------------------------- previous status
  // The server remembers the status a finding had when the Board archived it
  // (private state, not the ledger), so Restore works from any device.
  async function previousStatuses(entries) {
    const lanes = new Map(), out = new Map(); let available = true;
    for (const e of entries) lanes.set(JSON.stringify([e.program.family, e.program.name, e.lane.name]), e);
    for (const [lane] of lanes) {
      const [family, program, name] = JSON.parse(lane);
      try {
        const response = await fetch(`/api/archive-state?${new URLSearchParams({family, program, lane: name})}`, {cache: 'no-store'});
        const body = response.ok ? await response.json() : null;
        if (!body?.available) { available = false; continue; }
        for (const e of entries) if (e.program.family === family && e.program.name === program && e.lane.name === name) {
          const value = body.entries?.[String(e.row.id)]?.previous_status;
          if (typeof value === 'string' && STATUS_TOKEN.test(value) && !ARCHIVE_STATUSES.includes(value)) out.set(e.key, value);
        }
      } catch { available = false; }
    }
    return {map: out, available};
  }

  // ------------------------------------------------------------------ writes
  async function writeField(entry, field, value) {
    const {program, lane, row} = entry;
    const response = await ctx.api.write(ctx.state.data, 'findingMetadata', {programId: program.id, program: program.name, family: program.family, lane: lane.name,
      findingId: String(row.id), field, value, expectedRevision: row.metadata_revision, rootInstance: ctx.state.data?.root_instance});
    if (response?.value !== value) throw new Error('Unverified value');
    row[field] = response.value; if (field === 'class') row.class_name = response.value;
    row.metadata_revision = response.revision;
    window.BoardFindingView?.rebase?.(row, response.revisions);
  }
  const where = ({program, lane, row}) => ({family: program.family, program: program.name, lane: lane.name, fid: String(row.id)});
  async function writeSubmission(entry, value) {
    const result = await LA().post('/api/finding/submission', {...where(entry), expected_revision: entry.row.metadata_revision, root_instance: rootInstance(), submission: value});
    if (result?.finding?.fid !== String(entry.row.id)) throw new Error('Unverified finding');
    Object.assign(entry.row, {...result.finding, id: result.finding.fid, class: result.finding.class_name});
    window.BoardFindingView?.rebase?.(entry.row, result.revisions);
  }
  async function postJson(url, body) {
    const response = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Requested-With': 'Bounty-Board'}, body: JSON.stringify(body)});
    let payload = null; try { payload = await response.json(); } catch {}
    if (!response.ok) throw Object.assign(new Error(`Request failed (${response.status})`), {status: response.status, code: payload?.error, reason: payload?.reason});
    return payload;
  }
  // Permanent: BBH removes the finding and its generated report files and keeps
  // only a minimal tombstone. BBH deletes only status "archive", so an
  // "archived" finding is first set to archive through the edit path.
  async function deletePermanently(entry) {
    if (entry.row.status !== 'archive') await writeField(entry, 'status', 'archive');
    const result = await postJson('/api/finding/delete', {...where(entry), expected_revision: entry.row.metadata_revision, root_instance: rootInstance()});
    if (result?.deleted !== String(entry.row.id)) throw new Error('Unverified delete');
    window.BoardFindingView?.rebase?.(entry.row, result.revisions);
    const list = findings(entry.lane), index = list.indexOf(entry.row);
    if (index >= 0) list.splice(index, 1);
    return result;
  }
  const reasonFor = error => error?.code === 'delete_refused' && error.reason ? `BBH refused: ${error.reason}` : ({
    finding_changed: 'changed since it was loaded (stale)', root_changed: 'the source root changed', finding_not_found: 'no longer in the ledger',
    not_archived: 'not archived', delete_refused: 'BBH refused the delete', writer_unavailable: 'the writer is unavailable', busy: 'another update is in progress',
    invalid_finding_patch: 'rejected as invalid', invalid_ledger_action: 'rejected as invalid', writer_failed: 'writer error; the writer is now off',
    verification_failed: 'not verified; the writer is now off',
  }[error?.code] || (error?.status === 503 ? 'the writer is unavailable' : error?.status === 502 ? 'writer error; the writer is now off' : 'not saved or not verified'));
  const stops = error => error?.code === 'writer_unavailable' || error?.status === 502 || error?.status === 503;

  // Sequential per-finding writes with progress, per-item failures, Undo and
  // one data refresh. Failed and unattempted items stay selected for retry.
  async function runBulk(entries, title, perform, {undo = null, refresh = entries.length > 1, success = null, skipped = []} = {}) {
    if (!entries.length) { setStatus({text: skipped.length ? `${title}: nothing to change. ${skipped.map(s => `${s.id}: ${s.reason}`).join('; ')}` : `${title}: nothing to change.`, kind: 'warning'}); return null; }
    if (running || ctx.state.metadataPending) { ctx.ui.toast('Another update is in progress. Try again when it finishes.', 'warning'); return null; }
    running = true; ctx.state.metadataPending = true;
    const done = [], failed = [], undoItems = [], warningText = []; let stopped = false, warnings = 0;
    setStatus({text: `${title}: saving 0 of ${entries.length} through BBH.`, progress: [0, entries.length]});
    ctx.render();
    try {
      for (const [index, entry] of entries.entries()) {
        if (stopped) { failed.push({entry, reason: 'not attempted because the writer stopped'}); continue; }
        setStatus({text: `${title}: saving ${index + 1} of ${entries.length} through BBH.`, progress: [index, entries.length]});
        const before = undo?.(entry);
        try {
          const result = await perform(entry);
          if (result?.warnings) { warnings++; for (const text of result.warning_text || []) warningText.push(`${entry.row.id}: ${text}`); }
          done.push(entry); if (before) undoItems.push(before);
        } catch (error) {
          failed.push({entry, reason: reasonFor(error)});
          if (stops(error)) stopped = true;
        }
      }
    } finally { running = false; ctx.state.metadataPending = false; }
    selected.clear(); for (const {entry} of failed) selected.add(entry.key);
    lastUndo = undoItems.length ? {title, items: undoItems} : null;
    const failures = [...failed.map(({entry, reason}) => ({id: String(entry.row.id), reason})), ...skipped];
    const summary = `${success ? success(done.length, entries.length) : `${title}: saved ${done.length} of ${entries.length}.`}${warnings ? ` BBH reported warnings for ${warnings}.` : ''}`;
    const kind = failures.length ? 'warning' : 'success';
    setStatus({text: failed.length ? `${summary} Not saved: ${failed.length}. They stay selected; the data was refreshed so you can retry.` : summary, kind, failures, undo: !!lastUndo});
    const toast = ctx.ui.toast(failed.length ? `${summary} ${failed.length} not saved.` : summary, kind, {timeout: lastUndo ? 12000 : 6000});
    if (lastUndo) addUndoButton(toast);
    // Non-blocking notice: the work was done, but BBH reported a warning.
    if (warningText.length) ctx.ui.toast(`BBH warnings: ${warningText.slice(0, 5).join(' ')}${warningText.length > 5 ? ` (and ${warningText.length - 5} more)` : ''}`, 'warning', {timeout: 15000});
    if (refresh || failed.length) await ctx.reload();
    ctx.render(); // load() returns early while a report refresh is pending
    return {done, failed};
  }
  function addUndoButton(toast) {
    if (!toast) return;
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'toast-action'; button.textContent = 'Undo';
    button.addEventListener('click', () => { toast.remove(); runUndo(); });
    toast.querySelector('.toast-text')?.after(button);
  }
  // Restores previous values for items that still hold the value this change wrote.
  async function runUndo() {
    const record = lastUndo; if (!record) return;
    lastUndo = null;
    const entries = [], skipped = [];
    for (const item of record.items) {
      const entry = resolve(item.key);
      if (!entry) { skipped.push({id: item.id, reason: 'no longer loaded'}); continue; }
      const problem = item.check(entry.row);
      if (problem) { skipped.push({id: item.id, reason: problem}); continue; }
      entries.push({...entry, item});
    }
    await runBulk(entries, `Undo ${record.title.toLowerCase()}`, entry => entry.item.restore(entry), {refresh: true, skipped,
      success: (n, total) => `Undone for ${n} of ${total}.`});
  }

  // Undo descriptors per change type.
  const fieldUndo = (field, value) => entry => {
    const prev = field === 'class' ? entry.row.class : entry.row[field];
    // Status: BBH accepts any string, so the exact previous token is written back.
    const writable = field === 'severity' ? SEVERITIES.includes(prev) : field === 'status' ? typeof prev === 'string' && STATUS_TOKEN.test(prev) : typeof prev === 'string' && LA().CLASS_PATTERN.test(prev);
    return {key: entry.key, id: String(entry.row.id),
      check: row => (field === 'class' ? row.class : row[field]) !== value ? 'changed since' : writable ? '' : `the previous value ${prev == null || prev === '' ? '(empty)' : prev} cannot be written back`,
      restore: e => writeField(e, field, prev)};
  };
  const submissionUndo = value => entry => {
    const prev = submission(entry.row);
    return {key: entry.key, id: String(entry.row.id),
      check: row => { const now = submission(row); if (now.state !== value.state || (value.result && now.result !== value.result)) return 'changed since'; if (!prev.result && now.result) return 'BBH cannot clear a recorded result'; return ''; },
      restore: e => writeSubmission(e, {state: prev.state, ...(prev.result ? {result: prev.result} : {})})};
  };

  // --------------------------------------------------------------- actions
  const ids = entries => entries.map(e => String(e.row.id));
  const countLabel = n => `${n} ${n === 1 ? 'finding' : 'findings'}`;
  function changeSeverity(entries, value) {
    const targets = entries.filter(e => e.row.severity !== value);
    return runBulk(targets, `Severity ${SEV_LABELS[value]}`, e => writeField(e, 'severity', value), {undo: fieldUndo('severity', value),
      success: (n, total) => `Severity set to ${SEV_LABELS[value]} for ${n} of ${countLabel(total)}.`});
  }
  function changeClass(entries, value) {
    const targets = entries.filter(e => e.row.class !== value);
    return runBulk(targets, `Class ${value}`, e => writeField(e, 'class', value), {undo: fieldUndo('class', value),
      success: (n, total) => `Class set to ${value} for ${n} of ${countLabel(total)}.`});
  }
  function changeSubmission(entries, value) {
    const targets = entries.filter(e => { const s = submission(e.row); return s.state !== value.state || (value.result && s.result !== value.result); });
    const label = STATES.find(([v]) => v === value.state)?.[1] || value.state;
    return runBulk(targets, `Submission ${label}`, e => writeSubmission(e, value), {undo: submissionUndo(value),
      success: (n, total) => `Submission recorded locally as ${label}${value.result ? `, ${value.result}` : ''} for ${n} of ${countLabel(total)}. Nothing was sent to a platform.`});
  }
  async function archive(entries) {
    const targets = entries.filter(e => !isArchived(e.row));
    if (!targets.length) return;
    const ok = await confirmDialog({title: `Delete ${countLabel(targets.length)}?`,
      lines: ['This archives the findings: it sets their status to archive.', 'Archived findings are hidden from the dashboard and lists. The ledger keeps them, and you can restore them with Show archived.'],
      list: targets, confirm: 'Delete (archive)', danger: true});
    if (!ok) return;
    // The server remembers each previous status for Restore.
    return runBulk(targets, 'Delete', e => writeField(e, 'status', 'archive'),
      {undo: fieldUndo('status', 'archive'), refresh: true, success: (n, total) => `Archived ${n} of ${countLabel(total)}. Hidden from the dashboard and lists.`});
  }
  function restore(entries, status, previous) {
    const targets = entries.filter(e => isArchived(e.row));
    const fallback = status ? [] : targets.filter(e => !previous.get(e.key));
    return runBulk(targets, 'Restore', e => writeField(e, 'status', status || previous.get(e.key) || RESTORE_FALLBACK),
      {refresh: true, success: (n, total) => `Restored ${n} of ${countLabel(total)}.${fallback.length ? ` ${fallback.length} had no stored previous status and ${fallback.length === 1 ? 'was' : 'were'} restored as ${RESTORE_FALLBACK}.` : ''}`});
  }
  async function deleteForever(entries) {
    const targets = entries.filter(e => isArchived(e.row));
    if (!targets.length || !canDelete()) return;
    const one = targets.length === 1, marked = targets.filter(e => e.row.status !== 'archive').length;
    const ok = await confirmDialog({title: `Permanently delete ${countLabel(targets.length)}?`,
      lines: [`Delete permanently removes ${one ? 'the finding and its' : `the ${targets.length} findings and their`} generated report files. It cannot be undone.`,
        'Archive is how to keep something recoverable.',
        ...(marked ? [`${marked === targets.length ? (one ? 'It is' : 'They are') : `${marked} of them are`} marked archived; the Board first sets archive, then deletes.`] : [])],
      list: targets, confirm: 'Delete permanently', danger: true});
    if (!ok) return;
    return runBulk(targets, 'Delete permanently', deletePermanently, {refresh: true, success: (n, total) => `Permanently deleted ${n} of ${countLabel(total)}.`});
  }
  async function copyIds(entries) {
    try { await navigator.clipboard.writeText(ids(entries).join('\n')); ctx.ui.toast(entries.length === 1 ? 'Finding ID copied.' : `${entries.length} finding IDs copied.`, 'success'); }
    catch { ctx.ui.toast('Copy is unavailable in this browser.', 'warning'); }
  }

  // ---------------------------------------------------------------- dialogs
  function confirmDialog({title, lines, list = [], confirm, danger}) {
    return new Promise(resolvePromise => {
      const {el} = LA();
      const node = LA().dialog(title, 'finding-actions-confirm-text');
      let answer = false;
      const yes = el('button', {type: 'button', className: `button${danger ? ' danger-button' : ''}`, text: confirm});
      const no = el('button', {type: 'button', className: 'button subtle', text: 'Cancel'});
      const shown = list.slice(0, 8);
      node.append(el('div', {id: 'finding-actions-confirm-text'}, ...lines.map(text => el('p', {className: 'hint', text}))),
        list.length ? el('ul', {className: 'finding-confirm-list'}, ...shown.map(e => el('li', {}, el('span', {className: 'id', text: String(e.row.id)}), ' ', el('span', {text: String(e.row.title || 'Untitled finding')}))),
          list.length > shown.length ? el('li', {className: 'hint', text: `and ${list.length - shown.length} more`}) : null) : null,
        el('div', {className: 'ledger-dialog-actions'}, yes, no));
      yes.addEventListener('click', () => { answer = true; node.close(); });
      no.addEventListener('click', () => node.close());
      node.addEventListener('close', () => resolvePromise(answer));
      node.showModal(); no.focus();
    });
  }
  function classDialog(entries) {
    const {el} = LA();
    const single = entries.length === 1;
    const node = LA().dialog(single ? `Change class: ${entries[0].row.title || entries[0].row.id}` : `Change class: ${countLabel(entries.length)}`);
    let value = '', valid = false;
    const save = el('button', {type: 'button', className: 'button', text: 'Save class', disabled: true});
    const picker = LA().classPicker('finding-actions-class', single ? entries[0].row.class || '' : '', (v, ok) => { value = v; valid = ok; save.disabled = !valid || !canEdit('class'); });
    const classes = [...new Set(entries.map(e => e.row.class || 'not recorded'))];
    node.append(el('p', {className: 'hint', text: `${single ? `${entries[0].program.name} / ${entries[0].lane.name} / ${entries[0].row.id}.` : `${countLabel(entries.length)} selected.`} Current: ${classes.slice(0, 5).join(', ')}${classes.length > 5 ? ', …' : ''}. Each finding is saved through BBH one at a time.`}),
      el('label', {for: 'finding-actions-class', text: 'Class'}), picker.wrap,
      canEdit('class') ? null : el('p', {className: 'message warning', text: OFF_HINT}),
      el('div', {className: 'ledger-dialog-actions'}, save, LA().closeButton(node)));
    if (!canEdit('class')) picker.input.disabled = true;
    save.addEventListener('click', () => { if (!valid) return; node.close(); changeClass(entries, value); });
    picker.input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.defaultPrevented && valid && picker.input.getAttribute('aria-activedescendant') == null) { event.preventDefault(); save.click(); } });
    node.showModal(); picker.input.focus(); picker.input.select?.();
  }

  // ------------------------------------------------------------------ pills
  // Anchor for menus opened at the pointer (or a row) rather than a button.
  function pointAnchor(x, y) {
    const anchor = document.createElement('span');
    anchor.className = 'point-anchor'; anchor.setAttribute('aria-hidden', 'true');
    anchor.style.left = `${Math.round(x)}px`; anchor.style.top = `${Math.round(y)}px`;
    (document.querySelector('#ui-layer') || document.body).append(anchor);
    return anchor;
  }
  // Shared pills (BoardUI.openPills); a pointer anchor is removed on close.
  const pills = (trigger, restoreFocus, options) => ctx.ui.openPills(trigger, {...options,
    onClose: () => { if (trigger.classList.contains('point-anchor')) trigger.remove(); restoreFocus?.(); }});
  function severityPills(trigger, entries, restoreFocus) {
    const current = entries.length === 1 || entries.every(e => e.row.severity === entries[0].row.severity) ? entries[0]?.row.severity : null;
    pills(trigger, restoreFocus, {label: entries.length > 1 ? `Change severity for ${countLabel(entries.length)}` : 'Change severity', current,
      groups: [{options: ctx.ui.severityOptions(SEVERITIES)}],
      note: entries.length > 1 ? `Applies to ${countLabel(entries.length)}, saved one at a time.` : '',
      disabledHint: canEdit('severity') ? '' : OFF_HINT,
      onPick: option => changeSeverity(entries, option.value)});
  }
  function submissionPills(trigger, entries, restoreFocus) {
    const states = entries.map(e => submission(e.row));
    const same = states.every(s => s.state === states[0]?.state);
    const submittedAll = states.length && states.every(s => s.state === 'submitted');
    const results = new Set(states.map(s => s.result)), result = results.size === 1 ? [...results][0] : null;
    // The "ledger only" note is shown once per browser; no extra confirmation step.
    let seen = false; try { seen = localStorage.getItem(NOTE_SEEN_KEY) === '1'; localStorage.setItem(NOTE_SEEN_KEY, '1'); } catch {}
    pills(trigger, restoreFocus, {label: entries.length > 1 ? `Submission for ${countLabel(entries.length)}` : 'Submission',
      current: [same ? states[0]?.state : null, result ? `result:${result}` : null],
      groups: [{options: STATES.map(([value, label]) => ({value, label, tone: value === 'submitted' ? 'accent' : 'outline'}))},
        {label: 'Platform result', options: RESULTS.map(([value, label]) => ({value: `result:${value}`, label, tone: value === 'valid' ? 'success' : 'warning',
          disabled: !submittedAll, title: submittedAll ? (result ? 'BBH cannot clear a recorded result' : '') : 'Mark as Submitted first'}))}],
      note: [seen ? '' : 'Records state in the ledger only. Nothing is sent to a platform.', submittedAll ? '' : 'A result needs Submitted.'].filter(Boolean).join(' '),
      disabledHint: canSubmit() ? '' : 'Recording submission state is off: the backend has not enabled a BBH writer that supports it.',
      onPick: option => option.value.startsWith('result:') ? changeSubmission(entries, {state: 'submitted', result: option.value.slice(7)}) : changeSubmission(entries, {state: option.value})});
  }
  async function restorePills(trigger, entries, restoreFocus) {
    const {map, available} = await previousStatuses(entries);
    const missing = entries.filter(e => !map.get(e.key)).length;
    const statuses = (metaCap()?.options?.status || []).filter(v => !ARCHIVE_STATUSES.includes(v));
    const note = !missing ? 'Previous status restores the status each finding had when the Board archived it.'
      : `${!available ? 'Stored previous statuses are unavailable. ' : ''}No previous status is stored for ${entries.length === 1 ? 'this finding' : `${missing} of ${countLabel(entries.length)}`}; Previous status restores ${missing === 1 ? 'it' : 'them'} as ${RESTORE_FALLBACK}.`;
    if (!trigger.isConnected) return;
    pills(trigger, restoreFocus, {label: 'Restore as', current: null,
      groups: [{options: [{value: '', label: 'Previous status', tone: 'accent'}]}, {label: 'Or set status', options: statuses.map(value => ({value, label: value, tone: 'outline'}))}],
      note, disabledHint: canEdit('status') ? '' : OFF_HINT,
      onPick: option => restore(entries, option.value || null, map)});
  }

  // ------------------------------------------------------------ report info
  const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function reportInfo(entry) {
    const {lane, row} = entry;
    const reports = Array.isArray(lane.reports) ? lane.reports : null;
    const fid = String(row.id), pattern = new RegExp(`(^|[^a-z0-9])${escapeRe(fid)}([^a-z0-9]|$)`, 'i');
    const linked = ctx.reportIdFor?.(lane, row);
    // Evidence files are artifacts, not reports: app.js renders their icon
    // (evidenceIdFor) beside the report link, so nothing here looks for them.
    if (linked) return {linked};
    if (!reports || (Array.isArray(lane.warnings) && lane.warnings.some(w => typeof w === 'string' && w.startsWith('reports_')))) return null;
    const possible = reports.find(r => POSSIBLE_KINDS.has(r.kind) && pattern.test(String(r.path || '')));
    const recorded = typeof row.report_path === 'string' && row.report_path.trim();
    return {possible, reason: recorded ? 'No report: the ledger has a report path, but that file is not among this lane\'s reports (missing or moved).' : 'No report: the ledger has no report_path for this finding.'};
  }

  // ----------------------------------------------------------- context menu
  function menuItems(entries, origin) {
    const single = entries.length === 1 ? entries[0] : null;
    const archived = entries.filter(e => isArchived(e.row)), live = entries.filter(e => !isArchived(e.row));
    const items = [];
    const at = () => { const r = origin.getBoundingClientRect(); return pointAnchor(menuPoint.x ?? r.left, menuPoint.y ?? r.bottom); };
    const refocus = () => focusRow(entries[0]?.key);
    if (!writerOn()) items.push({heading: OFF_HINT});
    if (single) {
      const {program, lane, row} = single, info = reportInfo(single);
      const findingTarget = {program: program.id, lane: lane.name, section: 'findings', finding: String(row.id)};
      const reportId = info?.linked || null;
      const reportTarget = reportId ? {program: program.id, lane: lane.name, section: 'reports', report: reportId} : null;
      items.push({heading: `${row.id}`},
        {label: 'Open finding', icon: 'bug', onSelect: () => ctx.navigate(findingTarget)},
        {label: 'Open finding in new tab', icon: 'external-link', onSelect: () => openTab(ctx.hrefFor(findingTarget))},
        reportTarget ? {label: 'Go to report', icon: 'file-text-o', onSelect: () => ctx.navigate(reportTarget)} : {label: info?.possible ? 'No linked report (see Possible report)' : 'No linked report', icon: 'file-o', disabled: true},
        {label: 'Open report in new tab', icon: 'external-link', disabled: !reportTarget, onSelect: () => openTab(ctx.hrefFor(reportTarget))},
        {separator: true});
    } else items.push({heading: `${countLabel(entries.length)} selected`});
    if (live.length) {
      items.push({label: 'Change severity…', icon: 'signal', disabled: !canEdit('severity'), onSelect: () => severityPills(at(), live, refocus)},
        {label: 'Change class…', icon: 'tag', disabled: !canEdit('class'), onSelect: () => classDialog(live)},
        {label: 'Submission…', icon: 'paper-plane-o', disabled: !canSubmit(), onSelect: () => submissionPills(at(), live, refocus)});
    }
    if (single && !archived.length) {
      const reclassify = ledgerCaps().reclassify || {};
      items.push({label: 'Move to Gadgets…', icon: 'puzzle-piece', disabled: !reclassify.gadgets?.enabled, onSelect: () => LA().openMoveDialog(single, 'gadgets')},
        {label: 'Move to MapStore…', icon: 'map-o', disabled: !reclassify.map?.enabled, onSelect: () => LA().openMoveDialog(single, 'map')});
    }
    items.push({label: single ? 'Copy ID' : 'Copy IDs', icon: 'clipboard', onSelect: () => copyIds(entries)}, {separator: true});
    if (live.length) items.push({label: live.length === entries.length ? 'Delete…' : `Delete ${live.length}…`, icon: 'archive', danger: true, disabled: !canEdit('status'), onSelect: () => archive(live)});
    if (archived.length) {
      items.push({label: archived.length === entries.length ? 'Restore…' : `Restore ${archived.length}…`, icon: 'undo', disabled: !canEdit('status'), onSelect: () => restorePills(at(), archived, refocus)});
      if (canDelete()) items.push({label: archived.length === entries.length ? 'Delete permanently…' : `Delete ${archived.length} permanently…`, icon: 'trash', danger: true, onSelect: () => deleteForever(archived)});
    }
    return items;
  }
  const menuPoint = {x: null, y: null};
  const openTab = href => { if (href) window.open(new URL(href, location.href).href, '_blank', 'noopener'); };
  function focusRow(key) {
    const node = rowNodes().find(n => rowKey(n) === key);
    node?.querySelector('.row-select')?.focus();
  }
  function openContextMenu(node, x, y) {
    const key = rowKey(node), entry = key && resolve(key);
    if (!entry) return;
    const entries = selected.has(key) && selected.size > 1 ? selectedEntries() : [entry];
    menuPoint.x = x; menuPoint.y = y;
    const anchor = pointAnchor(x, y);
    const label = entries.length > 1 ? `Actions for ${countLabel(entries.length)}` : `Actions for ${entry.row.title || entry.row.id}`;
    ctx.ui.openMenu(anchor, menuItems(entries, node), {label, reanchor: () => null, onClose: () => { anchor.remove(); focusRow(key); }});
    document.querySelector('.menu-popover')?.classList.add('context-menu');
    window.dispatchEvent(new Event('resize')); // re-place within the viewport after the class change
  }

  // ---------------------------------------------------------- selection bar
  let bar = null;
  function setStatus(status) { barStatus = status; renderBar(); }
  function button(label, attrs = {}, iconName = '') {
    return `<button type="button" class="button sm ${attrs.className || ''}" ${Object.entries(attrs).filter(([k]) => k !== 'className').map(([k, v]) => v === true ? k : v === false || v == null ? '' : `${k}="${esc(v)}"`).join(' ')}>${iconName ? `<i class="fa fa-${iconName}" aria-hidden="true"></i>` : ''}<span>${esc(label)}</span></button>`;
  }
  function renderBar() {
    if (!ctx) return;
    if (!bar) {
      bar = document.createElement('div'); bar.className = 'selection-bar'; bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', 'Selected findings');
      bar.addEventListener('click', onBarClick);
      document.body.append(bar);
    }
    const entries = selectedEntries(), visible = visibleKeys().length;
    const show = entries.length > 0 || !!barStatus;
    bar.hidden = !show;
    document.body.classList.toggle('has-selection-bar', show);
    if (!show) { bar.innerHTML = ''; return; }
    const live = entries.filter(e => !isArchived(e.row)), archived = entries.filter(e => isArchived(e.row));
    const busy = running || ctx.state.metadataPending;
    const off = !writerOn();
    const actions = entries.length ? `<div class="selection-actions">
      <span class="selection-count"><strong>${entries.length}</strong> selected</span>
      ${button(`Select all (${visible})`, {'data-bulk': 'all', disabled: entries.length === visible})}
      ${live.length ? `${button('Change severity', {'data-bulk': 'severity', 'aria-haspopup': 'menu', 'aria-expanded': 'false', disabled: busy || !canEdit('severity'), title: canEdit('severity') ? '' : OFF_HINT}, 'signal')}
      ${button('Change class', {'data-bulk': 'class', disabled: busy || !canEdit('class'), title: canEdit('class') ? '' : OFF_HINT}, 'tag')}
      ${button('Submission', {'data-bulk': 'submission', 'aria-haspopup': 'menu', 'aria-expanded': 'false', disabled: busy || !canSubmit()}, 'paper-plane-o')}
      ${button(live.length === entries.length ? 'Delete' : `Delete ${live.length}`, {'data-bulk': 'archive', className: 'danger-ghost', disabled: busy || !canEdit('status'), title: 'Archive: hides the findings; the ledger keeps them'}, 'archive')}` : ''}
      ${archived.length ? `${button(archived.length === entries.length ? 'Restore' : `Restore ${archived.length}`, {'data-bulk': 'restore', 'aria-haspopup': 'menu', 'aria-expanded': 'false', disabled: busy || !canEdit('status')}, 'undo')}
      ${canDelete() ? button(archived.length === entries.length ? 'Delete permanently' : `Delete ${archived.length} permanently`, {'data-bulk': 'purge', className: 'danger-ghost', disabled: busy}, 'trash') : ''}` : ''}
      ${button('Clear', {'data-bulk': 'clear', className: 'ghost', title: 'Clear the selection (Escape)'})}
      </div>${off ? `<p class="hint selection-hint">${esc(OFF_HINT)}</p>` : ''}` : '';
    const s = barStatus;
    const status = s ? `<div class="selection-status ${s.kind || ''}" role="status" aria-live="polite">${s.progress ? `<progress max="${s.progress[1]}" value="${s.progress[0]}"></progress>` : ''}<span>${esc(s.text)}</span>${s.undo && lastUndo ? button('Undo', {'data-bulk': 'undo'}, 'undo') : ''}${!s.progress ? button('Dismiss', {'data-bulk': 'dismiss', className: 'ghost', 'aria-label': 'Dismiss status'}) : ''}${s.failures?.length ? `<ul class="selection-failures">${s.failures.slice(0, 12).map(f => `<li><span class="id">${esc(f.id)}</span> ${esc(f.reason)}</li>`).join('')}${s.failures.length > 12 ? `<li class="hint">and ${s.failures.length - 12} more</li>` : ''}</ul>` : ''}</div>` : '';
    const focused = bar.contains(document.activeElement) ? document.activeElement.dataset.bulk : null;
    bar.innerHTML = actions + status;
    // Keep toasts above the bar so neither covers the other.
    document.body.style.setProperty('--selection-bar-offset', `${bar.offsetHeight + 12}px`);
    if (focused) (bar.querySelector(`[data-bulk="${focused}"]:not(:disabled)`) || bar.querySelector('[data-bulk]:not(:disabled)'))?.focus();
  }
  function onBarClick(event) {
    const target = event.target.closest('[data-bulk]'); if (!target || target.disabled) return;
    const entries = selectedEntries(), live = entries.filter(e => !isArchived(e.row)), archived = entries.filter(e => isArchived(e.row));
    const refocus = () => bar.querySelector(`[data-bulk="${target.dataset.bulk}"]`)?.focus();
    switch (target.dataset.bulk) {
      case 'all': for (const key of visibleKeys()) selected.add(key); syncRows(); break;
      case 'clear': clearSelection(); break;
      case 'severity': severityPills(target, live, refocus); break;
      case 'class': classDialog(live); break;
      case 'submission': submissionPills(target, live, refocus); break;
      case 'archive': archive(live); break;
      case 'restore': restorePills(target, archived, refocus); break;
      case 'purge': deleteForever(archived); break;
      case 'undo': runUndo(); break;
      case 'dismiss': barStatus = null; renderBar(); break;
    }
  }
  function clearSelection() { selected.clear(); anchorKey = null; syncRows(); }
  // Cheap update without a full render.
  function syncRows() {
    for (const node of rowNodes()) {
      const on = selected.has(rowKey(node));
      node.classList.toggle('is-selected', on);
      const box = node.querySelector('.row-select'); if (box) box.checked = on;
    }
    for (const button of ctx.app.querySelectorAll('[data-select-list]')) {
      const keys = listKeys(button); button.setAttribute('aria-pressed', String(keys.length > 0 && keys.every(k => selected.has(k))));
    }
    renderBar();
  }
  const listKeys = button => {
    const scope = button.closest('.drill') || button.closest('.panel');
    return scope ? [...scope.querySelectorAll(ROWS)].filter(n => n.dataset.findingId && (!button.dataset.selectList.startsWith('placeholder') || n.dataset.placeholder === 'true')).map(rowKey) : [];
  };

  // ------------------------------------------------------------ decoration
  function decorate(node, entry) {
    const key = entry.key, label = `Select finding ${entry.row.id}`;
    if (!node.querySelector('.row-select')) {
      const box = document.createElement('input');
      box.type = 'checkbox'; box.className = 'row-select'; box.setAttribute('aria-label', label);
      box.title = 'Select. Shift+click selects a range; right-click for actions.';
      if (node.tagName === 'TR') { const cell = node.cells[0]; cell.classList.add('has-select'); cell.prepend(box); }
      else node.prepend(box);
    }
    const on = selected.has(key);
    node.classList.toggle('is-selected', on); node.querySelector('.row-select').checked = on;
    if (node.tagName === 'LI') node.draggable = true;
    const meta = node.querySelector('.finding-meta, .meta');
    if (!meta || node.dataset.decorated) return;
    node.dataset.decorated = 'true';
    if (isPlaceholder(entry.row)) {
      node.dataset.placeholder = 'true';
      meta.insertAdjacentHTML('afterbegin', '<span class="badge outline placeholder-badge" tabindex="0" data-tip="Unfilled schema example from the ledger template. Select these, delete (archive), then delete permanently.">Template placeholder</span>');
    }
    // Dashboard rows (.frow) keep report markers in their right-hand icon
    // column (.row-links) and the actionable "Possible report" in the subline.
    const links = node.querySelector('.row-links');
    const info = reportInfo(entry);
    const program = entry.program.id, lane = entry.lane.name;
    if (info && !info.linked) {
      const missing = links
        ? `<span class="report-missing row-icon" tabindex="0" data-tip="${esc(info.reason)}" aria-label="${esc(info.reason)}"><i class="fa fa-file-o" aria-hidden="true"></i></span>`
        : `<span class="report-missing" tabindex="0" data-tip="${esc(info.reason)}" aria-label="${esc(info.reason)}"><i class="fa fa-file-o" aria-hidden="true"></i>No report</span>`;
      (links || meta).insertAdjacentHTML(links ? 'afterbegin' : 'beforeend', missing);
      if (info.possible) {
        const tip = `Unlinked: ${info.possible.path} is a report file in this lane with this finding ID in its path. The ledger does not link it.`;
        meta.insertAdjacentHTML('beforeend', `<a class="possible-report" href="${esc(ctx.hrefFor({program, lane, section: 'reports', report: info.possible.id ?? info.possible.path}))}" data-tip="${esc(tip)}" aria-label="Possible report, unlinked: ${esc(info.possible.path)}"><i class="fa fa-question-circle-o" aria-hidden="true"></i>Possible report</a>`);
      }
    }
  }
  function decorateLists() {
    // Select all for each expanded drill-down list.
    for (const drill of ctx.app.querySelectorAll('.drill')) {
      const count = drill.querySelectorAll(ROWS).length; if (!count || drill.querySelector('.drill-select')) continue;
      drill.insertAdjacentHTML('afterbegin', `<div class="drill-select"><button type="button" class="button sm ghost" data-select-list="drill" aria-pressed="false"><i class="fa fa-check-square-o" aria-hidden="true"></i><span>Select all ${count}</span></button><span class="hint">Shift+click selects a range. Right-click for actions. Drag onto a class or severity row.</span></div>`);
    }
    // Template placeholder groups in the severity breakdown.
    for (const row of ctx.app.querySelectorAll('.breakdown-row[data-breakdown^="sev:raw:"]')) {
      const value = row.dataset.breakdown.slice(8);
      if (isPlaceholder({severity: value}) && !row.querySelector('.placeholder-badge')) row.querySelector('.label')?.insertAdjacentHTML('afterbegin', '<span class="badge outline placeholder-badge">Template placeholder</span>');
    }
    // Findings table: select all and select template placeholders.
    const filters = ctx.app.querySelector('.ledger-table') && ctx.app.querySelector('.filters');
    if (filters && !filters.querySelector('[data-select-list]')) {
      const placeholders = ctx.app.querySelectorAll('tbody tr[data-placeholder="true"]').length;
      filters.querySelector('.result-count')?.insertAdjacentHTML('beforebegin', `<button type="button" class="button sm" data-select-list="table" aria-pressed="false"><i class="fa fa-check-square-o" aria-hidden="true"></i><span>Select all</span></button>${placeholders ? `<button type="button" class="button sm" data-select-list="placeholder" aria-pressed="false"><span>Select template placeholders (${placeholders})</span></button>` : ''}`);
    }
  }

  // ------------------------------------------------------------------ events
  const interactive = target => target.closest('a, button, input, select, textarea, label, [contenteditable="true"]');
  document.addEventListener('click', event => {
    if (!ctx) return;
    const pick = event.target.closest?.('[data-sev-pick], [data-submission-pick]');
    if (pick && ctx.app.contains(pick)) {
      event.preventDefault();
      const node = pick.closest(ROWS), entry = node && resolve(rowKey(node));
      if (!entry) return;
      (pick.hasAttribute('data-sev-pick') ? severityPills : submissionPills)(pick, [entry], () => pick.isConnected && pick.focus());
      return;
    }
    const list = event.target.closest?.('[data-select-list]');
    if (list && ctx.app.contains(list)) {
      const keys = listKeys(list), all = keys.length && keys.every(k => selected.has(k));
      for (const key of keys) all ? selected.delete(key) : selected.add(key);
      syncRows(); return;
    }
    const box = event.target.closest?.('.row-select');
    const node = event.target.closest?.(ROWS);
    if (!node || !ctx.app.contains(node)) return;
    const key = rowKey(node);
    if (box) {
      if (event.shiftKey && anchorKey && anchorKey !== key) selectRange(anchorKey, key, box.checked);
      else box.checked ? selected.add(key) : selected.delete(key);
      anchorKey = key; syncRows(); return;
    }
    if (interactive(event.target)) return;
    if (event.ctrlKey || event.metaKey) { selected.has(key) ? selected.delete(key) : selected.add(key); anchorKey = key; syncRows(); }
    else if (event.shiftKey && anchorKey) { selectRange(anchorKey, key, true); window.getSelection?.()?.removeAllRanges(); syncRows(); }
  });
  function selectRange(from, to, on) {
    const keys = visibleKeys(), a = keys.indexOf(from), b = keys.indexOf(to);
    if (a < 0 || b < 0) { on ? selected.add(to) : selected.delete(to); return; }
    for (const key of keys.slice(Math.min(a, b), Math.max(a, b) + 1)) on ? selected.add(key) : selected.delete(key);
  }
  document.addEventListener('contextmenu', event => {
    if (!ctx) return;
    // The keyboard opener already showed our menu; suppress the browser one.
    if (Date.now() - keyboardMenuAt < 1000 && document.querySelector('#ui-layer .context-menu')) { event.preventDefault(); return; }
    if (event.shiftKey) return; // Shift+right-click keeps the browser menu.
    const node = event.target.closest?.(ROWS);
    if (!node || !ctx.app.contains(node) || event.target.closest('input:not(.row-select), select, textarea')) return;
    event.preventDefault();
    const r = node.getBoundingClientRect();
    const keyboard = event.clientX === 0 && event.clientY === 0;
    openContextMenu(node, keyboard ? r.left + 24 : event.clientX, keyboard ? r.bottom : event.clientY);
  });
  document.addEventListener('keydown', event => {
    if (!ctx) return;
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      const node = document.activeElement?.closest?.(ROWS);
      if (!node || !ctx.app.contains(node)) return;
      event.preventDefault(); keyboardMenuAt = Date.now();
      const r = (node.querySelector('.row-select') || node).getBoundingClientRect();
      openContextMenu(node, r.left, r.bottom);
      return;
    }
    if (event.key === 'Escape' && !event.defaultPrevented && selected.size && !document.querySelector('dialog[open]') && !document.querySelector('#ui-layer .popover') &&
        !event.target.closest?.('input:not([type=checkbox]), textarea, select, dialog')) {
      clearSelection();
    }
  });

  // ------------------------------------------------------------- drag & drop
  let dragKeys = null, preview = null;
  function dropAction(target) {
    const n = dragKeys?.length || 0;
    if (target.dataset.className) return {field: 'class', value: target.dataset.className, text: `Set class to ${target.dataset.className}`};
    if (target.hasAttribute('data-category-row')) {
      const category = target.dataset.categoryRow, t = window.BoardTaxonomy;
      if (category === 'none' || !t?.ready?.()) return {refuse: 'Unclassified has no class to apply. Drop on a class row.'};
      const classes = new Set(allEntries().map(e => e.row.class).filter(c => c && t.normalizeClass(c).category === category));
      if (classes.size !== 1) return {refuse: `This category has ${classes.size} raw classes. Switch to By class and drop on one.`};
      const value = [...classes][0];
      return {field: 'class', value, text: `Set class to ${value}`};
    }
    const sev = (target.dataset.breakdown || '').startsWith('sev:') ? target.dataset.breakdown.slice(4) : '';
    const value = sev.toUpperCase();
    if (SEVERITIES.includes(value)) return {field: 'severity', value, text: `Set severity to ${SEV_LABELS[value]}`};
    return n ? {refuse: 'Not a severity BBH can store. Drop on a named severity row.'} : null;
  }
  const dropTarget = event => { const t = event.target.closest?.('.breakdown-row'); return t && ctx?.app.contains(t) ? t : null; };
  function showPreview(target, action) {
    if (!preview) { preview = document.createElement('div'); preview.className = 'drop-preview'; preview.setAttribute('role', 'status'); (document.querySelector('#ui-layer') || document.body).append(preview); }
    const n = dragKeys.length;
    preview.textContent = action.refuse ? action.refuse : `${action.text} for ${countLabel(n)}${n > 1 ? '. You will confirm first.' : '.'}`;
    preview.classList.toggle('refused', !!action.refuse);
    const r = target.getBoundingClientRect(), vw = document.documentElement.clientWidth;
    preview.style.top = `${Math.round(Math.max(8, r.top - preview.offsetHeight - 6))}px`;
    preview.style.left = `${Math.round(Math.max(8, Math.min(vw - preview.offsetWidth - 8, r.left + 24)))}px`;
  }
  function clearDrag() {
    dragKeys = null; preview?.remove(); preview = null;
    document.body.classList.remove('dragging-findings');
    ctx?.app.querySelectorAll('.breakdown-row.drop-active').forEach(n => n.classList.remove('drop-active'));
  }
  document.addEventListener('dragstart', event => {
    const node = event.target.closest?.('li[data-finding-row]');
    if (!node || !ctx?.app.contains(node) || event.target.closest('input, button')) return;
    const key = rowKey(node);
    dragKeys = selected.has(key) ? visibleKeys().filter(k => selected.has(k)) : [key];
    event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(dragKeys));
    event.dataTransfer.effectAllowed = 'move';
    const ghost = document.createElement('div'); ghost.className = 'drag-ghost'; ghost.textContent = countLabel(dragKeys.length);
    document.body.append(ghost); event.dataTransfer.setDragImage(ghost, 12, 12); setTimeout(() => ghost.remove(), 0);
    document.body.classList.add('dragging-findings');
  });
  document.addEventListener('dragend', clearDrag);
  document.addEventListener('dragover', event => {
    if (!dragKeys) return;
    const target = dropTarget(event); if (!target) return;
    const action = dropAction(target); if (!action) return;
    ctx.app.querySelectorAll('.breakdown-row.drop-active').forEach(n => { if (n !== target) n.classList.remove('drop-active'); });
    showPreview(target, action);
    if (action.refuse) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'move'; target.classList.add('drop-active');
  });
  document.addEventListener('dragleave', event => {
    const target = dropTarget(event);
    if (target && !target.contains(event.relatedTarget)) { target.classList.remove('drop-active'); if (!event.relatedTarget?.closest?.('.breakdown-row')) { preview?.remove(); preview = null; } }
  });
  document.addEventListener('drop', async event => {
    if (!dragKeys) return;
    const target = dropTarget(event); if (!target) return;
    event.preventDefault();
    const action = dropAction(target), keys = dragKeys; clearDrag();
    if (!action || action.refuse) { if (action?.refuse) ctx.ui.toast(action.refuse, 'warning'); return; }
    const entries = keys.map(resolve).filter(Boolean).filter(e => !isArchived(e.row));
    if (!canEdit(action.field)) { ctx.ui.toast(OFF_HINT, 'warning'); return; }
    if (entries.length > 1) {
      const ok = await confirmDialog({title: `${action.text} for ${countLabel(entries.length)}?`, lines: ['Each finding is saved through BBH one at a time. Findings that changed since they were loaded are skipped and reported.'], list: entries, confirm: action.text});
      if (!ok) return;
    }
    if (action.field === 'class') changeClass(entries, action.value); else changeSeverity(entries, action.value);
  });

  // ------------------------------------------------------------------ module
  window.registerBoardModule({
    name: 'finding-actions',
    afterRender(context) {
      ctx = context;
      if (!ctx.state?.data) { renderBar(); return; }
      const visible = new Set();
      for (const node of rowNodes()) {
        const key = rowKey(node), entry = resolve(key);
        if (!entry) continue;
        visible.add(key); decorate(node, entry);
      }
      // The selection covers rows in the current list only. A refresh first
      // renders a loading state without rows; keep the selection through it.
      if (!ctx.state.loading) {
        for (const key of [...selected]) if (!visible.has(key)) selected.delete(key);
        if (anchorKey && !visible.has(anchorKey)) anchorKey = null;
      }
      decorateLists(); syncRows();
    },
  });
  // Entry points and helpers for tests and other modules.
  // entry(): a loaded finding as {key, program, lane, row}, or null. The pickers
  // and copyIds are reused by recent-reports.js for mapped report rows.
  window.BoardFindingActions = {selected: () => [...selected], clearSelection, isPlaceholder, SEVERITIES,
    entry: (programId, lane, fid) => ctx ? resolve(keyOf(programId, lane, fid)) : null, keyOf,
    severityPills, submissionPills, copyIds, submission, canEdit, canSubmit, OFF_HINT};
})();
