# One report per finding packet

- Branch: `feat/board-one-report-per-packet`; base `origin/beta` at `18089f4` (production); target `beta`.
- Ryushe (verbatim, two messages):
  - "If you look at Bugboard and look at the recent reports, there are a ton of duplicate reports there. The reason for that is that we're not picking out the main report. We are instead picking out other files and stuff within that directory as well that end up being read in as that report."
  - "so, submission md at one point was the final report, the fid reports are really old and rn we use more of a vuln type naming convention (can look at submission skill to see what i mean) so really we can prefer the vuln type reports (which are the main ones now -> submission.md -> fid reports and ya one report shwos per vuln pls"

## Intent

A finding packet (`reports/<FID>/` or `reports/<FID>-<slug>/`) is one vulnerability, so it is one report everywhere the Board lists reports: the Reports list and picker, report counts, Recent (view, dashboard panel, Recon panel) and search report hits. That report is the packet's *main report*, chosen in Ryushe's order (vuln-type, then `SUBMISSION.md`, then the old FID report). Every other Markdown file in the packet is a *packet file*: not listed, but one click away from the "Packet files" switcher above the report, and it opens and edits exactly like a report. Recent shows the packet once, at the time of its newest file, and says which file changed.

## Helper contract (`report_packets.py`)

One module beside `report_evidence.py`, imported by both indexes: `app.reports()` (`/api/data`, `/api/lane-reports`) and `search_index.SearchIndex` (`/api/search`, `/api/recent-reports`). It decides from paths, lstat mtimes and the ledger only, never from file content. Ledger paths resolve through `report_evidence.reports_relative` (relative, normalized, and other-host absolute paths). Evidence is excluded by `report_evidence.is_evidence` before the helper runs and is unchanged.

`plan(md_files, findings, lane, other_files, evidence_files)` returns `Packets` with:

- `mains[rel]`: `packet`, `fid`, `tier`, `modified` (packet time), `updated_file` (packet-relative newest file when it is not the main, else `None`), `evidence` (evidence paths in the packet), `owner_fids` (findings whose `report_path` lies in the packet), `finding` (`(fid, match)` for Recent);
- `files[rel]`: `packet`, `main`, `group` (`files`, `archive`, `older`);
- `main_for(rel)`: the listed report a path stands for.

Packet: a direct child folder of `reports/` matching `^([A-Za-z][0-9]{2,})(?:-.*)?$` (the existing `_PACKET_DIR`, now owned by `report_packets.PACKET_DIR`). Candidates: the packet's top-level `.md` files that are not evidence and do not start with `.`.

| Tier | Name (case-insensitive) | Notes |
|---|---|---|
| 1 vuln-type | `<prefix>-<FID>.md` | `<FID>` equals the folder FID; no `.` in the stem; prefix has 3 or more non-empty hyphen tokens; first token not `submission`, `evidence`, `report`, `judge`, `poc`, `notes`, `finding`, `readme`, `draft` |
| 2 | `SUBMISSION.md` | |
| 3 | `SUBMISSION-<FID>.md` | its own tier, so `SUBMISSION.md` always comes first |
| 4 old FID report | `REPORT.md`, `<FID>-REPORT.md`, `REPORT-<FID>.md`, `<FID>.md` | one tier; tie-breaks decide among them |
| 5 fallback | any other candidate (`POC.md`, `NOTES.md`, `JUDGE-RECEIPT-<FID>.md`, `EVIDENCE-<FID>.md`, ...) | the ledger file, else the only one, else the newest |

Within a tier: a file named by a ledger `report_path` wins, then the newest mtime, then the lower-cased name. A `report_path` never moves a file to an earlier tier, and one under an `_` folder can never make that file main (only top-level files are candidates).

