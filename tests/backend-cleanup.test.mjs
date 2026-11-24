import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support.mjs";
import { setup } from "./fixtures-credit.mjs";

test("清理批次1：退役的theme.css/workbench/renewals为404，替代接口和写接口保持可用", async () => {
  const f = await fixture();
  try {
    const s = await setup(f, 1, "cleanup-routes");
    for (const route of ["public/theme.css", "workbench", "renewals"]) {
      assert.equal((await s.call(route)).status, 404, route);
      const anonymous = await f.request("https://school.test/api/" + route);
      assert.equal(anonymous.status, 404, route);
      assert.equal(anonymous.headers.get("cache-control"), "no-store");
    }
    for (const route of ["public/brand?lite=1", "c2/home", "c2/renewals", "todo/inbox", "renewal-settings"])
      assert.equal((await s.call(route)).status, 200, route);
    // 仍注册并校验请求体，没有将续费写接口误删为404。
    assert.equal((await s.call("renewals/remind", "POST", {})).status, 400);
  } finally { f.restore(); }
});

test("清理批次1：下线报告权限键不从设置回显、不允许写入，历史存储和其它设置不受影响", async () => {
  const f = await fixture();
  try {
    const s = await setup(f, 1, "cleanup-settings");
    await s.r.saveSetting("teacher_can_publish_reports", true, s.user);
    const settings = await s.call("settings");
    assert.equal(settings.status, 200, settings.text);
    assert.ok(!Object.hasOwn(settings.body, "teacher_can_publish_reports"));
    const denied = await s.call("settings", "PUT", { key: "teacher_can_publish_reports", value: false });
    assert.equal(denied.status, 400, denied.text);
    assert.equal(f.db.raw.prepare("SELECT value FROM tenant_settings WHERE tenant_id=? AND id='teacher_can_publish_reports'").get(s.t.id).value, "true");
    assert.equal((await s.call("settings", "PUT", {key: "student_view_payments", value: false})).status, 200);
    assert.equal((await s.call("settings")).body.student_view_payments, false);
  } finally { f.restore(); }
});
