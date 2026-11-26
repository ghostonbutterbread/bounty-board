# Sandbox preview ports (backend and UI)

- Branch: `feat/board-terminal-ports`; base `18089f4` (origin/beta). Commits: `1aa50ea`, `efa5e83`, `0632c25`, review round 1 `53b9c3a`, `7493c3c`; merged terminal UX `ba02227`; review round 2 `12bef96`; UI `4ed50b8` (+ this dossier update).
- Owner surfaces: `terminal_ports.py` (new), `terminal_sandbox.py`, `terminal_service.py`, `sandbox/bbterm-ports.py` (new), `sandbox/Dockerfile`, `sandbox/Dockerfile.test`, `tests/test_terminal_ports.py` (new), `tests/test_terminal_service.py`, `tests/test_terminal_docker.py`; phase 2: `static/modules/sandbox-ports.js|css` (new), `static/index.html` tags, `static/tests/sandbox-ports.synthetic.test.cjs` (new, in `npm test`), `tests/terminal_browser_fixture.py` (`ports` mode).
- Ryu's request, short: a PoC server started in a report's sandbox (`python3 -m http.server 8000`, a small Flask app, a websocket server) must open in his browser on another tailnet machine. Bind to localhost always, and to the Tailscale address when a terminal setting says so.
- Phase 2 (done, on top of the terminal UX work): a ports pill in the drawer header and the Tailscale switch on the Settings page, built on `window.BoardTerminal` and `window.BoardSettings` (see "UI" below).

## How it works

```
browser on a tailnet machine ──http://100.x.y.z:9100/──┐
local process on the host ─────http://127.0.0.1:9100/──┤
                                                        ▼
terminal_service.py  PortsHub: listeners 127.0.0.1:<n> (+ Tailscale IPv4:<n> when on)
                     per session: ports.sock (host-owned, 0600) in <state>/proxy/<session>/
                                   ▲ the agent dials out; the host never connects in
container (--network none, read-only, cap-drop ALL, unchanged)
  /run/bbterm (read-only mount): proxy.sock, ports.sock
  bbterm-ports agent: reads /proc/net/tcp{,6}, reports LISTEN ports, answers opens
  PoC server on 127.0.0.1:8000 or 0.0.0.0:8000
```

1. The agent (`sandbox/bbterm-ports.py`, run as a thread inside the 3128 forwarder process `bbterm-forward`, restarted by a supervisor loop if the thread dies) opens a control connection to `/run/bbterm/ports.sock` and reports the TCP ports in LISTEN state on loopback or the unspecified address, every second, only on change. 3128 is excluded by the agent and, independently, by the host.
2. For each reported port (at most 8) the host picks a number from `--ports-range` (default 9100-9199) and listens on `127.0.0.1:<n>`, plus `<tailscale ip>:<n>` when the setting is on.
3. A browser connects to `<n>`. The host sends `{"t":"open","id":<random 128-bit hex>,"port":8000}` on the control connection. The agent connects to `127.0.0.1:8000` (then `::1`) inside the container, dials a new connection to `ports.sock`, sends `{"t":"data","id":…}` and from then on bytes are copied both ways with half-close.
4. When the server stops listening the port leaves the list and the host listener closes; the number stays reserved for that sandbox port while the session lives, so the URL is the same when the server starts again.

## Contract

All routes also work without the `/terminal` prefix, like the existing ones.

| Route | Auth | Result |
| --- | --- | --- |
| `GET /api/settings` | yes, else 401 | `{preview_ports, ports_tailscale, tailscale_address: "100.x.y.z"\|null, tailscale_reason: null\|"not_found"\|"disabled", ports_range: [lo, hi]}` |
| `POST /api/settings` `{ports_tailscale: bool}` | yes + Origin + `X-Requested-With: Bounty-Board` + JSON (same gate as other state changes) | same shape as GET; 400 for any other body (extra keys, non-bool); 409 `{error: "preview_ports_disabled"}` when the flag is off; 409 `{error: "tailscale_not_found"}` when switching on with no Tailscale address (nothing saved); 500 `{error: "settings_unreadable"}` when the settings file could not be read at start |
| `GET /api/ports?family&program&lane&path` | yes | `{ports: [item...], preview_ports, ports_tailscale}`; empty list when the report has no session or the flag is off |
| `GET /api/status` | yes | gains `preview_ports`, `ports_tailscale` |
| `GET /api/session?…` | yes | session info gains `ports: [item...]` |
| WebSocket | yes | new server message `{"type":"ports","ports":[item...]}` whenever that session's list changes (also when Tailscale URLs appear or go); `hello.session.ports` carries the list on attach |

Port item: `{port, host_port, local_url: "http://127.0.0.1:<host_port>/", tailscale_url: "http://<tailscale ip>:<host_port>/"|null, state: "open"|"paused"}`. `tailscale_url` is null when the setting is off, no address is found, or that one listener could not bind. `state` is `paused` while the sandbox is paused (a connection wakes it).

