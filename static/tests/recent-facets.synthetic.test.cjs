// Recent facets and Submissions (feat/board-recent-facets) in real Chromium
// against tests/recent_actions_fixture.py (BBH packet-shaped synthetic reports and
// the fake BBH writer). The facet dropdown bar, the Class column, URL keys, the
// "No longer matches" rows, and #/submissions (submitted, valid, duplicate). Synthetic only.
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
const facet=async(page,key)=>{const b=page.locator(`[data-facet-open="${key}"]`);if(await b.getAttribute('aria-expanded')!=='true')await b.click();await page.locator('.facet-popover').waitFor();return page.locator('.facet-popover');};
const facetText=(page,key)=>page.locator(`[data-facet-open="${key}"]`).innerText();
const options=pop=>pop.locator('label.option').evaluateAll(ls=>ls.map(l=>[l.querySelector('.facet-option-label').textContent.trim(),l.querySelector('.count')?.textContent ?? null,l.querySelector('input').checked,l.classList.contains('is-zero')]));
const rowPaths=page=>page.locator('.recent-table tr[data-recent-row]').evaluateAll(rs=>rs.map(r=>r.dataset.path));
const REPORT='F001-stored-xss/orchard.example-xss-F001.md';
const F002='F002-invoice-idor/billing.orchard.example-idor-F002.md', L011='L011-otp-rate-limit/auth.lantern.example-rate-limit-L011.md';
const L010='L010-email-race/lantern.example-race-condition-L010.md', F003='F003-open-redirect/orchard.example-open-redirect-F003.md';

