const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {chromium}=require('playwright');

async function fixture(program,run){
  const tmp=fs.mkdtempSync(path.join(process.env.TMPDIR,'rb-'));
  const root=path.join(tmp,'root'), report=path.join(root,'web_bounty',program,'web/reports/nested/report.md');
  fs.mkdirSync(path.dirname(report),{recursive:true});fs.writeFileSync(report,'source\n');
  const proc=spawn('python3',['-B','-u','-c',"import sys,app; s=app.make_server(sys.argv[1],0,collaboration_dir=sys.argv[2]); print(s.server_port,flush=True); s.serve_forever()",root,path.join(tmp,'private')],{cwd:path.resolve(__dirname,'../..'),env:process.env,stdio:['ignore','pipe','pipe']});proc.stderr.resume();
  let browser;
  try {const [out]=await once(proc.stdout,'data');const base='http://127.0.0.1:'+Number(out.toString().trim());
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',args:['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    await run({browser,base,report,root});
  } finally {if(browser)await browser.close();if(proc.exitCode===null&&proc.signalCode===null){const done=once(proc,'exit');proc.kill();await done;}fs.rmSync(tmp,{recursive:true,force:true});}
}
async function open(page,base){page.setDefaultTimeout(7000);await page.goto(base);await page.getByRole('button',{name:'Programs',exact:true}).click();await page.getByRole('button',{name:'Reports',exact:true}).click();}

test('missing source: path-scoped local and pending recovery stays durable without posting', {timeout:60000},()=>fixture('example',async({browser,base,report})=>{
  const context=await browser.newContext(),source=await context.newPage();await open(source,base);await source.getByText(/Shared draft ready/).waitFor();
  await source.route('**/api/collaboration?*',r=>r.request().method()==='POST'?r.abort():r.continue());
  await source.locator('.CodeMirror textarea').focus();await source.keyboard.press('Control+A');await source.keyboard.insertText('unsent local');await source.getByText(/Shared save failed/).waitFor();
  const entry=await source.evaluate(()=>Object.entries(localStorage).find(([k,v])=>k.startsWith('bounty-board-report-draft-v2:')&&JSON.parse(v).text==='unsent local'));
  assert.ok(JSON.parse(entry[1]).pendingShared);await source.close();fs.renameSync(report,report+'.gone');
  const page=await context.newPage(),posts=[];await page.route('**/api/collaboration?*',r=>{if(r.request().method()==='POST')posts.push(r.request().postData());return r.continue();});await open(page,base);
  await page.getByLabel('Original report path').fill('nested/report.md');await page.getByRole('button',{name:'Find saved local drafts'}).click();
  const card=page.locator('[data-local-recovery] [data-recovery-candidate]').filter({hasText:'unsent local'});
  assert.equal(await card.getByLabel('Saved draft (select and copy if recovery is unavailable)').inputValue(),'unsent local');
  assert.deepEqual(JSON.parse(await card.getByLabel('Pending request (copy for manual recovery if needed)').inputValue()),JSON.parse(entry[1]).pendingShared);
  await card.getByRole('button',{name:'Recover this draft'}).click();await card.getByText(/Recovered into this tab/).waitFor();
  assert.equal(await page.evaluate(([k,v])=>localStorage.getItem(k)===v,entry),true);assert.deepEqual(posts,[]);
  const dest=await page.evaluate(()=>Object.entries(localStorage).filter(([k,v])=>k.startsWith('bounty-board-report-draft-v2:')&&JSON.parse(v).text==='unsent local'));
  assert.equal(dest.length,2);assert.deepEqual(JSON.parse(dest.find(([k])=>k!==entry[0])[1]).pendingShared,JSON.parse(entry[1]).pendingShared);
  await page.getByLabel('Original report path').fill('other.md');await page.getByRole('button',{name:'Find saved local drafts'}).click();assert.equal(await page.locator('[data-local-recovery] [data-recovery-candidate]').count(),0);
  fs.renameSync(report+'.gone',report);await page.locator('#refresh').click();
  await page.locator('.CodeMirror').waitFor();await page.waitForFunction(()=>document.querySelector('#report-status')?.textContent.includes('Shared draft ready'),null,{timeout:12000});
  assert.deepEqual(JSON.parse(posts[0]),JSON.parse(entry[1]).pendingShared);
  assert.equal(fs.readFileSync(report,'utf8'),'source\n');
}));

