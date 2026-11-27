# Live report editing (Board as single merge point)

- Branch: `feat/live-report-editing`; base `fix/board-editing-combined` @ `82211bf` (independently accepted, gates green, not yet in beta).
- Target: `beta`. Activation (service flags, Hoster move) is a separate operator decision.
- Kanban: bounty-board `t_f3f624e4`. Source: Discord thread 1574538511124668601.

## Intent

Ryu edits reports from his machine (Abommie) through the Board; agents may update the same report meanwhile. Syncthing stays as the distribution layer (fast local reads for agents, easy file sharing). The Board server becomes the one place where Board edits are merged and written, so Syncthing never has to referee Board edits. Google Docs–like feel: autosave, live updates, no save button.

## Contract (implemented server side)

- Opt-in `--live-edit` (`--live-edit-dir`, default `~/.local/state/bounty-board/live-edit`, must be private and outside the data root). Mutually exclusive with `--collaboration-dir`, `--report-autosave`, `--experimental-fixture-publish`; the older shared-draft path is left intact for now.
- `live_editing.py`: per-report serialization; browser sends `{base, content}`; server three-way merges (`git merge-file`) against the current file and writes; overlapping edits return conflict markers (`… (Bounty Board)` labels) and the server refuses text still containing them.
- Replacement: staged `.syncthing.board-*.tmp` (ignored by Syncthing), mode preserved, check, then `renameat2(RENAME_EXCHANGE)`; a write landing between check and exchange is recovered from the displaced file and merged. Writes through an already-open descriptor after the exchange can still be lost (documented limit).
- Watcher polls open reports (1 s) and announces outside changes over SSE (`/api/live/events`).
- `sent_revision`: the server stores what each client sent so a browser that kept typing during a save rebases correctly.
- Syncthing conflict copies (`name.sync-conflict-YYYYMMDD-HHMMSS-DEVICE.md`) next to an open report: a lost Board write is merged back automatically (archived to history, copy removed); an unknown copy is listed for review (preview merge → apply or discard; both archive first).
- History (SQLite in the private dir): observed/external/board/merged/restore/conflict_draft/sync_conflict events; one typing session per client coalesces within 120 s; restore goes through the merge path.
- Endpoints: `GET /api/live/{report,events,history,revision,sync-conflict}`, `POST /api/live/{save,restore,sync-conflict}`; writes need same-origin + `X-Requested-With: Bounty-Board` + JSON.
- Frontend seam: `window.registerBoardModule({name, afterRender(ctx)})`; report panel renders `#live-report-host` / `#report-artifacts-host` when `capabilities.live_edit`.

## Evidence

- Base commit: `tests/test_live_editing.py` (16) and `tests/test_live_api.py` (7) passed locally on Ghost (Python 3.14, synthetic roots under TMPDIR).
- Client branch evidence: see "Browser client" below.

## Browser client (`static/modules/live-editor.js`, `.css`)

Loaded by one line under `<!-- Feature modules -->` in `static/index.html`; no other app.js/style.css/index.html change. Registers `live-editor` through `window.registerBoardModule` and mounts into `#live-report-host` when `capabilities.live_edit` is true.

Contract as implemented:

- `base` = server revision the editor text is based on. Each local edit marks the session dirty, writes a browser backup `{base, text, client, updated}` to localStorage, and debounces a save (700 ms; Ctrl/Cmd+S saves now). One save in flight per report.
- Save response, editor unchanged: apply `content` minimally (common prefix/suffix, `replaceRange`; cursor and scroll kept), `base = revision`, clear dirty and backup. Editor changed meanwhile: keep the text, `base = sent_revision`, save again. Conflict, editor unchanged: load the marker text, `base = revision`, pause autosave, banner with per-block Keep mine / Keep saved, Keep all, Show; marker blocks highlighted. Conflict while typing: keep the old base and save again after the debounce (the server marks the overlap against the newest text).
- Remote `changed` (other client or outside writer) while clean: fetch `/api/live/report` and apply minimally with an "Updated by ..." / "Updated outside the Board" notice; own client id ignored; while dirty the next save merges. An epoch counter drops refresh results that started before a save completed. SSE reconnects with backoff (1 s doubling to 30 s) and re-fetches after reconnecting and after the first subscribe.
- Offline / 5xx / 429 / timeouts: status Offline, banner "Offline, kept in this browser, retrying.", retry with backoff and on the `online` event. 404 shows "missing" and polls; 403 not_editable makes the editor read-only and resumes saving if the report becomes editable again; 409 root_changed and other refusals stop with a Retry button, text kept.
- Recovery: each tab holds a Web Lock (`bounty-board-live-client:<id>`) for its lifetime. On open, backups for the same root/report whose owner lock is not held are sent with their saved base (server merges) and the user sees "Recovered unsaved text from this browser...". Backups equal to the server text are dropped. Backups with markers reopen in conflict mode. Without Web Locks (insecure origins) a backup counts as orphaned after 60 s without a heartbeat; dirty sessions rewrite their backup every 10 s.
- Syncthing copies: banner per copy; Review shows the server's merged preview; Apply (only when not conflicted), Load into editor to resolve (the resolving save goes through `sync-conflict apply`, which archives and removes the copy), Discard (archived first).
- History drawer: friendly labels (Opened from disk, Changed outside the Board, Edited by X (this tab), Merged changes, Restored by X, Conflicting edit kept for review, Syncthing copy archived), relative times, view a revision (safe `ctx.markdown`), restore via `/api/live/restore`, Load older.
- Status pill: Opening / Saved / Saving / Unsaved / Merged / Conflict / Offline / Not saved / Read-only.
- Persistence across app renders: the session element is moved into the new `#live-report-host` and CodeMirror refreshed; focus is restored when the render removed it. Leaving a report parks the session: pending text is flushed, SSE closed, and the session destroyed once clean (dirty/conflicted sessions stay alive until saved).
- Undo history restarts whenever foreign text enters the editor, so Ctrl+Z cannot remove someone else's text and autosave it.
- Foreign text also re-renders the full Preview when it is on, keeping its scroll position: EasyMDE renders that pane only when it is toggled, so agent edits used to reach the hidden editor while the Preview being read stayed stale. Side by side already follows edits.
- Author defaults to "Board editor"; `localStorage['bounty-board-live-author']` overrides it.

