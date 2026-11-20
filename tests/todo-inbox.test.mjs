import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support.mjs";
import {
  setup,
  request,
  accountToken,
  lesson,
  pack,
  status,
} from "./fixtures-credit.mjs";
import { teacherToken, proposal } from "./fixtures-mobile.mjs";
import { sha } from "../src/server/core.js";
const AT = Date.parse("2026-11-10T10:00:00+08:00");
function ok(r, status = 200) {
  assert.equal(r.status, status, r.text);
  if (r.queries !== undefined) assert.ok(r.queries <= 40);
  return r.body;
}
async function school(fn) {
  const old = Date.now;
  let clock = AT;
  Date.now = () => clock;
  const f = await fixture();
  try {
    const s = { ...(await setup(f, 2, "inbox")), f };
    s.move = async (at) => {
      clock = at;
      await s.r.revokeSession(await sha(s.token));
      await s.r.createSession(await sha(s.token), await s.r.user(s.user.id), {
        ip: "test",
        ua: "inbox",
      });
    };
    await fn(s);
  } finally {
    Date.now = old;
    f.restore();
  }
}
async function task(s, assignee = s.user.id, title = "跟进学员") {
  const created = ok(
    await s.call("tools/followup_tasks", "POST", {
      student_id: s.students[0],
      title,
      due_date: "2026-11-09",
      assignee_id: assignee,
    }),
  );
  return s.r.businessGet("followup_tasks", created.id);
}
async function seed(s) {
  await pack(s, s.students[0], 1);
  const leave = await lesson(s, "2026-11-09T09:00", [s.students[1]]);
  ok(await status(s, leave, "student_leave"));
  s.checkin = await lesson(s, "2026-11-10T09:00", [s.students[0]]);
  s.lid = await lesson(s, "2026-11-10T08:00", [s.students[0]]);
  s.teacherAccount = await teacherToken(s);
  s.student = await accountToken(s, ["student"], s.students[0]);
  await s.r.saveSetting("teacher_self_checkin", true, s.user);
  ok(await proposal(s));
  s.lead = ok(
    await s.call("tools/leads", "POST", {
      name: "回访线索",
      stage: "contacted",
      next_followup: "2026-11-09",
    }),
  );
  s.followup = await task(s);
  ok(
    await request(s, "credits/payments", "POST", {
      operation_id: crypto.randomUUID(),
      student_id: s.students[0],
      amount: 20,
      paid_at: "2026-11-09",
    }),
  );
}

test("收件箱一次返回六类条目/计数、原因、负责人、截止/逾期和操作ID，不重复点名与待确认", () =>
  school(async (s) => {
    await seed(s);
    const data = ok(await request(s, "todo/inbox?scope=all"));
    for (const type of [
      "attendance",
      "lead_followup",
      "renewal",
      "makeup",
      "student_followup",
      "payment_check",
    ]) {
      assert.ok(data.counts[type].active > 0, type);
      assert.ok(
        data.items.some((x) => x.type === type),
        type,
      );
    }
    assert.equal(data.total, data.items.length);
    assert.equal(data.counts.attendance.total, 2);
    for (const item of data.items) {
      assert.ok(item.item_key);
      assert.ok(item.reason);
      assert.ok(item.assignee.name);
      assert.ok(item.primary_action.id);
      assert.ok(item.version);
      assert.ok("due_at" in item);
      assert.ok("overdue" in item);
    }
    assert.ok(data.items.find((x) => x.type === "lead_followup").overdue);
    assert.ok(
      data.items.some(
        (x) =>
          x.primary_action.kind === "confirm_submission" &&
          x.primary_action.submission_id,
      ),
    );
    assert.ok(
      data.items.some(
        (x) =>
          x.primary_action.kind === "lesson_attendance" &&
          x.primary_action.lesson_id === s.checkin,
      ),
    );
  }));

