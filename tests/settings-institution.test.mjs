// 第三期 · 设置（DECISIONS 14）：主管直接修改机构名称、Logo、联系说明。
import test from "node:test";
import assert from "node:assert/strict";
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
