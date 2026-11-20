// 生成 PWA 图标（开发时手动运行一次，产物提交在 src/tenant/pwa/）：
//   node scripts/pwa-icons.cjs
// 用 fq-assets.css 里的枫琴 logo（--fq-logo-light），深紫渐变底、居中留白，Playwright 渲染成 PNG。
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const root = path.resolve(__dirname, "..");
const css = fs.readFileSync(path.join(root, "src/tenant/fq-assets.css"), "utf8");
const logo = css.match(/--fq-logo-light:url\((data:image\/png;base64,[^)]+)\)/)[1];
const out = path.join(root, "src/tenant/pwa");
// [文件名, 边长, logo 宽度占比, 圆角占比]。maskable 的 logo 收在中心 80% 安全区内。
const jobs = [
  ["icon-192.png", 192, 0.68, 0],
  ["icon-512.png", 512, 0.68, 0],
  ["icon-maskable-512.png", 512, 0.52, 0],
  ["apple-touch-icon.png", 180, 0.66, 0],
];
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  for (const [name, size, ratio] of jobs) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(
      `<html><body style="margin:0"><div style="width:${size}px;height:${size}px;background:linear-gradient(160deg,#3d3054 0%,#2a1f3e 70%);display:flex;align-items:center;justify-content:center"><img src="${logo}" style="width:${Math.round(ratio * size)}px;height:auto;display:block"></div></body></html>`,
    );
    await page.waitForTimeout(100);
    await page.screenshot({ path: path.join(out, name), clip: { x: 0, y: 0, width: size, height: size } });
    await page.close();
  }
  await browser.close();
  console.log("PWA 图标已生成：", jobs.map((j) => j[0]).join("、"));
})();
