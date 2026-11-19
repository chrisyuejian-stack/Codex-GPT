import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support.mjs";
import { setup, request } from "./fixtures-credit.mjs";
import { startBackup, continueBackup, backupPage } from "../src/server/backup.js";

const ok = (r, code = 200) => {
  assert.equal(r.status, code, r.text);
  assert.ok(r.queries <= 40);
  return r.body;
};

test("第六阶段：暂存快照不随日常写入改变，断点续传；只清理超过30天的本应用备份", async () => {
  const f = await fixture();
  try {
    const s = { ...(await setup(f)), f };
    const backup = await startBackup(f.env);
    const row = (await request(s, "data/students/" + s.students[0])).body
      .record;
    ok(
      await request(s, "data/students/" + row.id, "PATCH", {
        version: row.version,
        name: "快照后改名",
      }),
    );
    await continueBackup(f.env, Date.now(), 1);
    const oldDay = new Date(Date.now() - 32 * 86400000)
        .toISOString()
        .slice(0, 10),
      newDay = new Date(Date.now() - 28 * 86400000).toISOString().slice(0, 10);
    await f.env.CHANNEL_BACKUPS.put(
      "daily/" + oldDay + "/bak_old/file.enc",
      "old",
    );
    await f.env.CHANNEL_BACKUPS.put(
      "daily/" + newDay + "/bak_new/file.enc",
      "keep",
    );
    await f.env.CHANNEL_BACKUPS.put("other/file.enc", "unrelated");
    while (!(await continueBackup(f.env)).done) {}
    const page = await backupPage(f.env, backup.id, "students", 0, s.t.id);
    assert.ok(page.rows.some((r) => r.id === row.id && r.name === row.name));
    assert.ok(!page.rows.some((r) => r.name === "快照后改名"));
    assert.ok(
      !f.env.CHANNEL_BACKUPS.objects.has(
        "daily/" + oldDay + "/bak_old/file.enc",
      ),
    );
    assert.ok(
      f.env.CHANNEL_BACKUPS.objects.has(
        "daily/" + newDay + "/bak_new/file.enc",
      ),
    );
    assert.ok(f.env.CHANNEL_BACKUPS.objects.has("other/file.enc"));
    assert.equal(
      f.db.raw.prepare("SELECT COUNT(*) n FROM backup_snapshot_rows").get().n,
      0,
    );
  } finally {
    f.restore();
  }
});
