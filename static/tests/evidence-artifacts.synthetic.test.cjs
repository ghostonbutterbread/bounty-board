// Evidence files are artifacts, not reports (tests/evidence_artifacts_fixture.py, synthetic only).
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {chromium}=require('playwright');

const repo=path.resolve(__dirname,'../..');
const shots=process.env.EVIDENCE_SCREENSHOT_DIR;
const PROGRAM='web_bounty/demo';
const route=(section,tail='')=>`#/programs/${encodeURIComponent(PROGRAM)}/web/${section}${tail?'/'+encodeURIComponent(tail):''}`;
const EVIDENCE=['F01-xss/EVIDENCE.md','F01-xss/EVIDENCE-2.md','F02-idor/EVIDENCE.md','F03-loose/evidence.md','F03-loose/notes/deep/EVIDENCE.md','proof/F04-capture.md','proof/F07-trace.md','proof/F09-notes.md'];
const REPORTS=['F01-xss/demo-xss-F01.md','F05/EVIDENCE.md','notes.md'];

async function withBoard(mode,fn){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bev-'));
  const child=spawn('python3',['-u','tests/evidence_artifacts_fixture.py',dir,mode],{cwd:repo,env:{...process.env,PYTHONPATH:repo},stdio:['ignore','pipe','inherit']});
  let browser;
  try {
    const port=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>reject(Error(`fixture exited ${code}`)));child.stdout.once('data',data=>resolve(Number(String(data).trim())));});
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN,args:['--no-sandbox','--disable-dev-shm-usage','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    const context=await browser.newContext({viewport:{width:1280,height:1000}});
    await context.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1' ? r.continue() : r.abort());
    const page=await context.newPage();page.setDefaultTimeout(15000);
    const errors=[];page.on('pageerror',e=>errors.push(String(e)));
    await fn({page,context,base:`http://127.0.0.1:${port}`,errors});
    assert.deepEqual(errors,[]);
  } finally {
    if(browser)await browser.close();
    child.kill('SIGTERM');await new Promise(resolve=>child.exitCode!==null||child.signalCode!==null?resolve():child.once('exit',resolve));
    fs.rmSync(dir,{recursive:true,force:true});
  }
}
async function until(check,label,timeout=15000){
  const end=Date.now()+timeout;
  while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,100));}
  throw new Error(`timed out: ${label}`);
}
async function evidenceView(page,evidencePath){
  const view=page.locator(`[data-evidence-view][data-evidence-path="${evidencePath}"]`);
  await view.waitFor();
  return view;
}
async function assertNoEditor(page){
  for(const selector of ['#report-select','.CodeMirror','#report-source','#live-report-host','[data-report-missing]','.editor-toolbar'])
    assert.equal(await page.locator(selector).count(),0,selector);
}

