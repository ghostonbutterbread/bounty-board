# Interactive Recon

- Status: implemented on `feat/board-recon-interactive` (from 88651b0, v1.4); not merged or deployed.
- Owner: Bounty Board maintainers.
- Canonical path: `docs/integrations/recon-interactive.md`. Builds on `docs/integrations/recon-intel.md`.
- Code:
  - Server: `recon_intel.py` (URL browser queries) and `app.py` (`POST /api/recon/mark`, the `url_mark` writer feature, `writer_timeout`).
  - Client: `static/modules/recon-urls.{js,css}` (URL browser) and `static/modules/recon-intel.{js,css}` (links, slots, hash keys).
  - Small seams: `static/app.js` (`breakdown()` scope, scoped panels in the `#/recon` frame) and `static/modules/recent-reports.js` (scoped Reports panel).

## Intent

Ryushe after using the deployed Recon view: "in the urls area I can't click on them to see the URLs/edit them … the reports and such since I can't expand/modify them and or see what reports there are … pls make it so that its modifiable like on the dashboard".

1. Every URL-ish number and host leads to the actual URLs, which can be read in detail and marked through BBH.
2. The program page has the dashboard's own findings panels (pills, context menu, selection, drag, archive and delete) and a Reports panel.
3. Nothing looks clickable without acting.

## What it does

**URL browser (a panel on the program page).** It opens from:
- the URLs, Unique routes, Parameters, URLs with params, Tested URLs and Tested params tiles;
- a host name and its URL, route, parameter-URL, test-run and tested-URL counts in the Hosts table;
- the lane headers and cells of the "looked for" matrix;
- hunt-next parameter names (opened as untested in the hinted lane) and under-tested hosts;
- the "URLs" jump link.

Each of these is a real `<a href>` whose hash carries the filters (`u=1&uh=<host>&uq=<text>&ul=<lane>&us=<status>&up=1&un=<param>&ua=<cursor>`), so middle-click opens it in a new tab and a filtered list can be bookmarked.

