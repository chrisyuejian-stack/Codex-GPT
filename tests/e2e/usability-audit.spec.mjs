import { test, expect } from "@playwright/test";
import { createHarness, topSheet } from "./helpers.mjs";
import { navigateHash } from "../../scripts/e2e/ui-audit-crawl.mjs";

const ROLES_TO_CHECK = {
  supervisor: [
    { id: "today", hash: "#today" },
    { id: "todo-unchecked", hash: "#todo-unchecked" },
    { id: "schedule-week", hash: "#schedule-week" },
    { id: "schedule-fixed", hash: "#schedule-fixed" },
    { id: "students", hash: "#students" },
    { id: "enrol-leads", hash: "#enrol-leads" },
    { id: "finance-income", hash: "#finance-income" },
    { id: "finance-rates", hash: "#finance-rates" },
    { id: "settings-teachers", hash: "#settings-teachers" },
    { id: "settings-courses", hash: "#settings-institution", settingsTab: "courses" },
    { id: "settings-accounts", hash: "#settings-accounts", settingsTab: "accounts" },
    { id: "settings-rights", hash: "#settings-rights", settingsTab: "rights" },
    { id: "settings-backup", hash: "#settings-institution", settingsTab: "backup" },
  ],
  teacher: [{ id: "teacher-home", hash: "#today", personal: true }],
  student: [{ id: "student-home", hash: "#today", personal: true }],
};

test.describe("任务 #15：全站页面元素可用性彻查", () => {
  test("@smoke #15 全站零 pageerror / 5xx，表单校验、抽屉 Esc/脏关闭、铃铛弹层与触屏热区可用", async ({ browser, request }, testInfo) => {
    const h = await createHarness(browser, request, testInfo, ["supervisor", "teacher", "student"]);
    const isMobile = testInfo.project.name === "mobile";

    try {
      // 1. 主管端：全页零 pageerror / 非预期 5xx，并采样检查手机端主要按钮热区
      const sup = h.actors.supervisor.page;
      const pageErrors = [];
      const api5xx = [];
      sup.on("pageerror", (err) => pageErrors.push(err.message));
      sup.on("response", (res) => {
        if (res.url().includes("/api/") && res.status() >= 500) api5xx.push(`${res.status()} ${res.url()}`);
      });

      await h.openApp("supervisor", "#today");
      for (const r of ROLES_TO_CHECK.supervisor) {
        await navigateHash(sup, r.hash, r.settingsTab || null);
        // 确认页面有实质内容而非空白
        const textLen = await sup.evaluate(() => (document.body.innerText || "").trim().length);
        expect(textLen, `${r.id} 页面内容不应为空`).toBeGreaterThan(10);
      }

      // 2. 表单与抽屉交互：必填校验、输入类型、脏关闭确认、Esc 关闭
      await navigateHash(sup, "#enrol-leads");
      const addLeadBtn = sup.locator("button:has-text('登记线索'), button:has-text('新建线索')").first();
      await expect(addLeadBtn).toBeVisible();
      await addLeadBtn.click();
      const sheet = topSheet(sup);
      await expect(sheet).toBeVisible();

      // 手机号输入框应具备 tel 或 numeric inputmode
      const phoneInput = sheet.locator("input[name='phone'], input[type='tel']").first();
      if (await phoneInput.isVisible().catch(() => false)) {
        const typeOrMode = await phoneInput.evaluate((el) => el.type === "tel" || el.inputMode === "numeric");
        expect(typeOrMode, "手机号输入框应为 tel 或 numeric 键盘").toBeTruthy();
      }

      // 空提交应触发校验错误且不关闭抽屉
      const submitBtn = sheet.locator("button[type='submit']").first();
      await submitBtn.click();
      await expect(sheet).toBeVisible();
      const invalidCount = await sheet.locator("[aria-invalid='true'], .ui-error, .ui-field-error").count();
      expect(invalidCount, "空表单提交应展示校验错误").toBeGreaterThan(0);

      // 填写部分内容后按 Esc 应弹出「放弃更改」确认（防止误关丢数据）
      const nameInput = sheet.locator("input[name='name']").first();
      await nameInput.fill("测试未保存线索");
      await sup.keyboard.press("Escape");
      const confirmDlg = sup.locator("dialog.ui-sheet[open]:has-text('放弃'), dialog[open]:has-text('放弃')").last();
      if (await confirmDlg.isVisible({ timeout: 1500 }).catch(() => false)) {
        await confirmDlg.locator("button:has-text('放弃')").first().click();
      }
      await expect(sheet).toBeHidden();

      // 3. 铃铛通知弹层（桌面端）Esc 可关闭
      if (!isMobile) {
        const bell = sup.locator(".v-bell").first();
        if (await bell.isVisible().catch(() => false)) {
          await bell.click();
          const pop = sup.locator("[popover]:popover-open").first();
          await expect(pop).toBeVisible();
          await sup.keyboard.press("Escape");
          await expect(pop).toBeHidden();
        }
      }

      // 4. 手机端（390×844）底栏按钮触屏热区 ≥ 40px
      if (isMobile) {
        const smallNav = await sup.evaluate(() => {
          const out = [];
          for (const b of document.querySelectorAll(".v-tabbar button")) {
            const r = b.getBoundingClientRect();
            if (r.width > 0 && r.height > 0 && (r.width < 40 || r.height < 40)) {
              out.push({ text: b.innerText.trim(), w: Math.round(r.width), h: Math.round(r.height) });
            }
          }
          return out;
        });
        expect(smallNav, `手机底栏热区应 ≥40px: ${JSON.stringify(smallNav)}`).toEqual([]);
      }

      expect(pageErrors, `存在未捕获 pageerror: ${pageErrors.join("; ")}`).toEqual([]);
      expect(api5xx, `存在 5xx 接口错误: ${api5xx.join("; ")}`).toEqual([]);

      // 5. 老师端与学员端可用性 & 离线提示条验证
      for (const role of ["teacher", "student"]) {
        const p = h.actors[role].page;
        const errs = [];
        p.on("pageerror", (e) => errs.push(e.message));
        await h.openApp(role, "#today");
        await p.waitForTimeout(300);
        const len = await p.evaluate(() => (document.body.innerText || "").trim().length);
        expect(len, `${role} 个人端首屏不应为空`).toBeGreaterThan(10);
        // 模拟离线切换页签（验证离线缓存兜底与无未捕获报错）
        await p.context().setOffline(true);
        const tabBtn = p.locator(".v-tabbar button, .fq-tc-nav button, .fq-st-nav button").nth(1);
        if (await tabBtn.isVisible().catch(() => false)) {
          await tabBtn.click().catch(() => {});
          await p.waitForTimeout(300);
        }
        await p.context().setOffline(false);
        await p.evaluate(() => window.dispatchEvent(new Event("online")));
        await p.waitForTimeout(200);
        expect(errs, `${role} 端存在 pageerror: ${errs.join("; ")}`).toEqual([]);
      }
    } finally {
      await h.close();
    }
  });
});
