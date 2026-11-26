# Artifact uploads

- Branch: `feat/board-artifact-uploads`; base `88651b0` (`origin/beta`, report artifacts panel and recon intel merged).
- Owner surface: the report artifacts panel (`#report-artifacts-host`, `static/modules/report-artifacts.js`).
- Request: "for bounty board we need a way to be able to upload artifacts from the ui. This way if I make anything I can upload it"

## Intent

Let the owner add files they made (screenshots, screen recordings, PoC scripts, captured requests) to a report from the Board, so they land in the report's own folder and show up in the same artifacts panel, without a terminal or a file manager. Uploads are opt-in, never create folders, never overwrite anything, and never touch the ledger.

## Where files go

The target is the report's **dedicated folder** exactly as `report_artifacts.associate()` decides it (association rule 1, `report_folder`; see `report-artifacts.md`), re-evaluated on every upload. The file is written directly in that folder (not in a subfolder), so it is listed with reason "Report folder" at once. No ledger write is needed or made: the folder rule already associates the file.

A report without a dedicated folder (in the `reports/` root, in a non-dedicated folder, or in a folder shared with other findings) cannot take uploads. The panel shows a disabled Upload files button with the reason, like the sandbox terminal does for reports without a finding folder. No folder is created. Measured on the real root (counts only, from the artifacts work): 450 of 544 report/evidence files have a dedicated folder; 94 do not.

## HTTP contract

`POST /api/report-artifact-upload?family=&program=&lane=&path=&name=[&root_instance=]`, body = the raw file bytes. No multipart (the stdlib `cgi` module is gone in Python 3.13+).

Checks, in order. Every refusal sent before the body was fully read either drains a body of at most 1 MiB (so the browser can read the JSON reply) or closes the connection (`Connection: close`), so an unread body is never parsed as the next request.

| Check | Refusal |
| --- | --- |
| `--artifact-uploads` not set | 404 `uploads_disabled` |
| `trusted_request(require_origin=True)` (same Host/Origin/Fetch-Metadata gate as other writes: Origin required and equal to the Board origin, `Sec-Fetch-Site` absent or `same-origin`), exactly one `X-Requested-With: Bounty-Board`, exactly one `Content-Type: application/octet-stream`, exactly one decimal `Content-Length`, no `Transfer-Encoding` | 403 `untrusted_origin` (connection closed) |
| `Content-Length` over 512 MiB (`MAX_UPLOAD_BYTES`) | 413 `{error: too_large, max_bytes}` without reading the body; connection closed |
| Selector: exactly `family, program, lane, path, name` (+ optional `root_instance`), each once; same family/lane/program rules as `/api/report-artifacts`; report must exist | 404 `artifact_not_found_or_unavailable` |
| Name cannot be fixed (NUL, undecodable) | 400 `invalid_name` |
| `root_instance` given and not the current root instance | 409 `root_changed` |
| Two uploads already running (non-blocking semaphore) | 503 `uploads_busy`, `Retry-After: 2` |
| No dedicated folder | 409 `{error: no_report_folder, note: flat_reports_root \| folder_not_dedicated \| folder_shared}` |
| Folder unreachable without following a symlink | 404 `artifact_not_found_or_unavailable` |
| Free space on the folder's filesystem below upload size + floor (1 GiB, `Uploads(free_floor=)`) | 507 `insufficient_storage` (also on `ENOSPC`/`EDQUOT` while writing) |
| Body shorter than `Content-Length` (cancel, dropped connection) or no data for 60 s | 400 `incomplete_body`, connection closed; nothing is left behind |

Success: `201 {artifact, renamed, requested_name}`. `artifact` is the entry the list endpoint returns for the new file (same keys and values; the server re-runs the association to build it). `requested_name` is the sanitized name; `renamed` is true when a suffix was added. A file the listing would skip (`*.pyc`) or that falls past the listing caps is still saved and gets the same fields with `listed: false`.

`GET /api/report-artifacts` adds `upload: {enabled, reason, max_bytes}`: `reason` is `null`, `"disabled"` (flag off; `max_bytes` null) or `"no_report_folder"`. `GET /api/data` adds `capabilities.artifact_uploads` (bool) for deploy checks.

## Rules

