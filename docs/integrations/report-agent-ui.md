# Report agent UI (phase 2)

- Branch: `feat/board-report-agent-ui`; base `608a962` (the terminal UX integration `49c76c9` merged with the report agent backend `0ed4682`). Commits: `db7fbf4` (feature, tests, screenshots), plus this dossier.
- Contract built against: [`report-agent.md`](report-agent.md) (routes, session info, WebSocket kinds, task shape). Drawer and Settings registry: [`terminal-ux.md`](terminal-ux.md). Terminal rules (Board-only controls, typing filter): [`sandbox-terminal.md`](sandbox-terminal.md).
- No backend change. No `app.js` change. No backend bug found.

Ryu's request, short: an Agent button on the report that changes the PoC format (curl, Python, browser JS, raw HTTP) and updates the report in our format, and lets him talk to that agent session right there; model and CLI choice in Settings; the report agent runs in the sandbox with one Claude login made on Hoster; connecting to an already running agent needs no sandbox.

## What changed for the user

### Settings: Agent section

Inside the Terminal card (`BoardSettings.register({id: 'agent', group: 'terminal', title: 'Agent', order: 20})`), loaded from `GET /terminal/api/agent/config` and `GET /terminal/api/status`:

- **CLI and model.** Every CLI is listed. Codex, OMP and OpenCode are disabled options reading "Codex (Needs a sandbox login on Hoster)". A sandbox-ready CLI whose binary is missing says "(not found on Hoster)". The model select has the CLI's models ("Default model", opus, sonnet, haiku) and "Custom..." when the CLI accepts custom ids; Custom shows a "Model id" field validated with the backend's rule (`[a-z0-9]([a-z0-9.-]{0,62}[a-z0-9])?`), with `aria-invalid` and a short reason, and Save stays disabled until it is valid. Save sends `POST /terminal/api/agent/config {cli, model}` and says "Saved for every device." The hint says the choice is saved on the terminal service and applies on every device (the card's own note, "Saved in this browser.", is about the terminal switches above).
- **Sandbox login.** A pill: "Sandbox login ready", or "No sandbox login on Hoster yet" plus deploy step 1 as one plain line ("On Hoster, run claude setup-token, then save only the printed token in ~/.config/bounty-board/report-agent.token (mode 0600, outside the data root)."). No token content is ever shown (the page only reads `login.ready`).
- **Connect to running agents: on/off**, read-only text with "A terminal service setting (--agent-connect), not changed here."
- **Off states.** Feature off: "The report agent is off on this Board. The terminal service needs the --report-agent flag." Service unreachable: "The terminal service is not reachable, so the agent settings cannot load. Try again later." (401: "Sign in to the terminal to see the agent settings."). Terminal not enabled: the existing Terminal card text ("The sandbox terminal is not enabled on this Board."), sections are not rendered.

### Agent button

- Placed right after the Terminal button and its reason text, wherever the terminal places it (live editor bar, or under the Reports heading in the non-live view).
- Disabled, with the reason as tooltip and visible text next to it, in this order: "Terminal service unavailable." (config request failed; 401 says "Sign in to the terminal to use the agent."), "The report agent is off on this Board.", the terminal's own `/api/mount` message for reports outside a finding packet ("This report is not inside a finding folder (reports/<FID>-…/)."), "No sandbox login on Hoster yet.". While the config loads the button is disabled with no visible reason (no flicker).
- **Popover** ("Report agent"): "Change PoC format" chips (Python, curl, Browser JS, Raw HTTP, Best fit; one chip at a time, click again to clear), "Or ask the agent" textarea ("Ask the agent..."), CLI and Model selects defaulting to the Settings choice (per-run override; non-ready CLIs disabled), and Start (rightmost; reads "Convert to Python" when a chip is picked). The hint line says what is missing ("Pick a format or type a question."), refuses unsafe text before sending ("The text contains control or invisible characters. Remove them and try again.", the drawer's own `unsafeText`), caps questions at 8 KiB, and notes that a typed question is not sent with a format change. CRLF is sent as LF.
- Start sends `POST /terminal/api/agent/start {selector, task, cli?, model?}` (`cli`/`model` only when they differ from the saved choice), closes the popover and opens the drawer on the Agent tab. `409 agent_running` opens the running agent instead; other errors show the service's message in the popover.
- **Live agent.** The button shows a status pill: "Working" (pulsing dot), "Waiting for you", "Exited". Clicking it opens the drawer on the Agent tab and the popover, which now shows the CLI, model, start time, "Answer its questions in the Agent tab. It asks before every shell command or web request.", Stop (left) and Open Agent tab (right). Stop asks first through `BoardLedgerActions.dialog` (same shape as `confirmDialog()` in `finding-actions.js`: "Stop the agent?", Stop agent / Cancel), then `POST /api/agent/stop`, removes the Agent tab, closes the popover and toasts "Agent stopped. Its edits stay in the report folder." An exited agent offers "Close session" (no confirm: nothing is running) and the start form again.
- **Polling.** `GET /api/agent/session` while the report is open and the page is visible: every 3 s while `starting`/`working`, every 10 s otherwise, immediately when the page becomes visible, and 0.4 s after the Agent tab receives output while the button does not say Working (so a short burst is not missed). The button, tab dot, popover and Convert buttons redraw only when `[state, cli, model, started, exit_code, viewers]` changes.

### Convert on code blocks

Each block bar in the preview (play, Run, Checked) gets "Convert" before Checked, through the new `registerBlockAction` seam. It shows only when the feature is on. It is disabled with the reason when the block fails the drawer's filter (the existing message, "This block contains control characters and cannot be typed; copy it manually after review."; `block.unsafe` comes from the terminal's `unsafeText`, no second filter), when an agent already runs for the report, when the agent is unavailable (same reasons as the button), or when the block is over 64 KiB. Its menu ("Convert this block", "Block 3 (python). The agent updates every place in the report that uses it.") has the five format chips; a chip starts the agent with `task = {kind: 'poc_format', format, block: {text, lang, index}}` (`lang` sent only when it matches the backend's pattern, else `''`) using the Settings CLI and model. The button lives in the Board-only bar, so `user-select: none` and the preview copy handler already keep it out of copies; the browser test checks the file and the editor value are byte-identical after a Convert and that a copy of the whole preview has no control text or markup.

### Drawer tabs

- A tab strip appears under the drawer header only while a module registered a tab: Terminal, Agent (when this report has an agent: after a start, or found by the poll, also when another device started it), and one closable tab per connect session ("OMP · Lane hunter on D1"). Tabs carry a status dot; labels ellipsize, the strip scrolls; Left/Right/Home/End move between tabs.
- Every tab is its own xterm created by the drawer's shared factory: the same key handler (toggle keys, Ctrl+C copies a selection, paste keys), copy on select, paste guard on every insertion route (paste, beforeinput/input, composition, keyCode 229), theme and refit rules. The status pill, note line and meta text follow the active tab (Agent: "Working" / "Waiting for you" / "Exited", meta "Claude Code · opus · 2 viewers · exit code 7"). Reset sandbox and Save output as evidence act on the shell, so they show only on the Terminal tab; the steps count too.
- WebSockets: Agent `?<selector>&kind=agent`; connect `?kind=connect&pane=…&terminal_id=…&session_ref=…`. Same client messages (`in`, `resize`); `hello` resets the screen, `error` shows its message and stops retrying, other closes reconnect with backoff (1 s doubling to 30 s).
- **Decision: switching tabs keeps the other sessions attached** (hidden), so the agent keeps streaming and scrollback stays without a reattach. Closing the drawer detaches every tab (viewers leave, so sandboxes can pause and Herdr attach clients end after their grace); opening it again reattaches the active tab (the service replays the last 256 KiB). A report change removes all registered tabs. Closing a connect tab detaches it.
- **Decision: the shell attaches only when its tab is shown.** Opening the drawer on the Agent or a connect tab does not start a shell viewer; picking Terminal does. Typing from a block's play/Run switches to the Terminal tab.
- The ports chip (sibling session) can use `BoardTerminal.slot('ports')` in the header as before; the tab strip is a separate row and does not touch the slots.

### Connect to running agents

In the popover, under the start form or the live section: "Running agents on this program", loaded from `GET /api/agents/active?<selector>`, lane matches first, then program matches (stable within each). "Show all" (`aria-pressed`) reloads with `all=1` and the heading reads "All running agents"; because `all=1` carries no selector (its items all have `match: null`), the scoped list is fetched alongside and its matches are carried over, so lane and program agents still come first. Rows follow the Recent row: title and a muted monospace subline (`cwd_relative`, or "outside Shared") on the left; pills on the right on one line ("escaped" warning when `unsafe_chars`, agent kind Claude/OMP, status working/idle/blocked/done). Every string is set with `textContent`; escaped values are shown as the service escaped them. The copy says: "These are the agents' real sessions on Hoster, outside any sandbox. What you type goes straight to the agent." A connect tab's drawer heading reads "Hoster" (not "Sandbox") and its meta says "Real session on Hoster, no sandbox. Typing goes to the agent." With connect off the section is one muted line: "Connecting to running agents is off on this Board."

## Seams added to `sandbox-terminal.js`

All on `window.BoardTerminal` (the drawer still owns everything; agent logic stays in `report-agent.js`):

```js
// Drawer tabs. connect runs when the tab is first shown while the drawer is open (after xterm loads).
const off = BoardTerminal.registerTab({
  id: 'agent',                 // [a-z][a-z0-9-]{0,47}, not 'terminal'; registering again replaces it
  label: 'Agent', title: '…',  // tab text and tooltip
  heading: 'Hoster',           // optional: replaces the drawer title ("Sandbox") while the tab shows
  closable: false, onClose() {},
  connect(container, api) {    // returns {dispose(), focus?(), refit?()}
    const {term, refit, dispose} = api.createTerm({onData, onResize});  // shared factory: same key handler, copy, paste guard, theme
    api.setStatus('working', 'Working', 'tooltip');   // drawer pill and tab dot while the tab shows
    api.note('text'); api.setMeta('text'); api.flash('Copied', 'ok');
  },
});
BoardTerminal.openTab('agent');      // opens the drawer (if the report has a terminal) on that tab; false otherwise
BoardTerminal.updateTab(id, {label, title}); BoardTerminal.removeTab(id);
BoardTerminal.activeTab(); BoardTerminal.tabs(); BoardTerminal.open;

// Code-block actions: decorate runs on every pass over the preview, must be idempotent.
BoardTerminal.registerBlockAction({id: 'agent-convert', order: 50, decorate(bar, block) {}});
// block = {text, lang, index, unsafe, unsafeMessage, blocked, blockedMessage}
BoardTerminal.refreshBlocks();       // re-run the decoration pass

// The /api/mount answer for the current report ({ok, message, …} or null while unknown).
BoardTerminal.mount(); BoardTerminal.on('mount', mount => {});
```

Internally the old `ensureTerm`/`onTermKey`/`copySelection` bodies became `makeTerm(screen, {onData, onResize, note})` and `termKeyHandler(term)`, used by the shell and by every tab, so the typing filter and paste guard keep a single implementation. The note line is per tab. `paint()` shows the active tab's status, note and meta, and hides the sign-in/down overlays and Reset/Save off the Terminal tab. The existing 18 drawer tests pass unchanged.

## Tests

New: `tests/report_agent_browser_fixture.py` (Board + in-process terminal service with the test-only local backend, `tests/fake_agent_cli.py` as `claude`, `tests/fake_model_upstream.py` as a TLS model upstream trusted only through the constructor, a 0600 fake token file outside the root, `tests/fake_herdr.py` with four synthetic agents; modes `nologin`, `agentoff`, `noconnect`, `down`, `nolive`), and `static/tests/report-agent.synthetic.test.cjs` (added to the `npm test` script after `sandbox-terminal-filter.test.cjs`). Never a real CLI, login, Herdr or Anthropic; no Docker.

- **settings:** load (all four CLIs, three disabled with "Needs a sandbox login on Hoster", models, login pill, connect flag, no toggle, "every device"), save `opus` (file `agent-settings.json` checked), Custom refused for `Bad_Model` then saved as `claude-synthetic-9`, persisted after reload, no token text; `nologin` pill and setup line; `agentoff,noconnect` off text and "Connect to running agents: off".
- **disabled states:** placement after the Terminal button and its reason; `active.md` uses the terminal's mount message; `nologin`, `agentoff`, `down` reasons; non-live view placement; `noconnect` one muted line and no list.
- **popover start and Agent tab:** chips; unsafe question refused; `start` body exactly `{selector, task: {kind: 'poc_format', format: 'python'}, cli: 'claude', model: 'opus'}`; drawer on the Agent tab with tabs Terminal/Agent; the fake CLI's output (argv with `--model opus`, the rendered task, dummy token, `FAKE-REPLY-OK` through the relay); shell not attached; typed input echoed; an `ESC[201~` paste refused with the note and nothing reaching the CLI (no marker file); status Waiting for you then Working (button, drawer pill, tab dot); a second page sees the running agent, has no start form and gets the scrollback; tab switching keeps the agent attached and hides Reset; Stop with Cancel keeps it, Stop agent ends it and removes the tab; ask with CRLF sent as LF and no override; `quit` shows Exited and "exit code 7".
- **Convert:** six Convert buttons before Checked; menu chips; `curl` on block 3 sends `{kind: 'poc_format', format: 'curl', block: {text: 'print("hello from python")\n', lang: 'python', index: 2}}`; the task in the CLI names block 3; Convert disabled while the agent runs; file and editor value byte-identical; preview copy without "Convert"/"Checked" or markup; `user-select: none`; the D11 block with control characters gets a disabled Convert with the existing message.
- **connect:** lane first (`w1:p2`, `w1:p4`, then program `w1:p1`), escaped title shown as text with the escaped pill and no raw U+202E in the DOM; Show all adds `w1:p3` "outside Shared" last; a connect tab labelled "OMP · Lane hunter on D1" attaches (`ATTACHED w1:p2`), heading "Hoster", typing echoes, Herdr argv without `--takeover`; closing the tab returns to Terminal.
- Each screenshot step also checks that pills, chips, tab labels and row lines do not wrap or cut, and that the popover and Convert menu are inside the window.

Runs (Ghost, shared, load 9 to 13 on 6 CPUs, `TMPDIR=/tmp/bbra`, `NODE_PATH=$PWD/node_modules CHROME_BIN=/opt/google/chrome/chrome`, serially), on `db7fbf4`:

| Command | Result |
| --- | --- |
| `node --test --test-concurrency=1 static/tests/report-agent.synthetic.test.cjs` | 5 pass, 0 fail |
| `node --test --test-concurrency=1 static/tests/sandbox-terminal.synthetic.test.cjs` (includes the Settings page tests from the UX dossier) | 18 pass, 0 fail |
| `node --test static/tests/sandbox-terminal-filter.test.cjs` | 5 pass, 0 fail |
| `node --test --test-concurrency=1 static/tests/live-editor.synthetic.test.cjs` | 8 pass, 0 fail |
| `node --test --test-concurrency=1 static/tests/ui-redesign.synthetic.test.cjs` | 7 pass, 0 fail |

No backend module was changed, so no Python suite was rerun. The full `npm test` was not run here (about 40 files on a loaded box); the files above cover what this branch touches.

## Screenshots

Synthetic fixture data, 1280x900, checked by eye in light and dark (nothing cut off, no wrapped pills):

- `docs/integrations/report-agent-ui-popover-{light,dark}.png`: the popover with the connect list.
- `docs/integrations/report-agent-ui-settings-{light,dark}.png`: the Terminal card with the Agent section (custom model).
- `docs/integrations/report-agent-ui-drawer-tabs-{light,dark}.png`: the drawer on the Agent tab, Working, the refused paste note.
- `docs/integrations/report-agent-ui-convert-menu-{light,dark}.png`: Convert buttons in the side-by-side preview and the menu.
- `docs/integrations/report-agent-ui-connect-list-{light,dark}.png`: Show all with the escaped title and "outside Shared".
- `docs/integrations/report-agent-ui-connect-tab-{light,dark}.png`: a connect tab ("Hoster", Connected).
- `docs/integrations/report-agent-ui-disabled-nologin-light.png`: the disabled button with its reason.

Regenerate: `REPORT_AGENT_SCREENSHOT_DIR=$PWD/docs/integrations node --test --test-concurrency=1 static/tests/report-agent.synthetic.test.cjs`.

## Known gaps

- Dusk was not screenshotted (only tokens are used, so it follows the theme); Firefox and phones were not driven for the new UI (the drawer's phone sheet is unchanged; the tab strip has a phone margin rule only).
- The popover has no focus trap; Esc and outside clicks close it, and focus returns to the button on Esc.
- When the popover is taller than the room on either side of the button (the report bar mid-page on a short window), it scrolls inside a capped height rather than covering the button.
- Connect rows whose ids contain unsafe characters are still clickable: the service's escaped value will not match the raw pane and the attach answers `agent_gone`. Not tested with the real Herdr.
- The Agent tab's `waiting`/`working` follows the backend's 3 s output window, so an agent that prints a spinner while waiting for Ryu would read as Working (backend decision 2).
- The agent session poll is per open report and per tab; there is no push for state changes.
- Convert's `index` is the block's position among the preview's `<pre>` elements, which matches the Markdown fenced blocks for normal reports; HTML `<pre>` written by hand in a report would shift it.

## Decisions for Ryu

1. Switching drawer tabs keeps every session attached (hidden); closing the drawer detaches all of them. Alternative: detach hidden tabs to save viewers (the agent's sandbox could then pause while you look at the shell).
2. The shell no longer attaches when the drawer opens on the Agent or a connect tab; it attaches when you pick Terminal. Saves a viewer (and a sandbox start for a report you only connect from).
3. Clicking the button while an agent runs opens the Agent tab and the popover (with Stop) together. Alternative: open only the tab and put Stop in the tab strip.
4. Convert is hidden when the report agent is off on the Board (rather than shown disabled on every block), to keep the preview calm.
5. A typed question and a picked format are exclusive: typing clears the chip, picking a chip keeps the text but does not send it (the hint says so). One task per start, as the contract has it.
6. The Agent button stays disabled for reports outside a finding packet even though connecting to Hoster agents does not need a sandbox (the brief's rule; the agent list is per report anyway). Open a packet report of the program to connect.
7. Exited agents get "Close session" without a confirmation (nothing is running); running ones get Stop with a confirmation.
