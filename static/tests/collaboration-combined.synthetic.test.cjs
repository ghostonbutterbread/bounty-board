const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {chromium}=require('playwright');

async function fixture(run) {
  const tmp=fs.mkdtempSync(path.join(process.env.TMPDIR,'board-combined-'));
  const root=path.join(tmp,'root'), report=path.join(root,'web_bounty/example/web/reports/example.md');
  fs.mkdirSync(path.dirname(report),{recursive:true});fs.writeFileSync(report,'original\n');
  const proc=spawn('python3',['-B','-u','-c',"import sys,app; s=app.make_server(sys.argv[1],0,collaboration_dir=sys.argv[2],experimental_fixture_publish=True); print(s.server_port,flush=True); s.serve_forever()",root,path.join(tmp,'private')],{cwd:path.resolve(__dirname,'../..'),env:process.env,stdio:['ignore','pipe','pipe']});
  let browser;
  try {
    const [chunk]=await once(proc.stdout,'data');const base='http://127.0.0.1:'+Number(chunk.toString().trim());
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',args:['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    await run({browser,base,report});
  } finally {if(browser)await browser.close();if(proc.exitCode===null&&proc.signalCode===null){const done=once(proc,'exit');proc.kill();await done;}fs.rmSync(tmp,{recursive:true,force:true});}
}
async function open(page,base){page.setDefaultTimeout(10000);await page.goto(base);await page.getByRole('button',{name:'Programs',exact:true}).click();await page.getByRole('button',{name:'Reports',exact:true}).click();await page.getByText(/Shared draft ready/).waitFor();}

// Browser actions are real; the setup uses the same HTTP API and synthetic file.
test('real backend history stays continuous during paging and recovers an old conflict', {timeout:90000},()=>fixture(async({browser,base,report})=>{
  const context=await browser.newContext(),page=await context.newPage();
  const root=(await (await context.request.get(base+'/api/data')).json()).root_identity;
  const query=new URLSearchParams({family:'web_bounty',program:'example',lane:'web',path:'example.md',root_identity:root});
  const endpoint=base+'/api/collaboration?'+query;
  const get=async suffix=>{const r=await context.request.get(base+'/api/collaboration'+suffix);assert.equal(r.status(),200);return r.json();};
  const post=async payload=>{const r=await context.request.post(endpoint,{headers:{Origin:base,'X-Requested-With':'Bounty-Board'},data:payload});assert.equal(r.status(),200,await r.text());return r.json();};
  const initial=await get('?'+query);
  let head=await post({base:initial.revision,content:'first head\n',request_id:'first'});
  const conflict=await post({base:initial.revision,content:'old conflict input\n',request_id:'old-conflict'});
  assert.equal(conflict.status,'conflict');
  for(let i=0;i<53;i++) head=await post({base:head.revision,content:`edit ${i}\n`,request_id:`edit-${i}`});
  const before=await get('?'+query);assert.equal(before.history.length,50);assert.equal(before.unresolved_count,1);
  const boundary=before.history.at(-1).id;assert.ok(!before.history.some(e=>e.id===conflict.conflict_id));
  const versions=[];page.on('request',r=>{const u=new URL(r.url());if(u.pathname==='/api/collaboration/version')versions.push(u.searchParams.get('revision'));});
  await open(page,base);await page.getByText('Shared history and conflicts').click();
  assert.equal(versions.length,0);
  let release,arrived;const gate=new Promise(r=>release=r), started=new Promise(r=>arrived=r);
  const hold=async route=>{const response=await route.fetch();arrived();await gate;await route.fulfill({response});};
  await page.route('**/api/collaboration/history?*',hold);
  const click=page.getByRole('button',{name:'Load older history'}).click();await started;
  head=await post({base:head.revision,content:'during paging\n',request_id:'during-paging'});
  await page.waitForFunction(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()==='during paging\n');
  release();await click;await page.unroute('**/api/collaboration/history?*',hold);
  await page.getByRole('button',{name:`Resolve conflict ${conflict.conflict_id} with editor`}).waitFor();
  assert.equal(await page.locator(`[data-version="${boundary}"]`).count(),1,'recent boundary must survive a poll while the older page is in flight');
  const oldPage=await get('/history?'+new URLSearchParams({...Object.fromEntries(query),before:String(boundary)}));
  const old=oldPage.history.find(e=>e.id===conflict.conflict_id);assert.ok(old);
  assert.equal(versions.length,0);
  await page.locator(`[data-result="${old.id}"]`).click();
  await page.waitForFunction(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()==='first head\n');
  await page.getByText(/Shared draft ready/).waitFor();
  await page.locator(`[data-version="${old.id}"]`).click();
  await page.waitForFunction(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()==='old conflict input\n');
  await page.getByText(/Shared draft ready/).waitFor();
  assert.deepEqual(versions,[old.head,old.revision]);
  const resolution=page.waitForResponse(r=>r.url().includes('/api/collaboration?')&&r.request().method()==='POST'&&r.request().postDataJSON()?.conflict_id===old.id);
  await page.getByRole('button',{name:`Resolve conflict ${old.id} with editor`}).click();
  assert.equal((await resolution).status(),200);
  const after=await get('/history?'+new URLSearchParams({...Object.fromEntries(query),before:String(boundary)}));
  assert.ok(after.history.find(e=>e.id===old.id).resolved_revision);
  assert.equal(after.unresolved_count,0);
  await page.waitForFunction(id=>{const r=[...document.querySelectorAll('.record')].find(x=>x.querySelector(`[data-version="${id}"]`));return r?.textContent.includes('(resolved)');},old.id,{timeout:10000});
  assert.equal(fs.readFileSync(report,'utf8'),'original\n');
}));

