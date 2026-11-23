import { test, expect } from '@playwright/test';
import { createHarness, assertNoOverflow, topSheet, closeAllSheets } from './helpers.mjs';

test.describe('学员端全视图与主管全量备份验收', () => {
  test('@smoke 学员端首页、课表、点评、课时与缴费及缴费开关控制', async ({ browser, request }, info) => {
    const isMobile = Boolean(info.project.use.isMobile);
    const h = await createHarness(browser, request, info, ['student', 'supervisor']);
    try {
      const stu = await h.openApp('student', '#today');
      await expect(stu.locator('body')).toContainText(/王一然|一然，/);
      await expect(stu.locator('body')).toContainText('剩余课时');
      await assertNoOverflow(stu, 'student-home');

      // 课表
      await stu.getByRole('button', { name: /课表/ }).first().click();
      await stu.waitForTimeout(400);
      await expect(stu.locator('body')).toContainText('钢琴 1 对 1');
      await assertNoOverflow(stu, 'student-schedule');

      // 老师点评
      await stu.getByRole('button', { name: /点评/ }).first().click();
      await stu.waitForTimeout(400);
      await expect(stu.locator('body')).toContainText(/指法清晰|课堂状态很好/);
      await assertNoOverflow(stu, 'student-comments');

      // 课时与缴费（开启开关时可见 ¥1,600 / 1,600）
      if (isMobile) {
        await stu.getByRole('button', { name: /首页/ }).first().click();
        await stu.waitForTimeout(300);
        const detailLink = stu.getByRole('button', { name: /明细|课时与缴费/ }).first();
        await expect(detailLink).toBeVisible();
        await detailLink.click();
      } else {
        await stu.getByRole('button', { name: /课时与缴费/ }).first().click();
      }
      await stu.waitForTimeout(400);
      await expect(stu.locator('body')).toContainText('钢琴 1 对 1');
      await expect(stu.locator('body')).toContainText(/1,600|1600/);
      await assertNoOverflow(stu, 'student-credits-on');

      // 主管关闭 student_view_payments 开关
      const sup = await h.openApp('supervisor', '#settings-overview');
      const toggleRes = await sup.evaluate(async () => {
        const r = await fetch('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'student_view_payments', value: false }),
        });
        return r.status;
      });
      expect(toggleRes).toBe(200);

      // 学员刷新后不再可见缴费记录（1,600 / 一期钢琴学费 隐藏）
      await stu.reload({ waitUntil: 'domcontentloaded' });
      await stu.waitForTimeout(600);
      if (isMobile) {
        const detailLink = stu.getByRole('button', { name: /明细|课时与缴费/ }).first();
        if (await detailLink.count()) await detailLink.click();
      } else {
        await stu.getByRole('button', { name: /课时与缴费/ }).first().click();
      }
      await stu.waitForTimeout(500);
      await expect(stu.locator('body')).not.toContainText('一期钢琴学费');
      await expect(stu.locator('body')).not.toContainText('¥1,600');

      await h.healthy();
    } finally {
      await h.close();
    }
  });

  test('主管全量数据备份导出与预览（不确认恢复）', async ({ browser, request }, info) => {
    test.skip(Boolean(info.project.use.isMobile), '全量备份导出与恢复预览仅在电脑端开放（决定 16）');
    const h = await createHarness(browser, request, info, ['supervisor']);
    const backupPw = 'FengqinBackupPass2026!';
    try {
      const sup = await h.openApp('supervisor', '#settings-data');
      await sup.getByRole('button', { name: '数据备份', exact: true }).first().click();
      await expect(sup.locator('body')).toContainText('导出备份文件');

      // 1. 导出加密备份文件并捕获下载路径
      await sup.getByRole('button', { name: '导出备份文件', exact: true }).first().click();
      const exportSheet = topSheet(sup);
      await expect(exportSheet).toBeVisible();

      const pwInputs = exportSheet.locator("input[type='password']");
      const pwCount = await pwInputs.count();
      for (let i = 0; i < pwCount; i++) {
        await pwInputs.nth(i).fill(backupPw);
      }

      const [download] = await Promise.all([
        sup.waitForEvent('download', { timeout: 20_000 }),
        exportSheet.getByRole('button', { name: /导出|下载|确认/ }).last().click(),
      ]);
      const filePath = await download.path();
      expect(filePath).toBeTruthy();
      expect(download.suggestedFilename()).toMatch(/\.fqbackup|\.json|\.bin|backup/i);
      await closeAllSheets(sup);

      // 2. 用导出的备份文件执行恢复预览（不确认恢复）
      const restoreBtn = sup.getByRole('button', { name: /选择备份文件|从备份恢复|恢复备份/ }).first();
      await expect(restoreBtn).toBeVisible();
      await restoreBtn.click();
      const previewSheet = topSheet(sup);
      await expect(previewSheet).toBeVisible();

      await previewSheet.locator("input[type='file']").setInputFiles(filePath);
      await previewSheet.locator("input[type='password']").first().fill(backupPw);

      const [previewRes] = await Promise.all([
        sup.waitForResponse(r => new URL(r.url()).pathname.endsWith('/api/backups/restore/preview') && r.request().method() === 'POST'),
        previewSheet.getByRole('button', { name: '校验并预览', exact: true }).click(),
      ]);
      expect([200, 201]).toContain(previewRes.status());
      await expect(previewSheet).toContainText(/学员|课程|预览有效至/);

      // 明确不点击确认恢复，直接关闭抽屉
      await closeAllSheets(sup);
      await h.healthy();
    } finally {
      await h.close();
    }
  });
});
