// 第三期 · 设置（DECISIONS 14）：主管直接修改机构名称、Logo、联系说明。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture } from "./support.mjs";
import { setup, request, accountToken, pack } from "./fixtures-credit.mjs";
import { b64, bytes, sha } from "../src/server/core.js";

const PASSWORD = "Backup-Pass-Institution-2026!";
// 最小合法 PNG 文件头（8 字节签名 + IHDR 块）。
const PNG = "data:image/png;base64," + Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]).toString("base64");

async function withSchool(fn) {
  const f = await fixture();
  try {
    const s = await setup(f, 1, "inst");
    s.f = f;
    await fn(s);
  } finally {
    f.restore();
  }
}
const ok = (r, status = 200) => {
  assert.equal(r.status, status, r.text);
  return r.body;
};

test("第三期设置：主管修改机构名称、Logo、联系说明（密文存储），品牌与续费通知同步解密，写脱敏审计", () =>
  withSchool(async (s) => {
    const before = ok(await request(s, "settings/institution"));
    assert.equal(before.editable, true);
    const contact = "咨询请加顾问微信 13900008888";
    const next = ok(
      await request(s, "settings/institution", "PATCH", {
        version: before.version,
        name: "  枫琴国际艺术  ",
        logo: PNG,
        contact_text: contact,
      }),
    );
    assert.equal(next.name, "枫琴国际艺术");
    assert.equal(next.logo, PNG);
    assert.equal(next.contact_text, contact);
    assert.equal(next.version, before.version + 1);

    // 数据库中 contact_text 必须以 AES-GCM v1 密文保存，绝不落明文。
    const dbRow = s.f.db.raw
      .prepare("SELECT display_name,contact_text FROM tenant_branding WHERE tenant_id=? AND id='brand'")
      .get(s.t.id);
    assert.equal(dbRow.display_name, "枫琴国际艺术");
    assert.ok(dbRow.contact_text.startsWith("v1."), "contact_text 须加密存储");
    assert.ok(!dbRow.contact_text.includes("13900008888"), "数据库不得包含联系说明明文");

    // 公开品牌同步名称与带版本号 Logo，且不返回 contact_text。
    const pub = await s.f.request("https://school.test/" + s.t.slug + "/api/public/brand?lite=1");
    const lite = await pub.json();
    assert.equal(lite.display_name, "枫琴国际艺术");
    assert.match(lite.logo, /public\/brand\/logo\?v=/);
    assert.ok(!("contact_text" in lite));

    // 续费品牌与批量续费生成接口均能正常解密 contact_text。
    const renewalBrand = ok(await request(s, "renewal-brand"));
    assert.equal(renewalBrand.display_name, "枫琴国际艺术");
    assert.equal(renewalBrand.contact_text, contact);
    await pack(s, s.students[0], 2);
    const gen = ok(
      await request(s, "renewals/generate", "POST", {
        items: [{ student_id: s.students[0], scope_kind: "type", scope_id: s.type }],
      }),
    );
    assert.equal(gen.brand.display_name, "枫琴国际艺术");
    assert.equal(gen.brand.contact_text, contact);

    // 主色、二维码接口读到同一版本号，主色仍可单独修改。
    const brand = ok(await request(s, "settings/brand"));
    assert.equal(brand.version, next.version);
    assert.equal(brand.name, "枫琴国际艺术");

    // 审计日志不保存 Logo 原图与联系说明原文/密文。
    const audit = s.f.db.raw
      .prepare("SELECT module,action,entity_id,summary,before_json,after_json FROM audit_log WHERE tenant_id=? AND entity_id='institution'")
      .all(s.t.id);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].module, "settings");
    assert.equal(audit[0].summary, "修改机构信息");
    assert.equal(JSON.parse(audit[0].after_json).logo, "已更换");
    assert.equal(JSON.parse(audit[0].after_json).contact_text, "已更新");
    assert.ok(!audit[0].after_json.includes("base64"), "审计不保存 Logo 原图");
    assert.ok(!audit[0].after_json.includes("13900008888"), "审计不保存联系说明原文");
    assert.ok(!audit[0].after_json.includes("v1."), "审计不保存密文");

    // 清空 Logo 与联系说明。
    const cleared = ok(await request(s, "settings/institution", "PATCH", { version: next.version, logo: null, contact_text: "" }));
    assert.equal(cleared.logo, null);
    assert.equal(cleared.contact_text, null);
    assert.equal(cleared.name, "枫琴国际艺术");
    const dbCleared = s.f.db.raw
      .prepare("SELECT contact_text FROM tenant_branding WHERE tenant_id=? AND id='brand'")
      .get(s.t.id);
    assert.equal(dbCleared.contact_text, "");
  }));

