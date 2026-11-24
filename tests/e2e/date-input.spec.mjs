import { test, expect } from '@playwright/test';
import { createHarness, topSheet, closeAllSheets } from './helpers.mjs';

async function verifyDateControlWidget(page, scope, { testClear = false } = {}) {
  const dateWrap = scope.locator('.ui-date').first();
  await expect(dateWrap).toBeVisible();
  const input = dateWrap.locator('.ui-date-input');
  const btn = dateWrap.locator('.ui-date-btn');
  await expect(input).toBeVisible();
  await expect(btn).toBeVisible();

  // 1. 键入合法日期（斜杠、点号、紧凑 8 位，均在固定时钟 2026-11-12 及之前以兼容收款日期 max=today）
  await input.fill('2026/11/08');
  await input.dispatchEvent('blur');
  await expect(input).toHaveValue('2026-11-08');

  await input.fill('2026.11.10');
  await input.dispatchEvent('blur');
  await expect(input).toHaveValue('2026-11-10');

  // 2. 粘贴紧凑 8 位日期
  await input.fill('20261111');
  await input.dispatchEvent('blur');
  await expect(input).toHaveValue('2026-11-11');

  // 3. 键入非法日期：显示错误且保留用户已输入原文不丢失
  await input.fill('2026-02-30');
  await input.dispatchEvent('blur');
  await expect(input).toHaveValue('2026-02-30');
  await expect(input).toHaveAttribute('aria-invalid', 'true');

  // 恢复合法日期（1 月）以测试跨年翻月
  await input.fill('2026-01-15');
  await input.dispatchEvent('blur');
  await expect(input).toHaveValue('2026-01-15');
  await expect(input).not.toHaveAttribute('aria-invalid', 'true');

  // 4. 打开日历浮层，测试上/下个月连续点击与跨年边界（热区 >= 40x40）
  await btn.click();
  const cal = dateWrap.locator('.ui-calendar:not([hidden])');
  await expect(cal).toBeVisible();
  const title = cal.locator('.ui-calendar-title');
  await expect(title).toHaveText('2026年1月');

  const prevBtn = cal.locator('button[aria-label="上个月"]');
  const nextBtn = cal.locator('button[aria-label="下个月"]');
  const prevBox = await prevBtn.boundingBox();
  expect(prevBox.width).toBeGreaterThanOrEqual(40);
  expect(prevBox.height).toBeGreaterThanOrEqual(40);

  for (const expected of ['2025年12月', '2025年11月', '2025年10月']) {
    await prevBtn.click();
    await expect(cal).toBeVisible();
    await expect(title).toHaveText(expected);
  }
  for (const expected of ['2025年11月', '2025年12月', '2026年1月']) {
    await nextBtn.click();
    await expect(cal).toBeVisible();
    await expect(title).toHaveText(expected);
  }

  // 5. 年月快选
  await title.click();
  await expect(cal.locator('.ui-calendar-ym')).toBeVisible();
  await cal.locator('.ui-calendar-mbtn', { hasText: '11月' }).click();
  await expect(title).toHaveText('2026年11月');

  // 6. 键盘方向键与日历点选
  const activeDay = cal.locator('.ui-calendar-day[tabindex="0"]');
  await activeDay.focus();
  await page.keyboard.press('ArrowRight');
  await cal.locator('.ui-calendar-day[data-date="2026-11-12"]').click();
  await expect(cal).toBeHidden();
  await expect(input).toHaveValue('2026-11-12');

  if (testClear) {
    await btn.click();
    await expect(cal).toBeVisible();
    const clearBtn = cal.locator('.ui-calendar-quick', { hasText: '清除' });
    if (await clearBtn.count()) {
      await clearBtn.click();
      await expect(cal).toBeHidden();
      await expect(input).toHaveValue('');
    } else {
      await page.keyboard.press('Escape');
    }
  }
}

test.describe('任务 #14 日期输入与日历组件双端回归（5 大页面覆盖）', () => {
  test('@smoke 覆盖设置日期筛选、新建课程、固定排课、线索回访、登记缴费 5 个页面的日期输入与翻月', async ({ browser, request }, info) => {
    const h = await createHarness(browser, request, info, ['supervisor']);
    try {
      // 1. 设置 -> 操作记录 日期筛选
      const page = await h.openApp('supervisor', '#settings-logs');
      await verifyDateControlWidget(page, page.locator('.v-content'), { testClear: true });

      // 2. 课表 -> 新建课程日期
      await h.openApp('supervisor', '#schedule-week');
      const addLessonBtn = page.getByRole('button', { name: '排课', exact: true }).first();
      await expect(addLessonBtn).toBeVisible();
      await addLessonBtn.click();
      const lessonSheet = topSheet(page);
      await expect(lessonSheet).toBeVisible();
      await verifyDateControlWidget(page, lessonSheet);
      const hiddenStart = lessonSheet.locator('input[name="start_at"]');
      await expect(hiddenStart).toHaveValue(/^2026-11-12T/);
      const discardDrawer = async () => {
        for (let i = 0; i < 4; i++) {
          if (!(await page.locator('.ui-sheet').count())) break;
          await page.keyboard.press('Escape');
          await page.waitForTimeout(200);
          const confirmDlg = page.locator("dialog[open]:has-text('放弃'), dialog[open]:has-text('未保存')").last();
          const confirmBtn = confirmDlg.locator("button:has-text('放弃'), button:has-text('离开'), button:has-text('确定')").last();
          if (await confirmBtn.count() && await confirmBtn.isVisible()) {
            await confirmBtn.click();
            await page.waitForTimeout(250);
          }
        }
        await expect(page.locator('.ui-sheet')).toHaveCount(0);
      };

      await discardDrawer();

      // 3. 课表 -> 固定排课 -> 新建固定排课生效开始/结束日期
      await h.openApp('supervisor', '#schedule-templates');
      const addTplBtn = page.locator("button:has-text('新建固定排课'), button:has-text('在周一添加'), .fq-sc-badd").first();
      if (await addTplBtn.count() && await addTplBtn.isVisible()) {
        await addTplBtn.click();
        const tplSheet = topSheet(page);
        await expect(tplSheet).toBeVisible();
        await verifyDateControlWidget(page, tplSheet);
        await discardDrawer();
      }

      // 4. 线索 -> 新建线索下次回访日期
      await h.openApp('supervisor', '#enrol-leads');
      const addLeadBtn = page.locator("button:has-text('登记线索'), button:has-text('新建线索')").first();
      await expect(addLeadBtn).toBeVisible();
      await addLeadBtn.click();
      const leadSheet = topSheet(page);
      await expect(leadSheet).toBeVisible();
      await verifyDateControlWidget(page, leadSheet);
      await discardDrawer();

      // 5. 财务 -> 登记缴费收款日期
      await h.openApp('supervisor', '#finance-overview');
      const payBtn = page.getByRole('button', { name: /登记缴费/ }).first();
      await expect(payBtn).toBeVisible();
      await payBtn.click();
      const paySheet = topSheet(page);
      await expect(paySheet).toBeVisible();
      await verifyDateControlWidget(page, paySheet);
      await discardDrawer();

      await h.healthy();
    } finally {
      await h.close();
    }
  });
});
