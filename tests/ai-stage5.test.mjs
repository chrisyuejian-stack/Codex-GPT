import test from "node:test";

import assert from "node:assert/strict";

import { school, call, ok, seed, accountToken, model, ai, until } from "./fixtures-ai.mjs";

test("YX5AI 固定键重放、不同请求422、进行中409与单人并发最多2个", () => school(async s => {
    await seed(s); const  resolvers = [];
    model(s, () => new Promise(resolve => resolvers.push(resolve)));
    const key = crypto.randomUUID(), data = {
        instruction: "调整设置"
    };
    const p1 = ai(s, "settings/propose", data, key);
    await until(() => resolvers.length === 1);
    assert.equal(ok(await ai(s, "settings/propose", data, key), 409).error, "in_progress");
    assert.equal(ok(await ai(s, "settings/propose", {
        ...data,
        instruction: "不同"
    }, key), 422).error, "idempotency_mismatch");
    const p2 = ai(s, "settings/propose", data);
    await until(() => resolvers.length === 2);
    assert.equal(ok(await ai(s, "settings/propose", data), 429).error, "rate_limited");
    resolvers.forEach(r => r({
        suggestions: []
    }));
    const first = ok(await p1);
    assert.equal(ok(await ai(s, "feedback/compose", data, key), 422).error, "idempotency_mismatch");
    ok(await p2);
    assert.deepEqual(ok(await ai(s, "settings/propose", data, key)), first);
    assert.equal(s.modelCalls.length, 2);
}));

test("YX5AI 十分钟缓存过期后从重放凭据恢复原usage和原建议，不增加记录或调用", () => school(async s => {
    await seed(s);
    model(s, {
        suggestions: [ {
            payload: {
                ops: [{op:"update",entity:"calendar",key:"grade_exam",field:"months",from:ok(await call(s,"settings/calendar")).items.find(x=>x.key==="grade_exam").months,to:[1,11]}]
            }
        } ]
    });
    const key = crypto.randomUUID(), data = {
        instruction: "调整设置"
    };
    const first = ok(await ai(s, "settings/propose", data, key));
    ok(await ai(s, "settings/propose", data));
    s.f.db.raw.prepare("UPDATE ai_requests SET response=NULL,cache_expires_at=1 WHERE tenant_id=? AND idem_key=?").run(s.t.id, key);
    assert.deepEqual(ok(await ai(s, "settings/propose", data, key)), first);
    assert.equal(s.modelCalls.length, 2);
    assert.equal(first.usage.used_today, 1);
    assert.equal(ok(await call(s, "ai/usage")).fast.used, 2);
    assert.equal(s.f.db.raw.prepare("SELECT COUNT(*) n FROM ai_usage WHERE tenant_id=?").get(s.t.id).n, 2);
}));

test("YX5AI 模型错误和两次解析失败不计次数，同键失败可重试", () => school(async s => {
    await seed(s);
    model(s, () => {
        throw Error("local model failure");
    });
    const key = crypto.randomUUID(), data = {
        instruction: "调整设置"
    };
    assert.equal(ok(await ai(s, "settings/propose", data, key), 502).error, "ai_unavailable");
    assert.equal(ok(await call(s, "ai/usage")).fast.used, 0);
    model(s, {
        suggestions: []
    });
    ok(await ai(s, "settings/propose", data, key));
    assert.equal(ok(await call(s, "ai/usage")).fast.used, 1);
    model(s, {
        content: "not JSON"
    });
    ok(await ai(s, "settings/propose", data), 502);
    assert.equal(s.modelCalls.length, 2);
    assert.equal(ok(await call(s, "ai/usage")).fast.used, 1);
}));