### Server changes on this branch

- A write that lands between the final check and the exchange and conflicts with the Board text used to stay only in history (the Board text was on disk and the editor got markers; a client re-sending from its old base then erased it). Now the late version is put back on disk as the head, the conflict is returned against it, and the change is broadcast. Test: `test_conflicting_write_between_check_and_exchange_stays_on_disk`.
- Conflict markers are 15 characters wide (`git merge-file --marker-size=15`), so a Markdown setext underline (`=======`) inside a side is not taken for the separator. `has_markers` still refuses older 7-wide markers. Test: `test_setext_underline_is_not_a_conflict_separator`.
- `save()` broadcasts a head change on the conflict path too.

### Decisions

- No server API changes; the client uses the existing endpoints only.
- Backups are per tab (key includes the client id) so two tabs never overwrite each other's unsaved text.
- Clearing undo history on foreign text trades some undo convenience for never undoing someone else's text.
- `BoardLiveEditor` is exposed on `window` for synthetic tests and diagnostics only.

## Evidence (this branch)

Machine shared by six agents (load average above 20), so timings are slow.

- `node --test --test-concurrency=1 static/tests/live-editor.synthetic.test.cjs`: 8/8 pass (two contexts see each other's edits, re-render keeps the node and focus, history; outside write in an idle editor; different-line browser + outside edits merged in file and both editors; overlapping edit, markers, Keep mine with a setext underline in my side; typing during a held save not lost (plus an outside write); offline, tab closed, server restarted, backup merged on reopen; generated navigation read-only and switching reports flushes pending text; unknown Syncthing copy review and apply).
- `python3 -m unittest tests.test_live_editing`: 18/18 pass. `tests.test_live_api`: 7/7 pass.
- `npm test` (bounded browser selection, now including the live editor suite): 123/123 pass.
- `python3 -W error::ResourceWarning tests/safe_suite.py`: 180 run, 178 pass, 1 skipped, 1 failure: `test_collaboration_process...test_source_read_is_serialized_across_two_servers` timed out ("server did not start" within 10 s) at load average about 28. It does not touch live code; rerun alone, `tests.test_collaboration_process` passes 3/3. That run started before the server fix commit, so the live tests were rerun afterwards: `tests.test_live_editing` 18/18 and `tests.test_live_api` 7/7 pass.
- An independent read-only review of the client and server found the late-write conflict loss, the setext separator ambiguity, autosave stalling after a temporary not_editable, a missed change between open and subscribe, lock-less backup theft, double recovery and open SSE on parked sessions. All are fixed on this branch.
- Screenshots (synthetic data, not committed): `$TMPDIR/screenshots/live-editor-idle.png`, `live-editor-conflict.png` (written when `LIVE_EDITOR_SCREENSHOTS` is set).

## Gaps and follow-ups

- Systems without `renameat2(RENAME_EXCHANGE)` fall back to `rename` with no late-write detection (Linux has it).
- A third late write during the restore of a second one, if it conflicts, keeps only the newest on disk; both are in history.
- Parked sessions in conflict stay alive in memory without a visible pointer from other reports.
- No presence (who else is editing) and no per-character cursors; merges are line based.
- Author identity is a local preference, not authenticated.
- The global `.preview` style collision is recorded in `BUGFIXES.md` (affects the non-live editor; the live editor overrides it).

## Pending

- UI redesign and other Board items (parallel branches), integration, independent review, Docker-isolated gates.

## Activation boundary

No service restart, real report writes, Tailscale or Syncthing configuration changes without Ryu's approval.
