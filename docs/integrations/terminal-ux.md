# Terminal UX: copy and paste, toggle shortcut, docking, Settings

- Branch: `feat/board-terminal-ux`; base `18089f4` (origin/beta).
- Owner surfaces: `static/modules/sandbox-terminal.js|css` (drawer), new `static/modules/settings.js|css` (Settings page and registry), the `#/settings` route in `static/app.js`, `static/index.html` tags, `static/tests/sandbox-terminal*.cjs`.
- Ryu's request, short: copying is annoying (Ctrl+Shift+C opens the inspector in Firefox on Windows), so copy on highlight; a Settings area, for the terminal first; a hotkey (Ctrl+E) to open and close the terminal; dock it right, left, top or bottom.
- The design, security rules and threat model of the terminal itself stay in `docs/integrations/sandbox-terminal.md`. Nothing here changes the service, the sandbox or the typing filter.

## What changed for the user

- **Copy on select** (on by default). Finishing a mouse selection in the terminal (drag, double click for a word, triple click for a line) copies it with `navigator.clipboard.writeText` inside that click's user activation. If the API is missing or refuses, a hidden-textarea `execCommand('copy')` is tried. A small "Copied" flash appears next to the status pill for 1.6 s ("Copy blocked by the browser" if both fail). Empty selections are never copied.
- **Ctrl+C**: with a selection it copies, clears the selection and sends nothing to the shell; without one it sends ^C as before. Ctrl+Shift+C copies (and never sends ^C). Ctrl+Insert copies.
- **Ctrl+V / Ctrl+Shift+V / Shift+Insert paste.** The xterm key handler returns false for them, so the browser fires its native `paste` event and xterm handles it (bracketed paste when the shell has it on).
- **Paste guard.** Routes covered, all by capture-phase listeners on the screen container that run before xterm's own listeners: (1) `paste` events, which is how Ctrl+V, Ctrl+Shift+V, Shift+Insert, the context menu Paste and the Linux middle click arrive; (2) `beforeinput` and `input` events with `inputType` `insertText`, `insertFromPaste`, `insertReplacementText` or `insertFromDrop` (phone keyboards' clipboard chips, IME commits, drops), where a multi-character insertion is cancelled if it fails the filter or contains a newline (review round 1, F2; single characters and `insertCompositionText` pass as typing); (3) composition commits (`compositionend`) and keyCode 229 textarea diffs, where the textarea is emptied before xterm reads it if the text is unsafe or multi-line (review round 2, G1); (4) the play and Run buttons, which call the filter before `term.paste`. Routes not covered: keys typed one at a time, which is ordinary typing. It runs the existing filter (`unsafeText`, the `UNSAFE_MESSAGE` area) on the clipboard text; unsafe text is cancelled (`preventDefault` + `stopImmediatePropagation`) and the note line says "Paste refused: the clipboard text contains control characters." Nothing is stripped. The only adaptation: CRLF counts as a newline (`unsafePaste` maps CRLF to LF before calling `unsafeText`), because Windows clipboards end lines with CRLF and xterm turns CRLF and LF into the same Enter anyway. A lone CR is still refused.
- The preview `copy` handler is unchanged: controls never end up in copied report text.
- **Toggle shortcut**: Ctrl+E (configurable) and the fixed Ctrl+` toggle the drawer for the current report from anywhere in the Board, including inside the terminal and the report editor. Opening focuses the terminal; closing returns focus to the element focused before opening (if it still exists), else the editor. With no terminal for the report (dashboard, Settings, a disabled Terminal button) nothing happens. Whenever the Board has a terminal the keys are kept from the browser (`preventDefault`), so Firefox does not focus its search bar. When the primary shortcut is not Ctrl+E, Ctrl+E reaches the shell again (bash end of line; tested).
- Every tooltip names the current shortcut: "Sandbox terminal (Ctrl+E)" on the Terminal button, "Close terminal (Ctrl+E)" on the close button.
- **Docking**: bottom (default, as before), top, left, right, plus maximize (fills the content column; the sidebar stays) that restores the previous dock. Side docks are full-height columns beside the content; top and bottom are full-width rows of the content column. Phones (700 px and below) always get the bottom sheet and the picker hides.
- **Dock picker** in the drawer header: four dock icons and a maximize/restore icon, each a button with a tooltip, keyboard reachable, `aria-pressed` on the current one. It changes the current dock of this tab (see Drag to dock).
- **Resize** on the inner edge (drag or arrow keys; the key pointing away from the docked edge grows it). Height (top/bottom) and width (left/right) are remembered separately. Clamp: at least 160 px; top and bottom leave about 320 px of window height (phones keep the tall sheet, 96 px free as before); side docks leave at least 560 px of content. When the window cannot fit 560 px of content beside a 320 px drawer (for example 1024 px wide with the sidebar open) a side dock falls back to the bottom dock, and the left and right picker buttons say "(needs a wider window; using the bottom dock)"; the stored choice comes back on a wider window. The side width defaults to min(520 px, 40% of the content column) until the user resizes it. The drag follows the pointer from where the handle was grabbed, so grabbing it never jumps.
- **Settings page** at `#/settings`, from a "Settings" sidebar link (gear icon, real `<a href="#/settings">`, above the sidebar footer; on phones it shows in the top bar). Tab title "Settings · Bounty Board". The Terminal card ("Saved in this browser.") has: Copy on select, Ctrl+C copies a selection, Ctrl+V pastes (switches), Toggle shortcut (press-a-key recorder plus "Reset to Ctrl+E"), Default dock position (Bottom/Top/Left/Right; "Where the terminal opens. Drag the terminal by its header to move it."). Without `capabilities.terminal_url` the card shows only "The sandbox terminal is not enabled on this Board." Switch and shortcut changes apply live to an open drawer in other tabs (`storage` event) and to the drawer in the same tab the next time it shows (the drawer is hidden while Settings is open). The default dock never moves an open drawer in another tab; see Drag to dock.

