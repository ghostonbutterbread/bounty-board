# Sandbox preview ports (backend and UI)

- Branch: `feat/board-terminal-ports`; base `18089f4` (origin/beta). Commits: `1aa50ea`, `efa5e83`, `0632c25`, review round 1 `53b9c3a`, `7493c3c`; merged terminal UX `ba02227`; review round 2 `12bef96`; UI `4ed50b8` (+ this dossier update).
- Owner surfaces: `terminal_ports.py` (new), `terminal_sandbox.py`, `terminal_service.py`, `sandbox/bbterm-ports.py` (new), `sandbox/Dockerfile`, `sandbox/Dockerfile.test`, `tests/test_terminal_ports.py` (new), `tests/test_terminal_service.py`, `tests/test_terminal_docker.py`; phase 2: `static/modules/sandbox-ports.js|css` (new), `static/index.html` tags, `static/tests/sandbox-ports.synthetic.test.cjs` (new, in `npm test`), `tests/terminal_browser_fixture.py` (`ports` mode).
- Ryu's request, short: a PoC server started in a report's sandbox (`python3 -m http.server 8000`, a small Flask app, a websocket server) must open in his browser on another tailnet machine. Bind to localhost always, and to the Tailscale address when a terminal setting says so.
- Phase 2 (done, on top of the terminal UX work): a ports pill in the drawer header and the Tailscale switch on the Settings page, built on `window.BoardTerminal` and `window.BoardSettings` (see "UI" below).
- Phase 3, Tailscale links (branch `feat/board-ports-tailnet-links`, base `69ee73d`): the Tailscale listener reuses the sandbox's own port number when free (`--ports-same`), a printed `http://localhost:8000/...` in the terminal is a link to the Tailscale URL, the drawer header shows the address itself (`100.101.102.103:8000` chips instead of "1 port"), and one interaction for every URL (Ctrl/Cmd+click or middle click opens, a click copies; no Open or Copy buttons). Ryu, verbatim: "it should be same port as the lh is running on if possible ... ctrl click opens and clikcing copies that way we dont need more ui buttons"; on the "1 port" pill: "so di like it to just list the address pls". See "Phase 3" below.

## How it works

```
browser on a tailnet machine ──http://100.x.y.z:8000/──┐   (same number as in the sandbox when free, else :9100)
local process on the host ─────http://127.0.0.1:9100/──┤
                                                        ▼
terminal_service.py  PortsHub: listeners 127.0.0.1:<n> (+ Tailscale IPv4:<sandbox port or n> when on)
                     per session: ports.sock (host-owned, 0600) in <state>/proxy/<session>/
                                   ▲ the agent dials out; the host never connects in
container (--network none, read-only, cap-drop ALL, unchanged)
  /run/bbterm (read-only mount): proxy.sock, ports.sock
  bbterm-ports agent: reads /proc/net/tcp{,6}, reports LISTEN ports, answers opens
  PoC server on 127.0.0.1:8000 or 0.0.0.0:8000
```

1. The agent (`sandbox/bbterm-ports.py`, run as a thread inside the 3128 forwarder process `bbterm-forward`, restarted by a supervisor loop if the thread dies) opens a control connection to `/run/bbterm/ports.sock` and reports the TCP ports in LISTEN state on loopback or the unspecified address, every second, only on change. 3128 is excluded by the agent and, independently, by the host.
2. For each reported port (at most 8) the host picks a number from `--ports-range` (default 9100-9199) and listens on `127.0.0.1:<n>`. When the setting is on it also listens on the Tailscale address: first on the sandbox's own number (`<tailscale ip>:8000`) if that number is in `--ports-same` and the bind succeeds, otherwise on `<tailscale ip>:<n>`.
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

Port item: `{port, host_port, local_url: "http://127.0.0.1:<host_port>/", tailscale_port: int|null, tailscale_url: "http://<tailscale ip>:<tailscale_port>/"|null, state: "open"|"paused"}`. `host_port` is always the loopback number (from `--ports-range`). `tailscale_port` is the number of the Tailscale listener: `port` itself when it was free and allowed by `--ports-same`, otherwise `host_port`. `tailscale_port` and `tailscale_url` are null when the setting is off, no address is found, or that one listener could not bind on either number. `state` is `paused` while the sandbox is paused (a connection wakes it).

`tailscale_reason`: `disabled` when the setting (or the flag) is off; `not_found` when on but no address is currently found (it keeps looking every 60 s); `null` when on and bound. `tailscale_address` is null unless on and found.

### Flags (`terminal_service.py`)

| Flag | Default | Meaning |
| --- | --- | --- |
| `--preview-ports` | off | Off: no `ports.sock`, no listeners, no agent connection accepted, `preview_ports: false` everywhere, POST settings 409. |
| `--ports-range LO-HI` | `9100-9199` | Host ports used for previews. 1024-65535, at most 1000 numbers, must not contain `--port`. |
| `--ports-same RANGES` | `1024-8999,10000-65535` | Numbers the Tailscale listener may take from the sandbox (sandbox 8000 → `100.x.y.z:8000`). Comma list of `LO-HI` within 1-65535 (checked at start; bad syntax refused). Empty (`--ports-same ''`) turns it off: Tailscale uses the `--ports-range` number like before. Always excluded whatever the flag says: the service `--port`, 3128 and 3129 (sandbox proxy, model relay) and every `--ports-range` number. 9000-9999 is outside the default because Tailscale Serve uses 9000, 9001 and 9502-9511 on that address today, and a squatted number would block a later `tailscale serve` on it. If the bind fails (in use, privileged, any error) the range number is used. Tried again every time a forward opens (server restart, Tailscale on, address change), so a restarted server gets its number back when free. Loopback never uses it. |
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

