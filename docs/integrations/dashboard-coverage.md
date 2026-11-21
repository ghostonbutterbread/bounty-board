# Dashboard and coverage integration dossier

- **Status:** awaiting parent review; no integration or activation authorized.
- **Implementation / recovery checkpoint:** `8e7c5a35e0088adee97938fd98b5e87630764294`; the branch tip contains a subsequent dossier-only handoff commit.
- **Owner / branch:** delegated feature worker, `feat/board-dashboard-coverage`.
- **Worktree:** `/home/ryushe/projects/bounty-board-dashboard-coverage`.
- **Feature base:** `68d30e413bad1c2d5871a54fbff1983405062532` (collaboration feature tip supplied by parent).
- **Intended target:** `beta`, observed locally at `553a06cebadd4fe9ded2213466a68510117060d9`; this is an ancestor of the supplied feature base. No remote fetch was performed under the task's no-remote boundary. Parent must reconcile integration with concurrent features rather than assuming the complete feature ancestry should land.

## Contract

Dashboard program selection scopes all aggregate counts, severity/class bars, submission records, program listing and lane warnings; all-programs resets the filter. Switching workspaces clears stale ledger filters. Nonempty nested submission state/result take precedence over the corresponding flat fields independently, so one finding contributes at most one value per field. Incomplete sources remain unknown/partial, not zero.

Coverage returns actual unassessed surface identities and existing assessment rows from one read transaction; the former are not conflated with `no_assessment` questions or proof of testing. Null fingerprint/run identifiers result in unknown freshness rather than a crash or false stale result. Bad assessment JSON makes coverage unavailable without disconnecting the API. WAL reads remain enabled.

## Evidence

- TDD: real HTTP test first reproduced disconnected response from both-null fingerprint/run; after repair it passes with a WAL writer held open. A second red test reproduced the malformed assessment JSON disconnect, then passed with coverage unavailable. The browser test first failed because the dashboard selector was absent, then passed.
- Fenced `HOME`, `HERMES_HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `TMPDIR`, and source-first `PYTHONPATH`; synthetic local roots only. `python3 -W error::ResourceWarning tests/safe_suite.py`: **67 passed**, with `test_real_bbh_metadata_write_on_disposable_fixture` explicitly excluded. Existing WAL/snapshot tests included.
- Fenced `npm test`: **59 passed** including the new real Chromium → real Python server → synthetic SQLite/JSON multi-program test; exact existing browser synthetic-writer test is excluded by package script. It checks filters, precedence, stale-selection reset, incomplete data and inert hostile surface markup. An earlier run had one timing failure in an existing submission test that counted before dashboard load; test now waits for the submission panel and rerun passed.
- No real Shared storage, real BBH fixture, remote, service, push, merge, or activation used. The parent supplies independent complete-diff review.

## Limits / handoff

MapStore/gadgets currently consume only existing `recon/maps/map.jsonl` adapter and tagged subset; application-behavior indexes and observation bodies are explicitly not loaded. Do not invent their schema here: investigate actual formats as a distinct task before implementation. Unassessed inventory and SQLite assessment lists are not paginated, matching existing limits. Parent should review contract, security, fixture paths, and base-to-feature-only changes, then perform integration and tests on the actual beta candidate; remove this branch-local dossier from the integration tree. Stable propagation and runtime activation require separate authorization.