`tailscale_reason`: `disabled` when the setting (or the flag) is off; `not_found` when on but no address is currently found (it keeps looking every 60 s); `null` when on and bound. `tailscale_address` is null unless on and found.

### Flags (`terminal_service.py`)

| Flag | Default | Meaning |
| --- | --- | --- |
| `--preview-ports` | off | Off: no `ports.sock`, no listeners, no agent connection accepted, `preview_ports: false` everywhere, POST settings 409. |
| `--ports-range LO-HI` | `9100-9199` | Host ports used for previews. 1024-65535, at most 1000 numbers, must not contain `--port`. |
| `--tailscale-address auto\|IPv4` | `auto` | `auto`: the IPv4 address (in 100.64.0.0/10, local) of a `tailscale*` interface, `tailscale0` first; never another interface, even one with a 100.64.0.0/10 address (ISP carrier-grade NAT, another overlay), so while Tailscale is down there is no address. An explicit address must be in 100.64.0.0/10 (checked at start) and local (checked when used; otherwise `not_found`). |

The setting itself lives in `<state-dir>/settings.json` (`{"ports_tailscale": false}` by default): atomic replace (new 0600 file, fsync, rename, directory fsync), never written after a failed read (permissions, symlink, directory: changes are refused until it is fixed), a corrupt file is renamed to `settings.json.corrupt-<stamp>-<rand>` before the first write replaces it, unknown keys are kept (room for app-wide settings later). Changing it applies live: on opens Tailscale listeners for every current forward; off closes them and the connections that came through them (local ones stay). Off fails closed: the listeners close first, then the file is saved; a failed save still answers 500 `settings_failed`, but Tailscale stays off in this process (the 60 s check does not turn it back on). The file still says on, so a restart would turn it on again until a save succeeds. A failed save when switching on leaves it off.

### Agent protocol (`ports.sock`)

Newline-delimited JSON, each line at most 4 KiB, exact key sets, integers checked with `type(x) is int`.

| Direction | Message |
| --- | --- |
| agent → host, first line | `{"t":"hello","v":1}` (control) or `{"t":"data","id":"<32 hex>"}` (answer; raw bytes follow) |
| agent → host, control | `{"t":"ports","ports":[…]}` (≤ 64 unique ints 1-65535), `{"t":"fail","id":…}` |
| host → agent, control | `{"t":"open","id":…,"port":…}` |

Limits (the agent is untrusted: any process in the sandbox can kill it and speak this): 8 forwarded ports per session (existing ones kept first, then lowest new), 32 forwarded connections per session, 128 in total, 48 per browser IP across sessions (one browser with several PoC tabs and websockets shares one tailnet IP; review round 2, N3), 16 opens waiting, an open not answered in 5 s closes the browser connection and kills the id, ids valid once, 5 s total deadline for the first line (a trickle does not extend it), 8 connections that have not identified themselves, 10 control connections per minute per session, 10 `ports` reports per 5 s per control connection (the real agent sends at most one a second; nesting too deep for the parser counts as malformed) (a new control replaces the old one; losing the control connection withdraws its ports until the agent reports again), a kernel send timeout on the control socket so an agent that stops reading cannot hold a sender. A refused connection (any cap) logs one stderr line naming the cap and the client IP: the first refusal, then at most one a minute per cap with a count. Any malformed line closes that connection only. A `fail` for an unknown id is ignored (it may have timed out). Forwarded bytes are never parsed.

### Lifecycle

- Fair use of the global cap (review R3, round 2): the per-IP cap (48) keeps one client from filling the global cap; a connection with no bytes either way for 10 minutes is closed while more than 75% of the global cap is in use (checked every 30 s). There is no eviction of live connections (the fair-share eviction of round 1 was dropped, N1).

- Host numbers are reserved per session and sandbox port for the session's life (pause included), at most 16 remembered per session (oldest inactive dropped first). When the range is full, a number that another session only remembers for a port that stopped listening is reused (that port gets a new number if it comes back); a listening forward is never taken. Released on removal, reset (a reset is a new sandbox with no ports) and service stop. If another host process holds a number, the next free one is used. When the range is full the port is not listed and stderr says `no free host port in LO-HI for sandbox port P`.
- Pause: a new inbound connection to a paused sandbox runs `docker unpause` first (idempotent). Forwarded traffic counts as activity for the pause timer (checked at most every 5 s while bytes flow), so a PoC page in use does not freeze after 5 min. It does **not** count for removal: removal stays 4 h after the last terminal viewer left. Lock order stays session lock, then manager lock; the ports lock is never held while calling into a session.

## UI (phase 2, `static/modules/sandbox-ports.js|css`)

