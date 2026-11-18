import { HttpError } from "./core.js";
// Server-only bounded deadlines and safe failure labels. Never persist model text.
export function aiTimeoutMs(tool, action, tier) {
  return tier === "fast" ? 45000 : 90000;
}
export function aiMaxTokens(tool, action, tier) {
  return tier === "fast" ? 4096 : 8192;
}
export function aiFault(reason) {
  const e = new Error("AI request failed");
  e.ai_failure_reason = reason;
  return e;
}
export function aiFailureReason(e) {
  if (
    ["AI_DEADLINE", "deadline"].includes(e?.message) ||
    ["AbortError", "TimeoutError"].includes(e?.name)
  )
    return "timeout";
  if (e?.message === "AI_PROTOCOL_INVALID") return "protocol_invalid";
  if (e?.message === "AI_RESPONSE_SIZE") return "response_too_large";
  const code = e?.ai_failure_reason;
  if (
    ["timeout", "protocol_invalid", "response_too_large", "other"].includes(
      code,
    ) ||
    /^provider_http_[1-5]\d\d$/.test(code || "")
  )
    return code;
  if (
    !(e instanceof HttpError) &&
    Number.isInteger(e?.status) &&
    e.status >= 100 &&
    e.status <= 599
  )
    return "provider_http_" + e.status;
  return "other";
}
