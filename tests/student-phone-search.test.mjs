import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support.mjs";
import { schoolFixture } from "./fixtures-school.mjs";
import { accountToken, request } from "./fixtures-credit.mjs";
import { b64, bytes } from "../src/server/core.js";

// 第三期决定 2：学员搜索支持手机尾号（学员或家长手机，4 位以上数字，匹配末尾）。
test("学员名单：手机尾号（学员/家长）与家长称呼可搜；不足 4 位不按号码；密文不外泄；财务可用", async () => {
  const f = await fixture();
  try {
    const s = { ...(await schoolFixture(f)), f };
    const make = async (data) => {
      const res = await s.call("data/students", "POST", data);
      assert.equal(res.status, 200, res.text);
      return res.body.id;
    };
    const a = await make({ name: "孙雨桐", parent_name: "孙女士", parent_phone: "13900000008", phone: "13700002231" });
    const b = await make({ name: "何沐阳", parent_name: "何先生", parent_phone: "13600012231" });
    const c = await make({ name: "陈思语", status: "paused", parent_phone: "13800000008" });
    await make({ name: "周安" });
    const ids = async (q, status = "active") => {
      const res = await s.call("c2/students?" + new URLSearchParams({ q, status }));
      assert.equal(res.status, 200, res.text);
      assert.ok(!/phone_enc|"v1\./.test(res.text), "列表不应带出加密号码");
      return res.body.items.map((x) => x.id).sort();
    };
    assert.deepEqual(await ids("0008"), [a]);
    assert.deepEqual(await ids("0008", ""), [a, c].sort());
    assert.deepEqual(await ids("2231"), [a, b].sort());
    assert.deepEqual(await ids("02231"), [a]);
    assert.deepEqual(await ids("0001-2231"), [b]);
    assert.deepEqual(await ids("138 0000 0008", ""), [c]);
    assert.deepEqual(await ids("223"), []);
    assert.deepEqual(await ids("9999"), []);
    assert.deepEqual(await ids("何先生"), [b]);
    assert.deepEqual(await ids("雨桐"), [a]);
    assert.equal((await ids("")).length, 3);
    const finance = (await accountToken(s, ["finance"])).token;
    const res = await request(s, "c2/students?q=0008", "GET", undefined, finance);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body.items.map((x) => x.id), [a]);
  } finally {
    f.restore();
  }
});

test("尾号搜索：5000条完整匹配，5001条明确拒绝而不返回截断结果；状态过滤仍可用", async () => {
  const f = await fixture();
  try {
    const s = await schoolFixture(f);
    const made = await s.call("data/students", "POST", { name: "边界学员", phone: "13900001234" });
    assert.equal(made.status, 200, made.text);
    const columns = f.db.raw.prepare("PRAGMA table_info(students)").all().map(x => x.name);
    const clone = f.db.raw.prepare(`INSERT INTO students(${columns.join(",")}) SELECT ${columns.map(x => x === "id" ? "?" : x).join(",")} FROM students WHERE id=?`);
    for (let i = 1; i < 5000; i++) clone.run("boundary_" + i, made.body.id);
    const full = await s.call("c2/students?q=1234");
    assert.equal(full.status, 200, full.text);
    assert.equal(full.body.total, 5000);
    clone.run("boundary_last", made.body.id);
    const overflow = await s.call("c2/students?q=1234");
    assert.equal(overflow.status, 422, overflow.text);
    assert.equal(overflow.body.code, "phone_search_limit");
    const filtered = await s.call("c2/students?q=1234&status=paused");
    assert.equal(filtered.status, 200, filtered.text);
    assert.equal(filtered.body.total, 0);
    assert.equal((await s.call("c2/students?q=边界")).status, 200);
  } finally { f.restore(); }
});

test("尾号搜索：错误/损坏字段密钥和损坏密文均明确不可用，不伪装成无匹配，不泄露号码或密文", async () => {
  const f = await fixture();
  try {
    const s = await schoolFixture(f);
    const made = await s.call("data/students", "POST", { name: "密钥学员", phone: "13900001234" });
    assert.equal(made.status, 200, made.text);
    const original = f.env.FIELD_KEY;
    for (const [key, code] of [[b64(bytes(32)), "phone_search_unavailable"], ["invalid-key", "CONFIG_INVALID"]]) {
      f.env.FIELD_KEY = key;
      const res = await s.call("c2/students?q=1234");
      assert.equal(res.status, 503, res.text);
      assert.equal(res.body.code, code);
      assert.doesNotMatch(res.text, /13900001234|v1\./);
    }
    f.env.FIELD_KEY = original;
    f.db.raw.prepare("UPDATE students SET phone_enc='broken-cipher' WHERE id=?").run(made.body.id);
    const broken = await s.call("c2/students?q=1234");
    assert.equal(broken.status, 503, broken.text);
    assert.equal(broken.body.code, "phone_search_unavailable");
    assert.doesNotMatch(broken.text, /broken-cipher|13900001234/);
  } finally { f.restore(); }
});
