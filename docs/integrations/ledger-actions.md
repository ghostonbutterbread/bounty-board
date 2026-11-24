# Ledger actions integration dossier

- **Branch:** `feat/board-ledger-actions`, based on `e9246db`. Not merged, pushed or activated.
- **Scope:** Ryu's to-do items (a) severity, sort, filter and Gadgets/MapStore reclassification, (b) editable classes from the board and class breakdown, and (c) local submission state plus adding findings. All writes go through supported BBH commands.

## Intent

Make the Findings ledger a place where you can act on entries, not just read them:

- Sort by severity or date, and filter by first-seen date.
- Change class through a searchable picker, from a row or in bulk from the dashboard class breakdown.
- Record local submission state, with a confirmation that this is not a platform submission.
- Add a finding.
- Move a finding to Gadgets or MapStore. You can drag the row onto the section target or use the row menu. Both keep the original and its evidence.

## BBH investigation (read-only source review, then disposable synthetic runs)

These findings come from the snapshot `board-bbh-browser.A1LilEDR/bbh` with pinned bounty-core `9db8b23`, compared with `bug_bounty_harness` main and `bbh-feat-severity-normalize`.

**Severity**
- `normalize_severity` accepts `EXCEPTIONAL CRITICAL HIGH MEDIUM LOW INFO UNKNOWN`, plus `P0`..`P5` and `INFORMATIONAL`.
- `info` and `informational` are stored as `INFO`.
- `N/A`, `NA`, `none` and empty are silently stored as `UNKNOWN`, so BBH has **no N/A value**. Confirmed by running BBH on a synthetic root.
- The `bbh-feat-severity-normalize` change is already in main. That branch is older in other ways: it has no `--edit-finding` and no EXCEPTIONAL.

**`manual_hunter.py --edit-finding`**
- Accepts any string for `class_name` and `status`.
- An edit changes no per-entry date.

**`--set-submission FID`**
- Options: `--submission-state not_submitted|submitted|dropped` (defaults to `submitted` if omitted), `--submission-result valid|duplicate`, and `--submission-report` (free text).
- Writes only `finding.submission`. It is local only; there are no network calls.
- A recorded result **cannot be cleared** from the CLI.

**`--from-file`**
- Takes a note of `Label: value` lines.
- Requires `File` and `Description`.
- Deduplicates on file, line, class and type. A duplicate prints `Duplicate: <fid>`, writes nothing and **exits 1**.

**Gadgets and MapStore**
- There is no separate gadget store. A gadget is a MapStore observation tagged `gadget`, or `gadget,residual`.
- The map-store policy (`skills/map-store/SKILL.md`) requires a body Capability block for gadgets.
- **BBH has a supported writer:** `agents/map_store.py write --program --family --lane --root --surface --scope --tags --title --agent --run-id --body-file`. It creates a collision-free directory and upserts `recon/maps/map.jsonl`.
- No BBH command or field marks a finding as "reclassified" or "moved".

**Date fields:** a ledger entry has `first_seen` and `last_seen` (ISO `...Z`). There is no `created_at` on manual entries.

## Contract (see `BACKEND_API.md` for the full text)

- `capabilities.ledger_actions` = `{submission: {enabled, states, results, local_only}, add_finding: {enabled}, reclassify: {gadgets: {enabled, reason?}, map: {...}}}`. Each action is enabled only when the writer's `--help` lists the options it needs.
- `POST /api/finding/submission` runs `--set-submission`.
- `POST /api/finding/new` runs `--from-file` with a server-generated note.
- `POST /api/finding/reclassify` runs `map_store.py write`, then `--edit-finding` to append a pointer line to `review_notes`, and optionally sets `status: archive`.
- All three use the same safety as `PATCH /api/finding`:
  - same-origin JSON with `X-Requested-With`
  - `root_instance` and `expected_revision` preconditions
  - shared filesystem preflight (refactored into `finding_precheck`, which `PATCH` now also uses)
  - the server metadata lock
  - read-back verification
  - the writer is disabled after any failure
- `ledger()` now also projects `first_seen` and `last_seen`.
- Every successful write returns `revisions` (see the decisions below).

