import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support.mjs";
import {
  setup,
  request,
  accountToken,
  pack,
  lesson,
  status,
} from "./fixtures-credit.mjs";
import {
  passwordOpen,
  passwordSeal,
  fullBackupTables,
} from "../src/server/full-backup-format.js";
import { open as serverOpen } from "../src/server/backup.js";
const PASSWORD = "FullBackupSecure9";
async function school(fn) {
  const f = await fixture();
  try {
    await fn({ ...(await setup(f, 2, "full-backup")), f });
  } finally {
    f.restore();
  }
}
function ok(r, status = 200) {
  assert.equal(r.status, status, r.text);
  assert.ok(r.queries <= 40);
  return r.body;
}
const exportFile = async (s) => {
  const r = await request(s, "backups/export", "POST", { password: PASSWORD });
  ok(r);
  return JSON.parse(r.text);
};
const preview = (s, file, password = PASSWORD, token = s.token) =>
  request(s, "backups/restore/preview", "POST", { password, file }, token);
const confirm = (s, id, token = s.token) =>
  request(
    s,
    "backups/restore/" + id + "/confirm",
    "POST",
    { confirm: true },
    token,
  );
async function login(s) {
  const r = ok(
    await request(s, "auth/login", "POST", {
      phone: "13911112222",
      password: "PhaseTwoSecure9",
    }),
  );
  return r;
}
function database(s) {
  return Object.fromEntries(
    Object.keys(fullBackupTables).map((t) => [
      t,
      s.f.db.raw
        .prepare("SELECT * FROM " + t)
        .all()
        .map((x) => ({ ...x })),
    ]),
  );
}
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jw1kAAAAASUVORK5CYII=";
async function image(s) {
  const form = new FormData();
  form.set(
    "file",
    new Blob([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], {
      type: "image/png",
    }),
    "sample.png",
  );
  const res = await s.f.directRequest("https://school.test/api/gallery", {
    method: "POST",
    headers: {
      Origin: "https://school.test",
      Cookie: "__Host-fengqin_session=" + s.token,
    },
    body: form,
  });
  assert.equal(res.status, 201, await res.clone().text());
  return res.json();
}

test("全量备份：密码派生AES-GCM、随机盐/IV、完整表/哈希/设置/图库，不含会话或服务密钥", () =>
  school(async (s) => {
    const gallery = await image(s);
    await s.r.saveSetting("student_view_payments", true, s.user);
    const digest = (await s.r.user(s.user.id)).digest;
    const file = await exportFile(s),
      other = await exportFile(s);
    assert.notEqual(file.salt, other.salt);
    assert.notEqual(file.iv, other.iv);
    assert.ok(!JSON.stringify(file).includes(digest));
    assert.ok(!JSON.stringify(file).includes("学员0"));
    const payload = await passwordOpen(file, PASSWORD);
    assert.deepEqual(
      Object.keys(payload.tables).sort(),
      Object.keys(fullBackupTables).sort(),
    );
    assert.ok(!("sessions" in payload.tables));
    assert.equal(payload.migration_version, 35);
    assert.equal(file.version, 1);
    for (const [name, rows] of Object.entries(payload.tables))
      assert.equal(payload.counts[name], rows.length);
    assert.ok(!JSON.stringify(payload).includes(s.f.env.BACKUP_KEY));
    assert.ok(!JSON.stringify(payload).includes(s.f.env.PW_PEPPER));
    assert.equal(
      payload.tables.users.find((x) => x.id === s.user.id).digest,
      digest,
    );
    assert.ok(
      payload.tables.tenant_settings.some(
        (x) => x.id === "student_view_payments" && x.value === "true",
      ),
    );
    assert.equal(payload.media.length, 1);
    assert.ok(payload.tables.gallery_images.some((x) => x.id === gallery.id));
    await assert.rejects(
      passwordOpen(file, "IncorrectBackup9"),
      (e) => e.status === 400,
    );
    await assert.rejects(
      passwordOpen(
        {
          ...file,
          cipher: (file.cipher[0] === "A" ? "B" : "A") + file.cipher.slice(1),
        },
        PASSWORD,
      ),
      (e) => e.status === 400,
    );
    const listed = ok(await request(s, "backups")).items;
    assert.equal(listed.length, 2);
    assert.ok(
      listed.every(
        (x) => x.status === "completed" && x.download_url && x.size_bytes > 0,
      ),
    );
  }));

