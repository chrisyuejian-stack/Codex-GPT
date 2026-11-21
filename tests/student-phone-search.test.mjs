import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support.mjs";
import { schoolFixture } from "./fixtures-school.mjs";
import { accountToken, request } from "./fixtures-credit.mjs";

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
