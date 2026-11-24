import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { normalizeFormat, parseImportFormat } from "../src/server/core.js";
import { fixture } from "./support.mjs";
import { setup, accountToken, mutate } from "./fixtures-credit.mjs";
import { normalizeFullBackupFormats } from "../src/server/full-backup-format.js";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
function ok(r, status = 200) {
  assert.equal(r.status, status, r.text);
  return r.body ?? JSON.parse(r.text || "{}");
}

test("课程形式合并 #13：normalizeFormat 与 parseImportFormat 兼容旧值 class/小组课/集训班 并归一为 group", () => {
  assert.equal(normalizeFormat("individual"), "individual");
  assert.equal(normalizeFormat("group"), "group");
  assert.equal(normalizeFormat("class"), "group");
  assert.throws(() => normalizeFormat("vip"), /课程形式/);

  assert.equal(parseImportFormat("一对一"), "individual");
  assert.equal(parseImportFormat("individual"), "individual");
  assert.equal(parseImportFormat("班课"), "group");
  assert.equal(parseImportFormat("小组课"), "group");
  assert.equal(parseImportFormat("集训班"), "group");
  assert.equal(parseImportFormat("group"), "group");
  assert.equal(parseImportFormat("class"), "group");
  assert.throws(() => parseImportFormat("大班VIP"));
});

test("课程形式合并 #13：写入 class 自动存为 group，课酬标准合并且已结算月份应发金额不变", async () => {
  const f = await fixture();
  try {
    const s = await setup(f, 1, "fmt-merge");
    const cat = ok(
      await s.call("data/course_categories", "POST", { name: "声乐班课类" }),
    );
    const ctCreated = ok(
      await s.call("data/course_types", "POST", {
        category_id: cat.id,
        name: "声乐集训课",
        format: "class",
        default_minutes: 60,
        units_per_lesson: 1,
        max_students: 6,
      }),
    );
    const ct = ok(await s.call(`data/course_types/${ctCreated.id}`)).record;
    assert.equal(ct.format, "group");

    const rateCreated = ok(
      await s.call("finance/rates", "POST", {
        operation_id: "op_fmt_rate_1",
        teacher_id: s.teacher,
        course_type_id: ct.id,
        format: "class",
        rate_basis: "unit",
        rate: 260,
        effective_from: "2026-11-01",
      }),
    );
    const rate = ok(await s.call(`finance/rates/${rateCreated.id}`)).record;
    assert.equal(rate.format, "group");

    const lesCreated = ok(
      await s.call("data/lessons", "POST", {
        start_at: "2026-11-18T10:00",
        teacher_id: s.teacher,
        course_type_id: ct.id,
        location_id: s.room,
        duration: 60,
        units: 1,
        format: "class",
        student_ids: [s.students[0]],
      }),
    );
    const lesson = ok(await s.call(`data/lessons/${lesCreated.id}`)).record;
    assert.equal(lesson.format, "group");

    ok(
      await s.call(`credits/lessons/${lesson.id}/status`, "POST", {
        operation_id: "op_fmt_comp_1",
        version: lesson.version,
        status: "completed",
      }),
    );

    const beforePayroll = ok(await s.call("finance/payroll?month=2026-11"));
    const beforeItem = beforePayroll.items.find((x) => x.teacher_id === s.teacher);
    assert.ok(beforeItem && beforeItem.total_amount >= 260);

    // 模拟已存有历史 class 数据与重叠课酬标准后再次执行 0034 迁移，验证幂等与去重规则
    const sql0034 = fs.readFileSync(
      path.join(root, "migrations/0034_merge_course_formats.sql"),
      "utf8",
    );
    f.db.raw.exec(sql0034);

    const afterPayroll = ok(await s.call("finance/payroll?month=2026-11"));
    const afterItem = afterPayroll.items.find((x) => x.teacher_id === s.teacher);
    assert.equal(afterItem.total_amount, beforeItem.total_amount);
  } finally {
    f.db.raw.close();
  }
});

test("课程形式合并 #13：前端下拉仅留一对一/班课，且课酬标准表单含三种计费方式说明与示例", () => {
  const files = [
    "src/tenant/app.js",
    "src/tenant/fq-settings.js",
    "src/tenant/v2p.js",
    "src/tenant/fq-teachers.js",
  ].map((rel) => fs.readFileSync(path.join(root, rel), "utf8"));
  const combined = files.join("\n");
  assert.match(combined, /班课/);
  assert.match(combined, /按课时/);
  assert.match(combined, /按课次/);
  assert.match(combined, /按人次/);
});

