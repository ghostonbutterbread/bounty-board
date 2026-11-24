# Bounty Board

A local-first workspace for navigating bug-bounty findings, surface coverage, reports, gadgets, and MapStore observations. It is a view over existing program/lane records, not a replacement for the systems that own them.

> **Development status:** This feature branch is under review. Source writes are off by default. Shared drafts and experimental source autosave require explicit options; finding metadata edits require a compatible BBH installation. Concurrent external writers and sync replicas can race the report writer: do not enable it without accepting the limitations below.

## Run locally

Requires Python 3.11 or newer; the server's Python code uses the standard library. The default root is `~/Shared`; the root must contain `web_bounty/` and/or `binaries/`. Read-only use and simple shared-draft edits do not require Git; three-way collaboration merges require the `git` executable on the server's `PATH` (`git merge-file`).

```sh
python3 app.py --root "$HOME/Shared" --port 9001
```

Open `http://127.0.0.1:9001/` on the same machine. Alternatively, create a JSON config outside the repository:

```json
{"root": "/path/to/Shared", "port": 9001}
```

```sh
python3 app.py --config /path/to/board.json
```

TOML files with top-level `root` and `port` are also accepted. Relative roots resolve against the config file's directory. `--root` and `--port` override the config; changing the configuration does not move data.

### Optional Tailscale Serve access

The backend always binds `127.0.0.1` and has **no authentication or TLS**. To opt in to one exact Tailscale Serve HTTPS hostname, start the board with the canonical lowercase DNS name shown for this node in Tailscale, for example:

```sh
python3 app.py --root "$HOME/Shared" --port 9001 --tailnet-host ghostonbread.taildb09a3.ts.net
# Only after reviewing existing Serve settings and tailnet access policy:
tailscale serve status
tailscale serve --bg --https=443 http://127.0.0.1:9001
```

Replace the hostname with the actual node name. `tailnet_host` may instead be set in the JSON/TOML config; the CLI flag overrides it. It must be a canonical lowercase `node.tailnet.ts.net` name, without scheme, port, trailing dot, or wildcard. This setting does not configure Tailscale. Check the installed Tailscale version, DNS/certificate setup, existing Serve routes, and tailnet access policy before changing Serve; that command changes Serve configuration. Do not enable Funnel or expose this service to the public internet.

**Trust boundary:** Tailscale Serve enforces access at the tailnet/network-policy boundary and terminates HTTPS. The Board does not identify or authenticate users: every device allowed by that policy can read sensitive program names, findings, reports, and evidence, and other local processes can reach the loopback server. Host, Origin and Fetch Metadata checks prevent some browser cross-origin attacks; they are not authentication and can be forged by non-browser clients. Never proxy this application through an unauthenticated or public proxy. The recommended Serve deployment remains read-only: omit `--bbh`, `--accept-uncoordinated-writes`, `--collaboration-dir`, and `--report-autosave`.

Browser storage is origin-scoped: `http://127.0.0.1:9001`, `http://localhost:9001`, and `https://<tailnet-host>` have separate local drafts and preferences even for the same data root. Local drafts may contain sensitive report material. The optional collaboration store separately retains shared drafts and history on the server.

### Optional shared drafts and experimental report autosave

Choose a private collaboration directory outside the source tree; it contains sensitive drafts, retained versions and publication records. Shared drafts without source publication use `--collaboration-dir` alone. Install Git and ensure `git` is executable on the server's `PATH` for concurrent edits that need a three-way merge. If it is unavailable, retain the draft, restore Git, and retry with the same request ID; inspect the result. Reads and edits that need no merge still work. To also opt in to experimental source publication:

```sh
python3 app.py --root /path/to/data --port 9001 \
  --collaboration-dir /path/to/private/board-collaboration --report-autosave
```

Eligible report and evidence edits can then be published to Markdown. Generated navigation and link stubs are read-only. When the source and shared draft diverge, inspect history and preview the merged report before explicitly saving it. A specific pre-submit retained-scan backlog response automatically retries the exact original request up to three times with backoff; the UI retains newer edits and reports exhaustion. Reload stops the automatic retry and requires inspection. Other unconfirmed saves must be inspected or retried as the original request; retain the local draft. Turning off `--report-autosave` leaves eligible shared-draft editing available but does not write source Markdown.

