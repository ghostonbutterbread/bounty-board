const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

// Fictional in-memory records only. No bounty directories or backend are read.
const fixture = {source_token:'synthetic-scan-token',portfolio:{state:'ready'},root_identity:'a'.repeat(64),programs:[{id:'synthetic',name:'Example program',family:'Test',lanes:[{name:'Web',findings:[{id:'f1',title:'Example finding',severity:'High',class:'Access control',status:'Draft'}],coverage:[{surface:'Example surface',class:'XSS',state:'Mapped',notes:'One boundary observed'}],gadgets:[],map:[],reports:[{id:'r1',title:'Example report',content:'# Report\n\nInitial text',revision:'1'}],warnings:[]}]}],warnings:[]};
const root = path.resolve(__dirname, '..');
const server = http.createServer((req,res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/api/data') { res.writeHead(200,{'content-type':'application/json'}); return res.end(JSON.stringify(fixture)); }
  const file = path.join(root, pathname === '/' ? 'index.html' : pathname.slice(1));
  if (!file.startsWith(root + path.sep)) {res.writeHead(403); return res.end();}
  fs.readFile(file,(err,data)=>{ if(err){res.writeHead(404);return res.end();} const ext=path.extname(file); res.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.css':'text/css'})[ext]||'text/plain');res.end(data); });
});
let browser, base;
test('loads a truthful ledger and filters synthetic findings', async () => {
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true, executablePath:process.env.CHROME_BIN || '/usr/bin/google-chrome'});
  const page=await browser.newPage();
  await page.goto(base);
  await page.getByRole('button',{name:'Programs',exact:true}).click();
  await page.getByRole('button',{name:'Findings',exact:true}).click();
  assert.equal(await page.getByText('Example finding').count(),1);
  if(process.env.BOARD_SCREENSHOTS) await page.screenshot({path:path.join(process.env.BOARD_SCREENSHOTS,'bounty-desktop.png'),fullPage:true});
  await page.getByLabel('Search findings').fill('not present');
  assert.equal(await page.getByText('Example finding').count(),0);
  assert.ok(await page.getByText(/No findings match/).count());
  await page.close();
});

test('report request carries the displayed source token', async () => {
  const page=await browser.newPage();const data=structuredClone(fixture);let header;
  data.source_token='synthetic-scan-token';
  data.programs[0].lanes[0].reports=[{path:'same.md',name:'same.md'}];
  await page.route('**/api/data',route=>route.fulfill({json:{...data,portfolio:{state:'ready'}}}));
  await page.route('**/api/report?*',route=>{header=route.request().headers()['x-portfolio-source'];return route.fulfill({json:{content:'source',revision:'1'}});});
  try {await page.goto(base);await page.getByRole('button',{name:'Programs',exact:true}).click();await page.getByRole('button',{name:'Reports',exact:true}).click();await page.locator('.CodeMirror').waitFor();assert.equal(header,data.source_token);}
  finally {await page.close();}
});

test('metadata request carries the displayed scan token', async () => {
  const page=await browser.newPage();const data=structuredClone(fixture);let header;
  data.source_token='synthetic-scan-token';
  data.capabilities={finding_metadata:true,finding_fields:['severity']};
  data.programs[0].lanes[0].findings[0]={fid:'F01',title:'Example finding',severity:'LOW'};
  await page.route('**/api/data',route=>route.fulfill({json:{...data,portfolio:{state:'ready'}}}));
  await page.route('**/api/finding',route=>{header=route.request().headers()['x-portfolio-source'];return route.fulfill({json:{finding:{fid:'F01',severity:'HIGH'}}});});
  try {await page.goto(base);await page.getByRole('button',{name:'Programs',exact:true}).click();await page.getByLabel('severity for Example finding').selectOption('HIGH');await page.waitForFunction(()=>!document.querySelector('#refresh').disabled);assert.equal(header,data.source_token);}
  finally {await page.close();}
});

test('ready response without a scan token is display-only even for forced metadata events', async () => {
  const page=await browser.newPage();const data=structuredClone(fixture);let writes=0;
  delete data.source_token;
  data.capabilities={finding_metadata:true,finding_fields:['severity']};
  data.programs[0].lanes[0].findings[0]={fid:'F01',title:'Example finding',severity:'LOW'};
  await page.route('**/api/data',route=>route.fulfill({json:{...data,portfolio:{state:'ready'}}}));
  await page.route('**/api/finding',route=>{writes++;return route.fulfill({status:500});});
  try {
    await page.goto(base);await page.getByRole('button',{name:'Programs',exact:true}).click();
    const control=page.getByLabel('severity for Example finding');
    assert.equal(await control.isDisabled(),true);
    await control.evaluate(el=>{el.value='HIGH';el.dispatchEvent(new Event('change',{bubbles:true}));});
    assert.equal(writes,0);
  } finally {await page.close();}
});

test('successful metadata update makes old snapshot display-only until fresh scan', async () => {
  const page=await browser.newPage();const data=structuredClone(fixture);let calls=0,release,arrived;
  const gate=new Promise(r=>release=r), blocked=new Promise(r=>arrived=r);
  data.capabilities={finding_metadata:true,finding_fields:['severity']};
  data.programs[0].lanes[0].findings[0]={fid:'F01',title:'Example finding',severity:'LOW'};
  await page.route('**/api/data',async route=>{if(++calls>1){arrived();await gate;}return route.fulfill({json:data});});
  await page.route('**/api/finding',route=>route.fulfill({json:{finding:{fid:'F01',severity:'HIGH'}}}));
  try {
    await page.goto(base);await page.getByRole('button',{name:'Programs',exact:true}).click();
    await page.getByLabel('severity for Example finding').selectOption('HIGH');await blocked;
    assert.equal(await page.getByLabel('severity for Example finding').isDisabled(),true);
  } finally {release();await page.close();}
});

test('post-write old ready token cannot restore stale metadata', async () => {
  const page=await browser.newPage();const data=structuredClone(fixture);let calls=0,arrived,release;
  const blocked=new Promise(r=>arrived=r), gate=new Promise(r=>release=r);
  data.capabilities={finding_metadata:true,finding_fields:['severity']};
  data.programs[0].lanes[0].findings[0]={fid:'F01',title:'Example finding',severity:'LOW'};
  await page.route('**/api/data',async route=>{if(++calls===2){arrived();await gate;}return route.fulfill({json:{...data,portfolio:{state:'ready',updated_at:calls===2?'stale':'initial'}}});});
  await page.route('**/api/finding',route=>route.fulfill({json:{finding:{fid:'F01',severity:'HIGH'}}}));
  try {
    await page.goto(base);await page.getByRole('button',{name:'Programs',exact:true}).click();
    await page.getByLabel('severity for Example finding').selectOption('HIGH');await blocked;release();
    await page.waitForFunction(()=>document.querySelector('#portfolio-status').textContent.includes('stale'));
    assert.equal(await page.getByLabel('severity for Example finding').inputValue(),'HIGH');
    assert.equal(await page.getByLabel('severity for Example finding').isDisabled(),true);
  } finally {release();await page.close();}
});

test('retained snapshot is display-only for existing and new clients during refresh', async () => {
  const data=structuredClone(fixture);let busy=false, writes=0, reports=0;
  data.capabilities={finding_metadata:true,finding_fields:['severity']};
  data.programs[0].lanes[0].findings[0]={fid:'F01',title:'Example finding',severity:'LOW'};
  data.programs[0].lanes[0].reports=[{path:'same.md',name:'same.md'}];
  const setup=async page=>{
    await page.route('**/api/data',route=>route.fulfill({json:{...data,portfolio:{state:busy?'refreshing':'ready'}}}));
    await page.route('**/api/finding',route=>{writes++;return route.fulfill({status:500});});
    await page.route('**/api/report?*',route=>{reports++;return route.fulfill({json:{content:'wrong root',revision:'1'}});});
  };
  const first=await browser.newPage(), second=await browser.newPage();
  try {
    await setup(first);await setup(second);await first.goto(base);
    await first.getByRole('button',{name:'Programs',exact:true}).click();
    busy=true;await first.getByRole('button',{name:'Refresh'}).click();
    await first.waitForFunction(()=>document.querySelector('#portfolio-status').textContent.includes('Refreshing'));
    assert.equal(await first.getByLabel('severity for Example finding').isDisabled(),true);
    await first.getByRole('button',{name:'Reports',exact:true}).click();
    await first.getByText(/source identity.*unverified/i).waitFor();
    await second.goto(base);await second.getByRole('button',{name:'Programs',exact:true}).click();
    assert.equal(await second.getByLabel('severity for Example finding').isDisabled(),true);
    await second.getByRole('button',{name:'Reports',exact:true}).click();
    await second.getByText(/source identity.*unverified/i).waitFor();
    assert.equal(writes,0);assert.equal(reports,0);
  } finally {await first.close();await second.close();}
});

