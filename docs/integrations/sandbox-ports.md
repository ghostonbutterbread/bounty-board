# Sandbox preview ports (phase 1: backend)

- Branch: `feat/board-terminal-ports`; base `18089f4` (origin/beta).
- Owner surfaces: `terminal_ports.py` (new), `terminal_sandbox.py`, `terminal_service.py`, `sandbox/bbterm-ports.py` (new), `sandbox/Dockerfile`, `sandbox/Dockerfile.test`, `tests/test_terminal_ports.py` (new), `tests/test_terminal_service.py`, `tests/test_terminal_docker.py`.
- Ryu's request, short: a PoC server started in a report's sandbox (`python3 -m http.server 8000`, a small Flask app, a websocket server) must open in his browser on another tailnet machine. Bind to localhost always, and to the Tailscale address when a terminal setting says so.
- Phase 2 (after `feat/board-terminal-ux` lands): a ports chip in the drawer header and the Tailscale toggle on the Settings page, built against the contract below. No `static/` changes in this phase.

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

1. The agent (`sandbox/bbterm-ports.py`, started by the image CMD next to the 3128 forwarder, restarted by a shell loop if killed) opens a control connection to `/run/bbterm/ports.sock` and reports the TCP ports in LISTEN state on loopback or the unspecified address, every second, only on change. 3128 is excluded by the agent and, independently, by the host.
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
| `--tailscale-address auto\|IPv4` | `auto` | `auto`: the first IPv4 in 100.64.0.0/10 on a local interface, `tailscale0` first. An explicit address must be in 100.64.0.0/10 (checked at start) and local (checked when used; otherwise `not_found`). |

The setting itself lives in `<state-dir>/settings.json` (`{"ports_tailscale": false}` by default): atomic replace (new 0600 file, fsync, rename, directory fsync), never written after a failed read (permissions, symlink, directory: changes are refused until it is fixed), a corrupt file is renamed to `settings.json.corrupt-<stamp>-<rand>` before the first write replaces it, unknown keys are kept (room for app-wide settings later). Changing it applies live: on opens Tailscale listeners for every current forward; off closes them and the connections that came through them (local ones stay).

### Agent protocol (`ports.sock`)

Newline-delimited JSON, each line at most 4 KiB, exact key sets, integers checked with `type(x) is int`.

| Direction | Message |
| --- | --- |
| agent → host, first line | `{"t":"hello","v":1}` (control) or `{"t":"data","id":"<32 hex>"}` (answer; raw bytes follow) |
| agent → host, control | `{"t":"ports","ports":[…]}` (≤ 64 unique ints 1-65535), `{"t":"fail","id":…}` |
| host → agent, control | `{"t":"open","id":…,"port":…}` |

Limits (the agent is untrusted: any process in the sandbox can kill it and speak this): 8 forwarded ports per session (existing ones kept first, then lowest new), 32 forwarded connections per session, 128 in total, 16 opens waiting, an open not answered in 5 s closes the browser connection and kills the id, ids valid once, 5 s total deadline for the first line (a trickle does not extend it), 8 connections that have not identified themselves, 10 control connections per minute per session, 10 `ports` reports per 5 s per control connection (the real agent sends at most one a second; nesting too deep for the parser counts as malformed) (a new control replaces the old one; losing the control connection withdraws its ports until the agent reports again), a kernel send timeout on the control socket so an agent that stops reading cannot hold a sender. Any malformed line closes that connection only. A `fail` for an unknown id is ignored (it may have timed out). Forwarded bytes are never parsed.

### Lifecycle

