/* Sandbox preview ports (feature module).
 *
 * A PoC server started in a report's sandbox (python3 -m http.server 8000) is
 * exposed by the terminal service on a host port (docs/integrations/sandbox-ports.md).
 * This module shows those ports one click away:
 *
 * - drawer: a "1 port" pill in window.BoardTerminal.slot('ports'); its popover
 *   lists each sandbox port with Open and Copy for its URL(s). With Tailscale on,
 *   the Tailscale URL is the main one (it works from another machine) and the
 *   127.0.0.1 one is "on the server".
 * - Settings: the "Sandbox ports" section (Tailscale switch, saved on the server).
 *
 * Data: GET <terminal_url>api/ports?<selector> on attach, {"type":"ports"} pushes
 * over the drawer's WebSocket, GET/POST <terminal_url>api/settings.
 */
(() => {
  'use strict';
  const NOTE_OFF = 'Only reachable on the server. Turn on Tailscale in';
  const ACL_NOTE = 'While this is on, anyone on your tailnet allowed by your ACLs can open sandbox ports. They are plain http.';
  const NOT_ENABLED = 'Not enabled on this server. Start the terminal service with --preview-ports.';
  const ERRORS = {
    tailscale_not_found: 'No Tailscale address found on the server.',
    preview_ports_disabled: NOT_ENABLED,
    settings_failed: 'Could not save the setting.',
    settings_unreadable: 'Could not save the setting.',
  };
  let ctx = null;
  let selector = null, ports = [], flags = {preview_ports: false, ports_tailscale: false};
  let pop = null, popFor = null, fetchSeq = 0;
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

  // The service builds these URLs, but only http links to loopback or a
  // Tailscale (100.64.0.0/10) IPv4 on the expected host port become links or
  // Copy values; anything else is shown as text.
  function safeUrl(url, hostPort) {
    let u; try { u = new URL(String(url ?? '')); } catch { return null; }
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(u.hostname);
    if (u.protocol !== 'http:' || !m || u.username || u.password || u.pathname !== '/' || u.search || u.hash) return null;
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (m.slice(1).some(o => Number(o) > 255) || !(a === 127 || (a === 100 && b >= 64 && b <= 127))) return null;
    if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535 || u.port !== String(hostPort)) return null;
    return `http://${u.hostname}:${hostPort}/`;
  }

  function urlRow(raw, secondary, hostPort) {
    const url = safeUrl(raw, hostPort);
    if (!url) return `<div class="term-ports-url${secondary ? ' secondary' : ''}" data-ports-invalid>
      <span class="term-ports-where">unexpected address, not linked</span><span class="term-ports-link">${esc(raw)}</span></div>`;
    return `<div class="term-ports-url${secondary ? ' secondary' : ''}">
      ${secondary ? '<span class="term-ports-where">on the server</span>' : ''}
      <a class="term-ports-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer" data-ports-url>${esc(url)}</a>
      <span class="term-ports-actions">
        <a class="button sm" href="${esc(url)}" target="_blank" rel="noopener noreferrer" data-ports-open>Open</a>
        <button type="button" class="button sm" data-ports-copy="${esc(url)}"><span>Copy</span></button>
      </span>
    </div>`;
  }

  function fillPopover() {
    if (!pop) return;
    const items = ports.map(p => {
      const main = p.tailscale_url || p.local_url;
      const note = p.state === 'paused' ? '<span class="term-ports-paused">paused, opens on first visit</span>' : '';
      let rows = urlRow(main, false, p.host_port);
      if (p.tailscale_url) rows += urlRow(p.local_url, true, p.host_port);
      return `<li class="term-ports-item" data-ports-item="${esc(p.port)}"><div class="term-ports-port"><code>:${esc(p.port)}</code>${note}</div>${rows}</li>`;
    }).join('');
    const anyTailnet = ports.some(p => p.tailscale_url);
    const foot = anyTailnet ? ''
      : flags.ports_tailscale
        ? '<p class="term-ports-note" data-ports-note>Tailscale is on, but the server has no Tailscale address right now.</p>'
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
    const copy = event.target.closest('[data-ports-copy]');
    if (copy) {
      const label = copy.querySelector('span');
      copyText(copy.dataset.portsCopy).then(ok => {
        copy.dataset.copied = ok ? 'ok' : 'warn';
        label.textContent = ok ? 'Copied' : 'Copy blocked by the browser';
        setTimeout(() => { if (copy.isConnected) { delete copy.dataset.copied; label.textContent = 'Copy'; } }, 1600);
      });
      return;
    }
    if (event.target.closest('[data-ports-settings]')) closePopover(false);
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
            <p class="hint">A server you start in a sandbox gets a port on this server${range ? ` (${esc(range)})` : ''}. With this on, it also listens on the server's Tailscale address, so you can open it from your other devices.</p>
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
    },
  });
  window.BoardPorts = {get ports() { return ports.slice(); }, get flags() { return {...flags}; }};  // tests and diagnostics
})();