test('rationale draft is isolated across matching roots', async () => {
  const page=await browser.newPage();const data=structuredClone(fixture);
  data.capabilities={finding_metadata:true,finding_fields:['severity_rationale']};
  data.programs[0].lanes[0].findings=[{fid:'F01',title:'Example finding',severity_rationale:'Saved'}];
  await page.route('**/api/data',route=>route.fulfill({json:structuredClone(data)}));
  try {
    await page.goto(base);await page.getByRole('button',{name:'Programs',exact:true}).click();
    await page.getByRole('button',{name:'Edit severity rationale for Example finding'}).click();
    await page.getByRole('textbox',{name:'Severity rationale for Example finding'}).fill('Root A draft');
    data.root_identity='b'.repeat(64);
    await page.getByRole('button',{name:'Refresh'}).click();
    await page.getByRole('button',{name:'Edit severity rationale for Example finding'}).waitFor({timeout:3000});
    assert.equal(await page.getByText('Root A draft',{exact:true}).count(),0);
    data.root_identity='a'.repeat(64);
    await page.getByRole('button',{name:'Refresh'}).click();
    assert.equal(await page.getByRole('textbox',{name:'Severity rationale for Example finding'}).inputValue(),'Root A draft');
  } finally {await page.close();}
});

test('initial loading waits for the real portfolio before rendering counts', async () => {
  const page=await browser.newPage();let calls=0;
  await page.route('**/api/data', route=>{
    calls++;
    return route.fulfill(calls===1 ? {status:202,json:{portfolio:{state:'loading',updated_at:null}}} : {json:{...fixture,portfolio:{state:'ready',updated_at:'2026-01-01T00:00:00Z'}}});
  });
  await page.goto(base);
  await page.getByText(/Loading workspace/).waitFor();
  await page.getByText('Example program').first().waitFor({timeout:5000});
  assert.ok(calls>=2);
  await page.close();
});

test('refresh clicked during a background poll is sent after that poll', async () => {
  const page=await browser.newPage();let calls=0, release, arrived, requested;
  const gate=new Promise(r=>release=r), blocked=new Promise(r=>arrived=r), next=new Promise(r=>requested=r);
  await page.route('**/api/data',async route=>{
    const n=++calls;
    if(n===3){arrived();await gate;}
    if(n===4){requested(route.request().headers()['x-portfolio-refresh']);}
    return route.fulfill({json:{...fixture,portfolio:{state:n===2?'refreshing':'ready'}}});
  });
  try {
    await page.goto(base);await page.getByRole('button',{name:'Refresh'}).click();await blocked;
    await page.getByRole('button',{name:'Refresh'}).click();release();
    assert.equal(await Promise.race([next,new Promise((_,reject)=>setTimeout(()=>reject(new Error('refresh was lost')),3000))]),'1');
  } finally {release();await page.close();}
});

test('ready background poll preserves focused uncommitted class input', async () => {
  const page=await browser.newPage();const data=structuredClone(fixture);let calls=0,release,arrived;
  const gate=new Promise(r=>release=r), blocked=new Promise(r=>arrived=r);
  data.capabilities={finding_metadata:true,finding_fields:['class_name','severity']};
  data.programs[0].lanes[0].findings[0]={fid:'F01',title:'Example finding',class_name:'xss',severity:'LOW'};
  await page.route('**/api/data',async route=>{
    const n=++calls;if(n===2){arrived();await gate;}
    return route.fulfill({json:{...data,portfolio:{state:'ready',updated_at:n===2?'final':'old'}}});
  });
  await page.route('**/api/finding',route=>route.fulfill({json:{finding:{fid:'F01',severity:'HIGH'}}}));
  try {
    await page.goto(base);await page.getByRole('button',{name:'Programs',exact:true}).click();
    await page.getByLabel('severity for Example finding').selectOption('HIGH');await blocked;
    const input=page.getByLabel('class for Example finding');await input.fill('unsaved-class');await input.focus();
    release();await page.waitForFunction(()=>document.querySelector('#portfolio-status').textContent.includes('final'));
    assert.match(await page.locator('#portfolio-status').innerText(),/display.*deferred/i);
    assert.equal(await input.inputValue(),'unsaved-class');
    assert.equal(await input.evaluate(el=>document.activeElement===el),true);
  } finally {release();await page.close();}
});

test('ready background poll preserves the real report editor and caret', async () => {
  const page=await browser.newPage();let calls=0,release,arrived;
  const gate=new Promise(r=>release=r), blocked=new Promise(r=>arrived=r);
  await page.route('**/api/data',async route=>{
    const n=++calls;if(n===3){arrived();await gate;}
    return route.fulfill({json:{...fixture,portfolio:{state:n===2?'refreshing':'ready',updated_at:n===3?'final':'old'}}});
  });
  try {
    await openReport(page);await page.getByRole('button',{name:'Refresh'}).click();await blocked;
    const editor=page.locator('.CodeMirror');await editor.evaluate(el=>{el.dataset.sentinel='original';el.CodeMirror.focus();el.CodeMirror.setCursor({line:0,ch:2});});
    release();await page.waitForFunction(()=>document.querySelector('#portfolio-status').textContent.includes('final'));
    assert.equal(await editor.getAttribute('data-sentinel'),'original');
    assert.deepEqual(await editor.evaluate(el=>el.CodeMirror.getCursor()),{line:0,ch:2});
    assert.equal(await editor.evaluate(el=>el.CodeMirror.hasFocus()),true);
  } finally {release();await page.close();}
});

test('background polling leaves an active editor intact', async () => {
  const page=await browser.newPage();let calls=0, fourth;
  const observed=new Promise(resolve=>{fourth=resolve;});
  await page.route('**/api/data', route=>{
    calls++;
    if(calls===4) fourth();
    return route.fulfill({json:{...fixture,portfolio:{state:calls===1?'ready':'refreshing',updated_at:'2026-01-01T00:00:00Z'}}});
  });
  await openReport(page);
  await page.getByRole('button',{name:'Refresh'}).click();
  await page.waitForFunction(()=>document.querySelector('#portfolio-status').textContent.includes('Refreshing'));
  await page.locator('.CodeMirror').evaluate(el=>{el.dataset.pollSentinel='same';});
  await observed;
  assert.equal(await page.locator('.CodeMirror').getAttribute('data-poll-sentinel'),'same');
  await page.close();
});

test('a poll begun before a metadata update cannot restore old values', async () => {
  const page=await browser.newPage();const data=structuredClone(fixture);let calls=0, release, arrived, followup;
  const gate=new Promise(resolve=>{release=resolve;}), blocked=new Promise(resolve=>{arrived=resolve;}), next=new Promise(resolve=>{followup=resolve;});
  data.capabilities={finding_metadata:true,finding_fields:['severity']};
  data.programs[0].lanes[0].findings[0]={fid:'F01',title:'Example finding',severity:'HIGH'};
  await page.route('**/api/data',async route=>{
    calls++;
    if(calls===2){arrived();await gate;const stale=structuredClone(data);stale.programs[0].lanes[0].findings[0].severity='LOW';return route.fulfill({json:{...stale,portfolio:{state:'ready'}}});}
    if(calls>=3){followup();return route.fulfill({json:{...data,portfolio:{state:'ready'}}});}
    return route.fulfill({json:{...data,portfolio:{state:'ready'}}});
  });
  await page.route('**/api/finding',route=>{const value=route.request().postDataJSON().patch.severity;return route.fulfill({json:{finding:{fid:'F01',severity:value}}});});
  try {
    await page.goto(base);await page.getByRole('button',{name:'Programs',exact:true}).click();
    await page.getByLabel('severity for Example finding').selectOption('LOW');await blocked;
    await page.getByLabel('severity for Example finding').selectOption('HIGH');
    await page.waitForFunction(()=>!document.querySelector('#refresh').disabled);
    release();await Promise.race([next,new Promise((_,reject)=>setTimeout(()=>reject(new Error('stale poll was not retried')),3500))]);
    assert.equal(await page.getByLabel('severity for Example finding').inputValue(),'HIGH');
  } finally {release();await page.close();}
});

