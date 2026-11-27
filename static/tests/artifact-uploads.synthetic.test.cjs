require('./isolate-home.cjs'); // Standalone runs must not use the operator's HOME.
// Artifact uploads from the report artifacts panel, on the synthetic fixture
// (tests/report_artifacts_fixture.py) with --artifact-uploads semantics.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {chromium}=require('playwright');

const repo=path.resolve(__dirname,'../..');
const shots=process.env.ARTIFACT_SCREENSHOT_DIR;
const MAX=8*1024*1024;

// Serves the fixture. Uploads: free-space floor 0 and an 8 MiB cap for the
// test; files named slow-* are read slowly so progress and Cancel are visible.
const RUNNER=`
import sys, time
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(repo)})
import app, artifact_uploads as au
from tests.report_artifacts_fixture import build
target, mode = Path(sys.argv[1]), sys.argv[2]
lane = build(target / 'root')
(lane / 'reports/ROOT.md').write_text('# flat root report\\n')
original = au.store
class Slow:
    def __init__(self, f): self.f = f
    def read(self, n):
        time.sleep(0.03)
        return self.f.read(n)
au.store = lambda uploads, fd, name, length, rfile: original(uploads, fd, name, length, Slow(rfile) if name.startswith('slow-') else rfile)
options = {'live_edit_dir': target / 'live-state'} if mode.endswith('live') else {}
server = app.make_server(target / 'root', port=0, artifact_uploads=not mode.startswith('off'), **options)
if server.artifact_uploads:
    server.artifact_uploads = au.Uploads(max_bytes=${MAX}, free_floor=0)
print(server.server_port, flush=True)
server.serve_forever()
`;

async function withBoard(mode,fn){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bu-'));
  const child=spawn('python3',['-u','-c',RUNNER,dir,mode],{cwd:repo,env:{...process.env,PYTHONPATH:repo},stdio:['ignore','pipe','inherit']});
  let browser;
  try {
    const port=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>reject(Error(`fixture exited ${code}`)));child.stdout.once('data',data=>resolve(Number(String(data).trim())));});
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN,args:['--no-sandbox','--disable-dev-shm-usage','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    const context=await browser.newContext({acceptDownloads:true,viewport:{width:1280,height:1400}});
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
  await selectReport(page,report);
}
async function selectReport(page,report){
  await page.locator('#report-select').selectOption(report);
  await page.locator(`#report-artifacts-host[data-path="${report}"] h3`).filter({hasText:/Artifacts \(\d+\)/}).waitFor({timeout:10000});
}
const staged=lane=>fs.readdirSync(path.join(lane,'reports/F1')).filter(n=>n.startsWith('.syncthing.board-'));
async function shot(page,name){
  if(!shots)return;
  fs.mkdirSync(shots,{recursive:true});
  for(const theme of ['light','dark']){
    await page.evaluate(t=>{document.documentElement.dataset.theme=t;},theme);
    // The top of the panel (header, hints, upload rows, first groups), below the sticky top bar.
    const box=await page.locator('#report-artifacts-host').evaluate(n=>{n.scrollIntoView({block:'start'});window.scrollBy(0,-80);const r=n.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:Math.min(r.height,620)};});
    await page.waitForTimeout(150);
    await page.screenshot({path:path.join(shots,`artifact-uploads-${name}-${theme}.png`),clip:{x:Math.max(box.x-8,0),y:Math.max(box.y-8,0),width:box.width+16,height:box.height+16}});
  }
  await page.evaluate(()=>{document.documentElement.dataset.theme='light';});
}

