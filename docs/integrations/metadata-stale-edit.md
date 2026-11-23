# Finding metadata stale-edit integration dossier

- **Status:** feature; independent parent review required before integration
- **Owner:** delegated Board stale-edit worker
- **Branch:** `fix/board-metadata-stale-edit`
- **Base commit:** `4f10d2d4aed832c151f99b6da573d186999a02d5`
- **Intended integration target:** `beta` (no merge, push, or deployment authorized here)
- **Last updated:** 2026-11-23
- **Owning feature branch/ref:** `fix/board-metadata-stale-edit`
- **Latest immutable recovery checkpoint:** pending first feature commit
- **Feature implementation commit(s):** pending first feature commit
- **Inspiration:** real browser → real BBH synthetic reproduction of stale LOW → external MEDIUM → stale HIGH overwrite.

## Intent and implemented contract

Keep severity, class, status and rationale edits opt-in, but reject a finding whose displayed root instance, lane/ledger identity or full finding revision no longer matches a fresh server-side read. Require both preconditions at the endpoint for all callers. Serialize this server's requests through its own check and write. Preserve failed or conflicting choices for copying, including across navigation and source changes, and keep submission/result separate. The generic legacy frontend writer is classified as unsafe for uncoordinated ledger editing; it is not the Board BBH contract.

This is **early precondition detection, not atomic CAS**. Another Board process, direct BBH, editor or synced peer may write after the check; ABA/intermediate states can be missed. The check and post-write readback do not promise durability or distributed coordination. Stop other writers/sync and require explicit opt-in. A failing writer can have partially changed the source. Actual activation remains a separate decision.

## Evidence and review

- Independent review: **not yet performed**; parent must review complete diff and test evidence, especially root/finding identity binding, UI draft retention and remaining non-CAS windows.
- Red/green: `tests/test_metadata_conflict.py` first failed on the unimplemented precondition (`400` instead of the expected `409`); after implementation it passed. It checks missing/mismatched tokens, missing root/FID, replaced ledger identity, and stale severity/class/status/rationale with zero writer invocation.
- Real browser → real BBH: `node tests/metadata_bbh_e2e.cjs` in the isolated environment below passed: response statuses `[409,200,409,200,200,200,400,409,409,409,404,502]`. Synthetic LOW → external real BBH MEDIUM → stale HIGH returned 409 with no Board writer invocation and a copyable pending HIGH; refresh then HIGH succeeded. A second real BBH change while a browser request was held and the user navigated caused 409 without invocation; pending class survived. Refreshed class, status, and rationale saved; `submission.state=submitted` and `submission.result=duplicate` remained unchanged. Missing/mismatched revisions, missing root/FID and an injected writer error were rejected/retained as appropriate. Writer error deliberately comes from a fixture wrapper before real BBH execution; it tests the Board's error handling, not a real BBH partial-failure mode.
- BBH checkout snapshot was mounted read-only then copied to disposable tmpfs. Snapshot normalized tar SHA-256 `541e8cb3d291d5f52a2791f9d0fd3b11b6ac517f70de31da9475715433089d01`; its pinned `bounty-core` commit `9db8b23d7405587bc123338ae0aa44d4d51c95a3` was archived offline and extracted as a task-local dependency (archive SHA-256 `b95b9fcfc13dcfd8f057e13e80e8d92ab0bc79ffaad05a1492fbc338b3b07c41`). No real Shared/service/remote was mounted. Container: network none, uid 65534, 2 CPUs, 3 GiB memory, executable `/runboard` tmpfs, explicit HOME/XDG/TMPDIR, read-only browser dependencies. Browser is real Chrome; no host `/tmp` or host `/dev/shm` used.
- `npm test`: 94 passed in the isolated container, including new browser regressions. The exact existing skip is `^browser metadata update reaches backend with a disposable synthetic writer$`; a separate sentinel canary verified the skip pattern. The real BBH browser test is separately invoked, not in `npm test`, to avoid a hidden real-writer test in ordinary runs. SHA-256s for `app.py`, `static/api.js`, `static/app.js`, and `static/tests/app.test.cjs` matched between the task tree and the extracted container tree.
- `python tests/safe_suite.py`: 156 selected tests passed, one skipped because its encoder-boundary fixture requires Python 3.12; exactly `test_backend.BackendTests.test_real_bbh_metadata_write_on_disposable_fixture` was excluded by the runner and identified before execution. Run in isolated network-none tmpfs; the distinct real BBH test above is not the same excluded Python test.
- `python -m unittest discover -s tests -p test_dashboard_coverage.py -v` on isolated Python 3.12: 7 passed, including the encoder-boundary test skipped by the Python 3.14 suite.
- Earlier suite attempts were retained in scratch logs: direct host-worktree bind caused unrelated Git merge-file failures due to its host-only Git pointer; extracted task archive resolved them. Later `read_file` signature change broke a browser fixture wrapper; the wrapper was corrected and the full npm selection rerun successfully. An early e2e assertion raced the rationale request; the corrected test waits for the confirmed UI state.
- `git diff --check`: to be rerun on final staged tree. No upstream fetch: task explicitly pins local beta base and prohibits network in the test workflow; integration parent must reconcile current beta before any merge.

## Blockers and deferred work

- Parent must independently review the actual final diff and evidence. Verify legacy generic writer classification and decide whether its existing external adapter should remain enabled; it has no Board-enforced revision guard and is unsupported for this BBH contract.
- Exact real BBH partial-write failure and sync-peer races are not proved safe; this is a non-atomic design limitation, not an outstanding test that can establish CAS. Do not activate against real data as a side effect of integration.
- The exact excluded Python real-BBH test requires an explicitly fenced approved fixture; the separate real browser → BBH synthetic test above provides different evidence.

## Interruption / resume handoff

- **Owning feature branch/ref:** `fix/board-metadata-stale-edit`
- **Latest immutable recovery checkpoint:** pending feature commit
- **Exact resume point:** inspect staged diff, commit, record checkpoint, then parent reviews; no merge/push/deploy.
- **Working-tree state:** task-owned uncommitted changes pending commit.

## Decision gates

- **Integration:** parent independent review, verify test receipts, reconcile beta; remove this branch-local dossier from the target when accepted.
- **Activation:** separate explicit operator authorization after review; retain opt-in and risk warning.
- **Promotion:** not authorized by this task.
