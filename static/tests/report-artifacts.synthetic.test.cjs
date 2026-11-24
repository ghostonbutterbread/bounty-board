// Report artifacts panel on a synthetic fixture (tests/report_artifacts_fixture.py).
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {chromium}=require('playwright');

const repo=path.resolve(__dirname,'../..');
const shots=process.env.ARTIFACT_SCREENSHOT_DIR;

async function withBoard(mode,fn){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ba-'));
  const child=spawn('python3',['-u','tests/report_artifacts_fixture.py',dir,mode],{cwd:repo,env:{...process.env,PYTHONPATH:repo},stdio:['ignore','pipe','inherit']});
  let browser;
  try {
    const port=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>reject(Error(`fixture exited ${code}`)));child.stdout.once('data',data=>resolve(Number(String(data).trim())));});
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN,args:['--no-sandbox','--disable-dev-shm-usage','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1','--autoplay-policy=no-user-gesture-required']});
    const context=await browser.newContext({acceptDownloads:true,viewport:{width:1280,height:1400}});
    await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1' ? route.continue() : route.abort());
    const page=await context.newPage();
    const errors=[];page.on('pageerror',e=>errors.push(String(e)));
    await fn({page,context,base:`http://127.0.0.1:${port}`,lane:path.join(dir,'root/web_bounty/alpha/web'),errors});
  } finally {
    if(browser)await browser.close();
    child.kill('SIGTERM');await new Promise(resolve=>child.exitCode!==null||child.signalCode!==null?resolve():child.once('exit',resolve));
    fs.rmSync(dir,{recursive:true,force:true});
  }
}

async function openReport(page,base,report){
  await page.goto(base);
  await page.getByRole('button',{name:'Open workspace'}).click();
  await page.getByRole('link',{name:'Reports',exact:true}).click();
  await page.locator('#report-select').selectOption(report);
  await page.locator(`#report-artifacts-host[data-path="${report}"] .artifact-row`).first().waitFor({timeout:10000});
}

