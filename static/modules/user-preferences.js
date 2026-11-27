/* Bootstrap preferences before the app reads its browser fallback.  Only the
 * explicit keys below are shared: draft storage, search text, locks and the
 * current terminal dock never leave the browser. */
(() => {
  'use strict';
  const keys = [
    'bounty-board-theme', 'bounty-board-show-archived', 'bounty-board-sidebar-collapsed',
    'bounty-board-finding-sort', 'bounty-board-dashboard-work', 'bounty-board-class-group',
    'bounty-board-report-list-hide-na', 'bounty-board-report-list-open', 'bounty-board-recent-programs',
    'bounty-board-last-program',
    'bounty-board-recent-panel-show-na',
  ];
  const fields = ['copyOnSelect', 'ctrlCCopy', 'ctrlVPaste', 'shortcut', 'dock'];
  const listFields = ['window', 'order', 'nav', 'hideNa', 'programs', 'lanes', 'subs', 'sevs', 'classes'];
  const lists = {recent: 'bounty-board-recent-reports', submissions: 'bounty-board-submissions'};
  const terminalKey = 'bounty-board-terminal:v1';
  const marker = 'bounty-board-preferences-migrated:v1';
  const pendingPrefix = 'bounty-board-preferences-pending:v1:';
  const pendingBasePrefix = 'bounty-board-preferences-base:v1:';
  const revisionsKey = 'bounty-board-preferences-revisions:v1';
  const allowed = new Set([...keys, ...fields.map(f => `terminal.${f}`), ...Object.keys(lists).flatMap(n => listFields.map(f => `list.${n}.${f}`))]);
  const memory = new Map();
  let cacheFailed = false;
  const read = key => { if(memory.has(key))return memory.get(key); try { return localStorage.getItem(key); } catch { cacheFailed=true; return null; } };
  const put = (key, value) => { memory.set(key,value); try { localStorage.setItem(key, value); return true; } catch { cacheFailed=true; return false; } };
  const parse = (raw, fallback) => { try { return JSON.parse(raw) ?? fallback; } catch { return fallback; } };
  function validLegacy(key, raw) {
    if (new TextEncoder().encode(raw).length > 8192) return false;
    if (key === 'bounty-board-theme') return ['light','dark','dusk'].includes(raw);
    if (['bounty-board-show-archived','bounty-board-sidebar-collapsed','bounty-board-report-list-hide-na','bounty-board-report-list-open'].includes(key)) return ['true','false'].includes(raw);
    if (key === 'bounty-board-recent-panel-show-na') return ['0','1'].includes(raw);
    const value = parse(raw, null);
    if (key === 'bounty-board-dashboard-work') return ['all','open'].includes(value);
    if (key === 'bounty-board-class-group') return ['class','category'].includes(value);
    if (key === 'bounty-board-finding-sort') return value && Object.keys(value).length === 2 && ['', 'title','severity','class','status','id','first_seen','last_seen'].includes(value.key) && ['asc','desc'].includes(value.dir);
    if (['bounty-board-recent-programs','bounty-board-last-program'].includes(key)) {
      const items = key === 'bounty-board-last-program' ? [value] : value;
      return Array.isArray(items) && items.length <= 5 && items.every(v => v && typeof v === 'object' && Object.keys(v).length === 2 && ['program','lane'].every(k => typeof v[k] === 'string' && v[k].length <= 200));
    }
    return false;
  }
  // Each write has an immutable unique identity, so one tab's acknowledgement
  // can never delete another tab's edit, even if sessionStorage was cloned.
  const recordPrefix = 'bounty-board-preferences-edit:v2:';
  const ownerKey = 'bounty-board-preferences-owner:v2';
  let owner;
  try {
    owner = performance.getEntriesByType('navigation')[0]?.type === 'reload' ? sessionStorage.getItem(ownerKey) : null;
    if (!owner) owner=crypto.randomUUID();
    sessionStorage.setItem(ownerKey,owner);
  } catch { owner=crypto.randomUUID(); cacheFailed=true; }
  const created = new Set();
  const submitted = new Set(), rejected = new Set(), uncertain = new Set(), superseded = new Map();
  let ownerClaimed=false, ownershipFailed=false;
  const pending = {}, pendingBases = {}, pendingIds = {}, pendingStamps = {}, conflicts = new Set();
  let nextStamp=Date.now()*1000;
  let observed = parse(read(revisionsKey), null);
  let serverCache = {};
  try {
    const records=Object.keys(localStorage).filter(k=>k.startsWith(recordPrefix)).map(name=>({name,entry:parse(localStorage.getItem(name),null)})).sort((a,b)=>(b.entry?.stamp || 0)-(a.entry?.stamp || 0));
    for (const {name,entry} of records) {
      if (!entry || entry.owner !== owner || !allowed.has(entry.key) || typeof entry.value !== 'string') continue;
      if(Number.isSafeInteger(entry.stamp))nextStamp=Math.max(nextStamp,entry.stamp);
      if(Object.hasOwn(pending,entry.key)){conflicts.add(entry.key);continue;}
      pending[entry.key]=entry.value; pendingIds[entry.key]=name; pendingStamps[entry.key]=entry.stamp || 0;
      if (Number.isSafeInteger(entry.base) && entry.base>=0) pendingBases[entry.key]=entry.base; else conflicts.add(entry.key);
    }
  } catch { cacheFailed=true; }
  for (const key of allowed) {
    if (Object.hasOwn(pending,key)) continue;
    const value = read(pendingPrefix + key);
    if (value !== null) {
      pending[key] = value;
      const base = parse(read(pendingBasePrefix + key), null);
      if (Number.isSafeInteger(base) && base >= 0) pendingBases[key] = base;
      else conflicts.add(key);
    }
  }
  window.addEventListener('storage',event=>{
    if(event.key===terminalKey && !fields.some(field=>Object.hasOwn(pending,`terminal.${field}`))) memory.delete(terminalKey);
  });
  let failed = false, readFailed = false, inflight = false, migrating = false;
  const noticeButtons = new Map();
  const notice = () => {
    const paint = () => {
      let node = document.getElementById('preferences-save-error');
      if (!failed) { node?.remove(); noticeButtons.clear(); return; }
      if (!node && document.body) {
        node = document.createElement('div'); node.id = 'preferences-save-error'; node.setAttribute('role', 'alert');
        node.style.cssText = 'position:fixed;z-index:9999;bottom:1rem;right:1rem;max-width:min(28rem, calc(100vw - 2rem));padding:.75rem 1rem;background:#8b2525;color:white;border-radius:.5rem;pointer-events:none';
        const message=document.createElement('span'); message.className='preferences-error-message'; node.appendChild(message);
        document.body.appendChild(node);
      }
      if (node) {
        const message=node.querySelector('.preferences-error-message');
        message.textContent = conflicts.size ? (readFailed ? 'A preference needs recovery. Waiting to read the saved values before retrying.' : migrating ? 'A preference needs recovery. Waiting for preference migration to finish.' : inflight ? 'A preference needs recovery. Saving is in progress.' : 'A preference needs recovery. Use your choice below to replace the current saved value.') : ownershipFailed || uncertain.size ? 'An earlier preference needs recovery and remains in this browser.' : cacheFailed ? 'Browser storage is unavailable; unsaved preferences may be lost after reload.' : 'Preferences could not be saved to the server. Changes remain in this browser; retrying.';
        if(cacheFailed && (conflicts.size || ownershipFailed || uncertain.size))message.append(' Browser storage is unavailable; unsaved choices may be lost after reload.');
        const visible=new Set();
        if (!readFailed && ownerClaimed && !ownershipFailed) for (const key of conflicts) {
          if (!Object.hasOwn(pending,key)) continue;
          visible.add(key);
          const label=key==='bounty-board-theme'?'Theme':key.replace(/^bounty-board-/, '').replaceAll('.', ' ').replaceAll('-', ' ');
          let button=noticeButtons.get(key);
          if(!button){
            button=document.createElement('button'); button.type='button'; button.textContent=`Use my choice for ${label}`;
            button.style.cssText='display:block;margin-top:.5rem;pointer-events:auto';
            button.addEventListener('click',()=>{if(!inflight && !migrating)resolveChoice(key);});
            noticeButtons.set(key,button); node.appendChild(button);
          }
          // aria-disabled keeps a focused action in place while guarded against activation.
          button.setAttribute('aria-disabled',String(inflight || migrating));
          button.style.opacity=inflight || migrating ? '0.6' : '1';
        }
        for(const [key,button] of noticeButtons)if(!visible.has(key)){button.remove();noticeButtons.delete(key);}
      }
    };
    if (document.body) paint(); else document.addEventListener('DOMContentLoaded', paint, {once: true});
  };
  const setFailed = value => { failed = value; notice(); };

  function legacyValues() {
    const legacy = {};
    if (read(marker) !== '1') {
      for (const key of keys) {
        const value = read(key);
        if (value !== null && !Object.hasOwn(pending, key) && validLegacy(key, value)) legacy[key] = value;
      }
      for (const [name, key] of Object.entries(lists)) {
        const saved = parse(read(key), {});
        for (const field of listFields) {
          const value = field === 'lanes' && !Array.isArray(saved?.lanes) && typeof saved?.lane === 'string' ? [saved.lane] : saved?.[field];
          const valid = field === 'window' ? ['1d','7d','30d','all'].includes(value) :
            field === 'order' ? ['newest','oldest','severity','class'].includes(value) :
            ['nav','hideNa'].includes(field) ? typeof value === 'boolean' :
            Array.isArray(value) && value.length <= 100 && value.every(v => typeof v === 'string' && v.length <= 200);
          const storeKey = `list.${name}.${field}`;
          if (valid && !Object.hasOwn(pending, storeKey)) legacy[storeKey] = JSON.stringify(value);
        }
      }
      const old = parse(read(terminalKey), {});
      for (const field of fields) {
        const v = old?.[field];
        if ((['copyOnSelect', 'ctrlCCopy', 'ctrlVPaste'].includes(field) && typeof v === 'boolean') ||
            (field === 'dock' && ['bottom', 'top', 'left', 'right'].includes(v)) ||
            (field === 'shortcut' && v && typeof v === 'object' && ['ctrl', 'alt', 'shift'].every(k => typeof v[k] === 'boolean') && typeof v.code === 'string' && v.code.length <= 16)) {
          if (!Object.hasOwn(pending, `terminal.${field}`)) legacy[`terminal.${field}`] = field === 'dock' ? v : JSON.stringify(field === 'shortcut' ? {ctrl:v.ctrl, alt:v.alt, shift:v.shift, code:v.code} : v);
        }
      }
    }
    return legacy;
  }
  const legacy = legacyValues();
  function hydrate(snapshot) {
    if (!snapshot.preferences || typeof snapshot.preferences !== 'object' || Array.isArray(snapshot.preferences)) throw new Error('missing preferences');
    const server = {...snapshot.preferences}, revisions = {...snapshot.revisions};
    if (!snapshot.revisions || typeof snapshot.revisions !== 'object') throw new Error('missing revisions');
    // An older GET may arrive after a successful POST. Never move a key's
    // observed revision backwards or repaint it with that older response.
    for (const key of allowed) if ((observed?.[key] || 0) > (revisions[key] || 0) && Object.hasOwn(serverCache,key)) {
      revisions[key]=observed[key]; server[key]=serverCache[key];
    }
    observed = revisions; serverCache=server;
    put(revisionsKey, JSON.stringify(observed));
    for (const key of keys) if (Object.hasOwn(server, key) && !Object.hasOwn(pending, key)) put(key, server[key]);
    for (const [name, key] of Object.entries(lists)) {
      const existing = parse(read(key), {});
      const value = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
      for (const field of listFields) {
        const storeKey = `list.${name}.${field}`;
        const raw = Object.hasOwn(pending, storeKey) ? pending[storeKey] : server[storeKey];
        if (raw !== undefined) value[field] = parse(raw, value[field]);
      }
      put(key, JSON.stringify(value));
    }
    const terminal = parse(read(terminalKey), {});
    for (const field of fields) {
      const key = `terminal.${field}`;
      const raw = Object.hasOwn(pending, key) ? pending[key] : server[key];
      if (raw !== undefined) terminal[field] = field === 'dock' ? raw : parse(raw, terminal[field]);
    }
    put(terminalKey, JSON.stringify(terminal));
    for (const key of keys) if (Object.hasOwn(pending, key)) put(key, pending[key]);
    if (conflicts.size || cacheFailed) setFailed(true);
  }
  let initial;
  try { initial=JSON.parse(document.getElementById('preferences-snapshot')?.textContent || 'null'); if(initial?.error)throw new Error('unavailable'); hydrate(initial); }
  catch { readFailed=true; setFailed(true); }

  function removeOwnedRecord(id,key) {
    if(!id)return;
    try {
      const record=parse(localStorage.getItem(id),null);
      if(record?.owner===owner && record.key===key)localStorage.removeItem(id);
    } catch {cacheFailed=true;}
  }
  function retireSuperseded(key) {
    for(const id of superseded.get(key) || []) removeOwnedRecord(id,key);
    superseded.delete(key);
  }
  function noteRetained(key) {
    try {
      const retained=Object.keys(localStorage).some(id=>{
        if(!id.startsWith(recordPrefix))return false;
        const record=parse(localStorage.getItem(id),null);
        return record?.owner===owner && record.key===key;
      }) || localStorage.getItem(pendingPrefix+key)!==null;
      if(retained)uncertain.add('retained:'+key); else uncertain.delete('retained:'+key);
    } catch {cacheFailed=true;}
  }

  async function flush() {
    const key = Object.keys(pending).find(k => !conflicts.has(k));
    if (inflight || migrating || !key || !ownerClaimed) return;
    if (!Number.isSafeInteger(pendingBases[key])) { conflicts.add(key); setFailed(true); return; }
    inflight = true; if(failed)notice();
    const value = pending[key], base = pendingBases[key], id = pendingIds[key];
    const controller=new AbortController(), timeout=setTimeout(()=>controller.abort(),3000);
    let retryImmediately = true;
    try {
      if(id){submitted.add(id);rejected.delete(id);}
      const response = await fetch('/api/user-preferences', {method: 'POST', signal:controller.signal, headers: {'Content-Type': 'application/json', 'X-Requested-With': 'Bounty-Board'}, body: JSON.stringify({set: {[key]:value}, expected: {[key]:base}})});
      if (response.status === 409) {
        if(id && !uncertain.has(id)) {
          rejected.add(id);
          if(pendingIds[key]!==id && created.has(id)) {
            if(!superseded.has(key))superseded.set(key,new Set());
            superseded.get(key).add(id);
          }
        }
        conflicts.add(key); setFailed(true); return;
      }
      if (!response.ok) throw new Error('save failed');
      const result = await response.json();
      if(id)uncertain.delete(id);
      observed = {...observed, [key]:result.revisions[key]};
      serverCache[key]=value;
      put(revisionsKey, JSON.stringify(observed));
      removeOwnedRecord(id,key);
      if (pendingIds[key] === id && pending[key] === value) {
        delete pending[key]; delete pendingBases[key]; delete pendingIds[key]; delete pendingStamps[key];
        retireSuperseded(key);
        try { if (!id && read(pendingPrefix + key) === value) { localStorage.removeItem(pendingPrefix + key); localStorage.removeItem(pendingBasePrefix + key); } } catch {}
        noteRetained(key);
      } else {
        pendingBases[key] = observed[key];
        if (pendingIds[key]) put(pendingIds[key], JSON.stringify({owner,key,value:pending[key],base:observed[key],stamp:pendingStamps[key]}));
      }
      setFailed(readFailed || cacheFailed || ownershipFailed || uncertain.size>0 || conflicts.size > 0 || (failed && Object.keys(pending).length>0));
    } catch { if(id)uncertain.add(id); retryImmediately = false; setFailed(true); }
    finally { clearTimeout(timeout); inflight = false; if(failed)notice(); }
    if (retryImmediately && !readFailed && Object.keys(pending).some(k => !conflicts.has(k))) flush();
  }
  function set(key, value) {
    if (!allowed.has(key) || typeof value !== 'string') return;
    memory.set(key,value);
    const prior=pendingIds[key];
    if(prior && created.has(prior) && (!submitted.has(prior) || rejected.has(prior))) {
      if(!superseded.has(key))superseded.set(key,new Set());
      superseded.get(key).add(prior);
    }
    if (!Object.hasOwn(pending, key)) {
      if (!readFailed && observed && typeof observed === 'object') {
        pendingBases[key] = observed[key] || 0;
      } else conflicts.add(key);
    }
    pending[key] = value;
    const id=recordPrefix+crypto.randomUUID(); pendingIds[key]=id; created.add(id);
    pendingStamps[key]=nextStamp=Math.max(nextStamp+1,Date.now()*1000);
    if (!put(id,JSON.stringify({owner,key,value,base:pendingBases[key] ?? null,stamp:pendingStamps[key]}))) setFailed(true);
    if (conflicts.has(key)) setFailed(true);
    flush();
  }
  async function resolveChoice(key) {
    if(!conflicts.has(key) || !Object.hasOwn(pending,key) || inflight || migrating || readFailed || !ownerClaimed || ownershipFailed)return;
    const id=pendingIds[key], value=pending[key];
    const unchanged=()=>pendingIds[key]===id && pending[key]===value && conflicts.has(key);
    inflight=true; notice();
    const controller=new AbortController(), timeout=setTimeout(()=>controller.abort(),3000);
    let attempted=false;
    try {
      const readResponse=await fetch('/api/user-preferences',{signal:controller.signal});
      if(!readResponse.ok)throw new Error('preferences unavailable');
      const snapshot=await readResponse.json();
      if(!snapshot.revisions || typeof snapshot.revisions!=='object')throw new Error('missing revisions');
      const base=snapshot.revisions[key] || 0;
      if(!Number.isSafeInteger(base) || base<0)throw new Error('invalid revision');
      if(!unchanged())return;
      if(id){submitted.add(id);rejected.delete(id);}
      attempted=true;
      const response=await fetch('/api/user-preferences',{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json','X-Requested-With':'Bounty-Board'},body:JSON.stringify({set:{[key]:value},expected:{[key]:base}})});
      if(response.status===409){
        if(id && !uncertain.has(id)){
          rejected.add(id);
          if(pendingIds[key]!==id && created.has(id)) {
            if(!superseded.has(key))superseded.set(key,new Set());
            superseded.get(key).add(id);
          }
        }
        setFailed(true);return;
      }
      if(!response.ok)throw new Error('save failed');
      const result=await response.json();
      if(id)uncertain.delete(id);
      observed={...observed,[key]:result.revisions[key]}; serverCache[key]=value;
      put(revisionsKey,JSON.stringify(observed)); removeOwnedRecord(id,key);
      if(unchanged()) {
        delete pending[key]; delete pendingBases[key]; delete pendingIds[key]; delete pendingStamps[key];
        conflicts.delete(key); retireSuperseded(key);
        noteRetained(key);
      }
      setFailed(readFailed || cacheFailed || ownershipFailed || uncertain.size>0 || conflicts.size>0 || (failed && Object.keys(pending).length>0));
    } catch {if(id && attempted)uncertain.add(id);setFailed(true);}
    finally {clearTimeout(timeout);inflight=false;if(failed)notice();}
    if(!readFailed && Object.keys(pending).some(k=>!conflicts.has(k)))flush();
  }
  async function refresh() {
    if (refresh.busy) return;
    refresh.busy=true;
    try {
      async function jsonRequest(options={}) {
        const controller=new AbortController(), timeout=setTimeout(()=>controller.abort(),3000);
        try {
          const response=await fetch('/api/user-preferences',{...options,signal:controller.signal});
          if(!response.ok)throw new Error('preferences unavailable');
          return await response.json();
        } finally {clearTimeout(timeout);}
      }
      let snapshot=await jsonRequest();
      if(read(marker)!=='1') {
        const migrate=Object.fromEntries(Object.entries(legacy).filter(([key])=>!Object.hasOwn(pending,key)));
        if(Object.keys(migrate).length) {
          const bases={...observed}; migrating=true; if(failed)notice();
          try {
            snapshot=await jsonRequest({method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'Bounty-Board'},body:JSON.stringify({migrate})});
            if(!Array.isArray(snapshot.migrated))throw new Error('missing migration receipt');
            for(const key of snapshot.migrated) if(Object.hasOwn(pending,key) && pendingBases[key]===(bases[key] || 0)) {
              pendingBases[key]=snapshot.revisions[key];
              if(pendingIds[key])put(pendingIds[key],JSON.stringify({owner,key,value:pending[key],base:pendingBases[key],stamp:pendingStamps[key]}));
            }
          } finally {migrating=false; if(failed)notice();}
        }
        put(marker,'1');
      }
      hydrate(snapshot); readFailed=false;
      setFailed(cacheFailed || ownershipFailed || uncertain.size>0 || conflicts.size>0 || (failed && Object.keys(pending).length>0));
      window.dispatchEvent(new Event('board-preferences-ready'));
      flush();
    } catch { readFailed=true; setFailed(true); }
    finally { refresh.busy=false; }
  }
  window.BoardPreferences = Object.freeze({set, get:read, cache:put, hasPending:()=>Object.keys(pending).length>0, terminal: (field, value) => set(`terminal.${field}`, field === 'dock' ? value : JSON.stringify(value)),
    list: (name, field, value) => set(`list.${name}.${field}`, JSON.stringify(value))});
  async function claimOwner() {
    let acquired=null;
    if(navigator.locks) acquired=await new Promise(resolve=>{
      navigator.locks.request('bounty-board-preferences:'+owner,{ifAvailable:true},async lock=>{
        resolve(!!lock); if(lock)await new Promise(()=>{});
      }).catch(()=>resolve(null));
    });
    if(acquired===null) {
      ownershipFailed=Object.values(pendingIds).some(id=>id && !created.has(id));
      if(ownershipFailed){setFailed(true);return;}
    }
    if(acquired===false) {
      owner=crypto.randomUUID();
      try { sessionStorage.setItem(ownerKey,owner); } catch { cacheFailed=true; }
      for(const key of Object.keys(pending)) {
        const id=pendingIds[key];
        if(id && !created.has(id)) {delete pending[key];delete pendingIds[key];delete pendingBases[key];delete pendingStamps[key];conflicts.delete(key);}
        else if(id) put(id,JSON.stringify({owner,key,value:pending[key],base:pendingBases[key] ?? null,stamp:pendingStamps[key]}));
      }
      if(initial?.preferences) {hydrate(initial);window.dispatchEvent(new Event('board-preferences-ready'));}
      if(cacheFailed)setFailed(true);
    }
    ownerClaimed=true;
    if(failed)notice();
    flush();
  }
  window.addEventListener('online', () => { if(readFailed)refresh(); else flush(); });
  setInterval(() => { if(readFailed)refresh(); else if (failed) flush(); }, 10000);
  claimOwner();
  refresh();
})();
