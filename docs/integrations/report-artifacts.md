# Report artifacts

- Branch: `feat/board-report-artifacts`; base `e9246db` (live editing server + module seam).
- Owner surface: `#report-artifacts-host` (live and non-live report views).
- To-do: "In each finding's report editing view, display the associated artifacts/assets and let the user download them, including videos, Python files, and JavaScript files. Keep artifacts linked to the correct report and preserve the existing report-editing workflow."

## Intent

Show the files that belong to the selected report next to the editor, explain why each one is linked, preview the safe types, and download any of them (or all non-sensitive ones as a zip) without the Board origin ever rendering active content.

## Association rule (`report_artifacts.py`)

A file is listed for `reports/<path>` in a lane when at least one of these holds; every listed file carries all matching reasons:

1. **Report folder** (`report_folder`). The report's folder is *dedicated* when
   - an owning finding's `report_dir` names it (and it contains the report), or
   - it is a direct child of `reports/` holding `REPORT.md` or `EVIDENCE.md` (the folder convention; covers lanes without a ledger entry).

   The `reports/` root is never dedicated. A folder that contains another finding's `report_path`, `evidence_path` or `report_dir` is *shared* and skipped, so flat folders (for example `reports/findings/<status>/`) never list sibling reports' files. Walk depth is 4; dot entries, `_`-prefixed folders (`_meta`, `_archive`, `_drafts`), `__pycache__` and `*.pyc` are skipped; the report itself is omitted.
2. **Finding field** (`finding_field`). Paths in an owning finding's `poc`, `evidence`, `artifacts`, `attachments`, `evidence_files` or `files` (string, list, or `{path}` objects) that resolve to a file, or a non-shared folder's files, inside the lane. Prose values (whitespace without a slash) are ignored.
3. **Report link** (`report_link`). Relative Markdown link/image targets (`[x](a/b.py)`, `![x](<a b.png>)`, reference definitions) resolved from the report's folder, inside the lane. URLs with a scheme, `//host`, and `#anchors` are ignored; `?query`/`#fragment` are stripped.

An *owning finding* names the report in `report_path` or `evidence_path`; failing that, its `report_dir` is the report's own folder (so an unregistered `SUBMISSION.md` in a finding folder gets that folder). Absolute recorded paths are matched by their `/<family>/<program>/<lane>/` segment, so ledgers written on another host resolve on this one. Nothing outside the lane is ever listed.

Measured read-only on the real root (aggregate counts only, no names or contents recorded): 544 report/evidence files; 450 resolve to a dedicated folder, 94 do not (87 in non-dedicated folders, 7 in the reports root); 0 marked shared after the fallback-owner rule; worst listing 45 ms.

## HTTP contract

All are `GET`, go through the existing Host/Origin/Fetch-Metadata gate (`trusted_request`), take `family`, `program`, `lane`, `path` (report path under `reports/`, `.md`), and optionally `root_instance` (409 `root_changed` on mismatch). Unknown parameters, invalid selectors, unassociated or unavailable files return 404 `artifact_not_found_or_unavailable`.

| Endpoint | Result |
| --- | --- |
| `/api/report-artifacts` | `{report, folder, notes[], artifacts[], max_zip_bytes}`. Each artifact: `name, relative` (lane-relative, used as the key), `display_path` (folder-relative when inside the folder), `size, modified` (epoch s), `category` (video/audio/image/code/data/capture/archive/document/other), `sensitive`, `preview` (`image`/`video`/`audio`/`text`/null), `source_reason`, `reasons[{reason, detail}]`. Notes: `folder_shared`, `folder_not_dedicated`, `flat_reports_root`, `truncated` (over 500 files listed or 2000 scanned). |
| `/api/report-artifact?…&artifact=<relative>` | Streams the file: always `application/octet-stream`, `Content-Disposition: attachment; filename="<ascii>"; filename*=UTF-8''<pct>`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'`, `Cross-Origin-Resource-Policy: same-origin`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, `Accept-Ranges: bytes`. Single `Range` is honored (206/416); multi-range falls back to 200. 64 KiB chunks. |
| `/api/report-artifact-media?…&artifact=` | Inline only for png/jpg/gif/webp and mp4/m4v/webm/mp3/m4a/wav/ogg with a fixed type from the extension; same hardening headers with `inline`. Anything else (SVG, HTML, JS, sensitive files) returns 415. Range supported (video seeking). |
| `/api/report-artifacts.zip` | Streamed `zipfile` archive of non-sensitive listed files (lane-relative names; deflate for code/data, stored otherwise). 413 when their total exceeds 512 MiB; 404 when there is nothing to zip. HTTP/1.0 close-delimited body. |

Every download re-runs the association and requires the requested `relative` to be in the result, then reopens it by walking directory descriptors with `O_NOFOLLOW` from the root (family, program, lane, then each component) and refuses anything but a regular file. A file swapped for a symlink after listing is refused. If a stream fails after headers are sent the connection is closed (short body) rather than appending an error.

Sensitive: extensions `.har .env .hdr .body .raw .pcap(ng) .saz .pem .key .p12 .pfx .jks .kdbx .cookie(s) .netrc .npmrc .pgpass`, plus name keywords (cookie, token, secret, credential, passw, session, bearer, jwt, api key, private key, id_rsa/id_ed25519, env) for non-media files. Sensitive files show a badge, get no preview and are left out of the zip; individual download still works.

