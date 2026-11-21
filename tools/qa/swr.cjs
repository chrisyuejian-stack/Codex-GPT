// 老师/学员端切页：第二次进入时是否立即显示上次画面（无骨架），以及后台更新后内容正常；手机彩条随滚动。
const { chromium, devices } = require('playwright');
const BASE = 'http://localhost:4185';
const [phone, pw, tag, tabsArg] = process.argv.slice(2);
const tabs = tabsArg.split(',');
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ ...devices['iPhone 13'] });
  await ctx.route('**/api/**', async (r) => { await new Promise((x) => setTimeout(x, 400)); await r.continue(); });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(BASE + '/login');
  await p.fill('input[type=password]', pw);
  await p.locator('input:not([type=password])').first().fill(phone);
  await p.keyboard.press('Enter');
  await p.waitForTimeout(1500);
  await p.waitForLoadState('networkidle');
  const click = async (name) => {
    const loc = p.locator('nav button:visible, nav a:visible, [role=tab]:visible').filter({ hasText: name }).first();
    await loc.click();
  };
  // 第一轮：依次进入每个页签（建立缓存）
  for (const t of [...tabs.slice(1), tabs[0]]) { await click(t); await p.waitForTimeout(1200); await p.waitForLoadState('networkidle'); }
  // 第二轮：切页后 100ms 内检查是否已有内容、是否出现骨架
  for (const t of tabs.slice(1)) {
    await click(t);
    await p.waitForTimeout(100);
    const s = await p.evaluate(() => {
      const c = document.querySelector('.personal-content');
      return { skeleton: !!c?.querySelector('.ui-skeleton, [class*=skeleton]'), refreshing: !!c?.classList.contains('is-refreshing'), text: (c?.innerText || '').replace(/\s+/g, ' ').slice(0, 50) };
    });
    await p.waitForTimeout(1500);
    const after = await p.evaluate(() => { const c = document.querySelector('.personal-content'); return { n: document.querySelectorAll('.personal-content').length, refreshing: !!c?.classList.contains('is-refreshing'), text: (c?.innerText || '').replace(/\s+/g, ' ').slice(0, 50) }; });
    console.log(tag, t, '100ms:', JSON.stringify(s), '| 1.6s:', JSON.stringify(after));
  }
  // 彩条：滚动后是否跟着页面走
  await p.evaluate(() => window.scrollTo(0, 300));
  await p.waitForTimeout(200);
  console.log(tag, 'ribbon position:', await p.evaluate(() => getComputedStyle(document.body, '::before').position), 'scrollY', await p.evaluate(() => scrollY));
  console.log(tag, 'errors', errs);
  await b.close();
})();