test('unidentified replacement server never serves reports into the old root', async () => {
  const page=await browser.newPage();const data=structuredClone(fixture);let calls=0, reports=0;
  data.programs[0].lanes[0].reports=[{path:'same.md',name:'same.md'}];
  await page.route('**/api/data',route=>route.fulfill(++calls===1 ? {json:{...data,portfolio:{state:'ready'}}} : {status:202,json:{portfolio:{state:'loading'}}}));
  await page.route('**/api/report?*',route=>{reports++;return route.fulfill({json:{content:'new root',revision:'2'}});});
  try {
    await page.goto(base);await page.getByRole('button',{name:'Programs',exact:true}).click();
    await page.getByRole('button',{name:'Refresh'}).click();
    await page.waitForFunction(()=>document.querySelector('#portfolio-status').textContent.includes('Refreshing'));
    await page.getByRole('button',{name:'Reports',exact:true}).click();
    await page.getByText(/source identity.*unverified/i).waitFor({timeout:3000});
    assert.equal(reports,0);
  } finally {await page.close();}
});

test('inflight report response is not accepted after refresh starts', async () => {
  const page=await browser.newPage();const data=structuredClone(fixture);let calls=0, release, arrived;
  const gate=new Promise(resolve=>{release=resolve;}), blocked=new Promise(resolve=>{arrived=resolve;});
  data.programs[0].lanes[0].reports=[{path:'same.md',name:'same.md'}];
  await page.route('**/api/data',route=>route.fulfill(++calls===1 ? {json:{...data,portfolio:{state:'ready'}}} : {status:202,json:{portfolio:{state:'loading'}}}));
  await page.route('**/api/report?*',async route=>{arrived();await gate;return route.fulfill({json:{content:'wrong root content',revision:'2'}});});
  try {
    await page.goto(base);await page.getByRole('button',{name:'Programs',exact:true}).click();await page.getByRole('button',{name:'Reports',exact:true}).click();await blocked;
    await page.getByRole('button',{name:'Refresh'}).click();await page.waitForFunction(()=>document.querySelector('#portfolio-status').textContent.includes('Refreshing'));
    await page.evaluate(()=>{window.reportRendered=new Promise(resolve=>{const observer=new MutationObserver(()=>{observer.disconnect();resolve();});observer.observe(document.querySelector('#app'),{childList:true});});});
    release();await page.evaluate(()=>window.reportRendered);
    await page.getByText(/source identity.*unverified/i).waitFor({timeout:3000});
    assert.equal(await page.getByText('wrong root content').count(),0);
  } finally {release();await page.close();}
});

test('failed post-write scan keeps confirmed metadata and distrusts retained snapshot', async () => {
  const page=await browser.newPage();const data=structuredClone(fixture);let calls=0;
  data.capabilities={finding_metadata:true,finding_fields:['severity']};
  data.programs[0].lanes[0].findings[0]={fid:'F01',title:'Example finding',severity:'LOW'};
  await page.route('**/api/data',route=>route.fulfill({json:{...data,portfolio:{state:++calls===1?'ready':'error',error:calls===1?null:'Scan failed'}}}));
  await page.route('**/api/finding',route=>route.fulfill({json:{finding:{fid:'F01',severity:'HIGH'}}}));
  try {
    await page.goto(base);await page.getByRole('button',{name:'Programs',exact:true}).click();
    await page.getByLabel('severity for Example finding').selectOption('HIGH');
    await page.waitForFunction(()=>document.querySelector('#portfolio-status').textContent.includes('Scan failed'),null,{timeout:4000});
    assert.equal(await page.getByLabel('severity for Example finding').inputValue(),'HIGH');
    assert.equal(await page.getByLabel('severity for Example finding').isDisabled(),true);
  } finally {await page.close();}
});

test('successful BBH update polls the invalidated portfolio', async () => {
  const page=await browser.newPage();const data=structuredClone(fixture);let calls=0, polled;
  const next=new Promise(resolve=>{polled=resolve;});
  data.capabilities={finding_metadata:true,finding_fields:['severity']};
  data.programs[0].lanes[0].findings[0]={fid:'F01',title:'Example finding',severity:'LOW'};
  await page.route('**/api/data',route=>{if(++calls>1)polled();return route.fulfill({json:{...data,portfolio:{state:'ready'}}});});
  await page.route('**/api/finding',route=>route.fulfill({json:{finding:{fid:'F01',severity:'HIGH'}}}));
  try {
    await page.goto(base);await page.getByRole('button',{name:'Programs',exact:true}).click();
    await page.getByLabel('severity for Example finding').selectOption('HIGH');
    await Promise.race([next,new Promise((_,reject)=>setTimeout(()=>reject(new Error('portfolio was not polled')),3000))]);
  } finally {await page.close();}
});

async function setReport(page, text) { await page.locator('.CodeMirror').evaluate((el,value)=>el.CodeMirror.setValue(value),text); }

async function openReport(page) {
  await page.goto(base);
  await page.getByRole('button',{name:'Programs',exact:true}).click();
  await page.getByRole('button',{name:'Reports',exact:true}).click();
  await page.locator('.CodeMirror').waitFor();
}

test('program, lane and ledger filters change the records in view', async () => {
  const page=await browser.newPage();const data=structuredClone(fixture);
  data.programs[0].lanes.push({name:'API',findings:[{id:'f2',title:'API synthetic finding',severity:'Low',class:'XSS',status:'Submitted'}],coverage:[],map:[{title:'Synthetic map'}],gadgets:[{title:'Synthetic gadget'}],reports:[],warnings:[]});
  await page.route('**/api/data',route=>route.fulfill({json:data}));
  await page.goto(base);await page.getByRole('button',{name:'Programs',exact:true}).click();
  await page.getByLabel('Lane').selectOption('API');
  assert.ok(await page.getByText('API synthetic finding').count());
  assert.equal(await page.getByText('Example finding').count(),0);
  await page.getByLabel('Filter severities').selectOption('Low');
  await page.getByLabel('Filter statuses').selectOption('Submitted');
  assert.ok(await page.getByText('API synthetic finding').count());
  await page.getByRole('button',{name:'MapStore',exact:true}).click();assert.ok(await page.getByText('Synthetic map').count());
  await page.getByRole('button',{name:'Gadgets',exact:true}).click();assert.ok(await page.getByText('Synthetic gadget').count());
  await page.close();
});

test('read-only reports render Markdown without executing HTML or fetching images', async () => {
  const page=await browser.newPage(); const requests=[];
  page.on('request',r=>requests.push(r.url()));
  await openReport(page);
  assert.match(await page.locator('#report-status').innerText(),/Saving to report unavailable/);
  await setReport(page,'# Heading\n\n**bold**\n\n<img src="https://bad.invalid/x" onerror="window.pwned=1">\n\n![x](https://bad.invalid/img)');
  assert.equal(await page.locator('#report-preview h1').innerText(),'Heading');
  assert.equal(await page.locator('#report-preview strong').innerText(),'bold');
  assert.equal(await page.locator('#report-preview img').count(),0);
  assert.equal(await page.evaluate(()=>window.pwned),undefined);
  assert.equal(requests.some(url=>url.includes('bad.invalid')),false);
  await page.getByRole('button',{name:'Coverage',exact:true}).click();
  assert.ok(await page.getByText('Example surface').count());
  await page.getByRole('button',{name:'Reports',exact:true}).click();
  assert.match(await page.locator('#report-source').inputValue(),/Heading/);
  await page.close();
});

