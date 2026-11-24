# Integrated Board workspace

- Branch: `feat/board-workspace-integrated` (worktree `bounty-board-integrated`). Not pushed, not merged into beta/main, not activated.
- Base: `e9246db` (live editing server + module seam). Six feature branches were built in parallel from it and merged here in this order:

| Order | Branch | Tip | Merge commit |
| --- | --- | --- | --- |
| 1 | `feat/live-report-editing` | `982b84c` | (already HEAD before this work) |
| 2 | `feat/board-ui-redesign` | `21a2b97` | `3da026c` (before this work) |
| 3 | `feat/board-ledger-actions` | `2e19d4b` | `6e5d5d5` |
| 4 | `feat/board-report-artifacts` | `4395f83` | `465a073` |
| 5 | `feat/board-search` | `414a5c9` | `4848389` |
| 6 | `feat/board-taxonomy` | `1834a7b` | `6780f14` |

Every merge used `git merge --no-ff`. Integration commits after the merges: `f40b41a`, `9799bc2`, `d60b98a`, `c69319a`, `7afabee`, plus the final dossier commit. The per-feature dossiers stay as written by their agents: `live-report-editing.md`, `board-ui-redesign.md`, `ledger-actions.md`, `report-artifacts.md`, `global-search.md`, `taxonomy-coverage.md`, `taxonomy-cleanup-proposal.md`.

## Intent

Make the six features one coherent product on top of the redesign: one row menu, one sort system, one navigation path, one search entry point, one server close path, and module UI that uses the redesign tokens in light, dark and dusk.

## Conflicts and how they were resolved

- **app.js, ledger-actions:** dashboard and findings markup taken from the redesign (it already carried `data-finding-id/data-program/data-lane`); the ledger module's filter/compare seam was kept only in the merge commit, then removed when sort and filter were unified (`f40b41a`). The auto-merged `BoardFindingView.rebase` calls in the inline metadata and rationale save paths were kept.
- **app.js, artifacts:** the `artifactsHost()` helper was added next to the redesign UI helpers; it stays in the read-only and editable non-live report views.
- **app.js, search:** both branches defined `navigate()`. The search version was replaced by `moduleNavigate()` (exposed as `ctx.navigate`), which validates the target and delegates to the redesign `navigate()`.
- **app.js, taxonomy:** helpers added next to the redesign helpers; the category and "Shown as" notes moved into the redesigned rows; the base-markup "By category" bars were dropped and re-implemented inside the redesigned class breakdown.
- **index.html:** exactly one `#global-search-host` (the redesign topbar one); one line per module under `<!-- Feature modules -->` (live-editor, ledger-actions, report-artifacts, search, taxonomy, coverage-drilldown).
- **app.py:** artifacts handlers and `search_request` both kept. The two `server_close` wrappers (live editing, search index) became one close path that stops the live watcher, then the search index thread, then closes the socket, each step running even if the previous one raised.
- **package.json:** union of every branch's test list (see "Test selection").

## Behavior decisions (integration)