- **Rows:** host, path and query (escaped), status per lane (pills, with the parameter), test count, first and last seen.
- **Filters:** host, text in URL, lane, status (untested, tested and the five BBH statuses), has parameters, parameter name.
- **Paging:** keyset, First, Previous and Next; the cursor is in the hash.
- **History:** opening a row shows its test runs and the latest status per lane. Notes are clamped. A `reports/*.md` evidence path links into the Board through `hrefFor`; any other path is shown as text.
- **Mark** (when the BBH writer is on): a small form with lane, status, an optional parameter (suggested from the row's keys), location and notes.
- **Bulk mark:** select rows (per row or the whole page, at most 100) and mark them with one form. It makes one BBH call per URL in order, shows progress with a Stop button, and reports the result on each row. A writer failure stops the run and says how many URLs were not attempted.
- **After a mark:** the row updates from the server's read-back. The lane's summary is recomputed at once after a single mark; a bulk run shares one recompute that runs 2 s after its last mark (review 10).
- **When Mark is not offered:** with editing off, the panel says "Editing is off: the backend has not enabled the BBH writer." (the ledger controls' wording) and shows no Mark controls. Rows with control characters, and non-web lanes, show the reason instead of a Mark button.

**Findings and Reports on the program page.**
- **Findings:** "Findings by severity" and "Finding classes" (by class or by category) are the dashboard panels, scoped to this program and lane. They have the same breakdown rows, drill rows, severity and submission pills, right-click menu, Select all and bulk bar, drag onto a severity or class row, archive and delete, and permanent delete from Show archived, all through the existing write paths.
- **Reports:** the Recent row design, filtered to this program and lane, newest first (20), with finding pills and N/A marks, plus "All reports" to the lane's Reports list.
- **Hosts table:** the Findings count opens a popover with links to those findings.

**Other links.**
- **Depth tiles:** Hosts, Test runs, URL observations and the JS tiles jump to their sections. Coverage questions and MapStore entries open those Board sections.
- **Dashboard card:** a whole Recon card row opens that program's Recon page.
- **Static values:** overview table numbers stay plain, with no link styling.

## Decisions

- **Inline panel, not a drawer.** The URL browser is a full-width panel right after the depth summary. A side drawer would compete with the sandbox terminal drawer and squeeze a wide table; inline it keeps the Board's table and pill design and works at 390 px (the table scrolls inside its frame).
- **One hash owner.** `recon-intel.js` parses and builds every `#/recon` key. `recon-urls.js` receives the filters and reports changes back. Program data is refetched only when the program or lane changes, not when URL filters do.
- **Newest first, keyset in id windows, never OFFSET.** The list shows the newest URLs first by default. An "Oldest first" checkbox is kept in the hash (`uo=asc`), and the cursor `ua` is an id bound in that direction. A single `WHERE … ORDER BY id LIMIT n` can scan the whole 1.3M-row table when the filter is sparse. Rows are read in id windows instead (5,000 ids, doubling while empty, up to 200,000), going down or up, each window a bounded statement, and a page stops after two query budgets. The returned cursor then points at the edge of the last window read, so Next keeps searching. Host filters use the host index; status filters use `EXISTS` on the small `observations` / `test_runs` tables.
- **Same database as BBH, or refuse.** BBH `url_ingest.py` has no root option. It writes `Path.home()/Shared/web_bounty/<program>/web/recon/url_index/url_index.sqlite`, and `web` is hard-coded. The Board passes its environment unchanged to BBH and runs it only when that path is the same file (device and inode) as the one it read. It refuses non-web lanes with that reason. It never guesses or creates a database.
- **What `mark` does with an unknown URL.** It inserts the URL ("ingested as new") and records the test run there. The Board only marks URLs it read by id, sends exactly the stored `canonical_url` (refusing when the client's copy differs), and checks afterwards that the new test run belongs to that id. A mismatch counts as a failed write.
- **Read-back tolerates concurrent agents (review 10).** The Board records the URL's highest test-run id before the call. It then requires a newer run with `agent_id` `bounty-board` and the requested lane, status and parameter, instead of "exactly one more run". An agent marking the same URL meanwhile no longer turns the writer off.
- **Refresh after marks is debounced (review 10).** The refresh uses a leading and trailing debounce of 2 s per index. A single mark recomputes at once; marks closer than 2 s apart share one recompute 2 s after the last. 20 marks give at most two recomputes, against 20 before. This is server-side, so a bulk run that is stopped or loses its tab still leaves a current summary. If BBH takes longer than 2 s per call, each mark refreshes on its own again, which is still bounded by the de-duplicated worker queue.
- **The same-database check assumes a local BBH with the Board's HOME (review 10).** The check compares the file BBH would open under the Board's `HOME` with the file the view read. It holds only when the configured `bbh` runs BBH on this host and passes `HOME` through; the standard launcher does (`os.execvpe(..., os.environ.copy())`). A wrapper that changes `HOME`, or runs BBH on another host, would make BBH write a different database. The read-back would then report a failure and turn the writer off, but only after that write. The orchestrator verifies Hoster's launcher.
- **Status validation in the Board.** BBH prints an error for an unknown status but exits 0, so the Board accepts only the five statuses and the twelve BBH lanes.
- **Same runner, same failure policy.** The mark uses `run_writer` (argv list, no shell, timeout, writer disabled after a failure or a failed read-back), the ledger trust checks, and `metadata_write_lock`. The timeout is the existing 60 s, now a server attribute so tests can shorten it. Marks are attributed with `--agent-id=bounty-board`.
- **Bulk runs on the client.** Sequential POSTs give exact progress, a Stop button and per-row failures without a long server request. The cap is 100, on the current page only.
- **Dashboard panels reused, not copied.** `breakdown()` takes a scope. Expansion is kept per scope in `state.scopedExpanded`, and the dashboard's `state.dashExpanded` and tests are unchanged. Row ids keep the `sev:…` / `class:…` format, so finding-actions drop targets, decoration and selection work unchanged. The app renders the scoped panels and the Reports host in the `#/recon` frame, so finding-actions and recent-reports decorate them in their normal `afterRender` pass; `recon-intel.js` then moves the block into its layout and keeps it across repaints. The scope comes from the hash (`p`, `lane`), so the first paint is complete.
- **Findings per host** use the same `asset`/`url`/`endpoint` host as the count (up to 50 IDs per host), resolved against the loaded findings for titles and severity.

## Security notes

- **Read-only rule unchanged:** every URL query goes through `open_plan`/`ReadOnlyDB` (no side files, `query_only`, per-statement budget).
- **Target data:** URLs, hosts, parameters, notes and evidence paths are escaped. A URL link (external icon) is offered only for `http(s)` values without `unsafe_chars`, and opens in a new tab with `rel="noopener noreferrer"`. Nothing fetches a target. Rows with control, bidi or invisible characters can't be selected or marked, and the server refuses such values too.
- **Writes:** only through BBH, only with `--bbh` and `--accept-uncoordinated-writes`. Requests use the same origin, CSRF header, JSON and size checks as the ledger actions, plus root-instance and URL preconditions and a read-back. There is no delete.
- **What tests touch:** synthetic data only. No test opens `~/Shared` or runs BBH against it. The real-BBH test sets `HOME` to a temporary directory.

## Evidence

- `tests/test_recon_urls.py` (18 tests):
  - keyset pages cover all 98 URLs exactly once;
  - every filter;
  - history;
  - parameter rejections, including `offset`;
  - a missing index says where it expected it;
  - unsafe characters are escaped and flagged;
  - the concurrency cap;
  - a sparse filter on a 400k-row index stops within the budget and resumes to the end;
  - Mark: argv mapping, row and summary refresh (tested URLs 4 to 5 with no waiting), trust checks and validation never running BBH, lane and HOME mismatch refused, BBH failure, timeout, wrong read-back and an inserted new URL disabling the writer, writer off, capability advertised;
  - `RealBbhMarkTests`: the real `agents/url_ingest.py mark` from a BBH checkout writes the test run into the database the view reads, matching the existing URL (no new URL) and writing nothing else under HOME.
- `static/tests/recon-urls.test.cjs` (4 tests): API query (newest first by default, order and cursor), mark body rules, refusal reasons, hash round-trip including `uo=asc`.
- Review 10 additions in `tests/test_recon_urls.py` (22 tests in total). Each fails on 4b40c2b:
  - `test_agent_mark_during_the_call_does_not_fail_the_board_mark`: the fake BBH also inserts an agent's run during the call. Before: 502 `verification_failed`.
  - `test_bulk_marks_share_one_or_two_summary_recomputes`: 20 marks. Before: 20 recomputes; now at most 2, with the summary current at the end.
  - `test_newest_first_by_default_and_both_directions_cover_every_url_once` and `test_id_gaps_and_filters_in_both_directions`: every URL exactly once in both directions, with deleted id ranges and a host filter.
  - `LargeIndexTests`: sparse filters resumable going down as well as up.
- Browser additions:
  - newest first and the Oldest first toggle in the hash;
  - the history layout check: sub-values on their own line and cell padding of at least 12 px, plus the `recon-urls-history-dark.png` screenshot.
- `static/tests/recon-interactive.synthetic.test.cjs` (3 browser tests):
  - the card row, the URLs tile, paging, the host link, history with an evidence link, filters in the hash surviving a reload, a hunt-next parameter link, a single mark with the argv checked and the summary recomputed, a bulk mark of 3, an unsafe row, and a failing bulk run;
  - findings panels (pill edit, context menu, drag onto a class, Select all and bulk bar, archive), the Reports panel, the host findings popover;
  - writer off, with light, dark, dusk, wide and phone layouts and no sideways scroll at 390 px.
- Screenshots (synthetic data) in `$TMPDIR/screens`: `recon-program-{light,dark,dusk,wide,phone}.png`, `recon-urls-light.png`, `recon-mark-form.png`, `recon-findings-light.png`, `recon-reports-light.png`.

Suite results (2026-11-25, load average 15 to 21):
- `python3 -m unittest tests.test_recon_urls`: 18 OK. `tests.test_recon_intel` plus `tests.test_ledger_actions`: 58 OK.
- `python3 tests/safe_suite.py`: 576 tests OK, 13 skipped. The skips are 12 opt-in Docker terminal tests and 1 Python-version fixture. The real-BBH mark test ran and passed.
- Recon node and browser files: 14/14. The finding-actions, ledger-actions, recent-actions, report-links-recent and dashboard-coverage browser files: 37/37.
- `npm test -- --test-concurrency=1`: 214 tests, 213 pass. The one failure was in `sandbox-terminal.synthetic.test.cjs` (an unrelated file); rerun alone it passed 8/8 (recorded in `BUGFIXES.md`).

## Gaps and open questions

- The manual_hunter capability probe in the real-BBH test is stubbed: that script needs the `bounty_core` package the real `bbh` dispatcher provides. The `url_ingest.py mark` call itself is real.
- The deployed `bbh` launcher must pass `HOME` through unchanged (it does: `os.execvpe(..., os.environ.copy())`). Hoster should be checked once with a real mark on a disposable program.
- Bulk marks cover the current page only (at most 100). Selecting across pages is not supported.
- BBH `mark` switches a rollback-journal index to WAL (its own `get_conn`). That is BBH behaviour, not the Board's.
