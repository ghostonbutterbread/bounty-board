# Report links and Recent reports

- Branch: `feat/board-report-links-recent` (worktree `bounty-board-links`), from `b8fb99d`. Not pushed, not merged, not activated.
- Request (Ryu): open reports in new tabs with a middle click, and see all reports newest to oldest, maybe on the dashboard.

## Intent

1. Everything that opens a report, finding or program is an ordinary link, so middle-click, Ctrl/Cmd+click, Shift+click and "Open link in new tab" work. A plain click still navigates inside the page with no reload.
2. A new tab opened on any of these links lands on the right place, also on a cold start with phased loading.
3. A "Recent reports" view (`#/recent`) and a dashboard panel list reports across all programs by file modification time.

## What changed

### Links (app.js, search.js, coverage-drilldown.js)

- `hrefFor(target)` (also `ctx.hrefFor` and `BoardUI.hrefFor`) builds the hash route from the `ctx.navigate` target shape. For a report it equals what `routeFor()` writes to the address bar, so link and URL are the same string.
- One document-level click handler turns plain left clicks on `a[href^="#/"]` into the app's `navigate()` (via `moduleNavigate`, so validation, filter reset and highlight apply). It ignores clicks a module already handled, modified clicks, non-primary buttons, links with a `target` and `download` links. Middle clicks fire no `click` event and stay native.
- Now links: the Reports section's new list, a "Report" link in each findings row, dashboard drill-down findings and reports, program table names, search palette results (main row link stretched over the row, plus "Open report"), coverage drill-down evidence references, every row in the Recent view and dashboard panel, the sidebar items (Dashboard, Recent reports, Programs, and the recently used programs) and the program workspace section tabs (Findings, Coverage, Reports, MapStore, Gadgets). The row menu stays a button.
- Sidebar and tabs (follow-up): same classes, `active` state, `aria-current="page"`, `aria-label` and `data-view`/`data-section` hooks as before; CSS selectors `.nav button` and `.tabs button` became `.nav a` and `.tabs :is(button,a)` plus `text-decoration:none`, so the look is unchanged (pixel comparison below). They never had `role="tab"`; they are a `<nav>` of links with `aria-current`, which is the right pattern for routes. Hrefs: Dashboard `#/dashboard`; Recent reports `#/recent?<current filters>`; Programs the current program route (`#/programs` before one is chosen); a tab its section route (the Reports tab keeps the open report); a recently used program its route on the current section. A plain left click keeps the old in-app handler (`preventDefault`, no reload, section and focus kept); modified clicks, middle click and the context menu are native. Because Recent filters change without a re-render, the sidebar hrefs are also refreshed on pointer over/down, focus and context menu. Enter on a focused link activates it; Space no longer does (normal link behaviour).
- Search palette: plain click and Enter unchanged. Ctrl/Cmd+Enter opens the active result in a new tab (Ctrl/Cmd+Shift+Enter: its report); the palette stays open. Mousedown `preventDefault` (keeps focus in the input) now applies only to the primary button.
- Reports section: keeps the fast `<select>` picker and adds "Reports in this lane": a collapsible (remembered), filterable list of links, newest first, with path, owning finding id, kind and modified time. Generated navigation is hidden behind "Show generated navigation (N)". The filter hides rows in place without a re-render; its text resets with the lane like the other filters.

### Routes and deep links

- Report ids are the report path relative to the lane's `reports/` folder (`api.js` `normalize`: `id = path`). That is stable across reloads and processes; nothing positional. Paths are `encodeURIComponent`-encoded in routes (slashes as `%2F`, spaces as `%20`).
- New routes: `#/recent[?filters]`; incoming `#/programs/<program>/<lane>/findings/<finding id>` highlights that row (the address bar then shows the section route, as before).
- Cold start: the initial-route path already opened report deep links correctly in both phases (lane index loaded lazily via `/api/lane-reports`, then the complete phase keeps the selection). A test now proves it with the complete phase delayed 4 s.
- Fixed silent fallbacks: a report requested by a link or route that is not in its lane now shows "Report not found in this lane: <path>..." with the lane's list, instead of quietly opening the first report. Reports picked in the UI that later disappear keep the old fallback. An unknown linked program or lane (cold load or in-page hash change) shows a dismissible notice naming it instead of silently switching.

