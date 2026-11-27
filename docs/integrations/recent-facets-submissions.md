# Recent facets and Submissions

- Branch: `feat/board-recent-facets` (worktree `bounty-board-facets`), from `69ee73d` (origin/beta, deployed). Not pushed, not merged, not activated.
- Request (Ryu, Discord): filter Recent by vulnerability class, severity and submission state with Bugcrowd-style checkboxes, a Class column in the table, "submitted/unsubmitted/duplicate" filters to see what still needs submitting and to rank by severity or class, and a Submissions tab on the left.
- Design follow-up (Ryu, verbatim): "we can just have dropdowns"; "then the recent is meant to show the recent were wokring on then the new submissions are the already submitted reports ... unless you think its redundant"; "and undr submissions i think it makes more sense to list it like with the recents".

## Intent

1. Every Recent row says which vulnerability class it is, and Recent can be narrowed and ranked by submission state, severity, class, time, program and lane.
2. The filters are a row of dropdowns along the top, each a checkbox list with counts that say what checking an option would give.
3. A Submissions view lists the reports already submitted (awaiting a result, valid, duplicate), as the same rows as Recent.
4. A pill edit never makes a row vanish under the cursor.

## Contract (server, commit `4ea667d`)

Full text in `BACKEND_API.md` (`GET /api/recent-reports`, "Facet filters").

- New repeatable parameters `severity`, `class`, `submission` (facet keys), `lane` repeatable (one value still accepted), `order` adds `severity` and `class`. OR within a facet, AND across facets. Strict parsing: unknown values, too many repeats or blanks give `400 invalid_recent_reports`.
- `facets` adds `severities`, `classes`, `submissions` as `[{key, label, count}]`, each ignoring its own filter; `programs` and `lanes` facets honour the new filters; `na_hidden` and `na_hidden_page` follow every filter and order.
- Items: `finding.class = {raw, category, subclass, label, subclass_label}`, `finding.severity_key`, and `submission_key` on every item (`none` when unmapped).
- Keys are computed once per ledger change in `SearchIndex._scan_lane` (cached with the ledger signature), with a per-lane `by_fid` map, so a request does no normalization.

### One mapping, two sides

- Python: `finding_facets.py` (`submission_key`, `severity_key`, `class_info`, `class_key`, option lists and class order).
- JS: `BoardFilterBar.keys` in `static/modules/filter-bar.js`. The browser uses it to decide, right after a pill edit, whether a row still matches its list.
- Shared cases: `static/tests/facet-cases.json` (34 cases, including the server `item.finding` shape), run by `tests/test_finding_facets.py` and `static/tests/filter-bar.test.cjs`; the JS test also checks that the option labels match the Python ones.
- Submission bucket: a `valid` or `duplicate` result wins; else the state (nested `submission.state`, falling back to the legacy top-level `submission_status`) trimmed and lowercased: missing, empty, `not submitted`, `none`, `draft`, `unsubmitted` and `not_submitted` give `not_submitted`; `submitted` and `dropped` map to themselves; anything else (for example `raw`) is `other`; no mapped finding is `none`.

## Design (frontend)

### Filter bar (`static/modules/filter-bar.js|css`)

- One dropdown button per facet along the top of the list, in this order: Submission, Severity, Class, Modified, Program, Lane, Options; then the title/path search box, the Sort select and Refresh list in the same toolbar, wrapping onto more lines when narrow.
- A button shows its name and a short summary ("Severity: High, Critical"; "Class: 3" when more than two values or longer than 24 characters; "Modified: All"; "Options: N/A shown"), with a tinted pressed look when it differs from the default. `aria-haspopup`, `aria-expanded`, and an `aria-label` that includes the summary.
- Its popover is the existing filter popover (`BoardUI.openPopover`, `.filter-popover`, `.menu .option`, `.count`, `.menu-foot`), the same look as the Findings filters and the old Recent program picker it replaces. Real checkboxes (radios for Modified), each "label · count" (the count is read as part of the label), Clear and Done. Class and Program get a filter box. Zero counts are muted; a checked option is never hidden (also not by the filter box).
- Checking applies at once and keeps the popover open (counts and the button update in place). One popover at a time. Esc closes and returns focus to the button; an outside click closes it, and if nothing focusable was clicked focus returns to the button. Arrow keys (and Home/End) move through the filter box and options; Tab is trapped inside. At 375 px the popover is clamped inside the viewport.
- Active selections show as chips under the bar (existing `.chips`/`.chip`), with "Clear all". Clear all resets the filters and the search text, not the sort.

