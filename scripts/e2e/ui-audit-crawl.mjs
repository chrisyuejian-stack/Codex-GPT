#!/usr/bin/env node
/**
 * 枫琴内部 CRM · 全站界面溢出与排版自动遍历检测模块（可被 #15 可用性彻查复用）
 *
 * 导出：
 *   - VIEWPORTS: 5 种标准视口（1280×800、1440×900、768×1024、390×844、360×740）
 *   - ROLE_ROUTES: 5 种角色（主管、教务、仅财务、老师、学员）对应的页面与子页签清单
 *   - seedPreviewAccounts(baseUrl): 幂等灌入预览数据并准备 5 角色测试账号
 *   - loginAs(page, baseUrl, account): 以指定账号登录
 *   - navigateHash(page, hash): 切页并等待加载完成
 *   - inspectPageLayout(page, meta): 检测横向滚动、视口越界、父容器裁切、弹出层越界、按钮截断、固定栏遮挡
 *   - probePopoversAndMenus(page, meta, opts): 打开页面内所有「更多/⋯」菜单并检测是否越界或被裁切
 *   - runFullAudit(options): 执行完整矩阵遍历并返回结构化结果
 *
 * CLI 用法：
 *   PREVIEW_URL=http://localhost:4195 PLAYWRIGHT_CHROME_PATH=/usr/bin/google-chrome \
 *     node scripts/e2e/ui-audit-crawl.mjs [--out=work/ui-audit.json] [--shots=docs/qa/screenshots/ui-audit]
 */

import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const VIEWPORTS = [
  { id: "desktop-1280", label: "桌面 1280×800", width: 1280, height: 800, isMobile: false, hasTouch: false },
  { id: "desktop-1440", label: "宽屏 1440×900", width: 1440, height: 900, isMobile: false, hasTouch: false },
  { id: "tablet-768", label: "平板 768×1024", width: 768, height: 1024, isMobile: false, hasTouch: true },
  { id: "mobile-390", label: "iPhone 13 (390×844)", width: 390, height: 844, isMobile: true, hasTouch: true },
  { id: "mobile-360", label: "小屏安卓 (360×740)", width: 360, height: 740, isMobile: true, hasTouch: true },
];

export const ROLE_ROUTES = {
  supervisor: [
    { id: "today", hash: "#today", label: "今天" },
    { id: "todo-unchecked", hash: "#todo-unchecked", label: "待办·点名销课" },
    { id: "todo-makeup", hash: "#todo-makeup", label: "待办·请假待补课" },
    { id: "todo-followup", hash: "#todo-followup", label: "待办·跟进任务" },
    { id: "todo-renewal", hash: "#todo-renewal", label: "待办·续费提醒" },
    { id: "schedule-week", hash: "#schedule-week", label: "课表·周课表" },
    { id: "schedule-student", hash: "#schedule-student", label: "课表·按学员" },
    { id: "schedule-fixed", hash: "#schedule-fixed", label: "课表·固定排课" },
    { id: "schedule-classes", hash: "#schedule-classes", label: "课表·班级" },
    { id: "students", hash: "#students", label: "学员" },
    { id: "enrol-leads", hash: "#enrol-leads", label: "线索" },
    { id: "finance-income", hash: "#finance-income", label: "财务·收款" },
    { id: "finance-packages", hash: "#finance-packages", label: "财务·课时包" },
    { id: "finance-pay", hash: "#finance-pay", label: "财务·月度结算" },
    { id: "finance-rates", hash: "#finance-rates", label: "财务·课酬标准" },
    { id: "finance-costs", hash: "#finance-costs", label: "财务·其他成本" },
    { id: "finance-reports", hash: "#finance-reports", label: "财务·报表" },
    { id: "settings-teachers", hash: "#settings-teachers", label: "老师" },
    { id: "settings-courses", hash: "#settings-institution", label: "设置·课程与教室", settingsTab: "courses" },
    { id: "settings-accounts", hash: "#settings-accounts", label: "设置·账号", settingsTab: "accounts" },
    { id: "settings-rights", hash: "#settings-rights", label: "设置·角色权限", settingsTab: "rights" },
    { id: "settings-institution", hash: "#settings-institution", label: "设置·机构信息", settingsTab: "institution" },
    { id: "settings-backup", hash: "#settings-institution", label: "设置·数据备份", settingsTab: "backup" },
    { id: "settings-export", hash: "#settings-export", label: "设置·导入导出", settingsTab: "export" },
  ],
  academic: [
    { id: "today", hash: "#today", label: "今天" },
    { id: "todo-unchecked", hash: "#todo-unchecked", label: "待办·点名销课" },
    { id: "todo-makeup", hash: "#todo-makeup", label: "待办·请假待补课" },
    { id: "schedule-week", hash: "#schedule-week", label: "课表·周课表" },
    { id: "students", hash: "#students", label: "学员" },
    { id: "enrol-leads", hash: "#enrol-leads", label: "线索" },
    { id: "settings-teachers", hash: "#settings-teachers", label: "老师" },
    { id: "settings-courses", hash: "#settings-institution", label: "设置·课程与教室", settingsTab: "courses" },
  ],
  finance: [
    { id: "today", hash: "#today", label: "财务今天" },
    { id: "finance-income", hash: "#finance-income", label: "财务·收款" },
    { id: "finance-packages", hash: "#finance-packages", label: "财务·课时包" },
    { id: "finance-pay", hash: "#finance-pay", label: "财务·月度结算" },
    { id: "finance-rates", hash: "#finance-rates", label: "财务·课酬标准" },
    { id: "finance-costs", hash: "#finance-costs", label: "财务·其他成本" },
    { id: "finance-reports", hash: "#finance-reports", label: "财务·报表" },
    { id: "students", hash: "#students", label: "学员" },
  ],
  teacher: [
    { id: "teacher-home", hash: "#today", label: "老师端·默认页", personal: true },
  ],
  student: [
    { id: "student-home", hash: "#today", label: "学员端·默认页", personal: true },
  ],
};

