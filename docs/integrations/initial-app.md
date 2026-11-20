# Initial application integration dossier

- **Status:** feature
- **Owner:** Hermes
- **Branch:** feat/initial-app
- **Base commit:** 553a06cebadd4fe9ded2213466a68510117060d9
- **Intended integration target:** beta
- **Last updated:** 2026-11-20
- **Owning feature branch/ref:** feat/initial-app
- **Latest immutable recovery checkpoint:** 5eff7052e5eef56d9c0e06a869f94bf99ab7468f
- **Feature implementation commit(s):** 960ab0d6a50adf79bc23e23b1e2bb5208fb11ae8, b57fe7f362125474c315fcbd6e880ef70620886f, b9d113019cd4ee2009bf672d3ccefe993b8cf851, 7701f9fef2dcf4ed34926b4980806a0a30d71aab, fb511b45cac681eaee94763c6f70fb98c340db09, 8ca163e1c7b55d88d6941d11f5dc091946c0e5c5, 135b48a2f5bdd1dfd4af18cd181e7904eea8a847, 5eff7052e5eef56d9c0e06a869f94bf99ab7468f.
- **Inspiration / canonical references:** `docs/product.md`; user-approved mockup; BBH ledger, coverage, MapStore and storage ownership skills.

## Intent

Provide a local-only, multi-theme bounty workspace over configured source roots. Keep the existing stores authoritative and keep real bounty records out of Git. Include rendered Markdown and safe report autosave where the actual source and writer guarantees support it.

## Implemented contract

The application discovers program and lane data and renders dashboard, coverage, reports, gadgets and MapStore with Light, Dark and Dusk themes. JSON/TOML config selects root and port. Finding metadata changes use the BBH writer only with a separate explicit uncoordinated-write risk acknowledgement; the UI warns of concurrent overwrite risk. Severity rationale and dashboard severity breakdown are visible. Source report writes remain disabled; in-tab drafts do not save. The separate private draft primitive is not connected.

## Evidence and review

- Bootstrap: private GitHub repo created and read back; initial main and beta point to base commit.
- Tests: after the current fixes, 38 Python fixture tests passed with `test_real_bbh_metadata_write_on_disposable_fixture` explicitly excluded; the earlier pre-fix run passed 32 including that real-BBH fixture. Frontend Node test run passed all 32 tests including a disposable synthetic-writer test; an attempted negative-lookahead exclusion did not work (papercut PC-20261120-113453-94ea198e). That test did not invoke real BBH. A full browser-to-real-BBH test is outstanding. Direct fixture setup timed out twice and a diagnostic retry was denied by the terminal safety gate; do not retry that workflow without user consent.
- Draft primitive: `python3 -W error::ResourceWarning -m unittest discover -s tests -p 'test_draft*.py' -v` passed 8 tests, including recovery of valid versions when another is corrupt, permissions, idempotency, simultaneous saves and injected fsync failure. This is isolated evidence, not end-to-end autosave; the primitive is not wired to the app.
- Independent review: second review identified metadata stale-write and unsupported autosave blockers plus severity rationale, draft recovery, report classification and dashboard gaps. A re-review verified most fixes but identified in-flight refresh/rationale-draft loss defects; corrections are in 135b48a2f5bdd1dfd4af18cd181e7904eea8a847. README was corrected for the acknowledgement flag and bounded test selections in 8ca163e1c7b55d88d6941d11f5dc091946c0e5c5.
- Bounded verification after 135b48a2f5bdd1dfd4af18cd181e7904eea8a847: `python3 -W error::ResourceWarning tests/safe_suite.py` passed 38 tests, explicitly excluding the real-BBH fixture. `node --test --test-skip-pattern='^browser metadata update reaches backend with a disposable synthetic writer$' static/tests/app.test.cjs` passed 38 tests; the named synthetic-writer test was not listed. Separate canary confirmed skip behavior.
- Independent re-review: the optional report-write race correction was accepted only for the current backend with report writes disabled. A separately lazy-loaded report can still discover a conflicting revision after an in-flight save was acknowledged; before enabling reportWrite, fix this lazy-fetch ordering and add deterministic tests for it. Original report autosave and its conflict policy remain unresolved.
- Report race mock-only verification: `node --test --test-skip-pattern='^browser metadata update reaches backend with a disposable synthetic writer$|^frontend boots against the real read-only backend with an empty synthetic root$' static/tests/app.test.cjs` passed 44 tests, with both named tests excluded. This does not validate source report autosave.
- Replay/cohort/fixture evidence: browser exercised the real HTTP server using a synthetic fixture root; selected a program and read/rendered a report. Eight actual lanes were sampled read-only for adapter compatibility; no target details copied into this repository.
- Merge/ancestry evidence: pending.

## Blockers and deferred work

- Report edits and ledger updates require verified owning write interfaces and inter-writer safety; if unsupported, keep disabled and document exact missing evidence and recovery step.
- Missing tests: full browser-to-server integration, source adapter compatibility, theme persistence, report save conflicts, safe Markdown rendering and cross-origin protections.
- Trigger: after backend and frontend workers complete their owned slices; integrate contracts and run isolated fixture-backed tests.

## Interruption / resume handoff

- Owning feature branch/ref: feat/initial-app.
- Latest immutable recovery checkpoint: 5eff7052e5eef56d9c0e06a869f94bf99ab7468f.
- Feature implementation commit(s): 960ab0d6a50adf79bc23e23b1e2bb5208fb11ae8, b57fe7f362125474c315fcbd6e880ef70620886f, b9d113019cd4ee2009bf672d3ccefe993b8cf851, 7701f9fef2dcf4ed34926b4980806a0a30d71aab, fb511b45cac681eaee94763c6f70fb98c340db09, 8ca163e1c7b55d88d6941d11f5dc091946c0e5c5, 135b48a2f5bdd1dfd4af18cd181e7904eea8a847, 5eff7052e5eef56d9c0e06a869f94bf99ab7468f.
- Exact resume point: after the operator chooses report autosave semantics, fix and test the lazy-report-fetch race before enabling any reportWrite backend. Renew GitHub authentication before pushing. Obtain consent before repeating terminal-blocked BBH fixture workflow.
- Working-tree state at handoff: clean after dossier-only commit. Latest local commits remain unpushed because GitHub authentication returned 401.

## Decision gates

- Integration: verified tests and independent review, no unverified source writes.
- Activation: separate decision; loopback only unless separately authorized.
- Promotion: explicit user authorization for stable main.

## Decision record

- 2026-11-20 — feature begun; report autosave and Markdown rendering added to product direction.
