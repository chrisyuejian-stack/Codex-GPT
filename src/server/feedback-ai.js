import { fail, randomId, now } from "./core.js";

import { can } from "./permissions.js";

import { text, ids, object } from "./tool-validation.js";

import { privateSafe } from "./ai-context.js";

import { lessonWindow } from "./presentation.js";

import { feedbackMessage } from "./growth-feedback.js";

export function feedbackProtocol() {
  return '只返回JSON {"suggestions":[{"payload":{},"basis":[{"type":"feedback","ref":"给定ref","date":"反馈日期","quote":"原话"}],"warnings":[]}]}。只整理当前老师给定原文，不编造事实，不与其他学员比较，不给分数或统计数字字段。payload={message:{learned,good,attention,homework}}，只整理本次tags/repertoire/note。';
}

const paragraphs = (value) =>
  typeof value === "string"
    ? value
        .split(/[。！!？?\n]+/)
        .map((x) => x.trim())
        .filter(Boolean)
    : Array.isArray(value)
      ? value.flatMap(paragraphs)
      : value && typeof value === "object"
        ? Object.values(value).flatMap(paragraphs)
        : [];

function permission(u, p, ctx) {
  if (
    !can(u, p, "ai", "use", {
      tool: "feedback",
      teacher_id: ctx.teacher_id,
    }) ||
    !can(u, p, "feedback", "write", {
      teacher_id: ctx.teacher_id,
    })
  )
    fail(403, "没有此操作权限", "forbidden");
}

export async function feedbackAiContext(r, tool, action, d, u, p) {
  const ctx = {
    tool: tool,
    action: action,
    refs: {},
    dates: {},
    instruction: text(d.instruction ?? "", "instruction", 1e4),
  };

  const lessonId = text(d.lesson_id, "lesson_id", 100, false),
    studentId = text(d.student_id, "student_id", 100, false),
    view = await r.reviewContext(lessonId, null, false, u.teacher_id),
    lesson = view.lessons[0];
  if (!lesson || !view.participants.some((x) => x.student_id === studentId))
    fail(404, "不存在", "not_found");
  if (!u.roles.includes("teacher") || lesson.teacher_id !== u.teacher_id)
    fail(403, "仅主讲老师可用", "forbidden");
  if (!lessonWindow(lesson, now()).open || view.settlements[0]?.locked)
    fail(403, "不在可提交窗口", "forbidden");
  const student = await r.growthStudent(studentId, u.teacher_id);
  if (!student) fail(404, "不存在", "not_found");
  const tags = ids(d.tags ?? [], "tags", 30),
    repIds = ids(d.repertoire_ids ?? [], "repertoire_ids", 100),
    refs = await r.growthFeedbackRefs([studentId], repIds, []);
  if (
    refs.repertoire.length !== repIds.length ||
    refs.repertoire.some((x) => x.student_id !== studentId)
  )
    fail(404, "不存在", "not_found");
  const note = text(d.note ?? "", "note", 12e3),
    ref = "draft_feedback:" + lessonId + ":" + studentId;
  ctx.target = {
    lesson_id: lessonId,
    student_id: studentId,
  };
  ctx.teacher_id = lesson.teacher_id;
  ctx.refs[ref] = privateSafe(
    [...tags, ...refs.repertoire.map((x) => x.name), note].join("\n"),
    student,
  );
  ctx.dates[ref] = lesson.start_at.slice(0, 10);
  ctx.public = {
    student: {
      nickname: student.nickname,
    },
    tags: privateSafe(tags, student),
    repertoire: refs.repertoire.map((x) => ({
      id: x.id,
      name: x.name,
    })),
    note: privateSafe(note, student),
  };
  ctx.instruction = privateSafe(ctx.instruction, student);

  permission(u, p, ctx);
  return ctx;
}

export function filterFeedbackAi(parsed, ctx) {
  const warnings = [],
    suggestions = [];
  for (const raw of parsed.suggestions) {
    try {
      const payload = object(raw.payload, "payload");
      if (
        /"(?:score|scores|stats|previous|mock_exams)"\s*:/.test(
          JSON.stringify(payload),
        )
      )
        warnings.push("已剔除模型提供的评分或统计字段");
      let safe;
      safe = {
        message: feedbackMessage(payload.message),
      };
      const basis = [];
      for (const b of Array.isArray(raw.basis) ? raw.basis.slice(0, 100) : []) {
        const quote = typeof b?.quote === "string" ? b.quote : "",
          ref = b?.ref;
        if (
          b?.type === "feedback" &&
          typeof ref === "string" &&
          ctx.refs[ref] &&
          quote &&
          ctx.refs[ref].includes(quote)
        ) {
          basis.push({
            type: "feedback",
            ref: ref,
            date: ctx.dates[ref],
            quote: quote,
          });
        } else
          basis.push({
            type: "unsupported",
            text: "模型依据无法从本次老师原文核对",
          });
      }
      const sentences = paragraphs(safe);
      for (const sentence of sentences) {
        const match = Object.entries(ctx.refs).find(([, source]) =>
          source.includes(sentence),
        );
        if (match) {
          const [ref] = match;
          if (
            !basis.some(
              (x) =>
                x.type === "feedback" && x.ref === ref && x.quote === sentence,
            )
          )
            basis.push({
              type: "feedback",
              ref: ref,
              date: ctx.dates[ref],
              quote: sentence,
            });
        } else
          basis.push({
            type: "unsupported",
            text: sentence,
          });
      }
      if (
        sentences.some((x) =>
          /(其他同学|全班最|比.{0,12}同学|全班排名)/.test(x),
        )
      ) {
        warnings.push("已丢弃与其他学员比较的建议");
        continue;
      }
      if (!sentences.length) {
        warnings.push("已丢弃空文字建议");
        continue;
      }
      const own = basis.some((x) => x.type === "unsupported")
        ? ["资料里找不到依据的文字需要人工核对"]
        : [];
      suggestions.push({
        id: randomId("sg"),
        kind: "feedback.message",
        target: ctx.target,
        payload: safe,
        basis: basis,
        warnings: own,
      });
      warnings.push(...own);
    } catch {
      warnings.push("已丢弃格式不正确的反馈建议");
    }
  }
  if (!suggestions.length && !warnings.length)
    warnings.push("没有符合本次资料的建议");
  return {
    suggestions: suggestions,
    warnings: [...new Set(warnings)],
  };
}
