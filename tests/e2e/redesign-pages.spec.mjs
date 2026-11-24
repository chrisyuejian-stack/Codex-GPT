import { test, expect } from '@playwright/test';
import { createHarness, gotoHash, assertNoOverflow, topSheet, closeAllSheets } from './helpers.mjs';

test.describe('第三期五个重做页面双端验收', () => {
  test('@smoke 学员页主视图、尾号搜索、详情与多页签', async ({ browser, request }, info) => {
    const isMobile = Boolean(info.project.use.isMobile);
    const h = await createHarness(browser, request, info, ['supervisor']);
    try {
      const page = await h.openApp('supervisor', '#students');
      await expect(page.locator('.fq-st-row, .fq-st-item, [data-student-id]').first()).toBeVisible();
      await assertNoOverflow(page, 'students');

      // 决定 4：手机端不显示导出 Excel 按钮
      if (isMobile) {
        await expect(page.locator("button:has-text('导出 Excel')")).toHaveCount(0);
      }

      // 手机尾号搜索 0008 -> 命中王一然（限定在 .v-content 内避免命中隐藏全局搜索）
      const search = page.locator(".v-content input[placeholder*='手机尾号'], .v-content input[placeholder*='姓名']").first();
      await expect(search).toBeVisible();
      await search.fill('0008');
      await page.waitForTimeout(500);
      await expect(page.locator('.v-content')).toContainText('王一然');
      await search.fill('');
      await page.waitForTimeout(400);

      // 选中王一然，核对详情与页签切换（电脑端右栏详情 / 手机端详情或抽屉）
      await page.locator('.fq-st-row, .fq-st-item, [data-student-id]').filter({ hasText: '王一然' }).first().click();
      await page.waitForTimeout(400);
      const scope = (await page.locator('.ui-sheet').count()) ? topSheet(page) : page.locator('.v-content');
      await expect(scope).toContainText('王一然');

      for (const tabName of ['课时与缴费', '课表', '点评']) {
        const tab = scope.locator(`button:has-text('${tabName}'), [role='tab']:has-text('${tabName}')`).first();
        if (await tab.count() && await tab.isVisible()) {
          await tab.click();
          await page.waitForTimeout(300);
        }
      }
      await closeAllSheets(page);
      await h.healthy();
    } finally {
      await h.close();
    }
  });

  test('@smoke 课表页周/日视图切换、排课抽屉与课程详情', async ({ browser, request }, info) => {
    const isMobile = Boolean(info.project.use.isMobile);
    const h = await createHarness(browser, request, info, ['supervisor']);
    try {
      const page = await h.openApp('supervisor', '#schedule-week');
      if (isMobile) {
        await expect(page.locator('.fq-sc-phone')).toBeVisible();
      } else {
        await expect(page.locator('.fq-sc-cal')).toBeVisible();
      }
      await assertNoOverflow(page, 'schedule-week');

      if (!isMobile) {
        // 切换日视图
        const dayBtn = page.locator(".fq-sc-bar button:has-text('日')").first();
        await expect(dayBtn).toBeVisible();
        await dayBtn.click();
        await page.waitForTimeout(400);
        await expect(page.locator('.v-content')).toContainText('钢琴 1 对 1');

        // 切回周视图
        const weekBtn = page.locator(".fq-sc-bar button:has-text('周')").first();
        if (await weekBtn.count()) {
          await weekBtn.click();
          await page.waitForTimeout(400);
        }
      }

      // 打开新建课程抽屉（exact: true 避免命中“固定排课”页签）
      const addBtn = page.getByRole('button', { name: '排课', exact: true }).first();
      await expect(addBtn).toBeVisible();
      await addBtn.click();
      const drawer = topSheet(page);
      await expect(drawer).toBeVisible();
      await expect(drawer).toContainText(/新建课程|排课/);
      await closeAllSheets(page);

      // 打开一节已有课程的详情抽屉
      const lessonCard = page.locator('.fq-sc-ev, .fq-sc-lc, .fq-sc-agday button').filter({ hasText: '钢琴 1 对 1' }).first();
      if (await lessonCard.count() && await lessonCard.isVisible()) {
        await lessonCard.click();
        const detail = topSheet(page);
        await expect(detail).toBeVisible();
        await closeAllSheets(page);
      }

      await h.healthy();
    } finally {
      await h.close();
    }
  });

  test('@smoke 线索页看板/列表与抽屉回访展示', async ({ browser, request }, info) => {
    const isMobile = Boolean(info.project.use.isMobile);
    const h = await createHarness(browser, request, info, ['supervisor']);
    try {
      const page = await h.openApp('supervisor', '#enrol-leads');
      await expect(page.locator('.fq-ld-page').first()).toBeVisible();
      await assertNoOverflow(page, 'enrol-leads');

      // 决定 10：手机端只显示列表，不显示看板列
      if (isMobile) {
        await expect(page.locator('.fq-ld-board')).toHaveCount(0);
        await expect(page.locator('.fq-ld-plist')).toBeVisible();
      } else {
        await expect(page.locator('.fq-ld-board')).toBeVisible();
      }

      // 点击周小乐打开详情（电脑端 .ui-sheet 抽屉，手机端页内详情）并核对历史回访记录可见
      const target = isMobile
        ? page.locator('.fq-ld-plist button, .fq-ld-plist [role="button"], .fq-ld-plist article, .fq-ld-plist li').filter({ hasText: '周小乐' }).first()
        : page.locator('.fq-ld-lead').filter({ hasText: '周小乐' }).first();
      await expect(target).toBeVisible();
      await target.click();
      const scope = isMobile ? page.locator('.v-content') : topSheet(page);
      await expect(scope).toBeVisible();
      await expect(scope).toContainText('周小乐');
      await expect(scope).toContainText('首次沟通');
      await closeAllSheets(page);

      await h.healthy();
    } finally {
      await h.close();
    }
  });

  test('@smoke 老师页主视图、详情课酬与课酬标准', async ({ browser, request }, info) => {
    const isMobile = Boolean(info.project.use.isMobile);
    const h = await createHarness(browser, request, info, ['supervisor']);
    try {
      const page = await h.openApp('supervisor', '#settings-teachers');
      await expect(page.locator('.fq-tp-page, .fq-tp-split').first()).toBeVisible();
      await expect(page.locator('body')).toContainText('李嘉文');
      await assertNoOverflow(page, 'settings-teachers');

      // 决定 11：手机端不出新建老师按钮
      if (isMobile) {
        await expect(page.locator("button:has-text('新建老师')")).toHaveCount(0);
      } else {
        // 电脑端验证课酬标准页
        await gotoHash(page, '#teachers-rates');
        await expect(page.locator('body')).toContainText('李嘉文');
        await assertNoOverflow(page, 'teachers-rates');
      }

      await h.healthy();
    } finally {
      await h.close();
    }
  });

  test('@smoke 设置页各分区、旧路由兼容与机构信息编辑权限', async ({ browser, request }, info) => {
    const isMobile = Boolean(info.project.use.isMobile);
    const h = await createHarness(browser, request, info, ['supervisor', 'academic']);
    try {
      const sup = await h.openApp('supervisor', '#settings-overview');
      await expect(sup.locator('.fq-se, .fq-se-host').first()).toBeVisible();
      await assertNoOverflow(sup, 'settings-overview');

      // 校验核心分区及旧路由兼容
      for (const hash of ['#settings-accounts', '#settings-institution', '#settings-courses', '#admin-courses', '#settings-data', '#settings-logs']) {
        await gotoHash(sup, hash);
        await expect(sup.locator('.fq-se, .fq-se-host').first()).toBeVisible();
        await assertNoOverflow(sup, hash);
      }

      // 手机端数据导入只读提示（决定 16）
      if (isMobile) {
        await gotoHash(sup, '#settings-import');
        await expect(sup.locator('body')).toContainText('电脑');
      }

      // 教务进入机构信息应只读，无编辑按钮
      const acad = await h.openApp('academic', '#settings-institution');
      await expect(acad.locator('body')).toContainText('只有机构主管可以修改');
      await expect(acad.locator(".fq-se-main button:has-text('编辑')")).toHaveCount(0);
      await assertNoOverflow(acad, 'academic-settings-institution');

      await h.healthy();
    } finally {
      await h.close();
    }
  });
});
