import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fixture } from "./support.mjs";
import {
  setup,
  accountToken,
  request,
  pack,
  lesson,
  status,
} from "./fixtures-credit.mjs";
import { rolesInput } from "../src/server/accounts.js";
import { backupTables } from "../src/server/backup-model.js";
import { schoolDatabaseContext } from "../src/server/ai-context.js";
const origin = "https://school.test",
  password = "PhaseTwoSecure9";
async function http(f, path, method = "GET", data, cookie = "", extra = {}) {
  const res = await f.directRequest(origin + path, {
    method,
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      ...extra,
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, body, text, headers: res.headers };
}
const initialize = (f) =>
  http(
    f,
    "/api/setup",
    "POST",
    { phone: "13911112222", password, name: "主管" },
    "",
    { "X-Setup-Key": f.env.SETUP_KEY },
  );
const login = (f) =>
  http(f, "/api/auth/login", "POST", { phone: "13911112222", password });
const cookie = (r) => r.headers.get("set-cookie")?.split(";")[0];
test("单机构：SETUP_KEY 校验、并发原子初始化与永久关闭；持久化自动生成ID", async () => {
  const f = await fixture({ legacyUrls: false });
  try {
    assert.equal((await http(f, "/api/setup")).body.initialized, false);
    assert.equal((await initialize({ ...f, env: {} })).status, 403);
    const results = await Promise.all([initialize(f), initialize(f)]);
    assert.deepEqual(results.map((x) => x.status).sort(), [201, 404]);
    const db = f.db.raw;
    assert.equal(db.prepare("SELECT COUNT(*) n FROM tenants").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM users").get().n, 1);
    const instance = db.prepare("SELECT * FROM app_instance").get();
    assert.ok(instance.tenant_id);
    assert.equal((await http(f, "/api/setup")).body.initialized, true);
    delete f.env.SETUP_KEY;
    assert.equal((await initialize(f)).status, 404);
    assert.equal((await login(f)).status, 200);
    assert.throws(
      () => db.exec("UPDATE app_instance SET tenant_id='other'"),
      /instance_immutable/,
    );
    assert.ok(
      !db
        .prepare("SELECT phone_enc,digest FROM users")
        .get()
        .phone_enc.includes("13911112222"),
    );
  } finally {
    f.restore();
  }
});
test("单机构：固定环境ID、统一根登录、配置不一致拒绝；无域名/slug选择或机构状态限制", async () => {
  const f = await fixture({ legacyUrls: false });
  try {
    f.env.TENANT_ID = "fengqin-fixed";
    assert.equal((await initialize(f)).status, 201);
    const r = await login(f);
    assert.equal(r.status, 200);
    assert.equal(r.body.api_base, "/api");
    assert.match(
      r.headers.get("set-cookie"),
      /__Host-fengqin_session=.*Path=\/; HttpOnly; Secure; SameSite=Strict/,
    );
    const db = f.db.raw;
    db.prepare(
      "UPDATE tenants SET status='paused',expires_at='2000-01-01',staff_seat_limit=1,student_seat_limit=1,slug='changed' WHERE id=?",
    ).run(f.env.TENANT_ID);
    assert.equal(
      (await http(f, "/api/me?tenant_id=spoof", "GET", undefined, cookie(r)))
        .status,
      200,
    );
    assert.equal((await login(f)).status, 200);
    const extraStaff=await http(f,'/api/accounts','POST',{name:'额外员工',phone:'13733334444',roles:['finance']},cookie(r));
    assert.equal(extraStaff.status,201,extraStaff.text);
    assert.equal(
      (await http(f, "/changed/api/me", "GET", undefined, cookie(r))).status,
      404,
    );
    assert.equal(
      (
        await http(
          f,
          "/api/auth/select",
          "POST",
          { tenant_id: "other" },
          cookie(r),
        )
      ).status,
      404,
    );
    f.env.TENANT_ID = "other";
    assert.equal(
      (await http(f, "/api/me", "GET", undefined, cookie(r))).status,
      503,
    );
  } finally {
    f.restore();
  }
});
test("单机构：删除平台/家长/包库接口与表，保留业务tenant_id、AI、课后点评和院校扩展点", async () => {
  const f = await fixture({ legacyUrls: false });
  try {
    await initialize(f);
    const auth = cookie(await login(f));
    for (const path of [
      "/api/platform/me",
      "/api/tenants",
      "/api/ops/overview",
      "/api/auth/select",
      "/api/parents",
      "/api/students/rec_x/guardians",
      "/api/parent/children",
      "/api/styles",
      "/api/settings/subjects",
      "/api/system-messages",
      "/console",
      "/console-assets/console.js",
    ])
      assert.equal(
        (await http(f, path, "GET", undefined, auth)).status,
        404,
        path,
      );
    for (const name of [
      "platform_admins",
      "platform_sessions",
      "platform_phone_index",
      "guardian_links",
      "login_choices",
      "tenant_domains",
      "tenant_slug_aliases",
      "tenant_export_runs",
      "tenant_purge_jobs",
      "platform_announcements",
      "subject_packs",
      "subject_pack_versions",
      "tenant_subjects",
      "style_packs",
      "style_pack_versions",
      "style_version_meta",
      "style_assets",
      "style_defaults",
      "tenant_ai_overrides",
    ]) {
      assert.equal(
        f.db.raw
          .prepare("SELECT name FROM sqlite_master WHERE name=?")
          .get(name),
        undefined,
        name,
      );
      assert.ok(!backupTables[name], name);
    }
    for (const table of [
      "students",
      "leads",
      "lesson_comments",
      "ai_requests",
      "ai_usage",
      "ai_quota_daily",
      "audit_log",
    ])
      assert.ok(
        f.db.raw
          .prepare("PRAGMA table_info(" + table + ")")
          .all()
          .some((x) => x.name === "tenant_id"),
        table,
      );
    assert.throws(() => rolesInput(["parent"]));
    assert.deepEqual(await schoolDatabaseContext({}, "school"), {
      schools: [],
      refs: {},
    });
    assert.deepEqual(f.db.raw.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    f.restore();
  }
});
test("单机构：AI环境默认值、主管内部覆盖/重置、乐观锁、审计与普通角色拒绝", async () => {
  const f = await fixture();
  try {
    const s = { ...(await setup(f, 1, "ai-settings")), f };
    f.env.AI_FAST_MODEL = "env-fast";
    f.env.AI_DEEP_MODEL = "env-deep";
    f.env.AI_FAST_DAILY_LIMIT = "3";
    f.env.DEEPSEEK_API_KEY = "never-return-this";
    const auth = "__Host-fengqin_session=" + s.token;
    const initial = await http(f, "/api/settings/ai", "GET", undefined, auth);
    assert.equal(initial.body.source, "environment");
    assert.equal(initial.body.fast_daily_limit, 3);
    const data = {
      version: initial.body.version,
      fast_model: "internal-fast",
      deep_model: "internal-deep",
      fast_daily_limit: 7,
      deep_daily_limit: 2,
    };
    const saved = await http(f, "/api/settings/ai", "PUT", data, auth);
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.body.source, "internal");
    assert.equal(saved.body.fast_model, "internal-fast");
    assert.equal(
      (await http(f, "/api/settings/ai", "PUT", data, auth)).status,
      409,
    );
    assert.equal(
      (
        await http(
          f,
          "/api/settings/ai",
          "PUT",
          { ...data, version: saved.body.version, fast_daily_limit: -1 },
          auth,
        )
      ).status,
      422,
    );
    const academic = await accountToken(s, ["academic"]);
    assert.equal(
      (
        await http(
          f,
          "/api/settings/ai",
          "GET",
          undefined,
          "__Host-fengqin_session=" + academic.token,
        )
      ).status,
      403,
    );
    const reset = await http(
      f,
      "/api/settings/ai",
      "PUT",
      { version: saved.body.version, use_environment: true },
      auth,
    );
    assert.equal(reset.body.fast_model, "env-fast");
    assert.equal(reset.body.fast_daily_limit, 3);
    assert.ok(
      !JSON.stringify([initial, saved, reset]).includes(f.env.DEEPSEEK_API_KEY),
    );
    assert.equal(
      f.db.raw
        .prepare(
          "SELECT COUNT(*) n FROM audit_log WHERE module='ai' AND action='settings'",
        )
        .get().n,
      2,
    );
  } finally {
    f.restore();
  }
});
test("单机构：员工/老师/学员统一登录，学员只读本人教务数据；缴费开关和批量读取一致", async () => {
  const f = await fixture();
  try {
    const s = { ...(await setup(f, 2, "student-readonly")), f };
    f.db.raw.prepare("UPDATE tenants SET student_seat_limit=0 WHERE id=?").run(s.t.id);
    const p = await pack(s, s.students[0], 4);
    const student = await accountToken(s, ["student"], s.students[0]);
    const user = await s.r.user(student.id),
      { decrypt } = await import("../src/server/crypto.js"),
      { newPassword } = await import("../src/server/crypto.js");
    const phone = await decrypt(f.env, user.phone_enc, s.t.id + ":phone");
    await s.r.password(
      user.id,
      user.version,
      await newPassword(f.env, password),
      s.user,
      0,
    );
    const signed = await http(f, "/api/auth/login", "POST", {
      phone,
      password,
    });
    assert.equal(signed.status, 200);
    assert.deepEqual(signed.body.user.roles, ["student"]);
    const auth = cookie(signed);
    assert.equal(
      (await http(f, "/api/credits/packages", "GET", undefined, auth)).status,
      200,
    );
    assert.equal(
      (
        await http(
          f,
          "/api/student/comments?student_id=" + s.students[1],
          "GET",
          undefined,
          auth,
        )
      ).status,
      200,
    );
    for (const [path, method, data] of [
      [
        "/api/data/students/" + s.students[0],
        "PATCH",
        { version: 1, name: "篡改" },
      ],
      ["/api/tools/leads", "POST", {}],
      ["/api/credits/payments", "POST", {}],
      ["/api/absence-policies", "PUT", {}],
    ])
      assert.equal((await http(f, path, method, data, auth)).status, 403, path);
    const batch = await http(
      f,
      "/api/read-batch",
      "POST",
      { paths: ["credits/packages", "student/comments"] },
      auth,
    );
    assert.equal(batch.status, 200); // student/comments must be in read whitelist
    await s.r.saveSetting("student_view_payments", false, s.user);
    const hidden = await http(
      f,
      "/api/credits/payments",
      "GET",
      undefined,
      auth,
    );
    assert.ok(
      hidden.status === 403 || hidden.body?.items?.length === 0,
      hidden.text,
    );
    assert.equal(
      (
        await http(
          f,
          "/api/data/students/" + s.students[1],
          "GET",
          undefined,
          auth,
        )
      ).status,
      404,
    );
    assert.equal(
      f.db.raw
        .prepare("SELECT name FROM students WHERE id=?")
        .get(s.students[0]).name,
      "学员0",
    );
  } finally {
    f.restore();
  }
});
test("单机构：登录手机号20次/IP100次基础限流，无人机验证或Access依赖", async () => {
  const f = await fixture({ legacyUrls: false });
  try {
    await initialize(f);
    for (let i = 0; i < 20; i++)
      assert.equal(
        (
          await http(f, "/api/auth/login", "POST", {
            phone: "13911112222",
            password: "incorrect",
          })
        ).status,
        401,
      );
    assert.equal((await login(f)).status, 429);
    f.db.raw.exec("DELETE FROM security_limits");
    assert.equal((await login(f)).status, 200);
    const page = await http(f, "/login");
    assert.equal(page.status, 200);
    assert.ok(
      !page.headers
        .get("content-security-policy")
        .includes("challenges.cloudflare.com"),
    );
    assert.equal(
      (await f.directRequest("https://other.test/api/setup")).status,
      404,
    );
  } finally {
    f.restore();
  }
});
test("单机构：两套实例会话不可互用，伪造tenant_id不能改变repo查询范围", async () => {
  const a = await fixture({ legacyUrls: false }),
    b = await fixture({ legacyUrls: false });
  try {
    await initialize(a);
    await initialize(b);
    const auth = cookie(await login(a));
    assert.equal(
      (await http(b, "/api/me", "GET", undefined, auth)).status,
      401,
    );
    assert.equal(
      (
        await http(
          a,
          "/api/me?tenant_id=" +
            b.db.raw.prepare("SELECT tenant_id FROM app_instance").get()
              .tenant_id,
          "GET",
          undefined,
          auth,
        )
      ).status,
      200,
    );
  } finally {
    a.restore();
    b.restore();
  }
});
test("0030：在有家长绑定与平台数据的旧结构上按外键顺序移除；业务行和点评不变", async () => {
  const { historicalDatabase } = await import("./fixtures-historical.mjs");
  const db = await historicalDatabase(29);
  try {
    db.exec(`INSERT INTO tenants(id,slug,name,type,city,status,staff_seat_limit,student_seat_limit,created_at,created_by,updated_at,updated_by) VALUES('old','old-school','旧机构','其他','','active',10,20,1,'old',1,'old');
 INSERT INTO students(tenant_id,id,name,created_at,created_by,updated_at,updated_by) VALUES('old','student','学员',1,'old',1,'old');
 INSERT INTO users(tenant_id,id,name,phone_hmac,phone_enc,phone_last4,roles,salt,digest,created_at,created_by,updated_at,updated_by) VALUES('old','parent','家长','hmac','encrypted','1111','["parent"]','salt','digest',1,'old',1,'old');
 INSERT INTO guardian_links(tenant_id,id,student_id,parent_user_id,relation,created_at,created_by,updated_at,updated_by) VALUES('old','link','student','parent','mother',1,'old',1,'old');`);
    const before = db.prepare("SELECT * FROM students").all();
    db.exec(await readFile("migrations/0030_single_tenant.sql", "utf8"));
    assert.deepEqual(db.prepare("SELECT * FROM students").all(), before);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM users").get().n, 0);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.ok(
      db
        .prepare("SELECT name FROM sqlite_master WHERE name='lesson_comments'")
        .get(),
    );
  } finally {
    db.close();
  }
});
test("单机构：备份和业务查询只使用固定tenant_id，不夹带数据库中的其他机构行", async () => {
  const f = await fixture();
  try {
    const s = { ...(await setup(f, 1, "scope")), f },
      db = f.db.raw;
    db.exec(
      "INSERT INTO tenants(id,slug,name,type,city,status,staff_seat_limit,student_seat_limit,created_at,created_by,updated_at,updated_by) VALUES('unrelated','other-school','其他','其他','','active',10,20,1,'test',1,'test');INSERT INTO students(tenant_id,id,name,created_at,created_by,updated_at,updated_by) VALUES('unrelated','unrelated-student','不应导出',1,'test',1,'test');",
    );
    const response = await request(s, "data/students?tenant_id=unrelated");
    assert.equal(response.status, 200);
    assert.ok(!response.text.includes("不应导出"));
    const { startBackup } = await import("../src/server/backup.js");
    const backup = await startBackup(f.env);
    const rows = db
      .prepare(
        "SELECT row_json FROM backup_snapshot_rows WHERE snapshot_id=? AND table_name IN('tenants','students')",
      )
      .all(backup.id);
    assert.ok(rows.length >= 2);
    assert.ok(!JSON.stringify(rows).includes("unrelated"));
  } finally {
    f.restore();
  }
});

test("学员必须先改初始密码，可撤销本人设备；老师也使用相同登录入口", async () => {
  const f = await fixture();
  try {
    const s = { ...(await setup(f, 1, "student-password")), f },
      supervisor = "__Host-fengqin_session=" + s.token;
    const created = await http(
      f,
      "/api/accounts",
      "POST",
      {
        name: "学员账号",
        phone: "13811112222",
        roles: ["student"],
        student_id: s.students[0],
      },
      supervisor,
    );
    assert.equal(created.status, 201, created.text);
    let signed = await http(f, "/api/auth/login", "POST", {
      phone: "13811112222",
      password: created.body.temporary_password,
    });
    assert.equal(signed.status, 200);
    assert.equal(signed.body.must_change, true);
    assert.equal(
      (await http(f, "/api/credits/packages", "GET", undefined, cookie(signed)))
        .status,
      403,
    );
    const changed = await http(
      f,
      "/api/password",
      "POST",
      {
        old_password: created.body.temporary_password,
        password: "StudentFresh9Z",
      },
      cookie(signed),
    );
    assert.equal(changed.status, 200, changed.text);
    assert.equal(
      (await http(f, "/api/me", "GET", undefined, cookie(signed))).status,
      401,
    );
    signed = await http(f, "/api/auth/login", "POST", {
      phone: "13811112222",
      password: "StudentFresh9Z",
    });
    assert.equal(signed.status, 200);
    const sessions = await http(
      f,
      "/api/sessions",
      "GET",
      undefined,
      cookie(signed),
    );
    assert.equal(sessions.status, 200);
    assert.equal(sessions.body.items.length, 1);
    const revoked = await http(
      f,
      "/api/sessions/" + sessions.body.items[0].id,
      "DELETE",
      {},
      cookie(signed),
    );
    assert.equal(revoked.status, 200, revoked.text);
    assert.equal(
      (await http(f, "/api/me", "GET", undefined, cookie(signed))).status,
      401,
    );
    const madeTeacher = await http(
      f,
      "/api/accounts",
      "POST",
      {
        name: "教师账号",
        phone: "13711112222",
        roles: ["teacher"],
        teacher_id: s.teacher,
      },
      supervisor,
    );
    assert.equal(madeTeacher.status, 201, madeTeacher.text);
    const teacherLogin = await http(f, "/api/auth/login", "POST", {
      phone: "13711112222",
      password: madeTeacher.body.temporary_password,
    });
    assert.equal(teacherLogin.status, 200);
    assert.deepEqual(teacherLogin.body.user.roles, ["teacher"]);
    assert.equal(teacherLogin.body.api_base, "/api");
  } finally {
    f.restore();
  }
});

test("学员缴费开关打开时只看本人记录；伪造student_id和批量查询不能绕过关闭设置", async () => {
  const f = await fixture();
  try {
    const s = { ...(await setup(f, 2, "student-payments")), f },
      person = await accountToken(s, ["student"], s.students[0]),
      auth = "__Host-fengqin_session=" + person.token;
    for (let i = 0; i < 2; i++) {
      const result = await request(s, "credits/payments", "POST", {
        operation_id: crypto.randomUUID(),
        student_id: s.students[i],
        amount: i ? 22 : 11,
        paid_at: "2026-11-12",
      });
      assert.equal(result.status, 200, result.text);
    }
    await s.r.saveSetting("student_view_payments", true, s.user);
    const shown = await http(
      f,
      "/api/credits/payments?student_id=" + s.students[1],
      "GET",
      undefined,
      auth,
    );
    assert.equal(shown.status, 200, shown.text);
    assert.equal(shown.body.items.length, 1);
    assert.equal(shown.body.items[0].student_id, s.students[0]);
    assert.equal(shown.body.items[0].amount, 11);
    assert.equal(
      (await http(f, "/api/ai/usage", "GET", undefined, auth)).status,
      403,
    );
    await s.r.saveSetting("student_view_payments", false, s.user);
    const batch = await http(
      f,
      "/api/read-batch",
      "POST",
      { paths: ["credits/payments", "credits/packages", "student/comments"] },
      auth,
    );
    assert.equal(batch.status, 200);
    assert.deepEqual(
      batch.body.results.map((x) => x.status),
      [403, 200, 200],
    );
  } finally {
    f.restore();
  }
});
