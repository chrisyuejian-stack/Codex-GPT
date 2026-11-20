import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support.mjs";
import { setup, request, pack, lesson, accountToken } from "./fixtures-credit.mjs";
import { validateReadPaths } from "../src/server/read-batch.js";

// 2026-11-20 扩充的 read-batch 白名单：逐条核对
// 1) 批量里与单独请求的状态码、内容一致；2) 批量本身不产生额外写入；3) 无权限时批量里同样拒绝。
const strip = (value) => {
  if (Array.isArray(value)) return value.map(strip);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !["generated_at"].includes(k))
        .map(([k, v]) => [k, strip(v)]),
    );
  return value;
};
const changes = (s) => s.f.db.raw.prepare("SELECT total_changes() n").get().n;

test("read-batch 扩充：新加入的只读路径批量与单独请求一致、无额外写入、权限同样生效", async () => {
  const f = await fixture();
  try {
    const s = { ...(await setup(f, 2)), f };
    await pack(s, s.students[0], 5);
    const lessonId = await lesson(s, "2026-11-03T09:00", [s.students[0]]);
    const paths = [
      "todo/inbox?scope=all&limit=20",
      "todo/followups?done=all&scope=all",
      "tools/leads?offset=0",
      "tools/followup_tasks?offset=0",
      "tools/classes?offset=0",
      "c3/leads-summary",
      "c3/report?month=2026-11",
      "c3/receipts?month=2026-11",
      "c3/costs-summary?month=2026-11",
      "c3/teachers",
      "finance/payroll?month=2026-11",
      "finance/settlement?month=2026-11",
      "finance/costs",
      "finance/rates",
      "schedule-next",
      "data/student_schedule_blocks",
      "settings/brand",
      "accounts?offset=0",
      "logs?offset=0",
      "teacher/today",
      "lessons/" + lessonId + "/review",
      "students/" + s.students[0] + "/fixed-rules",
    ];
    validateReadPaths(paths.slice(0, 12));
    validateReadPaths(paths.slice(12));
    const tokens = [
      ["supervisor", s.token],
      ["academic", (await accountToken(s, ["academic"])).token],
      ["finance", (await accountToken(s, ["finance"])).token],
    ];
    for (const [role, token] of tokens) {
      const single = {};
      for (const path of paths) single[path] = await request(s, path, "GET", undefined, token);
      // 基线：一个原有白名单路径的批量请求产生的写入（会话活动时间等）。
      let before = changes(s);
      assert.equal((await request(s, "read-batch", "POST", { paths: ["data/teachers"] }, token)).status, 200);
      const baseline = changes(s) - before;
      for (let i = 0; i < paths.length; i += 12) {
        const group = paths.slice(i, i + 12);
        before = changes(s);
        const batch = await request(s, "read-batch", "POST", { paths: group }, token);
        assert.equal(batch.status, 200, role + " " + batch.text);
        assert.ok(changes(s) - before <= baseline, role + " 批量读取不应产生额外写入：" + group.join(","));
        batch.body.results.forEach((r, k) => {
          const path = group[k],
            one = single[path];
          assert.equal(r.status, one.status, role + " 状态一致：" + path);
          if (one.status === 200) assert.deepEqual(strip(r.body), strip(one.body), role + " 内容一致：" + path);
        });
      }
      // 主管至少能读到这些路径（老师今日汇总只给老师，主管 403）。
      if (role === "supervisor")
        for (const path of paths)
          assert.equal(single[path].status, path === "teacher/today" ? 403 : 200, path + " " + single[path].text);
    }
    // 带 ID 的路径只接受服务器生成的 ID 格式。
    for (const bad of ["renewal-brand", "lessons/../review", "lessons/les_1/review", "students/x/fixed-rules", "settings/ai", "backups"])
      assert.throws(() => validateReadPaths([bad]), bad);
  } finally {
    f.restore();
  }
});
