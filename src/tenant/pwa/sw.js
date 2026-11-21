// 枫琴教务中心 · Service Worker（PWA 基础版）
// - 带版本号的 /assets/* 走缓存优先（内容变了地址就变，可以放心长期缓存）。
// - 页面导航（/login、/app/…）走网络优先：3.5 秒内没回应就先用上次缓存的页面外壳，
//   网络完全不通时显示离线提示。页面外壳是同一份静态 HTML，不含任何个人数据。
// - /api/* 以及其他请求一律不拦截、不缓存，直接走网络（个人数据绝不进缓存）。
// 构建时 scripts/build.mjs 会替换 VERSION 和 SHELL（当前版本的 CSS/JS/图标地址）。
const VERSION = "dev";
const SHELL = /*SHELL*/ [] /*END*/;
const ASSET_CACHE = "fq-assets-" + VERSION;
const PAGE_CACHE = "fq-pages-" + VERSION;
const NAV_TIMEOUT = 3500;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(ASSET_CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("fq-") && k !== ASSET_CACHE && k !== PAGE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const offlinePage = () =>
  new Response(
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#2a1f3e"><title>枫琴教务中心</title><style>' +
      "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4efe8;color:#2a1f3e;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif}" +
      "main{text-align:center;padding:32px}h1{font-size:20px;margin:0 0 8px}p{margin:0 0 24px;color:#6b6178;font-size:15px}" +
      "a{display:inline-block;padding:12px 32px;border-radius:10px;background:#2a1f3e;color:#fff;text-decoration:none;font-size:16px}" +
      '</style></head><body><main><h1>网络不可用</h1><p>网络不可用，请检查网络后重试</p><a href="/app/">重试</a></main></body></html>',
    {
      status: 503,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      },
    },
  );

async function navigate(event) {
  const request = event.request;
  const url = new URL(request.url);
  const key = url.pathname.startsWith("/app") ? "/app/" : url.pathname;
  const cache = await caches.open(PAGE_CACHE);
  const network = fetch(request).then((response) => {
    // 只缓存正常的 200 页面（未登录时 /app/ 会 302 到 /login，不缓存跳转）。
    if (response.ok && response.status === 200 && response.type === "basic" && !response.redirected)
      cache.put(key, response.clone()).catch(() => {});
    return response;
  });
  network.catch(() => {});
  const cached = await cache.match(key);
  if (!cached) return network.catch(() => offlinePage());
  let timer;
  const slow = new Promise((resolve) => {
    timer = setTimeout(() => resolve(cached), NAV_TIMEOUT);
  });
  try {
    return await Promise.race([network, slow]);
  } catch {
    // 网络完全不通：给缓存的页面外壳。老师、学员可以看本机保存的最近数据（离线模式），
    // 其他账号由页面自己显示“网络不可用”。
    return cached;
  } finally {
    clearTimeout(timer);
  }
}

async function asset(request) {
  const cache = await caches.open(ASSET_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok && response.status === 200) cache.put(request, response.clone()).catch(() => {});
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  if (request.mode === "navigate" && (url.pathname === "/login" || url.pathname === "/app" || url.pathname.startsWith("/app/"))) {
    event.respondWith(navigate(event));
    return;
  }
  if (url.pathname.startsWith("/assets/") && /^[a-f0-9]{8,64}$/.test(url.searchParams.get("v") || "")) {
    event.respondWith(asset(request));
  }
});
