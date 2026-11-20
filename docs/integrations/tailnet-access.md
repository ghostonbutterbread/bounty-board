# Tailnet access integration dossier

- **Status:** feature; integration review and activation pending
- **Owner:** parent integration agent
- **Branch / owning ref:** `feat/tailnet-access`
- **Base commit:** `f98430b0f2088df0b4809e610fdb5ca836b38d27`
- **Intended integration target:** `feat/initial-app`
- **Last updated:** 2026-11-20
- **Latest immutable recovery checkpoint:** `6835b29af4b1583c2eb1b195b64159881cf78c6b`
- **Feature implementation commits:** `6835b29af4b1583c2eb1b195b64159881cf78c6b`
- **Inspiration:** request for private Tailscale Serve and localhost access without exposing public internet or enabling writes

## Intent and implemented contract

Retain a loopback-only backend and existing local use. `--tailnet-host` or config `tailnet_host` opts in one validated canonical lowercase `node.tailnet.ts.net` hostname; exact matching HTTPS Origin only, with optional `:443` in Host. Duplicate Host, Origin and Fetch Metadata are rejected; requests must meet the documented browser-origin constraints. No CORS, forwarded-header authentication, public exposure, TLS, or application authentication is added. Tailscale Serve and its network policy control device access; all permitted devices can see sensitive records. Browser storage is origin-separated. Metadata editing remains off unless both pre-existing writer flags are supplied; report writes remain disabled. The requested deployment must omit both writer flags.

## Evidence and review

- `python3 -W error::ResourceWarning tests/safe_suite.py`: 44 passed, real BBH test excluded by the safe runner. Synthetic loopback CLI tests exercise the host/origin checks and a synthetic writer boundary; they do not exercise an actual Tailscale proxy.
- RED/GREEN observed for duplicate headers (200 instead of 403), CLI opt-in (unrecognized option), exact host (403 instead of 200), and invalid null config (accepted instead of rejected), followed by passing focused tests.
- `npm test`: 58 passed, with the existing synthetic-writer browser integration explicitly excluded by the repository's exact skip pattern. A disposable canary established that exclusion before the suite. Offline `npm ci --ignore-scripts` failed with `ENOTCACHED`; the run used the existing, read-only `/home/ryushe/projects/bounty-board-initial/node_modules` through `NODE_PATH`, with Playwright and playwright-core both 1.60.0, and `/usr/bin/google-chrome`.
- Independent complete-diff security review found no request-boundary blocker; parent reran 44 safe Python tests and 58 browser tests. A pre-existing static-cache documentation mismatch was corrected.
- Actual authorized synthetic proxy verification: user reaffirmed consent; a synthetic-only ledger and report were created in a private scratch root, and the candidate backend was started on loopback port 19001. `tailscale serve` HTTPS :443 routed only to that synthetic server; self-browser rendered the synthetic dashboard, HTTPS `/api/data` returned 200 with the synthetic finding, hostile cross-site Origin returned 403, and PATCH with writes disabled returned 503. `tailscale funnel status` reported tailnet only. A different device and inaccessible/non-tailnet clients have not been tested. Initial TLS handshake timed out while certificate startup was pending, then succeeded.

## Blockers and deferred work

- **Missing evidence:** independent second-device tailnet browser access, denied-device/non-tailnet rejection, and actual sync conflict retention. The synthetic ledger and loopback setup previously timed out at the safety gate; Ryushe explicitly reapproved it, and it was then successfully exercised. Remote sync inspection was separately blocked and must not be bypassed.
- **Trigger / environment:** parent acceptance and explicit runtime activation, with approved tailnet policy, DNS/certificates, route inventory, and a safe synthetic dataset. Verify localhost and tailnet access, rejection of unauthorized devices, absence of Funnel/public access, and read-only capabilities. Exact commands depend on approved service and existing Serve state; inspect `tailscale serve status` first.
- **Impact:** synthetic self-access through TLS works; client policy and separate-device behavior remain unverified and must not be claimed. A tailnet-only status is not an independent external Internet reachability test.
- **Next step:** switch the existing read-only local owner to the reviewed code, point Serve at it, verify both origins and remain explicit about untested independent-device policy. Integrate into `feat/initial-app` separately; keep beta/main unchanged.

## Interruption / resume handoff

- **Working-tree state:** implementation committed at `6835b29af4b1583c2eb1b195b64159881cf78c6b`; this dossier-only checkpoint records the safety block.
- **Exact resume point:** switch the existing read-only service to `6835b29` with `--tailnet-host ghostonbread.taildb09a3.ts.net`, switch tailnet Serve from synthetic port 19001 to real loopback port 9001, and verify; then stop the synthetic test service. Do not retry blocked remote sync inspection without approval.

## Decision gates

- **Integration:** independent review and parent-owned commit/merge; repeat safe tests as appropriate against integrated tree.
- **Activation:** parent explicitly authorizes, checks network policy and existing Serve configuration, keeps writer flags absent, then validates the actual HTTPS device path with synthetic data.
- **Promotion:** parent-owned; no public Funnel and no unsupported security claims.

## Decision record

- 2026-11-20 — isolated implementation and synthetic verification; integration and activation pending.
