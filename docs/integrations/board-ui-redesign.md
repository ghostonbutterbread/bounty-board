# Board UI redesign and app shell

- Branch: `feat/board-ui-redesign`; base `e9246db` (live editing server + module seam).
- Owner of: the visual design system (`static/style.css`), the app shell (`static/index.html`), and presentation in `static/app.js`.
- Data handling, drafts, metadata writes, recovery panels, root-change checks and phased loading are unchanged except where noted under "Behavior changes".

## Intent

Ryu asked for a clean, professional, user-friendly Board with dropdown menus and other application conveniences. The redesign targets a calm, dense product UI (Linear/Primer style): neutral surfaces, one accent per theme, hierarchy through weight and spacing, crisp sticky tables, system fonts and tabular numerals. Three UX to-do items are implemented as read-only features:

1. Program search and predictable program selection (no silent "first program").
2. Background report loading without a manual "Apply" step, without disturbing edits.
3. Clickable severity and finding-class breakdowns that list matching findings by program and link straight to findings and reports, plus a "Not submitted" dashboard filter.

## Contract for other agents

### Design tokens

All tokens are CSS custom properties documented at the top of `static/style.css`, defined for `light`, `dark` and `dusk`:

- Surfaces `--bg --surface --surface-2 --surface-3 --surface-raised --sidebar`; text `--text --text-2 --text-3 --text-on-accent`; lines `--border --border-strong`.
- Accent `--accent --accent-hover --accent-soft --accent-text`; feedback `--success|--warning|--danger|--info` each with `-soft`.
- Severity `--sev-exceptional --sev-critical --sev-high --sev-medium --sev-low --sev-info --sev-na --sev-unknown`. Any element with `data-sev="<level>"` gets `--sev-color`.
- `--radius-sm|--radius|--radius-lg|--radius-pill`, `--shadow-sm|md|lg`, `--space-1..8`, `--font-sans --font-mono`, `--text-xs..2xl`, `--focus --focus-ring`, `--ease --dur`.
- The original names (`--ink --muted --page --panel --border --accent --accent-soft --warning --warning-bg --focus --table --top --nav* --shadow`) remain as aliases, so modules written against them restyle automatically.

Shared classes: `.button` (`.primary .subtle .ghost .sm .icon-only`), `.panel .panel-pad .panel-head`, `.message` (`.warning .danger .success`), `.hint .state .empty`, `.badge` (`.accent .success .warning .danger .outline`), `.sev[data-sev]`, `.chip`, `.kbd`, `.skeleton`, `.truncate` (gets a tooltip when clipped), `[data-tip]` (tooltip text).

### Extension hosts and hooks

- `<div id="global-search-host"></div>` in the topbar (`.top-actions`), hidden while empty. For the search agent.
- Finding rows: `<tr data-finding-id data-program data-lane>` (program id, lane name). For the ledger agent.
- Section tabs keep `data-section`; the MapStore and Gadgets tabs also carry `class="drop-target"` and `data-drop-target="map|gadgets"`. Add `.drop-active` to a target while a draggable is over it; add `.dragging-finding` to `<body>` (or any ancestor) during a drag to outline all targets. Styling is provided; drag logic belongs to the ledger agent.
- `#live-report-host` and `#report-artifacts-host` markup and data attributes are unchanged. New: on re-render, an existing host node is kept (moved into the new markup) when `data-family/program/lane/path/report-id` are identical. Modules should therefore treat "same node, already mounted" as the normal case on `afterRender`, and mount fresh when the node is new. A different report always gets a new host.
- Module context gains `ctx.ui` (= `window.BoardUI`). All previous keys are unchanged.

### `window.BoardUI`

Frozen object, available before modules load:

- `toast(message, kind='info'|'success'|'warning'|'danger', {timeout})` returns the toast element.
- `openMenu(trigger, items, {label, align})`: accessible menu (`role=menu`, arrow keys, Home/End, type-ahead, Escape returns focus). Items: `{label, icon, onSelect, checked, disabled, danger}`, `{separator:true}`, `{heading}`.
- `openPopover(trigger, element, {className, label, align, reanchor})`, `closePopover(restoreFocus)`.
- `openProgramPicker(trigger, onPick(programId), {current, align})`: searchable combobox/listbox.
- `navigate({view, program, lane, section, report, highlight})`: same navigation the app uses (updates history).
- `severityKey`, `severityRank`, `severityBadge`, `statusBadge`, `submissionState`, `isNotSubmitted`, `icon(faName)`, `escape`.

### URL routes

`#/dashboard`, `#/programs`, `#/programs/<program id>/<lane>/<section>[/<report id>]`, each part `encodeURIComponent`-encoded. Back/forward and reload restore the view. A route to an unknown program falls back like a normal load.

## Decisions

