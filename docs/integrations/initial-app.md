# Initial application integration dossier

- **Status:** feature
- **Owner:** Hermes
- **Branch:** feat/initial-app
- **Base commit:** 553a06cebadd4fe9ded2213466a68510117060d9
- **Intended integration target:** beta
- **Last updated:** 2026-11-20
- **Owning feature branch/ref:** feat/initial-app
- **Latest immutable recovery checkpoint:** a03205127cd6502cf2299a891bfc74c4304c5433
- **Feature implementation commit(s):** 960ab0d6a50adf79bc23e23b1e2bb5208fb11ae8; a03205127cd6502cf2299a891bfc74c4304c5433 adds an intentionally failing config test.
- **Inspiration / canonical references:** `docs/product.md`; user-approved mockup; BBH ledger, coverage, MapStore and storage ownership skills.

## Intent

Provide a local-only, multi-theme bounty workspace over configured source roots. Keep the existing stores authoritative and keep real bounty records out of Git. Include rendered Markdown and safe report autosave where the actual source and writer guarantees support it.

## Implemented contract

The initial read-only application discovers program and lane data and renders the dashboard, coverage, reports, gadgets and MapStore. Light, Dark and Dusk themes are implemented. Source writes are disabled pending canonical-writer and concurrency validation; the frontend can preview and retain an in-tab report draft but cannot save it.

## Evidence and review

- Bootstrap: private GitHub repo created and read back; initial main and beta point to base commit.
- Tests and commands: `python3 -W error::ResourceWarning -m unittest discover -s tests -v` (14 passed before config test); `node --test static/tests/app.test.cjs` (14 passed with preinstalled Playwright/Chrome). `python3 -m unittest discover -s tests -p test_config.py -v` currently fails intentionally: `--config` is not yet implemented.
- Independent review: in progress; review agent assigned.
- Replay/cohort/fixture evidence: browser exercised the real HTTP server using a synthetic fixture root; selected a program and read/rendered a report. Eight actual lanes were sampled read-only for adapter compatibility; no target details copied into this repository.
- Merge/ancestry evidence: pending.

## Blockers and deferred work

- Report edits and ledger updates require verified owning write interfaces and inter-writer safety; if unsupported, keep disabled and document exact missing evidence and recovery step.
- Missing tests: full browser-to-server integration, source adapter compatibility, theme persistence, report save conflicts, safe Markdown rendering and cross-origin protections.
- Trigger: after backend and frontend workers complete their owned slices; integrate contracts and run isolated fixture-backed tests.

## Interruption / resume handoff

- Owning feature branch/ref: feat/initial-app.
- Latest immutable recovery checkpoint: a03205127cd6502cf2299a891bfc74c4304c5433.
- Feature implementation commit(s): 960ab0d6a50adf79bc23e23b1e2bb5208fb11ae8; config RED test a03205127cd6502cf2299a891bfc74c4304c5433.
- Exact resume point: implement `--config` until the config test passes, reconcile independent review, add canonical metadata write path, and investigate safe report autosave. Retest and re-review before beta integration.
- Working-tree state at handoff: clean after the dossier-only checkpoint commit.

## Decision gates

- Integration: verified tests and independent review, no unverified source writes.
- Activation: separate decision; loopback only unless separately authorized.
- Promotion: explicit user authorization for stable main.

## Decision record

- 2026-11-20 — feature begun; report autosave and Markdown rendering added to product direction.
