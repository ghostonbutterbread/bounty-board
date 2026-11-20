# Bounty Board

A local-first workspace for navigating bug-bounty findings, surface coverage, reports, gadgets, and MapStore observations. It is a view over existing program/lane records, not a replacement for the systems that own them.

> **Development status:** This feature branch is under review. The server is read-only by default. Finding metadata edits can be enabled explicitly with a compatible BBH installation. Source report autosave is not implemented; report drafts in the editor are temporary and will be lost when the tab closes.

## Run locally

Requires Python 3.11 or newer; the server uses the Python standard library. The default root is `~/Shared`; the root must contain `web_bounty/` and/or `binaries/`.

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

### Optional finding edits

To enable finding severity, class, status, and severity-rationale changes using a compatible BBH writer, supply its absolute launcher path **and** explicitly acknowledge the overwrite risk:

```sh
python3 app.py --config /path/to/board.json --bbh /absolute/path/to/bbh --accept-uncoordinated-writes
```

This invokes BBH's own finding-edit workflow and reads the result back. BBH may refresh generated indexes and create related evidence/context files. There is no shared compare-and-swap across Board sessions, arbitrary editors, or separate sync replicas: a stale or concurrent edit can overwrite another update. Stop other writers, including sync activity, and refresh before editing; even then the operator accepts the residual risk. A failed write may be partial; refresh and inspect the source before retrying. Submission and platform outcome edits are not yet supported in this application.

The server binds only to IPv4 loopback, has no user authentication or TLS, and is intended for a trusted single-user local environment. Other local processes can access it. Do **not** proxy it, expose it on a network, or point it at a data tree writable by untrusted local users. Program names, findings, evidence references, URLs, and report contents can be sensitive.

## What is available

- Discover canonical web/API and binary lanes under the configured root, with explicit warnings for missing sources.
- View a portfolio dashboard, select a program and lane, and filter findings.
- Explore live surface/class coverage questions, MapStore observations, gadgets, and Markdown report files when the source is available.
- Switch among Light, Dark, and Dusk themes; the preference is stored in the browser.
- Preview Markdown without executing raw HTML or fetching remote images. Unsaved in-tab drafts are not durable. A separate local draft-storage primitive is under development and is **not** wired to the editor.

Coverage is bounded by recorded questions and assessments, not a claim that an application is fully mapped. A gadget or residual is not automatically a vulnerability. Submission state and platform outcome are represented separately when present in the source.

`BACKEND_API.md` describes current data contracts and limitations. `docs/product.md` records the intended product, including capabilities that are not implemented yet.

## Tests

The default safe selection uses disposable synthetic directories and excludes the test that launches the real BBH runtime:

```sh
python3 -W error::ResourceWarning tests/safe_suite.py
```

Browser tests require Node.js, npm, and a Chrome/Chromium executable. This selection excludes the separate synthetic-writer browser integration test:

```sh
npm ci --ignore-scripts
CHROME_BIN=/path/to/chrome node --test \
  --test-skip-pattern='^browser metadata update reaches backend with a disposable synthetic writer$' \
  static/tests/app.test.cjs
```

These are **bounded selections**, not a full integration suite. The report-write tests use mocked capabilities, not a write-enabled report backend. The excluded BBH test invokes the actual local BBH launcher against a disposable fixture; run it only after explicitly evaluating and authorizing that workflow.

## Data and security

Never commit bounty records, report text, cookies, tokens, credentials, or private configuration. A missing or unreadable source is shown as unknown rather than zero. Report source writes remain disabled until the conflict behavior is agreed and the writer is safely implemented.