- **Drawer pill** in `window.BoardTerminal.slot('ports')` (phase 2; replaced by address chips in phase 3, see below): hidden when the server has `preview_ports: false` or the session has no ports; otherwise a Board-style pill "1 port" / "3 ports" (plug icon, accent tint, tooltip listing the sandbox ports). Works in every dock, in the two-line side header and on the phone sheet. The slot never starts a drag (the drag code ignores slots; tested for all four docks).
- **Popover** (a `role="dialog"` appended to `<body>`, fixed and clamped to the viewport): focus moves into it and stays inside on Tab; Esc closes and returns focus to the pill; a click outside closes. Each sandbox port shows `:8000` and its URL(s):
  - Tailscale on and bound: the Tailscale URL first (it works from another machine), then the 127.0.0.1 one labelled "on the server";
  - off: only the local URL and a muted "Only reachable on the server. Turn on Tailscale in Settings." with `Settings` a real `<a href="#/settings">`; on but no address: "Tailscale is on, but the server has no Tailscale address right now.";
  - each URL: the URL itself and Open are `<a target="_blank" rel="noopener noreferrer">`; Copy writes it to the clipboard (hidden-textarea fallback) and shows "Copied" for 1.6 s ("Copy blocked by the browser" when both fail);
  - a paused sandbox: muted "paused, opens on first visit".
  - only URLs of the form `http://<127.x.y.z or 100.64.0.0/10 IPv4>:<host_port>/` become links or Copy values (rebuilt from the parsed host and the item's `host_port`); anything else the service sends is shown as text with "unexpected address, not linked" (review round 3, P1).
- **Live updates**: `BoardTerminal.on('session')` fetches `GET <terminal_url>api/ports?<selector>` on attach and reset (and clears on null); `BoardTerminal.on('message')` applies `{"type":"ports"}` pushes and refetches the flags. No reload is needed when a server starts or stops, or when another tab switches Tailscale.
- **Settings**: `window.BoardSettings.register({id: 'terminal-ports', group: 'terminal', title: 'Sandbox ports', order: 50})` inside the Terminal card. "Saved on the server."; switch "Open sandbox ports over Tailscale" (`POST api/settings {ports_tailscale}`, JSON, `X-Requested-With: Bounty-Board`, same-origin); the port range and the Tailscale address ("Tailscale address 100.x.y.z", "No Tailscale address found on the server right now", or "The Tailscale address is detected when you turn this on"); the note "While this is on, anyone on your tailnet allowed by your ACLs can open sandbox ports. They are plain http." Errors: 409 `tailscale_not_found` → "No Tailscale address found on the server."; 409 `preview_ports_disabled` → the "Not enabled" line; 500 `settings_failed` → "Could not save the setting."; 401 → "Sign in to the terminal" linking to `/terminal/login?next=<this page>`. The switch always shows the server's answer (on error the section reloads the settings). Flag off: "Not enabled on this server. Start the terminal service with --preview-ports."

## Threat model

Newly reachable, and by whom:
- **Ports on 127.0.0.1** (always, when `--preview-ports` is on): any local process on the host, as for the Board itself. Same assumption as the existing service: local processes on Hoster are trusted.
- **Ports on the Tailscale address** (only when the setting is on): every tailnet peer the Tailscale ACLs let reach this machine on that port. There is **no Board auth** on these ports: whoever can reach them can use whatever the PoC server offers. Keep the setting off unless needed.
- **Since phase 3 the tailnet numbers are no longer confined to 9100-9199.** With the default `--ports-same`, a sandbox server on 8000 is reachable at `100.x.y.z:8000`, and a sandbox can pick almost any number in 1024-8999 and 10000-65535 (excluded: 9000-9999, the service port, 3128, 3129, the range). Tailnet ACLs can therefore **no longer scope preview ports by the 9100-9199 range**: an ACL that allows a peer `100.x.y.z:*` lets it reach any sandbox port while the setting is on. To get the old boundary back, start the service with `--ports-same ''` (Tailscale then uses only `--ports-range` numbers) and restrict 9100-9199 in ACLs.
- The same-number listener only ever binds the validated Tailscale IPv4 (never `0.0.0.0`/`::`; `_bind_tcp` refusals unchanged), so a sandbox cannot take a host loopback port. Loopback stays on the range number on purpose: on Hoster the loopback has short-lived agent proxy and browser CDP listeners in 8082-8095, 8466-8480 and 9223-9228 that come and go, and a sandbox must never squat a loopback port a local agent will connect to. - **Restart window of a host service (review round 1, S1).** A sandbox chooses the numbers it reports (any process in it can speak the agent protocol) and can retry about once a second. Without a guard, while a host service that listens on `0.0.0.0:N` or `<tailscale ip>:N` restarts, the hub could bind `<tailscale ip>:N` for the sandbox: the service then cannot bind `0.0.0.0:N` again (outage; Docker-published ports too), and tailnet peers opening `host:N` get the sandbox's page instead of that service (impersonation, for example a fake login page). **Closed by the seen-set:** the hub keeps the set of TCP numbers any other host process has been seen listening on, on any address (`/proc/net/tcp` and `/proc/net/tcp6`, state LISTEN), scanned at start, at every 60 s refresh, and right before every same-number bind; a number ever seen is never used for a same-number listener for the life of the service (it falls back to the 91xx number). The hub's own listeners are left out by socket inode, so a sandbox's earlier same-number use does not poison its number. A failed scan fails closed for that attempt (range number). Sandbox servers themselves are never in the host's tables: they live in the container's own network namespace. **What remains:** a host service that has not listened since the terminal service started (a new service, or one that was down at start and never came back) can still be pre-empted on the Tailscale address while a sandbox holds the number; the squat ends when the sandbox server stops, the switch goes off, or the session ends. A host service listening only between two scans (under 60 s) and restarting before the next one is not seen either. `--ports-same ''` turns the feature off (Tailscale then uses only 91xx numbers).
- Never `0.0.0.0` or `::`: `_bind_tcp` refuses the unspecified and multicast addresses, and only `127.0.0.1` and the validated Tailscale address are ever passed (tested: kernel view in `/proc/net/tcp` shows only those). Never the control API port (refused at start).
- The proxy port 3128 is never exposed (host-side filter, not trusted to the agent): exposing it would let peers use the sandbox's egress proxy.

What stays the same:
- The container keeps `--network none`, read-only root, cap-drop ALL, no-new-privileges, the same limits and exactly two mounts (`ports.sock` lives in the existing read-only `/run/bbterm` directory). The egress proxy and its address filter are unchanged: the sandbox still cannot reach host loopback, the LAN or the tailnet, **including its own exposed ports** (tested with the real container: both 403).
- The served pages are a different origin from the Board (`http://<ip>:<port>` vs `https://<node>.ts.net:9001`), so they cannot read or write the Board. The terminal cookie is `Secure` and `Path=/terminal`, so it is never sent to an `http://` port.

The tunnel only reaches the container's own loopback:
- The host never connects to anything for a forward. `terminal_ports.py` contains no `connect`, `connect_ex` or `create_connection` call (asserted by a test). It only accepts on its own listeners and on `ports.sock`.
- `ports.sock` is created by the host in a host-owned directory through `/proc/self/fd/<dir_fd>/…`, mode 0600, like `proxy.sock`; the container sees that directory read-only, so it cannot replace the socket with a symlink to a host socket (docker.sock). The host never connects to a path the container can write.
- The only thing the agent chooses is which bytes to send back on a data connection it dialled itself. Extra fields (`host`, `port` on a data line) close the connection (tested). The "destination" of a forward is whatever the agent connects to inside the container, which has only loopback.

## Phase 3: Tailscale links (same number, terminal links, address chips)

Backend (`terminal_ports.py`, `terminal_service.py` flag only):
- `_Forward.ts_port`: `_bind_tailscale` tries the sandbox number when `PortsHub.same_number_allowed(n)` (in `same_ranges`, not the service port, not 3128/3129, not in `--ports-range`), then the forward's `host_port`. The loopback listener is unchanged. Dropping the Tailscale listener clears `ts_port`, so off, address change (rebinds, trying the number again), stopped server, reset and removal all close or rebind it exactly like the old tailnet listener; switching off still closes first and saves second.
- Two sandboxes on 8000: the first gets `100.x.y.z:8000`, the second's bind fails and it uses its own range number; when the first stops, the second gets 8000 the next time its forward opens.

UI (`static/modules/sandbox-ports.js|css`; seams in `sandbox-terminal.js|css`):
- **One interaction rule** for every URL (header chips, popover, terminal): a real `<a href target="_blank" rel="noopener noreferrer" data-ports-url>` (terminal: `window.open(url, '_blank', 'noopener,noreferrer')`); Ctrl+click, Cmd+click, Shift/Alt+click and middle click open natively; a plain left click is intercepted and copies the URL, then "Copied" (or "Copy blocked by the browser") shows for 1.6 s: on a header chip the chip's own text changes, in the popover a note appears beside the URL. On touch-only devices (`(any-pointer: fine)` false) a tap opens. Link title / tip hint: "Ctrl+click to open, click to copy" ("Cmd+click ..." on Apple platforms, "Tap to open" on touch). The popover's Open and Copy buttons are gone.
- **Address chips (1b, replaces the "1 port" pill and the earlier "Port 8000 is live" line)** in `BoardTerminal.slot('ports')`: one Board-style accent pill per port with the main address as its text, `100.101.102.103:8000` (the Tailscale address and `tailscale_port`); with Tailscale off, the local `127.0.0.1:<host_port>`, muted, with "Only reachable on the server. Turn on Tailscale in Settings." in its tooltip ("Tailscale is on, but the server has no Tailscale address right now." when on without an address). The plug icon is on the first chip only. Each chip is the real link (`<a href target="_blank" rel="noopener noreferrer" draggable="false">`) with the one interaction rule; tooltip: the full URL, then the hint. An address that fails `safeUrl` is muted text, not a link. Since review round 1 each URL is held to its own address type: `local_url` must be `http://<127.0.0.0/8>:<host_port>/`, `tailscale_url` must be `http://<100.64.0.0/10>:<tailscale_port>/` (`host_port` when an older service sends no `tailscale_port`). TEST ONLY: a test page can name one loopback alias as its Tailscale address (`window.__BOARD_PORTS_TEST_TAILNET__`, set by the browser tests through an init script; page scripts are trusted anyway, the check guards against what the service sends). More than two ports: the first two chips and a "+N" chip that opens the popover with every port; with one or two ports there is no popover unless the header is short of room (below). Hidden without ports.
- **Fit pass** (measured, not guessed, after every change and when the drawer's dock or width changes): the chips must not add a header row, move the dock picker, the session text, the status pill or the actions, overflow a row, or overlap another header element. It tries two chips, then one chip and "+N", then one chip with shorter text (ellipsis, full URL in the tooltip), then only "+N" (plug icon and number). When even that does not fit (a side dock at its minimum width, whose first row has about 8 px left), no chip is shown rather than one over the dock picker; widening the drawer brings them back, and terminal links keep working. Measured in the test fixture at 1280 px with the sidebar: right and left docks two chips; top and bottom one chip and "+2" for three ports; bottom at 760 px one shortened chip; a right dock at its minimum (1120 px window) none; phone sheet one chip. The slot never starts a drag (tested for chips and "+N" in every dock).
- **Terminal links (1a)**: an xterm link provider (`BoardTerminal.on('terminal')`) finds `http(s)://` text whose host is `localhost`, `127.x.y.z`, `0.0.0.0`, `[::1]` or `[::]` with an explicit port that is a forwarded sandbox port of this session. The target is that port's main URL (Tailscale, else local) with the printed path, query and fragment kept, built with `new URL` from parsed parts; the result must keep the validated forward host and port (same rules as `safeUrl`: http, 127.0.0.0/8 or 100.64.0.0/10 IPv4, the item's own port; an `https://` print keeps https on that same host and port). Anything else (another host, userinfo, `localhost:8000@evil`, an unforwarded port, no port) is not a link. Hover shows a tip built with `textContent` ("Opens over Tailscale" / "Opens on the server", the target, the hint). A drag that ends on a link is left to the selection and copy-on-select. Wide characters before the URL are mapped to cell columns.
- **Settings** copy: the switch text says the port uses "the same port number as in the sandbox when that number is free"; the note says ports "can be on almost any port number, not only the range above".

Seam (one hunk in the extension-point block of `sandbox-terminal.js`; no CSS change there):
- `'terminal'` event: the xterm instance, emitted from `emitSession()` the first time a session attaches with a terminal (it is created once per page and never disposed), replayed to late subscribers in `on()`. The earlier `BoardTerminal.strip(name)` seam (for the live line) was removed with the line, so the export line is untouched.

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
18. (Phase 3) The `'terminal'` event is emitted from `emitSession()` (inside the extension-point block) rather than from `ensureTerm()`, so the seam stays in that block; the xterm instance exists before every hello, links only matter with a session, and the instance is never replaced. (A `strip(name)` seam for a below-header line existed in `f0958a5`..`6a0222d` and was removed in `226d4a8` together with the line.)
19. (Phase 3) Same-number binding is on by default (`--ports-same 1024-8999,10000-65535`) because that is what Ryu asked for; `--ports-same ''` restores the 9100-9199 boundary for ACLs.
20. (Phase 3) An `https://localhost:8000/` print links to `https://<tailscale ip>:8000/` (scheme kept, host and port validated); the forward is plain TCP, so a TLS PoC server works through it, and linking it as http would break it.
21. (Phase 3) Shift+click and Alt+click on a URL are left to the browser (new window / download) rather than copying; only a plain left click copies.
22. (Phase 3, revised after Ryu's "just list the address") The header shows the address itself, one chip per port, two at most, then "+N" for the popover; the separate "Port N is live" line is gone. With one or two ports there is no popover, except when the fit pass has to fall back to fewer chips.
23. (Phase 3) When no chip fits (side dock at its minimum width), the slot shows nothing rather than overlapping the dock picker; the old "1 port" pill overlapped there too. Showing the chips in the side header's second row would need a change to the drawer markup, which this branch avoids.
24. (Phase 3) Chip text is `host:port` without `http://` and the trailing slash; the full URL is in the tooltip and is what gets copied or opened.
25. (Review round 1, L1) A terminal link re-checks its text against the current ports list when clicked (open or copy) and acts only if it still leads to the same URL; otherwise it shows "Port closed" and does nothing. When the ports change, every terminal row is re-rendered, which makes xterm drop its cached (hovered) link, and the tip is hidden.
26. (Review round 1, S1) The seen-set is chosen over narrowing the default ranges: it keeps Ryu's "same number when free" for PoC ports and refuses numbers real host services use. It grows only (at most 65535 numbers) for the life of the service. TEST ONLY: `BBTERM_TEST_SANDBOX_PORTS` (honoured only with `--backend local-test-only`, same gate as `BBTERM_TEST_TAILSCALE_FILE`) leaves the browser fixture's host-side sandbox server out of the scan; the Python tests wrap the scan the same way for their in-process sandbox servers.
27. (Review round 1, minor 1) The link provider reads a wrapped line as one (rows joined while the next row is an xterm `isWrapped` continuation, at most 16 rows each way), so a URL cut at the row end links as a whole (a multi-row range) and never by its first row's prefix.

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

### Review round 3 (6c6fa73, phase 2) and fixes

The reviewer returned ACCEPT (fix P1): N1-N3 confirmed, R3 holds on the per-IP cap plus idle rule, no markup injection, the Settings switch and sign-in link correct, the test-only Tailscale override unreachable in production, drawer integration clean. Fixed by the orchestrator; red/green by swapping only the changed source file back to `6c6fa73`.

| # | Finding | Fix | Regression test | 6c6fa73 → now |
| --- | --- | --- | --- | --- |
| P1 (should-fix) | Popover links and Copy used the service's URLs without checking scheme or host (`javascript:` or a foreign host would become a link). | `safeUrl()`: only `http:` to a 127.0.0.0/8 or 100.64.0.0/10 IPv4, path `/`, no credentials, query or fragment, and the port equal to the item's `host_port`; the link is rebuilt from those parts; anything else is shown as text, no Open or Copy. | `sandbox-ports.synthetic` "popover links only http URLs to loopback or a Tailscale address on the host port (review P1)" (`javascript:`, foreign host, wrong port, extra path all unlinked; valid Tailscale and local URLs linked and copyable) | FAIL (`only the valid URLs are links`) → pass |
| P2 (nit) | At the pids limit `Thread.start` raised `RuntimeError` in the agent's reader and `forward()`, printing a traceback per open. | Both catch `RuntimeError` (the host times the open out). | `AgentThreadLimitTests` (reader and forward with `Thread.start` failing) | 2 ERROR (`RuntimeError: can't start new thread`) → OK |

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

### Phase 3 evidence

Run on Ghost, `TMPDIR=/tmp/bbl`, synthetic data only, each file alone and serially (`-W error::ResourceWarning`; browser with `NODE_PATH=$PWD/node_modules CHROME_BIN=/opt/google/chrome/chrome node --test --test-concurrency=1`). Docker suite not run (no `sandbox/` change; the same-number logic is host side and covered with loopback aliases).

| Run | Result |
| --- | --- |
| `tests.test_terminal_ports` | 59 OK (10 new in `SameNumberTests`) |
| `tests.test_terminal_service` | 30 OK (new `test_ports_same_flag_reaches_the_hub`; bad `--ports-same` values in `test_lifecycle_flags_are_validated`; `tailscale_port` in the item keys) |
| `tests.test_terminal_sandbox` / `test_terminal_proxy` / `test_terminal_ws` | 47 / 36 / 38 OK |
| `static/tests/sandbox-ports.synthetic.test.cjs` (at `226d4a8`, chips) | 5 pass |
| `static/tests/sandbox-terminal.synthetic.test.cjs` | 18 pass |
| `static/tests/sandbox-terminal-filter.test.cjs` | 5 pass |

Red before green (only the named source file swapped back, then restored):
- `terminal_ports.py` at `69ee73d`: `SameNumberTests` 9 of 10 ERROR (`KeyError: 'tailscale_port'`, no `same_number_allowed`/`same_ranges`/`parse_same_ranges`, connection refused on `127.0.0.2:<sandbox port>`); `test_stopped_server_closes_the_same_number_listener` passes on both (guard). The new service module does not import against the old hub (`parse_same_ranges` missing).
- `terminal_service.py` at `69ee73d`: `test_ports_same_flag_reaches_the_hub` ERROR (the flag never reaches `make_service`); the bad-flag cases pass on both (the old parser refuses the unknown flag; guard).
- `static/modules/sandbox-ports.js|css`: at `69ee73d` 3 of 5 browser tests failed (round 1: Open/Copy buttons, no terminal links, no copy on click); at `6a0222d` (the live line and "1 port" pill): see the chip round below.
- `static/modules/sandbox-terminal.js` at `69ee73d`: see the chip round below (no `'terminal'` event: no links).

What the new tests prove:
- Hub: Tailscale on `127.0.0.2:<sandbox port>` while loopback stays on the range number and nothing listens on `127.0.0.2:<range number>`; two sessions on the same port (first keeps it, second falls back, then gets it when its forward reopens after the first stopped); a squatter on the Tailscale address forces the fallback and the number comes back once free; a restarted hub gets it back; exclusions (service port, 3128, 3129, range ends and middle, 9000, 9001, 9502, 9999, 80, 1023, empty flag) and a live out-of-range port; the parser accepts the default, spaces, single-number ranges and empty, refuses 8 bad forms; off closes the same-number listener and its connection even when the save fails, and on again rebinds the same number; an address change rebinds the number on the new address and loss closes it; reset/removal closes listener and connection; a stopped server closes it.
- Browser, chips (fixture `tailnet,ports`, the TEST-ONLY alias 127.0.0.2 as the Tailscale address): no chip and no below-header line without ports; Tailscale off: one muted chip `127.0.0.1:<host_port>`, an `<a>` with `href` the local URL, `target="_blank" rel="noopener noreferrer"`, tooltip "URL / Only reachable on the server. Turn on Tailscale in Settings. / Ctrl+click to open, click to copy", one plug icon, no "+N"; a plain click copies (clipboard checked, no new tab, no navigation, no popover), the chip reads "Copied" then its address again. Tailscale on: `tailscale_port` equals the sandbox port, the chip reads `127.0.0.2:<sandbox port>` (not muted), the URL serves the synthetic page and the range number on 127.0.0.2 refuses; click copies; Ctrl+click and middle click open the exact URL with `window.opener === null`; a blocked clipboard makes the chip read "Copy blocked by the browser". Terminal links as in round 1: tip "Opens over Tailscale" with `http://127.0.0.2:<port>/poc/x.html?a=1#f` and the hint, click copies, Ctrl+click and Meta+click open (noopener), the tip holds text only, 22 `linkTarget` cases, an unforwarded port is not a link, a drag into the link selects and copy-on-select copies the selection. Three ports on a wide window: two chips and "+1", one plug icon, the header intact; "+1" opens the popover (3 items, Tailscale URL first, "on the server", real links with the hint, no buttons, focus inside, click copies with "Copied", Ctrl+click opens, Esc returns focus to "+1", a click outside closes). Another tab switches Tailscale off: the chips turn into the muted local addresses by push and the popover shows the Settings hint. Docks right, left, top, bottom at 1280 px, right at its minimum (1120 px window) and bottom at 760 px: an independent check (head height and the tops of the dock picker, actions, session text and status unchanged against the same header with the slot hidden; chips on one line, inside the drawer, overlapping nothing) holds everywhere; every port is a chip or behind "+N" except the minimum side dock, where the slot is hidden; the popover stays in the viewport; dragging from a chip or "+N" never starts a drawer drag. Phone sheet (390 px, touch only): the chip fits without changing the header, its tooltip ends "Tap to open", a tap opens it; three ports keep one line and "+N" opens a popover that fits. Bad addresses: the first two chips are muted `<span>`s (no link), "+2" opens the popover where only the three valid URLs are links (`tailscale_port` honoured: a Tailscale URL on another port is text).

Chip round (`226d4a8`) red before green, browser file `sandbox-ports.synthetic.test.cjs`, only the named files swapped back, then restored: `sandbox-ports.js|css` at `6a0222d` (the "1 port" pill and the live line): 3 of 5 fail (all three chip tests); `sandbox-terminal.js` at `69ee73d` (no `'terminal'` event): 1 of 5 fails (the main test, at the terminal link step); restored: 5 of 5 pass. `sandbox-terminal.synthetic.test.cjs` 18 pass with the reduced seam.

Screenshots (synthetic, looked at), in `/tmp/bbl/shots2/`: `ports-chip-one-{light,dark}.png` (header with one Tailscale chip), `ports-chip-local-{light,dark}.png` (muted local chip), `ports-chips-three-{light,dark}.png` (two chips and "+1"), `ports-popover-three-{light,dark}.png` (popover without buttons, "Copied"), `ports-terminal-link-{light,dark}.png` (hovered terminal link), `ports-chips-right-narrow-{light,dark}.png` (minimum side dock: no chip), `ports-popover-right-*`, `ports-settings-{off,on}-*`, `ports-phone-*`.

### Phase 3 review round 1 (`5ab578c`) and fixes (`2d21eef`)

The reviewer returned ACCEPT (fix L1; decide or fix S1) with two minors. All four fixed. Red/green: only the named source file swapped back to `5ab578c`, the tests run, the file restored (everything committed first). The reviewer's repros were copied to `$TMPDIR` with only the worktree path rewritten (originals untouched).

| # | Finding | Fix | Regression test | `5ab578c` → now |
| --- | --- | --- | --- | --- |
| L1 (should-fix) | A cached terminal link still opened (Ctrl+click) or copied after its forward was gone; the freed number can belong to another session's sandbox later. | `activate` and the deferred copy re-run `linkTarget(text)` and act only on the same URL, else "Port closed"; a ports change re-renders every terminal row (xterm drops the cached link) and hides the tip. | `sandbox-ports.synthetic` "stale terminal link opens and copies nothing after the forward disappeared (review round 1, L1)": hovered link, server stops, the tip goes away without moving the pointer, Ctrl+click opens nothing, a click copies nothing | FAIL → pass. Reviewer repro `test_stale_link.cjs`: FAIL → pass (as given, and with the test-page Tailscale hook added so it passes for the right reason after minor 2) |
| S1 (should-fix) | A sandbox could take a host service's number on the Tailscale address during that service's restart (outage, impersonation to tailnet peers). | Seen-set of host listener numbers (`/proc/net/tcp{,6}`, LISTEN, any address; at start, each 60 s refresh, right before each same-number bind; the hub's own sockets excluded by inode); a seen number never gets a same-number listener; a failed scan falls back. Threat model updated. | `SameNumberTests.test_s1_host_service_number_is_not_taken_during_its_restart` (the reviewer's scenario), `..._numbers_seen_at_start_or_right_before_the_bind_are_never_used`, `..._own_same_number_listener_does_not_poison_the_number`, `..._a_failed_scan_fails_closed_for_that_attempt`, `..._host_listening_ports_reads_proc_and_skips_excluded_inodes`; `test_terminal_service` checks the real scan is the default and the TEST-ONLY ignore list is not honoured with the Docker backend | 5 ERROR (the old hub has no `host_ports` parameter, so `SameNumberTests.setUp` fails) → 5 OK. Reviewer repro `test_same_number_squat.py` (uses the plain hub, so it fails on the behaviour): FAIL `52255 == 52255` → OK |
| Minor 1 | A URL wrapped across rows could link its first row's prefix (`http://localhost:800` + `0/`). | Rows of a wrapped line are joined (`isWrapped`, at most 16 each way); links get multi-row ranges. | "a URL wrapped across terminal rows links as a whole, never by its first row (review round 1, minor 1)": with 800 forwarded, `http://localhost:800` / `0/` gives no link on the first row; a forwarded URL cut as `.../wr` / `apped` is one link from either row, click copies the whole URL | FAIL → pass |
| Minor 2 | `safeOrigin` accepted 127.x for `tailscale_url` and 100.64.0.0/10 for `local_url`. | Per-type rule: `local_url` 127.0.0.0/8 on `host_port`, `tailscale_url` 100.64.0.0/10 on `tailscale_port` (test pages may name one loopback alias). | P1 test gains port 8004 with `local_url` on 100.101.102.103 and `tailscale_url` on 127.0.0.1 (each on its right port): no link either way; 7 bad URLs as text | FAIL → pass |

On `5ab578c` the whole browser file: 4 pass, 3 fail (L1, minor 1, P1/minor 2).

Round 1 runs (`TMPDIR=/tmp/bbl`, serially, each file alone, no Docker): `tests.test_terminal_ports` 64 OK, `tests.test_terminal_service` 30 OK, `tests.test_terminal_sandbox` 47 OK, `tests.test_terminal_proxy` 36 OK, `tests.test_terminal_ws` 38 OK; `static/tests/sandbox-ports.synthetic.test.cjs` 7 pass, `sandbox-terminal.synthetic.test.cjs` 18 pass, `sandbox-terminal-filter.test.cjs` 5 pass. One earlier `test_terminal_ports` run during development failed `test_n3_per_ip_cap_is_48_and_refusals_are_logged_rate_limited` on its refusal-count wording (timing on the loaded box); every run since passed it.

### Phase 3 re-review (`94357a2`) and the orchestrator's minor fix

The reviewer returned ACCEPT: L1, S1 and both minors confirmed (its repros pass on `94357a2`), the two TEST-ONLY hooks judged unreachable in production (`BBTERM_TEST_SANDBOX_PORTS` is read only in the `local-test-only` branch; `window.__BOARD_PORTS_TEST_TAILNET__` is compared with `===`, so DOM clobbering cannot match it, and it can only let one 127/8 address pass as `tailscale_url` on the exact port), the own-socket exclusion matched by inode, and the row redraw limited to visible rows. One new minor, fixed by the orchestrator; the nit was left as is.

| # | Finding | Fix | Test | Red on `94357a2` → now |
| --- | --- | --- | --- | --- |
| F1 (minor) | Every same-number bind re-read `/proc/net/tcp{,6}` under the hub lock with no rate limit; an agent alternating two sets of ports within the report limit forced up to 80 full scans per 5 s per session. | The bind path reuses a successful scan at most `SCAN_MAX_AGE` (1 s) old; a failed scan is not reused (the next bind retries, still falling back meanwhile). The start-up scan and the 60 s refresh always scan and do not touch that cache. | `ScanRateTests.test_agent_churn_does_not_force_a_scan_per_bind` (the reviewer's repro), `..._an_expired_scan_is_redone_before_a_same_number_bind` | FAIL (36 scans in 0.2 s) → OK; the second errors on the old module (no `SCAN_MAX_AGE`) → OK |
| F2 (nit) | `window.__BOARD_PORTS_TEST_TAILNET__` is a test global in production code. | Left as is (does not widen anything, see above). | | |

Remaining effect of F1's cache: a host service that starts listening less than 1 s after the last bind-path scan and stops again before the next scan is not seen; the start-up and 60 s scans are unchanged.

Runs (`TMPDIR=/tmp/bbl`): `tests.test_terminal_ports` 66 OK, `tests.test_terminal_service` OK; the reviewer's `test_scan_rate.py` (path rewritten) OK.

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

- (Phase 3) A side dock at its minimum width has no room in its header's first row: the chips are hidden there (decision 23). Widen the drawer or use the terminal links.
- (Phase 3) Bottom and top docks at 1280 px with the sidebar show one chip and "+N" for two or more ports (the session text takes the room), so two ports open the popover there.
- (Phase 3) A URL wrapped over more than 16 rows is not joined beyond that (decision 27).
- (Phase 3) Touch-only means `(any-pointer: fine)` is false; a tablet with a trackpad counts as fine (click copies, Ctrl+click opens).
- (Phase 3) No Docker run for this phase (no `sandbox/` change). On Hoster, check with `ss -ltn` that `100.x.y.z:8000` appears and the service holds no `127.0.0.1:8000`.
- (Phase 3) A sandbox can still hold a Tailscale-address number that a host service which has not listened since the terminal service started wants later (see the threat model, S1), until its server stops, the switch goes off or the session ends.

## Decisions for Ryu

1. Ports bound on Tailscale have no Board login in front of them; anyone your ACLs allow on 9100-9199 can use the PoC. OK, or do you want a per-port token in the URL later?
2. A server that stops keeps its host port for the session's life (max 16 per session), so the URL survives restarts. A full range lets other sessions take those idle numbers.
3. A full range leaves the extra port out of the list (logged), so the contract keeps only `open` and `paused` states. Would you rather see it listed as "no free port"?
4. `tailscale_reason` reads `disabled` whenever the switch is off, even when an address exists. Detection only runs when you switch it on.
5. Default range 9100-9199, at most 8 ports per sandbox, 48 connections per client IP: keep these?
6. The pill says "1 port" / "3 ports" and sits next to the status pill; the popover lists ports by sandbox number (`:8000`). Wording or place OK?
7. The Settings card header still says "Saved in this browser." (it belongs to the terminal's own controls); the ports section adds "Saved on the server." under its title. Fine, or should the card note move into each section?
8. (Phase 3) Same number on Tailscale is on by default. Tailnet ACLs can no longer limit preview ports to 9100-9199; `--ports-same ''` brings that boundary back. OK as the default?
9. (Phase 3) The default same-number ranges `1024-8999,10000-65535` skip 9000-9999 (Tailscale Serve). A PoC on 9000-9999 gets a 91xx URL. Fine?
10. (Phase 3) A printed `https://localhost:8443/` links to `https://<tailscale ip>:8443/` (scheme kept). OK?
11. (Phase 3) The header chips show the address (`100.101.102.103:8000`), at most two, then "+N" for the popover; fewer when the header is short. In a side dock at its minimum width no chip fits and none is shown. OK, or should the side dock put them on its second line (needs a small drawer markup change)?

## Deployment on Hoster (orchestrator)

Do these as the Board's user; do not change Serve.

1. Rebuild the production image (the forwarder now runs the ports agent; the CMD passes `/run/bbterm/ports.sock`):
   ```sh
   cd ~/path/to/bounty-board
   docker build -t bbterm-sandbox:latest --build-arg UID=$(id -u) --build-arg GID=$(id -g) sandbox/
   ```
2. Add `--preview-ports` to `ExecStart` of `~/.config/systemd/user/bounty-board-terminal.service` (optionally `--ports-range 9100-9199` and `--tailscale-address auto`), then `systemctl --user daemon-reload && systemctl --user restart bounty-board-terminal`. A restart drops paused sessions (files stay).
3. On-host checks:
   - Open a report's terminal and run `python3 -m http.server 8000`. The drawer header shows `127.0.0.1:9100` (muted; `100.x.y.z:8000` once Tailscale is on); `curl -s http://127.0.0.1:9100/` lists the report folder.
   - `ss -ltnp | grep -E ':91[0-9][0-9] '` shows only `127.0.0.1:9100`, never `0.0.0.0:9100`, `*:9100` or `[::]:9100`. Once Tailscale is on (phase 3), `ss -ltn | grep ':8000 '` shows `100.x.y.z:8000` and no `127.0.0.1:8000` or `0.0.0.0:8000` from the service.
   - `stat -c '%a %U' ~/.local/state/bounty-board/terminal/proxy/*/ports.sock` prints `600 <board user>`; `docker inspect bbterm-<id> --format '{{.HostConfig.NetworkMode}} {{len .Mounts}}'` prints `none 2`.
   - Settings, Terminal card, "Sandbox ports": turn on "Open sandbox ports over Tailscale". It shows "Tailscale address 100.x.y.z". From another tailnet device (your PC), Ctrl+click the header chip `100.x.y.z:8000`: the listing appears.
   - Turn the switch off: the page on the PC stops loading (`curl -m 5 http://100.x.y.z:9100/` from the PC fails), `ss` shows only `127.0.0.1:9100` again, and the drawer's popover says "Only reachable on the server."
   - Inside the sandbox: `curl -s http://127.0.0.1:9100/` (through the proxy, `NO_PROXY=` cleared) prints "Blocked by sandbox egress policy".
4. Check the tailnet ACLs allow exactly the peers that should reach this machine's preview ports. Since phase 3 these are not confined to 9100-9199 (see the threat model); add `--ports-same ''` to `ExecStart` if the ACLs must scope them by that range.
5. Phase 3 needs only a terminal service restart (no image rebuild: `sandbox/` is unchanged) and a Board reload. In the drawer, `python3 -m http.server 8000` prints `http://0.0.0.0:8000/`: hover it (tip "Opens over Tailscale", `http://100.x.y.z:8000/`), a click copies, Ctrl+click opens on the PC.