The writer retains displaced source versions for later observation, but this is not a filesystem or cross-host compare-and-swap. Concurrent uncoordinated edits, sync, transient versions between scans, power loss, storage growth and retention administration remain risks. Stop other writers and sync activity before opting in, protect and monitor the private store, and do not treat a save notice as proof against subsequent change or data loss. Review and activation are separate decisions.

**Retention capacity:** Autosave defaults to at most **1,000 entries** in the private store's `publication` directory and a **1 GiB** available-space floor. Override with `--retention-max-operations N` (positive integer) and `--retention-min-free-bytes N` (nonnegative bytes). These flags apply to all publisher processes sharing that private store; use the same limits for each. Before creating an operation, the publisher counts existing entries, including incomplete attempts and symlinks, and checks the actual available space on that filesystem. It requires a conservative estimate of twice the draft size plus 1 MiB above the floor; this is a check, not a reservation. A capacity refusal leaves the shared draft saved but does not exchange the Markdown; after increasing capacity or addressing space, retry the exact request. If the source or shared head changed, review and reconcile instead. No retained versions are deleted automatically.

This is a practical preflight, **not a hard disk quota**: other processes can consume space after the check, open old file descriptors can grow retained inodes, hardlinks can change, filesystem overhead and SQLite/Git growth vary, and the SQLite size cap does not cover retained files. The observation lock coordinates only publishers using the same store and lock, not sync replicas or outside writers. Monitor disk usage and stop external writers/sync. To manage backups, stop all board writers first and preserve the complete private store, including the SQLite database and publication directory, together; do not remove individual operation directories that the database may still need for recovery. A new store starts a separate shared history, so review and preserve drafts before switching. The guard uses a directory metadata cache invalidated by entry changes; it assumes a coherent local filesystem and cooperating publishers, not hostile manipulation of the private directory or independently synced locks.

### Optional live report editing

`--live-edit` turns the Reports section into a live editor. Edits autosave to the Markdown file (no save button); the Board server merges each save with changes made meanwhile by agents, other tabs, editors or Syncthing, and pushes updates to open editors.

```sh
python3 app.py --root /path/to/data --port 9001 --live-edit \
  --live-edit-dir /path/to/private/live-edit   # default ~/.local/state/bounty-board/live-edit
```

The history directory must be private (mode 0700) and outside the data root; it keeps every version the Board saw or wrote. `--live-edit` cannot be combined with `--collaboration-dir`, `--report-autosave` or `--experimental-fixture-publish`. Merges need `git` on the server's `PATH`; without it, every concurrent edit is shown as a conflict.

In the editor:

- The status pill shows Saved, Saving, Unsaved, Merged, Conflict, Offline or Read-only. Ctrl/Cmd+S saves immediately.
- Changes from elsewhere appear in an idle editor with an "Updated by ..." notice. Edits to different lines merge automatically.
- Overlapping edits are never resolved silently: the editor shows conflict markers, pauses autosave, and offers Keep mine / Keep saved per block (or for all). The server refuses text that still contains markers.
- Unsaved text is kept in this browser (localStorage, per origin) until the server confirms it. If the server is unreachable the editor says so and retries; if the tab is closed first, the next tab that opens the report sends the kept text with its original base so the server merges it.
- Syncthing conflict copies next to the report are offered for review: Apply the merged result, load it into the editor to resolve, or discard it (archived in history first). Copies of a lost Board write are merged back automatically.
- History lists observed, outside, Board, merged and restored versions; any version can be viewed and restored (restore also merges).
- Generated navigation is read-only.
- Undo restarts whenever text from elsewhere enters the editor, so undo never removes someone else's text.

Limits:

- Run one Board process per data root. Saves are serialized inside one process only.
- The file is replaced with an atomic exchange after a final check, and a write that lands between check and exchange is recovered and merged. A program that keeps the old file open and writes through that descriptor after the exchange can still lose that write. Agents and editors should write with temp-file-and-rename.
- Browser backups are per origin and per browser profile; clearing site data removes them.
- There is no authentication. The Tailscale Serve trust boundary above applies; anyone who can reach the Board can edit reports.

### Optional finding edits

To enable finding severity, class, status, and severity-rationale changes using a compatible BBH writer, supply its absolute launcher path **and** explicitly acknowledge the overwrite risk:

```sh
python3 app.py --config /path/to/board.json --bbh /absolute/path/to/bbh --accept-uncoordinated-writes
```

This invokes BBH's own finding-edit workflow and reads the result back. BBH may refresh generated indexes and create related evidence/context files. The Board rereads the finding before invocation and refuses a changed baseline; the UI retains a copyable pending value so you can refresh and review it. This is an early check, **not atomic compare-and-swap**: another Board process, editor, BBH or sync replica can write after the check and still be overwritten. Stop other writers, including sync activity, and refresh before editing; the operator accepts the residual risk. A failed write may be partial; refresh and inspect the source before retrying. Submission and platform outcome edits are not yet supported in this application. Review and real activation are separate decisions.

The server binds only to IPv4 loopback and has no user authentication or TLS. Other local processes can access it. Except for the explicit Tailscale Serve arrangement above, do **not** proxy or expose it on a network; never point it at a data tree writable by untrusted local users. Program names, findings, evidence references, URLs, and report contents can be sensitive.

## What is available

- Discover canonical web/API and binary lanes under the configured root, with explicit warnings for missing sources.
- View a portfolio dashboard, select a program and lane, and filter findings.
- Explore live surface/class coverage questions, MapStore observations, gadgets, and Markdown report files when the source is available.
- Switch among Light, Dark, and Dusk themes; the preference is stored in the browser.
- Filter findings with multi-select severity, class, status and submission menus; sort columns (sort is remembered); open row actions from each finding's menu.
- Dashboard severity and class breakdowns expand to list matching findings by program, linking to each finding and its report. A "Not submitted" view shows current work; "All records" keeps every record available.
- The address bar tracks the view (`#/dashboard`, `#/programs/<program>/<lane>/<section>[/<report>]`), so back, forward and reload return to the same place. "Switch program" searches programs; "Open workspace" shows which program it opens.
- Report data that finishes loading in the background is applied automatically unless you are typing or editing; it then waits and applies when you leave the field.
- Edit Markdown in the locally bundled EasyMDE editor with a safe preview. Without collaboration, drafts remain browser-local and do not modify the source. With the optional collaboration store, drafts and history are shared; opt-in source autosave can also publish eligible reports. Generated navigation is read-only when collaboration is enabled. Browser drafts can be lost when browser data is cleared; root moves create a new namespace. Storage errors and detected cross-tab changes are shown, but cross-tab storage checks are not atomic.

Coverage is bounded by recorded questions and assessments, not a claim that an application is fully mapped. A gadget or residual is not automatically a vulnerability. Submission state and platform outcome are represented separately when present in the source.

`BACKEND_API.md` describes current data contracts and limitations. `docs/product.md` records the intended product, including capabilities that are not implemented yet.

## Tests

The default safe selection uses disposable synthetic directories and excludes the test that launches the real BBH runtime:

```sh
python3 -W error::ResourceWarning tests/safe_suite.py
```

Browser tests require Node.js, npm, and a Chrome/Chromium executable. The default `npm test` runs the browser suites against synthetic fixtures and excludes the separate synthetic-writer browser integration test:

```sh
npm ci --ignore-scripts
CHROME_BIN=/path/to/chrome npm test
```

The equivalent explicit selection is:

```sh
CHROME_BIN=/path/to/chrome node --test --test-concurrency=1 \
  --test-skip-pattern='^browser metadata update reaches backend with a disposable synthetic writer$' \
  static/tests/app.test.cjs static/tests/drafts.synthetic.test.cjs \
  static/tests/root-identity.synthetic.test.cjs static/tests/review.synthetic.test.cjs \
  static/tests/dashboard-coverage.synthetic.test.cjs static/tests/mapstore-detail.synthetic.test.cjs
```

These are **bounded selections**, not a full integration suite. The EasyMDE tests use disposable synthetic roots; no report-source write endpoint is enabled. The excluded BBH test invokes the actual local BBH launcher against a disposable fixture; run it only after explicitly evaluating and authorizing that workflow.

## Data and security

Never commit bounty records, report text, cookies, tokens, credentials, or private configuration. A missing or unreadable source is shown as unknown rather than zero. Experimental source publication is not an atomic compare-and-swap with uncoordinated writers or remote sync replicas; a published status is a point-in-time observation, not a durability or concurrency guarantee.
