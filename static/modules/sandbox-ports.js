/* Sandbox preview ports (feature module).
 *
 * A PoC server started in a report's sandbox (python3 -m http.server 8000) is
 * exposed by the terminal service on a host port (docs/integrations/sandbox-ports.md).
 * This module shows those ports one click away:
 *
 * - drawer: address chips in window.BoardTerminal.slot('ports'), one per port
 *   (100.101.102.103:8000; the 127.0.0.1 one, muted, when Tailscale is off), at
 *   most two, then "+N" opening a popover with every port and its URL(s). With
 *   Tailscale on, the Tailscale URL is the main one (it works from another
 *   machine) and the 127.0.0.1 one is "on the server".
 * - terminal: a printed http://localhost:8000/... (127.x, 0.0.0.0, [::1], [::])
 *   for a forwarded sandbox port is a link to that port's URL, path kept.
 * - one rule for every URL: Ctrl/Cmd+click (or middle click) opens in a new tab,
 *   a plain click copies; on touch-only devices a tap opens.
 * - Settings: the "Sandbox ports" section (Tailscale switch, saved on the server).
 *
 * Data: GET <terminal_url>api/ports?<selector> on attach, {"type":"ports"} pushes
 * over the drawer's WebSocket, GET/POST <terminal_url>api/settings.
 */
