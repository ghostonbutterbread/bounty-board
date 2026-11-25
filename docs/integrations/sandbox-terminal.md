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
  1. the dedicated folder `report_artifacts` resolves (REPORT.md/EVIDENCE.md folder or the finding's `report_dir`);
  2. else the report file's own folder, when it is below `reports/`, holds no other top-level `.md` and is not shared with another finding;
  3. else (report directly in `reports/`, or in a bucket folder with several reports) a **per-report folder next to the report**, named after the file without `.md` (`reports/x.md` → `reports/x/`, `reports/bucket/one.md` → `reports/bucket/one/`), created on first open. Mounting the bucket would expose every report in it.
  Every component from the data root down is opened with `O_NOFOLLOW` (no symlinks anywhere), the lane root and `reports/` itself are never mounted, dot names are refused, and paths with commas, quotes or control characters are refused (Docker's `--mount` syntax). After `docker run`, the path is checked again to still be the same directory (device and inode) reached without symlinks, otherwise the container is removed. A viewer attaching to a session whose folder was moved or renamed sees "The report folder moved or was renamed. Reset sandbox to open the new location."
- **Ownership.** The container runs as the host user's UID:GID (`--user`), with HOME a tmpfs owned by that UID, so files created in `/report` belong to the host user and sync like any other report file. Build the image with matching `UID`/`GID` build args so the user has a name in the container.
- **Network.** `--network none`; the only way out is the service's filtering proxy, reached through the per-session socket and the in-container forwarder on 127.0.0.1:3128. `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY=socks5h://…` (and lower-case), `NO_PROXY=localhost,127.0.0.1,::1`, `NODE_USE_ENV_PROXY=1` are set, so curl, wget, Python requests/urllib, httpie and Go tools work. The proxy speaks HTTP CONNECT, absolute-form HTTP (one request per connection) and SOCKS5 CONNECT. It resolves names itself, refuses the whole name if any answer is non-global, connects only to the vetted address (no rebinding), and vets every connection. Refused: loopback, RFC 1918, CGNAT 100.64.0.0/10 (Tailscale), link-local incl. 169.254.169.254, IPv6 ULA incl. fd7a:115c:a1e0::/48, multicast, unspecified/reserved, plus IPv4 embedded in mapped, NAT64, 6to4 and Teredo addresses.
- **Save output as evidence.** The service (never the container) writes the session transcript (ANSI stripped, each line stamped with its arrival time, header with report and times, capped at 1 MiB keeping the newest output) to `<mounted folder>/validation/terminal-YYYYMMDD-HHMMSS.txt`: directories opened with `O_NOFOLLOW` from the root, `validation/` must not be a symlink, the file is created with `O_EXCL|O_NOFOLLOW` (a planted symlink at the name is skipped, never followed), and it refuses with "The Board data folder is read-only" when the root or folder is not writable. The drawer then reloads the artifacts panel (the file is listed for dedicated folders).

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

## Contract

| Route (also without the `/terminal` prefix) | Auth | Purpose |
| --- | --- | --- |
| `GET /healthz` | none | `{ok: true}` |
| `GET /login`, `/login.js`, `/login.css` | Host check | password page (CSP `default-src 'none'`, `frame-ancestors 'none'`) |
| `GET /api/status` | yes, else 401 `{error: login_required, login_url}` | `{user, method: tailnet\|password, pause_after, remove_after, idle_timeout (= remove_after), max_sessions}` |
| `POST /api/login` `{username, password}` / `POST /api/logout` | Origin + CSRF header | 200 + cookie; 401 invalid, 429 locked, 403 disabled |
| `GET /api/checks?family&program&lane&path` | yes | `{checks: {key: epoch}}` |
| `POST /api/checks` `{family, program, lane, path, key, checked}` | yes + Origin + CSRF | `{checks}`; 400 bad key, 409 cap reached |
| `GET /api/session?…` | yes | `{session: info or null}` |
| `POST /api/reset` `{selector}` | yes + Origin + CSRF | `{session}` |
| `POST /api/evidence` `{selector}` | yes + Origin + CSRF | `{relative, name}`; 409 no session / read-only root / unsafe folder |
| `GET /ws?…` (WebSocket) | yes + Origin | client text `{"t":"in","d":…}`, `{"t":"resize","cols","rows"}`; server binary = terminal output, text = `hello{session}`, `viewers{count}`, `reset`, `exit`, `error{code,message}`, `closed{message}` |

Session info: `{id, created, pause_after, remove_after, idle_timeout, folder, workdir, mount_reason, viewers, notes, running, paused}`. The WebSocket `hello` carries `event`: `started`, `attached`, `resumed`, `recreated_idle`, `recreated_vanished` or `reset`. Errors on attach include `low_memory` and `too_many_sessions`.

WebSocket server (`terminal_ws.py`, RFC 6455, server side only, no extensions/subprotocols): client frames must be masked; RSV bits, unknown opcodes, fragmented or >125-byte control frames, continuation without start, a new data frame mid-message and 64-bit lengths with the MSB set close with 1002; frames or messages over 256 KiB close with 1009 before the payload is read; invalid UTF-8 text or close reason closes with 1007; close codes are validated and echoed; pings are answered; the service pings every 20 s and drops peers silent for 75 s. A standard library has no WebSocket server, and the alternatives (polling, SSE plus POST) would add latency for keystrokes, so a minimal strict implementation with 35 unit tests was chosen.

`app.py`: new `--terminal-url` (same-origin path such as `/terminal/`, validated), exposed as `capabilities.terminal_url`. Nothing else in the Board changed except the `data-lang` attribute in `markdown()` and one CSS rule that themes EasyMDE preview code blocks (they were light grey with light text in dark/dusk).

## Decisions

- Mount, not copy (Ryu's correction): edits are seamless in both directions; the price is that the terminal can change and delete files in that folder.
- Per-report folder next to the report for flat and bucket layouts, rather than mounting a folder shared by other reports or refusing.
- Separate process, own systemd unit, loopback only; shell-capable code never runs inside app.py.
- Filtering forward proxy over a mounted Unix socket instead of host firewall rules (no sudo on Hoster).
- Check marks in the terminal service, not the Board, so the Board stays free of new write endpoints; when the service is down the marks are unavailable (shown disabled).
- Pause instead of close (Ryu approved): an idle sandbox measured about 16 MB and pause/unpause about 0.1 s here, so keeping 12 paused sandboxes costs little and coming back is instant. At the cap, paused sandboxes are removed before running ones and attached ones never.
- Memory guard on creation only; unpausing never refuses, because the memory is already held.
- Ryu kept the defaults: per-report folders for flat and bucket layouts, the folder mounted read-write, no extra image tools.
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

## Gaps

- `sandbox/Dockerfile` (apt packages) was not built here: there is no network in this environment. The real-container tests use `sandbox/Dockerfile.test` (python:3.12-slim, same user, forwarder, bashrc and layout, no curl/jq/node). Build and verify the real image on Hoster (steps below).
- Login sessions are in memory; a service restart signs out password users (tailnet users are unaffected).
- The check-mark poll is 5 s; there is no push.
- The transcript is what the PTY printed (echoed input included); full-screen programs (vim, less) leave noise even after ANSI stripping.
- Per-report folders (rule 3) are not listed in the artifacts panel, because `report_artifacts` only lists dedicated folders; the evidence file is still written and the drawer shows its path.
- No disk quota on the mounted folder.

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
   - From a device signed in as a different tailnet user or a tagged device: the drawer shows "Sign-in needed"; the password works; five wrong passwords lock sign-in for 15 minutes.
   - Lifecycle: start `sleep 1000 &` in a terminal, close the drawer, wait 5 minutes: `docker ps --filter name=bbterm-` shows `(Paused)`; reopen the report: "Resumed", `jobs` still lists the sleep. `docker stats --no-stream` shows the idle sandbox's memory.
   - Save output as evidence → a new `validation/terminal-*.txt` in the report folder, owned by the host user, visible in the artifacts panel.

## Decisions for Ryu

Questions 1, 2 and 5 were answered: keep the per-report folder, keep read-write, no extra tools.

1. Folder mounting for reports that sit directly in `reports/` or in a shared bucket folder: a new `reports/<name>/` folder next to the report (current), or refuse the terminal for those reports?
2. Should a sandbox be allowed to delete files in the report folder at all, or should the folder be mounted read-only with a separate writable scratch folder? (Current: read-write, as asked.)
3. (Answered: pause after 5 min, remove after 4 h, 12 sandboxes, 2 GiB free-memory floor.) 1 GB memory, 1 CPU, 256 processes per sandbox: keep?
4. Should check marks reset when the report is renamed or moved? (They are keyed by path, so they do today.)
5. Extra tools for the image (for example Go, nuclei, a newer Node that honours the proxy variables)?