## Frontend (`static/modules/report-artifacts.js` + `.css`)

- Registers through `window.registerBoardModule`; on every render it mounts a persistent panel (one per report selector, last 12 kept) into `#report-artifacts-host`, so open previews survive re-renders and a report switch loads that report's list. It does not touch the editor, drafts or focus.
- Grouped list (Videos, Images, Audio, Code, Text and data, Documents, Traffic captures, Archives, Other) with Font Awesome 4.7 file icons, size, modified time, "Outside the report folder" marker, link reasons, Preview toggle (`aria-expanded`/`aria-controls`) and a Download link. Reload list and Download all in the header (named so the global Refresh button stays unique); notes explain shared/non-dedicated folders, the sensitive exclusion and the zip size cap.
- Previews load only on click: `<img>`/`<video>`/`<audio>` from the media endpoint; text types (py, js, html, svg, json, md, txt, ...) are fetched from the download endpoint with `Range: bytes=0-65535` and set via `textContent` in a `<pre>`, with a truncation hint. All DOM is built with `createElement`/`textContent`; no artifact text goes through `innerHTML`.
- Styling uses existing custom properties (`--border`, `--table`, `--accent`, `--warning`, `--warning-bg`, `--muted`, `--panel`, `--ink`) and `.button`, `.hint`, `.message`, `.state`.

Edits outside the module (kept minimal for the merge):
- `app.py`: one route block in `do_GET` and a commented `report_artifacts` handler group (list/file/media/zip helpers). Logic lives in `report_artifacts.py`.
- `static/app.js`: `artifactsHost(report)` helper and the host appended to the read-only and editable non-live report sections (the live section already renders it).
- `static/index.html`: one line under `<!-- Feature modules -->`.

## Evidence

Run on Ghost with `TMPDIR=/home/ryushe/.hermes/cache/scratch/bb-agents/artifacts`, synthetic fixture `tests/report_artifacts_fixture.py` only:

- `python3 -m unittest tests.test_report_artifacts`: 25 tests, OK. Covers the three association rules, shared flat folders, marker folders, unregistered files in a finding folder, skips (dot, `_meta`, `__pycache__`, symlinked file and directory), list cap, attachment/inert headers for svg/html/js/py/mp4, RFC 5987 names, media allowlist (415 for svg/html/js/har), ranges (206/416/multi-range), traversal and unassociated paths, invalid selectors, symlinked lane component, symlink swap after listing, cross-site/foreign Host refusal, zip contents/exclusions/size cap, `root_instance` binding, live mode.
- `node --test --test-concurrency=1 static/tests/report-artifacts.synthetic.test.cjs`: 2 tests, pass. Non-live view lists/groups/reasons, sensitive badge with no preview, no automatic previews, HTML/SVG previews as inert text, 64 KB text cap, PNG and MP4 previews via the media endpoint, downloads of svg/html/js/py/mp4 byte-identical with nothing executed, direct navigation to an HTML artifact downloads, Download all zip, editor typing and draft retained across report switches, flat folder isolation, refresh. Live view mounts the panel and shows the error state.
- `python3 tests/safe_suite.py`: 205 tests, OK (1 skipped), including the 25 above.
- `npm test` (115 tests). First run: 113 pass, 2 fail, both caused by this branch's panel text colliding with existing selectors (`getByRole('button',{name:'Refresh'})` in drafts, `getByText(/could not be loaded/i)` in review). Fixed by renaming the panel button to "Reload list" and rewording its error copy; no existing test was changed. `drafts` + `review` + `report-artifacts` then passed 20/20. Final full run: 113 pass, 1 fail and 1 cancelled, both 15 s timeouts in `review.synthetic.test.cjs` at load average 18 to 21 on 6 shared CPUs; that file passed 17/17 twice when run alone straight afterwards.
- Screenshots (synthetic): `/home/ryushe/.hermes/cache/scratch/bb-agents/artifacts/screenshots/report-artifacts-panel.png`, `report-artifacts-panel-dark.png`.

## Gaps and limits

- The list refreshes on report switch and the Refresh button only, not on live saves or file-system changes. A link added in an unsaved live draft appears after saving and refreshing.
- A playing video pauses when the Board re-renders, because the host is recreated (the panel itself persists).
- The association uses the saved report on disk, not the live editor's buffer.
- No magic-byte check for inline media; safety relies on fixed content types, `nosniff` and the sandbox CSP (an HTML file renamed `.png` renders as a broken image, never as a page).
- The zip leaves sensitive files out, and if a file grows during zipping it is cut at its listed size. Close-delimited body, so there is no download progress total.
- `report-artifacts.synthetic.test.cjs` is not added to `npm test`; the orchestrator should decide whether it joins the default browser list.

## Decisions for Ryu

1. Should sensitive files (HAR, raw headers/bodies, `.env`, cookie/token-named files) stay out of Download all, or go in after a confirmation?
2. Is 512 MiB the right zip cap, and is the 64 KB text preview enough?
3. Should `_meta`/`_archive`/`_drafts` folders stay hidden, or show up in a collapsed "Internal" group?
4. Should the redesign place the panel beside the editor rather than under it?
