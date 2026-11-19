import {historicalDatabase} from './fixtures-historical.mjs';
import test from "node:test";

import assert from "node:assert/strict";

import { readFile } from "node:fs/promises";

import { growthSchool, call, ok, submitFeedback, confirmFeedback } from "./fixtures-growth.mjs";

test("YX6I 0001–0022与阶段5逐字节相同；0023仅扩展旧点评字段、保留原列原值且可升级",async()=>{const db=await historicalDatabase(22);try{db.prepare("INSERT INTO tenants(id,slug,name,type,city,status,staff_seat_limit,student_seat_limit,created_at,created_by,updated_at,updated_by) VALUES('old','old-school','历史','其他','','active',10,20,1,'old',1,'old')").run();const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name),before=Object.fromEntries(tables.map(t=>[t,db.prepare('SELECT * FROM '+t).all()]));db.exec(await readFile('migrations/0023_feedback_and_growth_reports.sql','utf8'));for(const t of tables)for(const row of before[t])assert.ok(db.prepare('SELECT * FROM '+t).all().some(after=>Object.keys(row).every(k=>after[k]===row[k])),t);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);}finally{db.close();}});

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

test("YX6I 未登录新接口401，其他实例会话401，机构状态字段不影响登录", () => growthSchool(async s => {
    for (const path of [ "feedback/today", "students/" + s.students[0] + "/repertoire" ]) ok(await call(s, path, "GET", undefined, null), 401);
    const {setup: setup} = await import("./fixtures-credit.mjs"), other = await setup(s.f, 1, "othergrowthscope");
    other.f = s.f;
    ok(await call(s, "/" + other.t.slug + "/api/students/" + s.students[0] + "/repertoire"), 401);
    s.f.db.raw.prepare("UPDATE tenants SET status='paused' WHERE id=?").run(s.t.id);
    ok(await call(s, "students/" + s.students[0] + "/repertoire"));
    assert.ok(s.f.db.raw.prepare("SELECT * FROM sessions WHERE tenant_id=? AND user_id=?").get(s.t.id, s.user.id));
    s.f.db.raw.prepare("UPDATE tenants SET status='active' WHERE id=?").run(s.t.id);
    ok(await call(s, "students/" + s.students[0] + "/repertoire"));
}));
