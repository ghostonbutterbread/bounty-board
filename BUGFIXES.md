# Observed unrelated issues

- `static/style.css` `.preview{min-height:340px;padding:14px;...}` (report preview panel) also matches EasyMDE's `button.preview` toolbar button, so the non-live report editor toolbar stretches to ~360 px tall. Seen while building the live editor (feat/live-report-editing), which overrides it locally in `static/modules/live-editor.css`. Fix: scope the panel rule (for example `#report-preview` or `div.preview`). Impact: layout only.
