import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support.mjs";
import {
  setup,
  request,
  accountToken,
  pack,
  lesson,
  status,
  mutate,
} from "./fixtures-credit.mjs";
const AT = Date.parse("2026-11-10T10:00:00+08:00");
const ok = (r, code = 200) => {
  assert.equal(r.status, code, r.text);
  assert.ok(r.queries <= 40);
  return r.body;
};
async function school(fn) {
  const old = Date.now;
  Date.now = () => AT;
  const f = await fixture();
  try {
    await fn({ ...(await setup(f, 2, "todo-actions")), f });
  } finally {
    f.restore();
    Date.now = old;
  }
}
async function task(s) {
  return ok(
    await request(s, "tools/followup_tasks", "POST", {
      student_id: s.students[0],
      title: "课程结束后沟通",
      due_date: "2026-11-09",
      assignee_id: s.user.id,
    }),
  );
}
async function leave(s) {
  await pack(s);
  const lid = await lesson(s, "2026-11-09T09:00", [s.students[0]]);
  ok(await status(s, lid, "student_leave"));
  return ok(await request(s, "todo/inbox?scope=all&type=makeup")).items[0];
}

test("收件箱字段和统计一致：北京时间分组、逾期天数、实体ID及业务版本可直接用于操作", () =>
  school(async (s) => {
    const t = await task(s),
      l = await leave(s);
    const inbox = ok(await request(s, "todo/inbox?scope=all"));
    assert.equal(inbox.total, inbox.items.length);
    assert.equal(
      inbox.total,
      Object.values(inbox.counts).reduce((n, c) => n + c.active, 0),
    );
    const item = inbox.items.find((x) => x.id === t.id);
    assert.equal(item.group, "overdue");
    assert.equal(item.overdue_days, 1);
    assert.equal(item.primary_action.version, 1);
    assert.equal(
      l.primary_action.version,
      (await s.r.businessGet("lesson_participants", l.id)).version,
    );
    assert.equal(l.primary_action.decision_version, 0);
    assert.ok(Number.isInteger(l.primary_action.original_lesson_version));
    assert.ok(
      inbox.items.every(
        (x) =>
          ["overdue", "today", "later"].includes(x.group) &&
          typeof x.id === "string" &&
          Number.isInteger(x.primary_action.version),
      ),
    );
  }));

test("单条跟进可指派/完成/重开；已完成单独分页查询，过期版本不覆盖，角色权限保持", () =>
  school(async (s) => {
    const made = await task(s),
      peer = await accountToken(s, ["academic"]),
      finance = await accountToken(s, ["finance"]);
    let row = ok(
      await request(s, "todo/followups/" + made.id, "PATCH", {
        version: 1,
        assignee_id: peer.id,
      }),
    ).record;
    assert.equal(row.version, 2);
    assert.equal(row.assignee_id, peer.id);
    assert.equal(
      ok(await request(s, "todo/inbox?type=student_followup")).total,
      0,
    );
    assert.equal(
      ok(
        await request(
          s,
          "todo/inbox?type=student_followup",
          "GET",
          undefined,
          peer.token,
        ),
      ).total,
      1,
    );
    ok(
      await request(s, "todo/followups/" + made.id, "PATCH", {
        version: 1,
        done: true,
      }),
      409,
    );
    row = ok(
      await request(
        s,
        "todo/followups/" + made.id,
        "PATCH",
        { version: 2, done: true },
        peer.token,
      ),
    ).record;
    assert.equal(row.done, true);
    assert.equal(row.version, 3);
    const completed = ok(
      await request(s, "todo/followups?done=1&scope=all&limit=1"),
    );
    assert.equal(completed.total, 1);
    assert.equal(completed.items[0].id, made.id);
    assert.equal(completed.items[0].assignee_name, "验收账号");
    assert.equal(
      ok(await request(s, "todo/followups?done=0&scope=all")).total,
      0,
    );
    ok(
      await request(
        s,
        "todo/followups/" + made.id,
        "PATCH",
        { version: 3, done: false },
        finance.token,
      ),
      403,
    );
    row = ok(
      await request(s, "todo/followups/" + made.id, "PATCH", {
        version: 3,
        done: false,
        assignee_id: null,
      }),
    ).record;
    assert.equal(row.done, false);
    assert.equal(row.assignee_id, null);
    const student = await accountToken(s, ["student"], s.students[0]);
    ok(
      await request(
        s,
        "todo/followups?done=1",
        "GET",
        undefined,
        student.token,
      ),
      403,
    );
    ok(
      await request(s, "todo/followups/missing", "PATCH", {
        version: 1,
        done: true,
      }),
      404,
    );
    ok(await request(s, "todo/followups?done=wrong"), 422);
  }));

