import test from 'node:test';
import assert from 'node:assert/strict';
import { growthSchool, call, ok } from "./fixtures-growth.mjs";

test("YX6G 曲目完成日期、状态和 DTO", () => growthSchool(async s => {
    let rep = ok(await call(s, "students/" + s.students[0] + "/repertoire", "POST", {
        name: "小步舞曲",
        status: "learning",
        start_date: "2026-11-01"
    }, s.teacherAccount.token), 201);
    rep = ok(await call(s, "students/" + s.students[0] + "/repertoire", "PUT", {
        id: rep.id,
        version: rep.version,
        status: "done",
        completed_date: "2026-11-03"
    }, s.teacherAccount.token));
    assert.equal(ok(await call(s, "students/" + s.students[0] + "/repertoire", "GET", undefined, s.teacherAccount.token)).items[0].status, "done");
    assert.equal(rep.tenant_id, undefined);
}));
test("YX6G 跨机构曲目统一404", () => growthSchool(async s => {
    const {setup: setup} = await import("./fixtures-credit.mjs"), other = await setup(s.f, 1, "growth-other");
    other.f = s.f;
    ok(await call(other, "students/" + s.students[0] + "/repertoire"), 404);
}));
