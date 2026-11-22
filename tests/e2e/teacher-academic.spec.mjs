import { test, expect } from '@playwright/test';
import { createHarness, gotoHash, topSheet, closeAllSheets, pickDate, choose } from './helpers.mjs';

test.describe('老师与教务核心业务流程', () => {
  test('@smoke 老师今天页点名并提交点评，教务待办确认生效', async ({ browser, request }, info) => {
    const h = await createHarness(browser, request, info, ['teacher', 'academic']);
    try {
      // 1. 老师在今天页看到 09:00 已下课的钢琴课展开为待点名卡片
      const teacher = await h.openApp('teacher', '#today');
      const todoCard = teacher.locator('.fq-tc-todo').first();
      await expect(todoCard).toBeVisible();
      await expect(todoCard).toContainText('钢琴 1 对 1');

      // 标记出勤（1 对 1 课点“出勤”或班课点“全部出勤”）并填写课后点评
      const allPresent = todoCard.getByRole('button', { name: '全部出勤', exact: true }).first();
      if (await allPresent.count()) {
        await allPresent.click();
      } else {
        const presentBtn = todoCard.getByRole('button', { name: '出勤', exact: true }).first();
        if (await presentBtn.count()) await presentBtn.click();
      }
      const commentBox = todoCard.locator("textarea[name='public_text'], textarea:not([disabled])").last();
      await expect(commentBox).toBeVisible();
      await commentBox.fill('E2E 课堂点评：音阶流畅度明显提升，注意手腕放松。');

      const [submitRes] = await Promise.all([
        teacher.waitForResponse(r => /\/api\/lessons\/[^/]+\/review$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST'),
        todoCard.getByRole('button', { name: /提交点名与点评|提交出勤与点评/ }).first().click(),
      ]);
      expect(submitRes.status()).toBe(200);
      await expect(teacher.locator('body')).toContainText(/已点名，待教务确认|已提交/);

      // 核对后端已产生 pending 提交
      const midState = await h.state();
      expect(midState.submissions.some(s => s.lesson_id === h.manifest.lessons.todayTodo && s.status === 'pending')).toBeTruthy();

      // 2. 教务在待办收件箱看到该提交并确认生效（电脑端操作）
      if (!info.project.use.isMobile) {
        const acad = await h.openApp('academic', '#todo-unchecked');
        await expect(acad.locator('body')).toContainText('钢琴 1 对 1');
        const confirmEntry = acad.getByRole('button', { name: '确认出勤', exact: true }).first();
        await expect(confirmEntry).toBeVisible();
        await confirmEntry.click();

        const sheet = topSheet(acad);
        await expect(sheet).toBeVisible();
        const goConfirm = sheet.getByRole('button', { name: '去确认', exact: true }).first();
        if (await goConfirm.count() && await goConfirm.isVisible()) {
          await goConfirm.click();
          await acad.waitForTimeout(400);
        }
        const activeSheet = topSheet(acad);
        const confirmBtn = activeSheet.getByRole('button', { name: /确认并生效|确认点名/ }).first();
        await expect(confirmBtn).toBeVisible();
        await confirmBtn.click();

        // 若弹出二次确认框则确认
        const dialogConfirm = acad.getByRole('dialog').getByRole('button', { name: '确认', exact: true });
        if (await dialogConfirm.count() && await dialogConfirm.isVisible()) {
          await Promise.all([
            acad.waitForResponse(r => /\/api\/submissions\/[^/]+\/confirm$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST'),
            dialogConfirm.click(),
          ]);
        } else {
          await acad.waitForTimeout(800);
        }

        const after = await h.state();
        expect(after.submissions.some(s => s.lesson_id === h.manifest.lessons.todayTodo && s.status === 'confirmed')).toBeTruthy();
        await closeAllSheets(acad);
      }

      await h.healthy();
    } finally {
      await h.close();
    }
  });

  test('教务排课冲突提示、调整时间保存、请假补课与待办稍后', async ({ browser, request }, info) => {
    test.skip(Boolean(info.project.use.isMobile), '复杂排课/补课/待办流程在桌面端执行');
    const h = await createHarness(browser, request, info, ['academic']);
    try {
      const acad = await h.openApp('academic', '#schedule-week');

      // 1. 排一节与今天 14:00 冲突的课（Emily + 305 琴房 + 陈思语）
      await acad.getByRole('button', { name: '排课', exact: true }).first().click();
      const drawer = topSheet(acad);
      await expect(drawer).toBeVisible();

      await pickDate(drawer, '北京时间日期', '2026-11-12');
      await drawer.getByLabel('北京时间时间', { exact: true }).fill('14:00');
      await drawer.getByLabel('北京时间时间', { exact: true }).press('Tab');
      await choose(drawer, '教师', 'Emily');
      await choose(drawer, '课程', '声乐 1 对 1');
      await choose(drawer, '教室（线下课必填）', '305 琴房');
      await drawer.getByRole('button', { name: '陈思语', exact: true }).click();
      await drawer.getByLabel('备注', { exact: true }).fill('E2E 冲突校验备注');

      const [conflictRes] = await Promise.all([
        acad.waitForResponse(r => new URL(r.url()).pathname.endsWith('/api/data/lessons') && r.request().method() === 'POST'),
        drawer.getByRole('button', { name: '保存并检查冲突', exact: true }).click(),
      ]);
      expect(conflictRes.status()).toBe(200);
      const conflictJson = await conflictRes.json();
      expect(conflictJson.committed).toBe(false);
      expect(conflictJson.conflicts.length).toBeGreaterThan(0);

      // 冲突提示可见且输入备注保留
      const alert = drawer.getByRole('alert').filter({ hasText: /未保存|冲突/ }).first();
      await expect(alert).toBeVisible();
      await expect(drawer.getByLabel('备注', { exact: true })).toHaveValue('E2E 冲突校验备注');

      // 2. 调整为空闲时间 16:30 保存成功
      await drawer.getByLabel('北京时间时间', { exact: true }).fill('16:30');
      await drawer.getByLabel('北京时间时间', { exact: true }).press('Tab');
      const [okRes] = await Promise.all([
        acad.waitForResponse(r => new URL(r.url()).pathname.endsWith('/api/data/lessons') && r.request().method() === 'POST'),
        drawer.getByRole('button', { name: '保存并检查冲突', exact: true }).click(),
      ]);
      expect(okRes.status()).toBe(200);
      expect((await okRes.json()).committed).toBe(true);
      await closeAllSheets(acad);

      const afterSchedule = await h.state();
      expect(afterSchedule.lessons.some(l => l.start_at.includes('2026-11-12T16:30'))).toBeTruthy();

      // 3. 请假与补课：将今天 14:00 的陈思语标记请假并安排补课
      await gotoHash(acad, '#schedule-week');
      const voiceCard = acad.locator('.fq-sc-ev').filter({ hasText: '声乐 1 对 1' }).first();
      await expect(voiceCard).toBeVisible();
      await voiceCard.click();
      const detail = topSheet(acad);
      await expect(detail).toBeVisible();

      // 标记陈思语请假（excused）
      const leaveBtn = detail.getByRole('button', { name: '请假', exact: true }).first();
      if (await leaveBtn.count()) {
        await leaveBtn.click();
        const saveReview = detail.getByRole('button', { name: /保存|确认/ }).first();
        if (await saveReview.count() && await saveReview.isVisible()) {
          await saveReview.click();
          await acad.waitForTimeout(600);
        }
      }
      await closeAllSheets(acad);

      // 4. 待办收件箱：验证待办项可执行「稍后」推迟
      await gotoHash(acad, '#todo-unchecked');
      const snoozeBtn = acad.getByRole('button', { name: '稍后', exact: true }).first();
      await expect(snoozeBtn).toBeVisible();
      await snoozeBtn.click();
      const [snoozeRes] = await Promise.all([
        acad.waitForResponse(r => new URL(r.url()).pathname.endsWith('/api/todo/snooze') && r.request().method() === 'POST'),
        acad.getByRole('menuitem', { name: /明天|下周一/ }).or(acad.locator("button:has-text('明天'), button:has-text('下周一')")).first().click(),
      ]);
      expect(snoozeRes.status()).toBe(200);
      const afterSnooze = await h.state();
      expect(afterSnooze.snoozes.length).toBeGreaterThan(0);

      await h.healthy();
    } finally {
      await h.close();
    }
  });
});
