// Ledger actions in real Chromium against a synthetic root and a fake BBH writer.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {chromium}=require('playwright');

const repo=path.resolve(__dirname,'../..');
const shots=process.env.LEDGER_SCREENSHOTS || '';

async function withBoard(mode,run){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'ledger-actions-'));
  const child=spawn('python3',['-u','tests/ledger_actions_browser_fixture.py',base,mode],{cwd:repo,env:{...process.env,PYTHONPATH:`${repo}:${repo}/tests`},stdio:['ignore','pipe','inherit']});
  let browser;
  try {
    const port=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>reject(Error(`fixture exited ${code}`)));child.stdout.once('data',d=>resolve(Number(String(d).trim())));});
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN,args:['--no-sandbox','--disable-dev-shm-usage','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    const context=await browser.newContext({viewport:{width:1360,height:900}});
    await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1' ? route.continue() : route.abort());
    const page=await context.newPage();page.setDefaultTimeout(10000);
    const errors=[];page.on('pageerror',e=>errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${port}`);
    const ledger=name=>JSON.parse(fs.readFileSync(path.join(base,'data/web_bounty',name,'web/ledgers/ledger.json'),'utf8')).findings;
    const mapEntries=name=>fs.readFileSync(path.join(base,'data/web_bounty',name,'web/recon/maps/map.jsonl'),'utf8').split('\n').filter(Boolean).map(JSON.parse);
    const calls=()=>fs.existsSync(path.join(base,'writer.log')) ? fs.readFileSync(path.join(base,'writer.log'),'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
    await run({page,ledger,mapEntries,calls,base});
    assert.deepEqual(errors,[]);
    assert.equal(await page.evaluate(()=>window.__ledger_xss),undefined);
  } finally {
    if(browser)await browser.close();
    child.kill('SIGTERM');await new Promise(r=>child.exitCode!==null||child.signalCode!==null?r():child.once('exit',r));
    fs.rmSync(base,{recursive:true,force:true});
  }
}
const openAlpha=async page=>{await page.getByRole('button',{name:'Programs',exact:true}).click();await page.locator('#program-select').selectOption('web_bounty/alpha');await page.locator('tr[data-finding-id]').first().waitFor();};
const order=page=>page.locator('tbody tr[data-finding-id]').evaluateAll(rows=>rows.map(r=>r.dataset.findingId));
const snap=async(page,name)=>{if(shots){fs.mkdirSync(shots,{recursive:true});await page.screenshot({path:path.join(shots,name)});}};

// Integrated UI: one sort system (Sort menu + header buttons) and the first
// seen filter in the redesign's multi-select filter bar.
const sortBy=async(page,label)=>{await page.getByRole('button',{name:/^Sort findings/}).click();await page.getByRole('menuitemradio',{name:label}).click();};
const pickFilter=async(page,plural,values)=>{await page.getByRole('button',{name:`Filter ${plural}`,exact:true}).click();for(const v of values)await page.getByRole('checkbox',{name:v}).check();await page.keyboard.press('Escape');};
test('sorts by severity and date, filters by date, labels severities',{timeout:60000},()=>withBoard('writer',async({page})=>{
  await openAlpha(page);
  assert.deepEqual(await order(page),['D01','D02','D03','D04','D05']);
  await sortBy(page,'Severity, highest first');
  assert.deepEqual(await order(page),['D02','D05','D01','D03','D04']);
  assert.equal(await page.evaluate(()=>document.activeElement.hasAttribute('data-sort-menu')),true,'focus returns to the Sort button');
  await sortBy(page,'Severity, lowest first');
  assert.deepEqual(await order(page),['D04','D03','D01','D05','D02']);
  await sortBy(page,'First seen, newest first');
  assert.deepEqual(await order(page),['D02','D05','D03','D01','D04']);
  await sortBy(page,'First seen, oldest first');
  assert.deepEqual(await order(page),['D01','D03','D05','D02','D04']);
  await sortBy(page,'Last seen, newest first');
  assert.deepEqual(await order(page),['D02','D01','D05','D03','D04']);
  // The First seen header button is the same sort: newest first on the first click.
  await page.locator('[data-sort="first_seen"]').click();
  assert.deepEqual(await order(page),['D02','D05','D03','D01','D04']);
  assert.equal(await page.locator('th[aria-sort="descending"] [data-sort="first_seen"]').count(),1);
  await page.locator('[data-sort="first_seen"]').click();
  assert.deepEqual(await order(page),['D01','D03','D05','D02','D04'],'missing dates stay last');
  // Disjoint first-seen buckets: the last 30 days is two buckets.
  await pickFilter(page,'first seen dates',['Last 7 days','8 to 30 days']);
  assert.deepEqual(await order(page),['D05','D02']);
  await page.getByText('2 of 5').waitFor();
  await page.getByRole('button',{name:'Clear all'}).click();
  await pickFilter(page,'first seen dates',['No date recorded']);
  assert.deepEqual(await order(page),['D04']);
  await page.getByRole('button',{name:'Clear all'}).click();
  await pickFilter(page,'first seen dates',['Older than 90 days']);
  assert.deepEqual(await order(page),['D01']);
  // Existing severity filter composes with the date filter and the sort.
  await page.getByRole('button',{name:'Clear all'}).click();
  await pickFilter(page,'severities',['INFO']);
  assert.deepEqual(await order(page),['D03']);
  await page.getByRole('button',{name:'Clear all'}).click();
  const labels=await page.getByLabel('severity for Alpha critical').locator('option').evaluateAll(o=>o.map(x=>[x.value,x.textContent,x.disabled]));
  assert.deepEqual(labels.find(([v])=>v==='INFO'),['INFO','Informational (INFO)',false]);
  assert.deepEqual(labels.find(([v])=>v==='N/A'),['N/A','N/A (not supported by BBH yet)',true]);
  assert.match(await page.locator('tr[data-finding-id="D02"] td.date').innerText(),/^\d{4}-\d{2}-\d{2}\s+Last seen \d{4}-\d{2}-\d{2}$/);
  const ranks=await page.evaluate(()=>['exceptional','Critical','informational','na','N/A','none','bogus',''].map(window.BoardLedgerActions.severityKey));
  assert.deepEqual(ranks,['EXCEPTIONAL','CRITICAL','INFO','N/A','N/A','N/A','UNKNOWN','UNKNOWN']);
  // Sort choice persists like the header sort.
  await page.reload();await page.locator('tr[data-finding-id]').first().waitFor();
  assert.match(await page.getByRole('button',{name:/^Sort findings/}).innerText(),/First seen, oldest first/);
}));

test('row menu by keyboard, searchable class picker and submission state',{timeout:60000},()=>withBoard('writer',async({page,ledger,calls})=>{
  await openAlpha(page);
  const actions=page.getByRole('button',{name:'Actions for Alpha critical'});
  await actions.click();
  const menu=page.getByRole('menu',{name:'Actions for Alpha critical'});
  // One menu: the UI items and the ledger actions together.
  await menu.waitFor();assert.equal(await actions.getAttribute('aria-expanded'),'true');
  assert.deepEqual(await menu.getByRole('menuitem').evaluateAll(items=>items.map(i=>i.textContent)),['Copy finding ID','Change class…','Set submission state…','Move to Gadgets…','Move to MapStore…','Show only severity CRITICAL','Show only class idor','Show only status confirmed']);
  assert.equal(await page.evaluate(()=>document.activeElement.textContent),'Copy finding ID');
  await page.keyboard.press('c');assert.equal(await page.evaluate(()=>document.activeElement.textContent),'Change class…');
  await page.keyboard.press('ArrowDown');assert.equal(await page.evaluate(()=>document.activeElement.textContent),'Set submission state…');
  await page.keyboard.press('End');assert.equal(await page.evaluate(()=>document.activeElement.textContent),'Show only status confirmed');
  await snap(page,'row-menu.png');
  await page.keyboard.press('Escape');await menu.waitFor({state:'detached'});
  assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),'Actions for Alpha critical');
  // Class picker
  await actions.click();await page.getByRole('menuitem',{name:'Change class…'}).click();
  const dialog=page.getByRole('dialog',{name:/Change class: Alpha critical/});await dialog.waitFor();
  const combo=dialog.getByRole('combobox',{name:'Class'});
  assert.equal(await combo.inputValue(),'idor');
  await combo.fill('s');
  const options=dialog.getByRole('option');
  assert.deepEqual(await options.evaluateAll(o=>o.map(x=>x.dataset.value)),['ssrf','xss']);
  await combo.fill('i');
  assert.deepEqual(await options.evaluateAll(o=>o.map(x=>x.dataset.value)),['idor','info-leak']);
  await combo.fill('xs');await page.keyboard.press('ArrowDown');
  assert.equal(await combo.getAttribute('aria-activedescendant'),'ledger-class-input-opt-0');
  await snap(page,'class-picker.png');
  await page.keyboard.press('Enter');assert.equal(await combo.inputValue(),'xss');
  await dialog.getByText('Existing class.').waitFor();
  await combo.fill('Bad Class');await dialog.getByText(/Use lowercase letters/).waitFor();
  assert.equal(await dialog.getByRole('button',{name:'Save class'}).isDisabled(),true);
  await combo.fill('xss');
  await dialog.getByRole('button',{name:'Save class'}).click();
  await dialog.getByText('Saved. Class is now xss.').waitFor();
  assert.equal(ledger('alpha').find(f=>f.fid==='D02').class_name,'xss');
  await dialog.getByRole('button',{name:'Cancel'}).click();
  assert.equal(await page.getByLabel('class for Alpha critical').inputValue(),'xss');
  // Submission state
  await actions.click();await page.getByRole('menuitem',{name:'Set submission state…'}).click();
  const sub=page.getByRole('dialog',{name:/Submission state: Alpha critical/});await sub.waitFor();
  await sub.getByText('This records local state in the ledger only. It does not submit or send anything to a platform.').waitFor();
  const record=sub.getByRole('button',{name:'Record state'});
  await sub.getByLabel('Submission state').selectOption('submitted');
  await sub.getByLabel('Platform result').selectOption('duplicate');
  await sub.getByLabel('Report reference').fill('R-1');
  assert.equal(await record.isDisabled(),true,'confirmation is required');
  const before=calls().length;
  await sub.getByLabel('I understand this only records local state.').check();
  await record.click();
  await sub.getByText(/Recorded locally: Submitted, result duplicate\. Nothing was sent to a platform\./).waitFor();
  assert.deepEqual(ledger('alpha').find(f=>f.fid==='D02').submission,{state:'submitted',result:'duplicate',report:'R-1'});
  const call=calls().at(-1);assert.equal(calls().length,before+1);
  assert.deepEqual(call.slice(call.indexOf('--set-submission')),['--set-submission','D02','--submission-state','submitted','--submission-result','duplicate','--submission-report=R-1']);
  await sub.getByRole('button',{name:'Cancel'}).click();
  await page.locator('tr[data-finding-id="D02"] .finding-meta').getByText('submitted',{exact:true}).waitFor();
}));

test('drag a finding onto Gadgets: preview, capability block, real write',{timeout:60000},()=>withBoard('writer',async({page,ledger,mapEntries,calls})=>{
  await openAlpha(page);
  await page.getByLabel('severity for Alpha critical').waitFor();
  const gadgets=page.locator('.workspace-nav [data-drop-target="gadgets"]');
  assert.equal(await gadgets.locator('.count').innerText(),'0');
  await page.setViewportSize({width:1360,height:1700});
  await page.locator('tr[data-finding-id="D05"]').dragTo(gadgets,{sourcePosition:{x:12,y:12}});
  const dialog=page.getByRole('dialog',{name:/Move to Gadgets: Alpha high/});await dialog.waitFor();
  const preview=dialog.locator('#ledger-move-preview');
  await preview.getByText('MapStore entry tagged gadget (shown under Gadgets)').waitFor();
  await preview.getByText(/Kept\. D05 stays in the ledger with its evidence/).waitFor();
  await preview.getByText('gadget, finding-d05, from-ledger').waitFor();
  const confirm=dialog.getByRole('button',{name:'Move to Gadgets'});
  assert.equal(await confirm.isDisabled(),true);
  await dialog.getByText(/Gadgets need a capability block\. Fill in: grants, requires, crosses\./).waitFor();
  assert.equal(await dialog.getByLabel('Surface').inputValue(),'ssrf');
  await dialog.getByLabel('Grants').fill('synthetic server fetch');
  await dialog.getByLabel('Requires',{exact:true}).fill('authenticated user');
  await dialog.getByLabel('Crosses',{exact:true}).fill('user-input->server-fetch');
  await dialog.getByLabel('Extra tags').fill('Legacy, ssrf');
  await preview.getByText('gadget, finding-d05, from-ledger, legacy, ssrf').waitFor();
  await dialog.getByLabel('Gadget tier').selectOption('residual');
  await dialog.getByText(/Fill in: disclosed by\./).waitFor();
  await dialog.getByLabel('Disclosed by').fill('allowlist rejected internal host');
  await dialog.getByLabel('Also set the finding status to archive').check();
  await preview.getByText(/Set to archive \(now raw\)/).waitFor();
  assert.equal(await confirm.isDisabled(),false);
  await snap(page,'drag-preview.png');
  await confirm.click();
  await dialog.getByText(/Created Gadgets entry recon\/maps\/ssrf\/_surface\/.+\. The finding and its evidence were kept\./).waitFor();
  const entry=mapEntries('alpha')[0];
  assert.deepEqual(entry.tags,['finding-d05','from-ledger','gadget','legacy','residual','ssrf']);
  const finding=ledger('alpha').find(f=>f.fid==='D05');
  assert.equal(finding.severity,'HIGH');assert.equal(finding.status,'archive');assert.match(finding.review_notes,/Reclassified to Gadgets/);
  assert.equal(ledger('alpha').length,5);
  assert.deepEqual(calls().map(c=>c[0]),['agents/map_store.py','agents/manual_hunter.py']);
  await dialog.getByRole('button',{name:'Close'}).click();
  assert.equal(await gadgets.locator('.count').innerText(),'1');
  await gadgets.click();await page.getByText(entry.title).first().waitFor();
}));

test('non-drag Move to MapStore and dashboard class review at scale',{timeout:60000},()=>withBoard('writer',async({page,ledger,mapEntries})=>{
  await openAlpha(page);
  await page.getByRole('button',{name:'Actions for Alpha informational'}).click();
  await page.getByRole('menuitem',{name:'Move to MapStore…'}).click();
  const dialog=page.getByRole('dialog',{name:/Move to MapStore: Alpha informational/});await dialog.waitFor();
  assert.equal(await dialog.getByLabel('Grants').count(),0,'MapStore entries need no capability block');
  await dialog.getByLabel('Note').fill('Synthetic observation\nsecond line');
  await dialog.getByRole('button',{name:'Move to MapStore'}).click();
  await dialog.getByText(/Created MapStore entry/).waitFor();
  assert.deepEqual(mapEntries('alpha')[0].tags,['finding-d03','from-ledger']);
  assert.equal(ledger('alpha').find(f=>f.fid==='D03').status,'raw');
  await dialog.getByRole('button',{name:'Close'}).click();
  // Dashboard class breakdown: xss spans two programs.
  await page.getByRole('button',{name:'Dashboard',exact:true}).click();
  // Bulk reclassify lives in the expanded class row of the dashboard breakdown.
  await page.locator('.breakdown-row[data-class-name="xss"]').click();
  await page.getByRole('button',{name:'Review and reclassify xss findings'}).click();
  const review=page.getByRole('dialog',{name:'Class: xss'});await review.waitFor();
  await review.getByText('3 loaded findings in this class. Each change runs a separate BBH edit for that finding.').waitFor();
  // Alpha D03 moved to MapStore above; its rebased revision must still work.
  await review.getByRole('checkbox',{name:/Beta xss/}).uncheck();
  await review.getByRole('combobox',{name:'New class for selected findings'}).fill('stored-xss');
  await review.getByText('New class; it will be created on save.').waitFor();
  await review.getByRole('button',{name:'Move selected'}).click();
  await review.getByText('Moved 2 of 2 to stored-xss.').waitFor();
  assert.equal(ledger('alpha').find(f=>f.fid==='D01').class_name,'stored-xss');
  assert.equal(ledger('alpha').find(f=>f.fid==='D03').class_name,'stored-xss');
  assert.equal(ledger('beta')[0].class_name,'xss');
  await review.getByRole('button',{name:'Close'}).click();
  await page.locator('.breakdown-row[data-class-name="stored-xss"]').waitFor();
  // Back-to-back inline edit in the same lane after module writes: no false conflict.
  await page.getByRole('button',{name:'Programs',exact:true}).click();
  await page.getByLabel('severity for Alpha high').selectOption('MEDIUM');
  await page.waitForFunction(()=>document.querySelector('tr[data-finding-id="D05"] [data-metadata=severity]')?.value==='MEDIUM' && !document.querySelector('tr[data-finding-id="D05"] [data-metadata=severity]').disabled);
  await page.getByLabel('severity for Alpha critical').selectOption('HIGH');
  await page.waitForFunction(()=>document.querySelector('tr[data-finding-id="D02"] [data-metadata=severity]')?.value==='HIGH' && !document.querySelector('tr[data-finding-id="D02"] [data-metadata=severity]').disabled);
  assert.equal(ledger('alpha').find(f=>f.fid==='D02').severity,'HIGH');
  assert.equal(await page.getByText(/Conflict/).count(),0);
}));

test('add finding through the form; duplicate and conflict feedback',{timeout:60000},()=>withBoard('writer',async({page,ledger,base})=>{
  await openAlpha(page);
  await page.getByRole('button',{name:'Add finding'}).click();
  const dialog=page.getByRole('dialog',{name:/Add finding to alpha \/ web/});await dialog.waitFor();
  const save=dialog.getByRole('button',{name:'Add finding'});
  await dialog.getByLabel('Title').fill('Synthetic added');
  await dialog.getByRole('combobox',{name:'Class'}).fill('idor');
  await dialog.getByLabel('Severity').selectOption('INFO');
  assert.equal(await save.isDisabled(),true,'file and description are required by BBH');
  await dialog.getByLabel('File or asset').fill('/api/items');
  await dialog.getByLabel('Description').fill('Fixture only.');
  await save.click();await dialog.getByText('Added D06.').waitFor();
  assert.equal(ledger('alpha').at(-1).title,'Synthetic added');
  await page.locator('tr[data-finding-id="D06"]').waitFor();
  assert.equal(await save.isDisabled(),true,'no accidental second add');
  await dialog.getByRole('button',{name:'Cancel'}).click();
  fs.writeFileSync(path.join(base,'mode'),'dedupe');
  await page.getByRole('button',{name:'Add finding'}).click();
  await dialog.getByLabel('Title').fill('Synthetic added');
  await dialog.getByRole('combobox',{name:'Class'}).fill('idor');
  await dialog.getByLabel('File or asset').fill('/api/items');
  await dialog.getByLabel('Description').fill('Fixture only.');
  await save.click();await dialog.getByText(/it may match an existing one/).waitFor();
  assert.equal(ledger('alpha').length,6);
  await dialog.getByRole('button',{name:'Cancel'}).click();
  // Conflict: change the ledger outside the board, then try a class change.
  fs.writeFileSync(path.join(base,'mode'),'ok');
  const file=path.join(base,'data/web_bounty/alpha/web/ledgers/ledger.json');
  const data=JSON.parse(fs.readFileSync(file,'utf8'));data.findings[1].severity='LOW';fs.writeFileSync(file,JSON.stringify(data));
  await page.getByRole('button',{name:'Actions for Alpha critical'}).click();await page.getByRole('menuitem',{name:'Set submission state…'}).click();
  const sub=page.getByRole('dialog',{name:/Submission state/});
  await sub.getByLabel('I understand this only records local state.').check();
  await sub.getByRole('button',{name:'Record state'}).click();
  await sub.getByText(/Conflict: the finding changed since it was loaded/).waitFor();
  assert.deepEqual(ledger('alpha')[1].submission,{state:'not_submitted'});
}));

test('without a writer every action stays visibly disabled',{timeout:60000},()=>withBoard('readonly',async({page,calls})=>{
  await openAlpha(page);
  await page.getByRole('button',{name:'Actions for Alpha high'}).click();
  await page.getByRole('menuitem',{name:'Move to Gadgets…'}).click();
  const dialog=page.getByRole('dialog',{name:/Move to Gadgets/});
  await dialog.getByText('Unavailable: the BBH writer does not offer agents/map_store.py write.').waitFor();
  assert.equal(await dialog.getByRole('button',{name:'Move to Gadgets'}).isDisabled(),true);
  await dialog.getByRole('button',{name:'Close'}).click();
  await page.getByRole('button',{name:'Actions for Alpha high'}).click();
  await page.getByRole('menuitem',{name:'Set submission state…'}).click();
  const sub=page.getByRole('dialog',{name:/Submission state/});
  await sub.getByText(/Recording submission state is unavailable/).waitFor();
  await sub.getByLabel('I understand this only records local state.').check();
  assert.equal(await sub.getByRole('button',{name:'Record state'}).isDisabled(),true);
  await sub.getByRole('button',{name:'Cancel'}).click();
  await page.getByRole('button',{name:'Actions for Alpha high'}).click();
  await page.getByRole('menuitem',{name:'Change class…'}).click();
  await page.getByText(/Class editing is unavailable/).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Add finding'}).click();
  await page.getByText(/Adding findings is unavailable/).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Dashboard',exact:true}).click();
  if(await page.locator('.breakdown-row[data-class-name="xss"]').count())await page.locator('.breakdown-row[data-class-name="xss"]').click();
  await page.locator('.drill').first().waitFor();
  assert.equal(await page.getByRole('button',{name:/Review and reclassify/}).count(),0);
  assert.deepEqual(calls(),[]);
}));
