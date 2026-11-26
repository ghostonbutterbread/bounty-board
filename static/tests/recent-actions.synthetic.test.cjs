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
// Evidence files are artifacts, not reports (feat/board-evidence-artifacts): never Recent rows.
const REPORT2='F002-invoice-idor/billing.orchard.example-idor-F002.md', REPORT3='F003-open-redirect/orchard.example-open-redirect-F003.md';

test('Recent pills save severity and submission through BBH, update every row of the finding, and undo',{timeout:120000},()=>withBoard('writer',async({page,finding})=>{
  await panelRow(page,REPORT).waitFor();
  // The submission report maps to F001 and shows pickers; its EVIDENCE.md is an artifact, not a second row.
  assert.equal(await panelRow(page,REPORT).locator('[data-recent-pick]').count(),2);
  assert.equal(await panelRow(page,EVIDENCE).count(),0);
  await page.goto(page.url().replace(/#.*$/,'')+'#/recent?within=all&order=newest');
  await page.locator('.recent-table tr[data-path="scratch/unmapped-notes.md"]').first().waitFor();
  assert.equal(await page.locator('.recent-table tr[data-path="scratch/unmapped-notes.md"] [data-recent-pick]').count(),0,'no pickers without a finding');
  // Packet _meta/ files are hidden like generated navigation, shown with the same toggle.
  assert.equal(await page.locator('.recent-table tr[data-path$="/_meta/notes.md"]').count(),0);
  assert.equal(await panel(page).count(),0);
  await page.getByLabel('Include generated and _meta files').check();
  await page.locator('.recent-table tr[data-path="F001-stored-xss/_meta/notes.md"]').waitFor();
  await page.getByLabel('Include generated and _meta files').uncheck();
  await until(async()=>await page.locator('.recent-table tr[data-path$="/_meta/notes.md"]').count()===0,'_meta hidden again');
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
  // Every row of F001 follows: the panel row and the drill-down row.
  await until(async()=>(await panelRow(page,REPORT).locator('[data-recent-pick="sev"]').innerText())==='CRITICAL','report row follows');
  await until(async()=>(await page.locator('li[data-finding-id="F001"] [data-sev-pick]').innerText())==='CRITICAL','drill row follows');
  // Undo restores the previous value.
  await page.locator('.toast').filter({hasText:'Severity set to Critical'}).getByRole('button',{name:'Undo'}).click();
  await until(()=>finding('orchard','F001').severity==='HIGH','undo restored HIGH');
  // Submission pill: Submitted, then a platform result.
  await panelRow(page,REPORT).locator('[data-recent-pick="sub"]').click();
  const sub=page.getByRole('menu',{name:'Submission'});
  await sub.getByRole('menuitemradio',{name:'Submitted',exact:true}).click();
  await until(()=>finding('orchard','F001').submission?.state==='submitted','F001 submitted');
  await until(async()=>/submitted/i.test(await panelRow(page,REPORT).locator('[data-recent-pick="sub"]').innerText()),'report row shows submitted');
  await panelRow(page,REPORT).locator('[data-recent-pick="sub"]').click();
  await sub.getByRole('menuitemradio',{name:'Duplicate'}).click();
  await until(()=>finding('orchard','F001').submission?.result==='duplicate','F001 duplicate');
}));

test('a stale Recent pick is refused, not overwritten; context menu offers the finding actions',{timeout:120000},()=>withBoard('writer',async({page,finding,touch,context})=>{
  await panelRow(page,REPORT3).waitFor();
  touch('orchard','F003',{title:'Open redirect on logout (edited elsewhere)'});
  await panelRow(page,REPORT3).locator('[data-recent-pick="sev"]').click();
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
  await panelRow(page,REPORT2).locator('a.recent-link').focus();
  await page.keyboard.press('Shift+F10');
  await page.locator('.context-menu').getByRole('menuitem',{name:'Mark N/A'}).waitFor();
  await page.keyboard.press('Escape');
}));

test('a finding with a non-standard ID maps through its owner path but its Recent pills stay read-only',{timeout:120000},()=>withBoard('writer',async({page,touch,url})=>{
  touch('orchard','F003',{fid:'AC-3'});
  const row=panelRow(page,'F003-open-redirect/orchard.example-open-redirect-F003.md');
  const sev=row.locator('[data-recent-pick="sev"]'), sub=row.locator('[data-recent-pick="sub"]');
  // The index notices the outside ledger change on a later pass; reload until it does.
  await until(async()=>{await page.goto(url);await row.waitFor();return await sev.getAttribute('data-fid')==='AC-3';},'re-mapped AC-3',30000);
  assert.equal(await sev.isDisabled(),true);assert.equal(await sub.isDisabled(),true);
  assert.match(await sev.getAttribute('title'),/AC-3 is not a standard finding ID/);
  assert.match(await sev.getAttribute('aria-label'),/read-only: non-standard finding ID/);
  assert.match(await sub.getAttribute('aria-label'),/read-only: non-standard finding ID/);
  await sev.click({force:true});
  assert.equal(await page.getByRole('menu',{name:'Change severity'}).count(),0,'no picker opens');
  const standard=panelRow(page,REPORT).locator('[data-recent-pick="sev"]');
  assert.equal(await standard.isDisabled(),false);
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
  const toggle=panelRow(page,REPORT2).getByRole('button',{name:/^Mark N\/A/});
  assert.equal(await toggle.getAttribute('aria-pressed'),'false');
  await toggle.click();
  await panel(page).getByText('1 N/A hidden').waitFor();
  await until(async()=>await panelRow(page,REPORT2).count()===0,'row hidden');
  await page.locator('.toast').filter({hasText:'Marked N/A'}).waitFor();
  const stored=JSON.parse(fs.readFileSync(path.join(base,'state/report-na.json'),'utf8'));
  assert.deepEqual(Object.keys(stored),[`web_bounty/orchard/web/${REPORT2}`]);
  assert.equal(fs.statSync(path.join(base,'state/report-na.json')).mode&0o777,0o600);
  // The file is unchanged and still listed by the server.
  assert.match(fs.readFileSync(path.join(base,'data/web_bounty/orchard/web/reports',REPORT2),'utf8'),/Synthetic submission report/);
  await panel(page).getByRole('button',{name:'show'}).click();
  const row=panelRow(page,REPORT2);await row.waitFor();
  assert.equal(await row.evaluate(n=>n.classList.contains('is-na')),true);
  assert.equal(await row.evaluate(n=>getComputedStyle(n).opacity),'0.45');
  assert.match(await row.locator('.na-title').evaluate(n=>getComputedStyle(n).textDecorationLine),/line-through/);
  assert.equal(await row.getByRole('button',{name:/^Unmark N\/A/}).getAttribute('aria-pressed'),'true');
  // The panel remembers "show" per browser.
  await page.reload();
  await panelRow(page,REPORT2).waitFor();
  await panel(page).getByRole('button',{name:'Hide N/A'}).waitFor();
  assert.equal(await page.evaluate(()=>localStorage.getItem('bounty-board-recent-panel-show-na')),'1');
  // Recent view: hidden by default, count and Show; the filter is in the hash.
  await page.goto(`${url}#/recent?within=all&order=newest`);
  await page.locator('.recent-table tr[data-recent-row]').first().waitFor();
  assert.equal(await page.locator(`.recent-table tr[data-path="${REPORT2}"]`).count(),0);
  await page.locator('[data-recent-status]').getByText('1 N/A hidden').waitFor();
  assert.equal(await page.locator('#recent-hide-na').isChecked(),true);
  await page.locator('[data-recent-show-na]').click();
  await until(()=>page.evaluate(()=>location.hash.includes('na=show')),'na=show in the hash');
  const viewRow=page.locator(`.recent-table tr[data-path="${REPORT2}"]`);await viewRow.waitFor();
  assert.equal(await viewRow.evaluate(n=>getComputedStyle(n).opacity),'0.45');
  assert.equal(await page.locator('#recent-hide-na').isChecked(),false);
  // A link with na=show opens with N/A shown; a plain filter link hides them.
  await page.goto(`${url}#/recent?within=all&order=newest&na=show`);await page.reload();
  await page.locator(`.recent-table tr[data-path="${REPORT2}"]`).waitFor();
  await page.locator('#recent-hide-na').check();
  await until(async()=>await page.locator(`.recent-table tr[data-path="${REPORT2}"]`).count()===0,'hidden again');
  assert.ok(!(await page.evaluate(()=>location.hash)).includes('na='));
  // Unmark by keyboard from the view (Show first), Undo re-marks.
  await page.locator('[data-recent-show-na]').click();
  const unmark=page.locator(`.recent-table tr[data-path="${REPORT2}"]`).getByRole('button',{name:/^Unmark N\/A/});
  await unmark.focus();await page.keyboard.press('Enter');
  await until(async()=>(await page.locator(`.recent-table tr[data-path="${REPORT2}"] [data-na-toggle]`).getAttribute('aria-pressed'))==='false','unmarked');
  assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')?.startsWith('Mark N/A')),true,'focus stays on the toggle');
  await page.locator('.toast').filter({hasText:'Unmarked N/A'}).getByRole('button',{name:'Undo'}).click();
  await until(async()=>(await page.locator(`.recent-table tr[data-path="${REPORT2}"] [data-na-toggle]`).getAttribute('aria-pressed'))==='true','undo re-marked');
  // Program Reports list: same toggle and filter, persists across reload.
  await page.goto(`${url}#/programs/web_bounty%2Forchard/web/reports`);await page.reload();
  const list=page.locator('[data-report-browser]');await list.locator('[data-report-row]').first().waitFor();
  await list.getByText('1 N/A hidden').waitFor();
  await list.locator('[data-report-show-na]').click();
  const listRow=list.locator('[data-report-row].is-na');await listRow.waitFor();
  assert.match(await listRow.innerText(),/F002/);
  assert.equal(await page.locator('#report-hide-na').isChecked(),false);
}));

test('no Board state directory: N/A toggles are disabled with the reason',{timeout:90000},()=>withBoard('nostate',async({page})=>{
  const toggle=panelRow(page,REPORT).locator('[data-na-toggle]');
  await toggle.waitFor();
  assert.equal(await toggle.isDisabled(),true);
  assert.match(await toggle.getAttribute('title'),/unavailable/);
}));

// Geometry of every expanded drill-down row (shared by the layout tests).
const rowBoxes=page=>page.locator('.drill li.frow').evaluateAll(list=>list.map(li=>{
  const box=s=>{const n=li.querySelector(s);if(!n)return null;const b=n.getBoundingClientRect();return {top:b.top,bottom:b.bottom,left:b.left,right:b.right,mid:(b.top+b.bottom)/2,h:b.height,w:b.width};};
  const title=li.querySelector('.frow-title'), row=li.getBoundingClientRect();
  return {row:{left:row.left,right:row.right,w:row.width},sev:box('.frow-sev .pick-trigger'),sub:box('.frow-subm .pick-trigger'),links:box('.row-links'),title:box('.frow-title'),subline:box('.frow-sub'),
    sevWidth:li.querySelector('.frow-sev .sev').getBoundingClientRect().width,lineHeight:parseFloat(getComputedStyle(title).lineHeight)||20,clamped:title.scrollHeight>title.clientHeight+1};
}));
const aligned=(boxes,pick,label)=>assert.ok(boxes.every(b=>Math.abs(pick(b)-pick(boxes[0]))<1),`${label}: ${boxes.map(pick).join(', ')}`);

test('finding rows in the half-width panel: pills pinned right and aligned, submission in the subline, two-line titles, severity breakdown pills save',{timeout:120000},()=>withBoard('writer',async({page,finding})=>{
  await page.locator('[data-breakdown="class:xss"]').click();
  await page.locator('.drill li.frow').first().waitFor();
  const boxes=await rowBoxes(page);
  assert.ok(boxes.length>=3,'xss has a long title, a MEDIUM and an EXCEPTIONAL row');
  // The severity pill and the icon column (room for two icons) end at the same x on every row.
  aligned(boxes,b=>b.sev.right,'severity pills right edges');
  aligned(boxes,b=>b.links.left,'icon column left');
  aligned(boxes,b=>b.links.right,'icon column right');
  for(const b of boxes){
    assert.ok(b.links.w>=50,'icon column reserves room for report and evidence');
    // Narrow panel: submission sits in the subline after "ID · status".
    assert.ok(Math.abs(b.sub.mid-b.subline.mid)<4 && b.sub.left>=b.subline.left,`submission in the subline ${JSON.stringify(b)}`);
    assert.ok(b.title.w>=0.45*b.row.w,`title gets at least 45% of the row (${Math.round(b.title.w)} of ${Math.round(b.row.w)})`);
    assert.ok(b.title.h<=2*b.lineHeight+1,'title is at most two lines');
    assert.ok(b.sevWidth<=133,'a long severity is capped');
  }
  assert.ok(boxes.some(b=>b.title.h>1.5*b.lineHeight),'the long title wraps to a second line instead of a short ellipsis');
  // Keyboard: the pills stay focusable buttons in reading order.
  await page.locator('li[data-finding-id="F001"] .frow-title').focus();
  await page.keyboard.press('Tab');
  assert.match(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')||''),/^Severity HIGH/);
  await page.keyboard.press('Tab');
  assert.match(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')||''),/^Submission: /);
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

test('wide panel: severity and submission together on one line, pinned right, aligned',{timeout:90000},()=>withBoard('writer',async({page})=>{
  await page.locator('[data-breakdown="class:xss"]').click();
  await page.locator('.drill li.frow').first().waitFor();
  const boxes=await rowBoxes(page);
  for(const b of boxes){
    assert.ok(Math.abs(b.sev.mid-b.sub.mid)<2 && Math.abs(b.sev.mid-b.links.mid)<2,`one line ${JSON.stringify(b)}`);
    assert.ok(Math.abs(b.sub.left-b.sev.right-6)<=1.5,`pills together: gap ${b.sub.left-b.sev.right}`);
    assert.ok(b.title.w>=0.45*b.row.w,'title keeps most of the row');
    assert.ok(b.title.h<=b.lineHeight+1,'one-line title with ellipsis on wide rows');
  }
  aligned(boxes,b=>b.sub.right,'submission pills right edges');
  aligned(boxes,b=>b.links.left,'icon column left');
},{viewport:{width:1920,height:1080}}));

test('phone width: pills under the title, icons on the right, no overflow; dark theme renders',{timeout:90000},()=>withBoard('writer',async({page})=>{
  await page.locator('[data-breakdown="class:xss"]').click();
  await page.locator('.drill li.frow').first().waitFor();
  const boxes=await rowBoxes(page);
  for(const b of boxes){
    assert.ok(b.sev.top>=b.subline.bottom-1,'pills sit under the title and subline');
    assert.ok(Math.abs(b.sev.mid-b.sub.mid)<2,'severity and submission share a line');
    assert.ok(b.links.right<=b.row.right+1 && b.links.left>=b.title.right-1,'icons on the right, beside the title');
    assert.ok(b.links.bottom<=b.sev.top+1 || b.links.left>=b.sub.right,'icons never overlap the pills');
  }
  aligned(boxes,b=>b.links.left,'icon column left');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth)<=375,'no horizontal overflow');
},{viewport:{width:375,height:812},theme:'dark'}));