test('evidence is absent from the Reports list, picker, Recent and search; the submission report lists it as an artifact',{timeout:90000},()=>withBoard('plain',async({page,base})=>{
  await page.goto(base+'/'+route('reports','F01-xss/demo-xss-F01.md'));
  const picker=page.locator('#report-select');
  await picker.waitFor();
  assert.deepEqual((await picker.locator('option').evaluateAll(os=>os.map(o=>o.value))).sort(),REPORTS.slice().sort());
  const listed=await page.locator('[data-report-row] a.report-link').evaluateAll(as=>as.map(a=>decodeURIComponent(a.getAttribute('href').split('/reports/')[1])));
  assert.deepEqual(listed.sort(),REPORTS.slice().sort());
  assert.equal(await page.locator('.report-browser summary .count').innerText(),String(REPORTS.length));
  assert.doesNotMatch(await page.locator('#app').innerText(),/Generated evidence/);
  // The submission report's artifacts panel keeps EVIDENCE.md (folder rule).
  const host=page.locator('#report-artifacts-host[data-path="F01-xss/demo-xss-F01.md"]');
  await host.locator('[data-artifact="reports/F01-xss/EVIDENCE.md"]').waitFor();
  await host.locator('[data-artifact="reports/F01-xss/poc/request.txt"]').waitFor();
  if(shots)await page.screenshot({path:path.join(shots,'submission-report-artifacts-light.png'),fullPage:true});

  // Recent: only reports.
  await page.goto(base+'/#/recent');
  await page.locator('.recent-table [data-recent-row]').first().waitFor();
  await until(async()=>(await page.locator('.recent-table [data-recent-row]').count())===REPORTS.length,'recent rows');
  assert.deepEqual((await page.locator('.recent-table [data-recent-row]').evaluateAll(rs=>rs.map(r=>r.dataset.path))).sort(),REPORTS.slice().sort());
  // Including generated and _meta files still never shows evidence.
  await page.locator('[data-facet-open="opts"]').click();await page.locator('#recent-nav').check();await page.keyboard.press('Escape'); // filter bar (feat/board-recent-facets)
  await page.waitForTimeout(800);
  for(const p of EVIDENCE)assert.equal(await page.locator(`.recent-table [data-recent-row][data-path="${p}"]`).count(),0,p);

  // Search: evidence text never produces a report hit; finding hits link evidence as evidence.
  await page.keyboard.press('Control+k');
  await page.keyboard.type('zebra');
  await page.locator('.search-results[data-results-for="zebra"]').waitFor();
  const hits=await page.locator('.search-item a.search-link').evaluateAll(as=>as.map(a=>a.getAttribute('href')));
  for(const p of EVIDENCE)assert.ok(!hits.some(h=>h.endsWith(encodeURIComponent(p))),p);
  assert.ok(hits.some(h=>h.endsWith(encodeURIComponent('notes.md'))));
  await page.locator('#global-search-input').fill('Evidence only idor');
  await page.locator('.search-results[data-results-for="Evidence only idor"]').waitFor();
  const finding=page.locator('.search-item',{hasText:'F02'}).first();
  const open=finding.locator('a.search-open-report');
  assert.equal(await open.innerText(),'Open evidence');
  assert.equal(await open.getAttribute('href'),route('reports','F02-idor/EVIDENCE.md'));
  assert.match(await finding.innerText(),/evidence, no report yet/);
  await open.click();
  const view=await evidenceView(page,'F02-idor/EVIDENCE.md');
  assert.match(await view.locator('h2').innerText(),/Evidence for finding F02/);
  await assertNoEditor(page);
}));