1. **One row menu.** The kebab (`Actions for <title>`) lists Copy finding ID, Open report (when the report index is loaded), a "Ledger actions" group (Change class, Set submission state, Move to Gadgets, Move to MapStore) and the Show-only filter shortcuts. Modules add items through `BoardUI.registerFindingActions(provider)`; the ledger module's own Actions button and menu were removed. Ledger items stay enabled when BBH lacks support; the dialog explains and its confirm button is disabled (same contract as the ledger branch).
2. **One sort system.** Header buttons and a new Sort menu in the filter bar both set `state.sort` (persisted in `bounty-board-finding-sort`). Keys: title, severity (rank EXCEPTIONAL > CRITICAL > HIGH > MEDIUM > LOW > INFO > N/A > UNKNOWN), class, status, `first_seen`, `last_seen`. Date sorts start newest first; findings without a date always sort last; ties keep ledger order. A sortable "First seen" column shows the date with "Last seen" underneath. (The redesign dossier said there was no date field; ledger entries do have `first_seen`/`last_seen`.)
3. **Date filter in the filter bar.** "First seen" is a multi-select like the others, with disjoint buckets: Last 7 days, 8 to 30 days, 31 to 90 days, Older than 90 days, No date recorded. The ledger branch's overlapping single select ("Last 30 days") is replaced; the last 30 days is two ticks. See open decision 9.
4. **Drag and drop.** Rows are draggable (except when the drag starts in a form control) onto the tabs marked `[data-drop-target]` (Gadgets, MapStore), using the redesign `.dragging-finding` / `.drop-active` styling. Dropping opens the same Move dialog as the menu; nothing is written until confirmed.
5. **Bulk reclassify** moved from an "Edit" link on the old chart rows into the expanded class row of the dashboard breakdown ("Reclassify", labelled "Review and reclassify <class> findings"), shown only when class writes are available. Not offered for the Unclassified group.
6. **By class / By category.** The Finding classes panel has a segmented toggle (persisted in `bounty-board-class-group`). Category rows (`data-category-row`) expand like the others and show the raw class next to each finding. Raw classes stay the filter and edit value.
7. **Add finding** is a button in the Findings ledger header.
8. **Severity options.** INFO is labelled "Informational (INFO)"; a disabled "N/A (not supported by BBH yet)" option is rendered by app.js (previously DOM-patched by the module).
9. **Navigation.** Search results, the coverage drill-down report links and module navigation all go through the app's `navigate()`: the URL hash and back/forward update, `laneGeneration` is bumped and filters reset on program/lane change, and a finding target uses the app's row highlight (`tr.highlight`, scrolled into view). The search module's separate highlight tracking was removed.
10. **Topbar search** is an inline field ("Search the workspace") styled like the redesign inputs. Pointer focus, typing, Enter or ArrowDown opens the palette (typed text seeds the query); Ctrl/Cmd+K opens it anywhere, including inside the editor. Keyboard focus alone does not open it, so Tab can move past it. Esc returns focus to the field.
11. **Report layout.** In the live view the editor and the artifacts panel share a grid: side by side when the report panel is at least 1020 px wide (container query; true at 1440x900 with the sidebar open), stacked otherwise. The artifacts column is sticky. Non-live views keep artifacts below the source/preview columns. The artifacts panel's "Reload list" wording (distinct from the global Refresh) is unchanged.
12. **Live editor and kept hosts.** The redesign keeps `#live-report-host` mounted across renders (detached and reinserted). The live editor now restores focus in that case too, which fixed the failing "session survives re-render" test.
13. **EasyMDE toolbar.** The preview pane rule is `.preview:not(button)`, so EasyMDE's preview button no longer stretches the toolbar; the live editor's local override was removed. Asserted in both the live (integrated test) and non-live (ui-redesign test) editors. `BUGFIXES.md` updated.
14. **Styling.** Ledger dialogs, search palette, live editor, artifacts and coverage drill-down CSS were rewritten against the redesign tokens (no hex or rgb values in module CSS). Fixed while doing so: the coverage drill-down widened the page on phones, secondary text in its table cells ran into the primary text, and a stray `<br>` left a gap above the report picker.

## Contract additions

- `ctx.navigate(target)` (module context): `{view?, program?, lane?, section?, report?, finding?}`; validates, returns `false` for an unknown program/lane/section, else navigates via the app.
- `BoardUI.registerFindingActions(provider)`: `provider(row, {program, lane})` returns menu items (`openMenu` item format).
- `BoardFindingView` is now only `{rebase}`; `BoardLedgerActions` exposes `openAddDialog`, `openClassReview` and the severity helpers.
- Finding rows: `draggable="true"` (set by the ledger module), `td.date` first-seen cell; dashboard class rows `data-class-name`, category rows `data-category-row`.

## Evidence

