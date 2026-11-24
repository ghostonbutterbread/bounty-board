/* Report artifacts panel (feat/board-report-artifacts).
 * Mounts into #report-artifacts-host (live and non-live report views). The
 * backend decides which files belong to the report and why; this module only
 * lists them, previews safe types and links downloads. All file-derived text
 * is inserted with textContent; nothing from an artifact is parsed as HTML. */
(() => {
  const TEXT_PREVIEW_BYTES = 64 * 1024;
  const KEEP_PANELS = 12;
  // Auto-refresh: while a panel is on screen and the tab is visible, re-list
  // quietly and redraw only when the files changed (added, removed, resized,
  // touched). New files are highlighted briefly.
  const REFRESH_MS = 4000;
  const NEW_HIGHLIGHT_MS = 6000;
  const GROUPS = [
    ['video', 'Videos', 'fa-file-video-o'], ['image', 'Images', 'fa-file-image-o'], ['audio', 'Audio', 'fa-file-audio-o'],
    ['code', 'Code', 'fa-file-code-o'], ['data', 'Text and data', 'fa-file-text-o'], ['document', 'Documents', 'fa-file-pdf-o'],
    ['capture', 'Traffic captures', 'fa-exchange'], ['archive', 'Archives', 'fa-file-archive-o'], ['other', 'Other files', 'fa-file-o'],
  ];
  const NOTES = {
    folder_shared: 'This folder is shared with other findings, so only files linked to this report are shown.',
    folder_not_dedicated: 'This report is not in its own folder, so only files linked to this report are shown.',
    flat_reports_root: 'This report sits in the reports root, so only files linked to this report are shown.',
    truncated: 'The list is truncated; some files are not shown.',
  };
  const REASONS = {report_folder: 'Report folder', finding_field: 'Finding field', report_link: 'Linked from report'};
  const panels = new Map();
  let previewCounter = 0;

  const el = (tag, props = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : value);
    }
    node.append(...children.filter(c => c != null));
    return node;
  };
  const icon = name => el('i', {class: `fa ${name}`, 'aria-hidden': 'true'});
  const size = bytes => {
    if (!Number.isFinite(bytes)) return 'Unknown size';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes, unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    return `${unit ? value.toFixed(value < 10 ? 1 : 0) : value} ${units[unit]}`;
  };
  const when = seconds => Number.isFinite(seconds) ? new Date(seconds * 1000).toLocaleString() : 'Unknown time';
  const query = (selector, extra = {}) => new URLSearchParams({...selector, ...extra}).toString();

  function selectorFor(host) {
    const {family, program, lane, path} = host.dataset;
    return family && program && lane && path ? {family, program, lane, path} : null;
  }

  function mount(host) {
    const selector = selectorFor(host);
    if (!selector) { host.replaceChildren(); return; }
    const key = JSON.stringify(selector);
    let panel = panels.get(key);
    if (!panel) {
      panel = {key, selector, node: el('section', {class: 'artifacts', 'aria-label': 'Report artifacts', 'data-artifacts-key': key}), open: new Set(), fresh: new Map()};
      panels.set(key, panel);
      while (panels.size > KEEP_PANELS) panels.delete(panels.keys().next().value);
      load(panel);
    } else { panels.delete(key); panels.set(key, panel); }
    if (host.firstChild !== panel.node) host.replaceChildren(panel.node);
    schedule();
  }

  // A listing's identity: which files, and their size and modified time.
  const signature = body => JSON.stringify([body.folder || '', (body.notes || []).slice().sort(),
    body.artifacts.map(a => [a.relative, a.size, a.modified, !!a.sensitive]).sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))]);

  async function load(panel, {quiet = false} = {}) {
    const generation = (panel.generation || 0) + 1;
    panel.generation = generation;
    if (!quiet) { panel.status = 'loading'; draw(panel); }
    try {
      const response = await fetch(`/api/report-artifacts?${query(panel.selector)}`, {headers: {Accept: 'application/json'}, cache: 'no-store'});
      const body = await response.json().catch(() => null);
      if (!response.ok || !body || !Array.isArray(body.artifacts)) throw new Error(String(response.status));
      if (panel.generation !== generation) return;
      const next = signature(body);
      if (quiet && panel.status === 'ready' && next === panel.signature) return;  // nothing changed
      if (panel.status === 'ready' && panel.data) {
        const before = new Set(panel.data.artifacts.map(a => a.relative));
        const now = Date.now();
        for (const a of body.artifacts) if (!before.has(a.relative)) panel.fresh.set(a.relative, now);
        // Redrawing also reloads open previews, so a changed file shows its new content.
      }
      panel.data = body;
      panel.signature = next;
      panel.status = 'ready';
    } catch {
      if (panel.generation !== generation) return;
      if (quiet && panel.status === 'ready') return;  // keep the last good list through a blip
      panel.status = 'error';
    }
    draw(panel);
  }

  function visiblePanels() {
    return [...panels.values()].filter(panel => panel.node.isConnected);
  }
  function refreshVisible() {
    if (document.visibilityState !== 'visible') return;
    for (const panel of visiblePanels()) if (panel.status !== 'loading') load(panel, {quiet: true});
  }
  let timer = null;
  function schedule() {
    if (timer) return;
    timer = setInterval(() => {
      if (!visiblePanels().length) { clearInterval(timer); timer = null; return; }
      refreshVisible();
    }, REFRESH_MS);
  }
  document.addEventListener('visibilitychange', refreshVisible);
  window.addEventListener('focus', refreshVisible);

  function draw(panel) {
    const {node, data, selector} = panel;
    const items = panel.status === 'ready' ? data.artifacts : [];
    const zippable = items.filter(a => !a.sensitive);
    const zipBytes = zippable.reduce((sum, a) => sum + (a.size || 0), 0);
    const tooBig = data && zipBytes > data.max_zip_bytes;
    const head = el('div', {class: 'artifacts-head'},
      el('h3', {id: 'artifacts-title'}, icon('fa-paperclip'), ` Artifacts${panel.status === 'ready' ? ` (${items.length})` : ''}`),
      el('div', {class: 'artifacts-actions'},
        el('button', {type: 'button', class: 'button subtle', 'data-artifacts-refresh': true, 'aria-label': 'Reload artifact list', onclick: () => load(panel)}, icon('fa-refresh'), ' Reload list'),
        zippable.length && !tooBig
          ? el('a', {class: 'button', href: `/api/report-artifacts.zip?${query(selector)}`, download: '', 'data-artifacts-zip': true}, icon('fa-download'), ' Download all')
          : null));
    const body = [];
    if (panel.status === 'loading') body.push(el('div', {class: 'state', text: 'Loading artifacts…'}));
    else if (panel.status === 'error') body.push(el('div', {class: 'message warning', role: 'status', text: 'The artifact list failed to load for this report. Reload the list to retry.'}));
    else {
      body.push(el('p', {class: 'hint', text: data.folder
        ? `Files in the report folder ${data.folder}, plus files linked from the report or its finding.`
        : 'Files linked from the report or its finding.'}));
      for (const note of data.notes || []) if (NOTES[note]) body.push(el('p', {class: 'hint', text: NOTES[note]}));
      if (zippable.length < items.length) body.push(el('p', {class: 'hint', text: 'Download all leaves out files marked sensitive. Download them one at a time.'}));
      if (tooBig) body.push(el('p', {class: 'hint', text: `Too large to download as one zip (over ${size(data.max_zip_bytes)}). Download files one at a time.`}));
      if (!items.length) body.push(el('div', {class: 'state', text: 'No artifacts found for this report.'}));
      for (const [category, label, glyph] of GROUPS) {
        const group = items.filter(a => (GROUPS.some(g => g[0] === a.category) ? a.category : 'other') === category);
        if (!group.length) continue;
        body.push(el('div', {class: 'artifact-group', 'data-category': category},
          el('h4', {text: `${label} (${group.length})`}),
          el('ul', {class: 'artifact-list'}, ...group.map(item => row(panel, item, glyph)))));
      }
    }
    node.setAttribute('aria-busy', panel.status === 'loading' ? 'true' : 'false');
    node.replaceChildren(head, ...body);
  }

  function row(panel, item, glyph) {
    const params = query(panel.selector, {artifact: item.relative});
    panel.ids ||= new Map();
    if (!panel.ids.has(item.relative)) panel.ids.set(item.relative, `artifact-preview-${++previewCounter}`);
    const previewId = panel.ids.get(item.relative);
    const open = panel.open.has(item.relative);
    const folder = panel.data?.folder;
    const outside = folder && !item.relative.startsWith(folder + '/');
    const reasons = (item.reasons || [{reason: item.source_reason, detail: ''}])
      .map(r => `${REASONS[r.reason] || r.reason}${r.detail ? `: ${r.detail}` : ''}`).join('; ');
    const preview = el('div', {class: 'artifact-preview', id: previewId, hidden: !open});
    const freshAt = panel.fresh.get(item.relative);
    const fresh = freshAt && Date.now() - freshAt < NEW_HIGHLIGHT_MS;
    if (freshAt && !fresh) panel.fresh.delete(item.relative);
    const toggle = item.preview ? el('button', {type: 'button', class: 'button subtle', 'aria-expanded': String(open), 'aria-controls': previewId,
      'data-artifact-preview': item.relative,
      onclick: () => {
        const next = !panel.open.has(item.relative);
        if (next) panel.open.add(item.relative); else panel.open.delete(item.relative);
        toggle.setAttribute('aria-expanded', String(next));
        toggle.lastChild.textContent = next ? ' Hide preview' : ' Preview';
        preview.hidden = !next;
        if (next && !preview.firstChild) fillPreview(preview, item, params);
        if (!next) preview.querySelectorAll('video,audio').forEach(media => media.pause());
      }}, icon('fa-eye'), document.createTextNode(open ? ' Hide preview' : ' Preview')) : null;
    if (open) fillPreview(preview, item, params);
    if (fresh) setTimeout(() => { panel.fresh.delete(item.relative); panel.node.querySelector(`[data-artifact="${CSS.escape(item.relative)}"]`)?.classList.remove('artifact-new'); }, NEW_HIGHLIGHT_MS - (Date.now() - freshAt));
    return el('li', {class: `artifact-row${fresh ? ' artifact-new' : ''}`, 'data-artifact': item.relative},
      el('div', {class: 'artifact-main'},
        el('span', {class: 'artifact-icon'}, icon(glyph)),
        el('div', {class: 'artifact-text'},
          el('div', {class: 'artifact-name'}, el('span', {text: item.display_path || item.name, title: item.relative}),
            fresh ? el('span', {class: 'artifact-badge artifact-new-badge', text: 'New'}) : null,
            item.sensitive ? el('span', {class: 'artifact-badge', title: 'May contain credentials or raw traffic. Not previewed.'}, icon('fa-exclamation-triangle'), ' Sensitive') : null),
          el('div', {class: 'artifact-meta hint', text: `${size(item.size)} | Modified ${when(item.modified)}${outside ? ' | Outside the report folder' : ''}`}),
          el('div', {class: 'artifact-reason hint', text: reasons})),
        el('div', {class: 'artifact-buttons'}, toggle,
          el('a', {class: 'button', href: `/api/report-artifact?${params}`, download: item.name, 'data-artifact-download': item.relative,
            'aria-label': `Download ${item.name}`}, icon('fa-download'), ' Download'))),
      preview);
  }

  async function fillPreview(box, item, params) {
    const media = `/api/report-artifact-media?${params}`;
    if (item.preview === 'image') box.replaceChildren(el('img', {src: media, alt: `Preview of ${item.name}`, loading: 'lazy'}));
    else if (item.preview === 'video') box.replaceChildren(el('video', {src: media, controls: true, preload: 'metadata'}));
    else if (item.preview === 'audio') box.replaceChildren(el('audio', {src: media, controls: true, preload: 'metadata'}));
    else if (item.preview === 'text') {
      box.replaceChildren(el('div', {class: 'state', text: 'Loading preview…'}));
      try {
        const response = await fetch(`/api/report-artifact?${params}`, {headers: {Range: `bytes=0-${TEXT_PREVIEW_BYTES - 1}`}});
        if (!response.ok) throw new Error(String(response.status));
        const text = new TextDecoder('utf-8', {fatal: false}).decode(await response.arrayBuffer());
        const pre = el('pre', {class: 'artifact-text-preview'});
        pre.textContent = text;
        box.replaceChildren(pre);
        if (item.size > TEXT_PREVIEW_BYTES) box.append(el('p', {class: 'hint', text: `Showing the first ${size(TEXT_PREVIEW_BYTES)} of ${size(item.size)}. Download to see the whole file.`}));
      } catch {
        box.replaceChildren(el('div', {class: 'message warning', text: 'Preview failed to load. Download the file instead.'}));
      }
    }
  }

  const register = () => window.registerBoardModule({
    name: 'report-artifacts',
    afterRender() { const host = document.getElementById('report-artifacts-host'); if (host) mount(host); },
  });
  if (window.registerBoardModule) register();
  else window.addEventListener('DOMContentLoaded', register, {once: true});
})();
