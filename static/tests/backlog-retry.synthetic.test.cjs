require('./isolate-home.cjs'); // Standalone runs must not use the operator's HOME.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {chromium}=require('playwright');

async function fixture(run){
  const tmp=fs.mkdtempSync(path.join(process.env.TMPDIR,'retry-'));
  const root=path.join(tmp,'root'),report=path.join(root,'web_bounty/example/web/reports/report.md');
  fs.mkdirSync(path.dirname(report),{recursive:true});fs.writeFileSync(report,'original\n');
  const proc=spawn('python3',['-B','-u','-c',"import sys,app; s=app.make_server(sys.argv[1],0,collaboration_dir=sys.argv[2],report_autosave=True); print(s.server_port,flush=True); s.serve_forever()",root,path.join(tmp,'private')],{cwd:path.resolve(__dirname,'../..'),env:process.env,stdio:['ignore','pipe','ignore']});
  let browser;
  try {
    const [chunk]=await once(proc.stdout,'data');const base=`http://127.0.0.1:${Number(String(chunk).trim())}`;
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',args:['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    const page=await browser.newPage();page.setDefaultTimeout(8000);await page.goto(base);
    await page.getByRole('link',{name:'Programs',exact:true}).click();await page.getByRole('link',{name:'Reports',exact:true}).click();await page.getByText(/Shared draft ready/).waitFor();
    await run({page,report});
  } finally {if(browser)await browser.close();if(proc.exitCode===null&&proc.signalCode===null){const done=once(proc,'exit');proc.kill();await done;}fs.rmSync(tmp,{recursive:true,force:true});}
}
async function edit(page,text){await page.locator('.CodeMirror textarea').focus();await page.keyboard.press('Control+A');await page.keyboard.insertText(text);}
async function stored(page){return page.evaluate(()=>Object.values(localStorage).map(v=>{try{return JSON.parse(v)}catch{return null}}).find(v=>v?.pendingShared));}

test('injected repeated backlog is bounded and retains original request and later text', {timeout:30000},()=>fixture(async({page,report})=>{
  const posts=[];
  await page.route('**/api/collaboration?*',route=>{
    if(route.request().method()!=='POST')return route.continue();
    posts.push(route.request().postDataJSON());return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'retained_scan_backlog'})});
  });
  await edit(page,'first\n');await page.getByText(/Retrying the exact request/).waitFor();await edit(page,'newer\n');
  await page.getByText(/Automatic retries exhausted/).waitFor({timeout:12000});
  assert.equal(posts.length,4);for(const post of posts)assert.deepEqual(post,posts[0]);
  await page.waitForTimeout(2200);assert.equal(posts.length,4);
  const draft=await stored(page);assert.deepEqual(draft.pendingShared,posts[0]);assert.equal(draft.text,'newer\n');
  assert.equal(fs.readFileSync(report,'utf8'),'original\n');assert.doesNotMatch(await page.locator('#report-status').innerText(),/Markdown file saved/);
  await page.getByRole('button',{name:'Inspect original save'}).waitFor();
}));

test('manual inspection cancels a scheduled automatic backlog retry', {timeout:15000},()=>fixture(async({page})=>{
  const posts=[];
  await page.route('**/api/collaboration?*',route=>{
    if(route.request().method()!=='POST')return route.continue();posts.push(route.request().postDataJSON());
    return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'retained_scan_backlog'})});
  });
  await edit(page,'first\n');await page.getByText(/Retrying the exact request/).waitFor();
  await page.getByRole('button',{name:'Inspect original save'}).click();await page.getByRole('button',{name:'Retry exact original request'}).waitFor();
  await page.waitForTimeout(1600);assert.equal(posts.length,1);assert.deepEqual((await stored(page)).pendingShared,posts[0]);
}));

test('inspection during a held poll cancels the backlog retry and inspects the original', {timeout:20000},()=>fixture(async({page,report})=>{
  const posts=[];let release,arrive;const gate=new Promise(r=>release=r),started=new Promise(r=>arrive=r);let held=false;
  await page.evaluate(()=>{const original=window.setTimeout;window.setTimeout=function(fn,delay,...args){if(delay===500 && String(fn).includes('draft.pendingShared!==pending'))delay=4000;return original(fn,delay,...args);};});
  await page.route('**/api/collaboration?*',async route=>{
    if(route.request().method()==='POST'){posts.push(route.request().postDataJSON());return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'retained_scan_backlog'})});}
    if(!posts.length || held)return route.continue();held=true;arrive();await gate;return route.continue();
  });
  try {
    await edit(page,'first\n');await page.getByText(/Retrying the exact request/).waitFor();await started;
    await page.getByRole('button',{name:'Inspect original save'}).click();
    await page.waitForTimeout(4500);assert.equal(posts.length,1,'inspection must cancel retry even while poll is held');
  } finally {release();}
  await page.waitForTimeout(1500);
  assert.equal(posts.length,1,'inspection must prevent a POST after the poll releases');
  assert.equal(await page.getByRole('button',{name:'Retry exact original request'}).count(),1,'deferred inspection must complete');
  assert.deepEqual((await stored(page)).pendingShared,posts[0]);assert.equal(fs.readFileSync(report,'utf8'),'original\n');
  await page.getByRole('button',{name:'Retry exact original request'}).click();
  await page.waitForTimeout(300);assert.equal(posts.length,2);assert.deepEqual(posts[1],posts[0]);
}));

test('a lost acknowledgement after a backlog retry stops automatic replay', {timeout:20000},()=>fixture(async({page,report})=>{
  const posts=[];
  await page.route('**/api/collaboration?*',async route=>{
    if(route.request().method()!=='POST')return route.continue();
    posts.push(route.request().postDataJSON());
    if(posts.length===1)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'retained_scan_backlog'})});
    if(posts.length===2){await route.fetch();return route.abort();}
    return route.continue();
  });
  await edit(page,'first\n');await page.getByText(/Save outcome unconfirmed/).waitFor({timeout:8000});
  await edit(page,'newer\n');await page.waitForTimeout(2200);
  assert.equal(posts.length,2);assert.deepEqual(posts[1],posts[0]);assert.equal(fs.readFileSync(report,'utf8'),'first\n');
  const draft=await stored(page);assert.deepEqual(draft.pendingShared,posts[0]);assert.equal(draft.text,'newer\n');
  await page.getByRole('button',{name:'Inspect original save'}).waitFor();assert.doesNotMatch(await page.locator('#report-status').innerText(),/Markdown file saved/);
}));

for(const [status,code] of [[503,'retained_reconciliation_unavailable'],[409,'retained_scan_backlog']]){
  test(`injected ${status} ${code} remains an unconfirmed outcome`, {timeout:20000},()=>fixture(async({page,report})=>{
    const posts=[];
    await page.route('**/api/collaboration?*',route=>{
      if(route.request().method()!=='POST')return route.continue();posts.push(route.request().postDataJSON());
      return route.fulfill({status,contentType:'application/json',body:JSON.stringify({error:code})});
    });
    await edit(page,'first\n');await page.getByText(/Save outcome unconfirmed/).waitFor();await edit(page,'newer\n');
    await page.waitForTimeout(2200);assert.equal(posts.length,1);
    const draft=await stored(page);assert.deepEqual(draft.pendingShared,posts[0]);assert.equal(draft.text,'newer\n');
    assert.equal(fs.readFileSync(report,'utf8'),'original\n');await page.getByRole('button',{name:'Inspect original save'}).waitFor();
  }));
}
