# Report autosave UI — branch-local integration dossier

- **Status:** implementation and synthetic-browser verification complete; independent combined review and corrected backend integration remain open. Not approved for real deployment.
- **Owner / branch / worktree:** delegated UI worker, `feat/board-report-save-ui`, `/home/ryushe/projects/bounty-board-report-save-ui`.
- **Assigned base:** `a0d8a03fc28f43f12b45fb3605176a3ec902b9a1`; target `beta` (fetched `origin/beta` at `553a06cebadd4fe9ded2213466a68510117060d9`). This UI branch deliberately starts on the experimental backend handoff; parent owns dependency ordering and integration.
- **Inspiration / contract:** `BACKEND_API.md` experimental collaboration source autosave. Backend worker is concurrently correcting the publication and recovery protocol; no backend work is included here.
- **Recovery checkpoint:** `9fa85841e40b58be15770780fc5c4097238f3760`; the branch tip contains a later dossier-only handoff commit. **Implementation commits:** `c19980cfc30306bfb4d75573e1ebf1a3dade5c7d` and `9fa85841e40b58be15770780fc5c4097238f3760`; review the entire branch range, including the dossier-only commits.

## Contract implemented

When the server advertises `report_autosave`, an accepted store receipt and point-in-time Markdown publication are shown separately. A `published` state with a recognized successful store receipt is the only success path that clears the pending request; the UI explicitly warns that later writers can change the file. Conflict, pending, uncertain, malformed or unknown outcomes retain editor text and the exact request. Network failure blocks new submissions until the user inspects the original request with its identity and request ID; recovery is a GET and never publishes. On 404, an explicit button retries only the identical request, before newer edits. The current Markdown can be inspected separately without changing the editor. The operation and reasons are displayed as opaque inspection data; the pending request is available for copying.

A publication conflict may follow a visible exchange. The UI warns that the file may have changed, allows inspection of current Markdown and paged retained shared-history versions, and requires an explicit review action before a resolution. It retains the reviewed request and inspection in browser storage. Uncertain or unknown outcomes remain blocked for manual review. Report selection and root identities remain scoped; default non-autosave behavior and CodeMirror undo machinery remain intact. Local storage remains plaintext, origin/tab-scoped, and can be cleared or become unavailable; no stronger durability is claimed.

## Evidence and review

- TDD initial red: `node --test static/tests/report-save-ui.synthetic.test.cjs` timed out waiting for the missing Markdown-saved status; green after implementation. Second red: `--test-name-pattern='lost acknowledgment'` failed because the newer edit was not saved after recovery; green after scheduling it. A further red/green demonstrated that reloading after an external change previously left the old Markdown-saved notice visible. Other assertions were added after behavior existed; this is not a claim of full strict TDD.
- Final `node --test --test-concurrency=1 static/tests/report-save-ui.synthetic.test.cjs`: **9 passed**. Real Chromium and real loopback HTTP server with autosave enabled only on synthetic TMPDIR roots cover an actual publication; lost response after backend commit, reload and newer edit; real two-client and external competing edit conflict, current-file inspection and retained history; delayed response while switching report; and 404 followed by exact original retry. The three `pending`, `outcome_uncertain`, and `future_state` cases mutate the real backend POST response in Playwright; they are mocked status coverage, not proof the backend generates those outcomes. Tests use a real synthetic file, not Shared.
- `npm test`: **58 passed**, the repository script explicitly excludes `browser metadata update reaches backend with a disposable synthetic writer`; this selection does not include the new autosave suite.
- `node --test --test-concurrency=1 static/tests/collaboration-recovery.synthetic.test.cjs static/tests/collaboration-undo.synthetic.test.cjs static/tests/drafts.synthetic.test.cjs`: **11 passed** standalone. An earlier concurrent run alongside npm had one undo test timeout (10 passed, 1 cancelled); a complete standalone rerun passed, but the timeout is not explained as a demonstrated product fix.
- `node --check static/app.js`, `node --check static/tests/report-save-ui.synthetic.test.cjs`, and `git diff --check` passed before handoff; rerun staged checks on final commit.
- No separate independent review was performed by this worker; the parent explicitly owns review and merging.

## Blockers / integration and activation gates

1. **Corrected backend candidate not available in this checkout:** rerun the new browser suite against the parent's exact combined staged tree after the backend fix lands. Confirm its actual `publication.state`, retained observations, recovery receipt, 404 semantics and idempotency match this UI. Trigger: backend worker supplies its reviewed fix. A stale backend receipt or changed pending/merged semantics blocks integration until reconciled.
2. **Durability and concurrency remain backend limitations:** `published` is an inspection, not a cross-host compare-and-swap; recovery may not add late displaced inode changes to shared history. Real sync, power loss, deployed-filesystem durability, metadata preservation, retention lifecycle and independent security review are not demonstrated. Do not activate against real reports or sync based on these tests.
3. **Reviewer gate:** parent reviews full frontend/backend combined diff and tests real conflict-to-resolution, retained versions, recovery 404/retry, browser storage failure, and selection races on the combined candidate. The feature dossier is branch-local; remove it from the integration target as part of merge cleanup.

## Resume / decision

- Owning ref: `feat/board-report-save-ui`; target `beta`.
- Exact next step: parent integrates only after the corrected backend and UI have been reviewed together and the above browser checks rerun on the exact candidate. Do not push, merge, activate, or write real Shared from this branch.
