import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fixture } from "./support.mjs";
import { setup, request, lesson } from "./fixtures-credit.mjs";
import { backupTables, restoreTables } from "../src/server/backup-model.js";
import { PURGE_TABLES } from "../src/server/purge-schema.js";
import { modules, can } from "../src/server/permissions.js";
import {
  aiContext,
  privateSafe,
  schoolDatabaseContext,
} from "../src/server/ai-context.js";
import { startBackup } from "../src/server/backup.js";

const retired = ["referrals", "promo", "content", "plans", "growth_reports"];
const migration = await readFile("migrations/0029_remove_modules.sql", "utf8");
const dropped = [
  "referrals",
  "campaigns",
  "campaign_targets",
  "campaign_reads",
  "promo_images",
  "poster_templates",
  "poster_outputs",
  "tenant_promo_assets",
  "partner_courses",
  "partner_sessions",
  "course_applications",
  "partner_rosters",
  "partner_write_guards",
  "promo_followups",
  "promo_user_notices",
  "plans",
  "plan_contexts",
  "plan_revisions",
  "plan_elements",
  "share_links",
  "content_items",
  "content_revisions",
  "growth_batches",
  "growth_reports",
  "growth_report_revisions",
  "growth_notifications",
  "plan_prospects",
  "plan_templates",
  "plan_sample_templates",
  "plan_reference_flags",
  "plan_briefs",
  "plan_v2_conversions",
  "plan_v2_elements",
];