test('advertised report writes stay disabled and browser drafts survive navigation and source conflict', async () => {
  const page=await browser.newPage(), writes=[];const data=structuredClone(fixture);
  data.capabilities={reportWrite:{enabled:true,method:'PATCH',url:'/api/report'}};
  await page.route('**/api/data',route=>route.fulfill({json:data}));
  await page.route('**/api/report',route=>{writes.push(route.request().method());return route.fulfill({status:500});});
  await openReport(page);await setReport(page,'My synthetic draft');
  assert.match(await page.locator('#report-status').innerText(),/saved in browser/i);
  assert.equal(await page.getByRole('button',{name:'Save to report unavailable'}).isDisabled(),true);
  await page.getByRole('button',{name:'Coverage',exact:true}).click();
  data.programs[0].lanes[0].reports[0].content='Changed source';data.programs[0].lanes[0].reports[0].revision='2';
  await page.getByRole('button',{name:'Refresh'}).click();await page.getByText('Example surface').waitFor();
  await page.getByRole('button',{name:'Reports',exact:true}).click();
  assert.match(await page.locator('#report-status').innerText(),/^Conflict:/);
  assert.equal(await page.locator('#report-source').inputValue(),'My synthetic draft');
  await setReport(page,'Still my draft');
  assert.equal(await page.evaluate(()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented;}),true);
  await page.getByRole('button',{name:'Refresh'}).click();await page.getByText(/^Conflict:/).waitFor();
  assert.equal(await page.locator('#report-source').inputValue(),'Still my draft');assert.deepEqual(writes,[]);
  await page.close();
});

test('unchanged refresh retains edited browser draft with no source write', async () => {
  const page=await browser.newPage(), writes=[];const data=structuredClone(fixture);
  data.capabilities={reportWrite:{enabled:true,method:'PATCH',url:'/api/report'}};
  await page.route('**/api/data',route=>route.fulfill({json:data}));
  await page.route('**/api/report',route=>{writes.push(route.request().method());return route.fulfill({status:500});});
  await openReport(page);await setReport(page,'First draft');await setReport(page,'Next draft');
  await page.getByRole('button',{name:'Refresh'}).click();await page.locator('.CodeMirror').waitFor();
  assert.equal(await page.locator('#report-source').inputValue(),'Next draft');
  assert.match(await page.locator('#report-status').innerText(),/saved in browser/i);assert.deepEqual(writes,[]);
  await page.close();
});

test('themes persist and mobile workspace fits without page overflow', async () => {
  const page=await browser.newPage({viewport:{width:375,height:800}});await page.goto(base);
  await page.getByLabel('Theme').selectOption('dusk');await page.reload();
  assert.equal(await page.locator('html').getAttribute('data-theme'),'dusk');
  await page.getByRole('button',{name:'Programs',exact:true}).click();
  await page.getByRole('button',{name:'Coverage',exact:true}).click();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  if(process.env.BOARD_SCREENSHOTS) await page.screenshot({path:path.join(process.env.BOARD_SCREENSHOTS,'bounty-mobile.png'),fullPage:true});
  await page.close();
});

test('missing data and network errors do not look like empty success', async () => {
  const page=await browser.newPage();
  await page.route('**/api/data',route=>route.fulfill({status:500,body:'error'}));
  await page.goto(base);await page.getByText('Workspace unavailable').waitFor();
  assert.ok(await page.getByText(/Could not load workspace data/).count());
  await page.unroute('**/api/data');
  const data=structuredClone(fixture);delete data.programs[0].lanes[0].coverage;delete data.programs[0].lanes[0].findings;
  await page.route('**/api/data',route=>route.fulfill({json:data}));
  await page.getByRole('button',{name:'Refresh'}).click();
  await page.getByText('Finding records',{exact:true}).waitFor();
  assert.ok(await page.getByText('Unknown').count());
  await page.getByRole('button',{name:'Programs',exact:true}).click();
  await page.getByRole('button',{name:'Coverage',exact:true}).click();
  assert.ok(await page.getByText(/collection was not provided/).count());
  await page.close();
});

test('metadata writes need capability and confirm returned value', async () => {
  const page=await browser.newPage();let writes=0;
  const data=structuredClone(fixture);data.capabilities={findingMetadata:{enabled:true,method:'PATCH',url:'/api/meta',options:{severity:['High','Low']}}};
  await page.route('**/api/data',route=>route.fulfill({json:data}));
  await page.route('**/api/meta',route=>{writes++;const payload=route.request().postDataJSON();return route.fulfill({json:{value:payload.value}});});
  await page.goto(base);await page.getByRole('button',{name:'Programs',exact:true}).click();
  const severity=page.getByLabel('severity for Example finding');await severity.selectOption('Low');
  await page.waitForFunction(()=>document.querySelector('[data-metadata="severity"]')?.value==='Low' && !document.querySelector('[data-metadata="severity"]')?.disabled);
  assert.equal(writes,1);assert.equal(await page.getByLabel('class for Example finding').isDisabled(),true);
  await page.close();
});

