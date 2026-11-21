# Vendored dependencies

`easymde.min.js` and `easymde.min.css` are the EasyMDE 2.21.0 npm distribution. EasyMDE's MIT notice is in `LICENSE`. Its prebuilt JavaScript contains CodeMirror, Marked, CodeMirror Spell Checker, and Typo.js, including code that is not used when spell checking is disabled. Their notices are in `licenses/`.

The EasyMDE 2.21.0 upstream release lockfile records CodeMirror 5.65.15, Marked 4.1.0, CodeMirror Spell Checker 1.1.2, and Typo.js 1.2.2. The first three notices are copied from those exact npm packages and match the installed packages' notices. Typo.js 1.2.2's npm package declares BSD-3-Clause but does not include its license file; `licenses/typo-js.txt` is the upstream project's license.txt. Versions installed separately by the current lockfile can differ from those embedded in the already-built EasyMDE distribution.

Font Awesome 4.7.0 fonts and CSS are distributed under OFL-1.1 and MIT respectively; see `../font-awesome/OFL-1.1.txt` and `../font-awesome/MIT.txt`. Its included README has additional documentation licensing details.
