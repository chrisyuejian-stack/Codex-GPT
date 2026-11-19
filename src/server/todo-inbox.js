import { repo } from "./repo.js";
import { body, json, fail, now, sha } from "./core.js";
import { can } from "./permissions.js";
import { renewalSettings } from "./tools.js";
export const inboxTypes = [
  "attendance",
  "lead_followup",
  "renewal",
  "makeup",
  "student_followup",
  "payment_check",
];
export const todoInboxPath = (p) =>
  ["/api/todo/inbox", "/api/todo/snooze"].includes(p);
const atIso = (at) =>
  at ? new Date(at + 28800000).toISOString().slice(0, 19) + "+08:00" : null;
const sourcePermissions = {
  "attendance:checkin": ["attendance", "read"],
  "attendance:confirm": ["attendance", "confirm"],
  "lead_followup:lead": ["leads", "read"],
  "renewal:balance": ["packages", "read"],
  "makeup:leave": ["attendance", "read"],
  "student_followup:task": ["followup", "read"],
  "student_followup:stage": ["students", "read"],
  "payment_check:payment": ["tuition", "read"],
  "payment_check:price": ["tuition", "read"],
};
const token = (row) =>
  sha(JSON.stringify([row.item_key, row.source_version, row.snooze_version]));
function inputFor(user, policy, at) {
  const settings = renewalSettings(policy.settings),
    scope = { teacher_id: user.teacher_id, student_id: user.student_id };
  return {
    today: new Date(at + 28800000).toISOString().slice(0, 10),
    at,
    low: settings.low_balance_threshold,
    days: settings.expiry_warning_days,
    user_id: user.id,
    roles: user.roles,
    teacher_id: user.roles.includes("teacher") ? user.teacher_id : null,
    allowed: Object.entries(sourcePermissions)
      .filter(
        ([key, p]) =>
          !(user.roles.includes("teacher") && key === "makeup:leave") &&
          can(user, policy, ...p, scope),
      )
      .map(([key]) => key),
  };
}
function actionFor(row, user, policy) {
  const scope = { teacher_id: row.teacher_id, student_id: row.student_id };
  const checks = {
    lesson_attendance: [
      "attendance",
      user.roles.includes("teacher") ? "submit" : "update",
    ],
    confirm_submission: ["attendance", "confirm"],
    contact_lead: ["leads", "update"],
    renewal: ["packages", "read"],
    schedule_makeup: ["lessons", "create"],
    student_followup: ["followup", "update"],
    student_stage: ["students", "update"],
    resolve_payment: ["tuition", "update"],
    price_package: ["packages", "update"],
  };
  return {
    kind: row.action,
    enabled: can(user, policy, ...checks[row.action], scope),
    id: row.entity_id,
    ...(row.student_id ? { student_id: row.student_id } : {}),
    ...(row.lesson_id ? { lesson_id: row.lesson_id } : {}),
    ...(row.course_type_id ? { course_type_id: row.course_type_id } : {}),
    ...(row.subtype === "confirm" ? { submission_id: row.entity_id } : {}),
    ...(row.type === "makeup"
      ? { original_participant_id: row.entity_id }
      : {}),
    ...(row.scope_kind
      ? { scope_kind: row.scope_kind, scope_id: row.scope_id }
      : {}),
  };
}
async function dto(row, user, policy, at) {
  return {
    item_key: row.item_key,
    type: row.type,
    subtype: row.subtype,
    title: row.title,
    reason: row.reason,
    due_at: atIso(row.due_at),
    effective_due_at: atIso(row.effective_due),
    overdue: !row.is_snoozed && row.effective_due > 0 && row.effective_due < at,
    snoozed_until: atIso(row.snoozed_until),
    assignee: {
      id: row.owner_id || null,
      name:
        row.owner_name ||
        {
          academic: "教务待领取",
          finance: "财务待领取",
          consultant: "顾问待领取",
        }[row.assignee_role] ||
        "待领取",
      role: row.owner_id ? JSON.parse(row.owner_roles)[0] : row.assignee_role,
    },
    primary_action: actionFor(row, user, policy),
    version: await token(row),
  };
}
function pagination(value, fallback, min, max) {
  if (value === null) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    fail(422, "分页参数不正确", "validation_failed");
  return n;
}
export async function todoInboxApi(req, env, resolved, user, policy, url) {
  const path = resolved.relative;
  if (!todoInboxPath(path)) return undefined;
  if (
    user.roles.includes("student") ||
    !can(user, policy, "home", "read", { teacher_id: user.teacher_id })
  )
    fail(403, "没有待办收件箱权限", "forbidden");
  const at = now(),
    r = repo(env, resolved.tenant.id),
    base = inputFor(user, policy, at);
  if (path === "/api/todo/inbox" && req.method === "GET") {
    const scope = url.searchParams.get("scope") || "mine",
      type = url.searchParams.get("type") || "";
    if (
      !["mine", "all"].includes(scope) ||
      (type && !inboxTypes.includes(type)) ||
      (url.searchParams.has("include_snoozed") &&
        !["0", "1"].includes(url.searchParams.get("include_snoozed")))
    )
      fail(422, "待办筛选参数不正确", "validation_failed");
    const limit = pagination(url.searchParams.get("limit"), 50, 1, 100),
      offset = pagination(url.searchParams.get("offset"), 0, 0, 1000000),
      include_snoozed = url.searchParams.get("include_snoozed") === "1";
    const data = await r.inbox({
      ...base,
      scope,
      type,
      limit,
      offset,
      include_snoozed,
    });
    const counts = Object.fromEntries(
      inboxTypes.map((type) => [
        type,
        { total: 0, active: 0, snoozed: 0, overdue: 0 },
      ]),
    );
    for (const row of data.counts)
      counts[row.type] = {
        total: row.total,
        active: row.total - row.snoozed,
        snoozed: row.snoozed,
        overdue: row.overdue,
      };
    const selected = type ? [counts[type]] : Object.values(counts),
      total = selected.reduce(
        (n, x) => n + (include_snoozed ? x.total : x.active),
        0,
      );
    return json({
      items: await Promise.all(data.items.map((x) => dto(x, user, policy, at))),
      counts,
      total,
      snoozed_count: selected.reduce((n, x) => n + x.snoozed, 0),
      scope,
      type: type || null,
      offset,
      limit,
      next_offset: offset + limit < total ? offset + limit : null,
      generated_at: atIso(at),
    });
  }
  if (path === "/api/todo/snooze" && req.method === "POST") {
    const d = await body(req);
    if (
      typeof d.item_key !== "string" ||
      d.item_key.length > 500 ||
      typeof d.version !== "string" ||
      !["tomorrow", "next_week", "clear"].includes(d.until)
    )
      fail(422, "待办稍后参数不正确", "validation_failed");
    const data = await r.inbox({
        ...base,
        scope: "all",
        item_key: d.item_key,
        include_snoozed: true,
        limit: 1,
      }),
      row = data.items[0];
    if (!row) fail(404, "待办已完成、已变更或不属于当前权限范围", "not_found");
    if ((await token(row)) !== d.version)
      fail(409, "待办已变化，请刷新", "version_conflict");
    const day = new Date(at + 28800000),
      morning = Date.parse(day.toISOString().slice(0, 10) + "T09:00:00+08:00");
    const until =
      d.until === "clear"
        ? 0
        : morning +
          86400000 *
            (d.until === "tomorrow" ? 1 : (8 - day.getUTCDay()) % 7 || 7);
    await r.snoozeTodo(row, until, user);
    const refreshed = (
      await r.inbox({
        ...base,
        scope: "all",
        item_key: d.item_key,
        include_snoozed: true,
        limit: 1,
      })
    ).items[0];
    return json({ ok: true, item: await dto(refreshed, user, policy, at) });
  }
  fail(404, "不存在", "not_found");
}