test('upload button, picker upload with rename, drag and drop, progress, cancel, precheck',{timeout:90000},async()=>{
  await withBoard('upload-plain',async({page,base,lane,dir,errors})=>{
    fs.writeFileSync(path.join(lane,'reports/F1/shot.png'),'existing');
    await openReport(page,base,'F1/REPORT.md');
    const host=page.locator('#report-artifacts-host');
    const button=host.locator('[data-artifacts-upload]');
    assert.equal(await button.isEnabled(),true);
    assert.equal(await button.textContent(),' Upload files');
    await host.getByText('Drop files on this panel or use Upload files to add them to the report folder.').waitFor();
    await page.evaluate(()=>window.scrollTo(0,document.querySelector('#report-artifacts-host').offsetTop-20));
    await shot(page,'idle');

    // Picker: two files, one collides case-insensitively with shot.png.
    const files=path.join(dir,'files');fs.mkdirSync(files);
    fs.writeFileSync(path.join(files,'Shot.PNG'),Buffer.from([0x89,0x50,0x4e,0x47,1,2,3]));
    fs.writeFileSync(path.join(files,'request.txt'),'GET /synthetic\n');
    const [chooser]=await Promise.all([page.waitForEvent('filechooser'),button.click()]);
    assert.equal(chooser.isMultiple(),true);
    await chooser.setFiles([path.join(files,'Shot.PNG'),path.join(files,'request.txt')]);
    await host.locator('.artifact-upload[data-upload-name="Shot.PNG"]').getByText('Saved as Shot-2.PNG').waitFor();
    await host.locator('.artifact-upload[data-upload-name="request.txt"]').getByText('Saved',{exact:true}).waitFor();
    const renamed=host.locator('[data-artifact="reports/F1/Shot-2.PNG"]');
    await renamed.waitFor();
    assert.ok(await renamed.evaluate(r=>r.classList.contains('artifact-new')),'uploaded file gets the New highlight');
    assert.equal(await renamed.locator('.artifact-new-badge').textContent(),'New');
    await host.locator('[data-artifact="reports/F1/request.txt"].artifact-new').waitFor();
    await shot(page,'after-upload');
    assert.equal(fs.readFileSync(path.join(lane,'reports/F1/shot.png'),'utf8'),'existing');
    // Downloaded bytes match the uploaded file.
    const [download]=await Promise.all([page.waitForEvent('download'),host.locator('[data-artifact-download="reports/F1/Shot-2.PNG"]').click()]);
    assert.deepEqual(fs.readFileSync(await download.path()),fs.readFileSync(path.join(files,'Shot.PNG')));
    // Successes fade.
    await host.locator('.artifact-upload[data-upload-name="request.txt"]').waitFor({state:'detached',timeout:10000});

    // Drag and drop onto the panel, with the drop highlight.
    const panel=host.locator('section.artifacts');
    const dt=await page.evaluateHandle(()=>{const d=new DataTransfer();d.items.add(new File(['dropped synthetic text\n'],'dropped notes.txt',{type:'text/plain'}));return d;});
    await panel.dispatchEvent('dragenter',{dataTransfer:dt});
    await panel.dispatchEvent('dragover',{dataTransfer:dt});
    assert.ok(await panel.evaluate(n=>n.classList.contains('artifacts-dropping')));
    assert.equal(await host.locator('.artifacts-drop-hint').isVisible(),true);
    await shot(page,'dropping');
    await panel.dispatchEvent('drop',{dataTransfer:dt});
    assert.ok(!(await panel.evaluate(n=>n.classList.contains('artifacts-dropping'))));
    await host.locator('[data-artifact="reports/F1/dropped notes.txt"]').waitFor();
    assert.equal(fs.readFileSync(path.join(lane,'reports/F1/dropped notes.txt'),'utf8'),'dropped synthetic text\n');

    // A larger upload shows a progress row; it survives a report switch and back.
    fs.writeFileSync(path.join(files,'slow-recording.mp4'),Buffer.alloc(6*1024*1024,7));
    await host.locator('[data-artifacts-upload-input]').setInputFiles(path.join(files,'slow-recording.mp4'));
    const progress=host.locator('.artifact-upload[data-upload-name="slow-recording.mp4"]');
    await progress.locator('.artifact-upload-bar').waitFor();
    assert.match(await progress.locator('.artifact-upload-status').textContent(),/Uploading \d+%/);
    await page.waitForTimeout(300);
    await shot(page,'uploading');
    await selectReport(page,'loose/notes.md');
    await selectReport(page,'F1/REPORT.md');
    await progress.getByText('Saved',{exact:true}).waitFor({timeout:30000});
    await host.locator('[data-artifact="reports/F1/slow-recording.mp4"]').waitFor();
    assert.equal(fs.statSync(path.join(lane,'reports/F1/slow-recording.mp4')).size,6*1024*1024);

    // Cancel aborts and leaves no file (and no staged file).
    fs.writeFileSync(path.join(files,'slow-cancel.bin'),Buffer.alloc(6*1024*1024,1));
    await host.locator('[data-artifacts-upload-input]').setInputFiles(path.join(files,'slow-cancel.bin'));
    const cancelRow=host.locator('.artifact-upload[data-upload-name="slow-cancel.bin"]');
    await cancelRow.locator('.artifact-upload-bar').waitFor();
    await page.getByRole('button',{name:'Cancel upload of slow-cancel.bin'}).click();
    await cancelRow.getByText('Cancelled').waitFor();
    await page.waitForTimeout(1500);
    assert.ok(!fs.existsSync(path.join(lane,'reports/F1/slow-cancel.bin')));
    assert.deepEqual(staged(lane),[]);

    // Client-side size precheck: nothing is sent.
    fs.writeFileSync(path.join(files,'huge.mov'),Buffer.alloc(MAX+1));
    let posts=0;page.on('request',r=>{if(r.url().includes('/api/report-artifact-upload'))posts++;});
    await host.locator('[data-artifacts-upload-input]').setInputFiles(path.join(files,'huge.mov'));
    const huge=host.locator('.artifact-upload[data-upload-name="huge.mov"]');
    await huge.getByText('Too large. The limit is 8.0 MB.').waitFor();
    await shot(page,'error');
    await page.getByRole('button',{name:'Dismiss upload message for huge.mov'}).click();
    await huge.waitFor({state:'detached'});
    assert.equal(posts,0);
    assert.ok(!fs.existsSync(path.join(lane,'reports/F1/huge.mov')));

    // Server errors are shown plainly and stay until dismissed.
    await page.route('**/api/report-artifact-upload?*',route=>route.fulfill({status:507,contentType:'application/json',body:'{"error":"insufficient_storage"}'}));
    await host.locator('[data-artifacts-upload-input]').setInputFiles({name:'later.txt',mimeType:'text/plain',buffer:Buffer.from('x')});
    await host.locator('.artifact-upload[data-upload-name="later.txt"]').getByText('Not enough space on the server.').waitFor();
    await page.unroute('**/api/report-artifact-upload?*');

    // A file dropped outside the panel is not opened by the browser.
    const url=page.url();
    const prevented=await page.evaluate(()=>{
      const d=new DataTransfer();d.items.add(new File(['x'],'stray.txt',{type:'text/plain'}));
      const target=document.querySelector('header')||document.body;
      const over=new DragEvent('dragover',{dataTransfer:d,bubbles:true,cancelable:true});target.dispatchEvent(over);
      const drop=new DragEvent('drop',{dataTransfer:d,bubbles:true,cancelable:true});target.dispatchEvent(drop);
      return [over.defaultPrevented,drop.defaultPrevented];
    });
    assert.deepEqual(prevented,[true,true]);
    assert.equal(page.url(),url);
    assert.ok(!fs.existsSync(path.join(lane,'reports/F1/stray.txt')));
    assert.deepEqual(staged(lane),[]);
    assert.deepEqual(errors,[]);
  });
});