test('Recent filter bar: dropdowns with counts, OR within and AND across facets, chips, URL keys, Class column and sort',{timeout:150000},()=>withBoard('readonly',async({page,url,context})=>{
  const bad=[];context.on('response',r=>{if(r.url().includes('/api/recent-reports')&&r.status()>=400)bad.push(r.url());});
  await page.goto(`${url}#/recent?within=all&order=newest`);
  await page.locator(`.recent-table tr[data-path="${REPORT}"]`).waitFor();
  assert.deepEqual(await page.locator('[data-facet-open]').evaluateAll(bs=>bs.map(b=>b.dataset.facetOpen)),['sub','sev','class','window','program','lane','opts']);
  assert.equal(await facetText(page,'window'),'Modified: All');
  assert.equal(await page.locator('[data-facet-open="window"]').evaluate(b=>b.classList.contains('is-active')),true,'All is not the 7-day default');
  assert.equal(await page.locator('[data-facet-open="sev"]').getAttribute('aria-haspopup'),'true');
  // Class column: category label, subclass muted, raw class in the tooltip; unmapped rows say No finding.
  const row=page.locator(`.recent-table tr[data-path="${F002}"]`);
  assert.equal(await row.locator('td.recent-class').innerText(),'Broken Access Control\nIDOR / object-level');
  assert.equal(await row.locator('.recent-class-label').getAttribute('title'),'Recorded class: idor');
  assert.equal(await page.locator('.recent-table tr[data-program="web_bounty/orchard"][data-path="scratch/unmapped-notes.md"] td.recent-class').innerText(),'No finding');
  // Class dropdown: counts, checking applies at once and keeps the popover open.
  let pop=await facet(page,'class');
  assert.equal(await page.locator('[data-facet-open="class"]').getAttribute('aria-expanded'),'true');
  assert.ok(await pop.getByLabel('Filter Class options').isVisible(),'Class has a filter box');
  const classes=await options(pop);
  assert.deepEqual(classes.find(o=>o[0]==='Cross-Site Scripting'),['Cross-Site Scripting','2',false,false]);
  assert.deepEqual(classes.find(o=>o[0]==='No linked finding'),['No linked finding','2',false,false]);
  await pop.locator('label.option',{hasText:'Cross-Site Scripting'}).locator('input').check();
  await page.waitForFunction(()=>location.hash.includes('class=xss'));
  await page.waitForFunction(()=>document.querySelectorAll('.recent-table tr[data-recent-row]').length===2);
  assert.equal(await page.locator('.facet-popover').count(),1,'stays open');
  assert.equal(await facetText(page,'class'),'Class: Cross-Site Scripting');
  // A facet's counts ignore its own selection; other facets follow it.
  const bac=classes.find(o=>o[0]==='Broken Access Control')[1];
  await page.waitForFunction(()=>document.querySelectorAll('.recent-table tr[data-recent-row]').length===2);
  assert.equal((await options(pop)).find(o=>o[0]==='Broken Access Control')[1],bac,'Class counts ignore the Class selection');
  assert.equal((await options(pop)).find(o=>o[0]==='Cross-Site Scripting')[2],true);
  await pop.locator('label.option',{hasText:'Broken Access Control'}).locator('input').check();
  await page.waitForFunction(n=>document.querySelectorAll('.recent-table tr[data-recent-row]').length===n,2+Number(bac));
  assert.equal(await facetText(page,'class'),'Class: 2');
  // Esc closes and returns focus to the button; one popover at a time.
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.facet-popover').count(),0);
  assert.equal(await page.evaluate(()=>document.activeElement?.dataset.facetOpen),'class');
  pop=await facet(page,'sev');
  const sevs=await options(pop);
  assert.deepEqual(sevs.map(o=>o[0]),['Exceptional','Critical','High','Medium','Low','Info','Unknown','No linked finding']);
  assert.deepEqual(sevs.find(o=>o[0]==='Exceptional'),['Exceptional','0',false,true],'zero counts are muted');
  assert.deepEqual(sevs.find(o=>o[0]==='Critical'),['Critical','1',false,false]);
  // Arrow keys move through the options.
  await pop.locator('input').first().focus();await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(()=>document.activeElement.value),'critical');
  await page.keyboard.press('Space');
  await page.waitForFunction(()=>document.querySelectorAll('.recent-table tr[data-recent-row]').length===1);
  assert.equal(await page.locator('.facet-popover input[value="critical"]').isChecked(),true);
  await facet(page,'lane');
  assert.equal(await page.locator('.facet-popover').count(),1,'one popover at a time');
  // An outside click closes it.
  await page.locator('h1').click();
  assert.equal(await page.locator('.facet-popover').count(),0);
  // Chips: one per value, Remove and Clear all.
  assert.deepEqual(await page.locator('[data-facet-chip]').evaluateAll(cs=>cs.map(c=>[...c.querySelectorAll('span')].map(x=>x.textContent).join(' '))),['Severity Critical','Class Cross-Site Scripting','Class Broken Access Control','Modified All']);
  assert.equal(new URL(page.url()).hash,'#/recent?within=all&sev=critical&class=xss&class=broken_access_control&order=newest');
  await page.getByRole('button',{name:'Remove filter Severity Critical'}).click();
  await page.waitForFunction(n=>document.querySelectorAll('.recent-table tr[data-recent-row]').length===n,2+Number(bac));
  // Submission: Not submitted plus Duplicate (OR), sorted by severity.
  pop=await facet(page,'sub');
  await pop.locator('input[value="not_submitted"]').check();
  await pop.locator('input[value="duplicate"]').check();
  await page.keyboard.press('Escape');
  await page.locator('#recent-order').selectOption('severity');
  await page.waitForFunction(()=>location.hash.includes('order=severity'));
  await page.waitForFunction(()=>document.querySelectorAll('.recent-table tr[data-recent-row]').length===2);
  assert.deepEqual(await rowPaths(page),[REPORT,'findings/medium/F006 - Reflected XSS in search suggestions.md']);
  const link=new URL(page.url()).hash;
  assert.equal(link,'#/recent?within=all&sub=not_submitted&sub=duplicate&class=xss&class=broken_access_control&order=severity');
  // Cold link in a fresh browser restores the view; invalid values fall back and the link is rewritten.
  const cold=await (await context.browser().newContext({viewport:{width:1440,height:900}})).newPage();
  await cold.context().route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
  await cold.goto(`${url}${link}`);
  await cold.waitForFunction(()=>document.querySelectorAll('.recent-table tr[data-recent-row]').length===2);
  assert.equal(await facetText(cold,'sub'),'Submission: Not submitted, Duplicate');
  assert.equal(await cold.locator('#recent-order').inputValue(),'severity');
  await cold.goto(`${url}#/recent?within=all&sev=urgent&sev=high&class=bogus&sub=pending&lane=zzz&lane=web&order=popular`);await cold.reload();
  await cold.waitForFunction(()=>location.hash==='#/recent?within=all&sev=high&lane=web&order=newest');
  await cold.context().close();
  // Clear all returns to the default filters (the sort is not a filter).
  await page.locator('[data-facet-clear-all]').click();
  await page.waitForFunction(()=>location.hash==='#/recent?within=7d&order=severity');
  assert.deepEqual(bad,[],'no rejected requests');
  // Dashboard panel subline names the class.
  await page.getByRole('link',{name:'Dashboard',exact:true}).click();
  const sub=page.locator(`#dashboard-recent-host li[data-path="${F002}"] .recent-where`);
  await sub.waitFor();
  assert.equal(await sub.innerText(),'orchard / web · F002 · Broken Access Control');
}));