**File name.** `name` is a display name and is fixed, not rejected: keep the last component of both `/` and `\` splits; NFC-normalize; replace control, format (bidi override, zero-width) and line/paragraph separator characters and `/ \ : * ? " < > |` with `_`; strip leading dots, underscores and spaces and trailing dots and spaces (the listing hides dot and `_` names, Windows peers drop trailing dots); add `_` to Windows device names (`con.txt` becomes `con_.txt`); cap at 180 UTF-8 bytes, cutting the stem and keeping the extension; fall back to `upload` plus the original extension when nothing is left. Examples: `../../x.py` to `x.py`, `a\b.js` to `b.js`, `.env` to `env`, `_meta` to `meta`.

**Never overwrite.** If the name exists in the folder, compared case-insensitively (`casefold`, since Windows and macOS sync peers are case-insensitive), the next free `stem-2.ext`, `stem-3.ext`, ... is used (up to `-9999`, then 409 `name_unavailable`). Existing reports (`REPORT.md`) are protected the same way (`report.md` becomes `report-2.md`).

**Placement.** The folder is opened by walking descriptors from the data root with `O_NOFOLLOW` (`report_artifacts.open_lane` and `_open_dir`). The body is streamed in 64 KiB chunks into `.syncthing.board-<hex>.tmp` created in that folder with `O_CREAT|O_EXCL|O_NOFOLLOW` (Syncthing never indexes `.syncthing.*.tmp`; the root's `.stignore` also ignores `*.tmp`), then fsynced. The final name is made with `os.link(..., src_dir_fd, dst_dir_fd, follow_symlinks=False)`, which fails with `FileExistsError` instead of replacing; on that the next suffix is tried. Name choice and linking run under one process lock, so two uploads in this process never produce names that differ only in case. The staged name is always removed in `finally`, and the directory is fsynced. Where hard links are unsupported (`EPERM`, `ENOTSUP`, `EXDEV`, `EMLINK`) the same lock covers a fresh case-insensitive check and `os.rename` in the same directory.

**Mode.** The file is created with `0o666` minus the server's umask (normally `0644`), like files other tools write there, so agents and Syncthing can read it.

**Timeouts.** Each socket read waits at most 60 s (`READ_TIMEOUT`); the previous socket timeout is restored afterwards.

## Frontend

- With `upload.enabled`: an **Upload files** button in the panel header (hidden `<input type=file multiple>`), a hint line, and drag and drop onto the panel with a dashed accent outline and a "Drop to upload to the report folder" bar. Pasting an image while focus is inside the panel (click blank panel space or any panel button) uploads it as `pasted-YYYYMMDD-HHMMSS.png` (UTC). Inputs and text areas keep their normal paste.
- With `reason: "no_report_folder"`: a disabled Upload files button with the reason as tooltip and a hint line. Drops on that panel do nothing. Flag off: nothing is shown.
- Uploads run one at a time from one queue via `XMLHttpRequest` (for upload progress). Each file gets a row: name, size, progress bar with percent, Cancel (aborts the request or removes a waiting item). Results: "Saved", "Saved as <name>", "Cancelled", or a plain error: "Too large. The limit is 512 MB.", "Not enough space on the server.", "The server is busy with other uploads. Retry in a moment.", "This report has no folder of its own, so files cannot be added here.", "Upload failed. Retry." Errors stay until dismissed (Retry where it can help); successes and cancels fade after 4 s.
- Size is prechecked against `max_bytes` in the browser (nothing is sent); the server still enforces it.
- After each success the list reloads quietly and the new file gets the existing New highlight.
- Queue state lives on the panel object, whose node persists across Board renders; each queued item keeps its own panel and selector, so switching reports neither cancels nor misroutes an upload.
- Dropping a file elsewhere on the page would make the browser open it and leave the Board. While uploads are available, a window-level guard stops file drops that no other handler took (`defaultPrevented` unset); CodeMirror and the finding drag and drop handle their events first and are unaffected. With uploads off the page behaves exactly as before.
- The editor, drafts and focus are never touched: uploading from the hidden input, or dropping, does not move focus.

Edits outside the new module (kept small and commented): `app.py` (route in `do_POST`, thin `artifact_upload` handler, `upload` block in the list reply, `capabilities.artifact_uploads`, `make_server(artifact_uploads=False)`, `--artifact-uploads`), `static/modules/report-artifacts.js`/`.css` (the panel owner), `package.json` (test list), README and `BACKEND_API.md`.

## Evidence

Synthetic only, `TMPDIR=~/.hermes/cache/scratch/bb-uploads/tmp`, fixture `tests/report_artifacts_fixture.py`:

- `tests/test_artifact_uploads.py` (28 tests): flag off (404, list `disabled`, capability false); 15 gate refusals (Origin missing/foreign, cross-site and same-site Fetch Metadata, X-Requested-With missing/wrong/duplicate, Content-Type wrong/JSON/missing, Transfer-Encoding, Content-Length missing/non-decimal/signed/duplicate) plus a foreign Host; 413 answered with no body sent and the connection closed; invalid selectors; `root_instance` mismatch and match; busy 503 with `Retry-After`; 507 via a patched `free_bytes` and the floor arithmetic; no-folder 409 for flat-root, non-dedicated and shared reports with nothing written; symlinked report folder, symlinked subfolder not followed, folder swapped for a symlink after association, symlinked lane component; success entry equal to the list entry, byte-identical download, nothing written outside the folder, mode `0666 & ~umask`; empty file; collisions including `Shot.PNG` vs `shot.png` and `report.md` vs `REPORT.md`; two concurrent same-name uploads both kept; hard-link fallback; short body and a stalled body leave neither final nor staged files; sanitizing (`../../x.py`, `a\b.js`, `.env`, `_meta`, control and bidi characters, Windows device names, 180-byte cap with multi-byte names and suffixes, empty, NUL); no folders created from `sub/dir/file.txt`.
- `static/tests/artifact-uploads.synthetic.test.cjs` (3 tests): button present and enabled; picker upload of two files including a case-insensitive collision ("Saved as Shot-2.PNG"); New highlight; byte-identical download; drag and drop with the highlight; progress row during a slowed 6 MB upload that survives switching reports and back; Cancel leaves no file and no staged file; 8 MB precheck sends nothing; a server 507 is shown until dismissed; a drop outside the panel is prevented and does not navigate; disabled with reason for non-dedicated, flat-root and shared reports, drops there upload nothing; absent with the flag off and file drops not intercepted; live editor draft, cursor and focus unaffected by an upload; image paste saved as `pasted-<time>.png`.
- Screenshots: `~/.hermes/cache/scratch/bb-uploads/tmp/screens/artifact-uploads-{idle,uploading,after-upload,dropping,error,disabled}-{light,dark}.png`.

## Gaps and limits

- The free-space check is a preflight, not a reservation; concurrent writers can still fill the disk (then the write fails with 507 and the staged file is removed).
- Without hard links, the rename fallback can replace a file another process creates in the instant between the check and the rename. This process's own uploads cannot collide.
- Case-insensitive uniqueness covers this process and the names present at upload time; a sync peer can still deliver a differently cased duplicate later (Syncthing then reports a case conflict as it would for any writer).
- Upload copies the bytes as given: no type sniffing, no scanning, no stripping of metadata (EXIF location in photos, for example). Downloads stay inert (`application/octet-stream`, `nosniff`, sandbox CSP), so a renamed HTML file is never rendered.
- A Markdown file uploaded into a report folder becomes a report file the Board lists like any other `.md` in `reports/`.
- Uploads go only into the folder root, not into subfolders such as `poc/` or `evidence/`.
- A refused upload of more than 1 MiB is answered and the connection closed with the body unread; some browsers then report a network error instead of the JSON reply. The panel avoids the common cases up front (size precheck, disabled state for reports without a folder, one upload at a time) and shows "Upload failed. Retry." otherwise.
- There is no authentication; anyone who can reach the Board through the tailnet boundary can upload. Uploaded files are distributed by Syncthing to every device sharing the root.

## Decisions for the owner

1. Keep uploads limited to reports with a dedicated folder (recommended), or offer to create `reports/<FID>-<slug>/` for the 94 reports without one?
2. Keep the 512 MiB per-file cap and 1 GiB free-space floor (recommended), or raise the cap for long screen recordings?
3. Keep uploads in the folder root (recommended), or add a target subfolder choice (`poc/`, `evidence/`)?
4. Keep renaming on collision (recommended), or ask before saving under a new name?
5. Strip image metadata (EXIF) on upload? Recommended: not by default; revisit if screenshots from phones are common.
