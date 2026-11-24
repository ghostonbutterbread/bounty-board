# Taxonomy and coverage drill-down

- Branch: `feat/board-taxonomy` (base e9246db)
- Status: implemented, review pending. Companion: `taxonomy-cleanup-proposal.md`.

## Intent

1. Show legacy finding classes and severities in a consistent VRT-style vocabulary without touching data (display-time normalization; raw values stay the source of truth and the edit/filter value).
2. Replace opaque route-type counts on the Coverage tab with drill-downs that separate inventory from reviewed coverage, using only what the coverage store records.

## Contract

- `static/taxonomy-rules.json` is the single source of truth (served statically, read by `taxonomy.py` and `static/modules/taxonomy.js`). Version 1. Rules are ordered; first match is primary, other matching categories are `alternates`. Patterns use the Python/JS common regex subset.
- `window.BoardTaxonomy` (pure): `configure(rules)`, `ready()`, `normalizeClass(raw)` returns `{category, subclass, label, raw, confidence: high|medium|low|none, alternates[], reason?}`; `normalizeSeverity(raw)` returns `{value, raw, kind: canonical|alias|placeholder|range|unmapped|missing, note}`. Before rules load, classes are Unclassified and severity is not rewritten.
- Confidence: exact alias = high; keyword match = medium; more than 8 words or an agent-name suffix (`hunter`, `auditor`) = low; none = Unclassified (raw label always shown).
- Severity mirrors `bounty_core.finding.normalize_severity` (BBH, branch `feat/ledger-severity-normalization`): P1-P5 and INFORMATIONAL aliases, everything else UNKNOWN (P0 and NONE stay UNKNOWN with a note). Placeholder and range labels also map to UNKNOWN, flagged by `kind`. EXCEPTIONAL passes through because the Board already lists it.
- `/api/data` additive fields only: findings get `class_category`, `class_subclass`; coverage items get `class_category` plus provenance columns `updated_at`, `agent`, `assessment_run_id`, `first_seen`, `last_seen` (null when the database lacks a column); unassessed surfaces get `first_seen`, `last_seen`. No existing field changed.
- app.js edits (small, commented): `taxonomy()`, `classNote()`, `severityNote()` helpers; a category line under class and a "Shown as" line under non-canonical severity in the findings table; a "By category" group on the dashboard; `<div id="coverage-drilldown-host">` in `coverage()`. Raw class and severity filters, edits and the existing dashboard bars are unchanged.
- index.html: three lines under the feature-modules comment (taxonomy.js, coverage-drilldown.js, its css).

## Coverage data findings (real stores, read-only, aggregates only)

36 lanes with a coverage database, 5,429 mapped surfaces, 5,545 assessment rows.

- **Two denominators.** A row is one class question on one surface. 4,745 surfaces have at least one row (1 row: 4,001; 2: 689; 3: 54; 4: 1); 684 surfaces have none. So rows (5,545) are not surfaces (5,429). The old tab's "Assessment questions" total mixes these up when read as coverage. The drill-down shows surface tiles and question tables separately and states the check `surfaces with questions + without = mapped`; it warns when that fails.
- **States by row:** open question (`no_assessment`) 3,534, bounded review 1,113, blocked 666, in progress 214, legacy `untested` 18. So about 64% of rows are placeholders for work not done; "assessed" is a minority. Only about 20% of rows are bounded reviews.
- **Evidence and reasons are well populated where it matters:** every bounded-review, blocked and in-progress row has a reason and at least one evidence reference; every bounded review has a boundary. About a quarter of evidence refs look like relative paths (linkable to lane reports); the rest are free-form strings.
- **Freshness is thin.** Stale is derived from fingerprint mismatch; only 2 rows are stale, and 582 rows have no surface fingerprint at all (baseline falls back to the mapper run id). Time-based staleness is possible: `updated_at` exists on every row but was not served before this branch. The drill-down adds a user-selectable "stale after N days" (default 30), shown separately from fingerprint staleness.
- **Blocked reasons are free text** (no structured field). The drill-down groups them by keyword tags (edge/WAF, account or role, source/build, scope, transport, other) and always shows the original text. Tags are a heuristic.
- **Kinds are not a stable vocabulary** (209 distinct `kind` values with spelling variants such as `api_operation`, `api-operation`). Kind tables show the 15 largest and a filter lists 40; they are not merged. A kind taxonomy is a follow-up.
- Coverage `class_name` has 55 distinct labels; the same rules map 99.1% of the 5,545 rows (94% at high confidence).

## Drill-down (static/modules/coverage-drilldown.js)

Surface tiles (mapped, with a bounded review, with work in progress, with a blocked question, stale, nothing assessed), reconciliation line, data-quality line (no evidence, unknown freshness, not updated in N days), filters (view: needs attention default / all / per state; class category; kind; stale-after; search), a question table (scope = host, surface key, input, consumer; state with prior state for stale; freshness; age and agent; boundary, reason, reopen-when; evidence, linked to the lane report when the ref path matches), questions-by-class table with reviewed share, mapped-vs-reviewed by kind, blocked-by-reason. Copy states that a bounded review is one class on one surface, not application coverage.

Not done because the data does not support it: per-feature rollups beyond host/kind (no feature or flow field), time-to-review trends (no history, only latest `updated_at`), percent of the application reviewed (no known true denominator; the mapped inventory only reflects what mappers found), blocked-reason structured categories (free text), cross-class completeness (no expected-class list per surface kind).

## Decisions

- Display-only normalization; no write path. Raw label is always visible next to the category.
- `confidence` and `alternates` instead of silently choosing for compound labels.
- Rules in JSON, parity-tested between Python and JS from a shared cases file.
- Open-question rows count as "question open", never as reviewed.

## Evidence (exact runs, synthetic data only)

Run in this worktree, synthetic fixtures only, machine shared with other agents:

- `python3 tests/safe_suite.py` (includes the 6 new `tests/test_taxonomy.py` tests): Ran 186, OK, 1 skipped (the excluded real-BBH test is the skip policy of the suite).
- `npm test` (existing 14 files, concurrency 1): 115 tests, 114 pass, 1 fail. The failure, `manual refresh supersedes an older held full response` in `progressive-races.synthetic.test.cjs`, was a 30 s timeout under load; the same file re-run alone passes 16 of 16. Not caused by this branch as far as shown, but not proven on the base commit.
- New, run separately: `static/tests/taxonomy.test.cjs` 5 pass; `static/tests/coverage-drilldown.test.cjs` 8 pass; `static/tests/taxonomy-coverage.synthetic.test.cjs` (browser, real server, real SQLite) 1 pass.
- Real-data check (read-only): rules map 76.7% of 361 finding class occurrences (277); 89.6% of the 309 non-placeholder ones. 99.1% of 5,545 coverage rows.

## Gaps and follow-ups

- `package.json` `test` script was not edited (merge-conflict hotspot); run the three new test files explicitly (see below) or add them at integration.
- Coverage by "feature" needs a feature/flow key on surfaces. Structured blocked reasons need a `blocked_reason_code`. A fingerprint baseline for more rows would make stale meaningful. A kind alias table is needed before kind rollups are trustworthy.
- BBH should write a normalized class (and keep the raw text in a tag) so the Board rules become a fallback.
- Screenshots: `docs/integrations/taxonomy-screens/` (synthetic fixture).
