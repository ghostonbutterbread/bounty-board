# Recon intel

- Status: implemented on `feat/board-recon-intel` (from v1.1, 52f1b48); not merged or deployed.
- Owner: Bounty Board maintainers.
- Canonical path: `docs/integrations/recon-intel.md`.
- Code: `recon_intel.py`, `static/modules/recon-intel.{js,css}`; small seams in `app.py` (two GET routes, two flags), `static/app.js` (`#/recon` route) and `static/index.html` (sidebar link, module tags).

## Intent

Ryu asked to pull in the JS store and the URL index "so I can see the immediate coverage, what we've looked for, and what we have the most JS and such for … a better idea of the depth we've gone and what more we should hunt for". The view answers four questions per program, read-only:

1. **How deep is the surface?** URLs, unique routes, hosts, parameters; JS files, bytes, source maps, JS observations and leads; recon aggregate line counts; findings, coverage questions and MapStore entries for context.
2. **Where is the surface?** A host table merging URL index counts, JS files/bytes, test runs, findings and coverage reviews, sortable, with under-tested hosts highlighted.
3. **What has been looked for?** Test runs from the URL index as a lane × test-family matrix (hover: statuses, skills, last run), a lane/skill/family/status breakdown with 24 h / 7 d / all counts, recent test runs and observations with evidence links.
4. **What to hunt next?** Parameters whose lane hints (ssrf, open-redirect, lfi, xss, idor, …) have no test run in that lane; hosts with surface or JS but no tests; JS observations with an open next action and JS leads. Each item offers copy buttons (URL, curl, `bbh agents/url_ingest.py next|status …`); nothing is executed or fetched.

## Contract

- Route `#/recon` (sidebar link "Recon intel", a real `<a href>`). Hash keys: `p` (`web_bounty/<program>`), `lane`, overview `sort`/`dir`/`q`, program `hsort`/`hdir`/`hq`/`under=1`/`hint=<lane>`. Unknown values fall back to defaults.
- Dashboard card `#dashboard-recon-host`, inserted by the module after the recent reports panel (no dashboard template change): totals across web programs and the five programs with the most surface per test run, linking into the view.
- API: `GET /api/recon/overview`, `GET /api/recon/program?family=&program=&lane=[&refresh=1]`, documented in `BACKEND_API.md`. Each source (`url_index`, `js`, `aggregates`, `board`) carries its own state and error code (`missing`, `locked`, `timeout`, `schema_mismatch`, `unavailable`, `invalid`); counts are `{value, approximate, method}`; responses carry `computed_at` and `partial`.
- Flags: `--artifact-root PATH` (default `/mnt/bounty` when it is a mount point, else none), `--recon-query-budget SECONDS` (default 3, 0.1–120).
- Empty states name the producer: no URL index → `bbh agents/url_ingest.py ingest <program> --source <urls.txt>` or `aggregate <program>` with the expected path; no JS library → whether the artifact root is unconfigured/unreadable on this host and every path tried; no test runs → the `url_ingest.py mark` command.

## Decisions

- **Separate module, minimal shared edits.** Everything lives in `recon_intel.py` and the module pair; `app.py` gains ~25 lines (service construction, route dispatch, flags), `app.js` ~17 lines mirroring the existing `#/recent` plumbing. The dashboard card injects itself, so the dashboard template (touched by other branches) is unchanged.
- **Never scan big tables.** Measured on this machine (loaded, cold cache): `SELECT COUNT(*) FROM urls` on the largest index (2.2 GB, 1.32M rows) took 57 s and `COUNT(DISTINCT route_hash)` did not finish in 4 min, while `MAX(id)` took 13 ms and a 1000-row rowid window ~0.2 s. So:
  - table sizes: exact `COUNT(*)` only when `MAX(id) ≤ 200,000`; else `MAX(id)` (approximate, `method: max_id`);
  - hosts and parameter keys: bounded index skip-scans (`WHERE col > ? ORDER BY col LIMIT 1`, one seek per distinct value, up to 5000), exact unless the budget stops them;
  - per-host URLs, routes and parameterised URLs on big tables: 48 evenly spaced rowid windows of 500 rows, scaled to the total (`sample_scaled`), then each enumerated host gets a capped index count (`LIMIT 2001`) so small hosts are exact; routes per host are a sample lower bound;
  - test runs, observations and the JS library are small (≤ hundreds / ~7.4k rows) and aggregated exactly;
  - hunt-next parameters: one bounded lookup per distinct key (first 200 rows for a hinted row, capped count to 1000+).
