import { test, expect } from '@playwright/test';
import { createHarness, gotoHash, topSheet, closeAllSheets, choose } from './helpers.mjs';

test.describe('财务与线索核心业务流程', () => {
  test('@smoke 仅财务：登记缴费、补课时包价格与收款核对', async ({ browser, request }, info) => {
    test.skip(Boolean(info.project.use.isMobile), '财务完整核对与补价流程在桌面端执行');
    const h = await createHarness(browser, request, info, ['finance']);
    try {
      const fin = await h.openApp('finance', '#finance-overview');
      await expect(fin.locator('body')).toContainText(/实收现金|收款核对/);

      // 1. 登记缴费：为许嘉宁登记一笔 1600 元缴费
      const addPayBtn = fin.getByRole('button', { name: /登记缴费/ }).first();
      await expect(addPayBtn).toBeVisible();
      await addPayBtn.click();
      const paySheet = topSheet(fin);
      await expect(paySheet).toBeVisible();

      const stuSelect = paySheet.locator('select').first();
      await expect(stuSelect.locator('option', { hasText: '许嘉宁' })).toHaveCount(1);
      await stuSelect.selectOption({ label: '许嘉宁' });
      await paySheet.locator("input[placeholder='本次实收金额']").fill('1600');
      const noteInput = paySheet.locator("input[placeholder='选填']").first();
      if (await noteInput.count()) await noteInput.fill('E2E 财务登记缴费');

      const [payRes] = await Promise.all([
        fin.waitForResponse(r => new URL(r.url()).pathname.endsWith('/api/credits/payments') && r.request().method() === 'POST'),
        paySheet.getByRole('button', { name: '确认登记缴费', exact: true }).click(),
      ]);
      expect(payRes.status()).toBe(200);
      await closeAllSheets(fin);

      const afterPay = await h.state();
      expect(afterPay.payments.some(p => p.student_id === h.manifest.students.xu && p.amount === 160000)).toBeTruthy();

      // 2. 补课时包价格：在登记缴费抽屉选择陈思语，给未定价钢琴包点击「补价格」补填金额
      await fin.getByRole('button', { name: /登记缴费/ }).first().click();
      const paySheet2 = topSheet(fin);
      await expect(paySheet2).toBeVisible();
      const stuSelect2 = paySheet2.locator('select').first();
      await expect(stuSelect2.locator('option', { hasText: '陈思语' })).toHaveCount(1);
      await stuSelect2.selectOption({ label: '陈思语' });
      const priceBtn = paySheet2.getByRole('button', { name: '补价格', exact: true }).first();
      await expect(priceBtn).toBeVisible();
      await priceBtn.click();

      const priceSheet = topSheet(fin);
      await expect(priceSheet).toBeVisible();
      const priceInput = priceSheet.locator("input[type='number'], input[inputmode='decimal']").first();
      await expect(priceInput).toBeVisible();
      await priceInput.fill('1800');
      const [priceRes] = await Promise.all([
        fin.waitForResponse(r => /\/api\/credits\/packages\//.test(new URL(r.url()).pathname) && ['PUT', 'PATCH', 'POST'].includes(r.request().method())),
        priceSheet.getByRole('button', { name: /保存|确认/ }).last().click(),
      ]);
      expect(priceRes.status()).toBe(200);
      await closeAllSheets(fin);

      const afterPrice = await h.state();
      const pricedPkg = afterPrice.packages.find(p => p.id === h.manifest.packages.chenUnpriced);
      expect(pricedPkg.amount || pricedPkg.unit_price).not.toBeNull();

      // 3. 收款核对：在财务概览「本月结账进度」点击「收款核对 -> 去处理 →」核对林可欣的待核对收款
      await gotoHash(fin, '#finance-overview');
      const checkBtn = fin.locator('li').filter({ hasText: '收款核对' }).getByRole('button', { name: /去处理/ }).first();
      await expect(checkBtn).toBeVisible();
      await checkBtn.click();
      await fin.waitForTimeout(500);

      const resolveScope = (await fin.locator('.ui-sheet').count()) ? topSheet(fin) : fin.locator('.v-content');
      await expect(resolveScope).toContainText('林可欣');
      const linCard = resolveScope.locator('tr, li, article, .fq-td-item, .v-card').filter({ hasText: '林可欣' }).first();
      const actionScope = (await linCard.count()) ? linCard : resolveScope;
      const toBalanceBtn = actionScope.getByRole('button', { name: /转预收|关联课时包|记为其他收入|核对/ }).first();
      await expect(toBalanceBtn).toBeVisible();
      await toBalanceBtn.click();
      await fin.waitForTimeout(500);
      const submitResolve = fin.locator('.ui-sheet, [role="dialog"]').last().getByRole('button', { name: /确认|保存/ }).last();
      if (await submitResolve.count() && await submitResolve.isVisible()) {
        await submitResolve.click();
        await fin.waitForTimeout(600);
      }
      await closeAllSheets(fin);

      await h.healthy();
    } finally {
      await h.close();
    }
  });

  test('@smoke 线索全流程：登记新线索、记录回访并转为正式学员', async ({ browser, request }, info) => {
    test.skip(Boolean(info.project.use.isMobile), '线索转学员全流程在桌面端执行');
    const h = await createHarness(browser, request, info, ['supervisor']);
    try {
      const page = await h.openApp('supervisor', '#enrol-leads');

      // 1. 登记新线索
      await page.getByRole('button', { name: '登记线索', exact: true }).first().click();
      const createSheet = topSheet(page);
      await expect(createSheet).toBeVisible();
      await createSheet.locator("input[name='name']").fill('E2E新线索林晓');
      const phoneInput = createSheet.locator("input[name='phone']");
      if (await phoneInput.count()) await phoneInput.fill('13600009988');
      const [createRes] = await Promise.all([
        page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/api/tools/leads') && r.request().method() === 'POST'),
        createSheet.getByRole('button', { name: '登记线索', exact: true }).last().click(),
      ]);
      expect(createRes.status()).toBe(200);
      await closeAllSheets(page);
      await expect(page.locator('.fq-ld-page')).toContainText('E2E新线索林晓');

      // 2. 打开已有试听阶段线索「周小乐」，提交一条新回访
      await page.locator('.fq-ld-lead').filter({ hasText: '周小乐' }).first().click();
      const detail = topSheet(page);
      await expect(detail).toBeVisible();

      let ta = detail.locator('textarea').first();
      if (!(await ta.count())) {
        const openFu = detail.getByRole('button', { name: /记录回访/ }).first();
        if (await openFu.count()) {
          await openFu.click();
          await page.waitForTimeout(300);
          ta = detail.locator('textarea').first();
        }
      }
      await expect(ta).toBeVisible();
      await ta.fill('E2E回访记录：试听满意，准备正式报名钢琴课。');
      const [fuRes] = await Promise.all([
        page.waitForResponse(r => /\/api\/tools\/leads\/[^/]+\/followups$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST'),
        detail.locator("button:has-text('保存回访'), button:has-text('保存'), button[type='submit']").first().click(),
      ]);
      expect(fuRes.status()).toBe(200);
      await expect(detail).toContainText('E2E回访记录');

      // 3. 关闭详情抽屉，在已试听卡片上点击「转为正式学员 →」
      await closeAllSheets(page);
      const convertBtn = page.getByRole('button', { name: /转为正式学员|转为学员/ }).first();
      await expect(convertBtn).toBeVisible();
      await convertBtn.click();
      await page.waitForTimeout(400);
      const confirmSheet = topSheet(page);
      const [convRes] = await Promise.all([
        page.waitForResponse(r => /\/api\/tools\/leads\/[^/]+\/convert$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST'),
        confirmSheet.getByRole('button', { name: /确认|转为|保存/ }).last().click(),
      ]);
      expect(convRes.status()).toBe(200);
      await closeAllSheets(page);

      // 校验数据库与学员页均已出现「周小乐」
      const st = await h.state();
      expect(st.students.some(s => s.name === '周小乐')).toBeTruthy();
      expect(st.leads.find(l => l.id === h.manifest.leads.trial)?.stage).toBe('enrolled');

      await gotoHash(page, '#students');
      await expect(page.locator('.v-content')).toContainText('周小乐');

      await h.healthy();
    } finally {
      await h.close();
    }
  });
});
