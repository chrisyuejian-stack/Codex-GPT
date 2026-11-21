// 生成设计稿模板：真实外壳（侧栏 + 顶栏 / 手机底栏），内容区清空并放占位符；CSS 用真实构建产物。
const { chromium, devices } = require('playwright');
const fs = require('fs');
const OUT = process.argv[2];
(async () => {
  const b = await chromium.launch();
  for (const [tag, dev] of [['desk', { viewport: { width: 1280, height: 800 } }], ['phone', { ...devices['iPhone 13'] }]]) {
    const c = await b.newContext(dev);
    const p = await c.newPage();
    await p.goto('http://localhost:4180/login');
    await p.fill('input[type=password]', 'PreviewSecure9Z');
    await p.locator('input:not([type=password])').first().fill('13911112222');
    await p.keyboard.press('Enter');
    await p.waitForTimeout(800);
    await p.waitForLoadState('networkidle');
    const html = await p.evaluate(() => {
      for (const s of document.querySelectorAll('script')) s.remove();
      const body = document.querySelector('section.content.v-content');
      body.innerHTML = '<!--CONTENT-->';
      const title = document.querySelector('header.v-head');
      if (title) title.setAttribute('data-mock', 'head');
      for (const l of document.querySelectorAll('link[rel=stylesheet]')) l.href = '../_shared/' + new URL(l.href).pathname.split('/').pop();
      for (const l of document.querySelectorAll('link[rel=manifest],link[rel=apple-touch-icon]')) l.remove();
      return '<!doctype html>\n' + document.documentElement.outerHTML;
    });
    fs.writeFileSync(`${OUT}/template-${tag}.html`, html);
    await c.close();
  }
  await b.close();
})();