test('renders backend ledger, coverage and lazily fetched report shapes', async () => {
  const page=await browser.newPage();
  const data={programs:[{id:'web_bounty/test',name:'test',family:'web_bounty',lanes:[{name:'web',findings:[{fid:'SYN-1',title:'Synthetic issue',class_name:'XSS',severity:'High',status:'Draft',submission_status:'submitted',platform_outcome:'duplicate'}],coverage:{items:[{surface_key:'Synthetic surface',class_name:'XSS',status:'open'}],counts:{open:1},total:1},map:[],gadgets:[],reports:[{path:'Example.md',name:'Example.md'}],warnings:[]}]}],warnings:[]};
  await page.route('**/api/data',route=>route.fulfill({json:data}));
  data.portfolio={state:'ready'};data.source_token='synthetic-source-token';
  let reportQueries=[];
  await page.route('**/api/report?*',route=>{reportQueries.push(new URL(route.request().url()).searchParams);return route.fulfill({json:{content:'# Source from backend',revision:'rev1',editable:false}})});
  await page.goto(base);await page.getByRole('button',{name:'Programs',exact:true}).click();
  assert.ok(await page.getByText('SYN-1').count());
  assert.equal(await page.getByLabel('class for Synthetic issue').inputValue(),'XSS');
  assert.ok(await page.getByText('Submission: submitted',{exact:true}).count());
  assert.ok(await page.getByText('Platform outcome: duplicate',{exact:true}).count());
  await page.getByRole('button',{name:'Coverage',exact:true}).click();
  assert.ok(await page.getByText('Synthetic surface',{exact:true}).count());
  await page.getByRole('button',{name:'Reports',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#report-source')?.value==='# Source from backend');
  assert.equal(reportQueries.length,1);assert.equal(reportQueries[0].get('path'),'Example.md');assert.equal(reportQueries[0].get('program'),'test');
  assert.match(await page.locator('#report-status').innerText(),/identity unavailable/i);
  await page.close();
});

test('refresh updates a clean report but retains a local draft', async () => {
  const page=await browser.newPage();const data=structuredClone(fixture);
  await page.route('**/api/data',route=>route.fulfill({json:data}));
  await openReport(page);
  data.programs[0].lanes[0].reports[0].content='# Changed at source';data.programs[0].lanes[0].reports[0].revision='2';
  await page.getByRole('button',{name:'Refresh'}).click();
  await page.waitForFunction(()=>document.querySelector('#report-source')?.value==='# Changed at source',null,{timeout:3000});
  await setReport(page,'# Local draft');
  data.programs[0].lanes[0].reports[0].content='# Another source change';
  await page.getByRole('button',{name:'Refresh'}).click();
  await page.locator('.CodeMirror').waitFor();
  assert.equal(await page.locator('#report-source').inputValue(),'# Local draft');
  await page.close();
});

test('missing lane collections do not count unknown findings as zero', async () => {
  const page=await browser.newPage();
  await page.route('**/api/data',route=>route.fulfill({json:{programs:[{id:'p',name:'Unavailable lanes'}],warnings:[]}}));
  await page.goto(base);
  const record=page.locator('.stat').filter({hasText:'Finding records'});
  assert.match(await record.innerText(),/Unknown/);
  await page.close();
});

test('dashboard uses explicit submission and outcome fields, not finding status', async () => {
  const page=await browser.newPage();const data=structuredClone(fixture);
  data.programs[0].lanes[0].findings=[{id:'f',title:'Synthetic',status:'Duplicate',submission:{state:'submitted',result:'accepted'}}];
  await page.route('**/api/data',route=>route.fulfill({json:data}));
  await page.goto(base);
  const panel=page.getByRole('region',{name:'Submission records'});
  assert.ok(await panel.getByText('submitted',{exact:true}).count());
  assert.ok(await panel.getByText('accepted',{exact:true}).count());
  assert.equal(await panel.getByText('Duplicate',{exact:true}).count(),0);
  await page.close();
});

test('frontend boots against the real read-only backend with an empty synthetic root', async () => {
  const {spawn}=require('node:child_process');
  const {once}=require('node:events');
  const nonexistent=path.join(process.env.TMPDIR||'/home/ryushe/.hermes/cache/scratch',`bounty-no-data-${process.pid}-${Date.now()}`);
  assert.equal(fs.existsSync(nonexistent),false);
  const source='import sys, app; s=app.make_server(sys.argv[1],0); print(s.server_port,flush=True); s.serve_forever()';
  const proc=spawn('python3',['-B','-u','-c',source,nonexistent],{cwd:path.resolve(root,'..'),stdio:['ignore','pipe','pipe']});
  let page;
  try {
    const [chunk]=await Promise.race([once(proc.stdout,'data'),new Promise((_,reject)=>setTimeout(()=>reject(new Error('backend startup timeout')),5000))]);
    const url=`http://127.0.0.1:${Number(chunk.toString().trim())}`;
    page=await browser.newPage();const failures=[];
    page.on('response',response=>{if(response.status()>=400)failures.push(`${response.status()} ${response.url()}`);});
    await page.goto(url);await page.getByText('Program discovery is unavailable or incomplete.').waitFor();
    assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.sidebar')).display),'flex');
    assert.deepEqual(failures,[]);
    await page.getByRole('button',{name:'Programs',exact:true}).click();
    assert.ok(await page.getByText('Configure the program root in the backend and refresh.').count());
  } finally {if(page)await page.close();if(proc.exitCode===null && proc.signalCode===null){const exited=once(proc,'exit');proc.kill('SIGTERM');await exited;}}
});

test('coverage separates mapped inventory from assessment questions and escapes evidence', async () => {
  const page=await browser.newPage();const data=structuredClone(fixture);
  const coverage={items:[],counts:{},total:0,mapped_kinds:{route:3,host:1},unclassified_surfaces:4};
  data.programs[0].lanes[0].coverage=coverage;
  await page.route('**/api/data',route=>route.fulfill({json:data}));
  await page.goto(base);
  assert.deepEqual(await page.evaluate(async()=> (await BoardAPI.load()).programs[0].lanes[0].coverage),coverage);
  await page.getByRole('button',{name:'Programs',exact:true}).click();
  assert.match(await page.locator('.summary-line').innerText(),/Assessment questions/);
  await page.getByRole('button',{name:'Coverage',exact:true}).click();
  assert.match(await page.locator('#app').innerText(),/Mapped inventory/);
  assert.match(await page.locator('#app').innerText(),/route\s*:?\s*3/);
  assert.match(await page.locator('#app').innerText(),/4.*(?:without|unclassified)/i);
  assert.match(await page.locator('#app').innerText(),/No assessment questions/i);
  await page.close();
});

test('coverage displays question counts and evidence as inert text', async () => {
  const page=await browser.newPage();const data=structuredClone(fixture);
  data.programs[0].lanes[0].coverage={items:[{surface_key:'Synthetic route',status:'open',evidence_refs:['<img src=x onerror="window.pwned=1">','ref://synthetic']}],counts:{open:1},total:1,mapped_kinds:{route:1},unclassified_surfaces:0};
  await page.route('**/api/data',route=>route.fulfill({json:data}));
  await page.goto(base);await page.getByRole('button',{name:'Programs',exact:true}).click();await page.getByRole('button',{name:'Coverage',exact:true}).click();
  assert.match(await page.locator('#app').innerText(),/Assessment counts/);
  assert.match(await page.locator('#app').innerText(),/ref:\/\/synthetic/);
  assert.equal(await page.locator('#app img').count(),0);
  assert.equal(await page.evaluate(()=>window.pwned),undefined);
  await page.close();
});

test('dashboard does not present incomplete discovery or partial reports as totals', async () => {
  const page=await browser.newPage();const data=structuredClone(fixture);
  data.warnings=['discovery_incomplete'];data.programs[0].lanes[0].warnings=['reports_unavailable_or_invalid'];
  await page.route('**/api/data',route=>route.fulfill({json:data}));await page.goto(base);
  for(const label of ['Programs loaded','Lanes loaded','Finding records','Report records']) {
    assert.match(await page.locator('.stat').filter({hasText:label}).innerText(),/Unknown|partial/i,label);
  }
  await page.unroute('**/api/data');
  data.warnings=[];
  await page.route('**/api/data',route=>route.fulfill({json:data}));
  await page.getByRole('button',{name:'Refresh'}).click();
  await page.getByText('reports_unavailable_or_invalid').waitFor();
  assert.match(await page.locator('.stat').filter({hasText:'Report records'}).innerText(),/Unknown/i);
  assert.match(await page.locator('.stat').filter({hasText:'Finding records'}).innerText(),/1/);
  await page.unroute('**/api/data');
  await page.route('**/api/data',route=>route.fulfill({json:{programs:[],warnings:['root_unavailable']}}));
  await page.getByRole('button',{name:'Refresh'}).click();
  await page.getByText('root_unavailable').waitFor();
  assert.match(await page.locator('.stat').filter({hasText:'Programs loaded'}).innerText(),/Unknown/i);
  assert.doesNotMatch(await page.locator('#app').innerText(),/No programs returned/);
  await page.close();
});

test('report picker identifies paths and backend-supplied ownership without guessing', async () => {
  const page=await browser.newPage();const data=structuredClone(fixture);
  data.programs[0].lanes[0].reports=[
    {path:'findings/one/final.md',name:'final.md',kind:'registered_report',owner_fids:['SYN-1'],content:'one'},
    {path:'findings/two/final.md',name:'final.md',kind:'unregistered',owner_fids:[],content:'two'},
    {path:'raw/index.md',name:'index.md',kind:'generated_navigation',content:'index'},
    {path:'raw/generated.md',name:'generated.md',kind:'generated_report',content:'generated'},
    {path:'raw/uncertain.md',name:'uncertain.md',kind:'unknown',content:'uncertain'},
    {path:'legacy/final.md',name:'final.md',content:'legacy'}];
  await page.route('**/api/data',route=>route.fulfill({json:data}));await openReport(page);
  const options=await page.locator('#report-select option').allTextContents();
  assert.match(options[0],/findings\/one\/final\.md/);assert.match(options[1],/findings\/two\/final\.md/);
  assert.match(await page.locator('#app').innerText(),/Registered report/i);
  assert.match(await page.locator('#app').innerText(),/SYN-1/);
  await page.locator('#report-select').selectOption('findings/two/final.md');
  assert.match(await page.locator('#app').innerText(),/Unregistered/i);
  await page.locator('#report-select').selectOption('raw/index.md');
  assert.match(await page.locator('#app').innerText(),/Generated navigation/i);
  await page.locator('#report-select').selectOption('raw/generated.md');
  assert.match(await page.locator('#app').innerText(),/Generated report/i);
  await page.locator('#report-select').selectOption('raw/uncertain.md');
  assert.match(await page.locator('#app').innerText(),/Ownership unknown/i);
  await page.locator('#report-select').selectOption('legacy/final.md');
  assert.match(await page.locator('#app').innerText(),/Ownership not provided/i);
  await page.close();
});

test('metadata with no recorded value stays unknown until a confirmed update', async () => {
  const page=await browser.newPage();const data=structuredClone(fixture);let writes=0;
  data.programs[0].lanes[0].findings[0].severity=null;
  data.capabilities={findingMetadata:{enabled:true,method:'PATCH',url:'/api/meta',options:{severity:['High','Low']}}};
  await page.route('**/api/data',route=>route.fulfill({json:data}));
  await page.route('**/api/meta',route=>{writes++;return route.fulfill({status:500,body:'failed'});});
  await page.goto(base);await page.getByRole('button',{name:'Programs',exact:true}).click();
  const severity=page.getByLabel('severity for Example finding');
  assert.equal(await severity.inputValue(),'');
  assert.equal(await severity.locator('option:checked').innerText(),'Unknown');
  await severity.selectOption('Low');await page.getByText(/Update failed or was not verified/).waitFor();
  assert.equal(await severity.inputValue(),'');assert.equal(writes,1);
  await page.close();
});

test('explicitly read-only report never writes even when a capability exists', async () => {
  const page=await browser.newPage();const data=structuredClone(fixture);let writes=0;
  data.programs[0].lanes[0].reports[0].editable=false;
  data.capabilities={reportWrite:{enabled:true,method:'PATCH',url:'/api/report'}};
  await page.route('**/api/data',route=>route.fulfill({json:data}));
  await page.route('**/api/report',route=>{writes++;return route.fulfill({status:500});});
  await openReport(page);await setReport(page,'temporary');
  await page.waitForTimeout(800);
  assert.equal(writes,0);assert.match(await page.locator('#report-status').innerText(),/saved in browser/i);
  await page.close();
});

test('multiple metadata failures remain visible until a successful refresh', async () => {
  const page=await browser.newPage();const data=structuredClone(fixture);
  data.capabilities={findingMetadata:{enabled:true,method:'PATCH',url:'/api/meta',options:{severity:['High','Low'],status:['Draft','Open']}}};
  await page.route('**/api/data',route=>route.fulfill({json:data}));
  await page.route('**/api/meta',route=>route.fulfill({status:500,body:'failed'}));
  try {
    await page.goto(base);await page.getByRole('button',{name:'Programs',exact:true}).click();
    await page.getByLabel('severity for Example finding').selectOption('Low');
    await page.getByText(/f1 \(severity\)/).waitFor();
    await page.getByLabel('status for Example finding').selectOption('Open');
    await page.getByText(/f1 \(status\)/).waitFor();
    await page.getByRole('button',{name:'Dashboard',exact:true}).click();
    assert.ok(await page.getByText(/f1 \(severity\)/).isVisible());
    assert.ok(await page.getByText(/f1 \(status\)/).isVisible());
    await page.getByRole('button',{name:'Refresh'}).click();
    await page.getByRole('region',{name:'Severity breakdown'}).waitFor();
    assert.equal(await page.getByText(/Update failed or was not verified/).count(),0);
  } finally {await page.close();}
});

test('failed metadata stays visible after navigation away and back', async () => {
  const page=await browser.newPage();const data=structuredClone(fixture);let release, started;
  const gate=new Promise(resolve=>{release=resolve;});const received=new Promise(resolve=>{started=resolve;});
  data.capabilities={findingMetadata:{enabled:true,method:'PATCH',url:'/api/meta',options:{severity:['High','Low']}}};
  await page.route('**/api/data',route=>route.fulfill({json:data}));
  await page.route('**/api/meta',async route=>{started();await gate;await route.fulfill({status:500,body:'failed'});});
  try {
    await page.goto(base);await page.getByRole('button',{name:'Programs',exact:true}).click();
    await page.getByLabel('severity for Example finding').selectOption('Low');await received;
    await page.getByRole('button',{name:'Dashboard',exact:true}).click();release();
    await page.getByText(/Update failed or was not verified/).waitFor({timeout:3000});
    await page.getByRole('button',{name:'Programs',exact:true}).click();
    assert.ok(await page.getByText(/Update failed or was not verified/).isVisible());
    assert.equal(await page.getByLabel('severity for Example finding').inputValue(),'High');
  } finally {release();await page.close();}
});

test('pending metadata is visible when navigating to the dashboard', async () => {
  const page=await browser.newPage();const data=structuredClone(fixture);let release, started;
  const gate=new Promise(resolve=>{release=resolve;});const received=new Promise(resolve=>{started=resolve;});
  data.capabilities={findingMetadata:{enabled:true,method:'PATCH',url:'/api/meta',options:{severity:['High','Low']}}};
  await page.route('**/api/data',route=>route.fulfill({json:data}));
  await page.route('**/api/meta',async route=>{started();await gate;await route.fulfill({json:{value:route.request().postDataJSON().value}});});
  try {
    await page.goto(base);await page.getByRole('button',{name:'Programs',exact:true}).click();
    await page.getByLabel('severity for Example finding').selectOption('Low');await received;
    await page.getByRole('button',{name:'Dashboard',exact:true}).click();
    assert.ok(await page.getByText(/Updating metadata; waiting for confirmation/).isVisible());
    release();await page.waitForFunction(()=>!document.querySelector('#refresh').disabled);
    assert.equal(await page.getByText(/Updating metadata; waiting for confirmation/).count(),0);
  } finally {release();await page.close();}
});

test('pending metadata blocks refresh and updates the dashboard after navigation', async () => {
  const page=await browser.newPage();const data=structuredClone(fixture);let release, started, loads=0;
  const gate=new Promise(resolve=>{release=resolve;});const received=new Promise(resolve=>{started=resolve;});
  data.capabilities={findingMetadata:{enabled:true,method:'PATCH',url:'/api/meta',options:{severity:['High','Low']}}};
  await page.route('**/api/data',route=>{loads++;return route.fulfill({json:data});});
  await page.route('**/api/meta',async route=>{started();await gate;await route.fulfill({json:{value:route.request().postDataJSON().value}});});
  try {
    await page.goto(base);await page.getByRole('button',{name:'Programs',exact:true}).click();
    await page.getByLabel('severity for Example finding').selectOption('Low');await received;
    assert.equal(await page.getByRole('button',{name:'Refresh'}).isDisabled(),true);
    await page.locator('#refresh').dispatchEvent('click');assert.equal(loads,1);
    await page.getByRole('button',{name:'Dashboard',exact:true}).click();
    release();
    await page.waitForFunction(()=>!document.querySelector('#refresh').disabled);
    assert.match(await page.getByRole('region',{name:'Severity breakdown'}).innerText(),/Low\s+1/);
    await page.getByRole('button',{name:'Programs',exact:true}).click();
    assert.equal(await page.getByLabel('severity for Example finding').inputValue(),'Low');
  } finally {release();await page.close();}
});

test('metadata updates show pending and serialize controls until verified', async () => {
  const page=await browser.newPage();const data=structuredClone(fixture);let release, started;
  const gate=new Promise(resolve=>{release=resolve;});const received=new Promise(resolve=>{started=resolve;});let writes=0;
  data.capabilities={findingMetadata:{enabled:true,method:'PATCH',url:'/api/meta',options:{severity:['High','Low'],status:['Draft','Open']}}};
  await page.route('**/api/data',route=>route.fulfill({json:data}));
  await page.route('**/api/meta',async route=>{writes++;started();await gate;await route.fulfill({json:{value:route.request().postDataJSON().value}});});
  try {
    await page.goto(base);await page.getByRole('button',{name:'Programs',exact:true}).click();
    await page.getByLabel('severity for Example finding').selectOption('Low');await received;
    assert.ok(await page.getByText(/Updating metadata/).count());
    assert.equal(await page.getByLabel('status for Example finding').isDisabled(),true);
    release();await page.waitForFunction(()=>!document.querySelector('[data-metadata="severity"]')?.disabled);
    assert.equal(writes,1);assert.equal(await page.getByLabel('severity for Example finding').inputValue(),'Low');
  } finally {release();await page.close();}
});

test('advertised BBH metadata capability sends the actual backend contract', async () => {
  const page=await browser.newPage();const data=structuredClone(fixture);let payload,headers;
  data.programs[0].lanes[0].findings=[{fid:'F01',title:'Synthetic BBH finding',severity:'HIGH',class_name:'xss',status:'raw'}];
  data.capabilities={finding_metadata:true,finding_fields:['severity','class_name','status','severity_rationale'],report_edit:false};
  await page.route('**/api/data',route=>route.fulfill({json:data}));
  await page.route('**/api/finding',route=>{payload=route.request().postDataJSON();headers=route.request().headers();data.source_token='updated-token';data.programs[0].lanes[0].findings[0].severity='LOW';return route.fulfill({json:{finding:{fid:'F01',severity:'LOW',class_name:'xss',status:'raw'}}});});
  await page.goto(base);await page.getByRole('button',{name:'Programs',exact:true}).click();
  assert.match(await page.locator('.footnote').innerText(),/supported fields/i);
  await page.getByLabel('severity for Synthetic BBH finding').selectOption('LOW',{timeout:2000});
  await page.waitForFunction(()=>document.querySelector('[data-metadata="severity"]')?.value==='LOW' && !document.querySelector('[data-metadata="severity"]')?.disabled);
  assert.deepEqual(payload,{family:'Test',program:'Example program',lane:'Web',fid:'F01',patch:{severity:'LOW'}});
  assert.equal(headers['x-requested-with'],'Bounty-Board');
  await page.close();
});

test('BBH class metadata uses the recorded class_name and verified owner ID', async () => {
  const page=await browser.newPage();const data=structuredClone(fixture);let payload;
  data.programs[0].lanes[0].findings=[{fid:'F01',title:'Synthetic BBH finding',class_name:'xss'}];
  data.capabilities={finding_metadata:true,finding_fields:['class_name']};
  await page.route('**/api/data',route=>route.fulfill({json:data}));
  await page.route('**/api/finding',route=>{payload=route.request().postDataJSON();data.source_token='updated-token';data.programs[0].lanes[0].findings[0].class_name='sqli';return route.fulfill({json:{finding:{fid:'F01',class_name:'sqli'}}});});
  await page.goto(base);await page.getByRole('button',{name:'Programs',exact:true}).click();
  const input=page.getByLabel('class for Synthetic BBH finding');
  assert.equal(await input.inputValue(),'xss');await input.fill('sqli',{timeout:2000});await input.press('Tab');
  await page.waitForFunction(()=>document.querySelector('[data-metadata="class"]')?.value==='sqli' && !document.querySelector('[data-metadata="class"]')?.disabled);
  assert.deepEqual(payload.patch,{class_name:'sqli'});
  await page.close();
});

test('browser metadata update reaches backend with a disposable synthetic writer', async () => {
  const {spawn}=require('node:child_process');const {once}=require('node:events');
  const tmp=fs.mkdtempSync(path.join(process.env.TMPDIR||'/home/ryushe/.hermes/cache/scratch','board-ui-test-'));
  const lane=path.join(tmp,'web_bounty','fictional','web');fs.mkdirSync(path.join(lane,'ledgers'),{recursive:true});fs.mkdirSync(path.join(lane,'reports'));
  const ledger=path.join(lane,'ledgers','ledger.json');fs.writeFileSync(ledger,JSON.stringify({findings:[{fid:'F01',title:'Synthetic fixture',severity:'LOW'}]}));
  const writer=path.join(tmp,'fixture-writer.py');
  fs.writeFileSync(writer,`#!/usr/bin/python3\nimport sys,json\nfrom pathlib import Path\nif '--help' in sys.argv:\n print('--edit-finding --patch-file --root --family --lane');sys.exit(0)\np=Path(${JSON.stringify(ledger)})\nd=json.loads(p.read_text());d['findings'][0].update(json.loads(Path(sys.argv[sys.argv.index('--patch-file')+1]).read_text()));p.write_text(json.dumps(d))\n`);fs.chmodSync(writer,0o700);
  const source='import sys, app; s=app.make_server(sys.argv[1],0,writer=sys.argv[2],accept_uncoordinated_writes=True); print(s.server_port,flush=True); s.serve_forever()';
  const proc=spawn('python3',['-B','-u','-c',source,tmp,writer],{cwd:path.resolve(root,'..'),stdio:['ignore','pipe','pipe'],env:{...process.env,TMPDIR:tmp}});let page;
  try {
    const [chunk]=await Promise.race([once(proc.stdout,'data'),new Promise((_,reject)=>setTimeout(()=>reject(new Error('backend startup timeout')),5000))]);
    page=await browser.newPage();await page.goto(`http://127.0.0.1:${Number(chunk.toString().trim())}`);
    await page.getByRole('button',{name:'Programs',exact:true}).click();
    await page.getByLabel('severity for Synthetic fixture').selectOption('HIGH');
    await page.waitForFunction(()=>document.querySelector('[data-metadata="severity"]')?.value==='HIGH' && !document.querySelector('[data-metadata="severity"]')?.disabled);
    assert.equal(JSON.parse(fs.readFileSync(ledger,'utf8')).findings[0].severity,'HIGH');
  } finally {if(page)await page.close();if(proc.exitCode===null && proc.signalCode===null){const exited=once(proc,'exit');proc.kill('SIGTERM');await exited;}fs.rmSync(tmp,{recursive:true,force:true});}
});

test('BBH metadata rejects a response for a different finding', async () => {
  const page=await browser.newPage();const data=structuredClone(fixture);
  data.programs[0].lanes[0].findings=[{fid:'F01',title:'Synthetic BBH finding',severity:'HIGH'}];
  data.capabilities={finding_metadata:true,finding_fields:['severity']};
  await page.route('**/api/data',route=>route.fulfill({json:data}));
  await page.route('**/api/finding',route=>route.fulfill({json:{finding:{fid:'F02',severity:'LOW'}}}));
  await page.goto(base);await page.getByRole('button',{name:'Programs',exact:true}).click();
  await page.getByLabel('severity for Synthetic BBH finding').selectOption('LOW');
  await page.getByText(/source may have changed; refresh/).waitFor();
  assert.equal(await page.getByLabel('severity for Synthetic BBH finding').inputValue(),'HIGH');
  await page.close();
});

test('coverage and report ownership remain readable across themes on mobile', async () => {
  const page=await browser.newPage({viewport:{width:375,height:800}});const data=structuredClone(fixture);
  data.programs[0].lanes[0].coverage={items:[],counts:{},total:0,mapped_kinds:{route:3},unclassified_surfaces:3};
  data.programs[0].lanes[0].reports=[{path:'findings/long-synthetic-directory-name/final-report.md',kind:'registered_report',owner_fids:['F01'],content:'# Fixture'}];
  await page.route('**/api/data',route=>route.fulfill({json:data}));
  await page.goto(base);await page.getByRole('button',{name:'Programs',exact:true}).click();
  for(const themeName of ['light','dark','dusk']) {
    await page.getByLabel('Theme').selectOption(themeName);
    assert.equal(await page.locator('html').getAttribute('data-theme'),themeName);
    await page.getByRole('button',{name:'Coverage',exact:true}).click();assert.ok(await page.getByText('Mapped inventory').isVisible());
    await page.getByRole('button',{name:'Reports',exact:true}).click();assert.ok(await page.getByText(/Registered report/).isVisible());
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,themeName);
  }
  await page.close();
});

test('rationale drafts survive finding switches, navigation and refresh with unload warning', async () => {
  const page=await browser.newPage();const data=structuredClone(fixture);
  data.programs[0].lanes[0].findings=[{fid:'F01',title:'First finding',severity_rationale:'First saved'}, {fid:'F02',title:'Second finding',severity_rationale:'Second saved'}];
  data.programs[0].lanes.push({name:'API',findings:[],coverage:[],reports:[],map:[],gadgets:[]});
  data.capabilities={finding_metadata:true,finding_fields:['severity_rationale']};
  await page.route('**/api/data',route=>route.fulfill({json:data}));
  try {
    await page.goto(base);await page.getByRole('button',{name:'Programs',exact:true}).click();
    await page.getByRole('button',{name:'Edit severity rationale for First finding'}).click();
    await page.getByRole('textbox',{name:'Severity rationale for First finding'}).fill('First draft');
    await page.getByRole('button',{name:'Edit severity rationale for Second finding'}).click();
    await page.getByRole('textbox',{name:'Severity rationale for Second finding'}).fill('Second draft');
    await page.getByLabel('Lane').selectOption('API');
    assert.equal(await page.evaluate(()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented;}),true);
    await page.getByLabel('Lane').selectOption('Web');
    data.programs[0].lanes[0].findings[0].severity_rationale='Changed at source';
    await page.getByRole('button',{name:'Refresh'}).click();
    await page.getByRole('textbox',{name:'Severity rationale for First finding'}).waitFor();
    assert.equal(await page.getByRole('textbox',{name:'Severity rationale for First finding'}).inputValue(),'First draft');
    assert.equal(await page.getByRole('textbox',{name:'Severity rationale for Second finding'}).inputValue(),'Second draft');
    const first=page.locator('tr').filter({hasText:'First finding'});
    assert.match(await first.innerText(),/Saved rationale.*Changed at source/s);
    assert.match(await first.innerText(),/Unsaved draft/i);
  } finally {await page.close();}
});