(() => {
  'use strict';
  const NOTE_OFF = 'Only reachable on the server. Turn on Tailscale in';
  const ACL_NOTE = 'While this is on, anyone on your tailnet allowed by your ACLs can open sandbox ports. They are plain http and can be on almost any port number, not only the range above.';
  const NO_ADDRESS = 'Tailscale is on, but the server has no Tailscale address right now.';
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
  const touchOnly = () => !!window.matchMedia && !window.matchMedia('(any-pointer: fine)').matches;
  const hint = () => (touchOnly() ? 'Tap to open' : `${isMac ? 'Cmd' : 'Ctrl'}+click to open, click to copy`);
  const CHIPS_MAX = 2;   // address chips in the header; more ports go behind "+N" (the popover)
  const NOT_ENABLED = 'Not enabled on this server. Start the terminal service with --preview-ports.';
  const ERRORS = {
    tailscale_not_found: 'No Tailscale address found on the server.',
    preview_ports_disabled: NOT_ENABLED,
    settings_failed: 'Could not save the setting.',
    settings_unreadable: 'Could not save the setting.',
  };
  let ctx = null;
  let selector = null, ports = [], flags = {preview_ports: false, ports_tailscale: false};
  let pop = null, popFor = null, fetchSeq = 0, tip = null, tipTimer = 0;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  const terminalBase = () => ctx?.state?.data?.capabilities?.terminal_url || null;
  const query = s => new URLSearchParams({family: s.family, program: s.program, lane: s.lane, path: s.path}).toString();
  const keyOf = s => (s ? JSON.stringify([s.family, s.program, s.lane, s.path]) : '');
  const loginHref = () => `${terminalBase() || '/terminal/'}login?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`;

  async function request(path, body) {
    const base = terminalBase();
    if (!base) { const error = new Error('No terminal'); error.status = 0; throw error; }
    const options = body
      ? {method: 'POST', credentials: 'same-origin', headers: {'Content-Type': 'application/json', 'X-Requested-With': 'Bounty-Board'}, body: JSON.stringify(body)}
      : {credentials: 'same-origin', cache: 'no-store'};
    const response = await fetch(base + path, {...options, signal: AbortSignal.timeout(15000)});
    let data = null;
    try { data = await response.json(); } catch {}
    if (!response.ok) { const error = new Error(data?.message || `Request failed (${response.status})`); error.status = response.status; error.code = data?.error; throw error; }
    return data || {};
  }

  async function copyText(text) {
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(text); return true; } catch {}
    }
    const area = document.createElement('textarea');
    area.value = text; area.setAttribute('readonly', ''); area.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(area); area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    area.remove();
    return ok;
  }

  // -- drawer ---------------------------------------------------------------------
  const slotEl = () => window.BoardTerminal?.slot?.('ports') || null;

  async function refresh() {
    const s = selector, seq = ++fetchSeq;
    if (!s) return;
    try {
      const data = await request(`api/ports?${query(s)}`);
      if (seq !== fetchSeq || keyOf(s) !== keyOf(selector)) return;
      ports = Array.isArray(data.ports) ? data.ports : [];
      flags = {preview_ports: !!data.preview_ports, ports_tailscale: !!data.ports_tailscale};
    } catch {
      if (seq !== fetchSeq) return;   // keep what the session told us; the drawer shows the service state
    }
    paint();
  }

  // Header chips: the address itself, one chip per port (at most CHIPS_MAX, fewer when
  // the header is short of room), then "+N" opening the popover with every port.
  function chipHtml(p, first) {
    const {url, tailnet} = mainUrl(p);
    const icon = first ? '<i class="fa fa-plug" aria-hidden="true"></i>' : '';
    if (!url) {
      const raw = String(p.tailscale_url || p.local_url || '');
      return `<span class="term-ports-chip muted" data-ports-chip data-ports-invalid title="${esc(`${raw}\nUnexpected address, not linked`)}">${icon}<span class="term-ports-chip-text">${esc(raw.replace(/^[a-z]+:\/\//i, '').replace(/\/$/, ''))}</span></span>`;
    }
    const where = tailnet ? '' : `\n${flags.ports_tailscale ? NO_ADDRESS : `${NOTE_OFF} Settings.`}`;
    return `<a class="term-ports-chip${tailnet ? '' : ' muted'}" href="${esc(url)}" target="_blank" rel="noopener noreferrer" draggable="false" data-ports-chip data-ports-url data-port="${esc(p.port)}" title="${esc(`${url}${where}\n${hint()}`)}">${icon}<span class="term-ports-chip-text">${esc(url.slice('http://'.length, -1))}</span></a>`;
  }

  // mode: 'normal', 'tight' (shorter chip text), 'compact' (only "+N", icon and number) or 'none'.
  function renderChips(slot, count, mode) {
    const more = ports.length - count;
    slot.dataset.portsTight = mode === 'tight' ? 'true' : 'false';
    slot.dataset.portsFit = mode;
    if (mode === 'none') { slot.innerHTML = ''; return; }
    const all = `All sandbox ports: ${ports.map(p => `:${p.port}`).join(', ')}`;
    slot.innerHTML = ports.slice(0, count).map((p, i) => chipHtml(p, i === 0)).join('')
      + (more > 0 ? `<button type="button" class="term-ports-chip term-ports-more" data-ports-more aria-haspopup="dialog" aria-expanded="false" aria-label="${esc(`${more} ${more === 1 ? 'port' : 'ports'}. ${all}`)}" title="${esc(all)}">${count ? '' : '<i class="fa fa-plug" aria-hidden="true"></i>'}+${esc(more)}</button>` : '');
  }

  // Chips must not add a header row, move the dock picker or the actions, or overflow:
  // try CHIPS_MAX chips, then one, then one with a shorter text, then only "+N"; measured, not guessed.
  function fitChips(slot) {
    const head = slot.closest('[data-term-head]');
    const first = Math.min(CHIPS_MAX, ports.length);
    if (!head || !head.offsetParent) { renderChips(slot, first, 'normal'); return; }
    const marks = [...head.querySelectorAll('[data-term-dock], .term-actions, [data-term-sub], [data-term-status]')];
    const others = [...head.querySelectorAll('.term-grip, .term-title, [data-term-status], [data-term-flash], [data-term-dock], [data-term-sub], .term-actions, [data-term-slot]')].filter(el => el !== slot);
    const hit = (a, b) => a.width > 0 && b.width > 0 && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
    const overlap = () => [...slot.children].some(chip => { const r = chip.getBoundingClientRect(); return others.some(el => hit(r, el.getBoundingClientRect())); });
    const probe = () => ({h: head.offsetHeight, tops: marks.map(el => el.offsetTop),
      over: [...head.querySelectorAll('.term-row')].some(row => row.scrollWidth > row.clientWidth + 1) || slot.scrollWidth > slot.clientWidth + 1 || overlap()});
    slot.style.display = 'none';
    const base = probe();
    slot.style.display = '';
    const fits = () => { const now = probe(); return now.h <= base.h + 1 && now.tops.every((t, i) => Math.abs(t - base.tops[i]) <= 1) && (!now.over || base.over); };
    // Nothing fits (a side dock at its minimum width): no chip rather than one over the
    // dock picker; widening the drawer re-fits, and terminal links still work.
    const tries = [[first, 'normal'], [Math.min(1, first), 'normal'], [Math.min(1, first), 'tight'], [0, 'compact']];
    for (const [count, mode] of tries) { renderChips(slot, count, mode); if (fits()) return; }
    renderChips(slot, 0, 'none');
  }

  let fitKey = '', fitObserver = null;
  function paint() {
    const slot = slotEl();
    if (!slot) return;
    linksChanged();
    bindSlot(slot);
    observeDrawer(slot);
    const show = flags.preview_ports && selector && ports.length;
    if (!show) { closePopover(false); slot.replaceChildren(); fitKey = ''; return; }
    const keepFocus = slot.contains(document.activeElement) ? document.activeElement.dataset.port || 'more' : null;
    fitChips(slot);
    fitKey = layoutKey(slot);
    if (keepFocus) slot.querySelector(keepFocus === 'more' ? '[data-ports-more]' : `[data-port="${CSS.escape(keepFocus)}"]`)?.focus();
    const more = slot.querySelector('[data-ports-more]');
    if (pop && !more) closePopover(false);
    else if (pop) { popFor = more; more.setAttribute('aria-expanded', 'true'); fillPopover(); }
  }
  const layoutKey = slot => { const d = slot.closest('.term-drawer'); return d ? `${d.dataset.dock}|${d.offsetWidth}|${window.innerWidth}` : ''; };

  function bindSlot(slot) {
    if (slot.__portsBound) return;
    slot.__portsBound = true;
    slot.addEventListener('click', event => {
      if (onUrlClick(event)) return;
      const more = event.target.closest('[data-ports-more]');
      if (more) (pop ? closePopover(true) : openPopover(more));
    });
    // Re-fit when the drawer is re-docked, resized or opened (only when its dock or width changed).
    const refit = () => { if (ports.length && fitKey && layoutKey(slot) !== fitKey) paint(); };
    if (window.ResizeObserver) fitObserver = new ResizeObserver(refit);
    window.addEventListener('resize', refit);
  }
  function observeDrawer(slot) {
    const drawer = slot.closest('.term-drawer');
    if (fitObserver && drawer && !drawer.__portsObserved) { drawer.__portsObserved = true; fitObserver.observe(drawer); }
  }

  // The service builds these URLs, but only http links to loopback or a
  // Tailscale (100.64.0.0/10) IPv4 on the expected host port become links or
  // Copy values; anything else is shown as text.
  // kind: 'local' (127.0.0.0/8, the loopback listener) or 'tailscale' (100.64.0.0/10).
  function safeUrl(url, hostPort, kind) {
    const origin = safeOrigin(url, hostPort, kind);
    if (!origin) return null;
    const u = new URL(String(url));
    return u.pathname === '/' && !u.search && !u.hash ? `${origin}/` : null;
  }
  // The validated origin of a URL, or null: http, an IPv4 of its own kind (local_url: 127.0.0.0/8,
  // tailscale_url: 100.64.0.0/10) and exactly the item's port for that listener.
  // TEST ONLY: the browser fixture's "Tailscale address" is a loopback alias; its tests set
  // window.__BOARD_PORTS_TEST_TAILNET__ to that one address (page scripts are trusted anyway;
  // this check guards against what the service sends).
  function safeOrigin(url, hostPort, kind) {
    let u; try { u = new URL(String(url ?? '')); } catch { return null; }
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(u.hostname);
    if (u.protocol !== 'http:' || !m || u.username || u.password) return null;
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (m.slice(1).some(o => Number(o) > 255)) return null;
    const local = a === 127, tailnet = (a === 100 && b >= 64 && b <= 127) || (u.hostname === window.__BOARD_PORTS_TEST_TAILNET__ && local);
    if (kind === 'local' ? !local : kind === 'tailscale' ? !tailnet : true) return null;
    if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535 || u.port !== String(hostPort)) return null;
    return `http://${u.hostname}:${hostPort}`;
  }
  // The Tailscale listener has its own number (the sandbox's when it was free); older services sent none.
  const tsPort = p => (Number.isInteger(p.tailscale_port) ? p.tailscale_port : p.host_port);
  // The URL a port is opened with: Tailscale first (it works from another machine), else the local one.
  function mainUrl(p) {
    const ts = p.tailscale_url ? safeUrl(p.tailscale_url, tsPort(p), 'tailscale') : null;
    if (p.tailscale_url) return {url: ts, tailnet: !!ts};
    return {url: safeUrl(p.local_url, p.host_port, 'local'), tailnet: false};
  }

  // Every URL is a real link (middle click and Ctrl/Cmd+click open natively);
  // a plain click copies it instead (onUrlClick).
  const linkHtml = (url, cls) => `<a class="${cls}" href="${esc(url)}" target="_blank" rel="noopener noreferrer" data-ports-url title="${esc(hint())}">${esc(url)}</a>`;

  function urlRow(raw, secondary, hostPort, kind) {
    const url = safeUrl(raw, hostPort, kind);
    if (!url) return `<div class="term-ports-url${secondary ? ' secondary' : ''}" data-ports-invalid>
      <span class="term-ports-where">unexpected address, not linked</span><span class="term-ports-link">${esc(raw)}</span></div>`;
    return `<div class="term-ports-url${secondary ? ' secondary' : ''}">
      ${secondary ? '<span class="term-ports-where">on the server</span>' : ''}
      ${linkHtml(url, 'term-ports-link')}
    </div>`;
  }

  // Copied / blocked note, 1.6 s: on a header chip itself, else next to the link.
  function flash(anchor, ok) {
    if (anchor.matches('[data-ports-chip]')) {
      const text = anchor.querySelector('.term-ports-chip-text');
      anchor.dataset.copied = ok ? 'ok' : 'warn';
      anchor.setAttribute('aria-live', 'polite');
      text.dataset.address ??= text.textContent;
      text.textContent = ok ? 'Copied' : 'Copy blocked by the browser';
      clearTimeout(anchor.timer);
      anchor.timer = setTimeout(() => { delete anchor.dataset.copied; text.textContent = text.dataset.address; }, 1600);
      return;
    }
    let el = anchor.nextElementSibling?.matches?.('[data-ports-copied]') ? anchor.nextElementSibling : null;
    if (!el) {
      el = document.createElement('span');
      el.className = 'term-ports-copied';
      el.dataset.portsCopied = '';
      el.setAttribute('role', 'status');
      anchor.after(el);
    }
    el.dataset.tone = ok ? 'ok' : 'warn';
    el.textContent = ok ? 'Copied' : 'Copy blocked by the browser';
    clearTimeout(el.timer);
    el.timer = setTimeout(() => el.remove(), 1600);
  }

  function onUrlClick(event) {
    const a = event.target.closest?.('a[data-ports-url]');
    if (!a || event.button !== 0) return false;
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || touchOnly()) return true;   // native open
    event.preventDefault();
    copyText(a.href).then(ok => { if (a.isConnected) flash(a, ok); });
    return true;
  }

  function fillPopover() {
    if (!pop) return;
    const items = ports.map(p => {
      const note = p.state === 'paused' ? '<span class="term-ports-paused">paused, opens on first visit</span>' : '';
      let rows = p.tailscale_url ? urlRow(p.tailscale_url, false, tsPort(p), 'tailscale') : urlRow(p.local_url, false, p.host_port, 'local');
      if (p.tailscale_url) rows += urlRow(p.local_url, true, p.host_port, 'local');
      return `<li class="term-ports-item" data-ports-item="${esc(p.port)}"><div class="term-ports-port"><code>:${esc(p.port)}</code>${note}</div>${rows}</li>`;
    }).join('');
    const anyTailnet = ports.some(p => p.tailscale_url);
    const foot = anyTailnet ? ''
      : flags.ports_tailscale
        ? `<p class="term-ports-note" data-ports-note>${esc(NO_ADDRESS)}</p>`
        : `<p class="term-ports-note" data-ports-note>${NOTE_OFF} <a href="#/settings" data-ports-settings>Settings</a>.</p>`;
    pop.innerHTML = `<div class="term-ports-title" id="term-ports-title">Sandbox ports</div><ul class="term-ports-list">${items}</ul>${foot}`;
  }

  function place(anchor) {
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth, h = pop.offsetHeight, gap = 6, margin = 8;
    let left = Math.min(Math.max(margin, r.left), window.innerWidth - w - margin);
    let top = r.bottom + gap;
    if (top + h > window.innerHeight - margin) top = Math.max(margin, r.top - gap - h);
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
  }

  function openPopover(pill) {
    closePopover(false);
    pop = document.createElement('div');
    pop.className = 'term-ports-pop';
    pop.dataset.portsPopover = '';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-labelledby', 'term-ports-title');
    popFor = pill;
    fillPopover();
    document.body.appendChild(pop);
    place(pill);
    pill.setAttribute('aria-expanded', 'true');
    pop.addEventListener('click', onPopClick);
    pop.addEventListener('keydown', onPopKey);
    document.addEventListener('pointerdown', onOutside, true);
    window.addEventListener('resize', onViewport);
    document.addEventListener('scroll', onViewport, true);
    pop.querySelector('a,button')?.focus();
  }

  function closePopover(focusPill) {
    if (!pop) return;
    pop.remove(); pop = null;
    document.removeEventListener('pointerdown', onOutside, true);
    window.removeEventListener('resize', onViewport);
    document.removeEventListener('scroll', onViewport, true);
    if (popFor?.isConnected) { popFor.setAttribute('aria-expanded', 'false'); if (focusPill) popFor.focus(); }
    popFor = null;
  }

  function onOutside(event) {
    if (pop && !pop.contains(event.target) && !popFor?.contains(event.target)) closePopover(false);
  }
  function onViewport(event) {
    if (pop && event.type === 'scroll' && pop.contains(event.target)) return;
    if (popFor?.isConnected) place(popFor); else closePopover(false);
  }
  function onPopKey(event) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closePopover(true); return; }
    if (event.key === 'Tab') {   // keep focus inside the popover while it is open
      const items = [...pop.querySelectorAll('a[href],button:not(:disabled)')];
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }
  function onPopClick(event) {
    if (onUrlClick(event)) return;
    if (event.target.closest('[data-ports-settings]')) closePopover(false);
  }

  // -- terminal links (1a) ------------------------------------------------------------
  // Terminal output is target-influenced text: it only ever selects a forwarded
  // port and a path; the link's origin is the validated forward origin, and the
  // hover text is set with textContent.
  const URL_RE = /\bhttps?:\/\/[^\s"'<>`]+/gi;
  const LOOPBACK = /^(?:localhost|0\.0\.0\.0|\[::1?\]|127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;

  // Printed text -> {url, tailnet} or null. Exported for tests (BoardPorts.linkTarget).
  function linkTarget(text) {
    const raw = String(text).replace(/[.,;:!?)\]}'"]+$/, '');
    const m = /^(https?):\/\/(\[[^\]\/]*\]|[^\/:?#@\[\]]+):(\d{1,5})(?=[\/?#]|$)/i.exec(raw);
    if (!m || !LOOPBACK.test(m[2])) return null;
    if (/^127\./.test(m[2]) && m[2].split('.').some(o => Number(o) > 255)) return null;
    const port = Number(m[3]);
    const item = ports.find(p => p.port === port);
    if (!item) return null;
    const {url: base, tailnet} = mainUrl(item);
    if (!base) return null;
    let printed, target;
    try { printed = new URL(raw); target = new URL(base); } catch { return null; }
    const expected = target.origin;
    target.protocol = m[1].toLowerCase() + ':';
    target.pathname = printed.pathname;
    target.search = printed.search;
    target.hash = printed.hash;
    // Same origin as the validated forward (the printed scheme kept: an https PoC server stays https).
    if (target.username || target.password || target.host !== new URL(expected).host || !/^https?:$/.test(target.protocol)) return null;
    return {url: target.href, tailnet, length: raw.length};
  }

  function showTip(event, title, detail) {
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'term-ports-tip';
      tip.dataset.portsTip = '';
      tip.setAttribute('role', 'tooltip');
      tip.append(document.createElement('div'), document.createElement('div'), document.createElement('div'));
      tip.children[0].className = 'term-ports-tip-title';
      tip.children[1].className = 'term-ports-tip-url';
      tip.children[2].className = 'term-ports-tip-hint';
    }
    clearTimeout(tipTimer);
    tip.children[0].textContent = title;
    tip.children[1].textContent = detail.url;
    tip.children[2].textContent = detail.hint;
    tip.dataset.tone = detail.tone || '';
    if (!tip.isConnected) document.body.appendChild(tip);
    if (event) {
      const w = tip.offsetWidth, h = tip.offsetHeight, margin = 8;
      tip.style.left = `${Math.round(Math.min(Math.max(margin, event.clientX + 12), window.innerWidth - w - margin))}px`;
      const below = event.clientY + 18;
      tip.style.top = `${Math.round(below + h > window.innerHeight - margin ? Math.max(margin, event.clientY - 10 - h) : below)}px`;
    }
  }
  function hideTip(delay = 0) {
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => tip?.remove(), delay);
  }

  // The terminal with our link provider, and what its links pointed at: when the ports
  // change, every row is re-rendered, which drops xterm's cached (hovered) link.
  let linkTerm = null, linkKey = '';
  function linksChanged() {
    const key = JSON.stringify(flags.preview_ports && selector ? ports.map(p => [p.port, mainUrl(p).url]) : []);
    if (key === linkKey) return;
    linkKey = key;
    hideTip();
    if (linkTerm) try { linkTerm.refresh(0, linkTerm.rows - 1); } catch {}
  }

  // A link acts only while its text still leads to the same URL (the forward may be gone, and
  // its number may belong to another session's sandbox by now).
  const stillSame = (text, url) => linkTarget(text)?.url === url;

  const MAX_JOINED_ROWS = 16;   // a wrapped line is read as one (bounded)
  function attachLinks(term) {
    if (!term || typeof term.registerLinkProvider !== 'function' || term.__portsLinks) return;
    term.__portsLinks = true;
    linkTerm = term;
    term.registerLinkProvider({
      provideLinks(y, callback) {
        if (!(flags.preview_ports && selector && ports.length)) { callback(undefined); return; }
        const buf = term.buffer.active;
        if (!buf.getLine(y - 1)) { callback(undefined); return; }
        // The whole logical line around row y (rows joined while the next one is a wrapped
        // continuation), with the cell position of every character (wide characters take two cells).
        let top = y - 1, bottom = y - 1;
        while (top > 0 && y - 1 - top < MAX_JOINED_ROWS && buf.getLine(top)?.isWrapped) top--;
        while (bottom - (y - 1) < MAX_JOINED_ROWS && buf.getLine(bottom + 1)?.isWrapped) bottom++;
        let text = '';
        const pos = [];
        let cell;
        for (let row = top; row <= bottom; row++) {
          const line = buf.getLine(row);
          for (let x = 0; x < line.length; x++) {
            cell = line.getCell(x, cell);
            if (!cell || cell.getWidth() === 0) continue;
            const chars = cell.getChars() || ' ';
            for (let k = 0; k < chars.length; k++) pos.push({x: x + 1, y: row + 1});
            text += chars;
          }
        }
        const links = [];
        for (const match of text.matchAll(URL_RE)) {
          const found = linkTarget(match[0]);
          if (!found) continue;
          const start = pos[match.index], end = pos[match.index + found.length - 1];
          if (end.y < y || start.y > y) continue;   // another row of this line provides it
          const title = found.tailnet ? 'Opens over Tailscale' : 'Opens on the server';
          const linkText = match[0].slice(0, found.length);
          const closed = () => { showTip(null, title, {url: found.url, hint: 'Port closed', tone: 'warn'}); hideTip(1600); };
          links.push({
            range: {start, end},
            text: linkText,
            decorations: {underline: true, pointerCursor: true},
            hover: event => { if (stillSame(linkText, found.url)) showTip(event, title, {url: found.url, hint: hint()}); },
            leave: () => hideTip(),
            activate: event => {
              if (!stillSame(linkText, found.url)) { closed(); return; }
              if (event?.ctrlKey || event?.metaKey || touchOnly()) { window.open(found.url, '_blank', 'noopener,noreferrer'); return; }
              // A drag that ends on the link selected text: leave it to copy-on-select.
              setTimeout(() => {
                if (term.hasSelection()) return;
                if (!stillSame(linkText, found.url)) { closed(); return; }
                copyText(found.url).then(ok => {
                  showTip(null, title, {url: found.url, hint: ok ? 'Copied' : 'Copy blocked by the browser', tone: ok ? 'ok' : 'warn'});
                  hideTip(1600);
                });
              }, 0);
            },
          });
        }
        callback(links.length ? links : undefined);
      },
    });
  }

  function onSession({selector: s, session}) {
    if (!s) { selector = null; ports = []; fetchSeq++; paint(); return; }
    const changed = keyOf(s) !== keyOf(selector);
    selector = s;
    ports = Array.isArray(session?.ports) ? session.ports : (changed ? [] : ports);
    paint();
    refresh();
  }
  function onMessage(message) {
    if (message?.type !== 'ports' || !selector) return;
    ports = Array.isArray(message.ports) ? message.ports : [];
    paint();
    refresh();   // picks up the Tailscale flag if another tab changed it
  }

  // -- Settings -------------------------------------------------------------------
  function renderSettings(host) {
    let alive = true, current = null, timer = 0;
    host.innerHTML = '<p class="hint" data-ports-settings-loading>Loading…</p>';

    function message(text, link) {
      const el = host.querySelector('[data-ports-settings-msg]');
      if (!el) return;
      el.innerHTML = text ? `${esc(text)}${link ? ` <a href="${esc(link.href)}" data-ports-login>${esc(link.text)}</a>` : ''}` : '';
      el.hidden = !text;
    }

    function show(data) {
      current = data;
      if (!data.preview_ports) {
        host.innerHTML = `<p class="hint settings-off" data-ports-disabled>${esc(NOT_ENABLED)}</p>`;
        return;
      }
      const on = !!data.ports_tailscale;
      const address = data.tailscale_address
        ? `Tailscale address ${esc(data.tailscale_address)}`
        : data.tailscale_reason === 'not_found' ? 'No Tailscale address found on the server right now' : 'The Tailscale address is detected when you turn this on';
      const range = Array.isArray(data.ports_range) ? `${data.ports_range[0]} to ${data.ports_range[1]}` : '';
      host.innerHTML = `<p class="hint settings-note">Saved on the server.</p>
        <div class="set-row">
          <div class="set-text"><label for="ports-tailscale">Open sandbox ports over Tailscale</label>
            <p class="hint">A server you start in a sandbox gets a port on this server${range ? ` (${esc(range)})` : ''}. With this on, it also listens on the server's Tailscale address, on the same port number as in the sandbox when that number is free, so you can open it from your other devices.</p>
            <p class="hint" data-ports-address>${address}.</p></div>
          <div class="set-controls"><input id="ports-tailscale" type="checkbox" role="switch" class="set-switch" data-ports-tailscale ${on ? 'checked' : ''}></div>
        </div>
        <p class="hint ports-acl-note" data-ports-acl>${esc(ACL_NOTE)}</p>
        <p class="ports-settings-msg" data-ports-settings-msg role="status" aria-live="polite" hidden></p>`;
      const input = host.querySelector('[data-ports-tailscale]');
      input.addEventListener('change', async () => {
        const wanted = input.checked;
        input.checked = !!current.ports_tailscale;   // reflect the server, not a guess
        input.disabled = true;
        message('');
        try {
          const answer = await request('api/settings', {ports_tailscale: wanted});
          if (!alive) return;
          show(answer);
          flags = {preview_ports: !!answer.preview_ports, ports_tailscale: !!answer.ports_tailscale};
          if (selector) refresh();
        } catch (error) {
          if (!alive) return;
          await load(false);
          if (error.status === 401) message('Sign in to the terminal to change this.', {href: loginHref(), text: 'Sign in to the terminal'});
          else message(ERRORS[error.code] || 'Could not reach the terminal service.');
        }
      });
    }

    async function load(first = true) {
      try {
        const data = await request('api/settings');
        if (alive) show(data);
      } catch (error) {
        if (!alive) return;
        if (!first && current) { show(current); return; }
        host.innerHTML = error.status === 401
          ? `<p class="hint" data-ports-signin>Sign in to the terminal to see these settings. <a href="${esc(loginHref())}" data-ports-login>Sign in to the terminal</a></p>`
          : '<p class="hint" data-ports-unreachable>The terminal service is not reachable right now.</p>';
      }
    }
    // Every module's afterRender runs before the request (the terminal URL comes from the Board context).
    timer = setTimeout(() => load(true), 0);
    return () => { alive = false; clearTimeout(timer); };
  }

  window.BoardSettings?.register?.({id: 'terminal-ports', group: 'terminal', title: 'Sandbox ports', order: 50, render: renderSettings});

  window.registerBoardModule?.({
    name: 'sandbox-ports',
    afterRender(context) {
      ctx = context;
      if (!window.BoardTerminal?.on || window.BoardTerminal.__portsHooked) return;
      window.BoardTerminal.__portsHooked = true;
      window.BoardTerminal.on('session', onSession);
      window.BoardTerminal.on('message', onMessage);
      window.BoardTerminal.on('terminal', attachLinks);
    },
  });
  window.BoardPorts = {get ports() { return ports.slice(); }, get flags() { return {...flags}; }, linkTarget};  // tests and diagnostics
})();