test("YX5AI 第81次快速请求429，深度独立，GET用量无需幂等键", () => school(async s => {
    await seed(s);
    model(s);
    for (let i = 0; i < 80; i++) ok(await ai(s, "settings/propose", {
        instruction: "调整设置"
    }));
    const denied = ok(await ai(s, "settings/propose", {
        instruction: "调整设置"
    }), 429);
    assert.equal(denied.error, "ai_quota_exceeded");
    assert.equal(denied.details.limit, 80);
    assert.match(denied.details.reset_at, /T00:00:00/);
    ok(await ai(s, "settings/propose", {
        instruction: "调整设置",
        tier: "deep"
    }));
    const usage = ok(await call(s, "ai/usage"));
    assert.equal(usage.fast.used, 80);
    assert.equal(usage.deep.used, 1);
    const original = Date.now;
    Date.now = () => Date.parse(denied.details.reset_at) + 1;
    try {
        const {b64: b64, bytes: bytes, sha: sha} = await import("../src/server/core.js"), token = b64(bytes(32));
        await s.r.createSession(await sha(token), await s.r.user(s.user.id), {
            ip: "test",
            ua: "new-day"
        });
        assert.equal(ok(await ai(s, "settings/propose", {
            instruction: "调整设置"
        }, crypto.randomUUID(), token)).usage.used_today, 1);
    } finally {
        Date.now = original;
    }
}));

test("YX5AI 20账号并发抢剩余3次，仅3个模型调用且用量准确至80", () => school(async s => {
    await seed(s); const  people = [];
    for (let i = 0; i < 20; i++) people.push(await accountToken(s, [ "consultant" ]));
    const date = (new Date).toLocaleDateString("sv-SE", {
        timeZone: "Asia/Shanghai"
    });
    s.f.db.raw.prepare("INSERT INTO ai_quota_daily(tenant_id,id,date,tier,used) VALUES(?,?,?,?,77)").run(s.t.id, date + ":fast", date, "fast");
    const resolvers = [];
    model(s, () => new Promise(r => resolvers.push(r)));
    let denied = 0;
    const requests = people.map(person => ai(s, "settings/propose", {
        instruction: "调整设置"
    }, crypto.randomUUID(), person.token).then(r => {
        if (r.status === 429) denied++;
        return r;
    }));
    await until(() => resolvers.length === 3 && denied === 17);
    resolvers.forEach(r => r({
        suggestions: []
    }));
    const results = await Promise.all(requests);
    assert.equal(results.filter(r => r.status === 200).length, 3);
    assert.equal(results.filter(r => r.status === 429).length, 17);
    assert.deepEqual(results.filter(r => r.status === 200).map(r => r.body.usage.used_today).sort(), [ 78, 79, 80 ]);
    assert.equal(ok(await call(s, "ai/usage")).fast.used, 80);
}));

test("YX5AI 120秒预占自动不再占位，过期结算重新抢名额，重复结算不二次扣费", () => school(async s => {
    const {aiDate: aiDate} = await import("../src/server/ai.js");
    const at = Date.now(), record = {
        id: "air_direct",
        user_id: s.user.id,
        idem_key: crypto.randomUUID(),
        request_hash: "hash",
        path: "/api/ai/settings/propose",
        hold_id: "hold_direct",
        date: aiDate(at),
        tier: "fast",
        deadline_at: at + 45e3
    };
    assert.equal((await s.r.aiAcquire(record, null, 1, at)).ok, true);
    assert.equal((await s.r.aiCapacity(s.user.id, record.date, "fast", 1, at + 120001)).held, 0);
    const response = {
        suggestions: [],
        warnings: [],
        usage: {
            tier: "fast",
            used_today: 0,
            limit: 1
        }
    }, metrics = {
        tool: "content",
        action: "versions",
        model: "local",
        prompt_tokens: 0,
        completion_tokens: 0,
        duration_ms: 120001
    };
    assert.equal((await s.r.aiFinish(record, response, [], metrics, 1, at + 120001)).ok, true);
    assert.equal(await s.r.aiDayUsed(record.date, "fast"), 1);
    assert.equal((await s.r.aiFinish(record, response, [], metrics, 10, at + 120002)).replay, true);
    assert.equal(await s.r.aiDayUsed(record.date, "fast"), 1);
    assert.equal(s.f.db.raw.prepare("SELECT COUNT(*) n FROM ai_usage WHERE tenant_id=?").get(s.t.id).n, 1);
}));