- Host numbers are reserved per session and sandbox port for the session's life (pause included), at most 16 remembered per session (oldest inactive dropped first). When the range is full, a number that another session only remembers for a port that stopped listening is reused (that port gets a new number if it comes back); a listening forward is never taken. Released on removal, reset (a reset is a new sandbox with no ports) and service stop. If another host process holds a number, the next free one is used. When the range is full the port is not listed and stderr says `no free host port in LO-HI for sandbox port P`.
- Pause: a new inbound connection to a paused sandbox runs `docker unpause` first (idempotent). Forwarded traffic counts as activity for the pause timer (checked at most every 5 s while bytes flow), so a PoC page in use does not freeze after 5 min. It does **not** count for removal: removal stays 4 h after the last terminal viewer left. Lock order stays session lock, then manager lock; the ports lock is never held while calling into a session.

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
7. No idle timeout on forwarded connections (a websocket PoC may idle); they end with the client, the sandbox server, a reset/removal, or switching Tailscale off (for tailnet ones).
8. The agent includes any loopback address (127.0.0.0/8, ::1) or the unspecified address; a server on `127.0.0.2` only is listed but the agent connects to 127.0.0.1/::1, so the open fails and the browser connection closes.
9. GET `/api/settings` with the flag off reports `ports_tailscale: false` and does not create `settings.json`.
10. The agent is a second Python process started by a `sh` restart loop in the CMD (not a thread in the forwarder), so killing it inside the sandbox only costs a second; the price is memory (below).
11. `settings_unreadable` answers 500 (a server-side fault the user cannot fix from the browser); the contract's two 409s are unchanged.

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
- Memory: idle sandbox measured 41 to 56 MiB in these runs (earlier rounds: 16 to 18 MiB). The agent is a second Python process; load on the shared machine also varies, so the exact cost is not isolated.

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

## Gaps

- Not built: the production `sandbox/Dockerfile` (no network here). The real-container tests use `sandbox/Dockerfile.test` built as `bbterm-test-image-ports:latest`. Rebuild the production image on Hoster to get the agent; an old image simply never connects (no ports listed).
- UDP is not forwarded; only TCP.
- The Tailscale listeners have no auth of their own (by design; see threat model).
- A port open on `127.0.0.2` only inside the sandbox is listed but cannot be reached (decision 8).
- Phase 2 UI (drawer chip, Settings toggle) is not built; no screenshots.
- Idle sandbox memory went up (41 to 56 MiB measured here, 16 to 18 MiB before); not isolated from machine load.
- `test_terminal_docker` `test_065` (existing pause timing) failed once under load and passed in the two later runs.
- My test image `bbterm-test-image-ports:latest` is left built for phase 2 (remove with `docker rmi bbterm-test-image-ports:latest`).

## Decisions for Ryu

1. Ports bound on Tailscale have no Board login in front of them; anyone your ACLs allow on 9100-9199 can use the PoC. OK, or do you want a per-port token in the URL later?
2. A server that stops keeps its host port for the session's life (max 16 per session), so the URL survives restarts. A full range lets other sessions take those idle numbers.
3. A full range leaves the extra port out of the list (logged), so the contract keeps only `open` and `paused` states. Would you rather see it listed as "no free port"?
4. `tailscale_reason` reads `disabled` whenever the switch is off, even when an address exists. Detection only runs when you switch it on.
5. The agent runs as its own process with a restart loop. That is the most robust choice, but it costs some idle memory per sandbox.
6. Default range 9100-9199 and at most 8 ports per sandbox: keep these?

## Deployment (orchestrator)

1. Rebuild the image (adds `/usr/local/bin/bbterm-ports` and the new CMD): `docker build -t bbterm-sandbox:latest --build-arg UID=$(id -u) --build-arg GID=$(id -g) sandbox/`.
2. Add `--preview-ports` to the terminal service unit (optionally `--ports-range` / `--tailscale-address`) and restart it (this drops paused sessions, as before).
3. Verify: open a report's terminal, `python3 -m http.server 8000`, then `curl -s "http://127.0.0.1:9011/api/ports?…"` is not needed: on Hoster `curl -s http://127.0.0.1:9100/` lists the folder. Switch Tailscale on (`POST /terminal/api/settings {"ports_tailscale": true}` from the Board origin, or the phase 2 toggle), then from another tailnet machine open `http://<hoster tailscale ip>:9100/`. `ss -ltn` must show `127.0.0.1:9100` and `100.x.y.z:9100`, never `0.0.0.0:9100` or `[::]:9100`.
4. Check the tailnet ACLs allow exactly the peers that should reach 9100-9199.
