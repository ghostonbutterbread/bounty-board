# Scope panel

- Status: implemented on `feat/board-scope-panel` (from `origin/beta` 6eaaca5, v1.5 with scope check and the Recon URL browser); not merged or deployed. Target `beta`.
- Owner: Bounty Board maintainers.
- Canonical path: `docs/integrations/scope-panel.md`.
- Code: `scope_inventory.py` (reader, caps, cache, HTTP handler) and `static/modules/scope-panel.{js,css}`. Small seams: `scope_check.py` (alias rule moved into `resolve_scope_dir()`, shared, behavior unchanged), `app.py` (service construction and one GET route, 6 lines), `static/app.js` (a `scope` section, its host element, and a `?query` on the scope route, about 12 lines), `static/index.html` (module tags).

## Intent

Ryu: "we want to be able to see when scope and apps update scope and to be able to track the inscope etc items", (a) track what the program lists in scope (apps, exes, source code) and show when that changes, (b) notice new app or exe releases so the binaries lane gets refreshed. The weekly re-pull is the agent's job ("have the agent update scope if the scope is a week old ... instead of having the board do so"); "read these yourself" became the program policy; "release changed is good enough for now".

So the Board shows, per program, what BBH `agents/scope_puller.py` last wrote, how old it is, and what changed. It never pulls, fetches or writes.

## Contract (BBH side)

BBH writes three files next to the existing ones in `<shared>/scopes/<program>/`: `scope-pull.json` (last pull state), `scope-items.json` (typed inventory) and `scope-history.jsonl` (append-only change log). Field definitions are in the task contract and are mirrored by `tests/scope_panel_fixture.py`. The Board also reads `in-scope.txt`, `out-of-scope.txt`, `program-policy.md` and the mtime of `assets.json`.

Board API: `GET /api/scope?family=&program=[&refresh=1]`, documented in `BACKEND_API.md` ("scope panel").

Commands the panel offers for copying (never run):

- `bbh agents/scope_puller.py '<program>' --if-older-than 7` (stale banner, no scope on file)
- `bbh agents/scope_puller.py --rebuild-inventory '<program>'` (no inventory yet)

## Route and UI

- Section `scope` in the program workspace: `#/programs/<program>/<lane>/scope[?kind=apps|executables|source|cloud|other&change=added|removed|changed|release&rules=all&policy=open]`. The tab is a real `<a href>`; filters are real links; the query survives reload, back and forward. Unknown keys and values fall back to defaults and are dropped from the URL (replace, no history entry). The section is per program, so every lane shows the same panel.
- Title badge after the program name on every program view: "Scope 34 d old" (warning at 7 days), "Scope today (est.)", "No scope on file" (muted) or "Scope unreadable"; it links to the Scope section. The program header was chosen over the Recon intel header because it is shown for every program and family, binaries included.
- Panel, following the approved mockup minus the third-party box: stale banner with the copyable re-pull command; header with the pull age, platform, rule and item counts, a failed last attempt with its error, and the no-inventory note; left column "Checked automatically" (in/out chips, 12 then "+N more" in place) and "Program policy" (safe Markdown, collapsed to 220 px with "Show the full policy"); right column "Other assets" (in/out pill, tier, identifier, kind, lane link or "no lane yet"), "Releases" and "Scope changes" (newest first, expandable diff).
- No scope directory: "No scope on file", open scope, pull command. Broken or escaping alias: "Scope cannot be read" with the reason. No inventory: rules from the text files and the policy side by side, with the backfill command.
- Refresh: quietly every 60 s while the section is shown and the tab is visible, and when the tab becomes visible again. A repaint happens only when the payload changed; open diffs, the policy scroll position and filters are kept.

## Decisions