test("全量备份：仅主管，财务/教务/顾问/学员不能导出、预览、下载、确认或列表", () =>
  school(async (s) => {
    const file = await exportFile(s),
      p = ok(await preview(s, file), 201),
      id = ok(await request(s, "backups")).items[0].id;
    for (const roles of [
      ["finance"],
      ["academic"],
      ["consultant"],
      ["student"],
    ]) {
      const actor = await accountToken(
        s,
        roles,
        roles[0] === "student" ? s.students[0] : null,
      );
      for (const [path, method, data] of [
        ["backups", "GET"],
        ["backups/export", "POST", { password: PASSWORD }],
        ["backups/" + id + "/download", "POST", { password: PASSWORD }],
        ["backups/restore/preview", "POST", { password: PASSWORD, file }],
        ["backups/restore/" + p.id + "/confirm", "POST", { confirm: true }],
      ])
        ok(await request(s, path, method, data, actor.token), 403);
    }
  }));

test("整体覆盖：预览不改业务，恢复先保存完整前镜像，保留密码哈希并清空所有会话", () =>
  school(async (s) => {
    const pkg = await pack(s),
      lid = await lesson(s, "2026-11-10T09:00");
    ok(await status(s, lid, "completed"));
    const digest = (await s.r.user(s.user.id)).digest;
    const file = await exportFile(s),
      p = ok(await preview(s, file), 201);
    assert.equal(p.counts.students, 2);
    assert.equal(p.counts.package_transactions, 2);
    assert.equal(p.requires_confirmation, true);
    assert.equal(
      (await s.r.businessGet("students", s.students[0])).name,
      "学员0",
    );
    const old = await s.r.businessGet("students", s.students[0]);
    ok(
      await request(s, "data/students/" + old.id, "PATCH", {
        version: old.version,
        name: "恢复前最新姓名",
      }),
    );
    const extra = ok(
      await request(s, "data/students", "POST", { name: "覆盖后应消失" }),
    ).id;
    const newer = await accountToken(s, ["finance"]);
    const result = ok(await confirm(s, p.id));
    assert.equal(result.reauthenticate, true);
    assert.ok(result.pre_backup_id);
    assert.equal((await s.r.businessGet("students", old.id)).name, "学员0");
    assert.equal(await s.r.businessGet("students", extra), null);
    assert.equal(await s.r.user(newer.id), null);
    assert.equal((await s.r.user(s.user.id)).digest, digest);
    assert.equal(
      s.f.db.raw.prepare("SELECT COUNT(*) n FROM sessions").get().n,
      0,
    );
    ok(await request(s, "me"), 401);
    const before = await s.r.fullBackupFile(result.pre_backup_id),
      obj = await s.f.env.CHANNEL_BACKUPS.get(before.r2_key),
      payload = await serverOpen(
        s.f.env,
        JSON.parse(await obj.text()),
        before.r2_key,
      );
    assert.equal(
      payload.tables.students.find((x) => x.id === old.id).name,
      "恢复前最新姓名",
    );
    assert.ok(payload.tables.students.some((x) => x.id === extra));
    assert.ok(payload.tables.users.some((x) => x.id === newer.id));
    assert.ok(!payload.tables.sessions);
    assert.deepEqual(s.f.db.raw.prepare("PRAGMA foreign_key_check").all(), []);
    assert.throws(
      () => s.f.db.raw.exec("UPDATE audit_log SET summary='篡改'"),
      /append only/,
    );
    await login(s);
  }));

test("恢复拒绝：无确认、错误密码、旧版本、其他固定机构、不同字段密钥、缺表/重复键/坏引用", () =>
  school(async (s) => {
    const file = await exportFile(s),
      payload = await passwordOpen(file, PASSWORD),
      bad = async (mutate) => {
        const next = structuredClone(payload);
        mutate(next);
        const r = await preview(s, await passwordSeal(next, PASSWORD));
        ok(r, 422);
      };
    ok(await preview(s, file, "WrongBackupSecure9"), 400);
    await bad((x) => (x.schema_version = 30));
    await bad((x) => (x.tenant_id = "other"));
    await bad((x) => (x.environment_fingerprint = "different"));
    await bad((x) => delete x.tables.leads);
    await bad((x) => x.tables.students.push(x.tables.students[0]));
    await bad((x) => (x.tables.course_categories = []));
    await bad((x) => (x.tables.users[0].roles = "bad json"));
    const p = ok(await preview(s, file), 201);
    ok(
      await request(s, "backups/restore/" + p.id + "/confirm", "POST", {}),
      422,
    );
    assert.equal(
      s.f.db.raw.prepare("SELECT COUNT(*) n FROM students").get().n,
      2,
    );
  }));

