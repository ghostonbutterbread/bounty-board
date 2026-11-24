// Capture synthetic UI screenshots: node static/tests/tools/ui-screenshots.cjs OUTDIR PREFIX
// Uses tests/ui_showcase_fixture.py (fictional data only) in a fresh temp root.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process');
const {chromium}=require('playwright');
(async()=>{
  const out=path.resolve(process.argv[2]||path.join(os.tmpdir(),'ui-shots')), prefix=process.argv[3]||'shot';
  fs.mkdirSync(out,{recursive:true});
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ui-shot-'));
  const repo=path.resolve(__dirname,'../../..');
  const child=spawn('python3',['-u','tests/ui_showcase_fixture.py',root],{cwd:repo,env:{...process.env,PYTHONPATH:repo},stdio:['ignore','pipe','inherit']});
  let browser;
  try {
    const port=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',c=>reject(Error('fixture exited '+c)));child.stdout.once('data',d=>resolve(Number(String(d).trim())));});
    const base=`http://127.0.0.1:${port}/`;
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN,args:['--no-sandbox','--disable-dev-shm-usage','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    for(const theme of (process.env.THEMES||'light,dark').split(',')){
      const context=await browser.newContext({viewport:{width:1440,height:900}});
      await context.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
      await context.addInitScript(t=>{try{localStorage.setItem('bounty-board-theme',t);}catch{}},theme);
      const page=await context.newPage();
      await page.goto(base);
      await page.getByRole('button',{name:'Programs',exact:true}).waitFor();
      await page.locator('.stat').first().waitFor();
      await page.waitForTimeout(1500);
      await page.screenshot({path:path.join(out,`${prefix}-dashboard-${theme}.png`)});
      await page.getByRole('button',{name:'Programs',exact:true}).click();
      await page.locator('#program-select').selectOption('web_bounty/acme-cloud');
      await page.locator('#lane-select').selectOption('web');
      await page.locator('body').click({position:{x:5,y:890}});
      const deadline=Date.now()+15000;
      while(!(await page.getByText('Invoice export reachable across organizations by numeric ID').count())){
        if(Date.now()>deadline)throw Error('findings did not load');
        for(const name of ['Apply selected lane','Apply loaded reports']){const b=page.getByRole('button',{name});if(await b.count() && await b.first().isVisible())await b.first().click();}
        await page.waitForTimeout(200);
      }
      await page.waitForTimeout(500);
      await page.screenshot({path:path.join(out,`${prefix}-findings-${theme}.png`)});
      await page.getByRole('button',{name:'Reports',exact:true}).click();
      await page.locator('.CodeMirror, #live-report-host').first().waitFor({timeout:10000}).catch(()=>{});
      await page.waitForTimeout(700);
      await page.screenshot({path:path.join(out,`${prefix}-reports-${theme}.png`)});
      if(process.env.EXTRA)for(const step of require(path.resolve(process.env.EXTRA)))await step(page,out,prefix,theme);
      await context.close();
    }
    console.log('screenshots in',out);
  } finally {if(browser)await browser.close();child.kill();fs.rmSync(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exit(1);});
