# Dashboard warning summary + progressive loading integration

## Loader correction handoff

Parent reports warning-summary-only already independently reviewed, integrated/pushed and deployed read-only at beta `5670cfe581082039fbbaf573928d0d807efa8140`. This branch has **not** been merged or rebased onto it; parent will reconcile the duplicated warning work. Parent owns independent review of the loader corrections and subsequent integration decision. The exact tested implementation checkpoint is recorded in a following dossier-only commit.

- Apply identity checks now have a per-attempt generation and view generation. Only the latest check against the same summary and load generation can apply; navigation makes a pending result inapplicable but reoffers Apply, and refresh supersedes it. The identity check remains point-in-time, not a filesystem lock.
- Partial and failed-summary MapStore/gadget observations carry the exact root-instance token. The server checks it before and after the lazy read and returns `409 root_changed` without body on observed mismatch. Ordinary unbound observations and all write-mode routes retain their old contract. Reports and collaboration actions remain unavailable in the read-only partial projection. This is not a guarantee against ABA changes, same-inode edits, symlink races, or changes after the final check.
- A failed complete scan marks reports unavailable independently of empty lane arrays; a successful full scan can establish zero. Warning UI remains retained and tested.

Synthetic-only receipts in `/home/ryushe/.hermes/cache/scratch/board-review-1795290467/`: nonroot Docker `--network none`, read-only code and tool mounts, executable `/runboard` tmpfs and isolated container `/tmp`/`/dev/shm`, loopback positive and off-host `101` negative preflight. No real Shared, live API, remote, active runtime or service used. Red-to-green tests reproduced empty 500 showing `0`, both out-of-order Apply deliveries, and mixed-root MapStore/gadget; HTTP checks cover identity before/after reads. Focused final Chromium/HTTP browser selection: **20/20** (`copy-focused-final-v2.log`); npm selection **80/80** (`fix-npm.log`); Python `tests/safe_suite.py` **148 run, 1 skipped, no failures** (`fix-python.log`), excluding the exact real-BBH metadata test. Broader browser selection: **161/161** across three disjoint shards of 25 files (`copy-broad-{0,1,2}.log`), excluding `collaboration.synthetic.test.cjs`, `collaboration-combined.synthetic.test.cjs`, and filtering the exact real-BBH metadata browser test. The later focused run strengthens the observation and delivery-order assertions without changing runtime code; the earlier broad run used their preceding version.

An initial unsharded run timed out; a subsequent directly mounted worktree broad run failed six publication and one collaboration tests because its `.git` worktree pointer could not resolve inside Docker. Confirmed `git merge-file` fails in that mount but works in scratch, and affected tests passed unchanged in a 89-path byte-verified self-contained source copy without `.git`. Complete broad shards above use that corrected copy. The npm and Python selections above passed despite their original direct mount; Python ran with cwd `/runboard`. No failed broad run is represented as green. Scratch receipts are transient.

## Intent, topology, and status

- Branch: `fix/board-dashboard-integrated`; worktree: `/home/ryushe/projects/bounty-board-dashboard-integrated`; eventual target: `beta`, subject to parent-owned independent combined review and release decision. No beta merge, push, remote contact, or runtime activation is authorized by this integration.
- Intended octopus merge parents, in order: `2461f5fc0bdd8c65dca17433f15e4f8473ea7b09` (then-current beta base), `9dfa194a9b27f85582519a69d3bd97589eb2dd7b` (warning-summary tip), `d8eb7f2014109a9098eff524a1d5fb4fa8d187d8` (progressive-load tip). Warning branch review was accepted; the original progressive candidate was blocked for the three defects corrected above. Parent owns the follow-up review.
- Tested staged source tree before this dossier: `12165bdf642350f6e1f311bab1e755075a4d5483`. This dossier is the only added content after that staged tree; compare all other paths to it. The two superseded feature dossiers are intentionally excluded from the integrated tree; their original branch histories retain them.

## Reconciliation

The dashboard conflict combines `rootWarning()` and the compact `availability(ps)` disclosure with `reports_loading ? 'Loading' : ...` for the report total. Partial report warnings remain unknown rather than empty; the workspace selection and identity-aware warning aggregation remain from warning-summary. The phase request, generation and root-instance guards, report-action restriction, focus/draft deferral and explicit apply remain from progressive-load. The held-report regression additionally checks that warnings are visible with Loading and remain visible after complete data is applied. Two existing browser assertions that expected raw warning codes were updated to use the visible accessible disclosure and fatal alert, without dropping unknown-count or healthy-program checks.

