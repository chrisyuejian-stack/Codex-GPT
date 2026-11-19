import {
  fail,
  now,
  bytes,
  b64,
  sha,
  equal,
  clientInfo,
  json,
  string,
} from "./core.js";
import { repo } from "./repo.js";
import {
  phoneIndex,
  digestPassword,
  newPassword,
  decrypt,
  validatePassword,
} from "./crypto.js";
import { publicUser } from "./permissions.js";
export const cookieName = "__Host-fengqin_session";
export function readCookie(req, name = cookieName) {
  const values = (req.headers.get("cookie") || "")
    .split(";")
    .map((x) => x.trim())
    .filter((x) => x.startsWith(name + "="));
  return values.length === 1 ? values[0].slice(name.length + 1) : "";
}
export const sessionCookie = (token, base = "/", personal = false) =>
  cookieName +
  "=" +
  token +
  "; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=" +
  (personal ? 1209600 : 43200);
export const clearCookie = () =>
  cookieName + "=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0";
export async function tenantSessionHash(req) {
  const token = readCookie(req);
  return /^[A-Za-z0-9+/]{43}=$/.test(token) ? sha(token) : null;
}
export async function authenticate(
  req,
  env,
  tenant,
  base = "/",
  resolved = null,
) {
  const hash = resolved?.hash ?? (await tenantSessionHash(req));
  if (!hash) fail(401, "请重新登录", "SESSION_INVALID");
  const r = repo(env, tenant.id),
    u =
      resolved?.auth === undefined
        ? await r.authenticateRequest(hash)
        : resolved.auth;
  if (
    !u ||
    u.tenant_id !== tenant.id ||
    u.expires_at <= now() ||
    (u.idle_ms && u.last_seen_at + u.idle_ms <= now())
  ) {
    await r.revokeSession(hash);
    fail(401, "请重新登录", "SESSION_INVALID");
  }
  u.roles = typeof u.roles === "string" ? JSON.parse(u.roles) : u.roles;
  if (
    u.roles.includes("parent") ||
    (u.roles.includes("student") && !u.student_id)
  )
    fail(401, "账号关联不可用", "SESSION_INVALID");
  u.token_hash = hash;
  return u;
}
export async function loginTenant(req, env, tenant, base, data) {
  const r = repo(env, tenant.id),
    info = clientInfo(req);
  string(data.phone, "手机号", 64);
  string(data.password, "密码", 256);
  const valid = /^1[3-9]\d{9}$/.test(data.phone),
    index = await phoneIndex(
      env,
      tenant.id,
      valid ? data.phone : "13800000000",
    ),
    key = "login:" + tenant.id + ":" + index,
    ipKey = "login-ip:" + info.ip;
  const locked = await r.tenantLoginLimited(key, ipKey, 20, 100);
  if (locked) fail(429, "登录尝试过多，请稍后重试", "rate_limited");
  const u = await r.userByPhone(index),
    computed = await digestPassword(
      env,
      data.password,
      u?.salt || "AAAAAAAAAAAAAAAAAAAAAA==",
    );
  if (
    !valid ||
    !u ||
    !u.active ||
    JSON.parse(u.roles).includes("parent") ||
    !equal(computed, u.digest)
  ) {
    await r.tenantLoginLimited(key, ipKey, 20, 100, true);
    await r.authEvent(
      u?.id,
      valid ? data.phone.slice(-4) : null,
      "login_failed",
      info,
    );
    fail(401, "手机号或密码不正确", "LOGIN_FAILED");
  }
  await r.clearLimit(key);
  const token = b64(bytes(32));
  await r.createSession(await sha(token), u, info);
  await r.authEvent(u.id, u.phone_last4, "login_success", info);
  return json(
    { user: publicUser(u), must_change: !!u.must_change, api_base: "/api" },
    200,
    {
      "Set-Cookie": sessionCookie(
        token,
        "/",
        JSON.parse(u.roles).some((x) => ["teacher", "student"].includes(x)),
      ),
    },
  );
}
export async function changeTenantPassword(env, tenant, user, data) {
  const r = repo(env, tenant.id),
    stored = await r.user(user.id);
  string(data.old_password, "原密码", 256);
  const digest = await digestPassword(env, data.old_password, stored.salt);
  if (!equal(digest, stored.digest)) fail(400, "原密码不正确");
  const mobile = await decrypt(env, stored.phone_enc, tenant.id + ":phone");
  validatePassword(data.password, mobile);
  if (equal(data.old_password, data.password))
    fail(400, "新密码不能与原密码相同");
  await r.password(
    user.id,
    stored.version,
    await newPassword(env, data.password),
    user,
    0,
  );
}
