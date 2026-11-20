# Initial application integration dossier

- **Status:** feature
- **Owner:** Hermes
- **Branch:** feat/initial-app
- **Base commit:** 553a06cebadd4fe9ded2213466a68510117060d9
- **Intended integration target:** beta
- **Last updated:** 2026-11-20
- **Owning feature branch/ref:** feat/initial-app
- **Latest immutable recovery checkpoint:** a78781da5fabc8f678e3f8f3475ceee24503fe39
- **Feature implementation commit(s):** 960ab0d6a50adf79bc23e23b1e2bb5208fb11ae8 (initial); b57fe7f362125474c315fcbd6e880ef70620886f (unintegrated local draft primitive); b9d113019cd4ee2009bf672d3ccefe993b8cf851 (config and review fixes); a78781da5fabc8f678e3f8f3475ceee24503fe39 (draft failure test).
- **Inspiration / canonical references:** `docs/product.md`; user-approved mockup; BBH ledger, coverage, MapStore and storage ownership skills.

## Intent

Provide a local-only, multi-theme bounty workspace over configured source roots. Keep the existing stores authoritative and keep real bounty records out of Git. Include rendered Markdown and safe report autosave where the actual source and writer guarantees support it.

## Implemented contract

The application discovers program and lane data and renders the dashboard, coverage, reports, gadgets and MapStore. Light, Dark and Dusk themes are implemented. A JSON/TOML config selects the root and port. Opt-in finding metadata changes use the BBH writer, with local-only locking caveats documented. Source report writes remain disabled; the frontend can preview and retain an in-tab report draft but cannot save it. The separately committed private draft primitive is not connected or reviewed.

## Evidence and review

- Bootstrap: private GitHub repo created and read back; initial main and beta point to base commit.
- Tests and commands: `python3 -W error::ResourceWarning -m unittest discover -s tests -v` passed 32 tests, including the real BBH writer on a synthetic fixture; `npm ci --ignore-scripts` and `npm test` passed 26 frontend tests. Frontend-to-backend write uses a synthetic writer; a full browser-to-real-BBH test remains outstanding. An additional direct fixture setup timed out twice and a diagnostic retry was denied by the terminal safety gate; do not retry that workflow without user consent.
- Draft primitive: `python3 -W error::ResourceWarning -m unittest discover -s tests -p test_drafts.py -v` passed 6 tests, including retained-version identity, idempotent retries, permissions, corruption detection, and simultaneous saves. `python3 -W error::ResourceWarning -m unittest discover -s tests -p test_draft_failure.py -v` passed 1 additional injected fsync failure and recovery test. These are isolated unit/fixture tests; the primitive is not wired to the app or independently reviewed.
- Independent review: initial read-only foundation reviewed with blockers. A second independent review of the corrected candidate and draft primitive is in progress.
- Replay/cohort/fixture evidence: browser exercised the real HTTP server using a synthetic fixture root; selected a program and read/rendered a report. Eight actual lanes were sampled read-only for adapter compatibility; no target details copied into this repository.
- Merge/ancestry evidence: pending.

## Blockers and deferred work

- Report edits and ledger updates require verified owning write interfaces and inter-writer safety; if unsupported, keep disabled and document exact missing evidence and recovery step.
- Missing tests: full browser-to-server integration, source adapter compatibility, theme persistence, report save conflicts, safe Markdown rendering and cross-origin protections.
- Trigger: after backend and frontend workers complete their owned slices; integrate contracts and run isolated fixture-backed tests.

## Interruption / resume handoff

- Owning feature branch/ref: feat/initial-app.
- Latest immutable recovery checkpoint: a78781da5fabc8f678e3f8f3475ceee24503fe39.
- Feature implementation commit(s): 960ab0d6a50adf79bc23e23b1e2bb5208fb11ae8, b57fe7f362125474c315fcbd6e880ef70620886f, b9d113019cd4ee2009bf672d3ccefe993b8cf851, a78781da5fabc8f678e3f8f3475ceee24503fe39.
- Exact resume point: reconcile independent review; get operator decision for report autosave conflict policy and renewed GitHub authentication; obtain consent before repeating the terminal-blocked BBH fixture workflow. Finish missing integration, verification and re-review before beta integration.
- Working-tree state at handoff: clean after the dossier-only checkpoint commit. Latest local commits are not pushed because GitHub authentication returned 401.

## Decision gates

- Integration: verified tests and independent review, no unverified source writes.
- Activation: separate decision; loopback only unless separately authorized.
- Promotion: explicit user authorization for stable main.

## Decision record

- 2026-11-20 — feature begun; report autosave and Markdown rendering added to product direction.