## Design

### Preferences (`localStorage` `bounty-board-terminal:v1`)

```json
{"open": false, "height": 320, "width": null, "dock": "bottom",
 "copyOnSelect": true, "ctrlCCopy": true, "ctrlVPaste": true,
 "shortcut": {"ctrl": true, "alt": false, "shift": false, "code": "KeyE"}}
```

- `open` and `height` keep their meaning, so old values load unchanged. Every field is validated on read; a corrupt or unknown value falls back to its default (tested with `{"dock":"diagonal","height":"tall","shortcut":{"ctrl":true,"code":"KeyT"},"copyOnSelect":"yes"}`). Unknown fields written by a newer Board are preserved on save.
- `dock` is the **default** position. The **current** position of a tab is `sessionStorage` `bounty-board-terminal-dock:v1` = `{"dock": "right", "maximized": false}`, written by dragging the header, the dock picker and the maximize button; a reload keeps it, a new tab starts at the default. Until a tab moves its drawer it follows the default. (A `maximized` field left in `localStorage` by the earlier build is ignored.)
- Another tab's change (`storage` event) applies everything except `open` (closing the drawer in one tab does not close it in another). When the default dock changes while this tab's drawer is open and still follows the default, the tab first pins its current position, so the open drawer does not move.
- Stored sizes are the user's wish; the clamp is applied when laying out, so a temporarily small window does not shrink the saved size.

### Shortcut rules

