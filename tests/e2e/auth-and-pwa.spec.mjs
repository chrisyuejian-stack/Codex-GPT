import { test, expect } from '@playwright/test';
import { createHarness, loginUI, gotoHash, assertNoOverflow, waitAppReady } from './helpers.mjs';

test.describe('认证、换人离线数据清理与 PWA 离线验收', () => {
  test('@smoke 登录、登出与换人登录后离线数据清除', async ({ browser, request }, info) => {
    const h = await createHarness(browser, request, info, ['student'], { bootstrapSession: false });
    const { student, student2 } = h.manifest.loginAccounts;
    // 允许测试期间对 /api/me 的登出后探测返回 401
    h.allowFailedRequest(r => r.path === '/api/me' && r.status === 401);
    try {
      const page = h.actors.student.page;

      // 1. 学员 1（王一然）真实登录
      await loginUI(page, student.phone, student.password);
      await expect(page.locator('body')).toContainText(/王一然|一然，/);
      await assertNoOverflow(page, 'student1-home');

      // 确认本地离线缓存已写入且归属学员 1
      await expect.poll(async () => page.evaluate(() => {
        const raw = localStorage.getItem('fq_offline_v1');
        return raw ? JSON.parse(raw).user_id : null;
      })).toBeTruthy();
      const firstOwner = await page.evaluate(() => JSON.parse(localStorage.getItem('fq_offline_v1')).user_id);

      // 2. 通过界面退出登录
      const mineBtn = page.getByRole('button', { name: /我的|账号/ }).first();
      if (await mineBtn.count() && await mineBtn.isVisible()) {
        await mineBtn.click();
        await page.waitForTimeout(300);
      }
      const logoutBtn = page.getByRole('button', { name: /退出登录|退出/ }).first();
      await expect(logoutBtn).toBeVisible();
      await logoutBtn.click();
      await page.waitForURL('**/login**', { timeout: 15_000 });

      // 登出后离线缓存必须清空
      const afterLogout = await page.evaluate(() => localStorage.getItem('fq_offline_v1'));
      expect(afterLogout).toBeNull();

      // 3. 模拟旧用户残留离线缓存，再用学员 2（陈思语）登录 -> 旧用户离线数据必须被清除
      await page.evaluate(owner => {
        localStorage.setItem('fq_offline_v1', JSON.stringify({
          user_id: owner,
          items: { me: { at: Date.now(), value: { user: { id: owner, name: '旧用户残留' } } } },
        }));
      }, firstOwner);

      await loginUI(page, student2.phone, student2.password);
      await expect(page.locator('body')).toContainText(/陈思语|思语，/);
      await expect(page.locator('body')).not.toContainText('旧用户残留');

      await expect.poll(async () => page.evaluate(() => {
        const raw = localStorage.getItem('fq_offline_v1');
        return raw ? JSON.parse(raw).user_id : null;
      })).not.toBe(firstOwner);

      await h.healthy();
    } finally {
      await h.close();
    }
  });

  test('PWA manifest、Service Worker 注册与老师/学员断网离线查看', async ({ browser, request }, info) => {
    const h = await createHarness(browser, request, info, ['teacher', 'student'], { fixedClock: true });
    try {
      // 1. 校验 manifest.webmanifest
      const manifestRes = await request.get('/manifest.webmanifest');
      expect(manifestRes.status()).toBe(200);
      const webManifest = await manifestRes.json();
      expect(webManifest.name || webManifest.short_name).toBeTruthy();
      expect(Array.isArray(webManifest.icons) && webManifest.icons.length > 0).toBeTruthy();
      expect(webManifest.display).toBe('standalone');

      // 2. 老师端：打开今天页、确认 SW 注册、访问课表页写入离线缓存，切回今天页后断网再切课表
      const teacherPage = await h.openApp('teacher', '#today');
      await expect(teacherPage.locator('body')).toContainText('钢琴 1 对 1');

      const swState = await teacherPage.evaluate(async () => {
        if (!('serviceWorker' in navigator)) return 'unsupported';
        const reg = await Promise.race([
          navigator.serviceWorker.ready,
          new Promise(resolve => setTimeout(() => resolve(null), 8000)),
        ]);
        return reg ? (reg.active?.state || 'registered') : 'timeout';
      });
      expect(['activated', 'activating', 'installed', 'registered']).toContain(swState);

      await gotoHash(teacherPage, '#schedule');
      await expect(teacherPage.locator('body')).toContainText('钢琴 1 对 1');
      const teacherCached = await teacherPage.evaluate(() => {
        const raw = localStorage.getItem('fq_offline_v1');
        return raw ? Object.keys(JSON.parse(raw).items || {}) : [];
      });
      expect(teacherCached.some(k => k.startsWith('schedule'))).toBeTruthy();

      // 断网模拟（阻断全部 /api/** 网络请求）后刷新页面，验证老师端回退到本地离线数据并显示离线提示条
      const teacherOffline = route => route.abort('internetdisconnected');
      await teacherPage.route('**/api/**', teacherOffline);
      await teacherPage.reload({ waitUntil: 'domcontentloaded' });
      await expect(teacherPage.locator('.fq-offline-bar')).toBeVisible({ timeout: 10_000 });
      await expect(teacherPage.locator('.fq-offline-bar')).toContainText('离线');
      await expect(teacherPage.locator('body')).toContainText('钢琴 1 对 1');
      await teacherPage.unroute('**/api/**', teacherOffline);

      // 3. 学员端：在线加载首页与课表写入离线缓存，断网刷新后仍可见离线数据与提示条
      const studentPage = await h.openApp('student', '#today');
      await expect(studentPage.locator('body')).toContainText(/王一然|一然，/);
      await studentPage.getByRole('button', { name: /课表/ }).first().click();
      await studentPage.waitForTimeout(400);
      await expect(studentPage.locator('body')).toContainText('钢琴 1 对 1');

      const studentOffline = route => route.abort('internetdisconnected');
      await studentPage.route('**/api/**', studentOffline);
      await studentPage.reload({ waitUntil: 'domcontentloaded' });
      await expect(studentPage.locator('.fq-offline-bar')).toBeVisible({ timeout: 10_000 });
      await expect(studentPage.locator('.fq-offline-bar')).toContainText('离线');
      await expect(studentPage.locator('body')).toContainText(/王一然|一然，|钢琴 1 对 1/);
      await studentPage.unroute('**/api/**', studentOffline);
      await waitAppReady(studentPage);

      await h.healthy();
    } finally {
      await h.close();
    }
  });
});
