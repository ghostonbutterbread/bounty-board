// Live report editor end to end against a synthetic live-edit Board.
// Each test uses a disposable root under TMPDIR and loopback only.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {chromium}=require('playwright');

const repo=path.resolve(__dirname,'../..');
const SHOTS=process.env.LIVE_EDITOR_SCREENSHOTS;
const ORIGINAL='# Synthetic report\n\nIntro line.\n\nMiddle line.\n\nClosing line.\n';

function startFixture(root,port){
  const child=spawn('python3',['-u','tests/live_browser_fixture.py',root],{cwd:repo,env:{...process.env,PYTHONPATH:repo,...(port?{PORT:String(port)}:{})},stdio:['ignore','pipe','inherit']});
  const ready=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>reject(Error(`fixture exited ${code}`)));child.stdout.once('data',data=>resolve(Number(String(data).trim())));});
  return {child,ready};
}
async function stop(child){
  if(!child||child.exitCode!==null||child.signalCode!==null)return;
  const done=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await done;
}
async function waitFor(check,label,timeout=15000){
  const deadline=Date.now()+timeout;
  while(!(await check())){if(Date.now()>deadline)throw Error(`timed out: ${label}`);await new Promise(r=>setTimeout(r,25));}
}
async function setup(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'live-ed-'));
  const env={root,report:path.join(root,'source/web_bounty/alpha/web/reports/report.md'),contexts:[]};
  env.fixture=startFixture(root);env.port=await env.fixture.ready;env.base=`http://127.0.0.1:${env.port}`;
  env.browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN,args:['--no-sandbox','--disable-dev-shm-usage','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
  env.context=async()=>{const context=await env.browser.newContext({viewport:{width:1280,height:900}});await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());env.contexts.push(context);return context;};
  t.after(async()=>{
    fs.writeFileSync(path.join(root,'release-save'),'released');
    if(env.browser)await env.browser.close();
    await stop(env.fixture.child);
    fs.rmSync(root,{recursive:true,force:true});
  });
  return env;
}
async function open(page,base,report){
  await page.goto(base);
  await page.getByRole('button',{name:'Open workspace'}).click();
  await page.getByRole('link',{name:'Reports',exact:true}).click();
  if(report)await page.locator('#report-select').selectOption(report);
  await page.locator('#live-report-host .live-editor .CodeMirror').waitFor({timeout:15000});
  await page.locator('[data-live-status]').filter({hasText:/^(Saved|Read-only)$/}).waitFor({timeout:15000});
}
const value=page=>page.evaluate(()=>document.querySelector('#live-report-host .CodeMirror').CodeMirror.getValue());
const pill=page=>page.locator('[data-live-status]').textContent();
async function typeAtLineEnd(page,match,text){
  await page.evaluate(match=>{const cm=document.querySelector('#live-report-host .CodeMirror').CodeMirror;let line=0;for(;line<cm.lineCount();line++)if(cm.getLine(line).includes(match))break;cm.focus();cm.setCursor({line,ch:cm.getLine(line).length});},match);
  await page.keyboard.insertText(text);
}
const waitValue=(page,check,label,timeout=15000)=>waitFor(async()=>check(await value(page)),label,timeout);
const waitPill=(page,text,timeout=15000)=>page.locator('[data-live-status]').filter({hasText:new RegExp(`^${text}$`)}).waitFor({timeout});
const waitFile=(env,check,label)=>waitFor(()=>check(fs.readFileSync(env.report,'utf8')),label);
// Outside writers use temp-file-and-rename, like agents and Syncthing.
function outsideWrite(file,text){const tmp=`${file}.tmp-${process.pid}`;fs.writeFileSync(tmp,text);fs.renameSync(tmp,file);}
async function holdNextSave(env){
  fs.rmSync(path.join(env.root,'release-save'),{force:true});fs.rmSync(path.join(env.root,'save-entered'),{force:true});
  fs.writeFileSync(path.join(env.root,'hold-save'),'hold');
  return {
    entered:()=>waitFor(()=>fs.existsSync(path.join(env.root,'save-entered')),'save reached the barrier'),
    release:()=>fs.writeFileSync(path.join(env.root,'release-save'),'released'),
  };
}