- **Drawer pill** in `window.BoardTerminal.slot('ports')`: hidden when the server has `preview_ports: false` or the session has no ports; otherwise a Board-style pill "1 port" / "3 ports" (plug icon, accent tint, tooltip listing the sandbox ports). Works in every dock, in the two-line side header and on the phone sheet. The slot never starts a drag (the drag code ignores slots; tested for all four docks).
- **Popover** (a `role="dialog"` appended to `<body>`, fixed and clamped to the viewport): focus moves into it and stays inside on Tab; Esc closes and returns focus to the pill; a click outside closes. Each sandbox port shows `:8000` and its URL(s):
  - Tailscale on and bound: the Tailscale URL first (it works from another machine), then the 127.0.0.1 one labelled "on the server";
  - off: only the local URL and a muted "Only reachable on the server. Turn on Tailscale in Settings." with `Settings` a real `<a href="#/settings">`; on but no address: "Tailscale is on, but the server has no Tailscale address right now.";
  - each URL: the URL itself and Open are `<a target="_blank" rel="noopener noreferrer">`; Copy writes it to the clipboard (hidden-textarea fallback) and shows "Copied" for 1.6 s ("Copy blocked by the browser" when both fail);
  - a paused sandbox: muted "paused, opens on first visit".
- **Live updates**: `BoardTerminal.on('session')` fetches `GET <terminal_url>api/ports?<selector>` on attach and reset (and clears on null); `BoardTerminal.on('message')` applies `{"type":"ports"}` pushes and refetches the flags. No reload is needed when a server starts or stops, or when another tab switches Tailscale.
- **Settings**: `window.BoardSettings.register({id: 'terminal-ports', group: 'terminal', title: 'Sandbox ports', order: 50})` inside the Terminal card. "Saved on the server."; switch "Open sandbox ports over Tailscale" (`POST api/settings {ports_tailscale}`, JSON, `X-Requested-With: Bounty-Board`, same-origin); the port range and the Tailscale address ("Tailscale address 100.x.y.z", "No Tailscale address found on the server right now", or "The Tailscale address is detected when you turn this on"); the note "While this is on, anyone on your tailnet allowed by your ACLs can open sandbox ports. They are plain http." Errors: 409 `tailscale_not_found` → "No Tailscale address found on the server."; 409 `preview_ports_disabled` → the "Not enabled" line; 500 `settings_failed` → "Could not save the setting."; 401 → "Sign in to the terminal" linking to `/terminal/login?next=<this page>`. The switch always shows the server's answer (on error the section reloads the settings). Flag off: "Not enabled on this server. Start the terminal service with --preview-ports."

## Threat model

Newly reachable, and by whom:
- **Ports on 127.0.0.1** (always, when `--preview-ports` is on): any local process on the host, as for the Board itself. Same assumption as the existing service: local processes on Hoster are trusted.
- **Ports on the Tailscale address** (only when the setting is on): every tailnet peer the Tailscale ACLs let reach this machine on 9100-9199. There is **no Board auth** on these ports: whoever can reach them can use whatever the PoC server offers. Keep the setting off unless needed, or restrict the port range in ACLs.
- Never `0.0.0.0` or `::`: `_bind_tcp` refuses the unspecified and multicast addresses, and only `127.0.0.1` and the validated Tailscale address are ever passed (tested: kernel view in `/proc/net/tcp` shows only those). Never the control API port (refused at start).
- The proxy port 3128 is never exposed (host-side filter, not trusted to the agent): exposing it would let peers use the sandbox's egress proxy.

What stays the same:
- The container keeps `--network none`, read-only root, cap-drop ALL, no-new-privileges, the same limits and exactly two mounts (`ports.sock` lives in the existing read-only `/run/bbterm` directory). The egress proxy and its address filter are unchanged: the sandbox still cannot reach host loopback, the LAN or the tailnet, **including its own exposed ports** (tested with the real container: both 403).
- The served pages are a different origin from the Board (`http://<ip>:<port>` vs `https://<node>.ts.net:9001`), so they cannot read or write the Board. The terminal cookie is `Secure` and `Path=/terminal`, so it is never sent to an `http://` port.

The tunnel only reaches the container's own loopback:
- The host never connects to anything for a forward. `terminal_ports.py` contains no `connect`, `connect_ex` or `create_connection` call (asserted by a test). It only accepts on its own listeners and on `ports.sock`.
- `ports.sock` is created by the host in a host-owned directory through `/proc/self/fd/<dir_fd>/…`, mode 0600, like `proxy.sock`; the container sees that directory read-only, so it cannot replace the socket with a symlink to a host socket (docker.sock). The host never connects to a path the container can write.
- The only thing the agent chooses is which bytes to send back on a data connection it dialled itself. Extra fields (`host`, `port` on a data line) close the connection (tested). The "destination" of a forward is whatever the agent connects to inside the container, which has only loopback.

## Decisions