test("恢复预览：主管之间不可冒用，30分钟过期，暂存只存服务器密文且不保存密码", () =>
  school(async (s) => {
    const p = ok(await preview(s, await exportFile(s)), 201),
      other = await accountToken(s, ["supervisor"]);
    ok(await confirm(s, p.id, other.token), 404);
    const row = await s.r.restorePreview(p.id, s.user),
      text = await (await s.f.env.CHANNEL_BACKUPS.get(row.object_key)).text();
    assert.ok(!text.includes(PASSWORD));
    assert.ok(!text.includes("学员0"));
    s.f.db.raw
      .prepare("UPDATE restore_previews SET expires_at=1 WHERE id=?")
      .run(p.id);
    ok(await confirm(s, p.id), 404);
  }));

test("恢复前R2写入失败不覆盖、保留会话，预览可重新确认", () =>
  school(async (s) => {
    const p = ok(await preview(s, await exportFile(s)), 201);
    s.f.db.raw.prepare("UPDATE students SET name='当前值'").run();
    const put = s.f.env.CHANNEL_BACKUPS.put.bind(s.f.env.CHANNEL_BACKUPS);
    s.f.env.CHANNEL_BACKUPS.put = async (key, ...args) => {
      if (key.startsWith("full/")) throw Error("R2 failure");
      return put(key, ...args);
    };
    ok(await confirm(s, p.id), 500);
    assert.equal(
      (await s.r.businessGet("students", s.students[0])).name,
      "当前值",
    );
    ok(await request(s, "me"));
    assert.equal((await s.r.restorePreview(p.id, s.user)).status, "ready");
    s.f.env.CHANNEL_BACKUPS.put = put;
    ok(await confirm(s, p.id));
  }));

test("恢复覆盖中途SQL失败：数据/会话/触发器全部回滚，重试成功", () =>
  school(async (s) => {
    const p = ok(await preview(s, await exportFile(s)), 201);
    s.f.db.raw.prepare("UPDATE students SET name='不得丢失'").run();
    const batch = s.f.db.batch.bind(s.f.db);
    s.f.db.batch = async (ops) => {
      if (ops.some((x) => x.query.startsWith("DROP TRIGGER"))) {
        const index = ops.findIndex((x) =>
          x.query.startsWith("INSERT INTO students("),
        );
        ops = [...ops];
        ops[index] = {
          ...ops[index],
          query: "INSERT INTO nonexistent_table(id) VALUES(1)",
          params: [],
        };
      }
      return batch(ops);
    };
    ok(await confirm(s, p.id), 500);
    assert.equal(
      (await s.r.businessGet("students", s.students[0])).name,
      "不得丢失",
    );
    assert.ok(
      await s.r.session(
        await (await import("../src/server/core.js")).sha(s.token),
      ),
    );
    assert.throws(
      () => s.f.db.raw.exec("UPDATE audit_log SET summary='篡改'"),
      /append only/,
    );
    s.f.db.batch = batch;
    ok(await confirm(s, p.id));
  }));

test("恢复并发防丢失：预备份后业务变化返回409，不覆盖新数据或撤销会话", () =>
  school(async (s) => {
    const p = ok(await preview(s, await exportFile(s)), 201);
    const put = s.f.env.CHANNEL_BACKUPS.put.bind(s.f.env.CHANNEL_BACKUPS);
    s.f.env.CHANNEL_BACKUPS.put = async (key, ...args) => {
      const out = await put(key, ...args);
      if (key.startsWith("full/"))
        s.f.db.raw.prepare("UPDATE students SET name='并发最新值'").run();
      return out;
    };
    ok(await confirm(s, p.id), 409);
    assert.equal(
      (await s.r.businessGet("students", s.students[0])).name,
      "并发最新值",
    );
    ok(await request(s, "me"));
    assert.equal((await s.r.restorePreview(p.id, s.user)).status, "ready");
  }));

