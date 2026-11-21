import { body, fail, json } from "./core.js";
const exact = new Set([
  "student/comments",
  "c3/student-comments",
  "credits/payments",
  "c2/home",
  "schedule",
  "c2/unchecked",
  "submissions",
  "c2/makeups",
  "finance/receivable-summary",
  "c2/renewals",
  "c2/followups",
  "c2/students",
  "c2/students/counts",
  "credits/packages",
  "schedule-templates",
  "data/schedule_templates",
  "data/schedule_enrollments",
  "data/teachers",
  "data/locations",
  "data/course_types",
  "data/course_categories",
  "data/students",
  "todo/summary",
  // 2026-11-20 扩充（接口合并）：均为只读 GET，每条在批量里仍按原接口逐条鉴权；
  // tests/read-batch-expand.test.mjs 逐条核对与单独请求结果一致、无写入、无权限时同样拒绝。
  "todo/inbox",
  "todo/followups",
  "tools/leads",
  "tools/followup_tasks",
  "tools/classes",
  "c3/leads-summary",
  "c3/report",
  "c3/receipts",
  "c3/costs-summary",
  "c3/teachers",
  "finance/payroll",
  "finance/settlement",
  "finance/costs",
  "finance/rates",
  "schedule-next",
  "data/student_schedule_blocks",
  // renewal-brand 不加入：每次读取都会记一条「生成续费通知」审计，属于有意的副作用。
  "settings/brand",
  "accounts",
  "logs",
  "teacher/today",
]);
// 带 ID 的只读路径：ID 只接受服务器生成的格式（小写前缀_24 位十六进制）。
const ID = "[a-z]+_[a-f0-9]{24}";
const patterns = new RegExp(
  "^(?:c2\\/students\\/[a-zA-Z0-9_-]+(?:\\/history)?|data\\/students\\/[a-zA-Z0-9_-]+|lessons\\/" +
    ID +
    "\\/review|students\\/" +
    ID +
    "\\/fixed-rules)$",
);
export function validateReadPaths(value) {
  if (!Array.isArray(value) || !value.length || value.length > 12)
    fail(400, "批量读取须包含 1–12 条路径");
  for (const path of value) {
    if (typeof path !== "string" || path.length > 2048 || /[\\#\s]/.test(path))
      fail(400, "无效读取路径");
    const pathname = path.split("?")[0];
    if (!exact.has(pathname) && !patterns.test(pathname))
      fail(400, "路径不在只读白名单内");
  }
  return value;
}
export async function readBatch(req, env, resolved, dispatch) {
  const paths = validateReadPaths((await body(req))?.paths);
  const children = await Promise.all(
    paths.map(async (path) => {
      const url = new URL(resolved.base + "api/" + path, req.url);
      const child = new Request(url, { method: "GET", headers: req.headers });
      const response = await dispatch(child, url, {
        ...resolved,
        relative: "/api/" + url.pathname.split("/api/")[1],
      });
      const value = (response.headers.get("content-type") || "").includes(
        "application/json",
      )
        ? await response.json()
        : await response.text();
      return {
        result: { path, status: response.status, body: value },
        count: 0,
      };
    }),
  );
  return json({ results: children.map(({ result }) => result) });
}
