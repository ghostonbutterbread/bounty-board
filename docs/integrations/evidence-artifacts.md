# Evidence files are artifacts, not reports

- Branch: `feat/board-evidence-artifacts`; base `origin/beta` at `88651b0` (production); target `beta`.
- Ryushe (verbatim): "this is an example on on the indexed reports and such on the uis we shouldnt be indexting the evidence. it should be an artifcat not show up as a vulneability"
- His example: `#/programs/<family>%2F<program>/web/reports/<FID>-<slug>%2FEVIDENCE.md`, a BBH packet folder whose only Markdown file is `EVIDENCE.md`. It was listed in Reports, Recent (mapped to the finding with severity pills, so it read like a second vulnerability) and search.

## Intent

An evidence file belongs to its finding. It is never a row in a report list, a Recent item, a search report hit or a report count. It is still one click away: from the finding row (paperclip), from old links, from search finding hits and from the submission report's artifacts panel, and it opens as a read-only evidence view.

## Classifier contract (`report_evidence.py`)

One module, imported by both indexes (`app.reports()` for `/api/data` and `/api/lane-reports`; `search_index.SearchIndex` for `/api/search` and `/api/recent-reports`), like `report_publisher.generated_navigation`:

- `reports_relative(recorded, lane)`: a ledger path to a path under `<lane>/reports/`. Relative paths are lane-relative (`reports/...`, normalized, no escape). Absolute paths match under this lane's own `reports/`, else by their last `/<family>/<program>/<lane>/reports/` segment (ledgers written on another host), as `report_artifacts.recorded_relative` does.
- `recorded_paths(findings, lane)`: the sets of paths named by any `report_path` and any `evidence_path`.
- `is_evidence(relative, report_paths, evidence_paths)`: true when no `report_path` names the file and either its basename is `EVIDENCE.md` (case-insensitive, any depth) or an `evidence_path` names it. A `report_path` named `EVIDENCE.md` stays a report.

The decision uses only the path and the ledger, so evidence is skipped before any content read: `reports()` skips it after the walk's own `is_symlink`/suffix checks; the search index keeps it by path from the walk's lstat (no read, no text budget, no `max_reports` slot). With no ledger (`findings=None`), only the name rule applies.

`static/app.js` mirrors the rule client-side (`reportsRelative`, `isEvidencePath`, `evidenceIdFor`) from the lane's findings, so routes can be classified even before the report index arrives. The comment there points at `report_evidence.py`.

## API changes

- `/api/data`, `/api/lane-reports`: evidence files are absent from `reports`. `kind: generated_evidence` is no longer produced. Every other kind, field and warning is unchanged.
- `/api/recent-reports`: evidence files are absent from `items`, `total`, `total_reports` and facets, with or without `navigation=1`. `finding.match: evidence_path` is no longer produced (a file an `evidence_path` names is evidence).
- `/api/search`: evidence files are never report hits and do not count in `counts.report` or a program's `report_count`. Finding hits still match by fid/title; `report` is `{path, title: "Evidence", kind: "evidence", target}` when the finding has no indexed report but has an evidence file (the report link wins when both exist).
- `/api/report` and `/api/report-artifacts*` are unchanged: evidence content and its folder stay readable.
- N/A marks on evidence files (made before this change) are kept but no longer shown; see gaps.

## UI behaviour

- **Finding rows.** Findings table: a muted "Evidence" link with `fa-paperclip` after the "Report" link. Dashboard drill rows: a paperclip icon in `.row-links` after the report icon (and after the "No report" marker when there is none). Both are real `<a href>` hash routes (plain click stays in the app, middle/Ctrl+click opens a tab), `aria-label="Evidence: <path>"`, tooltip `Open evidence: <path>`. Shown when the finding's `evidence_path` maps under this lane's `reports/`, ends in `.md`, and is evidence by the rule above. The old `finding-actions.js` decoration that looked for `generated_evidence` report rows is removed.
- **Evidence view.** Any Reports route whose path is evidence (finding-row link, old `.../reports/<packet>/EVIDENCE.md` URLs, search "Open evidence", coverage refs to `reports/.../EVIDENCE.md`) renders `[data-evidence-view]` before every report branch, including the `--live-edit` branch and the "Reports are loading" states:
  - heading "Evidence for finding <FID>" (FID links to the finding row), or "Evidence file" when no finding records it; a packet-folder match (`<FID>-slug/...`, unique FID) says so in the hint;
  - an "Evidence" pill and the path; one row per owning finding with "Show finding" and "Open report" (or "No report yet");
  - the Markdown rendered by the Board's existing safe `markdown()` from `/api/report` (reloaded quietly when the workspace data refreshes, no flash);
  - the existing artifacts panel (`#report-artifacts-host` with the evidence path), which lists the packet's other files including the submission report and keeps its own quiet 4 s refresh;
  - the lane's report list below, for navigation.
  - Never: the editor, live/collaborative editing, the report picker, an N/A toggle for the evidence file, the "Report not found in this lane" warning, or a silent switch to another report. A missing `EVIDENCE.md` shows "Evidence could not be loaded" inside the view. A path that is neither evidence nor indexed keeps the not-found warning.