test("图库恢复：缺失文件恢复，冲突文件使用新键，失败不会覆盖现有图片", () =>
  school(async (s) => {
    const gallery = await image(s),
      file = await exportFile(s),
      payload = await passwordOpen(file, PASSWORD),
      original = payload.media[0];
    await s.f.env.CHANNEL_MEDIA.put(original.key, "different-current-file");
    const p = ok(await preview(s, file), 201);
    ok(await confirm(s, p.id));
    const row = s.f.db.raw
      .prepare("SELECT r2_key FROM gallery_images WHERE id=?")
      .get(gallery.id);
    assert.notEqual(row.r2_key, original.key);
    assert.equal(
      await (await s.f.env.CHANNEL_MEDIA.get(row.r2_key)).text(),
      original.text,
    );
    assert.equal(
      await (await s.f.env.CHANNEL_MEDIA.get(original.key)).text(),
      "different-current-file",
    );
  }));

test("自动备份：北京时间03点、R2冻结图库、列表/密码下载与恢复兼容，旧文件明确拒绝", () =>
  school(async (s) => {
    await image(s);
    const worker =
      process.env.TEST_BUNDLE === "1"
        ? (await import("../backup-dist/backup-worker.js")).default
        : (await import("../src/server/backup.js")).default;
    await worker.scheduled(
      { cron: "0 19 * * *", scheduledTime: Date.now() },
      s.f.env,
      {},
    );
    for (
      let i = 0;
      i < 30 &&
      s.f.db.raw
        .prepare(
          "SELECT COUNT(*) n FROM backup_snapshots WHERE status='running'",
        )
        .get().n;
      i++
    )
      await worker.scheduled(
        { cron: "*/5 * * * *", scheduledTime: Date.now() },
        s.f.env,
        {},
      );
    const list = ok(await request(s, "backups")),
      entry = list.items.find((x) => x.kind === "automatic");
    assert.ok(entry);
    assert.equal(entry.status, "completed");
    assert.ok(entry.download_url);
    assert.ok(entry.size_bytes > 0);
    const objects = await s.f.env.CHANNEL_BACKUPS.list({
      prefix: entry.id + "/",
    });
    let bytes = 0;
    for (const x of objects.objects)
      bytes += Buffer.byteLength(
        await (await s.f.env.CHANNEL_BACKUPS.get(x.key)).text(),
      );
    assert.equal(entry.size_bytes, bytes);
    const manifestObject = await s.f.env.CHANNEL_BACKUPS.get(
      entry.id + "/manifest.enc",
    );
    const manifest = await serverOpen(
      s.f.env,
      JSON.parse(await manifestObject.text()),
      entry.id + "/manifest.enc",
    );
    assert.ok(!Object.hasOwn(manifest.tables, "sessions"));
    const r = await request(
      s,
      "backups/" + encodeURIComponent(entry.id) + "/download",
      "POST",
      { password: PASSWORD },
    );
    ok(r);
    const decoded = await passwordOpen(JSON.parse(r.text), PASSWORD);
    assert.equal(decoded.media.length, 1);
    ok(await preview(s, JSON.parse(r.text)), 201);
  }));

test("大于1MiB的真实加密文件能上传预览，短密码和伪造格式拒绝", () =>
  school(async (s) => {
    s.f.db.raw.prepare("UPDATE students SET notes=?").run("a".repeat(600000));
    const file = await exportFile(s);
    assert.ok(JSON.stringify(file).length > 1048576);
    ok(await preview(s, file), 201);
    ok(await request(s, "backups/export", "POST", { password: "short" }), 422);
    ok(await preview(s, { format: "unknown" }), 422);
  }));

test("当前图库已丢失时仍可从健康备份修复；覆盖前备份明确记录原有缺失", () =>
  school(async (s) => {
    const gallery = await image(s),
      file = await exportFile(s),
      payload = await passwordOpen(file, PASSWORD),
      key = payload.media[0].key;
    await s.f.env.CHANNEL_MEDIA.delete(key);
    const p = ok(await preview(s, file), 201),
      result = ok(await confirm(s, p.id));
    assert.equal(
      await (await s.f.env.CHANNEL_MEDIA.get(key)).text(),
      payload.media[0].text,
    );
    const row = await s.r.fullBackupFile(result.pre_backup_id),
      before = await serverOpen(
        s.f.env,
        JSON.parse(
          await (await s.f.env.CHANNEL_BACKUPS.get(row.r2_key)).text(),
        ),
        row.r2_key,
      );
    assert.deepEqual(before.missing_media, [key]);
    assert.ok(before.tables.gallery_images.some((x) => x.id === gallery.id));
  }));