test("0029 在外键开启且存在方案/推广子记录时删除模块，保留线索、课次、AI 与审计", async () => {
  const f = await fixture({ migrateRemoval: false });
  try {
    const s = await setup(f, 1, "remove-migration"),
      db = f.db.raw,
      at = Date.now();
    const insert = (table, row) => {
      const columns = Object.keys(row);
      db.prepare(
        `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
      ).run(...Object.values(row));
    };
    const stamps = {
      created_at: at,
      created_by: s.user.id,
      updated_at: at,
      updated_by: s.user.id,
    };
    const scoped = { tenant_id: s.t.id };
    insert("leads", {
      ...scoped,
      id: "lead_keep",
      name: "保留线索",
      stage: "new",
      ...stamps,
    });
    insert("plans", {
      ...scoped,
      id: "plan_drop",
      student_id: s.students[0],
      subject: "music_interest",
      title: "待删方案",
      doc_json: "{}",
      context_id: "context_drop",
      manifest_json: "{}",
      ...stamps,
    });
    insert("plan_contexts", {
      ...scoped,
      id: "context_drop",
      plan_id: "plan_drop",
      doc_json: "{}",
      created_at: at,
    });
    insert("plan_revisions", {
      ...scoped,
      id: "revision_drop",
      plan_id: "plan_drop",
      seq: 1,
      student_id: s.students[0],
      doc_json: "{}",
      context_id: "context_drop",
      manifest_json: "{}",
      image_ids_json: "[]",
      action: "save",
      created_at: at,
      created_by: s.user.id,
    });
    insert("share_links", {
      ...scoped,
      id: "share_drop",
      plan_id: "plan_drop",
      revision_id: "revision_drop",
      token_hash: "drop-hash",
      expires_at: at + 1000,
      created_at: at,
      created_by: s.user.id,
    });
    insert("plan_reference_flags", {
      ...scoped,
      plan_id: "plan_drop",
      revision_id: "revision_drop",
      updated_at: at,
      updated_by: s.user.id,
    });
    insert("campaigns", {
      id: "campaign_drop",
      type: "course",
      title: "待删推广",
      publish_at: at,
      status: "draft",
      audience: "all",
      created_at: at,
      updated_at: at,
    });
    insert("partner_courses", {
      id: "course_drop",
      campaign_id: "campaign_drop",
      lecturer: "合作讲师",
      min_size: 1,
      apply_deadline: at,
      status: "recruiting",
    });
    insert("partner_sessions", {
      id: "session_drop",
      course_id: "course_drop",
      start_at: "2026-11-18T10:00:00+08:00",
      duration: 45,
    });
    insert("partner_rosters", {
      ...scoped,
      id: "roster_drop",
      course_id: "course_drop",
      student_id: s.students[0],
      created_at: at,
    });
    const partnerLesson = await lesson({ ...s, f }, "2026-11-18T10:00");
    insert("partner_write_guards", { ...scoped, id: "migration-guard" });
    db.prepare(
      "UPDATE lessons SET source_course_id='course_drop',source_session_id='session_drop' WHERE tenant_id=? AND id=?",
    ).run(s.t.id, partnerLesson);
    db.prepare("DELETE FROM partner_write_guards WHERE tenant_id=?").run(
      s.t.id,
    );
    insert("ai_quota_daily", {
      ...scoped,
      id: "keep:fast",
      date: "2026-11-18",
      tier: "fast",
      used: 3,
    });
    for (const id of retired)
      insert("tenant_modules", { ...scoped, id, enabled: 1, ...stamps });
    insert("tenant_role_rights", {
      ...scoped,
      id: "retired-right",
      role: "academic",
      module: "referrals",
      action: "read",
      allowed: 1,
      ...stamps,
    });
    const preserved = [
      "students",
      "teachers",
      "lessons",
      "leads",
      "ai_settings",
      "ai_quota_daily",
      "audit_log",
      "sessions",
    ];
    const before = Object.fromEntries(
      preserved.map((t) => [t, db.prepare("SELECT * FROM " + t).all()]),
    );
    assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
    // D1 emulator TEMP triggers capture the old column list; rebuild these after the schema change.
    db.exec(
      "DROP TRIGGER IF EXISTS temp.__d1_lessonsINSERT; DROP TRIGGER IF EXISTS temp.__d1_lessonsUPDATE;",
    );
    for (const row of before.lessons) {
      delete row.source_course_id;
      delete row.source_session_id;
    }
    db.exec("BEGIN");
    try {
      db.exec(migration);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    f.db.limits.installRows();
    for (const t of dropped)
      assert.equal(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
          )
          .get(t),
        undefined,
        t,
      );
    for (const t of preserved)
      assert.deepEqual(db.prepare("SELECT * FROM " + t).all(), before[t], t);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.ok(
      !db
        .prepare("PRAGMA foreign_key_list(lessons)")
        .all()
        .some((x) => dropped.includes(x.table)),
    );
    assert.ok(
      !db
        .prepare("PRAGMA table_info(lessons)")
        .all()
        .some((x) => /^source_(course|session)_id$/.test(x.name)),
    );
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) n FROM tenant_role_rights WHERE module='referrals'",
        )
        .get().n,
      0,
    );
  } finally {
    f.restore();
  }
});

test("退休接口拒绝访问且不调用 AI，线索仍能原子转为学员", async () => {
  const f = await fixture();
  try {
    const s = { ...(await setup(f, 1, "remove-routes")), f };
    let calls = 0;
    f.env.AI_PROVIDER = async () => {
      calls++;
      throw Error("retired tool reached provider");
    };
    for (const [path, method] of [
      ["tools/referrals", "GET"],
      ["tools/referrals", "POST"],
      ["promo", "GET"],
      ["promo/recommend", "GET"],
      ["promo/images", "POST"],
      ["content", "POST"],
      ["content/scenes", "GET"],
      ["plans", "GET"],
      ["plans", "POST"],
      ["plans/removed/convert-student", "POST"],
      ["plans/removed/brief", "PUT"],
      ["plans/removed/reference", "PUT"],
      ["plan-templates", "GET"],
      ["plan-templates", "POST"],
      ["reports/removed", "GET"],
      ["report-batches", "POST"],
      ["parent/plans/removed", "GET"],
      ["parent/reports/removed", "GET"],
      ["ai/plan/brief", "POST"],
      ["ai/content/versions", "POST"],
      ["ai/report/draft", "POST"],
      ["ai/report/batch-draft", "POST"],
    ])
      assert.equal(
        (await request(s, path, method, method === "GET" ? undefined : {}))
          .status,
        404,
        path,
      );
    for (const path of [
      "/s/removed",
      "/api/share/removed",
      "/api/share/removed/media/image",
    ])
      assert.equal(
        (await f.request("https://school.test" + path)).status,
        404,
        path,
      );
    assert.equal(calls, 0);
    const teachers = await request(s, "c3/teachers?from=2026-11-16&to=2026-11-23");
    assert.equal(teachers.status, 200, teachers.text);
    assert.ok(teachers.body.items.some(row => row.id === s.teacher));
    const lead = await request(s, "tools/leads", "POST", {
      name: "可转学员",
      phone: "13912341234",
      stage: "new",
    });
    assert.equal(lead.status, 200, lead.text);
    const detail = await request(s, "tools/leads/" + lead.body.id);
    const converted = await request(
      s,
      "tools/leads/" + lead.body.id + "/convert",
      "POST",
      { version: detail.body.record.version },
    );
    assert.equal(converted.status, 200, converted.text);
    assert.ok(
      f.db.raw
        .prepare("SELECT id FROM students WHERE tenant_id=? AND id=?")
        .get(s.t.id, converted.body.student_id),
    );
    assert.equal(
      f.db.raw
        .prepare("SELECT stage FROM leads WHERE tenant_id=? AND id=?")
        .get(s.t.id, lead.body.id).stage,
      "enrolled",
    );
    assert.equal(
      (
        await request(s, "tools/leads/" + lead.body.id + "/convert", "POST", {
          version: detail.body.record.version,
        })
      ).status,
      409,
    );
  } finally {
    f.restore();
  }
});

test("备份和清理不再枚举已删表，完整快照仍覆盖 AI 与教学反馈", async () => {
  const f = await fixture();
  try {
    const s = await setup(f, 1, "remove-backup");
    for (const name of dropped) {
      assert.ok(!backupTables[name], name);
      assert.ok(!restoreTables.includes(name), name);
      assert.ok(!PURGE_TABLES.includes(name), name);
    }
    for (const name of [
      "ai_settings",
      "ai_requests",
      "ai_quota_holds",
      "ai_quota_daily",
      "ai_usage",
      "ai_suggestions",
      "leads",
      "lesson_submissions",
      "lesson_comments",
      "growth_feedback_copies",
      "growth_repertoire",
    ])
      assert.ok(backupTables[name], name);
    const at = Date.now();
    await startBackup(f.env, at);
    assert.ok(
      f.db.raw
        .prepare(
          "SELECT row_json FROM backup_snapshot_rows WHERE table_name='ai_settings'",
        )
        .get(),
    );
    const names = f.db.raw
      .prepare("SELECT DISTINCT table_name FROM backup_snapshot_rows")
      .all()
      .map((x) => x.table_name);
    assert.ok(!names.some((x) => dropped.includes(x)));
    assert.equal((await request({ ...s, f }, "me")).status, 200);
  } finally {
    f.restore();
  }
});

test("权限移除业务模块，AI 上下文只采集服务端资料并提供院校数据库扩展点", async () => {
  const f = await fixture();
  try {
    const s = await setup(f, 1, "remove-context"),
      policy = await s.r.policy();
    for (const name of [...retired, "plan_templates", "plan_references"]) {
      assert.ok(!modules.includes(name));
      assert.equal(can({ roles: ["supervisor"] }, policy, name, "read"), false);
    }
    const ctx = await aiContext(
      s.r,
      "settings",
      "propose",
      {
        instruction: "电话13912341234",
        schools: [{ name: "伪造院校" }],
        courses: [{ name: "伪造课程" }],
      },
      s.user,
      policy,
    );
    assert.ok(!JSON.stringify(ctx.public).includes("伪造"));
    assert.ok(!ctx.instruction.includes("13912341234"));
    assert.deepEqual(await schoolDatabaseContext(s.r, {}, s.user), {
      schools: [],
      refs: {},
    });
    assert.deepEqual(
      privateSafe(
        { phone: "secret", name: "张三", text: "张三 13912341234" },
        { name: "张三", nickname: "张同学" },
      ),
      { name: "张同学", text: "张同学 [手机号已隐去]" },
    );
  } finally {
    f.restore();
  }
});