test('a source change makes an untouched open rationale draft unsaved', async () => {
  const page=await browser.newPage();const data=structuredClone(fixture);
  data.programs[0].lanes[0].findings[0].severity_rationale='Old source';
  data.capabilities={finding_metadata:true,finding_fields:['severity_rationale']};
  await page.route('**/api/data',route=>route.fulfill({json:data}));
  try {
    await page.goto(base);await page.getByRole('button',{name:'Programs',exact:true}).click();
    await page.getByRole('button',{name:'Edit severity rationale for Example finding'}).click();
    data.programs[0].lanes[0].findings[0].severity_rationale='New source';
    await page.getByRole('button',{name:'Refresh'}).click();
    await page.getByText('New source',{exact:true}).waitFor();
    assert.equal(await page.getByRole('textbox',{name:'Severity rationale for Example finding'}).inputValue(),'Old source');
    assert.equal(await page.evaluate(()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented;}),true);
  } finally {await page.close();}
});

test('rationale save while navigated away updates only its own draft and confirmed value', async () => {
  const page=await browser.newPage();const data=structuredClone(fixture);let release, started;
  const gate=new Promise(resolve=>{release=resolve;});const received=new Promise(resolve=>{started=resolve;});
  data.programs[0].lanes[0].findings=[{fid:'F01',title:'First finding',severity_rationale:'First saved'}, {fid:'F02',title:'Second finding',severity_rationale:'Second saved'}];
  data.capabilities={finding_metadata:true,finding_fields:['severity_rationale']};
  await page.route('**/api/data',route=>route.fulfill({json:data}));
  await page.route('**/api/finding',async route=>{started();await gate;const body=route.request().postDataJSON();await route.fulfill({json:{finding:{fid:body.fid,...body.patch}}});});
  try {
    await page.goto(base);await page.getByRole('button',{name:'Programs',exact:true}).click();
    assert.equal(await page.evaluate(()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented;}),false);
    await page.getByRole('button',{name:'Edit severity rationale for First finding'}).click();
    await page.getByRole('textbox',{name:'Severity rationale for First finding'}).fill('First draft');
    await page.getByRole('button',{name:'Edit severity rationale for Second finding'}).click();
    await page.getByRole('textbox',{name:'Severity rationale for Second finding'}).fill('Second draft');
    await page.getByRole('button',{name:'Save severity rationale for First finding'}).click();await received;
    assert.equal(await page.getByRole('button',{name:'Refresh'}).isDisabled(),true);
    await page.getByRole('button',{name:'Dashboard',exact:true}).click();release();
    await page.waitForFunction(()=>!document.querySelector('#refresh').disabled);
    await page.getByRole('button',{name:'Programs',exact:true}).click();
    assert.ok(await page.getByText('First draft',{exact:true}).isVisible());
    assert.equal(await page.getByRole('textbox',{name:'Severity rationale for Second finding'}).inputValue(),'Second draft');
    assert.equal(await page.evaluate(()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented;}),true);
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
    assert.equal(await page.evaluate(()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented;}),false);
  } finally {release();await page.close();}
});

