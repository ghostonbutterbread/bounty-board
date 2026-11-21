# Board workspace latency integration dossier

- **Status:** blocked — RED-only checkpoint, not review-ready
- **Owner:** delegated workspace-latency worker
- **Branch:** `fix/board-workspace-latency`
- **Base:** `fea88bc7428b23c55be4d376ac38b81e5e89da8d`
- **Intended integration target:** `beta`; no merge, push or activation authorized here
- **Last updated:** 2026-11-21
- **Recovery checkpoint:** see subsequent handoff-only commit
- **Feature implementation commits:** none

## Intent and current contract

Remove unrelated-lane map and coverage I/O from the initial summary and selected
workspace paths, while retaining real ledger records, explicit loading/unknown
states, source capability semantics and complete portfolio discovery. Scope is
the read-only phased path; metadata writer/collaboration/full baselines must
remain intact. This checkpoint changes no application behavior.

`discover()` currently calls `ledger`, `map_entries` and `coverage` for every
lane before returning the summary; the full phase calls them again. The client
then calls `completeInitialLoad`, and its deliberate root/generation/view and
draft protections must not be bypassed. Manual refresh currently requests the
full endpoint. A target-scoped endpoint must bind the exact root instance both
before and after the read and verify family/program/lane ownership. In-flight
results also need client generation, selected lane, root and full-snapshot
arbitration. Do not infer missing from a source that has not yet been read.

## Evidence

- `tests/test_workspace_latency_red.py` is a recoverable RED test: real loopback
  HTTP against two synthetic program lanes, with a deterministic barrier on the
  unrelated lane, once each for map and coverage. Both ledgers were checked
  after release. Both tests failed at the intended pre-release assertion with
  `barrier entered=True` on the base; 2 methods, 2 failures, 0 skips.
- Reproduce from this checkout (expected failure until implementation):

  ```sh
  docker run --rm --network none --user 1000:1000 --memory 256m --cpus 0.5 \
    --pids-limit 64 --read-only \
    --tmpfs /runboard:rw,exec,nosuid,nodev,size=32m,uid=1000,gid=1000 \
    --tmpfs /tmp:ro,noexec,nosuid,nodev,size=1m --shm-size 1m \
    --mount type=bind,src="$PWD",dst=/src,readonly -w /src \
    -e TMPDIR=/runboard -e HOME=/runboard -e PYTHONPATH=/src \
    -e PYTHONDONTWRITEBYTECODE=1 python:3.12-slim \
    python -u tests/test_workspace_latency_red.py
  ```

- First Docker invocation exceeded its 35-second outer guard and the detached
  container exited subsequently; it produced no usable test receipt. The
  separately run 120-second-guard invocation finished normally in 4.085 seconds
  of test time with both expected failures. The two-second event wait is a
  failure guard, not a performance claim.
- No real-browser test, production traffic/data, npm test, safe Python suite,
  production speed measurement or independent review was performed. The new
  red test is discovered by the safe Python suite and will intentionally fail
  until fixed; it must not be silently excluded for a green release gate.

## Blocker and exact resume point

This is a partial checkpoint, not a fix. Completing the requested behavior
safely requires a coordinated backend/client change plus controlled end-to-end
race evidence; a partial projection or background scan without these checks
could silently turn missing data into empty data, use another lane/root, clobber
a draft or overwhelm the server. No production patch was attempted without
that evidence.

1. Keep the RED tests, then implement an explicitly partial read-only summary
   that does not read map/coverage/reports. Add a selected-lane scoped read
   using the existing source readers, exact root before/after, and strict lane
   ownership validation; keep writer-mode/full endpoint behavior unchanged.
2. Make selected-lane loading independently observable and race-safe; preserve
   selections, filters, focus and draft/editor state, ensure error/retry and
   refresh/selection/root/generation changes invalidate stale work, and ensure
   a late partial result cannot override a full response. Bound broad scans
   across requests/tabs so they cannot crowd out selected-lane reads, without
   dropping full portfolio results or adding global caches.
3. Add deterministic real HTTP + Chromium synthetic barrier coverage for
   unrelated map **and** coverage; selected lane must load both before release,
   then portfolio full scan must complete. Cover selection/root/refresh races,
   multiple tabs, errors, empty vs missing, read-only permissions, capabilities,
   lane ownership and action availability. Use nonroot network-none Docker,
   resource limits and task-owned `/runboard` tmpfs; never live `/api/data` or
   remote Syncthing. Provision Playwright/Chromium in that fence first: the
   `nikolaik/python-nodejs:python3.11-nodejs20` image lacks both. A read-only
   host Playwright 1.60.0 mount resolved successfully, but read-only host Chrome
   lacked 16 shared libraries in the image. Adding all host libraries via
   `LD_LIBRARY_PATH` failed with a glibc private-symbol mismatch. No browser
   launch was achieved; use a compatible pre-provisioned image/runtime rather
   than claiming that preflight as browser evidence.
4. Run the RED suite green, affected regressions, selected default npm suite and
   safe Python suite with audited fixture boundaries; report counts, exclusions,
   and limits. Obtain parent review of the exact implementation SHA.

## Decision gates

- **Integration:** blocked on implementation, green synthetic and regression
  evidence, and parent review. This branch is not merge-ready.
- **Activation:** separate parent decision; no service changed here.
- **Residual performance:** ledger and root enumeration and host I/O may still
  dominate even after the requested fix; no production speed claim is justified.