test('finding rows link evidence with real anchors; old evidence URLs open the read-only artifact view',{timeout:120000},()=>withBoard('plain',async({page,context,base})=>{
  await page.goto(base+'/'+route('findings'));
  const row=id=>page.locator(`tr[data-finding-id="${id}"]`);
  await row('F01').waitFor();
  const evidenceLink=id=>row(id).locator('a.evidence-ref');
  assert.equal(await evidenceLink('F01').getAttribute('href'),route('reports','F01-xss/EVIDENCE.md'));
  assert.equal(await evidenceLink('F01').getAttribute('aria-label'),'Evidence: F01-xss/EVIDENCE.md');
  assert.equal(await row('F01').locator('a.report-ref').getAttribute('href'),route('reports','F01-xss/demo-xss-F01.md'));
  assert.equal(await evidenceLink('F02').getAttribute('href'),route('reports','F02-idor/EVIDENCE.md'));
  assert.equal(await evidenceLink('F04').getAttribute('href'),route('reports','proof/F04-capture.md'));
  assert.equal(await evidenceLink('F07').getAttribute('href'),route('reports','proof/F07-trace.md'),'absolute path from another host');
  assert.equal(await evidenceLink('F09').getAttribute('href'),route('reports','proof/F09-notes.md'),'x/../reports path normalised like the backend');
  assert.equal(await evidenceLink('F05').count(),0,'a report_path named EVIDENCE.md is the report');
  await evidenceLink('F02').hover();
  await page.getByRole('tooltip').getByText('Open evidence: F02-idor/EVIDENCE.md').waitFor();

  // Dashboard drill-down rows: icon in .row-links beside the report icon.
  await page.getByRole('link',{name:'Dashboard',exact:true}).click();
  await page.locator('[data-breakdown="sev:high"]').click();
  const f01=page.locator('.drill li[data-finding-id="F01"] .row-links');
  await f01.waitFor();
  assert.deepEqual(await f01.locator('a').evaluateAll(as=>as.map(a=>a.className.split(' ').find(c=>c==='report-icon'||c==='evidence-icon'))),['report-icon','evidence-icon']);
  await page.locator('[data-breakdown="sev:critical"]').click();
  const icon=page.locator('.drill li[data-finding-id="F02"] .row-links a.evidence-icon');
  assert.equal(await icon.getAttribute('href'),route('reports','F02-idor/EVIDENCE.md'));
  assert.equal(await icon.getAttribute('aria-label'),'Evidence: F02-idor/EVIDENCE.md');
  assert.equal(await icon.locator('i.fa-paperclip').count(),1);
  if(shots){await icon.hover();await page.waitForTimeout(200);await page.locator('#drill-sev-critical').screenshot({path:path.join(shots,'dashboard-drill-light.png')});}
  // Ctrl+click opens a new tab on the evidence view; a plain click stays in the app.
  const [tab]=await Promise.all([context.waitForEvent('page'),icon.click({modifiers:['Control']})]);
  await tab.waitForLoadState();
  await evidenceView(tab,'F02-idor/EVIDENCE.md');
  await tab.close();
  const pages=context.pages().length;
  await icon.click();
  await evidenceView(page,'F02-idor/EVIDENCE.md');
  assert.equal(context.pages().length,pages);
  assert.equal(new URL(page.url()).hash,route('reports','F02-idor/EVIDENCE.md'));

  // Old URL of a packet's EVIDENCE.md: heading, finding and report links, safe preview, artifacts, no editor.
  await page.goto(base+'/'+route('reports','F01-xss/EVIDENCE.md'));
  const view=await evidenceView(page,'F01-xss/EVIDENCE.md');
  assert.match(await view.locator('h2').innerText(),/Evidence for finding F01/);
  await until(async()=>/^Evidence for F01 · Reports · .+ · Bounty Board$/.test(await page.title()),'tab title names the evidence, not a report');
  assert.equal(await view.locator('h2 a[data-evidence-finding="F01"]').getAttribute('href'),route('findings','F01'));
  assert.equal(await view.locator('[data-evidence-report]').getAttribute('href'),route('reports','F01-xss/demo-xss-F01.md'));
  await view.locator('#evidence-preview h1',{hasText:'Evidence F01'}).waitFor();
  const host=page.locator('#report-artifacts-host[data-path="F01-xss/EVIDENCE.md"]');
  await host.locator('[data-artifact="reports/F01-xss/demo-xss-F01.md"]').waitFor();
  await host.locator('[data-artifact="reports/F01-xss/poc/request.txt"]').waitFor();
  await assertNoEditor(page);
  assert.equal(await page.locator('[data-na-toggle][data-na-path="F01-xss/EVIDENCE.md"]').count(),0);
  if(shots){
    await page.waitForTimeout(300);
    await page.screenshot({path:path.join(shots,'evidence-view-light.png'),fullPage:true});
    await page.evaluate(()=>{localStorage.setItem('bounty-board-theme','dark');});
    await page.reload();await evidenceView(page,'F01-xss/EVIDENCE.md');await host.locator('[data-artifact]').first().waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({path:path.join(shots,'evidence-view-dark.png'),fullPage:true});
    await page.goto(base+'/'+route('findings'));await row('F01').waitFor();
    await page.screenshot({path:path.join(shots,'finding-rows-dark.png')});
    await page.evaluate(()=>{localStorage.setItem('bounty-board-theme','light');});
    await page.reload();await row('F01').waitFor();
    await page.screenshot({path:path.join(shots,'finding-rows-light.png')});
  }
  // Following the report link opens the submission report, not another evidence view.
  await page.goto(base+'/'+route('reports','F01-xss/EVIDENCE.md'));
  await (await evidenceView(page,'F01-xss/EVIDENCE.md')).locator('[data-evidence-report]').click();
  await until(async()=>(await page.locator('#report-select').count())===1 && await page.locator('#report-select').inputValue()==='F01-xss/demo-xss-F01.md','report opened');

  // Unowned evidence (name only), and a missing EVIDENCE.md: still the artifact view, never not-found.
  await page.goto(base+'/'+route('reports','F03-loose/evidence.md'));
  assert.match(await (await evidenceView(page,'F03-loose/evidence.md')).locator('h2').innerText(),/Evidence file/);
  await page.goto(base+'/'+route('reports','gone/EVIDENCE.md'));
  await (await evidenceView(page,'gone/EVIDENCE.md')).locator('[data-evidence-error]').waitFor();
  await assertNoEditor(page);
  // A report_path named EVIDENCE.md opens as a report; an unknown non-evidence path keeps not-found.
  await page.goto(base+'/'+route('reports','F05/EVIDENCE.md'));
  await until(async()=>(await page.locator('#report-select').count())===1 && await page.locator('#report-select').inputValue()==='F05/EVIDENCE.md','F05 report');
  assert.equal(await page.locator('[data-evidence-view]').count(),0);
  await page.goto(base+'/'+route('reports','gone/missing.md'));
  await page.locator('[data-report-missing]').waitFor();
}));