test('disabled with a reason for reports without a folder; absent when the flag is off',{timeout:60000},async()=>{
  await withBoard('upload-plain',async({page,base,lane,errors})=>{
    const before=fs.readdirSync(path.join(lane,'reports/loose')).sort();
    for(const report of ['loose/notes.md','ROOT.md','findings/confirmed/F2 - HIGH - sample.md']){
      if(report==='loose/notes.md')await openReport(page,base,report);else await selectReport(page,report);
      const host=page.locator('#report-artifacts-host');
      const button=host.locator('[data-artifacts-upload]');
      assert.equal(await button.isDisabled(),true,report);
      assert.match(await button.getAttribute('title'),/Uploads need a report folder of its own/);
      await host.locator('.artifacts-upload-hint').getByText(/Uploads need a report folder of its own/).waitFor();
      // Dropping files on this panel uploads nothing.
      const panel=host.locator('section.artifacts');
      const dt=await page.evaluateHandle(()=>{const d=new DataTransfer();d.items.add(new File(['x'],'nope.txt'));return d;});
      await panel.dispatchEvent('dragover',{dataTransfer:dt});
      assert.ok(!(await panel.evaluate(n=>n.classList.contains('artifacts-dropping'))));
      await panel.dispatchEvent('drop',{dataTransfer:dt});
      if(report==='loose/notes.md'){
        await page.evaluate(()=>window.scrollTo(0,document.querySelector('#report-artifacts-host').offsetTop-20));
        await shot(page,'disabled');
      }
    }
    await page.waitForTimeout(500);
    assert.deepEqual(fs.readdirSync(path.join(lane,'reports/loose')).sort(),before);
    assert.equal(await page.locator('.artifact-upload').count(),0);
    assert.deepEqual(errors,[]);
  });
  await withBoard('off-plain',async({page,base,errors})=>{
    await openReport(page,base,'F1/REPORT.md');
    const host=page.locator('#report-artifacts-host');
    assert.equal(await host.locator('[data-artifacts-upload]').count(),0);
    assert.equal(await host.locator('.artifacts-upload-hint').count(),0);
    // Without uploads the page does not intercept file drops.
    const prevented=await page.evaluate(()=>{const d=new DataTransfer();d.items.add(new File(['x'],'a.txt'));
      const e=new DragEvent('dragover',{dataTransfer:d,bubbles:true,cancelable:true});document.body.dispatchEvent(e);return e.defaultPrevented;});
    assert.equal(prevented,false);
    assert.deepEqual(errors,[]);
  });
});

