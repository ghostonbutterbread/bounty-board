/* Report N/A marker (feat/board-recent-actions).
 *
 * A Board-only "not applicable" mark on a report file, for noise: the row is
 * struck through and dimmed, and lists can hide marked rows. It never changes
 * the ledger or the file. The server keeps the marks in the Board's private
 * state directory (POST /api/report-na), so they show on every device.
 *
 *  - toggleHtml(...) renders the compact check-style toggle; one document-level
 *    click handler handles every [data-na-toggle] (Recent view and panel, the
 *    program Reports list, report links in finding rows).
 *  - After a save the flag is copied into the loaded lane reports
 *    (ctx.state.data) and a "board-report-na" event tells other modules
 *    (recent-reports.js) to update their own copies; then the app re-renders.
 *  - Undo toast posts the opposite value.
 * Keys are the report path relative to the lane's reports/ folder, so moving
 * or renaming a report drops its mark.
 */
(() => {
  'use strict';
  let ctx = null;
  let busy = false;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const UNAVAILABLE = 'N/A marks are unavailable: the Board has no private state directory.';

  // Marks are Board state: they work with the BBH writer off, but need the state dir.
  const available = () => ctx?.state?.data?.capabilities?.report_na?.enabled === true;
  const split = programId => { const s = String(programId), i = s.indexOf('/'); return i > 0 ? [s.slice(0, i), s.slice(i + 1)] : [null, null]; };

  function toggleHtml({program, lane, path, na, label = '', disabled = null}) {
    const off = disabled == null ? !available() : disabled;
    const action = na ? 'Unmark N/A' : 'Mark N/A';
    const tip = off ? UNAVAILABLE : na ? 'Marked N/A on the Board. Click to unmark.' : 'Mark N/A: strikes through and dims this report on the Board. The file and ledger are unchanged.';
    return `<button type="button" class="na-toggle" data-na-toggle data-na-program="${esc(program)}" data-na-lane="${esc(lane)}" data-na-path="${esc(path)}" aria-pressed="${na ? 'true' : 'false'}" aria-label="${esc(action)}${label ? `: ${esc(label)}` : ''}" title="${esc(tip)}"${off ? ' disabled' : ''}><i class="fa fa-check" aria-hidden="true"></i><span class="na-toggle-text">N/A</span></button>`;
  }

  async function post(program, lane, path, na) {
    const [family, name] = split(program);
    const response = await fetch('/api/report-na', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Requested-With': 'Bounty-Board'},
      body: JSON.stringify({family, program: name, lane, path, na})});
    let body = null; try { body = await response.json(); } catch {}
    if (!response.ok) throw Object.assign(new Error(`N/A failed (${response.status})`), {status: response.status, code: body?.error});
    if (body?.path !== path || body?.na !== na) throw new Error('Unverified N/A');
    return body;
  }
  // Copies the saved flag into every loaded copy, then re-renders.
  function apply(program, lane, path, na) {
    const p = (ctx?.programs?.() || []).find(x => String(x.id) === String(program));
    const l = (Array.isArray(p?.lanes) ? p.lanes : []).find(x => String(x.name) === String(lane));
    for (const r of Array.isArray(l?.reports) ? l.reports : []) if (String(r.path ?? r.id) === path) r.na = na;
    window.dispatchEvent(new CustomEvent('board-report-na', {detail: {program: String(program), lane: String(lane), path, na}}));
    ctx?.render?.();
  }
  const reason = error => error?.status === 503 ? UNAVAILABLE : error?.status === 404 ? 'That report is no longer in the lane. Refresh the board.'
    : error?.status === 403 ? 'The request was refused.' : 'The N/A mark was not saved.';

  async function set(program, lane, path, na, {undo = true, focusKey = null} = {}) {
    if (busy) return false;
    busy = true;
    try {
      await post(program, lane, path, na);
    } catch (error) {
      ctx.ui.toast(reason(error), 'warning');
      return false;
    } finally { busy = false; }
    apply(program, lane, path, na);
    const name = path.split('/').pop();
    const toast = ctx.ui.toast(na ? `Marked N/A: ${name}. Board only; the file and ledger are unchanged.` : `Unmarked N/A: ${name}.`, 'success', {timeout: undo ? 10000 : 4500});
    if (undo && toast) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'toast-action'; button.textContent = 'Undo';
      button.addEventListener('click', () => { toast.remove(); set(program, lane, path, !na, {undo: false}); });
      toast.querySelector('.toast-text')?.after(button);
    }
    // Keep keyboard users on the same toggle when it is still shown.
    // When a hidden-N/A list drops the row, focus goes to its "show" control.
    if (focusKey) requestAnimationFrame(() => {
      const box = document.querySelector(`[data-na-scope="${CSS.escape(focusKey)}"]`);
      const again = box && [...box.querySelectorAll('[data-na-toggle]')].find(b => b.dataset.naProgram === program && b.dataset.naLane === lane && b.dataset.naPath === path);
      (again || box?.querySelector('[data-na-show-hidden]'))?.focus();
    });
    return true;
  }

  document.addEventListener('click', event => {
    const button = event.target.closest?.('[data-na-toggle]');
    if (!button || !ctx || button.disabled) return;
    event.preventDefault(); event.stopPropagation();
    const scope = button.closest('[data-na-scope]')?.dataset.naScope || null;
    set(button.dataset.naProgram, button.dataset.naLane, button.dataset.naPath, button.getAttribute('aria-pressed') !== 'true', {focusKey: scope});
  }, true);

  window.registerBoardModule({name: 'report-na', afterRender(context) { ctx = context; }});
  window.BoardReportNa = {toggleHtml, set, available, UNAVAILABLE};
})();
