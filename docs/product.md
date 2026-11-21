# Bounty Board product direction

- Status: active product direction; implementation and integrations are incremental.
- Owner: Bounty Board maintainers.
- Canonical path: `docs/product.md`.
- Supersedes: none. Implementation commit: pending.

## Purpose

A fast, local-first workspace for answering where we hunted, what surfaces were mapped or reviewed, and what vulnerabilities we found. The directory root is configurable; the existing program/lane data remains the source of truth. Default to a loopback-only service at port 9001. Never put real program data or credentials in the source repository.

## Workspace

- Portfolio dashboard: findings, severity, vulnerability classes, submissions, manually recorded outcomes and duplicates. Rank activity only when supported by an explicitly named reliable activity source; missing records mean unknown.
- Program/lane selector from configured roots; contextual selectable views for findings, coverage, reports, gadgets and MapStore. Coverage distinguishes mapped questions, unassessed, in-progress, bounded reviews and stale/blocked where the source supports them. Link each reviewed boundary to its evidence; no implied whole-app completeness.
- Filter findings by program, severity, vulnerability class and status. Where the canonical source supports it, edit severity, class and status directly; preserve severity rationale, identity, finding/submission/outcome distinctions and report ownership. Do not hand-edit generated ledgers. An unavailable write must be visibly disabled, not simulated as successful.
- Support multiple selectable themes, including light and dark, with accessible contrast and persisted preference.

## Report editing

- Open the actual registered report Markdown file and display a rendered Markdown preview while editing.
- Autosave changes to the owning source file. Show unsaved, saving, saved, conflict and error states; do not equate a browser-local draft with a saved report.
- Preserve an unsaved draft on error or conflict, surface external edits, and do not silently overwrite them. A revision check alone is not atomic exclusion against uncoordinated writers; establish the actual writer and synchronization guarantees before enabling writes on shared/synced files. Where those guarantees cannot be established, expose the limitation and keep the affected writer disabled rather than claiming conflict safety.
- The Markdown renderer treats report content as untrusted: do not execute scripts, unsafe HTML, or silently fetch remote resources. No automatic triage rewrite or report submission.

## Safety and data semantics

Protect the local API against cross-origin writes, path traversal and symlink escapes; avoid making sensitive data available on other interfaces by default. Report missing and unreadable sources explicitly. Gadget residuals are observed behavior, not automatically findings. Submission state and platform outcome should remain independently representable.

## Verification

Use synthetic disposable fixtures for all mutation tests. Verify discovery, filtering, cross-program aggregates, available write paths, stale/conflicting report edits, safe rendering, theme persistence, error states, and the actual browser/server flow. Exercise real source reads without exporting target details and report integrations that remain unsupported.