test('severity rationale is visible and explicitly saved for its own finding', async () => {
  const page=await browser.newPage();const data=structuredClone(fixture);const writes=[];
  data.programs[0].lanes[0].findings=[{fid:'F01',title:'First finding',severity:'HIGH',severity_rationale:'Original rationale'}, {fid:'F02',title:'Second finding',severity:'LOW',severity_rationale:'Other rationale'}];
  data.capabilities={finding_metadata:true,finding_fields:['severity','severity_rationale']};
  await page.route('**/api/data',route=>route.fulfill({json:data}));
  await page.route('**/api/finding',route=>{const body=route.request().postDataJSON();writes.push(body);return route.fulfill({json:{finding:{fid:body.fid,...body.patch}}});});
  await page.goto(base);await page.getByRole('button',{name:'Programs',exact:true}).click();
  assert.ok(await page.getByText('Original rationale',{exact:true}).isVisible());
  await page.getByRole('button',{name:'Edit severity rationale for First finding'}).click();
  await page.getByLabel('Severity rationale for First finding',{exact:true}).fill('Corrected rationale');
  assert.equal(writes.length,0);
  await page.getByRole('button',{name:'Save severity rationale for First finding'}).click();
  await page.getByText('Corrected rationale',{exact:true}).waitFor();
  assert.equal(writes.length,1);assert.equal(writes[0].fid,'F01');assert.deepEqual(writes[0].patch,{severity_rationale:'Corrected rationale'});
  assert.ok(await page.getByText('Other rationale',{exact:true}).isVisible());
  await page.close();
});