`npm test` adds the three exact files `data-availability.synthetic.test.cjs`, `progressive-load.synthetic.test.cjs`, and `progressive-races.synthetic.test.cjs`. It retains the exact metadata fixture skip and does not add either legacy fixture-publisher test. The warning-focused group comprises two new availability tests plus two existing dashboard tests; therefore the selected broad suite has 143 previous + 11 new = 154, not 143 + 13 new.

## Verification receipts

Synthetic fixtures only: containers based on the locally available `nousresearch/hermes-agent:latest`, nonroot uid/gid 1000, `--network none`, read-only source/tool mounts, executable 4 GiB `/runboard` tmpfs, explicit HOME/TMPDIR/XDG in `/runboard`, private container `/tmp` and `/dev/shm`, and `/runboard` cwd for Python. Node 22.23.2, Playwright 1.60.0, Chrome 150.0.7871.181, Python 3.13.5. Preflight verified loopback connection, off-host connect returned 101, nonroot identity, no `.git` pointer in the copied checkout, executable tmpfs, read-only source, and Chrome startup. No real Shared data, live `/api/data`, host `/tmp` or `/dev/shm`, remote, or service was accessed. Each of the 88 staged snapshot blobs matched its Git index object before browser tests.

- `npm test`, selected staged source tree above: **73 passed, 0 failed, 0 cancelled**. The skip-pattern filters the metadata test out of TAP rather than counting it as skipped; its exact name occurs once in source and was absent from the subtest list. SHA-256 of receipt: `1d16129a13c004fb094c4d222c9c5fac94e48c8cceb5c1f6121a1ad9a73231f3`.
- Broad selected browser suite: all 25 `static/tests/*.test.cjs` files other than exact exclusions `collaboration.synthetic.test.cjs` and `collaboration-combined.synthetic.test.cjs`, with the same exact metadata test skip pattern: **154 passed, 0 failed, 0 cancelled**, 335.6 seconds. Source inspection confirmed exactly those two files use `experimental_fixture_publish`. Metadata skip is filtered from TAP. SHA-256: `350818bb12300086ecd623b709b987af28de656db9ebd9ff47d4e18f2b37609c`. Every one of the 13 focused test IDs below was present exactly once in both this run and npm.
- `python3 /repo/tests/safe_suite.py`: **147 run, 1 skipped, 0 failures**; exact excluded test `test_backend.BackendTests.test_real_bbh_metadata_write_on_disposable_fixture`; skip was `test_dashboard_coverage.DashboardCoverageTests.test_encoder_depth_failure_is_isolated_for_map_and_coverage` (Python 3.12 encoder boundary fixture). SHA-256: `8ae0c40d98ba96e11ac86129f37c3a1de5beb90dbcb4be5e1a87f153e12147a7`. This was run on staged tree `643d69f3e3ddd0fda37d93a87b8111f9b97fe8dd`; its only differences from the final tested source tree are the three browser test files `app.test.cjs`, `mapstore-detail.synthetic.test.cjs`, and `progressive-load.synthetic.test.cjs`; all Python and application sources are identical.
- Initial npm run on that earlier tree: **71 passed, 2 failed** due to existing browser assertions looking for raw warning codes, now replaced by assertions against the accessible rendered messages. Final npm and broad runs above include and pass both corrected tests.
- Receipts are in `/home/ryushe/.hermes/cache/scratch/board-dashboard-int-2461/receipts/`; scratch is transient. Recorded hashes identify exact logs while available. `git diff --cached --check` was clean before the dossier. No owned containers remained after tests.

Focused IDs (the first four are warning/dashboard; the other nine progressive):

1. `portfolio filtering, ledger and unassessed inventory end to end`
2. `same-name programs have distinguishable keyboard-accessible choices`
3. `many lane warnings leave the portfolio visible and provide bounded availability`
4. `disposable real loader distinguishes empty, missing, corrupt and unreadable sources`
5. `known portfolio is usable before the held report read completes`
6. `focused filter is retained until the completed data is explicitly applied`
7. `manual refresh supersedes an older held full response`
8. `superseded full response does not disturb an active report draft`
9. `root replacement during a held full read is rejected and refresh recovers`
10. `deferred report result is rejected if root changes before apply`
11. `failed complete request retains summary and refresh retries`
12. `a delayed summary does not begin the full read early`
13. `writer-enabled browser receives only a full writable snapshot`

## Gates and limits

Parent must obtain independent review of the correction commit and reconcile it with the now-current beta, especially the loader race, summary-scoped lazy reads, warning completeness, focus/draft guards, and test-selection changes. The earlier progressive review blocked its candidate; it is not acceptance of these corrections. Root identity checks are not an atomic filesystem snapshot and do not detect every same-inode internal change, ABA swap, or change after the last check. No production performance or worst-case latency is established. Remove this branch-local dossier only when the parent intentionally integrates an accepted branch into beta; deployment, service changes, publication and stable promotion are separate decisions.