test("保留30天：定时清理过期手动/恢复前文件与预览，列表下载均不暴露过期对象", () =>
  school(async (s) => {
    const file = await exportFile(s),
      p = ok(await preview(s, file), 201),
      row = await s.r.restorePreview(p.id, s.user),
      entry = ok(await request(s, "backups")).items[0];
    s.f.db.raw
      .prepare("UPDATE full_backup_files SET at=? WHERE id=?")
      .run(Date.now() - 31 * 86400000, entry.id);
    s.f.db.raw
      .prepare("UPDATE restore_previews SET expires_at=1 WHERE id=?")
      .run(p.id);
    ok(
      await request(s, "backups/" + entry.id + "/download", "POST", {
        password: PASSWORD,
      }),
      404,
    );
    assert.equal(ok(await request(s, "backups")).items.length, 0);
    const worker =
      process.env.TEST_BUNDLE === "1"
        ? (await import("../backup-dist/backup-worker.js")).default
        : (await import("../src/server/backup.js")).default;
    await worker.scheduled(
      { cron: "*/5 * * * *", scheduledTime: Date.now() },
      s.f.env,
      {},
    );
    assert.equal(await s.r.fullBackupFile(entry.id), null);
    assert.equal(await s.f.env.CHANNEL_BACKUPS.get(row.object_key), null);
    assert.equal(await s.r.restorePreview(p.id, s.user), null);
  }));

test("同一实例并发确认只覆盖一次，不允许两个恢复作业同时执行", () =>
  school(async (s) => {
    const file = await exportFile(s),
      a = ok(await preview(s, file), 201),
      b = ok(await preview(s, file), 201);
    let entered;
    const waiting = new Promise((resolve) => (entered = resolve));
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const put = s.f.env.CHANNEL_BACKUPS.put.bind(s.f.env.CHANNEL_BACKUPS);
    let once = true;
    s.f.env.CHANNEL_BACKUPS.put = async (key, ...args) => {
      if (key.startsWith("full/") && once) {
        once = false;
        entered();
        await gate;
      }
      return put(key, ...args);
    };
    const first = confirm(s, a.id);
    await waiting;
    const second = await confirm(s, b.id);
    ok(second, 409);
    release();
    ok(await first);
    assert.equal(
      s.f.db.raw
        .prepare("SELECT COUNT(*) n FROM audit_log WHERE action='restore'")
        .get().n,
      1,
    );
  }));

test("上传可使用multipart原始文件；仅更换BACKUP_KEY不影响密码文件解密", () =>
  school(async (s) => {
    const file = await exportFile(s),
      { bytes, b64 } = await import("../src/server/core.js");
    s.f.env.BACKUP_KEY = b64(bytes(32));
    const form = new FormData();
    form.set("password", PASSWORD);
    form.set(
      "file",
      new Blob([JSON.stringify(file)], {
        type: "application/vnd.fengqin.backup+json",
      }),
      "backup.fqbackup",
    );
    const res = await s.f.directRequest(
      "https://school.test/api/backups/restore/preview",
      {
        method: "POST",
        headers: {
          Origin: "https://school.test",
          Cookie: "__Host-fengqin_session=" + s.token,
        },
        body: form,
      },
    );
    assert.equal(res.status, 201, await res.clone().text());
    assert.ok((await res.json()).counts.users > 0);
  }));

test("中断的旧恢复预览到期后不永久占用恢复锁，新预览可以确认", () =>
  school(async (s) => {
    const file = await exportFile(s),
      old = ok(await preview(s, file), 201);
    s.f.db.raw
      .prepare(
        "UPDATE restore_previews SET status='applying',expires_at=1 WHERE id=?",
      )
      .run(old.id);
    const fresh = ok(await preview(s, file), 201);
    ok(await confirm(s, fresh.id));
  }));

test("自动快照图库缺失后标记失败，下一次可重新开始，列表明确无下载入口", () =>
  school(async (s) => {
    const gallery = await image(s);
    const { startBackup, continueBackup } =
      await import("../src/server/backup.js");
    const first = await startBackup(s.f.env);
    const pending = ok(await request(s, "backups")).items.find(
      (x) => x.id === first.id,
    );
    assert.equal(pending.status, "running");
    assert.equal(pending.download_url, null);
    const key = s.f.db.raw
      .prepare("SELECT r2_key FROM gallery_images WHERE id=?")
      .get(gallery.id).r2_key;
    await s.f.env.CHANNEL_MEDIA.delete(key);
    await assert.rejects(
      continueBackup(s.f.env, Date.now(), 1000),
      (e) => e.code === "backup_media_missing",
    );
    assert.equal(
      s.f.db.raw
        .prepare(
          "SELECT COUNT(*) n FROM backup_snapshots WHERE status='running'",
        )
        .get().n,
      0,
    );
    const failed = ok(await request(s, "backups")).items.find(
      (x) => x.id === first.id,
    );
    assert.equal(failed.status, "failed");
    assert.equal(failed.download_url, null);
    const second = await startBackup(s.f.env, Date.now() + 86400000);
    assert.notEqual(first.id, second.id);
  }));

