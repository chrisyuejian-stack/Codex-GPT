import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./support.mjs";

import { setup, request, mutate, status, pack } from "./fixtures-credit.mjs";

import { randomId } from "../src/server/core.js";

const day = 86400000;
function expect(response, status = 200) {
  assert.equal(response.status, status, response.text);
  if (response.queries) assert.ok(response.queries <= 40);
  return response.body;
}
async function withSchool(fn) {
  const f = await fixture();
  try { await fn({ ...await setup(f, 2, "d1"), f }); }
  finally { f.restore(); }
}

const operation = () => ({ operation_id: randomId("op"), reason: "验收删除流程" });

test("D1 学习阶段与课时包：软删、版本、幂等和关联拒绝；可解除阶段关联", () => withSchool(async (s) => {
  const st = expect(await mutate(s, "credits/stages", { student_id: s.students[0], name: "阶段" })).id;
  const pkg = expect(await mutate(s, "credits/packages", {
    student_id: s.students[0], course_type_id: s.type, units_total: 0, stage_id: st,
  })).id;
  const path = "credits/stages/" + st;
  assert.match(expect(await mutate(s, path, { version: 1 }, "DELETE"), 409).message, /被课时包引用/);
  expect(await mutate(s, "credits/packages/"+pkg, { version: 1, stage_id: null }, "PATCH"));
  expect(await mutate(s, path, { version: 2 }, "DELETE"), 409);
  const body = { ...operation(), version: 1 };
  const deleted = expect(await request(s, path, "DELETE", body));
  assert.deepEqual(expect(await request(s, path, "DELETE", body)), deleted);
  expect(await request(s, path), 404);
  expect(await mutate(s, "data/packages/"+pkg, { version: 2 }, "DELETE"));
  const used = await pack(s);
  assert.match(expect(await mutate(s, "data/packages/"+used, { version: 1 }, "DELETE"), 409).message, /课时流水/);
}));
