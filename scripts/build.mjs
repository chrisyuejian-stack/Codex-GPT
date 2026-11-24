import { tenantAssets } from "./frontend-bundle.mjs";
import vm from "node:vm";
import { readFile, mkdir, writeFile, rm, copyFile } from "node:fs/promises";
import path from "node:path";
const out = "dist";
await rm(out, { recursive: true, force: true });
await mkdir(out + "/assets", { recursive: true });
// 无第三方运行时；打包成单个 Pages Advanced Mode Worker。源码留在独立交付包。
const completed = new Map();
let chunks = [];
async function bundle(file) {
  file = path.resolve(file);
  if (completed.has(file)) return completed.get(file);
  const symbol = "module_" + completed.size;
  completed.set(file, symbol);
  let code = await readFile(file, "utf8");
  const importRx = /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"];?/g;
  let imports = [],
    match;
  while ((match = importRx.exec(code)))
    imports.push({ full: match[0], names: match[1], file: match[2] });
  for (const entry of imports) {
    const dep = await bundle(path.resolve(path.dirname(file), entry.file));
    code = code.replace(entry.full, `const {${entry.names}}=${dep};`);
  }
  let names = [];
  for (const m of code.matchAll(
    /export (?:async )?(?:function|class|const|let)\s+(\w+)/g,
  ))
    names.push(m[1]);
  if (/export default worker;/.test(code)) {
    names.push("default:worker");
    code = code.replace("export default worker;", "");
  }
  code = code.replace(
    /\bexport (?=(?:async )?(?:function|class|const|let)\b)/g,
    "",
  );
  chunks.push(
    `const ${symbol}=(()=>{\n${code}\nreturn {${names.join(",")}};\n})();`,
  );
  return symbol;
}
const entry = await bundle("src/server/worker.js");
await writeFile(
  out + "/_worker.js",
  chunks.join("\n") + `\nexport default ${entry}.default;\n`,
);
await copyFile("src/tenant/index.html", out + "/tenant.html");
const frontend = await tenantAssets();
await writeFile(out + "/assets/tenant.js", frontend.js);
await writeFile(out + "/assets/tenant.css", frontend.css);
await writeFile(out + "/assets/tenant-fonts.css", frontend.deferredCss);
// PWA：图标放 /assets/（带版本号长缓存），manifest 与 sw.js 放根路径（不长缓存，版本号在下面注入）。
for (const icon of ["icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"])
  await copyFile("src/tenant/pwa/" + icon, out + "/assets/" + icon);
await copyFile("src/tenant/pwa/manifest.webmanifest", out + "/manifest.webmanifest");
await copyFile("src/tenant/pwa/sw.js", out + "/sw.js");
await writeFile(
  out + "/_routes.json",
  JSON.stringify({ version: 1, include: ["/*"], exclude: [] }),
);
await writeFile(
  out + "/index.html",
  '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>教务管理系统</title><p>请使用机构提供的登录地址</p></html>',
);
console.log("Pages 包已生成：dist/");

completed.clear();
chunks = [];
const backupEntry = await bundle("src/server/backup.js");
await mkdir("backup-dist", { recursive: true });
await writeFile(
  "backup-dist/backup-worker.js",
  chunks.join("\n") + `\nexport default ${backupEntry}.default;\n`,
);
console.log("定时备份 Worker 已生成：backup-dist/backup-worker.js");

// 仅构建环境执行固定版本离线工具；生产代码没有eval/Function或source map。
const buildContext = vm.createContext({ console });
vm.runInContext(
  await readFile("scripts/vendor/terser-5.44.1.cjs", "utf8"),
  buildContext,
);
const paths = [
  "dist/_worker.js",
  "backup-dist/backup-worker.js",
  "dist/assets/tenant.js",
];
const sizes = [];
for (const file of paths) {
  const original = await readFile(file, "utf8");
  const result = await buildContext.Terser.minify(original, {
    module: true,
    compress: { passes: 2 },
    mangle: { toplevel: true },
    sourceMap: false,
    format: { comments: false },
  });
  if (!result.code || result.map) throw Error("生产压缩失败");
  await writeFile(file, result.code + "\n");
  sizes.push({
    file,
    before: Buffer.byteLength(original),
    after: Buffer.byteLength(result.code + "\n"),
  });
}
await writeFile(
  "backup-dist/build-report.json",
  JSON.stringify(sizes, null, 2) + "\n",
);
console.log("生产JS已压缩与变量名混淆，无source map；构建工具离线可复现。");

// 静态文件版本号：HTML 引用写成 /assets/tenant.js?v=<内容哈希前 12 位>。
// 内容变了地址就变，浏览器可以长期缓存（配合后端对带 v 的静态文件返回长缓存头）。
const { createHash } = await import("node:crypto");
for (const [page, files] of [
  ["dist/tenant.html", ["/assets/tenant.css", "/assets/tenant.js", "/assets/tenant-fonts.css", "/assets/apple-touch-icon.png"]],
  ["dist/manifest.webmanifest", ["/assets/icon-192.png", "/assets/icon-512.png", "/assets/icon-maskable-512.png"]],
]) {
  let html = await readFile(page, "utf8");
  for (const file of files) {
    const hash = createHash("sha256").update(await readFile("dist" + file)).digest("hex").slice(0, 12);
    const before = html;
    html = html.replace(`"${file}"`, `"${file}?v=${hash}"`);
    if (html === before) throw Error("HTML 中找不到 " + file);
  }
  await writeFile(page, html);
}
console.log("静态文件已加版本号。");

// Service Worker：预缓存当前版本的 CSS/JS/图标（地址与 HTML、manifest 里的 ?v= 一致）；
// VERSION 取这些地址的哈希，发新版时缓存名随之改变，旧缓存在激活时清理。
{
  const html = await readFile("dist/tenant.html", "utf8");
  const manifest = await readFile("dist/manifest.webmanifest", "utf8");
  const shell = [
    ...new Set([
      ...html.matchAll(/"(\/assets\/(?:tenant\.css|tenant\.js|apple-touch-icon\.png)\?v=[a-f0-9]{12})"/g),
      ...manifest.matchAll(/"(\/assets\/icon-[a-z0-9-]+\.png\?v=[a-f0-9]{12})"/g),
    ].map((m) => m[1])),
  ];
  if (shell.length !== 6) throw Error("Service Worker 预缓存清单不完整：" + shell.join(","));
  const version = createHash("sha256").update(shell.join("\n")).digest("hex").slice(0, 12);
  let sw = await readFile("dist/sw.js", "utf8");
  const before = sw;
  sw = sw
    .replace('const VERSION = "dev";', `const VERSION = "${version}";`)
    .replace("/*SHELL*/ [] /*END*/", JSON.stringify(shell));
  if (sw === before || sw.includes("/*SHELL*/")) throw Error("sw.js 版本注入失败");
  await writeFile("dist/sw.js", sw);
  console.log("Service Worker 已注入版本 " + version + "，预缓存 " + shell.length + " 个文件。");
}
