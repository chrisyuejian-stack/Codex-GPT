import { backupTables } from "./backup-model.js";
import { b64, unb64, bytes, textBytes, sha, fail } from "./core.js";
export const FULL_BACKUP_VERSION = 33;
export const MAX_FULL_BACKUP_BYTES = 16 * 1024 * 1024;
export const fullBackupTables = Object.fromEntries(
  Object.entries(backupTables).filter(
    ([name]) =>
      !["sessions", "security_limits", "backup_runs", "app_state"].includes(
        name,
      ),
  ),
);
export const fullTableSignature = () =>
  sha(
    JSON.stringify(
      Object.entries(fullBackupTables)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, s]) => [name, s.columns]),
    ),
  );
export const environmentFingerprint = (env) => {
  for (const key of ["FIELD_KEY", "HMAC_KEY", "PW_PEPPER"])
    if (typeof env[key] !== "string" || env[key].length < 32)
      fail(
        503,
        "请为备份Worker配置与Pages相同的字段/手机号/密码密钥",
        "CONFIG_MISSING",
      );
  return sha(
    JSON.stringify([
      "fengqin-data-keys-v1",
      env.FIELD_KEY,
      env.HMAC_KEY,
      env.PW_PEPPER,
    ]),
  );
};
const CONTEXT = "fengqin-full-backup-v1";
function passwordInput(password) {
  if (
    typeof password !== "string" ||
    password.trim().length < 12 ||
    password.length > 256
  )
    fail(422, "备份密码须为12到256字符", "invalid_backup_password");
  return password;
}
async function passwordKey(password, salt, iterations) {
  const material = await crypto.subtle.importKey(
    "raw",
    textBytes(passwordInput(password)),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
export async function passwordSeal(payload, password) {
  const plain = textBytes(JSON.stringify(payload));
  if (plain.byteLength > MAX_FULL_BACKUP_BYTES)
    fail(413, "完整备份超过16MiB上限；未导出部分数据", "backup_too_large");
  const salt = bytes(16),
    iv = bytes(12),
    iterations = 100000,
    key = await passwordKey(password, salt, iterations);
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: textBytes(CONTEXT) },
    key,
    plain,
  );
  return {
    format: CONTEXT,
    version: 1,
    kdf: "PBKDF2-SHA256",
    iterations,
    salt: b64(salt),
    iv: b64(iv),
    cipher: b64(cipher),
  };
}
export async function passwordOpen(envelope, password) {
  if (
    !envelope ||
    envelope.format !== CONTEXT ||
    envelope.version !== 1 ||
    envelope.kdf !== "PBKDF2-SHA256" ||
    envelope.iterations !== 100000
  )
    fail(
      422,
      "备份格式不兼容，仅支持枫琴全量备份v1",
      "backup_version_mismatch",
    );
  try {
    const salt = unb64(envelope.salt),
      iv = unb64(envelope.iv),
      cipher = unb64(envelope.cipher);
    if (
      salt.length !== 16 ||
      iv.length !== 12 ||
      cipher.length > MAX_FULL_BACKUP_BYTES + 16
    )
      throw Error("bounds");
    const key = await passwordKey(password, salt, envelope.iterations),
      plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: textBytes(CONTEXT) },
        key,
        cipher,
      );
    return JSON.parse(new TextDecoder().decode(plain));
  } catch (e) {
    if (e.status === 422) throw e;
    fail(400, "备份密码不正确或文件已损坏", "backup_decryption_failed");
  }
}
export async function validateFullPayload(payload, env, tenantId) {
  if (
    !payload ||
    payload.format !== "fengqin-database" ||
    payload.schema_version !== FULL_BACKUP_VERSION ||
    payload.migration_version !== FULL_BACKUP_VERSION ||
    payload.table_signature !== (await fullTableSignature())
  )
    fail(
      422,
      "备份数据库版本不兼容，当前仅支持0033结构",
      "backup_version_mismatch",
    );
  if (payload.tenant_id !== tenantId)
    fail(
      422,
      "备份属于其他固定机构，不能覆盖当前实例",
      "backup_instance_mismatch",
    );
  if (payload.environment_fingerprint !== (await environmentFingerprint(env)))
    fail(
      422,
      "字段加密、手机号索引或密码密钥不一致，请使用原环境密钥",
      "backup_key_mismatch",
    );
  if (
    !Number.isSafeInteger(payload.created_at) ||
    payload.created_at < 0 ||
    !Number.isFinite(new Date(payload.created_at).getTime()) ||
    !payload.tables ||
    typeof payload.tables !== "object" ||
    !Array.isArray(payload.media)
  )
    fail(422, "备份结构不完整", "invalid_backup");
  if (
    Object.keys(payload.tables).sort().join() !==
    Object.keys(fullBackupTables).sort().join()
  )
    fail(422, "备份表清单不完整或包含未知表", "invalid_backup");
  if (
    !payload.counts ||
    Object.keys(payload.counts).sort().join() !==
      Object.keys(fullBackupTables).sort().join()
  )
    fail(422, "备份缺少每表行数", "invalid_backup");
  for (const [name, spec] of Object.entries(fullBackupTables)) {
    const rows = payload.tables[name];
    if (!Array.isArray(rows))
      fail(422, "备份表格式不正确：" + name, "invalid_backup");
    if (payload.counts[name] !== rows.length)
      fail(422, "备份行数与实际内容不一致：" + name, "invalid_backup");
    const seen = new Set();
    for (const row of rows) {
      if (
        !row ||
        typeof row !== "object" ||
        Array.isArray(row) ||
        Object.keys(row).sort().join() !== [...spec.columns].sort().join() ||
        Object.values(row).some(
          (v) => v !== null && !["string", "number"].includes(typeof v),
        )
      )
        fail(422, "备份字段不完整：" + name, "invalid_backup");
      if (spec.tenant && row.tenant_id !== tenantId)
        fail(422, "备份中包含其他机构记录", "invalid_backup");
      const pk =
          spec.pk ||
          (spec.tenant
            ? spec.columns.includes("id")
              ? ["tenant_id", "id"]
              : ["tenant_id"]
            : ["id"]),
        id = JSON.stringify(pk.map((k) => row[k]));
      if (seen.has(id))
        fail(422, "备份包含重复主键：" + name, "invalid_backup");
      seen.add(id);
    }
  }
  if (
    payload.tables.tenants.length !== 1 ||
    payload.tables.tenants[0].id !== tenantId ||
    payload.tables.app_instance.length !== 1 ||
    payload.tables.app_instance[0].tenant_id !== tenantId
  )
    fail(422, "固定机构记录不匹配", "invalid_backup");

  for (const u of payload.tables.users) {
    let roles;
    try {
      roles = JSON.parse(u.roles);
    } catch {
      fail(422, "备份账号角色损坏", "invalid_backup");
    }
    if (
      !Array.isArray(roles) ||
      !roles.length ||
      new Set(roles).size !== roles.length ||
      roles.some(
        (x) =>
          ![
            "supervisor",
            "academic",
            "finance",
            "consultant",
            "teacher",
            "student",
          ].includes(x),
      ) ||
      (roles.includes("student") && !u.student_id) ||
      (roles.includes("teacher") && !u.teacher_id)
    )
      fail(422, "备份账号角色或档案关联无效", "invalid_backup");
  }
  if (
    !payload.tables.users.some(
      (u) =>
        u.active === 1 &&
        u.deleted_at === null &&
        JSON.parse(u.roles).includes("supervisor"),
    )
  )
    fail(422, "备份必须保留至少一位有效主管", "invalid_backup");
  for (const user of payload.tables.users) {
    const roles = JSON.parse(user.roles);
    if (
      !roles.includes("student") &&
      !roles.includes("teacher") &&
      (user.student_id || user.teacher_id)
    )
      fail(422, "员工账号不能关联个人档案", "invalid_backup");
    for (const role of ["student", "teacher"])
      if (roles.includes(role)) {
        if (roles.length !== 1)
          fail(422, "个人账号不能混用其他角色", "invalid_backup");
        const profile = payload.tables[
          role === "student" ? "students" : "teachers"
        ].find((x) => x.id === user[role + "_id"]);
        if (
          !profile ||
          (user.active === 1 &&
            user.deleted_at === null &&
            (profile.deleted_at !== null || profile.status !== "active"))
        )
          fail(422, "备份账号关联的学员/教师档案不可用", "invalid_backup");
      }
  }
  const images = payload.tables.gallery_images.filter(
      (x) => x.deleted_at === null && x.r2_key,
    ),
    media = new Map();
  for (const file of payload.media) {
    if (
      !file ||
      typeof file.key !== "string" ||
      typeof file.text !== "string" ||
      media.has(file.key) ||
      !images.some((x) => x.r2_key === file.key) ||
      !file.key.startsWith("promo/" + tenantId + "/gallery/")
    )
      fail(422, "备份媒体清单无效", "invalid_backup");
    media.set(file.key, file.text);
  }
  const missing = payload.missing_media || [];
  if (
    !Array.isArray(missing) ||
    new Set(missing).size !== missing.length ||
    missing.some(
      (key) =>
        typeof key !== "string" ||
        media.has(key) ||
        !images.some((x) => x.r2_key === key),
    )
  )
    fail(422, "备份缺失媒体声明无效", "invalid_backup");
  if (images.some((x) => !media.has(x.r2_key) && !missing.includes(x.r2_key)))
    fail(422, "备份缺少图库文件", "invalid_backup");
  return {
    schema_version: payload.schema_version,
    migration_version: payload.migration_version,
    created_at: payload.created_at,
    counts: Object.fromEntries(
      Object.entries(payload.tables).map(([t, rows]) => [t, rows.length]),
    ),
    media_count: payload.media.length,
    missing_media_count: missing.length,
    warnings: missing.length
      ? [
          "该备份记录了" +
            missing.length +
            "个原本已缺失的图库文件；恢复需要额外确认，无法从该文件恢复这些图片",
        ]
      : [],
  };
}