### Recent reports

- Backend `GET /api/recent-reports` (contract in `BACKEND_API.md`), implemented as `SearchIndex.recent()` over the existing background index, which already holds every report's mtime, title, path, owners and kind, plus ledger severities. No new file walk, no new thread.
  - Filters: `within` seconds, repeatable `program`, `lane`, `q` (all terms in title or path), `order`, `nav`. Facets for programs and lanes, each ignoring its own filter. Bounded `limit` (200), `offset`, 100 programs, 200-character query; strict parsing; 400 on anything else; shares the search request slots (503 when busy). Goes through `do_GET`'s `trusted_request()` like every GET.
  - Freshness: a request finds the index at most 5 s old; an older index is refreshed once first (bounded 2 s wait). Recent requests do not keep the refresher passing every 5 s (searches still do), so a dashboard left open costs one incremental pass per poll.
- Lane report entries (`/api/data`, `/api/lane-reports`) gain `modified` (one `lstat` per file).
- Frontend module `static/modules/recent-reports.js|css`. Hooks in core files, each commented: nav button and module lines in `index.html`; `recentView()`, `#/recent` route, breadcrumb and `#dashboard-recent-host` in `app.js`; link styles in `style.css`.
  - View: time window (24 hours, 7 days, 30 days, All; default 7 days), searchable program multi-select with counts, lane, title/path filter (debounced), newest/oldest toggle, "Include generated navigation", "Refresh list", chips and Clear filters, 50 per page with Previous/Next. Columns: report title and path, program and family, lane, finding id and severity badge, modified time (relative using the server clock, absolute on hover). Window, sort, navigation, programs and lane are remembered per browser.
  - Filters in the URL (follow-up): `#/recent?within=7d&program=web_bounty%2Facme&program=...&lane=web&q=...&order=newest&nav=1&page=2`. `within` is `1d`, `7d`, `30d` or `all`; `program` repeats (up to 100); `page` is 1-based and omitted on page 1; `within` and `order` are always written, the rest only when set. Filter changes and debounced typing update the hash with `replaceState`; Previous/Next use `pushState`, so Back returns to the previous page. Opening a link with a query (also cold, in a new tab) restores exactly that view and wins over the per-browser memory; a plain `#/recent` uses the memory, and a first visit gets 7 days. Unknown keys are ignored; invalid values (window, order, lane, nav, page, programs not in the loaded data, control characters in `q`, over-long values) fall back to the defaults and the address bar is rewritten to the canonical form, with no toast and no rejected request. A page past the end lands on the last page and fixes the link. Values are read only through `URLSearchParams` and reach the page only through `ctx.esc`. `app.js` only stores and round-trips the query string (`state.recentQuery`, `parseRoute`, `routeFor`, `hrefFor({view:'recent', query})`); `recent-reports.js` owns the keys and validation. "Clear filters" returns to the 7-day default. The dashboard panel's "View all" links to `#/recent?within=7d&order=newest`.
  - Dashboard panel "Recently updated reports": latest 8 with program / lane, finding id, severity and time, plus "View all". It paints from cache and fetches only after the dashboard has rendered and the workspace's own complete load has settled (at most 4 s wait), so it never delays first paint.
  - Refresh: on opening the view (when older than 10 s), on "Refresh list", when the workspace data is reloaded (global Refresh, phase change), and every 30 s while the tab is visible (panel: when older than 30 s). Live edits and outside changes appear within those bounds. No SSE: the only event stream is per report (`/api/live/events`); a global one would be new server surface for little gain.

## Decisions made