test('A pill edit keeps the row in place as "No longer matches" across polls until Refresh list; counts follow',{timeout:150000},()=>withBoard('writer',async({page,url,finding})=>{
  await page.goto(`${url}#/recent?within=all&sub=not_submitted&order=newest`);
  const row=page.locator(`.recent-table tr[data-path="${REPORT}"]`);await row.waitFor();
  const before=await rowPaths(page);
  await row.locator('[data-recent-pick="sub"]').click();
  await page.getByRole('menu',{name:'Submission'}).getByRole('menuitemradio',{name:'Submitted',exact:true}).click();
  await until(()=>finding('orchard','F001').submission?.state==='submitted','F001 submitted');
  await until(async()=>(await row.getAttribute('data-stale'))==='true','row dimmed');
  assert.match(await row.innerText(),/No longer matches/);
  await page.mouse.move(5,5);await page.locator('h1').focus().catch(()=>{});
  assert.ok(Number(await row.locator('td').first().evaluate(n=>getComputedStyle(n).opacity))<0.7,'dimmed');
  // A quiet reload (the 30 s poll path) keeps the row in its place; the count drops.
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('board-report-na',{detail:{}})));
  await until(async()=>/1 row no longer matches/.test(await page.locator('[data-recent-status]').innerText()),'status says kept');
  assert.deepEqual(await rowPaths(page),before,'same rows, same order');
  const pop=await facet(page,'sub');
  await until(async()=>(await options(pop)).find(o=>o[0]==='Not submitted')[1]==='4','facet count follows the edit');
  await page.keyboard.press('Escape');
  // Refresh list starts clean.
  await page.locator('[data-recent-refresh]').click();
  await until(async()=>!(await rowPaths(page)).includes(REPORT),'row leaves after Refresh list');
}));

test('Submissions lists submitted, valid and duplicate reports as Recent rows; Duplicate filter; empty states; kept rows',{timeout:150000},()=>withBoard('writer',async({page,url,finding})=>{
  const nav=page.locator('.nav a[data-view]');
  assert.deepEqual(await nav.evaluateAll(as=>as.map(a=>a.dataset.view)),['dashboard','recent','submissions','recon','program','settings']);
  await page.locator('.nav a[data-view="submissions"]').click();
  await page.locator('.recent-table tr[data-recent-row]').first().waitFor();
  assert.equal(await page.title(),'Submissions · Bounty Board');
  assert.equal(await page.locator('#breadcrumb').innerText(),'Submissions');
  assert.equal(new URL(page.url()).hash,'#/submissions?within=all&order=newest');
  assert.equal(await page.locator('.nav a[data-view="submissions"]').getAttribute('aria-current'),'page');
  // Submitted (valid) F002 and duplicate L011; never dropped, not-submitted or unmapped rows.
  assert.deepEqual((await rowPaths(page)).sort(),[F002,L011].sort());
  let pop=await facet(page,'sub');
  assert.deepEqual((await options(pop)).map(o=>[o[0],o[1]]),[['Awaiting result','0'],['Valid','1'],['Duplicate','1']]);
  await pop.locator('input[value="duplicate"]').check();
  await page.keyboard.press('Escape');
  await page.waitForFunction(()=>location.hash==='#/submissions?within=all&sub=duplicate&order=newest');
  await page.waitForFunction(()=>document.querySelectorAll('.recent-table tr[data-recent-row]').length===1);
  assert.deepEqual(await rowPaths(page),[L011]);
  // Severity Exceptional: no match, so the filtered empty state with Clear filters.
  pop=await facet(page,'sev');
  assert.equal(await pop.locator('input[value="none"]').count(),0,'every submission has a finding');
  await pop.locator('input[value="exceptional"]').check();await page.keyboard.press('Escape');
  await page.locator('.recent-panel .empty',{hasText:'No reports match these filters'}).waitFor();
  await page.locator('.recent-panel .empty [data-recent-clear]').click();
  await page.waitForFunction(()=>location.hash==='#/submissions?within=all&order=newest');
  // Own memory: Recent's filters are not Submissions' filters.
  await page.goto(`${url}#/recent`);await page.reload();
  await page.waitForFunction(()=>location.hash==='#/recent?within=7d&order=newest');
  // An edit that moves a row out of the filter keeps it, dimmed, until Refresh list.
  // (F002 has a recorded Valid result, which BBH cannot clear, so it stays a submission;
  // the severity filter is the one that stops matching here.)
  await page.goto(`${url}#/submissions?within=all&sev=critical&order=newest`);await page.reload();
  const row=page.locator(`.recent-table tr[data-path="${F002}"]`);await row.waitFor();
  assert.match(await row.locator('td.recent-class').innerText(),/Broken Access Control/);
  await row.locator('[data-recent-pick="sev"]').click();
  await page.getByRole('menu',{name:'Change severity'}).getByRole('menuitemradio',{name:'High'}).click();
  await until(()=>finding('orchard','F002').severity==='HIGH','F002 now HIGH');
  await until(async()=>(await row.getAttribute('data-stale'))==='true','row kept and dimmed');
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('board-report-na',{detail:{}})));
  await page.waitForTimeout(600);
  assert.equal(await row.getAttribute('data-stale'),'true','kept across a quiet reload');
  await page.locator('[data-recent-refresh]').click();
  await until(async()=>!(await rowPaths(page)).includes(F002),'gone after Refresh list');
}));

