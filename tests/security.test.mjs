import {readFile,readdir} from 'node:fs/promises';
import { test } from "node:test";
import assert from "node:assert/strict";

import { fixture } from "./support.mjs";
import worker from "../src/server/worker.js";
import { repo } from "../src/server/repo.js";
import {encrypt,decrypt,phoneIndex,newPassword,digestPassword,weakPasswordCount,validatePassword} from "../src/server/crypto.js";
import { can, modules, projectRecord } from "../src/server/permissions.js";
import { sha, b64, bytes } from "../src/server/core.js";
const tenant = {
  id: "ten_111111111111111111111111",
  slug: "test-school",
  name: "测试机构",
  type: "其他",
  city: "",
  expires_at: null,
  staff_seat_limit: 10,
  student_seat_limit: 10,
  contact_enc: null,
};
async function tenantFixture(f) {
  f.env.TENANT_ID=tenant.id;
  const res=await f.directRequest('https://school.test/api/setup',{method:'POST',headers:{Origin:'https://school.test','Content-Type':'application/json','X-Setup-Key':f.env.SETUP_KEY},body:JSON.stringify({phone:'13900000000',password:'SecureSetup9Z',name:'主管'})});
  assert.equal(res.status,201,await res.text());f.instances.set('test-school',f);
  return repo(f.env, tenant.id);
}
async function accountFixture(f, r) {
  const pw = await newPassword(f.env, "SecureAccount9Z");
  const u = {
    id: "usr_111111111111111111111111",
    name: "验收员工",
    roles: '["academic"]',
    phone_hmac: await phoneIndex(f.env, tenant.id, "13912345678"),
    phone_enc: await encrypt(f.env, "13912345678", tenant.id + ":phone"),
    phone_last4: "5678",
    ...pw,
  };
  await r.createUser(u, { id: "fixture", name: "系统维护" });
  return { ...u, version: 1, active: 1 };
}
test("字段加密使用随机 IV、绑定机构上下文；HMAC 隔离；密码独立盐和弱密码库", async () => {
  const f = await fixture();
  try {
    const a = await encrypt(f.env, "13912345678", "a:phone"),
      b = await encrypt(f.env, "13912345678", "a:phone");
    assert.notEqual(a, b);
    assert.ok(!a.includes("13912345678"));
    assert.equal(await decrypt(f.env, a, "a:phone"), "13912345678");
    await assert.rejects(() => decrypt(f.env, a, "b:phone"));
    assert.notEqual(
      await phoneIndex(f.env, "a", "13912345678"),
      await phoneIndex(f.env, "b", "13912345678"),
    );
    const p = await newPassword(f.env, "SecureAccount9Z"),
      q = await newPassword(f.env, "SecureAccount9Z");
    assert.notEqual(p.salt, q.salt);
    assert.equal(
      p.digest,
      await digestPassword(f.env, "SecureAccount9Z", p.salt),
    );
    assert.ok(weakPasswordCount >= 1000);
    assert.throws(() => validatePassword("a123456789"));
    assert.throws(() => validatePassword("hello12345678", "13912345678"));
  } finally {
    f.restore();
  }
});
test("所有必需 Secret 缺失均拒绝服务，客户端无堆栈或 SQL", async () => {
  const f = await fixture();
  try {
    for (const key of [
      "FIELD_KEY",
      "HMAC_KEY",
      "PW_PEPPER",
      "BACKUP_KEY",
    ]) {
      const env = { ...f.env };
      delete env[key];
      const res = await worker.fetch(new Request("https://school.test/"), env);
      assert.equal(res.status, 503);
      const body = await res.text();
      assert.ok(!/SELECT |stack|Error:/.test(body));
    }
  } finally {
    f.restore();
  }
});
test("三层权限、个人归属、金额裁剪和教务默认配置", () => {
  const p = {
      modules: Object.fromEntries(modules.map((m) => [m, true])),
      settings: { student_view_balance: true, student_view_payments: false },
      rights: [],
    },
    academic = { roles: ["academic"] },
    teacher = { roles: ["teacher"], teacher_id: "t1" },
    student = { roles: ["student"], student_id: "s1" };
  assert.equal(can(academic, p, "tuition", "read"), false);
  assert.equal(can(academic, p, "settings", "create"), false);
  assert.equal(can(teacher, p, "lessons", "read", { teacher_id: "t2" }), false);
  assert.equal(
    can(teacher, p, "lessons", "read", { assistant_id: "t1" }),
    true,
  );
  assert.equal(can(student, p, "tuition", "read", { student_id: "s1" }), false);
  assert.equal(can(student, p, "lessons", "read", { student_id: "s2" }), false);
  assert.equal(
    can(
      { roles: ["supervisor"] },
      { ...p, modules: { accounts: false } },
      "accounts",
      "read",
    ),
    false,
  );
  assert.deepEqual(
    projectRecord(academic, p, "packages", {
      id: "x",
      unit_price: 123,
      amount: 100,
      units: 5,
    }),
    { id: "x", units: 5 },
  );
  p.rights.push({
    role: "academic",
    module: "settings",
    action: "create",
    allowed: 1,
  });
  assert.equal(can(academic, p, "settings", "create"), true);
});
test("账号变更/密码变更撤销会话，乐观锁拒绝覆盖，审计只增不改", async () => {
  const f = await fixture();
  try {
    const r = await tenantFixture(f),
      u = await accountFixture(f, r),
      hash = await sha("fixture-token");
    await r.createSession(hash, u, { ip: "test", ua: "test" });
    assert.ok(await r.session(hash));
    await r.updateUser(
      u.id,
      1,
      { name: "更名", roles: '["finance"]', active: 1 },
      { id: "actor", name: "主管" },
    );
    assert.equal(await r.session(hash), null);
    await assert.rejects(
      () =>
        r.updateUser(
          u.id,
          1,
          { name: "覆盖", roles: '["academic"]', active: 1 },
          { id: "actor", name: "主管" },
        ),
      (e) => e.status === 409,
    );
    assert.equal((await r.user(u.id)).name, "更名");
    const next = await r.user(u.id);
    await r.createSession(hash, next, { ip: "test", ua: "test" });
    await r.password(
      u.id,
      next.version,
      await newPassword(f.env, "Different9Pass"),
      { id: "actor", name: "主管" },
    );
    assert.equal(await r.session(hash), null);
    assert.throws(() => f.db.raw.exec("DELETE FROM audit_log"));
    assert.throws(() =>
      f.db.raw.exec("UPDATE audit_log SET summary='tampered'"),
    );
    const rows = await r.logs("audit", 0);
    assert.equal(rows.length, 4);
  } finally {
    f.restore();
  }
});