test("我负责/全部、类型过滤、分页和完整计数独立；其他人的任务不混入mine", () =>
  school(async (s) => {
    const peer = await accountToken(s, ["academic"]);
    await task(s, s.user.id, "本人任务");
    await task(s, peer.id, "同事任务");
    const mine = ok(await request(s, "todo/inbox"));
    assert.deepEqual(
      mine.items.map((x) => x.title),
      ["本人任务"],
    );
    const all = ok(
      await request(s, "todo/inbox?scope=all&type=student_followup&limit=1"),
    );
    assert.equal(all.total, 2);
    assert.equal(all.items.length, 1);
    assert.equal(all.next_offset, 1);
    assert.equal(all.counts.student_followup.active, 2);
    const beyond = ok(await request(s, "todo/inbox?scope=all&offset=999"));
    assert.equal(beyond.total, 2);
    assert.equal(beyond.items.length, 0);
    const theirs = ok(
      await request(s, "todo/inbox", "GET", undefined, peer.token),
    );
    assert.deepEqual(
      theirs.items.map((x) => x.title),
      ["同事任务"],
    );
    for (const q of [
      "scope=unknown",
      "type=unknown",
      "offset=-1",
      "limit=0",
      "include_snoozed=yes",
    ])
      ok(await request(s, "todo/inbox?" + q), 422);
  }));

test("稍后按本人独立保存：明天/下周一北京时间09点，可更新/撤回，过期自动恢复", () =>
  school(async (s) => {
    const peer = await accountToken(s, ["academic"]);
    await task(s);
    let item = ok(await request(s, "todo/inbox")).items[0];
    const before = s.f.db.raw.prepare("SELECT * FROM followup_tasks").all();
    let result = ok(
      await request(s, "todo/snooze", "POST", {
        item_key: item.item_key,
        version: item.version,
        until: "tomorrow",
      }),
    );
    assert.equal(result.item.snoozed_until, "2026-11-11T09:00:00+08:00");
    assert.equal(ok(await request(s, "todo/inbox")).total, 0);
    assert.equal(ok(await request(s, "todo/inbox")).snoozed_count, 1);
    assert.equal(
      ok(await request(s, "todo/inbox?scope=all", "GET", undefined, peer.token))
        .total,
      1,
    );
    assert.equal(ok(await request(s, "todo/inbox?include_snoozed=1")).total, 1);
    ok(
      await request(s, "todo/snooze", "POST", {
        item_key: item.item_key,
        version: item.version,
        until: "next_week",
      }),
      409,
    );
    item = result.item;
    result = ok(
      await request(s, "todo/snooze", "POST", {
        item_key: item.item_key,
        version: item.version,
        until: "next_week",
      }),
    );
    assert.equal(result.item.snoozed_until, "2026-11-16T09:00:00+08:00");
    assert.deepEqual(
      s.f.db.raw.prepare("SELECT * FROM followup_tasks").all(),
      before,
    );
    await s.move(Date.parse("2026-11-16T09:01:00+08:00"));
    item = ok(await request(s, "todo/inbox")).items[0];
    assert.ok(item.overdue);
    const cleared = ok(
      await request(s, "todo/snooze", "POST", {
        item_key: item.item_key,
        version: item.version,
        until: "clear",
      }),
    );
    assert.equal(cleared.item.snoozed_until, null);
    assert.equal(
      s.f.db.raw
        .prepare("SELECT COUNT(*) n FROM audit_log WHERE action='snooze'")
        .get().n,
      3,
    );
  }));

