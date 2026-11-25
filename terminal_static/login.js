/* Terminal sign-in page. Same origin as the Board (served under /terminal/). */
(() => {
  'use strict';
  try { const t = localStorage.getItem('bounty-board-theme'); if (t === 'light' || t === 'dark' || t === 'dusk') document.documentElement.dataset.theme = t; } catch {}
  // After sign-in go back only to this origin's Board (/) or terminal pages. Parse
  // with the URL parser so tabs, backslashes and encodings cannot turn the value
  // into another host (for example /%09/evil.example becomes //evil.example).
  const next = (() => {
    const value = new URLSearchParams(location.search).get('next') || '/';
    try {
      const url = new URL(value, location.origin);
      if (url.origin === location.origin && (url.pathname === '/' || url.pathname.startsWith('/terminal/'))) {
        return url.pathname + url.search + url.hash;
      }
    } catch {}
    return '/';
  })();
  const post = (path, body) => fetch(`/terminal/api/${path}`, {
    method: 'POST', credentials: 'same-origin',
    headers: {'Content-Type': 'application/json', 'X-Requested-With': 'Bounty-Board'}, body: JSON.stringify(body || {}),
  });
  document.addEventListener('DOMContentLoaded', async () => {
    const form = document.getElementById('login-form'), message = document.getElementById('login-message');
    const show = text => { message.textContent = text; message.hidden = !text; };
    try {
      const status = await fetch('/terminal/api/status', {credentials: 'same-origin', cache: 'no-store'});
      if (status.ok) { document.getElementById('signed-in').hidden = false; }
    } catch {}
    document.getElementById('logout').addEventListener('click', async () => { await post('logout'); location.reload(); });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      show('');
      const button = form.querySelector('button[type=submit]');
      button.disabled = true;
      try {
        const response = await post('login', {username: form.username.value, password: form.password.value});
        const data = await response.json().catch(() => ({}));
        if (response.ok) { location.assign(next); return; }
        show(data.message || 'Sign-in failed.');
      } catch { show('The terminal service is not reachable.'); }
      finally { button.disabled = false; form.password.value = ''; }
    });
  });
})();