- **Native selects kept** for Program, Lane, Dashboard program and Report: they are fully accessible, many tests and keyboard flows depend on them, and they are restyled. Search-heavy switching uses the new "Switch program" picker beside them.
- **Theme switcher** is a menu button (`aria-label="Theme"`, menuitemradio items). The old `<select id="theme">` was removed; tests now use the menu.
- **Filters** are multi-select popovers (Severity, Class, Status, Submission) with chips, per-chip remove and "Clear all". `state.filters.<key>` is now an array.
- **Sorting**: Finding, Severity (scale rank, exceptional first), Class, Status; click cycles ascending, descending, off; persisted in `localStorage` (`bounty-board-finding-sort`). Ledger findings have no date field, so there is no date sort.
- **Open workspace** shows its target next to the button: dashboard filter program, else the current/last-used program, else the first program labelled "First program; none chosen yet". The workspace also says when it is showing a default. Explicit choices are remembered (`bounty-board-last-program`, plus up to five recent programs in the sidebar). Requiring an explicit pick before opening would break the documented one-click flow and ~24 test call sites; this is offered as a follow-up decision.
- **Not submitted** follows BBH semantics: a missing `submission.state` means `not_submitted`; `submission_status` is the legacy fallback; `''`, `not_submitted`, `unsubmitted`, `draft`, `none` count as not submitted; any other recorded state counts as submitted work. The dashboard defaults to "All records" (persisted choice), so totals are unchanged unless Ryu opts in. Submission records always show all findings.
- **Auto-apply**: completed portfolio data and a selected lane apply automatically unless a form field, CodeMirror or the live editor host is focused, a metadata write is pending, a draft needs recovery, or there are unsaved edits while a report editor is open. While deferred, the message explains why and keeps the "Apply loaded reports"/"Apply selected lane" button for an immediate apply; the apply is retried when focus leaves the field, after any render, and after an invalidating navigation. A successful report apply shows a short toast.
- **Breakdowns** group by the normalized severity scale (display keeps the recorded spelling) and by class (with an "Unclassified" row). Expanded rows list findings grouped by program/lane; titles open the finding (filters cleared, row highlighted and scrolled into view) and "Report" opens the owning registered report when the report index is loaded.
- Fonts: system stack only; icons: vendored Font Awesome 4.7 (no emoji). No new dependencies.
- Copy: visible separators that were em dashes in availability details are now colons; existing test-bound labels such as "Pending severity value — copy before leaving" were left unchanged to avoid churning recovery tests.

## Behavior changes worth reviewing

- Background data no longer waits for a click when nothing is being edited (to-do 4). The guard conditions above replace the previous "any focus inside #app or any unsaved state" rule.
- `render()` keeps focus on sort headers, breakdown rows, the dashboard work filter and section tabs after re-rendering (keyboard users previously lost focus).
- Unchanged: drafts, recovery panel placement outside `#app`, metadata edit flows, root checks, phased loading, EasyMDE lifecycle.
- Fixed in passing: EasyMDE's toolbar "preview" button inherited the preview pane's 340px min-height (`.preview`), which made the toolbar very tall.

## Evidence

All runs on Ghost with Node 22, Python 3.14, Playwright 1.60, Chrome headless, `TMPDIR=/home/ryushe/.hermes/cache/scratch/bb-agents/ui`, synthetic fixtures only.

- `npm test` (14 original files + `ui-redesign.synthetic.test.cjs` added to the script later): 115 tests, 115 pass, 0 fail (run before the new file was added to the script).
- `static/tests/ui-redesign.synthetic.test.cjs`: 7 tests, 7 pass.
- `python3 -W error::ResourceWarning tests/safe_suite.py`: 180 tests, OK (1 skipped), 419 s.
- Broad browser suite, once at the end (30 files: every `static/tests/*.test.cjs` except `collaboration.synthetic` and `collaboration-combined.synthetic`, with the synthetic-writer skip pattern): 199 tests, 197 pass, 2 fail:
  - `capacity-recovery-real`: "changed capacity preconditions can be reviewed without losing newer edits" timed out waiting for the first collaboration POST (8 s).
  - `review`: "conflict persistence does not overwrite newer draft from another tab" timed out clicking Refresh (2 s test timeout).
  - Both files then passed in isolation (8/8 and 17/17). The review file also passed 2/2 runs on both the base commit's static files and this branch. Both tests passed in the earlier full `npm test` run. Classified as load-sensitive timing (six agents share six CPUs), not regressions; worth a rerun at integration.
- After the last fix (chip focus): `ui-redesign` + `app.test` + `dashboard-coverage`: 51 tests, 51 pass.
- Contrast: every token pair checked (text tiers on surfaces and sidebar, accent text, text on accent, feedback colors on their soft fills, severity colors on their 13% tint) is at least 4.5:1 in all three themes (script-checked; lowest light 4.73, dark 5.00, dusk 4.83).

Screenshots (1440x900, fictional data from `tests/ui_showcase_fixture.py`, captured with `static/tests/tools/ui-screenshots.cjs`) are in `/home/ryushe/.hermes/cache/scratch/bb-agents/ui/screenshots/`:

- Before: `before-{dashboard,findings,reports}-{light,dark}.png`.
- After: `after-{dashboard,findings,reports}-{light,dark,dusk}.png`, plus `after-{drill,filters,row-menu,picker,theme-menu,dashboard-bottom,tablet,phone}-{light,dark,dusk}.png`.

Test changes kept their intent: theme selection goes through the menu (`setTheme` helper); filter selection goes through the multi-select popover (`pickFilter` helper) and "filters reset" is asserted through chips; availability regexes accept the new colon separator; the progressive test that required a manual Apply after navigation now asserts the invalidated check is repeated and applied automatically.

## Gaps and follow-ups

- Program/lane selects are native; a fully custom combobox for them was not built (the picker covers search).
- No date sort for findings (no date in the ledger projection). MapStore entries have timestamps; sorting there is a possible follow-up.
- Drag-and-drop logic for findings is the ledger agent's; only drop-target styling is provided.
- Tooltips are visual only (text is already in the accessible tree); touch devices rely on wrapping on narrow widths.
- Hash routes encode program ids; very long report paths make long URLs.
- Some older review tests use 2 s timeouts and can time out when the shared machine is under load; they pass when rerun.

## Decisions for Ryu

1. Should "Open workspace" require an explicit pick when nothing was chosen before (instead of opening the clearly labelled first program)?
2. Should the dashboard default to "Not submitted" instead of "All records"?
3. Is the treatment of unrecognized submission states (counted as submitted) right for the Board?