- **Packet files**: every other `.md` in the packet at any depth, except `_meta/` files. Group `archive` when any folder in the path starts with `_` (`_archive/`, `_drafts/`, `_retracted/`), else `files` (top-level sidecars, `poc/`, `evidence/`, `new report/`).
- **`_meta/`**: unchanged. The search index flags it `packet_meta` (hidden from Recent and search unless "Include generated and _meta files"); `app.reports()` lists it as before. It is neither main nor a packet file.
- **Packets without a candidate** (evidence-only, or only nested files): no main; their files stay exactly as today.
- **Packet time**: newest mtime of any regular file in the packet tree (Markdown, evidence, uploads, PoC files), excluding paths with a dot-named component, `*.tmp` and anything under `_meta/`.
- **Legacy copies**: a file outside packets named `<FID> - <title>.md` whose FID occurs once in the ledger (and no other finding's `report_path` names it) becomes a packet file (`older`) of that finding's packet main. The packet is the folder holding the finding's `report_path`, else the only packet folder with that FID; if neither is unique, or that packet has no main, the copy stays as it is today.
- **Two folders sharing an FID**: each is its own packet with its own main and row; never merged.
- **Recent finding**: the finding whose `report_path` lies in the packet (narrowed to the main's own owner when several do) with `match: report_path`; else the packet FID (`match: packet`) when it occurs once in the ledger.

## API changes

- `/api/data`, `/api/lane-reports` `reports`:
  - Main report items add `packet`, `packet_main` (itself), `file_modified` (own mtime), `updated_file`, `packet_evidence`; `modified` is the packet time. `owner_fids` gains every finding whose `report_path` lies in the packet, so a main the ledger does not name (ledger says `REPORT.md`, main is `SUBMISSION.md`) is `registered_report`.
  - Packet files: `kind: "packet_file"` with `packet`, `packet_main`, `packet_group`, their own `owner_fids` and `modified`. Not read for the listing: `editable` follows autosave, `collaboration_editable` is `true` (`/api/report` reports the real values when opened).
  - Ownership now uses `reports_relative` for both indexes, so `reports/../reports/x.md` and another host's absolute path register their file (they already counted for the evidence rule).
- `/api/recent-reports`: one item per packet. `items`, `total`, `total_reports`, facets, paging and `within` count packets. Items add `packet` and `updated_file`. N/A follows the main's mark.
- `/api/search`: packet files are never report hits, are not in `counts.report` or a program's `report_count`, and are never read into the text budget. Finding hits link the packet main when the ledger's `report_path` is a packet file.
- `/api/report`, `/api/live/*`, collaboration and artifact endpoints are unchanged: packet files read, edit and list artifacts as before.

## UI behaviour

- **Lists and counts**: the Reports list, picker, the Reports tab count, the workspace "Reports" summary and the dashboard "Report records" leave out `packet_file` items. The Reports list row shows a muted "Updated <file>" line when the packet changed after its main.
- **Packet files switcher** (`[data-packet-switcher]`, `nav aria-label="Packet files"`): above the report, below the picker and lane list, in the artifacts panel's card treatment (surface-2, border, large radius). Shown on a packet main that has packet files or evidence, and on every packet file. Order: the main report (with a "Main report" pill), Files, Evidence (link to the evidence view), then Archive and Older copies as collapsed `<details>` (opened only when they hold the file being viewed). Every entry is a real `<a href>` hash route with packet-relative names (full path in the tooltip); the open file has `aria-current="page"` and the accent fill. Font Awesome 4.7 icons: `file-text-o`, `file-o`, `paperclip`, `archive`, `history`.
- **On a packet file**: a one-line note "Packet file of <main>, the main report for this finding." links the main report. The picker shows the main report selected, the lane list marks the main current, the record line says "Packet file". The file opens in the normal editor (plain, shared draft with autosave, or the live editor) and saves to itself. Old links to packet files keep working; nothing falls through to "Report not found" or switches report.
- **Recent**: one row per packet. Under the path, a muted "Updated SUBMISSION.md" (view) or "· Updated SUBMISSION.md" (dashboard and Recon panels) when another file is newer. The footnote says "a finding packet shows once, at its newest file". Polling is unchanged.
- **Finding links**: the findings-table "Report" link, dashboard drill-row report icon, the evidence view's "Open report" and search finding hits go to the packet main. `reportFor` skips packet files when matching owners and resolves a path match on a packet file to its main. Evidence links are unchanged.

## Tests

New:

- `tests/test_report_packets.py` (26): tier shapes accept/reject (measured names incl. `JUDGE-RECEIPT-<FID>`, `EVIDENCE-<FID>`, `SUBMISSION-<FID>`, dotted stems, wrong FID, sidecar first tokens); named tiers; tier order; tie-breaks (newest, name, `report_path` within tier, old-FID-report ties); `report_path` never overrides the order; fallback (ledger file, only one, newest); `_` folder `report_path` never main (and no top-level candidate means no change); packet file groups and `_meta`; evidence-only packets; two folders sharing an FID; legacy copies (packet by `report_path`, by unique FID, ambiguous, no packet, not in ledger, duplicate FID); cross-host absolute `report_path`; packet time (PNG upload, evidence, `.tmp`, dot names, `_meta` ignored); flat and `_retracted/` reports untouched; `app.reports()` kinds and fields; no content read of packet files in `app.reports()` and in the search index; Recent one row per packet, packet time order, `updated_file`, finding mapping, `within`, navigation toggle; N/A follows the main; search hits and counts; finding links to the main; incremental refresh after adding a vuln-type report (the main switches, the old main becomes a packet file, only the new file is read); a sidecar edit moves the row without adding one; HTTP `/api/data`, `/api/lane-reports`, `/api/recent-reports`, `/api/search` membership and counts; `/api/report` still serves a packet file; both indexes use the shared helper.
- `static/tests/report-packets.synthetic.test.cjs` (5, in `npm test`; fixture `tests/report_packets_fixture.py` reuses the Python lane): one Recent row per packet with the "Updated ..." subline (view and dashboard panel); Reports list, picker, tab count and summary hold mains only; search report hits and the D16 finding hit; switcher hrefs, current marker, packet-relative names, Evidence link, collapsed Archive/Older, `_meta` excluded, plain click and Ctrl+click; an old packet-file URL (top-level, archived, legacy copy) opens with the note and the main selected; finding-row and drill-row report links go to the main; editing a packet file saves that file with shared drafts plus autosave, and in the live editor.

RESULTS_PLACEHOLDER