async function httpJson(baseUrl, apiPath, method = "GET", body = null, cookie = "") {
  const headers = { Origin: baseUrl };
  if (body !== null) headers["Content-Type"] = "application/json";
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(baseUrl + apiPath, {
    method,
    headers,
    body: body !== null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {}
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const nextCookie = setCookies.map((c) => c.split(";")[0]).join("; ");
  return { status: res.status, body: parsed, cookie: nextCookie };
}

export async function waitServerReady(baseUrl, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await httpJson(baseUrl, "/api/public/brand?lite=1");
      if (r.status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`预览服务未就绪：${baseUrl}`);
}

export async function seedPreviewAccounts(baseUrl, cwd = process.cwd()) {
  await waitServerReady(baseUrl);
  // 尝试主管登录；如尚未 seed 则执行 scripts/preview-seed.mjs
  let login = await httpJson(baseUrl, "/api/auth/login", "POST", {
    phone: "13911112222",
    password: "PreviewSecure9Z",
  });
  if (login.status !== 200) {
    execFileSync("node", ["scripts/preview-seed.mjs"], {
      cwd,
      env: { ...process.env, PREVIEW_URL: baseUrl },
      stdio: "pipe",
    });
    login = await httpJson(baseUrl, "/api/auth/login", "POST", {
      phone: "13911112222",
      password: "PreviewSecure9Z",
    });
  }
  if (login.status !== 200) throw new Error(`主管登录失败: ${login.status}`);
  const supCookie = login.cookie;

  let teachersRes = await httpJson(baseUrl, "/api/data/teachers", "GET", null, supCookie);
  if (!teachersRes.body?.items?.length) {
    execFileSync("node", ["scripts/preview-seed.mjs"], {
      cwd,
      env: { ...process.env, PREVIEW_URL: baseUrl },
      stdio: "pipe",
    });
    teachersRes = await httpJson(baseUrl, "/api/data/teachers", "GET", null, supCookie);
  }
  const teacherId = teachersRes.body?.items?.[0]?.id || null;

  async function ensureAccount(name, phone, roles, finalPassword, extra = {}) {
    const tryLogin = await httpJson(baseUrl, "/api/auth/login", "POST", { phone, password: finalPassword });
    if (tryLogin.status === 200) return { name, phone, password: finalPassword, roles };
    const created = await httpJson(
      baseUrl,
      "/api/accounts",
      "POST",
      { name, phone, roles, ...extra },
      supCookie,
    );
    if (created.status !== 201) {
      throw new Error(`创建账号 ${name} 失败: ${created.status} ${JSON.stringify(created.body)}`);
    }
    const tmpPw = created.body.temporary_password;
    const tmpLogin = await httpJson(baseUrl, "/api/auth/login", "POST", { phone, password: tmpPw });
    if (tmpLogin.status !== 200) throw new Error(`临时密码登录 ${name} 失败`);
    let chg = await httpJson(
      baseUrl,
      "/api/auth/password",
      "POST",
      { current_password: tmpPw, new_password: finalPassword },
      tmpLogin.cookie,
    );
    if (chg.status !== 200) {
      chg = await httpJson(
        baseUrl,
        "/api/password",
        "POST",
        { old_password: tmpPw, password: finalPassword },
        tmpLogin.cookie,
      );
    }
    if (chg.status !== 200) throw new Error(`改密 ${name} 失败: ${chg.status}`);
    return { name, phone, password: finalPassword, roles };
  }

  return {
    supervisor: { name: "主管", phone: "13911112222", password: "PreviewSecure9Z", roles: ["supervisor"] },
    academic: await ensureAccount("巡检教务", "13700000102", ["academic"], "AcademicAudit9Z"),
    finance: await ensureAccount("巡检财务", "13700000103", ["finance"], "FinanceAudit9Z"),
    teacher: await ensureAccount(
      "巡检老师",
      "13700000101",
      ["teacher"],
      "TeacherAudit9Z",
      teacherId ? { teacher_id: teacherId } : {},
    ),
    student: { name: "学员", phone: "13800000008", password: "StudentPreview9Z", roles: ["student"] },
  };
}

export async function loginAs(page, baseUrl, account) {
  await page.goto(baseUrl + "/login", { waitUntil: "networkidle" });
  const phoneIn = page.locator("input[type='tel'], input[name='phone'], input[placeholder*='手机']").first();
  const pwIn = page.locator("input[type='password']").first();
  await phoneIn.fill(account.phone);
  await pwIn.fill(account.password);
  await page.locator("button[type='submit'], button:has-text('登录')").first().click();
  await page.waitForURL(/\/app/, { timeout: 15000 });
  await page.waitForFunction(
    () => {
      const c = document.querySelector(".v-content, .personal-content, .fq-t-shell, .fq-s-shell, main");
      return !!c && c.getAttribute("aria-busy") !== "true";
    },
    { timeout: 12000 },
  ).catch(() => {});
  await page.waitForTimeout(500);
}

export async function navigateHash(page, hash, settingsTab = null) {
  await page.evaluate((h) => {
    location.hash = h;
  }, hash);
  await page.waitForTimeout(300);
  await page.waitForFunction(
    () => {
      const c = document.querySelector(".v-content, .personal-content, main");
      return !c || c.getAttribute("aria-busy") !== "true";
    },
    { timeout: 10000 },
  ).catch(() => {});
  await page.waitForTimeout(350);

  if (settingsTab) {
    const labelMap = {
      courses: "课程与教室",
      accounts: "账号",
      rights: "角色权限",
      institution: "机构信息",
      backup: "数据备份",
      export: "导入导出",
    };
    const text = labelMap[settingsTab];
    if (text) {
      const navLink = page.locator(`.fq-se-nav a, .fq-se-nav button, .v-head-tabs button`).filter({ hasText: text }).first();
      if (await navLink.isVisible().catch(() => false)) {
        await navLink.click();
        await page.waitForTimeout(450);
      }
    }
  }
}

/**
 * 在页面内检测各类溢出、裁切、截断与遮挡问题
 */
export async function inspectPageLayout(page, meta = {}) {
  return page.evaluate((ctx) => {
    const issues = [];
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const sw = document.documentElement.scrollWidth;
    const cw = document.documentElement.clientWidth;

    const describeEl = (el) => {
      if (!el || !el.tagName) return "unknown";
      const tag = el.tagName.toLowerCase();
      const id = el.id ? "#" + el.id : "";
      const cls =
        typeof el.className === "string" && el.className.trim()
          ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".")
          : "";
      const txt = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 28);
      return `${tag}${id}${cls}${txt ? `("${txt}")` : ""}`;
    };

    const isVisible = (el) => {
      const st = getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0.5 && r.height > 0.5;
    };

    const hasHorizontalScrollAncestor = (el) => {
      let cur = el.parentElement;
      while (cur && cur !== document.documentElement) {
        const st = getComputedStyle(cur);
        if ((st.overflowX === "auto" || st.overflowX === "scroll") && cur.scrollWidth > cur.clientWidth + 2) {
          return true;
        }
        cur = cur.parentElement;
      }
      return false;
    };

    // 1. 整页横向滚动条
    if (sw > cw + 1) {
      const offenders = [];
      for (const el of document.querySelectorAll("body *")) {
        if (!isVisible(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.right > vw + 2 && !hasHorizontalScrollAncestor(el)) {
          offenders.push({ el: describeEl(el), right: Math.round(r.right), overflow: Math.round(r.right - vw) });
        }
      }
      offenders.sort((a, b) => b.overflow - a.overflow);
      issues.push({
        type: "horizontal-overflow",
        severity: "P1",
        detail: `scrollWidth(${sw}) > clientWidth(${cw})，超出 ${sw - cw}px`,
        offenders: offenders.slice(0, 5),
        ...ctx,
      });
    }

    // 2. 弹出层 / 菜单越界检查（[popover]:popover-open, .ui-more-menu:popover-open）
    for (const pop of document.querySelectorAll("[popover]:popover-open, .ui-more-menu:popover-open")) {
      if (!isVisible(pop)) continue;
      const r = pop.getBoundingClientRect();
      const outLeft = r.left < -1;
      const outRight = r.right > vw + 1;
      const outTop = r.top < -1;
      const outBottom = r.bottom > vh + 1;
      if (outLeft || outRight || outTop || outBottom) {
        issues.push({
          type: "popover-out-of-bounds",
          severity: "P1",
          selector: describeEl(pop),
          detail: `弹层越界 rect=[L:${Math.round(r.left)}, T:${Math.round(r.top)}, R:${Math.round(r.right)}, B:${Math.round(r.bottom)}] vs viewport=${vw}×${vh}`,
          ...ctx,
        });
      }
    }

    // 3. 按钮/交互控件水平截断或超出视口
    const interactiveSel = "button, a.fq-se-btn, a.fq-se-link, .ui-button, .v-nav-item, .v-tab, .fq-se-chip";
    const seenClip = new Set();
    for (const el of document.querySelectorAll(interactiveSel)) {
      if (!isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      // 跳过屏幕外滚动区以外或故意在横向滚动条内的元素
      if (r.bottom < 0 || r.top > vh) continue;
      if (!hasHorizontalScrollAncestor(el) && (r.right > vw + 2 || r.left < -2)) {
        const key = "vp:" + describeEl(el);
        if (!seenClip.has(key)) {
          seenClip.add(key);
          issues.push({
            type: "viewport-overflow",
            severity: "P1",
            selector: describeEl(el),
            detail: `控件超出视口 rect=[L:${Math.round(r.left)}, R:${Math.round(r.right)}] vs vw=${vw}`,
            ...ctx,
          });
        }
      }
      // 被 overflow:hidden 父容器裁切
      let cur = el.parentElement;
      while (cur && cur !== document.body && cur !== document.documentElement) {
        const pst = getComputedStyle(cur);
        if (pst.overflowX === "hidden" || pst.overflowX === "clip") {
          const pr = cur.getBoundingClientRect();
          if (pr.width > 0 && (r.right > pr.right + 3 || r.left < pr.left - 3)) {
            const key = "clip:" + describeEl(el) + "->" + describeEl(cur);
            if (!seenClip.has(key)) {
              seenClip.add(key);
              issues.push({
                type: "parent-clip",
                severity: "P2",
                selector: describeEl(el),
                parent: describeEl(cur),
                detail: `控件被父容器裁切 child=[${Math.round(r.left)}..${Math.round(r.right)}] vs parent=[${Math.round(pr.left)}..${Math.round(pr.right)}]`,
                ...ctx,
              });
            }
            break;
          }
        }
        cur = cur.parentElement;
      }
      // 按钮自身文字水平溢出
      const target = el.querySelector(".ui-button-face") || el;
      const tst = getComputedStyle(target);
      if (
        tst.textOverflow !== "ellipsis" &&
        target.clientWidth > 0 &&
        target.scrollWidth > target.clientWidth + 3
      ) {
        const key = "trunc:" + describeEl(el);
        if (!seenClip.has(key)) {
          seenClip.add(key);
          issues.push({
            type: "text-truncation",
            severity: "P2",
            selector: describeEl(el),
            detail: `按钮/控件内容溢出 scrollWidth(${target.scrollWidth}) > clientWidth(${target.clientWidth})`,
            ...ctx,
          });
        }
      }
    }

    // 4. 手机底栏遮挡页底操作栏检查
    const tabbar = document.querySelector(".v-tabbar");
    if (tabbar && isVisible(tabbar)) {
      const tbRect = tabbar.getBoundingClientRect();
      for (const bar of document.querySelectorAll(".v-form-foot, .v-m-submitbar, .fq-se-sticky-bar")) {
        if (!isVisible(bar)) continue;
        const br = bar.getBoundingClientRect();
        if (br.bottom > tbRect.top + 2 && br.top < tbRect.bottom) {
          issues.push({
            type: "fixed-occlusion",
            severity: "P1",
            selector: describeEl(bar),
            detail: `底部操作栏(bottom=${Math.round(br.bottom)})被底栏(top=${Math.round(tbRect.top)})遮挡`,
            ...ctx,
          });
        }
      }
    }

    return issues;
  }, meta);
}

/**
 * 探测当前页面所有「更多 / ⋯」弹出菜单（含设置 › 课程大类卡片菜单）
 */
export async function probePopoversAndMenus(page, meta = {}, { maxTriggers = 12, screenshotDir = null } = {}) {
  const issues = [];
  const triggers = page.locator("button[aria-haspopup='menu'], .ui-menu-holder > button");
  const count = await triggers.count();
  const limit = Math.min(count, maxTriggers);

  for (let i = 0; i < limit; i++) {
    const btn = triggers.nth(i);
    if (!(await btn.isVisible().catch(() => false))) continue;
    try {
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await btn.click({ timeout: 3000 });
      await page.waitForTimeout(180);

      const popIssues = await page.evaluate(
        ({ ctx, idx }) => {
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          const out = [];
          const openMenus = [...document.querySelectorAll(".ui-more-menu:popover-open, [popover]:popover-open")];
          if (!openMenus.length) {
            out.push({
              type: "popover-not-opened",
              severity: "P2",
              detail: `第 ${idx + 1} 个菜单按钮点击后未检测到 :popover-open 浮层`,
              ...ctx,
            });
            return out;
          }
          for (const pop of openMenus) {
            const r = pop.getBoundingClientRect();
            const overLeft = r.left < -1;
            const overRight = r.right > vw + 1;
            const overTop = r.top < -1;
            const overBottom = r.bottom > vh + 1;
            if (overLeft || overRight || overTop || overBottom || r.width < 10 || r.height < 10) {
              out.push({
                type: "menu-out-of-bounds",
                severity: "P1",
                triggerIndex: idx,
                rect: {
                  left: Math.round(r.left),
                  top: Math.round(r.top),
                  right: Math.round(r.right),
                  bottom: Math.round(r.bottom),
                  width: Math.round(r.width),
                  height: Math.round(r.height),
                },
                viewport: { vw, vh },
                detail: `菜单越界 rect=[L:${Math.round(r.left)}, T:${Math.round(r.top)}, R:${Math.round(r.right)}, B:${Math.round(r.bottom)}] vs viewport=${vw}×${vh}`,
                ...ctx,
              });
            }
          }
          return out;
        },
        { ctx: meta, idx: i },
      );

      if (popIssues.length && screenshotDir) {
        const fname = `menu-${meta.role}-${meta.viewport}-${meta.routeId}-${i}.png`.replace(/[^a-zA-Z0-9._-]/g, "_");
        await mkdir(screenshotDir, { recursive: true });
        await page.screenshot({ path: path.join(screenshotDir, fname) }).catch(() => {});
      }
      issues.push(...popIssues);
    } catch {
      // ignore non-interactive trigger
    } finally {
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(80);
    }
  }
  return issues;
}

export async function runFullAudit({
  baseUrl = process.env.PREVIEW_URL || "http://localhost:4195",
  chromePath = process.env.PLAYWRIGHT_CHROME_PATH || "/usr/bin/google-chrome",
  viewports = VIEWPORTS,
  roles = ["supervisor", "academic", "finance", "teacher", "student"],
  screenshotDir = null,
  probeMenus = true,
  cwd = process.cwd(),
} = {}) {
  const accounts = await seedPreviewAccounts(baseUrl, cwd);
  const browser = await chromium.launch({
    headless: true,
    executablePath: chromePath,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });

  const allIssues = [];
  const visited = [];
  const startedAt = Date.now();

  try {
    for (const role of roles) {
      const account = accounts[role];
      const routes = ROLE_ROUTES[role] || [];
      for (const vp of viewports) {
        const context = await browser.newContext({
          viewport: { width: vp.width, height: vp.height },
          isMobile: vp.isMobile,
          hasTouch: vp.hasTouch,
          locale: "zh-CN",
          timezoneId: "Asia/Shanghai",
        });
        const page = await context.newPage();
        try {
          await loginAs(page, baseUrl, account);
          for (const route of routes) {
            if (!route.personal) {
              await navigateHash(page, route.hash, route.settingsTab || null);
            } else {
              await page.waitForTimeout(450);
            }
            const meta = {
              role,
              viewport: vp.id,
              viewportLabel: vp.label,
              routeId: route.id,
              routeLabel: route.label,
              hash: route.hash,
            };
            visited.push(meta);
            const layoutIssues = await inspectPageLayout(page, meta);
            allIssues.push(...layoutIssues);

            if (probeMenus) {
              const menuIssues = await probePopoversAndMenus(page, meta, {
                maxTriggers: route.id === "settings-courses" ? 16 : 6,
                screenshotDir,
              });
              allIssues.push(...menuIssues);
            }

            // 个人端（老师/学员）额外遍历底部/顶部导航切换页签
            if (route.personal) {
              const tabs = page.locator(".v-tabbar button, .fq-t-nav button, .fq-s-nav button, .fq-t-tabs button, .fq-s-tabs button");
              const tCount = Math.min(await tabs.count(), 6);
              for (let ti = 0; ti < tCount; ti++) {
                const tb = tabs.nth(ti);
                if (!(await tb.isVisible().catch(() => false))) continue;
                const label = (await tb.innerText().catch(() => "")).trim().replace(/\s+/g, " ");
                await tb.click().catch(() => {});
                await page.waitForTimeout(400);
                const subMeta = { ...meta, routeId: `${route.id}-tab-${ti}`, routeLabel: `${route.label}›${label || ti}` };
                visited.push(subMeta);
                allIssues.push(...(await inspectPageLayout(page, subMeta)));
              }
            }
          }
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }

  return {
    baseUrl,
    durationMs: Date.now() - startedAt,
    visitedCount: visited.length,
    issueCount: allIssues.length,
    issues: allIssues,
  };
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = Object.fromEntries(
    process.argv
      .slice(2)
      .filter((a) => a.startsWith("--"))
      .map((a) => {
        const [k, v] = a.slice(2).split("=");
        return [k, v ?? "true"];
      }),
  );
  const res = await runFullAudit({
    screenshotDir: args.shots || null,
    roles: args.roles ? args.roles.split(",").filter(Boolean) : undefined,
    viewports: args.viewports
      ? VIEWPORTS.filter((v) => args.viewports.split(",").includes(v.id))
      : undefined,
  });
  if (args.out) {
    await mkdir(path.dirname(args.out), { recursive: true });
    await writeFile(args.out, JSON.stringify(res, null, 2), "utf8");
  }
  const byType = {};
  for (const it of res.issues) byType[it.type] = (byType[it.type] || 0) + 1;
  console.log(
    JSON.stringify(
      {
        visitedCount: res.visitedCount,
        durationMs: res.durationMs,
        issueCount: res.issueCount,
        byType,
      },
      null,
      2,
    ),
  );
}
