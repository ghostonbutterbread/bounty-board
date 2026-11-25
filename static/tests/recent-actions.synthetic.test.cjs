// Recent actions and report N/A (feat/board-recent-actions) in real Chromium
// against tests/recent_actions_fixture.py: BBH packet-shaped synthetic reports
// and the fake BBH writer from tests/test_ledger_actions.py. Synthetic only.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {chromium}=require('playwright');

const repo=path.resolve(__dirname,'../..');

async function withBoard(mode,run,{viewport={width:1360,height:900},theme}={}){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'recent-actions-'));
  const child=spawn('python3',['-u','tests/recent_actions_fixture.py',base,mode],{cwd:repo,env:{...process.env,PYTHONPATH:`${repo}:${repo}/tests`},stdio:['ignore','pipe','inherit']});
  let browser;
  try {
    const port=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>reject(Error(`fixture exited ${code}`)));child.stdout.once('data',d=>resolve(Number(String(d).trim())));});
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN,args:['--no-sandbox','--disable-dev-shm-usage','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    const context=await browser.newContext({viewport});
    await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:`http://127.0.0.1:${port}`});
    await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1' ? route.continue() : route.abort());
    if(theme)await context.addInitScript(t=>{try{localStorage.setItem('bounty-board-theme',t);}catch{}},theme);
    const page=await context.newPage();page.setDefaultTimeout(10000);
    const errors=[];page.on('pageerror',e=>errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${port}`);
    await page.locator('.breakdown-row').first().waitFor();
    const lanePath=name=>path.join(base,'data/web_bounty',name,'web');
    const finding=(name,fid)=>JSON.parse(fs.readFileSync(path.join(lanePath(name),'ledgers/ledger.json'),'utf8')).findings.find(f=>f.fid===fid);
    const touch=(name,fid,patch)=>{const file=path.join(lanePath(name),'ledgers/ledger.json');const data=JSON.parse(fs.readFileSync(file,'utf8'));Object.assign(data.findings.find(f=>f.fid===fid),patch);fs.writeFileSync(file,JSON.stringify(data));};
    await run({page,context,finding,touch,base,lanePath,url:`http://127.0.0.1:${port}/`});
    assert.deepEqual(errors,[]);
  } finally {
    if(browser)await browser.close();
    child.kill('SIGTERM');await new Promise(r=>child.exitCode!==null||child.signalCode!==null?r():child.once('exit',r));
    fs.rmSync(base,{recursive:true,force:true});
  }
}
const until=async(fn,label='condition',ms=10000)=>{const end=Date.now()+ms;let last;while(Date.now()<end){try{if(await fn())return;}catch(e){last=e;}await new Promise(r=>setTimeout(r,50));}throw new Error(`timed out waiting for ${label}${last?`: ${last.message}`:''}`);};
const panel=page=>page.locator('#dashboard-recent-host');
const panelRow=(page,file)=>panel(page).locator(`li[data-recent-row][data-path$="${file}"]`);
const pillNames=menu=>menu.getByRole('menuitemradio').evaluateAll(items=>items.map(i=>[i.textContent.trim(),i.getAttribute('aria-checked'),i.disabled]));
const menuNames=menu=>menu.locator('[role^="menuitem"]').evaluateAll(items=>items.map(i=>i.textContent.trim()));
const REPORT='F001-stored-xss/orchard.example-xss-F001.md', EVIDENCE='F001-stored-xss/EVIDENCE.md';

