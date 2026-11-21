const { chromium, devices } = require('playwright');
const BASE='http://localhost:4173';
const [phone,pw,clicks]=process.argv.slice(2);
(async()=>{
  const b=await chromium.launch(); const ctx=await b.newContext({...devices['iPhone 13']});
  const page=await ctx.newPage(); let log=[]; let t0=Date.now();
  page.on('request',r=>{ if(r.url().includes('/api/')) log.push({t:Date.now()-t0,m:r.method(),u:r.url().replace(BASE,''),body:r.postData()}); });
  page.on('requestfinished',r=>{ const l=log.find(x=>x.u===r.url().replace(BASE,'')&&!x.end); if(l) l.end=Date.now()-t0; });
  const dump=(title)=>{console.log('---',title,page.url());for(const l of log) console.log(String(l.t).padStart(5),String(l.end??'').padStart(5),l.m,l.u,l.body?l.body.slice(0,400):'');};
  await page.goto(BASE+'/login'); await page.waitForLoadState('networkidle'); dump('cold /login');
  await page.fill('input[type=password]',pw);
  await page.locator('input:not([type=password])').first().fill(phone);
  log=[]; t0=Date.now();
  await page.keyboard.press('Enter'); await page.waitForTimeout(500); await page.waitForLoadState('networkidle'); dump('after login');
  log=[]; t0=Date.now(); await page.reload(); await page.waitForLoadState('networkidle'); dump('reload');
  const navs = await page.$$eval('nav button, nav a, [role=tab]', els=>els.filter(e=>e.offsetParent).map(e=>e.textContent.trim()).filter(Boolean));
  console.log('NAV', JSON.stringify(navs));
  for (const name of (clicks||'').split(',').filter(Boolean)) {
    log=[]; t0=Date.now();
    const loc=page.locator(`nav button:visible, nav a:visible, [role=tab]:visible`).filter({hasText:name}).first();
    if(!(await loc.count())) { console.log('no nav',name); continue; }
    await loc.click(); await page.waitForTimeout(300); await page.waitForLoadState('networkidle'); dump('click '+name);
  }
  await page.screenshot({path:__dirname+'/'+phone+'.png'});
  await b.close();
})();