test('non-live report view lists, previews and downloads artifacts safely',{timeout:60000},async()=>{
  await withBoard('plain',async({page,base,lane,errors})=>{
    await openReport(page,base,'F1/REPORT.md');
    const host=page.locator('#report-artifacts-host');
    assert.equal(await host.getAttribute('data-program'),'alpha');
    assert.match(await host.locator('h3').textContent(),/Artifacts \(11\)/);
    const rows=await host.locator('.artifact-row').evaluateAll(rs=>rs.map(r=>r.dataset.artifact));
    for(const name of ['reports/F1/poc/demo.mp4','reports/F1/poc/exploit.py','reports/F1/poc/payload.js','reports/F1/evidence/screenshot.png','reports/F1/evidence/diagram.svg','reports/F1/evidence/page.html','evidence/F1-replay.js'])assert.ok(rows.includes(name),name);
    assert.ok(!rows.some(r=>/REPORT\.md|_meta|\.hidden|escape|pycache/.test(r)));
    // Groups and link reasons.
    assert.deepEqual(await host.locator('.artifact-group').evaluateAll(gs=>gs.map(g=>g.dataset.category)),['video','image','code','data','capture']);
    assert.match(await host.locator('[data-artifact="reports/F1/poc/demo.mp4"] .artifact-reason').textContent(),/Report folder: report_dir of finding F1; Linked from report: poc\/demo\.mp4/);
    assert.match(await host.locator('[data-artifact="evidence/F1-replay.js"] .artifact-reason').textContent(),/Finding field: poc of finding F1/);
    assert.match(await host.locator('[data-artifact="evidence/F1-replay.js"] .artifact-meta').textContent(),/Outside the report folder/);
    assert.doesNotMatch(await host.locator('[data-artifact="reports/F1/poc/exploit.py"] .artifact-meta').textContent(),/Outside/);
    // Sensitive: badge and no preview button.
    const har=host.locator('[data-artifact="reports/F1/evidence/capture.har"]');
    assert.equal(await har.locator('.artifact-badge').count(),1);
    assert.equal(await har.locator('[data-artifact-preview]').count(),0);
    assert.equal(await page.locator('#report-artifacts-host video, #report-artifacts-host img, #report-artifacts-host pre').count(),0,'no automatic previews');

    // Text preview uses textContent: script markup stays text.
    await host.locator('[data-artifact-preview="reports/F1/evidence/page.html"]').click();
    const pre=host.locator('[data-artifact="reports/F1/evidence/page.html"] pre');
    await pre.waitFor();
    assert.match(await pre.textContent(),/<script>window\.htmlRan=1<\/script>/);
    assert.equal(await host.locator('[data-artifact="reports/F1/evidence/page.html"] script').count(),0);
    await host.locator('[data-artifact-preview="reports/F1/evidence/diagram.svg"]').click();
    await host.locator('[data-artifact="reports/F1/evidence/diagram.svg"] pre').waitFor();
    assert.equal(await host.locator('[data-artifact="reports/F1/evidence/diagram.svg"] svg, [data-artifact="reports/F1/evidence/diagram.svg"] img').count(),0);
    // Long text is capped.
    await host.locator('[data-artifact-preview="reports/F1/evidence/notes.txt"]').click();
    await host.getByText(/Showing the first 64 KB of/).waitFor();
    const notesLength=await host.locator('[data-artifact="reports/F1/evidence/notes.txt"] pre').evaluate(p=>p.textContent.length);
    assert.equal(notesLength,64*1024);
    assert.doesNotMatch(await host.locator('[data-artifact="reports/F1/evidence/notes.txt"] .artifact-preview').textContent(),/null/);
    // Image and video previews through the media endpoint.
    await host.locator('[data-artifact-preview="reports/F1/evidence/screenshot.png"]').click();
    const img=host.locator('[data-artifact="reports/F1/evidence/screenshot.png"] img');
    await page.waitForFunction(()=>document.querySelector('[data-artifact="reports/F1/evidence/screenshot.png"] img')?.naturalWidth===24);
    assert.match(await img.getAttribute('src'),/^\/api\/report-artifact-media\?/);
    await host.locator('[data-artifact-preview="reports/F1/poc/demo.mp4"]').click();
    await page.waitForFunction(()=>document.querySelector('[data-artifact="reports/F1/poc/demo.mp4"] video')?.readyState>=1,null,{timeout:10000});
    assert.equal(await host.locator('[data-artifact-preview="reports/F1/poc/demo.mp4"]').getAttribute('aria-expanded'),'true');
    await page.evaluate(()=>window.scrollTo(0,document.querySelector('#report-artifacts-host').offsetTop-20));
    if(shots){
      fs.mkdirSync(shots,{recursive:true});await page.locator('#report-artifacts-host').screenshot({path:path.join(shots,'report-artifacts-panel.png')});
      await page.locator('#theme').selectOption('dark');
      await host.locator('[data-artifact="reports/F1/poc/demo.mp4"] video').waitFor();
      await page.locator('#report-artifacts-host').screenshot({path:path.join(shots,'report-artifacts-panel-dark.png')});
      await page.locator('#theme').selectOption('light');
    }

    // SVG, HTML and JS download rather than render; nothing executed.
    for(const [artifact,file] of [['reports/F1/evidence/diagram.svg','diagram.svg'],['reports/F1/evidence/page.html','page.html'],['reports/F1/poc/payload.js','payload.js'],['reports/F1/poc/exploit.py','exploit.py'],['reports/F1/poc/demo.mp4','demo.mp4']]){
      const [download]=await Promise.all([page.waitForEvent('download'),host.locator(`[data-artifact-download="${artifact}"]`).click()]);
      assert.equal(download.suggestedFilename(),file);
      assert.deepEqual(fs.readFileSync(await download.path()),fs.readFileSync(path.join(lane,artifact)),artifact);
    }
    assert.equal(await page.evaluate(()=>[window.svgRan,window.htmlRan].filter(Boolean).length),0);
    // Navigating straight to the SVG or HTML URL does not render it either.
    const direct=await page.context().newPage();
    const [download]=await Promise.all([direct.waitForEvent('download'),direct.goto(`${base}/api/report-artifact?family=web_bounty&program=alpha&lane=web&path=F1%2FREPORT.md&artifact=reports%2FF1%2Fevidence%2Fpage.html`).catch(()=>null)]);
    assert.equal(download.suggestedFilename(),'page.html');
    await direct.close();
    // Download all.
    const [zip]=await Promise.all([page.waitForEvent('download'),host.locator('[data-artifacts-zip]').click()]);
    assert.equal(zip.suggestedFilename(),'F1-artifacts.zip');
    assert.equal(fs.readFileSync(await zip.path()).subarray(0,2).toString(),'PK');

    // The editor keeps working and keeps its draft while the panel is open.
    await page.locator('.CodeMirror textarea').focus();
    await page.keyboard.press('Control+End');await page.keyboard.insertText('\nlocal draft line');
    assert.match(await page.locator('#report-preview').textContent(),/local draft line/);
    await host.locator('[data-artifact="reports/F1/poc/demo.mp4"] video').waitFor();
    assert.equal(await host.locator('[data-artifact-preview="reports/F1/evidence/page.html"]').getAttribute('aria-expanded'),'true','open previews survive re-render');

    // Selecting another report swaps the list; a flat shared folder shows only its links.
    await page.locator('#report-select').selectOption('findings/confirmed/F2 - HIGH - sample.md');
    await page.locator('#report-artifacts-host[data-path="findings/confirmed/F2 - HIGH - sample.md"] .artifact-row').waitFor();
    assert.deepEqual(await host.locator('.artifact-row').evaluateAll(rs=>rs.map(r=>r.dataset.artifact)),['reports/findings/confirmed/F2-log.txt']);
    await host.getByText(/shared with other findings/).waitFor();
    await page.locator('#report-select').selectOption('findings/confirmed/F3 - LOW - other.md');
    await page.locator('#report-artifacts-host[data-path="findings/confirmed/F3 - LOW - other.md"]').getByText('No artifacts found for this report.').waitFor();
    // Back to F1: draft retained.
    await page.locator('#report-select').selectOption('F1/REPORT.md');
    await page.locator('#report-artifacts-host[data-path="F1/REPORT.md"] .artifact-row').first().waitFor();
    assert.match(await page.locator('#report-preview').textContent(),/local draft line/);

    // Refresh picks up a new file.
    fs.writeFileSync(path.join(lane,'reports/F1/poc/added.py'),'print(2)\n');
    await host.locator('[data-artifacts-refresh]').click();
    await host.locator('[data-artifact="reports/F1/poc/added.py"]').waitFor();
    assert.equal(await page.getByRole('button',{name:'Refresh'}).count(),1,'global Refresh stays unique');
    assert.deepEqual(errors,[]);
  });
});

test('live report view mounts the artifacts panel and handles unavailable reports',{timeout:45000},async()=>{
  await withBoard('live',async({page,base,errors})=>{
    await openReport(page,base,'F1/REPORT.md');
    assert.equal(await page.locator('#live-report-host').count(),1);
    assert.match(await page.locator('#report-artifacts-host h3').textContent(),/Artifacts \(11\)/);
    await page.route('**/api/report-artifacts?*',route=>route.fulfill({status:404,contentType:'application/json',body:'{"error":"artifact_not_found_or_unavailable"}'}));
    await page.locator('[data-artifacts-refresh]').click();
    await page.getByText('The artifact list failed to load for this report. Reload the list to retry.').waitFor();
    assert.deepEqual(errors,[]);
  });
});
