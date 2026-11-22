const { chromium, devices } = require('playwright');
const BASE='http://localhost:4173';
const [phone,pw]=process.argv.slice(2);
(async()=>{
  const b=await chromium.launch(); const ctx=await b.newContext({...devices['iPhone 13']});
  const page=await ctx.newPage(); let log=[]; let t0=Date.now();
  page.on('request',r=>{ if(r.url().includes('/api/')) log.push({t:Date.now()-t0,m:r.method(),u:r.url().replace(BASE,''), body:r.postData()}); });
  await page.goto(BASE+'/login'); await page.waitForLoadState('networkidle');
  await page.fill('input[type=tel], input[name=phone], input[autocomplete=username]',phone).catch(e=>console.log('fill',e.message));
  await page.fill('input[type=password]',pw);
  log=[]; t0=Date.now();
  await page.keyboard.press('Enter'); await page.waitForTimeout(500); await page.waitForLoadState('networkidle');
  console.log('--- after login', page.url());
  for(const l of log) console.log(l.t, l.m, l.u, l.body? l.body.slice(0,300):'');
  const navs = await page.$$eval('nav a, nav button, [role=tab]', els=>els.map(e=>e.textContent.trim()).filter(Boolean));
  console.log('NAV', JSON.stringify(navs));
  for (const name of (process.env.PAGES||'').split(',').filter(Boolean)) {
    log=[]; t0=Date.now();
    const loc=page.locator(`nav >> text="${name}"`).first();
    if(!(await loc.count())) { console.log('no nav',name); continue; }
    await loc.click({force:true}); await page.waitForTimeout(300); await page.waitForLoadState('networkidle');
    console.log('--- page',name, page.url()); for(const l of log) console.log(l.t,l.m,l.u,l.body?l.body.slice(0,200):'');
  }
  await b.close();
})();