- Reuse the search index rather than a new endpoint walk: one source of truth for mtimes and titles, already incremental and memory bounded, and about 1 ms per request on real data.
- Generated navigation stubs are excluded by default (5,049 of the 5,780 real report files are navigation), with a toggle in both the view and the Reports list. The real "every report" count is therefore 731 by default.
- Default window 7 days (Ryu: "7"), sorted newest first. Previously "All".
- Filters saved in the link (Ryu: "pls").
- Sidebar items and section tabs are links (Ryu: "pls do").
- Generated navigation stays hidden by default behind "Include generated navigation" (Ryu).
- Findings rows link to their report even before the lane's report index is loaded, using the ledger's relative `reports/...` path; if the file is gone, the not-found message explains it. Once the index is loaded, rows without a matching report show no link.

## Evidence

### Follow-up: URL filters, 7-day default, sidebar and tab links (commit 60f901b)

Same machine and settings; the other builder kept the load average between 10 and 23 throughout.

- `static/tests/report-links-recent.synthetic.test.cjs` now **7/7 pass** (3 new tests; the existing Recent test updated for the 7-day default, the View all link and Clear filters). New: (1) 7-day default on a first visit with the canonical hash `#/recent?within=7d&order=newest`; window, two programs, lane, typed text (6 keystrokes), order and navigation each update the hash with `history.length` unchanged; the sidebar href carries the view; a cold start in a new browser context with no storage restores every control and the rows; invalid values (`within=bogus`, unknown program, `lane=zzz`, `q=%00`, `order=sideways`, `nav=yes`, `page=-3`, unknown key) fall back to defaults with no page error and no 4xx; a hostile `q` stays inert in the input (no element injected, no script ran); a link wins over the remembered filters, and a plain `#/recent` uses them; middle-click on the sidebar item opens the same filtered view. (2) Paging with 64 reports: cold `page=2`, Previous/Next, Next pushes one history entry, Back returns to page 1, a filter change returns to page 1 with replaceState, `page=9` lands on page 2 and fixes the link. (3) Sidebar and tabs: hrefs for Dashboard, Recent reports, Programs and all five tabs; aria-current moves; plain click on a tab stays in-app with focus kept and the Reports tab keeping the open report; Enter on a focused tab; Ctrl+click and middle click on tabs, Ctrl+click on Dashboard and Programs, middle click on Recent reports and Ctrl+click on a recently used program each open a new page on the right view; plain clicks on sidebar items stay in-app with no reload and Back works; collapsed sidebar keeps the links.
- Look unchanged: sidebar nav and section tabs screenshotted on `b8d4c13` (clean `git archive`) and on this commit in 12 states (light and dark; idle, hover, keyboard focus, collapsed sidebar): **12 of 12 PNGs byte-identical**.
- `python3 -W error::ResourceWarning tests/safe_suite.py`: **298 run, OK, 1 skipped**, 1,445 s. (A first run beside `npm test` hit my own 30-minute `timeout` wrapper, exit 124, with no failure up to that point; rerun alone as above.)
- `npm test` (25 files): **166 tests, 164 pass, 2 fail**, 962 s. Both failures were timeouts and pass alone: `collaboration-recovery-blockers` "missing source: path-scoped local and pending recovery..." (7 s click wait on the Programs link; file alone **6/6**) and `ui-redesign` "multi-select filters, chips, persisted sort and row actions" (8 s wait for the row menu; file alone **7/7**, that test alone 3 more times **3/3**). Treated as load flakes, not proven. An earlier `npm test` run was cut off by the tool's 10-minute limit after 120 tests and found two selectors the bulk rename missed (`progressive-races` tab loop, `mapstore-detail` "no links in #app"), both fixed (files alone 16/16 and 2/2).
- `live-editor` "unknown Syncthing conflict copy can be reviewed and applied" failed in that cut-off run and once alone, passed in the full `npm test` above and alone later (8/8), and also failed on an unmodified `git archive` of `b8d4c13`. Logged in `BUGFIXES.md`; not caused by this change.
- Broad browser suite (39 files: every `static/tests/*.test.cjs` except `collaboration.synthetic` and `collaboration-combined.synthetic`, skip pattern `^browser metadata update reaches backend with a disposable synthetic writer$`), run once on `60f901b` at load average 15 to 25: **243 tests, 210 pass, 15 fail, 18 cancelled**, 3,155 s. All 33 were timeouts (test timeouts, "Timed out: server startup", 2 to 8 s locator waits) in 11 files. Each file rerun alone on the branch: backlog-reload 1/1, collaboration-frontend-fixes 20/20, collaboration-regressions 3/3, collaboration-undo 3/3, live-editor 8/8, review 17/17 pass; still failing alone: backlog-retry (2/6), board-65-real (0/1), capacity-recovery-real (3/8), collaboration-fast-path (4/5), report-save-ui (11/12). Compared with an unmodified `git archive` of `b8d4c13` at the same load: backlog-retry base 6/6, then 0/6 and 3/6 (branch 2/6 and 1/6 in the same pairs); capacity-recovery-real base 8/8, then 5/8 (branch 7/8 in the same pair); report-save-ui base 8/12; board-65-real base 0/1; collaboration-fast-path base 5/5 and branch 5/5 in the same pair. So those failures follow machine load, not this change; none was proven green on a quiet machine. The two that timed out on the Programs link click (`review`, `collaboration-recovery-blockers`) pass alone.
- Updated existing tests (intent kept): 39 test and tool files select the sidebar items and tabs by `link` instead of `button` role (mechanical); `progressive-races` likewise for its tab loop; `mapstore-detail` asserts no links in `#app` other than the section tabs.