test('active metadata controls warn about uncoordinated local and sync overwrites', async () => {
  const page=await browser.newPage();const data=structuredClone(fixture);
  data.capabilities={finding_metadata:true,finding_fields:['severity']};
  await page.route('**/api/data',route=>route.fulfill({json:data}));
  await page.goto(base);await page.getByRole('button',{name:'Programs',exact:true}).click();
  assert.equal(await page.getByLabel('severity for Example finding').isEnabled(),true);
  const warning=page.locator('.metadata-warning');
  assert.match(await warning.innerText(),/local.*sync.*overwrit/i);
  assert.equal(await page.getByLabel('severity for Example finding').getAttribute('aria-describedby'),'metadata-warning');
  await page.close();
});

test('severity breakdown counts loaded values and labels incomplete collections', async () => {
  const page=await browser.newPage();const data=structuredClone(fixture);
  data.programs[0].lanes[0].findings=[{severity:'HIGH'},{severity:'LOW'},{severity:'HIGH'},{severity:null}];
  data.programs[0].lanes.push({name:'Unavailable'});
  await page.route('**/api/data',route=>route.fulfill({json:data}));await page.goto(base);
  const panel=page.getByRole('region',{name:'Severity breakdown'});
  assert.match(await panel.innerText(),/incomplete|partial/i);
  assert.match(await panel.innerText(),/HIGH\s+2/);
  assert.match(await panel.innerText(),/LOW\s+1/);
  assert.match(await panel.innerText(),/Not recorded\s+1/);
  await page.close();
});

test('read-only rationale remains visible as inert text without an editor', async () => {
  const page=await browser.newPage();const data=structuredClone(fixture);
  data.programs[0].lanes[0].findings[0].severity_rationale='<img src=x onerror="window.pwned=1">';
  await page.route('**/api/data',route=>route.fulfill({json:data}));
  await page.goto(base);await page.getByRole('button',{name:'Programs',exact:true}).click();
  assert.ok(await page.getByText('<img src=x onerror="window.pwned=1">',{exact:true}).isVisible());
  assert.equal(await page.locator('#app img').count(),0);
  assert.equal(await page.getByRole('button',{name:/Edit severity rationale/}).count(),0);
  assert.equal(await page.evaluate(()=>window.pwned),undefined);await page.close();
});

test('failed rationale save preserves the draft and warns to refresh', async () => {
  const page=await browser.newPage();const data=structuredClone(fixture);
  data.programs[0].lanes[0].findings[0].severity_rationale='Previously saved';
  data.capabilities={finding_metadata:true,finding_fields:['severity_rationale']};
  await page.route('**/api/data',route=>route.fulfill({json:data}));
  await page.route('**/api/finding',route=>route.fulfill({status:500,body:'failed'}));
  await page.goto(base);await page.getByRole('button',{name:'Programs',exact:true}).click();
  await page.getByRole('button',{name:'Edit severity rationale for Example finding'}).click();
  await page.getByRole('textbox',{name:'Severity rationale for Example finding'}).fill('Unsaved draft');
  await page.getByRole('button',{name:'Save severity rationale for Example finding'}).click();
  await page.getByText(/source may have changed; refresh/).waitFor();
  assert.equal(await page.getByRole('textbox',{name:'Severity rationale for Example finding'}).inputValue(),'Unsaved draft');
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  assert.ok(await page.getByText('Previously saved',{exact:true}).isVisible());await page.close();
});

test('rationale editor and overwrite warning stay accessible on mobile themes', async () => {
  const page=await browser.newPage({viewport:{width:375,height:800}});const data=structuredClone(fixture);
  data.programs[0].lanes[0].findings[0].severity_rationale='Synthetic rationale';
  data.capabilities={finding_metadata:true,finding_fields:['severity_rationale']};
  await page.route('**/api/data',route=>route.fulfill({json:data}));await page.goto(base);
  await page.getByRole('button',{name:'Programs',exact:true}).click();
  for(const themeName of ['light','dark','dusk']) {
    await page.getByLabel('Theme').selectOption(themeName);
    assert.ok(await page.locator('.metadata-warning').isVisible());
    await page.getByRole('button',{name:'Edit severity rationale for Example finding'}).click();
    assert.equal(await page.getByRole('textbox',{name:'Severity rationale for Example finding'}).getAttribute('aria-describedby'),'metadata-warning');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,themeName);
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
  }
  await page.close();
});

after(async()=>{if(browser) await browser.close(); await new Promise(resolve=>server.close(resolve));});
