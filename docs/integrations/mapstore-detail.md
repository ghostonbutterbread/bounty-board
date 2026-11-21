# MapStore observation detail integration dossier

- **Status:** awaiting parent review; not integrated or activated.
- **Owner / branch:** delegated worker, `feat/board-mapstore-detail`.
- **Worktree:** `/home/ryushe/projects/bounty-board-mapstore-detail`.
- **Feature base:** `085c58717bc430018a56e39416b94ab4fbd86ea8` (parent-supplied dashboard feature tip).
- **Intended target:** `beta`; parent owns combined exact-tree review and integration. No remote fetch under the explicit no-remote boundary.
- **Recovery checkpoint / implementation commit:** `d55c07c58907abe8658c7ac70f09b309f7c41d30`; the branch tip includes a subsequent dossier-only handoff commit.
- **References:** MapStore skill and producer contract supplied by parent: `recon/maps/map.jsonl`, relative indexed Markdown paths, `gadget`/`residual` tags and recorded lifecycle status.

## Intent and contract

Open selected lane observation bodies on demand without leaking across programs or inventing capability fields. Index metadata remains visible with explicit recorded statuses/tags and missing fields. Archived is not active; gadget is not necessarily a confirmed exploit.

`GET /api/map-observation` requires exactly one each of family/program/lane/path and one exact matching record in the current bounded UTF-8 index. It reads a bounded regular UTF-8 `index.md` through the existing componentwise no-symlink reader rooted at the selected source root; invalid, duplicate, missing and unsafe cases return a path-free error. The backend is read-only and the index and body are not an atomic snapshot against concurrent writers. The UI opens inert text only on click, and ignores results whose original DOM/selection is gone. No Markdown rendering, auto-links or remote resource fetch.

## Evidence

- TDD: real HTTP initially failed with 404 for the requested indexed body, then passed; real Chromium initially failed because the open button was missing, then passed. The browser test runs against a real Python server and synthetic multi-program MapStore, checks lazy fetching, archived/residual labels, missing/legacy records, inert hostile markup/no remote requests, and a deterministic delayed-response program switch.
- Under fenced HOME, HERMES_HOME, XDG, TMPDIR and source-first PYTHONPATH: `python3 -W error::ResourceWarning tests/safe_suite.py` passed 73 tests, explicitly excluding `test_real_bbh_metadata_write_on_disposable_fixture`. A subsequent targeted run passed 7 MapStore HTTP tests, including additional surface/URL path shapes.
- Fenced `npm test` passed 60 tests, including the real Chromium/Python test. Its existing skip pattern excludes the real-writer browser test. Playwright installed version matches the lockfile (1.60.0).
- No real Shared, service, remote, push, merge or activation used. Parent supplies independent review of the combined exact tree.

## Boundaries and next step

The feature supplies index/body reads only; application-behavior indexes, edits, and gadget composition are out of scope. Data root must remain trusted against concurrent hostile filesystem replacement as documented in BACKEND_API. Parent should inspect the combined diff and security tests, verify actual beta integration candidate, then integrate only on acceptance; omit branch-local dossiers from beta. Runtime activation and stable promotion require separate authorization.
