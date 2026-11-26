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

Review 10 round (2026-11-25, after 9c3e59d, load average 11 to 16):
- `python3 -m unittest tests.test_recon_urls tests.test_recon_intel tests.test_ledger_actions`: 80 OK.
- Recon node and browser files plus the finding-actions, ledger-actions, recent-actions, report-links-recent and dashboard-coverage browser files: 51/51.
- `python3 tests/safe_suite.py`: 580 tests, 1 failure, 13 skipped. The failure was `test_collaboration_process` "server did not start" within 10 s; the module alone passed 3/3.
- `npm test -- --test-concurrency=1`: 214 tests, 212 pass. The two failures were the live-editor Syncthing test and the ui-redesign multi-select test, both timeouts; each file alone passed (live-editor green, ui-redesign 7/7). All three are recorded in `BUGFIXES.md`.
- Screenshots regenerated: `recon-urls-light.png`, `recon-urls-history-dark.png`, `recon-urls-history-phone.png` (390 px, no page overflow) and the program views.

Earlier suite results (2026-11-25, load average 15 to 21):
- `python3 -m unittest tests.test_recon_urls`: 18 OK. `tests.test_recon_intel` plus `tests.test_ledger_actions`: 58 OK.
- `python3 tests/safe_suite.py`: 576 tests OK, 13 skipped. The skips are 12 opt-in Docker terminal tests and 1 Python-version fixture. The real-BBH mark test ran and passed.
- Recon node and browser files: 14/14. The finding-actions, ledger-actions, recent-actions, report-links-recent and dashboard-coverage browser files: 37/37.
- `npm test -- --test-concurrency=1`: 214 tests, 213 pass. The one failure was in `sandbox-terminal.synthetic.test.cjs` (an unrelated file); rerun alone it passed 8/8 (recorded in `BUGFIXES.md`).

## Scope in the URL browser (merge with scope-checked Recon intel, origin/beta 7c8c685)

The URL browser follows the scope design in `docs/integrations/scope-check.md`:

- **Verdicts from the cache only.** `GET /api/recon/urls` and `/api/recon/url` classify the URLs of the displayed page (at most 100) through `ReconIntel.annotate_urls`, which uses the existing `_scope_lookup` (cache-only `ScopeChecker.lookup`). URLs not yet classified are `unchecked` with `scope_summary.state` `pending` and are queued as one background `scope` job for the program, delta only and at the front of the queue. The client polls the page every 1.5 s while it is pending (at most 20 times). A request never starts BBH. Hosts are already classified by the program view; URLs are always decided exactly (`in` or `out`).
- **Hidden by default.** Out-of-scope rows on the page are hidden unless `oos=1` is in the hash. A line reads "N out-of-scope URLs on this page hidden · Show", a real link that sets `oos=1` and keeps the URL filters; under `oos=1` it reads "… shown · Hide". Shown out-of-scope rows are muted and carry the same OOS pill (the tooltip is the reason). An "unchecked" row of a program that has a scope gets "Scope not checked". A page whose rows are all out of scope says so. Select all selects only the rows on screen.
- **Copy gated.** The new per-row "URL" copy button uses the same rule as the other Recon lists: disabled with "out of scope" for `out`, with "scope not checked" for `unchecked` unless the program has no scope on file (`pending`, `failed` and `unconfigured` all block). Control characters still win. The copy action checks the rule again when clicked.
- **Marking not gated.** An operator may record a review of an out-of-scope URL (for example dismiss it). `unchecked` and `pending` do not block Mark either, and the server's mark path never consults scope. The mark response item carries `scope`, so the row keeps its pill.
- **Count links carry `oos`.** Every link into the URL browser is built from the current hash state, so `oos=1` travels with it, and so do the Close and paging links.
- **Merge resolution.** `recon-intel.js` had 8 conflicting hunks, resolved as unions:
  - `DEFAULTS` and `parseQuery` carry `oos` and the URL browser keys.
  - The helper exports are merged.
  - The depth tiles keep the count links, with "In-scope hosts/URLs" after Hosts.
  - Host rows keep the URL browser links, the findings popover and the coverage link, plus the OOS class and pill.
  - Hunt-next parameters keep the scope-gated example and copies, plus the link on the parameter name.
  - Under-tested hosts keep the scope filter and gated copies, plus the host link.
  - The dashboard card row stays one link and shows in-scope counts.

  `recon-intel.css` and `BACKEND_API.md` keep both sides. The auto-merged `recon_intel.py` and `app.py` were reviewed: scope jobs (`('scope', program, 0)`) share the worker queue with the debounced mark refresh without key clashes.
- **Suite results after the merge (2026-11-25, 394f455, load average 4 to 12):**
  - `python3 -m unittest tests.test_scope_check tests.test_recon_urls tests.test_recon_intel tests.test_ledger_actions`: 106 OK. The first run had 1 failure, my own: an exact item key set without the new `scope` key. Fixed in 394f455.
  - The recon (scope coverage is in `recon-intel.synthetic`), finding-actions, ledger-actions, recent-actions, report-links-recent and dashboard-coverage browser and node files: 54/54.
  - `python3 tests/safe_suite.py`: 639 tests OK, 13 skipped.
  - `npm test -- --test-concurrency=1`: 223 tests, 220 pass. The three failures were timeouts in files outside the URL browser:
    - finding-actions "delete archives…": 13/13 alone.
    - sandbox-terminal drawer: 8/8 alone.
    - ui-redesign "multi-select filters…": failed once more alone, then passed alone. It is the known flake that the scope-check dossier and review 10 also saw on beta.
- **Tests:**
  - `ScopeUrlTests` (3): a request with the worker not started queues the job and makes no BBH call; one call from the worker, then cache hits; items, history and the mark response carry scope; out-of-scope and failed-check URLs can still be marked.
  - The node `scope` helper test.
  - The browser test "scope in the URL browser", on a synthetic program whose scope excludes `static.example.test`: hidden line and Show link, `oos=1` muted rows with OOS pill and tooltip, copy blocked, Mark works, in-scope rows copyable, count links carry `oos`.
  - In the writer-off test: "Scope not checked" with copy blocked for a program with a scope folder when the Board has no `--bbh`.
  - Screenshot: `recon-urls-scope-light.png`.

## Gaps and open questions

- The manual_hunter capability probe in the real-BBH test is stubbed: that script needs the `bounty_core` package the real `bbh` dispatcher provides. The `url_ingest.py mark` call itself is real.
- The deployed `bbh` launcher must pass `HOME` through unchanged (it does: `os.execvpe(..., os.environ.copy())`). Hoster should be checked once with a real mark on a disposable program.
- Bulk marks cover the current page only (at most 100). Selecting across pages is not supported.
- BBH `mark` switches a rollback-journal index to WAL (its own `get_conn`). That is BBH behaviour, not the Board's.
