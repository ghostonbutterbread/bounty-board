# Tailnet access integration dossier

- **Status:** feature; integration review and activation pending
- **Owner:** parent integration agent
- **Branch / owning ref:** `feat/tailnet-access`
- **Base commit:** `f98430b0f2088df0b4809e610fdb5ca836b38d27`
- **Intended integration target:** `feat/initial-app`
- **Last updated:** 2026-11-20
- **Latest immutable recovery checkpoint:** none; changes intentionally uncommitted per delegation
- **Feature implementation commits:** none; parent owns commit and integration
- **Inspiration:** request for private Tailscale Serve and localhost access without exposing public internet or enabling writes

## Intent and implemented contract

Retain a loopback-only backend and existing local use. `--tailnet-host` or config `tailnet_host` opts in one validated canonical lowercase `node.tailnet.ts.net` hostname; exact matching HTTPS Origin only, with optional `:443` in Host. Duplicate Host, Origin and Fetch Metadata are rejected; requests must meet the documented browser-origin constraints. No CORS, forwarded-header authentication, public exposure, TLS, or application authentication is added. Tailscale Serve and its network policy control device access; all permitted devices can see sensitive records. Browser storage is origin-separated. Metadata editing remains off unless both pre-existing writer flags are supplied; report writes remain disabled. The requested deployment must omit both writer flags.

## Evidence and review

- Working-tree-only receipts, **not recoverable from branch history until committed**. `python3 -W error::ResourceWarning tests/safe_suite.py`: 44 passed, real BBH test excluded by the safe runner. Synthetic loopback CLI tests exercise the host/origin checks and a synthetic writer boundary; they do not exercise an actual Tailscale proxy.
- RED/GREEN observed for duplicate headers (200 instead of 403), CLI opt-in (unrecognized option), exact host (403 instead of 200), and invalid null config (accepted instead of rejected), followed by passing focused tests.
- `npm test`: 58 passed, with the existing synthetic-writer browser integration explicitly excluded by the repository's exact skip pattern. A disposable canary established that exclusion before the suite. Offline `npm ci --ignore-scripts` failed with `ENOTCACHED`; the run used the existing, read-only `/home/ryushe/projects/bounty-board-initial/node_modules` through `NODE_PATH`, with Playwright and playwright-core both 1.60.0, and `/usr/bin/google-chrome`.
- Independent complete-diff security review found no request-boundary blocker; parent reran 44 safe Python tests and 58 browser tests. A pre-existing static-cache documentation mismatch was corrected. Real proxy, policy and TLS remain unverified. No running-service modification, real BBH invocation, or Tailscale configuration has occurred.

## Blockers and deferred work

- **Missing evidence:** review of complete dirty diff and actual private Tailscale Serve / browser end-to-end test, including access control and proxy Host/Origin behavior.
- **Trigger / environment:** parent acceptance and explicit runtime activation, with approved tailnet policy, DNS/certificates, route inventory, and a safe synthetic dataset. Verify localhost and tailnet access, rejection of unauthorized devices, absence of Funnel/public access, and read-only capabilities. Exact commands depend on approved service and existing Serve state; inspect `tailscale serve status` first.
- **Impact:** blocks activation claim and any assertion that the actual proxy/device workflow was verified. The test-only HTTP client supplies simulated external headers directly to an isolated local server; no tailnet auth or TLS is tested.
- **Next step:** parent reviews and commits the feature, updates this dossier to a reachable checkpoint, performs authorized integration into `feat/initial-app`, and owns all activation. Remove this branch-local dossier at integration per repository policy.

## Interruption / resume handoff

- **Working-tree state:** intentionally uncommitted; user forbids commits and pushes for this delegation. Preserve all changes.
- **Exact resume point:** inspect the complete diff including untracked `tests/test_tailnet.py` and this dossier, perform independent review, then parent decides integration and activation.

## Decision gates

- **Integration:** independent review and parent-owned commit/merge; repeat safe tests as appropriate against integrated tree.
- **Activation:** parent explicitly authorizes, checks network policy and existing Serve configuration, keeps writer flags absent, then validates the actual HTTPS device path with synthetic data.
- **Promotion:** parent-owned; no public Funnel and no unsupported security claims.

## Decision record

- 2026-11-20 — isolated implementation and synthetic verification; integration and activation pending.
