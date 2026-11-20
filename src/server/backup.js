import {
  FULL_BACKUP_VERSION,
  fullBackupTables,
  fullTableSignature,
  environmentFingerprint,
} from "./full-backup-format.js";
import { fixedTenant } from "./tenant.js";
import { repo } from "./repo.js";
import {
  backupTables,
  restoreTables,
  BUSINESS_SETTINGS,
} from "./backup-model.js";
import { bytes, unb64, textBytes, fail, now, randomId } from "./core.js";
export function backupConfig(env) {
  if (
    !env.CHANNEL_BACKUPS ||
    !env.CHANNEL_MEDIA ||
    !env.BACKUP_KEY ||
    unb64(env.BACKUP_KEY).length !== 32
  )
    fail(503, "备份配置不完整");
}
function base64(array) {
  let result = "";
  for (let i = 0; i < array.length; i += 16384)
    result += String.fromCharCode(...array.subarray(i, i + 16384));
  return btoa(result);
}
export async function seal(env, value, context) {
  const iv = bytes(12),
    key = await crypto.subtle.importKey(
      "raw",
      unb64(env.BACKUP_KEY),
      "AES-GCM",
      false,
      ["encrypt"],
    );
  const plain = textBytes(JSON.stringify(value));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: textBytes(context) },
    key,
    plain,
  );
  return { v: 1, iv: base64(iv), cipher: base64(new Uint8Array(cipher)) };
}
export async function open(env, envelope, context) {
  if (envelope.v !== 1) fail(400, "备份格式不支持");
  const key = await crypto.subtle.importKey(
    "raw",
    unb64(env.BACKUP_KEY),
    "AES-GCM",
    false,
    ["decrypt"],
  );
  try {
    const raw = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: unb64(envelope.iv),
        additionalData: textBytes(context),
      },
      key,
      unb64(envelope.cipher),
    );
    return JSON.parse(new TextDecoder().decode(raw));
  } catch {
    fail(400, "备份校验失败，请核对环境与密钥");
  }
}
export async function startBackup(env, at = now()) {
  backupConfig(env);
  const r = repo(env, null),
    existing = await r.activeBackup();
  if (existing) return { id: existing.id };
  const id =
    "daily/" +
    new Date(at).toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" }) +
    "/" +
    randomId("bak");
  const manifest = {
    schema: 10,
    schema_version: FULL_BACKUP_VERSION,
    migration_version: FULL_BACKUP_VERSION,
    table_signature: await fullTableSignature(),
    environment_fingerprint: await environmentFingerprint(env),
    media_files: [],
    id,
    created_at: at,
    kind: "full",
    tenant_ids: [],
    files: [],
    tables: null,
  };
  try {
    await r.beginBackup(id, at, manifest);
  } catch (e) {
    const active = await r.activeBackup();
    if (active) return { id: active.id };
    throw e;
  }
  const counts = await r.backupCounts(id);
  manifest.tables = Object.fromEntries(
    Object.keys(fullBackupTables).map((k) => [k, 0]),
  );
  for (const row of counts) manifest.tables[row.table_name] = row.n;
  await r.advanceBackup(
    id,
    JSON.stringify({ ...manifest, tables: null }),
    manifest,
  );
  return { id };
}
async function retainBackups(env, at) {
  const r = repo(env, null),
    cursor = await r.backupGcCursor();
  const page = await env.CHANNEL_BACKUPS.list({
    prefix: "daily/",
    cursor,
    limit: 1000,
  });
  const old = page.objects
    .filter(
      (x) =>
        /^daily\/\d{4}-\d{2}-\d{2}\//.test(x.key) &&
        Date.parse(x.key.slice(6, 16) + "T00:00:00+08:00") < at - 30 * 86400000,
    )
    .map((x) => x.key);
  if (old.length) await env.CHANNEL_BACKUPS.delete(old);
  await r.saveBackupGcCursor(page.truncated ? page.cursor : undefined);
}
export async function continueBackup(env, at = now(), pageBudget = 12) {
  backupConfig(env);
  const r = repo(env, null);
  let active = await r.activeBackup();
  if (!active) {
    await retainBackups(env, at);
    return { done: true };
  }
  let manifest = JSON.parse(active.manifest_json);
  // If a Cron invocation stopped after capturing rows, recover counts from the immutable snapshot.
  if (!manifest.tables) {
    manifest.tables = Object.fromEntries(
      Object.keys(fullBackupTables).map((k) => [k, 0]),
    );
    for (const row of await r.backupCounts(active.id))
      manifest.tables[row.table_name] = row.n;
    await r.advanceBackup(active.id, active.manifest_json, manifest);
    active.manifest_json = JSON.stringify(manifest);
  }
  try {
    for (let i = 0; i < pageBudget; i++) {
      const file = Object.entries(manifest.tables).flatMap(([table, count]) => {
        const offset = manifest.files
          .filter((x) => x.table === table)
          .reduce((n, x) => n + x.count, 0);
        return offset < count ? [{ table, offset }] : [];
      })[0];
      if (!file) {
        const image = await r.snapshotMedia(
          active.id,
          (manifest.media_files || []).length,
        );
        if (!image) break;
        const object = await env.CHANNEL_MEDIA.get(image.r2_key);
        if (!object)
          fail(409, "图库文件缺失，自动备份未标记完成", "backup_media_missing");
        const key = active.id + "/media/" + image.id + ".enc";
        const encrypted = JSON.stringify(
          await seal(
            env,
            { key: image.r2_key, text: await object.text() },
            key,
          ),
        );
        await env.CHANNEL_BACKUPS.put(key, encrypted);
        manifest.media_files ??= [];
        manifest.media_files.push({
          key,
          source_key: image.r2_key,
          bytes: textBytes(encrypted).byteLength,
        });
        if (!(await r.advanceBackup(active.id, active.manifest_json, manifest)))
          return { done: false, id: active.id, retry: true };
        active.manifest_json = JSON.stringify(manifest);
        continue;
      }
      const rows = await r.snapshotPage(active.id, file.table, file.offset),
        key = active.id + "/" + file.table + "/" + file.offset + ".enc";
      const encrypted = JSON.stringify(await seal(env, { ...file, rows }, key));
      await env.CHANNEL_BACKUPS.put(key, encrypted, {
        httpMetadata: { contentType: "application/octet-stream" },
      });
      if (file.table === "tenants")
        manifest.tenant_ids.push(...rows.map((row) => row.id));
      if (!rows.length) fail(409, "备份暂存快照不完整，拒绝发布成功备份");
      manifest.files.push({
        ...file,
        key,
        count: rows.length,
        bytes: textBytes(encrypted).byteLength,
        tenants: [...new Set(rows.map((r) => r.tenant_id).filter(Boolean))],
      });
      if (!(await r.advanceBackup(active.id, active.manifest_json, manifest)))
        return { done: false, id: active.id, retry: true };
      active.manifest_json = JSON.stringify(manifest);
    }
    const tablesDone = Object.entries(manifest.tables).every(
      ([table, count]) =>
        manifest.files
          .filter((x) => x.table === table)
          .reduce((n, x) => n + x.count, 0) === count,
    );
    const done =
      tablesDone &&
      !(await r.snapshotMedia(active.id, (manifest.media_files || []).length));
    if (done) {
      const key = active.id + "/manifest.enc";
      const encrypted = JSON.stringify(await seal(env, manifest, key));
      await env.CHANNEL_BACKUPS.put(key, encrypted);
      const size =
        manifest.files.reduce((n, f) => n + (f.bytes || 0), 0) +
        (manifest.media_files || []).reduce((n, f) => n + (f.bytes || 0), 0) +
        textBytes(encrypted).byteLength;
      await r.advanceBackup(
        active.id,
        active.manifest_json,
        manifest,
        true,
        size,
      );
    }
    return { done, id: active.id, tables: manifest.tables };
  } catch (e) {
    if (e.code === "backup_media_missing")
      await r.failBackupSnapshot(
        active.id,
        "图库文件缺失，当前快照失败；下一次每日任务将重新捕获",
      );
    else
      await r.backupLog(
        active.id,
        "failed",
        "备份分批处理失败；暂存快照保留，下一次定时任务继续；此前成功备份不受影响",
      );
    throw e;
  } finally {
    await retainBackups(env, at);
  }
}
export async function backupManifest(env, id) {
  backupConfig(env);
  if (
    typeof id !== "string" ||
    !/^daily\/\d{4}-\d{2}-\d{2}\/bak_[a-f0-9]{24}$/.test(id)
  )
    fail(404, "不存在");
  const key = id + "/manifest.enc",
    obj = await env.CHANNEL_BACKUPS.get(key);
  if (!obj) fail(404, "不存在");
  const manifest = await open(env, JSON.parse(await obj.text()), key);
  if (manifest.id !== id || ![9, 10].includes(manifest.schema))
    fail(400, "备份版本不匹配");
  return manifest;
}
export async function backupPage(env, id, table, offset, tenantId) {
  const manifest = await backupManifest(env, id);
  if (
    !backupTables[table]?.tenant ||
    (!restoreTables.includes(table) && table !== "tenant_settings")
  )
    fail(404, "不存在");
  const file = manifest.files.find(
    (x) => x.table === table && x.offset === offset,
  );
  if (!file) return { rows: [], next_offset: null };
  const obj = await env.CHANNEL_BACKUPS.get(file.key);
  if (!obj) fail(409, "备份文件不完整");
  const page = await open(env, JSON.parse(await obj.text()), file.key);
  const rows = page.rows.filter(
    (x) =>
      x.tenant_id === tenantId &&
      (table !== "tenant_settings" || BUSINESS_SETTINGS.includes(x.id)),
  );
  return {
    rows,
    next_offset:
      offset + file.count < manifest.tables[table] ? offset + file.count : null,
  };
}

