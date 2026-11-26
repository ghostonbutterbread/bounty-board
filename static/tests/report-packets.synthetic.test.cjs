// One report per finding packet (tests/report_packets_fixture.py, synthetic only).
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {chromium}=require('playwright');

const repo=path.resolve(__dirname,'../..');
const shots=process.env.PACKETS_SCREENSHOT_DIR;
const PROGRAM='web_bounty/demo';
const route=(section,tail='')=>`#/programs/${encodeURIComponent(PROGRAM)}/web/${section}${tail?'/'+encodeURIComponent(tail):''}`;
const D15='D15-ssrf/api-target-io-ssrf-D15.md';
const MAINS=[D15,'D16/SUBMISSION.md','D17-redirect/REPORT.md','D19-xss/github-com-stored-xss-D19.md','D20-a/REPORT.md','D20-b/REPORT.md','D21-x/REPORT.md'];
const OTHERS=['findings/low/D20 - Two folders.md','notes.md','_retracted/old.md'];
const META=['D15-ssrf/_meta/notes.md'];
const RECENT=[...MAINS,...OTHERS].sort();
const LISTED=[...MAINS,...OTHERS,...META].sort();
const PACKET_FILES=['D15-ssrf/REPORT.md','D15-ssrf/SUBMISSION.md','D15-ssrf/POC.md','D15-ssrf/JUDGE-RECEIPT-D15.md','D15-ssrf/poc/README.md',
  'D15-ssrf/_archive/api-target-io-ssrf-D15.pre-rewrite-1.md','D16/REPORT.md','D16/SUBMISSION-D16.md','D16/EVIDENCE-D16.md',
  'findings/high/D19 - Stored xss.md','D21-x/REPORT-D21.md'];

