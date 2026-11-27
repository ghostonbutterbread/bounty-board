require('./isolate-home.cjs'); // Standalone runs must not use the operator's HOME.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {chromium}=require('playwright');

async function fixture(run) {
  const tmp=fs.mkdtempSync(path.join(process.env.TMPDIR,'board-recovery-'));
  const root=path.join(tmp,'root'), report=path.join(root,'web_bounty/example/web/reports/example.md');
  fs.mkdirSync(path.dirname(report),{recursive:true});fs.writeFileSync(report,'original\n');
  const proc=spawn('python3',['-B','-u','-c',"import sys,app; s=app.make_server(sys.argv[1],0,collaboration_dir=sys.argv[2]); print(s.server_port,flush=True); s.serve_forever()",root,path.join(tmp,'private')],{cwd:path.resolve(__dirname,'../..'),env:process.env,stdio:['ignore','pipe','pipe']});
  let browser;
  try {
    const [chunk]=await once(proc.stdout,'data'); const base='http://127.0.0.1:'+Number(chunk.toString().trim());
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',args:['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    await run({browser,base});
  } finally {if(browser)await browser.close();if(proc.exitCode===null&&proc.signalCode===null){const done=once(proc,'exit');proc.kill();await done;}fs.rmSync(tmp,{recursive:true,force:true});}
}
async function open(page,base) {page.setDefaultTimeout(6000);await page.goto(base);await page.getByRole('link',{name:'Programs',exact:true}).click();await page.getByRole('link',{name:'Reports',exact:true}).click();await page.getByText(/Shared draft ready/).waitFor();}
async function edit(page,text){await page.locator('.CodeMirror textarea').focus();await page.keyboard.press('Control+A');await page.keyboard.insertText(text);}
async function reports(page){await page.getByRole('link',{name:'Programs',exact:true}).click();await page.getByRole('link',{name:'Reports',exact:true}).click();await page.locator('.CodeMirror').waitFor();}

test('lost acknowledged request is replayed exactly after reload before newer edits', {timeout:30000},()=>fixture(async({browser,base})=>{
  const page=await browser.newPage();await open(page,base);
  let first,notify;const committed=new Promise(r=>notify=r);
  const intercept=async route=>{if(route.request().method()!=='POST')return route.continue();first=route.request().postDataJSON();await route.fetch();notify();await route.abort();};
  await page.route('**/api/collaboration?*',intercept);await edit(page,'first pending');await committed;await page.getByText(/Shared save failed/).waitFor();
  await edit(page,'newer edit');
  await page.unroute('**/api/collaboration?*',intercept);
  const replay=[];await page.route('**/api/collaboration?*',route=>{if(route.request().method()==='POST')replay.push(route.request().postDataJSON());return route.continue();});
  await page.reload();await reports(page);await page.waitForFunction(()=>document.querySelector('#report-status')?.textContent.includes('Shared draft ready'),null,{timeout:12000});
  assert.deepEqual(replay[0],first,'first request after reload must exactly replay the committed request');
  const other=await browser.newPage();await open(other,base);assert.equal(await other.evaluate(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()),'newer edit');
}));


test('inherited window name starts an independent recoverable draft namespace', {timeout:30000},()=>fixture(async({browser,base})=>{
  const context=await browser.newContext();const a=await context.newPage();await open(a,base);
  const inherited=await a.evaluate(()=>window.name);
  const b=await context.newPage();await b.addInitScript(name=>{if(performance.getEntriesByType('navigation')[0]?.type!=='reload')window.name=name;},inherited);await open(b,base);
  const block=route=>route.request().method()==='POST'?route.abort():route.continue();
  await a.route('**/api/collaboration?*',block);await b.route('**/api/collaboration?*',block);
  await edit(a,'first tab');await edit(b,'second tab');
  const saved=await a.evaluate(()=>Object.entries(localStorage).filter(([k])=>k.startsWith('bounty-board-report-draft-v2:')).map(([,v])=>JSON.parse(v).text));
  assert.ok(saved.includes('first tab') && saved.includes('second tab'),'both inherited tabs must persist distinct drafts');
  await a.reload();await reports(a);assert.equal(await a.evaluate(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()),'first tab');
  await b.reload();await reports(b);assert.equal(await b.evaluate(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()),'second tab');
}));


test('offline saves stop after bounded attempts and manual retry retains draft', {timeout:30000},()=>fixture(async({browser,base})=>{
  const page=await browser.newPage();await open(page,base);let attempts=0;
  const block=route=>{if(route.request().method()==='POST'){attempts++;return route.abort();}return route.continue();};
  await page.route('**/api/collaboration?*',block);await edit(page,'offline draft');
  await page.getByRole('button',{name:'Retry shared save'}).waitFor({timeout:12000});
  const stopped=attempts;assert.equal(stopped,3);await page.waitForTimeout(2500);assert.equal(attempts,stopped);
  assert.equal(await page.evaluate(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()),'offline draft');
  await edit(page,'newer offline draft');assert.match(await page.locator('#report-status').innerText(),/retry shared save/i);assert.equal(attempts,stopped);
  await page.unroute('**/api/collaboration?*',block);await page.getByRole('button',{name:'Retry shared save'}).click();await page.getByText(/Shared draft ready/).waitFor();
  const other=await browser.newPage();await open(other,base);assert.equal(await other.evaluate(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()),'newer offline draft');
}));


