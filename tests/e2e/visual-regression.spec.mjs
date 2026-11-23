import { test, expect } from '@playwright/test';
import { createHarness, gotoHash, assertNoOverflow } from './helpers.mjs';

const VISUAL_PAGES = [
  { name: 'today', hash: '#today' },
  { name: 'todo', hash: '#todo-unchecked' },
  { name: 'students', hash: '#students' },
  { name: 'schedule', hash: '#schedule-week' },
  { name: 'leads', hash: '#enrol-leads' },
  { name: 'teachers', hash: '#settings-teachers' },
  { name: 'settings', hash: '#settings-overview' },
];

test.describe('关键页面视觉回归基线（固定示例数据与时间）', () => {
  test('今天、待办与五个重做页面视觉回归对比', async ({ browser, request }, info) => {
    const h = await createHarness(browser, request, info, ['supervisor'], { fixedClock: true });
    try {
      const page = await h.openApp('supervisor', '#today');
      await page.evaluate(() => document.fonts?.ready);

      for (const target of VISUAL_PAGES) {
        await gotoHash(page, target.hash);
        if (target.name === 'students' && !info.project.use.isMobile) {
          await page.locator('.fq-st-row, .fq-st-item, [data-student-id]').filter({ hasText: '王一然' }).first().click();
          await page.waitForTimeout(350);
        }
        await page.evaluate(() => document.fonts?.ready);
        await page.waitForTimeout(450);
        await assertNoOverflow(page, `visual-${target.name}`);
        await expect(page).toHaveScreenshot(`${target.name}.png`, {
          fullPage: false,
          maxDiffPixelRatio: 0.02,
          animations: 'disabled',
        });
      }

      await h.healthy();
    } finally {
      await h.close();
    }
  });
});
