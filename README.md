# Bounty Board

A local-first workspace for navigating bug-bounty findings, surface coverage, reports, gadgets, and MapStore observations. It is designed as a view over existing program/lane records, not a replacement for the systems that own them.

> **Development status:** The current implementation is read-only. Finding edits and report autosave are not enabled. The report editor can render Markdown and hold an in-tab draft, but it does **not** save to the source file. Do not use it for work you cannot afford to lose.

## Run locally

Requires Python 3.10 or newer; the server uses the Python standard library. The default root is `~/Shared`; the root must contain `web_bounty/` and/or `binaries/`.

```sh
python3 app.py --root "$HOME/Shared" --port 9001
```

Open `http://127.0.0.1:9001/` on the same machine. Use `--root /path/to/Shared` to select a different data root and `--port` for a different port. These are runtime options, not changes to source directories.

The server binds only to IPv4 loopback, has no user authentication or TLS, and is intended for a trusted single-user local environment. Other local processes can access it. Do **not** proxy it, expose it on a network, or point it at a data tree writable by untrusted local users. Program names, findings, evidence references, URLs, and report contents can be sensitive.

## What is available

- Discover canonical web/API and binary lanes under the configured root, with explicit warnings for missing sources.
- View a portfolio dashboard, select a program and lane, and filter findings.
- Explore live surface/class coverage questions, MapStore observations, gadgets, and Markdown report files when the source is available.
- Switch among Light, Dark, and Dusk themes; the preference is stored in the browser.
- Preview Markdown without executing raw HTML or fetching remote images. Unsaved in-tab drafts are not durable.

Coverage is bounded by recorded questions and assessments, not a claim that an application is fully mapped. A gadget or residual is not automatically a vulnerability. Submission state and platform outcome are represented separately when present in the source.

`BACKEND_API.md` describes the current data contracts and limitations. `docs/product.md` records the intended product, including capabilities that are not implemented yet.

## Tests

Backend tests use disposable synthetic directories, not real bounty data:

```sh
python3 -W error::ResourceWarning -m unittest discover -s tests -v
```

Browser tests additionally require Node.js, Playwright, and a Chrome/Chromium executable. After providing these dependencies in your environment:

```sh
CHROME_BIN=/path/to/chrome node --test static/tests/app.test.cjs
```

The browser suite uses synthetic data. It includes frontend tests of proposed write capabilities; these are mocked contracts, not evidence that the current backend writes files.

## Data and security

Never commit bounty records, report text, cookies, tokens, credentials, or private configuration. A missing or unreadable source is shown as unknown rather than zero. Source writes must use the owning ledger/report workflow and safe handling of concurrent writers; they are intentionally disabled until that can be verified.
