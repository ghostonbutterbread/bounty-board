# Scope check in Recon intel

- Status: implemented on `feat/board-scope-check` (from `origin/beta` 88651b0, v1.4 with Recon intel); not merged or deployed. Target `beta`.
- Owner: Bounty Board maintainers.
- Canonical path: `docs/integrations/scope-check.md`.
- Code: `scope_check.py` (checker, cache, payload helpers). Small seams: `recon_intel.py` (keeps the URL index host list, a `scope` worker job, scope fields in `overview()`/`program()`/`host_rows()`), `app.py` (4 lines: builds `ScopeChecker(root, --bbh)`), `static/modules/recon-intel.{js,css}` (hash key `oos`, pills, hidden-count lines, copy gating, header badge, overview column, dashboard ranking).

## Intent

Ryu: "bounty board can show oos urls i would love to make it so that our program when showing the urls they have been scope checked pls idk if that means recchecking before showing. or what. pls think of efficiency when you make a plan", then "yup hide them default then we can show oos with a filter" and "I like filtering oos on ingest and the failover is if no scope preent try to pull, if cant pull then run without scope (some programs have openscope)".

BBH now filters at ingest (parallel builder), but old index rows remain, scopes change and open-scope programs run without a scope file. So the Board checks what it shows, at display time, cheaply.

## Contract (BBH side)

    <bbh> agents/scope_validator.py classify <program> --scopes-base <root>/scopes --json

argv only, stdin `{"targets": [...]}` (hosts or full http(s) URLs, max 50,000), stdout one JSON object `{version: 1, program, scope_dir, scope_state: loaded|empty|missing, signature, entries, exclusions, results: [{target, state: in|out|partial|unchecked, rule, reason}]}`, one result per target in order with `target` echoed. URLs are always `in`/`out`; a bare host is `partial` when its verdict depends on the path. Non-zero exit only for usage/I/O errors. Read-only, no network. The Board runs it through the existing `--bbh` launcher (same as `agents/manual_hunter.py`) and tests against a fake (`tests/scope_check_fixture.py`) with variants that fail, time out, print bad JSON or return the wrong count.

Board API additions: see `BACKEND_API.md` ("Scope" paragraph under `GET /api/recon/*`).

## Decisions

