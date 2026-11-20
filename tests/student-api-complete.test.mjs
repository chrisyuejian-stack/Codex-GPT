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
    // 2026-11-20：每条点评带上课程开始时间、课程名、老师名、本人出勤，与本人课表同一节课的字段一致。
    const note = comments.body.items[0];
    assert.ok(note.lesson_id && note.start_at && note.course_name && note.teacher_name, JSON.stringify(note));
    const d = note.start_at.slice(0, 10),
      dayAfter = new Date(Date.parse(d + "T12:00:00Z") + 86400000).toISOString().slice(0, 10);
    const row = (await get("schedule?from=" + d + "&to=" + dayAfter)).body.items.find((x) => x.id === note.lesson_id);
    assert.ok(row, "点评对应的课在本人课表里");
    for (const k of ["start_at", "course_name", "teacher_name", "own_attendance"]) assert.equal(note[k], row[k], k);
    // 批量读取里同样带这些字段。
    const batch = await s.f.directRequest("https://school.test/api/read-batch", {
      method: "POST",
      headers: { Cookie: "__Host-fengqin_session=" + s.student.token, Origin: "https://school.test", "Content-Type": "application/json" },
      body: JSON.stringify({ paths: ["student/comments"] }),
    });
    const batched = (await batch.json()).results[0];
    assert.equal(batched.status, 200);
    assert.equal(batched.body.items[0].course_name, row.course_name);
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
