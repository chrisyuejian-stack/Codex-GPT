import { randomId } from "./core.js";
import { text, object } from "./tool-validation.js";
import { validateSettingProposal } from "./tool-settings.js";

const scoreKey = (k) =>
  /^(scores?|ratings?|previous|mock_exams|评分|分数|得分)$/i.test(k);

function stripScores(v, warnings) {
  if (Array.isArray(v)) return v.map((x) => stripScores(x, warnings));
  if (!v || typeof v !== "object") return v;
  const out = {};
  for (const [key, value] of Object.entries(v))
    if (scoreKey(key)) {
      warnings.push("已剔除AI返回的分数字段");
    } else out[key] = stripScores(value, warnings);
  return out;
}

function plain(v, max = 2e3) {
  return text(v ?? "", "AI文字", max);
}

function basisFor(raw, ctx, warnings) {
  const out = [];
  for (const item of Array.isArray(raw) ? raw.slice(0, 100) : []) {
    if (!item || typeof item !== "object") {
      out.push({
        type: "unsupported",
        text: "模型依据格式无效",
      });
      continue;
    }
    const type = item.type;
    if (
      ![
        "rule",
        "consult",
        "feedback",
        "profile",
        "ai_judgement",
        "unsupported",
      ].includes(type)
    ) {
      out.push({
        type: "unsupported",
        text: "模型依据类型无效",
      });
      continue;
    }
    let entry = {
      type: type,
    };
    if (type === "ai_judgement" || type === "unsupported") {
      entry.text = plain(item.text);
      out.push(entry);
      continue;
    }
    const ref =
        typeof item.ref === "string"
          ? item.ref
          : type === "consult"
            ? "consult"
            : null,
      source = ref ? ctx.refs[ref] : null,
      quote = typeof item.quote === "string" ? item.quote : "";
    if (
      !source ||
      (quote && !source.includes(quote)) ||
      (!quote && item.text && !source.includes(String(item.text)))
    ) {
      out.push({
        type: "unsupported",
        text: "所标依据无法在本次勾选资料中核对：" + plain(item.text || quote),
      });
      warnings.push("已将无法核验的引用标为unsupported");
      continue;
    }
    entry = {
      type: type,
      ref: ref,
      ...(quote
        ? {
            quote: plain(quote),
          }
        : {}),
      ...(item.text
        ? {
            text: plain(item.text),
          }
        : {}),
    };
    out.push(entry);
  }
  return out;
}

export async function filterAi(parsed, ctx, r) {
  const warnings = [],
    safe = stripScores(parsed, warnings),
    kind = "settings.change",
    items = [];
  for (const raw of safe.suggestions) {
    try {
      const payload = object(raw.payload, "payload");
      if (
        !Array.isArray(payload.ops) ||
        !payload.ops.length ||
        payload.ops.length > 8
      )
        throw Error("ops");
      const validated = await validateSettingProposal(r, payload);
      items.push({
        raw: raw,
        payload: validated.payload,
        target_versions: validated.target_versions,
      });
    } catch (e) {
      warnings.push("已丢弃无法校验或目标已变化的设置建议");
    }
  }
  const suggestions = [];
  for (const item of items.slice(0, 20)) {
    const ownWarnings = [];
    let basis;
    try {
      basis = basisFor(item.raw.basis, ctx, ownWarnings);
    } catch {
      basis = [
        {
          type: "unsupported",
          text: "模型提供的依据无法核验",
        },
      ];
      ownWarnings.push("已将格式错误的依据标为unsupported");
    }

    suggestions.push({
      id: randomId("sg"),
      kind: kind,
      target: ctx.target,
      payload: item.payload,
      basis: basis,
      warnings: ownWarnings,
      ...(item.target_versions
        ? {
            target_versions: item.target_versions,
          }
        : {}),
    });
    warnings.push(...ownWarnings);
  }
  if (!suggestions.length && !warnings.length)
    warnings.push("未找到符合本次条件的建议，请调整资料后再试");
  return {
    suggestions: suggestions,
    warnings: [...new Set(warnings)],
  };
}