### Initial build

Ghost, Node 22, Python 3.14, Playwright 1.60, Chrome headless, `TMPDIR=/home/ryushe/.hermes/cache/scratch/bb-agents/links`, synthetic fixtures only, `--test-concurrency=1`.

- New Python tests `tests/test_recent_reports.py`: **18 run, OK** (ordering, oldest first, navigation toggle, linked finding and severity, time windows, program/lane/text filters and facets, stable paging and tie order, symlinked file/dir/program and `_private` exclusion, change and delete visibility, stale-index refresh, refresher not kept busy, unavailable root; HTTP: filters, 22 invalid parameter cases plus limits, untrusted Origin/Sec-Fetch-Site/Host refused, 503 when slots are busy, lane `modified`, root unchanged). `tests/test_search.py` alongside: 27 OK (unchanged; the shared `_activate` refactor touches search).
- New browser tests `static/tests/report-links-recent.synthetic.test.cjs` (fixture `tests/report_links_fixture.py`): **4/4 pass**. Covers list hrefs and order, navigation toggle, plain click in-app without reload, Ctrl+click, middle click and Shift+click opening new pages on the exact report, list filter, picker; cold deep link with the complete phase delayed 4 s (report open in under 3.5 s, kept after "Reports loaded"), finding deep link highlight, missing report message, unknown program notice (cold and in-page); findings row, drill-down, program table, search palette links (Ctrl+click, Ctrl+Enter, plain click); Recent view order, windows, program multi-select, chips, lane, text, sort, navigation, links, Back, reload, dashboard panel after the summary phase, 375 px fit. Added to `npm test`.
- `python3 -W error::ResourceWarning tests/safe_suite.py` on `b5679b6`: **297 run, OK, 1 skipped** (the excluded real-BBH test, by design), 793 s.
- `npm test` (24 files) on `b5679b6`: **163 tests, 162 pass, 1 fail**. The failure was caused by this branch: `drafts.synthetic` "real EasyMDE saves a browser draft across reload" uses `getByLabel('Lane')`, which also matched the new list's labels "Filter reports in this lane" and "Reports in this lane". Fixed by renaming them ("Filter report list by name, path or finding", "Report links"); drafts plus the new file then passed **5/5**.
- `npm test` rerun on the fixed tree: **163 tests, 162 pass, 1 fail**: `collaboration-recovery-blockers` "discovered Unicode and spaced program binds collaborative editor" timed out waiting 7 s for a response (load average about 18 at the time). It passed in the first `npm test` and in the broad suite; rerun alone twice: **6/6 and 6/6**. Treated as a load flake, not proven.
- Broad browser suite (39 files: every `static/tests/*.test.cjs` except `collaboration.synthetic` and `collaboration-combined.synthetic`, skip pattern `^browser metadata update reaches backend with a disposable synthetic writer$`), run once on `b5679b6`: **240 tests, 239 pass, 1 fail**, the same `drafts.synthetic` label collision fixed above. Not rerun in full after the fix.
- Updated existing tests (markup changed, intent kept): `ui-redesign` drill-down uses `getByRole('link')` instead of `button` (2 places); `taxonomy-coverage` additionally asserts the evidence ref `href`.

