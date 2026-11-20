import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support.mjs";
import { setup, request, accountToken } from "./fixtures-credit.mjs";
import { b64, bytes, sha } from "../src/server/core.js";

async function teacherAccount(s, teacherId) {
  const made = await s.call("accounts", "POST", {
    name: "教师账号",
    phone: "137" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0"),
    roles: ["teacher"],
    teacher_id: teacherId,
  });
  assert.equal(made.status, 201, made.text);
  s.f.db.raw.prepare("UPDATE users SET must_change=0 WHERE tenant_id=? AND id=?").run(s.t.id, made.body.id);
  const token = b64(bytes(32));
  await s.r.createSession(await sha(token), await s.r.user(made.body.id), { ip: "test", ua: "teacher-today" });
  return token;
}
const bj = (ms) => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
const shift = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);

test("老师今日汇总：与课表、点名详情单独请求逐字段一致；只含本人已下课未提交的课；非老师 403；可进 read-batch", async () => {
  const f = await fixture();
  try {
    const s = { ...(await setup(f, 2)), f };
    const other = await s.create("teachers", { name: "另一位老师" });
    // 用“昨天”做查询日：当天的课都已下课，不受测试运行时刻影响。
    const date = shift(bj(Date.now()), -1);
    const make = async (time, teacher = s.teacher, d = date) => {
      const r = await s.call("data/lessons", "POST", {
        start_at: d + "T" + time,
        teacher_id: teacher,
        course_type_id: s.type,
        location_id: s.room,
        duration: 45,
        units: 1,
        student_ids: [s.students[0]],
      });
      assert.equal(r.body.committed, true, r.text);
      return r.body.id;
    };
    const mine1 = await make("09:00"),
      mine2 = await make("10:00"),
      others = await make("11:00", other),
      earlier = await make("09:00", s.teacher, shift(date, -2));
    const token = await teacherAccount(s, s.teacher);
    const res = await request(s, "teacher/today?date=" + date, "GET", undefined, token);
    assert.equal(res.status, 200, res.text);
    assert.ok(res.queries <= 40, "D1 查询预算");
    const body = res.body;
    assert.equal(body.date, date);
    const today = await request(s, "schedule?from=" + date + "&to=" + shift(date, 1) + "&offset=0", "GET", undefined, token);
    const recent = await request(s, "schedule?from=" + shift(date, -2) + "&to=" + date + "&offset=0", "GET", undefined, token);
    assert.deepEqual(body.today, today.body.items);
    assert.deepEqual(body.recent, recent.body.items);
    assert.ok(body.recent.some((r) => r.id === earlier));
    // 只含本人主讲、已下课、未提交的当天课；别的老师的课不在其中。
    assert.deepEqual(Object.keys(body.reviews).sort(), [mine1, mine2].sort());
    assert.ok(!(others in body.reviews));
    assert.ok(!body.today.some((r) => r.id === others && r.teacher_id === s.teacher));
    for (const id of [mine1, mine2]) {
      const one = await request(s, "lessons/" + id + "/review", "GET", undefined, token);
      assert.equal(one.status, 200);
      assert.deepEqual(body.reviews[id], one.body);
    }
    // 未来的日期：课没下课，不带点名详情。
    await make("09:00", s.teacher, shift(date, 3));
    const future = await request(s, "teacher/today?date=" + shift(date, 3), "GET", undefined, token);
    assert.equal(future.status, 200);
    assert.deepEqual(future.body.reviews, {});
    // 批量读取里同样可用。
    const batch = await request(s, "read-batch", "POST", { paths: ["teacher/today?date=" + date] }, token);
    assert.equal(batch.status, 200);
    assert.equal(batch.body.results[0].status, 200);
    assert.deepEqual(Object.keys(batch.body.results[0].body.reviews).sort(), [mine1, mine2].sort());
    // 非老师：主管、学员都拒绝；日期格式错误 400。
    assert.equal((await request(s, "teacher/today")).status, 403);
    const student = await accountToken(s, ["student"], s.students[0]);
    assert.equal((await request(s, "teacher/today", "GET", undefined, student.token)).status, 403);
    assert.equal((await request(s, "teacher/today?date=2026-13-01", "GET", undefined, token)).status, 400);
  } finally {
    f.restore();
  }
});
