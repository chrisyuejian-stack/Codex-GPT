import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fixture } from "./support.mjs";

const origin = "https://school.test";
const get = (f, path) => f.directRequest(origin + path, { headers: { Origin: origin } });

test("PWA：manifest、Service Worker、图标可取且类型正确；sw.js 与 manifest 不长缓存，图标带版本号长缓存", async () => {
  const f = await fixture({ legacyUrls: false });
  try {
    const manifest = await get(f, "/manifest.webmanifest");
    assert.equal(manifest.status, 200);
    assert.match(manifest.headers.get("content-type"), /^application\/manifest\+json/);
    assert.equal(manifest.headers.get("cache-control"), "no-cache");
    const m = await manifest.json();
    assert.equal(m.name, "枫琴教务中心");
    assert.equal(m.start_url, "/app/");
    assert.equal(m.scope, "/");
    assert.equal(m.display, "standalone");
    assert.ok(m.icons.some((x) => x.purpose === "maskable" && x.sizes === "512x512"));

    for (const path of ["/sw.js", "/sw.js?v=0123456789ab", "/manifest.webmanifest?v=0123456789ab"]) {
      const r = await get(f, path);
      assert.equal(r.status, 200, path);
      // 地址固定的 sw.js / manifest 即使带 v 参数也不能 immutable，否则新版本发不出去。
      assert.equal(r.headers.get("cache-control"), "no-cache", path);
      await r.arrayBuffer();
    }
    const sw = await get(f, "/sw.js");
    assert.match(sw.headers.get("content-type"), /^application\/javascript/);
    const code = await sw.text();
    assert.match(code, /startsWith\("\/api\/"\)\) return;/);

    for (const icon of ["icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"]) {
      const r = await get(f, "/assets/" + icon + "?v=0123456789ab");
      assert.equal(r.status, 200, icon);
      assert.equal(r.headers.get("content-type"), "image/png");
      assert.equal(r.headers.get("cache-control"), "public, max-age=31536000, immutable");
      const bytes = new Uint8Array(await r.arrayBuffer());
      assert.deepEqual([...bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], icon + " 是 PNG");
    }
    // 白名单之外的同目录文件仍是中性 404。
    assert.equal((await get(f, "/assets/icon-1024.png")).status, 404);
  } finally {
    f.restore();
  }
});

test("PWA：页面带 manifest 与 iOS 主屏幕标签，CSP 允许 manifest 与同源 worker；接口不受影响", async () => {
  const f = await fixture({ legacyUrls: false });
  try {
    const login = await get(f, "/login");
    assert.equal(login.status, 200);
    const csp = login.headers.get("content-security-policy");
    assert.match(csp, /manifest-src 'self'/);
    assert.match(csp, /worker-src 'self'/);
    assert.match(csp, /script-src 'self';/);
    const html = await login.text();
    assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest"/);
    assert.match(html, /rel="apple-touch-icon"/);
    assert.match(html, /name="apple-mobile-web-app-title" content="枫琴教务"/);
    assert.match(html, /name="theme-color"/);
    const status = await get(f, "/api/auth/status");
    assert.equal(status.status, 200);
    assert.equal(status.headers.get("cache-control"), "no-store");
  } finally {
    f.restore();
  }
});

test("PWA：Service Worker 不缓存接口和个人数据，只缓存带版本号的静态文件与正常的页面外壳", async () => {
  const code = await readFile("src/tenant/pwa/sw.js", "utf8");
  // 接口与非 GET 请求一律放行。
  assert.match(code, /if \(request\.method !== "GET"\) return;/);
  assert.match(code, /if \(url\.pathname\.startsWith\("\/api\/"\)\) return;/);
  // 静态文件只接受 16 进制版本号；页面只缓存 200 且未跳转的响应。
  assert.match(code, /\/\^\[a-f0-9\]\{8,64\}\$\/\.test\(url\.searchParams\.get\("v"\)/);
  assert.match(code, /response\.status === 200 && response\.type === "basic" && !response\.redirected/);
  // 离线页不含脚本（CSP 下也不能有内联脚本）。
  assert.ok(!/<script/i.test(code));
  // 注册只在 https 或本机。
  const app = await readFile("src/tenant/app.js", "utf8");
  assert.match(app, /navigator\.serviceWorker\.register\("\/sw\.js", \{ scope: "\/" \}\)/);
  assert.match(app, /location\.protocol === "https:" \|\| location\.hostname === "localhost"/);
});