- **Search palette.** Finding hits whose link is evidence show "Open evidence" (and "evidence, no report yet" in the subline); Shift+Enter opens it.
- **Submission report.** Its artifacts panel keeps listing `EVIDENCE.md` (folder rule; unchanged code, now tested).
- Removed dead strings: `generated_evidence` labels in the Reports list badge map and the record-value kind map in `app.js`, and the finding-actions evidence tooltip copy.

## Tests

New:

- `tests/test_evidence_artifacts.py` (11): classifier (relative, normalized, same-host absolute, other-host absolute, rejects; case-insensitive name, nested, reports root, evidence_path-only other name, `report_path` named `EVIDENCE.md`, report_path beats evidence_path); `reports()` excludes evidence and never reads it, no-ledger name rule; SearchIndex Recent/search/report_count exclusion, finding links (`report` vs `evidence`, other-host path), no read and no budget, a new evidence file never appears; HTTP `/api/data`, `/api/lane-reports`, `/api/recent-reports`, `/api/search`; `/api/report` still serves evidence; the submission report's artifacts list `EVIDENCE.md` and the evidence view's panel lists the packet's other files; both indexes import the shared classifier.
- `static/tests/evidence-artifacts.synthetic.test.cjs` (3, in `npm test`; fixture `tests/evidence_artifacts_fixture.py` reuses the Python fixture): no evidence in the Reports picker, list or count, Recent (also with generated files shown) or search report hits; search "Open evidence" link and click; findings-table and drill-row evidence hrefs, labels, tooltip, order after the report icon, Ctrl+click new tab and plain click in place; old evidence URL renders the view with finding/report links, safe preview and artifacts panel and no editor/picker/not-found/N/A; report link opens the submission report; unowned and missing evidence; `report_path` named `EVIDENCE.md` opens as a report; unknown path keeps not-found; `--live-edit`: evidence never opens the live editor.

Red on base (only the source files swapped to `git show 88651b0:<file>`, run, restored):

- Python: `app.py`, `search_index.py` swapped: 11 run, 7 failures + 1 error. The three that pass on base are the pure classifier unit tests (new module) and the artifacts-panel/report-content test (that behaviour already existed and must keep working).
- Browser: `app.py`, `search_index.py`, `static/app.js`, `static/modules/finding-actions.js`, `static/modules/search.js`, `static/style.css`, `static/modules/finding-actions.css` swapped: 3 of 3 fail.

Updated existing tests (only where the old behaviour is what Ryushe asked to remove, or where a fixture file merely happened to be evidence):

- `tests/search_fixture.py`: AC-3's `evidence_path` now names a new `raw/redirect/EVIDENCE.md`; `raw/redirect-evidence.md` stays as an ordinary unregistered note, so every Recent/time-window/N/A assertion that used it keeps its meaning.
- `tests/test_recent_reports.py`: the evidence mapping assertions become "evidence is not a Recent item" and "the note maps to nothing"; mapping-rule dict drops the two evidence files (dict equality proves absence); the payload check uses the packet's submission report.
- `tests/test_backend.py`, `tests/test_report_index_synthetic.py`: `generated_evidence` items become absence assertions.
- `tests/test_report_retained_scan.py`: `EVIDENCE.md` is still served editable by `/api/report`; it is asserted absent from the list.
- `tests/test_report_na.py`: N/A endpoint tests used `F012-xss/EVIDENCE.md` as an ordinary report; renamed to `F012-xss/submission.md` (assertions unchanged). The Recent touch test uses D01's submission report instead of its evidence.
- `static/tests/board-policy-real.synthetic.test.cjs`: `evidence.md` (named by `evidence_path`) is asserted absent and dropped from the editing loop.
- `static/tests/report-save-ui.synthetic.test.cjs`: the adapter injected `generated_evidence`; it now injects `unregistered` and expects "Unregistered artifact" (the test is about editability).
- `static/tests/coverage-drilldown.test.cjs`: new `evidenceForRef` cases.
- `static/tests/finding-actions.synthetic.test.cjs` unchanged and passing: its A04 `.evidence-report` href/label assertions now hit the new app.js link.