async function withBoard(mode,fn){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bpk-'));
  const child=spawn('python3',['-u','tests/report_packets_fixture.py',dir,mode],{cwd:repo,env:{...process.env,PYTHONPATH:repo},stdio:['ignore','pipe','inherit']});
  let browser;
  try {
    const port=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>reject(Error(`fixture exited ${code}`)));child.stdout.once('data',data=>resolve(Number(String(data).trim())));});
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN,args:['--no-sandbox','--disable-dev-shm-usage','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    const context=await browser.newContext({viewport:{width:1280,height:1000}});
    await context.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1' ? r.continue() : r.abort());
    const page=await context.newPage();page.setDefaultTimeout(15000);
    const errors=[];page.on('pageerror',e=>errors.push(String(e)));
    await fn({page,context,base:`http://127.0.0.1:${port}`,errors,reports:path.join(dir,'root/web_bounty/demo/web/reports')});
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
const reportOf=href=>decodeURIComponent(href.split('/reports/')[1]);
// Screenshots: scroll the switcher into view (by query, since quiet refreshes re-render it).
async function reveal(page){await page.waitForTimeout(300);await page.evaluate(()=>document.querySelector('[data-packet-switcher]')?.scrollIntoView({block:'start'}));await page.waitForTimeout(200);}
async function setTheme(page,theme){await page.evaluate(theme=>{localStorage.setItem('bounty-board-theme',theme);document.documentElement.dataset.theme=theme;},theme);}

test('Recent, the Reports list, the picker and search hold one report per packet',{timeout:120000},()=>withBoard('plain',async({page,base})=>{
  // Recent view: one row per packet, the packet time orders it, the newer file is named.
  await page.goto(base+'/#/recent?within=all');
  await until(async()=>(await page.locator('.recent-table [data-recent-row]').count())===RECENT.length,'recent rows');
  assert.deepEqual((await page.locator('.recent-table [data-recent-row]').evaluateAll(rs=>rs.map(r=>r.dataset.path))).sort(),RECENT);
  const first=page.locator('.recent-table [data-recent-row]').first();
  assert.equal(await first.getAttribute('data-path'),D15);
  assert.equal(await first.locator('.recent-updated').innerText(),'Updated poc/request.txt');
  assert.equal(await page.locator('.recent-table [data-recent-row][data-path="notes.md"] .recent-updated').count(),0);
  for(const p of PACKET_FILES)assert.equal(await page.locator(`.recent-table [data-recent-row][data-path="${p}"]`).count(),0,p);
  if(shots){await page.screenshot({path:path.join(shots,'recent-light.png')});await setTheme(page,'dark');await page.reload();await page.locator('.recent-table .recent-updated').first().waitFor();await page.screenshot({path:path.join(shots,'recent-dark.png')});await setTheme(page,'light');}
  // Dashboard panel: same rows, same subline.
  await page.goto(base+'/#/dashboard');
  const dash=page.locator(`#dashboard-recent-host [data-recent-row][data-path="${D15}"]`);
  await dash.waitFor();
  assert.match(await dash.locator('.recent-where').innerText(),/Updated poc\/request\.txt/);
  for(const p of PACKET_FILES)assert.equal(await page.locator(`#dashboard-recent-host [data-recent-row][data-path="${p}"]`).count(),0,p);
  if(shots)await page.locator('#dashboard-recent-host').screenshot({path:path.join(shots,'dashboard-recent-light.png')});

  // Reports list and picker: main reports (and the _meta file, unchanged) only.
  await page.goto(base+'/'+route('reports',D15));
  const picker=page.locator('#report-select');
  await picker.waitFor();
  assert.deepEqual((await picker.locator('option').evaluateAll(os=>os.map(o=>o.value))).sort(),LISTED);
  const listed=await page.locator('[data-report-row] a.report-link').evaluateAll(as=>as.map(a=>a.getAttribute('href')));
  assert.deepEqual(listed.map(reportOf).sort(),LISTED);
  assert.equal(await page.locator('.report-browser summary .count').innerText(),String(LISTED.length));
  assert.match(await page.locator(`[data-report-row] a.report-link[aria-current="page"]`).innerText(),/Updated poc\/request\.txt/);
  // The workspace count says the same.
  assert.match(await page.locator('.summary-line').innerText(),new RegExp(`${LISTED.length}\\s*Reports`));
  assert.equal(await page.locator('.workspace-nav [data-section="reports"] .count').innerText(),String(LISTED.length));

  // Search: report hits never name a packet file.
  await page.keyboard.press('Control+k');
  await page.keyboard.type('zebra');
  await page.locator('.search-results[data-results-for="zebra"]').waitFor();
  const hits=(await page.locator('.search-item a.search-link').evaluateAll(as=>as.map(a=>a.getAttribute('href')))).filter(h=>h.includes('/reports/')).map(reportOf);
  assert.ok(hits.length>0);
  for(const h of hits)assert.ok(RECENT.includes(h),h);
  // Finding hit for D16 opens the SUBMISSION.md main, not the registered REPORT.md.
  await page.locator('#global-search-input').fill('IDOR on invoices');
  await page.locator('.search-results[data-results-for="IDOR on invoices"]').waitFor();
  const open=page.locator('.search-item',{hasText:'D16'}).first().locator('a.search-open-report');
  assert.equal(await open.getAttribute('href'),route('reports','D16/SUBMISSION.md'));
}));

test('Packet files switcher: real links, current marker, collapsed groups; old packet-file URLs open with the main-report note',{timeout:120000},()=>withBoard('plain',async({page,context,base})=>{
  await page.goto(base+'/'+route('reports',D15));
  const nav=page.locator('[data-packet-switcher]');
  await nav.waitFor();
  const links=await nav.locator('a.packet-link').evaluateAll(as=>as.map(a=>({href:a.getAttribute('href'),current:a.getAttribute('aria-current'),text:a.innerText.trim()})));
  assert.equal(reportOf(links[0].href),D15,'main report first');
  assert.equal(links[0].current,'page');
  assert.match(links[0].text,/Main report/);
  assert.deepEqual(links.filter(l=>l.current).length,1);
  const files=await nav.locator('[data-packet-group="files"] a.packet-link').evaluateAll(as=>as.map(a=>a.getAttribute('href')));
  assert.deepEqual(files.map(reportOf),['D15-ssrf/JUDGE-RECEIPT-D15.md','D15-ssrf/POC.md','D15-ssrf/REPORT.md','D15-ssrf/SUBMISSION.md','D15-ssrf/poc/README.md']);
  assert.equal(await nav.locator('[data-packet-group="files"] a.packet-link').first().locator('.packet-link-name').innerText(),'JUDGE-RECEIPT-D15.md','names are packet-relative');
  assert.equal(reportOf(await nav.locator('[data-packet-evidence]').getAttribute('href')),'D15-ssrf/EVIDENCE.md');
  const archive=nav.locator('details[data-packet-group="archive"]');
  assert.equal(await archive.evaluate(d=>d.open),false,'archive collapsed by default');
  assert.equal(reportOf(await archive.locator('a.packet-link').getAttribute('href')),'D15-ssrf/_archive/api-target-io-ssrf-D15.pre-rewrite-1.md');
  assert.equal(await nav.locator('a[href*="_meta"]').count(),0,'_meta stays out of the switcher');
  assert.equal(await page.locator('[data-packet-note]').count(),0);
  if(shots){await reveal(page);await page.screenshot({path:path.join(shots,'switcher-main-light.png')});await setTheme(page,'dark');await page.reload();await nav.waitFor();await reveal(page);await page.screenshot({path:path.join(shots,'switcher-main-dark.png')});await setTheme(page,'light');}

  // Plain click on a packet file stays in the app and opens it.
  await nav.locator('a.packet-link',{hasText:'SUBMISSION.md'}).click();
  await page.locator('[data-packet-note]').waitFor();
  assert.equal(reportOf(page.url()),'D15-ssrf/SUBMISSION.md');
  assert.equal(await page.locator('#report-select').inputValue(),D15,'the picker shows the main report');
  assert.equal(await page.locator('[data-report-missing]').count(),0);
  assert.equal(reportOf(await page.locator('[data-packet-note] a[data-packet-main]').getAttribute('href')),D15);
  assert.match(await page.locator('[data-packet-note]').innerText(),/^Packet file of api-target-io-ssrf-D15\.md, the main report for this finding\.$/);
  assert.equal(reportOf(await page.locator('[data-packet-switcher] a.packet-link[aria-current="page"]').getAttribute('href')),'D15-ssrf/SUBMISSION.md');
  assert.match(await page.locator('.record-value').first().innerText(),/Packet file \| .*Path: D15-ssrf\/SUBMISSION\.md/);
  await page.locator('#report-preview').getByText('zebra submission.').waitFor();

  // Old link to an archived packet file: opens it, with its group open.
  await page.goto(base+'/'+route('reports','D15-ssrf/_archive/api-target-io-ssrf-D15.pre-rewrite-1.md'));
  await page.locator('[data-packet-note]').waitFor();
  assert.equal(await page.locator('details[data-packet-group="archive"]').evaluate(d=>d.open),true);
  await page.locator('#report-preview').getByText('zebra archive.').waitFor();
  if(shots){await reveal(page);await page.screenshot({path:path.join(shots,'switcher-packet-file-light.png')});await setTheme(page,'dark');await page.reload();await page.locator('[data-packet-note]').waitFor();await page.locator('#report-preview').getByText('zebra archive.').waitFor();await reveal(page);await page.screenshot({path:path.join(shots,'switcher-packet-file-dark.png')});await setTheme(page,'light');}

  // Legacy copy: an Older copies entry of D19's main report.
  await page.goto(base+'/'+route('reports','findings/high/D19 - Stored xss.md'));
  await page.locator('[data-packet-note]').waitFor();
  const older=page.locator('details[data-packet-group="older"]');
  assert.equal(await older.evaluate(d=>d.open),true);
  assert.equal(reportOf(await page.locator('[data-packet-note] a[data-packet-main]').getAttribute('href')),'D19-xss/github-com-stored-xss-D19.md');
  await page.locator('[data-packet-note] a[data-packet-main]').click();
  await page.locator('[data-packet-switcher]').waitFor();
  assert.equal(await page.locator('details[data-packet-group="older"]').evaluate(d=>d.open),false,'older copies collapsed on the main report');

  // Ctrl+click opens a packet file in a new tab.
  await page.goto(base+'/'+route('reports','D16/SUBMISSION.md'));
  const link=page.locator('[data-packet-switcher] a.packet-link',{hasText:'REPORT.md'});
  const [tab]=await Promise.all([context.waitForEvent('page'),link.click({modifiers:['Control']})]);
  await tab.waitForLoadState();
  assert.equal(reportOf(tab.url()),'D16/REPORT.md');
  await tab.locator('[data-packet-note]').waitFor();
  await tab.close();
  // A main report without packet files has no switcher.
  await page.goto(base+'/'+route('reports','D20-a/REPORT.md'));
  await page.locator('#report-select').waitFor();
  await page.locator('#report-preview').getByText('zebra.').first().waitFor();
  assert.equal(await page.locator('[data-packet-switcher]').count(),0);
}));

test('finding-row report links go to the packet main report',{timeout:90000},()=>withBoard('plain',async({page,base})=>{
  await page.goto(base+'/'+route('findings'));
  const row=id=>page.locator(`tr[data-finding-id="${id}"]`);
  await row('D15').waitFor();
  const href=async id=>reportOf(await row(id).locator('a.report-ref').getAttribute('href'));
  // Until the lane's report index arrives the link is derived from report_path; wait for the index.
  await until(async()=>await href('D15')===D15,'report index loaded');
  assert.equal(await href('D15'),D15,'ledger names REPORT.md; the vuln-type report is main');
  assert.equal(await href('D16'),'D16/SUBMISSION.md');
  assert.equal(await href('D17'),'D17-redirect/REPORT.md');
  assert.equal(await href('D21'),'D21-x/REPORT.md','absolute report_path from another host');
  assert.equal(await row('D18').locator('a.report-ref').count(),0,'evidence only');
  assert.equal(reportOf(await row('D15').locator('a.evidence-ref').getAttribute('href')),'D15-ssrf/EVIDENCE.md','evidence links unchanged');
  // Dashboard drill rows.
  await page.getByRole('link',{name:'Dashboard',exact:true}).click();
  await page.locator('[data-breakdown="sev:high"]').click();
  const icon=page.locator('.drill li[data-finding-id="D15"] .row-links a.report-icon');
  await icon.waitFor();
  assert.equal(reportOf(await icon.getAttribute('href')),D15);
  await page.locator('[data-breakdown="sev:critical"]').click();
  assert.equal(reportOf(await page.locator('.drill li[data-finding-id="D16"] .row-links a.report-icon').getAttribute('href')),'D16/SUBMISSION.md');
}));

test('editing a packet file saves that file (shared drafts with autosave)',{timeout:90000},()=>withBoard('edit',async({page,base,reports})=>{
  await page.goto(base+'/'+route('reports','D15-ssrf/SUBMISSION.md'));
  await page.locator('[data-packet-note]').waitFor();
  await page.getByText(/Shared draft ready/).waitFor();
  await page.locator('.CodeMirror textarea').focus();await page.keyboard.press('Control+A');await page.keyboard.insertText('# D15 submission\n\nedited in the Board.\n');
  await page.getByText(/Markdown file saved/).waitFor();
  assert.equal(fs.readFileSync(path.join(reports,'D15-ssrf/SUBMISSION.md'),'utf8'),'# D15 submission\n\nedited in the Board.\n');
  assert.match(fs.readFileSync(path.join(reports,D15),'utf8'),/zebra main/,'the main report is untouched');
  assert.equal(await page.locator('#report-select').inputValue(),D15);
}));

test('editing a packet file in the live editor saves that file',{timeout:90000},()=>withBoard('live',async({page,base,reports})=>{
  await page.goto(base+'/'+route('reports','D16/REPORT.md'));
  await page.locator('[data-packet-note]').waitFor();
  const host=page.locator('#live-report-host[data-path="D16/REPORT.md"]');
  await host.locator('.CodeMirror').waitFor();
  await page.locator('[data-live-status]').filter({hasText:/^Saved$/}).waitFor();
  await page.evaluate(()=>{const cm=document.querySelector('#live-report-host .CodeMirror').CodeMirror;cm.focus();cm.setCursor({line:cm.lineCount()-1,ch:0});});
  await page.keyboard.insertText('Live edit on a packet file.\n');
  await until(()=>fs.readFileSync(path.join(reports,'D16/REPORT.md'),'utf8').includes('Live edit on a packet file.'),'live save reached the packet file');
  assert.doesNotMatch(fs.readFileSync(path.join(reports,'D16/SUBMISSION.md'),'utf8'),/Live edit/);
  assert.equal(await page.locator('#report-select').inputValue(),'D16/SUBMISSION.md');
  if(shots){await reveal(page);await page.screenshot({path:path.join(shots,'switcher-live-light.png')});}
}));