Suites below ran on code commit `7afabee`. The final commit adds this dossier and a one-class CSS change in `static/modules/search.js` (the palette's Esc hint gets `.kbd`); `search` and `integrated-workspace` were rerun after it (7/7 pass). Ghost, Node 22, Python 3.14, Playwright 1.60, Chrome headless, `TMPDIR=/home/ryushe/.hermes/cache/scratch/bb-agents/integrate`, synthetic fixtures only, `--test-concurrency=1`.

- `npm test` (23 files): **159 tests, 159 pass, 0 fail**. An earlier run on `c69319a` had 149/159; the 10 failures were caused by integration (the inline search field's label "Search programs, findings and reports" matched `getByLabel('Program')` and the dashboard's "Search programs" box; the topbar and the coverage drill-down overflowed a 375 px viewport). Fixed in `7afabee`; the six affected files then passed 80/80 and the full run above is clean.
- `python3 tests/safe_suite.py`: **258 run, OK, 1 skipped** (the excluded real-BBH metadata test, by design), 402 s.
- Broad browser suite (38 files: every `static/tests/*.test.cjs` except `collaboration.synthetic` and `collaboration-combined.synthetic`, skip pattern `^browser metadata update reaches backend with a disposable synthetic writer$`): **236 tests, 231 pass, 0 fail, 5 cancelled**. All 5 were in `backlog-retry.synthetic.test.cjs` (test timeouts of 15 to 30 s; its sixth test passed). Rerun alone: **6/6 pass**. Rerun with its neighbours (`app.test`, `backlog-reload`, `backlog-retry`): **49/49 pass**. Treated as a timing flake, not proven; the file uses collaboration mode, which this integration did not change.
- Focused browser tests (each file alone): live-editor **8/8** (includes the previously failing "two browser contexts ... session survives re-render" test), ui-redesign **7/7**, ledger-actions **6/6**, report-artifacts **2/2**, search **5/5**, taxonomy unit **5/5**, coverage-drilldown unit **8/8**, taxonomy-coverage **1/1**, integrated-workspace **2/2**.
- Python feature tests: `test_live_editing` 18 OK, `test_live_api` 7 OK, `test_ledger_actions` 18 OK, `test_report_artifacts` 25 OK, `test_search` 26 OK, `test_search_scale` 1 OK, `test_taxonomy` 6 OK.
- Real BBH e2e: `BBH_SNAPSHOT=<TMPDIR copy of board-bbh-browser.A1LilEDR/bbh with bounty_core extracted from board-bounty-core.tar> node tests/ledger_actions_bbh_e2e.cjs`: **PASS**, statuses `[/api/finding 200, /api/finding/submission 200, /api/finding/reclassify 200, /api/finding/reclassify 200, /api/finding/reclassify 409, /api/finding/new 200, /api/finding/new 409]`. Snapshot, synthetic root and HOME all under TMPDIR. The script was updated for the unified UI (Sort menu, `.finding-title`, `[data-drop-target]`).
- New end-to-end smoke test `static/tests/integrated-workspace.synthetic.test.cjs` (fixture `tests/integrated_workspace_fixture.py`: one server with `--live-edit`, the fake BBH writer from `test_ledger_actions`, report artifacts, MapStore and gadget entries, a coverage database, search index). Test 1: dashboard, inline search field opens the palette, finding result highlighted with the URL updated, row menu lists UI and ledger items, Change class writes the synthetic ledger, a sibling inline edit still succeeds (revision rebase), Open report from the row menu, EasyMDE toolbar under 60 px, artifacts listed beside the editor (sensitive badge on the HAR), live typing autosaves to the synthetic file, an outside write appears with "Updated outside the Board", Back returns to Findings; no page errors and no non-loopback requests. Test 2: dispatched drag shows `.dragging-finding` and `.drop-active` on the Gadgets tab, drop opens the Move preview without writing, dashboard Reclassify and the By category toggle.

## Test selection

`npm test` now runs 23 files: the 14 original files, live-editor, ui-redesign, ledger-actions, search, report-artifacts, taxonomy (unit), coverage-drilldown (unit), taxonomy-coverage and the new integrated-workspace test. All five files the agents left out were added; none was unsuitable (each starts its own disposable loopback fixture and runs in seconds to a minute). Still outside `npm test`, as before: the broader historical browser files (run in the broad suite) and the real-BBH e2e scripts, which need a BBH snapshot.

## Screenshots (synthetic data, 1440x900)

Captured with `node static/tests/tools/integrated-screenshots.cjs <dir>` into `/home/ryushe/.hermes/cache/scratch/bb-agents/integrate/screens/`:
`dashboard-{light,dark,dusk}.png` (xss class row expanded with Reclassify), `dashboard-categories-light.png`, `search-palette-{light,dark}.png`, `findings-row-menu-{light,dark}.png`, `move-to-gadgets-preview-{light,dark}.png`, `report-live-artifacts-{light,dark,dusk}.png`, `report-conflict-{light,dark}.png`, `coverage-drilldown-{light,dark}.png`.

## Gaps and limits

- "Open report" in the row menu appears only once the lane's report index has loaded (same rule as the redesign).
- Ledger menu items are always shown; unsupported actions explain themselves in the dialog rather than being hidden.
- First-seen buckets are relative to the browser clock at render time.
- Visible em dashes remain only in three pre-existing, test-bound recovery labels ("Unsaved draft — …", "Pending … — copy before leaving"); the redesign left them for the same reason.
- The search inline field is an entry point only; results always show in the palette.
- Inherited limits from the feature dossiers still apply (BBH has no N/A, no CLI to clear a submission result, artifacts list refreshes on report switch or Reload list only, search freshness lags up to 5 s, live editor has no presence, and so on).

## Open decisions for Ryu (collected)

From the integration:
1. First-seen filter buckets: keep disjoint buckets (multi-select) or switch to cumulative "Last N days" choices?
2. Show unsupported ledger actions as enabled items that explain themselves (current), or disable/hide them in the menu?
3. Should row drag start anywhere on the row (current, except form controls) or only from a drag handle?
4. Artifacts beside the editor from 1020 px panel width (current), or always below?

From the feature dossiers (unchanged):
5. UI: should "Open workspace" require an explicit program pick on first use? Default the dashboard to "Not submitted"? Are unrecognized submission states correctly counted as submitted?
6. Ledger: add `N/A` to BBH `normalize_severity` (between INFO and UNKNOWN) so the Board can write it; expose clearing a submission report reference; bulk class review stops at the first writer failure (acceptable?).
7. Artifacts: sensitive files out of "Download all" or included after a confirmation; 512 MiB zip cap and 64 KB text preview; show `_meta/_archive/_drafts` in a collapsed group?
8. Search: should MapStore entries and coverage questions be searchable?
9. Taxonomy: the six decisions in `taxonomy-cleanup-proposal.md` (compound labels, agent names as classes, P0, UNKNOWN backlog, placeholders, ranges); BBH writing a normalized class; a kind alias table.
10. Live editing: activation (service flags, `--live-edit` on the real service, Hoster move) and authenticated author identity remain operator decisions.