Runs (box shared and loaded; `TMPDIR=/home/ryushe/.hermes/cache/scratch/bb-evidence/tmp`, `NODE_PATH=/home/ryushe/projects/bounty-board-initial/node_modules`, `CHROME_BIN=/opt/google/chrome/chrome`):

- `ls tests/test_*.py | sed 's#/#.#;s#\.py$##' | xargs -P4 -n1 python3 -m unittest`: 43 modules, 570 tests, 0 failures, 0 errors (13 skipped: Docker and opt-in tests).
- `npm test`: final run 210 tests, 210 pass, 0 fail. The first run (before the recent-actions test update) had 4 failures: 3 in `recent-actions.synthetic` that drove the packet's `EVIDENCE.md` Recent row (updated, then 9/9 alone) and `ui-redesign` "multi-select filters..." (passed alone).
- Broad browser suite (`node --test --test-concurrency=1 --test-skip-pattern='^browser metadata update reaches backend with a disposable synthetic writer$'` over `static/tests/*.test.cjs` minus `collaboration.synthetic` and `collaboration-combined.synthetic`, 46 files): 287 tests, 286 pass, 1 fail: `ui-redesign` "not-submitted filter, program search and explicit workspace target" (TimeoutError, load average about 13). `ui-redesign` alone: first 6/7 (this time the "multi-select filters" keyboard-focus assertion), then that test 6 of 7 targeted reruns, the same test on the base files 4/4, and the whole file again 7/7. Its fixture has no `evidence_path`, so no new code path runs there; recorded as a load flake, not a regression.

Screenshots (synthetic fixture, `EVIDENCE_SCREENSHOT_DIR=/home/ryushe/.hermes/cache/scratch/bb-evidence/tmp/shots`): `evidence-view-light.png`, `evidence-view-dark.png`, `finding-rows-light.png`, `finding-rows-dark.png`, `dashboard-drill-light.png`, `submission-report-artifacts-light.png`.

## Gaps

- Existing N/A marks on evidence files stay in the private store (the files still exist, so pruning keeps them) and are rechecked on listings within the existing `MAX_PRUNE` bound. They are invisible now. Harmless; clear them if wanted.
- An `evidence_path` that is not Markdown (a folder or `.txt`) gets no row icon: the evidence view reads through `/api/report`, which serves `.md` only. None measured in production (all 207 evidence_path targets are `EVIDENCE.md`).
- The client classifies routes from the lane's findings. In the progressive (`portfolio_unloaded`) mode, before the selected lane's ledger arrives, an `EVIDENCE.md` route shows "Loading evidence…"; an evidence_path-only file with another name briefly shows the normal report loading state until then (0 such files measured).
- `/api/report` still reports `editable`/`collaboration_editable` true for evidence, and `/api/live/*` would accept it if called directly. The Board never opens an editor for it; tightening the API was not asked for.
- With `--terminal-url`, the sandbox terminal toggle also appears on the evidence view (it keys on `#report-artifacts-host`); it opens the packet folder, which seemed useful. Say if it should be hidden there.

## Decisions for Ryushe

- Classifier lives in a new tiny module `report_evidence.py` (not inside `report_publisher.py`, which is about publishing); both indexes import it.
- Unowned `EVIDENCE.md` files (15 measured) are evidence by name and leave the indexes too; the view calls them "Evidence file" and, when the packet folder names a unique FID, links that finding.
- The evidence view shows the owning finding's FID and title but no severity or submission pills, so it never reads as a vulnerability of its own.
- `generated_evidence` is documented as no longer produced rather than removed from the contract text, for older clients.
- Coverage evidence refs that name `reports/.../EVIDENCE.md` used to link via the report list; they now link to the evidence view so that link is not lost.
- No sibling-owned files (`report_artifacts.py`, `static/modules/report-artifacts.js`, `static/modules/report-artifacts.css`) were edited.