- **Time budget.** Every statement runs under a deadline enforced by a progress handler and a watchdog calling `interrupt()`. The watchdog is needed: `COUNT(*)` is a single VDBE opcode, so a progress handler alone never fires during it (observed: the first version overran by minutes). A timed-out statement falls back to an estimate or records a section error; it never fails the source.
- **Background worker and cache.** One thread computes; requests never touch SQLite. Cache entries are per source, keyed by `(size, mtime_ns)` of the database and its `-wal`; a changed source is served as stale and recomputed at most every 120 s (agents write constantly), or immediately on Refresh (`refresh=1`). Program requests jump the queue. The overview computes headline numbers only (no sampling); host tables and detail lists only when a program is opened. Memory is bounded by an LRU of 512 entries and capped lists.
- **Read-only and path-safe.** `file:…?mode=ro`, `PRAGMA query_only=1`, busy timeout 1 s (no `immutable=1`, which would hide committed WAL data). Lanes come only from discovery (`discover(..., inventory_only=True)`); no request parameter becomes a path. Every component under the lane or artifact root is checked for symlinks (and `-wal`/`-shm`/`-journal`); the program directory on the artifact tier may be a symlink only when it resolves inside the artifact root. JS `downloads/`, `chunks/`, `sourcemaps/` and the library `ledger.json` are never opened.
- **JS library location.** Artifact tier first, then the lane under the Board root (some Shared lanes have a `_library`). The UI badges which one was read.
- **Under-tested rule** (server-side, stated in the UI): a host with ≥ 50 URLs or ≥ 3 JS files and either no test runs/bounded reviews or fewer than one per 200 URLs.
- **Findings per host** use the raw ledger's `asset`/`url`/`endpoint` host (most findings carry `asset`); archived findings are excluded and counted separately.
- **Target data.** Hosts/URLs are escaped; external links are http(s) only, `target="_blank" rel="noopener noreferrer"`; the browser test aborts any non-loopback request and asserts none happened. Copy commands are shell-quoted.

## Evidence

Synthetic tests (all data fictional, `*.example.test`):

- `tests/test_recon_intel.py` (22 tests): exact small index; 300k-row generated index proving estimates, skip-scan host counts, sample scaling (±20 %) and a bounded run time under a 0.5 s budget; interrupt of a runaway statement; locked database (`BEGIN EXCLUSIVE` writer) → `locked`; WAL reader sees committed rows; schema drift (missing columns → `schema_mismatch`, missing optional tables → section errors); non-database → `invalid`; JS summary, signals, open observations, JS schema drift; line counts exact/capped; symlinked aggregate, URL index and artifact program dir (outside refused, inside followed); missing artifact root with expected paths; background compute, cache hit, signature invalidation, refresh interval and explicit refresh; large index partial-then-cached through the service; HTTP trust/parameter checks; flags.
- `static/tests/recon-intel.test.cjs` (5 tests): hash query round-trip/validation, sorting with unknowns last, formatting, shell quoting, http(s)-only links.
- `static/tests/recon-intel.synthetic.test.cjs` (1 browser test): dashboard card, sidebar link and breadcrumb, overview sorting/filter/hash, program sections, under-tested highlight and filter, matrix, evidence links inside vs outside the lane, external link attributes, hunt-next items, lane-hint filter, clipboard contents of `bbh next` and curl, JS section, deep link with filters across reload, empty states, phone layout without horizontal overflow, no page errors, no non-loopback requests.

