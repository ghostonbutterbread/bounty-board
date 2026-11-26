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

Checks, in order. The gate refusals (404 flag off, 403, 413) close the connection with the body unread. Every later refusal drains a body of at most 1 MiB first (the connection stays usable); a larger body gets the reply with `Connection: close` and is then read and discarded (at most the declared length, which is under the cap, within 300 s, at most 4 discards at a time, and after giving back the upload slot so other uploads are not blocked) before the connection closes, so the browser reads the JSON reply instead of a reset. An unread body is never parsed as the next request.

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

**File name.** `name` is a display name and is fixed, not rejected: keep the last component of both `/` and `\` splits; NFC-normalize; replace control, format (bidi override, zero-width) and line/paragraph separator characters and `/ \ : * ? " < > |` with `_`; strip leading dots, underscores and spaces and trailing dots and spaces (the listing hides dot and `_` names, Windows peers drop trailing dots); add `_` to Windows device names before the first dot (`con.txt` becomes `con_.txt`, `nul.tar.gz` becomes `nul_.tar.gz`); cap at 180 UTF-8 bytes, cutting the stem and keeping the extension; fall back to `upload` plus the original extension when nothing is left; a name ending in `.tmp` or `.crdownload` (any case) gets `_` for that last dot (`capture.tmp` becomes `capture_tmp`), because the data root's `.stignore` ignores those suffixes and the file would never sync. Examples: `../../x.py` to `x.py`, `a\b.js` to `b.js`, `.env` to `env`, `_meta` to `meta`.

**Never overwrite.** If the name exists in the folder, compared case-insensitively (NFC + `casefold`, since Windows and macOS sync peers are case-insensitive), the next free `stem-2.ext`, `stem-3.ext`, ... is used (up to `-9999`, then 409 `name_unavailable`). Existing reports (`REPORT.md`) are protected the same way (`report.md` becomes `report-2.md`).