test('Default Submissions empty state, and the bar at 375 px: wraps, popover inside the viewport, no sideways scroll',{timeout:150000},()=>withBoard('readonly',async({page,url})=>{
  // No submitted reports at all (server answer stubbed): the default empty state, without Clear filters.
  await page.route('**/api/recent-reports?*',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({index_state:'ready',root_instance:null,now:Date.now()/1000,total:0,total_reports:0,offset:0,limit:50,order:'newest',items:[],na_available:true,na_hidden:0,na_hidden_page:0,facets:{programs:[],lanes:[],severities:[],classes:[],submissions:[]},warnings:[]})}));
  await page.goto(`${url}#/submissions`);await page.reload();
  await page.locator('.recent-panel .empty',{hasText:'No submitted reports yet'}).waitFor();
  assert.equal(await page.locator('.recent-panel .empty [data-recent-clear]').count(),0);
  await page.unroute('**/api/recent-reports?*');
  await page.setViewportSize({width:375,height:800});
  await page.goto(`${url}#/recent?within=all&order=newest`);
  await page.locator('.recent-table tr[data-recent-row]').first().waitFor();
  const pop=await facet(page,'program');
  const box=await pop.boundingBox();
  assert.ok(box.x>=0 && box.x+box.width<=375,`popover inside the viewport: ${JSON.stringify(box)}`);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=375),'no horizontal overflow');
  await page.keyboard.press('Escape');
  for(const key of ['sub','sev','class','window','program','lane','opts']){
    const b=await page.locator(`[data-facet-open="${key}"]`).boundingBox();
    assert.ok(b.x>=0 && b.x+b.width<=375,`${key} button fits`);
  }
}));

// Review round 1, R1: rows whose finding is not in the loaded workspace (cold start,
// summary mode) are built from the server's item.finding; under a Class filter they
// must not be drawn as "No longer matches".
test('R1: cold-start rows are not falsely "No longer matches" under a class filter',{timeout:90000},()=>withBoard('readonly',async({page,url})=>{
  await page.evaluate(()=>{window.BoardFindingActions.entry=()=>null;}); // finding not in the loaded workspace
  await page.goto(`${url}#/recent?within=all&class=xss&order=newest`);
  await page.locator(`.recent-table tr[data-path="${REPORT}"]`).waitFor();
  const stale=await page.locator('.recent-table tr[data-stale="true"]').evaluateAll(rs=>rs.map(r=>r.dataset.path));
  assert.deepEqual(stale,[],'the server returned these rows for class=xss');
  assert.doesNotMatch(await page.locator('[data-recent-status]').innerText(),/no longer match/);
}));