test("YX5AI 过期后配额已满丢弃结果并记录blocked_after_expiry", () => school(async s => {
    const {aiDate: aiDate} = await import("../src/server/ai.js"), at = Date.now(), record = {
        id: "air_expired",
        user_id: s.user.id,
        idem_key: crypto.randomUUID(),
        request_hash: "hash",
        path: "/api/ai/settings/propose",
        hold_id: "hold_expired",
        date: aiDate(at),
        tier: "fast",
        deadline_at: at + 45e3
    };
    assert.equal((await s.r.aiAcquire(record, null, 1, at)).ok, true);
    s.f.db.raw.prepare("INSERT INTO ai_quota_daily(tenant_id,id,date,tier,used) VALUES(?,?,?,?,1)").run(s.t.id, record.date + ":fast", record.date, "fast");
    const done = await s.r.aiFinish(record, {
        suggestions: [],
        warnings: [],
        usage: {
            tier: "fast",
            used_today: 0,
            limit: 1
        }
    }, [], {
        tool: "content",
        action: "versions",
        model: "local",
        prompt_tokens: 1,
        completion_tokens: 1,
        duration_ms: 120001
    }, 1, at + 120001);
    assert.equal(done.blocked, true);
    assert.equal((await s.r.aiHold(record.hold_id)).status, "expired");
    assert.equal(s.f.db.raw.prepare("SELECT result FROM ai_usage WHERE tenant_id=?").get(s.t.id).result, "blocked_after_expiry");
    assert.equal(await s.r.aiDayUsed(record.date, "fast"), 1);
}));

test("YX5AI 跨日按预占日期结算；次日用量独立", () => school(async s => {
    const at = Date.parse("2026-11-14T23:59:50+08:00"), record = {
        id: "air_midnight",
        user_id: s.user.id,
        idem_key: crypto.randomUUID(),
        request_hash: "hash",
        path: "/api/ai/settings/propose",
        hold_id: "hold_midnight",
        date: "2026-11-14",
        tier: "fast",
        deadline_at: at + 45e3
    };
    assert.equal((await s.r.aiAcquire(record, null, 80, at)).ok, true);
    await s.r.aiFinish(record, {
        suggestions: [],
        warnings: [],
        usage: {
            tier: "fast",
            used_today: 0,
            limit: 80
        }
    }, [], {
        tool: "content",
        action: "versions",
        model: "local",
        prompt_tokens: 1,
        completion_tokens: 1,
        duration_ms: 2e4
    }, 80, at + 2e4);
    assert.equal(await s.r.aiDayUsed("2026-11-14", "fast"), 1);
    assert.equal(await s.r.aiDayUsed("2026-11-15", "fast"), 0);
}));

test("YX5AI 批量基础预占min人数剩余额度，每位成功计次，一批只占一个并发名额", () => school(async s => {
    const {aiDate: aiDate} = await import("../src/server/ai.js"), at = Date.now(), date = aiDate(at), parent = {
        id: "air_batch",
        user_id: s.user.id,
        idem_key: crypto.randomUUID(),
        request_hash: "hash",
        path: "/api/ai/test-batch",
        date: date,
        tier: "fast",
        deadline_at: at + 45e3
    };
    const batch = await s.r.aiReserveBatch(parent, s.students, 2, at);
    assert.equal(batch.ok, true);
    assert.equal(batch.records.length, 2);
    assert.equal(batch.skipped.length, 1);
    assert.equal((await s.r.aiCapacity(s.user.id, date, "fast", 2, at)).pending, 1);
    for (const record of batch.records) {
        await s.r.aiFinish(record, {
            suggestions: [],
            warnings: [],
            usage: {
                tier: "fast",
                used_today: 0,
                limit: 2
            }
        }, [], {
            tool: "settings",
            action: "batch-draft",
            model: "local",
            prompt_tokens: 1,
            completion_tokens: 1,
            duration_ms: 1
        }, 2, at + 1);
    }
    const response = {
        suggestions: [],
        warnings: [],
        processed: batch.records.map(r => r.student_id),
        skipped: batch.skipped,
        usage: {
            tier: "fast",
            used_today: 2,
            limit: 2
        }
    };
    await s.r.aiCompleteBatch(parent, response, at + 2);
    assert.equal(await s.r.aiDayUsed(date, "fast"), 2);
    s.f.db.raw.prepare("UPDATE ai_requests SET response=NULL WHERE tenant_id=? AND id=?").run(s.t.id, parent.id);
    assert.deepEqual(await s.r.aiReplay(await s.r.aiRequestId(parent.id)), response);
}));