test("第三期设置：旧版本 409，非法字段与图片 422，非主管与个人角色 403", () =>
  withSchool(async (s) => {
    const cur = ok(await request(s, "settings/institution"));
    const stale = await request(s, "settings/institution", "PATCH", { version: cur.version + 5, name: "x" });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.details.latest.version, cur.version);
    for (const bad of [
      { primary_color: "#000000" },
      { name: "" },
      { name: "长".repeat(101) },
      { contact_text: "长".repeat(301) },
      { logo: "data:image/gif;base64,R0lGODlh" },
      { logo: "data:image/png;base64," + Buffer.from("not a png file").toString("base64") },
      { logo: "data:image/jpeg;base64," + Buffer.from([255, 216]).toString("base64") },
      { logo: "data:image/png;base64," + "A".repeat(180001) },
    ])
      assert.equal((await request(s, "settings/institution", "PATCH", { version: cur.version, ...bad })).status, 422, JSON.stringify(bad).slice(0, 80));

    const academic = await accountToken(s, ["academic"]);
    const read = ok(await request(s, "settings/institution", "GET", undefined, academic.token));
    assert.equal(read.editable, false);
    assert.equal((await request(s, "settings/institution", "PATCH", { version: cur.version, name: "越权" }, academic.token)).status, 403);

    const finance = await accountToken(s, ["finance"]);
    assert.equal((await request(s, "settings/institution", "PATCH", { version: cur.version, name: "越权" }, finance.token)).status, 403);

    const madeTeacher = ok(
      await request(s, "accounts", "POST", {
        name: "教师测试账号",
        phone: "137" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0"),
        roles: ["teacher"],
        teacher_id: s.teacher,
      }),
      201,
    );
    s.f.db.raw.prepare("UPDATE users SET must_change=0 WHERE tenant_id=? AND id=?").run(s.t.id, madeTeacher.id);
    const teacher = { token: b64(bytes(32)) };
    await s.r.createSession(await sha(teacher.token), await s.r.user(madeTeacher.id), { ip: "127.0.0.1", ua: "test" });
    assert.equal((await request(s, "settings/institution", "GET", undefined, teacher.token)).status, 403);
    assert.equal((await request(s, "settings/institution", "PATCH", { version: cur.version, name: "越权" }, teacher.token)).status, 403);

    const student = await accountToken(s, ["student"], s.students[0]);
    assert.equal((await request(s, "settings/institution", "GET", undefined, student.token)).status, 403);
    assert.equal((await request(s, "settings/institution", "PATCH", { version: cur.version, name: "越权" }, student.token)).status, 403);

    assert.equal(ok(await request(s, "settings/institution")).version, cur.version);
  }));

