import { bytes, b64, unb64, textBytes, fail, phone } from "./core.js";
export async function hmac(key, value) {
  const k = await crypto.subtle.importKey(
    "raw",
    textBytes(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return b64(await crypto.subtle.sign("HMAC", k, textBytes(value)));
}
export const phoneIndex = (env, tenantId, value) =>
  hmac(env.HMAC_KEY, tenantId + ":" + phone(value));

export async function encrypt(env, value, context) {
  if (value === null || value === undefined || value === "") return null;
  const iv = bytes(12),
    key = await crypto.subtle.importKey(
      "raw",
      unb64(env.FIELD_KEY),
      "AES-GCM",
      false,
      ["encrypt"],
    );
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: textBytes(context) },
    key,
    textBytes(value),
  );
  return "v1." + b64(iv) + "." + b64(cipher);
}
export async function decrypt(env, value, context) {
  if (!value) return "";
  const [v, iv, data] = value.split(".");
  if (v !== "v1") throw Error("cipher version");
  const key = await crypto.subtle.importKey(
    "raw",
    unb64(env.FIELD_KEY),
    "AES-GCM",
    false,
    ["decrypt"],
  );
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(iv), additionalData: textBytes(context) },
      key,
      unb64(data),
    ),
  );
}
export async function digestPassword(env, password, salt) {
  const peppered = await hmac(env.PW_PEPPER, password);
  const key = await crypto.subtle.importKey(
    "raw",
    textBytes(peppered),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return b64(
    await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: unb64(salt),
        iterations: 100000,
        hash: "SHA-256",
      },
      key,
      256,
    ),
  );
}
export async function newPassword(env, password) {
  const salt = b64(bytes(16));
  return { salt, digest: await digestPassword(env, password, salt) };
}
// 常见弱口令词根及常见数字组合，实际生成 2000+ 个拒绝项；不将正常测试密码写入生产。
const weak = new Set([
  "password1",
  "password123",
  "qwerty123",
  "admin123",
  "a123456789",
  "12345678a",
  "abc123456",
  "123456abc",
  "woaini520",
  "iloveyou1",
  "welcome123",
  "password1234",
]);
for (const root of [
  "password",
  "qwerty",
  "admin",
  "welcome",
  "letmein",
  "abc",
  "abcdef",
  "iloveyou",
  "woaini",
  "zxcvbn",
  "asdfgh",
  "qazwsx",
])
  for (let n = 0; n < 200; n++) weak.add(root + n);
for (const root of [
  "12345678",
  "123456789",
  "1234567890",
  "87654321",
  "11111111",
  "00000000",
  "88888888",
  "66666666",
])
  for (const c of "abcdefghijklmnopqrstuvwxyz") {
    weak.add(c + root);
    weak.add(root + c);
  }
export const weakPasswordCount = weak.size;
export function validatePassword(password, mobile = "") {
  if (
    typeof password !== "string" ||
    password.length < 8 ||
    password.length > 64 ||
    !/[a-z]/i.test(password) ||
    !/[0-9]/.test(password) ||
    weak.has(password.toLowerCase()) ||
    (mobile &&
      /\d{4,}/g.test(password) &&
      [...password.matchAll(/\d{4,}/g)].some((m) => mobile.includes(m[0])))
  )
    fail(400, "密码须为 8–64 位，含字母和数字，不能使用弱密码或手机号片段");
}
export function temporaryPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 10; i++) out += alphabet[bytes(1)[0] % alphabet.length];
  if (!/[0-9]/.test(out) || !/[a-z]/i.test(out)) return temporaryPassword();
  return out;
}
const alphabet32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
