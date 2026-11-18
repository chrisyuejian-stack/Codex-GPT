import { HttpError } from "./core.js";

export function invalid(message, field = "body") {
  const e = new HttpError(422, message, "validation_failed");
  e.details = {
    fields: [
      {
        field: field,
        message: message,
      },
    ],
  };
  throw e;
}

export function text(v, field, max = 2e3, empty = true) {
  if (
    typeof v !== "string" ||
    v.length > max ||
    (!empty && !v.trim()) ||
    /<\/?[a-z!][^>]*>/i.test(v)
  )
    invalid("请使用符合长度限制的纯文字，不要包含HTML标签", field);
  return v.trim();
}

export function object(v, field) {
  if (!v || typeof v !== "object" || Array.isArray(v))
    invalid("须为对象", field);
  return v;
}

export function list(v, field, max = 100) {
  if (!Array.isArray(v) || v.length > max)
    invalid("数组格式或数量不正确", field);
  return v;
}

export function ids(v, field, max = 100) {
  const a = list(v, field, max).map((x) => text(x, field, 100, false));
  if (new Set(a).size !== a.length) invalid("编号不能重复", field);
  return a;
}

export function dateValue(value, field = "date") {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value + "T00:00:00Z")) ||
    new Date(value + "T00:00:00Z").toISOString().slice(0, 10) !== value
  )
    invalid("日期不正确", field);
  return Date.parse(value + "T00:00:00Z");
}

export const beijingIso = (at) =>
  new Date(at + 8 * 36e5).toISOString().replace("Z", "+08:00");
