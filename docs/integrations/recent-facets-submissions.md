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
- Shared cases: `static/tests/facet-cases.json` (32 cases), run by `tests/test_finding_facets.py` and `static/tests/filter-bar.test.cjs`; the JS test also checks that the option labels match the Python ones.
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
- Class column (right after Report): the normalized category label, the subclass muted after it (not shown for the generic "Other" subclass), the raw `class_name` in the tooltip ("Recorded class: idor"). "Unclassified" (muted) when the class is empty or unknown; "No finding" (muted) when the report maps to no finding.
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
