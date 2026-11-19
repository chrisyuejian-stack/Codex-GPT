import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support.mjs";
import { schoolFixture } from "./fixtures-school.mjs";

test("P3 会话：根入口每分钟最多续期一次，鉴权使用一次批处理", async () => {
  const original = Date.now;
  let clock = original();
  Date.now = () => clock;
  const f = await fixture();
  try {
    const s = await schoolFixture(f, "session-touch"),
      row = f.db.raw
        .prepare("SELECT * FROM sessions WHERE user_id=?")
        .get(s.user.id);
    f.db.raw
      .prepare("UPDATE sessions SET last_seen_at=?,updated_at=? WHERE id=?")
      .run(clock - 60001, clock - 60001, row.id);
    const get = () =>
      f.directRequest("https://school.test/api/me", {
        headers: { Cookie: "__Host-fengqin_session=" + s.token },
      });
    const read = () =>
      f.db.raw
        .prepare("SELECT last_seen_at FROM sessions WHERE id=?")
        .get(row.id).last_seen_at;
    let result = await get();
    assert.equal(result.status, 200);
    assert.equal(read(), clock);
    assert.equal(Number(result.headers.get("x-test-d1-queries")), 2);
    clock += 45000;
    result = await get();
    assert.equal(result.status, 200);
    assert.equal(read(), clock - 45000);
    clock += 15000;
    result = await get();
    assert.equal(result.status, 200);
    assert.equal(read(), clock);
    assert.equal(Number(result.headers.get("x-test-d1-queries")), 2);
  } finally {
    Date.now = original;
    f.restore();
  }
});
