const { chromium, devices } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const c = await b.newContext({ ...devices['iPhone 13'] });
  const p = await c.newPage();
  const errs = [];
  p.on('response', (r) => {
    if (r.url().includes('/api/') && r.status() >= 400) errs.push(r.status() + ' ' + r.request().method() + ' ' + r.url().replace('http://localhost:4173', ''));
  });
  await p.goto('http://localhost:4173/login');
  await p.fill('input[type=password]', 'PreviewSecure9Z');
  await p.locator('input:not([type=password])').first().fill('13911112222');
  await p.keyboard.press('Enter');
  await p.waitForTimeout(800);
  await p.waitForLoadState('networkidle');
  await p.locator('nav button:visible, nav a:visible').filter({ hasText: '待办' }).first().click();
  await p.waitForTimeout(500);
  await p.waitForLoadState('networkidle');
  const items = await p.$$eval('.fq-item', (els) => els.map((e) => ({ t: e.innerText.replace(/\s+/g, ' ').slice(0, 90), off: !!e.querySelector('.is-off') })));
  console.log(JSON.stringify(items));
  console.log('noperm', await p.$$eval('.fq-noperm', (els) => els.map((e) => e.textContent)));
  const btns = p.locator('.fq-item .fq-ops button:not([disabled])').filter({ hasNotText: '稍后' });
  const n = await btns.count();
  console.log('enabled buttons', n);
  for (let i = 0; i < Math.min(n, 8); i++) {
    const bt = btns.nth(i);
    const txt = (await bt.innerText().catch(() => '?')).trim();
    await bt.click({ timeout: 3000 }).catch((e) => console.log('clickerr', e.message.split('\n')[0]));
    await p.waitForTimeout(800);
    const toast = await p.locator('#toast').innerText().catch(() => '');
    console.log('click', txt, '| toast:', toast.trim());
    await p.keyboard.press('Escape');
    await p.waitForTimeout(300);
  }
  console.log('api errors', errs);
  await p.screenshot({ path: __dirname + '/todo.png', fullPage: true });
  await b.close();
})();