test("第三期设置：机构信息（含加密联系说明与 Logo）随全量备份完整往返恢复", () =>
  withSchool(async (s) => {
    const before = ok(await request(s, "settings/institution"));
    const saved = ok(
      await request(s, "settings/institution", "PATCH", {
        version: before.version,
        name: "枫琴音乐中心",
        logo: PNG,
        contact_text: "教务老师微信：fq_edu_01",
      }),
    );
    const exported = await request(s, "backups/export", "POST", { password: PASSWORD });
    ok(exported);
    const file = JSON.parse(exported.text);

    // 导出后改成另一套值，确认恢复能完整回滚。
    ok(
      await request(s, "settings/institution", "PATCH", {
        version: saved.version,
        name: "临时改名",
        logo: null,
        contact_text: "临时联系",
      }),
    );
    const p = ok(await request(s, "backups/restore/preview", "POST", { password: PASSWORD, file }), 201);
    ok(await request(s, "backups/restore/" + p.id + "/confirm", "POST", { confirm: true }));

    // 恢复后会话清空，重新签发主管会话核对恢复结果与解密可用性。
    const sup = s.f.db.raw.prepare("SELECT * FROM users WHERE tenant_id=? AND active=1 AND roles LIKE '%supervisor%' LIMIT 1").get(s.t.id);
    const freshToken = b64(bytes(32));
    await s.r.createSession(await sha(freshToken), sup, { ip: "127.0.0.1", ua: "test" });
    const restored = ok(await request(s, "settings/institution", "GET", undefined, freshToken));
    assert.equal(restored.name, "枫琴音乐中心");
    assert.equal(restored.logo, PNG);
    assert.equal(restored.contact_text, "教务老师微信：fq_edu_01");
    assert.equal(restored.version, saved.version);
    const rb = ok(await request(s, "renewal-brand", "GET", undefined, freshToken));
    assert.equal(rb.contact_text, "教务老师微信：fq_edu_01");
  }));

// 最小合法 JPEG 与 WebP 文件头（用于登录背景图测试）。
const JPEG = "data:image/jpeg;base64," + Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 255, 217]).toString("base64");
const WEBP = "data:image/webp;base64," + Buffer.from("RIFF\x1a\x00\x00\x00WEBPVP8 \x0e\x00\x00\x00\x30\x01\x00\x9d\x01\x2a\x01\x00\x01\x00\x00\x00\x00\x00", "binary").toString("base64");