- **Check hosts, not rows.** The largest index has ~1.8M URLs but ~1,380 hosts, which Recon intel already enumerates by skip-scan. The checker classifies the host list plus the URLs of displayed items only (capped lists: 50 recent tests, 50 observations, up to 200 hunt-next params, JS lists). No query was added to SQLite.
- **Cache keyed by a stat-only signature.** Per program: `(resolved scope dir, dir inode/size/mtime/ctime, inode/size/mtime_ns/ctime_ns of in-scope.txt, out-of-scope.txt, excluded.txt, rules-of-engagement.json)`. Inode and ctime catch a same-size replacement that keeps the source mtime (sync tools, atomic rename; review 1, finding 2). Same signature: verdicts reused, a new host costs a delta-only call. Changed signature: that program's verdicts are dropped and all targets reclassified. LRU of 128 programs, 60,000 verdicts each.
- **Requests never run BBH.** `lookup()` is cache-only. Missing targets are queued as one `scope` job per program on the existing Recon intel worker (program view jumps the queue, overview jobs go last); the job makes at most one subprocess call. While it is queued the payload is `partial` and the UI keeps polling, so verdicts appear within a poll or two.
- **Failure is never "in scope".** No `--bbh`, a non-zero exit, timeout (10 s), invalid JSON, contract mismatch or wrong count: every target is `unchecked` with `scope check failed: <why>`, logged once per program and signature to stderr, retried after 60 s (or on Refresh), so a broken BBH does not cause a retry on every 1.5 s poll.
- **No scope on file = open scope.** A missing `<root>/scopes/<program>` (or BBH reporting `empty`/`missing`) gives `no_scope`: rows shown, copy enabled, muted "No scope on file" badge, no pill per row. No subprocess is started for a missing dir, even without `--bbh`.
- **Alias links.** `scopes/a -> a_corp` is followed only when it resolves inside `<root>/scopes`; outside or broken links (and invalid names) mean a scope exists but cannot be read: the program is `failed` with that reason, copy is disabled, and BBH is not called (BBH would follow the link). Only a scope dir that is genuinely absent, or empty, is open scope (review 1, finding 1).
- **`unconfigured` blocks copy.** A Board without `--bbh` cannot check scope, so for programs that do have a scope dir, rows are shown, marked "Scope not checked", and copy is disabled ("scope not checked"), as the spec lists "no --bbh" with the failures. `--bbh` was already the BBH launcher; using it for this read-only call does not enable metadata writes (those still need the existing checks).
- **Extra summary state `pending`.** Not in the original list; needed for the first second before a classify pass returns. Rows are `unchecked` ("scope check pending") and copy is blocked meanwhile.
- **UI.** Hash key `oos=1` (anything else hides). Every list hides `out` rows and shows "N out-of-scope hosts hidden · Show" (a real `<a href>` with `oos=1`; while shown, "… shown · Hide"). Shown OOS rows are muted with an `OOS` pill whose tooltip is the reason; `partial` hosts get "Partly in scope" with reason and rule. Copy buttons on `out` rows show "out of scope", on unchecked rows of a checked program "scope not checked", using the existing disabled-with-reason pattern (control characters still win). Header: scope badge ("Scope checked 2m ago", "No scope on file", "Checking scope…", "Scope check failed" plus a note with the reason), tiles "In-scope hosts M of K" and "In-scope URLs" summed from per-host counts of `in`/`partial` hosts (≈ when any host count is a sample estimate). Overview: "In scope" column (`M / K`, `open`, `…` or a warning icon).
- **Ranking without OOS surface.** Server: out-of-scope hosts are never `under_tested` and sort after in-scope hosts under the 300-row cap. Dashboard card and overview ranks use `in_scope_urls`/`in_scope_js_files`: exact per-host sums when a program view already cached per-host counts, otherwise the total scaled by the in-scope host share, marked ≈ (`method: host_share`). This is the simplest option with no overview query; it is coarse when one excluded host holds most URLs (the synthetic globex: ≈130 by share, 33 exact). Programs not `checked` fall back to raw totals.
- **Display safety.** Rules and reasons from BBH pass through `recon_intel.text()` (control/bidi escaped, 240 chars).
- **Read-only.** Nothing is written under `--root` or next to any database; tests snapshot the tree.

## Evidence (2026-11-25, dev machine, 6 cores, load average 7 to 10)

- `python3 -m unittest tests.test_scope_check`: 21 tests OK. Checker: classify then cache hit with zero further calls; URLs decided exactly; delta-only call (4 then 2 targets); scope file edit and new `excluded.txt` trigger full reclassify; alias inside allowed, outside and broken refused without a call; missing and empty scope give `no_scope`; fail/bad JSON/wrong count/timeout give `failed` with the reason and no retry storm, then recover; no `--bbh` gives `unconfigured`; failure logged once; hostile rule text escaped; nothing written under root; 2,000 hosts under 1 s. Service: payload fields on host rows, URL items and JS lists, cached results not mutated, zero calls on cached requests; at most one call per program per pass, none for an open-scope program; overview host-share vs host-count figures; refresh reclassifies; failed check not partial forever; recon reads leave the tree unchanged; a 2,000-host index adds under 1 s to the background compute versus no checker.
- `python3 -m unittest tests.test_recon_intel`: 36 tests OK (unchanged behavior without scope).
- `static/tests/recon-intel.test.cjs`: 7 tests pass (new: `oos` parsing, hiding, copy gating, in-scope ranking). `static/tests/recon-intel.synthetic.test.cjs`: 1 browser test passes, extended with: in-scope column, open-scope badge with copyable rows, OOS host and params hidden with count lines, Show link `href`, OOS pill and tooltip, disabled copy with "out of scope", partial pill and tooltip, `oos=1` across reload, unknown `oos` value hides, phone layout with OOS rows has no overflow, dashboard ranking by host share and then by exact in-scope counts, no page errors, no non-loopback requests.
- Cost: fake BBH (Python start included) classifies 2,000 hosts in 0.07 s in one call; a cached lookup of 2,000 hosts takes 0.4 ms.
- Full suites (after 2e01510): `python3 tests/safe_suite.py` 579 tests OK (13 skipped) in 20 min; `npm test -- --test-concurrency=1` 208 tests, 207 pass, 1 fail (`ui-redesign` "multi-select filters, chips, persisted sort and row actions": menu item timeout, the same known flake under load); rerunning that file alone gave 7/7 pass.