test('two browser contexts see each other edits; session survives re-render; history lists edits',{timeout:90000},async t=>{
  const env=await setup(t);
  const a=await (await env.context()).newPage(), b=await (await env.context()).newPage();
  await open(a,env.base);await open(b,env.base);
  assert.equal(await value(a),ORIGINAL);
  await a.evaluate(()=>{window.__session=document.querySelector('[data-live-session]');});
  await typeAtLineEnd(a,'Intro line.',' From A.');
  await waitFile(env,text=>text.includes('Intro line. From A.'),'A saved');
  await waitPill(a,'Saved');
  await waitValue(b,v=>v.includes('Intro line. From A.'),'B sees A');
  await b.getByText(/Updated by Board editor in another tab/).waitFor();
  await typeAtLineEnd(b,'Closing line.',' From B.');
  await waitValue(a,v=>v.includes('Closing line. From B.') && v.includes('From A.'),'A sees B');
  await waitFile(env,text=>text.includes('From A.') && text.includes('From B.'),'file has both');
  // An app re-render must move the same session node, not recreate it.
  await a.getByRole('link',{name:'Reports',exact:true}).click();
  assert.equal(await a.evaluate(()=>document.querySelector('[data-live-session]')===window.__session && window.__session.isConnected),true);
  // A re-render while typing keeps focus and cursor in the editor.
  await a.evaluate(()=>window.registerBoardModule({name:'test-probe',afterRender(ctx){window.__render=ctx.render;}}));
  await typeAtLineEnd(a,'Closing line. From B.',' Focus.');
  await a.evaluate(()=>window.__render());
  assert.equal(await a.evaluate(()=>!!document.activeElement.closest('#live-report-host .CodeMirror')),true);
  await a.keyboard.insertText(' Kept.');
  await waitFile(env,text=>text.includes('From B. Focus. Kept.'),'typing after re-render saved');
  await waitPill(a,'Saved');
  assert.equal(await localStorageBackups(a),0,'clean editor keeps no browser backup');
  await a.getByRole('button',{name:'History'}).click();
  await a.locator('.live-history-entry').filter({hasText:/Edited by Board editor \(this tab\)/}).first().waitFor();
  await a.locator('.live-history-entry').filter({hasText:'Opened from disk'}).click();
  await a.locator('.live-history-view .live-preview').filter({hasText:'Intro line.'}).waitFor();
  if(SHOTS){await a.getByRole('button',{name:'Close',exact:true}).last().click();await a.screenshot({path:path.join(SHOTS,'live-editor-idle.png'),fullPage:true});}
});

const localStorageBackups=page=>page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('bounty-board-live:')).length);

test('outside write appears in an idle editor with a notice',{timeout:60000},async t=>{
  const env=await setup(t);
  const a=await (await env.context()).newPage();
  await open(a,env.base);
  await a.evaluate(()=>{const cm=document.querySelector('#live-report-host .CodeMirror').CodeMirror;cm.focus();cm.setCursor({line:6,ch:3});});
  outsideWrite(env.report,ORIGINAL.replace('Intro line.','Intro from an agent.'));
  await waitValue(a,v=>v.includes('Intro from an agent.'),'outside change applied');
  await a.getByText('Updated outside the Board').waitFor();
  assert.equal(await pill(a),'Saved');
  // The cursor stays on the same text after a change above it.
  assert.deepEqual(await a.evaluate(()=>{const c=document.querySelector('#live-report-host .CodeMirror').CodeMirror.getCursor();return [c.line,c.ch];}),[6,3]);
});

test('different-line edits from the browser and an outside writer are merged',{timeout:60000},async t=>{
  const env=await setup(t);
  const a=await (await env.context()).newPage(), b=await (await env.context()).newPage();
  await open(a,env.base);await open(b,env.base);
  const hold=await holdNextSave(env);
  await typeAtLineEnd(a,'Closing line.',' Browser edit.');
  await hold.entered();
  outsideWrite(env.report,ORIGINAL.replace('Intro line.','Intro line. Agent edit.'));
  hold.release();
  const both=v=>v.includes('Intro line. Agent edit.') && v.includes('Closing line. Browser edit.');
  await waitFile(env,both,'file merged');
  await waitValue(a,both,'editor A merged');
  await waitValue(b,both,'editor B merged');
  assert.equal(await value(a),fs.readFileSync(env.report,'utf8'));
  await waitPill(a,'Merged');
});