- Ctrl or Alt (not both: Ctrl+Alt is AltGr on many keyboards), optionally Shift, plus one key: a letter, a digit, or `; ' , . /`. Letters match by the typed letter (keyboard layouts), other keys by position (`event.code`).
- Refused with a short reason: Ctrl+T/W/N/Q/L/R, Ctrl+Tab, Ctrl+Shift+C, plain Ctrl+C/V/D/Z, Ctrl+H/I/J/M (the terminal reads them as Backspace, Tab, Enter), Ctrl+0..9 and Alt+1..9 (tabs, zoom), Ctrl+Shift+T/N/P/W/Q/V, Ctrl+Shift+I/J/K/E/M (developer tools), Ctrl+K (the Board's own search shortcut), Ctrl+` (already the fixed one), Ctrl+[ (Esc), Ctrl+\ (quit), Ctrl+-/= (zoom), Meta combinations, keys without Ctrl or Alt.
- The recorder: click it, press the combination; Esc cancels, Tab leaves. A refused combination keeps recording and says why ("Ctrl+T is not available. Browsers open a new tab with it.").
- The global listener is on `window` in the capture phase with `stopPropagation`, so neither CodeMirror nor xterm sees the toggle keys; xterm's custom key handler also returns false for them.

### Docking

- The drawer stays `position: fixed`. `layout()` sets `html.term-dock-<side>` (or `html.term-max`), `--term-space-<side>` (the drawer size on the docked side, `0px` elsewhere) and `--term-drawer-space` (kept for compatibility), and positions the drawer from the sidebar's right edge.
- Reserved space: bottom pads `.page` (as before); top pads `.app > .body` and moves the sticky topbar down; left and right give `.app > .body` a margin, so the whole content column (topbar included) narrows. Maximize reserves nothing (it covers the content on purpose). Sticky `.report-side` and toasts move clear of the drawer.
- EasyMDE full screen and side by side (`position: fixed` over the window): the toolbar, editor and preview are offset by `--term-space-*` and the two halves split the remaining width, for every dock (tested: no overlap with the drawer or each other).
- After every dock change and resize xterm is refit, which sends the new size to the server (tested with `stty size`).

### Settings registry (`window.BoardSettings`)

```js
window.BoardSettings.register({
  id: 'ports',             // unique; registering the same id again replaces it
  group: 'terminal',       // 'terminal' renders inside the Terminal card, after the built-in controls
  title: 'Ports',          // shown as a sub-heading when it differs from the group title
  order: 50,               // sort order inside the group (built-in terminal controls use 0)
  render(host) {           // host: an empty element; may return a cleanup function
    host.innerHTML = '...';
    return () => {};
  },
});                        // returns an unregister function
```

- Known groups render in their order (`terminal` only, today; it is shown only when the Board has `capabilities.terminal_url`). Any other group gets its own card after them, titled by its first section's title.
- Registering while the page is open re-renders it; cleanups run before every re-render and when the page is left.
- Load order: `settings.js` loads before modules that register (it is listed before `sandbox-terminal.js` in `index.html`). Setting rows can reuse `.set-row`, `.set-text`, `.set-label`, `.set-controls` and `.set-switch` (a checkbox with `role="switch"`) from `settings.css`.

### Drawer slot and events (`window.BoardTerminal`)

```js
const el = window.BoardTerminal.slot('ports');   // stable [data-term-slot="ports"] in the header
const stop = window.BoardTerminal.on('session', ({selector, session}) => {});
window.BoardTerminal.on('message', message => { if (message.type === 'ports') {} });
window.BoardTerminal.off('session', handler);
window.BoardTerminal.selector();                  // {family, program, lane, path} or null
window.BoardTerminal.session();                   // the hello `session` object while the drawer is open, else null
```

- `slot(name)` (`[a-z][a-z0-9-]*`, up to 32 chars) returns the same element every time, created on first use and placed between the status text and the dock picker; it is hidden while empty (`:empty`).
- `session` fires `{selector, session}` on hello (attach) and on a sandbox reset, and `{selector: null, session: null}` once when the drawer closes or the report changes.
- `message` fires with every parsed server text message object (after the drawer's own handling), so a later module can handle new types such as `{"type": "ports", ...}` without editing this file.
- `on` returns an unsubscribe function; a throwing listener is logged and does not affect others.
- The other `BoardTerminal` members (`term`, `status`, `checks`, `prefs`, `unsafeText`, `unsafePaste`, `shortcutProblem`, ...) are for tests and diagnostics only.
- Drawer tabs (`registerTab`, `openTab`, `updateTab`, `removeTab`), code-block actions (`registerBlockAction`, `refreshBlocks`) and `mount()` / the `mount` event were added for the report agent UI; see [`report-agent-ui.md`](report-agent-ui.md#seams-added-to-sandbox-terminaljs).

### Drag to dock

- Press on the drawer header (its empty area, the title and status text, or the grip at the left; never on buttons, the dock picker, the slots, links or the terminal screen) and move at least 6 px: pointer events with pointer capture (mouse, pen, touch). `pointerdown` is cancelled, so focus stays in the terminal and nothing is selected; the root gets `term-dragging` (`user-select: none`, `grabbing` cursor), so copy on select cannot fire. The header shows a `grab` cursor.
- While dragging, a dashed translucent rectangle (`[data-term-drop-preview]`) shows exactly where the drawer will land (the size it will have there, from the per-orientation memory), and a 4 px accent bar (`[data-term-drop-edge]`) highlights the target edge. The target is the nearest edge of the content area (sidebar excluded) when the pointer is within 30% of the content width or height from it; the middle is a dead zone that keeps the current dock (the preview shows the current place, no edge). Side edges are not offered when a side dock does not fit (round 1 rule). Maximize stays a button.
- Releasing on an edge docks the drawer there (current dock of this tab, maximize left); releasing in the dead zone keeps it; releasing outside the content area or Esc cancels. After a drop xterm is refit and the new size goes to the server; focus stays in the terminal; height and width memory are unchanged.
- Phones (700 px and below): no grip, no drag, the bottom sheet as before. Keyboard and screen-reader users have the dock picker; the grip is `role="img"` with the label "Drag to move the terminal".

### Header

- Two rows in the DOM: [grip, title, status pill, Copied flash, slots, dock picker] and [session text (age, viewers, folder, steps), Reset, Save output as evidence, Close].
- Bottom, top and maximize flatten both rows into one line (`display: contents` plus `order`), as before. Left and right docks keep two lines down to 360 px: the title text hides (the icon stays), the session text is one muted ellipsized line with the full text in its tooltip, and Reset and Save are icon-only with tooltips (their labels stay for screen readers; an armed reset shows "Confirm reset"). Phones wrap with full-width labelled buttons as before.

## Decisions

- Default vs current dock (changed in the drag follow-up, replacing "one stored value"): Settings "Default dock position" is where the terminal opens in a new tab; dragging, the dock picker and maximize change only the current tab (`sessionStorage`). A new default moves a tab's drawer only if that tab has not moved it and the drawer is not open in another tab. There is no separate "reset position" action: a new tab, or closing the browser tab, starts at the default again.
- Drag zones: nearest edge within 30% of the content size, dead zone in the middle; the preview animates between targets but appears in place.
- A refused input-event insertion that is safe but contains a newline says "Multi-line text must be pasted with Ctrl+V."; control characters keep "Paste refused: the clipboard text contains control characters."
- Shortcut keys are kept from the browser whenever the Board has a terminal, even on pages without one (Ctrl+E "does nothing" there rather than opening Firefox's search bar). Plain browser behavior returns when the Board has no terminal configured.
- Ctrl+Shift+V and Shift+Insert always paste; the "Ctrl+V pastes" switch only governs Ctrl+V (off: ^V reaches the shell, for `quoted-insert`).
- Ctrl+Shift+C never sends ^C, even without a selection. Ctrl+Insert keeps the selection; Ctrl+C clears it (as specified).
- CRLF is read as a newline by the paste guard (see above). It is still the one filter function.
- Ctrl+K is refused as a shortcut because the Board's global search owns it (found by the browser test).
- Toasts move clear of a drawer docked bottom or right (previously the "Resumed" toast sat on the terminal).
- `docs/integrations/sandbox-terminal.md` is not edited here (the ports branch owns backend docs and edits it); its Drawer bullet still says "Ctrl+`" and "bottom drawer". Fold this dossier's summary in at integration.

### Topbar in a narrow content column (review round 1, F1)

- `.app > .body` is a size container (`board-body`, in `search.css`). The search field is sized from the column (`clamp(160px, calc(100cqi - 560px), 340px)`), not the window.
- Below 720 px of content width the field collapses to its search icon (a click or Ctrl+K still opens search), the "Ctrl K" chip hides, the topbar padding tightens and Refresh shows only its icon (its label stays for screen readers). Phones get the same collapsed field.
- The program tabs fade at the right edge while more are hidden (scroll-driven animation; Chromium has it, other browsers just scroll as before).

## Review round 1

The reviewer of `f2b969e` returned ACCEPT with two should-fixes. Red/green: the changed source files (`sandbox-terminal.js`, `sandbox-terminal.css`, `search.css`) were swapped back to `f2b969e`, the new tests run, then restored.

| Finding | Fix | Regression test | f2b969e → now |
|---|---|---|---|
| F1 layout: side docks squeezed the content column to 320 px; the "Ctrl K" chip wrapped over Refresh, the breadcrumb and tabs were cut | Container queries on the content column (search sized from the column, collapses to an icon below 720 px, chip hidden, Refresh icon-only); side docks keep 560 px of content, fall back to bottom when the window is too narrow (tooltip says so); default side width min(520, 40%); tab edge fade | `side docks keep the topbar intact at 1024, 1280 and 1440 wide (review F1)`: left and right docks, default and maximum drag width; chip one line and clear of Refresh, last breadcrumb item visible, no topbar control overlaps another, 1024 falls back to bottom | red (problems at 1024 and 1280 for both docks and both sizes, e.g. "1024 right default: chip wraps (35px)", "1280 right max: content column 320px") → green |
| F2 security: text arriving as `input`/`insertText` (phone keyboards) reached the shell without the paste guard | Capture-phase `beforeinput` and `input` guard on the screen for `insertText`, `insertFromPaste`, `insertReplacementText`, `insertFromDrop`: multi-character text that fails the filter or contains a newline is cancelled, the note says "Paste refused..." | `typing filter: multi-character input-event insertions are refused unless safe and single-line (review F2)`: ESC[201~, bidi isolate, newline, lone CR, drop via DataTransfer all cancelled, nothing reaches xterm, no marker file; a single character and a composed safe string (`keyboard.insertText`) still reach the shell | red → green |
| Test gap: session events across report switches | Contract test (no source change needed) | `BoardTerminal session events across report switches: D1, D10, then a report without a packet`: exact sequence session D1, hello, null, session D10, hello, null; no session for `active.md`; `session()` null at the end, `selector()` follows the report | green on both (contract) |

Round 1 runs (Ghost, serially, after commit `7ac9992`):

- `static/tests/sandbox-terminal-filter.test.cjs`: 5 pass, 0 fail.
- `static/tests/sandbox-terminal.synthetic.test.cjs` (alone): 15 pass, 0 fail (12 earlier tests plus the 3 above).
- Reviewer repros `review_builder.test.cjs` (`REPO=$PWD`): 5 pass, 0 fail (layout matrix, typing filter, ctrl+c, session events, prefs).
- `static/tests/ui-redesign.synthetic.test.cjs`: 7 pass, 0 fail. `static/tests/search.synthetic.test.cjs`: 5 pass, 0 fail (both cover the topbar and search field changed here).

## Review round 2

The narrow re-review of `f2b969e..b1087ec` returned ACCEPT: F1 and F2 fixed, drag to dock correct (no start from controls or the screen, Esc and pointercancel end it, no listener leak over 30 drags, no selection or clipboard write, per-tab dock semantics, corrupt `sessionStorage` safe, `slot('ports')` stable in every dock). Two new items, fixed by the orchestrator. Red/green: `sandbox-terminal.js` swapped back to `b1087ec`, the tests run, then restored.

| Finding | Fix | Regression test | b1087ec → now |
|---|---|---|---|
| G1 security (should-fix): text committed through composition reached the shell unfiltered; xterm reads the textarea itself on `compositionend` (and after keyCode 229 keydowns) and sends it without bracketed paste | Capture-phase `compositionend` and `input` listener on the screen empties the textarea before xterm reads it whenever the event data or the textarea value is unsafe or multi-line, and shows the matching note; xterm still sees the event, so its composition state resets | `typing filter: composition commits and keyCode 229 textarea reads cannot deliver unsafe or multi-line text (review G1)`: ESC[201~ and newline payloads by composition, bidi and newline payloads by the 229 route, nothing reaches xterm, no marker file, the right note each time; a safe composition commit still types | red (`composition "echo hi\u001b[201~..." delivered text`) → green |
| G2 minor: a window blur did not end a drag (Alt+Tab without pointercancel left `term-dragging` and the preview) | `window` `blur` calls `endDrag` | `drag to dock: the header docks ...`: blur mid-drag hides the preview, removes `term-dragging`, later moves do not drag, release keeps the dock | red (`blur hides the preview`) → green |

With these routes the paste guard covers: `paste` events, `beforeinput`/`input` insertions (`insertText`, `insertFromPaste`, `insertReplacementText`, `insertFromDrop`), composition commits, keyCode 229 textarea diffs, and the play/Run buttons. A refused composition or 229 insertion after earlier unsent textarea content can make xterm send one DEL (it diffs the shortened textarea); that only happens on a refusal.

Round 2 runs (Ghost, load 12 to 14): both tests above 2 pass on the fix and 2 fail on `b1087ec`; the reviewer's `review2.test.cjs` "R2 typing filter" and "R2 drag" 2 pass.

## Evidence

Run on Ghost (shared box, load 10 to 15), `NODE_PATH=$PWD/node_modules CHROME_BIN=/opt/google/chrome/chrome`, serially:

- `node --test static/tests/sandbox-terminal-filter.test.cjs`: 5 pass, 0 fail (3 existing; new: paste filter incl. CRLF/lone CR, shortcut rules).
- `node --test --test-concurrency=1 static/tests/sandbox-terminal.synthetic.test.cjs`: 12 pass, 0 fail (8 existing tests unchanged, 4 new):
  - `clipboard: ...`: double click copies the word (clipboard read back), a drag copies, the Copied flash shows; turning Copy on select off in a Settings tab applies live and the clipboard keeps its sentinel; Ctrl+C with a selection copies, clears it and `sleep 3; echo SURVIVED-$((1+1))` still prints `SURVIVED-2`; Ctrl+C without a selection interrupts `sleep 30; echo NOT-INTERRUPTED`; Ctrl+V pastes and runs `pasted-25`; clipboards with `ESC[201~`, a bidi isolate (RLI/PDI) and a lone CR are refused with the message, xterm's `onData` saw nothing and no marker file exists; synthetic paste events (the context menu and middle-click route) are refused for RLO text and a CRLF paste types one bracketed line.
  - `toggle shortcut: ...`: Ctrl+E from the editor opens and focuses the terminal; Ctrl+E inside the terminal closes it and focus is back in the editor, the report text unchanged; Ctrl+` both ways; the close button returns focus to the Terminal button; the dashboard ignores Ctrl+E; in a Settings tab Ctrl+T, Ctrl+Shift+C, Ctrl+D, Ctrl+Alt+K, Shift+K are refused with their reason; Alt+T is saved, applies live in the report tab (tooltips updated), Ctrl+E no longer toggles and reaches bash (`echo xyz`, Ctrl+A, Ctrl+E, `Q` prints `xyzQ`); Reset to Ctrl+E works. The `ports` slot is stable, sits between the steps text and the dock picker, hidden while empty; `session` fired with the folder and selector on attach and nulls on close; `message` saw `hello`.
  - `docks: ...`: for right, left, top, bottom the drawer box is on that edge of the content column, the report host and the topbar do not overlap it (bottom checked scrolled to the end); in EasyMDE full-screen side by side the toolbar, editor and preview do not overlap the drawer or each other for every dock; width drag (+100 px) and arrow keys (+32 px) on a side dock and height arrows on bottom are stored separately and restored after reload (dock too); `stty size` in the shell equals xterm's rows and cols after a dock change; maximize fills the content column with the sidebar visible and the handle hidden, Restore goes back to top with its height; a 390 px phone with `dock: right, maximized: true` stored gets the bottom sheet (x 0, width 390, 60% height) and no picker.
  - `settings page: ...`: the sidebar link is an `<a href="#/settings">` with `aria-current`, middle click opens a new tab on `#/settings`, tab title and breadcrumb; switches default on; a registered fake `group: 'terminal'` section renders inside the Terminal card after the built-in controls with its "Ports" heading; another group gets its own card and the first section's cleanup ran on re-render; persistence across reload; live apply across two tabs both ways (Settings dock to drawer, drawer picker to Settings, Ctrl+V switch); corrupt stored values fall back to defaults; with `noterm` the card says "The sandbox terminal is not enabled on this Board."

- `npm test` (whole suite, run once in the background on the loaded box): 237 tests, 234 pass, 3 fail. Each failing test was rerun alone and passed: `non-live report view gets controls` (3 of 3 alone; under load bash redrew the line before the Enter landed), `ui-redesign: not-submitted filter, program search...` (the program picker focus check; file 7 of 7 alone; not touched by this branch), and my `docks` test (a race in its `stty size` check, read before the refit frame; fixed by waiting for the size to settle, then 12 of 12 for the file alone).

Screenshots (`TERMINAL_SCREENSHOT_DIR=$TMPDIR/screens`, here `/tmp/bbt-ux/screens/`, synthetic fixture data only, not committed): `drawer-right-copied-{light,dark}.png`, `dock-picker-{light,dark}.png`, `drawer-head-right-{light,dark}.png`, `settings-{light,dark}.png`, `phone-sheet-{light,dark}.png`, plus `dock-{right,left,top,bottom}-light.png` and `side-by-side-{right,left,top,bottom}-light.png`. Review round 1: `topbar-1280-{left,right}-{default,max}-{light,dark}.png` (full page) and `topbar-strip-1280-{left,right}-{default,max}-{light,dark}.png` (topbar close-up); `drawer-right-copied-*`, `dock-picker-*` and `drawer-head-right-*` refreshed with the new default side width. The reviewer's matrix screenshots are in `/tmp/bbt-ux/rev1/screens/`.

## Drag to dock follow-up: evidence

Red/green: `sandbox-terminal.js` and `sandbox-terminal.css` swapped back to `efeb330`, the new and changed tests run, then restored. All four failed on `efeb330` and pass on `205a442`:

| Test | efeb330 → now |
|---|---|
| `drag to dock: the header docks the drawer on each edge with a preview; clicks, buttons, Esc, the dead zone and outside drops do not move it` (each edge with the preview and edge bar visible mid-drag, drawer on that edge, content not covered, focus kept in the terminal, xterm refit; click and sub-6 px move do nothing; a drag from a header button does not start; Esc cancels; dead zone keeps; drop over the sidebar cancels; no terminal or page selection and the clipboard keeps its sentinel; side header at most two lines at the default width and at 360 px; reload keeps the current dock; a new tab opens at the default; a new default moves neither the dragged tab nor an open drawer in another tab, and a later new tab uses it) | red → green |
| `drag to dock: narrow windows offer no side zones; phones have no grip and no drag` (1024 px: no right zone, the dead zone keeps bottom, top still offered; 390 px phone: no grip, no preview, bottom sheet) | red → green |
| `settings page: ...` (changed: a new default does not move an open drawer in another tab, the drawer picker does not change the default) | red → green |
| `typing filter ... (review F2)` (changed: safe multi-line insertions say "Multi-line text must be pasted with Ctrl+V.") | red → green |

Runs after `205a442` (Ghost, serially): `sandbox-terminal-filter.test.cjs` 5 pass, 0 fail; `sandbox-terminal.synthetic.test.cjs` (alone) 17 pass, 0 fail; the reviewer's `review_builder.test.cjs` 5 pass, 0 fail.

Screenshots (`/tmp/bbt-ux/screens/`): `drag-preview-right-{light,dark}.png` (mid-drag, preview over the right edge), `drag-result-right-{light,dark}.png` (after the drop), `drawer-head-{left,right}-360-{light,dark}.png` and `dock-{left,right}-360-{light,dark}.png` (two-line side header at 360 px).

## Gaps

- Drag was tested with a mouse (Playwright); touch and pen use the same pointer-event path but were not driven in a test. Phones never drag.

- The F2 guard was tested with synthetic input events and Playwright's `insertText`; it was not checked on a real Android keyboard (neither was the original bypass).
- The tab edge fade needs scroll-driven animations (Chromium); Firefox shows plain scrolling tabs.
- Firefox is not in the test matrix (Chromium only). Firefox on Windows over HTTPS supports `navigator.clipboard.writeText` in a click handler; Ctrl+Shift+C may still open Firefox's inspector there (the browser takes it first), which is why copy on select and Ctrl+C exist.
- Copy on select copies after each finished mouse selection; there is no "copy on keyboard selection" (xterm has none).
- The `execCommand` fallback was not exercised in a browser without the Clipboard API.
- Settings has only the Terminal card today; app-wide settings (theme and so on) stay where they are.
- The drawer in the same tab shows Settings changes when it next opens (it is hidden while Settings is open); other tabs apply them immediately.
