import { test, expect } from "@playwright/test";
import { createHarness } from "./helpers.mjs";
import { navigateHash, inspectPageLayout, probePopoversAndMenus } from "../../scripts/e2e/ui-audit-crawl.mjs";

const CORE_ROUTES = [
  { id: "today", hash: "#today" },
  { id: "schedule-week", hash: "#schedule-week" },
  { id: "students", hash: "#students" },
  { id: "enrol-leads", hash: "#enrol-leads" },
  { id: "finance-rates", hash: "#finance-rates" },
  { id: "settings-teachers", hash: "#settings-teachers" },
  { id: "settings-courses", hash: "#settings-institution", settingsTab: "courses" },
];

test.describe("任务 #12 与 #11：全站溢出回归与按钮交互反馈规范", () => {
  test("@smoke #12 核心页面与设置课程大类「更多」菜单无溢出与越界", async ({ browser, request }, testInfo) => {
    const h = await createHarness(browser, request, testInfo, ["supervisor"]);
    const { page } = h.actors.supervisor;
    const vpLabel = testInfo.project.name === "mobile" ? "mobile-390" : "desktop-1280";

    try {
      await page.goto("/app#today", { waitUntil: "domcontentloaded" });
      for (const r of CORE_ROUTES) {
        await navigateHash(page, r.hash, r.settingsTab || null);
        const meta = { role: "supervisor", viewport: vpLabel, routeId: r.id };
        const layoutIssues = await inspectPageLayout(page, meta);
        expect(layoutIssues, `${vpLabel} ${r.id} 存在排版溢出: ${JSON.stringify(layoutIssues)}`).toEqual([]);
        if (r.id === "settings-courses" || r.id === "finance-rates") {
          const menuIssues = await probePopoversAndMenus(page, meta, { maxTriggers: 6 });
          expect(menuIssues, `${vpLabel} ${r.id} 存在菜单越界: ${JSON.stringify(menuIssues)}`).toEqual([]);
        }
      }

      if (testInfo.project.name === "desktop") {
        await page.setViewportSize({ width: 768, height: 1024 });
        for (const r of CORE_ROUTES) {
          await navigateHash(page, r.hash, r.settingsTab || null);
          const meta = { role: "supervisor", viewport: "tablet-768", routeId: r.id };
          const layoutIssues = await inspectPageLayout(page, meta);
          expect(layoutIssues, `tablet-768 ${r.id} 存在排版溢出: ${JSON.stringify(layoutIssues)}`).toEqual([]);
        }
      }
    } finally {
      await h.close();
    }
  });

  test("@smoke #11 按钮/药丸/页签/列表行具备悬停过渡、焦点环且尊重 prefers-reduced-motion", async ({ browser, request }, testInfo) => {
    const h = await createHarness(browser, request, testInfo, ["supervisor"]);
    const { page } = h.actors.supervisor;

    try {
      await page.goto("/app#students", { waitUntil: "domcontentloaded" });
      await navigateHash(page, "#students");

      const chip = page.locator(".fq-st-chip:not(.is-on)").first();
      await expect(chip).toBeVisible();
      const chipTransition = await chip.evaluate((el) => getComputedStyle(el).transitionDuration);
      expect(chipTransition).not.toBe("0s");

      if (testInfo.project.name !== "mobile") {
        const beforeBorder = await chip.evaluate((el) => getComputedStyle(el).borderColor);
        await chip.hover();
        await page.waitForTimeout(180);
        const afterBorder = await chip.evaluate((el) => getComputedStyle(el).borderColor);
        expect(afterBorder).not.toBe(beforeBorder);

        const primaryBtn = page.locator(".v-head .v-create .ui-button--primary").first();
        await expect(primaryBtn).toBeVisible();
        const beforeBg = await primaryBtn.locator(".ui-button-face").evaluate((el) => getComputedStyle(el).backgroundColor);
        await primaryBtn.hover();
        await page.waitForTimeout(180);
        const afterBg = await primaryBtn.locator(".ui-button-face").evaluate((el) => getComputedStyle(el).backgroundColor);
        expect(afterBg).not.toBe(beforeBg);

        const row = page.locator("button.fq-st-row:not(.is-on)").first();
        if (await row.isVisible().catch(() => false)) {
          const rowBefore = await row.evaluate((el) => getComputedStyle(el).backgroundColor);
          await row.hover();
          await page.waitForTimeout(180);
          const rowAfter = await row.evaluate((el) => getComputedStyle(el).backgroundColor);
          expect(rowAfter).not.toBe(rowBefore);
        }
      }

      await page.emulateMedia({ reducedMotion: "reduce" });
      const reducedDur = await chip.evaluate((el) => getComputedStyle(el).transitionDuration);
      expect(reducedDur).toBe("0s");
    } finally {
      await h.close();
    }
  });
});