- **Read-only, no network, no subprocess.** The Board reads files only. The re-pull is an agent action (Ryu's call); the Board shows the command.
- **Alias rule shared with scope check.** `resolve_scope_dir()` in `scope_check.py` is now used by both modules, so an alias is followed only inside `<root>/scopes`, and a broken or escaping link is `failed`, never open scope. The same holds for each file: a `program-policy.md` (or any other read file) that is a link resolving outside `<root>/scopes` is refused with a per-file error, so a synced link cannot surface a private local file in the Board.
- **Caps and per-file errors.** `scope-pull.json` 64 KiB, `scope-items.json` 4 MiB, rule files 1 MiB each, `program-policy.md` 256 KiB. A larger, unreadable or malformed file gives that file an error state shown next to its section; the rest renders. A malformed or oversized inventory falls back to the text-file rules. Items are capped at 5,000, rules sent at 1,000 per list (counts exact), diff lists at 200 per history line.
- **History tail.** Only the last 256 KiB of `scope-history.jsonl` is read (seek from the end, first partial line dropped), then the last 20 lines, newest first. A malformed line shows as "Unreadable line" and does not hide the others. `more` says older lines exist.
- **Cache by signature.** Parsed files per program, keyed by `(st_ino, size, mtime_ns, ctime_ns)` of every file and the directory (the `scope_check.py` approach, so a same-size atomic replacement is seen). Ages and lane times are computed per request from the cached parse, so the stale state moves with the clock without a reparse. LRU of 64 programs.
- **Freshness.** `pulled_at` from `scope-pull.json`; when absent or null (only a rebuild ran), the `assets.json` mtime, then the `in-scope.txt` mtime, labelled "estimated". Stale at 7 days or when no time is known. `last_attempt_status: failed` shows the error; other non-ok statuses (`skipped_fresh`, `skipped_backoff`) show as a quiet line.
- **Rules.** With an inventory: `enforced` items split by `in_scope`. Without one: the non-comment lines of the text files. Non-enforced web items are not shown as rules.
- **Lanes and releases.** Kind to lane: `android_app` to `apk`, `executable` to `exe`, `ios_app` to `ios` then `app`. Only lanes the Board discovers are linked; today `FAMILIES['binaries']` is `apk`, `exe`, `mac`, so iOS apps show "no lane yet" until an `ios`/`app` lane is added to discovery. Lane age is the newest mtime of the lane directory's top-level regular files (stat only, symlinks and subdirectories ignored, first 10,000 entries). "Lane may be stale" when `release.changed_at` is newer, or when the lane has no top-level files.
- **Unknown kinds** are listed under Other assets with their raw kind (filter "Other"), so a future kind is visible rather than dropped.
- **Display safety.** Every string goes through `recon_intel.text()` (control, bidi and invisible characters escaped; length caps). The policy is escaped per line so Markdown structure survives, then rendered with the Board's own Markdown subset (all HTML escaped, links and images stay text). Copy uses the Recon intel `shellQuote`/`isCopySafe`; `copy_safe: false` from the server (raw program name had unsafe characters) disables copy with the reason shown.

## Evidence (2026-11-25, dev machine, load average 6 to 7)

See "Final test runs" below for counts. Synthetic data only (`*.example.test`, `acme-demo`, `globex-demo`, `initech-demo`); no real `~/Shared` reads.

- `python3 -m unittest tests.test_scope_inventory`: 23 tests. Full inventory payload (unknown keys ignored); lane links, lane stale and its clearing by a newer lane file; top-level-only lane scan ignoring symlinks and subdirectories; symlinked lane not linked; text fallback; estimate from `assets.json` and from `in-scope.txt`; `pulled_at: null`; stale boundary at 7 days; no scope dir; alias inside followed, outside and broken refused; a file link outside `<root>/scopes` refused (content not in the payload), inside followed; malformed JSON, non-object, non-list items and bad items as per-file errors with text fallback; oversized policy and inventory refused per file; history order, 20-line cap, `more`, baseline, unreadable line; tail read bounded to 256 KiB (spied reads); unsafe characters escaped in the whole payload and the policy keeps newlines; unsafe program name gives `copy_safe: false`; signature cache hit, same-size same-mtime atomic replacement, append, new file and `refresh` invalidation; ages move with the clock without a reparse; cached parse not mutated; nothing written under the root; HTTP 200s, 403 for a foreign Host, 400s for bad parameters.
- `python3 -m unittest tests.test_scope_check`: 23 tests OK after the `resolve_scope_dir()` move.
- `static/tests/scope-panel.test.cjs`: 3 tests (query keys and validation, command quoting and refusal of ESC/CR/bidi/ZWSP, ages, kind filter, change summaries).
- `static/tests/scope-panel.synthetic.test.cjs`: 1 browser test. Tab and badge hrefs; tab click route; breadcrumb; freshness, failed attempt, stale banner and clipboard text; no em-dashes; 12 chips then "+2 more", `rules=all` in the hash, survives reload, "Show fewer"; policy heading and list rendered, no `img/script/a/iframe` in it, hostile text visible as text, `window.__pwned` unset, escaped bidi/ESC visible, collapsed height then `policy=open`; six assets, pills, tiers, apk/exe lane hrefs, iOS "no lane yet", unknown kind escaped; kind filter link and hash; unknown query keys and values dropped from the URL; release changed, one "Lane may be stale", unchanged with version, muted error; change log order, unreadable line, baseline, diff expand with added/removed/changed/release lines, change filter keeps open diffs; quiet refresh shows an appended history line without reload; light, dark and dusk screenshots; lane link navigates to `binaries/acme-demo/apk` and back; no-inventory state with backfill clipboard text; no-scope state with pull clipboard text and muted badge; phone layout without horizontal overflow; no page errors; no non-loopback requests.

Screenshots (synthetic) under `$TMPDIR/screens`: `scope-panel-light.png`, `scope-panel-dark.png`, `scope-panel-dusk.png`, `scope-panel-phone.png`, `scope-panel-no-inventory.png`, `scope-panel-no-scope.png` (regenerate with `SHOT_DIR=… node --test static/tests/scope-panel.synthetic.test.cjs`).

## Gaps

- Not run against real BBH `scope_puller.py` output (built in parallel) or real scopes; only the contract fixture. First real run: check one program with an inventory, one without, and one alias.
- iOS apps cannot link to a lane until discovery knows an `ios` or `app` binaries lane.
- The lane age is a heuristic (newest top-level file). A refresh that only writes into subdirectories leaves "Lane may be stale" on.
- The badge costs one `/api/scope` request per program view (cached client-side for 60 s; the server reparses only on file changes).
- The change log shows the last 20 lines; older lines are only named ("Older changes are in scope-history.jsonl").

## Decisions for Ryu

1. The badge sits next to the program title on every program view. Keep there, or also add it to the Recon intel header?
2. "Lane may be stale" uses the newest top-level file of the lane. Should a specific marker file (for example a BBH pull stamp) be used instead when BBH writes one?
3. Should iOS get a binaries lane (`ios`) in discovery so iOS apps link and get lane-stale checks?
4. Stale threshold is 7 days, matching `--if-older-than 7`. Adjust?

## Final test runs

2026-11-26, dev machine, load average 6 to 7.

- `python3 -m unittest tests.test_scope_inventory`: 23 OK. `python3 -m unittest tests.test_scope_check`: 23 OK.
- `python3 tests/safe_suite.py` was too slow on this box (about 100 tests in 10 min), so it was stopped and every `tests/test_*.py` module ran 4 at a time (`ls tests/test_*.py | xargs -P4`, real-BBH fixture test excluded as in `safe_suite.py`): 47 modules, 686 tests, 0 failures, 13 skipped. Three report modules use `multiprocessing` and error under that ad hoc runner (the children re-import the runner script); with `python3 -m unittest` alone, `test_report_retained_poll` 4 OK and `test_report_autosave` 12 OK; `test_report_retention_capacity` failed once and then passed twice (12 OK), and it has no scope code.
- `NODE_PATH=… CHROME_BIN=/opt/google/chrome/chrome node --test --test-concurrency=1 static/tests/scope-panel.test.cjs static/tests/scope-panel.synthetic.test.cjs`: 4/4 pass.
- `npm test -- --test-concurrency=1` (now includes both scope panel files): 231 tests, 228 pass, 3 fail. Two were caused by this branch: `mapstore-detail` asserted no non-tab links in `#app`, and the scope badge is a link. The assertion now excludes `[data-scope-badge]`, and the file passes alone (2/2). The third is `artifact-uploads` "upload button … cancel, precheck": a staged temp file was still present 1.5 s after a cancel. It failed again when its file ran alone, then passed by name. It is unrelated to this branch and is recorded in `BUGFIXES.md`.

## Review 1 (independent, 2b2fa77): ACCEPT, five minors fixed (Hermes)

1. A history line still being appended (no trailing newline) showed as the newest "Unreadable line". `read_tail` drops an unterminated last line.
2. A single history line longer than the tail window vanished ("No changes recorded yet"). It is now reported as one `line too long` entry.
3. `program` names starting with `_` or `.` (skipped by discovery) were turned into paths. `payload` refuses them as `not a discovered program`.
4. Binaries lanes were stat-scanned on every request. They are scanned only when an asset kind can link to a lane.
5. A `scope-history.jsonl` file error was hidden when there was no inventory. The no-inventory layout now renders it.

Tests: `tests.test_scope_inventory.ReviewOneTests` (findings 1-4) and a browser assertion on the globex no-inventory fixture, whose `scope-history.jsonl` is a directory (finding 5). With 2b2fa77's `scope_inventory.py` and `scope-panel.js` swapped in, all four Python tests and the browser test fail; on the fix `tests.test_scope_inventory` + `tests.test_scope_check` 50 OK and the scope-panel node and browser files 4/4.
