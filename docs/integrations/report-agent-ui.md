# Report agent UI (phase 2)

- Branch: `feat/board-report-agent-ui`; base `608a962` (the terminal UX integration `49c76c9` merged with the report agent backend `0ed4682`). Commits: `db7fbf4` (feature, tests, screenshots), `2fb261c` (dossier); follow-up: `fcb6b04` (backend: login from Settings, task `note`), `b886a54` (UI: login row, running agents from any report, chip plus note), plus this dossier update.
- Contract built against: [`report-agent.md`](report-agent.md) (routes, session info, WebSocket kinds, task shape). Drawer and Settings registry: [`terminal-ux.md`](terminal-ux.md). Terminal rules (Board-only controls, typing filter): [`sandbox-terminal.md`](sandbox-terminal.md).
- First run: no backend change. Follow-up (Ryu: "we should have an option in the settings where we can set auth as well and have the app securely save it"): the login routes and `note` were added to the terminal service (contract in [`report-agent.md`](report-agent.md)), and one backend bug was fixed with a regression test (below). No `app.js` change.

Ryu's request, short: an Agent button on the report that changes the PoC format (curl, Python, browser JS, raw HTTP) and updates the report in our format, and lets him talk to that agent session right there; model and CLI choice in Settings; the report agent runs in the sandbox with one Claude login made on Hoster; connecting to an already running agent needs no sandbox.

## What changed for the user

### Settings: Agent section

Inside the Terminal card (`BoardSettings.register({id: 'agent', group: 'terminal', title: 'Agent', order: 20})`), loaded from `GET /terminal/api/agent/config` and `GET /terminal/api/status`:

