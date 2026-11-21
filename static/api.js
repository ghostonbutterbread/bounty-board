/* The only transport integration seam. Writes require an explicit capability.
 * See API_NEEDS.md; the endpoint and contract are proposals, not assumptions. */
window.BoardAPI = (() => {
  async function request(url, options) {
    const response = await fetch(url, options);
    if (!response.ok) { const error = new Error(`Request failed (${response.status})`); error.status = response.status; throw error; }
    return response.json();
  }
  function capability(data, name) {
    let cap = data?.capabilities?.[name];
    if (name === 'findingMetadata' && !cap && data?.capabilities?.finding_metadata === true && Array.isArray(data.capabilities.finding_fields)) {
      const fields=data.capabilities.finding_fields;
      cap={enabled:true,method:'PATCH',url:'/api/finding',backend:'bbh',options:{}};
      if(fields.includes('severity')) cap.options.severity=['EXCEPTIONAL','CRITICAL','HIGH','MEDIUM','LOW','INFO','UNKNOWN'];
      if(fields.includes('status')) cap.options.status=['raw','confirmed','dormant','novel','complete','archive'];
      cap.textFields=[];
      if(fields.includes('class_name')) cap.textFields.push('class');
      if(fields.includes('severity_rationale')) cap.textFields.push('severity_rationale');
    }
    if (!cap || cap.enabled !== true || cap.method !== 'PATCH' || typeof cap.url !== 'string') return null;
    try { const url = new URL(cap.url, location.origin); return url.origin === location.origin && /^https?:$/.test(url.protocol) ? cap : null; }
    catch { return null; }
  }
  async function write(data, name, body) {
    const cap = capability(data, name);
    if (!cap) throw new Error('Write capability unavailable');
    if(cap.backend==='bbh' && name==='findingMetadata') {
      const field=body.field==='class'?'class_name':body.field;
      const result=await request(cap.url,{method:'PATCH',headers:{'Content-Type':'application/json','X-Requested-With':'Bounty-Board'},body:JSON.stringify({family:body.family,program:body.program,lane:body.lane,fid:body.findingId,patch:{[field]:body.value}})});
      if(result?.finding?.fid!==body.findingId) throw new Error('Unverified finding');
      return {value:result.finding[field]};
    }
    const {family,program,...legacyBody}=body;
    return request(cap.url, {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify(legacyBody)});
  }
  function normalize(data) {
    for (const program of data.programs || []) for (const lane of program.lanes || []) {
      if (Array.isArray(lane.findings)) lane.findings = lane.findings.map(f => ({...f,id:f.id ?? f.fid,class:f.class ?? f.class_name}));
      if (Array.isArray(lane.reports)) lane.reports = lane.reports.map(r => ({...r,id:r.id ?? r.path,title:r.title ?? r.name}));
    }
    return data;
  }
  function report(program, lane, path) {
    const query = new URLSearchParams({family:program.family,program:program.name,lane,path});
    return request(`/api/report?${query}`, {cache:'no-store'});
  }
  function collaboration(program, lane, path, payload, rootIdentity) {
    const query = new URLSearchParams({family:program.family,program:program.name,lane,path,root_identity:rootIdentity});
    const options=payload ? {method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'Bounty-Board'},body:JSON.stringify(payload),signal:AbortSignal.timeout(10000)} : {cache:'no-store',signal:AbortSignal.timeout(10000)};
    return request(`/api/collaboration?${query}`,options);
  }
  function collaborationRead(program,lane,path,rootIdentity,view,extra) {
    const query=new URLSearchParams({family:program.family,program:program.name,lane,path,root_identity:rootIdentity,...extra});
    return request(`/api/collaboration/${view}?${query}`,{cache:'no-store',signal:AbortSignal.timeout(10000)});
  }
  return { load: async () => normalize(await request('/api/data', {cache:'no-store'})), report, collaboration, collaborationRead, capability, write };
})();
