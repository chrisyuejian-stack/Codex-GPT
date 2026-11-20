// 生成“单文件” Pages 部署包：把 dist/ 里的静态文件内嵌进 _worker.js，用内存 ASSETS 代替 Pages 静态资源。
// 原因：本环境的出站代理会把发往 api.cloudflare.com 的认证头统一替换为 API 令牌，
// 而 Pages 的静态文件上传接口只接受临时 JWT，因此改为只上传 _worker.js（部署接口接受 API 令牌）。
// 用法：node make-bundle.mjs <repo>/dist <输出目录>
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { join, extname, relative } from "node:path";

const [dist, out] = process.argv.slice(2);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
};
async function walk(dir) {
  const files = [];
  for (const name of await readdir(dir)) {
    const p = join(dir, name);
    if ((await stat(p)).isDirectory()) files.push(...(await walk(p)));
    else files.push(p);
  }
  return files;
}
const assets = {};
for (const file of await walk(dist)) {
  const rel = "/" + relative(dist, file).split("\\").join("/");
  if (rel === "/_worker.js" || rel === "/_routes.json") continue;
  assets[rel] = { type: types[extname(file)] || "application/octet-stream", body: await readFile(file, "utf8") };
}
let worker = await readFile(join(dist, "_worker.js"), "utf8");
const tail = /export default ([A-Za-z0-9_$.]+);\s*$/;
const m = worker.match(tail);
if (!m) throw Error("dist/_worker.js 结尾不是预期的 export default");
worker = worker.replace(tail, "\nconst __fqApp = " + m[1] + ";\n");
worker += `
const __fqAssets = ${JSON.stringify(assets)};
const __fqStatic = {
  async fetch(input) {
    const url = new URL(typeof input === "string" ? input : input.url);
    let path = url.pathname;
    if (path.endsWith("/")) path += "index.html";
    const hit = __fqAssets[path];
    if (!hit) return new Response("Not Found", { status: 404 });
    return new Response(hit.body, { headers: { "Content-Type": hit.type } });
  },
};
export default {
  ...__fqApp,
  fetch(req, env, ctx) {
    return __fqApp.fetch(req, { ...env, ASSETS: __fqStatic }, ctx);
  },
};
`;
await mkdir(out, { recursive: true });
await writeFile(join(out, "_worker.js"), worker);
await writeFile(join(out, "_routes.json"), await readFile(join(dist, "_routes.json"), "utf8"));
console.log("bundle", Object.keys(assets), (worker.length / 1024).toFixed(0) + "KB");