**Frontend** (`static/modules/ledger-actions.js` + `.css`; seam edits in `app.js`/`api.js`/`index.html` are commented):
- `window.BoardFindingView = {filter, compare, rebase}` is consumed by `findings()`.
- `<tr data-finding-id>` marks finding rows. `.chart-row[data-class-name]` marks the dashboard class rows.
- `api.js` `write()` also returns `revisions`.

## Decisions

1. **Severity N/A.**
   - It is shown and ranked (EXCEPTIONAL > CRITICAL > HIGH > MEDIUM > LOW > INFO > N/A > UNKNOWN), with aliases `na`, `none` and `not applicable`.
   - It is **not written**: BBH would turn it into `UNKNOWN` and lose the difference. The severity select offers a disabled "N/A (not supported by BBH yet)" option.
   - INFO is labeled "Informational (INFO)".
   - *BBH proposal:* add `N/A` (alias `NA`, `NOT_APPLICABLE`) to `SEVERITY_ORDER` / `normalize_severity` in bounty-core, ranked between INFO and UNKNOWN. Then the Board adds it to `SEVERITIES`.
2. **Date field for sort and filter.** Sorting uses `first_seen` (newest or oldest) and `last_seen` (newest). The date filter (7, 30 or 90 days, older than 90 days, no date) uses `first_seen`. Missing dates sort last. Ties keep ledger order because the sort is stable.
3. **Reclassification uses BBH's MapStore writer; the board never writes store files.**
   - Scope is `surface`, so no URL Ingest projection is triggered. The surface defaults to the finding's class.
   - Tags are `gadget[,residual]`, `finding-<fid>` and `from-ledger`, plus any extra tags.
   - The body records the source FID, title, class, severity as recorded, and lane-relative evidence and report paths.
   - The original finding is kept unchanged except for one appended `review_notes` line and an optional `status: archive`. Its severity, evidence and report files are untouched, so severity and classification stay separate.
   - "Reclassified" is not a BBH status, so none is invented.
   - A second move of the same FID is refused with `already_reclassified`.
4. **The two-step move is not atomic.**
   - If the finding changes between the MapStore write and the annotation, the server returns `409 partial_reclassify` with the created entry and does not annotate.
   - If the annotation fails, the writer is disabled (502) and the MapStore entry remains. The UI says so.
5. **Rolling sibling revisions forward (this fixes a defect that already existed).**
   - The revision includes the ledger file's dev/inode, and BBH replaces `ledger.json` atomically. So any write made every other row in that lane stale until Refresh.
   - The defect already affected the existing inline edits: edit A, then B, and B returned 409. Bulk class changes cannot work without fixing it.
   - The server now returns `{fid: [old, new]}` only for entries whose stored JSON its own write left byte-identical, taken from one read before and one after.
   - The client updates a row only if it holds exactly `old`. External changes are still conflicts.
   - The deliberate "byte-identical ledger replacement is a conflict" contract in `test_metadata_conflict` is unchanged.
6. **Submission.**
   - The dialog requires the checkbox "I understand this only records local state".
   - The result defaults to "Keep recorded result" because BBH cannot clear it.
   - State is always passed explicitly, to avoid BBH's default of `submitted`.
7. **Add finding.** File and description are required because BBH requires them. A duplicate gives `409 not_added`, and the writer stays enabled. The Add button stays disabled after a success to prevent an accidental second add.
8. **Drag and drop is a convenience.**
   - Rows are draggable onto the workspace nav targets Gadgets and MapStore, which are highlighted during the drag.
   - The same dialog is reachable from the row's Actions menu (menu button, arrow/Home/End/Escape keys) and needs no drag.
   - Dragging onto a class was considered and deferred. The searchable picker and the bulk class review cover classes without a drag.

## Evidence (synthetic data only; TMPDIR `/home/ryushe/.hermes/cache/scratch/bb-agents/ledger`)

- `python3 -m unittest tests.test_ledger_actions`: **18/18 passed**. This is a fake writer that mirrors BBH's atomic ledger replacement and duplicate exit code. It covers:
  - capabilities
  - origin and header refusals
  - validation
  - stale-revision and root conflicts, all without invoking the writer
  - exact argv
  - verification failure and writer failure disabling the writer
  - duplicate add
  - reclassify to gadgets and to MapStore
  - partial reclassify
  - annotation failure
  - a missing store writer
  - revision rebasing, including exclusion of a row changed during the write
  - `PATCH` still using the shared precheck
