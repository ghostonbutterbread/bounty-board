(() => {
  'use strict';
  const app = document.querySelector('#app');
  const themeButton = document.querySelector('#theme-button');
  const state = {showArchived:(()=>{try{return localStorage.getItem('bounty-board-show-archived')==='true';}catch{return false;}})(), data:null, view:'dashboard', dashboardProgram:'', section:'findings', program:'', lane:'', filters:{severity:[],class:[],status:[],submission:[],query:''}, report:'', drafts:new Map(), loading:true, error:'', metadataPending:false, metadataErrors:[], metadataDrafts:new Map(), rationaleDrafts:new Map(),
    // Presentation state (UI redesign): persisted sort, dashboard work filter,
    // expanded breakdown row, program search, how the program was chosen.
    sort:{key:'',dir:'asc'}, dashWork:'all', dashExpanded:'', programQuery:'', programOrigin:'default', highlight:''};
  const sections = [['findings','Findings'],['coverage','Coverage'],['reports','Reports'],['map','MapStore'],['gadgets','Gadgets']];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const metadataFailure = error => error.code==='finding_changed' ? 'Conflict: finding changed.' : error.code==='root_changed' ? 'Conflict: source root changed.' : error.code==='finding_not_found' ? 'Finding is no longer available.' : 'Update failed or was not verified.';
  const display = value => value == null || value === '' ? 'Unknown' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  const list = value => Array.isArray(value) ? value : null;
  const programs = () => list(state.data?.programs) || [];
  const currentProgram = () => programs().find(p => String(p.id) === state.program);
  const currentLane = () => (list(currentProgram()?.lanes) || []).find(l => String(l.name) === state.lane);
  const rows = key => {
    const value=currentLane()?.[key];
    return list(key==='coverage' && value && !Array.isArray(value) ? value.items : value);
  };
  const reportsIncomplete = lane => (list(lane?.warnings)||[]).some(w=>typeof w==='string' && w.startsWith('reports_'));
  const reportWarning = warning => typeof warning==='string' && (warning.startsWith('reports_') || warning.startsWith('report_content_'));
  const mergeWarnings = (...groups) => [...new Set(groups.flat())];
  // Unknown instances are scoped to the current loaded snapshot, never to a
  // different refresh. Existing drafts from them remain copy-only afterward.
  const rationaleKey = (program,lane,id) => JSON.stringify([/^[a-f0-9]{64}$/.test(state.data?.root_instance || '') ? ['instance',state.data.root_instance] : ['unidentified',state.unidentifiedRoot],program,lane,String(id)]);
  const reportById = id => (rows('reports') || []).find(r => String(r.id) === String(id));
  // Module navigation seam (ctx.navigate, used by search and other modules).
  // Validates the target, then goes through the one app navigate() so the URL
  // hash, back/forward, laneGeneration, filter reset and highlight all apply.
  // {finding} opens Findings with that row highlighted (filters cleared);
  // {report} opens Reports on it. Returns false for an unknown target.
  function moduleNavigate(target={}) {
    if(!target || typeof target!=='object' || !state.data)return false;
    if(target.view==='dashboard'){navigate({view:'dashboard'});return true;}
    const wanted=target.program==null ? state.program : String(target.program);
    const program=programs().find(p=>String(p.id)===wanted);if(!program)return false;
    const lanes=list(program.lanes)||[];
    if(target.lane!=null && !lanes.some(l=>String(l.name)===String(target.lane)))return false;
    const section=target.section!=null ? String(target.section) : target.finding!=null ? 'findings' : target.report!=null ? 'reports' : undefined;
    if(section!=null && !sections.some(([key])=>key===section))return false;
    if(target.finding!=null)state.filters=emptyFilters();
    navigate({view:'program',program:wanted,lane:target.lane!=null ? String(target.lane) : undefined,section,report:target.report!=null ? String(target.report) : undefined,highlight:target.finding!=null ? String(target.finding) : (target.highlight ?? '')});
    return true;
  }
  // Feature modules (static/modules/*.js) push {name, afterRender(ctx)} onto
  // window.BoardModules and mount into host elements after every render.
  const moduleContext = () => ({app, state, esc, markdown, display, programs, currentProgram, currentLane, rows, reportById, render, navigate:moduleNavigate, hrefFor, api:window.BoardAPI, ui:window.BoardUI, reload:()=>load(), reportIdFor});
  // ---- Real links (feat/board-report-links-recent) ----
  // Every in-app destination is an <a href> in the hash route format, so
  // middle-click, Ctrl/Cmd/Shift+click and "Open link in new tab" work
  // natively. hrefFor(target) takes the ctx.navigate target shape and returns
  // exactly what routeFor() produces for that view; a finding adds
  // /findings/<id>, which parseRoute() turns into the row highlight.
  function hrefFor(target={}) {
    if(!target || typeof target!=='object' || target.view==='dashboard')return '#/dashboard';
    if(target.view==='recent')return recentRoute(target.query);
    if(target.view==='recon')return reconRoute(target.query);
    const program=target.program==null ? state.program : String(target.program);
    if(!program)return '#/programs';
    const lane=target.lane!=null ? String(target.lane) : program===state.program ? state.lane : String((list(programs().find(p=>String(p.id)===program)?.lanes)||[])[0]?.name ?? '');
    const section=target.section!=null ? String(target.section) : target.report!=null ? 'reports' : 'findings';
    const tail=section==='reports' && target.report!=null ? '/'+encodeURIComponent(String(target.report)) : section==='findings' && target.finding!=null ? '/'+encodeURIComponent(String(target.finding)) : '';
    return `#/programs/${encodeURIComponent(program)}/${encodeURIComponent(lane)}/${section}${tail}`;
  }
  // Plain left clicks on in-app links stay in the page (no reload) and go
  // through the one navigate(); modified clicks, other buttons, links with a
  // target and clicks a module already handled are left to the browser.
  function openRoute(route) {
    if(route.view!=='program'){navigate(route);return true;}
    const ok=moduleNavigate({program:route.program || undefined,lane:route.lane || undefined,section:route.section,report:route.report || undefined,finding:route.highlight || undefined});
    if(!ok)toast('That item is not in the loaded data. Refresh the board and try again.','warning');
    return ok;
  }
  document.addEventListener('click',event=>{
    if(event.defaultPrevented || event.button!==0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !state.data)return;
    const link=event.target.closest?.('a[href^="#/"]');
    if(!link || (link.target && link.target!=='_self') || link.hasAttribute('download'))return;
    const route=parseRoute(link.getAttribute('href'));if(!route)return;
    event.preventDefault();openRoute(route);
  });
  // Relative modification time ("5 min ago"); callers put the absolute time in a title.
  function relativeTime(seconds, now=Date.now()/1000) {
    if(typeof seconds!=='number' || !Number.isFinite(seconds))return '';
    const d=Math.max(0,now-seconds);
    if(d<60)return 'just now';
    if(d<3600)return `${Math.floor(d/60)} min ago`;
    if(d<86400)return `${Math.floor(d/3600)} h ago`;
    if(d<86400*30)return `${Math.floor(d/86400)} d ago`;
    return new Date(seconds*1000).toISOString().slice(0,10);
  }
  const absoluteTime = seconds => typeof seconds==='number' && Number.isFinite(seconds) ? new Date(seconds*1000).toLocaleString() : '';
  // Taxonomy seam (static/modules/taxonomy.js): display-time labels only; the raw
  // class and severity stay as recorded and remain what filters and edits use.
  const taxonomy = () => window.BoardTaxonomy?.ready?.() ? window.BoardTaxonomy : null;
  const classNote = row => {
    const t = taxonomy(); if (!t || row.class == null || row.class === '') return '';
    const c = t.normalizeClass(row.class);
    return `<span class="cell-note" data-class-category="${esc(c.category)}">${c.category==='unclassified' ? 'Category: Unclassified' : `Category: ${esc(c.label)}${c.confidence==='low' ? ' (low confidence)' : ''}`}</span>`;
  };
  const severityNote = row => {
    const t = taxonomy(); if (!t || row.severity == null || row.severity === '') return '';
    const s = t.normalizeSeverity(row.severity);
    return s.kind === 'canonical' ? '' : `<span class="cell-note" data-severity-note="${esc(s.kind)}">Shown as ${esc(s.value)}${s.note ? `. ${esc(s.note)}` : ''}</span>`;
  };
  window.BoardModules = window.BoardModules || [];
  window.registerBoardModule = module => {window.BoardModules.push(module);try{module.afterRender?.(moduleContext());}catch(error){console.error('Board module failed:',module?.name,error);}};
  // ---- Presentation helpers (severity scale, badges, submission state) ----
  const SEVERITY_LEVELS=['exceptional','critical','high','medium','low','info','na','unknown'];
  const SEVERITY_LABELS={exceptional:'Exceptional',critical:'Critical',high:'High',medium:'Medium',low:'Low',info:'Info',na:'N/A',unknown:'Unknown'};
  const sevKey = value => {
    const raw=String(value ?? '').trim().toLowerCase();
    if(!raw) return 'unknown';
    if(['n/a','na','n.a.','not_applicable','not applicable','none'].includes(raw)) return 'na';
    if(raw==='informational') return 'info';
    return SEVERITY_LEVELS.includes(raw) ? raw : 'unknown';
  };
  const sevRank = value => SEVERITY_LEVELS.indexOf(sevKey(value));
  const sevBadge = value => `<span class="sev" data-sev="${sevKey(value)}">${esc(value == null || value === '' ? 'Not recorded' : String(value))}</span>`;
  const STATUS_TONES={confirmed:'success',complete:'success',novel:'accent',raw:'',dormant:'outline',archive:'outline'};
  const statusBadge = value => value == null || value === '' ? '' : `<span class="badge ${STATUS_TONES[String(value).toLowerCase()] ?? ''}">${esc(value)}</span>`;
  // BBH submission records default to not_submitted; legacy ledgers may carry
  // submission_status. Unrecognized states are treated as submitted work.
  const NOT_SUBMITTED=new Set(['','not_submitted','not submitted','unsubmitted','draft','none']);
  const submissionState = finding => {
    const nested=finding?.submission?.state;
    const value=nested != null && nested !== '' ? nested : finding?.submission_status;
    return String(value ?? '').trim().toLowerCase();
  };
  const isNotSubmitted = finding => NOT_SUBMITTED.has(submissionState(finding));
  const submissionLabel = finding => {const s=submissionState(finding);return NOT_SUBMITTED.has(s) ? 'Not submitted' : s.replace(/_/g,' ');};
  const submissionBadge = finding => {
    const s=submissionState(finding), result=finding?.submission?.result || finding?.platform_outcome;
    const tone=NOT_SUBMITTED.has(s) ? 'outline' : s==='dropped' ? 'outline' : 'accent';
    return `<span class="badge ${tone}">${esc(submissionLabel(finding))}</span>${result ? ` <span class="badge ${String(result).toLowerCase()==='valid'?'success':String(result).toLowerCase()==='duplicate'?'warning':''}">${esc(result)}</span>` : ''}`;
  };
  const icon = name => `<i class="fa fa-${name}" aria-hidden="true"></i>`;
  // Finding actions (static/modules/finding-actions.js): "Delete" archives a
  // finding (status archive). Archived findings are hidden from dashboard
  // counts/lists and the Findings table unless "Show archived" is on.
  const isArchived = finding => ['archive','archived'].includes(String(finding?.status ?? '').trim().toLowerCase());
  const shownFinding = finding => state.showArchived || !isArchived(finding);
  const archiveToggle = count => `<label class="archive-toggle"><input type="checkbox" data-show-archived ${state.showArchived?'checked':''}><span>Show archived</span><span class="badge outline" data-archived-count>Archived ${count}</span></label>`;
  // Hook for finding-actions pickers: a badge wrapped in a button when the module is loaded.
  const pickButton = (kind, label, inner) => window.BoardFindingActions ? `<button type="button" class="pick-trigger" data-${kind}-pick aria-haspopup="menu" aria-expanded="false" aria-label="${esc(label)}">${inner}</button>` : inner;
  const programLabel = p => p ? String(p.name || p.id || 'Unknown program') : 'Unknown program';
  const readStore = (key,fallback) => {try {const raw=localStorage.getItem(key);return raw==null ? fallback : JSON.parse(raw);} catch {return fallback;}};
  const writeStore = (key,value) => {try {localStorage.setItem(key,JSON.stringify(value));} catch {}};

  // ---- BoardUI: shared UI primitives for the app and feature modules ----
  const uiLayer=document.querySelector('#ui-layer') || document.body.appendChild(Object.assign(document.createElement('div'),{id:'ui-layer'}));
  const toastBox=document.querySelector('#toasts') || document.body.appendChild(Object.assign(document.createElement('div'),{id:'toasts',className:'toasts'}));
  function toast(message, kind='info', options={}) {
    const el=document.createElement('div');el.className=`toast ${['success','warning','danger','info'].includes(kind)?kind:'info'}`;
    const icons={success:'check-circle',warning:'exclamation-triangle',danger:'exclamation-circle',info:'info-circle'};
    el.innerHTML=`${icon(icons[kind]||icons.info)}<span class="toast-text"></span><button type="button" aria-label="Dismiss notification">${icon('times')}</button>`;
    el.querySelector('.toast-text').textContent=String(message);
    const remove=()=>el.remove();el.querySelector('button').addEventListener('click',remove);
    toastBox.append(el);while(toastBox.children.length>4)toastBox.firstElementChild.remove();
    const timeout=options.timeout ?? (kind==='danger' ? 8000 : 4500);
    if(timeout>0)setTimeout(remove,timeout);
    return el;
  }
  let popover=null;
  function placePopover(el, anchor, align='start') {
    const r=anchor.getBoundingClientRect(), w=el.offsetWidth, h=el.offsetHeight, vw=document.documentElement.clientWidth, vh=window.innerHeight;
    let left=align==='end' ? r.right-w : r.left, top=r.bottom+4;
    if(left+w>vw-8)left=vw-8-w; if(left<8)left=8;
    if(top+h>vh-8 && r.top-h-4>8)top=r.top-h-4;
    el.style.left=`${Math.round(left)}px`;el.style.top=`${Math.round(top)}px`;
  }
  function closePopover(restoreFocus=true) {
    if(!popover)return;
    const {el,trigger,onClose}=popover;popover=null;el.remove();
    if(trigger?.isConnected){trigger.setAttribute('aria-expanded','false');if(restoreFocus)trigger.focus();}
    onClose?.();
  }
  // Opens content anchored to trigger. reanchor() re-finds the trigger after a
  // full render so a popover (for example a multi-select filter) can stay open.
  function openPopover(trigger, content, options={}) {
    closePopover(false);
    const el=document.createElement('div');el.className=`popover ${options.className||''}`;
    if(options.label)el.setAttribute('aria-label',options.label);
    el.append(content);uiLayer.append(el);
    popover={el,trigger,reanchor:options.reanchor,onClose:options.onClose,align:options.align};
    trigger.setAttribute('aria-expanded','true');
    placePopover(el,trigger,options.align);
    el.addEventListener('keydown',event=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closePopover(true);}
      else if(event.key==='Tab' && !options.trapTab){event.preventDefault();closePopover(true);}
    });
    return el;
  }
  function reanchorPopover() {
    if(!popover)return;
    const next=popover.reanchor?.();
    if(!next){closePopover(false);return;}
    popover.trigger=next;next.setAttribute('aria-expanded','true');placePopover(popover.el,next,popover.align);
  }
  function menuKeys(container, selector) {
    container.addEventListener('keydown',event=>{
      const items=[...container.querySelectorAll(selector)].filter(el=>!el.disabled);
      const index=items.indexOf(document.activeElement);
      let next=null;
      if(event.key==='ArrowDown')next=items[(index+1)%items.length];
      else if(event.key==='ArrowUp')next=items[(index-1+items.length)%items.length];
      else if(event.key==='Home')next=items[0];
      else if(event.key==='End')next=items[items.length-1];
      else if(event.key.length===1 && /\S/.test(event.key)){
        const ordered=[...items.slice(index+1),...items.slice(0,index+1)];
        next=ordered.find(el=>el.textContent.trim().toLowerCase().startsWith(event.key.toLowerCase()));
      }
      if(next){event.preventDefault();next.focus();}
    });
  }
  // items: [{label, icon, onSelect, checked, disabled, danger, separator, heading}]
  function openMenu(trigger, items, options={}) {
    const menu=document.createElement('div');menu.className='menu';menu.setAttribute('role','menu');
    if(options.label)menu.setAttribute('aria-label',options.label);
    for(const item of items){
      if(item.separator){const sep=document.createElement('div');sep.className='menu-sep';sep.setAttribute('role','separator');menu.append(sep);continue;}
      if(item.heading){const h=document.createElement('div');h.className='menu-label';h.textContent=item.heading;h.setAttribute('role','presentation');menu.append(h);continue;}
      const button=document.createElement('button');button.type='button';
      button.setAttribute('role',typeof item.checked==='boolean' ? 'menuitemradio' : 'menuitem');
      if(typeof item.checked==='boolean')button.setAttribute('aria-checked',String(item.checked));
      button.disabled=!!item.disabled;if(item.danger)button.classList.add('danger');
      button.innerHTML=`${item.icon?icon(item.icon):''}<span></span>${typeof item.checked==='boolean'?icon('check')+'':''}`;
      button.querySelector('span').textContent=item.label;
      button.querySelector('.fa-check')?.classList.add('check');
      button.addEventListener('click',()=>{closePopover(true);item.onSelect?.();});
      menu.append(button);
    }
    menuKeys(menu,'[role^="menuitem"]');
    openPopover(trigger,menu,{...options,className:'menu-popover'});
    (menu.querySelector('[aria-checked="true"]:not(:disabled)') || menu.querySelector('[role^="menuitem"]:not(:disabled)'))?.focus();
    return menu;
  }
  // Coloured value pills in a popover (severity, submission, status pickers).
  // groups: [{label?, options:[{value, label, sev?, tone?, disabled?, title?}]}].
  // Arrow keys move, Enter/Space pick, Escape/Tab close and focus returns.
  function openPills(trigger, {label, groups, current, note='', disabledHint='', onPick, onClose}) {
    const box=document.createElement('div');box.className='pill-box';
    const menu=document.createElement('div');menu.className='pills';menu.setAttribute('role','menu');menu.setAttribute('aria-label',label);
    for(const group of groups){
      if(group.label){const h=document.createElement('div');h.className='menu-label';h.setAttribute('role','presentation');h.textContent=group.label;menu.append(h);}
      const row=document.createElement('div');row.className='pill-row';
      for(const option of group.options){
        const b=document.createElement('button');b.type='button';b.setAttribute('role','menuitemradio');
        const on=option.value===current || (Array.isArray(current) && current.includes(option.value));
        b.setAttribute('aria-checked',String(on));b.className=`pill ${option.sev?'sev':`badge ${option.tone||''}`}`;
        if(option.sev)b.dataset.sev=option.sev;b.dataset.value=option.value;b.disabled=!!disabledHint || !!option.disabled;
        if(option.title)b.title=option.title;
        b.innerHTML=`${on?icon('check'):''}<span></span>`;b.querySelector('span').textContent=option.label;
        b.addEventListener('click',()=>{closePopover(true);onPick(option);});
        row.append(b);
      }
      menu.append(row);
    }
    box.append(menu);
    if(note || disabledHint){const n=document.createElement('p');n.className=`hint pill-note${disabledHint?' warning':''}`;n.textContent=disabledHint || note;box.append(n);}
    menu.addEventListener('keydown',event=>{
      const items=[...menu.querySelectorAll('[role=menuitemradio]:not(:disabled)')], i=items.indexOf(document.activeElement);let next=null;
      if(event.key==='ArrowRight' || event.key==='ArrowDown')next=items[(i+1)%items.length];
      else if(event.key==='ArrowLeft' || event.key==='ArrowUp')next=items[(i-1+items.length)%items.length];
      else if(event.key==='Home')next=items[0];else if(event.key==='End')next=items[items.length-1];
      if(next){event.preventDefault();next.focus();}
    });
    openPopover(trigger,box,{label,className:'pill-popover',reanchor:()=>null,onClose});
    const first=menu.querySelector('[aria-checked="true"]:not(:disabled)') || menu.querySelector('[role=menuitemradio]:not(:disabled)');
    if(first)first.focus();else{box.tabIndex=-1;box.focus();}
    return box;
  }
  const SEVERITY_PILL_TITLES={INFO:'Informational (INFO)'};
  // Severity pills for a finding: BBH order, current value checked. Values come
  // from the write capability; N/A is shown but BBH stores it as UNKNOWN.
  function severityOptions(values) {
    return values.map(v=>{const k=sevKey(v), canonical=String(v).toUpperCase()===String(v) && k!=='unknown' || String(v)==='UNKNOWN';return {value:String(v),label:canonical?SEVERITY_LABELS[k]:String(v),sev:k,title:SEVERITY_PILL_TITLES[v]||''};});
  }
  document.addEventListener('mousedown',event=>{
    if(popover && !popover.el.contains(event.target) && !popover.trigger?.contains(event.target))closePopover(false);
  });
  window.addEventListener('resize',()=>{if(popover)placePopover(popover.el,popover.trigger,popover.align);});
  document.addEventListener('scroll',event=>{if(popover && !popover.el.contains(event.target))placePopover(popover.el,popover.trigger,popover.align);},true);

  // Visual tooltips for [data-tip] and truncated .truncate text. The full text
  // is already in the accessible tree; the tooltip only reveals it visually.
  let tipTimer=0, tipEl=null;
  function hideTip(){clearTimeout(tipTimer);tipEl?.remove();tipEl=null;}
  function showTip(target){
    const text=target.dataset.tip || (target.classList.contains('truncate') && (target.scrollWidth>target.clientWidth || target.scrollHeight>target.clientHeight+1) ? target.textContent : '');
    if(!text?.trim())return;
    hideTip();tipTimer=setTimeout(()=>{
      if(!target.isConnected)return;
      tipEl=document.createElement('div');tipEl.className='tooltip';tipEl.setAttribute('role','tooltip');tipEl.textContent=text.trim();uiLayer.append(tipEl);
      const r=target.getBoundingClientRect(), w=tipEl.offsetWidth, h=tipEl.offsetHeight, vw=document.documentElement.clientWidth;
      let top=r.top-h-6;if(top<6)top=r.bottom+6;
      tipEl.style.left=`${Math.round(Math.max(8,Math.min(vw-w-8,r.left+r.width/2-w/2)))}px`;tipEl.style.top=`${Math.round(top)}px`;
    },350);
  }
  document.addEventListener('mouseover',event=>{const t=event.target.closest?.('[data-tip],.truncate');if(t)showTip(t);});
  document.addEventListener('mouseout',event=>{if(event.target.closest?.('[data-tip],.truncate'))hideTip();});
  document.addEventListener('focusin',event=>{const t=event.target.closest?.('[data-tip]');if(t)showTip(t);else hideTip();});
  document.addEventListener('keydown',event=>{if(event.key==='Escape')hideTip();});
  document.addEventListener('scroll',hideTip,true);

  // Searchable program picker (combobox + listbox). onPick receives a program id.
  function openProgramPicker(trigger, onPick, options={}) {
    const box=document.createElement('div');
    const listId=`program-picker-list-${Date.now()}`;
    box.innerHTML=`<div class="input-icon">${icon('search')}<input type="text" role="combobox" aria-expanded="true" aria-controls="${listId}" aria-autocomplete="list" aria-label="Search programs" placeholder="Search programs and lanes" autocomplete="off" spellcheck="false"></div><div class="listbox" role="listbox" id="${listId}" aria-label="Programs"></div><div class="picker-foot"><span><span class="kbd">↑</span> <span class="kbd">↓</span> to move</span><span><span class="kbd">Enter</span> to open</span><span><span class="kbd">Esc</span> to close</span></div>`;
    const input=box.querySelector('input'), listbox=box.querySelector('.listbox');
    let active=0, matches=[];
    const draw=()=>{
      const q=input.value.trim().toLowerCase();
      matches=programs().filter(p=>!q || [p.id,p.name,p.family,...(list(p.lanes)||[]).map(l=>l.name)].some(v=>String(v??'').toLowerCase().includes(q)));
      active=Math.min(active,Math.max(0,matches.length-1));
      const families=[...new Set(matches.map(p=>p.family || 'Other'))];
      let n=0;
      listbox.innerHTML=matches.length ? families.map(f=>`<div class="group" role="presentation">${esc(f)}</div>`+matches.filter(p=>(p.family||'Other')===f).map(p=>{
        const lanes=list(p.lanes), findings=lanes ? lanes.reduce((sum,l)=>sum+(list(l.findings)?.length||0),0) : null, i=matches.indexOf(p);n++;
        return `<div role="option" id="${listId}-${i}" data-index="${i}" aria-selected="${String(p.id)===options.current}" class="${i===active?'active':''}"><span class="opt-main"><span>${esc(programLabel(p))}</span><span class="opt-sub">${esc(lanes ? lanes.map(l=>l.name).join(', ') || 'No lanes' : 'Lanes unavailable')}</span></span><span class="count">${findings==null?'–':findings}</span></div>`;
      }).join('')).join('') : '<div class="empty" role="presentation">No programs match.</div>';
      input.setAttribute('aria-activedescendant',matches.length ? `${listId}-${active}` : '');
      listbox.querySelector('.active')?.scrollIntoView({block:'nearest'});
    };
    const pick=index=>{const p=matches[index];if(!p)return;closePopover(false);onPick(String(p.id));};
    input.addEventListener('input',()=>{active=0;draw();});
    input.addEventListener('keydown',event=>{
      if(event.key==='ArrowDown'){event.preventDefault();active=Math.min(matches.length-1,active+1);draw();}
      else if(event.key==='ArrowUp'){event.preventDefault();active=Math.max(0,active-1);draw();}
      else if(event.key==='Home' && event.ctrlKey){active=0;draw();}
      else if(event.key==='Enter'){event.preventDefault();pick(active);}
    });
    listbox.addEventListener('mousemove',event=>{const o=event.target.closest('[role=option]');if(o && Number(o.dataset.index)!==active){active=Number(o.dataset.index);draw();}});
    listbox.addEventListener('click',event=>{const o=event.target.closest('[role=option]');if(o)pick(Number(o.dataset.index));});
    draw();
    const selected=matches.findIndex(p=>String(p.id)===options.current);if(selected>=0){active=selected;draw();}
    openPopover(trigger,box,{className:'picker',label:'Switch program',align:options.align});
    input.focus();
    return box;
  }
  // Report artifacts module host for the non-live report views (feat/board-report-artifacts).
  const artifactsHost = report => {const program=currentProgram();return program && report?.path ? `<div id="report-artifacts-host" data-family="${esc(program.family)}" data-program="${esc(program.name)}" data-lane="${esc(state.lane)}" data-path="${esc(report.path)}" data-report-id="${esc(report.id)}"></div>` : '';};
  const reportReadOnly = draft => !!state.data?.capabilities?.collaboration && (typeof draft.source?.collaboration_editable==='boolean' ? !draft.source.collaboration_editable : draft.source?.editable===false);
  let unidentifiedSequence=0;
  let metadataDraftSequence=0;
  let recoveryPathSequence=0;
  const recoveryPaths=new Map();
  const rootIdentity = () => /^[a-f0-9]{64}$/.test(state.data?.root_identity || '') ? state.data.root_identity : null;
  const recoveryPathKey = () => JSON.stringify([rootIdentity(),/^[a-f0-9]{64}$/.test(state.data?.root_instance || '') ? ['instance',state.data.root_instance] : ['unidentified',state.unidentifiedRoot],state.program,state.lane]);
  const validRecoveryPath = path => !!path && !path.startsWith('/') && !path.split('/').some(part=>!part || part==='.' || part==='..');
  const draftKey = (program,lane,id) => JSON.stringify([rootIdentity() || state.unidentifiedRoot,program,lane,String(id)]);
  let tabId, tabReloadRecovery=true, tabLockHeld=false;
  // Cloned sessions may inherit both window.name and sessionStorage, including
  // a reload navigation. An origin-scoped Web Lock arbitrates live ownership.
  // Without Web Locks use a fresh namespace, preferring no overwrite over reload
  // recovery; the browser-local (non-collaboration) namespace is unaffected.
  async function claimTab() {
    const prefix='bounty-board-tab:';
    let candidate, locked=false;
    try {const nav=performance.getEntriesByType('navigation')[0], inherited=nav?.type==='reload' && window.name.startsWith(prefix) ? window.name.slice(prefix.length) : '';
      candidate=inherited && localStorage.getItem('bounty-board-lock-owner:'+inherited)==='locked' ? inherited : crypto.randomUUID();}
    catch {candidate=crypto.randomUUID();}
    if(navigator.locks) {
      for(;;) {
        const id=candidate;
        const acquired=await new Promise(resolve=>{
          navigator.locks.request(prefix+id,{ifAvailable:true},async lock=>{
            if(!lock){resolve(false);return;}
            resolve(true);await new Promise(()=>{});
          }).catch(()=>resolve(null));
        });
        if(acquired===true){locked=true;break;}
        candidate=crypto.randomUUID();if(acquired===null){tabReloadRecovery=false;break;}
      }
    } else {candidate=crypto.randomUUID();tabReloadRecovery=false;}
    tabId=candidate;tabLockHeld=locked;try {window.name=prefix+tabId;} catch {}
  }
  const storageKey = key => `bounty-board-report-draft-v2:${key}${state.data?.capabilities?.collaboration ? ':'+tabId : ''}`;
  // This panel lives outside #app so navigation and editor rerenders cannot
  // hide a draft belonging to an earlier root.
  const recovery=document.createElement('section');
  recovery.id='draft-recovery';recovery.className='panel panel-pad draft-recovery';
  recovery.hidden=true;recovery.setAttribute('aria-label','Draft recovery');
  recovery.setAttribute('aria-live','polite');app.before(recovery);
  const recoveryHeading=document.createElement('h2');recoveryHeading.textContent='Draft recovery';
  const recoveryWarning=document.createElement('p');recoveryWarning.textContent='These drafts may exist only in this tab. Select and copy the text or download it before reloading or leaving. They are not saved to the source report.';
  recovery.append(recoveryHeading,recoveryWarning);
  const recoveryCards=new Map();
  let editor = null;
  function persistDraft(draft) {
    if (draft.storageBlocked || draft.storageUnreadable) return false;
    try {
      const current=localStorage.getItem(storageKey(draft.key));
      if(current!==draft.storageSnapshot){draft.storageBlocked=true;return false;}
      const next=JSON.stringify({version:1,text:draft.text,original:draft.original,revision:draft.revision ?? null,conflict:draft.status==='conflict',conflictId:draft.conflictId ?? null,conflictBase:draft.conflictBase ?? null,staleResolution:!!draft.staleResolution,rejectedResolutions:draft.rejectedResolutions ?? [],hasDraft:draft.hasDraft,pendingShared:draft.pendingShared ?? null,resolutionRejected:draft.resolutionRejected ?? null,inspectRequested:draft.inspectRequested ?? null,publicationNotice:draft.publicationNotice ?? null,publicationDetail:draft.publicationDetail ?? null,reviewedPublications:draft.reviewedPublications ?? []});
      localStorage.setItem(storageKey(draft.key),next);
      if(localStorage.getItem(storageKey(draft.key))!==next){draft.storageBlocked=true;return false;}
      draft.storageSnapshot=next;
      draft.storageError=false;
      return true;
    } catch { draft.storageError=true;return false; }
  }
  function reconcileReport(draft,report) {
    const content=report.content == null ? null : String(report.content), revision=report.revision ?? null;
    if(draft.source===report && draft.observedContent===content && draft.observedRevision===revision)return;
    const changed = (draft.revision != null && revision != null && draft.revision!==revision) || (content!==null && content!==draft.original);
    // Collaborative revisions describe the shared draft, not the source report.
    // The server observes source changes and determines conflicts when saving.
    if(draft.hasDraft && changed && !state.data?.capabilities?.collaboration && draft.status!=='conflict') {draft.status='conflict';persistDraft(draft);}
    else if(!draft.hasDraft && content!==null){if(changed && state.data?.capabilities?.report_autosave)draft.publicationNotice=null;draft.text=content;draft.original=draft.text;draft.revision=report.revision;}
    draft.source=report;draft.observedContent=content;draft.observedRevision=revision;
  }
  const draftFor = report => {
    if(state.data?.capabilities?.collaboration && tabLockHeld){try{localStorage.setItem('bounty-board-lock-owner:'+tabId,'locked');}catch{}}
    const key = draftKey(state.program,state.lane,report.id);
    if (!state.drafts.has(key)) {
      const original=String(report.content ?? '');
      const draft={key,program:state.program,lane:state.lane,id:String(report.id),text:original,revision:report.revision,original,status:'saved',source:report,hasDraft:false,storageBlocked:false,storageError:!rootIdentity(),storageUnreadable:!rootIdentity(),unidentified:!rootIdentity()};
      try {
        const raw=rootIdentity() ? localStorage.getItem(storageKey(key)) : null;
        draft.storageSnapshot=raw;
        if(raw!==null){
          let saved;try {saved=JSON.parse(raw);} catch {}
          if(!saved || saved.version!==1 || typeof saved.text!=='string' || typeof saved.original!=='string' || !(saved.revision===null || typeof saved.revision==='string') || (saved.conflict!==undefined && typeof saved.conflict!=='boolean')) draft.storageBlocked=true;
          else {draft.text=saved.text;draft.original=saved.original;draft.revision=saved.revision;draft.hasDraft=saved.hasDraft!==false;draft.conflictId=saved.conflictId;draft.conflictBase=saved.conflictBase;draft.staleResolution=!!saved.staleResolution;draft.pendingShared=saved.pendingShared || null;draft.publicationNotice=typeof saved.publicationNotice==='string'?saved.publicationNotice:null;draft.publicationDetail=saved.publicationDetail || null;draft.reviewedPublications=Array.isArray(saved.reviewedPublications)?saved.reviewedPublications:[];draft.status=saved.conflict?'conflict':draft.hasDraft?'unsaved':'saved';}
          if(saved?.resolutionRejected===draft.pendingShared?.request_id)draft.resolutionRejected=saved.resolutionRejected;
          if(saved?.inspectRequested && saved.inspectRequested===draft.pendingShared?.request_id)draft.inspectRequested=saved.inspectRequested;
          if(Array.isArray(saved?.rejectedResolutions))draft.rejectedResolutions=saved.rejectedResolutions;
          if(draft.pendingShared && (draft.publicationNotice?.includes('Retrying the exact request') || draft.publicationNotice?.includes('Waiting for the current shared read before retrying')))draft.publicationNotice='Automatic retry stopped on reload. The outcome may be unconfirmed; inspect the original save and retain your draft.';
        }
      } catch {draft.storageError=true;draft.storageUnreadable=true;}
      state.drafts.set(key,draft);
      if(draft.hasDraft && report.content!=null){draft.source=null;reconcileReport(draft,report);}
    }
    const draft=state.drafts.get(key);reconcileReport(draft,report);return draft;
  };
  const hasUnsaved = () => state.metadataPending || state.metadataDrafts.size>0 || recoveryPaths.size>0 || [...state.drafts.values()].some(d => d.hasDraft || d.storageError || d.storageBlocked) || state.rationaleDrafts.size>0;
  window.addEventListener('beforeunload', event => { if (hasUnsaved()) { event.preventDefault(); event.returnValue = ''; } });
  const THEMES=[['light','Light','sun-o'],['dark','Dark','moon-o'],['dusk','Dusk','adjust']];
  function applyTheme(value) {
    if (!THEMES.some(([key])=>key===value)) value = 'light';
    document.documentElement.dataset.theme=value;
    const [,label,glyph]=THEMES.find(([key])=>key===value);
    themeButton.innerHTML=icon(glyph);themeButton.title=`Theme: ${label}`;
    try { localStorage.setItem('bounty-board-theme',value); } catch {}
  }
  try { applyTheme(localStorage.getItem('bounty-board-theme') || 'light'); } catch { applyTheme('light'); }
  themeButton.addEventListener('click', () => openMenu(themeButton,[{heading:'Theme'},...THEMES.map(([key,label,glyph])=>({label,icon:glyph,checked:document.documentElement.dataset.theme===key,onSelect:()=>applyTheme(key)}))],{label:'Theme',align:'end'}));
  // Sidebar items and section tabs are links (middle-click and Ctrl/Cmd+click
  // open a new tab); a plain left click keeps the in-app behaviour.
  const plainClick = event => event.button===0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
  // Hrefs follow the current program route and Recent filters. Modules change
  // the Recent filters without a render, so they are also refreshed just before
  // the pointer or keyboard can use them (hover status, middle-click, menu).
  function syncNavLinks() {
    document.querySelectorAll('[data-view]').forEach(b=>b.setAttribute('href',b.dataset.view==='recent' ? recentRoute(state.recentQuery) : b.dataset.view==='recon' ? reconRoute(state.reconQuery) : b.dataset.view==='program' ? programRoute() : '#/dashboard'));
  }
  for(const type of ['pointerover','pointerdown','focusin','contextmenu'])document.querySelector('.sidebar .nav')?.addEventListener(type,syncNavLinks,true);
  document.querySelectorAll('[data-view]').forEach(link => link.addEventListener('click', event => {if(!plainClick(event))return;event.preventDefault();state.view=link.dataset.view;state.routeNotice='';routePush=true;render();}));
  // Collapsible sidebar (icon rail); the preference persists per browser origin.
  const shell=document.querySelector('#shell'), sidebarToggle=document.querySelector('#sidebar-toggle');
  function setSidebar(collapsed) {
    shell.classList.toggle('sidebar-collapsed',collapsed);sidebarToggle.setAttribute('aria-expanded',String(!collapsed));
    sidebarToggle.title=collapsed?'Expand sidebar':'Collapse sidebar';sidebarToggle.querySelector('span').textContent=collapsed?'Expand sidebar':'Collapse sidebar';
    writeStore('bounty-board-sidebar-collapsed',collapsed);
  }
  setSidebar(readStore('bounty-board-sidebar-collapsed',false)===true);
  sidebarToggle.addEventListener('click',()=>setSidebar(!shell.classList.contains('sidebar-collapsed')));
  state.sort=(s=>s && typeof s.key==='string' && ['title','severity','class','status','id','first_seen','last_seen'].includes(s.key) && ['asc','desc'].includes(s.dir) ? s : {key:'',dir:'asc'})(readStore('bounty-board-finding-sort',null));
  state.dashWork=readStore('bounty-board-dashboard-work','all')==='open' ? 'open' : 'all';
  state.classGroupBy=readStore('bounty-board-class-group','class')==='category' ? 'category' : 'class';
  state.reportHideNa=readStore('bounty-board-report-list-hide-na',true)!==false;
  // Last-used program: recorded on explicit selection, offered on load.
  const recentPrograms = () => (readStore('bounty-board-recent-programs',[])||[]).filter(r=>r && typeof r.program==='string').slice(0,5);
  function markProgramUsed() {
    if(!state.program)return;
    state.programOrigin='explicit';
    writeStore('bounty-board-last-program',{program:state.program,lane:state.lane});
    writeStore('bounty-board-recent-programs',[{program:state.program,lane:state.lane},...recentPrograms().filter(r=>r.program!==state.program)].slice(0,5));
  }
  function renderRecent() {
    const box=document.querySelector('#recent-programs'), label=document.querySelector('#recent-label');if(!box)return;
    const items=recentPrograms().map(r=>programs().find(p=>String(p.id)===r.program)).filter(Boolean);
    label.hidden=!items.length;
    box.innerHTML=items.map(p=>`<a class="side-link${state.view==='program' && String(p.id)===state.program?' current':''}" href="${esc(hrefFor({program:p.id,lane:String(p.id)===state.program ? state.lane : undefined,section:state.section}))}" data-recent-program="${esc(p.id)}" title="${esc(p.family||'')} / ${esc(programLabel(p))}">${icon(p.family==='binaries'?'cube':'globe')}<span>${esc(programLabel(p))}</span></a>`).join('');
  }
  document.querySelector('#recent-programs')?.addEventListener('click',event=>{
    const button=event.target.closest('[data-recent-program]');if(!button || !plainClick(event))return;
    event.preventDefault();
    navigate({view:'program',program:button.dataset.recentProgram,section:state.section});
  });
  document.querySelector('#refresh').addEventListener('click', load);
  let routePush=false;
  function normalizeSelection() {
    const ps=programs();
    if (state.dashboardProgram && !ps.some(p=>String(p.id)===state.dashboardProgram)) state.dashboardProgram='';
    if (!ps.some(p=>String(p.id)===state.program)) {
      if(state.programOrigin==='route' && state.program && ps.length)state.routeNotice=`The linked program "${state.program}" was not found. Showing another program instead.`;
      const last=readStore('bounty-board-last-program',null);
      if(last && typeof last.program==='string' && ps.some(p=>String(p.id)===last.program)){state.program=last.program;state.programOrigin='last-used';if(typeof last.lane==='string' && !state.lane)state.lane=last.lane;}
      else {state.program=ps.length ? String(ps[0].id) : '';state.programOrigin='default';}
    }
    const lanes=list(currentProgram()?.lanes)||[];
    if (!lanes.some(l=>String(l.name)===state.lane)) {
      if(state.programOrigin==='route' && state.lane && lanes.length && !state.routeNotice)state.routeNotice=`The linked lane "${state.lane}" was not found in this program. Showing ${lanes[0].name} instead.`;
      state.lane=lanes.length ? String(lanes[0].name) : '';
    }
  }
  let pendingReportRefresh=null;
  let loadGeneration=0, applyGeneration=0, renderGeneration=0;
  const phaseStatus=document.createElement('div');
  phaseStatus.className='message phase-status';phaseStatus.setAttribute('role','status');phaseStatus.hidden=true;app.before(phaseStatus);
  const portfolioAction=document.createElement('div');
  portfolioAction.className='message phase-status';portfolioAction.hidden=true;app.before(portfolioAction);
  portfolioAction.append('Portfolio totals and report index are not loaded. ');
  const portfolioButton=document.createElement('button');portfolioButton.className='button sm';portfolioButton.textContent='Load entire portfolio';portfolioAction.append(portfolioButton);
  async function loadPortfolio() {
    const snapshot=state.data, generation=loadGeneration;
    if(!snapshot?.portfolio_unloaded || snapshot._portfolioLoading)return;
    snapshot._portfolioLoading=true;
    portfolioButton.disabled=true;
    try {await completeInitialLoad(snapshot,generation);} finally {snapshot._portfolioLoading=false;if(state.data===snapshot)portfolioButton.disabled=false;}
  }
  portfolioButton.addEventListener('click',loadPortfolio);
  let laneGeneration=0;
  async function loadSelectedLane() {
    const snapshot=state.data, program=currentProgram(), lane=currentLane(), generation=loadGeneration;
    if(!snapshot?.portfolio_unloaded || !program || !lane?.unscanned || lane._pending || lane._failed || lane._deferred===laneGeneration)return;
    const selection=laneGeneration, programId=state.program, laneName=state.lane;
    lane._pending=true;
    const current=()=>state.data===snapshot && generation===loadGeneration && selection===laneGeneration && state.program===programId && state.lane===laneName;
    try {
      const result=await BoardAPI.lane(program,laneName,snapshot.root_instance);
      if(!current())return;
      if(result.root_instance!==snapshot.root_instance || result.family!==program.family || result.program!==program.name || result.lane?.name!==laneName || (snapshot.capabilities?.collaboration && result.source_authoritative!==true))throw new Error('Stale lane');
      const apply=async()=>{
        if(!current())return;
        const check=++applyGeneration, view=renderGeneration;
        try {
          const identity=await BoardAPI.rootInstance();
          if(!current() || check!==applyGeneration)return;
          if(identity.root_instance!==snapshot.root_instance)throw new Error('Root changed');
          if(view!==renderGeneration || !safeToApply()){lane._deferred=selection;phaseMessage(DEFER_LANE,apply,'Apply selected lane');if(view!==renderGeneration)retryDeferredApply();return;}
          const indexed=lane._reportsLoaded ? {reports:lane.reports,reports_unscanned:false,
            warnings:mergeWarnings((list(result.lane.warnings)||[]).filter(w=>!reportWarning(w)),lane._reportWarnings||[])} : null;
          Object.assign(lane,result.lane,indexed || {});delete lane.unscanned;delete lane._deferred;
          phaseMessage('');render();
          if(!snapshot._portfolioRequested){snapshot._portfolioRequested=true;loadPortfolio();}
        } catch {
          if(current() && check===applyGeneration){lane._failed=true;phaseMessage('Selected lane could not be loaded or the source changed. Use Refresh to retry.');}
        }
      };
      if(!safeToApply()){lane._deferred=selection;phaseMessage(DEFER_LANE,apply,'Apply selected lane');}
      else await apply();
    } catch {
      if(current()){lane._failed=true;phaseMessage('Selected lane could not be loaded. Use Refresh to retry.');if(!editingInApp())render();}
    } finally {delete lane._pending;if(currentLane()===lane && lane.unscanned && !lane._failed)loadSelectedLane();}
  }
  async function loadSelectedReports() {
    const snapshot=state.data, program=currentProgram(), lane=currentLane(), generation=loadGeneration;
    if(!snapshot?.portfolio_unloaded || state.view!=='program' || state.section!=='reports' || !program || !lane || lane._reportsPending || lane._reportsLoaded || lane._reportsFailed)return;
    const selection=laneGeneration, programId=state.program, laneName=state.lane;
    const current=()=>state.data===snapshot && generation===loadGeneration && selection===laneGeneration && state.program===programId && state.lane===laneName;
    lane._reportsPending=true;
    try {
      const result=await BoardAPI.laneReports(program,laneName,snapshot.root_instance);
      if(!current())return;
      if(result.root_instance!==snapshot.root_instance || result.family!==program.family || result.program!==program.name || result.lane!==laneName || !(result.reports===null || Array.isArray(result.reports)) || (snapshot.capabilities?.collaboration && result.source_authoritative!==true))throw new Error('Stale report index');
      const identity=await BoardAPI.rootInstance();
      if(!current())return;
      if(identity.root_instance!==snapshot.root_instance)throw new Error('Root changed');
      lane.reports=result.reports;lane._reportsLoaded=true;delete lane.reports_unscanned;
      // The report endpoint rereads the ledger for ownership. Once the lane
      // scan has arrived, its ledger/map/coverage warnings own those sources;
      // only the index owns report warnings. Replace, never accumulate, each.
      const warnings=list(result.warnings)||[];
      lane._reportWarnings=warnings.filter(reportWarning);
      lane.warnings=mergeWarnings(lane.unscanned ? warnings.filter(w=>!reportWarning(w)) : (list(lane.warnings)||[]).filter(w=>!reportWarning(w)),lane._reportWarnings);
      if(state.view==='program' && state.section==='reports')render();
    } catch {
      if(current()){lane._reportsFailed=true;phaseMessage('Selected reports could not be loaded or the source changed. Use Refresh to retry.');}
    } finally {delete lane._reportsPending;if(currentLane()===lane && !lane._reportsLoaded && !lane._reportsFailed)loadSelectedReports();}
  }
  // A deferred apply keeps its button for an immediate explicit apply, and is
  // retried automatically once it can no longer disturb focus or edits.
  let pendingApply=null, autoApplyQueued=false;
  function phaseMessage(text, apply, label='Apply loaded reports') {
    phaseStatus.replaceChildren();phaseStatus.hidden=!text;
    pendingApply=apply ? {apply,label} : null;
    if(text)phaseStatus.append(document.createTextNode(text));
    if(apply){const button=document.createElement('button');button.className='button sm';button.textContent=label;button.addEventListener('click',()=>apply());phaseStatus.append(' ',button);}
  }
  const editingInApp = () => {
    const el=document.activeElement;
    if(!el || el===document.body || !app.contains(el))return false;
    return el.matches('input, select, textarea, [contenteditable=""], [contenteditable="true"]') || !!el.closest('.CodeMirror, #live-report-host');
  };
  const reportEditorOpen = () => !!app.querySelector('.CodeMirror, #report-source, #live-report-host');
  const safeToApply = () => !editingInApp() && !state.metadataPending && !hasUnrecoverableDraft() && !(hasUnsaved() && reportEditorOpen());
  function retryDeferredApply() {
    if(!pendingApply || autoApplyQueued)return;
    autoApplyQueued=true;
    setTimeout(()=>{autoApplyQueued=false;if(pendingApply && safeToApply())pendingApply.apply();},0);
  }
  const DEFER_REPORTS='New reports are ready. They load automatically when you finish editing; your current view is unchanged.';
  const DEFER_LANE='Selected lane is ready. It opens automatically when you finish editing.';
  async function completeInitialLoad(summary, generation) {
    try {
      const full=await BoardAPI.load('complete',summary.root_instance);
      if(generation!==loadGeneration || state.data!==summary)return;
      if(!full || !Array.isArray(full.programs) || full.reports_loading!==false || full.root_identity!==summary.root_identity || full.root_instance!==summary.root_instance || (summary.capabilities?.collaboration && full.capabilities?.source_authoritative!==true))throw new Error('Stale report snapshot');
      const apply=async()=>{
        if(generation!==loadGeneration || state.data!==summary)return;
        const check=++applyGeneration, view=renderGeneration;
        const stale=()=>{
          if(check!==applyGeneration || generation!==loadGeneration || state.data!==summary)return true;
          if(view!==renderGeneration){phaseMessage(DEFER_REPORTS,apply);retryDeferredApply();return true;}
          return false;
        };
        if(hasUnrecoverableDraft()){phaseMessage('Reports loaded, but a draft needs recovery before applying them.');return;}
        try {
          const current=await BoardAPI.rootInstance();
          if(stale())return;
          if(current.root_instance!==summary.root_instance)throw new Error('Root changed');
        } catch {
          if(!stale()){summary.reports_loading=false;summary.reports_unavailable=true;phaseMessage('Reports could not be loaded or the source changed. Use Refresh to retry.');if(!editingInApp())render();}
          return;
        }
        if(hasUnrecoverableDraft()){phaseMessage('Reports loaded, but a draft needs recovery before applying them.');return;}
        if(!safeToApply()){phaseMessage(DEFER_REPORTS,apply);return;}
        state.data=full;normalizeSelection();phaseMessage('');render();
        toast('Reports loaded. The workspace is up to date.','success',{timeout:3500});
      };
      if(!safeToApply())phaseMessage(DEFER_REPORTS,apply);
      else await apply();
    } catch (error) {
      if(generation===loadGeneration && state.data===summary){summary.reports_loading=false;summary.reports_unavailable=true;phaseMessage(error?.code==='portfolio_scan_busy' ? 'Portfolio scan is busy. Your browser drafts remain available; wait for the current scan to finish, then use Load entire portfolio to retry.' : 'Reports could not be loaded or the source changed. Use Refresh to retry.');if(!editingInApp() && !hasUnsaved())render();}
    }
  }
  const hasUnrecoverableDraft = () => [...state.drafts.values()].some(d=>d.hasDraft && (d.storageError || d.storageUnreadable || d.storageBlocked));
  function renderRecovery() {
    const drafts=[...state.drafts.values()].filter(d=>d.hasDraft && (d.storageError || d.storageUnreadable || d.storageBlocked));
    recovery.hidden=!drafts.length;
    const keys=new Set(drafts.map(d=>d.key));
    for(const [key,card] of recoveryCards)if(!keys.has(key)){card.remove();recoveryCards.delete(key);}
    for(const draft of drafts){
      const existing=recoveryCards.get(draft.key);
      if(existing){const text=existing.querySelector('textarea');if(text.value!==draft.text)text.value=draft.text;continue;}
      const card=document.createElement('div');card.className='recovery-draft';
      const identity=document.createElement('p');
      identity.textContent=`Root: ${JSON.parse(draft.key)[0]} | Program: ${draft.program} | Lane: ${draft.lane} | Report: ${draft.id}`;
      card.append(identity);
      const text=document.createElement('textarea');text.readOnly=true;text.rows=6;text.value=draft.text;text.setAttribute('aria-label','Recover draft text');card.append(text);
      const button=document.createElement('button');button.type='button';button.className='button';button.textContent='Download draft';
      button.addEventListener('click',()=>{
        const url=URL.createObjectURL(new Blob([draft.text],{type:'text/plain;charset=utf-8'}));
        const link=document.createElement('a');link.href=url;link.download='recovered-draft.txt';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      });
      card.append(button);recovery.append(card);recoveryCards.set(draft.key,card);
    }
  }
  function blockRefresh() {
    state.metadataErrors=['Refresh blocked: a draft cannot be recovered from browser storage. Use Draft recovery to copy or download it before reloading.'];
  }
  async function load() {
    if(state.metadataPending || pendingReportRefresh) return;
    if(hasUnrecoverableDraft()) {blockRefresh();render();return;}
    const generation=++loadGeneration;
    ++laneGeneration;
    phaseMessage('');
    let finishRefresh;pendingReportRefresh=new Promise(resolve=>{finishRefresh=resolve;});
    state.loading=true; state.error=''; render();
    try {
      // A refresh with browser drafts must reconcile their source versions
      // before replacing the editor with an inventory-only snapshot.
      let data;
      if(state.data && hasUnsaved() && state.data.root_instance) {
        const identity=await BoardAPI.rootInstance();
        data=identity.root_instance ? await BoardAPI.load('complete',identity.root_instance) : await BoardAPI.load();
      } else data=await BoardAPI.load('summary');
      // An unidentified partial snapshot cannot be paired safely. Retain the
      // existing full-load behavior, including unscoped draft recovery.
      if(data?.reports_loading===true && (!/^[a-f0-9]{64}$/.test(data.root_identity || '') || !/^[a-f0-9]{64}$/.test(data.root_instance || '')))data=await BoardAPI.load();
      if(hasUnrecoverableDraft()) blockRefresh();
      else {
        if (!data || !Array.isArray(data.programs)) throw new Error('Invalid response');
        state.data=data; state.unidentifiedRoot=`unidentified-${++unidentifiedSequence}`; state.metadataErrors=[]; normalizeSelection();
        if(data.portfolio_unloaded===true)phaseMessage('Portfolio data and reports are not yet loaded. The selected lane loads first.');
        for(const program of programs())for(const lane of list(program.lanes)||[])for(const report of list(lane.reports)||[]){
          const draft=state.drafts.get(draftKey(String(program.id),String(lane.name),report.id));
          if(draft && (report.content!=null || (report.revision!=null && draft.hasDraft)))reconcileReport(draft,report);
        }
      }
    } catch (error) {
      if(hasUnrecoverableDraft())blockRefresh();
      else if(state.data){state.metadataErrors=[error?.code==='portfolio_scan_busy' ? 'Refresh could not complete because the portfolio scan is busy. Your browser draft remains available; wait for the current scan, then use Load entire portfolio to retry.' : 'Refresh failed. The previously loaded data and browser drafts remain available; try Refresh again.'];}
      else {state.error='Could not load workspace data. Check the local backend and try Refresh.'; state.data=null;}
    }
    state.loading=false;try{render();}finally{pendingReportRefresh=null;finishRefresh();}
    if(state.data?.portfolio_unloaded===true && generation===loadGeneration)loadSelectedLane();
    if(state.data?.portfolio_unloaded===true && generation===loadGeneration && !currentLane()){state.data._portfolioRequested=true;loadPortfolio();}
  }
  const opt = (value,label,selected) => `<option value="${esc(value)}"${selected?' selected':''}>${esc(label)}</option>`;
  const warningText = w => typeof w==='object' && w!==null ? (w.message ?? JSON.stringify(w)) : String(w);
  function rootWarning() {
    return (state.data?.root_unavailable === true || (list(state.data?.warnings)||[]).includes('root_unavailable'))
      ? '<div class="message warning" role="alert">Program root unavailable; portfolio data could not be discovered.</div>' : '';
  }
  function availability(ps) {
    const labels={map_missing:'Map missing',coverage_missing:'Coverage missing',ledger_missing:'Ledger missing',reports_missing:'Reports missing',map_unavailable_or_invalid:'Map inaccessible or invalid',coverage_unavailable_or_invalid:'Coverage inaccessible or invalid',ledger_unavailable_or_invalid:'Ledger inaccessible or invalid',reports_unavailable_or_invalid:'Reports inaccessible or invalid',report_content_unavailable_or_invalid:'Report content inaccessible or invalid'};
    const groups=new Map(), affected=new Set(), categories={missing:new Set(),invalid:new Set(),other:new Set()};
    for(const p of ps) for(const lane of list(p.lanes)||[]) {
      const identity=JSON.stringify([p.family,p.id,p.name,lane.name]);
      for(const w of list(lane.warnings)||[]) {
        const text=warningText(w), key=Object.hasOwn(labels,text)?text:'other:'+text;
        if(!groups.has(key))groups.set(key,{label:labels[text]||`Other warning: ${text}`,lanes:new Map()});
        groups.get(key).lanes.set(identity,`${p.family || 'Unknown family'} / ${p.name || p.id || 'Unknown program'} / ${lane.name || 'Unknown lane'}`);
        affected.add(identity);
        categories[Object.hasOwn(labels,text) ? (text.endsWith('_missing')?'missing':'invalid') : 'other'].add(identity);
      }
    }
    const globals=[...new Set((list(state.data?.warnings)||[]).map(warningText).filter(w=>w!=='root_unavailable'))];
    if(state.data?.discovery_incomplete === true && !globals.includes('discovery_incomplete'))globals.push('discovery_incomplete');
    const globalText=w=>w==='discovery_incomplete'?'Program discovery incomplete; totals may be unknown.':`Global warning: ${w}`;
    const items=[...groups.values()].map(group=>`<li><strong>${esc(group.label)}</strong>: ${group.lanes.size} ${group.lanes.size===1?'lane':'lanes'}<ul>${[...group.lanes.values()].map(name=>`<li>${esc(name)}</li>`).join('')}</ul></li>`).join('');
    const globalItems=globals.filter(w=>w!=='discovery_incomplete').map(w=>`<li>${esc(globalText(w))}</li>`).join('');
    const counts=[['Missing',categories.missing],['Inaccessible or invalid',categories.invalid],['Other warnings',categories.other]].filter(([,set])=>set.size).map(([label,set])=>`${label}: ${set.size} ${set.size===1?'lane':'lanes'}`).join(' · ');
    const unscanned=ps.some(p=>(list(p.lanes)||[]).some(l=>l.unscanned || l.reports_unscanned));
    return `<section class="panel panel-pad availability ${affected.size || unscanned || discoveryIncomplete() ? 'warn' : 'ok'}" aria-label="Data availability"><h2>${icon(affected.size || discoveryIncomplete() ? 'exclamation-triangle' : unscanned ? 'clock-o' : 'check-circle')}Data availability</h2><p>${affected.size ? `${affected.size} ${affected.size===1?'lane has':'lanes have'} reported availability warnings. ${counts}.` : unscanned ? 'Some sources have not been scanned; warnings are unknown.' : 'No lane warnings reported for this selection.'}${unscanned && affected.size?' Some sources have not been scanned.':''}${discoveryIncomplete()?' Discovery is incomplete; counts may be partial.':''}${globalItems?' Other global warnings are available in details.':''}</p>${items || globalItems?`<details><summary>View availability details</summary><div class="availability-details" tabindex="0" aria-label="Availability warning details"><ul>${globalItems}${items}</ul></div></details>`:''}</section>`;
  }
  function selectors() {
    const ps=programs(), lanes=list(currentProgram()?.lanes)||[];
    return `<div class="toolbar"><label>Program<select id="program-select" ${ps.length?'':'disabled'}>${ps.length?ps.map(p=>opt(p.id,p.id || p.name,String(p.id)===state.program)).join(''):opt('','No programs',true)}</select></label><label>Lane<select id="lane-select" ${lanes.length?'':'disabled'}>${lanes.length?lanes.map(l=>opt(l.name,l.name,String(l.name)===state.lane)).join(''):opt('','No lanes',true)}</select></label></div>`;
  }
  function title(title, subtitle, controls='') {return `<div class="titlebar"><div><h1>${esc(title)}</h1><p class="subtitle">${esc(subtitle)}</p></div>${controls}</div>`;}
  const discoveryIncomplete = () => state.data?.root_unavailable === true || state.data?.discovery_incomplete === true || (list(state.data?.warnings)||[]).some(w=>w==='root_unavailable'||w==='discovery_incomplete');
  // Every finding with its owning program and lane, for cross-program views.
  const findingEntries = ps => ps.flatMap(p=>(list(p.lanes)||[]).flatMap(l=>(list(l.findings)||[]).map(f=>({p,l,f}))));
  // Lookup tables per report list (rebuilt when the list object changes): the
  // first registered report owning a finding id, and the first report per path.
  const reportLookups=new WeakMap();
  const reportLookup = reports => {
    let lookup=reportLookups.get(reports);
    if(!lookup){
      lookup={owner:new Map(),path:new Map()};
      reports.forEach((r,i)=>{
        if(r.id==null)return;
        if(r.kind==='registered_report' && Array.isArray(r.owner_fids))for(const fid of r.owner_fids)if(!lookup.owner.has(String(fid)))lookup.owner.set(String(fid),i);
        if(r.path!=null && !lookup.path.has(r.path))lookup.path.set(r.path,i);
      });
      reportLookups.set(reports,lookup);
    }
    return lookup;
  };
  const reportFor = (lane, finding) => {
    const reports=list(lane?.reports);if(!reports || finding?.id==null)return null;
    const id=String(finding.id), path=typeof finding.report_path==='string' ? finding.report_path.replace(/^reports\//,'') : null;
    const lookup=reportLookup(reports), a=lookup.owner.get(id), b=path ? lookup.path.get(path) : undefined;
    const index=a===undefined ? b : b===undefined ? a : Math.min(a,b);
    return index===undefined ? null : reports[index];
  };
  // Report id (its path) for a finding: from the loaded report index, else
  // derived from a relative reports/... report_path while the index is not
  // loaded. A stale derived link opens the report view's not-found message.
  const reportIdFor = (lane, finding) => {
    const report=reportFor(lane,finding);if(report)return String(report.id);
    if(Array.isArray(lane?.reports) && !reportsIncomplete(lane))return null;
    const path=typeof finding?.report_path==='string' && finding.report_path.startsWith('reports/') ? finding.report_path.slice(8) : '';
    return path.toLowerCase().endsWith('.md') && !path.split('/').some(part=>!part || part==='.' || part==='..') ? path : null;
  };
  function workspaceTarget() {
    if(state.dashboardProgram){const p=programs().find(p=>String(p.id)===state.dashboardProgram);if(p)return {program:p,lane:String(p.id)===state.program?state.lane:(list(p.lanes)||[])[0]?.name,why:'Dashboard filter'};}
    const p=currentProgram();if(!p)return null;
    return {program:p,lane:state.lane,why:state.programOrigin==='default'?'First program; none chosen yet':state.programOrigin==='last-used'?'Last used':'Current selection'};
  }
  function severityGroups(entries) {
    const groups=new Map();
    for(const entry of entries){
      const value=entry.f.severity, blank=value==null || value==='';
      const known=!blank && (sevKey(value)!=='unknown' || String(value).trim().toLowerCase()==='unknown');
      const key=blank ? 'none' : known ? sevKey(value) : 'raw:'+String(value);
      if(!groups.has(key))groups.set(key,{key,label:blank?'Not recorded':String(value),sev:blank?'unknown':sevKey(value),rank:blank?99:known?SEVERITY_LEVELS.indexOf(sevKey(value)):6.5,items:[]});
      groups.get(key).items.push(entry);
    }
    return [...groups.values()].sort((a,b)=>a.rank-b.rank || a.label.localeCompare(b.label));
  }
  function classGroups(entries) {
    const groups=new Map();
    for(const entry of entries){
      const value=entry.f.class, key=value==null || value==='' ? 'none' : String(value);
      if(!groups.has(key))groups.set(key,{key,label:key==='none'?'Unclassified':key,items:[]});
      groups.get(key).items.push(entry);
    }
    return [...groups.values()].sort((a,b)=>(a.key==='none')-(b.key==='none') || b.items.length-a.items.length || a.label.localeCompare(b.label));
  }
  // Display-time categories (taxonomy module) for the dashboard class
  // breakdown. Raw classes stay the source of truth for filters and edits.
  function categoryGroups(entries) {
    const t=taxonomy();if(!t)return [];
    const groups=new Map();
    for(const entry of entries){
      const raw=entry.f.class, c=raw==null || raw==='' ? null : t.normalizeClass(raw);
      const key=c && c.category!=='unclassified' ? c.category : 'none';
      if(!groups.has(key))groups.set(key,{key,label:key==='none'?'Unclassified':c.label.split(' > ')[0],items:[]});
      groups.get(key).items.push(entry);
    }
    return [...groups.values()].sort((a,b)=>(a.key==='none')-(b.key==='none') || b.items.length-a.items.length || a.label.localeCompare(b.label));
  }
  const classWritable = () => !!BoardAPI.capability(state.data,'findingMetadata')?.textFields?.includes('class');
  function drill(kind, group) {
    const byProgram=new Map();
    for(const entry of group.items){const k=JSON.stringify([entry.p.id,entry.l.name]);if(!byProgram.has(k))byProgram.set(k,{p:entry.p,l:entry.l,items:[]});byProgram.get(k).items.push(entry);}
    const sorted=[...byProgram.values()].sort((a,b)=>programLabel(a.p).localeCompare(programLabel(b.p)) || String(a.l.name).localeCompare(String(b.l.name)));
    // Bulk reclassify (ledger actions) for one raw class, from its expanded row.
    const review=kind==='class' && group.key!=='none' && classWritable() && window.BoardLedgerActions?.openClassReview ? `<div class="drill-actions"><span class="hint">${group.items.length} ${group.items.length===1?'finding':'findings'} with class <code>${esc(group.key)}</code></span><button type="button" class="button sm" data-class-review="${esc(group.key)}" aria-label="Review and reclassify ${esc(group.key)} findings">${icon('pencil')}<span>Reclassify</span></button></div>` : '';
    return `<div class="drill" id="drill-${esc(kind)}-${esc(group.key.replace(/[^a-z0-9_-]/gi,'_'))}">${review}${sorted.map(({p,l,items})=>`<div class="drill-group"><h4>${icon('folder-o')}<span>${esc(programLabel(p))} / ${esc(l.name)}</span><span class="count">${items.length}</span></h4><ul>${items.sort((a,b)=>sevRank(a.f.severity)-sevRank(b.f.severity)).map(({f})=>{
      const report=reportIdFor(l,f);
      const target=`data-program="${esc(p.id)}" data-lane="${esc(l.name)}"`;
      // finding-actions hooks: row identity for selection/context menu, severity and submission pickers.
      // Row layout (feat/board-recent-actions), same rhythm as the Recent panel: title over a muted
      // subline (ID, status, class, report markers) on the left, then one aligned cluster on the
      // right: severity and submission pills together (.frow-pills), report/evidence icon links (.row-links).
      const sub=[`<span class="id">${esc(f.id??'')}</span>`, f.status!=null && f.status!=='' && !isArchived(f) ? `<span>${esc(f.status)}</span>` : '', isArchived(f)?'<span class="badge outline">archive</span>':'', kind!=='class' && f.class?`<span class="frow-class">${esc(f.class)}</span>`:''].filter(Boolean).join('');
      const reportNa=report && (l.reports||[]).some(r=>String(r.id)===String(report) && r.na===true);
      return `<li data-finding-row class="frow" data-finding-id="${esc(f.id??'')}" data-program="${esc(p.id)}" data-lane="${esc(l.name)}" data-sev="${sevKey(f.severity)}"><span class="frow-main"><a class="link-button frow-title truncate" href="${esc(hrefFor({program:p.id,lane:l.name,section:'findings',finding:f.id??undefined}))}" data-goto-finding="${esc(f.id??'')}" ${target}>${esc(f.title||'Untitled finding')}</a><span class="meta frow-sub">${sub}</span></span><span class="frow-pills"><span class="frow-sev">${pickButton('sev',`Severity ${f.severity==null||f.severity===''?'not recorded':f.severity}. Change severity`,sevBadge(f.severity))}</span><span class="frow-subm">${window.BoardFindingActions?pickButton('submission',`Submission: ${submissionLabel(f)}. Change submission`,submissionBadge(f)):submissionBadge(f)}</span></span><span class="row-links">${report?`<a class="row-icon report-icon${reportNa?' is-na-link':''}" href="${esc(hrefFor({program:p.id,lane:l.name,section:'reports',report}))}" data-goto-report="${esc(report)}" ${target} aria-label="Report${reportNa?' (marked N/A)':''}: ${esc(report)}" data-tip="${reportNa?'Report (marked N/A on the Board)':'Open report'}: ${esc(report)}">${icon('file-text-o')}</a>`:''}</span></li>`;
    }).join('')}</ul></div>`).join('')}</div>`;
  }
  function breakdown(kind, groups, total) {
    const max=Math.max(1,...groups.map(g=>g.items.length));
    return `<div class="breakdown">${groups.map(group=>{
      const id=`${kind}:${group.key}`, open=state.dashExpanded===id;
      const label=kind==='sev' ? `<span class="sev" data-sev="${group.sev}">${esc(group.label)}</span>` : esc(group.label);
      const hook=kind==='class' && group.key!=='none' ? ` data-class-name="${esc(group.key)}"` : kind==='cat' ? ` data-category-row="${esc(group.key)}"` : '';
      return `<button type="button" class="breakdown-row"${hook} data-breakdown="${esc(id)}" aria-expanded="${open}" title="Show matching findings by program"><i class="fa fa-angle-right" aria-hidden="true"></i><span class="label">${label}</span><span class="bar${kind==='sev'?' sev-bar':''}" ${kind==='sev'?`data-sev="${group.sev}"`:''} aria-hidden="true"><i style="width:${group.items.length/max*100}%"></i></span><strong>${group.items.length}</strong></button>${open?drill(kind,group):''}`;
    }).join('')}</div>`;
  }
  function dashboard() {
    const options=programs(), ps=state.dashboardProgram ? options.filter(p=>String(p.id)===state.dashboardProgram) : options;
    const lanes=ps.flatMap(p=>list(p.lanes)||[]), loaded=lanes.flatMap(l=>list(l.findings)||[]), every=loaded.filter(shownFinding);
    const openOnly=state.dashWork==='open', all=openOnly ? every.filter(isNotSubmitted) : every;
    const entries=findingEntries(ps).filter(e=>shownFinding(e.f) && (!openOnly || isNotSubmitted(e.f)));
    const discovered=!discoveryIncomplete();
    const complete=discovered && ps.every(p=>Array.isArray(p.lanes)) && lanes.every(l=>Array.isArray(l.findings));
    const stat=(v,label,extra='')=>`<div class="stat"><strong>${esc(v)}</strong><span>${esc(label)}${extra}</span></div>`;
    const reportsComplete=discovered && !state.data?.reports_unavailable && ps.every(p=>Array.isArray(p.lanes)) && lanes.every(l=>Array.isArray(l.reports) && !(reportsIncomplete(l)));
    const submissionValues=field=>{
      const counts=new Map();for(const finding of every){const nested=finding.submission?.[field];const value=nested != null && nested !== '' ? nested : finding[field==='state'?'submission_status':'platform_outcome'];if(value!=null && value!=='')counts.set(String(value),(counts.get(String(value))||0)+1);}
      return counts.size ? `<div class="kv">${[...counts].sort((a,b)=>b[1]-a[1]).map(([value,count])=>`<span>${esc(value)}</span> <strong>${count}</strong>`).join('')}</div>` : '<p class="hint">No recorded values available.</p>';
    };
    const target=workspaceTarget();
    const workFilter=`<div class="work-filter"><span id="work-filter-label">Show</span><div class="segmented" role="group" aria-labelledby="work-filter-label"><button type="button" data-dash-work="all" aria-pressed="${!openOnly}">All records</button><button type="button" data-dash-work="open" aria-pressed="${openOnly}">Not submitted</button></div></div>`;
    const controls=`<div class="toolbar">${archiveToggle(loaded.filter(isArchived).length)}${workFilter}<label>Dashboard program<select id="dashboard-program">${opt('','All programs',!state.dashboardProgram)}${options.map(p=>opt(p.id,p.id||p.name,String(p.id)===state.dashboardProgram)).join('')}</select></label></div>`;
    const sevGroups=severityGroups(entries), clsGroups=classGroups(entries), catGroups=categoryGroups(entries.filter(e=>e.f.class!=null && e.f.class!==''));
    const byCategory=state.classGroupBy==='category' && catGroups.length>0;
    const scope=openOnly ? 'not-submitted finding records' : 'finding records';
    const programRows=ps.map(p=>{
      const pl=list(p.lanes), fs=pl ? pl.flatMap(l=>list(l.findings)||[]).filter(shownFinding) : [], known=pl && pl.every(l=>Array.isArray(l.findings));
      const top=fs.length ? fs.reduce((best,f)=>sevRank(f.severity)<sevRank(best.severity)?f:best,fs[0]).severity : null;
      const search=[p.id,p.name,p.family,...(pl||[]).map(l=>l.name)].join(' ').toLowerCase();
      return `<tr data-program-row data-search="${esc(search)}"><td><a class="link-button" href="${esc(hrefFor({program:p.id,lane:(pl||[])[0]?.name ?? '',section:'findings'}))}" data-open-program="${esc(p.id)}">${esc(p.name||p.id)}</a><span class="id" style="display:block">${esc(p.family||'Family not provided')}</span></td><td class="num">${pl?pl.length:'Unavailable'}</td><td class="num">${known?fs.length:'Unknown'}</td><td class="num">${known?fs.filter(isNotSubmitted).length:'Unknown'}</td><td>${top!=null && top!==''?sevBadge(top):'<span class="hint">None</span>'}</td></tr>`;
    }).join('');
    return `${title('Dashboard','A portfolio view of the records currently loaded.',controls)}
      <div class="stack">${rootWarning()}<section class="panel panel-pad"><div class="blockhead"><div><h2>Portfolio overview</h2><p class="hint">Counts are records across loaded program lanes${!discovered?'; discovery is incomplete, so portfolio totals are unknown.':complete?'.':'; some finding collections are unavailable.'}${openOnly?' Finding counts include not-submitted work only.':''}</p></div><div class="open-workspace"><button class="button primary" data-go-program ${target?'':'disabled'}>${icon('arrow-right')}<span>Open workspace</span></button><button type="button" class="button" data-program-picker ${options.length?'':'disabled'}>${icon('search')}<span>Switch program</span></button>${target?`<p class="target-note">Opens <strong>${esc(programLabel(target.program))}</strong>${target.lane?` / ${esc(target.lane)}`:''}<span class="badge outline">${esc(target.why)}</span></p>`:''}</div></div><div class="stats">${stat(discovered?ps.length:'Unknown','Programs loaded')}${stat(discovered && ps.every(p=>Array.isArray(p.lanes))?lanes.length:'Unknown','Lanes loaded')}${stat(complete?all.length:'Unknown','Finding records',openOnly?' (not submitted)':'')}${stat(state.data?.portfolio_unloaded ? 'Unknown' : state.data?.reports_loading ? 'Loading' : reportsComplete?lanes.reduce((n,l)=>n+l.reports.length,0):'Unknown','Report records')}</div></section>
      ${availability(ps)}<div class="dashboard-grid"><div id="dashboard-recent-host" class="wide"></div><section class="panel panel-pad" aria-label="Severity breakdown"><h2>Severity breakdown</h2><p class="hint">${complete?`Counts from all loaded ${scope}.`:`Incomplete data: counts include loaded ${scope} only, not portfolio totals.`} Select a row to list matching findings by program.</p>${sevGroups.length?breakdown('sev',sevGroups):'<div class="state">No severity records available.</div>'}</section><section class="panel panel-pad" aria-label="Finding classes"><div class="blockhead"><h2>Finding classes</h2>${catGroups.length?`<div class="segmented" role="group" aria-label="Group classes"><button type="button" data-class-group="class" aria-pressed="${!byCategory}">By class</button><button type="button" data-class-group="category" aria-pressed="${byCategory}">By category</button></div>`:''}</div><p class="hint">${byCategory?`Raw classes grouped by display-time category rules on loaded ${scope}. Raw classes stay unchanged; Unclassified keeps the raw label.`:`Classification on loaded ${scope}; not coverage.`} Select a row to list matches.</p>${byCategory?breakdown('cat',catGroups):clsGroups.length?breakdown('class',clsGroups):'<div class="state">No classified findings available.</div>'}</section><section class="panel wide"><div class="panel-head"><div><h2>Programs</h2><p class="hint">Choose a program to inspect its lanes.</p></div></div>${ps.length?`<div class="program-search"><div class="input-icon">${icon('search')}<input id="program-search" type="search" aria-label="Search programs" placeholder="Search programs" value="${esc(state.programQuery||'')}" autocomplete="off"></div><span class="hint num" id="program-search-count"></span></div><div class="table-wrap"><table class="program-table"><thead><tr><th>Program</th><th>Lanes</th><th>Findings</th><th>Not submitted</th><th>Highest severity</th></tr></thead><tbody>${programRows}</tbody></table><div class="state" id="program-search-empty" hidden>No programs match this search.</div></div>`:discovered?'<div class="state">No programs returned by the backend.</div>':'<div class="state">Program discovery is unavailable or incomplete.</div>'}</section><section class="panel panel-pad wide" aria-label="Submission records"><h2>Submission records</h2><p class="hint">Recorded submission state and outcome are separate from finding status. Values shown for all loaded findings.</p><div class="report-layout"><div><h3>Submission state</h3>${submissionValues('state')}</div><div><h3>Platform result</h3>${submissionValues('result')}</div></div></section></div></div>`;
  }
  function applyProgramSearch() {
    const input=app.querySelector('#program-search');if(!input)return;
    const q=input.value.trim().toLowerCase();let shown=0;
    const rowsEl=[...app.querySelectorAll('[data-program-row]')];
    for(const row of rowsEl){const match=!q || row.dataset.search.includes(q);row.hidden=!match;if(match)shown++;}
    const empty=app.querySelector('#program-search-empty');if(empty)empty.hidden=shown>0;
    const count=app.querySelector('#program-search-count');if(count)count.textContent=q?`${shown} of ${rowsEl.length}`:'';
  }
  const SECTION_ICONS={findings:'bug',coverage:'sitemap',reports:'file-text-o',map:'map-o',gadgets:'puzzle-piece'};
  function workspace() {
    const p=currentProgram(), lane=currentLane();
    const picker=`<button type="button" class="button" data-program-picker ${programs().length?'':'disabled'}>${icon('search')}<span>Switch program</span></button>`;
    if (!p || !lane) return `${title(p?.name || 'Programs',p?'No lanes are available for this program.':'No programs are available.',`<div class="switcher">${selectors()}${picker}</div>`)}<div class="stack">${rootWarning()}${availability([])}<div class="panel state">${p?'This program has no lane data.':'Configure the program root in the backend and refresh.'}</div></div>`;
    // Gadgets and MapStore tabs are drop targets for modules that move findings.
    const nav=sections.map(([key,label])=>`<a href="${esc(hrefFor({section:key,report:key==='reports' && state.report ? state.report : undefined}))}" data-section="${key}" aria-label="${esc(label)}" class="${state.section===key?'active':''}${key==='map'||key==='gadgets'?' drop-target':''}" ${key==='map'||key==='gadgets'?`data-drop-target="${key}"`:''} ${state.section===key?'aria-current="page"':''}>${icon(SECTION_ICONS[key])}<span>${esc(label)}</span><span class="count">${key==='reports' && reportsIncomplete(lane) ? '–' : rows(key)?.length ?? '–'}</span></a>`).join('');
    const origin=state.programOrigin==='default' && programs().length>1 ? `<p class="context-note">${icon('info-circle')}<span>Showing the first program because none was chosen yet. Use Switch program or the Program menu to choose another.</span></p>` : '';
    const header=`<div class="titlebar"><div><p class="eyebrow">${icon(p.family==='binaries'?'cube':'globe')}<span>${esc(p.family||'Program workspace')} / ${esc(lane.name)}</span></p><h1>${esc(p.name||p.id)}</h1>${origin}</div><div class="switcher">${selectors()}${picker}</div></div>`;
    return `${header}<div class="stack">${rootWarning()}<section class="panel panel-pad"><div class="blockhead"><div><h2>Surface coverage</h2><p class="hint">Recorded surface boundaries, not a measure of complete testing.</p></div><button class="link-button" data-section="coverage">Explore coverage</button></div><div class="summary-line"><div><strong>${rows('coverage')?.length ?? 'Unknown'}</strong><span>Assessment questions</span></div><div><strong>${rows('findings')?.length ?? 'Unknown'}</strong><span>Finding records</span></div><div><strong>${reportsIncomplete(lane) ? 'Unknown' : rows('reports')?.length ?? 'Unknown'}</strong><span>Reports</span></div><div><strong>${rows('findings') ? rows('findings').filter(isNotSubmitted).length : 'Unknown'}</strong><span>Not submitted</span></div></div></section>${availability([{...p,lanes:[lane]}])}<div class="layout"><div class="stack"><nav class="tabs workspace-nav" aria-label="Workspace sections">${nav}</nav>${sectionContent()}</div></div></div>`;
  }
  const FILTERS=[['severity','Severity','severities'],['class','Class','classes'],['status','Status','statuses'],['submission','Submission','submission states'],['age','First seen','first seen dates']];
  const emptyFilters = () => ({severity:[],class:[],status:[],submission:[],age:[],query:'',reports:''});
  // First-seen age buckets are disjoint so the multi-select stays meaningful
  // (pick "Last 7 days" and "8 to 30 days" for the last month).
  const AGE_BUCKETS=['Last 7 days','8 to 30 days','31 to 90 days','Older than 90 days','No date recorded'];
  const ledgerTime = value => {const t=Date.parse(value ?? '');return Number.isFinite(t) ? t : null;};
  const ageBucket = row => {
    const t=ledgerTime(row.first_seen);if(t===null)return AGE_BUCKETS[4];
    const days=(Date.now()-t)/86400000;
    return days<=7 ? AGE_BUCKETS[0] : days<=30 ? AGE_BUCKETS[1] : days<=90 ? AGE_BUCKETS[2] : AGE_BUCKETS[3];
  };
  const filterValue = (row,key) => key==='submission' ? submissionLabel(row) : key==='age' ? ageBucket(row) : String(row[key] ?? '');
  const filterValues = (key, findings) => {
    const counts=new Map();for(const r of findings){const v=filterValue(r,key);if(v)counts.set(v,(counts.get(v)||0)+1);}
    return [...counts].sort((a,b)=>key==='severity' ? sevRank(a[0])-sevRank(b[0]) || a[0].localeCompare(b[0]) : key==='age' ? AGE_BUCKETS.indexOf(a[0])-AGE_BUCKETS.indexOf(b[0]) : a[0].localeCompare(b[0]));
  };
  function filterControl(key,label,plural,findings) {
    const active=state.filters[key]||[];
    if(!filterValues(key,findings).length && !active.length)return '';
    return `<button type="button" class="button sm filter-trigger" data-filter="${key}" aria-haspopup="true" aria-expanded="false" aria-label="Filter ${esc(plural)}">${esc(label)}${active.length?` <span class="badge-count">${active.length}</span>`:''}${icon('angle-down')}</button>`;
  }
  function openFilter(trigger) {
    const key=trigger.dataset.filter, def=FILTERS.find(([k])=>k===key);if(!def)return;
    const box=document.createElement('div');
    const draw=()=>{
      const values=filterValues(key,rows('findings')||[]), active=state.filters[key]||[];
      for(const v of active)if(!values.some(([x])=>x===v))values.push([v,0]);
      box.innerHTML=`<div class="menu-label">${esc(def[1])}</div><div class="menu" role="group" aria-label="${esc(def[1])} values">${values.map(([v,n])=>`<label class="option"><input type="checkbox" value="${esc(v)}" ${active.includes(v)?'checked':''}><span>${key==='severity'?sevBadge(v):esc(v)}</span><span class="count">${n}</span></label>`).join('')}</div><div class="menu-foot"><button type="button" class="button sm ghost" data-filter-clear ${active.length?'':'disabled'}>Clear</button><button type="button" class="button sm" data-filter-done>Done</button></div>`;
    };
    draw();
    box.addEventListener('change',event=>{
      const input=event.target.closest('input[type=checkbox]');if(!input)return;
      const set=new Set(state.filters[key]||[]);if(input.checked)set.add(input.value);else set.delete(input.value);
      state.filters[key]=[...set];render();
    });
    box.addEventListener('click',event=>{
      if(event.target.closest('[data-filter-clear]')){state.filters[key]=[];render();draw();box.querySelector('input')?.focus();}
      else if(event.target.closest('[data-filter-done]'))closePopover(true);
    });
    menuKeys(box,'input[type=checkbox], .menu-foot button');
    openPopover(trigger,box,{className:'filter-popover',reanchor:()=>app.querySelector(`.filter-trigger[data-filter="${CSS.escape(key)}"]`)});
    box.querySelector('input')?.focus();
  }
  const WRITE_SEVERITY_LABELS={INFO:'Informational (INFO)',UNKNOWN:'Unknown'};
  function metadataCell(row,key) {
    const value=String(row[key]??''); const cap=BoardAPI.capability(state.data,'findingMetadata');
    if(cap?.textFields?.includes(key)) return `<input data-metadata="${esc(key)}" data-id="${esc(row.id??'')}" aria-label="${esc(key)} for ${esc(row.title||row.id||'finding')}" aria-describedby="metadata-warning" title="Lowercase class identifier; change applies on leaving the field" value="${esc(value)}" ${row.id != null && !state.metadataPending?'':'disabled'}>`;
    const options=cap?.options?.[key]; const writable=cap && row.id != null && Array.isArray(options) && options.length && !state.metadataPending;
    const values=[...new Set([value,...(Array.isArray(options)?options.map(String):[])].filter(Boolean))];
    // Severity uses the same coloured pills as the dashboard (finding actions);
    // the button keeps data-metadata/value so the metadata flow is unchanged.
    if(key==='severity') return `<button type="button" class="pick-trigger sev-cell" data-metadata="severity" data-id="${esc(row.id??'')}" value="${esc(value)}" aria-haspopup="menu" aria-expanded="false" aria-label="severity for ${esc(row.title||row.id||'finding')}: ${esc(value||'not recorded')}" ${cap?'aria-describedby="metadata-warning"':''} title="${writable?'Change severity':'Severity editing is unavailable'}" ${writable?'':'disabled'}>${sevBadge(value||null)}${icon('angle-down')}</button>`;
    const sev='';
    // Severity: INFO is BBH's informational value; N/A is shown and ranked but
    // BBH stores it as UNKNOWN, so it is offered disabled until BBH supports it.
    const label=v=>key==='severity' && WRITE_SEVERITY_LABELS[v] ? WRITE_SEVERITY_LABELS[v] : v;
    const na=key==='severity' && writable && !values.includes('N/A') ? '<option value="N/A" disabled>N/A (not supported by BBH yet)</option>' : '';
    return `<select data-metadata="${key}" data-id="${esc(row.id??'')}"${sev} aria-label="${esc(key)} for ${esc(row.title||row.id||'finding')}" ${cap?'aria-describedby="metadata-warning"':''} ${writable?'':'disabled'}>${value ? '' : opt('','Unknown',true)}${values.map(v=>opt(v,label(v),v===value)).join('')}${na}</select>`;
  }
  function rationale(row) {
    const label=String(row.title||row.id||'finding'), edit=state.rationaleDrafts.get(rationaleKey(state.program,state.lane,row.id));
    const writable=BoardAPI.capability(state.data,'findingMetadata')?.textFields?.includes('severity_rationale') && row.id != null;
    if(edit) return `<div class="rationale"><p>Saved rationale: <span class="record-value">${esc(row.severity_rationale || 'Not recorded')}</span></p><label>Unsaved draft — Severity rationale for ${esc(label)}<textarea data-rationale-input="${esc(row.id)}" aria-label="Severity rationale for ${esc(label)}" aria-describedby="metadata-warning" rows="3" ${state.metadataPending?'disabled':''}>${esc(edit.text)}</textarea></label>${writable?`<button class="button" data-rationale-save="${esc(row.id)}" aria-label="Save severity rationale for ${esc(label)}" aria-describedby="metadata-warning" ${state.metadataPending?'disabled':''}>Save rationale</button>`:'<p class="hint">Saving unavailable; copy this draft before leaving.</p>'} <button class="button subtle" data-rationale-cancel="${esc(row.id)}" ${state.metadataPending?'disabled':''}>Cancel</button></div>`;
    return `<div class="rationale"><span>Severity rationale: </span><span class="record-value">${esc(row.severity_rationale || 'Not recorded')}</span>${writable?` <button class="link-button" data-rationale-edit="${esc(row.id)}" aria-label="Edit severity rationale for ${esc(label)}" ${state.metadataPending?'disabled':''}>Edit rationale</button>`:''}</div>`;
  }
  // One sort system for the findings table: header buttons and the Sort menu
  // both set state.sort. Severity ascending is scale order (EXCEPTIONAL first);
  // dates start newest first. Missing dates always sort last; ties keep ledger order.
  const SORTS={title:r=>String(r.title||'').toLowerCase(),severity:r=>sevRank(r.severity),class:r=>String(r.class||'').toLowerCase(),status:r=>String(r.status||'').toLowerCase(),id:r=>String(r.id??''),first_seen:r=>ledgerTime(r.first_seen),last_seen:r=>ledgerTime(r.last_seen)};
  const SORT_FIRST_DIR={first_seen:'desc',last_seen:'desc'};
  const SORT_MENU=[['','asc','Ledger order'],['severity','asc','Severity, highest first'],['severity','desc','Severity, lowest first'],['first_seen','desc','First seen, newest first'],['first_seen','asc','First seen, oldest first'],['last_seen','desc','Last seen, newest first'],['last_seen','asc','Last seen, oldest first'],['title','asc','Title, A to Z'],['class','asc','Class, A to Z'],['status','asc','Status, A to Z']];
  function sortFindings(items) {
    const {key,dir}=state.sort||{};const get=SORTS[key];if(!get)return items;
    const sign=dir==='desc'?-1:1;
    return items.map((r,i)=>[r,i,get(r)]).sort((a,b)=>{const x=a[2],y=b[2];if(x===null || y===null)return (x===null)-(y===null) || a[1]-b[1];return (x<y?-1:x>y?1:0)*sign || a[1]-b[1];}).map(([r])=>r);
  }
  const sortLabel = () => (SORT_MENU.find(([k,d])=>k===(state.sort?.key||'') && (!k || d===state.sort.dir))||SORT_MENU[0])[2];
  function setSort(next) {state.sort=next;writeStore('bounty-board-finding-sort',state.sort);render();}
  function openSortMenu(trigger) {
    openMenu(trigger,[{heading:'Sort findings'},...SORT_MENU.map(([key,dir,label])=>({label,checked:(state.sort?.key||'')===key && (!key || state.sort.dir===dir),onSelect:()=>setSort({key,dir})}))],{label:'Sort findings',reanchor:()=>null});
  }
  const shortDate = value => {const t=ledgerTime(value);return t===null ? '' : new Date(t).toISOString().slice(0,10);};
  // Module hook: providers add items to the finding row menu (see BoardUI.registerFindingActions).
  const findingActionProviders=[];
  function sortHeader(key,label,extra='') {
    const active=state.sort?.key===key, dir=active?state.sort.dir:'';
    return `<th ${active?`aria-sort="${dir==='desc'?'descending':'ascending'}"`:''} ${extra}><button type="button" class="sort-button" data-sort="${key}" title="Sort by ${esc(label.toLowerCase())}">${esc(label)}${icon(active?(dir==='desc'?'sort-desc':'sort-asc'):'sort')}</button></th>`;
  }
  function findings() {
    const loadedRows=rows('findings'); if (!loadedRows) return unavailable('Findings ledger');
    const all=loadedRows.filter(shownFinding), archivedCount=loadedRows.filter(isArchived).length;
    const f=state.filters, query=f.query.trim().toLowerCase();
    const filtered=sortFindings(all.filter(r=>FILTERS.every(([k])=>!(f[k]||[]).length || f[k].includes(filterValue(r,k))) && (!query||[r.title,r.id,r.class,r.status,r.severity].some(v=>String(v??'').toLowerCase().includes(query)))));
    const program=currentProgram(), laneName=state.lane;
    const body=filtered.map(r=>`<tr data-finding-id="${esc(r.id??'')}" data-program="${esc(program?.id??'')}" data-lane="${esc(laneName)}" data-sev="${sevKey(r.severity)}"${r.id!=null && String(r.id)===state.highlight?' class="highlight"':''}><td><span class="finding-title">${esc(r.title||'Untitled finding')}</span><div class="finding-meta"><span class="id">${esc(r.id??'ID unavailable')}</span>${(rid=>rid?`<a class="report-ref" href="${esc(hrefFor({program:program?.id,lane:laneName,section:'reports',report:rid}))}" title="Open report ${esc(rid)}">${icon('file-text-o')}<span>Report</span></a>`:'')(reportIdFor(currentLane(),r))}${r.submission_status || r.platform_outcome ? `${r.submission_status ? `<span class="hint">Submission: ${esc(r.submission_status)}</span>` : ''}${r.platform_outcome ? `<span class="hint">Platform outcome: ${esc(r.platform_outcome)}</span>` : ''}` : pickButton('submission',`Submission: ${submissionLabel(r)}. Change submission`,submissionBadge(r))}</div></td><td>${metadataCell(r,'severity')}${severityNote(r)}${rationale(r)}</td><td>${metadataCell(r,'class')}${classNote(r)}</td><td>${metadataCell(r,'status')}</td><td class="date">${seenCell(r)}</td><td class="actions"><button type="button" class="button ghost icon-only sm" data-row-menu="${esc(r.id??'')}" aria-haspopup="menu" aria-expanded="false" aria-label="Actions for ${esc(r.title||r.id||'finding')}" title="Actions">${icon('ellipsis-v')}</button></td></tr>`).join('');
    const cap=BoardAPI.capability(state.data,'findingMetadata');
    const chips=FILTERS.flatMap(([k,label])=>(f[k]||[]).map(v=>`<span class="chip" data-filter-chip><span class="chip-key">${esc(label)}</span><span>${esc(v)}</span><button type="button" data-remove-filter="${k}" data-value="${esc(v)}" aria-label="Remove filter ${esc(label)} ${esc(v)}">${icon('times')}</button></span>`));
    const anyFilter=chips.length || query;
    return `<section class="panel"><div class="panel-head"><div><h2>Findings ledger</h2><p class="hint">Filter, sort and open the findings in this lane.${window.BoardLedgerActions?' Use a row menu, or drag a row onto Gadgets or MapStore, to act on a finding.':''}</p></div>${window.BoardLedgerActions?`<div class="panel-actions"><button type="button" class="button sm" data-ledger-add title="${state.data?.capabilities?.ledger_actions?.add_finding?.enabled?'Add a finding through BBH':'Unavailable: no BBH writer that supports adding findings'}">${icon('plus')}<span>Add finding</span></button></div>`:''}</div>${cap?'<div class="panel-pad" style="padding-top:0"><div id="metadata-warning" class="message warning metadata-warning">Warning: concurrent local edits or sync changes can be overwritten by metadata updates. Coordinate all writers before editing; conflict protection is not guaranteed.</div></div>':''}<div class="filters">${FILTERS.map(([k,label,plural])=>filterControl(k,label,plural,all)).join('')}<div class="input-icon">${icon('search')}<input id="finding-search" aria-label="Search findings" placeholder="Search findings" value="${esc(f.query)}" autocomplete="off"></div><button type="button" class="button sm sort-trigger" data-sort-menu aria-haspopup="menu" aria-expanded="false" aria-label="Sort findings: ${esc(sortLabel())}">${icon('sort-amount-desc')}<span>${esc(sortLabel())}</span>${icon('angle-down')}</button>${archivedCount?archiveToggle(archivedCount):''}<span class="result-count">${filtered.length} of ${all.length}</span></div>${anyFilter?`<div class="chips">${chips.join('')}<button type="button" class="link-button" data-clear-filters>Clear all</button></div>`:''}${filtered.length?`<div class="table-wrap"><table class="ledger-table"><thead><tr>${sortHeader('title','Finding')}${sortHeader('severity','Severity')}${sortHeader('class','Class')}${sortHeader('status','Status')}${sortHeader('first_seen','First seen','class="date"')}<th class="actions"><span class="sr-only">Actions</span></th></tr></thead><tbody>${body}</tbody></table></div>`:`<div class="empty">${icon(all.length?'filter':'inbox')}<strong>${all.length?'No findings match these filters.':'No findings in this lane.'}</strong>${all.length?'<button type="button" class="link-button" data-clear-filters>Clear filters</button>':''}</div>`}<p class="footnote">${cap?'Only supported fields with stable IDs can be edited. Class changes apply when you leave the field.':'Metadata editing is unavailable: the backend has not advertised a write capability.'}</p><div id="metadata-message" role="status">${state.metadataPending?'Updating metadata; waiting for confirmation.':''}</div></section>`;
  }
  function seenCell(r) {
    const first=shortDate(r.first_seen), last=shortDate(r.last_seen);
    return `${first?`<time datetime="${esc(r.first_seen)}">${first}</time>`:'<span class="hint">Not recorded</span>'}${last && last!==first?`<span class="cell-note">Last seen ${last}</span>`:''}`;
  }
  function openRowMenu(trigger) {
    const id=trigger.dataset.rowMenu, row=(rows('findings')||[]).find(r=>String(r.id??'')===id);if(!row)return;
    const report=reportFor(currentLane(),row), items=[], title=String(row.title||row.id||'finding');
    if(row.id!=null)items.push({label:'Copy finding ID',icon:'clipboard',onSelect:async()=>{try{await navigator.clipboard.writeText(String(row.id));toast('Finding ID copied.','success');}catch{toast('Copy is unavailable in this browser.','warning');}}});
    if(report)items.push({label:'Open report',icon:'file-text-o',onSelect:()=>navigate({section:'reports',report:String(report.id)})});
    const only=(key,label,value)=>{if(value!=null && value!=='')items.push({label:`Show only ${label} ${value}`,icon:'filter',onSelect:()=>{state.filters={...emptyFilters(),query:'',[key]:[String(value)]};render();}});};
    // Ledger actions (and any other module provider) sit between the
    // navigation items and the filter shortcuts.
    for(const provider of findingActionProviders){
      let extra=[];try{extra=provider(row,{program:currentProgram(),lane:currentLane()})||[];}catch(error){console.error('Finding action provider failed:',error);}
      if(extra.length){if(items.length)items.push({separator:true});items.push(...extra);}
    }
    if(items.length)items.push({separator:true});
    only('severity','severity',row.severity);only('class','class',row.class);only('status','status',row.status);
    openMenu(trigger,items,{label:`Actions for ${title}`,align:'end',reanchor:()=>null});
  }
  function unavailable(name){return `<section class="panel panel-pad"><h2>${esc(name)}</h2><div class="state">This collection was not provided by the backend.</div></section>`;}
  function records(key,label,description) {return recordList(rows(key),label,description);}
  function observations(key, label) {
    const items=rows(key);
    if(!items) return unavailable(label);
    if(!items.length) return `<section class="panel panel-pad"><h2>${esc(label)}</h2><div class="state">No records in this lane.</div></section>`;
    const fields=['url','surface','scope','status','path','tags','timestamp'];
    return `<section class="panel panel-pad"><h2>${esc(label)}</h2><p class="hint">Index metadata; archived and residual labels are preserved. Bodies are loaded only when opened.</p>${items.map((item,i)=>{
      if(!item || typeof item!=='object') return '<div class="record">Invalid index entry</div>';
      const metadata=fields.map(k=>`<p class="hint record-value"><b>${esc(k)}:</b> ${esc(item[k] == null || item[k] === '' ? 'Not recorded' : display(item[k]))}</p>`).join('');
      const action=typeof item.path==='string' && item.path ? `<button data-observation="${i}">Open observation</button><div data-observation-body role="status"></div>` : '<p>Observation path not recorded.</p>';
      return `<div class="record"><strong>${esc(item.title || 'Untitled observation')}</strong>${metadata}${action}</div>`;
    }).join('')}</section>`;
  }
  function recordList(items,label,description) {
    if(!items) return unavailable(label);
    if(!items.length) return `<section class="panel panel-pad"><h2>${esc(label)}</h2><p class="hint">${esc(description)}</p><div class="state">No ${esc(label.toLowerCase())} records in this lane.</div></section>`;
    const content=items.map(item=>{
      if (typeof item !== 'object' || item===null) return `<div class="record record-value">${esc(item)}</div>`;
      const entries=Object.entries(item); const titleKey=['surface','surface_key','title','name','id','url'].find(k=>item[k]!=null) || entries[0]?.[0];
      return `<div class="record"><strong>${esc(display(item[titleKey]))}</strong>${entries.filter(([k])=>k!==titleKey).map(([k,v])=>`<p class="hint record-value"><b>${esc(k)}:</b> ${esc(display(v))}</p>`).join('')}</div>`;
    }).join('');
    return `<section class="panel panel-pad"><h2>${esc(label)}</h2><p class="hint">${esc(description)}</p>${content}</section>`;
  }
  function coverage() {
    const value=currentLane()?.coverage;
    if (!value) return unavailable('Coverage');
    const inventory=value.mapped_kinds;
    const mapped=inventory && typeof inventory==='object' && !Array.isArray(inventory)
      ? Object.entries(inventory).map(([kind,count])=>`<div class="record"><strong>${esc(kind)}</strong>: ${esc(display(count))}</div>`).join('') || '<p class="hint">No mapped surfaces reported.</p>'
      : '<p class="hint">Mapped inventory not provided by the backend.</p>';
    const unclassified=value.unclassified_surfaces == null ? 'Unknown number of surfaces without assessment questions.' : `${display(value.unclassified_surfaces)} surfaces without assessment questions.`;
    const items=rows('coverage');
    const counts=value.counts && typeof value.counts==='object' && !Array.isArray(value.counts) ? `<section class="panel panel-pad"><h2>Assessment counts</h2><p class="hint">Recorded assessment questions${value.total == null ? '' : `: ${esc(display(value.total))} total`}.</p>${Object.entries(value.counts).map(([status,count])=>`<div class="record"><strong>${esc(status)}</strong>: ${esc(display(count))}</div>`).join('') || '<p class="hint">No assessment counts reported.</p>'}</section>` : '';
    const assessments=items ? (items.length ? records('coverage','Assessment questions','Recorded questions and boundaries, not proof of complete testing.') : '<section class="panel panel-pad"><h2>Assessment questions</h2><div class="state">No assessment questions recorded in this lane.</div></section>') : unavailable('Assessment questions');
    const unassessed=recordList(list(value.unassessed_surfaces),'Surfaces without assessment questions','Mapped inventory only; no assessment question recorded for these surfaces.');
    return `<div class="stack"><div id="coverage-drilldown-host"></div><section class="panel panel-pad"><h2>Mapped inventory</h2><p class="hint">Mapped surfaces are inventory, not assessed coverage.</p>${mapped}<p class="hint">${esc(unclassified)}</p></section>${unassessed}${counts}${assessments}</div>`;
  }
  // Deliberately small Markdown subset; all source is escaped before formatting.
  // Links/images remain text. No HTML, navigation, external images or scripts.
  function markdown(source) {
    const inline=s=>esc(s).replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/\*([^*]+)\*/g,'<em>$1</em>');
    let code=false, result=[], inList=false;
    for (const line of String(source).split('\n')) {
      if (line.startsWith('```')) {if(inList){result.push('</ul>');inList=false;} const lang=code?'':line.slice(3).trim().split(/\s+/)[0].toLowerCase(); result.push(code?'</code></pre>':(lang?`<pre data-lang="${esc(lang)}"><code>`:'<pre><code>'));code=!code;continue;}
      if(code){result.push(esc(line)+'\n');continue;}
      const bullet=line.match(/^\s*[-*] (.*)$/); if(bullet){if(!inList){result.push('<ul>');inList=true;} result.push(`<li>${inline(bullet[1])}</li>`);continue;}
      if(inList){result.push('</ul>');inList=false;}
      const heading=line.match(/^(#{1,3})\s+(.+)$/); if(heading){const n=heading[1].length;result.push(`<h${n}>${inline(heading[2])}</h${n}>`);} else if(line.trim()) result.push(`<p>${inline(line)}</p>`);
    }
    if(inList)result.push('</ul>');if(code)result.push('</code></pre>');return result.join('');
  }
  function savedSharedRecovery() {
    if(!state.data?.capabilities?.collaboration)return '';
    return `<section class="panel panel-pad"><h2>Recover saved drafts</h2><p class="hint">Deleted or renamed reports disappear from the picker. Enter the original path relative to this lane's reports folder. Find saved local drafts and pending requests in this browser, or look up a previously observed shared draft. Local recovery leaves the original intact; if the source is unavailable, it waits for the source to return. None of this saves a report file.</p><label for="saved-shared-path">Original report path</label> <input id="saved-shared-path" type="text" autocomplete="off" value="${esc(recoveryPaths.get(recoveryPathKey())?.value || '')}"><button type="button" class="button" data-discard-current-path>Discard path</button><button type="button" class="button" data-find-shared>Find saved shared draft</button><button type="button" class="button" data-find-local>Find saved local drafts</button><div data-shared-recovery role="status"></div><div data-local-recovery></div></section>`;
  }
  function reports() {
    const partial=reportsIncomplete(currentLane()) && Array.isArray(rows('reports'));
    return savedSharedRecovery()+(partial ? '<div class="message warning">Report list is incomplete; some reports may be unavailable.</div>' : '')+reportEditor();
  }
  // Browsable list of the lane's reports as real links, newest first.
  // Generated navigation is hidden unless asked for; the filter hides rows
  // in place (applyReportFilter) without a re-render.
  function reportBrowser(all) {
    const program=currentProgram();if(!program)return '';
    const navCount=all.filter(r=>r.kind==='generated_navigation').length, showNav=state.reportNav===true;
    // Report N/A (report-na.js): marked rows are struck through and dimmed, hidden unless "Hide N/A" is off.
    const naModule=window.BoardReportNa, hideNa=state.reportHideNa!==false;
    const naCount=all.filter(r=>r.id!=null && (showNav || r.kind!=='generated_navigation') && r.na===true).length;
    const items=all.filter(r=>r.id!=null && (showNav || r.kind!=='generated_navigation') && !(hideNa && r.na===true)).sort((a,b)=>(typeof b.modified==='number'?b.modified:-1)-(typeof a.modified==='number'?a.modified:-1) || String(a.path??a.id).localeCompare(String(b.path??b.id)));
    const open=readStore('bounty-board-report-list-open',true)!==false;
    const kinds={registered_report:'Registered',generated_report:'Generated',generated_evidence:'Evidence',generated_navigation:'Navigation',unregistered:'Unregistered'};
    const rowsHtml=items.map(r=>{
      const name=String(r.title || r.name || r.id), path=String(r.path ?? ''), owners=Array.isArray(r.owner_fids) ? r.owner_fids.map(String) : [];
      const when=relativeTime(r.modified);
      return `<li data-report-row${r.na===true?' class="is-na"':''} data-search="${esc([name,path,...owners].join(' ').toLowerCase())}"><a class="report-link" href="${esc(hrefFor({program:program.id,lane:state.lane,section:'reports',report:r.id}))}"${String(r.id)===state.report?' aria-current="page"':''}><span class="report-link-title na-title">${esc(name)}</span>${path && path!==name?`<span class="report-link-path">${esc(path)}</span>`:''}</a><span class="report-link-meta">${owners.length?`<span class="id">${esc(owners[0])}</span>`:''}${kinds[r.kind]?`<span class="badge outline">${esc(kinds[r.kind])}</span>`:''}${when?`<time datetime="${esc(new Date(r.modified*1000).toISOString())}" title="${esc(absoluteTime(r.modified))}">${esc(when)}</time>`:''}${naModule && path?naModule.toggleHtml({program:program.id,lane:state.lane,path,na:r.na===true,label:name}):''}</span></li>`;
    }).join('');
    return `<details class="report-browser" data-report-browser data-na-scope="report-list"${open?' open':''}><summary>Reports in this lane <span class="count">${items.length}</span></summary><div class="report-browser-tools"><div class="input-icon">${icon('search')}<input id="report-filter" type="search" aria-label="Filter report list by name, path or finding" placeholder="Filter by name, path or finding" value="${esc(state.filters.reports||'')}" autocomplete="off"></div>${navCount?`<label class="report-nav-toggle"><input type="checkbox" id="report-nav-toggle"${showNav?' checked':''}> Show generated navigation (${navCount})</label>`:''}${naModule?`<label class="na-hide-toggle"><input type="checkbox" id="report-hide-na"${hideNa?' checked':''}> Hide N/A</label>${hideNa && naCount?`<span class="na-hidden-note">${naCount} N/A hidden · <button type="button" class="link-button" data-na-show-hidden data-report-show-na>Show</button></span>`:''}`:''}<span class="hint num" id="report-filter-count"></span></div>${items.length?`<ul class="report-links" aria-label="Report links">${rowsHtml}</ul>`:''}<p class="state" id="report-filter-empty"${items.length?' hidden':''}>${items.length?'No reports match this filter.':hideNa && naCount?'Every report here is marked N/A.':'Only generated navigation in this lane.'}</p><p class="hint">Middle-click or Ctrl/Cmd+click a report to open it in a new tab.</p></details>`;
  }
  function applyReportFilter() {
    const input=app.querySelector('#report-filter');if(!input)return;
    const q=input.value.trim().toLowerCase();let shown=0;
    const rowsEl=[...app.querySelectorAll('[data-report-row]')];
    for(const row of rowsEl){const match=!q || q.split(/\s+/).every(t=>row.dataset.search.includes(t));row.hidden=!match;if(match)shown++;}
    const empty=app.querySelector('#report-filter-empty');if(empty && rowsEl.length)empty.hidden=shown>0;
    const count=app.querySelector('#report-filter-count');if(count)count.textContent=q?`${shown} of ${rowsEl.length}`:'';
  }
  function reportEditor() {
    if(state.data?.portfolio_unloaded && !currentLane()?._reportsLoaded)return '<section class="panel panel-pad"><h2>Reports</h2><div class="state">Reports are loading.</div></section>';
    if(state.data?.reports_loading && !currentLane()?._reportsLoaded)return '<section class="panel panel-pad"><h2>Reports</h2><div class="state">Reports are loading.</div></section>';
    const all=rows('reports'); if(!all)return unavailable('Reports');
    if(!all.length)return `<section class="panel panel-pad"><h2>Reports</h2><div class="state">${reportsIncomplete(currentLane())?'No reports loaded.':'No reports in this lane.'}</div></section>`;
    // A report opened from a link or route that is not in this lane gets a
    // clear message (with the lane's list) instead of another report.
    if(state.report && state.report===state.linkedReport && !all.some(r=>String(r.id)===state.report))return `<section class="panel panel-pad"><h2>Reports</h2><div class="message warning" role="alert" data-report-missing>Report not found in this lane: <code>${esc(state.report)}</code>. It may have been moved, renamed or deleted, or the link is out of date. Choose a report below.</div>${reportBrowser(all)}</section>`;
    state.linkedReport='';
    if(!all.some(r=>String(r.id)===state.report)) state.report=String(all[0].id??'');
    const report=reportById(state.report); if(!report || report.id==null)return '<section class="panel panel-pad"><h2>Reports</h2><div class="state">Reports need stable IDs before they can be opened.</div></section>';
    const kindNames={registered_report:'Registered report',generated_report:'Generated report',generated_evidence:'Generated evidence',generated_navigation:'Generated navigation',unregistered:'Unregistered artifact',unknown:'Ownership unknown'};
    const kind=report.kind == null ? 'Ownership not provided' : (kindNames[report.kind] || String(report.kind));
    const owner=Array.isArray(report.owner_fids) && report.owner_fids.length ? `Finding owner IDs: ${report.owner_fids.map(display).join(', ')}` : '';
    const picker=`<label class="hint" for="report-select">Report</label><br><select id="report-select" class="report-picker">${all.filter(r=>r.id!=null).map(r=>opt(r.id,r.path || r.title || r.id,String(r.id)===state.report)).join('')}</select><p class="hint record-value">${esc(kind)}${owner ? ` | ${esc(owner)}` : ''}${report.path ? ` | Path: ${esc(report.path)}` : ''}</p>${reportBrowser(all)}`;
    if(state.data?.capabilities?.live_edit){
      // The live editor module owns this host; it persists across renders.
      const program=currentProgram();
      if(!report.path || !program)return `<section class="panel panel-pad"><h2>Reports</h2>${picker}<div class="state">This report has no file path and cannot be opened.</div></section>`;
      const host=`data-family="${esc(program.family)}" data-program="${esc(program.name)}" data-lane="${esc(state.lane)}" data-path="${esc(report.path)}" data-report-id="${esc(report.id)}"`;
      // Editor and artifacts sit side by side when the panel is wide (container
      // query in style.css), otherwise the artifacts follow the editor.
      return `<section class="panel panel-pad report-panel"><h2>Reports</h2>${picker}<div class="report-workspace"><div class="report-main"><div id="live-report-host" ${host}><div class="state">Opening editor…</div></div></div><aside class="report-side" aria-label="Report artifacts"><div id="report-artifacts-host" ${host}></div></aside></div></section>`;
    }
    if(report.content == null && report.path){
      if(!report.loadState) {
        report.loadState='loading';const program=currentProgram(), lane=state.lane, snapshot=state.data, selection=laneGeneration;
        BoardAPI.report(program,lane,report.path,snapshot?.portfolio_unloaded ? snapshot.root_instance : undefined).then(async result=>{
          if(typeof result.content!=='string')throw new Error('Invalid report');
          if(snapshot?.portfolio_unloaded && snapshot.capabilities?.collaboration && (result.source_authoritative!==true || result.root_instance!==snapshot.root_instance))throw new Error('Non-authoritative report');
          if(snapshot?.portfolio_unloaded && (await BoardAPI.rootInstance()).root_instance!==snapshot.root_instance)throw new Error('Root changed');
          if(state.data!==snapshot || selection!==laneGeneration){delete report.loadState;return;}
          report.content=result.content;report.revision=result.revision;
          if(typeof result.editable==='boolean')report.editable=result.editable;
          if(typeof result.collaboration_editable==='boolean')report.collaboration_editable=result.collaboration_editable;
          report.loadState='loaded';
        }).catch(()=>{if(state.data!==snapshot || selection!==laneGeneration)delete report.loadState;else report.loadState='error';})
          .finally(()=>{if(state.data===snapshot && currentProgram()===program && currentLane()?.name===lane && state.section==='reports' && state.report===String(report.id))render();});
      }
      if(report.loadState!=='error') return `<section class="panel panel-pad"><h2>Reports</h2>${picker}<div class="state">Loading report…</div></section>`;
      if(!draftFor(report).hasDraft) return `<section class="panel panel-pad"><h2>Reports</h2>${picker}<div class="state">Report could not be loaded. Refresh the workspace to retry.</div></section>`;
      // A retained local draft is not evidence that the partial report body is
      // current. Preserve it for copying, but do not start collaborative writes.
      if(state.data?.portfolio_unloaded && state.data?.capabilities?.collaboration){
        const draft=draftFor(report);
        return `<section class="panel panel-pad"><h2>Reports</h2>${picker}<div class="message warning">Report could not be verified. Your retained draft is read-only; copy it and refresh to retry.</div><label for="report-source">Retained draft</label><textarea id="report-source" readonly>${esc(draft.text)}</textarea></section>`;
      }
    }
    const draft=draftFor(report);
    if(reportReadOnly(draft)) {
      clearTimeout(draft.saveTimer);
      return `<section class="panel panel-pad"><h2>Reports</h2>${picker}<div id="report-status" class="message warning" role="status">This report is read-only under the backend editing policy. Any retained browser draft is shown for copying; it will not be published.</div><div class="report-layout"><div><label for="report-source">Markdown source</label><textarea id="report-source" readonly spellcheck="false">${esc(draft.text)}</textarea></div><div><label>Preview</label><div id="report-preview" class="preview">${markdown(draft.text)}</div></div></div>${artifactsHost(report)}</section>`;
    }
    if(state.data?.capabilities?.collaboration && !draft.collabStarted) startCollaboration(draft, currentProgram(), report.path);
    const status=reportStatus(draft)+(draft.historyGaps?.length ? ' History is incomplete; fetching missing pages.' : '')+(draft.undoNotice ? ` ${draft.undoNotice}` : '');
    const unavailableSource=report.loadState==='error' ? '<div class="message warning">Report could not be loaded. Source is unavailable; your draft is shown below. Refresh the workspace to retry.</div>' : '';
    return `<section class="panel panel-pad"><div class="blockhead"><div><h2>Reports</h2><p class="hint">Markdown source and safe preview. Reports remain in their owning source.</p></div></div>${picker}${unavailableSource}<div id="report-status" class="message report-status" role="status">${esc(status)}</div><p class="hint">${state.data?.capabilities?.report_autosave ? 'Autosave is experimental. Shared draft and Markdown publication are separate; external writers can change the file after confirmation. Browser drafts and pending requests may be lost if browser data is cleared.' : 'Drafts are stored in this browser and can be lost if browser data is cleared. They are not saved to the report.'} Older unscoped drafts are retained but not automatically imported.</p>${state.data?.capabilities?.report_autosave ? '' : '<button class="button" disabled title="Report writing is disabled to protect source files">Save to report unavailable</button>'}${state.data?.capabilities?.collaboration ? '<div id="orphan-drafts"><button type="button" class="button" data-find-drafts>Find saved drafts</button><div data-draft-candidates></div></div><div id="collaboration-history"></div>' : ''}<div class="report-layout"><div><label for="report-source">Markdown source</label><textarea id="report-source" spellcheck="false">${esc(draft.text)}</textarea></div><div><label>Preview</label><div id="report-preview" class="preview">${markdown(draft.text)}</div></div></div>${artifactsHost(report)}</section>`;
  }
  function findSavedDrafts(draft, box=app.querySelector('[data-draft-candidates]'), includeCurrent=false) {
    if(!box || !rootIdentity())return;
    const scope={root:rootIdentity(),instance:state.data?.root_instance,program:state.program,lane:state.lane};
    box.replaceChildren();
    const note=document.createElement('p');note.textContent='Saved drafts for this report are retained. A live tab cannot be recovered; copy its text instead. Recovery leaves the original untouched.';box.append(note);
    const base=`bounty-board-report-draft-v2:${draft.key}`, prefix=base+':';
    try {
      for(let i=0;i<localStorage.length;i++){
        const key=localStorage.key(i);if(!key || (key!==base && !key.startsWith(prefix)) || (!includeCurrent && key===storageKey(draft.key)))continue;
        const namespace=key===base ? null : key.slice(prefix.length);if(namespace && !/^[0-9a-f-]{36}$/i.test(namespace))continue;
        const raw=localStorage.getItem(key);let saved;try {saved=JSON.parse(raw);}catch{continue;}
        if(!saved || saved.version!==1 || typeof saved.text!=='string' || (saved.hasDraft===false && !saved.pendingShared))continue;
        const complete=typeof saved.original==='string' && (saved.revision===null || typeof saved.revision==='string');
        const card=document.createElement('section');card.dataset.recoveryCandidate='';
        const label=document.createElement('label');label.textContent='Saved draft (select and copy if recovery is unavailable)';
        const text=document.createElement('textarea');text.readOnly=true;text.rows=4;text.textContent=saved.text;label.append(text);card.append(label);
        if(saved.pendingShared){const pendingLabel=document.createElement('label');pendingLabel.textContent='Pending request (copy for manual recovery if needed)';const pendingText=document.createElement('textarea');pendingText.readOnly=true;pendingText.rows=3;pendingText.textContent=JSON.stringify(saved.pendingShared);pendingLabel.append(pendingText);card.append(pendingLabel);}
        const status=document.createElement('p');status.setAttribute('role','status');card.append(status);
        const button=document.createElement('button');button.type='button';button.className='button';button.textContent='Recover this draft';card.append(button);box.append(card);
        button.addEventListener('click',async()=>{
          if(!namespace || !complete){status.textContent='This older draft has no provable tab ownership or complete recovery data. Select and copy the draft text.';return;}
          if(key===storageKey(draft.key)){status.textContent='This is the current tab’s draft. Select and copy the text; no data was changed.';return;}
          if(!navigator.locks || !tabReloadRecovery){status.textContent='Safe recovery is unavailable in this browser. Select and copy the draft text.';return;}
          try {
            await navigator.locks.request('bounty-board-tab:'+namespace,{ifAvailable:true},async lock=>{
              const identity=await BoardAPI.rootInstance();
              if(!box.isConnected || identity.root_instance!==scope.instance || rootIdentity()!==scope.root || state.data?.root_instance!==scope.instance || state.program!==scope.program || state.lane!==scope.lane){status.textContent='Workspace changed. Find saved drafts again.';return;}
              if(!lock){status.textContent='This draft belongs to a live tab. Copy the text instead; no data was changed.';return;}
              if(localStorage.getItem('bounty-board-lock-owner:'+namespace)!=='locked'){status.textContent='This older or lockless draft cannot be safely claimed. Select and copy its text.';return;}
              if(localStorage.getItem(key)!==raw){status.textContent='The saved draft changed. Find saved drafts again.';return;}
              if(draft.hasDraft || draft.pendingShared || draft.storageBlocked || draft.storageUnreadable || draft.storageError || localStorage.getItem(storageKey(draft.key))!==draft.storageSnapshot){status.textContent='This tab already has unsaved or changed data. Copy the draft instead.';return;}
              if(saved.pendingShared && (typeof saved.pendingShared!=='object' || typeof saved.pendingShared.content!=='string' || typeof saved.pendingShared.request_id!=='string' || typeof saved.pendingShared.base!=='string')){status.textContent='Pending request cannot be safely replayed. Copy the text instead.';return;}
              Object.assign(draft,{text:saved.text,original:saved.original,revision:saved.revision,hasDraft:saved.hasDraft!==false,conflictId:saved.conflictId,conflictBase:saved.conflictBase,staleResolution:!!saved.staleResolution,rejectedResolutions:Array.isArray(saved.rejectedResolutions)?saved.rejectedResolutions:[],pendingShared:saved.pendingShared||null,resolutionRejected:saved.resolutionRejected===saved.pendingShared?.request_id?saved.resolutionRejected:null,inspectRequested:saved.inspectRequested===saved.pendingShared?.request_id?saved.inspectRequested:null,publicationNotice:saved.publicationNotice||null,publicationDetail:saved.publicationDetail||null,reviewedPublications:Array.isArray(saved.reviewedPublications)?saved.reviewedPublications:[],status:saved.conflict?'conflict':'unsaved'});
              const persisted=persistDraft(draft);
              if(draftKey(state.program,state.lane,state.report)===draft.key){
                draft.applyingRemote=true;try {if(editor)editor.value(draft.text);}finally{draft.applyingRemote=false;}
                const preview=document.querySelector('#report-preview');if(preview)preview.innerHTML=markdown(draft.text);
              }
              if(!persisted){status.textContent='Recovery could not be saved in this tab. Copy the draft before leaving; the original remains unchanged.';refreshStatus(draft);renderRecovery();return;}
              status.textContent='Recovered into this tab; original saved draft retained.';
              draft.collabMessage=draft.status==='conflict' ? 'Conflict: your draft is preserved. Compare history and submit a resolution.' : draft.collabStarted ? 'Recovered local draft; saving shared draft…' : 'Recovered locally. Restore the source and reopen the report before retrying.';
              showSharedHistory(draft,draft.sharedHistory||[]);refreshStatus(draft);
              if(draft.collabStarted && draft.status!=='conflict')scheduleSharedSave(draft,0);
            });
          }catch{status.textContent='Safe recovery failed. Select and copy the draft text.';}
        });
      }
    } catch {note.textContent='Saved drafts could not be read from browser storage.';}
  }
  function startCollaboration(draft, program, path) {
    draft.collabStarted=true; draft.collabProgram={family:program.family,name:program.name}; draft.collabPath=path; draft.collabRoot=rootIdentity();
    pollShared(draft);
  }
  function conflictFresh(draft,item) {
    return (draft.historyRecent||[]).some(row=>row.id===item.id) || draft.conflictFreshness?.get(item.id)===draft.historyToken;
  }
  function rememberConflictPage(draft,items,token) {
    draft.conflictFreshness ||= new Map();
    for(const item of items)if(item.kind.endsWith(':conflict'))draft.conflictFreshness.set(item.id,token);
  }
  function showSharedHistory(draft, history, fromPoll=false) {
    const box=document.querySelector('#collaboration-history');
    if(!box || draftKey(state.program,state.lane,state.report)!==draft.key) return;
    // Do not destroy a user's selection while they copy recovery material.
    if(fromPoll && box.contains(document.activeElement) && document.activeElement.tagName==='TEXTAREA')return;
    const wasOpen=box.querySelector('details[data-shared-history]')?.open;
    const reviewedOpen=box.querySelector('details[data-reviewed-publications]')?.open;
    const resolutionBlocked=!!draft.pendingShared && !draft.resolutionQueued;
    box.innerHTML=(resolutionBlocked ? '<p>Wait for the current save to finish or inspect its retained outcome before resolving a conflict.</p>' : '')+(draft.rejectedResolutions?.length ? `<label>Rejected resolution requests<textarea readonly aria-label="Rejected resolution requests">${esc(JSON.stringify(draft.rejectedResolutions,null,2))}</textarea></label>` : '')+(state.data?.capabilities?.report_autosave && draft.pendingShared ? `<section aria-label="Publication recovery"><p>Request ${esc(draft.pendingShared.request_id)} is retained. Inspect its original receipt before submitting another edit. Inspection does not publish.</p><label>Original pending request<textarea readonly aria-label="Original pending request">${esc(JSON.stringify(draft.pendingShared,null,2))}</textarea></label>${draft.publicationDetail ? `<label>Latest publication inspection<textarea readonly aria-label="Latest publication inspection">${esc(JSON.stringify(draft.publicationDetail,null,2))}</textarea></label>` : ''}<button type="button" class="button" data-inspect-save>Inspect original save</button><button type="button" class="button" data-inspect-markdown>Inspect current Markdown</button>${draft.markdownInspection!=null ? `<label>Current Markdown inspection<textarea readonly aria-label="Current Markdown inspection">${esc(draft.markdownInspection)}</textarea></label>` : ''}${(draft.recoveryNotFound || draft.publicationDetail?.state==='capacity') ? '<button type="button" class="button" data-retry-original>Retry exact original request</button>' : ''}${draft.recoveryNotFound && draft.pendingShared.conflict_id && draft.resolutionRejected===draft.pendingShared.request_id ? '<p>The last resolution attempt was rejected, but an earlier attempt may still commit. Review history and Markdown. Continuing keeps the original request and sends the editor as a new edit from its original base; it may conflict and does not resolve the original conflict automatically.</p><button type="button" class="button" data-continue-resolution>Continue as a new edit after review</button>' : ''}${draft.publicationConflict ? '<button type="button" class="button" data-review-conflict>Continue after reviewing conflict</button><p>Compare retained versions and the current Markdown before continuing. Publication may already have changed the file.</p>' : ''}</section>` : '')+(draft.reviewedPublications?.length ? `<details data-reviewed-publications ${reviewedOpen?'open':''}><summary>Reviewed publication requests</summary><label>Retained request and inspection data<textarea readonly aria-label="Reviewed publication requests">${esc(JSON.stringify(draft.reviewedPublications,null,2))}</textarea></label></details>` : '')+`<details data-shared-history ${wasOpen?'open':''}><summary>Shared history and conflicts</summary>`+(draft.historyGaps?.length ? '<p role="status">History is incomplete; fetching missing pages. Keep this page open.</p>' : '')+history.map(item=>
      `<div class="record"><strong><span>Event #${esc(item.id)}</span> · <span>${esc(item.kind)}</span>${item.kind.endsWith(':conflict') ? (item.resolved_revision ? ' (resolved)' : ' (unresolved)') : ''}</strong> <span>Revision ${esc(item.revision.slice(0,12))}${item.head!==item.revision ? ` · result ${esc(item.head.slice(0,12))}` : ''}</span><button type="button" class="button" data-version="${esc(item.id)}">Preview this version</button>${item.head!==item.revision ? `<button type="button" class="button" data-result="${esc(item.id)}">Preview resulting revision</button>` : ''}${item.kind.endsWith(':conflict') && !item.resolved_revision ? `<button type="button" class="button" data-conflict="${esc(item.id)}" ${conflictFresh(draft,item) && !resolutionBlocked?'':'disabled'}>Resolve conflict ${esc(item.id)} with editor</button>${conflictFresh(draft,item)?'':` <span>Conflict status may be stale.</span> <button type="button" class="button" data-refresh-conflict="${esc(item.id)}">Refresh conflict ${esc(item.id)} status</button>`}` : ''}</div>`).join('')+(draft.historyBefore ? '<button type="button" class="button" data-older>Load older history</button>' : '')+
      (draft.versionPreview ? `<section class="panel-pad"><h3>Preview event #${esc(draft.versionPreview.id)} · revision ${esc(draft.versionPreview.revision)}</h3><label>Version preview<textarea readonly aria-label="Version preview">${esc(draft.versionPreview.value)}</textarea></label><button type="button" class="button" data-confirm-version>Confirm restore version</button><button type="button" class="button" data-cancel-version>Cancel preview</button></section>` : '')+'</details>' +
      (draft.retryExhausted ? '<button type="button" class="button" data-retry>Retry shared save</button>' : '') +
      (draft.staleResolution && draft.conflictBase ? '<button type="button" class="button" data-reopen>Retry as a new edit</button>' : '') +
      (draft.status==='conflict' && !draft.staleResolution ? `<button type="button" class="button" data-resolve ${resolutionBlocked?'disabled':''}>Submit editor as resolution</button>` : '') +
      (state.data?.capabilities?.report_autosave && !draft.pendingShared && !draft.hasDraft && !draft.sourceUnavailable && !draft.unresolvedCount && draft.reconciliationState==='complete' && typeof draft.sourceSnapshot==='string' && draft.sourceSnapshot!==draft.text ? `<section aria-label="Reconcile report"><p>Shared draft differs from Markdown. Review both before publishing; uncoordinated writers may race.</p><button type="button" class="button" data-preview-merge>Preview merged report</button>${draft.mergePreview ? `<label>Current Markdown<textarea readonly aria-label="Current Markdown">${esc(draft.mergePreview.source_snapshot)}</textarea></label><label>Merged shared report<textarea readonly aria-label="Merged shared report">${esc(draft.mergePreview.content)}</textarea></label><button type="button" class="button" data-save-merge>Save merged report</button>` : ''}</section>` : '') +
      (state.data?.capabilities?.fixture_publish ? '<p class="warning">Experimental fixture publishing can overwrite uncoordinated edits. Never use with real reports or sync.</p><button type="button" class="button" data-publish>Publish fixture report</button>' : '');
    box.querySelector('[data-preview-merge]')?.addEventListener('click',()=>{
      draft.mergePreview={base:draft.sharedRevision,content:draft.text,source_snapshot:draft.sourceSnapshot};
      showSharedHistory(draft,draft.sharedHistory||[]);
    });
    box.querySelector('[data-save-merge]')?.addEventListener('click',()=>{
      const p=draft.mergePreview;
      if(!p || draft.collabBusy || draft.hasDraft || draft.pendingShared || draft.unresolvedCount || draft.reconciliationState!=='complete' || p.base!==draft.sharedRevision || p.content!==draft.text || p.source_snapshot!==draft.sourceSnapshot){
        draft.mergePreview=null;draft.collabMessage='The preview is stale. Review the current shared draft and Markdown again.';showSharedHistory(draft,draft.sharedHistory||[]);refreshStatus(draft);return;
      }
      draft.mergePreview=null;draft.pendingShared={action:'reconcile',...p,request_id:crypto.randomUUID()};
      saveShared(draft,true);
    });
    box.querySelector('[data-inspect-save]')?.addEventListener('click',()=>inspectSave(draft));
    box.querySelector('[data-inspect-markdown]')?.addEventListener('click',async()=>{
      try {
        const report=await BoardAPI.report(draft.collabProgram,draft.lane,draft.collabPath);
        if(typeof report.content!=='string')throw new Error('Invalid report');
        draft.markdownInspection=report.content;showSharedHistory(draft,draft.sharedHistory||[]);
      } catch {draft.publicationNotice='Current Markdown could not be inspected. The file may have changed; retain the request and draft.';refreshStatus(draft);}
    });
    box.querySelector('[data-retry-original]')?.addEventListener('click',()=>{
      clearTimeout(draft.backlogRetryTimer);draft.backlogRetries=0;draft.recoveryNotFound=false;draft.retryExhausted=false;
      if(draft.collabBusy && draft.pollInFlight && draft.pendingShared){
        const pending=draft.pendingShared;
        draft.publicationNotice='Waiting for the current shared read before retrying the exact original request; its outcome remains unconfirmed.';
        if(persistDraft(draft))draft.retryAfterPoll=pending;
        else {draft.retryAfterPoll=null;renderRecovery();}
        refreshStatus(draft);return;
      }
      saveShared(draft,true);
    });
    box.querySelector('[data-continue-resolution]')?.addEventListener('click',()=>{
      const pending=draft.pendingShared;
      if(draft.collabBusy || !pending?.conflict_id || !draft.recoveryNotFound || draft.resolutionRejected!==pending.request_id)return;
      const before={pendingShared:pending,reviewedPublications:draft.reviewedPublications,revision:draft.revision,conflictId:draft.conflictId,status:draft.status,publicationNotice:draft.publicationNotice,resolutionRejected:draft.resolutionRejected,hasDraft:draft.hasDraft};
      draft.reviewedPublications=[...(draft.reviewedPublications||[]),{request:pending,publication:{state:'unconfirmed',reasons:['resolution_attempt_rejected','request_not_observed_at_inspection']}}];
      draft.pendingShared=null;draft.resolutionRejected=null;draft.revision=pending.base;draft.conflictId=null;draft.status='unsaved';draft.hasDraft=true;
      draft.publicationNotice='Continuing from the original base; the earlier outcome remains unconfirmed.';
      if(!persistDraft(draft)){Object.assign(draft,before);refreshStatus(draft);renderRecovery();return;}
      draft.recoveryNotFound=false;showSharedHistory(draft,draft.sharedHistory||[]);refreshStatus(draft);scheduleSharedSave(draft,0);
    });
    box.querySelector('[data-review-conflict]')?.addEventListener('click',()=>{
      const pending=draft.pendingShared, reviewed=draft.reviewedPublications || [];
      draft.reviewedPublications=[...reviewed,{request:pending,publication:draft.publicationDetail}];
      draft.pendingShared=null;draft.publicationConflict=false;draft.publicationNotice='Publication conflict reviewed. The file may have changed; compare history before submitting a resolution.';
      draft.status='conflict';
      if(!persistDraft(draft)){draft.pendingShared=pending;draft.reviewedPublications=reviewed;draft.publicationConflict=true;draft.publicationNotice='Browser storage failed. Copy the draft and request before leaving.';}
      showSharedHistory(draft,draft.sharedHistory||[]);refreshStatus(draft);
    });
    const useVersion=async (id, resultVersion)=>{
      const entry=history.find(item=>String(item.id)===id);if(!entry)return;
      const revision=resultVersion ? entry.head : entry.revision, before=draft.text;
      try {
        const legacy=resultVersion ? entry.head_content : entry.content;
        const value=typeof legacy==='string' ? legacy : (await BoardAPI.collaborationRead(draft.collabProgram,draft.lane,draft.collabPath,draft.collabRoot,'version',{revision})).content;
        if(typeof value!=='string' || draft.text!==before){draft.collabMessage='Version was not loaded because the editor changed. Select it again.';refreshStatus(draft);return;}
        draft.versionPreview={id,revision,value,before};showSharedHistory(draft,draft.sharedHistory||history);
      } catch {draft.collabMessage='Version could not be loaded. Your draft is retained.';refreshStatus(draft);}
    };
    box.querySelector('[data-confirm-version]')?.addEventListener('click',()=>{
      const preview=draft.versionPreview;if(!preview)return;
      if(draft.text!==preview.before){draft.versionPreview=null;draft.collabMessage='Version was not restored because the editor changed. Select it again.';showSharedHistory(draft,draft.sharedHistory||[]);refreshStatus(draft);return;}
      draft.versionPreview=null;
      draft.applyingRemote=true;try {if(editor && draftKey(state.program,state.lane,state.report)===draft.key)editor.value(preview.value);} finally {draft.applyingRemote=false;}
      updateDraft(draft,preview.value);showSharedHistory(draft,draft.sharedHistory||[]);
    });
    box.querySelector('[data-cancel-version]')?.addEventListener('click',()=>{draft.versionPreview=null;showSharedHistory(draft,draft.sharedHistory||[]);});
    box.querySelectorAll('[data-version]').forEach(button=>button.addEventListener('click',()=>useVersion(button.dataset.version,false)));
    box.querySelectorAll('[data-result]').forEach(button=>button.addEventListener('click',()=>useVersion(button.dataset.result,true)));
    box.querySelector('[data-older]')?.addEventListener('click',async()=>{
      const before=draft.historyBefore, token=draft.historyToken; if(draft.historyLoading)return;draft.historyLoading=true;
      // Preserve the boundary before awaiting: a poll can slide the recent page
      // while the older-page request is in flight.
      draft.historyPaged=true;
      const retained=new Map((draft.historyOlder||[]).map(item=>[item.id,item]));
      for(const item of draft.historyRecent||[])retained.set(item.id,item);
      draft.historyOlder=[...retained.values()];
      try {const page=await BoardAPI.collaborationRead(draft.collabProgram,draft.lane,draft.collabPath,draft.collabRoot,'history',{before});
        rememberConflictPage(draft,page.history,token);
        const entries=new Map((draft.historyOlder||[]).map(item=>[item.id,item]));for(const item of page.history)entries.set(item.id,item);
        draft.historyOlder=[...entries.values()];draft.historyPaged=true;
        const all=new Map(draft.historyOlder.map(item=>[item.id,item]));for(const item of draft.historyRecent||[])all.set(item.id,item);
        draft.sharedHistory=[...all.values()].sort((a,b)=>b.id-a.id);draft.historyBefore=page.next_before;draft.unresolvedCount=page.unresolved_count;showSharedHistory(draft,draft.sharedHistory);
      } catch {draft.collabMessage='Older history could not be loaded. Retry from history.';refreshStatus(draft);}
      finally {draft.historyLoading=false;}
    });
    box.querySelector('[data-retry]')?.addEventListener('click',()=>{draft.retryExhausted=false;draft.retryAttempts=0;draft.pollAttempts=0;draft.pollRetryAt=0;showSharedHistory(draft,draft.sharedHistory || []);if(draft.collabReady && draft.hasDraft)scheduleSharedSave(draft,0);else pollShared(draft);});
    box.querySelector('[data-reopen]')?.addEventListener('click',()=>{draft.revision=draft.conflictBase;draft.conflictId=null;draft.staleResolution=false;draft.status='unsaved';draft.collabMessage='Retrying as a new edit against the original base…';persistDraft(draft);showSharedHistory(draft,draft.sharedHistory||[]);refreshStatus(draft);scheduleSharedSave(draft,0);});
    box.querySelectorAll('[data-refresh-conflict]').forEach(button=>button.addEventListener('click',async()=>{
      const id=Number(button.dataset.refreshConflict),token=draft.historyToken;
      button.disabled=true;
      try {
        const page=await BoardAPI.collaborationRead(draft.collabProgram,draft.lane,draft.collabPath,draft.collabRoot,'history',{before:id+1});
        const row=page.history.find(item=>item.id===id);
        if(!row)throw new Error('Conflict missing');
        for(const list of [draft.historyOlder,draft.historyRecent,draft.sharedHistory])for(let i=0;i<(list||[]).length;i++)if(list[i].id===id)list[i]=row;
        rememberConflictPage(draft,[row],token);showSharedHistory(draft,draft.sharedHistory||[]);
      } catch {draft.collabMessage='Conflict status could not be refreshed. Retry before resolving.';showSharedHistory(draft,draft.sharedHistory||[]);refreshStatus(draft);}
    }));
    const resolve=(id)=>{
      if(!draft.sharedRevision || (!id && !draft.revision) || draft.pendingShared || (draft.collabBusy && !draft.pollInFlight))return;
      // Only an explicit store-conflict resolution is based on the reviewed
      // head. A publication-only conflict is a new edit from its causal base.
      draft.publicationNotice=null;draft.conflictId=id; if(id)draft.revision=draft.sharedRevision; draft.status='unsaved';draft.hasDraft=true;draft.collabMessage='Submitting resolution…';
      const pending={base:draft.revision,content:draft.text,request_id:crypto.randomUUID()};if(id)pending.conflict_id=id;
      draft.pendingShared=pending;draft.resolutionQueued=true;
      if(!persistDraft(draft)){refreshStatus(draft);renderRecovery();return;}
      refreshStatus(draft);scheduleSharedSave(draft);
    };
    box.querySelector('[data-resolve]')?.addEventListener('click',()=>resolve(draft.conflictId));
    box.querySelectorAll('[data-conflict]').forEach(button=>button.addEventListener('click',()=>resolve(Number(button.dataset.conflict))));
    box.querySelector('[data-publish]')?.addEventListener('click',()=>{
      if(draft.collabBusy && draft.pollInFlight && !draft.hasDraft && draft.sharedRevision){
        draft.publishAfterPoll=draft.sharedRevision;
        draft.collabMessage='Waiting for the current shared read before publishing…';refreshStatus(draft);return;
      }
      publishFixture(draft,draft.sharedRevision);
    });
  }
  async function publishFixture(draft, expectedRevision) {
    if(reportReadOnly(draft))return;
    if(draft.sourceUnavailable){draft.collabMessage='Source unavailable. Publication was not attempted.';refreshStatus(draft);return;}
    if(draft.hasDraft || draft.collabBusy || !expectedRevision || draft.sharedRevision!==expectedRevision){draft.collabMessage='Save or resolve your local draft before publishing; retry if the shared revision changed.';refreshStatus(draft);return;}
    draft.collabBusy=true;draft.fixturePublishedRevision=null;
    try {
      await BoardAPI.collaboration(draft.collabProgram,draft.lane,draft.collabPath,{action:'publish',revision:expectedRevision},draft.collabRoot);
      draft.fixturePublishedRevision=expectedRevision;
      draft.collabMessage='Fixture report published. Uncoordinated writers are not protected.';
    } catch {draft.collabMessage='Fixture publication failed or became stale. Your draft is retained; refresh and resolve conflicts.';}
    finally {draft.collabBusy=false;refreshStatus(draft);if(draft.hasDraft && draft.status!=='conflict')scheduleSharedSave(draft);}
  }
  function applyShared(draft, content, revision) {
    draft.text=content; draft.original=content; draft.revision=revision; draft.hasDraft=false; draft.status='saved';
    persistDraft(draft);
    if(editor && draftKey(state.program,state.lane,state.report)===draft.key) {
      const previous=editor.value();
      if(previous!==content) {
        // A linked document with a separate history makes CodeMirror rebase
        // local undo over the remote change without recording it as local undo.
        let start=0, oldEnd=previous.length, newEnd=content.length;
        while(start<oldEnd && start<newEnd && previous[start]===content[start]) start++;
        while(oldEnd>start && newEnd>start && previous[oldEnd-1]===content[newEnd-1]) {oldEnd--;newEnd--;}
        const cm=editor.codemirror, doc=cm.getDoc(), undoBefore=doc.historySize().undo;
        const remote=doc.linkedDoc({sharedHist:false});
        draft.applyingRemote=true;
        try {remote.replaceRange(content.slice(start,newEnd),remote.posFromIndex(start),remote.posFromIndex(oldEnd),'+remote');}
        finally {doc.unlinkDoc(remote);draft.applyingRemote=false;}
        if(doc.historySize().undo<undoBefore) draft.undoNotice='Some local undo history was discarded because it overlaps or shares lines with a collaborator’s edit. Review the shared history before changing it.';
      }
      const preview=document.querySelector('#report-preview'); if(preview)preview.innerHTML=markdown(content);
    }
  }
  async function pollShared(draft) {
    if(reportReadOnly(draft) || draft.collabBusy || draft.retryExhausted || (draft.pollRetryAt && Date.now()<draft.pollRetryAt)) return;
    draft.collabBusy=true;draft.pollInFlight=true;let pollSucceeded=false;
    try {
      const result=await BoardAPI.collaboration(draft.collabProgram,draft.lane,draft.collabPath,null,draft.collabRoot);
      if(state.data?.capabilities?.report_autosave && draft.sharedRevision && draft.sharedRevision!==result.revision && !draft.pendingShared){draft.publicationNotice=null;persistDraft(draft);}
      draft.sharedRevision=result.revision;draft.pollAttempts=0;draft.pollRetryAt=0;
      draft.sourceUnavailable=result.source_status==='source_unavailable';
      draft.sourceSnapshot=typeof result.source_snapshot==='string' ? result.source_snapshot : null;
      draft.reconciliationState=result.reconciliation?.state || null;
      if(draft.mergePreview && (draft.mergePreview.base!==result.revision || draft.mergePreview.source_snapshot!==draft.sourceSnapshot || draft.reconciliationState!=='complete' || result.unresolved_count))draft.mergePreview=null;
      const recent=result.history || [];
      const previous=draft.historyRecent||[];
      const priorHead=previous.length ? Math.max(...previous.map(item=>item.id)) : null;
      const missed=priorHead!==null && recent.length && !recent.some(item=>previous.some(old=>old.id===item.id)) && Math.min(...recent.map(item=>item.id))>priorHead;
      if(draft.historyToken===undefined)draft.historyToken=0;
      else if((result.unresolved_count!=null && draft.unresolvedCount!=null && result.unresolved_count!==draft.unresolvedCount) || missed || recent.some(item=>item.id>priorHead && item.kind.startsWith('resolution:')))draft.historyToken++;
      // A full recent page without an overlap may have skipped events. Keep
      // each missing interval until a cursor page reaches its old boundary.
      if(draft.historyPaged && previous.length && recent.length && !recent.some(item=>previous.some(old=>old.id===item.id)) && Math.min(...recent.map(item=>item.id))>Math.max(...previous.map(item=>item.id))){
        (draft.historyGaps ||= []).push({before:Math.min(...recent.map(item=>item.id)),anchor:Math.max(...previous.map(item=>item.id))});
      }
      if(draft.historyPaged){const older=new Map((draft.historyOlder||[]).map(item=>[item.id,item]));for(const item of previous)older.set(item.id,item);draft.historyOlder=[...older.values()];}
      draft.historyRecent=recent;
      if(draft.historyGaps?.length){
        showSharedHistory(draft,draft.sharedHistory||[],true);refreshStatus(draft);
        const gap=draft.historyGaps[0];
        // One bounded page per poll; a failure leaves the cursor intact.
        const page=await BoardAPI.collaborationRead(draft.collabProgram,draft.lane,draft.collabPath,draft.collabRoot,'history',{before:gap.before});
        const older=new Map((draft.historyOlder||[]).map(item=>[item.id,item]));for(const item of page.history)older.set(item.id,item);draft.historyOlder=[...older.values()];
        if(!page.next_before || page.history.some(item=>item.id<=gap.anchor))draft.historyGaps.shift();
        else gap.before=page.next_before;
      }
      const entries=new Map((draft.historyOlder||[]).map(item=>[item.id,item]));for(const item of recent)entries.set(item.id,item);
      draft.sharedHistory=[...entries.values()].sort((a,b)=>b.id-a.id);
      if(!draft.historyPaged)draft.historyBefore=recent.length===50 ? Math.min(...recent.map(item=>item.id)) : null;
      if(draft.conflictId && !draft.conflictBase){const conflict=draft.sharedHistory.find(item=>item.id===draft.conflictId);if(conflict?.base){draft.conflictBase=conflict.base;persistDraft(draft);}}
      draft.unresolvedCount=result.unresolved_count ?? recent.filter(item=>item.kind.endsWith(':conflict') && !item.resolved_revision).length;
      if(!draft.hasDraft) applyShared(draft,result.content,result.revision);
      draft.collabReady=true;
      const unresolved=draft.unresolvedCount;
      draft.collabMessage=draft.status==='conflict' ? 'Conflict: your draft is preserved. Compare history and submit a resolution.' : draft.hasDraft ? 'Unsaved locally; saving shared draft…' : `Shared draft ready. ${state.data?.capabilities?.report_autosave ? 'Markdown publication is not confirmed by this read.' : 'Source report is not saved.'}${unresolved ? ` ${unresolved} unresolved conflict(s); see history.` : ''}${draft.fixturePublishedRevision===result.revision && !unresolved ? ' Fixture report published earlier; uncoordinated writers are not protected.' : ''}`;
      if(draft.hasDraft && draft.status!=='conflict') scheduleSharedSave(draft);
      showSharedHistory(draft,draft.sharedHistory,true);
      pollSucceeded=true;
    } catch {
      draft.pollAttempts=(draft.pollAttempts||0)+1;
      if(draft.pollAttempts>=3){draft.retryExhausted=true;draft.collabMessage='Shared draft unavailable. Your local draft is retained; use Retry shared save.';showSharedHistory(draft,draft.sharedHistory||[]);}
      else {draft.pollRetryAt=Date.now()+500 * 2 ** (draft.pollAttempts-1);draft.collabMessage='Shared draft unavailable. Your local draft is retained; retrying.';}
    }
    finally {
      draft.collabBusy=false;draft.pollInFlight=false;
      const pendingPublish=draft.publishAfterPoll;draft.publishAfterPoll=null;
      const retry=draft.retryAfterPoll;draft.retryAfterPoll=null;
      if(draft.inspectRequested && draft.pendingShared?.request_id===draft.inspectRequested)inspectSave(draft);
      else if(retry && retry===draft.pendingShared){
        if(pollSucceeded && !draft.sourceUnavailable && !draft.storageBlocked && !draft.storageUnreadable && !draft.storageError)saveShared(draft,true);
        else {draft.publicationNotice='Shared read failed or source unavailable; the exact retry was not sent. Retain the request and inspect before retrying.';persistDraft(draft);}
      }
      else if(draft.resolutionQueued)scheduleSharedSave(draft,0);
      else if(draft.hasDraft && draft.collabReady && draft.status!=='conflict')scheduleSharedSave(draft);
      if(pendingPublish){
        if(pollSucceeded)publishFixture(draft,pendingPublish);
        else draft.collabMessage='Shared read failed; fixture publication was not attempted. Retry after refresh.';
      }
      refreshStatus(draft);
    }
  }
  async function inspectSave(draft) {
    const pending=draft.pendingShared;
    clearTimeout(draft.backlogRetryTimer);
    draft.retryAfterPoll=null;
    if(!pending)return;
    draft.inspectRequested=pending.request_id;
    draft.publicationNotice='Waiting to inspect the original save; its outcome remains unconfirmed.';
    if(!persistDraft(draft)){refreshStatus(draft);renderRecovery();return;}
    if(draft.collabBusy){refreshStatus(draft);return;}
    draft.collabBusy=true;draft.recoveryNotFound=false;
    try {
      const result=await BoardAPI.collaborationRead(draft.collabProgram,draft.lane,draft.collabPath,draft.collabRoot,'recovery',{request_id:pending.request_id});
      if(draft.pendingShared!==pending)return;
      if(!result.store_receipt || result.store_saved!==true)throw new Error('Missing receipt');
      handleAutosaveReceipt(draft,pending,result.store_receipt,result.publication,true);
    } catch(error) {
      draft.recoveryNotFound=error.status===404;
      draft.publicationNotice=error.status===404 ? 'Original request not found in the store at inspection time. The outcome is unconfirmed; you may retry the exact original request, not a new one.' : 'Original request inspection failed. Store and Markdown outcomes are unconfirmed; retain the request and copy your draft.';
      persistDraft(draft);
    } finally {draft.inspectRequested=null;persistDraft(draft);draft.collabBusy=false;showSharedHistory(draft,draft.sharedHistory||[]);refreshStatus(draft);if(!draft.pendingShared && draft.hasDraft && draft.status!=='conflict')scheduleSharedSave(draft);}
  }
  function handleAutosaveReceipt(draft,pending,receipt,publication,inspected=false) {
    const stateName=publication?.state;
    draft.publicationDetail=publication ?? null;
    // This response is emitted before any exchange, so a successful shared
    // edit is safe to acknowledge separately from Markdown publication.
    const storeOnly=publication?.state==='conflict' && ((!publication.operation && publication.reasons?.includes('store_needs_reconciliation')) || (inspected && publication.reasons?.includes('not_published')));
    if(storeOnly && ['saved','merged','unchanged'].includes(receipt.status) && typeof receipt.revision==='string' && typeof receipt.content==='string' && (draft.text===pending.content || typeof receipt.incoming_revision==='string')){
      draft.pendingShared=null;draft.conflictId=null;draft.publicationConflict=false;draft.sharedRevision=receipt.revision;
      draft.publicationNotice='Saved to shared draft only. Review the merged report before saving Markdown.';
      if(draft.text===pending.content)applyShared(draft,receipt.content,receipt.revision);
      else {
        // Later editor text descends from the submitted input, not the merged
        // receipt. The store must three-way merge it against that input.
        draft.revision=receipt.incoming_revision;draft.original=pending.content;persistDraft(draft);
      }
      return true;
    }
    if(stateName!=='published' || !['saved','merged','unchanged'].includes(receipt.status) || typeof receipt.revision!=='string' || typeof receipt.content!=='string' || (draft.text!==pending.content && typeof receipt.incoming_revision!=='string')) {
      draft.hasDraft=true;draft.publicationConflict=inspected && stateName==='conflict';
      if(receipt.status==='conflict'){draft.conflictId=receipt.conflict_id;draft.conflictBase=pending.base;}
      else if(['saved','merged','unchanged'].includes(receipt.status) && typeof receipt.incoming_revision==='string'){
        draft.revision=receipt.incoming_revision;draft.original=pending.content;
      }
      const shared=receipt.status==='conflict' ? 'Shared draft conflict retained. ' : 'Shared draft saved. ';
      draft.publicationNotice=shared+(stateName==='capacity' ? 'Markdown was not saved: retention capacity or free space is exhausted. Increase capacity or manage backups, then retry the exact original request.' : stateName==='conflict' ? 'Publication conflict: the Markdown file may already have changed. Inspect the original save and compare retained history before resolving.' : stateName==='pending' ? 'Markdown publication is pending and unconfirmed. Inspect the original save.' : 'Markdown publication outcome is uncertain or unrecognized. Inspect the original save; retain this request for manual review.');
      persistDraft(draft);return false;
    }
    draft.pendingShared=null;draft.publicationConflict=false;draft.recoveryNotFound=false;draft.retryAttempts=0;draft.sharedRevision=receipt.revision;
    // A pre-save poll is no longer a valid source snapshot for a new preview.
    draft.sourceSnapshot=null;draft.reconciliationState=null;draft.mergePreview=null;
    draft.publicationNotice='Shared draft saved. Markdown file saved and inspected at that moment; external changes may occur afterward.';
    if(draft.text===pending.content){draft.conflictId=null;applyShared(draft,receipt.content,receipt.revision);}
    else {draft.conflictId=null;draft.revision=receipt.incoming_revision || receipt.revision;draft.original=pending.content;draft.publicationNotice='Earlier shared draft and Markdown were saved at that moment. Newer editor changes are not yet saved.';persistDraft(draft);}
    return true;
  }
  function scheduleSharedSave(draft, delay=500) {
    clearTimeout(draft.saveTimer);
    if(reportReadOnly(draft) || draft.retryExhausted || (state.data?.capabilities?.report_autosave && draft.pendingShared && !draft.resolutionQueued) || draft.storageBlocked || draft.storageUnreadable || draft.storageError || (draft.sourceUnavailable && !draft.pendingShared))return;
    draft.saveTimer=setTimeout(()=>saveShared(draft,!!draft.resolutionQueued),delay);
  }
  // Only an explicit pre-submit backlog response permits automatic replay.
  function scheduleBacklogRetry(draft,pending,delay) {
    clearTimeout(draft.backlogRetryTimer);
    if(draft.inspectRequested)return;
    draft.backlogRetryTimer=setTimeout(()=>{
      if(draft.pendingShared!==pending || draft.storageBlocked || draft.storageUnreadable || draft.storageError || reportReadOnly(draft))return;
      if(draft.collabBusy){scheduleBacklogRetry(draft,pending,100);return;}
      saveShared(draft,true);
    },delay);
  }
  async function saveShared(draft, retryOriginal=false) {
    const autosave=state.data?.capabilities?.report_autosave===true;
    if(reportReadOnly(draft) || draft.collabBusy || !draft.collabReady || (draft.status==='conflict' && !retryOriginal) || (autosave && draft.pendingShared && !retryOriginal)) return;
    draft.collabBusy=true;
    draft.resolutionQueued=false;
    const pending=draft.pendingShared || {base:draft.revision,content:draft.text,request_id:crypto.randomUUID()};
    if(draft.conflictId && !draft.pendingShared)pending.conflict_id=draft.conflictId;
    draft.pendingShared=pending;
    // Persist the exact idempotency payload before it can reach the server.
    if(!persistDraft(draft)){draft.collabBusy=false;refreshStatus(draft);renderRecovery();return;}
    showSharedHistory(draft,draft.sharedHistory||[]);
    if(autosave){draft.publicationNotice='Saving shared draft; Markdown publication is pending and unconfirmed.';refreshStatus(draft);}
    try {
      const result=await BoardAPI.collaboration(draft.collabProgram,draft.lane,draft.collabPath,pending,draft.collabRoot);
      draft.backlogRetries=0;
      if(autosave){
        if(result.store_saved!==true)throw new Error('Missing store receipt');
        handleAutosaveReceipt(draft,pending,result,result.publication);
        showSharedHistory(draft,draft.sharedHistory||[]);
        return;
      }
      draft.pendingShared=null; draft.sharedRevision=result.revision; draft.retryAttempts=0;
      if(pending.conflict_id && result.status!=='conflict') {
        // Older cached pages do not appear in the next bounded poll.
        for(const list of [draft.historyOlder,draft.historyRecent,draft.sharedHistory])
          for(const item of list||[])if(item.id===pending.conflict_id)item.resolved_revision=result.revision;
        showSharedHistory(draft,draft.sharedHistory||[]);
      }
      if(result.status==='conflict') {
        draft.conflictId=result.conflict_id;draft.conflictBase=pending.base;draft.staleResolution=false; draft.status='conflict'; draft.collabMessage='Conflict: your draft is preserved. Compare history and submit a resolution.'; persistDraft(draft);
      } else if(draft.text===pending.content) {
        draft.conflictId=null;
        applyShared(draft,result.content,result.revision); draft.collabMessage='Shared draft ready. Source report is not saved.';
      } else {
        draft.conflictId=null;
        draft.revision=result.incoming_revision; draft.original=pending.content; persistDraft(draft); scheduleSharedSave(draft);
      }
    } catch (error) {
      if(autosave && error.status===503 && error.code==='retained_scan_backlog'){
        draft.hasDraft=true;
        const retries=draft.backlogRetries||0, limit=3;
        if(retries<limit){
          draft.backlogRetries=retries+1;
          draft.publicationNotice=`Retained history scan is backlogged; this attempt was not submitted. Retrying the exact request (${retries+1}/${limit}); newer edits are retained.`;
          if(persistDraft(draft))scheduleBacklogRetry(draft,pending,500 * 2 ** retries);
        } else {
          draft.publicationNotice='Retained history scan is still backlogged. Automatic retries exhausted; the request and newer edits are retained. Inspect the original save before retrying.';
          persistDraft(draft);
        }
        showSharedHistory(draft,draft.sharedHistory||[]);
      }
      else if(autosave && pending.action==='reconcile' && error.code==='reconciliation_changed'){
        draft.pendingShared=null;draft.mergePreview=null;draft.reconciliationState=null;
        draft.publicationNotice='The merged preview is stale; Markdown was not saved. Review the changed shared draft and Markdown again.';
        persistDraft(draft);showSharedHistory(draft,draft.sharedHistory||[]);
      }
      else if(autosave){if(error.status===409 && pending.conflict_id)draft.resolutionRejected=pending.request_id;draft.hasDraft=true;draft.publicationNotice='Save outcome unconfirmed: shared draft and Markdown may or may not have been saved. Inspect the original save before submitting another edit.';persistDraft(draft);showSharedHistory(draft,draft.sharedHistory||[]);}
      else if(error.code==='source_unavailable'){
        draft.sourceUnavailable=true;draft.retryExhausted=true;
        draft.collabMessage='Source unavailable; pending request and local draft are retained. Restore the source before retrying.';
        persistDraft(draft);showSharedHistory(draft,draft.sharedHistory||[]);
      }
      else if(error.status===409){if(pending.conflict_id)(draft.rejectedResolutions ||= []).push(pending);draft.pendingShared=null;draft.staleResolution=!!pending.conflict_id;draft.status='conflict';draft.collabMessage='Conflict or stale resolution. Your draft is preserved; review history before retrying.';persistDraft(draft);showSharedHistory(draft,draft.sharedHistory||[]);}
      else {
        draft.retryAttempts=(draft.retryAttempts||0)+1;
        if(draft.retryAttempts>=3){draft.retryExhausted=true;draft.collabMessage='Shared save failed. Your local draft is retained; use Retry shared save.';showSharedHistory(draft,draft.sharedHistory||[]);}
        else {draft.collabMessage='Shared save failed. Your local draft is retained; retrying.';scheduleSharedSave(draft,500 * 2 ** (draft.retryAttempts-1));}
      }
    }
    finally {draft.collabBusy=false;showSharedHistory(draft,draft.sharedHistory||[]);refreshStatus(draft);if(draft.inspectRequested && draft.pendingShared?.request_id===draft.inspectRequested)inspectSave(draft);else if(autosave && !draft.pendingShared && draft.hasDraft && draft.status!=='conflict')scheduleSharedSave(draft);}
  }
  setInterval(()=>{for(const draft of state.drafts.values()) if(draft.collabStarted && !draft.collabBusy && (!draft.pendingShared || state.data?.capabilities?.report_autosave)) pollShared(draft);},2000);
  function reportStatus(draft) {
    return reportStatusBase(draft)+(draft.reviewedPublications?.some(item=>item.publication?.reasons?.includes('resolution_attempt_rejected') && item.publication?.state==='unconfirmed') ? ' Earlier resolution outcome remains unconfirmed; see retained request in history.' : '');
  }
  function reportStatusBase(draft) {
    if(draft.sourceUnavailable) return state.data?.capabilities?.report_autosave ? 'Source unavailable. Markdown publication cannot be confirmed now; the file may have changed. Keep the draft and inspect any original request.' : 'Source unavailable. Shared history is retained but not saved to the report. Restore the source before saving; copy any local edits.';
    const sourceUnavailable=draft.source?.loadState==='error' ? 'Source unavailable. ' : '';
    if(state.data?.capabilities?.collaboration && !tabReloadRecovery) return 'This browser cannot safely restore collaborative drafts on reload. Copy unsaved edits before leaving. '+(draft.collabMessage||'');
    if(draft.storageBlocked) return `${draft.status==='conflict'?'Conflict: the report changed in its source. The conflict warning may not be saved. ':''}${sourceUnavailable}Browser draft data is invalid or changed in another tab; it was not overwritten. Copy your edits before leaving.`;
    if(draft.collabMessage && (draft.storageError || draft.storageUnreadable)) return `${draft.status==='conflict'?'Conflict: ':''}${sourceUnavailable}Browser draft storage unavailable. Your edits may be only in this tab; copy them before leaving.`;
    if(state.data?.capabilities?.report_autosave && draft.pendingShared) return draft.publicationNotice || 'Save outcome unconfirmed. Inspect the original save; your request and draft are retained.';
    if(state.data?.capabilities?.report_autosave && draft.publicationNotice) return draft.publicationNotice;
    if(draft.collabMessage) return draft.collabMessage;
    if(draft.status==='conflict') return `Conflict: the report changed in its source. ${sourceUnavailable}${draft.storageError?'Browser draft storage unavailable; the conflict warning could not be saved. Copy your edits before leaving.':'Your browser draft is preserved; compare it with the source before reconciling.'}`;
    if(sourceUnavailable && draft.storageError) return `${sourceUnavailable}Browser draft storage unavailable; copy your edits before leaving.`;
    if(sourceUnavailable) return `${sourceUnavailable}Your draft is shown; copy it or refresh to retry.`;
    if(draft.storageUnreadable && !rootIdentity()) return 'Root identity unavailable. Your edits are only in this tab; copy them before refreshing or leaving.';
    if(draft.storageError) return 'Browser draft storage unavailable. Your edits are only in this tab; copy them before leaving.';
    if(draft.hasDraft) return 'Draft saved in browser, not to the source report.';
    return 'Saving to report unavailable. Edits are saved as browser drafts.';
  }
  function sectionContent(){switch(state.section){case 'findings':return findings();case 'coverage':return coverage();case 'reports':return reports();case 'map':return observations('map','MapStore');case 'gadgets':return observations('gadgets','Gadgets');default:return '';}}
  function render() {
    const oldPath=app.querySelector('#saved-shared-path'), focus=oldPath && document.activeElement===oldPath ? {key:oldPath.dataset.recoveryKey,start:oldPath.selectionStart,end:oldPath.selectionEnd,direction:oldPath.selectionDirection} : null;
    const active=document.activeElement, focusKey=active && app.contains(active) ? ['data-sort','data-sort-menu','data-breakdown','data-dash-work','data-class-group','data-section'].map(attr=>active.hasAttribute(attr)?[attr,active.getAttribute(attr),!!active.closest('.tabs')]:null).find(Boolean) : null;
    ++renderGeneration;
    if(editor){editor.toTextArea();editor=null;}
    hideTip();
    // Module hosts survive re-renders when they still describe the same report,
    // so a live editor session is not torn down by unrelated updates.
    const keptHosts=['live-report-host','report-artifacts-host'].map(id=>app.querySelector(`#${id}`)).filter(Boolean);
    const reportListScroll=app.querySelector('.report-links')?.scrollTop || 0;
    document.querySelector('#refresh').disabled=state.metadataPending || state.loading;
    portfolioAction.hidden=!state.data?.portfolio_unloaded;
    portfolioButton.disabled=!!state.data?._portfolioLoading;
    document.querySelectorAll('[data-view]').forEach(b=>{const active=b.dataset.view===state.view;b.classList.toggle('active',active);if(active)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
    syncNavLinks();
    document.querySelector('#breadcrumb').textContent=state.view==='dashboard'?'Dashboard':state.view==='recent'?'Recent reports':state.view==='recon'?'Recon intel':'Programs';
    const trail=document.querySelector('#breadcrumb-trail'), crumbProgram=state.view==='program' && !state.loading ? currentProgram() : null;
    if(trail)trail.innerHTML=crumbProgram ? [programLabel(crumbProgram),state.lane,(sections.find(([k])=>k===state.section)||[])[1]].filter(Boolean).map(part=>`<span class="sep" aria-hidden="true">/</span> <span class="crumb-current">${esc(part)}</span>`).join(' ') : '';
    if(state.loading) app.innerHTML=skeleton();
    else if(state.error) app.innerHTML=`<div class="panel empty error-state" role="alert">${icon('exclamation-circle')}<h2>Workspace unavailable</h2><p>${esc(state.error)}</p></div>`;
    else app.innerHTML=state.view==='dashboard'?dashboard():state.view==='recent'?recentView():state.view==='recon'?reconView():workspace();
    for(const old of keptHosts){const fresh=app.querySelector(`#${old.id}`);if(fresh && ['family','program','lane','path','reportId'].every(k=>fresh.dataset[k]===old.dataset[k]))fresh.replaceWith(old);}
    const reportList=app.querySelector('.report-links');if(reportList && reportListScroll)reportList.scrollTop=reportListScroll;
    if(state.routeNotice && !state.loading)app.insertAdjacentHTML('afterbegin',`<div class="message warning" role="alert">${esc(state.routeNotice)} <button type="button" class="link-button" data-dismiss-route-notice>Dismiss</button></div>`);
    if(state.metadataPending && !app.querySelector('#metadata-message')) app.insertAdjacentHTML('afterbegin','<div class="message warning" role="status">Updating metadata; waiting for confirmation. Displayed values are the last loaded or confirmed values.</div>');
    if(state.metadataErrors.length) app.insertAdjacentHTML('afterbegin',state.metadataErrors.map(error=>`<div class="message warning" role="alert">${esc(error)}</div>`).join(''));
    if(state.metadataDrafts.size) app.insertAdjacentHTML('afterbegin',[...state.metadataDrafts.values()].map(d=>`<div class="message warning" role="alert">${esc(d.message)}<label>Pending ${esc(d.field)} value — copy before leaving<textarea readonly rows="2">${esc(d.value)}</textarea></label><button type="button" data-discard-metadata="${d.sequence}">Discard pending value</button></div>`).join(''));
    const pathInput=app.querySelector('#saved-shared-path'), pathKey=recoveryPathKey();
    if(pathInput){pathInput.dataset.recoveryKey=pathKey;if(focus?.key===pathKey){pathInput.focus();pathInput.setSelectionRange(focus.start,focus.end,focus.direction);}}
    const hiddenPaths=[...recoveryPaths.entries()].filter(([key])=>!pathInput || key!==pathKey);
    if(hiddenPaths.length)app.insertAdjacentHTML('afterbegin',hiddenPaths.map(([,p])=>`<div class="message warning">Recovery path retained for ${esc(p.program)} / ${esc(p.lane)}; source ${esc(p.source)}. Copy it before leaving.<label>Retained recovery path<textarea readonly rows="2">${esc(p.value)}</textarea></label><button type="button" data-discard-path="${p.sequence}">Discard retained path</button></div>`).join(''));
    const visibleRationales=new Set([...app.querySelectorAll('[data-rationale-input]')].map(el=>rationaleKey(state.program,state.lane,el.dataset.rationaleInput)));
    const hiddenRationales=[...state.rationaleDrafts.entries()].filter(([key])=>!visibleRationales.has(key)).map(([,draft])=>draft);
    if(hiddenRationales.length) app.insertAdjacentHTML('afterbegin',hiddenRationales.map(d=>`<div class="message warning">Unsaved severity rationale for ${esc(d.program)} / ${esc(d.lane)} / ${esc(d.id)}; source instance: ${esc(/^[a-f0-9]{64}$/.test(d.rootInstance || '') ? d.rootInstance : 'unknown')}.<label>Pending severity rationale — copy before leaving<textarea readonly rows="3">${esc(d.text)}</textarea></label></div>`).join(''));
    const source=app.querySelector('#report-source');
    if(source && typeof EasyMDE !== 'undefined') {
      // EasyMDE's own autosave removes empty values and clears data on submit;
      // the board owns persistence and retains the source revision instead.
      editor=new EasyMDE({element:source,autoDownloadFontAwesome:false,autosave:{enabled:false},forceSync:true,spellChecker:false,status:false,previewRender:markdown,toolbar:source.readOnly ? false : ['bold','italic','heading','|','quote','unordered-list','ordered-list','code','|','preview','side-by-side']});
      if(source.readOnly)editor.codemirror.setOption('readOnly',true);
      const field=editor.codemirror.getInputField();field.id='report-source-editor';app.querySelector('label[for="report-source"]').htmlFor=field.id;field.setAttribute('aria-describedby','report-status');
      const draft=draftFor(reportById(state.report));
      editor.codemirror.on('change',()=>updateDraft(draft,editor.value()));
    }
    renderRecovery();
    applyProgramSearch();
    applyReportFilter();
    renderRecent();
    if(focusKey){const el=app.querySelector(`${focusKey[2]?'.tabs ':''}[${focusKey[0]}="${CSS.escape(focusKey[1])}"]`);el?.focus({preventScroll:true});}
    if(state.scrollToHighlight){const row=app.querySelector(`tr.highlight`);if(row){state.scrollToHighlight=false;row.scrollIntoView({block:'center',behavior:'smooth'});}}
    reanchorPopover();
    syncRoute();
    for(const module of window.BoardModules || []){try{module.afterRender?.(moduleContext());}catch(error){console.error('Board module failed:',module?.name,error);}}
    if(!state.loading){loadSelectedLane();loadSelectedReports();retryDeferredApply();}
  }
  // Recent reports view: the page frame only; static/modules/recent-reports.js
  // fills #recent-reports-host (filters, list, paging) from /api/recent-reports.
  function recentView() {
    return `${title('Recent reports','Reports across every program and lane, by last modified time.')}<div class="stack">${rootWarning()}<div id="recent-reports-host"><div class="panel state">Loading recent reports…</div></div></div>`;
  }
  // Recon intel view: the page frame only; static/modules/recon-intel.js fills
  // #recon-intel-host from /api/recon/* and owns the #/recon?<query> keys.
  function reconView() {
    return `${title('Recon intel','URL index, JS library and test depth per program: what has been looked for and what to hunt next.')}<div class="stack">${rootWarning()}<div id="recon-intel-host"><div class="panel state">Loading recon intel…</div></div></div>`;
  }
  function skeleton() {
    const line=w=>`<span class="skeleton sk-line" style="width:${w}%"></span>`;
    return `<div class="skeleton-page" aria-busy="true"><p class="skeleton-caption">${icon('circle-o-notch fa-spin')}Loading workspace…</p><div class="panel panel-pad"><span class="skeleton sk-title"></span>${line(42)}<div class="stats">${('<div class="stat">'+line(30)+line(60)+'</div>').repeat(4)}</div></div><div class="dashboard-grid"><div class="panel panel-pad">${line(35)}${line(90)}${line(80)}${line(70)}</div><div class="panel panel-pad">${line(35)}${line(85)}${line(75)}${line(60)}</div></div></div>`;
  }
  // ---- Hash routing: #/dashboard, #/recent or #/programs/<program>/<lane>/<section>[/<report>] ----
  // Incoming links may also use #/programs/<program>/<lane>/findings/<finding id>.
  // #/recent?<query>: the Recent view's filters (recent-reports.js owns the
  // keys and validation; the app only stores and round-trips the string).
  function recentRoute(query) { return `#/recent${query ? '?'+String(query) : ''}`; }
  function reconRoute(query) { return `#/recon${query ? '?'+String(query) : ''}`; }
  function programRoute() {
    if(!state.program)return '#/programs';
    return `#/programs/${encodeURIComponent(state.program)}/${encodeURIComponent(state.lane)}/${state.section}${state.section==='reports' && state.report ? '/'+encodeURIComponent(state.report) : ''}`;
  }
  function routeFor() {
    if(state.view==='recent')return recentRoute(state.recentQuery);
    if(state.view==='recon')return reconRoute(state.reconQuery);
    if(state.view!=='program')return '#/dashboard';
    return programRoute();
  }
  function parseRoute(hash) {
    const raw=String(hash||'').replace(/^#\/?/,''), mark=raw.indexOf('?');
    if((mark<0 ? raw : raw.slice(0,mark))==='recent')return {view:'recent',recentQuery:mark<0 ? '' : raw.slice(mark+1)};
    if((mark<0 ? raw : raw.slice(0,mark))==='recon')return {view:'recon',reconQuery:mark<0 ? '' : raw.slice(mark+1)};
    const parts=raw.split('/').map(part=>{try {return decodeURIComponent(part);} catch {return '';}});
    if(parts[0]==='dashboard')return {view:'dashboard'};
    if(parts[0]==='programs'){
      const section=sections.some(([k])=>k===parts[3])?parts[3]:'findings', rest=parts.slice(4).join('/');
      return {view:'program',program:parts[1]||'',lane:parts[2]||'',section,report:section==='reports'?rest:'',...(section==='findings' && rest ? {highlight:rest} : {})};
    }
    return null;
  }
  function syncRoute() {
    if(state.loading || !state.data){routePush=false;return;}
    const next=routeFor();
    if(location.hash!==next){try {history[routePush?'pushState':'replaceState'](null,'',next);} catch {}}
    routePush=false;
  }
  function navigate(next={}, options={}) {
    const missingProgram=next.program ? !programs().some(p=>String(p.id)===String(next.program)) : false;
    if(next.view)state.view=next.view;
    if(next.view==='recent' && typeof next.recentQuery==='string')state.recentQuery=next.recentQuery;
    if(next.view==='recon' && typeof next.reconQuery==='string')state.reconQuery=next.reconQuery;
    if(next.program!==undefined && next.program!==state.program){
      ++laneGeneration;state.program=next.program;state.lane=next.lane||'';state.report='';state.filters=emptyFilters();normalizeSelection();
    } else if(next.lane && next.lane!==state.lane && (list(currentProgram()?.lanes)||[]).some(l=>String(l.name)===next.lane)){
      ++laneGeneration;state.lane=next.lane;state.report='';state.filters=emptyFilters();
    }
    if(next.section && sections.some(([k])=>k===next.section))state.section=next.section;
    if(next.report!==undefined){state.report=next.report;state.linkedReport=next.report;}
    state.highlight=next.highlight ?? '';state.scrollToHighlight=!!next.highlight;
    state.routeNotice=missingProgram ? `The linked program "${next.program}" was not found. Showing another program instead.` : '';
    if(state.view==='program' && next.program!==undefined && !options.fromHistory)markProgramUsed();
    routePush=!options.fromHistory;
    closePopover(false);
    render();
  }
  window.addEventListener('popstate',()=>{
    const route=parseRoute(location.hash);
    if(!route || !state.data || location.hash===routeFor())return;
    navigate(route,{fromHistory:true});
  });
  app.addEventListener('click',event=>{
    if(event.target.closest('[data-report-show-na]')){state.reportHideNa=false;writeStore('bounty-board-report-list-hide-na',false);render();app.querySelector('#report-hide-na')?.focus();return;}
    const tab=event.target.closest('a[data-section]');if(!tab || !plainClick(event))return;
    event.preventDefault();state.section=tab.dataset.section;state.highlight='';routePush=true;render();
  });
  app.addEventListener('toggle',event=>{if(event.target.matches?.('[data-report-browser]'))writeStore('bounty-board-report-list-open',event.target.open);},true);
  app.addEventListener('focusout',event=>{if(!phaseStatus.contains(event.relatedTarget) && !portfolioAction.contains(event.relatedTarget))retryDeferredApply();});
  app.addEventListener('click',async event=>{
    const target=event.target.closest('button');if(!target)return;
    if(target.dataset.metadata==='severity' && !target.disabled){
      const id=target.dataset.id, row=(rows('findings')||[]).find(r=>String(r.id)===id), cap=BoardAPI.capability(state.data,'findingMetadata');if(!row)return;
      const values=[...new Set([...(Array.isArray(cap?.options?.severity)?cap.options.severity.map(String):[])])];
      const options=severityOptions(values);
      if(cap?.backend==='bbh' && !values.includes('N/A'))options.push({value:'N/A',label:'N/A',sev:'na',disabled:true,title:'Not supported by BBH yet'});
      openPills(target,{label:`Change severity for ${row.title||row.id||'finding'}`,groups:[{options}],current:String(row.severity??''),onPick:option=>{if(option.value!==String(row.severity??''))saveMetadata('severity',id,option.value);}});
      return;
    }
    if(target.hasAttribute('data-observation')){
      const item=(rows(state.section)||[])[Number(target.dataset.observation)], box=target.parentElement.querySelector('[data-observation-body]');
      const program=currentProgram(), lane=state.lane, section=state.section;
      if(!item || !box || !program || typeof item.path!=='string')return;
      target.disabled=true;box.textContent='Loading observation…';
      try {
        const partial=state.data?.reports_loading===true || state.data?.reports_unavailable===true;
        const result=await BoardAPI.observation(program,lane,item.path,partial ? state.data.root_instance : undefined);
        if(!box.isConnected || currentProgram()!==program || state.lane!==lane || state.section!==section)return;
        if(typeof result.content!=='string')throw new Error('Invalid response');
        const pre=document.createElement('pre');pre.className='observation-body';pre.textContent=result.content;box.replaceChildren(pre);
      } catch {if(box.isConnected)box.textContent='Observation unavailable or no longer indexed.';}
      finally {if(target.isConnected)target.disabled=false;}
    }
    else if(target.hasAttribute('data-find-shared')){
      const box=app.querySelector('[data-shared-recovery]'), input=app.querySelector('#saved-shared-path');
      const program=currentProgram(), lane=state.lane, path=input.value, root=rootIdentity(), snapshot=state.data;
      box.replaceChildren();if(!validRecoveryPath(path)){box.textContent='Enter the original relative report path.';return;}target.disabled=true;
      try {
        if(!root || !/^[a-f0-9]{64}$/.test(state.data?.root_instance || ''))throw new Error('Unknown source');
        const identity=await BoardAPI.rootInstance();
        if(!box.isConnected || input.value!==path || state.data!==snapshot || currentProgram()!==program || state.lane!==lane || identity.root_instance!==snapshot.root_instance)throw new Error('Source changed');
        const result=await BoardAPI.collaborationRead(program,lane,path,root,'recovery',{});
        const verified=await BoardAPI.rootInstance();
        if(!box.isConnected || input.value!==path || state.data!==snapshot || currentProgram()!==program || state.lane!==lane || verified.root_instance!==snapshot.root_instance)throw new Error('Source changed');
        const message=document.createElement('p');
        message.textContent=result.source_status==='source_unavailable' ? 'Source unavailable. This is a saved shared draft, not saved to the report. Select and copy it.' : 'Source is available. This is a saved shared draft, not saved to the report. Select and copy it.';
        const label=document.createElement('label');label.textContent='Recovered shared draft';
        const text=document.createElement('textarea');text.readOnly=true;text.rows=10;text.value=result.content;label.append(text);box.append(message,label);
      } catch {if(box.isConnected)box.textContent='No saved shared draft found or recovery is unavailable. Check the original path and retry.';}
      finally {if(target.isConnected)target.disabled=false;}
    }
    else if(target.hasAttribute('data-find-local')){
      const input=app.querySelector('#saved-shared-path'), path=input.value, box=app.querySelector('[data-local-recovery]'), snapshot=state.data, program=currentProgram(), lane=state.lane;
      if(!rootIdentity() || !/^[a-f0-9]{64}$/.test(state.data?.root_instance || '')){box.textContent='Source identity unavailable. Copy the path and refresh before recovery.';return;}
      if(!validRecoveryPath(path)){box.textContent='Enter the original relative report path.';return;}
      box.textContent='Verifying source before finding saved drafts…';
      try {const identity=await BoardAPI.rootInstance();if(!box.isConnected || input.value!==path || state.data!==snapshot || currentProgram()!==program || state.lane!==lane || identity.root_instance!==snapshot.root_instance)throw new Error('Source changed');}
      catch {if(box.isConnected)box.textContent='Source changed or could not be verified. Copy the path and refresh before recovery.';return;}
      const report=reportById(path) || {id:path,content:null};
      findSavedDrafts(draftFor(report),box,true);
    }
    else if(target.hasAttribute('data-find-drafts')){const report=reportById(state.report);if(report)findSavedDrafts(draftFor(report));}
    else if(target.hasAttribute('data-discard-metadata')){for(const [key,draft] of state.metadataDrafts)if(String(draft.sequence)===target.dataset.discardMetadata){state.metadataDrafts.delete(key);break;}render();}
    else if(target.hasAttribute('data-discard-current-path')){recoveryPaths.delete(recoveryPathKey());render();}
    else if(target.hasAttribute('data-discard-path')){for(const [key,path] of recoveryPaths)if(String(path.sequence)===target.dataset.discardPath){recoveryPaths.delete(key);break;}render();}
    else if(target.hasAttribute('data-go-program')){if(state.dashboardProgram && state.program!==state.dashboardProgram){++laneGeneration;state.program=state.dashboardProgram;state.lane='';state.report='';state.filters=emptyFilters();normalizeSelection();}state.view='program';markProgramUsed();routePush=true;render();}
    else if(target.dataset.section){state.section=target.dataset.section;state.highlight='';routePush=true;render();}
    else if(target.hasAttribute('data-program-picker')){
      const fromDashboard=state.view==='dashboard';
      openProgramPicker(target,id=>navigate(fromDashboard ? {view:'program',program:id,section:'findings'} : {program:id}),{current:fromDashboard ? (state.dashboardProgram || state.program) : state.program,align:fromDashboard?'start':'end'});
      if(popover)popover.reanchor=()=>null;
    }
    else if(target.hasAttribute('data-dash-work')){state.dashWork=target.dataset.dashWork==='open'?'open':'all';writeStore('bounty-board-dashboard-work',state.dashWork);render();}
    else if(target.hasAttribute('data-class-group')){state.classGroupBy=target.dataset.classGroup==='category'?'category':'class';writeStore('bounty-board-class-group',state.classGroupBy);state.dashExpanded='';render();}
    else if(target.hasAttribute('data-breakdown')){state.dashExpanded=state.dashExpanded===target.dataset.breakdown?'':target.dataset.breakdown;render();}
    else if(target.hasAttribute('data-dismiss-route-notice')){state.routeNotice='';render();}
    else if(target.hasAttribute('data-sort')){
      const key=target.dataset.sort, current=state.sort||{};
      const first=SORT_FIRST_DIR[key]||'asc', second=first==='asc'?'desc':'asc';
      setSort(current.key!==key ? {key,dir:first} : current.dir===first ? {key,dir:second} : {key:'',dir:'asc'});
    }
    else if(target.classList.contains('filter-trigger')){if(popover?.trigger===target)closePopover(true);else openFilter(target);}
    else if(target.hasAttribute('data-remove-filter')){const key=target.dataset.removeFilter;state.filters[key]=(state.filters[key]||[]).filter(v=>v!==target.dataset.value);render();(app.querySelector('[data-remove-filter]') || app.querySelector('#finding-search'))?.focus();}
    else if(target.hasAttribute('data-clear-filters')){state.filters=emptyFilters();render();app.querySelector('#finding-search')?.focus();}
    else if(target.hasAttribute('data-row-menu')){if(popover?.trigger===target)closePopover(true);else openRowMenu(target);}
    else if(target.hasAttribute('data-sort-menu')){if(popover?.trigger===target)closePopover(true);else openSortMenu(target);}
    else if(target.hasAttribute('data-ledger-add'))window.BoardLedgerActions?.openAddDialog?.();
    else if(target.hasAttribute('data-class-review'))window.BoardLedgerActions?.openClassReview?.(target.dataset.classReview);
    else if(target.hasAttribute('data-rationale-edit')){
      const row=(rows('findings')||[]).find(r=>String(r.id)===target.dataset.rationaleEdit);
      if(row && !state.metadataPending){const key=rationaleKey(state.program,state.lane,row.id), text=String(row.severity_rationale??'');if(!state.rationaleDrafts.has(key))state.rationaleDrafts.set(key,{program:state.program,lane:state.lane,id:String(row.id),text,revision:row.metadata_revision,rootInstance:state.data?.root_instance});render();app.querySelector(`[data-rationale-input="${CSS.escape(String(row.id))}"]`)?.focus();}
    }
    else if(target.hasAttribute('data-rationale-cancel')){state.rationaleDrafts.delete(rationaleKey(state.program,state.lane,target.dataset.rationaleCancel));render();}
    else if(target.hasAttribute('data-rationale-save')){
      const draftKey=rationaleKey(state.program,state.lane,target.dataset.rationaleSave), edit=state.rationaleDrafts.get(draftKey), row=(rows('findings')||[]).find(r=>String(r.id)===edit?.id);
      if(!edit || !row || state.metadataPending || edit.program!==state.program || edit.lane!==state.lane || !BoardAPI.capability(state.data,'findingMetadata')?.textFields?.includes('severity_rationale'))return;
      const family=currentProgram()?.family, name=currentProgram()?.name; state.metadataPending=true;render();
      try {
        const response=await BoardAPI.write(state.data,'findingMetadata',{programId:edit.program,program:name,family,lane:edit.lane,findingId:edit.id,field:'severity_rationale',value:edit.text,expectedRevision:edit.revision,rootInstance:edit.rootInstance});
        if(response?.value!==edit.text)throw new Error('Unverified value');
        row.severity_rationale=response.value;row.metadata_revision=response.revision;window.BoardFindingView?.rebase?.(row,response.revisions);state.rationaleDrafts.delete(draftKey);state.metadataPending=false;render();
      } catch (error) {state.metadataPending=false;state.metadataErrors.push(`${metadataFailure(error)} ${edit.program} / ${edit.lane} / ${edit.id} (severity rationale). The source may have changed; refresh before retrying. Your rationale draft remains in this tab.`);render();}
    }
  });
  // One metadata write path for inline edits: the class/status fields and the
  // severity pills. Conflicts keep a copyable pending value (metadata drafts).
  async function saveMetadata(key,id,value) {
    const row=(rows('findings')||[]).find(r=>String(r.id)===id); if(!row || state.metadataPending)return;
    const program=state.program,lane=state.lane, family=currentProgram()?.family, name=currentProgram()?.name,rootInstance=state.data?.root_instance;
    const origin=rationaleKey(program,lane,id);state.metadataPending=true;render();
    try {const response=await BoardAPI.write(state.data,'findingMetadata',{programId:program,program:name,family,lane, findingId:id,field:key,value,expectedRevision:row.metadata_revision,rootInstance}); if(response?.value!==value)throw new Error('Unverified value'); row[key]=response.value;row.metadata_revision=response.revision;window.BoardFindingView?.rebase?.(row,response.revisions);/* ledger-actions: roll untouched rows forward */state.metadataPending=false;render();}
    catch (error) {const sequence=++metadataDraftSequence;state.metadataPending=false;state.metadataErrors.push(`${metadataFailure(error)} ${program} / ${lane} / ${id} (${key}). The source may have changed; refresh before retrying.`);state.metadataDrafts.set(JSON.stringify([origin,key,sequence]),{sequence,field:key,value,message:`Unsaved value for ${program} / ${lane} / ${id}${/^[a-f0-9]{64}$/.test(rootInstance || '')?` (source ${rootInstance.slice(0,8)})`:' (source unknown)'}; refresh and review before retrying.`});render();}
  }
  app.addEventListener('change',async event=>{
    const el=event.target;
    if(el.id==='dashboard-program'){const focused=document.activeElement===el;state.dashboardProgram=el.value;render();if(focused)app.querySelector('#dashboard-program')?.focus();}
    else if(el.id==='program-select'){++laneGeneration;state.program=el.value;state.lane='';state.report='';state.filters=emptyFilters();normalizeSelection();markProgramUsed();routePush=true;render();}
    else if(el.id==='lane-select'){++laneGeneration;state.lane=el.value;state.report='';state.filters=emptyFilters();markProgramUsed();routePush=true;render();}
    else if(el.id==='report-select'){state.report=el.value;routePush=true;render();}
    else if(el.matches('[data-show-archived]')){state.showArchived=el.checked;try{localStorage.setItem('bounty-board-show-archived',String(el.checked));}catch{}render();app.querySelector('[data-show-archived]')?.focus();}
    else if(el.id==='report-nav-toggle'){state.reportNav=el.checked;render();app.querySelector('#report-nav-toggle')?.focus();}
    else if(el.id==='report-hide-na'){state.reportHideNa=el.checked;writeStore('bounty-board-report-list-hide-na',el.checked);render();app.querySelector('#report-hide-na')?.focus();}
    else if(el.dataset.metadata)saveMetadata(el.dataset.metadata,el.dataset.id,el.value);
  });
  app.addEventListener('input',event=>{
    const el=event.target;
    if(el.id==='saved-shared-path'){
      const key=el.dataset.recoveryKey;if(!el.value)recoveryPaths.delete(key);
      else {const existing=recoveryPaths.get(key);recoveryPaths.set(key,{sequence:existing?.sequence || ++recoveryPathSequence,value:el.value,program:state.program,lane:state.lane,source:/^[a-f0-9]{64}$/.test(state.data?.root_instance || '') ? state.data.root_instance : 'unknown'});}
    }
    if(el.hasAttribute('data-rationale-input')){const edit=state.rationaleDrafts.get(rationaleKey(state.program,state.lane,el.dataset.rationaleInput));if(edit)edit.text=el.value;}
    if(el.id==='program-search'){state.programQuery=el.value;applyProgramSearch();}
    if(el.id==='report-filter'){state.filters.reports=el.value;applyReportFilter();}
    if(el.id==='finding-search'){const pos=el.selectionStart;state.filters.query=el.value;render();const input=document.querySelector('#finding-search');input?.focus();input?.setSelectionRange(pos,pos);}
    if(el.id==='report-source' && !editor){const report=reportById(state.report);if(report)updateDraft(draftFor(report),el.value);}
  });
  function updateDraft(draft,text){
    if(draft.applyingRemote || reportReadOnly(draft)) return;
    if(state.data?.capabilities?.report_autosave && !draft.pendingShared)draft.publicationNotice=null;
    draft.fixturePublishedRevision=null;
    draft.text=text;draft.hasDraft=true;if(draft.status!=='conflict')draft.status='unsaved';
    if(draft.collabReady && draft.status!=='conflict' && !draft.retryExhausted)draft.collabMessage='Unsaved locally; saving shared draft…';
    persistDraft(draft);
    if(draft.collabStarted && draft.collabReady && draft.status!=='conflict') scheduleSharedSave(draft);
    const preview=document.querySelector('#report-preview');if(preview)preview.innerHTML=markdown(text);
    refreshStatus(draft);
    renderRecovery();
  }
  function refreshStatus(draft){const status=document.querySelector('#report-status');if(status && draftKey(state.program,state.lane,state.report)===draft.key)status.textContent=reportStatus(draft)+(draft.historyGaps?.length ? ' History is incomplete; fetching missing pages.' : '')+(draft.undoNotice ? ` ${draft.undoNotice}` : '');}
  window.addEventListener('storage',event=>{
    for(const draft of state.drafts.values()) if(event.key===storageKey(draft.key) || event.key===null){
      draft.storageBlocked=true;refreshStatus(draft);
    }
    renderRecovery();
  });
  const initialRoute=parseRoute(location.hash);
  if(initialRoute){
    state.view=initialRoute.view;
    if(initialRoute.view==='recent')state.recentQuery=initialRoute.recentQuery;
    if(initialRoute.view==='recon')state.reconQuery=initialRoute.reconQuery;
    if(initialRoute.view==='program' && initialRoute.program){state.program=initialRoute.program;state.lane=initialRoute.lane;state.section=initialRoute.section;state.report=initialRoute.report;state.linkedReport=initialRoute.report;state.highlight=initialRoute.highlight||'';state.scrollToHighlight=!!initialRoute.highlight;state.programOrigin='route';}
  }
  // Public UI helpers for feature modules (see style.css header for tokens).
  window.BoardUI = Object.freeze({toast, openMenu, openPopover, closePopover, openProgramPicker, openPills, severityOptions,
    navigate:(route)=>navigate(route||{}), severityKey:sevKey, severityRank:sevRank, severityBadge:sevBadge,
    statusBadge, submissionState, isNotSubmitted, submissionBadge, submissionLabel, icon, escape:esc, hrefFor, relativeTime, absoluteTime,
    // provider(row, {program, lane}) returns extra row-menu items for a finding.
    registerFindingActions:provider=>{if(typeof provider==='function')findingActionProviders.push(provider);}});
  claimTab().then(load);
})();
