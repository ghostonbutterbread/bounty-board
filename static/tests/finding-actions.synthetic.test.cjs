// Finding actions (pickers, context menu, multi-select, bulk, drag, archive and
// permanent delete, report markers) in real Chromium against a synthetic root
// and the fake BBH writer from tests/test_ledger_actions.py.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {chromium}=require('playwright');

const repo=path.resolve(__dirname,'../..');

async function withBoard(mode,run,{theme}={}){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'finding-actions-'));
  const child=spawn('python3',['-u','tests/finding_actions_fixture.py',base,mode],{cwd:repo,env:{...process.env,PYTHONPATH:`${repo}:${repo}/tests`},stdio:['ignore','pipe','inherit']});
  let browser;
  try {
    const port=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>reject(Error(`fixture exited ${code}`)));child.stdout.once('data',d=>resolve(Number(String(d).trim())));});
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN,args:['--no-sandbox','--disable-dev-shm-usage','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    const context=await browser.newContext({viewport:{width:1360,height:900}});
    await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:`http://127.0.0.1:${port}`});
    await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1' ? route.continue() : route.abort());
    if(theme)await context.addInitScript(t=>{try{localStorage.setItem('bounty-board-theme',t);}catch{}},theme);
    const page=await context.newPage();page.setDefaultTimeout(10000);
    const errors=[];page.on('pageerror',e=>errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${port}`);
    await page.locator('.breakdown-row').first().waitFor();
    const lanePath=name=>path.join(base,'data/web_bounty',name,'web');
    const ledger=name=>JSON.parse(fs.readFileSync(path.join(lanePath(name),'ledgers/ledger.json'),'utf8')).findings;
    const finding=(name,fid)=>ledger(name).find(f=>f.fid===fid);
    // An outside edit that keeps the ledger inode, so only this entry's revision changes.
    const touch=(name,fid,patch)=>{const file=path.join(lanePath(name),'ledgers/ledger.json');const data=JSON.parse(fs.readFileSync(file,'utf8'));Object.assign(data.findings.find(f=>f.fid===fid),patch);fs.writeFileSync(file,JSON.stringify(data));};
    const calls=()=>fs.existsSync(path.join(base,'writer.log')) ? fs.readFileSync(path.join(base,'writer.log'),'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
    await run({page,context,ledger,finding,touch,calls,base,lanePath,port});
    assert.deepEqual(errors,[]);
  } finally {
    if(browser)await browser.close();
    child.kill('SIGTERM');await new Promise(r=>child.exitCode!==null||child.signalCode!==null?r():child.once('exit',r));
    fs.rmSync(base,{recursive:true,force:true});
  }
}
const until=async(fn,label='condition',ms=10000)=>{const end=Date.now()+ms;let last;while(Date.now()<end){try{if(await fn())return;}catch(e){last=e;}await new Promise(r=>setTimeout(r,50));}throw new Error(`timed out waiting for ${label}${last?`: ${last.message}`:''}`);};
const openAlpha=async page=>{await page.getByRole('button',{name:'Programs',exact:true}).click();await page.locator('#program-select').selectOption('web_bounty/alpha');await page.locator('tr[data-finding-id]').first().waitFor();};
const tableIds=page=>page.locator('tbody tr[data-finding-id]').evaluateAll(rows=>rows.map(r=>r.dataset.findingId));
const expand=async(page,key)=>{await page.locator(`[data-breakdown="${key}"]`).click();await page.locator('.drill li[data-finding-id]').first().waitFor();};
const pillNames=menu=>menu.getByRole('menuitemradio').evaluateAll(items=>items.map(i=>[i.textContent.trim(),i.getAttribute('aria-checked'),i.disabled]));
const menuNames=menu=>menu.locator('[role^="menuitem"]').evaluateAll(items=>items.map(i=>i.textContent.trim()));
const active=page=>page.evaluate(()=>document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent.trim());
const bar=page=>page.getByRole('region',{name:'Selected findings'});

test('severity and submission pills save one finding through the edit and submission paths',{timeout:90000},()=>withBoard('writer',async({page,finding,calls})=>{
  await expand(page,'class:xss');
  // Every drill-down row shows its submission badge as a picker.
  assert.equal(await page.locator('.drill li[data-finding-id]').count(),await page.locator('.drill li[data-finding-id] [data-submission-pick]').count());
  const row=page.locator('li[data-finding-id="A02"]');
  await row.locator('[data-sev-pick]').click();
  const pills=page.getByRole('menu',{name:'Change severity'});
  assert.deepEqual(await pillNames(pills),[['Exceptional','false',false],['Critical','false',false],['High','true',false],['Medium','false',false],['Low','false',false],['Info','false',false],['Unknown','false',false]]);
  assert.equal(await active(page),'High','focus starts on the current value');
  const bg=await page.locator('.pill-popover').evaluate(n=>getComputedStyle(n).backgroundColor);
  assert.match(bg,/^rgb\(/,'the popover is opaque');
  await page.keyboard.press('ArrowRight');assert.equal(await active(page),'Medium');
  await page.keyboard.press('Enter');
  await until(()=>finding('alpha','A02').severity==='MEDIUM','A02 saved as MEDIUM');
  await until(async()=>(await page.locator('li[data-finding-id="A02"] [data-sev-pick]').innerText())==='MEDIUM','row shows MEDIUM');
  assert.deepEqual(calls().at(-1).slice(-4),['--edit-finding','A02','--patch-file',calls().at(-1).at(-1)]);
  // Escape closes the pills and returns focus to the badge.
  await page.locator('li[data-finding-id="A03"] [data-sev-pick]').click();await pills.waitFor();
  await page.keyboard.press('Escape');await pills.waitFor({state:'detached'});
  assert.match(await active(page),/^Severity MEDIUM/);
  // Submission: results need Submitted first.
  const sub=page.locator('li[data-finding-id="A03"] [data-submission-pick]');
  await sub.click();
  const subMenu=page.getByRole('menu',{name:'Submission'});
  assert.deepEqual(await pillNames(subMenu),[['Not submitted','true',false],['Submitted','false',false],['Dropped','false',false],['Valid','false',true],['Duplicate','false',true]]);
  await page.locator('.pill-popover').getByText('Nothing is sent to a platform').waitFor();
  await subMenu.getByRole('menuitemradio',{name:'Submitted',exact:true}).click();
  await until(()=>finding('alpha','A03').submission?.state==='submitted','A03 submitted');
  await until(async()=>/submitted/i.test(await page.locator('li[data-finding-id="A03"] [data-submission-pick]').innerText()),'badge shows submitted');
  await page.locator('li[data-finding-id="A03"] [data-submission-pick]').click();
  await subMenu.getByRole('menuitemradio',{name:'Valid'}).click();
  await until(()=>finding('alpha','A03').submission?.result==='valid','A03 valid');
  const last=calls().at(-1);
  assert.deepEqual(last.slice(last.indexOf('--set-submission')),['--set-submission','A03','--submission-state','submitted','--submission-result','valid']);
}));

test('context menu by right-click and keyboard, navigation items, copy and viewport fit',{timeout:90000},()=>withBoard('writer',async({page})=>{
  await openAlpha(page);
  await page.locator('tr[data-finding-id="A01"] .finding-title').click({button:'right'});
  const menu=page.getByRole('menu',{name:'Actions for Alpha critical idor'});
  await menu.waitFor();
  assert.deepEqual(await menuNames(menu),['Open finding','Open finding in new tab','Go to report','Open report in new tab','Change severity…','Change class…','Submission…','Move to Gadgets…','Move to MapStore…','Copy ID','Delete…']);
  assert.equal(await active(page),'Open finding');
  assert.match(await page.locator('.context-menu').evaluate(n=>getComputedStyle(n).backgroundColor),/^rgb\(/);
  await page.keyboard.press('Escape');await menu.waitFor({state:'detached'});
  assert.equal(await active(page),'Select finding A01','focus returns to the row');
  // Copy ID
  await page.locator('tr[data-finding-id="A01"] .finding-title').click({button:'right'});
  await menu.getByRole('menuitem',{name:'Copy ID'}).click();
  await page.getByText('Finding ID copied.').waitFor();
  assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'A01');
  // Keyboard: Shift+F10 on a focused row, typeahead, pills by keyboard.
  await page.getByRole('checkbox',{name:'Select finding A02'}).focus();
  await page.keyboard.press('Shift+F10');
  const menu2=page.getByRole('menu',{name:'Actions for Alpha high xss'});await menu2.waitFor();
  assert.ok((await menuNames(menu2)).includes('No linked report (see Possible report)'));
  assert.equal(await menu2.getByRole('menuitem',{name:'No linked report (see Possible report)'}).isDisabled(),true);
  await page.keyboard.press('c');assert.equal(await active(page),'Change severity…');
  await page.keyboard.press('Enter');
  const pills=page.getByRole('menu',{name:'Change severity'});await pills.waitFor();
  assert.equal(await active(page),'High');
  await page.keyboard.press('Escape');await pills.waitFor({state:'detached'});
  assert.equal(await active(page),'Select finding A02');
  // The ContextMenu key works too.
  await page.keyboard.press('ContextMenu');await menu2.waitFor();
  await page.keyboard.press('Escape');await menu2.waitFor({state:'detached'});
  // Near the bottom-right corner the menu stays inside the viewport.
  await page.setViewportSize({width:900,height:600});
  // A right-click at the bottom-right corner (dispatched at exact coordinates).
  await page.locator('tr[data-finding-id="A08"] .finding-title').evaluate(n=>n.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:895,clientY:595,button:2})));
  const menu3=page.getByRole('menu',{name:'Actions for Alpha submitted high'});await menu3.waitFor();
  const rect=await page.locator('.context-menu').boundingBox();
  assert.ok(rect.x>=0 && rect.y>=0 && rect.x+rect.width<=900 && rect.y+rect.height<=600,`menu inside viewport: ${JSON.stringify(rect)}`);
  await page.keyboard.press('Escape');
  await page.setViewportSize({width:1360,height:900});
  // Go to report navigates to the linked report.
  await page.locator('tr[data-finding-id="A01"] .finding-title').click({button:'right'});
  await menu.getByRole('menuitem',{name:'Go to report'}).click();
  await until(()=>page.evaluate(()=>location.hash==='#/programs/web_bounty%2Falpha/web/reports/A01%2FREPORT.md'),'report route');
  // Open in new tab uses the real link.
  await page.goBack();await page.locator('tr[data-finding-id]').first().waitFor();
  const [popup]=await Promise.all([page.context().waitForEvent('page'),(async()=>{await page.locator('tr[data-finding-id="A01"] .finding-title').click({button:'right'});await menu.getByRole('menuitem',{name:'Open finding in new tab'}).click();})()]);
  await until(()=>popup.url().endsWith('#/programs/web_bounty%2Falpha/web/findings/A01'),'new tab url');
  await popup.close();
}));

test('delete archives with confirm and undo; archived hidden by default, shown with the toggle, restored',{timeout:90000},()=>withBoard('writer',async({page,finding,calls})=>{
  // Dashboard counts exclude archived findings.
  const stat=()=>page.locator('.stat').filter({hasText:'Finding records'}).locator('strong').innerText();
  assert.equal(await stat(),'9');
  await page.getByText('Archived 1').waitFor();
  await page.getByLabel('Show archived').check();
  assert.equal(await stat(),'10');
  await page.getByLabel('Show archived').uncheck();
  await openAlpha(page);
  assert.deepEqual(await tableIds(page),['A01','A02','A03','A04','A05','A06','A08']);
  const writes=calls().length;
  await page.locator('tr[data-finding-id="A04"] .finding-title').click({button:'right'});
  await page.getByRole('menuitem',{name:'Delete…'}).click();
  const dialog=page.getByRole('dialog',{name:'Delete 1 finding?'});
  await dialog.getByText('hidden from the dashboard and lists. The ledger keeps them').waitFor();
  await dialog.getByRole('button',{name:'Cancel'}).click();
  assert.equal(calls().length,writes,'cancel writes nothing');
  assert.equal(finding('alpha','A04').status,'raw');
  await page.locator('tr[data-finding-id="A04"] .finding-title').click({button:'right'});
  await page.getByRole('menuitem',{name:'Delete…'}).click();
  await dialog.getByRole('button',{name:'Delete (archive)'}).click();
  await until(()=>finding('alpha','A04').status==='archive','A04 archived');
  await until(async()=>!(await tableIds(page)).includes('A04'),'A04 hidden');
  const toast=page.locator('.toast').filter({hasText:'Archived 1 of 1 finding'});
  await toast.getByRole('button',{name:'Undo'}).click();
  await until(()=>finding('alpha','A04').status==='raw','A04 restored by undo');
  await until(async()=>(await tableIds(page)).includes('A04'),'A04 visible again');
  // Toggle shows archived findings and persists.
  await page.getByText('Archived 1').waitFor();
  await page.getByLabel('Show archived').check();
  await until(async()=>(await tableIds(page)).includes('A07'),'A07 shown');
  await page.reload();await page.locator('tr[data-finding-id]').first().waitFor();
  assert.ok((await tableIds(page)).includes('A07'),'toggle persists');
  // Restore: the previous status of A07 is not known in this browser, so pick one.
  await page.locator('tr[data-finding-id="A07"] .finding-title').click({button:'right'});
  const menu=page.getByRole('menu',{name:'Actions for Alpha archived info'});
  assert.deepEqual(await menuNames(menu),['Open finding','Open finding in new tab','No linked report','Open report in new tab','Copy ID','Restore…','Delete permanently…']);
  await menu.getByRole('menuitem',{name:'Restore…'}).click();
  const pills=page.getByRole('menu',{name:'Restore as'});
  assert.equal(await pills.getByRole('menuitemradio',{name:'Previous status'}).isDisabled(),true);
  await pills.getByRole('menuitemradio',{name:'confirmed'}).click();
  await until(()=>finding('alpha','A07').status==='confirmed','A07 restored');
  // Archive then restore with Previous status.
  await page.locator('tr[data-finding-id="A03"] .finding-title').click({button:'right'});
  await page.getByRole('menuitem',{name:'Delete…'}).click();
  await dialog.getByRole('button',{name:'Delete (archive)'}).click();
  await until(()=>finding('alpha','A03').status==='archive','A03 archived');
  await until(async()=>(await page.locator('tr[data-finding-id="A03"]').count())===1,'A03 visible with toggle on');
  await page.locator('tr[data-finding-id="A03"] .finding-title').click({button:'right'});
  await page.getByRole('menuitem',{name:'Restore…'}).click();
  await pills.getByRole('menuitemradio',{name:'Previous status'}).click();
  await until(()=>finding('alpha','A03').status==='confirmed','A03 back to confirmed');
}));

test('shift-click range, ctrl-click, select all and Escape; drill-down select all',{timeout:90000},()=>withBoard('writer',async({page})=>{
  await expand(page,'class:xss');
  await page.getByRole('button',{name:'Select all 4'}).click();
  await bar(page).getByText('4 selected').waitFor();
  await page.keyboard.press('Escape');
  await until(async()=>await bar(page).isHidden(),'bar hidden');
  await openAlpha(page);
  const check=id=>page.getByRole('checkbox',{name:`Select finding ${id}`});
  await check('A01').click();
  await check('A04').click({modifiers:['Shift']});
  await bar(page).getByText('4 selected').waitFor();
  for(const id of ['A01','A02','A03','A04'])assert.equal(await check(id).isChecked(),true,id);
  assert.equal(await check('A05').isChecked(),false);
  await page.locator('tr[data-finding-id="A06"] .finding-title').click({modifiers:['Control']});
  await bar(page).getByText('5 selected').waitFor();
  // Space toggles the focused checkbox.
  await check('A08').focus();await page.keyboard.press('Space');
  await bar(page).getByText('6 selected').waitFor();
  await bar(page).getByRole('button',{name:'Select all (7)'}).click();
  await bar(page).getByText('7 selected').waitFor();
  // Shift+click a selected checkbox clears a range.
  await check('A02').click();
  await check('A05').click({modifiers:['Shift']});
  await bar(page).getByText('3 selected').waitFor();
  await page.keyboard.press('Escape');
  await until(async()=>await bar(page).isHidden(),'bar hidden after Escape');
  assert.equal(await page.locator('.row-select:checked').count(),0);
  // Filter-bar select all.
  await page.getByRole('button',{name:'Select all',exact:true}).click();
  await bar(page).getByText('7 selected').waitFor();
  await bar(page).getByRole('button',{name:'Clear'}).click();
  await until(async()=>await bar(page).isHidden(),'cleared');
}));

test('bulk severity and bulk class report a stale item, keep it selected, save the rest, then undo',{timeout:120000},()=>withBoard('writer',async({page,finding,touch})=>{
  await openAlpha(page);
  const check=id=>page.getByRole('checkbox',{name:`Select finding ${id}`});
  await check('A02').click();await check('A04').click({modifiers:['Shift']});
  await bar(page).getByText('3 selected').waitFor();
  touch('alpha','A03',{title:'Alpha medium xss (edited elsewhere)'});
  await bar(page).getByRole('button',{name:'Change severity'}).click();
  const pills=page.getByRole('menu',{name:'Change severity for 3 findings'});
  assert.deepEqual((await pillNames(pills)).map(p=>p[1]),['false','false','false','false','false','false','false'],'mixed values: none marked');
  await pills.getByRole('menuitemradio',{name:'Info'}).click();
  const status=bar(page).getByRole('status');
  await status.getByText('Severity set to Info for 2 of 3 findings.').waitFor();
  await status.getByText(/A03 changed since it was loaded \(stale\)/).waitFor();
  assert.equal(finding('alpha','A02').severity,'INFO');
  assert.equal(finding('alpha','A04').severity,'INFO');
  assert.equal(finding('alpha','A03').severity,'MEDIUM','stale item not overwritten');
  await bar(page).getByText('1 selected').waitFor();
  assert.equal(await check('A03').isChecked(),true,'failed item stays selected');
  // Retry after the refresh succeeds.
  await bar(page).getByRole('button',{name:'Change severity'}).click();
  await page.getByRole('menu',{name:'Change severity'}).getByRole('menuitemradio',{name:'Info'}).click();
  await until(()=>finding('alpha','A03').severity==='INFO','A03 retried');
  // Bulk class with one stale item, then Undo restores the others.
  await until(async()=>await bar(page).getByRole('button',{name:'Change severity'}).isHidden(),'selection cleared after success');
  await check('A02').click();await check('A04').click({modifiers:['Shift']});
  await bar(page).getByText('3 selected').waitFor();
  touch('alpha','A02',{title:'Alpha high xss (edited elsewhere)'});
  await bar(page).getByRole('button',{name:'Change class'}).click();
  const dialog=page.getByRole('dialog',{name:'Change class: 3 findings'});
  await dialog.getByRole('combobox',{name:'Class'}).fill('csrf');
  await dialog.getByText('New class; it will be created on save.').waitFor();
  await dialog.getByRole('button',{name:'Save class'}).click();
  await status.getByText('Class set to csrf for 2 of 3 findings.').waitFor();
  await status.getByText(/A02 changed since it was loaded/).waitFor();
  assert.deepEqual(['A02','A03','A04'].map(id=>finding('alpha',id).class_name),['xss','csrf','csrf']);
  await bar(page).getByRole('button',{name:'Undo'}).click();
  await until(()=>finding('alpha','A03').class_name==='xss' && finding('alpha','A04').class_name==='ssrf','undo restored classes');
  assert.equal(finding('alpha','A02').class_name,'xss');
}));

test('drag selected rows onto a class row and one row onto a severity row',{timeout:90000},()=>withBoard('writer',async({page,finding})=>{
  await expand(page,'class:xss');
  await page.getByRole('checkbox',{name:'Select finding A02'}).click();
  await page.getByRole('checkbox',{name:'Select finding A03'}).click();
  const source=page.locator('li[data-finding-id="A02"] a.link-button');
  const target=page.locator('.breakdown-row[data-class-name="idor"]');
  await source.hover();await page.mouse.down();
  const t=await target.boundingBox();
  for(let i=0;i<5;i++)await page.mouse.move(t.x+20+i*10,t.y+t.height/2,{steps:3});
  await until(async()=>(await page.locator('.drop-preview').count())===1,'drop preview');
  assert.equal(await page.locator('.drop-preview').innerText(),'Set class to idor for 2 findings. You will confirm first.');
  assert.equal(await target.evaluate(n=>n.classList.contains('drop-active')),true);
  await page.mouse.up();
  const dialog=page.getByRole('dialog',{name:'Set class to idor for 2 findings?'});
  await dialog.getByRole('button',{name:'Set class to idor'}).click();
  await until(()=>finding('alpha','A02').class_name==='idor' && finding('alpha','A03').class_name==='idor','classes moved');
  // A single row needs no confirm.
  await page.locator('li[data-finding-id="B01"]').waitFor();
  await page.locator('li[data-finding-id="B01"] a.link-button').dragTo(page.locator('.breakdown-row[data-breakdown="sev:low"]'));
  await until(()=>finding('beta','B01').severity==='LOW','B01 severity');
}));

test('writer disabled: pickers, context menu and selection bar are disabled with a hint',{timeout:60000},()=>withBoard('readonly',async({page,calls})=>{
  await expand(page,'class:xss');
  await page.locator('li[data-finding-id="A02"] [data-sev-pick]').click();
  const pills=page.getByRole('menu',{name:'Change severity'});
  assert.ok((await pillNames(pills)).every(p=>p[2]===true));
  await page.locator('.pill-popover').getByText('Editing is off: the backend has not enabled the BBH writer.').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('li[data-finding-id="A02"] a.link-button').click({button:'right'});
  const menu=page.getByRole('menu',{name:'Actions for Alpha high xss'});
  await menu.getByText('Editing is off: the backend has not enabled the BBH writer.').waitFor();
  for(const name of ['Change severity…','Change class…','Submission…','Move to Gadgets…','Delete…'])assert.equal(await menu.getByRole('menuitem',{name}).isDisabled(),true,name);
  assert.equal(await menu.getByRole('menuitem',{name:'Open finding',exact:true}).isDisabled(),false);
  await page.keyboard.press('Escape');
  await page.getByRole('checkbox',{name:'Select finding A02'}).click();
  for(const name of ['Change severity','Change class','Submission','Delete'])assert.equal(await bar(page).getByRole('button',{name,exact:true}).isDisabled(),true,name);
  await bar(page).getByText('Editing is off').waitFor();
  assert.deepEqual(calls(),[]);
}));

test('report markers, template placeholders, archive then delete permanently',{timeout:120000},()=>withBoard('writer',async({page,finding,ledger,calls,lanePath})=>{
  // The dashboard groups the raw template severity and labels it.
  await page.locator('.breakdown-row[data-breakdown="sev:raw:LOW|MEDIUM|HIGH|CRITICAL"]').getByText('Template placeholder').waitFor();
  await openAlpha(page);
  const row=id=>page.locator(`tr[data-finding-id="${id}"]`);
  assert.equal(await row('A01').locator('.report-ref').count(),1);
  assert.equal(await row('A01').locator('.report-missing, .possible-report').count(),0);
  assert.match(await row('A02').locator('.report-missing').getAttribute('data-tip'),/no report_path/);
  assert.equal(await row('A02').locator('.possible-report').getAttribute('href'),'#/programs/web_bounty%2Falpha/web/reports/drafts%2FA02-notes.md');
  assert.match(await row('A02').locator('.possible-report').getAttribute('aria-label'),/unlinked/);
  assert.match(await row('A03').locator('.report-missing').getAttribute('data-tip'),/missing or moved/);
  assert.equal(await row('A04').locator('.possible-report').count(),0,'no partial ID matches');
  await row('A02').locator('.report-missing').focus();
  await page.getByRole('tooltip').getByText(/no report_path/).waitFor();
  assert.equal(await row('A05').locator('.placeholder-badge').innerText(),'Template placeholder');
  assert.equal(await row('A06').locator('.placeholder-badge').count(),1);
  assert.equal(await row('A04').locator('.placeholder-badge').count(),0);
  // Possible report is a real link.
  await row('A02').locator('.possible-report').click();
  await until(()=>page.evaluate(()=>location.hash.endsWith('reports/drafts%2FA02-notes.md')),'possible report route');
  await page.goBack();await row('A05').waitFor();
  // Step 1: select the placeholders and delete (archive).
  await page.getByRole('button',{name:'Select template placeholders (2)'}).click();
  await bar(page).getByText('2 selected').waitFor();
  await bar(page).getByRole('button',{name:'Delete',exact:true}).click();
  await page.getByRole('dialog',{name:'Delete 2 findings?'}).getByRole('button',{name:'Delete (archive)'}).click();
  await until(()=>finding('alpha','A05').status==='archive' && finding('alpha','A06').status==='archive','placeholders archived');
  await until(async()=>(await row('A05').count())===0,'placeholders hidden');
  // Step 2: show archived, select them again and delete permanently.
  await page.getByLabel('Show archived').check();
  await page.getByRole('button',{name:'Select template placeholders (2)'}).click();
  await bar(page).getByRole('button',{name:'Delete permanently'}).click();
  const dialog=page.getByRole('dialog',{name:'Permanently delete 2 findings?'});
  await dialog.getByText('It cannot be undone. Archive is the recoverable state; this is not.').waitFor();
  await dialog.getByRole('button',{name:'Delete permanently'}).click();
  await bar(page).getByRole('status').getByText('Permanently deleted 2 of 2 findings.').waitFor();
  assert.deepEqual(ledger('alpha').map(f=>f.fid),['A01','A02','A03','A04','A07','A08']);
  assert.equal(fs.existsSync(path.join(lanePath('alpha'),'reports/A05/REPORT.md')),false,'generated report deleted');
  assert.equal(fs.existsSync(path.join(lanePath('alpha'),'reports/drafts/A02-notes.md')),true);
  assert.deepEqual(calls().filter(c=>c.includes('--delete-finding')).map(c=>c.at(-1)),['A05','A06']);
  assert.equal(await bar(page).getByRole('button',{name:'Undo'}).count(),0,'no undo for permanent delete');
  await until(async()=>(await row('A05').count())===0,'deleted rows gone');
  // A non-archived finding cannot be deleted permanently from the UI.
  await page.locator('tr[data-finding-id="A01"] .finding-title').click({button:'right'});
  assert.equal(await page.getByRole('menuitem',{name:/permanently/}).count(),0);
  await page.keyboard.press('Escape');
}));

test('without the BBH delete feature, archived rows offer Restore but no permanent delete',{timeout:60000},()=>withBoard('nodelete',async({page})=>{
  await openAlpha(page);
  await page.getByLabel('Show archived').check();
  await page.getByRole('checkbox',{name:'Select finding A07'}).click();
  await bar(page).getByRole('button',{name:'Restore'}).waitFor();
  assert.equal(await bar(page).getByRole('button',{name:/permanently/}).count(),0);
  await page.locator('tr[data-finding-id="A07"] .finding-title').click({button:'right'});
  assert.equal(await page.getByRole('menuitem',{name:/permanently/}).count(),0);
}));