- **CLI and model.** Every CLI is listed. Codex, OMP and OpenCode are disabled options reading "Codex (Needs a sandbox login on Hoster)". A sandbox-ready CLI whose binary is missing says "(not found on Hoster)". The model select has the CLI's models ("Default model", opus, sonnet, haiku) and "Custom..." when the CLI accepts custom ids; Custom shows a "Model id" field validated with the backend's rule (`[a-z0-9]([a-z0-9.-]{0,62}[a-z0-9])?`), with `aria-invalid` and a short reason, and Save stays disabled until it is valid. Save sends `POST /terminal/api/agent/config {cli, model}` and says "Saved for every device." The hint says the choice is saved on the terminal service and applies on every device (the card's own note, "Saved in this browser.", is about the terminal switches above).
- **Sandbox login (Claude)** (follow-up), when the service has `--report-agent-token-file` (`login.editable`):
  - No login: the "No sandbox login on Hoster yet" pill, the help line "Run claude setup-token on Hoster and paste the token here. It is stored on Hoster only, readable by the Board's user.", a masked text field and Save (Enter works too). Since the review round (U1) the field is `type="text"` masked with `-webkit-text-security: disc` (inline and in CSS), `autocomplete="off"`, `spellcheck=false`, `data-1p-ignore`, `data-lpignore="true"`, `data-bwignore`, `data-form-type="other"`, not inside a form, placeholder `sk-ant-oat...`; the pill sits right-aligned with the field and Save, and the help line is one full-width line under the row.
  - Save reads the field, clears it at once (success or failure), checks the setup-token shape in the page (a wrong value is refused there and never sent), then sends `POST /terminal/api/agent/login {cli: "claude", token}`. The value is never kept in module state, storage, the URL or a log; the only copy that leaves the field is that request body.
  - Saved: "Saved <relative time>", the "Sandbox login ready" pill, Remove and Replace. Replace shows the field again with Cancel. Remove asks first ("Remove the sandbox login?", Remove login / Cancel, the same `BoardLedgerActions.dialog` pattern as Stop) and sends `POST /api/agent/logout`.
  - A login file the service refuses (wrong mode, symlink and so on) shows the service's message under the row.
  - Not editable (no token-file flag): the pill plus deploy step 1 as one plain line ("On Hoster, run claude setup-token, then save only the printed token in ~/.config/bounty-board/report-agent.token (mode 0600, outside the data root)."), no field.
- **Connect to running agents: on/off**, read-only text with "A terminal service setting (--agent-connect), not changed here."
- **Off states.** Feature off: "The report agent is off on this Board. The terminal service needs the --report-agent flag." Service unreachable: "The terminal service is not reachable, so the agent settings cannot load. Try again later." (401: "Sign in to the terminal to see the agent settings."). Terminal not enabled: the existing Terminal card text ("The sandbox terminal is not enabled on this Board."), sections are not rendered.

### Agent button

- Placed right after the Terminal button and its reason text, wherever the terminal places it (live editor bar, or under the Reports heading in the non-live view).
- (Follow-up, decision 6 changed) Disabled only when neither the report agent nor agent connect can be used. While connect is on, the button stays enabled for reports outside a finding packet, without a login or with the agent off: its tooltip reads "Running agents on Hoster. <reason>", and the popover shows only the "Running agents" section (matched by the report's program and lane, with Show all) with the reason as one muted line in place of the chips, the ask box and Start. Picking an agent opens the drawer on its connect tab even outside a packet; the Terminal tab is disabled there with the mount message, no shell attaches, and closing the last connect tab closes the drawer.
- When it is disabled, the reason shows as tooltip and visible text next to it, in this order: "Terminal service unavailable." (config request failed; 401 says "Sign in to the terminal to use the agent."), "The report agent is off on this Board.", the terminal's own `/api/mount` message for reports outside a finding packet ("This report is not inside a finding folder (reports/<FID>-…/)."), "No sandbox login on Hoster yet.". While the config loads the button is disabled with no visible reason (no flicker).
- **Popover** ("Report agent"): "Change PoC format" chips (Python, curl, Browser JS, Raw HTTP, Best fit; one chip at a time, click again to clear), a textarea that is the ask box ("Or ask the agent", "Ask the agent...") without a chip, and "Anything else? (optional)" under a picked chip (follow-up, decision 5 changed: sent as `task.note`, 2 KiB, same unsafe-text check), CLI and Model selects defaulting to the Settings choice (per-run override; non-ready CLIs disabled), and Start (rightmost; reads "Convert to Python" when a chip is picked). The hint line says what is missing ("Pick a format or type a question."), refuses unsafe text before sending ("The text contains control or invisible characters. Remove them and try again.", the drawer's own `unsafeText`), caps questions at 8 KiB and notes at 2 KiB, and under a chip says the text is "Sent with the format change as your extra instructions." CRLF is sent as LF.
- Start sends `POST /terminal/api/agent/start {selector, task, cli?, model?}` (task `{kind: 'poc_format', format, note?}` or `{kind: 'ask', text}`) (`cli`/`model` only when they differ from the saved choice), closes the popover and opens the drawer on the Agent tab. `409 agent_running` opens the running agent instead; other errors show the service's message in the popover.
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

## Follow-up 2: Hoster's skills and end-to-end validation (backend and prompt only)

Ryu: the PoC should be validated end to end with web access, and the agent should have our skills without anyone maintaining a list. No UI change was needed: the Agent button, popover, tab and approval flow are the same; what the agent knows and does changed.

- `--report-agent-skills-dir ~/.claude/skills` gives the agent every skill Claude Code uses on Hoster (about 200), copied with permission-widening frontmatter removed into one read-only tree mounted at `/opt/report-agent/skills`; `~/.claude/skills` in the sandbox links to it. New skills appear in the next sandbox started after the change; nothing to maintain. Details, mounts and the threat model: [`report-agent.md`](report-agent.md) (Skills tree).
- The prompt now has the agent load the vulnerability-class skill and `live-testing-policy`, run offline checks, then ask to run the PoC end to end (the Agent tab shows the approval prompt for each command), show the result, save `poc-run-<UTC timestamp>.txt` in the packet, and give GREEN only after a live run showed impact (else "YELLOW / not ready"). For a test-account credential it gives Ryu the one-liner `rm -f /tmp/bb-auth; (umask 077; set -C; IFS= read -rs BB_AUTH && printf '%s' "$BB_AUTH" > /tmp/bb-auth)` for the Terminal tab (re-review V5), runs the PoC with `--auth-file /tmp/bb-auth`, and asks afterwards whether to delete the file.
- Commit `4d79074`. Runs: see `report-agent.md`, "Follow-up 2". The browser file `static/tests/report-agent.synthetic.test.cjs` still passes (6 pass, 0 fail) with the new template.

## Review round (608a962..7696646, ACCEPT with one should-fix and four minors)

Red/green: each regression test was run with only the named source file swapped back to its `7696646` content (`git show 7696646:<file> > <file>`), then the file was restored. Commits: `cd65be2` (fixes and tests), `6ede137` (screenshots).

| Finding | Fix | Regression test | Swapped file | Red on 7696646 | Green now |
| --- | --- | --- | --- | --- | --- |
| U1 should-fix: the token field was a formless `type=password` removed after a fetch, which Chrome offers to save in its password manager | Text input masked with `-webkit-text-security: disc` (inline style too, so it is masked before the stylesheet applies), `autocomplete="off"`, the 1Password, LastPass, Bitwarden and `data-form-type` ignore attributes; where the property is unsupported, `type=password` with `autocomplete="one-time-code"` (feature-detected with `CSS.supports`) | `report-agent.synthetic` "settings: sandbox login saved from Settings…" (field state: text, masked `disc`, ignore attributes, no password input on the page) | `static/modules/report-agent.js` | FAIL (field state differs: `type: 'password'`, no mask) | pass |
| U2: Home or ArrowLeft selected the disabled Terminal tab outside a packet | `selectTab` refuses `terminal` while `blocked()`; the arrow-key order skips it | `report-agent-review.synthetic` "U2: outside a packet, arrow keys and Home never select the disabled Terminal tab" (Home, ArrowLeft, ArrowRight, End; shell stays idle) | `static/modules/sandbox-terminal.js` | FAIL ("Home selected the disabled shell tab") | pass |
| U3: guard listeners piled up on each reopen and kept old terminals alive | `makeTerm` registers every listener (screen guards, mousedown, document mouseup) with one `AbortController`, aborted in `dispose`; the tab handle and the module's terminal map drop their references | `report-agent-review.synthetic` "U3: a tab terminal re-created on every reopen keeps one guard set…" (CDP listener counts on the tab screen and `document` after 3 close and reopen cycles; scrub still works; one `.xterm`) | `static/modules/sandbox-terminal.js` | FAIL (paste 1 → 4, beforeinput 1 → 4, input 2 → 8 after 3 cycles) | pass |
| U4: the sentinel scan missed responses, console and the later steps | One `tokenCapture` helper: request URL, headers and body; response URL, headers and body; console; page errors; DOM and field values; local and session storage; URL. Scans after Save, after Replace (second token) and after Remove; only the login POST bodies may carry a token | `report-agent-scan-coverage` (static check of the test source) plus the scans themselves in `report-agent.synthetic` | `static/tests/report-agent.synthetic.test.cjs` | FAIL (no shared helper, no response or console capture, one scan) | pass |
| U5: toast over the Settings shot, login pill on the left, hints wrapping | Toasts dismissed (after network idle, until quiet) before Settings shots; pill in `.ra-login-controls`; hints shortened ("Saved on Hoster, for every device.", "Set by the --agent-connect service flag.", "The token stays on Hoster and never enters the sandbox.", the manual hint) and the help line full width; the CLI row keeps a 220 px text column so the selects never leave the card | `report-agent.synthetic` "settings: Agent section loads and saves…" (no toast, pill in the controls, every Agent hint one line) and the login test (pill in the controls) | `static/modules/report-agent.js` | FAIL ("hints wrap") | pass |
| Unverified 1: the mount race | Real in part: on a switch to a report outside a packet with the drawer open, the shell tried a WebSocket attach before `/api/mount` answered (the service refused it with `not_in_packet`, so no sandbox started and no other sandbox was reached), and the pill kept saying "Connected" for the previous report's closed socket. Now no shell attaches until the mount answer for the current report is in (`mountKnown`, reset on every report change; status reset to idle, "Connecting" while waiting); a late answer for an earlier report was already ignored and is now tested | `report-agent-review.synthetic` "mount race: no shell attaches before the mount answer…; a late answer for an earlier report is ignored" (mount answers delayed with `page.route`; WebSocket URLs recorded) | `static/modules/sandbox-terminal.js` | FAIL ("a shell attach was tried before the mount answer") | pass |
| Unverified 2: a queued Play runs after the drawer reopens | Predates this branch: the same `pending` logic is on `18089f4` (enqueue line 339, flushed on `hello` line 175, cleared only on a report change) and on `49c76c9`. Recorded in `BUGFIXES.md` with location, evidence and impact; not fixed here | none (out of scope) | n/a | n/a | n/a |

Firefox check for U1: the local Firefox 158.0.1 (headless, a scratch page outside the repo) reports `CSS.supports('-webkit-text-security', 'disc')` true and renders a text input with the property as dots. The `type=password` fallback is for older browsers only.

### Skills tree against a real-shaped directory (read-only)

Ghost's `~/.claude/skills` (same shape as Hoster's), read-only, into a scratch state dir under `TMPDIR`, deleted afterwards. Nothing under `~/.claude` changed: a snapshot of every file's mtime and size, taken before and after, matched. No skill contents were printed.

- 210 top-level entries: 208 skills discovered, 2 skipped, both "no top-level SKILL.md" (the real folders).
- Tree: 208 skills, 973 files, 6.3 MiB of file content (the source holds the same 973 regular files and 6.3 MiB; `du -L` shows 16M in disk blocks including the two folders). 4 nested symlinks skipped.
- Build: 0.33 s. Change check with nothing changed: 0.03 s (same tree reused), so no speedup was needed.
- `bunny-report-and-triage`, `triager-first-poc-authoring`, `poc-tooling-policy` and `live-testing-policy` are in the tree; 0 `SKILL.md` files in the tree have frontmatter keys other than `name` and `description`.

### Review round runs (serially, `TMPDIR=/tmp/bbra`, load 7 to 13)

| File | Result |
| --- | --- |
| `static/tests/report-agent.synthetic.test.cjs` | 6 pass, 0 fail |
| `static/tests/report-agent-review.synthetic.test.cjs` (new, in `npm test`) | 3 pass, 0 fail |
| `static/tests/report-agent-scan-coverage.test.cjs` (new, in `npm test`) | 1 pass, 0 fail |
| `static/tests/sandbox-terminal.synthetic.test.cjs` | 18 pass, 0 fail |
| `static/tests/sandbox-terminal-filter.test.cjs` | 5 pass, 0 fail |
| `static/tests/live-editor.synthetic.test.cjs` | 7 pass, 1 fail in the serial run ("unknown Syncthing conflict copy…", the flaky test already in `BUGFIXES.md`); alone right after: 8 pass, 0 fail, twice |
| `static/tests/ui-redesign.synthetic.test.cjs` | 7 pass, 0 fail |

No Python module changed in this round.

## Review round 2 (7696646..7e6c930, BLOCK on the skills tree; U1 to U5 and the mount race confirmed)

Red/green: each regression test was run with the touched source swapped back to its `7e6c930` content, then restored. The tree fixes span `terminal_agent_cli.py` and its call site in `terminal_report_agent.py` (new `expect`, `log`, `identities` and `user` arguments), so those two were swapped back together. Regression tests: `tests/test_review_rv2.py` (from the reviewer's `test_skills_tree_rv2.py` and `test_bb_auth_rules.py`, paths fixed), `static/tests/report-agent-scan-coverage.test.cjs` (from `scan-websocket-gap.test.cjs`), and two new cases in `test_terminal_agent_docker.test_07`. Commit `7c727ed`.

| Finding | Fix | Regression test | Swapped back | Red on 7e6c930 | Green now |
| --- | --- | --- | --- | --- | --- |
| V1 blocker: `.git` (409 entries on Hoster) and other dot-folders copied into every sandbox | `copy_skill` and `skill_signature` skip `.git`, `.hg`, `.svn`, `.bzr`, `CVS` (folder or a worktree's `.git` file) and every dot-directory at any depth; deploy scan now runs over the generated tree without `-I`, plus a count of compressed files to check by hand | `Exposure.test_git_metadata_and_dot_directories_are_not_copied` | cli + report_agent | FAIL (`.git`, `.hg`, `.svn`, `.bzr`, `CVS`, `.pytest_cache` copied) | pass |
| V2: a FIFO in a skill hangs every start, reset and removal | `lstat` first, only regular files are opened, with `O_NONBLOCK\|O_NOFOLLOW` and an `fstat` re-check | `FifoHang.test_fifo_in_a_skill_does_not_block_builds_or_stop` | cli + report_agent | FAIL (build and destroy still blocked after 3 s) | pass |
| V3: cleanup could delete a starting sandbox's tree | `skills_tree(user=)` records the tree in `tree_users` in the same lock hold that returns it; `session_destroyed` releases it, also after a failed `docker run` | `GcRace.test_tree_returned_to_a_starting_sandbox_survives_a_concurrent_rebuild` | cli + report_agent | ERROR (`user=` did not exist; the reviewer's form of the repro fails with "the tree handed to sandbox A was deleted") | pass |
| V4: the agent could read `/tmp/bb-auth` without asking | Managed deny `Read(//tmp/bb-auth)`; the real binary also refuses Grep with it | `CredentialRules.test_managed_policy_denies_reading_the_credential_file`; `test_07` (real Claude Code 2.1.331: scripted Read and Grep of the file come back `is_error`, the content never reaches the fake upstream, Bash still asks) | `terminal_agent_cli.py` (unit); for `test_07` only the deny line removed, because the whole file would break the new call sites | unit FAIL; `test_07` FAIL ("FAKE-BBAUTH-SECRET-7Q2 unexpectedly found" in the model request) | pass |
| V5: one-liner created the file 0644 until chmod, followed a planted link, left the variable set on failure | Template: `rm -f /tmp/bb-auth; (umask 077; set -C; IFS= read -rs BB_AUTH && printf '%s' "$BB_AUTH" > /tmp/bb-auth)`; the offer to delete it after the run stays | `CredentialRules.test_template_has_the_exact_one_liner`; `test_one_liner_in_the_sandbox_image` (Docker, `bbterm-test-image-agent`: mode 600 owned by the user, variable unset in the shell, a link to an existing file and a dangling link planted after the `rm` both refused with the target untouched and nothing created, the full line replaces a planted link with a 0600 file) | `agent_prompts/report-agent.md` | FAIL (both) | pass |
| V6: copies ignored privacy and could follow a swap | Walk from an `O_NOFOLLOW\|O_DIRECTORY` handle whose dev/inode must match what discovery checked, `dir_fd`-relative opens below; files with more than one link or not readable by others skipped with one log line (name only) | `Exposure.test_hard_linked_and_private_files_are_not_copied`; `SwapRace.test_target_swapped_to_a_link_into_root_after_checks_is_not_copied`; `SwapRace.test_folder_replaced_by_another_folder_after_discovery_is_refused` | cli + report_agent | FAIL (private and hard-linked files copied as 0644; a file from inside `--root` copied; a replaced folder copied) | pass |
| V7: WebSocket frames not scanned; `test_07` no longer showed precedence over an unstripped skill | `tokenCapture` records frames sent and received through CDP `Network.webSocketFrameSent/Received` and reports unreadable API bodies; the popover test checks frames are captured both ways; `test_07` builds one tree with `cli.strip_frontmatter` patched to identity (test only, no production flag) and the `allowed-tools: [Bash]` skill still gets the managed ask prompt, no marker | `report-agent-scan-coverage`; `test_07` "unstripped allowed-tools skill loaded, Bash asks" | `static/tests/report-agent.synthetic.test.cjs` | FAIL (no frame capture) | pass (`test_07` case is coverage: it passes on both, as it should) |

### Skills tree against the real-shaped directory, again (read-only)

Ghost's `~/.claude/skills`, read-only, scratch state under `TMPDIR` deleted afterwards; a snapshot of every source file's mtime, size and mode matched before and after; counts only.

- Discovery: 210 entries, 208 skills, 2 skipped ("no top-level SKILL.md").
- Dot and VCS directories skipped: `.git` (409 entries, 1 skill), `.pytest_cache` (4 files, 1 skill); no `.git` file. None remain in the tree.
- Files skipped: 2 "not readable by others" (a `.pyc` and a `.md`), 0 with more than one link; 4 nested symlinks skipped.
- Tree: 553 files, 5.44 MiB (was 973 files and 6.3 MiB with `.git`).
- Build 0.21 s; change check with nothing changed 0.023 s.
- The four required skills are present; 0 `SKILL.md` files with frontmatter keys other than `name` and `description`.

### Review round 2 runs (serially, `TMPDIR=/tmp/bbra`; Docker after the gate run ended)

| Run | Result |
| --- | --- |
| `tests.test_review_rv2` (new) | 9 OK without Docker (1 skipped); 9 OK with `BBTERM_DOCKER_TESTS=1` |
| `tests.test_terminal_skills_tree` | 5 OK |
| `tests.test_terminal_report_agent` | 28 OK (one error under load in the first run, then 28 OK twice) |
| `tests.test_review_r1_permission_settings` / `test_review_r2_minors` / `test_terminal_agent_login` / `test_terminal_sandbox` | 7 / 8 / 13 / 47 OK |
| `test_terminal_docker` (`BBTERM_TEST_IMAGE=bbterm-test-image-agent:latest BBTERM_DOCKER_TESTS=1`) | 13 OK |
| `test_terminal_agent_docker` (`BBTERM_CLAUDE_BIN=$HOME/.local/bin/claude BBTERM_DOCKER_TESTS=1`) | 8 OK; policy evidence for 5 cases (the three earlier ones, "Read and Grep of /tmp/bb-auth denied, Bash asks", "unstripped allowed-tools skill loaded, Bash asks") |
| `static/tests/report-agent.synthetic.test.cjs` | 6 pass |
| `static/tests/report-agent-scan-coverage.test.cjs` | 1 pass |

No `bbterm-test-*` container remained.

## Review round 3 (7e6c930..d160b07, ACCEPT; minors closed by Hermes)

The narrow re-review confirmed V1 to V7 and found three minors.

| Finding | Fix | Test | Red on d160b07 | Now |
| --- | --- | --- | --- | --- |
| W1: the token scan missed binary WebSocket frames (terminal output arrives base64 in CDP `payloadData`) | `tokenCapture` decodes opcode 2 frames before scanning; the popover test asserts the decoded `ECHO hello-agent` output frame is seen | reviewer repro `scan-binary-frames.test.cjs`; `report-agent.synthetic` popover test | repro fails | repro and test pass |
| W2: `/tmp/bb-auth` deny proven for the exact path only | `test_07` adds a `/tmp/./bb-auth` Read (refused) and a Grep over all of `/tmp` (no credential reaches the model) | `test_terminal_agent_docker.test_07` (real Claude Code 2.1.331) | not covered | 8 OK; evidence "Read, ./ spelling and Grep of /tmp/bb-auth denied, /tmp-wide Grep returns no credential, Bash asks" |
| W3: a 0600 file in a required skill is skipped with only a log line | Deploy check: skipped-file log lines must not name files in the four required skills; `chmod o+r` the file in its source repo if one shows | `report-agent.md` deploy checklist | n/a | documented |



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
BoardTerminal.openTab('agent');      // opens the drawer on that tab; false otherwise. A registered tab may open it for a
                                     // report outside a finding folder (follow-up): the Terminal tab is then disabled and no shell attaches
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

New: `tests/report_agent_browser_fixture.py` (Board + in-process terminal service with the test-only local backend, `tests/fake_agent_cli.py` as `claude`, `tests/fake_model_upstream.py` as a TLS model upstream trusted only through the constructor, a 0600 fake token file outside the root, `tests/fake_herdr.py` with four synthetic agents; modes `nologin`, `agentoff`, `noconnect`, `down`, `nolive`, `notokenflag`), and `static/tests/report-agent.synthetic.test.cjs` (added to the `npm test` script after `sandbox-terminal-filter.test.cjs`). Never a real CLI, login, Herdr or Anthropic; no Docker.

- **settings:** load (all four CLIs, three disabled with "Needs a sandbox login on Hoster", models, login pill, connect flag, no toggle, "every device"), save `opus` (file `agent-settings.json` checked), Custom refused for `Bad_Model` then saved as `claude-synthetic-9`, persisted after reload, no token text; `nologin` pill and setup line; `agentoff,noconnect` off text and "Connect to running agents: off".
- **settings login (follow-up):** the row label, help line and field attributes (password, autocomplete off, no spellcheck, not in a form); a non-token value refused in the page, field cleared, nothing sent; Save with a sentinel token: field cleared, file holds it with mode 0600, pill ready, "Saved under a minute ago", no field; the DOM (outer HTML and every input value), localStorage, sessionStorage and the URL hold no part of it, and of every request the page made (URL, body, headers) exactly one carries it: the `POST /terminal/api/agent/login` body; Replace then Cancel keeps it; Remove with Cancel keeps the file, Remove login deletes it and the field returns; `notokenflag` shows the manual hint and no field.
- **disabled states:** placement after the Terminal button and its reason; with connect off, `active.md` is disabled with the terminal's mount message; with connect on, `active.md` is enabled, the popover has the muted mount line, no chips, ask box or Start, the lane/program list, and a connect tab opens with the Terminal tab disabled, the shell idle, and the drawer closing with the last tab; `nologin` with connect on is enabled with "No sandbox login on Hoster yet." in the popover; `nologin,noconnect`, `agentoff,noconnect`, `down` disabled with their reasons; non-live view placement; `noconnect` one muted line and no list.
- **popover start and Agent tab:** chips; unsafe question refused; under the Python chip the textarea reads "Anything else? (optional)"; `start` body exactly `{selector, task: {kind: 'poc_format', format: 'python', note: 'Keep the curl as a fallback.'}, cli: 'claude', model: 'opus'}`; the CLI's task shows the note as Ryu's extra instructions; drawer on the Agent tab with tabs Terminal/Agent; the fake CLI's output (argv with `--model opus`, the rendered task, dummy token, `FAKE-REPLY-OK` through the relay); shell not attached; typed input echoed; an `ESC[201~` paste refused with the note and nothing reaching the CLI (no marker file); status Waiting for you then Working (button, drawer pill, tab dot); a second page sees the running agent, has no start form and gets the scrollback; tab switching keeps the agent attached and hides Reset; Stop with Cancel keeps it, Stop agent ends it and removes the tab; ask with CRLF sent as LF and no override; `quit` shows Exited and "exit code 7".
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

Follow-up runs (same setup, load 5 to 13), on `b886a54`:

| Command | Result |
| --- | --- |
| `node --test --test-concurrency=1 static/tests/report-agent.synthetic.test.cjs` | 6 pass, 0 fail |
| `node --test --test-concurrency=1 static/tests/sandbox-terminal.synthetic.test.cjs` | 18 pass, 0 fail |
| `node --test static/tests/sandbox-terminal-filter.test.cjs` | 5 pass, 0 fail |
| `python3 -W error::ResourceWarning -m unittest tests.test_terminal_agent_login` (new) | 13 OK (3 runs) |
| `... tests.test_terminal_relay` / `test_terminal_report_agent` / `test_terminal_service` / `test_terminal_connect` | 18 / 28 / 29 / 11 OK |
| `... tests.test_review_r1_permission_settings` / `test_review_r2_minors` / `test_review_r2_relay_lifetime` | 7 / 8 / 1 OK |

Backend bug found and fixed (follow-up): `TokenFile.read()` compared the inode from `lstat` with the one it opened and answered `unreadable` when they differed, so a model call that raced a save's rename failed. It now tries again (up to 5 times). Regression test: `test_terminal_agent_login.TokenFileWriteTests.test_concurrent_saves_never_leave_a_partial_file` (14 `unreadable` reads before the fix, none after).

The full `npm test` was not run (about 40 files on a loaded box); the files above cover what this branch touches. Docker suites were not rerun (no sandbox or relay transport change).

## Screenshots

Synthetic fixture data, 1280x900, checked by eye in light and dark (nothing cut off, no wrapped pills):

- `docs/integrations/report-agent-ui-popover-{light,dark}.png`: the popover with the connect list.
- `docs/integrations/report-agent-ui-settings-{light,dark}.png`: the Terminal card with the Agent section (custom model).
- `docs/integrations/report-agent-ui-drawer-tabs-{light,dark}.png`: the drawer on the Agent tab, Working, the refused paste note.
- `docs/integrations/report-agent-ui-convert-menu-{light,dark}.png`: Convert buttons in the side-by-side preview and the menu.
- `docs/integrations/report-agent-ui-connect-list-{light,dark}.png`: Show all with the escaped title and "outside Shared".
- `docs/integrations/report-agent-ui-connect-tab-{light,dark}.png`: a connect tab ("Hoster", Connected).
- `docs/integrations/report-agent-ui-disabled-nologin-light.png`: the disabled button with its reason (no login, connect off).
- `docs/integrations/report-agent-ui-login-field-{light,dark}.png`: the Sandbox login row with the field (follow-up).
- `docs/integrations/report-agent-ui-login-saved-{light,dark}.png`: the row after Save, with Remove and Replace.
- `docs/integrations/report-agent-ui-popover-outside-packet-{light,dark}.png`: the popover on a report outside a finding packet (running agents only).

Regenerate: `REPORT_AGENT_SCREENSHOT_DIR=$PWD/docs/integrations node --test --test-concurrency=1 static/tests/report-agent.synthetic.test.cjs`.

## Known gaps

- Dusk was not screenshotted (only tokens are used, so it follows the theme); Firefox and phones were not driven for the new UI (the drawer's phone sheet is unchanged; the tab strip has a phone margin rule only).
- The popover has no focus trap; Esc and outside clicks close it, and focus returns to the button on Esc.
- When the popover is taller than the room on either side of the button (the report bar mid-page on a short window), it scrolls inside a capped height rather than covering the button.
- Connect rows whose ids contain unsafe characters are still clickable: the service's escaped value will not match the raw pane and the attach answers `agent_gone`. Not tested with the real Herdr.
- The Agent tab's `waiting`/`working` follows the backend's 3 s output window, so an agent that prints a spinner while waiting for Ryu would read as Working (backend decision 2).
- The agent session poll is per open report and per tab; there is no push for state changes.
- The token passes through a JavaScript string (the field value and the request body); the page drops its references right after the request, but a string cannot be wiped from memory.
- Anyone who can sign in to the terminal can replace or remove the login (threat model in `report-agent.md`).
- A typed token is lost if the Agent section repaints before Save (changing the model select), by design: it is never kept outside the field.
- Convert's `index` is the block's position among the preview's `<pre>` elements, which matches the Markdown fenced blocks for normal reports; HTML `<pre>` written by hand in a report would shift it.

## Decisions for Ryu

1. Switching drawer tabs keeps every session attached (hidden); closing the drawer detaches all of them. Alternative: detach hidden tabs to save viewers (the agent's sandbox could then pause while you look at the shell).
2. The shell no longer attaches when the drawer opens on the Agent or a connect tab; it attaches when you pick Terminal. Saves a viewer (and a sandbox start for a report you only connect from).
3. Clicking the button while an agent runs opens the Agent tab and the popover (with Stop) together. Alternative: open only the tab and put Stop in the tab strip.
4. Convert is hidden when the report agent is off on the Board (rather than shown disabled on every block), to keep the preview calm.
5. (Changed by Hermes for Ryu in the follow-up) A picked chip plus text sends the text as `note`, Ryu's extra instructions for the format change ("Python, and keep the curl as a fallback"); without a chip the text is the question.
6. (Changed by Hermes for Ryu in the follow-up) Outside a finding packet the button stays enabled while agent connect is on, offering only the running agents of that report's program and lane (and Show all). The same applies without a login or with the agent off. It is disabled only when both are unavailable.
7. Exited agents get "Close session" without a confirmation (nothing is running); running ones get Stop with a confirmation.
8. (Follow-up) The page checks the setup-token shape before sending, so a mistyped password or the wrong paste never leaves the browser; the service checks it again.
9. (Follow-up) The status pill stays visible next to the login field, so "No sandbox login on Hoster yet" and the field show together; Replace keeps the saved login until a new Save succeeds.
10. (Follow-up 2) The agent gets every Hoster skill through `--report-agent-skills-dir`; skills are readable by code in the sandbox, so they must hold no secrets (deploy check in `report-agent.md`).
11. (Follow-up 2) The agent can read the test-account credential file it is given (`/tmp/bb-auth`), and so can any process in that sandbox, until it is deleted; it asks after the run whether to delete it, and the file vanishes with the container's tmpfs anyway.
12. (Follow-up 2) Live runs are gated by Ryu's per-command approval and the egress filter; staying on the report's endpoints is a prompt rule, not a technical limit.
13. (Review round) The token field is a CSS-masked text input rather than a password input, so browsers do not offer to save the token; a browser without `-webkit-text-security` gets a password input with `autocomplete="one-time-code"` instead, so the value is never shown in clear.
14. (Review round) The queued-Play bug predates this branch and is left in `BUGFIXES.md` for its own fix.
