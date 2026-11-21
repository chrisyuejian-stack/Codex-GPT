// 截取现有新版页面作为设计参照（员工：今天、待办、财务概览；电脑与手机）
const { chromium, devices } = require('playwright');
const BASE = 'http://localhost:4180';
const OUT = process.argv[2];
(async () => {
  const b = await chromium.launch();
  for (const [tag, dev] of [['desk', { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 }], ['phone', { ...devices['iPhone 13'], deviceScaleFactor: 1 }]]) {
    const c = await b.newContext(dev);
    const p = await c.newPage();
    await p.goto(BASE + '/login');
    await p.fill('input[type=password]', 'PreviewSecure9Z');
    await p.locator('input:not([type=password])').first().fill('13911112222');
    await p.keyboard.press('Enter');
    await p.waitForTimeout(800);
    await p.waitForLoadState('networkidle');
    await p.screenshot({ path: `${OUT}/ref-today-${tag}.png` });
    for (const [name, label] of [['todo', '待办'], ['finance', '财务'], ['students-current', '学员']]) {
      const loc = p.locator('nav button:visible, nav a:visible').filter({ hasText: label }).first();
      if (!(await loc.count())) continue;
      await loc.click();
      await p.waitForTimeout(600);
      await p.waitForLoadState('networkidle');
      await p.screenshot({ path: `${OUT}/ref-${name}-${tag}.png` });
    }
    await c.close();
  }
  await b.close();
})();