test("任务 #10 登录页背景：主管上传/预览/恢复默认、公开接口版本缓存、审计脱敏、409/422/403 与全量备份往返", () =>
  withSchool(async (s) => {
    const before = ok(await request(s, "settings/institution"));
    assert.equal(before.has_login_bg, false);
    assert.equal(before.login_bg_url, null);

    // 1. 上传自定义登录背景图（WebP，也支持 JPEG/PNG，允许 180k~200KB 大图）。
    const saved = ok(
      await request(s, "settings/institution", "PATCH", {
        version: before.version,
        login_bg: WEBP,
      }),
    );
    assert.equal(saved.has_login_bg, true);
    assert.equal(saved.version, before.version + 1);
    assert.ok(saved.login_bg_url.endsWith("api/public/brand/login-bg?v=" + saved.version));
    assert.ok(!("login_bg" in saved), "institution 接口不直接下发大段 base64");

    // 2. 公开接口同步返回带版本号 login_bg_url，且图片路由强缓存返回原始二进制。
    const liteRes = await s.f.request("https://school.test/" + s.t.slug + "/api/public/brand?lite=1");
    const lite = await liteRes.json();
    assert.equal(lite.login_bg_url, saved.login_bg_url);
    const imgRes = await s.f.request("https://school.test" + saved.login_bg_url);
    assert.equal(imgRes.status, 200);
    assert.equal(imgRes.headers.get("content-type"), "image/webp");
    assert.equal(imgRes.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.deepEqual(Buffer.from(await imgRes.arrayBuffer()), Buffer.from(WEBP.split(",")[1], "base64"));
    // 旧版本号返回 404。
    assert.equal((await s.f.request("https://school.test/" + s.t.slug + "/api/public/brand/login-bg?v=" + before.version)).status, 404);

    // 3. 审计日志脱敏：不保存 base64 原文，只记状态。
    const audits = s.f.db.raw
      .prepare("SELECT before_json,after_json FROM audit_log WHERE tenant_id=? AND entity_id='institution' ORDER BY rowid")
      .all(s.t.id);
    assert.equal(audits.length, 1);
    assert.equal(JSON.parse(audits[0].before_json).login_bg, null);
    assert.equal(JSON.parse(audits[0].after_json).login_bg, "已更换");
    assert.ok(!audits[0].after_json.includes("base64") && !audits[0].after_json.includes("data:image"));

    // 4. 409 乐观锁返回最新状态含 has_login_bg/login_bg_url。
    const stale = await request(s, "settings/institution", "PATCH", { version: before.version, login_bg: JPEG });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.details.latest.has_login_bg, true);
    assert.equal(stale.body.details.latest.login_bg_url, saved.login_bg_url);

    // 5. 422 校验：非白名单格式、伪造魔数头、截断 JPEG、超 200KB 字节、超 300,000 字符。
    const over200kBytes = Buffer.alloc(200 * 1024 + 4, 0);
    over200kBytes[0] = 255;
    over200kBytes[1] = 216;
    over200kBytes[over200kBytes.length - 2] = 255;
    over200kBytes[over200kBytes.length - 1] = 217;
    const over200kJpeg = "data:image/jpeg;base64," + over200kBytes.toString("base64");
    for (const bad of [
      { login_bg: "data:image/gif;base64,R0lGODlh" },
      { login_bg: "data:image/png;base64," + Buffer.from("not-a-png").toString("base64") },
      { login_bg: "data:image/jpeg;base64," + Buffer.from([255, 216]).toString("base64") },
      { login_bg: over200kJpeg },
      { login_bg: "data:image/png;base64," + "A".repeat(300001) },
    ]) {
      assert.equal((await request(s, "settings/institution", "PATCH", { version: saved.version, ...bad })).status, 422);
    }

    // 6. 非主管 403（教务/财务可读但不可写；老师/学员读写均 403）。
    const academic = await accountToken(s, ["academic"]);
    const acRead = ok(await request(s, "settings/institution", "GET", undefined, academic.token));
    assert.equal(acRead.editable, false);
    assert.equal(acRead.has_login_bg, true);
    assert.equal(acRead.login_bg_url, saved.login_bg_url);
    assert.equal((await request(s, "settings/institution", "PATCH", { version: saved.version, login_bg: null }, academic.token)).status, 403);
    const finance = await accountToken(s, ["finance"]);
    assert.equal((await request(s, "settings/institution", "PATCH", { version: saved.version, login_bg: JPEG }, finance.token)).status, 403);
    const student = await accountToken(s, ["student"], s.students[0]);
    assert.equal((await request(s, "settings/institution", "PATCH", { version: saved.version, login_bg: JPEG }, student.token)).status, 403);

    // 7. 全量备份导出 -> 恢复默认 -> 全量备份恢复 -> 背景完整回滚。
    const exported = await request(s, "backups/export", "POST", { password: PASSWORD });
    ok(exported);
    const backupFile = JSON.parse(exported.text);

    // 恢复默认（传 null 清空）。
    const reset = ok(await request(s, "settings/institution", "PATCH", { version: saved.version, login_bg: null }));
    assert.equal(reset.has_login_bg, false);
    assert.equal(reset.login_bg_url, null);
    const liteCleared = await (await s.f.request("https://school.test/" + s.t.slug + "/api/public/brand?lite=1")).json();
    assert.equal(liteCleared.login_bg_url, null);
    assert.equal((await s.f.request("https://school.test" + saved.login_bg_url)).status, 404);

    // 执行全量恢复，确认自定义背景图与版本一同还原。
    const p = ok(await request(s, "backups/restore/preview", "POST", { password: PASSWORD, file: backupFile }), 201);
    ok(await request(s, "backups/restore/" + p.id + "/confirm", "POST", { confirm: true }));
    const sup = s.f.db.raw.prepare("SELECT * FROM users WHERE tenant_id=? AND active=1 AND roles LIKE '%supervisor%' LIMIT 1").get(s.t.id);
    const freshToken = b64(bytes(32));
    await s.r.createSession(await sha(freshToken), sup, { ip: "127.0.0.1", ua: "test" });
    const restored = ok(await request(s, "settings/institution", "GET", undefined, freshToken));
    assert.equal(restored.has_login_bg, true);
    assert.equal(restored.login_bg_url, saved.login_bg_url);
    const restoredImg = await s.f.request("https://school.test" + restored.login_bg_url);
    assert.equal(restoredImg.status, 200);
    assert.deepEqual(Buffer.from(await restoredImg.arrayBuffer()), Buffer.from(WEBP.split(",")[1], "base64"));
  }));

