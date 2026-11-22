// 第三期 · 设置（DECISIONS 14）：主管直接修改机构名称、Logo、联系说明。
import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support.mjs";
import { setup, request, accountToken } from "./fixtures-credit.mjs";

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

test("第三期设置：主管修改机构名称、Logo、联系说明，登录页品牌同步，写审计", () =>
  withSchool(async (s) => {
    const before = ok(await request(s, "settings/institution"));
    assert.equal(before.editable, true);
    const next = ok(
      await request(s, "settings/institution", "PATCH", {
        version: before.version,
        name: "  枫琴国际艺术  ",
        logo: PNG,
        contact_text: "咨询请加顾问微信",
      }),
    );
    assert.equal(next.name, "枫琴国际艺术");
    assert.equal(next.logo, PNG);
    assert.equal(next.contact_text, "咨询请加顾问微信");
    assert.equal(next.version, before.version + 1);
    const pub = await s.f.request("https://school.test/" + s.t.slug + "/api/public/brand?lite=1");
    const lite = await pub.json();
    assert.equal(lite.display_name, "枫琴国际艺术");
    assert.match(lite.logo, /public\/brand\/logo\?v=/);
    // 主色、二维码接口读到同一版本号，主色仍可单独修改。
    const brand = ok(await request(s, "settings/brand"));
    assert.equal(brand.version, next.version);
    assert.equal(brand.name, "枫琴国际艺术");
    const audit = s.f.db.raw
      .prepare("SELECT module,action,entity_id,summary,before_json,after_json FROM audit_log WHERE tenant_id=? AND entity_id='institution'")
      .all(s.t.id);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].module, "settings");
    assert.equal(audit[0].summary, "修改机构信息");
    assert.equal(JSON.parse(audit[0].after_json).logo, "已更换");
    assert.ok(!audit[0].after_json.includes("base64"), "审计不保存 Logo 原图");
    // 清空 Logo 与联系说明。
    const cleared = ok(await request(s, "settings/institution", "PATCH", { version: next.version, logo: null, contact_text: "" }));
    assert.equal(cleared.logo, null);
    assert.equal(cleared.contact_text, null);
    assert.equal(cleared.name, "枫琴国际艺术");
  }));

test("第三期设置：旧版本 409，非法字段与图片 422，非主管 403", () =>
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
      { logo: "data:image/png;base64," + "A".repeat(180001) },
    ])
      assert.equal((await request(s, "settings/institution", "PATCH", { version: cur.version, ...bad })).status, 422, JSON.stringify(bad).slice(0, 80));
    const academic = await accountToken(s, ["academic"]);
    const read = ok(await request(s, "settings/institution", "GET", undefined, academic.token));
    assert.equal(read.editable, false);
    assert.equal((await request(s, "settings/institution", "PATCH", { version: cur.version, name: "越权" }, academic.token)).status, 403);
    assert.equal(ok(await request(s, "settings/institution")).version, cur.version);
  }));
