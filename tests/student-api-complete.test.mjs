import test from "node:test";
import assert from "node:assert/strict";
import {
  growthSchool,
  submitFeedback,
  confirmFeedback,
} from "./fixtures-growth.mjs";
import { lesson, request } from "./fixtures-credit.mjs";
const ok = (r, status = 200) => {
  assert.equal(r.status, status, r.text);
  return r.body;
};
test("学员根入口：下一节课/本人课表/课时余额/老师点评齐全，手机与电脑使用相同API", () =>
  growthSchool(async (s) => {
    const own = await lesson(s, "2026-11-10T11:00", [s.students[0]]),
      other = await lesson(s, "2026-11-10T12:00", [s.students[1]]),
      submitted = ok(await submitFeedback(s));
    ok(await confirmFeedback(s, submitted.id));
    const get = async (path) => {
      const res = await s.f.directRequest("https://school.test/api/" + path, {
        headers: { Cookie: "__Host-fengqin_session=" + s.student.token },
      });
      const text = await res.text();
      assert.equal(res.status, 200, text);
      assert.ok(Number(res.headers.get("x-test-d1-queries")) <= 40);
      return { body: JSON.parse(text), text };
    };
    const next = await get("schedule-next");
    assert.equal(next.body.record.id, own);
    const timetable = await get("schedule?from=2026-11-10&to=2026-11-11");
    assert.ok(timetable.body.items.some((x) => x.id === own));
    assert.ok(!timetable.body.items.some((x) => x.id === other));
    assert.ok(!timetable.text.includes("学员1"));
    const packages = await get("credits/packages?student_id=" + s.students[1]);
    assert.equal(packages.body.items.length, 1);
    assert.equal(packages.body.items[0].student_id, s.students[0]);
    assert.equal(packages.body.items[0].balance, 19);
    const comments = await get("student/comments?student_id=" + s.students[1]);
    assert.equal(comments.body.items.length, 1);
    assert.ok(comments.body.items.every((x) => x.student_id === s.students[0]));
    assert.equal(comments.body.items[0].message.good, "节奏稳定");
    await get("c3/student-comments");
    ok(
      await request(s, "credits/payments", "GET", undefined, s.student.token),
      403,
    );
    await s.r.saveSetting("student_view_payments", true, s.user);
    await get("credits/payments");
    for (const path of ["todo/inbox", "backups"])
      ok(await request(s, path, "GET", undefined, s.student.token), 403);
  }));
