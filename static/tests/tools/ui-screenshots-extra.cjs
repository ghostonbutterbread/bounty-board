// Optional extra screenshot steps for ui-screenshots.cjs (EXTRA=this file).
module.exports=[async(page,out,prefix,theme)=>{
  const shot=name=>page.screenshot({path:`${out}/${prefix}-${name}-${theme}.png`});
  await page.getByRole('button',{name:'Findings',exact:true}).click();
  await page.getByRole('button',{name:'Filter severities',exact:true}).click();
  await page.getByRole('checkbox',{name:'HIGH'}).check();await page.getByRole('checkbox',{name:'CRITICAL'}).check();
  await page.waitForTimeout(250);await shot('filters');
  await page.keyboard.press('Escape');await page.getByRole('button',{name:'Clear all'}).click();
  await page.locator('[data-row-menu]').first().click();await page.waitForTimeout(250);await shot('row-menu');
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Switch program'}).click();await page.waitForTimeout(250);await shot('picker');
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Dashboard',exact:true}).click();
  await page.locator('[data-breakdown="sev:high"]').click();await page.waitForTimeout(250);
  await page.locator('[data-breakdown="sev:high"]').scrollIntoViewIfNeeded();await page.mouse.move(0,0);await shot('drill');
  await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));await page.waitForTimeout(200);await shot('dashboard-bottom');
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.getByRole('button',{name:'Theme',exact:true}).click();await page.waitForTimeout(200);await shot('theme-menu');await page.keyboard.press('Escape');
  await page.setViewportSize({width:820,height:1000});await page.getByRole('button',{name:'Programs',exact:true}).click();await page.waitForTimeout(400);await shot('tablet');
  await page.setViewportSize({width:375,height:800});await page.waitForTimeout(300);await shot('phone');
  await page.setViewportSize({width:1440,height:900});
}];
