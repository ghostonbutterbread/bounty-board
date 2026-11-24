// Screenshots of the finding actions on synthetic data (light and dark).
// Usage: node static/tests/tools/finding-actions-screenshots.cjs <outdir>
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
const {spawn}=require('node:child_process');const {chromium}=require('playwright');
const repo=path.resolve(__dirname,'../../..');
const out=path.resolve(process.argv[2]||path.join(os.tmpdir(),'screens'));
(async()=>{
  fs.mkdirSync(out,{recursive:true});
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN,args:['--no-sandbox','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
  for(const theme of ['light','dark']){
    const base=fs.mkdtempSync(path.join(os.tmpdir(),'finding-shots-'));
    const child=spawn('python3',['-u','tests/finding_actions_fixture.py',base,'writer'],{cwd:repo,env:{...process.env,PYTHONPATH:`${repo}:${repo}/tests`},stdio:['ignore','pipe','inherit']});
    try{
      const port=await new Promise((resolve,reject)=>{child.once('exit',c=>reject(Error(`fixture exited ${c}`)));child.stdout.once('data',d=>resolve(Number(String(d).trim())));});
      const context=await browser.newContext({viewport:{width:1440,height:900}});
      await context.addInitScript(t=>{try{localStorage.setItem('bounty-board-theme',t);}catch{}},theme);
      const page=await context.newPage();
      await page.goto(`http://127.0.0.1:${port}`);
      const shot=name=>page.screenshot({path:path.join(out,`${name}-${theme}.png`)});
      await page.locator('[data-breakdown="class:xss"]').click();
      await page.locator('.drill li[data-finding-id]').first().waitFor();
      await page.locator('.breakdown-row[data-class-name="xss"]').scrollIntoViewIfNeeded();
      await page.locator('li[data-finding-id="A02"] [data-sev-pick]').click();
      await page.getByRole('menu',{name:'Change severity'}).waitFor();await shot('severity-pills');
      await page.keyboard.press('Escape');
      await page.locator('li[data-finding-id="A03"] a.link-button').click({button:'right'});
      await page.locator('.context-menu').waitFor();await shot('context-menu');
      await page.keyboard.press('Escape');
      // Drag preview: selected rows held over a class row.
      await page.getByRole('checkbox',{name:'Select finding A02'}).click();
      await page.getByRole('checkbox',{name:'Select finding A03'}).click();
      await page.locator('li[data-finding-id="A02"] a.link-button').hover();await page.mouse.down();
      const t=await page.locator('.breakdown-row[data-class-name="idor"]').boundingBox();
      for(let i=0;i<5;i++)await page.mouse.move(t.x+40+i*10,t.y+t.height/2,{steps:3});
      await page.locator('.drop-preview').waitFor();await shot('drag-preview');
      await page.keyboard.press('Escape');await page.mouse.up();
      if(await page.locator('dialog[open]').count())await page.getByRole('button',{name:'Cancel'}).click();
      // Findings table: selection bar with the bulk severity pills, then the archive confirm.
      await page.getByRole('link',{name:'Programs',exact:true}).click();await page.locator('#program-select').selectOption('web_bounty/alpha');
      await page.locator('tr[data-finding-id]').first().waitFor();
      await page.getByRole('checkbox',{name:'Select finding A02'}).click();
      await page.getByRole('checkbox',{name:'Select finding A04'}).click({modifiers:['Shift']});
      await page.getByRole('region',{name:'Selected findings'}).getByRole('button',{name:'Change severity'}).click();
      await page.locator('.pill-popover').waitFor();await shot('selection-bar-bulk');
      await page.keyboard.press('Escape');
      await page.getByRole('region',{name:'Selected findings'}).getByRole('button',{name:'Delete',exact:true}).click();
      await page.getByRole('dialog').waitFor();await shot('archive-confirm');
      await page.getByRole('button',{name:'Cancel'}).click();
      await page.getByLabel('Show archived').check();
      await page.getByRole('button',{name:'Select template placeholders (2)'}).waitFor();
      await shot('findings-markers');
      await context.close();
    } finally {child.kill('SIGTERM');await new Promise(r=>child.exitCode!==null||child.signalCode!==null?r():child.once('exit',r));fs.rmSync(base,{recursive:true,force:true});}
  }
  await browser.close();
  console.log(fs.readdirSync(out).filter(f=>/^(severity|context|drag|selection|archive|findings-markers)/.test(f)).sort().map(f=>path.join(out,f)).join('\n'));
})().catch(e=>{console.error(e);process.exit(1);});
