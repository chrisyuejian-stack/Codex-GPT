import { repo } from "./repo.js";

import { body, json, fail, randomId, now, version } from "./core.js";

import { can } from "./permissions.js";

import { text, ids, invalid } from "./tool-validation.js";

import { dateValue } from "./tool-validation.js";

import { beijingIso } from "./tool-validation.js";

import { lessonWindow } from "./presentation.js";

export const feedbackPath = (p) =>
  /^\/api\/(?:feedback\/(?:today|[^/]+\/[^/]+\/copied)|students\/[^/]+\/repertoire(?:\/[^/]+)?|parent\/(?:children\/[^/]+\/feed|media\/[^/]+))$/.test(
    p,
  );
const personal = (u) => u.roles.some((x) => ["student", "parent"].includes(x));
const teacher = (u) => u.roles.includes("teacher");
const staff = (u) =>
  u.roles.some((x) => ["supervisor", "academic"].includes(x));
export async function feedbackApi(req, env, resolved, u, p, url) {
  const path = resolved.relative;
  if (!feedbackPath(path)) return undefined;
  if (!p.modules.feedback) fail(404, "不存在", "not_found");
  const r = repo(env, resolved.tenant.id);
  const family =
    /^\/api\/parent\/(?:children\/([^/]+)\/feed|media\/([^/]+))$/.exec(path);
  if (family) {
    if (req.method !== "GET" || !personal(u))
      fail(403, "没有权限", "forbidden");
    const children = await r.feedbackChildIds(u);
    if (family[1]) {
      if (!children.includes(family[1])) fail(404, "不存在", "not_found");
      const offset = Number(url.searchParams.get("offset") || 0),
        limit = Number(url.searchParams.get("limit") || 50);
      if (
        !Number.isInteger(offset) ||
        offset < 0 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 200
      )
        invalid("分页不正确");
      const student = await r.growthStudent(family[1]);
      const data = await r.feedbackFeed(student.id, offset, limit),
        base = resolved.root
          ? "/api"
          : resolved.base.replace(/\/$/, "") + "/api";
      return json({
        ...data,
        items: data.items.map((x) => {
          const d = JSON.parse(x.doc_json);
          return {
            ...x,
            at: beijingIso(x.at),
            message: d.message,
            tags: d.tags,
            repertoire_ids: d.repertoire_ids || [],
            public_comment: d.public_text || "",
            image_ids: student.parent_consent_media ? d.image_ids || [] : [],
            image_urls: student.parent_consent_media
              ? (d.image_ids || []).map(
                  (id) => base + "/parent/media/" + encodeURIComponent(id),
                )
              : [],
            doc_json: undefined,
          };
        }),
        next_offset: offset + limit < data.total ? offset + limit : null,
      });
    }
    const image = await r.feedbackParentMedia(family[2], children);
    if (!image) fail(404, "不存在", "not_found");
    const file = await env.CHANNEL_MEDIA.get(image.r2_key);
    if (!file) fail(404, "不存在", "not_found");
    return new Response(
      Uint8Array.from(atob(await file.text()), (c) => c.charCodeAt(0)),
      {
        headers: {
          "Content-Type": image.mime,
          "Cache-Control": "private, no-store",
        },
      },
    );
  }
  if (path === "/api/feedback/today" && req.method === "GET") {
    if (!teacher(u)) fail(403, "仅老师可用", "forbidden");
    const day = new Date(now()).toLocaleDateString("sv-SE", {
        timeZone: "Asia/Shanghai",
      }),
      to = new Date(Date.parse(day + "T00:00:00Z") + 864e5)
        .toISOString()
        .slice(0, 10);
    return json({
      items: (await r.growthToday(u.teacher_id, day, to)).map((x) => ({
        ...x,
        status: x.submission_status || "not_submitted",
        can_submit:
          x.teacher_id === u.teacher_id &&
          lessonWindow(x, now()).open &&
          !x.locked &&
          x.lesson_status === "planned" &&
          can(u, p, "attendance", "submit", x),
        can_submit_comments:
          x.teacher_id === u.teacher_id &&
          lessonWindow(x, now()).open &&
          !x.locked &&
          x.lesson_status !== "planned" &&
          can(u, p, "comments", "create", x),
      })),
    });
  }
  const copied = /^\/api\/feedback\/([^/]+)\/([^/]+)\/copied$/.exec(path);
  if (copied && req.method === "POST") {
    const result = await r.growthCopied(copied[1], copied[2], u);
    if (!result) fail(404, "不存在", "not_found");
    if (
      !can(u, p, "feedback", "write", result.row) &&
      !can(u, p, "feedback", "confirm", result.row)
    )
      fail(403, "没有权限", "forbidden");
    if (result.row.status !== "confirmed" || !result.current)
      fail(409, "仅可复制当前已确认版本", "invalid_state");
    await r.growthRecordCopy(result.row, u);
    return json({
      ok: true,
    });
  }
  const rep = /^\/api\/students\/([^/]+)\/repertoire(?:\/([^/]+))?$/.exec(path);
  if (rep) {
    const student = await r.growthStudent(
      rep[1],
      teacher(u) ? u.teacher_id : null,
    );
    if (!student) fail(404, "不存在", "not_found");
    if (!(
      staff(u) ||
      teacher(u) ||
      (req.method === "GET" && u.roles.includes("consultant"))
    ))
      fail(403, "没有权限", "forbidden");
    if (personal(u)) fail(403, "没有权限", "forbidden");
    const rows = await r.growthRepertoire(student.id),
      dto = (x) => ({
        id: x.id,
        student_id: x.student_id,
        name: x.name,
        status: x.status,
        start_date: x.start_date,
        completed_date: x.completed_date,
        image_ids: JSON.parse(x.image_ids_json),
        version: x.version,
      });
    if (req.method === "GET" && !rep[2])
      return json({
        items: rows.map(dto),
      });
    if (!["POST", "PUT"].includes(req.method)) fail(404, "不存在", "not_found");
    const d = await body(req),
      old = rep[2]
        ? rows.find((x) => x.id === rep[2])
        : req.method === "PUT"
          ? rows.find((x) => x.id === d.id)
          : null;
    if ((rep[2] || req.method === "PUT") && !old)
      fail(404, "不存在", "not_found");
    if (old && version(d.version) !== old.version)
      fail(409, "曲目已被修改，请刷新", "version_conflict");
    const value = {
      ...old,
      id: old?.id || randomId("rep"),
      student_id: student.id,
      name: text(d.name ?? old?.name, "name", 200, false),
      status: d.status ?? old?.status ?? "learning",
      start_date:
        d.start_date === undefined ? (old?.start_date ?? null) : d.start_date,
      completed_date:
        d.completed_date === undefined
          ? (old?.completed_date ?? null)
          : d.completed_date,
      image_ids_json: JSON.stringify(
        ids(
          d.image_ids ?? (old ? JSON.parse(old.image_ids_json) : []),
          "image_ids",
          30,
        ),
      ),
      deleted_at: null,
    };
    if (!["learning", "done"].includes(value.status))
      invalid("曲目状态不正确", "status");
    for (const k of ["start_date", "completed_date"])
      if (value[k] !== null) dateValue(value[k]);
    if (value.status === "done" && !value.completed_date)
      invalid("请填写完成日期", "completed_date");
    if (
      value.start_date &&
      value.completed_date &&
      value.start_date > value.completed_date
    )
      invalid("日期顺序不正确");
    const images = JSON.parse(value.image_ids_json),
      refs = await r.growthFeedbackRefs([], [], images);
    if (refs.images.length !== images.length) fail(404, "不存在", "not_found");
    await r.commitBusiness(
      await r.dataVersion(),
      [
        {
          resource: "growth_repertoire",
          previous: old,
          data: value,
        },
      ],
      u,
      "feedback",
      old ? "edit_repertoire" : "create_repertoire",
    );
    return json(
      dto(
        (await r.growthRepertoire(student.id)).find((x) => x.id === value.id),
      ),
      old ? 200 : 201,
    );
  }
  fail(404, "不存在", "not_found");
}
