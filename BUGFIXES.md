# Observed unrelated issues

- Fixed (feat/board-workspace-integrated): `static/style.css` report preview rule also matched EasyMDE's `button.preview` toolbar button, making the editor toolbar ~360 px tall. The rule is now `.preview:not(button)` and the local override in `static/modules/live-editor.css` was removed. A browser test asserts the toolbar height in both the live and non-live editors (`static/tests/integrated-workspace.synthetic.test.cjs`).