test("YX5AI 请求按机构隔离且忽略伪造tenant，学员财务看不到AI明细，机构用量隔离", () => school(async s => {
    await seed(s); const  other = await (await import("./fixtures-credit.mjs")).setup(s.f, 1, "ai-other");
    other.f = s.f;
    model(s);
    model(other);
    ok(await ai(other, "settings/propose", {
        instruction: "调整设置"
    }));
    assert.equal(other.modelCalls.length, 1);
    const own = ok(await ai(s, "settings/propose", {
        instruction: "调整设置",
        tenant_id: other.t.id,
        user_id: other.user.id
    }));
    assert.equal(own.usage.used_today, 1);
    assert.equal(ok(await call(other, "ai/usage")).fast.used, 1);
    const finance = await accountToken(s, [ "finance" ]), academic = await accountToken(s, [ "academic" ]);
    for (const person of [ finance ]) {
        const usage = ok(await call(s, "ai/usage", "GET", undefined, person.token));
        assert.equal(usage.by_user, undefined);
        assert.equal(usage.by_tool, undefined);
        ok(await ai(s, "settings/propose", {
            instruction: "调整设置"
        }, crypto.randomUUID(), person.token), 403);
    }
    const {studentAccount: studentAccount} = await import("./fixtures-plans.mjs");
    const pa = await studentAccount(s);
    ok(await call(s, "ai/usage", "GET", undefined, pa.token),403);
    ok(await ai(s, "settings/propose", {
        instruction: "调整设置"
    }, crypto.randomUUID(), pa.token), 403);
}));

test("YX5AI 缺幂等键、无效档位和外机构plan在预占前拒绝", () => school(async s => {
    await seed(s);
    model(s);
    ok(await call(s, "ai/settings/propose", "POST", {
        instruction: "调整设置"
    }), 422);
    ok(await ai(s, "settings/propose", {
        instruction: "调整设置",
        tier: "bad"
    }), 422);
    ok(await ai(s, "plan/polish", {
        plan_id: "pln_foreign"
    }), 404);
    assert.equal(s.modelCalls.length, 0);
    assert.equal(s.f.db.raw.prepare("SELECT COUNT(*) n FROM ai_quota_holds WHERE tenant_id=?").get(s.t.id).n, 0);
}));

test("YX5AI 内部模型和额度设置生效，设置建议快速深度硬截止分别45/90秒", () => school(async s => {
    await seed(s);
    model(s, request => {
        assert.ok(request.signal instanceof AbortSignal);
        assert.ok(Math.abs(request.deadline_at - Date.now() - (request.tier === "fast" ? 45e3 : 90e3)) < 2e3);
        return {
            suggestions: []
        };
    });
    s.f.db.raw.prepare("UPDATE ai_settings SET fast_daily_limit=1,deep_daily_limit=0 WHERE id='main' AND ? IS NOT NULL").run(s.t.id);
    const r = ok(await ai(s, "settings/propose", {
        instruction: "调整设置",
        model: "injected",
        endpoint: "https://invalid.test"
    }));
    assert.equal(r.usage.limit, 1);
    assert.equal(s.modelCalls[0].model, "local-fast");
    assert.equal(ok(await ai(s, "settings/propose", {
        instruction: "调整设置",
        tier: "deep"
    }), 429).details.limit, 0);
}));

test("YX5AI 硬截止后才返回的结果丢弃，解析重试不延长原截止", () => school(async s => {
    await seed(s); const  original = Date.now;
    let clock = original();
    Date.now = () => clock;
    try {
        model(s, (_, n) => {
            clock += 1e4;
            return n === 1 ? {
                content: "bad"
            } : {
                suggestions: []
            };
        });
        ok(await ai(s, "settings/propose", {
            instruction: "调整设置"
        }));
        assert.equal(s.modelCalls.length, 2);
        assert.equal(s.modelCalls[0].deadline_at, s.modelCalls[1].deadline_at);
        model(s, () => {
            clock += 46e3;
            return {
                suggestions: []
            };
        });
        assert.equal(ok(await ai(s, "settings/propose", {
            instruction: "调整设置"
        }), 502).error, "ai_timeout");
        assert.equal(ok(await call(s, "ai/usage")).fast.used, 1);
    } finally {
        Date.now = original;
    }
}));