1. Data connections are separate dials to `ports.sock` identified by a one-time random id, rather than multiplexing over the control connection: no framing of forwarded bytes, half-close for free, and a malicious agent can only ever affect its own session.
2. Ports that stop listening keep their host number for the session's life (max 16 remembered per session) so a restarted server keeps its URL; a reset or removal releases them, and a full range reuses them for other sessions.
3. When the range is exhausted the extra port is left out of the list (contract states stay `open`/`paused`) and logged to stderr.
4. `tailscale_reason` is `disabled` whenever the setting is off (no detection runs then), even if an address exists; the Settings page can still offer the switch, and switching on answers 409 `tailscale_not_found` when there is no address.
5. A corrupt `settings.json` is set aside at the first write, not at read; reading never changes the file.
6. With the setting on at start and no address found, the setting stays on, `tailscale_reason` is `not_found`, and the 60 s check binds as soon as the address appears.
7. Forwarded connections have no idle timeout while there is room (a websocket PoC may idle). They are closed when idle 10 min while the global cap is over 75% used (review R3); otherwise they end with the client, the sandbox server, a reset/removal, or switching Tailscale off (for tailnet ones).
8. The agent includes any loopback address (127.0.0.0/8, ::1) or the unspecified address; a server on `127.0.0.2` only is listed but the agent connects to 127.0.0.1/::1, so the open fails and the browser connection closes.
9. GET `/api/settings` with the flag off reports `ports_tailscale: false` and does not create `settings.json`.
10. The agent runs as a supervised thread in the forwarder process (review round 1). Killing the forwarder already ends the container, so a second process gave no extra robustness, and one process saves about 6 MiB per idle sandbox.
11. `settings_unreadable` answers 500 (a server-side fault the user cannot fix from the browser); the contract's two 409s are unchanged.
12. (Round 1 added fair-share eviction at the full cap; round 2 dropped it, N1: it could close another session's live connection.) The round-1 repro class `R3_OneClientStarvesOtherSessions` only passes with that eviction, so it now fails by design; `test_r3_one_client_at_its_cap_leaves_room_for_another_client` replaces it (the per-IP cap with two client IPs).
13. The agent supervisor in `bbterm-forward` restarts the agent after 1 s, doubling to 30 s, back to 1 s after the agent stayed up 60 s; the agent's exception is caught in its thread (no thread traceback in the container log) and logged once, then at most one line a minute with a count (N2).
14. UI: the pill shows only when the server has `preview_ports` and the report's session has at least one port. The Tailscale URL is the main one when present (it works from another machine); the 127.0.0.1 one is labelled "on the server". The switch shows the server's answer: on a failed POST the section reloads the settings and shows the plain error. Other tabs update through the ports push the server sends when the Tailscale listeners change; the drawer then refetches `api/ports` for the flag.
15. UI: the popover is appended to `<body>` (fixed position, clamped to the viewport) instead of living in the header slot, so the header's clipping, wrapping and drag handling are untouched; the slot holds only the pill button, which the drag code already ignores.
16. No change to `sandbox-terminal.js` was needed: the module reads the terminal URL from the Board context (`capabilities.terminal_url`) like the drawer does, so no `base()` accessor was added.
17. The browser fixture's Tailscale address is a TEST-ONLY file (`BBTERM_TEST_TAILSCALE_FILE`, a loopback alias, empty = no address), honoured only with `--backend local-test-only` (which already needs `BBTERM_ALLOW_LOCAL_BACKEND=1` and a root under TMPDIR); the Docker backend never reads it.

## Evidence

Run on Ghost, `TMPDIR=/tmp/bbt-ports`, synthetic data only, load average about 8 to 10 on 6 CPUs. Commits `1aa50ea` (feature) and `efa5e83` (review fixes).

| Command | Result |
| --- | --- |
| `python3 -W error::ResourceWarning -m unittest tests.test_terminal_ports` | 35 OK |
| `python3 -W error::ResourceWarning -m unittest tests.test_terminal_service` | 29 OK (one earlier full run had 1 failure that passed on immediate rerun and every run since; load) |
| `python3 -W error::ResourceWarning -m unittest tests.test_terminal_sandbox` | 47 OK |
| `python3 -W error::ResourceWarning -m unittest tests.test_terminal_proxy` | 36 OK |
| `python3 -W error::ResourceWarning -m unittest tests.test_terminal_ws` | 38 OK |
| `BBTERM_TEST_IMAGE=bbterm-test-image-ports:latest BBTERM_DOCKER_TESTS=1 python3 -W error::ResourceWarning -m unittest tests.test_terminal_docker` | 13 OK in the last 2 of 3 runs (76 s, 90 s). The first run failed only the existing pause-timing test `test_065` (14 ticks against a limit of 13.0 while `docker pause` took 400 ms median under load); it passed in both later runs. No `bbterm-test-*` container remained after any run. |

Image: `docker build -t bbterm-test-image-ports:latest --build-arg UID=$(id -u) --build-arg GID=$(id -g) -f sandbox/Dockerfile.test sandbox/` (`bbterm-test-image:latest` untouched).

What the tests prove:
- `test_terminal_ports`: the real agent's `forward()` carries an echo with half-close and an HTTP body; listeners only on 127.0.0.1 and the configured address (socket names and `/proc/net/tcp`, 127.0.0.3 refused, `_bind_tcp` refuses 0.0.0.0, multicast, `::`); same host port after the sandbox server stops and restarts, listener closed while it is stopped; released on close (a new session gets the number); a busy number is skipped and a full range logs and lists fewer; 8-port cap, 3128 never forwarded. Malicious agent: oversized line, bad JSON, wrong types, duplicates, out-of-range, extra keys, NaN, 65 ports, invalid UTF-8, bad first lines (`v: true` included) each close only that connection; extra destination fields refused and the source has no connect call; unknown and reused ids closed; 5 s open timeout (shortened in the test) and `fail` close the browser connection; 40 connections give exactly 16 opens and at least 8 immediate closes; global cap; 8 unidentified then immediate close; hello deadline not extended by a trickle; the 11th control connection in a minute refused. Settings: defaults, atomic 0600 write with no temp file left, unknown keys kept, four kinds of corrupt file set aside with their bytes, unreadable/symlink/directory never written, failed replace keeps the old file. Tailscale: detection rules, live on/off (tailnet connection closed, local one kept, URLs pushed), refusal without an address (nothing saved), address change rebinds, loss reports `not_found`, setting survives restart. Lifecycle with a fake Docker backend and injectable clock: push to viewers and in session info; inbound connection unpauses; traffic at 500 s moves the pause to 800 s; removal still at 4 h after the viewer left even with traffic; reset releases and starts empty.
- `test_terminal_service`: flag off (settings `disabled`, POST 409 `preview_ports_disabled`, empty ports, status fields, no hub, no settings file); flag on: GET/POST settings with 401/403 (no CSRF header, no or wrong Origin, cross-site)/400 (four bad bodies), 409 `tailscale_not_found`, 200 on and off; `/api/ports` and WebSocket push with the real agent path, 0600 `ports.sock`, session info, bytes through the service, reset empties the list and closes the listener; CLI refuses a bad range, a range containing `--port`, and non-Tailscale addresses.
- `test_terminal_docker` `test_068`: `python3 -m http.server 8000` in the sandbox is listed and serves the file at the 127.0.0.1 host port; NetworkMode none and exactly `/report` and `/run/bbterm`; `ports.sock` 0600; from inside the sandbox both its own exposed host port and a host loopback listener get 403 through the proxy (`PORTS EVIDENCE … proxy probes {…: 403, …: 403}`); a paused sandbox answers an HTTP request and is no longer paused; killing the server removes the port and closes the listener; restarting it gives the same host port. `test_05` now lists `ports.sock proxy.sock` in `/run/bbterm`; `test_99` shows stop closes the ports and leaves no forwards.
- Memory: the 41 to 56 MiB from `test_09` was measured with a bash shell attached. Measured properly in review round 1 (below).

### Independent review (1aa50ea) and fixes (efa5e83)

| # | Finding | Fix | Test (old → new) |
| --- | --- | --- | --- |
| 1 | Blocking wake byte sent under the hub lock could deadlock the service if the accept thread was waiting on that lock. | Wake socket non-blocking; a full pipe means a wake-up is already pending. | `ReviewFixTests.test_wake_byte_never_blocks_under_the_hub_lock` (fail → pass) |
| 2 | `docker rm` timing out before `close_ports()` left listeners forwarding to a dead sandbox. | Ports closed first. | `BackendOrderTests.test_destroy_closes_ports_even_when_docker_rm_fails` (fail → pass) |
| 3 | `ports` reports had no rate limit (each can rebind under the hub lock). | 10 per 5 s per control connection, then closed. | `test_ports_reports_are_rate_limited` (error → pass) |
| 4 | A failed thread start leaked `unidentified`/`total_conns`. | Counters rolled back. | `test_thread_start_failure_does_not_leak_counters` (fail → pass) |
| 5 | Deeply nested JSON raised `RecursionError` past the handler. | Treated as malformed. | `test_deeply_nested_json_is_just_malformed` (passes on both: the old thread died but the socket was still closed) |
| 6 | Remembered numbers let one agent hold 16 numbers for hours. | Full range reuses other sessions' idle numbers. | `test_idle_reservations_of_other_sessions_are_reused_when_the_range_is_full` (fail → pass) |

Not changed: forwarded connections have no idle timeout (decision 7; per-session caps bound it).

Screenshots: none. This phase has no UI (no `static/` changes); the drawer chip and Settings toggle come in phase 2.

### Review round 1 (0632c25) and fixes (53b9c3a)

The reviewer returned ACCEPT, fix R1 before merge. Each regression test is in `tests/test_terminal_ports.py`. Red/green proof: only `terminal_ports.py`, `sandbox/bbterm-forward.py` and `sandbox/bbterm-ports.py` were swapped back to `0632c25`, the new tests were run, and the files were restored. 8 of 9 were red; on the restored code all 44 pass.

| # | Finding | Fix | Regression test | On 0632c25 → now |
| --- | --- | --- | --- | --- |
| R1 | Switching Tailscale off saved first; a failed save left tailnet listeners and connections up (no auth). | Close the listeners and connections first, then save; a failed save still raises (500 `settings_failed`) but stays off, also for the 60 s check. The switch-on path saves before applying, so a failed save leaves it off. | `ReviewRound1Tests.test_r1_switching_off_closes_tailnet_listeners_even_when_the_save_fails`; mirror `test_r1_mirror_a_failed_save_when_switching_on_leaves_it_off` | FAIL (`True is not false: off means off`) → OK; mirror OK → OK (guard: the old code already saved before turning on) |
| R2 | After a corrupt file was moved aside, one failed write wedged settings until restart (it tried to move the missing file again). | State becomes `missing` as soon as the rename succeeds. | `test_r2_settings_work_again_after_a_failed_write_of_a_corrupt_file` | ERROR (`FileNotFoundError` on the rename) → OK |
| R3 | One client holding idle connections to a few sessions could fill the global cap and lock every other session out. | 16 connections per client IP across sessions; fair-share eviction at the full cap; idle 10 min closes while over 75% of the cap. Existing caps kept. | `test_r3_idle_hog_on_two_sessions_does_not_lock_out_a_third` (the reviewer's repro), `test_r3_per_client_cap_across_sessions`, `test_r3_idle_connections_close_only_under_pressure` | ERROR (`ConnectionResetError`: the victim is refused), ERROR (no `MAX_CLIENT_CONNS`), ERROR (no `IDLE_CLOSE`) → OK, OK, OK |
| R4 | `auto` fell back to any 100.64.0.0/10 address on any interface. | Only `tailscale*` interfaces, `tailscale0` first; explicit addresses unchanged. | `test_r4_auto_never_falls_back_to_a_non_tailscale_cgnat_address`; `TailscaleTests.test_detection_rules` rewritten | FAIL (`'100.72.13.9' is not None`) → OK |
| Mem | The agent was a second Python process (about 9.5 MiB per sandbox, reviewer). | Agent runs as a supervised thread in `bbterm-forward`; the CMD is one `python3 … bbterm-forward 3128 proxy.sock ports.sock`. The agent no longer reads argv at import. | `ForwarderAgentTests.test_forwarder_process_runs_the_agent`, `test_supervisor_restarts_a_dead_agent`; docker `test_068` asserts a single forwarder process and no `bbterm-ports` process | FAIL (never connected), ERROR (no `supervise_agent`) → OK |

The reviewer's repro file (`test_repro_builder.py`, untouched): 4 FAIL on `0632c25` → 4 OK on `53b9c3a`.

Idle container memory, test image, no shell attached, preview ports on with the agent connected (`DockerBackend.create` only; median of 5 `docker stats` samples, 2 runs each):

| Image | Processes | Memory |
| --- | --- | --- |
| before (`0632c25`, tagged `bbterm-test-image-ports:before`) | forwarder 15.0 MB RSS, separate agent 15.5 MB RSS, `sh` loop | 18.73 / 18.98 MiB (third run 18.98) |
| after (`53b9c3a`, `bbterm-test-image-ports:latest`) | one forwarder with the agent thread, 18.4 to 18.8 MB RSS | 12.79 / 12.52 MiB |

About 6.2 MiB less per idle sandbox (about 75 MiB at 12 sandboxes).

Round 1 suite runs (`TMPDIR=/tmp/bbt-ports`, `-W error::ResourceWarning`): `test_terminal_ports` 44 OK, `test_terminal_service` 29 OK, `test_terminal_sandbox` 47 OK, `test_terminal_proxy` 36 OK, `test_terminal_ws` 38 OK, `test_terminal_docker` (`BBTERM_TEST_IMAGE=bbterm-test-image-ports:latest BBTERM_DOCKER_TESTS=1`) 13 OK in 2 of 3 runs (84 s, 55 s; the first failed only my new `docker top` assertion, which needed a pid column and was fixed before the two green runs), repro file 4 OK. No `bbterm-test-*` container remained.

### Review round 2 (7493c3c) and fixes (12bef96)

The reviewer returned ACCEPT with three minors. Red/green proof: only `terminal_ports.py`, `sandbox/bbterm-forward.py` and `sandbox/bbterm-ports.py` were swapped back to `7493c3c`, the new tests run, the files restored.

| # | Finding | Fix | Regression test | On 7493c3c → now |
| --- | --- | --- | --- | --- |
| N1 | Fair-share eviction could close another session's live connection (no idle minimum). | Eviction removed; the per-IP cap and the 10-minute idle rule remain. At the full cap new connections are refused (logged). | `ReviewRound2Tests.test_n1_active_connections_of_another_session_are_never_evicted` (the reviewer's repro, plus the refusal log); `test_r3_one_client_at_its_cap_leaves_room_for_another_client` replaces the fair-share test | FAIL (`refused at the global cap`: a live connection was evicted instead) → OK; the replacement passes on both |
| N2 | The agent supervisor restarted every 1 s and logged every crash (a pids-limit crash loop floods the container log). | Delay 1 s doubling to 30 s, back to 1 s after 60 s up; the agent's exception is caught in its thread; log the first failure, then at most one line a minute with a count. | `test_n2_supervisor_backs_off_and_rate_limits_its_log` (sleeps `[1, 2, 4, 8, 16, 30, …]`, 3 lines over 10 crashes, reset after a long run); `ForwarderAgentTests.test_supervisor_restarts_a_dead_agent` updated | ERROR (no backoff parameters) → OK |
| N3 | 16 per client IP is tight for one browser with several tabs and websockets; refusals were silent. | Cap 48; every refusal (session, client, pending, total cap) logs `preview port connection from <ip> refused: <cap> cap of <n> reached`, first then at most one a minute per cap with a count. | `test_n3_per_ip_cap_is_48_and_refusals_are_logged_rate_limited` | FAIL (`16 != 48`) → OK |

Reviewer repros now: `ports-r2/test_repro_r2_builder.py` 1 FAIL on `7493c3c` → 1 OK; `ports-r1/test_repro_builder.py` 3 OK and `R3_OneClientStarvesOtherSessions` FAIL by design (it needs the eviction N1 removed; see decision 12).

### Phase 2 evidence

Run on Ghost, `TMPDIR=/tmp/bbt-ports`, synthetic data only, each file alone and serially (`-W error::ResourceWarning` for Python; browser with `NODE_PATH=$PWD/node_modules CHROME_BIN=/opt/google/chrome/chrome node --test --test-concurrency=1`). Branch includes the terminal UX merge `ba02227`.

| Run | Result |
| --- | --- |
| `tests.test_terminal_ports` | 47 OK |
| `tests.test_terminal_service` | 29 OK |
| `tests.test_terminal_sandbox` | 47 OK |
| `tests.test_terminal_proxy` | 36 OK |
| `tests.test_terminal_ws` | 38 OK |
| `tests.test_terminal_docker` (`BBTERM_TEST_IMAGE=bbterm-test-image-ports:latest BBTERM_DOCKER_TESTS=1`, image rebuilt for the supervisor change) | 13 OK (89 s); no `bbterm-test-*` container left |
| `repros/ports-r1/test_repro_builder.py` | 3 OK, 1 FAIL by design (R3, see above) |
| `repros/ports-r2/test_repro_r2_builder.py` | 1 OK |
| `static/tests/sandbox-terminal-filter.test.cjs` | 5 pass |
| `static/tests/sandbox-terminal.synthetic.test.cjs` | 18 pass |
| `static/tests/sandbox-ports.synthetic.test.cjs` (new) | 4 pass |

`sandbox-ports.synthetic.test.cjs` (fixture mode `tailnet,ports`; the fake agent forwards with the real agent's `forward()` to a synthetic HTTP server):
- no pill without ports; a port appears by push → "1 port", its host port is in the range and serves the synthetic page; popover with Tailscale off (one local URL, Open and the URL with `target="_blank" rel="noopener noreferrer"`, the Settings hint with `href="#/settings"`), focus inside, Copy writes the URL and shows "Copied", Esc returns focus to the pill, click outside closes;
- Settings: off, "Saved on the server.", the ACL note; with no Tailscale address the switch answers "No Tailscale address found on the server." and stays off; on → "Tailscale address 127.0.0.2" (test alias), confirmed by `GET api/settings`;
- back in the report: the Tailscale URL first (reachable on 127.0.0.2), local "on the server", Copy writes the Tailscale URL; another tab switches it off → this drawer's items lose the Tailscale URL by push, the flag updates, the tailnet listener refuses, the hint returns;
- the popover stays inside the viewport docked right, left, top and bottom, and a drag started on the pill never starts a drawer drag (no `term-dragging`, no drop preview, dock unchanged);
- the server stops listening → the pill goes away by push; phone sheet (390×844): pill and popover fit; flag off: no pill, Settings shows "Not enabled on this server. Start the terminal service with --preview-ports."; password mode, not signed in: "Sign in to the terminal" links to `/terminal/login?next=%2F%23%2Fsettings` on the same origin.

Screenshots (synthetic, looked at): `/tmp/bbt-ports/screens-ports/ports-popover-bottom-off-{light,dark}.png`, `ports-popover-bottom-on-{light,dark}.png`, `ports-popover-right-{light,dark}.png`, `ports-settings-off-{light,dark}.png`, `ports-settings-on-{light,dark}.png`, `ports-phone-{light,dark}.png`.

## Gaps

- Not built: the production `sandbox/Dockerfile` (no network here). The real-container tests use `sandbox/Dockerfile.test` built as `bbterm-test-image-ports:latest`. Rebuild the production image on Hoster to get the agent; an old image simply never connects (no ports listed).
- UDP is not forwarded; only TCP.
- The Tailscale listeners have no auth of their own (by design; see threat model).
- A port open on `127.0.0.2` only inside the sandbox is listed but cannot be reached (decision 8).
- The round-1 repro class `R3_OneClientStarvesOtherSessions` fails by design after N1 (it needs eviction of live connections).
- The UI was tested with the test-only local backend and a fake agent (real forwarding code); the full chain with Docker is covered by `test_terminal_docker` `test_068`, not by a browser test.
- A popover open while the drawer is resized or re-docked by keyboard follows the pill on window resize and scroll only; re-docking closes it on the next click.
- After a failed save of "off", the file still says on: the running service stays off, but a restart turns Tailscale on again until a save succeeds (logged as the 500 answer).
- Fair-share eviction can close an idle websocket PoC of a busy session when the global cap is full.
- `test_terminal_docker` `test_065` (existing pause timing) failed once under load and passed in the two later runs.
- My test images `bbterm-test-image-ports:latest` (round 1) and `bbterm-test-image-ports:before` (0632c25, the memory baseline) are left built (remove with `docker rmi bbterm-test-image-ports:latest bbterm-test-image-ports:before`).

## Decisions for Ryu

1. Ports bound on Tailscale have no Board login in front of them; anyone your ACLs allow on 9100-9199 can use the PoC. OK, or do you want a per-port token in the URL later?
2. A server that stops keeps its host port for the session's life (max 16 per session), so the URL survives restarts. A full range lets other sessions take those idle numbers.
3. A full range leaves the extra port out of the list (logged), so the contract keeps only `open` and `paused` states. Would you rather see it listed as "no free port"?
4. `tailscale_reason` reads `disabled` whenever the switch is off, even when an address exists. Detection only runs when you switch it on.
5. Default range 9100-9199, at most 8 ports per sandbox, 48 connections per client IP: keep these?
6. The pill says "1 port" / "3 ports" and sits next to the status pill; the popover lists ports by sandbox number (`:8000`). Wording or place OK?
7. The Settings card header still says "Saved in this browser." (it belongs to the terminal's own controls); the ports section adds "Saved on the server." under its title. Fine, or should the card note move into each section?

## Deployment on Hoster (orchestrator)

Do these as the Board's user; do not change Serve.

1. Rebuild the production image (the forwarder now runs the ports agent; the CMD passes `/run/bbterm/ports.sock`):
   ```sh
   cd ~/path/to/bounty-board
   docker build -t bbterm-sandbox:latest --build-arg UID=$(id -u) --build-arg GID=$(id -g) sandbox/
   ```
2. Add `--preview-ports` to `ExecStart` of `~/.config/systemd/user/bounty-board-terminal.service` (optionally `--ports-range 9100-9199` and `--tailscale-address auto`), then `systemctl --user daemon-reload && systemctl --user restart bounty-board-terminal`. A restart drops paused sessions (files stay).
3. On-host checks:
   - Open a report's terminal and run `python3 -m http.server 8000`. The drawer shows "1 port"; `curl -s http://127.0.0.1:9100/` lists the report folder.
   - `ss -ltnp | grep -E ':91[0-9][0-9] '` shows only `127.0.0.1:9100` (and, once Tailscale is on, `100.x.y.z:9100`), never `0.0.0.0:9100`, `*:9100` or `[::]:9100`.
   - `stat -c '%a %U' ~/.local/state/bounty-board/terminal/proxy/*/ports.sock` prints `600 <board user>`; `docker inspect bbterm-<id> --format '{{.HostConfig.NetworkMode}} {{len .Mounts}}'` prints `none 2`.
   - Settings, Terminal card, "Sandbox ports": turn on "Open sandbox ports over Tailscale". It shows "Tailscale address 100.x.y.z". From another tailnet device (your PC), open the drawer's pill, click Open on the main URL `http://100.x.y.z:9100/`: the listing appears.
   - Turn the switch off: the page on the PC stops loading (`curl -m 5 http://100.x.y.z:9100/` from the PC fails), `ss` shows only `127.0.0.1:9100` again, and the drawer's popover says "Only reachable on the server."
   - Inside the sandbox: `curl -s http://127.0.0.1:9100/` (through the proxy, `NO_PROXY=` cleared) prints "Blocked by sandbox egress policy".
4. Check the tailnet ACLs allow exactly the peers that should reach 9100-9199.
