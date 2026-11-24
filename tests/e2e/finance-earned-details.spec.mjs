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
  test("@smoke 点击概览确认收入卡片弹出明细抽屉并支持来源筛选与搜索，报表页支持确认收入页签", async ({ browser, request }, info) => {
    const h = await createHarness(browser, request, info, ["supervisor"]);
    try {
      const page = await h.openApp("supervisor", "#finance-overview");
      await page.route("**/api/c3/report/earned*", async (route) => {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_EARNED) });
      });

      // 1. 概览页点击「确认收入」卡片或摘要条打开明细抽屉
      const earnedCard = page.locator("button.fq-fin-stat.is-earned-link").first();
      await expect(earnedCard).toBeVisible();
      await expect(earnedCard).toContainText("查看明细");
      await earnedCard.click();

      const sheet = topSheet(page);
      await expect(sheet).toBeVisible();
      await expect(sheet).toContainText("确认收入明细");
      await expect(sheet).toContainText("明细合计与本月确认收入完全一致");
      await expect(sheet).toContainText("林思语");
      await expect(sheet).toContainText("周子轩");
      await expect(sheet).toContainText("去补单价");

      // 2. 来源筛选与关键词搜索
      await sheet.getByRole("button", { name: /冲红撤回/ }).click();
      await expect(sheet).toContainText("周子轩");
      await expect(sheet).not.toContainText("林思语");

      await sheet.getByRole("button", { name: /全部/ }).click();
      await sheet.locator("input.fq-fin-edq").fill("沈清越");
      await expect(sheet).toContainText("沈清越");
      await expect(sheet).not.toContainText("林思语");

      await page.keyboard.press("Escape");
      await expect(sheet).toBeHidden();

      // 3. 报表页 #finance-reports 第四个「收入明细」页签
      await page.evaluate(() => { location.hash = "#finance-reports"; });
      await page.waitForTimeout(450);
      const earnedTab = page.locator(".v-ptab:has-text('收入明细')").first();
      await expect(earnedTab).toBeVisible();
      await earnedTab.click();
      await expect(page.locator(".fq-fin-edwrap")).toBeVisible();
      await expect(page.locator(".fq-fin-edwrap")).toContainText("林思语");

      await h.healthy();
    } finally {
      await h.close();
    }
  });
});