test("YX5AI settings/propose仅建议，经过既有校验后可走修改卡片审批", () => school(async s => {
    await seed(s);
    const calendar = ok(await call(s, "settings/calendar"));
    const original = calendar.items.find(x => x.key === "grade_exam");
    model(s, {
        suggestions: [ {
            payload: {
                ops: [ {
                    op: "update",
                    entity: "calendar",
                    key: "grade_exam",
                    field: "months",
                    from: original.months,
                    to: [ 1, 11 ]
                } ],
                affected: {
                    plans_in_progress: 999
                }
            }
        } ]
    });
    const r = ok(await ai(s, "settings/propose", {
        instruction: "考级改到11月"
    }));
    assert.equal(r.suggestions[0].kind, "settings.change");
    assert.notEqual(r.suggestions[0].payload.affected.plans_in_progress, 999);
    assert.deepEqual(ok(await call(s, "settings/calendar")).items.find(x => x.key === "grade_exam").months, original.months);
    const card = ok(await call(s, "settings/changes", "POST", {
        suggestion_id: r.suggestions[0].id,
        payload: r.suggestions[0].payload
    }), 201);
    ok(await call(s, "settings/changes/" + card.id + "/approve", "POST", {
        version: card.version
    }));
    assert.deepEqual(ok(await call(s, "settings/calendar")).items.find(x => x.key === "grade_exam").months, [ 1, 11 ]);
}));

import { after } from "node:test";

import { mkdir, writeFile } from "node:fs/promises";

import { aiExamples } from "./fixtures-ai.mjs";

import { examples } from "./fixtures-plans.mjs";

after(async () => {
    await mkdir("work/stage5", {
        recursive: true
    });
    await writeFile("work/stage5/ai-http-" + (process.env.TEST_BUNDLE === "1" ? "bundle" : "source") + ".json", JSON.stringify({
        local_only: true,
        examples: [ ...aiExamples, ...examples.filter(x => /\/api\/ai\/usage/.test(x.request.path)) ]
    }, null, 2) + "\n");
});

test("YX5AI 结算数据库失败四项同事务回滚，成功重试只扣一次", () => school(async s => {
    await seed(s);
    model(s, {
        suggestions: [ {
            payload: {
                ops: [{op:"update",entity:"calendar",key:"grade_exam",field:"months",from:ok(await call(s,"settings/calendar")).items.find(x=>x.key==="grade_exam").months,to:[1,11]}]
            }
        } ]
    });
    const key = crypto.randomUUID(), data = {
        instruction: "调整设置"
    };
    s.f.db.raw.exec("CREATE TRIGGER ai_test_fail BEFORE INSERT ON ai_usage WHEN NEW.result='ok' BEGIN SELECT RAISE(ABORT,'local_fail'); END");
    ok(await ai(s, "settings/propose", data, key), 502);
    assert.equal(ok(await call(s, "ai/usage")).fast.used, 0);
    assert.equal(s.f.db.raw.prepare("SELECT COUNT(*) n FROM ai_suggestions WHERE tenant_id=?").get(s.t.id).n, 0);
    assert.equal(s.f.db.raw.prepare("SELECT status FROM ai_requests WHERE tenant_id=?").get(s.t.id).status, "failed");
    s.f.db.raw.exec("DROP TRIGGER ai_test_fail");
    ok(await ai(s, "settings/propose", data, key));
    assert.equal(ok(await call(s, "ai/usage")).fast.used, 1);
}));

test("YX5AI 10分钟缓存清理仍可重放；两天后清请求/预占，七天后清未引用建议", () => school(async s => {
    await seed(s);
    model(s, {
        suggestions: [ {
            payload: {
                ops: [{op:"update",entity:"calendar",key:"grade_exam",field:"months",from:ok(await call(s,"settings/calendar")).items.find(x=>x.key==="grade_exam").months,to:[1,11]}]
            }
        } ]
    });
    const key = crypto.randomUUID(), first = ok(await ai(s, "settings/propose", {
        instruction: "调整设置"
    }, key)), at = Date.now();
    await s.r.aiCleanup(at + 600001);
    const record = await s.r.aiRequest(s.user.id, key);
    assert.equal(record.response, null);
    assert.deepEqual(await s.r.aiReplay(record), first);
    await s.r.aiCleanup(at + 2 * 864e5 + 1e3);
    assert.equal(await s.r.aiRequest(s.user.id, key), null);
    assert.equal(s.f.db.raw.prepare("SELECT COUNT(*) n FROM ai_quota_holds WHERE tenant_id=?").get(s.t.id).n, 0);
    assert.equal(s.f.db.raw.prepare("SELECT COUNT(*) n FROM ai_suggestions WHERE tenant_id=?").get(s.t.id).n, 1);
    await s.r.aiCleanup(at + 7 * 864e5 + 1e3);
    assert.equal(s.f.db.raw.prepare("SELECT COUNT(*) n FROM ai_suggestions WHERE tenant_id=?").get(s.t.id).n, 0);
}));

