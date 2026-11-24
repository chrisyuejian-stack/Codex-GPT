import { test, expect } from "@playwright/test";
import { createHarness, topSheet } from "./helpers.mjs";

const MOCK_EARNED = {
  month: "2026-11",
  cutoff: "2026-11-12",
  locked: false,
  earned_amount: 1560,
  unpriced_units: 1,
  summary: {
    lesson_amount: 1080,
    other_income_amount: 600,
    reversal_amount: -120,
    lesson_count: 2,
    other_count: 1,
    reversal_count: 1,
    unpriced_count: 1,
  },
  dimensions: {
    courses: [{ id: "ct_demo_1", name: "钢琴一对一", lesson_count: 3, units: 3, earned_amount: 960, unpriced_units: 1 }],
    students: [{ id: "stu_demo_1", name: "林思语", lesson_count: 2, units: 2, earned_amount: 1560, unpriced_units: 0, other_income_amount: 600 }],
    teachers: [{ id: "tch_demo_1", name: "陈韵老师", lesson_count: 3, units: 3, earned_amount: 960, unpriced_units: 1 }],
  },
  items: [
    {
      id: "txn_1",
      date: "2026-11-12",
      category: "lesson",
      source: "checkout",
      source_label: "课程消课",
      student_id: "stu_demo_1",
      student_name: "林思语",
      course_type_id: "ct_demo_1",
      course_name: "钢琴一对一",
      teacher_id: "tch_demo_1",
      teacher_name: "陈韵老师",
      lesson_id: "les_demo_1",
      start_at: "2026-11-12T16:00+08:00",
      package_id: "pkg_demo_1",
      package_name: "钢琴20课时包",
      units: 2,
      unit_price: 540,
      unpriced_units: 0,
      amount: 1080,
      can_fix_price: false,
      note: "",
    },
    {
      id: "pay_1",
      date: "2026-11-11",
      category: "other",
      source: "other_income",
      source_label: "其他收入 · 报名费",
      student_id: "stu_demo_1",
      student_name: "林思语",
      course_type_id: null,
      course_name: "报名费",
      teacher_id: null,
      teacher_name: null,
      lesson_id: null,
      start_at: null,
      package_id: null,
      package_name: "",
      units: null,
      unit_price: null,
      unpriced_units: 0,
      amount: 600,
      can_fix_price: false,
      note: "新生入学报名费",
    },
    {
      id: "txn_2",
      date: "2026-11-10",
      category: "reversal",
      source: "reversal",
      source_label: "冲红撤回",
      student_id: "stu_demo_2",
      student_name: "周子轩",
      course_type_id: "ct_demo_1",
      course_name: "钢琴一对一",
      teacher_id: "tch_demo_1",
      teacher_name: "陈韵老师",
      lesson_id: "les_demo_2",
      start_at: "2026-11-10T15:00+08:00",
      package_id: "pkg_demo_2",
      package_name: "钢琴10课时包",
      units: -0.5,
      unit_price: 240,
      unpriced_units: 0,
      amount: -120,
      can_fix_price: false,
      note: "撤回误销课",
    },
    {
      id: "txn_3",
      date: "2026-11-09",
      category: "unpriced",
      source: "no_price",
      source_label: "无单价课时",
      student_id: "stu_demo_3",
      student_name: "沈清越",
      course_type_id: "ct_demo_1",
      course_name: "钢琴一对一",
      teacher_id: "tch_demo_1",
      teacher_name: "陈韵老师",
      lesson_id: "les_demo_3",
      start_at: "2026-11-09T14:00+08:00",
      package_id: "pkg_demo_3",
      package_name: "旧课时包",
      units: 1,
      unit_price: null,
      unpriced_units: 1,
      amount: 0,
      can_fix_price: true,
      note: "",
    },
  ],
};

