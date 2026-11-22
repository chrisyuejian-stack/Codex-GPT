import { expect } from '@playwright/test';

export const controller = () => ({ 'x-e2e-key': process.env.E2E_CONTROL_KEY });

export async function waitAppReady(page) {
  await expect(page.locator('.personal-content, .v-content').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.personal-content, .v-content').first()).toHaveAttribute('aria-busy', 'false', { timeout: 15_000 });
  await page.waitForTimeout(250);
}

export async function loginUI(page, phone, password) {
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  const phoneInput = page.locator("input[type='tel'], input[name='phone'], input[placeholder*='手机']").first();
  const pwInput = page.locator("input[type='password']").first();
  await expect(phoneInput).toBeVisible();
  await phoneInput.fill(phone);
  await pwInput.fill(password);
  await page.locator("button[type='submit'], button:has-text('登录')").first().click();
  await page.waitForURL('**/app**', { timeout: 15_000 });
  await waitAppReady(page);
}

export async function gotoHash(page, hash) {
  const target = hash.startsWith('#') ? hash : `#${hash}`;
  await page.evaluate(h => { location.hash = h; }, target);
  await page.waitForTimeout(300);
  await waitAppReady(page);
}

export async function assertNoOverflow(page, label = '') {
  const metrics = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
  }));
  expect(
    metrics.sw,
    `${label || page.url()} 横向溢出: scrollWidth=${metrics.sw} > clientWidth=${metrics.cw}`
  ).toBeLessThanOrEqual(metrics.cw + 1);
}

export function topSheet(page) {
  return page.locator('.ui-sheet').last();
}

export async function closeAllSheets(page) {
  for (let i = 0; i < 4; i++) {
    const count = await page.locator('.ui-sheet').count();
    if (!count) break;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
  }
}

export async function createHarness(
  browser,
  request,
  info,
  roles,
  { kind = 'fengqin', bootstrapSession = true, fixedClock = true } = {}
) {
  const reset = await request.post(`/__e2e/reset?kind=${kind}`, { headers: controller() });
  expect(reset.ok(), `reset failed: ${reset.status()}`).toBeTruthy();
  const manifest = await reset.json();

  const actors = {};
  const errors = [];
  const failedRequests = [];
  const allowedMatchers = [];

  const allowFailedRequest = matcher => {
    allowedMatchers.push(matcher);
  };

  const state = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await request.get('/__e2e/state', { headers: controller() });
        expect(res.ok()).toBeTruthy();
        return res.json();
      } catch (err) {
        if (attempt === 2) throw err;
        await new Promise(r => setTimeout(r, 200));
      }
    }
  };

  const close = async () => {
    await info.attach('浏览器诊断', {
      body: JSON.stringify({ errors, failedRequests }, null, 2),
      contentType: 'application/json',
    }).catch(() => {});
    for (const { context } of Object.values(actors)) {
      await context.close().catch(() => {});
    }
  };

  try {
    for (const role of roles) {
      const context = await browser.newContext({
        baseURL: info.project.use.baseURL,
        viewport: info.project.use.viewport,
        isMobile: info.project.use.isMobile,
        hasTouch: info.project.use.hasTouch,
        deviceScaleFactor: info.project.use.deviceScaleFactor,
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
      });
      if (bootstrapSession) {
        const session = await context.request.post(`/__e2e/session?role=${role}`, { headers: controller() });
        expect(session.ok(), `session bootstrap failed for ${role}`).toBeTruthy();
      }
      const page = await context.newPage();
      if (fixedClock) {
        await page.clock.install({ time: new Date(manifest.now) });
      }
      page.on('pageerror', e => errors.push({ role, message: String(e?.message || e) }));
      page.on('response', r => {
        if (r.url().includes('/api/') && r.status() >= 400) {
          const entry = { role, path: new URL(r.url()).pathname, method: r.request().method(), status: r.status() };
          if (!allowedMatchers.some(fn => fn(entry))) {
            failedRequests.push(entry);
          }
        }
      });
      actors[role] = { context, page };
    }
  } catch (error) {
    await close();
    throw error;
  }

  const openApp = async (role, hash = '') => {
    const page = actors[role].page;
    const url = hash ? `/app/${hash.startsWith('#') ? hash : `#${hash}`}` : '/app/';
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await waitAppReady(page);
    return page;
  };

  const healthy = async ({ checkOverflow = true } = {}) => {
    expect(errors, `存在未捕获 pageerror: ${JSON.stringify(errors)}`).toEqual([]);
    expect(failedRequests, `存在非预期 API 4xx/5xx: ${JSON.stringify(failedRequests)}`).toEqual([]);
    if (checkOverflow) {
      for (const [role, { page }] of Object.entries(actors)) {
        if (page.url() === 'about:blank') continue;
        await assertNoOverflow(page, `${role}@${page.url()}`);
      }
    }
  };

  return {
    manifest,
    actors,
    errors,
    failedRequests,
    allowFailedRequest,
    state,
    openApp,
    gotoHash: (role, hash) => gotoHash(actors[role].page, hash),
    healthy,
    close,
  };
}

export async function pickDate(scope, label, date) {
  await scope.getByRole('button', { name: label, exact: true }).click();
  await scope.getByRole('gridcell', { name: date, exact: true }).click();
}

export async function choose(scope, label, option) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await scope.getByRole('button', { name: new RegExp(`^${escaped}\\s*\\*?$`) }).click();
  await scope.getByRole('option', { name: option, exact: true }).click();
}
