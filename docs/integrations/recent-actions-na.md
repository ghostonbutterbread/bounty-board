# Recent actions, report N/A and dashboard row redesign

- Branch: `feat/board-recent-actions` (worktree `bounty-board-recent`), from `52f1b48` (v1.1, deployed on beta). Not pushed, not merged, not activated.
- Request (Ryu): adjust severity/submission from the Recent reports panel and view; a quick way to mark noisy reports N/A (strikethrough, lower opacity) with a filter to hide them; fix the cramped right side of the dashboard finding rows and the unused width. Follow-up: "if you see a better ux/ui do that pls ... i like the placement of the severities and such of the top section but not of the bottom ... make it look more aesthetic".

## Intent

1. A report row in Recent (dashboard panel and `#/recent`) knows which finding it belongs to, server-side, from the ledger the index already holds.
2. Mapped rows act on that finding with the same pills, write paths, stale-write protection and Undo as the dashboard and Findings table.
3. Any report can be marked N/A in one click. It is a Board-only marker (never the ledger or the file), stored server-side so every device sees it.
4. N/A rows are hidden by default where reports are listed, with a count and a quick way to show them.
5. The dashboard reads as one design: finding rows use the Recent panel's row language, and the dashboard uses wide screens.

## Contract

Full details in `BACKEND_API.md` (`GET /api/recent-reports`, `POST /api/report-na`).

- **Mapping** (`search_index.py`, at lane scan time, no extra disk walk): `report_path` owner, then `evidence_path` owner, then a packet folder (`reports/<FID>[-slug]/...`, any depth below it, so `EVIDENCE.md`, the submission report `<target>-<vuln>-<FID>.md` and `_meta/` files all map), then a legacy `<FID> - <title>.md` file anywhere. Only FIDs that appear once in the ledger; never generated navigation. Recent items carry `finding: {fid, title, severity, status, submission, submission_status, metadata_revision, match}`. A successful BBH write calls `SearchIndex.touch()`, so the next Recent request re-reads the ledger before answering.
- **N/A store** (`ReportNaState` in `app.py`, next to `ArchiveState`): `report-na.json` in `--state-dir` (refused inside the data root); key `family/program/lane/path`, value `{family, program, lane, path, marked_at}`; at most 10,000 entries (oldest dropped); atomic replace, fsync, mode 0600; own lock (works with the BBH writer off). A read error refuses the write (503) instead of overwriting; a corrupt file is set aside as `report-na.json.corrupt-<time>`. Display reads that fail report `na_available: false`.
- **Endpoint** `POST /api/report-na {family, program, lane, path, na}`: same trust checks as the ledger actions (same-origin Origin, `X-Requested-With`, JSON content type, single Content-Length ≤ 4096, no Transfer-Encoding), strict token and path validation, marking requires an existing regular `.md` file under the lane's `reports/` reached without symlinks; unmarking a missing file is allowed so stale marks can be cleared. 403 / 400 / 404 / 503 as documented.
- **Payloads**: Recent items get `na`; `hide_na=1` filters them out of items, totals, paging and facets, with `na_hidden` and `na_hidden_page`. Lane reports in `/api/data` and `/api/lane-reports` get `na`; `capabilities.report_na.enabled` and `na_available` say whether marks can be used.

## Frontend

