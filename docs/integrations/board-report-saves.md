# Report autosave backend — branch-local handoff

- **Status:** experimental backend vertical slice implemented and synthetic-tested; **not reviewed, integrated, activated, or approved for real deployment**. Parent owns independent review, integration, UI, and activation decisions.
- **Owner / ref / checkout:** delegated Hermes worker; `feat/board-report-saves`; `/home/ryushe/projects/bounty-board-report-saves`.
- **Assigned base:** `21a2244ab5ee93be5667c2d3deda2276472b6345`; prior source-observation primitive `0fc6e722197307bc2da4dd7f70312fb37ec35a45`; eventual target `beta`. `git fetch origin beta` succeeded. No merge, push, service change, real source write, or frontend change.
- **Implementation / recovery checkpoint:** `06a714f8cb3f34db25eab6f4fd7f4c5fa7bf1cca`; the branch tip includes a subsequent dossier-only handoff commit. Verify that tip separately.
- **Inspiration:** separate synthetic `feat/collaboration-exchange` experiment (`exchange_experiment.py`, dossier); its TMPDIR/marker fixture guard is not repurposed as a real-use guard.

## Implemented contract

`report_publisher.py` attempts Linux `renameat2(RENAME_EXCHANGE)` only, with no ordinary-rename fallback. The opt-in `--report-autosave` (default off, incompatible with the old fixture publisher) connects the shared-store submit endpoint to this publisher. Store source observations and the existing line-oriented three-way merge run under the existing process-shared store observation lock. The accepted draft is committed before publication. A private same-device operation directory retains an independent Board copy, an initially observed hard link, a candidate/exchanged-out inode, intent and receipt. Metadata validation covers UID, GID, mode, and source/candidate xattrs; unsupported conditions fail closed where observed. The exchanged-out and current source are reinspected; a late displaced edit is sent to the existing retained-observation store primitive on the publication path. An SQLite publication-attempt state is committed before exchange and completed only after publication and observation: a crash while pending recovers as `outcome_uncertain`, not a fresh exchange. Exact retry is associated with the original report and request ID.

See `BACKEND_API.md` for the JSON contract, including `store_saved`, publication state/reasons, opaque operation, `GET /api/collaboration/recovery?...&request_id=...`, and the explicit distinction between a store save and a source save. The operation is synchronous; there is no externally reported pending phase. No UI has been implemented here.

## Test evidence

All executions used synthetic `TemporaryDirectory` files and checkout-first `PYTHONPATH`; `HOME`, `HERMES_HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, and `TMPDIR` were redirected under `/home/ryushe/.hermes/cache/scratch/board-save-vertical`. These environment overrides are not an OS/network sandbox.

- Final focused command: `python3 -B -W error::ResourceWarning -m unittest -v test_report_autosave test_collaboration_process test_retained_observation test_missing_source_synthetic test_config`: **27 passed**. Included 12 new autosave tests: real local HTTP source publish, retained original, external+draft three-way merge, publication-time displaced conflict/history, mode, open-fd late write/reinspection, same-inode retention, unsupported exchange injected with ENOSYS, source deletion, real process barriers before/after exchange, SIGKILL before/after exchange, receipt failure injection, real HTTP process death after exchange before store acknowledgment, exact retry/recovery after restart, and two separate server processes blocked at the actual shared `flock` while publishing two non-overlapping changes. ENOSYS is injected; it does not establish behavior on a real unsupported filesystem. SIGKILL is not a power cut.
- Final safe discovery: **81 passed**, exact exclusions asserted before run: `test_backend.BackendTests.test_real_bbh_metadata_write_on_disposable_fixture` and `test_collaboration_api.CollaborationAPITests.test_opt_in_fixture_publication_checks_head_and_writes_source`. Exact runner, after setting the isolated environment above:

  ```sh
  python3 -B -W error::ResourceWarning -c 'import unittest,sys
  suite=unittest.defaultTestLoader.discover("tests")
  def flatten(s):
   for x in s:
    if isinstance(x,unittest.TestSuite): yield from flatten(x)
    else: yield x
  all_tests=list(flatten(suite)); excluded={"test_backend.BackendTests.test_real_bbh_metadata_write_on_disposable_fixture","test_collaboration_api.CollaborationAPITests.test_opt_in_fixture_publication_checks_head_and_writes_source"}; ids={t.id() for t in all_tests}; assert excluded <= ids, (excluded-ids); selected=[t for t in all_tests if t.id() not in excluded]; print("Selected",len(selected),"excluded",sorted(excluded),flush=True); result=unittest.TextTestRunner(verbosity=1).run(unittest.TestSuite(selected)); sys.exit(not result.wasSuccessful())'
  ```

  The expected invalid-config argparse diagnostic was printed. An earlier run of 79 selected tests had one CLI-forwarding mock failure; fixed and reran successfully. The new HTTP history test first timed out at its five-second client limit; no process remained, and a longer-timeout rerun failed for the intended missing history observation before the fix and subsequently passed.
- TDD red/green was demonstrated for the initial endpoint opt-in, source-baseline advance, recovery request lookup, publication-time displaced history, candidate xattr refusal, failure receipt, and crash-before-ack recovery. Some additional tests were added after their behavior already existed; do not claim strict red-first evidence for every new assertion.

## Known limitations and review gates

1. `published` is a current observation after exchange, not a claim that independent processes or synced hosts cannot overwrite it. This is not a filesystem compare-and-swap. An old descriptor can mutate a retained inode after any read, and intermediate writes can be missed. Recovery rechecks current/displaced bytes but **does not add later displaced snapshots to SQLite history**; the retained inode is available for manual recovery. A source replacement during publication can be preserved as a displaced inode but may have metadata or type that cannot be decoded or merged.
2. Locks coordinate only servers using **the same private store on the same lock-capable filesystem**. Separate stores, other editors, BBH, and sync clients are not coordinated. Sync behavior and cross-host conflict retention have not been tested or authorized.
3. Mode, owner/group and xattrs checks are snapshots, not race-free preservation of all metadata. Timestamps, filesystem flags and hard-link relationships are not preserved; unsupported metadata and permissions need target-filesystem review. The initial app read compares content with the publisher's later read, not an inode identity captured at the initial read. Directory reachability is only checked around the exchange. The backend assumes a trusted local tree, not hostile concurrent path mutation.
4. Private retention is plaintext, has no pruning/quota policy, and requires the private store on the same filesystem. Disk-full, actual unsupported filesystem, real power loss, all fsync failure points, unlink failure during receipt cleanup, directory migration, and storage hardware failures are not fully tested. A failed filesystem may prevent durable uncertainty recording; retain the operation and do not infer success. Tests do not establish crash consistency across actual deployed mounts. SQLite pending/ack gates HTTP success, not the standalone inspection helper.
5. Recovery inspection is read-only and cannot itself resolve pending, conflict, or uncertainty. Explicit UI flows, accepted resolution, reopened fd changes after recovery, browser-to-backend testing, retention administration, and independent complete-diff review remain for parent/follow-up. The safe suite explicitly omits the two tests named above; no real BBH test, real sync test, activation or deployment occurred.

**Resume:** independently review the full branch diff against `21a2244`, paying particular attention to durability boundaries, status/receipt ordering, path races, and post-exchange collision handling. Rerun focused and safe synthetic tests on the eventual integration candidate. Parent to decide whether gaps block integration and separately implement UI. This document is branch-local and should not be carried into the integration target as a permanent status board.
