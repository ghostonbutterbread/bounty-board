/* The only transport integration seam. Writes require an explicit capability.
 * See API_NEEDS.md; the endpoint and contract are proposals, not assumptions. */
window.BoardAPI = (() => {
  async function request(url, options) {
    const response = await fetch(url, options);
    if (!response.ok) { const error = new Error(`Request failed (${response.status})`); error.status = response.status; throw error; }
    return response.json();
  }
  function capability(data, name) {
    const cap = data?.capabilities?.[name];
    if (!cap || cap.enabled !== true || cap.method !== 'PATCH' || typeof cap.url !== 'string') return null;
    try { const url = new URL(cap.url, location.origin); return url.origin === location.origin && /^https?:$/.test(url.protocol) ? cap : null; }
    catch { return null; }
  }
  async function write(data, name, body) {
    const cap = capability(data, name);
    if (!cap) throw new Error('Write capability unavailable');
    return request(cap.url, {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
  }
  function normalize(data) {
    for (const program of data.programs || []) for (const lane of program.lanes || []) {
      if (Array.isArray(lane.findings)) lane.findings = lane.findings.map(f => ({...f,id:f.id ?? f.fid,class:f.class ?? f.class_name}));
      if (lane.coverage && !Array.isArray(lane.coverage) && Array.isArray(lane.coverage.items)) lane.coverage = lane.coverage.items;
      if (Array.isArray(lane.reports)) lane.reports = lane.reports.map(r => ({...r,id:r.id ?? r.path,title:r.title ?? r.name}));
    }
    return data;
  }
  function report(program, lane, path) {
    const query = new URLSearchParams({family:program.family,program:program.name,lane,path});
    return request(`/api/report?${query}`, {cache:'no-store'});
  }
  return { load: async () => normalize(await request('/api/data', {cache:'no-store'})), report, capability, write };
})();