- `static/modules/report-na.js|css` (new): the toggle (`BoardReportNa.toggleHtml`), one capture-phase click handler for every `[data-na-toggle]`, the POST, Undo toast, copying the saved flag into loaded lane reports, a `board-report-na` event for other modules, and focus restore (to the same toggle, or to the list's "Show" control when the row was hidden).
- `recent-reports.js`: severity and submission pills on mapped rows (`BoardFindingActions.severityPills/submissionPills`, so writes, expected revisions, stale refusal, writer-off hint and Undo are the existing code). It prefers the loaded workspace row for a finding (the same object the dashboard lists use, so one save updates every row of that finding); before the workspace data is loaded it uses one shared copy from the server payload. "Hide N/A" in the toolbar (default on, `na=show` in the URL hash when off, remembered with the other filters), "N N/A hidden · Show" in the status line, an N/A column at the end of each row. The dashboard panel asks for `hide_na=1` and shows "N N/A hidden · show" from `na_hidden_page` (only what would have been in its latest-8 span). Right-click or Shift+F10 / ContextMenu on any row: Open report in new tab, and for mapped rows Open finding, Change severity…, Submission…, Copy ID; Mark/Unmark N/A on every row. Background refreshes keep keyboard focus on the same control.
- `app.js`: program Reports list gets the toggle, "Hide N/A" (remembered per browser, default on) and the hidden count; drill-down finding rows use the new row markup; a report link to an N/A report is dimmed and says so in its label. `BoardUI` exports `submissionBadge` and `submissionLabel`.
- `finding-actions.js`: report markers go into the row's icon column; the Evidence link also shows beside a linked report (BBH packets have both); `BoardFindingActions` exposes `entry`, the pickers, `copyIds`, `canEdit`, `canSubmit` for other modules.

## Design (dashboard rows)

Reference: the Recent panel row Ryu liked. Finding rows in the Severity breakdown and Finding classes drill-downs now follow it:

- Left: checkbox, then the title (strongest: 600 weight, normal text colour, accent only on hover) on one line with an ellipsis and the full title in the tooltip; under it a muted subline: `FID · status · class` (class only where the list is not already grouped by class), the archive badge, template-placeholder badge and the actionable "Possible report" link (warning colour).
- Right: one aligned cluster in columns: severity pill, submission pill, then icon links (report `fa-file-text-o`, evidence `fa-paperclip`, a muted `fa-file-o` with the reason when there is no report). Icons have `aria-label`s and tooltips with the path.
- Alignment: in the half-width drill-downs the columns size to the widest pill in the expanded list (CSS grid shared by all program groups through `subgrid`), so the title keeps the most room and every row lines up. The full-width Recent panel uses fixed columns (`--col-sev`, `--col-subm`, `--col-when`, `--col-na`) so its pills line up the same way.
- Rhythm: 7 px vertical padding, 1 px separators, quiet row hover, no layout shift (pills keep their size; hover only adds a ring or background). Colour only where it means something: severity tints, submission accent/result tones, Possible report warning; everything else neutral tokens. Both themes use only existing tokens.
- N/A rows: strikethrough title, opacity 0.45, rising to 0.8 on hover or focus so they stay readable and clickable. The toggle is a small bordered "✓ N/A" chip: faint check when off, filled when on.
- Phone (≤ 650 px): the right cluster wraps as one block under the title (pills and icons on one line), no horizontal overflow.
- Width: on the dashboard `.page` may grow to 1960 px (was 1480), so wide screens are used; the two-column grid keeps each panel's line length readable.

## Decisions made

- Hidden by default everywhere (Recent view, dashboard panel, Reports list), as asked; the dashboard panel's "show" is per page view, the view and Reports list remember the choice.
- `na=show` is written to the hash only when N/A rows are shown, so existing canonical links (`#/recent?within=7d&order=newest`) are unchanged.
- N/A filtering is server-side for Recent so totals and paging stay right; the Reports list filters client-side (the lane index is already loaded).
- Report links inside finding rows show the N/A state (dimmed, labelled) but have no toggle: the row is about the finding and a second control there would crowd the cluster. Toggle from the Reports list or Recent.
- `_meta/` files inside a packet map to the finding too (they are inside `reports/<FID>-slug/`); they are usually small notes, and can be marked N/A.
- The severity breakdown drill-down now also has the severity pill (before it showed the status there); status moved to the subline in every list.

## Evidence

Ghost, Python 3.14, Node 22, Playwright 1.60, Chrome headless, `TMPDIR=/home/ryushe/.hermes/cache/scratch/bb-agents/recent`, synthetic fixtures only, `--test-concurrency=1`, load average about 8 to 11.

- New Python tests `tests/test_report_na.py` (19) and 9 new in `tests/test_recent_reports.py`. They cover: mapping (packet `EVIDENCE.md` and the submission report map to one FID, owner paths, legacy names, FID not in the ledger, duplicate FIDs, navigation, top-level files, payload equal to `/api/data`, `touch()` freshness); the store (set and unset, persistence across a restart, mode 0600, the size bound, the path cap, a corrupt file set aside, an update read error not overwriting, a display read error showing unavailable, a state dir inside the root refused); the endpoint (works with the writer off, trust failures, path validation including symlinked file and directory, 404, unmarking a deleted file, 503 without a store); and `hide_na`, `na_hidden`, `na_hidden_page` and the flags in the lane payloads. With `test_archive_state` and `test_search`: **88 run, OK**.
- `python3 -W error::ResourceWarning tests/safe_suite.py`: **354 run, OK, 1 skipped** (the real-BBH test, excluded by design), 649 s.
- New browser tests `static/tests/recent-actions.synthetic.test.cjs` (fixture `tests/recent_actions_fixture.py`, BBH packet shape): **7/7 pass**. They cover:
  - Recent pills save severity and submission through the BBH paths; every row of the finding follows (both panel rows and the drill-down); Undo; a result after Submitted; no pickers on unmapped rows.
  - A stale pick is refused, not overwritten.
  - The context menu items, open in new tab, Copy ID, and the keyboard opener.
  - Writer off: the pills are disabled with the hint, and N/A still works.
  - N/A: hidden with "1 N/A hidden", store file mode 0600, the report file unchanged, opacity 0.45 and line-through after "show", `aria-pressed`, the Recent view's Hide N/A with `na=show` in the hash and back, keyboard unmark keeping focus, Undo, the Reports list toggle and count after a reload.
  - No state dir: the toggle is disabled with the reason.
  - Aligned layout at 1360 px: severity, submission and links share one line (centres within 2 px), columns aligned across rows, the title on one line with an ellipsis; Severity breakdown pills save severity and submission.
  - Phone 375 px, dark: the pills wrap as one line under the title, with no overflow.
- Touched suites run together (`finding-actions`, `report-links-recent`, `ui-redesign`, `taxonomy-coverage`, `ledger-actions`): **34/34 pass**. No existing test needed changing.
- `npm test` (26 files): **187 tests, 186 pass, 1 fail**, 509 s. The failure is `ui-redesign` "multi-select filters, chips, persisted sort and row actions": the menu's first item was not focused yet (line 147), the same load flake the report-links dossier recorded. The file alone: **7/7**. It is about the Findings-table kebab menu, which this branch does not change.

### Screenshots (synthetic)

`node static/tests/tools/recent-actions-screenshots.cjs $TMPDIR/screens before` (run on a clean `git archive` of `52f1b48`) and `... after` (this branch) wrote 25 PNGs each to `/home/ryushe/.hermes/cache/scratch/bb-agents/recent/screens/`: `{before,after}-{dashboard-recent,dashboard-classes,dashboard-severity,dashboard-full,recent-view}-{desktop-light,desktop-dark,wide-light,phone-light,phone-dark}.png` (desktop 1440x900, wide 1920x1080, phone 375x812). The "after" desktop-light run marks one report N/A first, so later shots show "1 N/A hidden" (marks are server-side, so every later context sees it). Checked by eye. Problems fixed that way: the drill-down title was squeezed to about 120 px by fixed columns (now subgrid columns sized to the content), and a separator dot was underlined beside "Possible report".

## Gaps and limits

- On very wide screens the full-width Recent panel puts a wide gap between the title and its pills (unchanged from before; Ryu liked that panel as is).

- Moving or renaming a report drops its mark (keys are paths). There is no cleanup of stale keys; they are bounded by the 10,000-entry cap.
- The dashboard panel's "show" choice is not remembered across reloads.
- Recent rows reflect ledger edits made outside the Board within the 5 s index interval (or immediately after a Board write).
- Undo of a Recent pick for a finding that is not in the loaded workspace data (cold start) reports "no longer loaded" instead of undoing; refresh first.
- Multi-select and drag are not offered on Recent rows (they are report rows; the finding lists keep them).

## Decisions for Ryu

- Should the dashboard panel remember "show N/A" across reloads, the way the Recent view and Reports list remember it? It doesn't today.
- Should `_meta/` files inside a packet show in Recent at all? Today they show and map to the finding. They could be hidden by default, like generated navigation.
- Should finding rows also get an N/A toggle on their report icon? Today they only show the state.
- Should stale N/A marks (from moved or renamed reports) be cleaned up automatically? Today they are only bounded by the cap.