test("恢复成功后暂存R2清理失败仍返回成功并使会话失效", () =>
  school(async (s) => {
    const file = await exportFile(s),
      p = ok(await preview(s, file), 201);
    const remove = s.f.env.CHANNEL_BACKUPS.delete.bind(s.f.env.CHANNEL_BACKUPS);
    s.f.env.CHANNEL_BACKUPS.delete = async (key) => {
      if (typeof key === "string" && key.startsWith("restore_staging/"))
        throw Error("cleanup unavailable");
      return remove(key);
    };
    assert.equal(ok(await confirm(s, p.id)).reauthenticate, true);
    assert.equal(
      s.f.db.raw.prepare("SELECT COUNT(*) n FROM sessions").get().n,
      0,
    );
    assert.equal((await s.r.restorePreview(p.id, s.user)).status, "done");
  }));

test("历史停用个人账号及已归档档案可完整往返，仍拒绝有效账号关联不可用档案", () =>
  school(async (s) => {
    const actor = await accountToken(s, ["student"], s.students[0]);
    s.f.db.raw
      .prepare("UPDATE users SET active=0,deleted_at=? WHERE id=?")
      .run(Date.now(), actor.id);
    s.f.db.raw
      .prepare("UPDATE students SET deleted_at=? WHERE id=?")
      .run(Date.now(), s.students[0]);
    const file = await exportFile(s);
    const invalid = await passwordOpen(file, PASSWORD);
    invalid.tables.users.find((x) => x.id === actor.id).active = 1;
    invalid.tables.users.find((x) => x.id === actor.id).deleted_at = null;
    ok(await preview(s, await passwordSeal(invalid, PASSWORD)), 422);
    const p = ok(await preview(s, file), 201);
    ok(await confirm(s, p.id));
    assert.equal(
      s.f.db.raw.prepare("SELECT active FROM users WHERE id=?").get(actor.id)
        .active,
      0,
    );
    assert.ok(
      s.f.db.raw
        .prepare("SELECT deleted_at FROM students WHERE id=?")
        .get(s.students[0]).deleted_at,
    );
  }));

test("恢复预览逐表对比当前行数和差值，文件内行数不匹配与0032旧迁移版本拒绝", () =>
  school(async (s) => {
    const file = await exportFile(s);
    ok(await request(s, "data/students", "POST", { name: "预览前新增" }));
    const result = ok(await preview(s, file), 201);
    assert.equal(result.migration_version, 35);
    assert.equal(result.current_counts.students, 3);
    assert.deepEqual(result.comparison.students, {
      backup: 2,
      current: 3,
      delta: -1,
    });
    let payload = await passwordOpen(file, PASSWORD);
    payload.counts.students = 999;
    ok(await preview(s, await passwordSeal(payload, PASSWORD)), 422);
    payload = await passwordOpen(file, PASSWORD);
    payload.schema_version = 33;
    payload.migration_version = 33;
    const denied = await preview(s, await passwordSeal(payload, PASSWORD));
    ok(denied, 422);
    assert.match(denied.body.message, /0035/);
  }));

test("不补课决定进入全量备份并整体恢复，恢复不会残留更新后的决定", () =>
  school(async (s) => {
    await pack(s);
    const lid = await lesson(s, "2026-11-09T09:00");
    ok(await status(s, lid, "student_leave"));
    const item = ok(await request(s, "todo/inbox?scope=all&type=makeup"))
      .items[0];
    const d = {
      version: item.primary_action.version,
      decision_version: 0,
      skip: true,
      reason: "确认不补",
    };
    ok(await request(s, "todo/makeups/" + item.id + "/skip", "POST", d));
    const file = await exportFile(s),
      decoded = await passwordOpen(file, PASSWORD);
    assert.equal(decoded.tables.makeup_decisions[0].skipped, 1);
    ok(
      await request(s, "todo/makeups/" + item.id + "/skip", "POST", {
        ...d,
        decision_version: 1,
        skip: false,
      }),
    );
    const p = ok(await preview(s, file), 201);
    ok(await confirm(s, p.id));
    assert.equal((await s.r.makeupDecision(item.id)).skipped, 1);
  }));
