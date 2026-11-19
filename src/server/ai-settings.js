import { repo } from "./repo.js";
import { body, json, fail } from "./core.js";
import { text, invalid } from "./tool-validation.js";

export async function aiSettingsApi(req, env, resolved, user) {
  if (resolved.relative !== "/api/settings/ai") return undefined;
  if (!user.roles.includes("supervisor"))
    fail(403, "仅主管可管理AI设置", "forbidden");
  const r = repo(env, resolved.tenant.id),
    view = async () => {
      const c = await r.aiConfig();
      return {
        version: c.version,
        source: c.configured ? "internal" : "environment",
        fast_model: c.fast_model,
        deep_model: c.deep_model,
        fast_daily_limit: c.fast_limit,
        deep_daily_limit: c.deep_limit,
      };
    };
  if (req.method === "GET") return json(await view());
  if (req.method !== "PUT") fail(404, "不存在", "not_found");
  const d = await body(req);
  if (!Number.isInteger(d.version) || d.version < 1)
    invalid("版本不正确", "version");
  if (d.use_environment !== undefined && typeof d.use_environment !== "boolean")
    invalid("须为布尔值", "use_environment");
  const old = await r.aiSettings(),
    value = {
      ...old,
      version: d.version,
      configured: d.use_environment !== true,
    };
  if (value.configured) {
    for (const tier of ["fast", "deep"]) {
      const limit = d[tier + "_daily_limit"];
      if (!Number.isInteger(limit) || limit < 0 || limit > 1000000)
        invalid("每日额度须为0到1000000的整数", tier + "_daily_limit");
      value[tier + "_daily_limit"] = limit;
      value[tier + "_model"] = text(
        d[tier + "_model"],
        tier + "_model",
        200,
        false,
      );
    }
  }
  await r.saveAISettings(value, user);
  return json(await view());
}