**Placement.** The folder is opened by walking descriptors from the data root with `O_NOFOLLOW` (`report_artifacts.open_lane` and `_open_dir`). The body is streamed in 64 KiB chunks into `.syncthing.board-<hex>.tmp` created in that folder with `O_CREAT|O_EXCL|O_NOFOLLOW` (Syncthing never indexes `.syncthing.*.tmp`; the root's `.stignore` also ignores `*.tmp`), then fsynced. The final name is made with `os.link(..., src_dir_fd, dst_dir_fd, follow_symlinks=False)`, which fails with `FileExistsError` instead of replacing; on that the next suffix is tried. Name choice and linking run under one process lock, so two uploads in this process never produce names that differ only in case. The staged name is always removed in `finally`, and the directory is fsynced. Where hard links are unsupported (`EPERM`, `ENOTSUP`, `EXDEV`, `EMLINK`) the same lock covers a fresh case-insensitive check and `renameat2(RENAME_NOREPLACE)` in the same directory (an existing name moves on to the next suffix); only where that is unsupported too does a plain `os.rename` remain.

**Mode.** The file is created with `0o666` minus the server's umask (normally `0644`), like files other tools write there, so agents and Syncthing can read it.

**Timeouts.** Each socket read waits at most 60 s (`READ_TIMEOUT`); the previous socket timeout is restored afterwards.

## Frontend

- With `upload.enabled`: an **Upload files** button in the panel header (hidden `<input type=file multiple>`), a hint line, and drag and drop onto the panel with a dashed accent outline and a "Drop to upload to the report folder" bar. Pasting an image while focus is inside the panel (click blank panel space or any panel button) uploads it as `pasted-YYYYMMDD-HHMMSS.png` (UTC; `.jpg`, `.gif` or `.webp` when the clipboard image is that type). Inputs and text areas keep their normal paste.
- With `reason: "no_report_folder"`: a disabled Upload files button with the reason as tooltip and a hint line. Drops on that panel do nothing. Flag off: nothing is shown.
- Uploads run one at a time from one queue via `XMLHttpRequest` (for upload progress). Each file gets a row: name, size, progress bar with percent, Cancel (aborts the request or removes a waiting item). Results: "Saved", "Saved as <name>", "Cancelled", or a plain error: "Too large. The limit is 512 MB.", "Not enough space on the server.", "The server is busy with other uploads. Retry in a moment.", "This report has no folder of its own, so files cannot be added here.", "Upload failed. Retry." Errors stay until dismissed (Retry where it can help); successes and cancels fade after 4 s.
- Size is prechecked against `max_bytes` in the browser (nothing is sent); the server still enforces it.
- After each success the list reloads quietly and the new file gets the existing New highlight.
- Queue state lives on the panel object, whose node persists across Board renders; each queued item keeps its own panel and selector, so switching reports neither cancels nor misroutes an upload. The 12-panel cache never evicts a panel with a queued or running upload, nor the panel being mounted, so its rows (progress, Cancel, Retry) are still there when the report is opened again.
- Dropping a file elsewhere on the page would make the browser open it and leave the Board. Once any list has shown uploads on (enabled or disabled for lack of a folder), a window-level guard stops file drops that no other handler took, also while a panel is loading or its list failed (`defaultPrevented` unset); CodeMirror and the finding drag and drop handle their events first and are unaffected. With uploads off the page behaves exactly as before.
- The editor, drafts and focus are never touched: uploading from the hidden input, or dropping, does not move focus.

Edits outside the new module (kept small and commented): `app.py` (route in `do_POST`, thin `artifact_upload` handler, `upload` block in the list reply, `capabilities.artifact_uploads`, `make_server(artifact_uploads=False)`, `--artifact-uploads`), `static/modules/report-artifacts.js`/`.css` (the panel owner), `package.json` (test list), README and `BACKEND_API.md`.

## Delete

- Branch: `feat/board-artifact-delete`; base `cc48d46` (`origin/beta`, uploads merged).
- Request: "Yup I'd love a delete button with the confirmation window" (answer to "There's no delete button for uploaded files yet. Want one?").

The same opt-in flag, `--artifact-uploads`, covers upload and delete. Without it nothing below exists (no buttons; the endpoint answers 404 `uploads_disabled`).

### What can be deleted

A listed artifact is deletable only when all hold:

- uploads are enabled;
- the report has a dedicated folder (`associate()['folder']`), the artifact's `relative` is inside it (subfolders such as `poc/` included), and its reasons include `report_folder`;
- it is not Markdown (`.md`, `.markdown`, any case). Markdown files are reports in the Board's model (`REPORT.md`, `EVIDENCE.md`, submission drafts) and are never deletable from the panel; the report itself is never even listed;
- no other ledger finding names it, or a folder containing it, in its artifact fields (`poc`, `evidence`, `artifacts`, `attachments`, `evidence_files`, `files`); such entries carry `referenced_elsewhere: true` in the list. Deleting it from this report would silently break the other finding's evidence;
- the lane's ledger is readable. While it exists but cannot be read (mid-sync, over the 5 MB read cap) the list adds the note `ledger_unreadable` and nothing is deletable, since other findings' claims are unknown;
- its name does not start with a dot (staged uploads `.syncthing.board-*.tmp` are never listed anyway; the rule refuses them again);
- it is a regular file: symlinks are never listed, and the name is checked with `lstat` before unlinking.

`GET /api/report-artifacts` adds `version` (inode and nanosecond mtime of that exact file, opaque), `referenced_elsewhere: bool` and `deletable: bool` to every entry and `delete: bool` to the `upload` block (true when uploads are on and the report has a folder). The upload response's `artifact` carries `deletable` too, so it stays equal to the list entry. Rule code: `artifact_uploads.delete_refusal` / `mark_deletable`.

### HTTP contract

`POST /api/report-artifact-delete?family=&program=&lane=&path=&artifact=[&root_instance=]`, body `{"size": <int>, "modified": <int>}`: the values the panel showed for that row (exact keys, non-negative integers, booleans refused).

| Check | Refusal |
| --- | --- |
| `--artifact-uploads` not set | 404 `uploads_disabled` (connection closed, body unread) |
| `trusted_request(require_origin=True)`, exactly one `X-Requested-With: Bounty-Board`, exactly one `Content-Type: application/json`, one decimal `Content-Length` of at most 4096, no `Transfer-Encoding` | 403 `untrusted_origin` (connection closed, body unread) |
| Body shorter than `Content-Length` within 10 s | 400 `incomplete_body` (connection closed) |
| Selector: exactly `family, program, lane, path, artifact` (+ optional `root_instance`), each once, same rules as the list; `artifact` a clean relative path; more than 8 query fields | 404 `artifact_not_found_or_unavailable` |
| Body not exactly `{size, modified, version}` (integers and the list entry's version string) | 400 `invalid_body` |
| `root_instance` given and not the current root instance | 409 `root_changed` |
| Association re-run at request time: report missing, artifact not listed, report without a folder, artifact outside the folder | 404 `artifact_not_found_or_unavailable` |
| Listed inside the folder but Markdown, a dot name, listed only by a link or field (for example a file under the folder's `_meta/`), named by another finding, or the ledger unreadable | 409 `not_deletable` |
| Folder (or a subfolder) unreachable without following a symlink, or the file already gone | 404 `artifact_not_found_or_unavailable` |
| Name is no longer a regular file (symlink or directory swapped in), or its size or integer mtime differ from the body | 409 `changed` (the file is left alone; the panel reloads) |

Success: `200 {"deleted": "<relative>"}`. An unexpected filesystem error is 500 `delete_failed`.

**Removal.** The parent directory is reached by the same `O_NOFOLLOW` descriptor walk as uploads (`report_artifacts._open_dir` from the lane descriptor); the name is `lstat`ed relative to that descriptor (`follow_symlinks=False`), compared, then `os.unlink(name, dir_fd=parent)` and the directory is fsynced. Check and unlink run under `Uploads.place_lock`, the lock uploads hold while choosing and linking a name, so an upload in this process can never pick the name between the check and the unlink. `unlink` never follows a symlink and fails on a directory (reported as `changed`). Nothing else is touched: no folders removed, no ledger write.

### Frontend

- Rows with `deletable: true` get a **Delete** button (trash icon, `button subtle danger-ghost`, danger text color, `aria-label="Delete <name>"`, `data-artifact-delete=<relative>`) left of Preview and Download, so Download keeps one right-edge column. Other rows get none.
- Click opens a modal dialog: title `Delete <name>?`, text `This removes <display path> from the report folder. Synced devices remove it too. This cannot be undone.`, buttons Delete (`danger-button`) and Cancel. Cancel has focus; Escape cancels. The dialog comes from `window.BoardLedgerActions.dialog()` when that module is loaded, otherwise from a native `<dialog>` built in the panel module with the same classes (fallback styles in `report-artifacts.css`). Never `window.confirm`.
- While the request runs, the row's buttons are disabled. On 200 the row is removed in place (its media paused first, its preview gone with it) and the counts update; the in-memory list is updated so the next quiet reload sees no change and other rows, their open previews and the upload rows are not redrawn. A "Deleted <name>" note fades after 4 s.
- On 409 `changed`: "This file changed since the list loaded. Check it and try again." and a quiet reload shows the new size and time. Other errors get a plain message. Error notes stay until dismissed or the next full list load (Reload list); quiet auto-refreshes keep them.
- Everything is built with `createElement`/`textContent`. Focus in the deleted row moves to the panel itself, never outside it; the editor, drafts and upload queue are not touched.

## Evidence

Synthetic only, `TMPDIR=~/.hermes/cache/scratch/bb-uploads/tmp`, fixture `tests/report_artifacts_fixture.py`:

- Review fixes (independent review of `078c069`, ACCEPT with U1 to U3): panels with active uploads are not evicted (browser test, red on `078c069`); `.tmp`/`.crdownload` names renamed (`test_sync_ignored_suffixes_are_renamed`, red); large refused bodies still get the reply (`test_large_refused_body_still_gets_the_reply`, red: connection reset); pasted JPEG keeps `.jpg`; the drop guard stays on while a list loads (both in the browser tests, red). Re-review of `a24e736` (ACCEPT with N1, N2): a refused upload gives back its slot before discarding (`test_refused_upload_releases_its_slot_while_discarding`, red: 503); the panel being mounted is never evicted (browser test, red).
- `tests/test_artifact_uploads.py` (33 tests): flag off (404, list `disabled`, capability false); 15 gate refusals (Origin missing/foreign, cross-site and same-site Fetch Metadata, X-Requested-With missing/wrong/duplicate, Content-Type wrong/JSON/missing, Transfer-Encoding, Content-Length missing/non-decimal/signed/duplicate) plus a foreign Host; 413 answered with no body sent and the connection closed; invalid selectors; `root_instance` mismatch and match; busy 503 with `Retry-After`; 507 via a patched `free_bytes` and the floor arithmetic; no-folder 409 for flat-root, non-dedicated and shared reports with nothing written; symlinked report folder, symlinked subfolder not followed, folder swapped for a symlink after association, symlinked lane component; success entry equal to the list entry, byte-identical download, nothing written outside the folder, mode `0666 & ~umask`; empty file; collisions including `Shot.PNG` vs `shot.png` and `report.md` vs `REPORT.md`; two concurrent same-name uploads both kept; hard-link fallback, including an outside writer taking the name between check and rename (kept, upload renamed); an NFD name on disk blocks its NFC twin; more than 8 query fields gives 404, not a traceback; short body and a stalled body leave neither final nor staged files; sanitizing (`../../x.py`, `a\b.js`, `.env`, `_meta`, control and bidi characters, Windows device names, 180-byte cap with multi-byte names and suffixes, empty, NUL); no folders created from `sub/dir/file.txt`.
- `static/tests/artifact-uploads.synthetic.test.cjs` (5 tests; the last two cover review U1, R3 and N2): button present and enabled; picker upload of two files including a case-insensitive collision ("Saved as Shot-2.PNG"); New highlight; byte-identical download; drag and drop with the highlight; progress row during a slowed 6 MB upload that survives switching reports and back; Cancel leaves no file and no staged file; 8 MB precheck sends nothing; a server 507 is shown until dismissed; a drop outside the panel is prevented and does not navigate; disabled with reason for non-dedicated, flat-root and shared reports, drops there upload nothing; absent with the flag off and file drops not intercepted; live editor draft, cursor and focus unaffected by an upload; image paste saved as `pasted-<time>.png`.
- `python3 -m unittest tests.test_artifact_uploads tests.test_report_artifacts`: 55 tests OK. Full Python suite (43 modules, 4 in parallel): 587 tests OK, 13 skipped (12 Docker terminal tests, 1 dashboard); run before the review fixes, which added 2 upload tests (rerun alone, OK). `npm test` (now including the new file): 210 pass, 0 fail; nothing needed a rerun.
- Screenshots: `~/.hermes/cache/scratch/bb-uploads/tmp/screens/artifact-uploads-{idle,uploading,after-upload,dropping,error,disabled}-{light,dark}.png`.
- Delete (synthetic only, `TMPDIR=~/.hermes/cache/scratch/bb-delete/tmp`): `tests/test_artifact_delete.py` (18 tests): flag off 404 with no Delete flags; 17 gate refusals plus a foreign Host; invalid selectors, path traversal in `artifact`, more than 8 fields (404); invalid bodies (400); `root_instance` mismatch and match; `deletable` flags (true for non-Markdown files in the folder; false for `.md`, `.MARKDOWN`, `.Md`, finding-field and report-link files outside the folder, and every file of folderless reports); the upload reply carries `deletable`; success removes exactly one path (tree compared before/after) and a second delete is 404; 409 `not_deletable` for Markdown and for a folder file listed only by a link; 404 for associated files outside the folder; 409 `changed` for size, older and newer mtime with the file untouched; symlink swapped in after listing (409, link and target untouched); folder swapped for a symlink (404, target untouched); a directory is never removed; a staged `.syncthing.board-*.tmp` name is not listed and refused; 8 rounds of concurrent upload and delete of the same name each leave exactly one file with the uploaded bytes and no staged file. Review fixes (independent review of `c5f9d0f`, ACCEPT with R1 and R2): another finding's file or folder is not deletable, a same-size replacement within the same second is refused by `version`, a body without `version` is invalid, an unreadable ledger turns delete off (5 tests in `ReviewFixTests`, all red on `c5f9d0f`). `static/tests/artifact-delete.synthetic.test.cjs` (4 tests): Delete only on deletable rows (none on `.md`, `.MARKDOWN`, outside-folder rows, folderless reports or with the flag off); aligned with Download, also at 420 px; dialog title and text, Cancel focused, Enter on Cancel and Escape keep the file; Delete removes the file and row, shows the fading note, keeps another row's open preview node and focus inside the panel; a file changed on disk after listing shows the changed message, stays on disk, the list reloads and the message survives quiet reloads until dismissed; the native fallback dialog without `BoardLedgerActions`; live editor draft and upload error rows unaffected; no page errors.
- `python3 -m unittest tests.test_artifact_delete tests.test_artifact_uploads tests.test_report_artifacts`: 76 tests OK. Full Python suite (44 modules, 4 in parallel): 610 tests OK, 13 skipped. `npm test` (with the new file): 217 pass, 0 fail; no reruns.
- Delete screenshots: `~/.hermes/cache/scratch/bb-delete/tmp/screens/artifact-delete-{row,dialog,dialog-fallback,after-delete,changed,narrow}-{light,dark}.png`.

## Gaps and limits

- The free-space check is a preflight, not a reservation; concurrent writers can still fill the disk (then the write fails with 507 and the staged file is removed).
- Without hard links and without `renameat2(RENAME_NOREPLACE)` (non-Linux, very old kernels, some FUSE filesystems), the plain-rename fallback can replace a file another process creates in the instant between the check and the rename. This process's own uploads cannot collide.
- Case-insensitive uniqueness covers this process and the names present at upload time; a sync peer can still deliver a differently cased duplicate later (Syncthing then reports a case conflict as it would for any writer).
- Upload copies the bytes as given: no type sniffing, no scanning, no stripping of metadata (EXIF location in photos, for example). Downloads stay inert (`application/octet-stream`, `nosniff`, sandbox CSP), so a renamed HTML file is never rendered.
- A Markdown file uploaded into a report folder becomes a report file the Board lists like any other `.md` in `reports/`.
- Uploads go only into the folder root, not into subfolders such as `poc/` or `evidence/`.
- A refused upload of more than 1 MiB is discarded after the reply. If that takes over 300 s, or 4 discards are already running, the connection closes with the rest unread and the browser may show "Upload failed" instead of the reason. A 507 or busy refusal of a large file therefore costs the time to send it before the message shows, in browsers that do not read early replies.
- Each socket read has a 60 s timeout, but there is no overall deadline: a client that trickles bytes can hold one of the two upload slots for a long time (tailnet clients with a forged Origin only).
- There is no authentication; anyone who can reach the Board through the tailnet boundary can upload. Uploaded files are distributed by Syncthing to every device sharing the root.

Delete gaps:

- The changed check compares size, whole-second mtime and `version` (inode + nanosecond mtime), so a replacement (new inode) or an edit (new mtime) after the list loaded is refused. Another process (Syncthing, an agent) can still replace the file in the instant between the `lstat` and the `unlink`; the replacement is then removed. This process's own uploads cannot interleave (shared lock).
- Protection from other findings covers their artifact fields only; a file another report links to by a relative Markdown link (and not through any ledger field) is not detected.
- Delete is permanent in the Board and Syncthing removes the file on every peer. Only Syncthing file versioning on a peer, if configured, keeps a copy.
- One file per request; there is no multi-select or delete-all.
- Files linked from the report or a finding field but stored outside the folder (for example `evidence/` at lane level) cannot be deleted here, by design: other reports may use them.
- Folders emptied by a delete stay; no directory is ever removed.

## Decisions for the owner

1. Keep uploads limited to reports with a dedicated folder (recommended), or offer to create `reports/<FID>-<slug>/` for the 94 reports without one?
2. Keep the 512 MiB per-file cap and 1 GiB free-space floor (recommended), or raise the cap for long screen recordings?
3. Keep uploads in the folder root (recommended), or add a target subfolder choice (`poc/`, `evidence/`)?
4. Keep renaming on collision (recommended), or ask before saving under a new name?
5. Strip image metadata (EXIF) on upload? Recommended: not by default; revisit if screenshots from phones are common.

Delete (feat/board-artifact-delete):

6. Keep delete under the same `--artifact-uploads` flag (recommended), or give it its own `--artifact-delete` flag so a deployment can upload without being able to delete?
7. Keep Markdown files undeletable from the panel (recommended), or allow deleting non-report Markdown such as notes the owner uploaded?
8. Keep delete permanent (recommended for now, matches the request), or move files to a Board trash folder (`_trash/` inside the report folder, hidden from the list and ignored by the association) so a mistake can be undone?
9. Keep error notes until dismissed or a full Reload list (recommended), or also clear them on the 4 s quiet auto-refresh?