Screenshots (synthetic): `scope-program-light.png`, `scope-program-dark.png`, `scope-program-phone.png`, `scope-dashboard-card.png` plus the regenerated `recon-*.png` under `$TMPDIR/screens` (`SHOT_DIR=… node --test static/tests/recon-intel.synthetic.test.cjs`).

## Gaps

- Not run against the real BBH `classify` (built in parallel) or real `~/Shared` scopes; only the contract fake. First real run: check timing on the largest program and that the `--bbh` launcher resolves `agents/scope_validator.py`.
- Hunt-next parameters keep one example URL each. When that example is out of scope the parameter stays listed (it is a program lead): the example URL is hidden (`Example URL out of scope`, or shown muted with an OOS pill under `oos=1`), its URL/curl copies are disabled with "example out of scope", and `bbh next` stays usable because BBH applies scope itself (review 1, finding 4). Picking an in-scope example would need extra queries per key.
- The coverage matrix and the lane/skill breakdown are aggregates and are not split by scope.
- Escaped (unsafe) and truncated (over 600 characters) URLs are classified by their display text; copy is blocked for unsafe ones anyway.
- Host-share estimates in the overview are coarse until a program view caches per-host counts.
- Findings and MapStore pills are a later phase (out of scope here).

## Decisions for Ryu

1. Without `--bbh`, programs with a scope dir show rows as "Scope not checked" with copy disabled. Keep, or allow copy when unconfigured?
2. Should the overview compute per-host counts for exact in-scope figures (more background work per program), or is host share fine?
3. Retry interval for a failing BBH is 60 s; adjust?
4. Should hunt-next pick an in-scope example URL per parameter (extra per-key queries)? Today the parameter stays listed and only its out-of-scope example is hidden.

## Review 1 (independent, 867e203): ACCEPT, fixes

- Finding 1 (should-fix): broken or escaping scope alias was treated as open scope with copy enabled. Now `failed`, copy disabled. Test: `test_alias_inside_allowed_outside_refused`, `test_missing_scope_is_no_scope_without_subprocess` (invalid name).
- Finding 2 (should-fix): same-size, same-mtime replacement served stale verdicts. Signature adds inode and ctime. Test: `test_same_size_same_mtime_replacement_reclassifies`.
- Finding 3 (minor): host-share estimate dropped the source's approximate marker. Test: `OverviewShareApproximation`.
- Finding 4 (minor): hunt-next hid a parameter when its example URL was out of scope. Now only the example is hidden. Tests: `paramBlocks` unit cases in `static/tests/recon-intel.test.cjs`, browser assertions in `recon-intel.synthetic.test.cjs`.
- Each new Python test and the node unit test fail with 867e203's `scope_check.py`/`recon-intel.js` swapped in and pass on the fix. `python3 -m unittest tests.test_scope_check` 23 OK; `node --test --test-concurrency=1 static/tests/recon-intel.test.cjs static/tests/recon-intel.synthetic.test.cjs` 8/8 pass.
