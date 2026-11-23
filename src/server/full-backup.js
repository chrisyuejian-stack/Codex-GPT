import { repo } from "./repo.js";
import { seal, open, backupManifest } from "./backup.js";
import { body, json, fail, now, randomId, sha, textBytes } from "./core.js";
import { clearCookie } from "./auth.js";
import { clearTenantCache } from "./tenant.js";
import {
  FULL_BACKUP_VERSION,
  MAX_FULL_BACKUP_BYTES,
  fullBackupTables,
  fullTableSignature,
  environmentFingerprint,
  passwordSeal,
  passwordOpen,
  validateFullPayload,
} from "./full-backup-format.js";
export const fullBackupPath = (path) =>
  /^\/api\/backups(?:\/(?:export|restore\/preview|restore\/[^/]+\/confirm|[^/]+\/download))?$/.test(
    path,
  );
const counts = (payload) =>
  Object.fromEntries(
    Object.entries(payload.tables).map(([t, rows]) => [t, rows.length]),
  );
const checkSize = (payload) => {
  if (textBytes(JSON.stringify(payload)).byteLength > MAX_FULL_BACKUP_BYTES)
    fail(413, "完整备份超过16MiB上限，未生成部分备份", "backup_too_large");
};
function checkPassword(p) {
  if (typeof p !== "string" || p.trim().length < 12 || p.length > 256)
    fail(422, "备份密码须为12到256字符", "invalid_backup_password");
}
async function capture(env, tenantId, kind) {
  const r = repo(env, tenantId),
    id = randomId("fqb"),
    at = now();
  try {
    await r.captureFullSnapshot(id, at);
    const size = await r.fullSnapshotSize(id);
    if (size.bytes > MAX_FULL_BACKUP_BYTES)
      fail(413, "完整备份超过16MiB上限，未生成部分备份", "backup_too_large");
    const tables = Object.fromEntries(
      Object.keys(fullBackupTables).map((t) => [t, []]),
    );
    for (const row of await r.fullSnapshotRows(id))
      tables[row.table_name].push(JSON.parse(row.row_json));
    const payload = {
      format: "fengqin-database",
      schema_version: FULL_BACKUP_VERSION,
      migration_version: FULL_BACKUP_VERSION,
      counts: Object.fromEntries(
        Object.entries(tables).map(([t, rows]) => [t, rows.length]),
      ),
      table_signature: await fullTableSignature(),
      tenant_id: tenantId,
      environment_fingerprint: await environmentFingerprint(env),
      created_at: at,
      tables,
      media: [],
      missing_media: [],
    };
    for (const image of tables.gallery_images.filter(
      (x) => x.deleted_at === null && x.r2_key,
    )) {
      const object = await env.CHANNEL_MEDIA.get(image.r2_key);
      if (!object) {
        if (kind === "pre_restore") {
          payload.missing_media.push(image.r2_key);
          continue;
        }
        fail(409, "图库文件缺失，未生成不完整备份", "backup_media_missing");
      }
      payload.media.push({ key: image.r2_key, text: await object.text() });
      checkSize(payload);
    }
    checkSize(payload);
    return { id, at, kind, payload };
  } catch (e) {
    await r.discardFullSnapshot(id);
    throw e;
  }
}
async function publish(env, tenantId, snapshot) {
  const key =
    "full/" +
    new Date(snapshot.at + 28800000).toISOString().slice(0, 10) +
    "/" +
    snapshot.id +
    ".enc";
  const encrypted = JSON.stringify(await seal(env, snapshot.payload, key));
  await env.CHANNEL_BACKUPS.put(key, encrypted, {
    httpMetadata: { contentType: "application/octet-stream" },
  });
  try {
    await repo(env, tenantId).saveFullBackup({
      id: snapshot.id,
      at: snapshot.at,
      kind: snapshot.kind,
      r2_key: key,
      schema_version: FULL_BACKUP_VERSION,
      counts: counts(snapshot.payload),
      size_bytes: textBytes(encrypted).byteLength,
    });
  } catch (e) {
    await env.CHANNEL_BACKUPS.delete(key);
    throw e;
  }
  return key;
}
async function loadBackup(env, tenantId, id) {
  const r = repo(env, tenantId),
    saved = await r.fullBackupFile(id);
  if (saved) {
    if (saved.at < now() - 30 * 86400000)
      fail(404, "备份已超过保留期", "not_found");
    const object = await env.CHANNEL_BACKUPS.get(saved.r2_key);
    if (!object) fail(404, "备份文件已不存在", "not_found");
    return open(env, JSON.parse(await object.text()), saved.r2_key);
  }
  const manifest = await backupManifest(env, id);
  if (manifest.created_at < now() - 30 * 86400000)
    fail(404, "备份已超过保留期", "not_found");
  if (
    manifest.schema_version !== FULL_BACKUP_VERSION ||
    manifest.table_signature !== (await fullTableSignature())
  )
    fail(
      422,
      "旧自动备份版本不兼容，请使用0035之后生成的全量备份",
      "backup_version_mismatch",
    );
  const payload = {
    format: "fengqin-database",
    schema_version: manifest.schema_version,
    migration_version: manifest.migration_version,
    counts: Object.fromEntries(
      Object.keys(fullBackupTables).map((t) => [t, manifest.tables[t]]),
    ),
    table_signature: manifest.table_signature,
    environment_fingerprint: manifest.environment_fingerprint,
    tenant_id: tenantId,
    created_at: manifest.created_at,
    tables: Object.fromEntries(
      Object.keys(fullBackupTables).map((t) => [t, []]),
    ),
    media: [],
  };
  for (const file of manifest.files) {
    if (!Object.hasOwn(fullBackupTables, file.table)) continue;
    const object = await env.CHANNEL_BACKUPS.get(file.key);
    if (!object) fail(409, "自动备份分页缺失", "backup_incomplete");
    const page = await open(env, JSON.parse(await object.text()), file.key);
    if (!Array.isArray(page.rows) || page.rows.length !== file.count)
      fail(409, "自动备份分页不完整", "backup_incomplete");
    payload.tables[file.table].push(...page.rows);
    checkSize(payload);
  }
  for (const [table, spec] of Object.entries(fullBackupTables)) {
    if (
      !Object.hasOwn(manifest.tables, table) ||
      payload.tables[table].length !== manifest.tables[table]
    )
      fail(409, "自动备份表记录不完整：" + table, "backup_incomplete");
  }
  for (const file of manifest.media_files || []) {
    const object = await env.CHANNEL_BACKUPS.get(file.key);
    if (!object) fail(409, "自动备份媒体缺失", "backup_incomplete");
    const media = await open(env, JSON.parse(await object.text()), file.key);
    payload.media.push(media);
    checkSize(payload);
  }
  return payload;
}
async function download(payload, password) {
  return new Response(JSON.stringify(await passwordSeal(payload, password)), {
    headers: {
      "Content-Type": "application/vnd.fengqin.backup+json",
      "Content-Disposition":
        'attachment; filename="fengqin-' +
        new Date(payload.created_at + 28800000).toISOString().slice(0, 10) +
        '.fqbackup"',
    },
  });
}
async function upload(req) {
  if (req.headers.get("Origin") !== new URL(req.url).origin)
    fail(403, "请求来源不正确", "forbidden");
  let n = 0;
  const chunks = [],
    reader = req.body?.getReader();
  if (!reader) fail(400, "请上传备份文件", "invalid_backup");
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    n += part.value.byteLength;
    if (n > 24 * 1024 * 1024) {
      await reader.cancel();
      fail(413, "备份上传超过24MiB上限", "backup_too_large");
    }
    chunks.push(part.value);
  }
  const raw = new Uint8Array(n);
  let at = 0;
  for (const x of chunks) {
    raw.set(x, at);
    at += x.length;
  }
  try {
    if (
      (req.headers.get("content-type") || "").startsWith("multipart/form-data")
    ) {
      const form = await new Request(req.url, {
          method: "POST",
          headers: req.headers,
          body: raw,
        }).formData(),
        file = form.get("file");
      if (!file || typeof file.text !== "function")
        fail(422, "缺少备份文件", "invalid_backup");
      return {
        password: form.get("password"),
        file: JSON.parse(await file.text()),
      };
    }
    if (
      !/^application\/json(?:;|$)/i.test(req.headers.get("content-type") || "")
    )
      fail(415, "请使用JSON或文件上传", "invalid_backup");
    const d = JSON.parse(new TextDecoder().decode(raw));
    return {
      password: d.password,
      file: typeof d.file === "string" ? JSON.parse(d.file) : d.file,
    };
  } catch (e) {
    if (e.status) throw e;
    fail(400, "备份文件不是有效JSON", "invalid_backup");
  }
}
export async function fullBackupApi(req, env, resolved, user) {
  const path = resolved.relative;
  if (!fullBackupPath(path)) return undefined;
  if (!user.roles.includes("supervisor"))
    fail(403, "仅主管可导出和恢复全量备份", "forbidden");
  const tenantId = resolved.tenant.id,
    r = repo(env, tenantId);
  if (path === "/api/backups" && req.method === "GET") {
    const data = await r.fullBackupList(now() - 30 * 86400000);
    const items = [
      ...data.files.map((x) => ({
        ...x,
        status: "completed",
        counts: JSON.parse(x.counts_json),
        counts_json: undefined,
      })),
      ...data.daily.map((x) => {
        const m = JSON.parse(x.manifest_json);
        return {
          id: x.id,
          kind: "automatic",
          status: x.status,
          size_bytes:
            x.size_bytes ||
            [...(m.files || []), ...(m.media_files || [])].reduce(
              (n, f) => n + (f.bytes || 0),
              0,
            ),
          at: x.at,
          schema_version: m.schema_version || null,
          compatible: m.schema_version === FULL_BACKUP_VERSION,
          counts: m.tables,
        };
      }),
    ]
      .sort((a, b) => b.at - a.at)
      .map((x) => ({
        ...x,
        download_url:
          x.status === "completed"
            ? "/api/backups/" + encodeURIComponent(x.id) + "/download"
            : null,
      }));
    return json({ items, retention_days: 30 });
  }
  if (path === "/api/backups/export" && req.method === "POST") {
    const d = await body(req);
    checkPassword(d.password);
    const snapshot = await capture(env, tenantId, "manual");
    try {
      await publish(env, tenantId, snapshot);
      await r.audit(
        user,
        "settings",
        "backup_export",
        snapshot.id,
        "导出密码加密全量备份（无会话）",
      );
      return await download(snapshot.payload, d.password);
    } finally {
      await r.discardFullSnapshot(snapshot.id);
    }
  }
  const get = /^\/api\/backups\/([^/]+)\/download$/.exec(path);
  if (get && req.method === "POST") {
    const d = await body(req);
    checkPassword(d.password);
    let id;
    try {
      id = decodeURIComponent(get[1]);
    } catch {
      fail(404, "不存在", "not_found");
    }
    const payload = await loadBackup(env, tenantId, id);
    await validateFullPayload(payload, env, tenantId);
    await r.audit(
      user,
      "settings",
      "backup_download",
      id,
      "下载密码加密备份（无会话）",
    );
    return download(payload, d.password);
  }
  if (path === "/api/backups/restore/preview" && req.method === "POST") {
    const d = await upload(req);
    checkPassword(d.password);
    const payload = await passwordOpen(d.file, d.password);
    const summary = await validateFullPayload(payload, env, tenantId);
    await r.validateFullReferences(payload);
    const current_counts = await r.currentFullCounts();
    const comparison = Object.fromEntries(
      Object.keys(fullBackupTables).map((t) => [
        t,
        {
          backup: summary.counts[t],
          current: current_counts[t],
          delta: summary.counts[t] - current_counts[t],
        },
      ]),
    );
    const id = randomId("rst"),
      key = "restore_staging/" + tenantId + "/" + id + ".enc",
      hash = await sha(JSON.stringify(payload));
    await env.CHANNEL_BACKUPS.put(
      key,
      JSON.stringify(await seal(env, payload, key)),
    );
    try {
      await r.saveRestorePreview({ id, key, hash, summary }, user);
    } catch (e) {
      await env.CHANNEL_BACKUPS.delete(key);
      throw e;
    }
    return json(
      {
        id,
        ...summary,
        current_counts,
        comparison,
        expires_at: now() + 1800000,
        requires_confirmation: true,
        current_account_in_backup: payload.tables.users.some(
          (x) => x.id === user.id && x.active === 1 && x.deleted_at === null,
        ),
        login_notice: "恢复后请使用备份中的账号和密码重新登录",
      },
      201,
    );
  }
  const confirm = /^\/api\/backups\/restore\/([^/]+)\/confirm$/.exec(path);
  if (confirm && req.method === "POST") {
    const d = await body(req);
    if (d.confirm !== true)
      fail(
        422,
        "请明确确认整体覆盖当前全部数据",
        "restore_confirmation_required",
      );
    const job = await r.restorePreview(confirm[1], user);
    if (!job || job.expires_at <= now())
      fail(404, "恢复预览不存在或已过期", "not_found");
    if (job.status === "done")
      return json(
        { ok: true, reauthenticate: true, pre_backup_id: job.pre_backup_id },
        200,
        { "Set-Cookie": clearCookie() },
      );
    await r.claimRestore(job.id, user);
    let snapshot;
    const created = [];
    try {
      const object = await env.CHANNEL_BACKUPS.get(job.object_key);
      if (!object) fail(404, "恢复文件已过期，请重新上传", "not_found");
      const payload = await open(
        env,
        JSON.parse(await object.text()),
        job.object_key,
      );
      if ((await sha(JSON.stringify(payload))) !== job.document_hash)
        fail(400, "恢复预览校验失败", "invalid_backup");
      await validateFullPayload(payload, env, tenantId);
      await r.validateFullReferences(payload);
      if (payload.missing_media?.length && d.allow_missing_media !== true)
        fail(
          422,
          "备份中有已缺失的媒体，请明确确认仍恢复这些数据",
          "restore_media_confirmation_required",
        );
      snapshot = await capture(env, tenantId, "pre_restore");
      await publish(env, tenantId, snapshot);
      for (const file of payload.media) {
        const existing = await env.CHANNEL_MEDIA.get(file.key);
        if (existing && (await existing.text()) === file.text) continue;
        let key = file.key;
        if (existing) key = file.key + "/restore_" + job.id;
        const target = await env.CHANNEL_MEDIA.get(key);
        if (!target) {
          await env.CHANNEL_MEDIA.put(key, file.text);
          created.push(key);
        } else if ((await target.text()) !== file.text)
          fail(
            409,
            "恢复媒体暂存存在冲突，请重新预览",
            "restore_media_conflict",
          );
        for (const image of payload.tables.gallery_images)
          if (image.r2_key === file.key) image.r2_key = key;
      }
      await r.commitFullRestore(job, payload, snapshot.id, user);
      // 整体恢复覆盖了机构记录：清掉机构缓存（tenant.js），下一个请求重新读取。
      clearTenantCache(env);
      try {
        await env.CHANNEL_BACKUPS.delete(job.object_key);
      } catch {}
      return json(
        { ok: true, reauthenticate: true, pre_backup_id: snapshot.id },
        200,
        { "Set-Cookie": clearCookie() },
      );
    } catch (e) {
      const latest = await r.restorePreview(job.id, user);
      if (latest?.status !== "done") {
        if (created.length) await env.CHANNEL_MEDIA.delete(created);
        await r.resetRestore(job.id, user);
      }
      throw e;
    } finally {
      if (snapshot)
        try {
          await r.discardFullSnapshot(snapshot.id);
        } catch {}
    }
  }
  fail(404, "不存在", "not_found");
}