test('Recent pills save severity and submission through BBH, update every row of the finding, and undo',{timeout:120000},()=>withBoard('writer',async({page,finding})=>{
  await panelRow(page,REPORT).waitFor();
  // Both packet files map to F001 and show pickers; an unmapped file shows none.
  for(const file of [REPORT,EVIDENCE])assert.equal(await panelRow(page,file).locator('[data-recent-pick]').count(),2);
  await page.goto(page.url().replace(/#.*$/,'')+'#/recent?within=all&order=newest');
  await page.locator('.recent-table tr[data-path="scratch/unmapped-notes.md"]').first().waitFor();
  assert.equal(await page.locator('.recent-table tr[data-path="scratch/unmapped-notes.md"] [data-recent-pick]').count(),0,'no pickers without a finding');
  await page.getByRole('link',{name:'Dashboard',exact:true}).click();
  await panelRow(page,REPORT).waitFor();
  await page.locator('[data-breakdown="class:xss"]').click();
  const drillSev=page.locator('li[data-finding-id="F001"] [data-sev-pick]');
  await drillSev.waitFor();
  await panelRow(page,REPORT).locator('[data-recent-pick="sev"]').click();
  const pills=page.getByRole('menu',{name:'Change severity'});
  assert.deepEqual((await pillNames(pills)).find(p=>p[0]==='High'),['High','true',false]);
  await pills.getByRole('menuitemradio',{name:'Critical'}).click();
  await until(()=>finding('orchard','F001').severity==='CRITICAL','F001 saved as CRITICAL');
  // Every row of F001 follows: both panel rows and the drill-down row.
  await until(async()=>(await panelRow(page,EVIDENCE).locator('[data-recent-pick="sev"]').innerText())==='CRITICAL','evidence row follows');
  assert.equal(await panelRow(page,REPORT).locator('[data-recent-pick="sev"]').innerText(),'CRITICAL');
  assert.equal(await page.locator('li[data-finding-id="F001"] [data-sev-pick]').innerText(),'CRITICAL');
  // Undo restores the previous value.
  await page.locator('.toast').filter({hasText:'Severity set to Critical'}).getByRole('button',{name:'Undo'}).click();
  await until(()=>finding('orchard','F001').severity==='HIGH','undo restored HIGH');
  // Submission pill: Submitted, then a platform result.
  await panelRow(page,EVIDENCE).locator('[data-recent-pick="sub"]').click();
  const sub=page.getByRole('menu',{name:'Submission'});
  await sub.getByRole('menuitemradio',{name:'Submitted',exact:true}).click();
  await until(()=>finding('orchard','F001').submission?.state==='submitted','F001 submitted');
  await until(async()=>/submitted/i.test(await panelRow(page,REPORT).locator('[data-recent-pick="sub"]').innerText()),'report row shows submitted');
  await panelRow(page,REPORT).locator('[data-recent-pick="sub"]').click();
  await sub.getByRole('menuitemradio',{name:'Duplicate'}).click();
  await until(()=>finding('orchard','F001').submission?.result==='duplicate','F001 duplicate');
}));

test('a stale Recent pick is refused, not overwritten; context menu offers the finding actions',{timeout:120000},()=>withBoard('writer',async({page,finding,touch,context})=>{
  await panelRow(page,'F003-open-redirect/EVIDENCE.md').waitFor();
  touch('orchard','F003',{title:'Open redirect on logout (edited elsewhere)'});
  await panelRow(page,'F003-open-redirect/EVIDENCE.md').locator('[data-recent-pick="sev"]').click();
  await page.getByRole('menu',{name:'Change severity'}).getByRole('menuitemradio',{name:'High'}).click();
  await page.locator('.toast.warning').filter({hasText:/not saved/}).first().waitFor();
  assert.equal(finding('orchard','F003').severity,'LOW','stale finding not overwritten');
  // Right-click on a mapped row.
  await panelRow(page,REPORT).locator('.recent-where').click({button:'right'});
  const menu=page.locator('.context-menu');await menu.waitFor();
  assert.deepEqual(await menuNames(menu),['Open report in new tab','Open finding','Change severity…','Submission…','Copy ID','Mark N/A']);
  const [tab]=await Promise.all([context.waitForEvent('page'),menu.getByRole('menuitem',{name:'Open report in new tab'}).click()]);
  assert.match(tab.url(),/#\/programs\/web_bounty%2Forchard\/web\/reports\/F001-stored-xss%2Forchard\.example-xss-F001\.md$/);
  await tab.close();
  await panelRow(page,REPORT).locator('.recent-where').click({button:'right'});
  await page.locator('.context-menu').getByRole('menuitem',{name:'Copy ID'}).click();
  await page.getByText('Finding ID copied.').waitFor();
  assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'F001');
  // Keyboard opener on a focused row.
  await panelRow(page,EVIDENCE).locator('a.recent-link').focus();
  await page.keyboard.press('Shift+F10');
  await page.locator('.context-menu').getByRole('menuitem',{name:'Mark N/A'}).waitFor();
  await page.keyboard.press('Escape');
}));

test('writer off: Recent pills are disabled with the hint, N/A still works (Board state)',{timeout:120000},()=>withBoard('readonly',async({page})=>{
  await panelRow(page,REPORT).locator('[data-recent-pick="sev"]').click();
  const pills=page.getByRole('menu',{name:'Change severity'});
  assert.ok((await pillNames(pills)).every(p=>p[2]===true),'every option disabled');
  await page.locator('.pill-popover').getByText('Editing is off: the backend has not enabled the BBH writer.').waitFor();
  await page.keyboard.press('Escape');
  const toggle=panelRow(page,REPORT).getByRole('button',{name:/^Mark N\/A/});
  assert.equal(await toggle.isDisabled(),false);
  await toggle.click();
  await panel(page).getByText('1 N/A hidden').waitFor();
}));

test('N/A toggle: strikethrough and opacity, Hide N/A filter in the URL, hidden counts, persistence',{timeout:150000},()=>withBoard('writer',async({page,url,base})=>{
  // Dashboard: marking hides the row and shows "N hidden · show".
  const toggle=panelRow(page,EVIDENCE).getByRole('button',{name:/^Mark N\/A/});
  assert.equal(await toggle.getAttribute('aria-pressed'),'false');
  await toggle.click();
  await panel(page).getByText('1 N/A hidden').waitFor();
  await until(async()=>await panelRow(page,EVIDENCE).count()===0,'row hidden');
  await page.locator('.toast').filter({hasText:'Marked N/A'}).waitFor();
  const stored=JSON.parse(fs.readFileSync(path.join(base,'state/report-na.json'),'utf8'));
  assert.deepEqual(Object.keys(stored),[`web_bounty/orchard/web/${EVIDENCE}`]);
  assert.equal(fs.statSync(path.join(base,'state/report-na.json')).mode&0o777,0o600);
  // The file is unchanged and still listed by the server.
  assert.match(fs.readFileSync(path.join(base,'data/web_bounty/orchard/web/reports',EVIDENCE),'utf8'),/Synthetic evidence/);
  await panel(page).getByRole('button',{name:'show'}).click();
  const row=panelRow(page,EVIDENCE);await row.waitFor();
  assert.equal(await row.evaluate(n=>n.classList.contains('is-na')),true);
  assert.equal(await row.evaluate(n=>getComputedStyle(n).opacity),'0.45');
  assert.match(await row.locator('.na-title').evaluate(n=>getComputedStyle(n).textDecorationLine),/line-through/);
  assert.equal(await row.getByRole('button',{name:/^Unmark N\/A/}).getAttribute('aria-pressed'),'true');
  // Recent view: hidden by default, count and Show; the filter is in the hash.
  await page.goto(`${url}#/recent?within=all&order=newest`);
  await page.locator('.recent-table tr[data-recent-row]').first().waitFor();
  assert.equal(await page.locator(`.recent-table tr[data-path="${EVIDENCE}"]`).count(),0);
  await page.locator('[data-recent-status]').getByText('1 N/A hidden').waitFor();
  assert.equal(await page.locator('#recent-hide-na').isChecked(),true);
  await page.locator('[data-recent-show-na]').click();
  await until(()=>page.evaluate(()=>location.hash.includes('na=show')),'na=show in the hash');
  const viewRow=page.locator(`.recent-table tr[data-path="${EVIDENCE}"]`);await viewRow.waitFor();
  assert.equal(await viewRow.evaluate(n=>getComputedStyle(n).opacity),'0.45');
  assert.equal(await page.locator('#recent-hide-na').isChecked(),false);
  // A link with na=show opens with N/A shown; a plain filter link hides them.
  await page.goto(`${url}#/recent?within=all&order=newest&na=show`);await page.reload();
  await page.locator(`.recent-table tr[data-path="${EVIDENCE}"]`).waitFor();
  await page.locator('#recent-hide-na').check();
  await until(async()=>await page.locator(`.recent-table tr[data-path="${EVIDENCE}"]`).count()===0,'hidden again');
  assert.ok(!(await page.evaluate(()=>location.hash)).includes('na='));
  // Unmark by keyboard from the view (Show first), Undo re-marks.
  await page.locator('[data-recent-show-na]').click();
  const unmark=page.locator(`.recent-table tr[data-path="${EVIDENCE}"]`).getByRole('button',{name:/^Unmark N\/A/});
  await unmark.focus();await page.keyboard.press('Enter');
  await until(async()=>(await page.locator(`.recent-table tr[data-path="${EVIDENCE}"] [data-na-toggle]`).getAttribute('aria-pressed'))==='false','unmarked');
  assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')?.startsWith('Mark N/A')),true,'focus stays on the toggle');
  await page.locator('.toast').filter({hasText:'Unmarked N/A'}).getByRole('button',{name:'Undo'}).click();
  await until(async()=>(await page.locator(`.recent-table tr[data-path="${EVIDENCE}"] [data-na-toggle]`).getAttribute('aria-pressed'))==='true','undo re-marked');
  // Program Reports list: same toggle and filter, persists across reload.
  await page.goto(`${url}#/programs/web_bounty%2Forchard/web/reports`);await page.reload();
  const list=page.locator('[data-report-browser]');await list.locator('[data-report-row]').first().waitFor();
  await list.getByText('1 N/A hidden').waitFor();
  await list.locator('[data-report-show-na]').click();
  const listRow=list.locator('[data-report-row].is-na');await listRow.waitFor();
  assert.match(await listRow.innerText(),/EVIDENCE/);
  assert.equal(await page.locator('#report-hide-na').isChecked(),false);
}));

test('no Board state directory: N/A toggles are disabled with the reason',{timeout:90000},()=>withBoard('nostate',async({page})=>{
  const toggle=panelRow(page,REPORT).locator('[data-na-toggle]');
  await toggle.waitFor();
  assert.equal(await toggle.isDisabled(),true);
  assert.match(await toggle.getAttribute('title'),/unavailable/);
}));

test('finding rows: metadata on one aligned line, title ellipsis, severity breakdown pills save',{timeout:120000},()=>withBoard('writer',async({page,finding})=>{
  await page.locator('[data-breakdown="class:xss"]').click();
  const rows=page.locator('.drill li.frow');await rows.first().waitFor();
  const boxes=await rows.evaluateAll(list=>list.map(li=>{
    const r=s=>{const n=li.querySelector(s);if(!n)return null;const b=n.getBoundingClientRect();return {top:b.top,bottom:b.bottom,left:b.left,mid:(b.top+b.bottom)/2,h:b.height};};
    const title=li.querySelector('.frow-title');
    return {sev:r('.frow-sev .pick-trigger'),sub:r('.frow-subm .pick-trigger'),links:r('.row-links'),title:r('.frow-title'),subline:r('.frow-sub'),
      ellipsis:getComputedStyle(title).textOverflow,overflow:title.scrollWidth>title.clientWidth};
  }));
  assert.ok(boxes.length>=2);
  for(const b of boxes){
    // Severity, submission and links share one line (vertical centres within 2 px).
    assert.ok(Math.abs(b.sev.mid-b.sub.mid)<2 && Math.abs(b.sev.mid-b.links.mid)<2,`one line ${JSON.stringify(b)}`);
    assert.ok(b.sub.h<30,'submission does not wrap');
    assert.equal(b.ellipsis,'ellipsis');
    assert.ok(b.title.h<24,'title stays on one line');
  }
  // Columns line up across rows.
  assert.ok(boxes.every(b=>Math.abs(b.sev.left-boxes[0].sev.left)<1 && Math.abs(b.sub.left-boxes[0].sub.left)<1),'aligned columns');
  assert.ok(boxes.some(b=>b.overflow),'the long title is truncated, not wrapped');
  // Severity breakdown: pills open and save.
  await page.locator('[data-breakdown^="sev:"]', {hasText:'LOW'}).first().click();
  const low=page.locator('section[aria-label="Severity breakdown"] li[data-finding-id="F003"]');
  await low.locator('[data-sev-pick]').click();
  await page.getByRole('menu',{name:'Change severity'}).getByRole('menuitemradio',{name:'Medium'}).click();
  await until(()=>finding('orchard','F003').severity==='MEDIUM','F003 saved from the severity breakdown');
  await page.locator('[data-breakdown^="sev:"]', {hasText:'MEDIUM'}).first().click();
  const sub=page.locator('section[aria-label="Severity breakdown"] li[data-finding-id="F003"] [data-submission-pick]');
  await sub.click();
  await page.getByRole('menu',{name:'Submission'}).getByRole('menuitemradio',{name:'Dropped'}).click();
  await until(()=>finding('orchard','F003').submission?.state==='dropped','F003 dropped from the severity breakdown');
}));

test('phone width: finding row metadata wraps as one block under the title; dark theme renders',{timeout:90000},()=>withBoard('writer',async({page})=>{
  await page.locator('[data-breakdown="class:xss"]').click();
  const row=page.locator('.drill li.frow').first();await row.waitFor();
  const b=await row.evaluate(li=>{const r=s=>li.querySelector(s).getBoundingClientRect();return {title:r('.frow-title'),sev:r('.frow-sev'),sub:r('.frow-subm'),width:document.documentElement.scrollWidth};});
  assert.ok(b.sev.top>=b.title.bottom-1,'pills sit under the title');
  assert.ok(Math.abs(b.sev.top-b.sub.top)<2,'pills stay on one line');
  assert.ok(b.width<=375,'no horizontal overflow');
},{viewport:{width:375,height:812},theme:'dark'}));
