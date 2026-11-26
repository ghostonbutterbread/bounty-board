// Deleting report artifacts from the artifacts panel, on the synthetic
// fixture (tests/report_artifacts_fixture.py) with --artifact-uploads.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {chromium}=require('playwright');

const repo=path.resolve(__dirname,'../..');
const shots=process.env.ARTIFACT_SCREENSHOT_DIR;

const RUNNER=`
import sys
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(repo)})
import app, artifact_uploads as au
from tests.report_artifacts_fixture import build
target, mode = Path(sys.argv[1]), sys.argv[2]
lane = build(target / 'root')
(lane / 'reports/F1/notes.MARKDOWN').write_text('# draft notes\\n')
(lane / 'reports/F1/a-very-long-synthetic-capture-name-for-layout-checks-0123456789.bin').write_bytes(b'0' * 2048)
options = {'live_edit_dir': target / 'live-state'} if mode.endswith('live') else {}
server = app.make_server(target / 'root', port=0, artifact_uploads=not mode.startswith('off'), **options)
if server.artifact_uploads:
    server.artifact_uploads = au.Uploads(max_bytes=${8*1024*1024}, free_floor=0)
print(server.server_port, flush=True)
server.serve_forever()
`;

async function withBoard(mode,fn,viewport={width:1280,height:1400}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bd-'));
  const child=spawn('python3',['-u','-c',RUNNER,dir,mode],{cwd:repo,env:{...process.env,PYTHONPATH:repo},stdio:['ignore','pipe','inherit']});
  let browser;
  try {
    const port=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>reject(Error(`fixture exited ${code}`)));child.stdout.once('data',data=>resolve(Number(String(data).trim())));});
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN,args:['--no-sandbox','--disable-dev-shm-usage','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    const context=await browser.newContext({viewport});
    await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1' ? route.continue() : route.abort());
    const page=await context.newPage();
    const errors=[];page.on('pageerror',e=>errors.push(String(e)));
    await fn({page,base:`http://127.0.0.1:${port}`,lane:path.join(dir,'root/web_bounty/alpha/web'),dir,errors});
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
  await page.locator(`#report-artifacts-host[data-path="${report}"] h3`).filter({hasText:/Artifacts \(\d+\)/}).waitFor({timeout:10000});
}
// Every path under dir (symlinks listed, never followed).
const tree=dir=>{const out=[];const walk=(d,p)=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const r=p?`${p}/${e.name}`:e.name;out.push(r);if(e.isDirectory())walk(path.join(d,e.name),r);}};walk(dir,'');return out.sort();};
const dialogFor=(page,relative)=>page.locator(`dialog[data-artifact-delete-dialog="${relative}"]`);
async function panelShot(page,name,{rowSelector}={}){
  if(!shots)return;
  fs.mkdirSync(shots,{recursive:true});
  for(const theme of ['light','dark']){
    await page.evaluate(t=>{document.documentElement.dataset.theme=t;},theme);
    const target=rowSelector?page.locator(rowSelector).first():page.locator('#report-artifacts-host');
    const box=await target.evaluate(n=>{n.scrollIntoView({block:'start'});window.scrollBy(0,-90);const r=n.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:Math.min(r.height,620)};});
    await page.waitForTimeout(150);
    await page.screenshot({path:path.join(shots,`artifact-delete-${name}-${theme}.png`),clip:{x:Math.max(box.x-8,0),y:Math.max(box.y-8,0),width:box.width+16,height:box.height+16}});
  }
  await page.evaluate(()=>{document.documentElement.dataset.theme='light';});
}
async function dialogShot(page,name){
  if(!shots)return;
  fs.mkdirSync(shots,{recursive:true});
  for(const theme of ['light','dark']){
    await page.evaluate(t=>{document.documentElement.dataset.theme=t;},theme);
    await page.waitForTimeout(150);
    await page.screenshot({path:path.join(shots,`artifact-delete-${name}-${theme}.png`)});
  }
  await page.evaluate(()=>{document.documentElement.dataset.theme='light';});
}

