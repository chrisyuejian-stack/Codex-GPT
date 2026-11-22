import { defineConfig, chromium } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';

// Only inherited by the test runner and its local child server. Never bundled.
process.env.E2E_CONTROL_KEY ||= randomBytes(32).toString('hex');
const port = Number(process.env.E2E_PORT || 4380);
const reportDir = process.env.E2E_REPORT_DIR || 'work/e2e';

function resolveChromePath() {
  const override = process.env.PLAYWRIGHT_CHROME_PATH || process.env.CHROME_PATH;
  if (override) return override;
  try {
    const bundled = chromium.executablePath();
    if (bundled && existsSync(bundled)) return undefined;
  } catch {
    // Fall through to system Chrome/Chromium discovery.
  }
  for (const candidate of ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const executablePath = resolveChromePath();

export default defineConfig({
  testDir: './tests/e2e',
  snapshotPathTemplate: '{testDir}/__snapshots__/{testFileName}/{arg}-{projectName}{ext}',
  timeout: 90_000,
  expect: {
    timeout: 12_000,
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.02,
      animations: 'disabled',
    },
  },
  workers: 1,
  retries: 0,
  outputDir: `${reportDir}/artifacts`,
  reporter: [['list'], ['html', { outputFolder: `${reportDir}/html`, open: 'never' }], ['./scripts/e2e/reporter.mjs']],
  use: {
    baseURL: `http://localhost:${port}`,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    actionTimeout: 12_000,
    trace: 'off',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      args: ['--disable-dev-shm-usage', '--disable-gpu', '--no-sandbox'],
      ...(executablePath ? { executablePath } : {}),
    },
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
  ],
  webServer: {
    command: 'node scripts/e2e/server.mjs',
    url: `http://localhost:${port}/__e2e/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      E2E_PORT: String(port),
      E2E_CONTROL_KEY: process.env.E2E_CONTROL_KEY,
      ...(process.env.TEST_BUNDLE ? { TEST_BUNDLE: process.env.TEST_BUNDLE } : {}),
    },
  },
});