test('bounded metadata history pages old unresolved conflicts and fetches versions on demand', {timeout:30000},()=>fixture(async({browser,base})=>{
  const page=await browser.newPage();const versions=[];const calls=[];
  const hash=i=>require('node:crypto').createHash('sha256').update(String(i)).digest('hex');
  const rows=Array.from({length:51},(_,i)=>({id:51-i,kind:i===50?'client:conflict':i===49?'client:edge':'client:edited',revision:hash('input-'+(51-i)),base:hash('base'),head:hash('head-'+(51-i)),resolved_revision:null}));
  await page.route('**/api/collaboration**',async route=>{
    const req=route.request(),url=new URL(req.url());
    if(req.method()!=='GET')return route.continue();
    calls.push(url.pathname);
    if(url.pathname.endsWith('/history'))return route.fulfill({json:{history:rows.slice(50),next_before:null,unresolved_count:1}});
    if(url.pathname.endsWith('/version')){versions.push(url.searchParams.get('revision'));return route.fulfill({json:{revision:url.searchParams.get('revision'),content:'older selected content'}});}
    const response=await route.fetch(), body=await response.json();body.history=rows.slice(0,50);body.unresolved_count=1;body.next_before=2;
    return route.fulfill({response,json:body});
  });
  await open(page,base);assert.equal(versions.length,0);await page.getByText('Shared history and conflicts').click();
  await page.getByRole('button',{name:'Load older history'}).click();
  await page.getByRole('button',{name:'Resolve conflict 1 with editor'}).waitFor();
  rows.unshift({id:52,kind:'client:new',revision:hash('input-52'),base:hash('base'),head:hash('head-52'),resolved_revision:null});
  await page.getByText('client:new',{exact:true}).waitFor();
  assert.equal(await page.getByText('client:edge',{exact:true}).count(),1,'the moving recent page must not create a gap above older pages');
  assert.equal(versions.length,0);
  await page.locator('.record').filter({hasText:'client:conflict'}).getByRole('button',{name:'Preview this version'}).click();
  await page.getByRole('button',{name:'Confirm restore version'}).click();
  await page.waitForFunction(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()==='older selected content');
  assert.deepEqual(versions,[hash('input-1')]);assert.ok(calls.includes('/api/collaboration/history'));
}));


test('another client resolves a conflict without stranding the original editor', {timeout:35000},()=>fixture(async({browser,base})=>{
  const a=await browser.newPage(),b=await browser.newPage();await Promise.all([open(a,base),open(b,base)]);
  let release,arrive;const held=new Promise(r=>release=r),started=new Promise(r=>arrive=r);
  const hold=async route=>{if(route.request().method()==='POST'){arrive();await held;}await route.continue();};
  await b.route('**/api/collaboration?*',hold);await edit(b,'B version');await started;
  await edit(a,'A version');await a.getByText(/Shared draft ready/).waitFor();release();await b.getByText(/^Conflict:/).waitFor();await b.unroute('**/api/collaboration?*',hold);
  await a.getByText('Shared history and conflicts').click();
  const resolve=a.getByRole('button',{name:/Resolve conflict [0-9]+ with editor/});await resolve.waitFor();await resolve.click();await a.getByText(/Shared draft ready/).waitFor();
  await b.getByRole('button',{name:'Submit editor as resolution'}).click();
  await b.getByRole('button',{name:'Retry as a new edit'}).waitFor();
  assert.equal(await b.evaluate(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()),'B version');
  await b.getByRole('button',{name:'Retry as a new edit'}).click();
  await b.getByText(/^Conflict:/).waitFor();
  assert.equal(await b.evaluate(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()),'B version');
}));


test('initial offline polling backs off and offers manual retry', {timeout:30000},()=>fixture(async({browser,base})=>{
  const page=await browser.newPage();page.setDefaultTimeout(6000);let attempts=0;
  const block=route=>{if(route.request().method()==='GET'){attempts++;return route.abort();}return route.continue();};
  await page.route('**/api/collaboration?*',block);await page.goto(base);await reports(page);
  await page.getByRole('button',{name:'Retry shared save'}).waitFor({timeout:12000});const count=attempts;assert.equal(count,3);
  await page.waitForTimeout(2500);assert.equal(attempts,count);
  await page.unroute('**/api/collaboration?*',block);await page.getByRole('button',{name:'Retry shared save'}).click();await page.getByText(/Shared draft ready/).waitFor();
}));


test('cloned reload state cannot claim a live tab namespace', {timeout:30000},()=>fixture(async({browser,base})=>{
  const context=await browser.newContext(),a=await context.newPage();await open(a,base);
  const inherited=await a.evaluate(()=>window.name);const b=await context.newPage();
  await b.addInitScript(name=>{window.name=name;const get=performance.getEntriesByType.bind(performance);performance.getEntriesByType=type=>type==='navigation'?[{type:'reload'}]:get(type);},inherited);await open(b,base);
  const block=route=>route.request().method()==='POST'?route.abort():route.continue();await a.route('**/api/collaboration?*',block);await b.route('**/api/collaboration?*',block);
  await edit(a,'original live');await edit(b,'clone live');
  const saved=await a.evaluate(()=>Object.entries(localStorage).filter(([k])=>k.startsWith('bounty-board-report-draft-v2:')).map(([,v])=>JSON.parse(v).text));
  assert.ok(saved.includes('original live')&&saved.includes('clone live'));
}));