test('fixture publish is not lost when a poll is in flight', {timeout:30000},()=>fixture(async({browser,base,report})=>{
  const page=await browser.newPage();await open(page,base);
  let release,arrived;const gate=new Promise(r=>release=r),started=new Promise(r=>arrived=r);
  const hold=async route=>{if(route.request().method()!=='GET')return route.continue();const response=await route.fetch();arrived();await gate;await route.fulfill({response});};
  await page.route('**/api/collaboration?*',hold);await started;
  const published=page.waitForResponse(r=>r.url().includes('/api/collaboration?')&&r.request().method()==='POST'&&r.request().postDataJSON()?.action==='publish',{timeout:10000});
  await page.getByRole('button',{name:'Publish fixture report'}).click();release();
  const response=await published;assert.equal(response.status(),200);
  await page.waitForResponse(r=>r.url().includes('/api/collaboration?')&&r.request().method()==='GET'&&r.status()===200);
  await page.waitForFunction(()=>{const status=document.querySelector('#report-status')?.textContent||'';return status.includes('Shared draft ready')&&status.includes('Fixture report published');},{},{timeout:6000});
  assert.equal(fs.readFileSync(report,'utf8'),'original\n');
  await page.locator('.CodeMirror textarea').focus();await page.keyboard.insertText(' changed');
  assert.doesNotMatch(await page.locator('#report-status').innerText(),/Fixture report published/);
}));

test('queued fixture publish refuses a changed shared revision', {timeout:30000},()=>fixture(async({browser,base,report})=>{
  const page=await browser.newPage();await open(page,base);
  const root=(await (await page.request.get(base+'/api/data')).json()).root_identity;
  const query=new URLSearchParams({family:'web_bounty',program:'example',lane:'web',path:'example.md',root_identity:root});
  const endpoint=base+'/api/collaboration?'+query;
  const initial=await (await page.request.get(endpoint)).json();
  let release,arrived;const gate=new Promise(r=>release=r),started=new Promise(r=>arrived=r);
  let publishes=0;
  const hold=async route=>{if(route.request().method()!=='GET'){publishes++;return route.continue();}arrived();await gate;await route.continue();};
  await page.route('**/api/collaboration?*',hold);await started;
  await page.getByRole('button',{name:'Publish fixture report'}).click();
  const changed=await page.request.post(endpoint,{headers:{Origin:base,'X-Requested-With':'Bounty-Board'},data:{base:initial.revision,content:'changed by another tab\n',request_id:'other-tab'}});
  assert.equal(changed.status(),200);release();
  await page.getByText(/retry if the shared revision changed/i).waitFor();
  assert.equal(publishes,0);assert.equal(fs.readFileSync(report,'utf8'),'original\n');
}));

test('queued fixture publish refuses a failed shared read', {timeout:30000},()=>fixture(async({browser,base,report})=>{
  const page=await browser.newPage();await open(page,base);
  let release,arrived;const gate=new Promise(r=>release=r),started=new Promise(r=>arrived=r);
  let publishes=0;
  const hold=async route=>{if(route.request().method()!=='GET'){publishes++;return route.continue();}arrived();await gate;await route.abort();};
  await page.route('**/api/collaboration?*',hold);await started;
  await page.getByRole('button',{name:'Publish fixture report'}).click();release();
  await page.getByText(/fixture publication was not attempted/i).waitFor();
  assert.equal(publishes,0);assert.equal(fs.readFileSync(report,'utf8'),'original\n');
}));
