const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {chromium}=require('playwright');

async function fixture(run) {
  const tmp=fs.mkdtempSync(path.join(process.env.TMPDIR,'board-save-ui-'));
  const root=path.join(tmp,'root'), report=path.join(root,'web_bounty/example/web/reports/example.md');
  fs.mkdirSync(path.dirname(report),{recursive:true});fs.writeFileSync(report,'original\n');
  fs.writeFileSync(path.join(path.dirname(report),'second.md'),'second\n');
  const proc=spawn('python3',['-B','-u','-c',"import sys,app; s=app.make_server(sys.argv[1],0,collaboration_dir=sys.argv[2],report_autosave=True); print(s.server_port,flush=True); s.serve_forever()",root,path.join(tmp,'private')],{cwd:path.resolve(__dirname,'../..'),env:process.env,stdio:['ignore','pipe','ignore']});
  let browser;
  try {
    const [chunk]=await once(proc.stdout,'data');const base='http://127.0.0.1:'+Number(chunk.toString().trim());
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',args:['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    await run({browser,base,report});
  } finally {if(browser)await browser.close();if(proc.exitCode===null&&proc.signalCode===null){const done=once(proc,'exit');proc.kill();await done;}fs.rmSync(tmp,{recursive:true,force:true});}
}
async function open(page,base){page.setDefaultTimeout(8000);await page.goto(base);await page.getByRole('button',{name:'Programs',exact:true}).click();await page.getByRole('button',{name:'Reports',exact:true}).click();await page.getByText(/Shared draft ready/).waitFor();}
async function edit(page,text){await page.locator('.CodeMirror textarea').focus();await page.keyboard.press('Control+A');await page.keyboard.insertText(text);}

test('published receipt is presented as point-in-time Markdown save', {timeout:30000},()=>fixture(async({browser,base,report})=>{
  const page=await browser.newPage();await open(page,base);await edit(page,'saved text\n');
  await page.getByText(/Markdown file saved/).waitFor();
  assert.equal(fs.readFileSync(report,'utf8'),'saved text\n');
  assert.match(await page.locator('#report-status').innerText(),/shared draft/i);
}));

test('lost acknowledgment retains exact request and newer edit until original is inspected', {timeout:35000},()=>fixture(async({browser,base,report})=>{
  const page=await browser.newPage();await open(page,base);
  let first,arrive;const committed=new Promise(r=>arrive=r);let posts=[];
  const lose=async route=>{if(route.request().method()!=='POST')return route.continue();first=route.request().postDataJSON();posts.push(first);await route.fetch();arrive();await route.abort();};
  await page.route('**/api/collaboration?*',lose);await edit(page,'first\n');await committed;
  await page.getByText(/Save outcome unconfirmed/).waitFor();await edit(page,'newer\n');
  await page.unroute('**/api/collaboration?*',lose);
  page.on('request',r=>{if(r.method()==='POST' && r.url().includes('/api/collaboration?'))posts.push(r.postDataJSON());});
  await page.reload();await page.getByRole('button',{name:'Programs',exact:true}).click();await page.getByRole('button',{name:'Reports',exact:true}).click();
  await page.getByRole('button',{name:'Inspect original save'}).waitFor();
  assert.equal(posts.length,1);assert.equal(await page.evaluate(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()),'newer\n');
  const inspection=page.waitForResponse(r=>r.url().includes('/api/collaboration/recovery?')&&r.status()===200);
  await page.getByRole('button',{name:'Inspect original save'}).click();
  const receipt=await (await inspection).json();assert.equal(receipt.store_saved,true);
  await page.waitForFunction(()=>document.querySelector('#report-status')?.textContent.includes('Markdown file saved') && document.querySelector('.CodeMirror').CodeMirror.getValue()==='newer\n');
  await page.waitForFunction(()=>document.querySelector('#report-status')?.textContent.includes('Markdown file saved') && !document.querySelector('[data-inspect-save]'));
  await page.waitForTimeout(1200);
  assert.ok(posts.length>=2,'newer edit must be saved after inspection');assert.notEqual(posts[1].request_id,first.request_id);assert.equal(posts[1].content,'newer\n');assert.equal(fs.readFileSync(report,'utf8'),'newer\n');
}));


for(const publicationState of ['pending','outcome_uncertain','future_state']) {
  test(`mocked ${publicationState} publication never claims the Markdown saved or discards edits`, {timeout:30000},()=>fixture(async({browser,base})=>{
    const page=await browser.newPage();await open(page,base);let posts=0;
    await page.route('**/api/collaboration?*',async route=>{
      if(route.request().method()!=='POST')return route.continue();
      posts++;const response=await route.fetch(),body=await response.json();body.publication={state:publicationState,operation:'synthetic-opaque'};
      await route.fulfill({response,json:body});
    });
    await edit(page,'retained draft\n');
    await page.getByRole('button',{name:'Inspect original save'}).waitFor();
    await page.getByText(/Shared draft saved\./).waitFor();
    const status=await page.locator('#report-status').innerText();assert.match(status,/Shared draft saved/);assert.doesNotMatch(status,/Markdown file saved/);assert.match(status,/pending|uncertain/i);
    await edit(page,'newer retained draft\n');await page.waitForTimeout(1200);assert.equal(posts,1);
    assert.equal(await page.evaluate(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()),'newer retained draft\n');
    const stored=await page.evaluate(()=>Object.values(localStorage).filter(v=>v.includes('newer retained draft')).map(v=>JSON.parse(v)));
    assert.ok(stored.some(x=>x.pendingShared?.content==='retained draft\n'&&x.text==='newer retained draft\n'));
  }));
}

