/* Report agent UI (feature module, phase 2 of docs/integrations/report-agent.md).
 *
 * - Settings: an "Agent" section in the Terminal card (CLI and model, host-wide,
 *   saved by the terminal service; login and connect status, read-only).
 * - Report view: an "Agent" button next to the Terminal button. Its popover starts
 *   the report agent (change the PoC format, or ask a question), shows a running
 *   agent with Stop, and lists agents already running on Hoster (agent connect).
 * - Code blocks: a "Convert" action in the terminal's block bar starts the agent on
 *   that block (task.block).
 * - Drawer tabs: "Agent" (WebSocket kind=agent) and one tab per connect session
 *   (kind=connect), registered through BoardTerminal.registerTab.
 *
 * sandbox-terminal.js owns the drawer, the typing filter and the code-block bar;
 * this module only uses its seams (registerTab, openTab, registerBlockAction,
 * mount, unsafeText). Every string from the service is set with textContent.
 * Nothing here reaches the report Markdown: the Convert control lives in the
 * Board-only block bar, which the preview copy handler strips.
 */
(() => {
  'use strict';
  const FORMATS = [['python', 'Python'], ['curl', 'curl'], ['browser_js', 'Browser JS'], ['raw_http', 'Raw HTTP'], ['best_fit', 'Best fit']];
  const FORMAT_LABEL = Object.fromEntries(FORMATS);
  const LANG_RE = /^[A-Za-z0-9_+.#-]{0,32}$/;
  const CUSTOM_RE = /^[a-z0-9]([a-z0-9.-]{0,62}[a-z0-9])?$/;
  const MAX_ASK = 8 * 1024, MAX_BLOCK = 64 * 1024;
  const STATE_LABEL = {starting: 'Starting', working: 'Working', waiting: 'Waiting for you', exited: 'Exited'};
  const LIVE = new Set(['starting', 'working', 'waiting']);
  const KIND_LABEL = {claude: 'Claude', omp: 'OMP', codex: 'Codex', opencode: 'OpenCode'};
  const STATUS_TONE = {working: 'accent', blocked: 'warning', idle: '', done: 'success'};
  const NEEDS_LOGIN = 'Needs a sandbox login on Hoster';
  // Deploy step 1 of docs/integrations/report-agent.md, as one plain line.
  const LOGIN_HINT = 'On Hoster, run claude setup-token, then save only the printed token in ~/.config/bounty-board/report-agent.token (mode 0600, outside the data root).';
  const UNSAFE_TEXT = 'The text contains control or invisible characters. Remove them and try again.';
  const CONNECT_COPY = 'These are the agents\' real sessions on Hoster, outside any sandbox. What you type goes straight to the agent.';

  let ctx = null, base = null, sel = null, selKey = '';
  let config = null, configError = null, configAt = 0, configLoading = null;
  let status = null;          // GET /api/status (agent_connect flag)
  let session = {state: 'none'}, sessionSig = '', pollTimer = null, pollKey = '';
  let pop = null, popAnchor = null, convertMenu = null;
  const form = {format: null, text: '', cli: null, model: null, custom: '', busy: false, error: ''};
  const agentsView = {all: false, loading: false, enabled: null, items: [], error: ''};
  let agentTab = null;        // tab api of the Agent tab while attached
  const handles = new Map();  // tab id -> terminal handle (tests and diagnostics)
  const BT = () => window.BoardTerminal;

  // -- small helpers -------------------------------------------------------------
  function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'text') node.textContent = value;
      else if (key === 'value') node.value = value;
      else if (key === 'className') node.className = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else if (key in node && typeof value !== 'string') node[key] = value;
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) if (child != null && child !== false) node.append(child);
    return node;
  }
  const icon = name => h('i', {className: `fa fa-${name}`, 'aria-hidden': 'true'});
  const query = s => new URLSearchParams({family: s.family, program: s.program, lane: s.lane, path: s.path}).toString();
  const keyOf = s => JSON.stringify([s.family, s.program, s.lane, s.path]);
  const bytes = text => new TextEncoder().encode(text).length;
  const unsafe = text => (BT()?.unsafeText ? BT().unsafeText(text) : false);
  const ago = seconds => {
    const s = Math.max(0, Math.round(Date.now() / 1000 - seconds));
    return s < 60 ? 'under a minute ago' : s < 3600 ? `${Math.floor(s / 60)} min ago` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min ago`;
  };
  const cliLabel = id => config?.clis?.find(c => c.id === id)?.label || id || '';
  const modelLabel = m => (m === 'default' ? 'Default model' : m);

  async function api(path, body) {
    const options = body
      ? {method: 'POST', credentials: 'same-origin', headers: {'Content-Type': 'application/json', 'X-Requested-With': 'Bounty-Board'}, body: JSON.stringify(body)}
      : {credentials: 'same-origin', cache: 'no-store'};
    const response = await fetch(base + path, {...options, signal: AbortSignal.timeout(body ? 90000 : 15000)});
    let data = null;
    try { data = await response.json(); } catch {}
    if (!response.ok) {
      const error = new Error(data?.message || `Request failed (${response.status})`);
      error.status = response.status; error.code = data?.error; error.data = data;
      throw error;
    }
    return data || {};
  }

  async function loadConfig(force) {
    if (!base) return null;
    if (!force && config && Date.now() - configAt < 30000) return config;
    if (configLoading) return configLoading;
    configLoading = (async () => {
      try {
        const [next, st] = await Promise.all([api('api/agent/config'), api('api/status').catch(() => null)]);
        config = next; status = st; configError = null;
      } catch (error) { configError = error; config = null; }
      configAt = Date.now();
      configLoading = null;
      paintButton(); paintPopover(); BT()?.refreshBlocks?.();
      return config;
    })();
    return configLoading;
  }

  // Why the agent cannot start for this report ('' when it can).
  function unavailable() {
    if (!base) return 'The sandbox terminal is not enabled on this Board.';
    if (configError) return configError.status === 401 ? 'Sign in to the terminal to use the agent.' : 'Terminal service unavailable.';
    if (!config) return 'Checking the agent...';
    if (!config.enabled) return 'The report agent is off on this Board.';
    const mount = BT()?.mount?.();
    if (mount?.ok === false) return mount.message || 'This report is not inside a finding folder.';
    if (!config.login?.ready) return 'No sandbox login on Hoster yet.';
    return '';
  }
  const hasSession = () => session && session.state && session.state !== 'none';
  const running = () => LIVE.has(session?.state);

  // -- session polling -------------------------------------------------------------
  // GET /api/agent/session while the report is visible: every 3 s while the agent
  // is starting or working, every 10 s otherwise. Redraw only on change.
  function schedulePoll(delay) {
    clearTimeout(pollTimer);
    if (!sel || !base) return;
    const fast = session.state === 'starting' || session.state === 'working';
    pollTimer = setTimeout(pollSession, delay ?? (fast ? 3000 : 10000));
  }
  let soonPoll = false;
  async function pollSession() {
    soonPoll = false;
    if (!sel || !base) return;
    const key = selKey;
    if (!document.hidden) {
      try { const next = await api(`api/agent/session?${query(sel)}`); if (key === selKey) setSession(next); }
      catch { /* quiet: the button keeps its last state */ }
    }
    if (key === selKey) schedulePoll();
  }
  function setSession(next) {
    next = next && typeof next === 'object' ? next : {state: 'none'};
    const sig = JSON.stringify([next.state, next.cli, next.model, next.started, next.exit_code, next.viewers]);
    if (sig === sessionSig) return;
    const wasLive = hasSession();
    session = next; sessionSig = sig;
    if (hasSession()) ensureAgentTab();
    else if (wasLive) BT()?.removeTab?.('agent');
    paintAgentTab();
    paintButton(); paintPopover(); BT()?.refreshBlocks?.();
  }

  // -- the Agent button --------------------------------------------------------------
  function placeButton() {
    const toggle = document.querySelector('[data-term-toggle]');
    if (!toggle) { removeButton(); return null; }
    let button = document.querySelector('[data-agent-toggle]');
    if (button && button.isConnected) return button;
    const after = toggle.nextElementSibling?.matches('[data-term-reason]') ? toggle.nextElementSibling : toggle;
    button = h('button', {type: 'button', className: 'button subtle ra-toggle', dataset: {agentToggle: ''}, 'aria-haspopup': 'dialog', 'aria-expanded': 'false', onclick: onButton},
      icon('magic'), h('span', {className: 'ra-toggle-label', text: 'Agent'}),
      h('span', {className: 'ra-state', dataset: {agentState: ''}, hidden: true}, h('span', {className: 'ra-dot', 'aria-hidden': 'true'}), h('span', {className: 'ra-state-text'})));
    const reason = h('span', {className: 'hint ra-reason', dataset: {agentReason: ''}, id: `agent-reason-${Date.now().toString(36)}`, hidden: true});
    button.setAttribute('aria-describedby', reason.id);
    after.after(button, reason);
    paintButton();
    return button;
  }
  function removeButton() {
    document.querySelectorAll('[data-agent-toggle],[data-agent-reason]').forEach(el => el.remove());
    closePopover();
  }
  function paintButton() {
    const button = document.querySelector('[data-agent-toggle]');
    if (!button) return;
    const reason = hasSession() ? '' : unavailable();
    const loading = !configError && !config && !!base;
    button.disabled = !!reason;
    button.title = reason || (hasSession() ? `Agent: ${STATE_LABEL[session.state] || session.state}. Open the session.` : 'Report agent: change the PoC format or ask a question');
    const reasonEl = document.querySelector('[data-agent-reason]');
    if (reasonEl) { reasonEl.textContent = loading ? '' : reason; reasonEl.hidden = loading || !reason; }
    const stateEl = button.querySelector('[data-agent-state]');
    stateEl.hidden = !hasSession();
    stateEl.dataset.state = session.state;
    stateEl.querySelector('.ra-state-text').textContent = STATE_LABEL[session.state] || '';
    button.dataset.state = session.state;
  }
  function onButton(event) {
    const button = event.currentTarget;
    if (pop && popAnchor === button) { closePopover(); return; }
    if (hasSession()) { ensureAgentTab(); BT()?.openTab?.('agent'); }
    openPopover(button, !hasSession());
  }

  // -- popover -----------------------------------------------------------------------
  function openPopover(anchor, focusForm) {
    closePopover();
    closeConvert();
    popAnchor = anchor;
    form.error = '';
    const cfgCli = config?.selected?.cli, ready = c => c?.sandbox_ready && c.id;
    if (!form.cli || !config?.clis?.some(c => c.id === form.cli && c.sandbox_ready)) {
      form.cli = ready(config?.clis?.find(c => c.id === cfgCli)) || ready(config?.clis?.find(c => c.sandbox_ready)) || cfgCli || null;
      form.model = form.cli === cfgCli ? config?.selected?.model : config?.clis?.find(c => c.id === form.cli)?.default_model;
      form.custom = '';
    }
    pop = h('div', {className: 'popover ra-pop', role: 'dialog', 'aria-label': 'Report agent', dataset: {agentPopover: ''}});
    document.body.appendChild(pop);
    anchor.setAttribute('aria-expanded', 'true');
    paintPopover();
    position(pop, anchor);
    loadAgents();
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onPopKey, true);
    window.addEventListener('resize', reposition);
    if (focusForm) pop.querySelector('[data-agent-format], textarea')?.focus({preventScroll: true});
  }
  function closePopover(returnFocus) {
    if (!pop) return;
    pop.remove(); pop = null;
    popAnchor?.setAttribute('aria-expanded', 'false');
    if (returnFocus) popAnchor?.focus({preventScroll: true});
    popAnchor = null;
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onPopKey, true);
    window.removeEventListener('resize', reposition);
  }
  const reposition = () => { if (pop && popAnchor) position(pop, popAnchor); if (convertMenu) position(convertMenu.el, convertMenu.anchor); };
  function onOutside(event) {
    if (pop?.contains(event.target) || popAnchor?.contains(event.target) || event.target.closest?.('dialog')) return;
    closePopover();
  }
  function onPopKey(event) {
    if (event.key === 'Escape' && !event.target.closest?.('dialog')) { event.preventDefault(); event.stopPropagation(); closePopover(true); }
  }
  // Below the anchor when it fits, else above; when neither fits, the side with
  // more room, with the height capped so the popover never covers its anchor.
  function position(el, anchor) {
    const r = anchor.getBoundingClientRect(), m = 8, gap = 6;
    el.style.maxHeight = '';
    const w = el.offsetWidth, natural = el.scrollHeight + 2;
    const below = window.innerHeight - r.bottom - gap - m, above = r.top - gap - m;
    const down = natural <= below || (natural > above && below >= above);
    const room = Math.max(120, down ? below : above);
    const ht = Math.min(natural, room);
    el.style.maxHeight = `${Math.round(room)}px`;
    const left = Math.max(m, Math.min(r.left, window.innerWidth - w - m));
    const top = down ? r.bottom + gap : r.top - gap - ht;
    Object.assign(el.style, {left: `${Math.round(left)}px`, top: `${Math.round(top)}px`});
  }

  function paintPopover() {
    if (!pop) return;
    const active = document.activeElement && pop.contains(document.activeElement) ? document.activeElement : null;
    const focusedKey = active ? focusKey(active) : null;
    const caret = active && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
    const live = running();
    const head = h('div', {className: 'ra-head'}, h('h2', {className: 'ra-title', text: 'Report agent'}),
      hasSession() ? statePill(session.state) : null);
    const parts = [head];
    if (hasSession()) parts.push(liveSection());
    if (!live) parts.push(startForm());
    parts.push(connectSection());
    pop.replaceChildren(...parts);
    paintConnect();
    const again = focusedKey ? pop.querySelector(focusedKey) : null;
    if (again) { again.focus({preventScroll: true}); if (caret) { try { again.setSelectionRange(caret[0], caret[1]); } catch {} } }
    if (popAnchor) position(pop, popAnchor);
  }
  const focusKey = el => (el.dataset.agentFormat ? `[data-agent-format="${el.dataset.agentFormat}"]` : el.name ? `[name="${el.name}"]` : el.dataset.agentAction ? `[data-agent-action="${el.dataset.agentAction}"]` : null);
  function statePill(state) {
    return h('span', {className: 'ra-pill', dataset: {state}}, h('span', {className: 'ra-dot', 'aria-hidden': 'true'}), STATE_LABEL[state] || state);
  }

  function liveSection() {
    const live = running();
    const bits = [cliLabel(session.cli), session.model ? modelLabel(session.model) : null, session.started ? `started ${ago(session.started)}` : null].filter(Boolean);
    if (session.state === 'exited') bits.push(`exit code ${session.exit_code ?? '?'}`);
    const stop = h('button', {type: 'button', className: 'button sm subtle', dataset: {agentAction: 'stop'}, text: live ? 'Stop' : 'Close session',
      title: live ? 'Stop the agent' : 'End the finished session and clear its output', onclick: () => stopAgent(live)});
    const openTab = h('button', {type: 'button', className: 'button sm primary', dataset: {agentAction: 'open'}, onclick: () => { ensureAgentTab(); BT()?.openTab?.('agent'); closePopover(); }},
      icon('terminal'), ' Open Agent tab');
    return h('div', {className: 'ra-live'},
      h('p', {className: 'ra-sub', text: bits.join(' · ')}),
      live ? h('p', {className: 'hint ra-copy', text: 'Answer its questions in the Agent tab. It asks before every shell command or web request.'}) : null,
      h('div', {className: 'ra-actions'}, stop, openTab));
  }

  function startForm() {
    const reason = unavailable();
    const chips = h('div', {className: 'ra-chips', role: 'group', 'aria-label': 'Change PoC format'},
      FORMATS.map(([id, label]) => h('button', {type: 'button', className: 'ra-chip', dataset: {agentFormat: id}, 'aria-pressed': String(form.format === id),
        onclick: () => { form.format = form.format === id ? null : id; form.error = ''; syncChips(); paintHint(); }}, label)));
    const syncChips = () => chips.querySelectorAll('[data-agent-format]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.agentFormat === form.format)));
    const area = h('textarea', {name: 'agent-ask', className: 'ra-ask', rows: 3, placeholder: 'Ask the agent...', 'aria-label': 'Ask the agent', value: form.text,
      oninput: event => { form.text = event.target.value; form.error = ''; if (form.format) { form.format = null; syncChips(); } paintHint(); }});
    const fields = modelFields(form, quiet => { form.error = ''; if (quiet) paintHint(); else paintPopover(); }, 'agent');
    const hint = h('p', {className: 'hint ra-hint', dataset: {agentHint: ''}, role: 'status', 'aria-live': 'polite'});
    const start = h('button', {type: 'button', className: 'button primary sm', dataset: {agentAction: 'start'}, onclick: () => startFromForm()}, icon('play'), ' Start');
    const wrap = h('div', {className: 'ra-form'},
      h('div', {className: 'ra-label', text: 'Change PoC format'}), chips,
      h('div', {className: 'ra-label', text: 'Or ask the agent'}), area,
      h('div', {className: 'ra-models'}, fields),
      hint,
      h('div', {className: 'ra-actions'}, h('span', {className: 'ra-where hint', text: 'Runs in this report\'s sandbox.'}), start));
    function paintHint() {
      const problem = formProblem();
      hint.textContent = form.error || reason || problem.text;
      hint.dataset.tone = form.error || reason || problem.bad ? 'warn' : '';
      start.disabled = !!reason || problem.bad || form.busy || !problem.ready;
      start.lastChild.textContent = form.busy ? ' Starting' : form.format ? ` Convert to ${FORMAT_LABEL[form.format]}` : ' Start';
    }
    paintHint();
    return wrap;
  }
  // {ready, bad, text} for the start form.
  function formProblem() {
    const model = effectiveModel(form);
    if (model === null) return {ready: false, bad: true, text: 'Custom model ids use lowercase letters, digits, dots and dashes.'};
    if (form.format) return {ready: true, bad: false, text: form.text.trim() ? 'A format change starts on its own. Ask your question in the Agent tab afterwards.' : ''};
    const text = form.text.replace(/\r\n?/g, '\n');
    if (!text.trim()) return {ready: false, bad: false, text: 'Pick a format or type a question.'};
    if (unsafe(text)) return {ready: false, bad: true, text: UNSAFE_TEXT};
    if (bytes(text) > MAX_ASK) return {ready: false, bad: true, text: 'The question is too long (8 KiB at most).'};
    return {ready: true, bad: false, text: ''};
  }
  // The model to send: the select, or the custom field (null when the custom id is invalid).
  function effectiveModel(state) {
    if (state.model !== '__custom') return state.model;
    return CUSTOM_RE.test(state.custom) ? state.custom : null;
  }

  // CLI and model selects (popover override and Settings). onChange repaints.
  function modelFields(state, onChange, prefix) {
    const clis = config?.clis || [];
    const cliSelect = h('select', {name: `${prefix}-cli`, className: 'ra-select', 'aria-label': 'CLI',
      onchange: event => { state.cli = event.target.value; state.model = clis.find(c => c.id === state.cli)?.default_model || 'default'; state.custom = ''; onChange(); }},
    clis.map(c => h('option', {value: c.id, disabled: !c.sandbox_ready, selected: c.id === state.cli},
      c.sandbox_ready ? `${c.label}${c.available ? '' : ' (not found on Hoster)'}` : `${c.label} (${NEEDS_LOGIN})`)));
    const cli = clis.find(c => c.id === state.cli);
    const models = cli?.models || ['default'];
    if (state.model && state.model !== '__custom' && !models.includes(state.model)) { state.custom = state.model; state.model = cli?.custom_models ? '__custom' : (cli?.default_model || 'default'); }
    const modelSelect = h('select', {name: `${prefix}-model`, className: 'ra-select', 'aria-label': 'Model',
      onchange: event => { state.model = event.target.value; onChange(); }},
    models.map(m => h('option', {value: m, selected: m === state.model}, m === 'default' ? 'Default model' : m)),
    cli?.custom_models ? h('option', {value: '__custom', selected: state.model === '__custom'}, 'Custom...') : null);
    const out = [h('label', {className: 'ra-field'}, h('span', {className: 'ra-field-label', text: 'CLI'}), cliSelect),
      h('label', {className: 'ra-field'}, h('span', {className: 'ra-field-label', text: 'Model'}), modelSelect)];
    if (state.model === '__custom') {
      const valid = CUSTOM_RE.test(state.custom);
      const input = h('input', {name: `${prefix}-custom`, className: 'ra-custom', type: 'text', value: state.custom, placeholder: 'model id', spellcheck: 'false', autocomplete: 'off',
        'aria-label': 'Custom model id', 'aria-invalid': String(!!state.custom && !valid),
        oninput: event => { state.custom = event.target.value.trim(); event.target.setAttribute('aria-invalid', String(!!state.custom && !CUSTOM_RE.test(state.custom))); onChange(true); }});
      out.push(h('label', {className: 'ra-field ra-field-custom'}, h('span', {className: 'ra-field-label', text: 'Model id'}), input));
    }
    return out;
  }

  // -- start and stop ----------------------------------------------------------------
  function overrides(cli, model) {
    const selected = config?.selected || {};
    return cli && model && (cli !== selected.cli || model !== selected.model) ? {cli, model} : {};
  }
  async function startFromForm() {
    const problem = formProblem();
    if (!problem.ready || problem.bad || form.busy) return;
    const task = form.format ? {kind: 'poc_format', format: form.format} : {kind: 'ask', text: form.text.replace(/\r\n?/g, '\n')};
    form.busy = true; form.error = ''; paintPopover();
    const error = await start(task, overrides(form.cli, effectiveModel(form)));
    form.busy = false;
    if (error) { form.error = error; paintPopover(); return; }
    form.text = ''; form.format = null;
    closePopover();
  }
  // Returns '' on success, else the message to show.
  async function start(task, extra = {}) {
    const key = selKey;
    try {
      const info = await api('api/agent/start', {selector: sel, task, ...extra});
      if (key !== selKey) return '';
      setSession(info);
    } catch (error) {
      if (key !== selKey) return '';
      if (error.code === 'agent_running' && error.data?.agent) { setSession(error.data.agent); ensureAgentTab(); BT()?.openTab?.('agent'); return 'An agent is already running for this report. Opened it.'; }
      if (error.code === 'login_missing' || error.code === 'report_agent_disabled' || error.code === 'cli_not_sandbox_ready') loadConfig(true);
      return error.message || 'The agent could not start.';
    }
    ensureAgentTab();
    BT()?.openTab?.('agent');
    schedulePoll(1500);
    return '';
  }
  async function stopAgent(confirmFirst) {
    if (confirmFirst && !(await confirmStop())) return;
    const key = selKey;
    try { await api('api/agent/stop', {selector: sel}); }
    catch (error) { window.BoardUI?.toast?.(`Not stopped: ${error.message}`, 'warning'); return; }
    if (key !== selKey) return;
    setSession({state: 'none'});
    closePopover();
    window.BoardUI?.toast?.('Agent stopped. Its edits stay in the report folder.', 'success', {timeout: 4000});
  }
  // Same dialog as finding-actions.js confirmDialog(), through BoardLedgerActions.dialog.
  function confirmStop() {
    const LA = window.BoardLedgerActions;
    if (typeof LA?.dialog !== 'function') return Promise.resolve(window.confirm('Stop the agent?'));
    return new Promise(resolve => {
      const node = LA.dialog('Stop the agent?', 'report-agent-stop-text');
      node.classList.add('ra-dialog');
      let answer = false;
      const yes = h('button', {type: 'button', className: 'button danger-button', dataset: {agentConfirm: 'stop'}, text: 'Stop agent', onclick: () => { answer = true; node.close(); }});
      const no = h('button', {type: 'button', className: 'button subtle', text: 'Cancel', onclick: () => node.close()});
      node.append(h('div', {id: 'report-agent-stop-text'},
        h('p', {className: 'hint', text: 'The agent stops now, even in the middle of a step.'}),
        h('p', {className: 'hint', text: 'Edits it already made stay in the report folder. The Agent tab closes.'})),
      h('div', {className: 'ledger-dialog-actions'}, yes, no));
      node.addEventListener('close', () => resolve(answer));
      node.showModal(); no.focus();
    });
  }

  // -- Agent tab (kind=agent) ------------------------------------------------------
  function ensureAgentTab() {
    const T = BT();
    if (!T?.registerTab || !sel || T.tabs().includes('agent')) return;
    T.registerTab({id: 'agent', label: 'Agent', title: 'Report agent session (in the sandbox)', connect: connectAgent});
  }
  function agentMeta() {
    const bits = [cliLabel(session.cli), session.model ? modelLabel(session.model) : null].filter(Boolean);
    if (session.viewers > 1) bits.push(`${session.viewers} viewers`);
    if (session.state === 'exited') bits.push(`exit code ${session.exit_code ?? '?'}`);
    return bits.join(' · ');
  }
  function paintAgentTab() {
    if (!agentTab?.connected) return;
    const state = session.state === 'none' ? 'exited' : session.state;
    agentTab.api.setStatus(state, STATE_LABEL[state] || state, state === 'waiting' ? 'The agent is quiet: it is probably waiting for your answer.' : '');
    agentTab.api.setMeta(agentMeta());
  }
  const wsUrl = q => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${base}ws?${q}`;

  // Shared WebSocket attach for a tab: same messages for kind=agent and kind=connect.
  function attachSocket(id, container, tabApi, q, handlers) {
    const made = tabApi.createTerm({onData: d => send({t: 'in', d}), onResize: (cols, rows) => send({t: 'resize', cols, rows})});
    let ws = null, closed = false, failed = false, retry = 0, timer = null;
    function send(message) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(message)); }
    function open() {
      if (closed) return;
      failed = false;
      tabApi.setStatus(retry ? 'reconnecting' : 'connecting', retry ? 'Reconnecting' : 'Connecting');
      const socket = new WebSocket(wsUrl(q));
      socket.binaryType = 'arraybuffer';
      ws = socket;
      socket.onopen = () => { if (ws !== socket) return; made.refit(); send({t: 'resize', cols: made.term.cols, rows: made.term.rows}); };
      socket.onmessage = event => {
        if (ws !== socket) return;
        if (typeof event.data !== 'string') { made.term.write(new Uint8Array(event.data)); handlers.output?.(); return; }
        let message; try { message = JSON.parse(event.data); } catch { return; }
        if (message.type === 'hello') { made.term.reset(); retry = 0; tabApi.note(''); send({t: 'resize', cols: made.term.cols, rows: made.term.rows}); }
        if (message.type === 'error') { failed = true; tabApi.note(message.message || 'Could not attach.'); tabApi.setStatus('error', 'Error'); }
        if (message.type === 'closed') tabApi.note(message.message || 'The session closed.');
        handlers.message?.(message);
      };
      socket.onclose = () => {
        if (ws !== socket) return;
        ws = null;
        if (closed || failed || handlers.ended?.()) return;
        retry = Math.min((retry || 1000) * 2, 30000);
        tabApi.setStatus('reconnecting', 'Reconnecting');
        timer = setTimeout(open, retry);
      };
    }
    open();
    const handle = {
      dispose() { closed = true; clearTimeout(timer); const old = ws; ws = null; try { old?.close(); } catch {} made.dispose(); if (handles.get(id) === handle) handles.delete(id); handlers.disposed?.(); },
      focus() { made.term.focus(); },
      refit: made.refit,
      term: made.term,
    };
    handles.set(id, handle);
    return handle;
  }

  function connectAgent(container, tabApi) {
    const mine = {api: tabApi, connected: false};
    agentTab = mine;
    const key = selKey;
    let exited = false;
    return attachSocket('agent', container, tabApi, `${query(sel)}&kind=agent`, {
      message(message) {
        if (message.type === 'hello') { mine.connected = true; if (message.agent && key === selKey) setSession(message.agent); paintAgentTab(); }
        else if (message.type === 'viewers') { if (key === selKey) setSession({...session, viewers: message.count}); }
        else if (message.type === 'exit') { exited = true; if (key === selKey) setSession({...session, state: 'exited', exit_code: message.code}); paintAgentTab(); }
        else if (message.type === 'error' && message.code === 'no_agent') { tabApi.note('No agent is running for this report. Start one from the Agent button.'); }
      },
      // Output while the button says waiting: check the session soon instead of
      // at the slow poll, so the dot turns Working while the agent prints.
      output() { if (key === selKey && session.state !== 'working' && session.state !== 'starting' && !soonPoll) { soonPoll = true; schedulePoll(400); } },
      ended: () => exited && session.state === 'none',
      disposed() { if (agentTab === mine) agentTab = null; },
    });
  }

  // -- agent connect (kind=connect, no sandbox) ---------------------------------------
  async function loadAgents() {
    if (!pop || !sel) return;
    const key = selKey, all = agentsView.all;
    agentsView.loading = true; agentsView.error = '';
    paintConnect();
    try {
      // all=1 carries no selector, so its items have match null: the scoped list
      // (fetched alongside) says which of them are in this lane or program.
      const [data, scoped] = await Promise.all([api(all ? 'api/agents/active?all=1' : `api/agents/active?${query(sel)}`),
        all ? api(`api/agents/active?${query(sel)}`).catch(() => null) : null]);
      if (key !== selKey || all !== agentsView.all) return;
      if (scoped?.agents) {
        const id = item => JSON.stringify([item.pane_id, item.terminal_id]);
        const matches = new Map(scoped.agents.map(item => [id(item), item.match]));
        data.agents = (data.agents || []).map(item => (item.match == null && matches.get(id(item)) ? {...item, match: matches.get(id(item))} : item));
      }
      agentsView.enabled = !!data.enabled;
      const rank = item => (item.match === 'lane' ? 0 : item.match === 'program' ? 1 : 2);
      agentsView.items = (data.agents || []).map((item, i) => ({item, i})).sort((a, b) => rank(a.item) - rank(b.item) || a.i - b.i).map(x => x.item);
    } catch (error) {
      if (key !== selKey) return;
      agentsView.error = error.message || 'Could not list the agents.';
      agentsView.items = [];
    }
    agentsView.loading = false;
    paintConnect();
  }
  function connectSection() {
    return h('section', {className: 'ra-connect', dataset: {agentConnect: ''}, 'aria-label': 'Running agents on this program'});
  }
  function paintConnect() {
    const host = pop?.querySelector('[data-agent-connect]');
    if (!host) return;
    const off = agentsView.enabled === false || (agentsView.enabled === null && status && status.agent_connect === false);
    if (off) {
      host.replaceChildren(h('p', {className: 'hint ra-off', dataset: {agentConnectOff: ''}, text: 'Connecting to running agents is off on this Board.'}));
      return;
    }
    const showAll = h('button', {type: 'button', className: 'button sm ghost ra-showall', dataset: {agentAction: 'show-all'}, 'aria-pressed': String(agentsView.all),
      title: agentsView.all ? 'Show only agents in this program' : 'Show every agent on Hoster',
      onclick: () => { agentsView.all = !agentsView.all; loadAgents(); }}, agentsView.all ? 'This program' : 'Show all');
    const refresh = h('button', {type: 'button', className: 'button sm ghost icon-only', dataset: {agentAction: 'refresh'}, 'aria-label': 'Refresh the list', title: 'Refresh the list', onclick: () => loadAgents()}, icon('refresh'));
    const head = h('div', {className: 'ra-connect-head'}, h('h3', {text: agentsView.all ? 'All running agents' : 'Running agents on this program'}), h('span', {className: 'ra-connect-tools'}, refresh, showAll));
    const body = [];
    if (agentsView.loading && !agentsView.items.length) body.push(h('p', {className: 'hint', text: 'Loading...'}));
    else if (agentsView.error) body.push(h('p', {className: 'hint ra-error', text: agentsView.error}));
    else if (!agentsView.items.length) body.push(h('p', {className: 'hint', text: agentsView.all ? 'No agents are running on Hoster.' : 'No agents are running in this program. Show all lists every agent.'}));
    else body.push(h('ul', {className: 'ra-agents', dataset: {agentList: ''}}, agentsView.items.map(agentRow)));
    host.replaceChildren(head, h('p', {className: 'hint ra-copy', text: CONNECT_COPY}), ...body);
    if (popAnchor) position(pop, popAnchor);
  }
  function agentRow(item) {
    const kind = KIND_LABEL[item.agent] || item.agent || 'Agent';
    const title = item.title || item.pane_id || 'Untitled agent';
    const where = item.cwd_relative == null ? 'outside Shared' : item.cwd_relative || '.';
    const pills = h('span', {className: 'ra-row-pills'},
      item.unsafe_chars ? h('span', {className: 'badge warning ra-unsafe', dataset: {agentUnsafe: ''}, title: 'Shown escaped: the original text has control or invisible characters.'}, icon('exclamation-triangle'), 'escaped') : null,
      h('span', {className: 'badge outline', dataset: {agentKind: item.agent || ''}, text: kind}),
      h('span', {className: `badge ${STATUS_TONE[item.status] ?? ''}`.trim(), dataset: {agentStatus: item.status || ''}, text: item.status || 'unknown'}));
    const button = h('button', {type: 'button', className: 'ra-row', dataset: {agentPane: item.pane_id || '', agentMatch: item.match || ''},
      title: `Connect to ${title}`, onclick: () => openConnect(item)},
    h('span', {className: 'ra-row-main'}, h('span', {className: 'ra-row-title', text: title}), h('span', {className: 'ra-row-sub', text: where})),
    pills);
    return h('li', {}, button);
  }
  function connectId(item) {
    const hash = BT()?.sha256hex ? BT().sha256hex(JSON.stringify([item.pane_id, item.terminal_id, item.session_ref])).slice(0, 12) : String(Date.now());
    return `connect-${hash}`;
  }
  function openConnect(item) {
    const T = BT();
    if (!T?.registerTab) return;
    const id = connectId(item);
    if (!T.tabs().includes(id)) {
      const kind = KIND_LABEL[item.agent] || item.agent || 'Agent';
      const short = String(item.title || item.pane_id || '').slice(0, 22);
      const q = new URLSearchParams({kind: 'connect', pane: item.pane_id, terminal_id: item.terminal_id, session_ref: item.session_ref}).toString();
      T.registerTab({id, label: short ? `${kind} · ${short}` : kind, title: `${kind}: ${item.title || item.pane_id} (real session on Hoster)`, heading: 'Hoster', closable: true,
        connect: (container, tabApi) => {
          tabApi.setMeta('Real session on Hoster, no sandbox. Typing goes to the agent.');
          let ended = false;
          return attachSocket(id, container, tabApi, q, {
            message(message) {
              if (message.type === 'hello') tabApi.setStatus('connected', 'Connected', 'Attached to the agent through Herdr.');
              else if (message.type === 'exit') { ended = true; tabApi.setStatus('exited', 'Ended', 'The attach ended. Close the tab and connect again from the list.'); }
            },
            ended: () => ended,
          });
        }});
    }
    closePopover();
    T.openTab(id);
  }

  // -- Convert on code blocks (BoardTerminal.registerBlockAction) ---------------------
  function convertReason(block) {
    if (block.unsafe) return block.unsafeMessage;
    if (running()) return 'An agent is already running for this report. Open it from the Agent button.';
    const reason = unavailable();
    if (reason) return reason;
    if (!block.text || bytes(block.text) > MAX_BLOCK) return 'This block is too large for the agent (64 KiB at most).';
    return '';
  }
  function decorateBlock(bar, block) {
    let button = bar.querySelector('[data-term-action="agent-convert"]');
    if (!base || !config?.enabled) { button?.remove(); return; }
    if (!button) {
      button = h('button', {type: 'button', className: 'button sm subtle ra-convert', dataset: {termAction: 'agent-convert'}}, icon('exchange'), ' Convert');
      const check = bar.querySelector('.term-check');
      if (check) check.before(button); else bar.appendChild(button);
    }
    const reason = convertReason(block);
    button.disabled = !!reason;
    button.title = reason || 'Have the agent rewrite this block as another PoC format';
    button._block = {text: block.text, lang: LANG_RE.test(block.lang) ? block.lang : '', index: block.index};
  }
  document.addEventListener('click', event => {
    const button = event.target.closest?.('[data-term-action="agent-convert"]');
    if (!button || button.disabled) return;
    event.preventDefault();
    if (convertMenu?.anchor === button) { closeConvert(); return; }
    openConvert(button);
  });
  function openConvert(anchor) {
    closeConvert();
    closePopover();
    const block = anchor._block;
    const status = h('p', {className: 'hint ra-hint', role: 'status', 'aria-live': 'polite'});
    const el = h('div', {className: 'popover ra-pop ra-convert-menu', role: 'dialog', 'aria-label': 'Convert this block', dataset: {agentConvertMenu: ''}},
      h('div', {className: 'ra-head'}, h('h2', {className: 'ra-title', text: 'Convert this block'})),
      h('p', {className: 'ra-sub', text: `Block ${block.index + 1}${block.lang ? ` (${block.lang})` : ''}. The agent updates every place in the report that uses it.`}),
      h('div', {className: 'ra-chips', role: 'group', 'aria-label': 'Format'}, FORMATS.map(([id, label]) => h('button', {type: 'button', className: 'ra-chip', dataset: {agentFormat: id},
        onclick: async event => {
          el.querySelectorAll('button').forEach(b => { b.disabled = true; });
          event.currentTarget.setAttribute('aria-pressed', 'true');
          status.textContent = 'Starting the agent...';
          const error = await start({kind: 'poc_format', format: id, block: {text: block.text, lang: block.lang, index: block.index}});
          if (error) { status.textContent = error; status.dataset.tone = 'warn'; el.querySelectorAll('button').forEach(b => { b.disabled = false; }); return; }
          closeConvert();
        }}, label))),
      status,
      h('p', {className: 'hint', text: `Uses ${cliLabel(config?.selected?.cli)}, ${modelLabel(config?.selected?.model || 'default')} (Settings).`}));
    document.body.appendChild(el);
    convertMenu = {el, anchor};
    anchor.setAttribute('aria-expanded', 'true');
    position(el, anchor);
    el.querySelector('[data-agent-format]')?.focus({preventScroll: true});
    document.addEventListener('pointerdown', onConvertOutside, true);
    document.addEventListener('keydown', onConvertKey, true);
  }
  function closeConvert(returnFocus) {
    if (!convertMenu) return;
    const {el, anchor} = convertMenu;
    convertMenu = null;
    el.remove();
    anchor.setAttribute('aria-expanded', 'false');
    if (returnFocus && anchor.isConnected) anchor.focus({preventScroll: true});
    document.removeEventListener('pointerdown', onConvertOutside, true);
    document.removeEventListener('keydown', onConvertKey, true);
  }
  function onConvertOutside(event) { if (!convertMenu?.el.contains(event.target) && !convertMenu?.anchor.contains(event.target)) closeConvert(); }
  function onConvertKey(event) { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeConvert(true); } }

  // -- Settings: Agent section ------------------------------------------------------
  function renderSettings(host) {
    const state = {cli: null, model: null, custom: '', saving: false, message: '', tone: ''};
    let alive = true;
    const paint = () => {
      if (!alive) return;
      const parts = [];
      if (configError) {
        parts.push(h('p', {className: 'hint ra-set-off', dataset: {agentSettingsOff: ''}, text: configError.status === 401 ? 'Sign in to the terminal to see the agent settings.' : 'The terminal service is not reachable, so the agent settings cannot load. Try again later.'}));
      } else if (!config) {
        parts.push(h('p', {className: 'hint', text: 'Loading...'}));
      } else if (!config.enabled) {
        parts.push(h('p', {className: 'hint ra-set-off', dataset: {agentSettingsOff: ''}, text: 'The report agent is off on this Board. The terminal service needs the --report-agent flag.'}));
      } else {
        if (state.cli === null) { state.cli = config.selected?.cli; state.model = config.selected?.model; }
        const model = effectiveModel(state);
        const dirty = state.cli !== config.selected?.cli || model !== config.selected?.model;
        const save = h('button', {type: 'button', className: 'button sm primary', dataset: {agentSave: ''}, disabled: state.saving || !dirty || model === null, onclick: saveSettings}, state.saving ? 'Saving' : 'Save');
        parts.push(h('div', {className: 'set-row ra-set-row'},
          h('div', {className: 'set-text'}, h('span', {className: 'set-label', text: 'CLI and model'}),
            h('p', {className: 'hint', text: 'Used for every report agent. Saved on the terminal service, so it applies on every device.'})),
          h('div', {className: 'set-controls ra-set-controls'}, modelFields(state, quiet => { state.message = ''; if (quiet) paintSave(); else paint(); }, 'set-agent'), save)));
        parts.push(h('p', {className: `hint ra-set-msg${state.tone ? ` ${state.tone}` : ''}`, dataset: {agentSettingsMsg: ''}, role: 'status', 'aria-live': 'polite',
          text: state.message || (model === null ? 'Custom model ids use lowercase letters, digits, dots and dashes.' : '')}));
        const login = config.login || {};
        parts.push(h('div', {className: 'set-row'},
          h('div', {className: 'set-text'}, h('span', {className: 'set-label', text: 'Sandbox login'}),
            login.ready ? h('p', {className: 'hint', text: 'The agent signs in through the host relay. The token never enters the sandbox.'}) : h('p', {className: 'hint', dataset: {agentLoginHint: ''}, text: LOGIN_HINT})),
          h('span', {className: `badge ${login.ready ? 'success' : 'warning'}`, dataset: {agentLogin: login.ready ? 'ready' : 'missing'}, text: login.ready ? 'Sandbox login ready' : 'No sandbox login on Hoster yet'})));
      }
      const connectOn = status ? !!status.agent_connect : null;
      parts.push(h('div', {className: 'set-row'},
        h('div', {className: 'set-text'}, h('span', {className: 'set-label', text: connectOn === null ? 'Connect to running agents: unknown' : `Connect to running agents: ${connectOn ? 'on' : 'off'}`, dataset: {agentConnectFlag: connectOn === null ? 'unknown' : connectOn ? 'on' : 'off'}}),
          h('p', {className: 'hint', text: 'A terminal service setting (--agent-connect), not changed here. When on, the Agent button lists agents running on Hoster.'}))));
      host.replaceChildren(...parts);
    };
    const paintSave = () => {
      const model = effectiveModel(state);
      const button = host.querySelector('[data-agent-save]');
      if (button) button.disabled = state.saving || model === null || (state.cli === config.selected?.cli && model === config.selected?.model);
      const msg = host.querySelector('[data-agent-settings-msg]');
      if (msg) msg.textContent = state.message || (model === null ? 'Custom model ids use lowercase letters, digits, dots and dashes.' : '');
    };
    async function saveSettings() {
      const model = effectiveModel(state);
      if (model === null) return;
      state.saving = true; state.message = ''; paint();
      try {
        config = await api('api/agent/config', {cli: state.cli, model});
        configAt = Date.now(); configError = null;
        state.cli = config.selected.cli; state.model = config.selected.model; state.custom = '';
        state.message = 'Saved for every device.'; state.tone = '';
        paintButton(); BT()?.refreshBlocks?.();
      } catch (error) { state.message = `Not saved: ${error.message}`; state.tone = 'ra-error'; }
      state.saving = false;
      paint();
    }
    paint();
    // base is set by this module's afterRender, which runs after the Settings module's in the same pass.
    Promise.resolve().then(() => loadConfig(true)).then(paint);
    return () => { alive = false; };
  }
  window.BoardSettings?.register?.({id: 'agent', group: 'terminal', title: 'Agent', order: 20, render: renderSettings});

  // -- module hook ---------------------------------------------------------------------
  BT()?.registerBlockAction?.({id: 'agent-convert', order: 50, decorate: decorateBlock});
  BT()?.on?.('mount', () => { paintButton(); paintPopover(); });

  window.registerBoardModule?.({
    name: 'report-agent',
    afterRender(context) {
      ctx = context;
      const nextBase = context.state?.data?.capabilities?.terminal_url || null;
      if (nextBase !== base) { base = nextBase; config = null; configError = null; configAt = 0; }
      const host = document.getElementById('live-report-host') || document.getElementById('report-artifacts-host');
      const next = base && host?.dataset.path ? {family: host.dataset.family, program: host.dataset.program, lane: host.dataset.lane, path: host.dataset.path} : null;
      if (!next) {
        if (sel) { sel = null; selKey = ''; clearTimeout(pollTimer); session = {state: 'none'}; sessionSig = ''; agentTab = null; }
        removeButton(); closeConvert();
        return;
      }
      const key = keyOf(next);
      if (key !== selKey) {
        sel = next; selKey = key;
        session = {state: 'none'}; sessionSig = ''; agentTab = null;
        agentsView.all = false; agentsView.items = []; agentsView.enabled = null;
        form.format = null; form.text = ''; form.error = '';
        closePopover(); closeConvert();
        loadConfig();
        pollSession();
      }
      placeButton();
      paintButton();
    },
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && sel) schedulePoll(0); });

  // For synthetic browser tests and diagnostics only.
  window.BoardReportAgent = {get session() { return {...session}; }, get config() { return config; }, tabTerm: id => handles.get(id)?.term || null, unavailable};
})();
