(() => {
  'use strict';
  const app = document.querySelector('#app');
  const theme = document.querySelector('#theme');
  const state = {data:null, view:'dashboard', section:'findings', program:'', lane:'', filters:{severity:'',class:'',status:'',query:''}, report:'', drafts:new Map(), loading:true, error:'', metadataPending:false, metadataErrors:[], rationaleDrafts:new Map()};
  const sections = [['findings','Findings'],['coverage','Coverage'],['reports','Reports'],['map','MapStore'],['gadgets','Gadgets']];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const display = value => value == null || value === '' ? 'Unknown' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  const list = value => Array.isArray(value) ? value : null;
  const programs = () => list(state.data?.programs) || [];
  const currentProgram = () => programs().find(p => String(p.id) === state.program);
  const currentLane = () => (list(currentProgram()?.lanes) || []).find(l => String(l.name) === state.lane);
  const rows = key => {
    const value=currentLane()?.[key];
    return list(key==='coverage' && value && !Array.isArray(value) ? value.items : value);
  };
  const reportKey = (program, lane, id) => JSON.stringify([program,lane,String(id)]);
  const reportById = id => (rows('reports') || []).find(r => String(r.id) === String(id));
  const draftFor = report => {
    const key = reportKey(state.program,state.lane,report.id);
    if (!state.drafts.has(key)) state.drafts.set(key,{key,program:state.program,lane:state.lane,id:String(report.id),text:String(report.content ?? ''),revision:report.revision,original:String(report.content ?? ''),status:'saved',timer:null,inflight:false,source:report});
    const draft=state.drafts.get(key);
    if(draft.source!==report){
      if(!draft.inflight && draft.text===draft.original){draft.text=String(report.content??'');draft.original=draft.text;draft.revision=report.revision;draft.status='saved';}
      else if(report.revision != null && draft.revision != null && report.revision!==draft.revision){clearTimeout(draft.timer);draft.status='conflict';}
      draft.source=report;
    }
    return draft;
  };
  const hasUnsaved = () => state.metadataPending || [...state.drafts.values()].some(d => d.text !== d.original || d.inflight) || state.rationaleDrafts.size>0;
  window.addEventListener('beforeunload', event => { if (hasUnsaved()) { event.preventDefault(); event.returnValue = ''; } });
  function applyTheme(value) { if (!['light','dark','dusk'].includes(value)) value = 'light'; document.documentElement.dataset.theme=value; theme.value=value; try { localStorage.setItem('bounty-board-theme',value); } catch {} }
  try { applyTheme(localStorage.getItem('bounty-board-theme') || 'light'); } catch { applyTheme('light'); }
  theme.addEventListener('change', () => applyTheme(theme.value));
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {state.view=button.dataset.view;render();}));
  document.querySelector('#refresh').addEventListener('click', load);
  function normalizeSelection() {
    const ps=programs();
    if (!ps.some(p=>String(p.id)===state.program)) state.program=ps.length ? String(ps[0].id) : '';
    const lanes=list(currentProgram()?.lanes)||[];
    if (!lanes.some(l=>String(l.name)===state.lane)) state.lane=lanes.length ? String(lanes[0].name) : '';
  }
  async function load() {
    if(state.metadataPending || (state.loading && state.data)) return;
    state.loading=true; state.error=''; render();
    try { const data=await BoardAPI.load(); if (!data || !Array.isArray(data.programs)) throw new Error('Invalid response'); state.data=data; state.metadataErrors=[]; normalizeSelection(); }
    catch { state.error='Could not load workspace data. Check the local backend and try Refresh.'; state.data=null; }
    state.loading=false; render();
  }
  const opt = (value,label,selected) => `<option value="${esc(value)}"${selected?' selected':''}>${esc(label)}</option>`;
  function warnings() {
    const values=[...(list(state.data?.warnings)||[]),...(list(currentLane()?.warnings)||[])];
    return values.map(w=>`<div class="message warning">${esc(typeof w==='object' ? (w.message ?? JSON.stringify(w)) : w)}</div>`).join('');
  }
  function selectors() {
    const ps=programs(), lanes=list(currentProgram()?.lanes)||[];
    return `<div class="toolbar"><label>Program<select id="program-select" ${ps.length?'':'disabled'}>${ps.length?ps.map(p=>opt(p.id,p.name || p.id,String(p.id)===state.program)).join(''):opt('','No programs',true)}</select></label><label>Lane<select id="lane-select" ${lanes.length?'':'disabled'}>${lanes.length?lanes.map(l=>opt(l.name,l.name,String(l.name)===state.lane)).join(''):opt('','No lanes',true)}</select></label></div>`;
  }
  function title(title, subtitle, controls='') {return `<div class="titlebar"><div><h1>${esc(title)}</h1><p class="subtitle">${esc(subtitle)}</p></div>${controls}</div>`;}
  const discoveryIncomplete = () => state.data?.root_unavailable === true || state.data?.discovery_incomplete === true || (list(state.data?.warnings)||[]).some(w=>w==='root_unavailable'||w==='discovery_incomplete');
  function dashboard() {
    const ps=programs(), lanes=ps.flatMap(p=>list(p.lanes)||[]), all=lanes.flatMap(l=>list(l.findings)||[]);
    const discovered=!discoveryIncomplete();
    const complete=discovered && ps.every(p=>Array.isArray(p.lanes)) && lanes.every(l=>Array.isArray(l.findings));
    const stat=(v,label)=>`<div class="stat"><strong>${esc(v)}</strong><span>${esc(label)}</span></div>`;
    const reportsComplete=discovered && ps.every(p=>Array.isArray(p.lanes)) && lanes.every(l=>Array.isArray(l.reports) && !(list(l.warnings)||[]).some(w=>typeof w==='string' && w.startsWith('reports_')));
    const submissionValues=field=>{
      const counts=new Map();for(const finding of all){const value=finding.submission?.[field];if(value!=null && value!=='')counts.set(String(value),(counts.get(String(value))||0)+1);}
      return [...counts].map(([value,count])=>`<div class="record"><span>${esc(value)}</span> <strong>${count}</strong></div>`).join('') || '<p class="hint">No recorded values available.</p>';
    };
    const classes=new Map(); all.forEach(f=>{if(f.class) classes.set(String(f.class),(classes.get(String(f.class))||0)+1);});
    const severity=new Map(); let noSeverity=0;
    for(const finding of all){const value=finding.severity;if(value==null || value==='')noSeverity++;else severity.set(String(value),(severity.get(String(value))||0)+1);}
    const severityRows=[...severity].sort((a,b)=>a[0].localeCompare(b[0])).map(([name,n])=>`<div class="record"><span>${esc(name)}</span> <strong>${n}</strong></div>`).join('')+(noSeverity?`<div class="record"><span>Not recorded</span> <strong>${noSeverity}</strong></div>`:'');
    const max=Math.max(1,...classes.values());
    const bars=[...classes].sort((a,b)=>b[1]-a[1]).map(([name,n])=>`<div class="chart-row"><span>${esc(name)}</span><span class="bar"><i style="width:${n/max*100}%"></i></span><strong>${n}</strong></div>`).join('');
    return `${title('Dashboard','A portfolio view of the records currently loaded.')}
      <div class="stack">${warnings()}<section class="panel panel-pad"><div class="blockhead"><div><h2>Portfolio overview</h2><p class="hint">Counts are records across loaded program lanes${!discovered?'; discovery is incomplete, so portfolio totals are unknown.':complete?'.':'; some finding collections are unavailable.'}</p></div><button class="button" data-go-program>Open workspace</button></div><div class="stats">${stat(discovered?ps.length:'Unknown','Programs loaded')}${stat(discovered && ps.every(p=>Array.isArray(p.lanes))?lanes.length:'Unknown','Lanes loaded')}${stat(complete?all.length:'Unknown','Finding records')}${stat(reportsComplete?lanes.reduce((n,l)=>n+l.reports.length,0):'Unknown','Report records')}</div></section>
      <div class="dashboard-grid"><section class="panel panel-pad"><h2>Finding classes</h2><p class="hint">Classification on loaded finding records; not coverage.</p>${bars||'<div class="state">No classified findings available.</div>'}</section><section class="panel panel-pad" aria-label="Severity breakdown"><h2>Severity breakdown</h2><p class="hint">${complete?'Counts from all loaded finding records.':'Incomplete data: counts include loaded finding records only, not portfolio totals.'}</p>${severityRows||'<div class="state">No severity records available.</div>'}</section><section class="panel panel-pad"><h2>Programs</h2><p class="hint">Choose a program to inspect its lanes.</p>${ps.length?ps.map(p=>`<div class="record"><button class="link-button" data-open-program="${esc(p.id)}">${esc(p.name||p.id)}</button><p class="hint">${esc(p.family||'Family not provided')} · ${Array.isArray(p.lanes)?`${p.lanes.length} lanes`:'Lanes unavailable'}</p></div>`).join(''):discovered?'<div class="state">No programs returned by the backend.</div>':'<div class="state">Program discovery is unavailable or incomplete.</div>'}</section><section class="panel panel-pad wide" aria-label="Submission records"><h2>Submission records</h2><p class="hint">Recorded submission state and outcome are separate from finding status. Values shown for loaded findings only.</p><div class="report-layout"><div><h3>Submission state</h3>${submissionValues('state')}</div><div><h3>Platform result</h3>${submissionValues('result')}</div></div></section></div></div>`;
  }
  function workspace() {
    const p=currentProgram(), lane=currentLane();
    if (!p || !lane) return `${title(p?.name || 'Programs',p?'No lanes are available for this program.':'No programs are available.',selectors())}<div class="stack">${warnings()}<div class="panel state">${p?'This program has no lane data.':'Configure the program root in the backend and refresh.'}</div></div>`;
    const nav=sections.map(([key,label])=>`<button data-section="${key}" aria-label="${esc(label)}" class="${state.section===key?'active':''}" ${state.section===key?'aria-current="page"':''}><span>${esc(label)}</span><span class="count">${rows(key)?.length ?? '—'}</span></button>`).join('');
    return `${title(p.name||p.id,`${p.family||'Program workspace'} / ${lane.name}`,selectors())}<div class="stack">${warnings()}<div class="layout"><div class="stack"><section class="panel panel-pad"><div class="blockhead"><div><h2>Surface coverage</h2><p class="hint">Recorded surface boundaries, not a measure of complete testing.</p></div><button class="link-button" data-section="coverage">Explore coverage</button></div><div class="summary-line"><div><strong>${rows('coverage')?.length ?? 'Unknown'}</strong><span>Assessment questions</span></div><div><strong>${rows('findings')?.length ?? 'Unknown'}</strong><span>Finding records</span></div><div><strong>${rows('reports')?.length ?? 'Unknown'}</strong><span>Reports</span></div></div></section>${sectionContent()}</div><aside class="panel workspace-nav"><h2>Workspace</h2><p class="hint">Explore this lane</p><div class="choices">${nav}</div></aside></div></div>`;
  }
  function filterControl(key,label,findings) {
    const values=[...new Set(findings.map(r=>r[key]).filter(v=>v!=null&&v!=='' ).map(String))].sort();
    return `<select data-filter="${key}" aria-label="Filter ${label}">${opt('',`All ${label}`,!state.filters[key])}${values.map(v=>opt(v,v,state.filters[key]===v)).join('')}</select>`;
  }
  function metadataCell(row,key) {
    const value=String(row[key]??''); const cap=BoardAPI.capability(state.data,'findingMetadata');
    if(cap?.textFields?.includes(key)) return `<input data-metadata="${esc(key)}" data-id="${esc(row.id??'')}" aria-label="${esc(key)} for ${esc(row.title||row.id||'finding')}" aria-describedby="metadata-warning" title="Lowercase class identifier; change applies on leaving the field" value="${esc(value)}" ${row.id != null && !state.metadataPending?'':'disabled'}>`;
    const options=cap?.options?.[key]; const writable=cap && row.id != null && Array.isArray(options) && options.length && !state.metadataPending;
    const values=[...new Set([value,...(Array.isArray(options)?options.map(String):[])].filter(Boolean))];
    return `<select data-metadata="${key}" data-id="${esc(row.id??'')}" aria-label="${esc(key)} for ${esc(row.title||row.id||'finding')}" ${cap?'aria-describedby="metadata-warning"':''} ${writable?'':'disabled'}>${value ? '' : opt('','Unknown',true)}${values.map(v=>opt(v,v,v===value)).join('')}</select>`;
  }
  function rationale(row) {
    const label=String(row.title||row.id||'finding'), edit=state.rationaleDrafts.get(reportKey(state.program,state.lane,row.id));
    const writable=BoardAPI.capability(state.data,'findingMetadata')?.textFields?.includes('severity_rationale') && row.id != null;
    if(edit) return `<div class="rationale"><p>Saved rationale: <span class="record-value">${esc(row.severity_rationale || 'Not recorded')}</span></p><label>Unsaved draft — Severity rationale for ${esc(label)}<textarea data-rationale-input="${esc(row.id)}" aria-label="Severity rationale for ${esc(label)}" aria-describedby="metadata-warning" rows="3" ${state.metadataPending?'disabled':''}>${esc(edit.text)}</textarea></label>${writable?`<button class="button" data-rationale-save="${esc(row.id)}" aria-label="Save severity rationale for ${esc(label)}" aria-describedby="metadata-warning" ${state.metadataPending?'disabled':''}>Save rationale</button>`:'<p class="hint">Saving unavailable; copy this draft before leaving.</p>'} <button class="button subtle" data-rationale-cancel="${esc(row.id)}" ${state.metadataPending?'disabled':''}>Cancel</button></div>`;
    return `<div class="rationale"><span>Severity rationale: </span><span class="record-value">${esc(row.severity_rationale || 'Not recorded')}</span>${writable?` <button class="link-button" data-rationale-edit="${esc(row.id)}" aria-label="Edit severity rationale for ${esc(label)}" ${state.metadataPending?'disabled':''}>Edit rationale</button>`:''}</div>`;
  }
  function findings() {
    const all=rows('findings'); if (!all) return unavailable('Findings ledger');
    const f=state.filters, query=f.query.trim().toLowerCase();
    const filtered=all.filter(r=>['severity','class','status'].every(k=>!f[k]||String(r[k]??'')===f[k]) && (!query||[r.title,r.id,r.class,r.status,r.severity].some(v=>String(v??'').toLowerCase().includes(query))));
    const body=filtered.map(r=>`<tr><td><strong>${esc(r.title||'Untitled finding')}</strong><span class="id">${esc(r.id??'ID unavailable')}</span>${r.submission?.state ? `<span class="id">Submission state: ${esc(r.submission.state)}</span>` : ''}${r.submission?.result ? `<span class="id">Submission result: ${esc(r.submission.result)}</span>` : ''}${r.submission_status ? `<span class="id">Submission: ${esc(r.submission_status)}</span>` : ''}${r.platform_outcome ? `<span class="id">Platform outcome: ${esc(r.platform_outcome)}</span>` : ''}</td><td>${metadataCell(r,'severity')}${rationale(r)}</td><td>${metadataCell(r,'class')}</td><td>${metadataCell(r,'status')}</td></tr>`).join('');
    const cap=BoardAPI.capability(state.data,'findingMetadata');
    return `<section class="panel"><div class="panel-pad"><h2>Findings ledger</h2><p class="hint">Filter the findings in this lane.</p>${cap?'<div id="metadata-warning" class="message warning metadata-warning">Warning: concurrent local edits or sync changes can be overwritten by metadata updates. Coordinate all writers before editing; conflict protection is not guaranteed.</div>':''}</div><div class="filters">${filterControl('severity','severities',all)}${filterControl('class','classes',all)}${filterControl('status','statuses',all)}<input id="finding-search" aria-label="Search findings" placeholder="Search findings" value="${esc(f.query)}"><span class="muted">${filtered.length} of ${all.length}</span></div>${filtered.length?`<div class="table-wrap"><table class="ledger-table"><thead><tr><th>Finding</th><th>Severity</th><th>Class</th><th>Status</th></tr></thead><tbody>${body}</tbody></table></div>`:'<div class="state">No findings match these filters.</div>'}<p class="footnote">${cap?'Only supported fields with stable IDs can be edited. Class changes apply when you leave the field.':'Metadata editing is unavailable: the backend has not advertised a write capability.'}</p><div id="metadata-message" role="status">${state.metadataPending?'Updating metadata; waiting for confirmation.':''}</div></section>`;
  }
  function unavailable(name){return `<section class="panel panel-pad"><h2>${esc(name)}</h2><div class="state">This collection was not provided by the backend.</div></section>`;}
  function records(key,label,description) {
    const items=rows(key); if(!items) return unavailable(label);
    if(!items.length) return `<section class="panel panel-pad"><h2>${esc(label)}</h2><p class="hint">${esc(description)}</p><div class="state">No ${esc(label.toLowerCase())} records in this lane.</div></section>`;
    const content=items.map(item=>{
      if (typeof item !== 'object' || item===null) return `<div class="record record-value">${esc(item)}</div>`;
      const entries=Object.entries(item); const titleKey=['surface','title','name','id','url'].find(k=>item[k]!=null) || entries[0]?.[0];
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
    return `<div class="stack"><section class="panel panel-pad"><h2>Mapped inventory</h2><p class="hint">Mapped surfaces are inventory, not assessed coverage.</p>${mapped}<p class="hint">${esc(unclassified)}</p></section>${counts}${assessments}</div>`;
  }
  // Deliberately small Markdown subset; all source is escaped before formatting.
  // Links/images remain text. No HTML, navigation, external images or scripts.
  function markdown(source) {
    const inline=s=>esc(s).replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/\*([^*]+)\*/g,'<em>$1</em>');
    let code=false, result=[], inList=false;
    for (const line of String(source).split('\n')) {
      if (line.startsWith('```')) {if(inList){result.push('</ul>');inList=false;} result.push(code?'</code></pre>':'<pre><code>');code=!code;continue;}
      if(code){result.push(esc(line)+'\n');continue;}
      const bullet=line.match(/^\s*[-*] (.*)$/); if(bullet){if(!inList){result.push('<ul>');inList=true;} result.push(`<li>${inline(bullet[1])}</li>`);continue;}
      if(inList){result.push('</ul>');inList=false;}
      const heading=line.match(/^(#{1,3})\s+(.+)$/); if(heading){const n=heading[1].length;result.push(`<h${n}>${inline(heading[2])}</h${n}>`);} else if(line.trim()) result.push(`<p>${inline(line)}</p>`);
    }
    if(inList)result.push('</ul>');if(code)result.push('</code></pre>');return result.join('');
  }
  function reports() {
    const all=rows('reports'); if(!all)return unavailable('Reports');
    if(!all.length)return '<section class="panel panel-pad"><h2>Reports</h2><div class="state">No reports in this lane.</div></section>';
    if(!all.some(r=>String(r.id)===state.report)) state.report=String(all[0].id??'');
    const report=reportById(state.report); if(!report || report.id==null)return '<section class="panel panel-pad"><h2>Reports</h2><div class="state">Reports need stable IDs before they can be opened.</div></section>';
    const kindNames={registered_report:'Registered report',generated_report:'Generated report',generated_evidence:'Generated evidence',generated_navigation:'Generated navigation',unregistered:'Unregistered artifact',unknown:'Ownership unknown'};
    const kind=report.kind == null ? 'Ownership not provided' : (kindNames[report.kind] || String(report.kind));
    const owner=Array.isArray(report.owner_fids) && report.owner_fids.length ? `Finding owner IDs: ${report.owner_fids.map(display).join(', ')}` : '';
    const picker=`<label class="hint" for="report-select">Report</label><br><select id="report-select" class="report-picker">${all.filter(r=>r.id!=null).map(r=>opt(r.id,r.path || r.title || r.id,String(r.id)===state.report)).join('')}</select><p class="hint record-value">${esc(kind)}${owner ? ` | ${esc(owner)}` : ''}${report.path ? ` | Path: ${esc(report.path)}` : ''}</p>`;
    if(report.content == null && report.path){
      if(!report.loadState) {
        report.loadState='loading';const program=currentProgram(), lane=state.lane;
        BoardAPI.report(program,lane,report.path).then(result=>{if(typeof result.content!=='string')throw new Error('Invalid report');report.content=result.content;report.revision=result.revision;if(result.editable===false)report.editable=false;report.loadState='loaded';}).catch(()=>{report.loadState='error';}).finally(()=>{if(currentProgram()===program && currentLane()?.name===lane && state.section==='reports')render();});
      }
      return `<section class="panel panel-pad"><h2>Reports</h2>${picker}<div class="state">${report.loadState==='error'?'Report could not be loaded. Refresh the workspace to retry.':'Loading report…'}</div></section>`;
    }
    const draft=draftFor(report);
    const writable=reportWritable(draft);
    const status=reportStatus(draft,writable);
    return `<section class="panel panel-pad"><div class="blockhead"><div><h2>Reports</h2><p class="hint">Markdown source and safe preview. Reports remain in their owning source.</p></div></div>${picker}<div id="report-status" class="message report-status" role="status">${esc(status)}</div><div class="report-layout"><div><label for="report-source">Markdown source</label><textarea id="report-source" spellcheck="false">${esc(draft.text)}</textarea></div><div><label>Preview</label><div id="report-preview" class="preview">${markdown(draft.text)}</div></div></div></section>`;
  }
  const reportWritable = draft => !!(draft.source?.editable !== false && BoardAPI.capability(state.data,'reportWrite') && draft.revision != null);
  function reportStatus(draft,writable) {
    if(draft.status==='conflict') return 'Conflict: the report changed in its source. Your draft is preserved in this tab; copy it before reloading and reconcile with the source.';
    if(draft.status==='error') return 'Save failed. Your draft is preserved in this tab; edit to retry or copy it before leaving.';
    if(!writable) return 'Saving unavailable: no supported report-write capability and revision. Edits are temporary in this tab only.';
    return ({saved:'Saved to source.',saving:'Saving…',unsaved:'Unsaved changes.'})[draft.status]||'Unsaved changes.';
  }
  function sectionContent(){switch(state.section){case 'findings':return findings();case 'coverage':return coverage();case 'reports':return reports();case 'map':return records('map','MapStore','Mapped records from the selected lane.');case 'gadgets':return records('gadgets','Gadgets','Gadget records from the selected lane.');default:return '';}}
  function render() {
    document.querySelector('#refresh').disabled=state.metadataPending || state.loading;
    document.querySelectorAll('[data-view]').forEach(b=>{const active=b.dataset.view===state.view;b.classList.toggle('active',active);if(active)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
    document.querySelector('#breadcrumb').textContent=state.view==='dashboard'?'Dashboard':'Programs';
    if(state.loading) app.innerHTML='<div class="panel state">Loading workspace…</div>';
    else if(state.error) app.innerHTML=`<div class="panel panel-pad"><h2>Workspace unavailable</h2><p>${esc(state.error)}</p></div>`;
    else app.innerHTML=state.view==='dashboard'?dashboard():workspace();
    if(state.metadataPending && !app.querySelector('#metadata-message')) app.insertAdjacentHTML('afterbegin','<div class="message warning" role="status">Updating metadata; waiting for confirmation. Displayed values are the last loaded or confirmed values.</div>');
    if(state.metadataErrors.length) app.insertAdjacentHTML('afterbegin',state.metadataErrors.map(error=>`<div class="message warning" role="alert">${esc(error)}</div>`).join(''));
  }
  app.addEventListener('click',async event=>{
    const target=event.target.closest('button');if(!target)return;
    if(target.hasAttribute('data-go-program')){state.view='program';render();}
    else if(target.hasAttribute('data-open-program')){state.program=target.dataset.openProgram;state.lane='';normalizeSelection();state.view='program';state.section='findings';render();}
    else if(target.dataset.section){state.section=target.dataset.section;render();}
    else if(target.hasAttribute('data-rationale-edit')){
      const row=(rows('findings')||[]).find(r=>String(r.id)===target.dataset.rationaleEdit);
      if(row && !state.metadataPending){const key=reportKey(state.program,state.lane,row.id), text=String(row.severity_rationale??'');if(!state.rationaleDrafts.has(key))state.rationaleDrafts.set(key,{program:state.program,lane:state.lane,id:String(row.id),text});render();app.querySelector(`[data-rationale-input="${CSS.escape(String(row.id))}"]`)?.focus();}
    }
    else if(target.hasAttribute('data-rationale-cancel')){state.rationaleDrafts.delete(reportKey(state.program,state.lane,target.dataset.rationaleCancel));render();}
    else if(target.hasAttribute('data-rationale-save')){
      const draftKey=reportKey(state.program,state.lane,target.dataset.rationaleSave), edit=state.rationaleDrafts.get(draftKey), row=(rows('findings')||[]).find(r=>String(r.id)===edit?.id);
      if(!edit || !row || state.metadataPending || edit.program!==state.program || edit.lane!==state.lane || !BoardAPI.capability(state.data,'findingMetadata')?.textFields?.includes('severity_rationale'))return;
      const family=currentProgram()?.family, name=currentProgram()?.name; state.metadataPending=true;render();
      try {
        const response=await BoardAPI.write(state.data,'findingMetadata',{programId:edit.program,program:name,family,lane:edit.lane,findingId:edit.id,field:'severity_rationale',value:edit.text});
        if(response?.value!==edit.text)throw new Error('Unverified value');
        row.severity_rationale=response.value;state.rationaleDrafts.delete(draftKey);state.metadataPending=false;render();
      } catch {state.metadataPending=false;state.metadataErrors.push(`Update failed or was not verified for ${edit.program} / ${edit.lane} / ${edit.id} (severity rationale). The source may have changed; refresh before retrying. Your rationale draft remains in this tab.`);render();}
    }
  });
  app.addEventListener('change',async event=>{
    const el=event.target;
    if(el.id==='program-select'){state.program=el.value;state.lane='';state.report='';state.filters={severity:'',class:'',status:'',query:''};normalizeSelection();render();}
    else if(el.id==='lane-select'){state.lane=el.value;state.report='';state.filters={severity:'',class:'',status:'',query:''};render();}
    else if(el.id==='report-select'){state.report=el.value;render();}
    else if(el.dataset.filter){state.filters[el.dataset.filter]=el.value;render();}
    else if(el.dataset.metadata){
      const key=el.dataset.metadata, id=el.dataset.id, value=el.value, row=(rows('findings')||[]).find(r=>String(r.id)===id); if(!row || state.metadataPending)return;
      const program=state.program,lane=state.lane, family=currentProgram()?.family, name=currentProgram()?.name;state.metadataPending=true;render();
      try {const response=await BoardAPI.write(state.data,'findingMetadata',{programId:program,program:name,family,lane, findingId:id,field:key,value}); if(response?.value!==value)throw new Error('Unverified value'); row[key]=response.value; state.metadataPending=false;render();}
      catch {state.metadataPending=false;state.metadataErrors.push(`Update failed or was not verified for ${program} / ${lane} / ${id} (${key}). The source may have changed; refresh before retrying.`);render();}
    }
  });
  app.addEventListener('input',event=>{
    const el=event.target;
    if(el.hasAttribute('data-rationale-input')){const edit=state.rationaleDrafts.get(reportKey(state.program,state.lane,el.dataset.rationaleInput));if(edit)edit.text=el.value;}
    if(el.id==='finding-search'){const pos=el.selectionStart;state.filters.query=el.value;render();const input=document.querySelector('#finding-search');input?.focus();input?.setSelectionRange(pos,pos);}
    if(el.id==='report-source'){
      const report=reportById(state.report);if(!report)return;const draft=draftFor(report);draft.text=el.value;
      document.querySelector('#report-preview').innerHTML=markdown(draft.text);
      if(draft.status!=='conflict') draft.status='unsaved';
      const writable=reportWritable(draft);
      document.querySelector('#report-status').textContent=reportStatus(draft,writable);
      clearTimeout(draft.timer);if(writable && draft.status!=='conflict')draft.timer=setTimeout(()=>saveDraft(draft),600);
    }
  });
  async function saveDraft(draft){
    if(!reportWritable(draft)||draft.inflight||draft.status==='conflict'||draft.text===draft.original)return;
    const text=draft.text, revision=draft.revision; draft.inflight=true;draft.status='saving';refreshStatus(draft);
    try {
      const result=await BoardAPI.write(state.data,'reportWrite',{programId:draft.program,lane:draft.lane,reportId:draft.id,content:text,revision});
      if(result?.revision==null || result.content!==text)throw new Error('Unverified save');
      draft.revision=result.revision;draft.original=text;draft.status=draft.text===text?'saved':'unsaved';
    } catch(error){draft.status=error.status===409?'conflict':'error';}
    finally {draft.inflight=false;refreshStatus(draft);if(draft.status==='unsaved'){clearTimeout(draft.timer);draft.timer=setTimeout(()=>saveDraft(draft),600);}}
  }
  function refreshStatus(draft){const status=document.querySelector('#report-status');if(status && state.program===draft.program && state.lane===draft.lane && state.report===draft.id)status.textContent=reportStatus(draft,reportWritable(draft));}
  load();
})();