test('Delete buttons only on deletable rows; Cancel and Escape keep the file; Delete removes it',{timeout:90000},async()=>{
  await withBoard('on-plain',async({page,base,lane,errors})=>{
    await openReport(page,base,'F1/REPORT.md');
    const host=page.locator('#report-artifacts-host');
    const buttons=await host.locator('[data-artifact-delete]').evaluateAll(n=>n.map(b=>b.dataset.artifactDelete));
    assert.ok(buttons.includes('reports/F1/poc/exploit.py'));
    assert.ok(buttons.includes('reports/F1/evidence/screenshot.png'));
    for(const relative of ['reports/F1/EVIDENCE.md','reports/F1/notes.MARKDOWN','evidence/F1-replay.js','evidence/shared-shot.png']){
      assert.equal(await host.locator(`[data-artifact="${relative}"]`).count(),1,relative);
      assert.ok(!buttons.includes(relative),`no Delete on ${relative}`);
    }
    const target='reports/F1/poc/exploit.py';
    const button=host.locator(`[data-artifact-delete="${target}"]`);
    assert.equal(await button.getAttribute('aria-label'),'Delete exploit.py');
    assert.match(await button.getAttribute('class'),/danger-ghost/);
    // Row alignment: the Delete button sits on the same line as Download.
    const [d,x]=await Promise.all([host.locator(`[data-artifact-download="${target}"]`).boundingBox(),button.boundingBox()]);
    assert.ok(Math.abs(d.y-x.y)<2&&Math.abs(d.height-x.height)<2,'Delete aligned with Download');
    await panelShot(page,'row',{rowSelector:'#report-artifacts-host .artifact-group[data-category="code"]'});

    // Keep a preview of another row open; it must survive the delete untouched.
    await host.locator('[data-artifact-preview="reports/F1/evidence/screenshot.png"]').click();
    const img=host.locator('[data-artifact="reports/F1/evidence/screenshot.png"] .artifact-preview img');
    await img.waitFor();
    await img.evaluate(n=>{n.dataset.marker='kept';});

    // Cancel (focused by default) keeps the file.
    await button.click();
    const dialog=dialogFor(page,target);
    await dialog.waitFor();
    assert.equal(await page.getByRole('dialog',{name:'Delete exploit.py?'}).count(),1);
    assert.equal(await dialog.locator('p').textContent(),'This removes poc/exploit.py from the report folder. Synced devices remove it too. This cannot be undone.');
    assert.equal(await page.evaluate(()=>document.activeElement?.dataset?.artifactDeleteCancel),'');
    assert.match(await dialog.locator('[data-artifact-delete-confirm]').getAttribute('class'),/danger-button/);
    await dialogShot(page,'dialog');
    await page.keyboard.press('Enter');  // Enter on the focused Cancel
    await dialog.waitFor({state:'detached'});
    assert.ok(fs.existsSync(path.join(lane,target)));
    // Escape cancels too.
    await button.click();
    await dialog.waitFor();
    await page.keyboard.press('Escape');
    await dialog.waitFor({state:'detached'});
    assert.ok(fs.existsSync(path.join(lane,target)));
    assert.equal(await host.locator(`[data-artifact="${target}"]`).count(),1);

    // Delete removes the file and the row and shows a note that fades.
    const before=tree(path.join(lane,'reports/F1'));
    await button.click();
    await dialog.locator('[data-artifact-delete-confirm]').click();
    await host.locator(`[data-artifact="${target}"]`).waitFor({state:'detached'});
    await host.locator('[data-delete-note="done"]').getByText('Deleted exploit.py').waitFor();
    assert.ok(!fs.existsSync(path.join(lane,target)));
    const after=tree(path.join(lane,'reports/F1'));
    assert.equal(after.length,before.length-1);
    assert.deepEqual(before.filter(n=>!after.includes(n)),['poc/exploit.py']);
    assert.equal(await img.getAttribute('data-marker'),'kept','other open previews are untouched');
    assert.ok(await page.evaluate(()=>document.querySelector('#report-artifacts-host section.artifacts').contains(document.activeElement)),'focus stays in the panel');
    await panelShot(page,'after-delete');
    // The next quiet reload agrees with the in-place removal (no redraw).
    await page.waitForTimeout(4500);
    assert.equal(await img.getAttribute('data-marker'),'kept');
    await host.locator('[data-delete-note="done"]').waitFor({state:'detached',timeout:5000});
    assert.deepEqual(errors,[]);
  });
});

test('a file changed on disk after the list loaded is kept and the list reloads',{timeout:60000},async()=>{
  await withBoard('on-plain',async({page,base,lane,errors})=>{
    await openReport(page,base,'F1/REPORT.md');
    const host=page.locator('#report-artifacts-host');
    const target='reports/F1/poc/payload.js';
    const file=path.join(lane,target);
    // Hold auto-refresh lists so the panel still shows the old size.
    let hold=true;
    await page.route('**/api/report-artifacts?*',async route=>{ if(hold)return route.abort(); return route.continue(); });
    fs.writeFileSync(file,'console.log("edited after the list loaded, with more bytes");\n');
    await host.locator(`[data-artifact-delete="${target}"]`).click();
    hold=false;
    await dialogFor(page,target).locator('[data-artifact-delete-confirm]').click();
    const note=host.locator('[data-delete-note="error"]');
    await note.getByText('This file changed since the list loaded. Check it and try again.').waitFor();
    assert.ok(fs.existsSync(file));
    assert.match(fs.readFileSync(file,'utf8'),/edited after the list loaded/);
    // The list reloads with the new size; the message stays until dismissed.
    const size=fs.statSync(file).size;
    await page.waitForFunction(([rel,s])=>document.querySelector(`[data-artifact="${rel}"] .artifact-meta`)?.textContent.startsWith(`${s} B`),[target,size]);
    await panelShot(page,'changed');
    await page.waitForTimeout(4500);
    assert.equal(await note.count(),1,'the error stays through quiet reloads');
    await note.locator('[data-delete-note-dismiss]').click();
    assert.equal(await note.count(),0);
    assert.deepEqual(errors,[]);
  });
});

