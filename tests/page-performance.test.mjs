import test from "node:test";
import assert from "node:assert/strict";

import { fixture } from "./support.mjs";
import { setup, lesson, pack, status, accountToken } from "./fixtures-credit.mjs";

const trips = (response) => Number(response.headers.get("server-timing")?.match(/desc="(\d+)"/)?.[1]);
function within(response, max) {
  assert.equal(response.status, 200);
  assert.equal(trips(response), Number(response.headers.get("x-test-d1-queries")));
  assert.ok(trips(response) <= max);
}
async function withSchool(run) {
  const f = await fixture();
  try { await run({ ...await setup(f, 2, "p1"), f }); }
  finally { f.restore(); }
}
const get = (s, path, token = s.token) => s.f.request(
  "https://school.test/" + s.t.slug + "/api/" + path, { headers: { Cookie: "channel_session=" + token } },
);

test("P1 首页和待办：一批读取，仍按角色裁剪", () => withSchool(async (s) => {
  const { f } = s;
  const today = new Date().toLocaleDateString("sv-SE",{timeZone:"Asia/Shanghai"});
  await lesson(s,today+"T09:00");
  const previous = await lesson(s,"2020-11-10T09:00",[s.students[0]]);
  assert.equal((await status(s,previous,"completed")).status,200);
  await pack(s,s.students[1],2);
  const academic = await accountToken(s,["academic"]);
  const finance = await accountToken(s,["finance"]);
  const home = await get(s,"c2/home",academic.token);
  within(home,5);
  const result = await home.json();
  assert.equal(result.lessons.length,1);
  assert.equal(result.lessons[0].participants_summary.count,2);
  assert.equal(result.week.length,1);
  assert.ok(!("tuition_amount" in result));
  const todo = await (await get(s,"todo/summary",academic.token)).json();
  assert.equal(todo.renewal_debt,1);
  assert.equal(todo.renewal_low,1);
  for (const [key, value] of Object.entries(result.counts)) assert.equal(value,todo[key],key);
}));

test("P1 缓存：品牌短缓存，已授权成功读取图片才长缓存，按会话隔开", () => withSchool(async (s) => {
  const { f } = s;
  const brand = await get(s,"public/brand","");
  assert.equal(brand.headers.get("cache-control"),"private, max-age=60");
  assert.equal((await get(s,"public/theme.css")).headers.get("cache-control"),"no-store");
  assert.equal((await get(s,"me")).headers.get("cache-control"),"no-store");

}));

test("P1 查询计划：续费流水、欠课与月收款使用按机构限定的索引", () => withSchool(async (s) => {
  const { f } = s, statements = [];
  const execute = f.db.batch.bind(f.db);
  f.db.batch = (queries) => {
    for (const query of queries)
      if (/^\s*(WITH|SELECT)/i.test(query.query) && /package_transactions|credit_debts|student_payments/.test(query.query))
        statements.push(query);
    return execute(queries);
  };
  await get(s,"c2/home");
  await get(s,"finance/report?month=2026-11");
  const plans = statements.flatMap(({query,params}) => f.db.raw.prepare("EXPLAIN QUERY PLAN "+query).all(...params).map((r) => r.detail));
  for (const table of ["p1_credit_ledger_active", "p1_credit_debt_active", "p1_payments_date_active"])
    assert.ok(plans.some((detail) => detail.startsWith("SEARCH") && detail.includes(table) && detail.includes("tenant_id=?")),plans.join("\n"));
}));