- `node --test --test-concurrency=1 static/tests/ledger-actions.synthetic.test.cjs` (real Chromium, fake writer): **6/6 passed**. It covers:
  - severity and date sort and filter, severity labels, and the disabled N/A option
  - the keyboard row menu
  - the class combobox
  - submission with the required confirmation
  - **drag onto Gadgets** with a live preview and the capability block
  - the non-drag MapStore move
  - dashboard bulk class review followed by back-to-back inline edits
  - add, duplicate and conflict feedback
  - read-only mode with everything disabled
  - an XSS title
  - **RED check:** with `rebase` disabled, the bulk-review test failed at "Moved 2 of 2".
- `BBH_SNAPSHOT=<disposable bbh copy with bounty_core> node tests/ledger_actions_bbh_e2e.cjs`: **PASS**. This is real Chromium → Board → the **actual BBH** writer. The BBH copy, the synthetic root and an isolated HOME are all created inside TMPDIR, and HOME stays empty.
  - Statuses: `[/api/finding 200, submission 200, reclassify 200, reclassify 200, reclassify 409 already_reclassified, new 200, new 409 not_added]`.
  - It verifies that informational is stored as INFO, the gadget capability body, the `review_notes` pointer, that evidence is kept, archive, and that the writer stays enabled after a duplicate.
  - The first run of this e2e exposed defect 5 (`reclassify 409 finding_changed`).
- Existing suites: see "Final runs" below.
- Screenshots (synthetic): `/home/ryushe/.hermes/cache/scratch/bb-agents/ledger/screens/row-menu.png`, `class-picker.png`, `drag-preview.png`.

## Gaps and follow-ups

- No BBH command clears a submission result. Clearing the report reference with an empty `--submission-report ""` is supported by BBH but not exposed.
- N/A needs the BBH change above.
- Severity rationale drafts still capture the revision when the draft is started. After another write in the lane, an older draft on a sibling row conflicts until Refresh. This keeps the existing stale-draft contract.
- Rebasing covers this server's own writes. Writes by other processes still require Refresh, as before.
- The move dialog does not offer `scope url` or behavior links. Use BBH directly for those.
- The bulk class review stops at the first writer failure. Each finding is a separate BBH call; there is no batch command.
- The dashboard severity breakdown is still sorted alphabetically (owned by app.js; the UI redesign may adopt `BoardLedgerActions.severityRank`).
- These are not compare-and-swap guarantees. Same limits as `PATCH /api/finding`: stop other writers and sync before editing.

## Final runs

All runs used real Chromium 1.60 and `/opt/google/chrome/chrome` on a shared 6-CPU machine (load average 16 to 24 during the runs).

- `python3 -W error::ResourceWarning tests/safe_suite.py`, run once: **198 run, 193 passed, 4 failed, 1 skipped** (excluded as designed: `test_backend.BackendTests.test_real_bbh_metadata_write_on_disposable_fixture`). This run began before the map-store probe change (decision 9).
  - Three of the failures were caused by that probe: `test_backend...context_symlink`, `test_metadata_conflict...stale_finding`, and `test_tailnet...hostile_patches`. Their fake writers count any call whose second argument is not `--help` as a write.
  - The fourth was `test_report_retention_capacity...two_processes_share_one_capacity_slot_repeatedly`.
  - After the fix, all 4 passed when run directly (`PYTHONPATH=.:tests python3 -m unittest <4 ids>`: **4/4 OK**). The full safe suite was **not** rerun after the fix.
- `npm test` (default selection, now including `ledger-actions.synthetic.test.cjs`): **121 tests, 120 passed, 1 failed**.
  - The failure was `review.synthetic.test.cjs`, "revisionless source conflict stays visible when original content returns": a 2000 ms timeout clicking Programs.
  - Running that file alone twice: **17/17 and 17/17 passed**. Treated as a load-related flake, not caused by this branch, but not proven.
- Real-BBH e2e (above): rerun after the probe fix, **PASS**.

9. **Map-store probe.** `writer_features` runs `agents/map_store.py --help` and looks for `write` in the subcommand list. Probing `write --help` would break the convention that `--help` is the second argument of every probe. The `write` flags themselves are assumed from the reviewed BBH; if a write fails, the writer is disabled.