test('fallback dialog without the ledger module; live editor draft unaffected; upload rows kept',{timeout:60000},async()=>{
  await withBoard('on-live',async({page,base,lane,errors})=>{
    await openReport(page,base,'F1/REPORT.md');
    const host=page.locator('#report-artifacts-host');
    assert.equal(await page.locator('#live-report-host').count(),1);
    await page.locator('.CodeMirror textarea').focus();
    await page.keyboard.press('Control+End');await page.keyboard.insertText('\nsynthetic draft line');
    const value=()=>page.locator('.CodeMirror').evaluate(e=>e.CodeMirror.getValue());
    const draft=await value();
    // An upload error row (precheck, nothing sent) must survive the delete.
    await host.locator('[data-artifacts-upload-input]').setInputFiles({name:'too-big.bin',mimeType:'application/octet-stream',buffer:Buffer.alloc(9*1024*1024)});
    await host.locator('.artifact-upload[data-upload-name="too-big.bin"][data-upload-state="error"]').waitFor();
    await page.evaluate(()=>{delete window.BoardLedgerActions;});
    const target='reports/F1/evidence/notes.txt';
    await host.locator(`[data-artifact-delete="${target}"]`).click();
    const dialog=dialogFor(page,target);
    await dialog.waitFor();
    assert.match(await dialog.getAttribute('class'),/artifact-delete-fallback/);
    assert.equal(await page.getByRole('dialog',{name:'Delete notes.txt?'}).count(),1);
    assert.equal(await page.evaluate(()=>document.activeElement?.dataset?.artifactDeleteCancel),'');
    await dialogShot(page,'dialog-fallback');
    await page.keyboard.press('Escape');
    await dialog.waitFor({state:'detached'});
    assert.ok(fs.existsSync(path.join(lane,target)));
    await host.locator(`[data-artifact-delete="${target}"]`).click();
    await dialog.locator('[data-artifact-delete-confirm]').click();
    await host.locator(`[data-artifact="${target}"]`).waitFor({state:'detached'});
    assert.ok(!fs.existsSync(path.join(lane,target)));
    assert.equal(await value(),draft,'the editor draft is untouched');
    assert.equal(await host.locator('.artifact-upload[data-upload-name="too-big.bin"]').count(),1,'upload rows are untouched');
    // Back in the editor, typing continues the draft.
    await page.locator('.CodeMirror textarea').focus();
    await page.keyboard.insertText(' more');
    assert.match(await value(),/synthetic draft line more$/);
    assert.deepEqual(errors,[]);
  });
});

test('no Delete buttons with the flag off or for reports without a folder; narrow layout',{timeout:60000},async()=>{
  await withBoard('off-plain',async({page,base,errors})=>{
    await openReport(page,base,'F1/REPORT.md');
    assert.equal(await page.locator('#report-artifacts-host [data-artifact-delete]').count(),0);
    assert.ok(await page.locator('#report-artifacts-host .artifact-row').count()>0);
    assert.deepEqual(errors,[]);
  });
  await withBoard('on-plain',async({page,base,errors})=>{
    await openReport(page,base,'findings/confirmed/F2 - HIGH - sample.md');
    const host=page.locator('#report-artifacts-host');
    assert.ok(await host.locator('.artifact-row').count()>0);
    assert.equal(await host.locator('[data-artifact-delete]').count(),0);
    // Narrow: buttons wrap under the name and stay on one line together.
    await page.setViewportSize({width:420,height:1200});
    await page.locator('#report-select').selectOption('F1/REPORT.md');
    await page.locator('#report-artifacts-host[data-path="F1/REPORT.md"] h3').filter({hasText:/Artifacts \(\d+\)/}).first().waitFor();
    const long='reports/F1/a-very-long-synthetic-capture-name-for-layout-checks-0123456789.bin';
    const del=host.locator(`[data-artifact-delete="${long}"]`);
    await del.waitFor();
    const [d,x]=await Promise.all([host.locator(`[data-artifact-download="${long}"]`).boundingBox(),del.boundingBox()]);
    assert.ok(Math.abs(d.y-x.y)<2,'Download and Delete share a line at narrow width');
    const width=await page.evaluate(()=>document.documentElement.scrollWidth);
    assert.ok(width<=420,'no horizontal overflow');
    await panelShot(page,'narrow',{rowSelector:`#report-artifacts-host [data-artifact="${long}"]`});
    assert.deepEqual(errors,[]);
  });
});
