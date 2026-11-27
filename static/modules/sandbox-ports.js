/* Sandbox preview ports (feature module).
 *
 * A PoC server started in a report's sandbox (python3 -m http.server 8000) is
 * exposed by the terminal service on a host port (docs/integrations/sandbox-ports.md).
 * This module shows those ports one click away:
 *
 * - drawer: a "1 port" pill in window.BoardTerminal.slot('ports'); its popover
 *   lists each sandbox port with its URL(s). With Tailscale on, the Tailscale URL
 *   is the main one (it works from another machine) and the 127.0.0.1 one is
 *   "on the server".
 * - drawer: a "Port 8000 is live" line in window.BoardTerminal.strip('ports').
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
  const LIVE_MAX = 2;   // ports shown in the live line; the pill's popover has them all
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

  function paint() {
    const slot = slotEl();
    if (!slot) return;
    paintStrip();
    const show = flags.preview_ports && selector && ports.length;
    if (!show) { closePopover(false); slot.replaceChildren(); return; }
    const label = `${ports.length} ${ports.length === 1 ? 'port' : 'ports'}`;
    let pill = slot.querySelector('[data-ports-pill]');
    if (!pill) {
      slot.innerHTML = '<button type="button" class="term-ports-pill" data-ports-pill aria-haspopup="dialog" aria-expanded="false"><i class="fa fa-plug" aria-hidden="true"></i><span data-ports-count></span></button>';
      pill = slot.querySelector('[data-ports-pill]');
      pill.addEventListener('click', () => (pop ? closePopover(true) : openPopover(pill)));
    }
    pill.querySelector('[data-ports-count]').textContent = label;
    pill.title = `Sandbox ports: ${ports.map(p => `:${p.port}`).join(', ')}`;
    if (pop) fillPopover();
  }

  // -- live line under the drawer header (1b) ---------------------------------------
  const stripEl = () => window.BoardTerminal?.strip?.('ports') || null;

  function paintStrip() {
    const el = stripEl();
    if (!el) return;
    if (!(flags.preview_ports && selector && ports.length)) { el.replaceChildren(); return; }
    const shown = ports.slice(0, LIVE_MAX);
    const entry = p => {
      const {url, tailnet} = mainUrl(p);
      const link = url ? linkHtml(url, 'term-ports-live-link') : `<span class="term-ports-live-link" data-ports-invalid>${esc(p.tailscale_url || p.local_url)}</span>`;
      return ports.length === 1
        ? `<span class="term-ports-live-text">Port <b>${esc(p.port)}</b> is live</span>${link}${url && tailnet ? '<span class="term-ports-where">over Tailscale</span>' : ''}`
        : `<span class="term-ports-live-port"><code>:${esc(p.port)}</code>${link}</span>`;
    };
    const anyTailnet = shown.some(p => mainUrl(p).tailnet);
    const head = ports.length === 1 ? '' : `<span class="term-ports-live-text">${esc(ports.length)} ports live</span>`;
    const more = ports.length > LIVE_MAX ? `<button type="button" class="term-ports-more" data-ports-more>+${esc(ports.length - LIVE_MAX)} more</button>` : '';
    const note = anyTailnet ? ''
      : flags.ports_tailscale ? `<span class="term-ports-live-note" data-ports-note>${esc(NO_ADDRESS)}</span>`
        : `<span class="term-ports-live-note" data-ports-note>${NOTE_OFF} <a href="#/settings" data-ports-settings>Settings</a>.</span>`;
    el.innerHTML = `<div class="term-ports-live" data-ports-live><span class="term-ports-dot" aria-hidden="true"></span>${head}${shown.map(entry).join('')}${more}${note}</div>`;
  }

  function onStripClick(event) {
    if (event.target.closest('[data-ports-more]')) {
      const p = slotEl()?.querySelector('[data-ports-pill]');
      if (p) openPopover(p);
    }
  }

  // The service builds these URLs, but only http links to loopback or a
  // Tailscale (100.64.0.0/10) IPv4 on the expected host port become links or
  // Copy values; anything else is shown as text.
  function safeUrl(url, hostPort) {
    const origin = safeOrigin(url, hostPort);
    if (!origin) return null;
    const u = new URL(String(url));
    return u.pathname === '/' && !u.search && !u.hash ? `${origin}/` : null;
  }
  // The validated origin (http://<127.x or 100.64.0.0/10 IPv4>:<port>) of a URL, or null.
  function safeOrigin(url, hostPort) {
    let u; try { u = new URL(String(url ?? '')); } catch { return null; }
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(u.hostname);
    if (u.protocol !== 'http:' || !m || u.username || u.password) return null;
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (m.slice(1).some(o => Number(o) > 255) || !(a === 127 || (a === 100 && b >= 64 && b <= 127))) return null;
    if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535 || u.port !== String(hostPort)) return null;
    return `http://${u.hostname}:${hostPort}`;
  }
  // The Tailscale listener has its own number (the sandbox's when it was free); older services sent none.
  const tsPort = p => (Number.isInteger(p.tailscale_port) ? p.tailscale_port : p.host_port);
  // The URL a port is opened with: Tailscale first (it works from another machine), else the local one.
  function mainUrl(p) {
    const ts = p.tailscale_url ? safeUrl(p.tailscale_url, tsPort(p)) : null;
    if (p.tailscale_url) return {url: ts, tailnet: !!ts};
    return {url: safeUrl(p.local_url, p.host_port), tailnet: false};
  }

  // Every URL is a real link (middle click and Ctrl/Cmd+click open natively);
  // a plain click copies it instead (onUrlClick).
  const linkHtml = (url, cls) => `<a class="${cls}" href="${esc(url)}" target="_blank" rel="noopener noreferrer" data-ports-url title="${esc(hint())}">${esc(url)}</a>`;

  function urlRow(raw, secondary, hostPort) {
    const url = safeUrl(raw, hostPort);
    if (!url) return `<div class="term-ports-url${secondary ? ' secondary' : ''}" data-ports-invalid>
      <span class="term-ports-where">unexpected address, not linked</span><span class="term-ports-link">${esc(raw)}</span></div>`;
    return `<div class="term-ports-url${secondary ? ' secondary' : ''}">
      ${secondary ? '<span class="term-ports-where">on the server</span>' : ''}
      ${linkHtml(url, 'term-ports-link')}
    </div>`;
  }

  // Copied / blocked note next to a link, 1.6 s.
  function flash(anchor, ok) {
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
      let rows = p.tailscale_url ? urlRow(p.tailscale_url, false, tsPort(p)) : urlRow(p.local_url, false, p.host_port);
      if (p.tailscale_url) rows += urlRow(p.local_url, true, p.host_port);
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

  function attachLinks(term) {
    if (!term || typeof term.registerLinkProvider !== 'function' || term.__portsLinks) return;
    term.__portsLinks = true;
    term.registerLinkProvider({
      provideLinks(y, callback) {
        if (!(flags.preview_ports && selector && ports.length)) { callback(undefined); return; }
        const line = term.buffer.active.getLine(y - 1);
        if (!line) { callback(undefined); return; }
        // Text with the cell column of every character (wide characters take two cells).
        let text = '';
        const cols = [];
        let cell;
        for (let x = 0; x < line.length; x++) {
          cell = line.getCell(x, cell);
          if (!cell || cell.getWidth() === 0) continue;
          const chars = cell.getChars() || ' ';
          for (let k = 0; k < chars.length; k++) cols.push(x);
          text += chars;
        }
        const links = [];
        for (const match of text.matchAll(URL_RE)) {
          const found = linkTarget(match[0]);
          if (!found) continue;
          const start = cols[match.index], end = cols[match.index + found.length - 1];
          const title = found.tailnet ? 'Opens over Tailscale' : 'Opens on the server';
          links.push({
            range: {start: {x: start + 1, y}, end: {x: end + 1, y}},
            text: match[0].slice(0, found.length),
            decorations: {underline: true, pointerCursor: true},
            hover: event => showTip(event, title, {url: found.url, hint: hint()}),
            leave: () => hideTip(),
            activate: event => {
              if (event?.ctrlKey || event?.metaKey || touchOnly()) { window.open(found.url, '_blank', 'noopener,noreferrer'); return; }
              // A drag that ends on the link selected text: leave it to copy-on-select.
              setTimeout(() => {
                if (term.hasSelection()) return;
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
  function bindStrip() {
    const el = stripEl();
    if (el && !el.__portsBound) { el.__portsBound = true; el.addEventListener('click', event => { if (!onUrlClick(event)) onStripClick(event); }); }
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
      bindStrip();
    },
  });
  window.BoardPorts = {get ports() { return ports.slice(); }, get flags() { return {...flags}; }, linkTarget};  // tests and diagnostics
})();