test('two clients and an external edit report conflict without claiming an untouched file', {timeout:40000},()=>fixture(async({browser,base,report})=>{
  const a=await browser.newPage(),b=await browser.newPage();await Promise.all([open(a,base),open(b,base)]);
  let release,arrive;const gate=new Promise(r=>release=r),started=new Promise(r=>arrive=r);
  const hold=async route=>{if(route.request().method()==='POST'){arrive();await gate;}await route.continue();};
  await b.route('**/api/collaboration?*',hold);await edit(b,'client B\n');await started;
  await edit(a,'client A\n');await a.getByText(/Markdown file saved/).waitFor();
  fs.writeFileSync(report,'external competing edit\n');release();
  await b.getByText(/Publication conflict/).waitFor();
  assert.match(await b.locator('#report-status').innerText(),/may already have changed/);
  assert.equal(await b.evaluate(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()),'client B\n');
  assert.equal(await b.getByRole('button',{name:'Continue after reviewing conflict'}).count(),0);
  await b.unroute('**/api/collaboration?*',hold);
  await b.getByRole('button',{name:'Inspect original save'}).click();
  await b.getByRole('button',{name:'Continue after reviewing conflict'}).waitFor();
  await b.getByRole('button',{name:'Inspect current Markdown'}).click();
  assert.equal(await b.getByLabel('Current Markdown inspection').inputValue(),fs.readFileSync(report,'utf8'));
  await b.getByText('Shared history and conflicts').click();
  await b.getByRole('button',{name:'Preview this version'}).first().waitFor();
  assert.equal(await b.evaluate(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()),'client B\n');
  const inspection=JSON.parse(await b.getByLabel('Latest publication inspection').inputValue());assert.equal(inspection.state,'conflict');
  await b.getByRole('button',{name:'Continue after reviewing conflict'}).click();
  await b.getByText('Reviewed publication requests').click();
  const reviewed=JSON.parse(await b.getByLabel('Reviewed publication requests').inputValue());
  assert.equal(reviewed[0].request.content,'client B\n');assert.equal(reviewed[0].publication.state,'conflict');
  assert.equal(await b.evaluate(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()),'client B\n');
}));

test('delayed acknowledgment belongs to the original selection', {timeout:35000},()=>fixture(async({browser,base,report})=>{
  const page=await browser.newPage();await open(page,base);
  let release,arrive;const gate=new Promise(r=>release=r),started=new Promise(r=>arrive=r);
  const hold=async route=>{if(route.request().method()!=='POST')return route.continue();const response=await route.fetch();arrive();await gate;await route.fulfill({response});};
  await page.route('**/api/collaboration?*',hold);await edit(page,'first delayed\n');await started;
  await page.locator('#report-select').selectOption('second.md');await page.waitForFunction(()=>document.querySelector('.CodeMirror')?.CodeMirror.getValue()==='second\n');
  release();await page.waitForTimeout(800);
  assert.equal(await page.evaluate(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()),'second\n');
  assert.doesNotMatch(await page.locator('#report-status').innerText(),/Markdown file saved/);
  assert.equal(fs.readFileSync(report,'utf8'),'first delayed\n');
  await page.locator('#report-select').selectOption('example.md');await page.getByText(/Markdown file saved/).waitFor();
}));


test('not-observed recovery permits only exact original retry before newer edit', {timeout:35000},()=>fixture(async({browser,base,report})=>{
  const page=await browser.newPage();await open(page,base);let original;
  const abort=route=>{if(route.request().method()!=='POST')return route.continue();original=route.request().postDataJSON();return route.abort();};
  await page.route('**/api/collaboration?*',abort);await edit(page,'not received\n');await page.getByText(/Save outcome unconfirmed/).waitFor();
  await edit(page,'after failure\n');await page.unroute('**/api/collaboration?*',abort);
  await page.getByRole('button',{name:'Inspect original save'}).click();await page.getByRole('button',{name:'Retry exact original request'}).waitFor();
  const retry=page.waitForRequest(r=>r.method()==='POST' && r.url().includes('/api/collaboration?'));
  await page.getByRole('button',{name:'Retry exact original request'}).click();assert.deepEqual((await retry).postDataJSON(),original);
  await page.waitForFunction(()=>document.querySelector('#report-status')?.textContent.includes('Markdown file saved') && document.querySelector('.CodeMirror').CodeMirror.getValue()==='after failure\n',{},{timeout:15000});
  assert.equal(fs.readFileSync(report,'utf8'),'after failure\n');
}));


