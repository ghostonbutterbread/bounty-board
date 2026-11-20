const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

// Fictional in-memory records only. No bounty directories or backend are read.
const fixture = {programs:[{id:'synthetic',name:'Example program',family:'Test',lanes:[{name:'Web',findings:[{id:'f1',title:'Example finding',severity:'High',class:'Access control',status:'Draft'}],coverage:[{surface:'Example surface',class:'XSS',state:'Mapped',notes:'One boundary observed'}],gadgets:[],map:[],reports:[{id:'r1',title:'Example report',content:'# Report\n\nInitial text',revision:'1'}],warnings:[]}]}],warnings:[]};
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

async function openReport(page) {
  await page.goto(base);
  await page.getByRole('button',{name:'Programs',exact:true}).click();
  await page.getByRole('button',{name:'Reports',exact:true}).click();
  await page.locator('#report-source').waitFor();
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
  assert.match(await page.locator('#report-status').innerText(),/Saving unavailable/);
  await page.locator('#report-source').fill('# Heading\n\n**bold**\n\n<img src="https://bad.invalid/x" onerror="window.pwned=1">\n\n![x](https://bad.invalid/img)');
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

test('advertised report saves use revisions, debounce, and preserve conflicts', async () => {
  const page=await browser.newPage(); const writes=[];
  const data=structuredClone(fixture);data.capabilities={reportWrite:{enabled:true,method:'PATCH',url:'/api/report'}};
  await page.route('**/api/data',route=>route.fulfill({json:data}));
  await page.route('**/api/report',async route=>{
    const body=route.request().postDataJSON(); writes.push(body);
    if(writes.length===1) return route.fulfill({json:{content:body.content,revision:'2'}});
    return route.fulfill({status:409,json:{error:'conflict'}});
  });
  await openReport(page);
  await page.locator('#report-source').fill('# New report');
  assert.match(await page.locator('#report-status').innerText(),/Unsaved/);
  await page.waitForFunction(()=>document.querySelector('#report-status')?.textContent==='Saved to source.');
  assert.equal(writes.length,1);assert.equal(writes[0].revision,'1');
  await page.locator('#report-source').fill('# Conflict draft');
  await page.waitForFunction(()=>document.querySelector('#report-status')?.textContent.startsWith('Conflict:'));
  assert.equal(writes[1].revision,'2');
  await page.locator('#report-source').fill('# Keep my draft');
  await page.waitForTimeout(800);
  assert.equal(writes.length,2);
  await page.getByRole('button',{name:'Coverage',exact:true}).click();
  await page.getByRole('button',{name:'Reports',exact:true}).click();
  assert.equal(await page.locator('#report-source').inputValue(),'# Keep my draft');
  assert.match(await page.locator('#report-status').innerText(),/Conflict/);
  await page.close();
});

test('report edits during a pending save are sent with its returned revision', async () => {
  const page=await browser.newPage();const data=structuredClone(fixture), writes=[];let release;
  const gate=new Promise(resolve=>{release=resolve;});
  data.capabilities={reportWrite:{enabled:true,method:'PATCH',url:'/api/report'}};
  await page.route('**/api/data',route=>route.fulfill({json:data}));
  await page.route('**/api/report',async route=>{const body=route.request().postDataJSON();writes.push(body);if(writes.length===1)await gate;await route.fulfill({json:{content:body.content,revision:String(writes.length+1)}});});
  try {
    await openReport(page);await page.locator('#report-source').fill('First draft');
    await page.waitForFunction(()=>document.querySelector('#report-status')?.textContent==='Saving…');
    await page.locator('#report-source').fill('Second draft');
    release();
    await page.waitForFunction(()=>document.querySelector('#report-status')?.textContent==='Saved to source.');
    assert.equal(writes.length,2);assert.equal(writes[0].revision,'1');assert.equal(writes[1].revision,'2');assert.equal(writes[1].content,'Second draft');
  } finally {release();await page.close();}
});

test('failed saves preserve draft and never claim success', async () => {
  const page=await browser.newPage();const data=structuredClone(fixture);data.capabilities={reportWrite:{enabled:true,method:'PATCH',url:'/api/report'}};
  await page.route('**/api/data',route=>route.fulfill({json:data}));
  await page.route('**/api/report',route=>route.fulfill({status:500,body:'failed'}));
  await openReport(page);await page.locator('#report-source').fill('Keep this');
  await page.waitForFunction(()=>document.querySelector('#report-status')?.textContent.startsWith('Save failed.'));
  assert.equal(await page.locator('#report-source').inputValue(),'Keep this');
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
  assert.match(await page.locator('#report-status').innerText(),/Saving unavailable/);
  await page.close();
});

test('refresh updates a clean report but retains a local draft', async () => {
  const page=await browser.newPage();const data=structuredClone(fixture);
  await page.route('**/api/data',route=>route.fulfill({json:data}));
  await openReport(page);
  data.programs[0].lanes[0].reports[0].content='# Changed at source';data.programs[0].lanes[0].reports[0].revision='2';
  await page.getByRole('button',{name:'Refresh'}).click();
  await page.waitForFunction(()=>document.querySelector('#report-source')?.value==='# Changed at source',null,{timeout:3000});
  await page.locator('#report-source').fill('# Local draft');
  data.programs[0].lanes[0].reports[0].content='# Another source change';
  await page.getByRole('button',{name:'Refresh'}).click();
  await page.locator('#report-source').waitFor();
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
    await page.goto(url);await page.getByText('No programs returned by the backend.').waitFor();
    assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.sidebar')).display),'flex');
    assert.deepEqual(failures,[]);
    await page.getByRole('button',{name:'Programs',exact:true}).click();
    assert.ok(await page.getByText('Configure the program root in the backend and refresh.').count());
  } finally {if(page)await page.close();if(proc.exitCode===null && proc.signalCode===null){const exited=once(proc,'exit');proc.kill('SIGTERM');await exited;}}
});

after(async()=>{if(browser) await browser.close(); await new Promise(resolve=>server.close(resolve));});
