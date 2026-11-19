import { fail } from "./core.js";

function quota(value, fallback, key) {
  if (value === undefined || value === "") return fallback;
  const n =
    typeof value === "number"
      ? value
      : /^\d+$/.test(value)
        ? Number(value)
        : NaN;
  if (!Number.isSafeInteger(n) || n < 0 || n > 1000000)
    fail(503, key + " 必须为0到1000000的整数", "CONFIG_INVALID");
  return n;
}
export function effectiveAIConfig(env, row) {
  if (!row) fail(503, "AI设置尚未初始化", "configuration_missing");
  const configured = !!row.configured;
  return {
    ...row,
    fast_model: configured
      ? row.fast_model
      : env.AI_FAST_MODEL || "deepseek-chat",
    deep_model: configured
      ? row.deep_model
      : env.AI_DEEP_MODEL || "deepseek-reasoner",
    fast_limit: configured
      ? row.fast_daily_limit
      : quota(env.AI_FAST_DAILY_LIMIT, 80, "AI_FAST_DAILY_LIMIT"),
    deep_limit: configured
      ? row.deep_daily_limit
      : quota(env.AI_DEEP_DAILY_LIMIT, 50, "AI_DEEP_DAILY_LIMIT"),
  };
}