test("YX5AI 被修改卡引用的过期建议保留审计外键，但不能再被采纳", () => school(async s => {
    await seed(s);
    const c = ok(await call(s, "settings/calendar")), exam = c.items.find(x => x.key === "grade_exam");
    model(s, {
        suggestions: [ {
            payload: {
                ops: [ {
                    op: "update",
                    entity: "calendar",
                    key: "grade_exam",
                    field: "months",
                    from: exam.months,
                    to: [ 11 ]
                } ]
            }
        } ]
    });
    const suggestion = ok(await ai(s, "settings/propose", {
        instruction: "调整考级"
    })).suggestions[0];
    const card = ok(await call(s, "settings/changes", "POST", {
        suggestion_id: suggestion.id,
        payload: suggestion.payload
    }), 201);
    await s.r.aiCleanup(Date.now() + 8 * 864e5);
    assert.ok(s.f.db.raw.prepare("SELECT id FROM ai_suggestions WHERE tenant_id=? AND id=?").get(s.t.id, suggestion.id));
    assert.deepEqual(s.f.db.raw.prepare("PRAGMA foreign_key_check").all(), []);
    assert.ok(ok(await call(s, "settings/changes")).items.some(x => x.id === card.id));
    s.f.db.raw.prepare("UPDATE ai_suggestions SET expires_at=1 WHERE tenant_id=? AND id=?").run(s.t.id, suggestion.id);
    ok(await call(s, "settings/changes", "POST", {
        suggestion_id: suggestion.id,
        payload: suggestion.payload
    }), 404);
}));

test("YX5AI 生产DeepSeek HTTP适配器仅访问固定地址，模型与密钥来自内部配置", () => school(async s => {
    await seed(s);
    s.f.db.raw.prepare("UPDATE ai_settings SET configured=1,fast_model='configured-provider-model'").run();
    s.f.env.DEEPSEEK_API_KEY = "local-fake-provider-key";
    const original = globalThis.fetch;
    let seen = 0;
    globalThis.fetch = async (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url === "https://api.deepseek.com/chat/completions") {
            seen++;
            const data = JSON.parse(init.body);
            assert.equal(data.model, "configured-provider-model");
            assert.equal(init.headers.Authorization, "Bearer local-fake-provider-key");
            assert.equal(data.stream, false);
            assert.ok(init.signal instanceof AbortSignal);
            return Response.json({
                choices: [ {
                    message: {
                        content: JSON.stringify({
                            suggestions: []
                        })
                    }
                } ],
                usage: {
                    prompt_tokens: 11,
                    completion_tokens: 3
                }
            });
        }
        return original(input, init);
    };
    try {
        const r = ok(await ai(s, "settings/propose", {
            instruction: "调整设置",
            model: "ignored",
            endpoint: "https://ignored.invalid"
        }));
        assert.equal(seen, 1);
        assert.equal(r.usage.used_today, 1);
        assert.equal(s.f.db.raw.prepare("SELECT prompt_tokens FROM ai_usage WHERE tenant_id=?").get(s.t.id).prompt_tokens, 11);
    } finally {
        globalThis.fetch = original;
    }
}));

test('YX5AI 成功只写AI专用记录，不修改课程、线索或学员',()=>school(async s=>{
 await seed(s);const db=s.f.db.raw,tables=['offer_courses','leads','students'],before=Object.fromEntries(tables.map(t=>[t,db.prepare('SELECT * FROM '+t).all()]));
 model(s);const r=ok(await ai(s,'settings/propose',{instruction:'测试设置建议'}));assert.equal(r.usage.used_today,1);for(const t of tables)assert.deepEqual(db.prepare('SELECT * FROM '+t).all(),before[t]);assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_usage WHERE tenant_id=?').get(s.t.id).n,1);
}));