const worker = {
  async scheduled(controller, env, ctx) {
    const tenant = await fixedTenant(env);
    if (!tenant) return;
    if (controller.cron === "0 19 * * *")
      await startBackup(env, controller.scheduledTime);
    try {
      if (controller.cron === "*/5 * * * *") {
        await repo(env, tenant.id).aiCleanup(controller.scheduledTime);
      }
    } finally {
      try {
        await continueBackup(env, controller.scheduledTime);
      } finally {
        const scoped = repo(env, tenant.id),
          expired = await scoped.expiredFullBackupFiles(
            controller.scheduledTime - 30 * 86400000,
          );
        if (expired.length) {
          await env.CHANNEL_BACKUPS.delete(expired.map((x) => x.r2_key));
          await scoped.deleteFullBackupFiles(expired.map((x) => x.id));
        }
        const previews = await scoped.expiredRestorePreviews(
          controller.scheduledTime,
        );
        if (previews.length) {
          await env.CHANNEL_BACKUPS.delete(previews.map((x) => x.object_key));
          await scoped.deleteRestorePreviews(previews.map((x) => x.id));
        }
        await scoped.cleanupFullSnapshots(controller.scheduledTime - 86400000);
      }
    }
  },
  async fetch() {
    return new Response("记录或页面不存在", { status: 404 });
  },
};
export default worker;