test('uploading next to the live editor leaves the draft and focus alone',{timeout:60000},async()=>{
  await withBoard('upload-live',async({page,base,lane,errors})=>{
    await openReport(page,base,'F1/REPORT.md');
    assert.equal(await page.locator('#live-report-host').count(),1);
    const host=page.locator('#report-artifacts-host');
    await host.locator('[data-artifacts-upload]').waitFor();
    await page.locator('.CodeMirror textarea').focus();
    await page.keyboard.press('Control+End');await page.keyboard.insertText('\nsynthetic draft line');
    const value=()=>page.locator('.CodeMirror').evaluate(e=>e.CodeMirror.getValue());
    const cursor=await page.locator('.CodeMirror').evaluate(e=>JSON.stringify(e.CodeMirror.getCursor()));
    await host.locator('[data-artifacts-upload-input]').setInputFiles({name:'live-note.txt',mimeType:'text/plain',buffer:Buffer.from('from live view\n')});
    await host.locator('[data-artifact="reports/F1/live-note.txt"]').waitFor();
    // Keep typing: the editor still has focus and the draft text.
    await page.keyboard.insertText(' more');
    assert.match(await value(),/synthetic draft line more$/);
    assert.ok(await page.evaluate(()=>!!document.activeElement.closest('.CodeMirror')),'focus stays in the editor');
    assert.notEqual(await page.locator('.CodeMirror').evaluate(e=>JSON.stringify(e.CodeMirror.getCursor())),cursor);
    assert.equal(fs.readFileSync(path.join(lane,'reports/F1/live-note.txt'),'utf8'),'from live view\n');
    // Pasting an image while focus is in the panel uploads it as pasted-<time>.png.
    await host.locator('section.artifacts').focus();
    await host.locator('section.artifacts').evaluate(node=>{
      const d=new DataTransfer();d.items.add(new File([new Uint8Array([0x89,0x50,0x4e,0x47])],'image.png',{type:'image/png'}));
      node.dispatchEvent(new ClipboardEvent('paste',{clipboardData:d,bubbles:true,cancelable:true}));
    });
    await page.waitForFunction(()=>[...document.querySelectorAll('#report-artifacts-host [data-artifact]')].some(r=>/^reports\/F1\/pasted-\d{8}-\d{6}\.png$/.test(r.dataset.artifact)));
    // A pasted JPEG keeps a .jpg name (review R4).
    await host.locator('section.artifacts').evaluate(node=>{
      const d=new DataTransfer();d.items.add(new File([new Uint8Array([0xff,0xd8,0xff])],'image.jpg',{type:'image/jpeg'}));
      node.dispatchEvent(new ClipboardEvent('paste',{clipboardData:d,bubbles:true,cancelable:true}));
    });
    await page.waitForFunction(()=>[...document.querySelectorAll('#report-artifacts-host [data-artifact]')].some(r=>/^reports\/F1\/pasted-\d{8}-\d{6}(-\d+)?\.jpg$/.test(r.dataset.artifact)));
    assert.match(await value(),/synthetic draft line more$/);
    assert.deepEqual(errors,[]);
  });
});