test("源记录更新使旧稍后失效，完成任务自动消失，旧版本和未知条目不能写入", () =>
  school(async (s) => {
    const row = await task(s);
    let item = ok(await request(s, "todo/inbox")).items[0];
    ok(
      await request(s, "todo/snooze", "POST", {
        item_key: item.item_key,
        version: item.version,
        until: "tomorrow",
      }),
    );
    ok(
      await s.call("tools/followup_tasks/" + row.id, "PATCH", {
        version: row.version,
        student_id: s.students[0],
        title: "更新任务",
        due_date: "2026-11-09",
        assignee_id: s.user.id,
        done: false,
      }),
    );
    let data = ok(await request(s, "todo/inbox"));
    assert.equal(data.total, 1);
    assert.equal(data.items[0].snoozed_until, null);
    ok(
      await request(s, "todo/snooze", "POST", {
        item_key: item.item_key,
        version: item.version,
        until: "tomorrow",
      }),
      409,
    );
    const updated = await s.r.businessGet("followup_tasks", row.id);
    ok(
      await s.call("tools/followup_tasks/" + row.id, "PATCH", {
        ...updated,
        done: true,
      }),
    );
    assert.equal(ok(await request(s, "todo/inbox?include_snoozed=1")).total, 0);
    ok(
      await request(s, "todo/snooze", "POST", {
        item_key: item.item_key,
        version: data.items[0].version,
        until: "tomorrow",
      }),
      404,
    );
    ok(
      await request(s, "todo/snooze", "POST", {
        item_key: "student_followup:task:unknown",
        version: "bad",
        until: "tomorrow",
      }),
      404,
    );
  }));

test("权限不泄露：学员拒绝、教师仅本人出勤，教务无收款核对，财务看不到未授权线索", () =>
  school(async (s) => {
    await seed(s);
    const academic = await accountToken(s, ["academic"]),
      finance = await accountToken(s, ["finance"]);
    ok(await request(s, "todo/inbox", "GET", undefined, s.student.token), 403);
    const teacher = ok(
      await request(
        s,
        "todo/inbox?scope=all",
        "GET",
        undefined,
        s.teacherAccount.token,
      ),
    );
    assert.ok(teacher.items.length);
    assert.ok(teacher.items.every((x) => x.type === "attendance"));
    assert.ok(
      teacher.items.every((x) => x.primary_action.lesson_id === s.checkin),
    );
    const staff = ok(
      await request(
        s,
        "todo/inbox?scope=all",
        "GET",
        undefined,
        academic.token,
      ),
    );
    assert.equal(staff.counts.payment_check.total, 0);
    assert.ok(!staff.items.some((x) => x.type === "payment_check"));
    const cash = ok(
      await request(s, "todo/inbox?scope=all", "GET", undefined, finance.token),
    );
    assert.equal(cash.counts.lead_followup.total, 0);
    assert.ok(cash.counts.payment_check.active > 0);
    const protectedItem = ok(
      await request(s, "todo/inbox?scope=all"),
    ).items.find((x) => x.type === "payment_check");
    ok(
      await request(
        s,
        "todo/snooze",
        "POST",
        {
          item_key: protectedItem.item_key,
          version: protectedItem.version,
          until: "tomorrow",
        },
        academic.token,
      ),
      404,
    );
    await s.r.saveRights("academic", "leads", "read", false, s.user);
    ok(
      await request(
        s,
        "todo/inbox?scope=all",
        "GET",
        undefined,
        academic.token,
      ),
      401,
    );
  }));

test("请假补课完成及已核对缴费不再出现在收件箱，GET无业务/审计写入", () =>
  school(async (s) => {
    await seed(s);
    const before = s.f.db.raw
      .prepare("SELECT COUNT(*) n FROM audit_log")
      .get().n;
    const data = ok(await request(s, "todo/inbox?scope=all"));
    ok(await request(s, "todo/inbox?scope=all"));
    assert.equal(
      s.f.db.raw.prepare("SELECT COUNT(*) n FROM audit_log").get().n,
      before,
    );
    const check = data.items.find((x) => x.type === "payment_check");
    ok(
      await request(
        s,
        "credits/payments/" + check.primary_action.id + "/resolve",
        "POST",
        { operation_id: crypto.randomUUID(), version: 1, action: "to_balance" },
      ),
    );
    const after = ok(await request(s, "todo/inbox?scope=all"));
    assert.equal(after.counts.payment_check.total, 0);
    assert.equal(after.counts.makeup.active, 1);
  }));
