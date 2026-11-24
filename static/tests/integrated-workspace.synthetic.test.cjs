// Integrated workspace end to end: ONE synthetic server with live editing, a
// fake BBH metadata writer, report artifacts and the search index. Walks
// dashboard -> search palette -> open finding -> row menu change class ->
// open report -> live edit autosaves -> outside write appears -> artifacts.
// Disposable root under TMPDIR, loopback only, non-loopback requests aborted.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {chromium}=require('playwright');

const repo=path.resolve(__dirname,'../..');

async function withWorkspace(t,run){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'bb-integrated-'));
  const child=spawn('python3',['-u','tests/integrated_workspace_fixture.py',base],{cwd:repo,env:{...process.env,PYTHONPATH:`${repo}:${repo}/tests`},stdio:['ignore','pipe','inherit']});
  let browser;
  t.after(async()=>{
    if(browser)await browser.close();
    if(child.exitCode===null && child.signalCode===null){const done=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await done;}
    fs.rmSync(base,{recursive:true,force:true});
  });
  const port=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>reject(Error(`fixture exited ${code}`)));child.stdout.once('data',d=>resolve(Number(String(d).trim())));});
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN,args:['--no-sandbox','--disable-dev-shm-usage','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
  const context=await browser.newContext({viewport:{width:1440,height:900}});
  const foreign=[];
  await context.route('**/*',route=>{const host=new URL(route.request().url()).hostname;if(host==='127.0.0.1')return route.continue();foreign.push(host);return route.abort();});
  const page=await context.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error' && !/Failed to load resource/.test(m.text()))errors.push(m.text());});
  const lane=path.join(base,'data/web_bounty/acme-cloud/web');
  const env={page,base,url:`http://127.0.0.1:${port}`,lane,report:path.join(lane,'reports/A101/REPORT.md'),
    ledger:()=>JSON.parse(fs.readFileSync(path.join(lane,'ledgers/ledger.json'),'utf8')).findings,
    calls:()=>fs.existsSync(path.join(base,'writer.log'))?fs.readFileSync(path.join(base,'writer.log'),'utf8').trim().split('\n').filter(Boolean):[]};
  await run(env);
  assert.deepEqual(errors,[],'no page errors');
  assert.deepEqual(foreign,[],'no non-loopback requests');
}
async function waitFor(check,label,timeout=15000){
  const deadline=Date.now()+timeout;
  while(!(await check())){if(Date.now()>deadline)throw Error(`timed out: ${label}`);await new Promise(r=>setTimeout(r,50));}
}
const editorValue=page=>page.evaluate(()=>document.querySelector('#live-report-host .CodeMirror')?.CodeMirror.getValue() ?? null);

