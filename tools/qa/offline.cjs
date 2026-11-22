// 离线查看端到端：登录 → 浏览 → 断网刷新 → 检查提示条与内容 → 恢复网络
const { chromium, devices } = require('playwright');
const BASE = 'http://localhost:4173';
const [phone, pw, tag, tabs] = process.argv.slice(2);
(async () => {
  const b = await chromium.launch();
  const c = await b.newContext({ ...devices['iPhone 13'] });
  const p = await c.newPage();
  await p.goto(BASE + '/login');
  await p.waitForLoadState('networkidle');
  await p.fill('input[type=password]', pw);
  await p.locator('input:not([type=password])').first().fill(phone);
  await p.keyboard.press('Enter');
  await p.waitForTimeout(800);
  await p.waitForLoadState('networkidle');
  // 等 Service Worker 接管页面
  await p.evaluate(async () => { await navigator.serviceWorker?.ready; });
  await p.reload();
  await p.waitForLoadState('networkidle');
  for (const name of (tabs || '').split(',').filter(Boolean)) {
    const loc = p.locator('nav button:visible, nav a:visible, [role=tab]:visible').filter({ hasText: name }).first();
    if (await loc.count()) { await loc.click(); await p.waitForTimeout(400); await p.waitForLoadState('networkidle'); }
  }
  // 回到首页
  const first = p.locator('nav button:visible, nav a:visible').first();
  if (await first.count()) { await first.click(); await p.waitForTimeout(400); await p.waitForLoadState('networkidle'); }
  const stored = await p.evaluate(() => { const s = JSON.parse(localStorage.getItem('fq_offline_v1') || 'null'); return s ? { user: s.user_id, keys: Object.keys(s.items) } : null; });
  console.log(tag, 'stored:', JSON.stringify(stored));
  const onlineText = (await p.locator('#root').innerText()).replace(/\s+/g, ' ').slice(0, 160);
  await c.setOffline(true);
  await p.reload().catch((e) => console.log('reload err', e.message));
  await p.waitForTimeout(2500);
  const bar = await p.locator('.fq-offline-bar').innerText().catch(() => '(无提示条)');
  const offlineText = (await p.locator('#root').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160);
  console.log(tag, 'online :', onlineText);
  console.log(tag, 'offline:', offlineText);
  console.log(tag, 'banner :', bar);
  await p.screenshot({ path: __dirname + '/offline-' + tag + '.png' });
  // 离线时尝试切到第二个标签（应显示保存的数据或友好错误，不白屏）
  for (const name of (tabs || '').split(',').filter(Boolean).slice(0, 1)) {
    const loc = p.locator('nav button:visible, nav a:visible, [role=tab]:visible').filter({ hasText: name }).first();
    if (await loc.count()) { await loc.click(); await p.waitForTimeout(1200); console.log(tag, 'offline tab', name, ':', (await p.locator('#root').innerText()).replace(/\s+/g, ' ').slice(0, 140)); }
  }
  await c.setOffline(false);
  await p.dispatchEvent('body', 'online').catch(() => {});
  await p.evaluate(() => dispatchEvent(new Event('online')));
  await p.waitForTimeout(300);
  console.log(tag, 'after online banner:', await p.locator('.fq-offline-bar').innerText().catch(() => '(无)'));
  // 登出后本机数据应被清除
  const out = await p.evaluate(async () => { await fetch('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); return 0; });
  await b.close();
})();