test("员工闲置/绝对时限、个人会话时限、Cookie 安全属性和非法会话", async () => {
  const f = await fixture();
  try {
    const r = await tenantFixture(f),
      u = await accountFixture(f, r),
      hash = await sha("session");
    await r.createSession(hash, u, { ip: "x", ua: "x" });
    const session = await r.session(hash);
    assert.equal(session.idle_ms, 7200000);
    f.db.raw
      .prepare("UPDATE sessions SET last_seen_at=?")
      .run(Date.now() - 7200001);
    const res = await f.request("https://school.test/test-school/api/me", {
      headers: { Cookie: "channel_session=session" },
    });
    assert.equal(res.status, 401);
    assert.match(
      res.headers.get("set-cookie"),
      /Path=\/; HttpOnly; Secure; SameSite=Strict/,
    );
    const personal = { ...u, roles: '["teacher"]' };
    await r.createSession("personal", personal, { ip: "x", ua: "x" });
    const row = await r.session("personal");
    assert.equal(row.idle_ms, null);
    assert.ok(row.expires_at - Date.now() > 13 * 86400000);
  } finally {
    f.restore();
  }
});

test("请求上限、图片真实格式、保留路由和非登录 CSP", async () => {
  const f = await fixture();
  try {
    await tenantFixture(f);
    const headers = {
      Origin: "https://school.test",
      "Content-Type": "application/json",
    };
    let r = await f.request("https://school.test/test-school/api/login", {
      method: "POST",
      headers,
      body: JSON.stringify({ x: "x".repeat(1048576) }),
    });
    assert.equal(r.status, 413);
    for (const slug of ["admin", "api", "app", "CONSOLE", "ab", "-abc"])
      assert.equal(
        (await f.request("https://school.test/" + slug + "/login")).status,
        404,
      );
    r = await f.request("https://school.test/test-school/login");
    assert.equal(r.status, 200);
    assert.match(
      r.headers.get("content-security-policy"),
      /script-src 'self'/,
    );

  } finally {
    f.restore();
  }
});

