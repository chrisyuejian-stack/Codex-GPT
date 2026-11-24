import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support.mjs";
import {
  setup,
  request,
  mutate,
  pack,
  lesson,
  status,
  accountToken,
  details,
} from "./fixtures-credit.mjs";
import { teacherToken } from "./fixtures-mobile.mjs";
import { readWorkbook, workbook } from "../src/server/xlsx.js";
import { moneyOut } from "../src/server/numbers.js";
const path = "c3/report/earned?month=2026-11";
function ok(r, code = 200) {
  assert.equal(r.status, code, r.text);
  if (r.queries !== undefined) assert.ok(r.queries <= 40);
  return r.body;
}
async function school(fn) {
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : ["2026-11-24T20:00:00+08:00"]));
    }
    static now() {
      return RealDate.parse("2026-11-24T20:00:00+08:00");
    }
  };
  const f = await fixture();
  try {
    await fn({ ...(await setup(f, 3, "earned-details")), f });
  } finally {
    f.restore();
    globalThis.Date = RealDate;
  }
}
test("确认收入明细：分类、金额分位、整体收费、维度、截止日、只读批量和租户隔离", () =>
  school(async (s) => {
    await pack(s, s.students[0], 5);
    ok(
      await mutate(s, "credits/packages", {
        student_id: s.students[1],
        course_type_id: s.type,
        units_total: 5,
      }),
    );
    ok(
      await s.call("data/students/" + s.students[2], "PATCH", {
        version: 1,
        billing_mode: "overall",
      }),
    );
    const a = await lesson(s, "2026-11-03T09:00", s.students);
    ok(await status(s, a, "completed"));
    const b = await lesson(s, "2026-11-04T09:00", [s.students[0]]);
    ok(await status(s, b, "completed"));
    ok(
      await mutate(s, "credits/lessons/" + b + "/undo", {
        lesson_version: (await details(s, b)).version,
      }),
    );
    ok(
      await mutate(s, "credits/payments", {
        student_id: s.students[0],
        paid_at: "2026-11-05",
        kind: "other_income",
        amount: 0.01,
        other_category: "教材费",
        other_note: "=SUM(A1)",
      }),
    );
    // Future postings must not leak into the current-month cutoff.
    const future = await lesson(s, "2026-11-25T09:00", [s.students[0]]);
    ok(await status(s, future, "completed"));
    assert.equal(
      ok(await request(s, path)).earned_amount,
      200.01,
      "按入账日而非未来课程日期截断",
    );
    s.f.db.raw
      .prepare(
        `UPDATE credit_income_entries SET booked_on='2026-11-25' WHERE id IN(SELECT x.id FROM package_transactions x JOIN lesson_participants p ON p.tenant_id=x.tenant_id AND p.id=x.participant_id WHERE p.lesson_id=?)`,
      )
      .run(future);
    const before = s.f.db.raw
      .prepare("SELECT COUNT(*) n FROM audit_log")
      .get().n;
    const out = ok(await request(s, path));
    assert.equal(out.cutoff, "2026-11-24");
    assert.equal(out.earned_amount, 100.01);
    assert.equal(
      out.earned_amount,
      ok(await request(s, "c3/report?month=2026-11")).earned_amount,
    );
    assert.equal(out.unpriced_units, 2);
    assert.equal(out.summary.lesson_amount, 200);
    assert.equal(out.summary.reversal_amount, -100);
    assert.equal(out.summary.other_income_amount, 0.01);
    assert.equal(out.items.filter((x) => x.category === "unpriced").length, 2);
    assert.equal(
      out.items.find(
        (x) => x.student_id === s.students[1] && x.category === "unpriced",
      ).can_fix_price,
      true,
    );
    assert.equal(
      out.items.find((x) => x.source === "overall").can_fix_price,
      false,
    );
    assert.ok(out.items.every((x) => x.date <= out.cutoff));
    assert.equal(
      out.items.find((x) => x.category === "other").unit_price,
      null,
    );
    assert.equal(
      out.dimensions.students.reduce((n, x) => n + x.earned_amount, 0),
      100.01,
    );
    const batch = ok(await request(s, "read-batch", "POST", { paths: [path] }));
    assert.deepEqual(batch.results[0].body, out);
    assert.equal(
      s.f.db.raw.prepare("SELECT COUNT(*) n FROM audit_log").get().n,
      before,
    );
    for (const role of ["academic", "finance"]) {
      const u = await accountToken(s, [role]);
      ok(await request(s, path, "GET", undefined, u.token));
    }
    const consultant = await accountToken(s, ["consultant"]);
    ok(await request(s, path, "GET", undefined, consultant.token), 403);
    const student = await accountToken(s, ["student"], s.students[0]);
    ok(await request(s, path, "GET", undefined, student.token), 403);
    ok(await request(s, path, "GET", undefined, (await teacherToken(s)).token), 403);
    const foreign = { ...(await setup(s.f, 1, "earned-foreign")), f: s.f };
    assert.equal(ok(await request(foreign, path)).items.length, 0);
    ok(await request(s, "c3/report/earned?month=2026-13"), 400);
  }));
