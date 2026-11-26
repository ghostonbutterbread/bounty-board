/* Report artifacts panel (feat/board-report-artifacts).
 * Mounts into #report-artifacts-host (live and non-live report views). The
 * backend decides which files belong to the report and why; this module only
 * lists them, previews safe types and links downloads. All file-derived text
 * is inserted with textContent; nothing from an artifact is parsed as HTML.
 * Uploads (feat/board-artifact-uploads, opt-in --artifact-uploads): an Upload
 * files button, drag and drop and image paste send files one at a time into
 * the report's own folder; see docs/integrations/artifact-uploads.md. */
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
  // Uploads: one global queue, one file at a time. Each item keeps its own
  // panel and selector, so switching reports never cancels or misroutes it.
  const UPLOAD_DONE_MS = 4000;
  const uploadQueue = [];
  let uploadActive = null;
  let uploadCounter = 0;
  let uploadsSeen = false;

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
      setupUploads(panel);
      panels.set(key, panel);
      // Evict the oldest panels, but never one with a queued or running upload:
      // its rows (progress, Cancel, Retry) must still be there when the report
      // is opened again.
      for (const [oldKey, old] of panels) {
        if (panels.size <= KEEP_PANELS) break;
        if (oldKey === key) continue;  // never the panel being mounted
        if (!old.uploads?.some(u => u.state === 'queued' || u.state === 'uploading')) panels.delete(oldKey);
      }
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
      // Once any list shows uploads are on, keep guarding page-level file
      // drops even while a panel is loading or its list failed.
      if (body.upload && body.upload.reason !== 'disabled') uploadsSeen = true;
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
        uploadButton(panel),
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
      const upload = uploadState(panel);
      if (upload === 'enabled') body.push(el('p', {class: 'hint artifacts-upload-hint', text: 'Drop files on this panel or use Upload files to add them to the report folder.'}));
      else if (upload === 'no_folder') body.push(el('p', {class: 'hint artifacts-upload-hint', id: `${panel.uploadId}-why`, text: NO_FOLDER_TEXT}));
      if (zippable.length < items.length) body.push(el('p', {class: 'hint', text: 'Download all leaves out files marked sensitive. Download them one at a time.'}));
      if (tooBig) body.push(el('p', {class: 'hint', text: `Too large to download as one zip (over ${size(data.max_zip_bytes)}). Download files one at a time.`}));
      body.push(panel.dropHint, panel.uploadList);
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
    // The input and the upload rows are persistent nodes: re-rendering moves
    // them instead of recreating them, so progress survives Board renders.
    if (!body.includes(panel.uploadList)) body.push(panel.dropHint, panel.uploadList);
    node.replaceChildren(head, panel.uploadInput, ...body);
  }

  // ------------------------------------------------------------- uploads
  const NO_FOLDER_TEXT = 'Uploads need a report folder of its own, so files cannot be added here.';
  const uploadState = panel => {
    const upload = panel.status === 'ready' ? panel.data?.upload : null;
    if (!upload) return 'off';
    if (upload.enabled) return 'enabled';
    return upload.reason === 'no_report_folder' ? 'no_folder' : 'off';
  };

  function setupUploads(panel) {
    panel.uploadId = `artifacts-upload-${++uploadCounter}`;
    panel.uploads = [];
    panel.uploadInput = el('input', {type: 'file', multiple: true, hidden: true, tabindex: '-1', 'aria-hidden': 'true', 'data-artifacts-upload-input': true,
      onchange: () => { enqueue(panel, panel.uploadInput.files); panel.uploadInput.value = ''; }});
    panel.dropHint = el('div', {class: 'artifacts-drop-hint', hidden: true, 'aria-hidden': 'true'}, icon('fa-upload'), ' Drop to upload to the report folder');
    panel.uploadList = el('ul', {class: 'artifact-uploads', 'aria-label': 'Uploads', 'aria-live': 'polite'});
    const node = panel.node;
    // Focus inside the panel (for image paste): clicking blank panel space focuses it.
    node.tabIndex = -1;
    const hasFiles = event => [...(event.dataTransfer?.types || [])].includes('Files');
    let depth = 0;
    const setDropping = on => { node.classList.toggle('artifacts-dropping', on); panel.dropHint.hidden = !on; };
    node.addEventListener('dragenter', event => {
      if (!hasFiles(event) || uploadState(panel) !== 'enabled') return;
      event.preventDefault(); depth++; setDropping(true);
    });
    node.addEventListener('dragover', event => {
      if (!hasFiles(event) || uploadState(panel) !== 'enabled') return;
      event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDropping(true);
    });
    node.addEventListener('dragleave', event => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (!depth || !node.contains(event.relatedTarget)) { depth = 0; setDropping(false); }
    });
    node.addEventListener('drop', event => {
      depth = 0; setDropping(false);
      if (!hasFiles(event) || uploadState(panel) !== 'enabled') return;
      event.preventDefault();
      enqueue(panel, event.dataTransfer.files);
    });
    node.addEventListener('paste', event => {
      if (uploadState(panel) !== 'enabled' || event.target.closest?.('input,textarea,[contenteditable]')) return;
      const images = [...(event.clipboardData?.files || [])].filter(file => file.type.startsWith('image/'));
      if (!images.length) return;
      event.preventDefault();
      const stamp = new Date().toISOString().replace(/\.\d+Z$/, '').replace(/[-:]/g, '').replace('T', '-');
      const ext = file => ({'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp'})[file.type] || 'png';
      enqueue(panel, images.map((file, index) => ({file, name: `pasted-${stamp}${index ? `-${index + 1}` : ''}.${ext(file)}`})));
    });
  }

  function uploadButton(panel) {
    const state = uploadState(panel);
    if (state === 'off') return null;
    const disabled = state === 'no_folder';
    const button = el('button', {type: 'button', class: 'button subtle', 'data-artifacts-upload': true, disabled,
      'aria-describedby': disabled ? `${panel.uploadId}-why` : null, title: disabled ? NO_FOLDER_TEXT : 'Upload files to the report folder',
      onclick: () => panel.uploadInput.click()}, icon('fa-upload'), ' Upload files');
    // A disabled button gets no pointer events in some browsers; the wrapper keeps the tooltip.
    return disabled ? el('span', {class: 'artifacts-upload-disabled', title: NO_FOLDER_TEXT}, button) : button;
  }

  function enqueue(panel, files) {
    const max = panel.data?.upload?.max_bytes;
    for (const entry of [...(files || [])]) {
      const file = entry instanceof Blob ? entry : entry.file;
      const item = {id: ++uploadCounter, panel, selector: {...panel.selector}, file, name: entry.name || file.name || 'upload',
        loaded: 0, state: 'queued', message: '', node: null};
      panel.uploads.push(item);
      if (Number.isFinite(max) && file.size > max) finish(item, 'error', `Too large. The limit is ${size(max)}.`);
      else { renderUpload(item); uploadQueue.push(item); }
    }
    pump();
  }

  function pump() {
    if (uploadActive) return;
    const item = uploadQueue.shift();
    if (!item) return;
    uploadActive = item;
    item.state = 'uploading';
    renderUpload(item);
    const xhr = new XMLHttpRequest();
    item.xhr = xhr;
    xhr.open('POST', `/api/report-artifact-upload?${query(item.selector, {name: item.name})}`);
    xhr.setRequestHeader('X-Requested-With', 'Bounty-Board');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.responseType = 'json';
    xhr.upload.onprogress = event => { item.loaded = event.loaded; renderProgress(item); };
    const done = (state, message) => { item.xhr = null; uploadActive = null; finish(item, state, message); pump(); };
    xhr.onload = () => {
      const body = xhr.response && typeof xhr.response === 'object' ? xhr.response : {};
      if (xhr.status === 201 && body.artifact) {
        item.panel.fresh.set(body.artifact.relative, Date.now());
        done('done', body.renamed ? `Saved as ${body.artifact.name}` : 'Saved');
        load(item.panel, {quiet: true});
      } else {
        item.retry = ![413, 404].includes(xhr.status) && !['no_report_folder', 'invalid_name', 'uploads_disabled'].includes(body.error);
        done('error', uploadError(xhr.status, body, item.panel));
      }
    };
    xhr.onerror = () => { item.retry = true; done('error', 'Upload failed. Check the connection and retry.'); };
    xhr.ontimeout = xhr.onerror;
    xhr.onabort = () => done('cancelled', 'Cancelled');
    xhr.send(item.file);
  }

  function uploadError(status, body, panel) {
    const code = body?.error;
    if (status === 413 || code === 'too_large') return `Too large. The limit is ${size(body?.max_bytes ?? panel.data?.upload?.max_bytes)}.`;
    if (status === 507) return 'Not enough space on the server.';
    if (status === 503) return 'The server is busy with other uploads. Retry in a moment.';
    if (code === 'no_report_folder') return 'This report has no folder of its own, so files cannot be added here.';
    if (code === 'uploads_disabled') return 'Uploads are turned off on the server.';
    if (code === 'invalid_name') return 'The file name cannot be used. Rename the file and retry.';
    return 'Upload failed. Retry.';
  }

  function finish(item, state, message) {
    item.state = state;
    item.message = message;
    renderUpload(item);
    if (state === 'done' || state === 'cancelled') setTimeout(() => removeUpload(item), UPLOAD_DONE_MS);
  }

  function removeUpload(item) {
    const list = item.panel.uploads;
    const index = list.indexOf(item);
    if (index >= 0) list.splice(index, 1);
    item.node?.remove();
  }

  function cancelUpload(item) {
    if (item.xhr) item.xhr.abort();
    else {
      const index = uploadQueue.indexOf(item);
      if (index >= 0) uploadQueue.splice(index, 1);
      finish(item, 'cancelled', 'Cancelled');
    }
  }

  function renderProgress(item) {
    const bar = item.node?.querySelector('.artifact-upload-bar');
    if (!bar) return;
    const percent = item.file.size ? Math.min(100, Math.round(item.loaded / item.file.size * 100)) : 100;
    bar.setAttribute('aria-valuenow', String(percent));
    bar.firstChild.style.width = `${percent}%`;
    item.node.querySelector('.artifact-upload-status').textContent = `Uploading ${percent}%`;
  }

  function renderUpload(item) {
    const {state} = item;
    const active = state === 'queued' || state === 'uploading';
    const label = name => `${name} upload of ${item.name}`;
    const status = state === 'queued' ? 'Waiting' : state === 'uploading' ? 'Uploading 0%' : item.message;
    const node = el('li', {class: `artifact-upload is-${state}`, 'data-upload-state': state, 'data-upload-name': item.name},
      el('span', {class: 'artifact-icon'}, icon(state === 'done' ? 'fa-check' : state === 'error' ? 'fa-exclamation-triangle' : 'fa-upload')),
      el('div', {class: 'artifact-text'},
        el('div', {class: 'artifact-upload-name'}, el('span', {text: item.name}), el('span', {class: 'hint', text: size(item.file.size)})),
        active ? el('div', {class: 'artifact-upload-bar', role: 'progressbar', 'aria-label': `Upload progress for ${item.name}`,
          'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0'}, el('span')) : null,
        el('div', {class: `artifact-upload-status${state === 'error' ? ' is-error' : ''}`, role: state === 'error' ? 'alert' : null, text: status})),
      el('div', {class: 'artifact-buttons'},
        active ? el('button', {type: 'button', class: 'button subtle', 'aria-label': label('Cancel'), 'data-upload-cancel': true, onclick: () => cancelUpload(item)}, 'Cancel') : null,
        state === 'error' && item.retry ? el('button', {type: 'button', class: 'button subtle', 'aria-label': label('Retry'), 'data-upload-retry': true,
          onclick: () => { removeUpload(item); enqueue(item.panel, [{file: item.file, name: item.name}]); }}, 'Retry') : null,
        state === 'error' ? el('button', {type: 'button', class: 'button subtle', 'aria-label': `Dismiss upload message for ${item.name}`, 'data-upload-dismiss': true,
          onclick: () => removeUpload(item)}, 'Dismiss') : null));
    if (item.node?.isConnected || item.node?.parentNode) item.node.replaceWith(node);
    else item.panel.uploadList.append(node);
    item.node = node;
    if (state === 'uploading') renderProgress(item);
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

  // A file dropped outside the panel would make the browser open it and leave
  // the Board. While uploads are available, stop only file drops nobody else
  // handled: the editor and finding drag and drop handle their events first.
  const dropGuard = event => {
    if (event.defaultPrevented || ![...(event.dataTransfer?.types || [])].includes('Files')) return;
    if (!uploadsSeen && ![...panels.values()].some(panel => uploadState(panel) !== 'off')) return;
    if (event.target.closest?.('input[type=file]')) return;
    event.preventDefault();
    if (event.type === 'dragover') event.dataTransfer.dropEffect = 'none';
  };
  window.addEventListener('dragover', dropGuard);
  window.addEventListener('drop', dropGuard);

  const register = () => window.registerBoardModule({
    name: 'report-artifacts',
    afterRender() { const host = document.getElementById('report-artifacts-host'); if (host) mount(host); },
  });
  if (window.registerBoardModule) register();
  else window.addEventListener('DOMContentLoaded', register, {once: true});
})();