test("密码哈希计算期间账号已变更，旧凭据不能建立新会话", async () => {
  const f = await fixture();
  try {
    const r = await tenantFixture(f),
      u = await accountFixture(f, r);
    await r.password(u.id, 1, await newPassword(f.env, "ChangedPassword9Z"), {
      id: "fixture",
      name: "主管",
    });
    await assert.rejects(
      () => r.createSession("stale", u, { ip: "x", ua: "x" }, 1),
      (e) => e.status === 401,
    );
  } finally {
    f.restore();
  }
});

test("审查回归：历史 accounts 授权不能完成教务提权、改角色或接管财务的完整攻击链", async () => {
  const f = await fixture();
  try {
    const r = await tenantFixture(f),
      academic = await accountFixture(f, r);
    const finance = {
      ...academic,
      id: "usr_222222222222222222222222",
      phone_hmac: "finance-index",
      roles: '["finance"]',
    };
    const supervisor = {
      ...academic,
      id: "usr_333333333333333333333333",
      phone_hmac: "supervisor-index",
      roles: '["supervisor"]',
    };
    const personal = {
      ...academic,
      id: "usr_444444444444444444444444",
      phone_hmac: "personal-index",
      roles: '["student"]',
    };
    for (const u of [finance, supervisor, personal])
      await r.createUser(u, { id: "fixture", name: "主管" });
    for (const action of [
      "read",
      "update",
      "create",
      "reset_staff",
      "manage_rights",
      "manage_settings",
      "reveal_phone",
    ])
      await r.saveRights("academic", "accounts", action, true, {
        id: supervisor.id,
        name: "主管",
      });
    f.db.raw.prepare("UPDATE users SET must_change=0").run();
    const token = b64(bytes(32));
    await r.createSession(await sha(token), academic, {
      ip: "x",
      ua: "regression",
    });
    const send = async (path, method, data, cookie = token) => {
      const response = await f.request(
        "https://school.test/test-school/api/" + path,
        {
          method,
          headers: {
            Origin: "https://school.test",
            Cookie: "channel_session=" + cookie,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(data),
        },
      );
      const text = await response.text();
      return { status: response.status, text };
    };
    const before = await r.user(finance.id);
    for (const module of ["tuition", "accounts"])
      assert.equal(
        (
          await send("rights", "PUT", {
            role: "academic",
            module,
            action: "read",
            allowed: true,
          })
        ).status,
        403,
      );
    assert.equal(
      (
        await send("settings", "PUT", {
          key: "student_view_payments",
          value: true,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await send("accounts/" + academic.id, "PATCH", {
          name: "攻击",
          roles: ["academic", "finance"],
          active: true,
          version: 1,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await send("accounts/" + finance.id, "PATCH", {
          name: "攻击",
          roles: ["academic"],
          active: false,
          version: 1,
        })
      ).status,
      403,
    );
    const reset = await send(
      "accounts/" + finance.id + "/reset-password",
      "POST",
      {},
    );
    assert.equal(reset.status, 403);
    assert.ok(!reset.text.includes("temporary_password"));
    assert.equal(
      (await send("accounts/" + finance.id + "/phone", "POST", {})).status,
      403,
    );
    assert.equal(
      (
        await send("accounts", "POST", {
          name: "攻击",
          phone: "13900000888",
          roles: ["finance"],
        })
      ).status,
      403,
    );
    assert.equal((await r.user(finance.id)).digest, before.digest);
    assert.equal((await r.user(finance.id)).active, 1);
    assert.equal((await r.user(academic.id)).roles, '["academic"]');
    // 教务个人账号重置不依赖 accounts.read，且不能借此作用于员工。
    assert.equal(
      (await send("accounts/" + personal.id + "/reset-password", "POST", {}))
        .status,
      200,
    );
    await r.saveSetting("academic_can_reset_accounts", false, {
      id: supervisor.id,
      name: "主管",
    });
    assert.equal(
      (await send("accounts/" + personal.id + "/reset-password", "POST", {}))
        .status,
      403,
    );
    await r.saveSetting("academic_can_create_accounts", false, {
      id: supervisor.id,
      name: "主管",
    });
    assert.equal(
      (
        await send("accounts", "POST", {
          name: "个人",
          phone: "13900000889",
          roles: ["student"],
        })
      ).status,
      403,
    );
    const supToken = b64(bytes(32));
    await r.createSession(await sha(supToken), supervisor, {
      ip: "x",
      ua: "regression",
    });
    assert.equal(
      (
        await send(
          "accounts/" + supervisor.id,
          "PATCH",
          { name: "主管", roles: ["finance"], active: false, version: 1 },
          supToken,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await send(
          "rights",
          "PUT",
          {
            role: "academic",
            module: "accounts",
            action: "update",
            allowed: true,
          },
          supToken,
        )
      ).status,
      400,
    );
  } finally {
    f.restore();
  }
});
test("审查回归：学费和课酬按领域递归独立裁剪", () => {
  const user = { roles: ["academic"] },
    p = {
      modules: Object.fromEntries(modules.map((m) => [m, true])),
      settings: {},
      rights: [
        { role: "academic", module: "tuition", action: "read", allowed: 1 },
      ],
    };
  const record = {
    rate: 12,
    id: "x",
    amount: 200,
    unit_price: 20,
    teacherCost: 30,
    overrideRate: 40,
    details: [{ tuition_amount: 50, teacher_fee: 60 }],
    teacher_pay: { amount: 70, rate: 80 },
    tuition: { amount: 90 },
  };
  let result = projectRecord(user, p, "packages", record);
  assert.equal(result.amount, 200);
  assert.equal(result.unit_price, 20);
  assert.ok(!("rate" in result));
  assert.ok(!("teacherCost" in result));
  assert.ok(!("overrideRate" in result));
  assert.deepEqual(result.teacher_pay, {});
  assert.deepEqual(result.details, [{ tuition_amount: 50 }]);
  p.rights = [
    { role: "academic", module: "teacher_pay", action: "read", allowed: 1 },
  ];
  result = projectRecord(user, p, "packages", record);
  assert.ok(!("amount" in result));
  assert.ok(!("unit_price" in result));
  assert.equal(result.teacherCost, 30);
  assert.equal(result.rate, 12);
  assert.deepEqual(result.tuition, {});
  assert.equal(result.teacher_pay.amount, 70);
  p.rights = [];
  result = projectRecord(user, p, "packages", record);
  assert.deepEqual(result.details, [{}]);
  assert.equal(record.teacherCost, 30);
});
test("审查回归：机构字段未变或停用均保留会话；财务日志 SQL 分页前过滤", async () => {
  const f = await fixture();
  try {
    const r = await tenantFixture(f),
      u = await accountFixture(f, r),
      hash = await sha("retained");
    await r.createSession(hash, u, { ip: "x", ua: "x" });
    f.db.raw.prepare("UPDATE tenants SET name='改名',status='active' WHERE id=?").run(tenant.id);
    assert.ok(await r.session(hash));
    f.db.raw.prepare("UPDATE tenants SET status='paused',expires_at='2000-01-01',slug='changed-school' WHERE id=?").run(tenant.id);
    assert.ok(await r.session(hash));
    for (const module of [
      "accounts",
      "students",
      "tuition",
      "teacher_pay",
      "settlements",
    ])
      await r.audit({ id: u.id, name: "员工" }, module, "test", "x", module);
    const fin = {
      ...u,
      id: "usr_555555555555555555555555",
      phone_hmac: "fin",
      roles: '["finance"]',
    };
    await r.createUser(fin, { id: "fixture", name: "主管" });
    f.db.raw.prepare("UPDATE tenants SET status='active'").run();
    f.db.raw.prepare("UPDATE users SET must_change=0").run();
    const token = b64(bytes(32));
    await r.createSession(await sha(token), fin, { ip: "x", ua: "x" });
    const send = (path) =>
      f.request("https://school.test/test-school/api/" + path, {
        headers: { Cookie: "channel_session=" + token },
      });
    let response = await send("logs");
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.deepEqual(data.items.map((x) => x.module).sort(), [
      "settlements",
      "teacher_pay",
      "tuition",
    ]);
    response = await send("logs?kind=login");
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).items, []);
  } finally {
    f.restore();
  }
});

test("SQL集中在repo，前端源码无HTML注入汇",async()=>{
  for (const name of await readdir("src/server"))
    if (name !== "repo.js") {
      const content = await readFile("src/server/" + name, "utf8");
      assert.ok(
        !/\b(?:SELECT .+ FROM|INSERT INTO|UPDATE \w+ SET|DELETE FROM)\b/.test(
          content,
        ),
        name,
      );
    }
  for (const dir of ["src/tenant", "src/console"])
    for (const name of (await readdir(dir)).filter((n) =>
      /\.(js|html|css)$/.test(n),
    )) {
      const content = await readFile(dir + "/" + name, "utf8");
      assert.ok(
        !/innerHTML|unsafe-inline|unsafe-eval|onclick=/.test(content),
        dir + "/" + name,
      );
    }
});