test('a saved notice is invalidated when reload observes a later external change', {timeout:30000},()=>fixture(async({browser,base,report})=>{
  const page=await browser.newPage();await open(page,base);await edit(page,'saved earlier\n');await page.getByText(/Markdown file saved/).waitFor();
  fs.writeFileSync(report,'later external\n');await page.reload();
  await page.getByRole('button',{name:'Programs',exact:true}).click();await page.getByRole('button',{name:'Reports',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.CodeMirror')?.CodeMirror.getValue()==='later external\n');
  await page.waitForTimeout(300);
  assert.doesNotMatch(await page.locator('#report-status').innerText(),/Markdown file saved/);
}));

// Adapter injects the policy that the sibling backend will advertise.
test('backend editability disables collaborative editor and source writes only for denied reports', {timeout:30000},()=>fixture(async({browser,base,report})=>{
  const page=await browser.newPage();page.setDefaultTimeout(6000);let posts=0;
  await page.route('**/api/data',async route=>{const response=await route.fetch(),body=await response.json();for(const item of body.programs[0].lanes[0].reports)item.kind=item.path==='example.md'?'generated_navigation':'generated_evidence';await route.fulfill({response,json:body});});
  await page.route('**/api/report?*',async route=>{const response=await route.fetch(),body=await response.json();body.editable=!route.request().url().includes('example.md');body.collaboration_editable=body.editable;await route.fulfill({response,json:body});});
  page.on('request',req=>{if(req.method()==='POST'&&req.url().includes('/api/collaboration?'))posts++;});
  await page.goto(base);await page.getByRole('button',{name:'Programs',exact:true}).click();await page.getByRole('button',{name:'Reports',exact:true}).click();
  await page.getByText(/read.only/i).waitFor({timeout:3000});
  assert.match(await page.locator('#app').innerText(),/Generated navigation/);
  assert.equal(await page.evaluate(()=>document.querySelector('.CodeMirror')?.CodeMirror.getOption('readOnly') ?? document.querySelector('#report-source')?.readOnly),true);
  assert.equal(await page.locator('.editor-toolbar').count(),0,'read-only editor must not expose write commands');
  assert.equal(await page.getByRole('button',{name:'Save merged report'}).count(),0);assert.equal(posts,0);assert.equal(fs.readFileSync(report,'utf8'),'original\n');
  await page.locator('#report-select').selectOption('second.md');await page.getByText(/Shared draft ready/).waitFor();assert.match(await page.locator('#app').innerText(),/Generated evidence/);await edit(page,'editable report\n');
  await page.getByText(/Markdown file saved/).waitFor();assert.equal(fs.readFileSync(path.join(path.dirname(report),'second.md'),'utf8'),'editable report\n');
}));

test('mocked published receipt without incoming revision retains newer edit and request', {timeout:30000},()=>fixture(async({browser,base})=>{
  const page=await browser.newPage();await open(page,base);let release,arrive;const gate=new Promise(r=>release=r),started=new Promise(r=>arrive=r);
  const handler=async route=>{if(route.request().method()!=='POST')return route.continue();const response=await route.fetch(),body=await response.json();delete body.incoming_revision;arrive();await gate;await route.fulfill({response,json:body});};
  try {await page.route('**/api/collaboration?*',handler);await edit(page,'earlier\n');await started;await edit(page,'newer\n');release();
    await page.getByText(/outcome is uncertain or unrecognized/i).waitFor({timeout:3000});
    await page.getByRole('button',{name:'Inspect original save'}).waitFor();
    const saved=await page.evaluate(()=>Object.values(localStorage).map(v=>{try{return JSON.parse(v);}catch{return null;}}).find(v=>v?.pendingShared));
    assert.equal(saved.text,'newer\n');assert.equal(saved.pendingShared.content,'earlier\n');
  } finally {release();}
}));

test('storage failure during in-flight acknowledgement retains unsent text and prevents another write', {timeout:30000},()=>fixture(async({browser,base})=>{
  const page=await browser.newPage();await open(page,base);let release,arrive,posts=0;const gate=new Promise(r=>release=r),started=new Promise(r=>arrive=r);
  const handler=async route=>{if(route.request().method()!=='POST')return route.continue();posts++;const response=await route.fetch();arrive();await gate;return route.fulfill({response});};
  try {await page.route('**/api/collaboration?*',handler);await edit(page,'submitted\n');await started;
    await page.evaluate(()=>{const put=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('bounty-board-report-draft-v2:'))throw new DOMException('quota','QuotaExceededError');return put.call(this,k,v);};});
    await edit(page,'only in memory\n');release();await page.getByText(/storage unavailable/i).first().waitFor();
    await page.waitForTimeout(1000);assert.equal(posts,1);assert.equal(await page.evaluate(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()),'only in memory\n');
    assert.equal(await page.getByLabel('Recover draft text').inputValue(),'only in memory\n');
    const stored=await page.evaluate(()=>Object.values(localStorage).map(v=>{try{return JSON.parse(v);}catch{return null;}}).find(v=>v?.pendingShared));
    assert.equal(stored.pendingShared.content,'submitted\n');
  }finally{release();}
}));