### Recent (`#/recent`) and Submissions (`#/submissions`): one list, two instances

`recent-reports.js` now builds its view through `createList(cfg)`. The two instances share every line of loading, rendering, URL handling, pills, N/A, context menu, links and paging; only the config differs.

| | Recent | Submissions |
| --- | --- | --- |
| Host / route | `#recent-reports-host`, `#/recent` | `#submissions-host`, `#/submissions` |
| Submission options | Not submitted, Submitted (awaiting result), Valid, Duplicate, Dropped, Other, No linked finding | Awaiting result, Valid, Duplicate; none checked means all three |
| Fixed server filter | none | `submission=submitted&submission=valid&submission=duplicate` when nothing is checked |
| Severity / Class "No linked finding" | yes | no (every submission has a finding) |
| Default window / sort | 7 days / Newest first | All / Newest first |
| Memory key | `bounty-board-recent-reports` | `bounty-board-submissions` |
| Empty state (default filters) | No reports match these filters. | No submitted reports yet |

- Rows are the Recent rows for both: one row per finding packet, report title and path, the new Class column, program and family, lane, finding ID with severity and submission pills, modified time, N/A. Same context menu and links.
- Class column (right after Report): the normalized category label, the subclass on its own muted line under it (not shown for the generic "Other" subclass), the raw `class_name` in the tooltip ("Recorded class: idor"). "Unclassified" (muted) when the class is empty or unknown; "No finding" (muted) when the report maps to no finding.
- Sort select: Newest first, Oldest first, Severity (highest first, ties newest), Class (A to Z, Unclassified then no finding last, ties by severity then newest). Server-side, so paging stays right.
- Narrow results column (container query on the panel, not the viewport): at 1080 px or less the Lane column folds away (the program cell still names it via the route); at 860 px or less each row becomes a two-column card (title, class, program on the left; finding pills, time, N/A on the right); at 520 px or less the pills move to their own line.
- URL keys, as before plus: `sub`, `sev`, `class` and `lane` repeat; `order=newest|oldest|severity|class`. Canonical order `within, sub, sev, class, program, lane, q, order, nav, na, page`. `within` and `order` are always written, so the canonical links stay `#/recent?within=7d&order=newest` and `#/submissions?within=all&order=newest`. Filter changes replace the URL, paging pushes; a link with a query wins over memory; invalid values are dropped and the link is rewritten; class values are checked once the taxonomy rules are loaded (the list waits for them, at most 3 s).
- Dashboard panel "Recently updated reports": the subline adds the class label (`orchard / web · F002 · Broken Access Control`, raw class in the tooltip). "View all" is unchanged.
- `app.js` only gains the Submissions route, `submissionsRoute`, the breadcrumb "Submissions", `pageTitle()` "Submissions · Bounty Board", the sidebar `href` sync and a page frame with `#submissions-host`. Sidebar link "Submissions" (`fa-paper-plane-o`, `data-view="submissions"`) sits between Recent reports and Recon intel.

### "No longer matches"

