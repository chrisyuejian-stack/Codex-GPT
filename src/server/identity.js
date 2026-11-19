export const identityLabels = {
  school_db: "院校库",
  prices: "报价价格",
  feedback: "课后反馈",
  ai: "AI工具",
  usage: "AI用量",
};
export function identityErrorCode(error) {
  const map = {
    REQUEST_REJECTED: "bad_request",
    SESSION_INVALID: "unauthenticated",
    LOGIN_FAILED: "unauthenticated",
    PERMISSION_DENIED: "forbidden",
    PASSWORD_CHANGE_REQUIRED: "forbidden",
    CONFLICT: "version_conflict",
  };
  return (
    map[error.code] ||
    (error.code && /^[a-z_]+$/.test(error.code)
      ? error.code
      : {
          400: "bad_request",
          401: "unauthenticated",
          403: "forbidden",
          404: "not_found",
          409: "version_conflict",
          422: "validation_failed",
          429: "rate_limited",
          503: "configuration_missing",
        }[error.status] || "internal_error")
  );
}
