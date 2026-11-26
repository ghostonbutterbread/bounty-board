# Sandbox terminal

- Branch: `feat/board-sandbox-terminal`; base `c5cd47c`.
- Owner surfaces: `terminal_service.py` and `terminal_*.py` (separate process), `sandbox/` (image), `static/modules/sandbox-terminal.js|css` (drawer and code-block controls), `static/vendor/xterm/` (xterm.js 5.5.0 + addon-fit 0.11.0, MIT, unmodified).
- Ryu's request, short: from the report view, open a small sandboxed terminal already in the report's folder, run the PoC steps from the report with play buttons, tick them off, and save the output. Usable from several devices. Play buttons and check marks must never end up in the report text. Tailnet access for his account; otherwise a username and password.
- Lifecycle change (approved by Ryu): sandboxes pause instead of closing, so coming back to a report resumes the same shell; removal only after 4 hours without a viewer.
- Course correction (Ryu): "I want simplicity... what happens when I want to update the PoC, does the agent have to remember to recopy?... seamless integration where I can have the agent improve it then see it immediately." The report folder is therefore **bind-mounted read-write**, not copied.

## How it works

```
browser (Board origin https://<node>:9001)
  ├─ /            → Tailscale Serve → app.py (127.0.0.1:9001)   [unchanged, plus --terminal-url]
  └─ /terminal/*  → Tailscale Serve → terminal_service.py (127.0.0.1:9011)
                                        ├─ auth (tailnet allowlist or password session)
                                        ├─ check marks (SQLite in its state dir)
                                        ├─ sessions: one per report, one PTY each ("docker exec -it")
                                        ├─ filtering egress proxy (one Unix socket per session)
                                        └─ Save output as evidence (writes validation/ itself)
                                     docker run per report:
                                        --network none, --read-only, --cap-drop ALL, no-new-privileges,
                                        --user <host uid:gid>, pids/memory/CPU limits, --init,
                                        tmpfs /tmp and /home/sandbox,
                                        mounts: <report folder> → /report (rw), proxy socket dir → /run/bbterm (ro)
                                        in-container forwarder 127.0.0.1:3128 → /run/bbterm/proxy.sock
```

- **Drawer.** In the report view a Terminal button (in the live editor bar, or under the Reports heading in the non-live view) and Ctrl+` toggle a bottom drawer. It is resizable (drag or arrow keys on the handle), remembers open state and height per browser (`localStorage` `bounty-board-terminal:v1`), and is a full-width sheet on phones (60% of the screen by default). Status line: Connected / Connecting / Reconnecting / Sign-in needed / Service unavailable (its tooltip says when the sandbox pauses and is removed; the header itself stays quiet), session age, viewer count, mounted folder, "N of M steps checked", Reset sandbox (two-step confirm), Save output as evidence, Close. EasyMDE's full-screen side-by-side mode is shortened so the drawer never covers it.
- **Play buttons and check marks.** The module decorates every `<pre>` in the rendered preview (`.editor-preview`, `.editor-preview-side`, `#report-preview`) with a Board-only bar: language label, ▶ (types the block, no Enter; Shift+click also sends Enter), Run (shown for shell-like languages: none, shell, bash, sh, zsh, console, shell-session, terminal, curl), and a Checked box. Every block gets ▶ and Checked, whatever its language. Text goes in through xterm's `paste()`, so multi-line blocks use bracketed paste when the shell has it on (bash does) and arrive as one command. `console`-style blocks type only their `$ ` lines. `app.js`'s Markdown renderer now adds `data-lang` to `<pre>` (one-line change).
- **Nothing reaches the report.** Controls exist only in the preview DOM (never in the editor or the file), carry `user-select: none`, and a `copy` handler strips them from any selection, both text and HTML. The browser test checks the file and the editor value are byte-identical after typing, running and checking, and that a copy of the whole preview contains no control text or markup.
- **Check state.** Stored by the terminal service in `<state-dir>/checks.sqlite3`, keyed by report selector and block key `sha256(normalised text)[:32]:<n>` (n counts earlier identical blocks). Editing a block resets only that block; moving blocks keeps their marks; duplicates are told apart by order. Normalisation ignores trailing whitespace and leading/trailing blank lines. `terminal_checks.block_keys` (Python) and `blockKeys` (browser, synchronous SHA-256) are the same; the browser test asserts equality on the fixture. Shared across devices (5 s poll plus window focus), survives restarts; max 500 keys per report.
- **Sessions.** One per report selector (family, program, lane, path), created on first attach, shared by every viewer: output fans out to all, input from any, a new viewer gets the last 256 KiB of output first. The service owns the PTY, so closing tabs does not kill the shell. Each viewer has its own send queue (a slow phone is dropped at 4 MiB backlog instead of stalling the shell). If the shell exits, Enter starts a new one in the same container. Reset sandbox recreates the container. Stop closes everything; start reaps containers whose name has the prefix **and** that carry the label `org.bountyboard.terminal.prefix=<prefix>`, so **a service restart drops paused sessions** (files are kept; the next open starts a fresh sandbox).
- **Lifecycle: running → paused → removed** (`SessionManager`, one reaper pass every 10 s):
  - *running*: at least one viewer, or no viewer for less than `--pause-after` (default 300 s, the grace period for a reload or a quick switch);
  - *paused*: `docker pause` (cgroup freezer: processes stop, memory stays) once no viewer has been attached for `--pause-after`. Opening the report again runs `docker unpause` and reattaches to the **same** session: same shell process, cwd, history, background jobs and scrollback, no visible restart; the drawer shows a short "Resumed" toast;
  - *removed*: `docker rm -f` once no viewer has been attached for `--remove-after` (default 4 h, measured from when the last viewer left, paused or not). The next open creates a fresh sandbox and says "This sandbox was removed after 4 hours idle; started a fresh one." Files persist because the folder is mounted.
  - Capacity `--max-sessions` (default 12, 1 to 32): when a new report needs a sandbox and the cap is reached, the paused sandbox whose last viewer left longest ago is removed first, then a running viewerless one; never one with a viewer. If every slot has a viewer: "All 12 sandboxes have someone attached. Close the terminal on another report and try again."
  - Memory guard: before creating a sandbox (new, recreated or reset) the service reads `MemAvailable` from `/proc/meminfo` and refuses below `--min-free-memory` (default 2 GiB; `0` disables): "Hoster is low on memory (1.5 GB free); close a terminal or try later." Unpausing is always allowed.
  - Races: lock order is always session lock, then manager lock; the reaper re-checks viewers and timers under the session lock, so a viewer arriving while a pause is in flight waits for it and then unpauses (tested). Pause, unpause and removal are idempotent ("already paused" / "not paused" count as success). A failed pause is logged to stderr and retried on the next pass. A container that vanished outside the service is treated as removed: a pause marks the session removed; an attach (paused or running) recreates it with "The previous sandbox was gone; started a fresh one."
  - `--idle-timeout` still works as the old name of `--remove-after`.