When a pill edit makes a row stop matching its list (marking a Recent row Submitted while filtering Not submitted; changing a Submissions row's severity while filtering by severity), the row stays where it is, dimmed (opacity 0.55, 0.85 on hover or focus) with a warning-coloured "No longer matches" note, and the status line says how many rows are kept. The check runs in the browser against the edited finding with `BoardFilterBar.keys`, so it is immediate. When the next fetch (the 30 s quiet poll, a workspace reload, an N/A change) no longer returns the row, it is re-inserted at its previous position, flagged as kept. A filter change, a sort change, paging or "Refresh list" starts clean. Facet counts come from the server, so they follow the edit on the next fetch.

## What was dropped from the first design

- The left filter rail (`filter-rail.js|css`) with collapsible groups, "Show N more" and the narrow-column drawer: replaced by the dropdown bar (Ryu: "we can just have dropdowns").
- The finding-row Submissions view (`submissions.js|css`: one row per finding, client-side facets over the workspace data, Report and Finding status facets, Include archived, bulk bar), the extraction of the `drill()` row renderer into a shared `findingRowHtml`, the `ctx` exports and completeness helper it needed, the kept-host change in `render()`, and the `BoardFindingActions.refresh()` hook in `finding-actions.js`. None of it is in the branch: `finding-actions.js` is unchanged and `app.js` carries only the route.
- The server side was kept as designed.

## Decisions made

- Submissions = reports whose finding is submitted (awaiting a result), valid or duplicate. Dropped findings are not submissions; Recent's Submission dropdown still has Dropped. Not redundant with Recent: Recent is "what changed lately" (7 days by default, every state), Submissions is "what is out there", all time.
- Newest in Submissions sorts by the packet's newest file, like Recent: `submission.submitted_at` exists on 1 of 345 real findings, so there is no submission-date sort.
- Counts are server facets for both lists; Submissions' severity, class, program and lane counts are therefore counts of submitted reports.
- Program and Lane list every loaded program or lane (zero counts muted), programs sorted by count then name, like the old program picker. Class lists the categories present in the window, plus checked ones.
- Options (Hide N/A, Include generated and _meta files) are not chips; the button summary says when they differ from the default.
- Clear all keeps the sort; the old "Clear filters" did the same.
- The JS mapping prefers the browser row's `class` field and falls back to `class_name`; the server reads `class_name`. They agree in every shared case.
- A Submissions row whose finding has a Valid or Duplicate result stays a submission when its state is set back to Not submitted: BBH cannot clear a recorded result, and the result wins in the mapping.

## Evidence

Ghost, Python 3.14, Node 22, Playwright 1.60, Chrome headless, `TMPDIR=/tmp/bbfacets`, synthetic fixtures only, `--test-concurrency=1`.

Load average about 12 throughout.

- Python, `python3 -W error::ResourceWarning -m unittest tests.test_recent_reports tests.test_report_na tests.test_search tests.test_taxonomy tests.test_finding_facets`: **104 run, OK**. New: `tests/test_finding_facets.py` (4: the 32 shared cases, every expected key is an option, class labels, class order) and 8 in `tests/test_recent_reports.py` (`FacetIndexTests`: default order unchanged, OR within and AND across filters including `none` and repeatable lanes, facets ignoring their own filter with zero counts and selected classes, severity and class orders with stable paging, item fields, `na_hidden`/`na_hidden_page` under facet filters and orders, normalized once per ledger change; `FacetAPITests`: filters over HTTP and strict parsing with caps). Existing test updated: `test_finding_payload` now expects the additive `class` and `severity_key` fields and `submission_key`.
- Red on `69ee73d` (only `search_index.py` and `app.py` swapped back, plus `finding_facets.py` removed): `tests.test_recent_reports` **40 run, 4 failures and 5 errors** (every new facet test and the updated payload test; the default-order test passes on the base, as it should); `tests.test_finding_facets` errors on import. Green after.
- JS shared mapping, `node --test static/tests/filter-bar.test.cjs`: **5/5**; red with `filter-bar.js` removed (the base has none): 0/1 (load error).
- Browser, each file run alone, serially (`node --test --test-concurrency=1`, `NODE_PATH=$PWD/node_modules CHROME_BIN=/opt/google/chrome/chrome`):
  - `recent-facets.synthetic` (new, 4): **4/4**. Red on the base `recent-reports.js` (with this branch's `filter-bar.js`): **0/4**.
  - `recent-actions.synthetic`: **9/9**. `report-links-recent.synthetic`: **7/7**. `finding-actions.synthetic`: **13/13**. `dashboard-coverage.synthetic`: **2/2**. `ui-redesign.synthetic`: **7/7**. `evidence-artifacts.synthetic`: **4/4**.
- Existing tests edited for the dropdown bar (intent kept, selectors only):
  - `report-links-recent.synthetic`: window buttons (`[data-recent-window]` click / `aria-pressed`) become the Modified dropdown (`check`, button text); the program popover (`[data-recent-programs]`, "Search programs to filter", `.recent-program-list`) becomes the Program dropdown ("Filter Program options", `.facet-popover`); "Remove program filter X" becomes "Remove filter Program X"; `#recent-lane` select becomes the Lane dropdown; the `[data-recent-order]` toggle becomes `#recent-order` `selectOption`; "Include generated and _meta files" is checked inside the Options dropdown; cold-link assertions read the button summaries, `#recent-order` and `[data-facet-chip="program"]`.
  - `recent-actions.synthetic`: the `_meta` toggle and `#recent-hide-na` are used through the Options dropdown; `isChecked` on `#recent-hide-na` becomes the Options summary ("Options" / "Options: N/A shown").
  - `evidence-artifacts.synthetic`: `#recent-nav` is checked inside the Options dropdown.
  - `tools/report-links-screenshots.cjs`: same selector change for its program-filter shot.

## Review round 1 (independent review of `d546895`: BLOCK, one blocker, one minor)

| Finding | Fix | Red on `d546895` (only the source file swapped back) | Test (green on the fix) |
| --- | --- | --- | --- |
| R1 (blocker): a row whose finding is not in the loaded workspace (cold start, summary mode, cold links) is a copy of the server's `item.finding`, where `class` is an object; `BoardFilterBar.keys` read it as unclassified, so under a Class filter those rows showed "No longer matches" and `carryKept` could resurrect rows the server stopped returning. | `bd3e312`: `classInfo` (JS) and `finding_facets.class_info` (Python) bucket the object's `raw` class, so both sides and both row sources agree. Severity and submission were checked: the server copy carries the raw `severity`, `submission` and `submission_status`, which map the same as `severity_key`/`submission_key` (now pinned by shared cases); no change needed. Two server-shaped cases added to `static/tests/facet-cases.json` (34 cases). | `filter-bar.js`: `filter-bar.test.cjs` 4/6 (the shared cases and the R1 test fail). `finding_facets.py`: `test_finding_facets` fails on the server-shape case. Browser: `recent-facets.synthetic` "R1: cold-start rows…" fails (stale rows found). | `filter-bar.test.cjs` "R1: a row built from item.finding keeps the server class key"; `recent-facets.synthetic` "R1: cold-start rows are not falsely …" (stubs `BoardFindingActions.entry` to return null, opens `#/recent?within=all&class=xss`, expects no stale rows and no "no longer match" status); shared cases in both runners. |
| R2 (minor): a class seen only in hidden N/A reports was listed in `facets.classes` with 0. | `bd3e312`: `present.add` moved after the hidden-N/A check in `SearchIndex.recent`. | `search_index.py`: `test_hidden_na_class_not_listed` fails. | `tests/test_recent_reports.py` `FacetIndexTests.test_hidden_na_class_not_listed` (also checks the class is listed when N/A is not hidden). |
| Polish (screenshots): the subclass ran on inline after the category and wrapped mid-phrase. | `bd3e312`: subclass on its own muted line under the category (title-over-path rhythm); raw class still in the tooltip. | n/a | `recent-facets.synthetic` Class column assertion (`Broken Access Control\nIDOR / object-level`). |

Evidence for round 1 (load average 15 to 17; each file alone, serial, `TMPDIR=/tmp/bbfacets`, `NODE_PATH=$PWD/node_modules CHROME_BIN=/opt/google/chrome/chrome`):

- `python3 -W error::ResourceWarning -m unittest tests.test_recent_reports tests.test_finding_facets`: **46 run, OK** (41 + 5; was 44).
- `node --test static/tests/filter-bar.test.cjs`: **6/6**.
- `recent-facets.synthetic`: **5/5** (one new). `recent-actions.synthetic`: **9/9**. `report-links-recent.synthetic`: **7/7**.
- Red runs were done in a scratch copy of the tree with only the named source file taken from `d546895`: `search_index.py` → R2 test fails; `filter-bar.js` → `filter-bar.test.cjs` 4/6 and the R1 browser test 0/1; `finding_facets.py` → `test_finding_facets` 1 failure (the server-shape case).
- Screenshots regenerated in `/tmp/bbfacets/screens/` (all 14, including `submissions-*.png` and `recent-filtered-light.png`); checked by eye: the subclass sits under the category.

## Review round 2 (narrow re-review of `db3a6c6`: ACCEPT)

R1 and R2 confirmed fixed (reviewer repros pass). Live keyboard check: one popover at a time, Esc and outside click return focus, `aria-expanded`, arrows/Home/End, Space applies and keeps the popover open; no sideways scroll at 375, 1024, 1280, 1440 on Recent and Submissions; popovers stay inside the viewport.

| Finding | Fix | Red on `db3a6c6` | Test |
| --- | --- | --- | --- |
| N1 (minor, pre-existing since the old Recent program picker): `trapTab` in `openPopover` only stopped Tab from closing the popover, so Tab past the last control moved focus behind the still-open popover (a toast's Dismiss, or out of the page). Also affected the Recon popovers that pass `trapTab`. | `openPopover`: with `trapTab`, Tab on the last focusable control wraps to the first and Shift+Tab on the first wraps to the last; focus outside the popover is pulled back in. The "Tab is trapped inside" line above is now true. | `static/app.js` swapped back: the N1 test fails ("Tab: focus left the popover"). | `recent-facets.synthetic` "N1: Tab and Shift+Tab stay inside an open facet popover" (12 presses each way, then Esc returns focus to the button). File **6/6**. |

## Fix round 2: intermittent `recent-actions` failures

**Cause.** A saved N/A mark (`report-na.js`) or a pill save (`finding-actions.js`) calls `ctx.render()` in the same task as the save. That rebuilds every Recent list host and drops focus to `<body>`. Focus came back only on a later animation frame (`report-na.js`'s `requestAnimationFrame` restore, the pickers' refocus callbacks). A 10 ms poll saw `<body>` at the moment the toggle flipped, on this branch and on `69ee73d` alike. Under machine load that frame is late, and this branch's heavier list mount (dropdown bar, chips, facet model) made the gap longer. So `recent-actions` assertions that check focus right after the change ("focus stays on the toggle") could land in the gap. The layout-stability and writer-off failures seen on the merged tree were not reproduced here (the branch alone passed 5 of 5 before the fix at load ~20); the identical-markup skip below removes the repaint churn they pointed to.

**Fix (`a1a0985`).** `recent-reports.js` remembers the last focused control inside any Recent list (view, Submissions, dashboard panel, Recon list) by row identity (program, lane, path) plus a control selector, or by control id outside rows. It puts focus back in the same task when the list remounts, so there is no window where focus is on `<body>`. A click on empty space clears the memory, so a later render does not pull focus back. Repaints of results, status and the panels compare markup and leave identical content alone, so quiet refreshes and polls no longer replace the DOM or move layout when nothing changed. The kept-row and in-place behaviour is unchanged.

**Evidence** (serial, `TMPDIR=/tmp/bbfacets`, `NODE_PATH=$PWD/node_modules CHROME_BIN=/opt/google/chrome/chrome`):

- Probe (scratch, not committed): with `requestAnimationFrame` delayed 0 or 400 ms, focus sampled at the moment "Unmark N/A" flips was `<body>` on `f4ec8af` and on `69ee73d`, and the toggle after the fix.
- New regression test `recent-actions.synthetic` "N/A save and pill save never drop focus, with a late frame and a delayed refresh". Setup: a 400 ms late animation frame and `/api/recent-reports` delayed 1.5 s after the save, with focus sampled every 10 ms through the N/A save and a keyboard Severity pill save. It **fails on `f4ec8af`** ("focus stayed on the toggle"; only `recent-reports.js` swapped back) and **passes on `a1a0985`**.
- `recent-actions.synthetic`, interleaved with the base under the same load (the base runs its own copy of the file, 9 tests; the branch has 10):

| Run | Branch `a1a0985` | Load | Base `69ee73d` | Load |
| --- | --- | --- | --- | --- |
| 1 | 10/10 | 24.6 | 9/9 | 28.5 |
| 2 | 10/10 | 21.1 | 9/9 | 22.4 |
| 3 | 10/10 | 18.6 | 9/9 | 21.6 |
| 4 | 10/10 | 24.5 | 9/9 | 23.5 |
| 5 | 10/10 | 19.3 | 9/9 | 19.3 |

- After the fix, once each: `report-links-recent` **7/7**, `dashboard-coverage` **2/2**, `finding-actions` **13/13**, `recent-facets` **6/6**.
  - `recent-facets` first went 5/6. Its "No longer matches" test checked the stale row's resting opacity right after the pill save. It had relied on focus being lost: focus now stays on the row's pill, which lifts the dimming through `:focus-within`. The test now blurs before measuring (`8d1ad7c`); intent unchanged.

## Screenshots

`NODE_PATH=$PWD/node_modules CHROME_BIN=/opt/google/chrome/chrome node static/tests/tools/recent-facets-screenshots.cjs $TMPDIR/screens` (fixture `tests/recent_actions_fixture.py`, read-only) wrote to `/tmp/bbfacets/screens/`:

- `recent-bar-light.png`, `recent-bar-dark.png`: Recent with the bar, 1440 px.
- `recent-class-open-light.png`: the Class dropdown open with counts and its filter box.
- `recent-filtered-light.png`: Severity High+Medium, Class 2, sorted by severity: pressed buttons, chips, Class column.
- `recent-1024-open-light.png` (Submission open), `recent-1280-open-dark.png` (Program open), `recent-375-open-light.png` (Program open, inside the viewport), `recent-375-light.png` (full page, cards).
- `submissions-light.png`, `submissions-dark.png`: Submissions default; `submissions-duplicate-light.png`, `submissions-dusk.png`: filtered to Duplicate.
- `dashboard-panel-light.png`, `dashboard-panel-dark.png`: the dashboard panel subline with the class.

Checked by eye. Fixed that way: the result table overflowing sideways at 1024 px (now cards below 860 px of results width), the count's screen-reader comma showing in the count pill, and a transient load toast covering rows in the shots (hidden in the script only).

## Gaps and limits

- Kept rows live in the loaded page: a kept row is not carried to another page. They also persist when he leaves the view and comes back in the same tab (until a filter change or Refresh list); a reload of the browser tab starts clean.
- Facet counts and totals do not include kept rows; the status line counts them separately.
- `finding-actions.js` still re-renders the page after a pill save (existing behaviour); the Recent list repaints from its cache, so the row updates without a new fetch, but it is not a single-row DOM patch.
- The phone sidebar (top strip) now has one more link and scrolls sideways a little sooner, as it already did for Recon intel and Programs.
- Class values in a link are checked against the taxonomy rules; if the rules fail to load within 3 s, class values from links are dropped.
- Not rerun after this change: the full `npm test` and `tests/safe_suite.py` (only the Recent-related suites below).

## Decisions for Ryu

1. Submissions shows only reports (one per finding packet). A submitted finding without a report packet (in the fixture, an EXCEPTIONAL duplicate with no report file) does not appear. Should Submissions also list such findings, as a row without a report link?
2. Default window for Submissions is All and for Recent 7 days. OK, or should Submissions remember the last window he picked across both views?
3. Recent's default shows every submission state. Should it default to hiding Dropped (or to Not submitted), now that Submissions covers the submitted ones?
