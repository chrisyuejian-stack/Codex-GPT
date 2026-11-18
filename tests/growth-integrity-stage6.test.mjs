import test from "node:test";

import assert from "node:assert/strict";

import { readFile } from "node:fs/promises";

import { createHash } from "node:crypto";

import { growthSchool, call, ok, submitFeedback, confirmFeedback, parent } from "./fixtures-growth.mjs";

import { fixture } from "./support.mjs";

import { mobileSetup, proposal, decide, MOBILE_NOW } from "./fixtures-mobile.mjs";

test("YX6I 0001–0022与阶段5逐字节相同；0023仅扩展旧点评字段、保留原列原值且可升级", async () => {
    const base = JSON.parse(await readFile("docs/reference/stage6-start-baseline-sha256.json", "utf8"));
    for (const e of base.files.filter(x => x.path.startsWith("migrations/"))) assert.equal(createHash("sha256").update(await readFile(e.path)).digest("hex"), e.sha256, e.path);
    const old = Date.now;
    Date.now = () => MOBILE_NOW;
    const f = await fixture({
        migrateGrowth: false
    });
    try {
        const s = await mobileSetup(f, 1, "upgradegrowth");
        s.f = f;
        f.db.raw.prepare("UPDATE tenant_modules SET enabled=0 WHERE tenant_id=? AND id='feedback'").run(s.t.id);
        const proposed = ok(await proposal(s));
        ok(await decide(s, proposed.id));
        const tables = f.db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x => x.name), before = Object.fromEntries(tables.map(n => [ n, f.db.raw.prepare("SELECT * FROM " + n).all().map(x => JSON.stringify(x)) ]));
        f.db.raw.exec(await readFile("migrations/0023_feedback_and_growth_reports.sql", "utf8"));
        for (const n of tables) {
            const after = new Set(f.db.raw.prepare("SELECT * FROM " + n).all().map(x => {
                delete x.personal_json;
                delete x.feedback_versions_json;
                return JSON.stringify(x);
            }));
            for (const row of before[n]) assert.ok(after.has(row), n);
        }
        f.db.raw.prepare("UPDATE tenant_modules SET enabled=1 WHERE tenant_id=? AND id='feedback'").run(s.t.id);
        const pa = await parent(s);
        assert.equal(ok(await call(s, "parent/children/" + s.students[0] + "/feed", "GET", undefined, pa.token)).items.length, 1);
        ok(await call(s, "feedback/" + proposed.id + "/" + s.students[0] + "/copied", "POST", {}, s.teacherAccount.token));
        assert.deepEqual(f.db.raw.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
        f.restore();
        Date.now = old;
    }
});

test("YX6I 新增结构及已发布修订纳入全量加密快照，修订/已确认反馈不可覆盖", () => growthSchool(async s => {
    const rep = ok(await call(s, "students/" + s.students[0] + "/repertoire", "POST", {
        name: "小步舞曲"
    }, s.teacherAccount.token), 201);
    const submitted = ok(await submitFeedback(s));
    ok(await confirmFeedback(s, submitted.id));
    ok(await call(s, "feedback/" + submitted.id + "/" + s.students[0] + "/copied", "POST", {}, s.teacherAccount.token));
    const {startBackup: startBackup} = await import("../src/server/backup.js");
    await startBackup(s.f.env, Date.now());
    for (const table of [ "lesson_submissions", "lesson_comments", "growth_repertoire", "growth_feedback_copies" ]) assert.ok(s.f.db.raw.prepare("SELECT row_json FROM backup_snapshot_rows WHERE table_name=? AND tenant_id=?").get(table, s.t.id), table);
    assert.equal(s.f.db.raw.prepare("SELECT type FROM sqlite_master WHERE name='growth_feedback'").get().type, "view");
    assert.throws(() => s.f.db.raw.prepare("UPDATE growth_feedback SET doc_json='{}' WHERE status='confirmed'").run(), /growth_feedback_immutable/);
    assert.deepEqual(s.f.db.raw.prepare("PRAGMA foreign_key_check").all(), []);
}));

test("YX6I 未登录新接口401，跨机构会话404，到期403且原会话保留", () => growthSchool(async s => {
    for (const path of [ "feedback/today", "students/" + s.students[0] + "/repertoire" ]) ok(await call(s, path, "GET", undefined, null), 401);
    const {setup: setup} = await import("./fixtures-credit.mjs"), other = await setup(s.f, 1, "othergrowthscope");
    other.f = s.f;
    ok(await call(s, "/" + other.t.slug + "/api/students/" + s.students[0] + "/repertoire"), 404);
    s.f.db.raw.prepare("UPDATE tenants SET status='paused' WHERE id=?").run(s.t.id);
    assert.equal(ok(await call(s, "students/" + s.students[0] + "/repertoire"), 403).error, "tenant_expired");
    assert.ok(s.f.db.raw.prepare("SELECT * FROM sessions WHERE tenant_id=? AND user_id=?").get(s.t.id, s.user.id));
    s.f.db.raw.prepare("UPDATE tenants SET status='active' WHERE id=?").run(s.t.id);
    ok(await call(s, "students/" + s.students[0] + "/repertoire"));
}));