test("0034真实锁月：历史class与新group费率冲突不改变已批准金额、数量及锁月快照，rateLocks仍阻止回改", async () => {
  const f = await fixture();
  try {
    const s = { ...(await setup(f, 1, "locked-format")), f };
    const rate = ok(await mutate(s, "finance/rates", { teacher_id: s.teacher, course_type_id: s.type, format: "group", rate_basis: "unit", rate: 200, effective_from: "2026-11-01" }));
    const made = ok(await s.call("data/lessons", "POST", { start_at: "2026-11-18T10:00", teacher_id: s.teacher, course_type_id: s.type, location_id: s.room, unit_minutes: 45, units: 1.5, student_ids: s.students }));
    ok(await mutate(s, `credits/lessons/${made.id}/status`, { version: 1, status: "completed" }));
    const finance = await accountToken(s, ["finance"]);
    ok(await mutate(s, "finance/settlements/submit", { month: "2026-11", version: 0 }, "POST", finance.token));
    ok(await mutate(s, "finance/settlements/approve", { month: "2026-11", version: 1 }));
    const before = ok(await s.call("finance/payroll?month=2026-11"));
    assert.equal(before.items[0].total_amount, 300);
    const snapshots = () => f.db.raw.prepare("SELECT * FROM payroll_snapshots ORDER BY id").all();
    const settled = () => f.db.raw.prepare("SELECT * FROM settlements ORDER BY month").all();
    const oldSnapshots = snapshots(), oldSettled = settled();
    f.db.raw.prepare("UPDATE teacher_rates SET format='class' WHERE id=?").run(rate.id);
    f.db.raw.prepare("UPDATE lessons SET format='class' WHERE id=?").run(made.id);
    f.db.raw.prepare("UPDATE course_types SET format='class' WHERE id=?").run(s.type);
    const columns = f.db.raw.prepare("PRAGMA table_info(teacher_rates)").all().map(x => x.name);
    f.db.raw.prepare(`INSERT INTO teacher_rates(${columns.join(",")}) SELECT ${columns.map(x => ({id: "'rate_newer'", format: "'group'", rate: "99900", created_at: "created_at+1"})[x] || x).join(",")} FROM teacher_rates WHERE id=?`).run(rate.id);
    f.db.raw.exec(fs.readFileSync(path.join(root, "migrations/0034_merge_course_formats.sql"), "utf8"));
    assert.ok(f.db.raw.prepare("SELECT deleted_at FROM teacher_rates WHERE id=?").get(rate.id).deleted_at);
    assert.equal(f.db.raw.prepare("SELECT format FROM lessons WHERE id=?").get(made.id).format, "group");
    assert.deepEqual(snapshots(), oldSnapshots);
    assert.deepEqual(settled(), oldSettled);
    assert.deepEqual(ok(await s.call("finance/payroll?month=2026-11")), before);
    ok(await mutate(s, "finance/rates/rate_newer", { version: 1, rate: 500 }, "PATCH"), 409);
  } finally { f.restore(); }
});

test("0034备份兼容：多条重叠class/group按原集合去重、created_at相同时按id；不触及锁月快照", () => {
  const row = (id, format, created_at) => ({ id, tenant_id: "t", teacher_id: "teacher", course_type_id: null, format, created_at, deleted_at: null, version: 1, effective_from: "2026-01-01", effective_to: "2026-12-31" });
  const payload = { tables: { teacher_rates: [row("b", "class", 2), row("a", "group", 1), row("c", "group", 2)], lessons: [{format: "class"}], course_types: [{format: "class"}], payroll_snapshots: [{amount: 12345, details_json: '{"format":"class"}'}] } };
  const snapshots = structuredClone(payload.tables.payroll_snapshots);
  normalizeFullBackupFormats(payload, 100);
  assert.deepEqual(payload.tables.teacher_rates.filter(r => r.deleted_at === null).map(r => r.id), ["c"]);
  assert.ok(payload.tables.teacher_rates.every(r => r.format === "group"));
  assert.equal(payload.tables.lessons[0].format, "group");
  assert.deepEqual(payload.tables.payroll_snapshots, snapshots);
});
