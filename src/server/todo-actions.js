import { repo } from "./repo.js";
import { body, json, fail, now, version, string } from "./core.js";
import { requireCan } from "./accounts.js";
import { renewalSettings } from "./tools.js";
import { decrypt } from "./crypto.js";
import { day } from "./scheduling.js";
export const todoActionsPath = (p) =>
  ["/api/todo/followups", "/api/renewals/generate"].includes(p) ||
  /^\/api\/todo\/(?:followups\/[^/]+|makeups\/[^/]+\/skip)$/.test(p);
const dateBJ = () => new Date(now() + 28800000).toISOString().slice(0, 10);
const taskDto = (r) => ({
  id: r.id,
  student_id: r.student_id,
  title: r.title,
  due_date: r.due_date,
  assignee_id: r.assignee_id,
  assignee_name: r.assignee_name ?? null,
  done: !!r.done,
  version: r.version,
});
export async function todoActionsApi(req, env, resolved, user, policy, url) {
  const path = resolved.relative;
  if (!todoActionsPath(path)) return undefined;
  if (user.roles.some((x) => ["student", "teacher"].includes(x)))
    fail(403, "仅员工可操作待办", "forbidden");
  const r = repo(env, resolved.tenant.id);
  if (path === "/api/todo/followups" && req.method === "GET") {
    requireCan(user, policy, "followup", "read");
    const done = url.searchParams.get("done") || "0",
      scope = url.searchParams.get("scope") || "mine",
      offset = Number(url.searchParams.get("offset") || 0),
      limit = Number(url.searchParams.get("limit") || 50);
    if (
      !["0", "1", "all"].includes(done) ||
      !["mine", "all"].includes(scope) ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 1000000 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      fail(422, "跟进筛选参数不正确", "validation_failed");
    const data = await r.inboxFollowups(
      done === "all" ? -1 : Number(done),
      scope,
      user.id,
      url.searchParams.get("student_id") || "",
      offset,
      limit,
    );
    return json({
      ...data,
      items: data.items.map(taskDto),
      next_offset: offset + limit < data.total ? offset + limit : null,
    });
  }
  const followup = /^\/api\/todo\/followups\/([^/]+)$/.exec(path);
  if (followup && req.method === "PATCH") {
    requireCan(user, policy, "followup", "update");
    const d = await body(req),
      revision = await r.dataVersion(),
      old = await r.businessGet("followup_tasks", followup[1]);
    if (!old) fail(404, "跟进任务不存在", "not_found");
    if (version(d.version) !== old.version)
      fail(409, "任务已变化，请刷新", "version_conflict");
    const next = { ...old };
    if (d.done !== undefined) {
      if (typeof d.done !== "boolean")
        fail(422, "done必须为布尔值", "validation_failed");
      next.done = Number(d.done);
    }
    if (d.assignee_id !== undefined) {
      if (d.assignee_id !== null) {
        const u = await r.user(d.assignee_id);
        if (
          !u ||
          u.active !== 1 ||
          !JSON.parse(u.roles).some((x) =>
            ["supervisor", "academic", "finance"].includes(x),
          )
        )
          fail(404, "负责人不存在或不可指派", "not_found");
      }
      next.assignee_id = d.assignee_id;
    }
    if (d.due_date !== undefined) next.due_date = day(d.due_date);
    if (!["done", "assignee_id", "due_date"].some((k) => d[k] !== undefined))
      fail(422, "请提供指派、完成状态或到期日", "validation_failed");
    await r.commitBusiness(
      revision,
      [{ resource: "followup_tasks", previous: old, data: next }],
      user,
      "followup",
      "update",
    );
    return json({
      record: taskDto(await r.businessGet("followup_tasks", old.id)),
    });
  }
  const skip = /^\/api\/todo\/makeups\/([^/]+)\/skip$/.exec(path);
  if (skip && req.method === "POST") {
    requireCan(user, policy, "attendance", "update");
    const d = await body(req),
      revision = await r.dataVersion(),
      part = await r.businessGet("lesson_participants", skip[1]);
    if (!part) fail(404, "请假记录不存在", "not_found");
    if (version(d.version) !== part.version)
      fail(409, "请假记录已变化", "version_conflict");
    if (
      !Number.isSafeInteger(d.decision_version) ||
      d.decision_version < 0 ||
      typeof d.skip !== "boolean"
    )
      fail(422, "请提供skip和decision_version", "validation_failed");
    if (
      part.makeup_for ||
      !["student_leave", "teacher_leave"].includes(part.attendance)
    )
      fail(409, "该条记录不属于待补课请假", "makeup_not_pending");
    const lesson = await r.businessGet("lessons", part.lesson_id);
    if (!lesson) fail(404, "课程不存在", "not_found");
    if (d.skip && (await r.hasActiveMakeup(part.id)))
      fail(409, "已安排有效补课，不能标记不补", "makeup_already_scheduled");
    const record = await r.skipMakeup(
      part,
      d.decision_version,
      d.skip,
      string(d.reason ?? "", "不补说明", 1000, 0),
      revision,
      user,
    );
    return json({
      ok: true,
      record: {
        id: part.id,
        original_participant_id: part.id,
        skipped: !!record.skipped,
        reason: record.reason,
        version: record.version,
        participant_version: part.version,
      },
    });
  }
  if (path === "/api/renewals/generate" && req.method === "POST") {
    requireCan(user, policy, "packages", "read");
    requireCan(user, policy, "exports", "export");
    const d = await body(req);
    if (!Array.isArray(d.items) || !d.items.length || d.items.length > 100)
      fail(422, "每批选择1到100条续费待办", "validation_failed");
    const keys = d.items.map((x) => {
      if (
        !x ||
        typeof x.student_id !== "string" ||
        !["type", "category"].includes(x.scope_kind) ||
        typeof x.scope_id !== "string"
      )
        fail(422, "续费范围参数不完整", "validation_failed");
      return JSON.stringify([x.student_id, x.scope_kind, x.scope_id]);
    });
    if (new Set(keys).size !== keys.length)
      fail(422, "请勿重复选择续费条目", "validation_failed");
    const rows = await r.studentRenewalGroups(
      dateBJ(),
      renewalSettings(policy.settings),
      [...new Set(d.items.map((x) => x.student_id))],
    );
    const byId = new Map(rows.map((x) => [x.id, x]));
    const items = keys.map((id) => {
      const row = byId.get(id);
      if (!row || row.state === "active")
        fail(409, "续费待办已变化，请刷新", "renewal_changed");
      const [, scope_kind, scope_id] = JSON.parse(id);
      return {
        ...row,
        scope_kind,
        scope_id,
        text: `${row.student_name}的${row.course_name}剩余${row.balance}课时，请联系教务续费。`,
      };
    });
    const b = await r.brand();
    await r.audit(
      user,
      "exports",
      "export",
      null,
      "批量生成" + items.length + "条续费提醒（未发送）",
    );
    return json({
      items,
      total: items.length,
      generated_at: now(),
      brand: {
        display_name: b.display_name,
        logo: b.logo,
        theme_color: b.theme_color,
        consultant_qr: b.consultant_qr,
        contact_text: await decrypt(
          env,
          b.contact_text,
          resolved.tenant.id + ":contact",
        ),
      },
    });
  }
  fail(404, "不存在", "not_found");
}
