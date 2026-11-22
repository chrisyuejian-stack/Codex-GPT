// 冷启动登录后的请求链：每个 /api 请求人为延迟 150ms，便于看出串行层数；统计重复请求与错误。
const { chromium, devices } = require('playwright');
const BASE = 'http://localhost:4173';
const [phone, pw, tag, clicks] = process.argv.slice(2);
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ ...devices['iPhone 13'] });
  await ctx.route('**/api/**', async (route) => { await new Promise((r) => setTimeout(r, 150)); await route.continue(); });
  const p = await ctx.newPage();
  let log = [], t0 = Date.now();
  const errs = [];
  p.on('request', (r) => { if (r.url().includes('/api/')) log.push({ t: Date.now() - t0, m: r.method(), u: r.url().replace(BASE, ''), body: r.postData() }); });
  p.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 400) errs.push(r.status() + ' ' + r.url().replace(BASE, '')); });
  p.on('pageerror', (e) => errs.push('pageerror ' + e.message));
  await p.goto(BASE + '/login');
  await p.waitForLoadState('networkidle');
  await p.fill('input[type=password]', pw);
  await p.locator('input:not([type=password])').first().fill(phone);
  log = []; t0 = Date.now();
  await p.keyboard.press('Enter');
  await p.waitForTimeout(600);
  await p.waitForLoadState('networkidle');
  const dump = (title) => {
    console.log('---', tag, title);
    const seen = new Map();
    for (const l of log) {
      const k = l.m + ' ' + l.u + (l.body && l.u.includes('read-batch') ? ' ' + l.body : '');
      seen.set(k, (seen.get(k) || 0) + 1);
      console.log(String(l.t).padStart(5), l.m, l.u, l.body && !l.u.includes('login') ? l.body.slice(0, 260) : '');
    }
    const dup = [...seen].filter(([, n]) => n > 1);
    if (dup.length) console.log('DUPLICATES', dup);
  };
  dump('cold login');
  for (const name of (clicks || '').split(',').filter(Boolean)) {
    log = []; t0 = Date.now();
    const loc = p.locator('nav button:visible, nav a:visible, [role=tab]:visible').filter({ hasText: name }).first();
    if (!(await loc.count())) { console.log('no nav', name); continue; }
    await loc.click(); await p.waitForTimeout(400); await p.waitForLoadState('networkidle');
    dump('click ' + name);
  }
  console.log('errors', errs);
  await b.close();
})();