test('overlapping edit shows markers; Keep mine saves the file',{timeout:60000},async t=>{
  const env=await setup(t);
  const a=await (await env.context()).newPage();
  await open(a,env.base);
  const hold=await holdNextSave(env);
  await typeAtLineEnd(a,'Middle line.',' Mine.\n======='); // a setext underline inside my side
  await hold.entered();
  outsideWrite(env.report,ORIGINAL.replace('Middle line.','Middle line from agent.'));
  hold.release();
  await waitPill(a,'Conflict');
  await a.getByText('Your edit overlaps a change saved elsewhere.').waitFor();
  const marked=await value(a);
  assert.match(marked,/^<{15} your edit \(Bounty Board\)$/m);
  assert.match(marked,/^>{15} saved version \(Bounty Board\)$/m);
  assert.ok(await a.locator('.CodeMirror .live-conflict-mine').count()>0,'mine side highlighted');
  assert.equal(fs.readFileSync(env.report,'utf8'),ORIGINAL.replace('Middle line.','Middle line from agent.'),'nothing with markers was written');
  await new Promise(r=>setTimeout(r,1000));
  assert.equal(await pill(a),'Conflict','autosave paused while markers remain');
  if(SHOTS)await a.screenshot({path:path.join(SHOTS,'live-editor-conflict.png'),fullPage:true});
  await a.getByRole('button',{name:'Keep mine'}).first().click();
  await waitFile(env,text=>text.includes('Middle line. Mine.\n=======\n') && !text.includes('Middle line from agent.') && !text.includes('<<<<<<<'),'mine saved');
  await waitPill(a,'Saved');
  assert.equal(await value(a),fs.readFileSync(env.report,'utf8'));
  assert.equal(await localStorageBackups(a),0);
});

test('typing during an in-flight save is not lost',{timeout:60000},async t=>{
  const env=await setup(t);
  const a=await (await env.context()).newPage();
  await open(a,env.base);
  const hold=await holdNextSave(env);
  await typeAtLineEnd(a,'Closing line.',' First.');
  await hold.entered();
  assert.equal(await pill(a),'Saving');
  await typeAtLineEnd(a,'Closing line. First.',' Second.');
  outsideWrite(env.report,ORIGINAL.replace('Intro line.','Intro line. Agent.'));
  await new Promise(r=>setTimeout(r,1200)); // the debounce fires while the first save is held
  assert.match(await a.evaluate(()=>Object.entries(localStorage).find(([k])=>k.startsWith('bounty-board-live:'))?.[1]||''),/First\. Second\./,'typing is backed up');
  hold.release();
  const all=v=>v.includes('Closing line. First. Second.') && v.includes('Intro line. Agent.');
  await waitFile(env,all,'file has every edit');
  await waitValue(a,all,'editor has every edit');
  await waitFor(async()=>['Saved','Merged'].includes(await pill(a)),'clean');
  assert.equal(await value(a),fs.readFileSync(env.report,'utf8'));
});

test('offline edits survive a closed tab and merge on reopen',{timeout:90000},async t=>{
  const env=await setup(t);
  const context=await env.context();
  const a=await context.newPage();
  await open(a,env.base);
  await stop(env.fixture.child);
  await typeAtLineEnd(a,'Closing line.',' Typed offline.');
  await waitPill(a,'Offline');
  await a.getByText('Offline, kept in this browser, retrying.').waitFor();
  outsideWrite(env.report,ORIGINAL.replace('Intro line.','Intro line. Agent while offline.'));
  await a.close();
  env.fixture=startFixture(env.root,env.port);await env.fixture.ready;
  const b=await context.newPage();
  await b.goto(env.base);
  await b.getByRole('button',{name:'Open workspace'}).click();
  await b.getByRole('link',{name:'Reports',exact:true}).click();
  await b.getByText(/Recovered unsaved text from this browser/).waitFor({timeout:20000});
  const both=v=>v.includes('Closing line. Typed offline.') && v.includes('Intro line. Agent while offline.');
  await waitFile(env,both,'backup merged into file');
  await waitValue(b,both,'editor shows merged text');
  await waitFor(async()=>(await localStorageBackups(b))===0,'backup cleared');
});