- **Mounted folder** (`terminal_sandbox.resolve_mount`, re-resolved on every session start and reset):
  Follows the BBH report packet format: each finding has a packet folder `reports/<FID>-<slug>/` (or legacy `reports/<FID>/`) holding `EVIDENCE.md`, the submission report `<target-domain>-<vuln-type>-<FID>.md`, optional `poc.py`/`poc.<ext>` and `_meta/`. Files directly in `reports/` (active.md, confirmed.md, index/, severity/, categories/, daily/ ...) are generated navigation.
  1. **Report inside a packet folder** `reports/<FID>[-slug]/...` → that packet folder; the shell starts at the packet root. Exact-FID rule: the folder name is a ledger FID verbatim (case and punctuation) or that FID, `-`, and a lowercase slug (`[a-z0-9]+` joined by single `-`). `D10-xss` never belongs to D1; `D1-Bad-Slug`, `D1_odd`, `D1-`, `D1--double`, `d1-lower` and `D100-x` (no FID D100) are not packets; when two FIDs match (AC and AC-1 for `AC-1-idor`) the longer wins. The FID must be in the lane's `ledgers/ledger.json`: without the ledger the end of the FID cannot be known.
  2. **Report elsewhere mapped to a ledger finding** (legacy `reports/findings/<bucket>/<FID> - title.md`, a file directly in `reports/`), by the finding's `report_path`/`evidence_path` or by an exact `<FID> - …` / `<FID>.md` file name → that finding's packet: its `report_dir` when that is a packet folder for the same FID directly under `reports/`, else the legacy `reports/<FID>/`, and only if it exists. The drawer says "Opened the finding folder reports/D10-xss/ (D10, from the ledger)."
  3. **Anything else** (navigation pages, unmapped files, a ledger finding whose packet folder is missing) → the Terminal button is disabled with "This report is not inside a finding folder (reports/<FID>-…/)." (`GET /api/mount` tells the Board before anyone clicks; the play buttons are disabled with the same reason; check marks still work). No folder is ever created, and `reports/` and the lane are never mounted.
  Every component from the data root down is opened with `O_NOFOLLOW` (no symlinks anywhere), the lane root and `reports/` itself are never mounted, dot names are refused, and paths with commas, quotes or control characters are refused (Docker's `--mount` syntax). After `docker run`, the path is checked again to still be the same directory (device and inode) reached without symlinks, otherwise the container is removed. A viewer attaching to a session whose folder was moved or renamed sees "The report folder moved or was renamed. Reset sandbox to open the new location."
- **Ownership.** The container runs as the host user's UID:GID (`--user`), with HOME a tmpfs owned by that UID, so files created in `/report` belong to the host user and sync like any other report file. Build the image with matching `UID`/`GID` build args so the user has a name in the container.
- **Network.** `--network none`; the only way out is the service's filtering proxy, reached through the per-session socket and the in-container forwarder on 127.0.0.1:3128. `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY=socks5h://…` (and lower-case), `NO_PROXY=localhost,127.0.0.1,::1`, `NODE_USE_ENV_PROXY=1` are set, so curl, wget, Python requests/urllib, httpie and Go tools work. The proxy speaks HTTP CONNECT, absolute-form HTTP (one request per connection) and SOCKS5 CONNECT. It resolves names itself, refuses the whole name if any answer is non-global, connects only to the vetted address (no rebinding), and vets every connection. Refused: loopback, RFC 1918, CGNAT 100.64.0.0/10 (Tailscale), link-local incl. 169.254.169.254, IPv6 ULA incl. fd7a:115c:a1e0::/48, multicast, unspecified/reserved, plus IPv4 embedded in mapped, NAT64, 6to4 and Teredo addresses.
- **Save output as evidence.** The service (never the container) writes the session transcript (ANSI stripped, each line stamped with its arrival time, header with report and times, capped at 1 MiB keeping the newest output) to `<mounted folder>/validation/terminal-YYYYMMDD-HHMMSS.txt`: directories opened with `O_NOFOLLOW` from the root, `validation/` must not be a symlink, the file is created with `O_EXCL|O_NOFOLLOW` (a planted symlink at the name is skipped, never followed), and it refuses with "The Board data folder is read-only" when the root or folder is not writable. The drawer then reloads the artifacts panel (the file is listed for dedicated folders).

## Preview ports (opt-in, `--preview-ports`)

Full design, contract and limits: [`sandbox-ports.md`](sandbox-ports.md). Short version: an in-container agent dials out to a host-owned `ports.sock` (0600, created through `/proc/self/fd/<dir_fd>/` in the same read-only `/run/bbterm` directory as `proxy.sock`) and reports listening TCP ports; the service exposes each on `127.0.0.1:<9100-9199>` and, when the `ports_tailscale` setting is on, on the Tailscale IPv4 too. The container keeps `--network none` and exactly two mounts; the egress proxy filter is unchanged.

Threat model additions:
- **Newly reachable:** with the flag on, ports a sandbox listens on are reachable from local processes on the host (127.0.0.1). With the Tailscale setting on, also from every tailnet peer the ACLs allow, **with no Board auth**. Never on 0.0.0.0 or ::, never the control API port, never the sandbox's proxy port 3128.
- **Origin isolation:** previews are `http://<ip>:<port>`, a different origin from the Board, so they cannot read or write it; the terminal cookie is `Secure` and `Path=/terminal`, so it is never sent to them.
- **No new reach for the sandbox:** it still cannot reach host loopback, LAN or tailnet, its own exposed ports included (real-container test: 403 through the proxy).
- **No host-side connects:** the host only accepts (on its listeners and on `ports.sock`); `terminal_ports.py` has no connect call (tested). A malicious agent can only answer opens with bytes from inside the container. Its control stream is strictly parsed and capped (see sandbox-ports.md).
- Forwarded traffic keeps a sandbox from pausing and a connection unpauses it; removal still counts 4 h from the last terminal viewer.
- Availability (review round 1): 16 forwarded connections per client IP across sessions, fair-share eviction at the global cap, idle connections closed under pressure. Switching Tailscale off closes its listeners before saving (fails closed). `auto` binds only an address on a `tailscale*` interface.

## Access control (terminal service only)

- Allowed without password: request came through Serve (Host is the configured Board authority from `--allowed-origin`) **and** carries exactly one `Tailscale-User-Login` in the `--allow-tailnet-user` list (case-insensitive). The header is trusted only because the service binds to 127.0.0.1 (hard-coded) and Serve sets/replaces that header; a request straight to 127.0.0.1:9011 has a different Host and is not trusted by header. **Assumption:** local processes on Hoster are trusted, as for the Board itself (any local process could forge the headers).
- Otherwise the login page (`/terminal/login`, styled with the Board's `style.css` and theme): username `ryushe`, password verified against an scrypt hash (N=2^15, r=8, p=1) read from a 0600 file owned by the service user (`--password-hash-file`). Plaintext is never stored or logged; request logging is off entirely. Session cookie `bbterm_session`: 256-bit random, `HttpOnly; Secure; SameSite=Strict; Path=/terminal; Max-Age=43200`, server-side store (in memory: a service restart signs everyone out), Sign out on the login page. Username and password compared in constant time; unknown usernames spend the same scrypt time. 5 failures in 15 min lock password logins for 15 min (global, because behind Serve every client is 127.0.0.1; allowlisted tailnet users are unaffected).
- Every WebSocket upgrade and state change needs `Origin` equal to an allowed origin whose authority is the request's Host; state changes also need `X-Requested-With: Bounty-Board` and a JSON body; `Sec-Fetch-Site` must be same-origin when present. No CORS headers, OPTIONS returns 405. Allowed origins must be `https://…` (or `http://127.0.0.1|localhost:<port>` for tests) and cannot be the service's own port.
- The Board shows the terminal only when started with `--terminal-url /terminal/` (capability `terminal_url`); when the service is down the drawer says so, the check boxes are disabled with a tooltip, and the editor keeps working.

## Threat model: what is and is not isolated

A command run in the terminal **can**:
- read, modify and **delete any file in that one report folder** (that is the point). Syncthing propagates those changes, deletions included, to every synced device. Report Markdown has the live editor's history (`--live-edit-dir`) as a safety net; other files in the folder (PoCs, screenshots, captures) do not. Keep important artifacts in git or another backup.
- create symlinks in the folder. The Board never follows them (artifacts and evidence use `O_NOFOLLOW`) and Syncthing syncs them as links, but other host tools that follow links could be pointed at host paths. Do not run untrusted host tools over a folder after running untrusted code in it.
- fill the folder (no disk quota on the bind mount), use its CPU/memory/pids allowance, and reach any public internet address through the proxy.

It **cannot** (enforced and tested):
- see any other folder of the data root, the parent folders, the host's home, SSH keys, BBH, the Docker socket or any secret: the only mounts are the report folder and a read-only directory holding the proxy socket;
- reach the host, the Docker bridge gateway, the LAN, the tailnet or cloud metadata: no network interface but loopback, and the proxy refuses those addresses;
- gain privileges: no capabilities, no-new-privileges, default seccomp and AppArmor, read-only root filesystem, host UID (not root);
- persist outside the folder: /tmp and HOME are tmpfs and vanish with the container.

Not covered:
- Raw TCP/UDP that ignores proxy variables, ICMP and DNS do not work (`ping`, `dig`, `nc host port` direct). Use `curl`, `ncat --proxy 127.0.0.1:3128 --proxy-type http`, or `socat - PROXY:127.0.0.1:host:port,proxyport=3128`.
- The proxy allows every port on public addresses (the address filter is the boundary).
- Docker resolves the mount path itself; the post-start identity check narrows but does not remove a race where a local process swaps a path component for a symlink at that instant.
- An authenticated user can open a sandbox for any report (one researcher; no per-report permissions).

## Security review (9235727): findings and fixes

An independent review of `9235727` returned BLOCK. Every item is fixed with a regression test. Each test was run against an export of `9235727` and failed there; on the old code, tests that pass options it lacks were run in a scratch copy with only those options removed. All pass on the fixed code.

| # | Finding | Fix | Regression test (old code → new code) |
| --- | --- | --- | --- |
| 1 | Parallel logins exhausted memory: each scrypt verify allocates about 32 MiB and nothing bounded concurrent verifications or request threads (100 parallel logins reached 1.48 GiB). | At most 2 scrypt verifications at once behind a non-blocking semaphore (`429 {error: busy}` otherwise). A failure slot is reserved under the lock before hashing, so parallel attempts cannot overrun the 5-failure lockout. The service accepts at most 64 connections at once and answers the rest `503` at accept time instead of starting a thread. | `test_terminal_sandbox.AuthTests.test_parallel_logins_are_bounded_and_respect_lockout` (50 concurrent verifies → max 2, ≤ 5 failed guesses, then locked); `test_terminal_service.HardeningTests.test_parallel_logins_run_at_most_two_scrypt_verifications` (33 concurrent → ≤ 2); `HardeningTests.test_connection_cap_refuses_floods` (no 503, hang → 503 at the cap, slots released) |
| 2 | The type-only play button could run hidden commands: xterm's `paste()` wraps text in `ESC[200~ … ESC[201~` without escaping, so a block containing `ESC[201~` ended bracketed paste and the following lines ran. Reproduced on the old code: clicking ▶ on such a block created a marker file. | Before any typing path (▶, Run, Shift+click) the module refuses text containing ESC, any C0 control other than tab and newline, DEL, or C1 controls (U+0080 to U+009F). The block shows "This block contains control characters and cannot be typed; copy it manually after review.", its buttons are disabled, and the guard also holds if a button is forced on. Typing strips trailing newlines. A multi-line block is typed without Run only when the shell has bracketed paste on. | `static/tests/sandbox-terminal-filter.test.cjs` (unit test of the filter; old: missing); browser `blocks with control characters cannot be typed…` (warning shown, buttons disabled, forced clicks send nothing, no marker file; the safe block types without Enter and Run runs it) |
| 3 | A client that stops reading was never dropped: the sender blocked in `sendall` holding the WebSocket send lock, and the pinger's `close()` waited on the same lock. | The socket gets a send/receive timeout (`PEER_TIMEOUT`) after the upgrade; `WebSocket.abort()` shuts the socket down without the send lock; the pinger and viewer-overflow paths call it. | `test_terminal_ws.FrameTests.test_abort_releases_a_sender_blocked_on_a_stalled_peer`; `HardeningTests.test_stalled_viewer_is_dropped` (old: 2 viewers after 25 s → new: the stalled one is detached, the reading one stays) |
| 4 | One sandbox could use every slot of the shared 64-connection egress proxy. | A per-session cap of 24 connections, on top of the global 64. | `test_terminal_proxy.ProxyTests.test_per_listener_cap_leaves_room_for_other_sandboxes` |
| 5 | The proxy had no deadline for the request head or SOCKS handshake (a slow trickle reset the per-recv timeout). | A total 20 s handshake deadline, separate from the idle timeout. | `ProxyTests.test_handshake_has_a_total_deadline` |
| 6 | Open redirect after sign-in: `next=/%09/evil.example` passed the regex (the tab is stripped by the URL parser, leaving `//evil.example`). | `next` is parsed with `new URL(value, location.origin)`; only this origin's `/` or `/terminal/…` are allowed, otherwise `/`. | browser test, second half (sign-in with that `next` stays on the Board origin at `/`) |
| 7 | Logout or session expiry did not end an open WebSocket. | The pinger re-checks password sessions every ping and closes with 1008 ("Signed out. Sign in again to use the terminal."). | `HardeningTests.test_logout_ends_the_open_websocket` |
| 8 | The attach-error path waited forever in `ws.recv()`. | 5 s for the client's close, then the socket is dropped. | `HardeningTests.test_attach_error_does_not_wait_forever` (old: still open after 10 s) |
| 9 | Zero-length continuation frames grew memory without limit. | At most 1024 frames per message, then close 1009. | `test_terminal_ws.FrameTests.test_zero_length_continuations_are_capped` (+ `test_fragment_cap_allows_normal_fragmentation`) |
| 10 | Deprecated IPv6 forms were not blocked, and the host's own addresses (its public IP) were reachable. | `::/96` (IPv4-compatible), `::ffff:0:0:0/96` (SIIT) and `fec0::/10` (site-local) are refused; the proxy also refuses every address assigned to the host, read from `/proc/net/fib_trie` (IPv4 LOCAL) and `/proc/net/if_inet6`, refreshed every minute (stdlib only). | `AddressAllowedTests.test_table` (6 new refused addresses); `ProxyTests.test_host_own_addresses_are_refused`; `ProxyTests.test_local_addresses_reads_proc` |
| 11 | The post-start mount check (host side) could not see a symlink swap that was undone in time. | After `docker run`, `docker exec <c> stat -c %d:%i /report` must equal the device and inode recorded when the host path was opened without symlinks; otherwise the sandbox is removed. | `test_terminal_docker.test_095_mount_identity_checked_inside_container` (real container; a wrong identity is refused and the container is gone) |
| 12 | Proxy socket mode 0666. | 0600: the container runs as the service's UID, so it can still connect. | `ProxyTests.test_listen_unix_mode`; `test_095` checks the live socket is 0600 and `test_06_network_policy` shows the container still gets out through it |

## Security review 2 (0e6566a): findings and fixes

A second review confirmed the 12 fixes above and returned BLOCK on two problems they introduced, plus one low. Each new test failed on an export of `0e6566a` (the N1 tests in a scratch copy with only the new options removed) and passes on the fix.

| # | Finding | Fix | Regression test (old code → new code) |
| --- | --- | --- | --- |
| N1 (blocker) | The 64-connection cap was taken at accept time and nothing timed a connection out before the WebSocket upgrade: 64 unauthenticated `POST /api/login` with `Content-Length: 65536` and no body locked everyone out of the terminal indefinitely (the allowlisted tailnet user got 503 at +0, +30 and +120 s). | One request per connection, `Handler.timeout = 10` s per read or write, and one 10 s deadline for the whole head and body (a watchdog shuts the socket). Admission happens *after* the head is parsed: requests with an allowlisted tailnet header or a valid session cookie take one of 64 slots, all others one of 8, so anonymous traffic can never take the slots identified users and WebSockets need. Connections still sending their head count as pending, and the oldest pending one is evicted when 128 wait. | `test_terminal_service.HardeningTests.test_stalled_anonymous_posts_cannot_lock_out_the_tailnet_user` (reviewer repro; old: tailnet user 503 → new: 200, the extra anonymous requests get 503 at once, the held ones are cut at the deadline); `HardeningTests.test_slow_request_heads_are_evicted_not_hoarded` (old: 503 → new: 200 with 3× the pending limit of unfinished heads); `HardeningTests.test_identified_cap_still_applies` |
| N2 (blocker) | The host's-own-address block compared only the literal address: `::ffff:<own IPv4>` (IPv4-mapped, reachable through an AF_INET6 socket) and `64:ff9b::<own IPv4>` (NAT64) passed. | `::ffff:0:0/96` is refused outright (`blocked_address`); the own-address check also compares every IPv4 embedded in an IPv6 address (mapped, NAT64, 6to4, Teredo), the same normalisation the private-range check uses. `local_addresses()` logs a warning to stderr when `/proc/net/fib_trie` or `/proc/net/if_inet6` cannot be read. | `test_terminal_proxy.ProxyTests.test_host_address_block_covers_mapped_and_nat64_forms` (reviewer repro; old: `200 HOST-SERVICE-REACHED` via `[::ffff:127.0.0.1]` → new: 403); `AddressAllowedTests.test_table` (`::ffff:8.8.8.8`, `::ffff:1.1.1.1` refused); `ProxyTests.test_local_addresses_warns_when_proc_is_unreadable` |
| N3 (low) | Bidi and invisible characters passed the type filter: with isolates the preview showed `echo hi#; touch …` as a comment while Run executed `touch`. | The refusal set now also covers U+00AD, U+061C, U+200B to U+200F, U+202A to U+202E, U+2060 to U+2069, U+FEFF, U+2028 and U+2029, for every typing path, with the same visible warning. | `static/tests/sandbox-terminal-filter.test.cjs` "bidi and invisible characters make a block untypeable (review N3)" (reviewer's trojan block; old: allowed → new: refused) |

Not changed (accepted by the reviewer): the host-address list refreshes every 60 s; with 24 connections per sandbox under a global 64, three busy sandboxes of the one user can still fill the proxy.

## Contract

| Route (also without the `/terminal` prefix) | Auth | Purpose |
| --- | --- | --- |
| `GET /healthz` | none | `{ok: true}` |
| `GET /login`, `/login.js`, `/login.css` | Host check | password page (CSP `default-src 'none'`, `frame-ancestors 'none'`) |
| `GET /api/status` | yes, else 401 `{error: login_required, login_url}` | `{user, method: tailnet\|password, pause_after, remove_after, idle_timeout (= remove_after), max_sessions, preview_ports, ports_tailscale}` |
| `POST /api/login` `{username, password}` / `POST /api/logout` | Origin + CSRF header | 200 + cookie; 401 invalid, 429 locked, 403 disabled |
| `GET /api/checks?family&program&lane&path` | yes | `{checks: {key: epoch}}` |
| `POST /api/checks` `{family, program, lane, path, key, checked}` | yes + Origin + CSRF | `{checks}`; 400 bad key, 409 cap reached |
| `GET /api/mount?…` | yes | `{ok: true, folder, fid, rule: packet\|ledger, reason}` or `{ok: false, code: not_in_packet\|unsafe_folder\|report_not_found, message}` |
| `GET /api/session?…` | yes | `{session: info or null}` |
| `POST /api/reset` `{selector}` | yes + Origin + CSRF | `{session}` |
| `POST /api/evidence` `{selector}` | yes + Origin + CSRF | `{relative, name}`; 409 no session / read-only root / unsafe folder |
| `GET /api/settings` / `POST /api/settings` `{ports_tailscale}` | yes (POST + Origin + CSRF) | preview-ports settings; see sandbox-ports.md |
| `GET /api/ports?…` | yes | `{ports, preview_ports, ports_tailscale}`; see sandbox-ports.md |
| `GET /ws?…` (WebSocket) | yes + Origin | client text `{"t":"in","d":…}`, `{"t":"resize","cols","rows"}`; server binary = terminal output, text = `hello{session}`, `viewers{count}`, `reset`, `exit`, `error{code,message}`, `closed{message}` |

Session info: `{id, created, pause_after, remove_after, idle_timeout, folder, workdir, mount_reason, mount_rule, fid, viewers, notes, running, paused, ports}` (`ports` is `[]` unless `--preview-ports`; the WebSocket also sends `{"type":"ports","ports":[…]}` on change). The WebSocket `hello` carries `event`: `started`, `attached`, `resumed`, `recreated_idle`, `recreated_vanished` or `reset`. Errors on attach include `low_memory` and `too_many_sessions`.

WebSocket server (`terminal_ws.py`, RFC 6455, server side only, no extensions/subprotocols): client frames must be masked; RSV bits, unknown opcodes, fragmented or >125-byte control frames, continuation without start, a new data frame mid-message and 64-bit lengths with the MSB set close with 1002; frames or messages over 256 KiB close with 1009 before the payload is read; invalid UTF-8 text or close reason closes with 1007; close codes are validated and echoed; pings are answered; the service pings every 20 s and drops peers silent for 75 s. A standard library has no WebSocket server, and the alternatives (polling, SSE plus POST) would add latency for keystrokes, so a minimal strict implementation with 35 unit tests was chosen.

`app.py`: new `--terminal-url` (same-origin path such as `/terminal/`, validated), exposed as `capabilities.terminal_url`. Nothing else in the Board changed except the `data-lang` attribute in `markdown()` and one CSS rule that themes EasyMDE preview code blocks (they were light grey with light text in dark/dusk).

## Decisions

- Mount, not copy (Ryu's correction): edits are seamless in both directions; the price is that the terminal can change and delete files in that folder.
- Mount only finding packet folders (Ryu's correction): no folders are created; navigation pages and unmapped files get a disabled Terminal button with the reason. An earlier version created `reports/<name>/` folders next to flat reports; that code and its tests are removed.
- Separate process, own systemd unit, loopback only; shell-capable code never runs inside app.py.
- Filtering forward proxy over a mounted Unix socket instead of host firewall rules (no sudo on Hoster).
- Check marks in the terminal service, not the Board, so the Board stays free of new write endpoints; when the service is down the marks are unavailable (shown disabled).
- Pause instead of close (Ryu approved): an idle sandbox measured about 16 MB and pause/unpause about 0.1 s here, so keeping 12 paused sandboxes costs little and coming back is instant. At the cap, paused sandboxes are removed before running ones and attached ones never.
- Memory guard on creation only; unpausing never refuses, because the memory is already held.
- Ryu kept the folder mounted read-write and no extra image tools.
- Login lockout is global (no trustworthy client address behind Serve).
- Debian `stable-slim` base. Debian's Node is older than the release that honours `NODE_USE_ENV_PROXY` (Node 24 / 22.21), so plain Node `fetch` may ignore the proxy; curl, Python and httpie honour it.

## Evidence

Run on Ghost with `TMPDIR=/home/ryushe/.hermes/cache/scratch/bb-agents/term`, synthetic data only, on a shared machine at load average 15 to 22 on 6 CPUs.

New tests (all with `-W error::ResourceWarning`):
- `tests.test_terminal_ws`: 35 OK. Handshake rejections, RFC accept key, masked round-trips, unmasked/RSV/opcode/fragmented-control/oversized-control → 1002, oversized frame (payload not read) and message → 1009, reassembly with interleaved ping, continuation rules, UTF-8 (split multibyte OK, invalid → 1007), close echo and invalid codes/reasons, 64-bit length MSB, EOF mid-frame, server frame encodings, concurrent senders, sends after close.
- `tests.test_terminal_proxy`: 30 OK. Address table (loopback, RFC 1918, Docker bridge, CGNAT/100.x, metadata, ULA/Tailscale, multicast, mapped/NAT64/6to4/Teredo embedding), mixed DNS answers, rebinding, CONNECT, absolute-form GET (Proxy-* stripped), SOCKS5, refusals over a real Unix socket with a real 127.0.0.1 listener never reached, limits.
- `tests.test_terminal_sandbox`: 33 OK. Auth (allowlisted header only with the Board Host, missing/other/duplicate header, login, cookie flags, logout, expiry, lockout and recovery, disabled password, cookie parsing, 0600 hash file, symlinked hash file), check keys (edit/reorder/duplicates/whitespace) and store (persistence across reopen, validation, 500 cap), mount choice (dedicated, single-report folder, per-report folder for reports root and bucket, `create=False`), refusals (symlinked folder, lane, per-report folder; comma injection; bad selectors; missing report; moved folder), evidence (ANSI stripping, timestamps, cap, new file each time, symlinked validation/, planted symlink at the target name, read-only root, read-only folder), sessions with the test-only local shell (starts in the folder, host edits visible, two viewers share one shell, scrollback, idle reap, eviction then refusal, reset, shell exit and respawn, folder-move notice, close).
- `tests.test_terminal_service`: 15 OK. Real HTTP and WebSocket: health, untrusted Host, header trust with and without the /terminal prefix, Origin/CSRF/Sec-Fetch-Site refusals, no CORS, locked-down login page, login/logout/cookie, lockout (tailnet unaffected), checks API, WebSocket refusals (wrong Origin 403, anonymous 401), shared session over two sockets (tailnet + password, prefixed + stripped) with scrollback, evidence and reset, missing report error, origin rules, `--terminal-url` parsing and capability, hash-password CLI from stdin.
- `tests.test_terminal_docker` (`BBTERM_DOCKER_TESTS=1`, image `bbterm-test-image` from `sandbox/Dockerfile.test`): 9 OK in 3 of 4 final runs (38 to 51 s); the first final run (124 s, at peak load) reported 1 error whose traceback was not captured, and 3 reruns straight afterwards passed. Covers: inspect (network none, read-only root, CapDrop ALL, no CapAdd, no-new-privileges, no unconfined profile, not privileged, init, pids 128, memory, CPUs, host UID:GID, tmpfs /tmp and HOME, exactly the two mounts, no docker.sock, AppArmor docker-default), `/proc/self/status` NoNewPrivs 1, CapEff 0, Seccomp 2, read-only /etc; shell starts in /report; host edit visible immediately; container edit lands on the host owned by the host user; nothing outside the folder (no parent files, mountinfo, only proxy.sock in /run/bbterm, grep for a secret planted next to the lane finds nothing); network policy; idle reap; stale reap by prefix plus label (a prefixed container without the label is left alone); evidence; cleanup on stop. No `bbterm-test-*` container remained after any run.
- Network evidence line from the container (no NO_PROXY, so every probe goes through the filter): allowed test server `[200, "allowed-egress-ok"]`, CONNECT 200, SOCKS 0; host loopback 127.0.0.1, `localhost`, Docker bridge gateway 172.17.0.1, 10.0.0.1, 192.168.1.1, 100.100.100.100, 169.254.169.254 and fd7a:115c:a1e0::1 all `403 Blocked by sandbox egress policy: blocked_address` over HTTP, `403` over CONNECT and SOCKS reply 2; direct sockets to 1.1.1.1:80 and the gateway refused (no route); DNS fails; the host 127.0.0.1 listener received no connection.
- `static/tests/sandbox-terminal.synthetic.test.cjs`: 5 pass (also run inside `npm test`). Drawer opens and connects; fingerprints equal Python's; play types without Enter; Run; Shift+click on a console block; multi-line bracketed paste; host edit visible; checks persist across reload and are shared between two pages; two viewers on one shell; editor value and file unchanged; copied text/HTML contain no controls; evidence saved and listed in the artifacts panel; Ctrl+`; height remembered; Reset sandbox; phone sheet; password sign-in (cookie flags checked in the browser) with prefix stripping; non-live view; no UI without `--terminal-url`; graceful when the service is down.

Existing suites:
- `python3 -W error::ResourceWarning tests/safe_suite.py`: 419 tests, 1 failure, 1 error, 10 skipped (the 9 Docker tests plus the existing skip). The failure (`test_collaboration_process...test_source_read_is_serialized_across_two_servers`) and the error (`test_report_retained_scan...test_reconcile_blocks_conflict_until_explicit_resolution`, socket timeout) each passed alone, both on this branch and on an export of base `c5cd47c`.
- `npm test`: 168 tests, 168 pass.
- Broad browser suite (every `static/tests/*.test.cjs` except collaboration.synthetic and collaboration-combined.synthetic, metadata writer test skipped): 245 tests, 233 pass, 10 fail, 2 cancelled, all timeouts, in 5 files. Alone afterwards: collaboration-frontend-fixes 20/20, live-editor 8/8, merged-ack-recovery 1/1; capacity-recovery-real 7/8, then 5/8; report-save-ui 11/12, then 7 pass / 3 fail / 2 cancelled. The same two files on the base export at the same time: capacity-recovery-real 6 pass / 2 cancelled, report-save-ui 5 pass / 2 fail / 5 cancelled (all timeouts), so these are load timeouts, not regressions.

Screenshots (synthetic): `$TMPDIR/screens/report-terminal-light.png`, `report-terminal-dark.png`, `login-light.png`, `login-dark.png`, `phone-terminal-light.png`, `phone-terminal-dark.png`.

### Lifecycle change (pause/resume) evidence

Run on Ghost, same TMPDIR, load average about 8 to 17.

- Measured with the test image (`python:3.12-slim` base, forwarder + bash idle, limits 256 MiB / 0.5 CPU), `docker stats --no-stream` and 10 pause/unpause cycles, three runs: idle sandbox **15.4 to 15.9 MiB** (one earlier run with the shell busier: 27.4 MiB), the same while paused (15.4 MiB: pausing freezes, it does not free memory); `docker pause` median **118 to 140 ms** (max 516 ms), `docker unpause` median **105 to 119 ms** (max 686 ms). The production image runs the same processes when idle; its size on disk is larger but idle memory should be similar (not measured: image not built here).
- `tests.test_terminal_sandbox`: 44 OK (was 33). New: real local shell pause, resume and removal (`export`, `cd` kept across a pause; fresh session after removal says `recreated_idle`); fake Docker backend with an injectable clock for every transition: grace period, never paused with a viewer, pause at 300 s, resume reuses the same shell process, removal 4 h after the last viewer left even while paused, idempotent passes, attach while a pause is in flight (blocked pause, attach waits, ends running and `resumed`), failed pause logged and retried, unpause after the container vanished (recreated, old scrollback dropped), running container vanished (recreated on attach), pause of a vanished container counts as removed, capacity with mixed paused/running/attached (paused first even if a running one left earlier, then running viewerless, refusal naming "All 3 sandboxes"), memory guard (refuses a new sandbox at 1.5 GB with the exact message, resume still allowed, unknown MemAvailable allowed), `/proc/meminfo` parser, defaults (12, 300, 14400, 2 GiB), stale cleanup at start, `idle_timeout` alias, double detach.
- `tests.test_terminal_service`: 17 OK (was 15): flag validation (`--max-sessions` 0 and 33, pause after removal, too-short timers, `--idle-timeout` conflicting with `--remove-after`, bad `--min-free-memory`), size parsing, defaults through `make_service` with the alias.
- `tests.test_terminal_ws` 35 OK, `tests.test_terminal_proxy` 30 OK (unchanged).
- `tests.test_terminal_docker`: 11 OK in each of the last 3 runs (22 to 31 s), after one fix to the new test's own shell command. New: a background job writing 5 lines a second plus `cd sub`; pause via the reaper (`State.Paused` true, second pause idempotent); across 2.3 to 2.5 s including a 2 s pause the job wrote 1 to 2 lines (frozen), then 8 → 14 lines a second later (running again); resume event `resumed`, scrollback kept, `cwd=/report/sub alive=yes` (same shell, job alive). A paused container is removed by stop. Measurement test as above. No `bbterm-test-*` container remained.
- `static/tests/sandbox-terminal.synthetic.test.cjs`: 6 pass (was 5). New: a sandbox paused after the drawer closes (service `--pause-after 10`), reopening shows the "Resumed" toast, the same scrollback, `still-here in sub, jobs=1` (same shell, cwd and background job), no restart notice. The main test now checks that the header has no lifecycle text and that the status tooltip reads "Pauses 5 min after the last viewer leaves and is removed after 4 hours. Files in the report folder are kept."
- `python3 -W error::ResourceWarning tests/safe_suite.py`: 434 tests, OK (12 skipped: the 11 Docker tests and the existing skip).
- `npm test`: 169 tests, 168 pass, 1 fail (`live-editor` "outside write appears in an idle editor with a notice", 30 s wait for the notice); `live-editor.synthetic.test.cjs` alone straight afterwards: 8/8 pass.

### Mount rule change (finding packet folders only) evidence

Run on Ghost, same TMPDIR. The fixture now uses the packet layout: `reports/D1-sqli-login/` (EVIDENCE.md, `example-com-sqli-D1.md`, `poc.py`, `_meta/`), `reports/D10-xss/`, legacy `reports/AC-1/`, `reports/D7-open-redirect/`, legacy files under `reports/findings/`, navigation (`active.md`, `index/all.md`) and look-alike folders that must not count.

- `tests.test_terminal_sandbox`: 46 OK. Mount tests replaced: exact-FID rule (D1 vs D10, digits in slugs, longest FID for AC/AC-1, refused `D100-x`, `D1-Bad-Slug`, `D1_odd`, `D1-`, `D1--double`, `d1-lower`, `D1-x_y`, `D1-x.y`, `D1 x`, `xD1`); rule 1 mounts the packet root (from the report, EVIDENCE.md or any file in it; legacy `reports/AC-1/`); rule 2 by file name (`D10 - HIGH - …`, `reports/D10.md`) and by ledger `report_path` (D7); rule 3 refuses navigation, index pages, unmapped files, a finding whose packet folder is missing and every look-alike folder, with the exact message, and the `reports/` listing is unchanged afterwards (nothing created); ledger `report_dir` must be a packet for that FID directly under `reports/` (`reports` itself, another FID's packet, a nested folder all refused); symlinked packets refused for rule 1 and rule 2, symlinked lane refused; comma injection through an FID; moved packet. The folder-creation tests are removed.
- `tests.test_terminal_service`: 18 OK. New: `GET /api/mount` for a packet report, a legacy report (rule `ledger`), navigation (`ok: false`, `not_in_packet`, exact message), bad selector 400, anonymous 401; a WebSocket attach to a navigation page gets `not_in_packet`; evidence for it is refused.
- `tests.test_terminal_ws` 35 OK, `tests.test_terminal_proxy` 30 OK.
- `tests.test_terminal_docker`: 11 OK in 2 of 2 runs (19 to 32 s) with the packet layout (the mount is `reports/D1-sqli-login`; a sibling packet and the navigation pages are not visible). Measured again on this run: idle sandbox 18.3 MiB (same while paused), pause median 52 ms, unpause median 82 ms.
- `static/tests/sandbox-terminal.synthetic.test.cjs`: 7 pass. New: `active.md` shows a disabled Terminal button with the reason as its title and visible text, Ctrl+` does nothing, no `reports/active` folder appears; the legacy D10 report enables the button, opens D10's packet root (`basename $PWD` = `D10-xss`, EVIDENCE.md listed) and shows "Opened the finding folder reports/D10-xss/ (D10, from the ledger)."; switching to `index/all.md` hides the drawer and disables the button again. Screenshot: `$TMPDIR/screens/not-in-packet-light.png`.

### Security fix round 2 evidence

Run on Ghost, same TMPDIR: `tests.test_terminal_ws` 38 OK, `tests.test_terminal_proxy` 36 OK, `tests.test_terminal_sandbox` 47 OK, `tests.test_terminal_service` 25 OK (twice), `tests.test_terminal_docker` (`BBTERM_DOCKER_TESTS=1`, local `bbterm-test-image`) 12 OK, `static/tests/sandbox-terminal-filter.test.cjs` 3 pass, `static/tests/sandbox-terminal.synthetic.test.cjs` 8 pass (the drawer works with one request per connection). No `bbterm-test-*` container remained.

### Security fix round evidence

Run on Ghost, same TMPDIR: `tests.test_terminal_ws` 38 OK, `tests.test_terminal_proxy` 34 OK, `tests.test_terminal_sandbox` 47 OK, `tests.test_terminal_service` 23 OK, `tests.test_terminal_docker` (`BBTERM_DOCKER_TESTS=1`, rebuilt test image) 12 OK, `static/tests/sandbox-terminal-filter.test.cjs` 2 pass, `static/tests/sandbox-terminal.synthetic.test.cjs` 8 pass. No `bbterm-test-*` container remained.

## Gaps

- `sandbox/Dockerfile` (apt packages) was not built here: there is no network in this environment. The real-container tests use `sandbox/Dockerfile.test` (python:3.12-slim, same user, forwarder, bashrc and layout, no curl/jq/node). Build and verify the real image on Hoster (steps below).
- Login sessions are in memory; a service restart signs out password users (tailnet users are unaffected).
- The check-mark poll is 5 s; there is no push.
- The transcript is what the PTY printed (echoed input included); full-screen programs (vim, less) leave noise even after ANSI stripping.
- A packet folder whose FID is not in the lane ledger is not recognised (the exact-FID rule needs the ledger); such reports get the disabled button.
- No disk quota on the mounted folder.
- Password sign-in is limited to 2 concurrent scrypt checks and anonymous requests (sign-in page, password users before signing in) to 8 at a time; a flood from the tailnet can make sign-in answer "busy" or 503 until it stops. Allowlisted tailnet users and signed-in users have their own 64 slots and keep working.
- Only the host's own addresses are blocked, not on-link neighbours in a public subnet; the host-address list refreshes every 60 s.
- Blocks containing control characters cannot be typed at all; copy them by hand after review.
- A service restart drops paused sessions (containers are cleaned up at start); there is no state file to adopt them.
- A paused sandbox keeps its memory; the 2 GiB floor only guards creation. Twelve idle sandboxes measured about 16 MB each here, but one with a big process paused inside keeps all of it until removal or eviction.
- Paused time still counts toward removal (4 h from when the last viewer left).

## Deployment (orchestrator)

Do these on Hoster as the Board's user. Review existing Serve config first (`tailscale serve status`).

1. Build the image (network needed once):
   ```sh
   cd ~/path/to/bounty-board
   docker build -t bbterm-sandbox:latest --build-arg UID=$(id -u) --build-arg GID=$(id -g) sandbox/
   ```
2. Create the password hash (prompt does not echo; store the password in Bitwarden as user `ryushe`):
   ```sh
   mkdir -p ~/.config/bounty-board && chmod 700 ~/.config/bounty-board
   python3 terminal_service.py hash-password --output ~/.config/bounty-board/terminal.hash
   # non-interactive: printf '%s\n' "$PW" | python3 terminal_service.py hash-password --output ...
   ```
3. systemd user unit `~/.config/systemd/user/bounty-board-terminal.service`:
   ```ini
   [Unit]
   Description=Bounty Board sandbox terminal
   After=docker.service network-online.target

   [Service]
   Type=simple
   WorkingDirectory=%h/path/to/bounty-board
   ExecStart=/usr/bin/python3 %h/path/to/bounty-board/terminal_service.py --root %h/Shared --port 9011 \
     --allowed-origin https://<node>:9001 --allow-tailnet-user ryushe.dev@gmail.com \
     --password-hash-file %h/.config/bounty-board/terminal.hash --image bbterm-sandbox:latest \
     --pause-after 300 --remove-after 14400 --max-sessions 12 --min-free-memory 2G
   KillSignal=SIGTERM
   TimeoutStopSec=60
   Restart=on-failure
   RestartSec=5

   [Install]
   WantedBy=default.target
   ```
   `systemctl --user daemon-reload && systemctl --user enable --now bounty-board-terminal`. Stopping it removes every sandbox container, paused ones included; starting reaps leftovers (`bbterm-` prefix plus label). A restart therefore drops paused sessions (the files stay in the report folders).
4. Board: add `--terminal-url /terminal/` to the existing app.py unit and restart it.
5. Serve: `tailscale serve --bg --https=9001 --set-path /terminal http://127.0.0.1:9011`. The service accepts paths with or without the prefix.
6. Verify on the real host:
   - `curl -s http://127.0.0.1:9011/healthz` → `{"ok": true}`; `curl -s -H 'Host: 127.0.0.1:9011' -H 'Tailscale-User-Login: ryushe.dev@gmail.com' http://127.0.0.1:9011/api/status` → 403 (direct requests are not trusted).
   - From a tailnet device: open a report, press Ctrl+`, run `id; pwd; ls` (host UID, `/report`, the report's files), `curl -sI https://example.com` (works), then each of these must print "Blocked by sandbox egress policy": `curl -s http://127.0.0.1:9001/`, `curl -s http://172.17.0.1/`, `curl -s http://192.168.1.1/`, `curl -s http://100.100.100.100/`, `curl -s http://169.254.169.254/`; `curl --noproxy '*' -s https://example.com` must fail (no network); `ls /report/..` must not show other reports.
   - `docker inspect bbterm-<id>` → NetworkMode none, ReadonlyRootfs true, CapDrop [ALL], SecurityOpt [no-new-privileges], two mounts only.
   - Anonymous connection hold (review N1): from a tailnet device, open 64 `POST /terminal/api/login` requests that declare `Content-Length: 65536` and send no body; the allowlisted user's `/terminal/api/status` must still return 200 and the held requests must be closed within about 10 s. Also confirm whether Serve streams request bodies to the backend.
   - IPv4-mapped host address (review N2): in the terminal, `curl -s "http://[::ffff:<host public IPv4>]/"` must print "Blocked by sandbox egress policy". If the host has a global IPv6 address or a public IPv4 subnet, also try a neighbour's address in the same subnet: only the host's own addresses are blocked, not on-link neighbours (known gap).
   - Paste guard (review N3): a code block with RLI/LRI bidi controls shows the control-character warning and its play and Run buttons are disabled.
   - Idle tab: a tab left open but idle keeps its terminal attached for at least 10 minutes; a laptop that sleeps is dropped within about 75 s.
   - From a device signed in as a different tailnet user or a tagged device: the drawer shows "Sign-in needed"; the password works; five wrong passwords lock sign-in for 15 minutes.
   - Lifecycle: start `sleep 1000 &` in a terminal, close the drawer, wait 5 minutes: `docker ps --filter name=bbterm-` shows `(Paused)`; reopen the report: "Resumed", `jobs` still lists the sleep. `docker stats --no-stream` shows the idle sandbox's memory.
   - Save output as evidence → a new `validation/terminal-*.txt` in the report folder, owned by the host user, visible in the artifacts panel.

## Decisions for Ryu

Questions 1, 2 and 5 were answered: mount only finding packet folders (no folder creation), keep read-write, no extra tools.

1. (Answered: packet folders only.)
2. Should a sandbox be allowed to delete files in the report folder at all, or should the folder be mounted read-only with a separate writable scratch folder? (Current: read-write, as asked.)
3. (Answered: pause after 5 min, remove after 4 h, 12 sandboxes, 2 GiB free-memory floor.) 1 GB memory, 1 CPU, 256 processes per sandbox: keep?
4. Should check marks reset when the report is renamed or moved? (They are keyed by path, so they do today.)
5. Extra tools for the image (for example Go, nuclei, a newer Node that honours the proxy variables)?