test("第三期设置页（fq-settings.js/.css）与登录页背景：无 HTML 注入汇、原生弹窗与禁止内联样式", async () => {
  const { readFile } = await import("node:fs/promises");
  const { tenantAssets } = await import("../scripts/frontend-bundle.mjs");
  const js = await readFile("src/tenant/fq-settings.js", "utf8");
  const yx = await readFile("src/tenant/yx.js", "utf8");
  const assets = await tenantAssets();
  assert.ok(assets.js.includes("settings/institution"));
  assert.ok(assets.css.indexOf(".fq-se") > 0 && assets.css.indexOf(".fq-se") < assets.css.lastIndexOf("/* ---------- 按钮 ---------- */"));
  assert.doesNotMatch(js, /\.innerHTML\s*=|insertAdjacentHTML|document\.write/);
  assert.ok(!/(?<![.\w])(?:alert|prompt|confirm)\(/.test(js));
  assert.doesNotMatch(yx, /\.innerHTML\s*=|\.style\.|setAttribute\(["']style["']|insertAdjacentHTML|document\.write/);
  assert.ok(!/(?<![.\w])(?:alert|prompt|confirm)\(/.test(yx));
  assert.ok(yx.includes("fq-login-bg") && yx.includes("fqLoadDeferredCss"));
  for (const route of ["settings-institution", "settings-logs", "settings-accounts", "admin-courses", "settings-data"])
    assert.ok(js.includes(route), route);
  assert.ok(js.includes('localStorage.removeItem("fq_brand_v1")'));
  assert.ok(js.includes("loginBgData"));
});

test("第三期设置未出稿三区（教务规则、AI 设置、操作记录）：统一 .fq-se-* 视觉体系、接口字段与权限禁用态完整对齐", async () => {
  const { readFile } = await import("node:fs/promises");
  const js = await readFile("src/tenant/fq-settings.js", "utf8");
  const css = await readFile("src/tenant/fq-settings.css", "utf8");

  // 静态安全与样式约束：无内联 HTML、无原生弹窗、无外链字体、动效不含 height 且有减少动态兜底。
  assert.doesNotMatch(js, /\.innerHTML\s*=|insertAdjacentHTML|document\.write/);
  assert.ok(!/(?<![.\w])(?:alert|prompt|confirm)\(/.test(js));
  assert.doesNotMatch(js + css, /fonts\.googleapis|cdn\.jsdelivr|unpkg\.com/);
  assert.doesNotMatch(css, /transition(?:-property)?:[^;]*\bheight\b/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);

  // 1. 教务规则：不再外包 c3Part("absence") / c3Part("view")，复用 .fq-se-sw，覆盖缺勤/欠课时/课表视图/续费提醒。
  const rulesBlock = js.slice(js.indexOf("// ---------- 教务规则 ----------"), js.indexOf("// ---------- AI 设置 ----------"));
  assert.doesNotMatch(rulesBlock, /c3Part\(/);
  assert.match(rulesBlock, /toggleSwitch\(/);
  for (const key of ["student_leave", "student_no_show", "teacher_leave", "cancelled"])
    assert.ok(rulesBlock.includes('"' + key + '"'), key);
  assert.match(rulesBlock, /api\("absence-policies", "PUT", \{ policies: draftAb \}\)/);
  assert.match(rulesBlock, /api\("settings", "PUT", \{ key: "max_debt_units", value: numVal \}\)/);
  assert.match(rulesBlock, /api\("settings", "PUT", \{ key: "default_schedule_view", value: v \}\)/);
  // 课表默认视图值与后端 worker.js 校验严格一致（time/teacher/location/list）。
  for (const v of ['["time", "按时间"]', '["teacher", "按教师"]', '["location", "按教室"]', '["list", "列表"]'])
    assert.ok(rulesBlock.includes(v), v);
  assert.match(rulesBlock, /api\("renewal-settings", "PUT", \{ low_balance_threshold: low, expiry_warning_days: days \}\)/);
  assert.match(rulesBlock, /disabled: !editable/);

  // 2. AI 设置：不再调用旧 yxAiUsagePage，支持 GET/PUT settings/ai（含版本冲突 409 与环境变量切换）、DEEPSEEK_API_KEY 说明与用量统计。
  const aiBlock = js.slice(js.indexOf("// ---------- AI 设置 ----------"), js.indexOf("// ---------- 数据与备份 ----------"));
  assert.doesNotMatch(aiBlock, /yxAiUsagePage\(/);
  assert.match(aiBlock, /DEEPSEEK_API_KEY/);
  assert.match(aiBlock, /api\("settings\/ai"\)/);
  assert.match(aiBlock, /api\("settings\/ai", "PUT", payload\)/);
  assert.match(aiBlock, /use_environment: useEnv/);
  assert.match(aiBlock, /e\?\.status === 409/);
  assert.match(aiBlock, /api\("ai\/usage\?date=" \+ encodeURIComponent\(usageDate\)\)/);
  assert.match(aiBlock, /fq-se-prog/);
  assert.match(aiBlock, /by_tool/);
  assert.match(aiBlock, /by_user/);

  // 3. 操作记录：不再调用旧 logsV，支持操作记录/登录记录切换、快捷动作/模块/操作人/日期/关键字筛选与抽屉明细。
  const logsBlock = js.slice(js.indexOf("// ---------- 操作记录 ----------"), js.indexOf("const RENDER = {"));
  assert.doesNotMatch(logsBlock, /logsV\(/);
  assert.match(logsBlock, /"操作记录"/);
  assert.match(logsBlock, /"登录记录"/);
  assert.match(logsBlock, /if \(logState\.kind === "audit"\) for \(const k of \["module", "action"\]\) if \(logState\[k\]\) q\.set\(k, logState\[k\]\);/);
  assert.match(logsBlock, /api\("logs\?" \+ q\)/);
  assert.match(logsBlock, /UI\.drawer\(/);
  assert.match(logsBlock, /before_json/);
  assert.match(logsBlock, /after_json/);
});

test("全站 CSS 花括号配对检查：防止未闭合 @media 吞掉后续 fq.css 登录页与卡片样式", () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const dirs = [
    path.join(root, "src/ui"),
    path.join(root, "src/tenant"),
  ];
  const files = [];
  for (const dir of dirs) {
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith(".css")) files.push(path.join(dir, name));
    }
  }
  const builtCss = path.join(root, "dist/assets/tenant.css");
  if (fs.existsSync(builtCss)) files.push(builtCss);
  assert.ok(files.length >= 10);
  for (const file of files) {
    const clean = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    let depth = 0;
    let min = 0;
    for (const ch of clean) {
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth < min) min = depth;
      }
    }
    assert.equal(depth, 0, `${path.relative(root, file)} 存在未闭合花括号 (depth=${depth})`);
    assert.equal(min, 0, `${path.relative(root, file)} 存在多余右花括号 (min=${min})`);
  }
});