test('dashboard to search, row menu class change, report live edit, outside write and artifacts',{timeout:120000},t=>withWorkspace(t,async env=>{
  const {page}=env;
  await page.goto(env.url);
  // Dashboard renders with the redesign shell and exactly one search host.
  await page.getByRole('heading',{name:'Portfolio overview'}).waitFor();
  assert.equal(await page.locator('#global-search-host').count(),1);
  assert.equal(await page.locator('#global-search-field').count(),1);
  await page.locator('.breakdown-row[data-class-name]').first().waitFor();

  // Search palette from the inline field: typing opens it seeded.
  await page.locator('#global-search-field').focus();
  await page.keyboard.type('project description');
  await page.locator('.search-dialog').waitFor();
  await page.locator('.search-results[data-results-for="project description"]').waitFor();
  assert.match(await page.locator('.search-item').first().innerText(),/Stored XSS in project description/);
  await page.keyboard.press('Enter');
  await page.locator('.search-dialog').waitFor({state:'hidden'});
  const row=page.locator('tr[data-finding-id="A101"]');
  await row.waitFor();
  await waitFor(()=>row.evaluate(r=>r.classList.contains('highlight')),'found row highlighted');
  assert.match(page.url(),/#\/programs\/web_bounty%2Facme-cloud\/web\/findings$/);

  // Row menu: one kebab with UI items and ledger actions; change class.
  const kebab=page.getByRole('button',{name:'Actions for Stored XSS in project description'});
  await kebab.click();
  const menu=page.getByRole('menu',{name:'Actions for Stored XSS in project description'});
  await menu.waitFor();
  for(const name of ['Copy finding ID','Change class…','Set submission state…','Move to Gadgets…','Move to MapStore…'])
    assert.equal(await menu.getByRole('menuitem',{name}).count(),1,name);
  await menu.getByRole('menuitem',{name:'Change class…'}).click();
  const dialog=page.getByRole('dialog',{name:/Change class: Stored XSS in project description/});
  await dialog.waitFor();
  await dialog.getByRole('combobox',{name:'Class'}).fill('xss');
  await dialog.getByText('Existing class.').waitFor();
  await dialog.getByRole('button',{name:'Save class'}).click();
  await dialog.getByText('Saved. Class is now xss.').waitFor();
  assert.equal(env.ledger().find(f=>f.fid==='A101').class_name,'xss');
  await dialog.getByRole('button',{name:'Cancel'}).click();
  assert.equal(await page.getByLabel('class for Stored XSS in project description').inputValue(),'xss');
  // A sibling row stays writable after the write (revision rebase).
  await page.getByLabel('severity for CSRF on notification preferences').selectOption('HIGH');
  await waitFor(()=>env.ledger().find(f=>f.fid==='A105').severity==='HIGH','sibling inline edit');
  assert.equal(await page.getByText(/Conflict/).count(),0);

  // Open the report from the row menu (once the lane's reports are indexed).
  await waitFor(async()=>{
    await kebab.click();await menu.waitFor();
    if(await menu.getByRole('menuitem',{name:'Open report'}).count()){await menu.getByRole('menuitem',{name:'Open report'}).click();return true;}
    await page.keyboard.press('Escape');return false;
  },'Open report item');
  await page.locator('#live-report-host .CodeMirror').waitFor();
  assert.match(page.url(),/\/reports\//);
  assert.equal(await editorValue(page),fs.readFileSync(env.report,'utf8'));
  // The EasyMDE toolbar keeps a normal height (old .preview collision).
  const toolbar=await page.locator('#live-report-host .editor-toolbar').boundingBox();
  assert.ok(toolbar.height<60,`toolbar height ${toolbar.height}`);

  // Artifacts panel lists the report's files beside the editor at 1440 px.
  const artifacts=page.locator('#report-artifacts-host');
  await artifacts.locator('[data-artifact="reports/A101/poc/exploit.py"]').waitFor();
  await artifacts.locator('[data-artifact="reports/A101/evidence/screen.png"]').waitFor();
  assert.match(await artifacts.locator('[data-artifact="reports/A101/evidence/request.har"]').innerText(),/Sensitive/);
  const editorBox=await page.locator('#live-report-host').boundingBox(), sideBox=await page.locator('.report-side').boundingBox();
  assert.ok(sideBox.x>editorBox.x+editorBox.width-1,'artifacts sit beside the editor on a wide screen');

  // Live edit autosaves to the synthetic file.
  await page.evaluate(()=>{const cm=document.querySelector('#live-report-host .CodeMirror').CodeMirror;const line=cm.getValue().split('\n').indexOf('Synthetic report used by the integrated workspace test.');cm.focus();cm.setCursor({line,ch:999});});
  await page.keyboard.type(' Edited in the Board.');
  await waitFor(()=>fs.readFileSync(env.report,'utf8').includes('integrated workspace test. Edited in the Board.'),'autosave reached the file');
  await page.locator('[data-live-status]').filter({hasText:'Saved'}).waitFor();

  // An outside write appears in the idle editor with a notice.
  const outside=fs.readFileSync(env.report,'utf8').replace('1. Create a project.','1. Create a project as an agent.');
  fs.writeFileSync(env.report,outside);
  await waitFor(async()=>(await editorValue(page))?.includes('Create a project as an agent.'),'outside write in the editor');
  assert.match(await editorValue(page),/Edited in the Board\./);
  await page.getByText(/Updated outside the Board/).waitFor();

  // Back returns to the findings list through the hash route.
  await page.goBack();
  await page.locator('tr[data-finding-id="A101"]').waitFor();
}));

test('drag onto Gadgets uses the redesign drop target; dashboard class tools',{timeout:90000},t=>withWorkspace(t,async env=>{
  const {page}=env;
  await page.goto(`${env.url}#/programs/${encodeURIComponent('web_bounty/acme-cloud')}/web/findings`);
  const row=page.locator('tr[data-finding-id="A103"]');
  await row.waitFor();
  assert.equal(await row.getAttribute('draggable'),'true');
  const gadgets=page.locator('.workspace-nav [data-drop-target="gadgets"]');
  // Dispatch the drag events by hand to observe the hover state.
  const dt=await page.evaluateHandle(()=>new DataTransfer());
  await row.locator('td').first().dispatchEvent('dragstart',{dataTransfer:dt});
  assert.equal(await page.evaluate(()=>document.body.classList.contains('dragging-finding')),true);
  await gadgets.dispatchEvent('dragover',{dataTransfer:dt});
  assert.equal(await gadgets.evaluate(el=>el.classList.contains('drop-active')),true);
  await gadgets.dispatchEvent('drop',{dataTransfer:dt});
  const dialog=page.getByRole('dialog',{name:/Move to Gadgets: Open redirect on logout continuation/});
  await dialog.waitFor();
  assert.equal(await page.evaluate(()=>document.body.classList.contains('dragging-finding')),false);
  assert.equal(await page.locator('.drop-active').count(),0);
  await dialog.locator('#ledger-move-preview').getByText('MapStore entry tagged gadget (shown under Gadgets)').waitFor();
  await dialog.getByRole('button',{name:'Close'}).click();
  assert.deepEqual(env.calls().filter(c=>!c.includes('--help')),[],'opening the preview writes nothing');
  // Dashboard: category toggle and bulk reclassify live in the class breakdown.
  await page.getByRole('button',{name:'Dashboard',exact:true}).click();
  await page.locator('.breakdown-row[data-class-name="xss"]').click();
  await page.getByRole('button',{name:'Review and reclassify xss findings'}).waitFor();
  await page.getByRole('button',{name:'By category',exact:true}).click();
  await page.locator('[data-category-row="xss"]').waitFor();
  await page.getByRole('button',{name:'By class',exact:true}).click();
  await page.locator('.breakdown-row[data-class-name]').first().waitFor();
}));
