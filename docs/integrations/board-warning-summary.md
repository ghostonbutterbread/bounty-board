# Data availability integration dossier

- **Status:** implementation complete; independent review and integration pending
- **Owner:** dashboard warning-summary worker
- **Branch / worktree:** `fix/board-warning-summary`, `/home/ryushe/projects/bounty-board-warning-summary`
- **Base commit:** `2461f5fc0bdd8c65dca17433f15e4f8473ea7b09`
- **Intended integration target:** `beta` (parent integrates after review)
- **Last updated:** 2026-11-21
- **Implementation / recovery checkpoint:** `91c8d01d9ed8cecb6cbf2fdbb1f57b21394ba7c7`; branch tip also contains this dossier-only handoff.
- **Inspiration:** operator's warning-flood screenshot and independent synthetic reproduction.

## Intent and contract

The dashboard flattened warnings from every lane above the portfolio and removed their identities. Replace that flood with a compact, closed-by-default Data availability summary after the portfolio, plus a corresponding summary for the selected workspace lane. Native disclosure is keyboard-operable and its detail area is scrollable. Each status and warning type counts distinct family/program/lane identities, rather than warning events; details retain those identities. Missing is not claimed to be expected. Invalid/inaccessible, unknown warning codes, global discovery warnings and the immediately visible fatal root warning remain available. Strings are escaped. Selection changes recompute the summary. Partial report walks have unknown counts and do not claim an empty partial list means no reports. No backend, source data, or write capabilities are changed.

## Evidence

- **RED:** real Chromium against an in-memory synthetic API with eight missing-data lanes and one additional problematic lane placed Portfolio overview at y=2879 in a 768px viewport; first new browser assertion failed as intended. After the initial implementation the same assertion passed. A second RED verified a partial empty report walk incorrectly displayed “No reports in this lane”; after the correction it passed.
- **GREEN:** the following local command passed **4 tests** (two new tests, two existing dashboard tests). It uses a dedicated disposable scratch HOME/TMP/XDG, synthetic loopback servers, a browser route fence, and no real program root or source writes. The second new test uses the repository's real loader on disposable fixtures with a valid empty map, missing map, corrupt JSON and SQLite, and invalid-UTF-8 report; the other uses controlled synthetic responses for partial walks and global errors.

```sh
env -i PATH=/usr/bin:/bin \
  HOME=/home/ryushe/.hermes/cache/scratch/board-warning-test/home \
  TMPDIR=/home/ryushe/.hermes/cache/scratch/board-warning-test/tmp \
  XDG_CONFIG_HOME=/home/ryushe/.hermes/cache/scratch/board-warning-test/config \
  XDG_CACHE_HOME=/home/ryushe/.hermes/cache/scratch/board-warning-test/cache \
  PYTHONDONTWRITEBYTECODE=1 NODE_PATH=/home/ryushe/node_modules \
  CHROME_BIN=/usr/bin/google-chrome \
  node --test --test-concurrency=1 static/tests/data-availability.synthetic.test.cjs static/tests/dashboard-coverage.synthetic.test.cjs
```

Create the four scratch directories before rerunning. Coverage includes duplicate warning events, same-name programs in different families, dashboard filters/reset, workspace lane switch, unknown codes, root/discovery/global warnings, partial reports, XSS strings, Enter/Space, desktop/mobile layout and reachable submission aggregates. `git diff --check` passed. The browser tests use local loopback, not a network-none container; only task-owned synthetic servers were visited and browser requests were restricted to their ephemeral origin.

## Review, blockers and integration

- **Independent review:** assigned to parent; not yet performed. Review the entire feature diff and tests, especially identity/deduplication, partial report semantics, accessibility and compatibility with the concurrent backend loading changes. Any consequential integration conflict requires retest on the combined tree.
- **Integration gate:** parent review and combined beta tests; remove this branch-local dossier during integration. Neither merge nor push was performed.
- **Activation / promotion:** no runtime or service change is authorized by this branch. Stable promotion is separate.
- **Deferred evidence:** full suite and combined-tree tests with the concurrent loader branch have not been run. Run the focused command above (and the parent-selected broader isolated suite) after integrating the loader, before acceptance. No live `/api/data`, Shared data, metadata or source mutation was exercised.

## Resume

Implementation checkpoint `91c8d01d9ed8cecb6cbf2fdbb1f57b21394ba7c7` is reachable from this branch; review it together with the dossier-only tip. Parent should review, reconcile concurrent loader changes, run combined synthetic checks, and integrate into beta if accepted. This branch does not grant runtime activation.
