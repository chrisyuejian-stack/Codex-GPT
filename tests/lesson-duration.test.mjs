import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./support.mjs";
import { setup } from "./fixtures-credit.mjs";

function ok(r, status = 200) {
  assert.equal(r.status, status, r.text);
  return r.body ?? JSON.parse(r.text || "{}");
}

test("排课总时长 #16：45分钟×2课时=90分钟占用并触发后半段冲突；0.5×45=23；非0.5倍数422拒绝；固定排课与课酬回归", async () => {
  const f = await fixture();
  try {
    const s = await setup(f, 2, "dur-16");

    // 1. 45分钟 × 2课时 = 90分钟（09:00–10:30）
    const l1Created = ok(
      await s.call("data/lessons", "POST", {
        start_at: "2026-11-18T09:00",
        teacher_id: s.teacher,
        course_type_id: s.type,
        location_id: s.room,
        unit_minutes: 45,
        units: 2,
        student_ids: [s.students[0]],
      }),
    );
    const l1 = ok(await s.call(`data/lessons/${l1Created.id}`)).record;
    assert.equal(l1.unit_minutes, 45);
    assert.equal(l1.units, 2);
    assert.equal(l1.duration, 90);

    // 2. 09:45 在 09:00–10:30 内必须报教师/教室冲突（committed: false）
    const conflict = ok(
      await s.call("data/lessons", "POST", {
        start_at: "2026-11-18T09:45",
        teacher_id: s.teacher,
        course_type_id: s.type,
        location_id: s.room,
        unit_minutes: 45,
        units: 1,
        student_ids: [s.students[1]],
      }),
    );
    assert.equal(conflict.committed, false);
    assert.ok(Array.isArray(conflict.conflicts) && conflict.conflicts.length >= 1);

    // 3. 10:30 紧接其后不冲突，且 0.5 × 45 = 23 分钟（四舍五入默认方案）
    const l2Created = ok(
      await s.call("data/lessons", "POST", {
        start_at: "2026-11-18T10:30",
        teacher_id: s.teacher,
        course_type_id: s.type,
        location_id: s.room,
        unit_minutes: 45,
        units: 0.5,
        student_ids: [s.students[1]],
      }),
    );
    const l2 = ok(await s.call(`data/lessons/${l2Created.id}`)).record;
    assert.equal(l2.unit_minutes, 45);
    assert.equal(l2.units, 0.5);
    assert.equal(l2.duration, 23);

    // 4. 非 0.5 倍数被 422 拒绝
    for (const badUnits of [0.3, 1.01, 0.25, 0]) {
      const bad = await s.call("data/lessons", "POST", {
        start_at: "2026-11-18T14:00",
        teacher_id: s.teacher,
        course_type_id: s.type,
        location_id: s.room,
        unit_minutes: 60,
        units: badUnits,
        student_ids: [s.students[0]],
      });
      assert.equal(bad.status, 422);
    }

    // 5. 编辑回显与修改课时数（1.5 × 60 = 90）
    ok(
      await s.call(`data/lessons/${l1.id}`, "PATCH", {
        version: l1.version,
        start_at: l1.start_at,
        teacher_id: l1.teacher_id,
        course_type_id: l1.course_type_id,
        location_id: l1.location_id,
        unit_minutes: 60,
        units: 1.5,
        student_ids: [s.students[0]],
      }),
    );
    const updated = ok(await s.call(`data/lessons/${l1.id}`)).record;
    assert.equal(updated.unit_minutes, 60);
    assert.equal(updated.units, 1.5);
    assert.equal(updated.duration, 90);

    // 6. 固定排课模板与批量生成：45 × 2 = 90
    const tplCreated = ok(
      await s.call("data/schedule_templates", "POST", {
        course_type_id: s.type,
        teacher_id: s.teacher,
        location_id: s.room,
        weekday: 4,
        start_time: "15:00",
        unit_minutes: 45,
        units: 2,
        date_from: "2026-11-01",
        date_to: "2026-12-31",
      }),
    );
    const tpl = ok(await s.call(`data/schedule_templates/${tplCreated.id}`)).record;
    assert.equal(tpl.unit_minutes, 45);
    assert.equal(tpl.units, 2);
    assert.equal(tpl.duration, 90);

    // 7. 课酬按课时仍按 units 计算（1.5 课时 × 200 = 300）
    ok(
      await s.call("finance/rates", "POST", {
        operation_id: "op_dur_rate_1",
        teacher_id: s.teacher,
        course_type_id: s.type,
        rate_basis: "unit",
        rate: 200,
        effective_from: "2026-11-01",
      }),
    );
    ok(
      await s.call(`credits/lessons/${updated.id}/status`, "POST", {
        operation_id: "op_dur_comp_1",
        version: updated.version,
        status: "completed",
      }),
    );
    const payroll = ok(await s.call("finance/payroll?month=2026-11"));
    const item = payroll.items.find((x) => x.teacher_id === s.teacher);
    assert.equal(item.total_amount, 300);
  } finally {
    f.db.raw.close();
  }
});
