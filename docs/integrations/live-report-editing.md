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

- `tests/test_live_editing.py` (16) and `tests/test_live_api.py` (7) pass locally on Ghost (Python 3.14, synthetic roots under TMPDIR).

## Pending

- Live editor client module, UI redesign, Bounty Board to-do items (parallel subagent branches), integration, independent review, Docker-isolated gates.

## Activation boundary

No service restart, real report writes, Tailscale or Syncthing configuration changes without Ryu's approval.
