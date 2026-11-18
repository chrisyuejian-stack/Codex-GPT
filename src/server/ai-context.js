import { text } from "./tool-validation.js";

export function privateSafe(value, student = null) {
  if (Array.isArray(value)) return value.map((x) => privateSafe(x, student));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([k]) =>
            !/(phone|password|secret|token|phone_enc|parent_consent)/i.test(k),
        )
        .map(([k, v]) => [k, privateSafe(v, student)]),
    );
  if (typeof value === "string") {
    let v = value
      .replace(/(?:\+?86[- ]?)?1[3-9]\d{9}/g, "[手机号已隐去]")
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[邮箱已隐去]");
    if (student?.name && student.name !== student.nickname)
      v = v.replaceAll(student.name, student.nickname || "同学");
    return v;
  }
  return value;
}

function references(value, prefix, out) {
  if (Array.isArray(value))
    value.forEach((v, i) => references(v, prefix + "." + i, out));
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value))
      references(v, prefix ? prefix + "." + k : k, out);
  else if (value !== null && value !== undefined && String(value) !== "")
    out[prefix] = String(value);
}

// Extension point: implement repository-backed school lookup here when the院校数据库 is connected.
// Only server-selected records belong in this context; client-provided facts are never trusted.
export async function schoolDatabaseContext(r, input, user) {
  return { schools: [], refs: {} };
}

export async function aiContext(r, tool, action, input, user, policy) {
  const catalog = await r.aiCatalog();
  const ctx = {
    tool,
    action,
    instruction: privateSafe(
      text(input.instruction ?? "", "instruction", 10000),
    ),
    target: {},
    refs: {},
    warnings: [],
    catalog,
  };
  ctx.public = {
    courses: catalog.courses.map((x) => ({
      id: x.id,
      version: x.version,
      ...JSON.parse(x.doc_json),
      price_cents: x.price_cents,
    })),
    stages: catalog.stages.map((x) => ({
      id: x.id,
      version: x.version,
      ...JSON.parse(x.doc_json),
    })),
    settings: catalog.settings,
    report_classes: catalog.report_classes.map((x) => ({
      id: x.id,
      version: x.version,
      ...JSON.parse(x.doc_json),
    })),
  };
  for (const [key, data] of Object.entries(catalog.settings))
    references(data, key, ctx.refs);
  const schools = await schoolDatabaseContext(r, input, user);
  ctx.public.schools = schools.schools;
  Object.assign(ctx.refs, schools.refs);
  ctx.public = privateSafe(ctx.public);
  ctx.refs = privateSafe(ctx.refs);
  return ctx;
}
