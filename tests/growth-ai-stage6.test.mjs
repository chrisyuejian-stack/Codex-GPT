import test, { after } from "node:test";

import assert from "node:assert/strict";

import { mkdir, writeFile } from "node:fs/promises";

import { growthSchool, call, ok, submitFeedback, confirmFeedback } from "./fixtures-growth.mjs";

import { model, ai, aiExamples, until } from "./fixtures-ai.mjs";

test("YX6AI 反馈草稿仅用主讲原文、剔除评分、不写提交，采用通过原保存", () => growthSchool(async s => {
    model(s, {
        suggestions: [ {
            target: {
                student_id: "foreign"
            },
            payload: {
                message: {
                    learned: "节奏练习",
                    good: "节奏稳定",
                    attention: "句尾注意",
                    homework: "练习两遍"
                },
                scores: [ {
                    value: 5
                } ]
            },
            basis: []
        } ]
    });
    const before = s.f.db.raw.prepare("SELECT COUNT(*) n FROM lesson_submissions").get().n;
    const a = ok(await ai(s, "feedback/compose", {
        lesson_id: s.lid,
        student_id: s.students[0],
        tags: [ "节奏稳定" ],
        note: "节奏练习，句尾注意，练习两遍"
    }, crypto.randomUUID(), s.teacherAccount.token));
    assert.equal(a.suggestions[0].kind, "feedback.message");
    assert.equal(a.suggestions[0].target.student_id, s.students[0]);
    assert.equal(a.suggestions[0].payload.scores, undefined);
    assert.ok(a.suggestions[0].basis.some(x => x.type === "feedback" && x.date === "2026-11-10" && x.quote === "节奏稳定" && x.ref === "draft_feedback:" + s.lid + ":" + s.students[0]));
    assert.equal(s.f.db.raw.prepare("SELECT COUNT(*) n FROM lesson_submissions").get().n, before);
    const p = ok(await submitFeedback(s, {
        extra: {
            personal: [ {
                student_id: s.students[0],
                message: a.suggestions[0].payload.message
            } ],
            applied_suggestion_ids: [ a.suggestions[0].id ]
        }
    }));
    ok(await confirmFeedback(s, p.id));
    assert.ok(s.f.db.raw.prepare("SELECT doc_json FROM growth_feedback WHERE tenant_id=? AND student_id=?").get(s.t.id, s.students[0]).doc_json.includes(a.suggestions[0].id));
}));

after(async () => {
    await mkdir("work/stage6", {
        recursive: true
    });
    await writeFile("work/stage6/ai-http-" + (process.env.TEST_BUNDLE === "1" ? "bundle" : "source") + ".json", JSON.stringify({
        local_only: true,
        examples: aiExamples
    }, null, 2));
});

test("YX6AI compose拒绝非主讲、别的学生曲目和48小时窗口外请求，均不调用模型", () => growthSchool(async s => {
    model(s, {
        suggestions: [ {
            payload: {
                message: {
                    good: "节奏稳定"
                }
            }
        } ]
    });
    const input = {
        lesson_id: s.lid,
        student_id: s.students[0],
        note: "节奏稳定"
    };
    ok(await ai(s, "feedback/compose", input, crypto.randomUUID(), s.token), 403);
    const other = ok(await call(s, "students/" + s.students[1] + "/repertoire", "POST", {
        name: "另一个学生的曲目"
    }, s.academic.token), 201);
    ok(await ai(s, "feedback/compose", {
        ...input,
        repertoire_ids: [ other.id ]
    }, crypto.randomUUID(), s.teacherAccount.token), 404);
    const original = Date.now;
    Date.now = () => original() + 49 * 36e5;
    try {
        ok(await ai(s, "feedback/compose", input, crypto.randomUUID(), s.teacherAccount.token), 403);
    } finally {
        Date.now = original;
    }
    assert.equal(s.modelCalls.length, 0);
}));