Real data, read-only from the dev machine (`~/Shared`, no `/mnt/bounty`); counts and timings only — see the table below.

### Measurements (2026-11-24, dev machine, 6 cores, load average 5–13, `~/Shared` read-only)

| What | Result |
| --- | --- |
| Discovered web lanes / URL indexes / Shared JS libraries | 61 / 43 ready + 18 missing / 6 ready + 55 missing (no artifact root here) |
| Overview: first response (inventory discovery) | 0.97 s, `partial: true` |
| Overview: all headline sources computed (first run, mostly cold) | 68.6 s in the background; per URL index median 0.20 s; 10 rows approximate |
| Overview: cached response | 0.031 s |
| Largest index by rows (2.1 GB, ≈1.83M URLs, 1380 hosts): program view first response / detail computed (cold) / Board cache hit | 0.001 s (partial) / 8.1 s / 0.005 s |
| Same, with a warm OS page cache (Board cache bypassed) | 0.22–0.24 s, no timeouts, 1380 host rows |
| Largest index by bytes (2.2 GB, ≈1.32M URLs): headline / detail, cold | 3.4 s / 14.4 s |
| Same, warm OS cache | 0.09–0.12 s |
| Exact `COUNT(*)` on that table, cold (why sampling exists) | 57 s; `COUNT(DISTINCT route_hash)` > 240 s (aborted) |
| Largest Shared-lane `js_info.sqlite` (70 MB, 543 files) | 1.1 s |

The first cold run hit one `host_tests` timeout: SQLite drove the test_runs↔urls join from the huge urls host index. A `CROSS JOIN` pinning the small table as the outer loop fixed it (rerun: no section errors). The OS page cache could not be dropped without root, so "cold" figures are first-touch runs in this session.

Screenshots (synthetic): `recon-overview-light.png`, `recon-program-light.png`, `recon-program-dark.png`, `recon-program-phone.png`, `recon-overview-phone.png`, `recon-dashboard-card.png` under `$TMPDIR/screens` (regenerate with `SHOT_DIR=… node --test static/tests/recon-intel.synthetic.test.cjs`).

## Gaps

- **Artifact tier untested on real data here**: the dev machine has no `/mnt/bounty`; JS numbers above come from the few Shared-lane libraries. On Hoster, start the Board with the default (mounted) or `--artifact-root /mnt/bounty` and check the largest `js_info.sqlite` (~160 MB) timing.
- `leads` and `metadata` tables in `js_info.sqlite` are read when present, but no current BBH code creates them; their columns follow the task description, not BBH source.
- Estimates on big indexes: `MAX(id)` overstates after deletions; route counts are sample-scaled (rough when routes are skewed); routes per host are a sample lower bound; parameters URL counts are scaled. All are marked ≈.
- Recency uses ISO text comparison of `completed_at` (BBH writes `isoformat()` UTC); mixed offsets would skew 24 h / 7 d counts slightly.
- No per-route drill-down or route-level "most JS but no tests" (JS provenance `page_url` is not joined); hosts are the unit.
- `api` lanes are included when they have the same stores; binaries lanes are out of scope.
- The 60 s background refresh and 1.5 s partial polling run only while the view is visible; the dashboard card polls only while partial.

## Decisions for Ryu

1. Keep "Recon intel" as its own sidebar view plus the dashboard card (implemented), or fold the card higher/lower on the dashboard?
2. Under-tested thresholds (50 URLs / 3 JS files / 1 test per 200 URLs) are a first guess; adjust once you have looked at real programs.
3. Should Hoster get an explicit `--artifact-root /mnt/bounty` in its unit file (the default already picks it when mounted)?
4. Worth asking BBH to run `ANALYZE` on URL indexes? `sqlite_stat1` would give cheap, better distinct estimates for routes.