test("确认收入明细：锁月快照与极早无口径锁月null；历史月末及空月", () =>
  school(async (s) => {
    await pack(s);
    const id = await lesson(s, "2026-11-03T09:00", [s.students[0]]);
    ok(await status(s, id, "completed"));
    const finance = await accountToken(s, ["finance"]);
    ok(
      await mutate(
        s,
        "finance/settlements/submit",
        { month: "2026-11", version: 0 },
        "POST",
        finance.token,
      ),
    );
    ok(
      await mutate(s, "finance/settlements/approve", {
        month: "2026-11",
        version: 1,
      }),
    );
    const out = ok(await request(s, path));
    assert.equal(out.locked, true);
    assert.equal(out.earned_amount, 100);
    assert.equal(out.summary.lesson_amount, 100);
    s.f.db.raw.prepare('UPDATE credit_income_entries SET amount=10100 WHERE tenant_id=?').run(s.t.id);
    const drift = ok(await request(s, path));
    assert.equal(drift.earned_amount, 100);
    assert.equal(drift.summary.lesson_amount, 101);
    assert.equal(drift.earned_amount, ok(await request(s, 'c3/report?month=2026-11')).earned_amount);
    // Model the pre-0018 summary without earned fields, as occurredReport does.
    s.f.db.raw
      .prepare(
        "UPDATE settlements SET summary='{}' WHERE tenant_id=? AND month='2026-11'",
      )
      .run(s.t.id);
    assert.equal(ok(await request(s, path)).earned_amount, null);
    const empty = ok(await request(s, "c3/report/earned?month=2026-10"));
    assert.equal(empty.cutoff, "2026-10-31");
    assert.equal(empty.earned_amount, 0);
    assert.deepEqual(empty.items, []);
  }));
test("确认收入导出：Sheet1保留，Sheet2金额为元与文本公式安全，默认导入仍拒绝多表", () =>
  school(async (s) => {
    await pack(s);
    const id = await lesson(s, "2026-11-03T09:00", [s.students[0]]);
    ok(await status(s, id, "completed"));
    ok(
      await mutate(s, "credits/payments", {
        student_id: s.students[0],
        paid_at: "2026-11-05",
        kind: "other_income",
        amount: 0.01,
        other_category: "教材费",
        other_note: "=1+1<&",
      }),
    );
    const res = await s.f.request(
      "https://school.test/" +
        s.t.slug +
        "/api/export?kind=report&month=2026-11&scope=occurred",
      { headers: { Cookie: "channel_session=" + s.token } },
    );
    assert.equal(res.status, 200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const xml = new TextDecoder().decode(bytes);
    assert.match(xml, /确认收入明细/);
    assert.match(xml, /教务数据/);
    assert.match(xml, /sheet2.xml/);
    const rows = await readWorkbook(bytes, { sheet: 2, singleSheet: false });
    const consumed = rows.find((x) => x.values["来源类型"] === "课程消课");
    assert.equal(consumed.values["确认金额（元）"], "100");
    assert.equal(consumed.values["单价（元）"], "100");
    assert.equal(
      rows.find((x) => x.values["来源类型"] === "其他收入").values["备注"],
      "=1+1<&",
    );
    assert.doesNotMatch(xml, /<f[ >]/);
    await assert.rejects(() => readWorkbook(bytes), /一个待导入工作表/);
    const single = workbook([["金额"], [0.01]]);
    assert.equal((await readWorkbook(single))[0].values["金额"], "0.01");
    assert.deepEqual(
      moneyOut({ lesson_amount: 1, reversal_amount: -1, earned_amount: null }),
      { lesson_amount: 0.01, reversal_amount: -0.01, earned_amount: null },
    );
  }));

test("跨课程大类包：维度归实际消课课程，1分钱金额与单价不丢失", () => school(async s => {
  const actual = await s.create('course_types',{name:'同类另一门课',category_id:s.cat,format:'group'});
  ok(await mutate(s,'credits/packages',{student_id:s.students[0],course_type_id:s.type,scope_kind:'category',units_total:5,unit_price:0.01}));
  const id=ok(await s.call('data/lessons','POST',{start_at:'2026-11-03T10:00',teacher_id:s.teacher,course_type_id:actual,location_id:s.room,unit_minutes:45,units:1,student_ids:[s.students[0]]})).id;
  ok(await status(s,id,'completed'));
  const out=ok(await request(s,path));
  assert.equal(out.earned_amount,0.01);assert.equal(out.summary.lesson_amount,0.01);
  assert.equal(out.items[0].unit_price,0.01);assert.equal(out.items[0].course_type_id,actual);
  assert.equal(out.dimensions.courses[0].id,actual);assert.equal(out.items[0].package_name,'班课');
}));
