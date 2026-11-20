# Frontend integration contract

`api.js` is the transport seam. This document describes the contract the UI consumes and **proposes** the optional write contracts; it does not assert that the backend implements writes. The frontend makes no write requests unless the matching capability is explicitly advertised. All endpoints must be same-origin. Program roots and filesystem access are configured server-side; the browser does not collect secrets or paths.

## Read

`GET /api/data` returns JSON:

```json
{"programs":[{"id":"stable-program-id","name":"Program name","family":"Family","lanes":[{"name":"Web","findings":[],"coverage":[],"gadgets":[],"map":[],"reports":[],"warnings":[]}]}],"warnings":[]}
```

Arrays are scoped to the lane. Missing collections are shown as unavailable, not zero; warnings are shown verbatim as text. The current backend returns findings as `fid`, `class_name`, `title`, `severity`, `status` (also `submission`, `submission_status`, `platform_outcome`); `api.js` maps `fid` and `class_name` to UI identity and class. A coverage collection can also be `{items, counts, total}`; the UI displays the actual `items`, not inferred coverage. A coverage, map or gadget item can be an object or string; its supplied fields are shown rather than inferred. The current backend returns reports as `{path,name}`; selecting one fetches `GET /api/report?family=...&program=...&lane=...&path=...`, which returns `{content,revision,editable:false}`. The adapter maps `path` to a report ID and `name` to its title. A directly embedded report may instead provide `id`, `title`, `content` (Markdown), and `revision`. `revision` must be an opaque token for the exact source content, not merely a timestamp guess.

Dashboard statistics count only loaded records. Counts do not imply unique findings across lanes or a test-depth/coverage metric. Missing lane or finding arrays make finding totals unknown. Submission state and result are displayed only from the explicitly recorded `submission.state` and `submission.result` fields; finding status is never used to infer a submission or outcome.

## Proposed optional capabilities

A backend opts in by adding a top-level `capabilities` object. No capability means read-only. This proposed contract must be coordinated with the backend; absent coordination no update is sent. The named route is an example, not a hard-coded frontend endpoint.

```json
{"capabilities":{
  "findingMetadata":{"enabled":true,"method":"PATCH","url":"/api/finding-metadata","options":{"severity":["High","Low"],"class":["XSS"],"status":["Draft"]}},
  "reportWrite":{"enabled":true,"method":"PATCH","url":"/api/report"}
}}
```

- `findingMetadata`: only a stable finding ID and fields with advertised options are editable. Request: `{programId,lane,findingId,field,value}`; success response: `{value}` with the persisted value. The server owns validation, concurrency and ledger consistency. If a backend cannot guarantee the update addresses the correct source record, it must not advertise this capability. The frontend rejects an unconfirmed or mismatched `value` and displays an error.
- `reportWrite`: request `{programId,lane,reportId,content,revision}`. The backend must atomically compare the supplied revision against the source and, on a match, persist the exact content and return `{content,revision}` with the persisted content and **new** revision. Return HTTP `409` when the revision no longer matches, without writing. Other non-2xx responses are errors. The frontend verifies returned content and revision before displaying saved. Changes during a pending write are sent in a subsequent debounced request with the returned revision. A conflict stops autosave; the draft stays in memory for copying/reconciliation. The frontend does not silently overwrite conflicts or claim browser-local drafts were saved to source.

Report text is editable even when save is unavailable; the UI labels it temporary, in-tab only. Drafts survive view/selection changes in the same tab, but not reload or browser closure. An unsaved draft triggers a before-unload warning where supported. Markdown preview supports headings, paragraphs, bold, emphasis, inline/code fences and lists; raw HTML is escaped and links/images are rendered as text, so the preview cannot trigger external fetches. It is intentionally not a complete Markdown implementation.

The frontend makes no claims of live file watching, external revision polling, report triage, or submission. Conflict detection depends on backend enforcement. The backend must independently secure routes, restrict exposure, validate requests and protect writes; a UI capability flag is not authorization.

## Verification

`node --test static/tests/app.test.cjs` uses Playwright and a local HTTP server with synthetic in-memory fixtures; no real bounty files or backend are accessed. Set `CHROME_BIN` when Chrome is not installed at `/usr/bin/google-chrome`.