// Review U1: the 12-panel cache must not drop a panel whose upload is still
// queued or running, or its progress, Cancel and Retry rows disappear.
test('an in-flight upload stays visible and cancellable after visiting 12 other reports',{timeout:90000},async()=>{
  await withBoard('upload-plain',async({page,base,lane,dir,errors})=>{
    await openReport(page,base,'F1/REPORT.md');
    const host=page.locator('#report-artifacts-host');
    const files=path.join(dir,'files');fs.mkdirSync(files);
    fs.writeFileSync(path.join(files,'slow-big.bin'),Buffer.alloc(7*1024*1024,3));
    await host.locator('[data-artifacts-upload-input]').setInputFiles(path.join(files,'slow-big.bin'));
    await host.locator('.artifact-upload[data-upload-name="slow-big.bin"][data-upload-state="uploading"]').waitFor();
    // Mount 12 other report panels, then come back.
    await page.evaluate(()=>{const h=document.getElementById('report-artifacts-host');const m=window.BoardModules.find(x=>x.name==='report-artifacts');const orig=h.dataset.path;
      for(let i=0;i<12;i++){h.dataset.path=`F1/other-${i}.md`;m.afterRender();}h.dataset.path=orig;m.afterRender();});
    const row=host.locator('.artifact-upload[data-upload-name="slow-big.bin"]');
    assert.equal(await row.count(),1,'upload row must still be shown for the report it targets');
    await row.locator('[data-upload-cancel]').click();
    await host.locator('.artifact-upload[data-upload-name="slow-big.bin"][data-upload-state="cancelled"]').waitFor();
    for(let i=0;i<50&&staged(lane).length;i++)await new Promise(r=>setTimeout(r,100));
    assert.deepEqual(staged(lane),[]);
    assert.ok(!fs.existsSync(path.join(lane,'reports/F1/slow-big.bin')));
    // Once uploads are known to be on, a stray file drop is stopped even
    // while the next report's list is still loading (review R3).
    await page.route('**/api/report-artifacts?*',route=>new Promise(resolve=>setTimeout(()=>resolve(route.continue().catch(()=>{})),4000)));
    const prevented=await page.evaluate(()=>{
      const h=document.getElementById('report-artifacts-host');const m=window.BoardModules.find(x=>x.name==='report-artifacts');
      for(let i=0;i<14;i++){h.dataset.path=`F1/loading-${i}.md`;m.afterRender();}
      const d=new DataTransfer();d.items.add(new File(['x'],'stray.txt',{type:'text/plain'}));
      const drop=new DragEvent('drop',{dataTransfer:d,bubbles:true,cancelable:true});(document.querySelector('header')||document.body).dispatchEvent(drop);
      return drop.defaultPrevented;
    });
    assert.equal(prevented,true);
    assert.deepEqual(errors,[]);
  });
});

// Re-review N2: when every older cached panel has queued or running uploads,
// eviction must not drop the panel that is being mounted.
test('the panel being mounted is kept when all older panels have active uploads',{timeout:120000},async()=>{
  await withBoard('upload-plain',async({page,base,dir,errors})=>{
    // Fake report lists for F1/fake-*.md (upload enabled, empty), real ones otherwise.
    await page.route('**/api/report-artifacts?*',route=>{
      const p=new URL(route.request().url()).searchParams.get('path')||'';
      if(!p.startsWith('F1/fake-'))return route.continue();
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({report:`reports/${p}`,folder:'reports/F1',artifacts:[],notes:[],max_zip_bytes:1,upload:{enabled:true,reason:null,max_bytes:8*1024*1024}})});
    });
    await openReport(page,base,'F1/REPORT.md');
    const host=page.locator('#report-artifacts-host');
    const files=path.join(dir,'files');fs.mkdirSync(files);
    fs.writeFileSync(path.join(files,'slow-hold.bin'),Buffer.alloc(7*1024*1024,5));
    fs.writeFileSync(path.join(files,'queued.txt'),'q\n');
    await host.locator('[data-artifacts-upload-input]').setInputFiles(path.join(files,'slow-hold.bin'));
    await host.locator('.artifact-upload[data-upload-name="slow-hold.bin"][data-upload-state="uploading"]').waitFor();
    const mountPath=p=>page.evaluate(p=>{const h=document.getElementById('report-artifacts-host');h.dataset.path=p;window.BoardModules.find(x=>x.name==='report-artifacts').afterRender();},p);
    // 11 more panels, each with a queued upload: 12 panels with active uploads.
    for(let i=0;i<11;i++){
      await mountPath(`F1/fake-${i}.md`);
      const panel=host.locator(`section.artifacts[data-artifacts-key*="fake-${i}.md"]`);
      await panel.locator('[data-artifacts-upload]').waitFor();
      await panel.locator('[data-artifacts-upload-input]').setInputFiles(path.join(files,'queued.txt'));
      await panel.locator('.artifact-upload[data-upload-state="queued"]').waitFor();
    }
    // Mount a 13th panel, then re-render: the same panel node must be reused.
    await mountPath('F1/fake-new.md');
    await host.locator('section.artifacts[data-artifacts-key*="fake-new.md"] [data-artifacts-upload]').waitFor();
    const same=await page.evaluate(()=>{const h=document.getElementById('report-artifacts-host');const before=h.firstChild;
      window.BoardModules.find(x=>x.name==='report-artifacts').afterRender();return h.firstChild===before;});
    assert.equal(same,true,'the newly mounted panel must stay cached');
    // Stop the slow upload so nothing runs on after the test.
    await mountPath('F1/REPORT.md');
    await host.locator('.artifact-upload[data-upload-name="slow-hold.bin"] [data-upload-cancel]').click();
    assert.deepEqual(errors,[]);
  });
});
