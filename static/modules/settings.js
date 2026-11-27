/* Settings page (feature module).
 *
 * app.js renders the #/settings frame with an empty #settings-host; this module
 * fills it with one card per group. Other modules add their controls through
 * a small registry:
 *
 *   window.BoardSettings.register({id, group, title, order, render(host)})
 *
 * render gets an empty element and may return a cleanup function (called when
 * the page re-renders or is left). Sections are sorted by order inside their
 * group's card; known groups (GROUPS below) render in their order, other groups
 * get their own card after them, titled by their first section. Registering
 * while the page is open re-renders it. Load this file before the modules that
 * register (index.html order).
 */
(() => {
  'use strict';
  // Known groups. A group may only show when the Board has the feature.
  const GROUPS = {
    terminal: {title: 'Terminal', icon: 'terminal', order: 10, note: 'Settings are saved on the Board server.',
      enabled: ctx => !!ctx?.state?.data?.capabilities?.terminal_url, off: 'The sandbox terminal is not enabled on this Board.'},
  };
  const sections = new Map();
  let ctx = null, host = null, cleanups = [];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

  function register(section) {
    if (!section || typeof section.id !== 'string' || !section.id || typeof section.render !== 'function') throw new Error('BoardSettings.register needs {id, render}');
    sections.set(section.id, {group: 'general', title: '', order: 100, ...section});
    if (host?.isConnected) paint();
    return () => { sections.delete(section.id); if (host?.isConnected) paint(); };
  }

  function cleanup() {
    const old = cleanups; cleanups = [];
    for (const fn of old) { try { fn(); } catch (error) { console.error('Settings cleanup failed:', error); } }
  }

  function paint() {
    cleanup();
    const byGroup = new Map(Object.keys(GROUPS).map(g => [g, []]));
    for (const section of sections.values()) {
      if (!byGroup.has(section.group)) byGroup.set(section.group, []);
      byGroup.get(section.group).push(section);
    }
    const groupOrder = g => GROUPS[g]?.order ?? Math.min(1000, ...byGroup.get(g).map(s => s.order));
    const groups = [...byGroup.keys()].filter(g => GROUPS[g] || byGroup.get(g).length).sort((a, b) => groupOrder(a) - groupOrder(b) || a.localeCompare(b));
    host.replaceChildren();
    for (const group of groups) {
      const meta = GROUPS[group] || {}, list = byGroup.get(group).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
      const title = meta.title || list[0]?.title || group;
      const card = document.createElement('section');
      card.className = 'panel panel-pad settings-card';
      card.dataset.settingsGroup = group;
      card.setAttribute('aria-labelledby', `settings-group-${group}`);
      card.innerHTML = `<div class="settings-card-head"><h2 id="settings-group-${esc(group)}">${meta.icon ? `<i class="fa fa-${esc(meta.icon)}" aria-hidden="true"></i> ` : ''}${esc(title)}</h2>${meta.note ? `<p class="hint settings-note">${esc(meta.note)}</p>` : ''}</div>`;
      host.appendChild(card);
      if (meta.enabled && !meta.enabled(ctx)) {
        card.querySelector('.settings-note')?.remove();
        card.insertAdjacentHTML('beforeend', `<p class="hint settings-off">${esc(meta.off)}</p>`);
        continue;
      }
      if (!list.length) { card.insertAdjacentHTML('beforeend', '<p class="hint settings-off">Nothing to set here yet.</p>'); continue; }
      for (const section of list) {
        const wrap = document.createElement('div');
        wrap.className = 'settings-section';
        wrap.dataset.settingsSection = section.id;
        if (section.title && section.title !== title) wrap.insertAdjacentHTML('beforeend', `<h3>${esc(section.title)}</h3>`);
        const body = document.createElement('div');
        wrap.appendChild(body);
        card.appendChild(wrap);
        try {
          const done = section.render(body);
          if (typeof done === 'function') cleanups.push(done);
        } catch (error) {
          console.error('Settings section failed:', section.id, error);
          body.innerHTML = '<p class="hint">This section could not be shown.</p>';
        }
      }
    }
  }

  window.BoardSettings = Object.freeze({register});

  window.registerBoardModule?.({
    name: 'settings',
    afterRender(context) {
      ctx = context;
      const next = document.getElementById('settings-host');
      if (next === host) return;
      cleanup();
      host = next;
      if (host) paint();
    },
  });
})();