test("请假标记不补可撤回并审计，版本冲突不覆盖；已不补不能安排，已安排不能标记不补", () =>
  school(async (s) => {
    const item = await leave(s),
      before = s.f.db.raw.prepare("SELECT * FROM package_transactions").all();
    const base = {
      version: item.primary_action.version,
      decision_version: 0,
      skip: true,
      reason: "学员确认本次不补",
    };
    let result = ok(
      await request(s, "todo/makeups/" + item.id + "/skip", "POST", base),
    );
    assert.equal(result.record.skipped, true);
    assert.equal(result.record.version, 1);
    assert.equal(
      ok(await request(s, "todo/inbox?scope=all&type=makeup")).total,
      0,
    );
    assert.deepEqual(
      s.f.db.raw.prepare("SELECT * FROM package_transactions").all(),
      before,
    );
    ok(
      await request(s, "todo/makeups/" + item.id + "/skip", "POST", base),
      409,
    );
    const target = await lesson(s, "2026-11-12T09:00", [s.students[1]]);
    const data = {
      original_participant_id: item.id,
      original_participant_version:
        item.primary_action.original_participant_version,
      original_lesson_version: item.primary_action.original_lesson_version,
      target_lesson_id: target,
      force: true,
    };
    ok(await mutate(s, "credits/makeups", data), 409);
    result = ok(
      await request(s, "todo/makeups/" + item.id + "/skip", "POST", {
        ...base,
        decision_version: 1,
        skip: false,
      }),
    );
    assert.equal(result.record.version, 2);
    assert.equal(
      ok(await request(s, "todo/inbox?scope=all&type=makeup")).items[0]
        .primary_action.decision_version,
      2,
    );
    ok(
      await mutate(s, "credits/makeups", {
        ...data,
        original_participant_version: data.original_participant_version + 100,
      }),
      409,
    );
    const joined = ok(await mutate(s, "credits/makeups", data));
    assert.equal(joined.committed, true);
    assert.equal(
      ok(await request(s, "todo/inbox?scope=all&type=makeup")).total,
      0,
    );
    ok(
      await request(s, "todo/makeups/" + item.id + "/skip", "POST", {
        ...base,
        decision_version: 2,
      }),
      409,
    );
    const student = await accountToken(s, ["student"], s.students[0]);
    ok(
      await request(
        s,
        "todo/makeups/" + item.id + "/skip",
        "POST",
        base,
        student.token,
      ),
      403,
    );
    assert.equal(
      s.f.db.raw
        .prepare("SELECT COUNT(*) n FROM audit_log WHERE action='waive_makeup'")
        .get().n,
      1,
    );
  }));

test("批量续费提醒生成不登记发送，单条已提醒使今日待办消失，规则读取修改沿用授权", () =>
  school(async (s) => {
    await pack(s, s.students[0], 1);
    await pack(s, s.students[1], 2);
    const inbox = ok(await request(s, "todo/inbox?scope=all&type=renewal"));
    assert.equal(inbox.total, 2);
    const input = {
      items: inbox.items.map((x) => ({
        student_id: x.primary_action.student_id,
        scope_kind: x.primary_action.scope_kind,
        scope_id: x.primary_action.scope_id,
      })),
    };
    const generated = ok(await request(s, "renewals/generate", "POST", input));
    assert.equal(generated.total, 2);
    assert.ok(
      generated.items.every(
        (x) => x.package_ids.length === 1 && x.text.includes(x.student_name),
      ),
    );
    assert.equal(
      s.f.db.raw.prepare("SELECT COUNT(*) n FROM renewal_reminders").get().n,
      0,
    );
    const row = generated.items[0];
    const reminder = ok(
      await request(s, "renewals/remind", "POST", {
        student_id: row.student_id,
        course_type_id: row.reminder_course_type_id,
        package_ids: row.package_ids,
        channel: "text",
      }),
    );
    assert.ok(reminder.sent_at);
    assert.equal(
      ok(await request(s, "todo/inbox?scope=all&type=renewal")).total,
      1,
    );
    const academic = await accountToken(s, ["academic"]);
    ok(
      await request(
        s,
        "renewal-settings",
        "PUT",
        { low_balance_threshold: 8, expiry_warning_days: 21 },
        academic.token,
      ),
      403,
    );
    ok(
      await request(s, "renewal-settings", "PUT", {
        low_balance_threshold: 8,
        expiry_warning_days: 21,
      }),
    );
    assert.equal(
      ok(await request(s, "renewal-settings")).settings.low_balance_threshold,
      8,
    );
    ok(
      await request(s, "renewals/generate", "POST", {
        items: [...input.items, input.items[0]],
      }),
      422,
    );
    ok(
      await request(s, "renewals/generate", "POST", {
        items: [
          { student_id: "foreign", scope_kind: "type", scope_id: s.type },
        ],
      }),
      409,
    );
    const student = await accountToken(s, ["student"], s.students[0]);
    ok(
      await request(s, "renewals/generate", "POST", input, student.token),
      403,
    );
  }));