test('pre-opt-in unsuffixed v2 drafts appear as copy-only including old shape', {timeout:60000},()=>fixture('example',async({browser,base})=>{
  const context=await browser.newContext(),page=await context.newPage();await open(page,base);await page.getByText(/Shared draft ready/).waitFor();
  const key=await page.evaluate(async()=>{const root=(await (await fetch('/api/data')).json()).root_identity;const key='bounty-board-report-draft-v2:'+JSON.stringify([root,'web_bounty/example','web','nested/report.md']);localStorage.setItem(key,JSON.stringify({version:1,text:'legacy text',original:'source\n',revision:null}));return key;});
  const before=await page.evaluate(k=>localStorage.getItem(k),key),posts=[];await page.route('**/api/collaboration?*',r=>{if(r.request().method()==='POST')posts.push(r.request().postData());return r.continue();});
  await page.getByRole('button',{name:'Find saved drafts'}).click();const card=page.locator('#orphan-drafts [data-recovery-candidate]').filter({hasText:'legacy text'});
  assert.equal(await card.getByLabel('Saved draft (select and copy if recovery is unavailable)').inputValue(),'legacy text');
  await card.getByRole('button',{name:'Recover this draft'}).click();await card.getByRole('status').getByText(/no provable tab ownership/i).waitFor();
  assert.equal(await page.evaluate(k=>localStorage.getItem(k),key),before);assert.deepEqual(posts,[]);
}));

test('manual missing-source lookup cannot recover a live tab record', {timeout:60000},()=>fixture('example',async({browser,base,report})=>{
  const context=await browser.newContext(),live=await context.newPage();await open(live,base);await live.getByText(/Shared draft ready/).waitFor();
  await live.route('**/api/collaboration?*',r=>r.request().method()==='POST'?r.abort():r.continue());
  await live.locator('.CodeMirror textarea').focus();await live.keyboard.press('Control+A');await live.keyboard.insertText('live unsent');await live.getByText(/Shared save failed/).waitFor();
  const entry=await live.evaluate(()=>Object.entries(localStorage).find(([k,v])=>k.startsWith('bounty-board-report-draft-v2:')&&JSON.parse(v).text==='live unsent'));
  fs.renameSync(report,report+'.gone');const page=await context.newPage();await open(page,base);
  await page.getByLabel('Original report path').fill('nested/report.md');await page.getByRole('button',{name:'Find saved local drafts'}).click();
  const card=page.locator('[data-local-recovery] [data-recovery-candidate]').filter({hasText:'live unsent'});
  await card.getByRole('button',{name:'Recover this draft'}).click();await card.getByText(/belongs to a live tab/).waitFor();
  assert.equal(await live.evaluate(([k,v])=>localStorage.getItem(k)===v,entry),true);
  assert.equal(await live.evaluate(()=>document.querySelector('.CodeMirror').CodeMirror.getValue()),'live unsent');
}));

test('discovered Unicode and spaced program binds collaborative editor and shared history exactly', {timeout:60000},()=>fixture('Acme\u2003Café',async({browser,base,report})=>{
  const context=await browser.newContext(),page=await context.newPage();await open(page,base);await page.getByText(/Shared draft ready/).waitFor();
  const saved=page.waitForResponse(r=>r.url().includes('/api/collaboration?')&&r.request().method()==='POST'&&r.status()===200);
  await page.locator('.CodeMirror textarea').focus();await page.keyboard.press('Control+A');await page.keyboard.insertText('saved shared');await saved;
  await page.getByText('Shared history and conflicts').click();await page.getByText('client:saved').waitFor();assert.equal(fs.readFileSync(report,'utf8'),'source\n');
}));