test.describe("财务：确认收入来源明细（概览下钻抽屉与报表页签）", () => {
  test("@smoke 真实后端联调：概览下钻抽屉与报表维度/收入明细页签均通过真实接口与 read-batch 加载", async ({ browser, request }, info) => {
    const h = await createHarness(browser, request, info, ["supervisor"]);
    try {
      const page = await h.openApp("supervisor", "#finance-overview");
      const earnedCard = page.locator("button.fq-fin-stat.is-earned-link").first();
      await expect(earnedCard).toBeVisible();
      await expect(earnedCard).toContainText("查看明细");

      const [directRes] = await Promise.all([
        page.waitForResponse((r) => new URL(r.url()).pathname === "/api/c3/report/earned" && r.request().method() === "GET"),
        earnedCard.click(),
      ]);
      expect(directRes.status()).toBe(200);

      const sheet = topSheet(page);
      await expect(sheet).toBeVisible();
      await expect(sheet).toContainText("确认收入明细");
      await expect(sheet).toContainText(/明细合计与本月确认收入完全一致|已锁月/);

      await page.keyboard.press("Escape");
      await expect(sheet).toBeHidden();

      // 报表页 #finance-reports 应通过 read-batch 联合加载确认收入维度列与第 4 个「收入明细」页签
      const [batchRes] = await Promise.all([
        page.waitForResponse(async (r) => {
          if (new URL(r.url()).pathname !== "/api/read-batch" || r.request().method() !== "POST") return false;
          return (r.request().postData() || "").includes("c3/report/earned");
        }),
        page.evaluate(() => { location.hash = "#finance-reports"; }),
      ]);
      expect(batchRes.status()).toBe(200);

      const earnedTab = page.locator(".v-ptab:has-text('收入明细')").first();
      await expect(earnedTab).toBeVisible();
      if (!info.project.use.isMobile) {
        await expect(page.locator(".v-content")).toContainText("确认收入");
      }
      await earnedTab.click();
      await expect(page.locator(".fq-fin-edwrap")).toBeVisible();
      await expect(page.locator(".fq-fin-edwrap")).toContainText(/明细合计与本月确认收入完全一致|已锁月/);

      await h.healthy();
    } finally {
      await h.close();
    }
  });

  test("@smoke 边界校验：历史快照 null 不误报 0 元、1 分钱差异告警、筛选搜索与去补单价", async ({ browser, request }, info) => {
    const h = await createHarness(browser, request, info, ["supervisor"]);
    try {
      const page = await h.openApp("supervisor", "#finance-overview");

      // 1. 1 分钱差异（1560.01 vs 1560.00）必须判为不一致警告，且支持筛选/搜索/去补单价
      await page.route("**/api/c3/report/earned*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ...MOCK_EARNED, earned_amount: 1560.01 }),
        });
      });
      await page.locator("button.fq-fin-stat.is-earned-link").first().click();
      let sheet = topSheet(page);
      await expect(sheet).toBeVisible();
      await expect(sheet.locator(".fq-fin-edchk.is-warn")).toContainText("明细合计 ¥1,560 · 快照 ¥1,560.01");
      await expect(sheet).not.toContainText("完全一致");
      await expect(sheet).toContainText("去补单价");

      await sheet.getByRole("button", { name: /冲红撤回/ }).click();
      await expect(sheet).toContainText("周子轩");
      await expect(sheet).not.toContainText("林思语");

      await sheet.getByRole("button", { name: /全部/ }).click();
      await sheet.locator("input.fq-fin-edq").fill("沈清越");
      await expect(sheet).toContainText("沈清越");
      await expect(sheet).not.toContainText("林思语");

      await page.keyboard.press("Escape");
      await expect(sheet).toBeHidden();

      // 2. 早期锁月 earned_amount === null：保留实时明细并提示“快照未记录 / 暂不可核对”，绝不归零
      await page.unroute("**/api/c3/report/earned*");
      await page.route("**/api/c3/report/earned*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ...MOCK_EARNED, locked: true, earned_amount: null }),
        });
      });
      await page.locator("button.fq-fin-stat.is-earned-link").first().click();
      sheet = topSheet(page);
      await expect(sheet).toBeVisible();
      await expect(sheet.locator(".fq-fin-edform")).toContainText("快照未记录");
      await expect(sheet.locator(".fq-fin-edchk.is-warn")).toContainText("历史快照未记录确认收入口径，暂不可核对");
      await expect(sheet.locator(".fq-fin-edchk.is-warn")).toContainText("¥1,560");
      await expect(sheet).not.toContainText("核对一致");
      await expect(sheet).toContainText("林思语");

      await page.keyboard.press("Escape");
      await expect(sheet).toBeHidden();
      await h.healthy();
    } finally {
      await h.close();
    }
  });
});