### Real data (read-only, counts only)

`SearchIndex` on `~/Shared`, measured directly (no server started), median of 20 calls:

| Measure | Result |
| --- | --- |
| Programs / lanes / report files | 73 / 79 / 5,780 (5,049 generated navigation, 731 other) |
| Programs with non-navigation reports | 35 |
| Index cold build | 63 s with a cold disk cache (machine under load); 1.6 to 2.2 s with a warm cache (the complete `/api/data` phase reads every report, so the cache is normally warm) |
| Incremental refresh pass | 0.12 to 0.30 s |
| Default page (50, newest, no navigation) | 1.0 ms (max 2.6), 41 KB JSON |
| Dashboard panel (8) | 1.2 ms, 9.7 KB |
| With navigation (5,780 total) | 5.8 ms; 200 per page: 6.4 ms, 109 KB |
| 7 days / 24 hours windows | 0.7 ms (54 matches) / 0.6 ms (12) |
| Text filter, 5 programs + lane, last page oldest first | 0.6 to 1.4 ms |
| Extra `lstat` for `modified` | under 100 ms for 11,272 files (upper bound; the complete phase already reads each report) |

### Screenshots (synthetic, 1440x900 unless noted)

`node static/tests/tools/report-links-screenshots.cjs $TMPDIR/screens` wrote to `/home/ryushe/.hermes/cache/scratch/bb-agents/links/screens/`: `recent-light.png`, `recent-dark.png`, `recent-program-filter-dark.png`, `dashboard-light.png`, `dashboard-recent-panel-light.png`, `dashboard-recent-panel-dark.png`, `reports-link-list-light.png`, `reports-link-list-dark.png` (full page), `reports-missing-light.png`, `findings-report-links-light.png`, `recent-phone-light.png` (375 px), and from the follow-up `recent-url-filters-light.png` (a filtered link opened cold), `nav-tab-links-light.png`, `nav-tab-links-dark.png` (hovered sidebar link, keyboard-focused tab) and `nav-collapsed-dark.png`. Checked by eye; fixed a 375 px overflow of the Recent view and overlapping phone nav labels found that way.

## Gaps and limits

- The Recent list lags edits by up to 5 s (index interval) plus the 30 s poll while open; reopening or "Refresh list" is immediate within 5 s.
- While the index builds (first request after start), the view and panel say so and retry every second; results may be partial and out of order until it finishes (cold disk: up to about a minute on real data).
- Titles come from the first heading in the first 40 lines; reports past the index's content budget use the file name.
- The free-text filter is in the link but not in the per-browser memory (as before).
- A link naming a program that is not in the loaded data drops that program (it cannot be told apart from a typo); refresh the board and reopen the link if the program is new.
- Space does not activate the sidebar items and tabs any more (they are links; Enter does).
- The Reports list shows file names (the lane index has no headings); the Recent view shows headings.
- A program or lane created after the page loaded appears in Recent but its links show "not in the loaded data, refresh" until the board is refreshed.

## Decisions for Ryu

Answered on 2026-11-24 and built in the follow-up: navigation hidden by default (kept), default window 7 days, filters in the `#/recent` link, sidebar items and section tabs as links. Still open: dashboard panel placement (first in the grid, current, or below the breakdowns).