test('evidence content appears when workspace data is replaced during its fetch (cold load, Refresh)',{timeout:90000},()=>withBoard('plain',async({page,base})=>{
  // Delay /api/report so the phased summary->full swap (cold load) or a Refresh
  // replaces the program and lane objects while the evidence fetch is in flight.
  const delays=[300];
  await page.route('**/api/report?**',async r=>{const d=delays.shift();if(d)await new Promise(x=>setTimeout(x,d));await r.continue();});
  await page.goto(base+'/'+route('reports','F01-xss/EVIDENCE.md'));
  await (await evidenceView(page,'F01-xss/EVIDENCE.md')).locator('#evidence-preview h1',{hasText:'Evidence F01'}).waitFor({timeout:8000});
  delays.push(2500);
  await page.evaluate(hash=>{location.hash=hash;},route('reports','F02-idor/EVIDENCE.md'));
  const view=await evidenceView(page,'F02-idor/EVIDENCE.md');
  await view.locator('.state',{hasText:'Loading evidence'}).waitFor();
  await page.locator('#refresh').click();
  await view.locator('#evidence-preview h1',{hasText:'Evidence F02'}).waitFor({timeout:10000});
}));

test('live-edit mode: evidence opens the artifact view, never the live editor',{timeout:90000},()=>withBoard('live',async({page,base})=>{
  await page.goto(base+'/'+route('reports','F01-xss/demo-xss-F01.md'));
  await page.locator('#live-report-host[data-path="F01-xss/demo-xss-F01.md"]').waitFor();
  await page.goto(base+'/'+route('reports','F01-xss/EVIDENCE.md'));
  const view=await evidenceView(page,'F01-xss/EVIDENCE.md');
  await view.locator('#evidence-preview h1',{hasText:'Evidence F01'}).waitFor();
  await page.locator('#report-artifacts-host[data-path="F01-xss/EVIDENCE.md"] [data-artifact="reports/F01-xss/demo-xss-F01.md"]').waitFor();
  await page.waitForTimeout(500);
  await assertNoEditor(page);
  // In-app navigation from a live report to evidence tears nothing into an editor either.
  await page.goto(base+'/'+route('findings'));
  await page.locator('tr[data-finding-id="F02"] a.evidence-ref').click();
  await evidenceView(page,'F02-idor/EVIDENCE.md');
  await assertNoEditor(page);
}));
