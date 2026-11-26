# Global search (feat/board-search)

Status: implemented on `feat/board-search`, base `e9246db`. Read-only; nothing in the data root is written.

## Intent
Fast search across programs, findings and reports, with direct navigation, and a clear link from each finding to its report (and from a report back to its owning finding).

## Contract
### `GET /api/search?q=&limit=&program=&kind=`
- Same `trusted_request` rules as other GETs (Host, Origin, Sec-Fetch-Site).
- `q`: up to 200 chars, no NUL. Empty `q` is valid: it returns no results and only reports `index_state` (used as a warm-up that starts the index).
- `limit`: 1..50 per group (default 8). `program`: `family/name` or bare name. `kind`: comma list of `program,finding,report`, no duplicates.
- Duplicate or unknown params, bad UTF-8 and bad values give `400 invalid_search`. Four concurrent searches max, else `503 search_busy` with `Retry-After`.
- Response: `{query, index_state: building|partial|ready, root_instance, limit, counts, results:{programs,findings,reports}, warnings, took_ms}`.
- Every result has `target` (`program` id, `lane`, `section`, plus `finding` or `report`). Findings carry `report: {path, title, kind: report|evidence, target}` or `null` (`kind: evidence` links the finding's evidence file, title `Evidence`, when it has no indexed report; the palette labels it "Open evidence"). Evidence files are never report hits and do not count toward `report_count` (feat/board-evidence-artifacts). Reports carry `owner_fids`, `report_kind`, `snippet` (plain text) and `snippet_ranges` / `title_ranges` (offsets for highlighting).
- All terms must match (AND). Terms match fid/title/class/severity/status for findings, path/title/full text for reports, name/id for programs.
- Ranking: exact > prefix > word-prefix > substring per field; title and path beat content; whole-query title bonus; severity tiebreak for findings; recency (60 day decay) and "owned by a finding" bonus for reports.
- Generated navigation stubs are not searchable.

### Index (`search_index.py`)
- Created per server, started lazily by the first search request. One daemon thread refreshes every 5 s while searches are recent, and sleeps after 60 s idle.
- Incremental: a lane's ledger is parsed only when its (mtime, size, inode) changes; a report is re-read only when its signature changes. Reads use `read_file` (no symlinks) and `ledger()`.
- Each lane snapshot is replaced atomically, so searches never wait for a refresh. Only refreshes share a lock.
- Bounds: 60,000 chars indexed per report, 24M chars total, 60,000 reports. When a bound is hit the report stays searchable by title/path and `index_state` becomes `partial`.
- Dropped and rebuilt when the root instance (canonical path + dev/inode) changes, including mid-pass.
- Finding to report ownership repeats the `reports()` rule (`report_path`, resolved against the lane). It is a small separate helper so `reports()` is untouched; if that rule changes, update `SearchIndex._ownership`. Evidence classification is not repeated: both import `report_evidence.is_evidence`, and the index keeps evidence by path only (lstat, no read, no budget).

### Frontend (`static/modules/search.js`, `search.css`)
- `#global-search-host` in the topbar holds a trigger button; Ctrl/Cmd+K opens the palette (capture phase, so it also works inside the editor).
- Debounce 120 ms, abort of stale requests, retry while the index is building. Up/Down/Home+Ctrl/End+Ctrl/Enter/Shift+Enter (open a finding's report)/Esc. Single-control modal; Tab is held in the input.
- Results are built with DOM nodes and `textContent`; highlights are `<mark>` nodes from server ranges. Report text never reaches `innerHTML`.
- Empty query shows recent searches (localStorage `bounty-board-recent-searches`, 8 max, clearable) and a jump-to-program list.
- Finding result: navigates to the program/lane findings list, highlights the row (`tr.search-hit`, no focus move) and shows a notice with "Open report". Report result: opens Reports on it and offers "Show finding" for the owner.
- Esc and selection restore focus to the prior element if it still exists, else `#main`. The module never moves focus in `afterRender`.

### app.js changes (small, commented)
- `ctx.navigate({view, program, lane, section, report, finding})`: mirrors `data-open-program` and selector handlers (laneGeneration bump, filter reset on program/lane change). Returns `false` for an unknown program/lane/section.
- Finding rows carry `data-finding-id`.
- `index.html`: `#global-search-host` and the module css/js lines.

## Evidence
- `python3 -m unittest tests.test_search`: 26 tests, OK (ranking, snippet/control-char handling, incremental reindex reading only the changed file, ledger change/deleted files, symlinks, caps, root change, unavailable root, invalid ledger, search not blocked by a slow refresh, param validation, untrusted requests, concurrency with `/api/data`, no mtime changes in the root).
- `python3 -m unittest tests.test_search_scale` (synthetic 50 programs x 200 reports = 10,000 reports, 13.7M chars): cold build 3.7 s, no-change pass about 280 ms, warm queries median 20 to 28 ms (max 34 ms). Worst case, a query matching every report ("lorem ipsum dolor", 10,000 hits), about 137 ms.
- Real tree, read-only, nice/ionice idle, counts only: 5,775 reports, 79 lanes, 5.1M chars; cold build 30.9 s (cold sync tree), no-change pass 126 ms, queries 8 to 14 ms; state `partial` (a lane ledger or report could not be read; not investigated). Nothing from it is recorded here.
- `static/tests/search.synthetic.test.cjs`: 4 browser tests, pass (keyboard flow to finding and Open report; report selection and Show finding; inert snippet markup, Esc focus restore, editor text intact after open/close, recents, program jump; screenshot).
- `npm test` (now includes the search test): 115 of 115 pass (run before the search test was added to the script; the search test was run separately).
- `python3 tests/safe_suite.py`: 207 run, 1 skipped by design, 1 failure: `test_collaboration_process...test_source_read_is_serialized_across_two_servers`, a timing test that failed while six agents shared the CPUs and passes when run alone (8 s). It does not touch search.
- Screenshot: `docs/integrations/search-palette.png` (synthetic data).

## Gaps and limits
- The topbar control is a button that opens the palette, not an inline text box.
- Freshness lags by up to one refresh interval (5 s) after a file change.
- No fuzzy/typo matching; no search over MapStore, gadgets or coverage rows.
- The cold index on a large cloud-synced tree took about 31 s in the real-tree check; first queries show "index is still building" until then.
- A match-everything query is the slowest case (about 137 ms synthetic).
- The finding highlight lasts 20 s or until the user leaves that lane/section.

## Follow-ups / decisions for Ryu
- Should MapStore entries and coverage questions be searchable too?
- Should the UI redesign replace the trigger with an inline input?
- The UI agent also adds `#global-search-host`; on merge keep a single host and the module `<link>`/`<script>` lines.
