# Retained-scan backlog retry — branch-local handoff

- **Status:** review pending; not integrated or activated
- **Owner / branch:** delegated worker, `fix/board-backlog-retry`
- **Base:** `9ea3031` (`feat/board-release` at delegation); integration target: parent-owned `feat/board-release`, then parent determines beta propagation. The defect belongs to the combined release candidate, not independently applicable to beta without its autosave backend.
- **Last updated:** 2026-11-21
- **Owning ref:** `fix/board-backlog-retry`
- **Latest immutable recovery checkpoint:** initial code-and-dossier commit (recorded in following handoff-only commit).
- **Inspiration:** independent backend review of pre-submit `503 retained_scan_backlog`; `BACKEND_API.md` retained-sweep contract.

## Intent and contract

Only HTTP 503 plus exact `retained_scan_backlog` permits three bounded automatic retries (500 ms, 1 s, 2 s) of the original persisted payload and request ID. These replies describe the current attempt, not any earlier unknown attempt. Newer text stays separate and is sent only after the original receipt permits it. Poll contention defers rather than loses a scheduled retry; manual inspection cancels it. Exhaustion is visible and retains the request. Reload stops retry and directs inspection, because a previous attempt could be in flight. Other 503s, transport failures, malformed/unknown success receipts, and uncertain publication outcomes preserve the original manual-recovery path. No backend changes, fixture publisher, live source, service, remote, merge, push, or activation.

## Evidence

- TDD red: `node --test --test-concurrency=1 static/tests/board-65-real.synthetic.test.cjs` produced the real 503 and failed waiting for auto-save on the original UI. Green with the same 65 real browser-issued publications, source Markdown, private store, recovery inspection (404 not observed), interleaved actual backend GET, captured exact retry and real published receipt, newer editor text and final source: passed in the 6-test invocation below. The real scenario disables the UI's 2-second interval for deterministic barriers and drives the poll explicitly; it does not prove the interval firing during a retry.
- `node --test --test-concurrency=1 static/tests/board-65-real.synthetic.test.cjs static/tests/backlog-retry.synthetic.test.cjs static/tests/backlog-reload.synthetic.test.cjs`: 6/6 passed before adding a further test; same implementation and real 65 fixture. The repeated-backlog, mismatched-status/code and reload cases inject responses; the post-backlog lost acknowledgment fetches and drops a real committed backend response.
- `node --test --test-concurrency=1 static/tests/backlog-retry.synthetic.test.cjs static/tests/backlog-reload.synthetic.test.cjs`: 6/6 passed, including added inspection-cancels-retry test, bounded four POSTs, same payload, newer text, 503/409 negative controls, and dropped real acknowledgment.
- `node --test --test-concurrency=1 static/tests/report-save-ui.synthetic.test.cjs`: 12/12 passed, including real lost-ack inspection, reload and newer-edit recovery, conflict and storage-failure paths; some cases explicitly inject publication states/policy.
- `node --test --test-concurrency=1 static/tests/merged-ack-race.synthetic.test.cjs static/tests/merged-ack-recovery.synthetic.test.cjs`: 4/4 passed against synthetic source/store and real backend, including injected conflict case as labeled in test.
- Reload notice TDD: new reload test failed on stale `Retrying` notice, then passed after the UI changed to unconfirmed/inspection.
- All runs used isolated synthetic `HOME`, `HERMES_HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `TMPDIR` and checkout-first `PYTHONPATH`. Chromium host resolution excluded non-loopback; backend listened only on loopback; no fixture publisher. No remote fetch due to the explicit no-network directive.
- One intermediate 65-test execution timed out without output after the tool's 420-second limit; no cause was established. Owned processes were checked and gone. The fixture was changed to disable interval races, add a barrier timeout and reject on interception assertion; the same real test passed subsequently. This does not prove the earlier timeout's cause.

## Review, gaps, and gates

- Independent review is assigned to the parent. Inspect retry safety, local-storage/reload semantics, and the real/injected test boundary on the exact commit range `9ea3031..fix/board-backlog-retry`.
- The actual 2-second UI polling callback racing a retry timer is not directly exercised by the real 65 fixture. To close if required, add a deterministic UI poll-in-flight barrier in `board-65-real.synthetic.test.cjs` or a separate real-backend regression, run under the same isolated environment, and verify the retry waits then completes without duplicate submission. Current fixture proves real backend poll interleaving, not that particular callback race.
- No full repository suite was run; parent to choose broader release-candidate gates. Previously existing writer concurrency and uncoordinated external/sync limitations remain; source publication stays opt-in and activation is a separate decision.
- No propagation to beta or stable was authorized in this worker. Parent integrates/reviews the release candidate, resolves branch topology and removes this temporary dossier from the target upon accepted merge.

## Resume

Review the staged/committed diff and rerun the named focused cases as needed. Confirm current branch tip and immutable implementation checkpoint in the follow-up handoff commit. Worktree should be clean; no push or service changes.