test('generated navigation report is read-only',{timeout:60000},async t=>{
  const env=await setup(t);
  const a=await (await env.context()).newPage();
  await open(a,env.base);
  // Switching reports right after typing still saves the pending edit.
  await typeAtLineEnd(a,'Intro line.',' Before switching.');
  await a.locator('#report-select').selectOption('zz-nav.md');
  await waitFile(env,text=>text.includes('Intro line. Before switching.'),'pending edit flushed on switch');
  await a.locator('[data-live-status]').filter({hasText:/^Read-only$/}).waitFor({timeout:15000});
  assert.equal(await pill(a),'Read-only');
  await a.getByText('Generated navigation is read-only.').waitFor();
  assert.equal(await a.evaluate(()=>document.querySelector('#live-report-host .CodeMirror').CodeMirror.getOption('readOnly')),true);
  assert.equal(await a.locator('#live-report-host .editor-toolbar').isVisible(),false);
  const nav=path.join(env.root,'source/web_bounty/alpha/web/reports/zz-nav.md'), before=fs.readFileSync(nav,'utf8');
  await a.locator('#live-report-host .CodeMirror textarea').focus();
  await a.keyboard.insertText('x');
  await new Promise(r=>setTimeout(r,1000));
  assert.equal(fs.readFileSync(nav,'utf8'),before);
  // Switching back opens the editable report again.
  await a.locator('#report-select').selectOption('report.md');
  await waitPill(a,'Saved');
  assert.equal(await value(a),ORIGINAL.replace('Intro line.','Intro line. Before switching.'));
});

test('unknown Syncthing conflict copy can be reviewed and applied',{timeout:60000},async t=>{
  const env=await setup(t);
  const a=await (await env.context()).newPage();
  await open(a,env.base);
  const copy=path.join(path.dirname(env.report),'report.sync-conflict-20261123-101010-ABCDEFG.md');
  fs.writeFileSync(copy,ORIGINAL.replace('Closing line.','Closing line from the other device.'));
  await a.getByText('Syncthing kept a conflicting copy from device ABCDEFG.').waitFor({timeout:15000});
  await a.locator('.live-copy').getByRole('button',{name:'Review',exact:true}).click();
  await a.locator('.live-review .live-preview').filter({hasText:'Closing line from the other device.'}).waitFor();
  await a.getByRole('button',{name:'Apply',exact:true}).click();
  await waitFile(env,text=>text.includes('Closing line from the other device.'),'copy applied');
  await waitValue(a,v=>v.includes('Closing line from the other device.'),'editor updated');
  await waitFor(()=>!fs.existsSync(copy),'copy removed');
  await a.getByText(/Syncthing kept a conflicting copy/).waitFor({state:'detached'});
  await a.getByRole('button',{name:'History'}).click();
  await a.locator('.live-history-entry').filter({hasText:'Syncthing copy archived'}).waitFor();
});

test('outside write updates the rendered Preview while reading',{timeout:60000},async t=>{
  const env=await setup(t);
  const a=await (await env.context()).newPage();
  await open(a,env.base);
  await a.locator('#live-report-host .editor-toolbar button.preview').click();
  const shown=a.locator('#live-report-host .editor-preview-full.editor-preview-active');
  await shown.filter({hasText:'Intro line.'}).waitFor();
  outsideWrite(env.report,ORIGINAL.replace('Intro line.','Intro from an agent.'));
  await waitValue(a,v=>v.includes('Intro from an agent.'),'outside change reached the editor');
  await shown.filter({hasText:'Intro from an agent.'}).waitFor({timeout:5000});
  await a.getByText('Updated outside the Board').waitFor();
  assert.equal(await pill(a),'Saved');
});

test('resolving a conflict while reading the Preview shows the resolved text',{timeout:60000},async t=>{
  const env=await setup(t);
  const a=await (await env.context()).newPage();
  await open(a,env.base);
  const hold=await holdNextSave(env);
  await typeAtLineEnd(a,'Middle line.',' Mine.');
  await hold.entered();
  await a.locator('#live-report-host .editor-toolbar button.preview').click();
  const shown=a.locator('#live-report-host .editor-preview-full.editor-preview-active');
  await shown.waitFor();
  outsideWrite(env.report,ORIGINAL.replace('Middle line.','Middle line from agent.'));
  hold.release();
  await waitPill(a,'Conflict');
  await shown.filter({hasText:'(Bounty Board)'}).waitFor({timeout:5000});
  await a.getByRole('button',{name:'Keep saved'}).first().click();
  await waitFile(env,text=>text.includes('Middle line from agent.') && !text.includes('<<<<<<<') && !text.includes('Mine.'),'saved side kept');
  await waitPill(a,'Saved');
  await waitFor(async()=>{const text=await shown.textContent();return text.includes('Middle line from agent.') && !text.includes('(Bounty Board)') && !text.includes('Mine.');},'Preview shows the resolved text',5000);
});
