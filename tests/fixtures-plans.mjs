import assert from "node:assert/strict";

import { fixture } from "./support.mjs";

import { setup, accountToken } from "./fixtures-credit.mjs";

import { b64, bytes, sha } from "../src/server/core.js";

export const examples = [];

export async function call(s, path, method = "GET", data, token = s.token, extra = {}) {
    const url = path.startsWith("/") ? path : "/" + s.t.slug + "/api/" + path;
    const headers = {
        Origin: "https://school.test",
        "Content-Type": "application/json",
        ...token ? {
            Cookie: (url.startsWith("/api/") ? "__Host-yx_session=" : "channel_session=") + token
        } : {},
        ...extra
    };
    const response = await s.f.request("https://school.test" + url, {
        method: method,
        headers: headers,
        body: data === undefined ? undefined : JSON.stringify(data)
    });
    const raw = new Uint8Array(await response.arrayBuffer()), text = new TextDecoder().decode(raw);
    let body;
    try {
        body = JSON.parse(text);
    } catch {
        body = text;
    }
    const result = {
        status: response.status,
        body: body,
        text: text,
        headers: response.headers,
        queries: Number(response.headers.get("x-test-d1-queries"))
    };
    examples.push({
        request: {
            method: method,
            path: url,
            body: data ?? null,
            authenticated: !!token
        },
        response: {
            status: response.status,
            body: (response.headers.get("content-type")||"").startsWith("image/") ? {binary:true,mime:response.headers.get("content-type"),base64:Buffer.from(raw).toString("base64")} : body,
            queries: result.queries
        }
    });
    return result;
}

export function ok(r, status = 200) {
    assert.equal(r.status, status, r.text || JSON.stringify(r.body));
    return r.body;
}

export async function school(fn) {
    const f = await fixture();
    try {
        const s = await setup(f, 3, "yx4");
        s.f = f;
        await fn(s);
    } finally {
        f.restore();
    }
}

export async function seed(s, subject = "music_interest") {
    ok(await call(s, "settings/subjects", "POST", {
        key: subject
    }));
    const types = ok(await call(s, "settings/stage-types")).items;
    return types.filter(x => x.subject === subject);
}

export async function course(s, name = "钢琴一对一", amount = 200, mode = "per_unit", extra = {}) {
    const data = {
        subject: "music_interest",
        name: name,
        group: "主修",
        form: "one_to_one",
        minutes: 45,
        duration_text: null,
        pricing: {
            mode: mode,
            amount: amount,
            unit_label: mode === "package" ? "包" : "课时",
            ...mode === "package" ? {
                units_per_package: 10
            } : {}
        },
        ...extra
    };
    const existing = ok(await call(s, "settings/courses?include_inactive=1&q=" + encodeURIComponent(name))).items.find(x => x.name === name && x.subject === data.subject);
    return existing ? ok(await call(s, "settings/courses/" + existing.id, "PUT", {
        ...data,
        version: existing.version
    })) : ok(await call(s, "settings/courses", "POST", data), 201);
}

export async function parent(s, indices = [ 0 ]) {
    let user;
    for (const index of indices) {
        const r = ok(await call(s, "students/" + s.students[index] + "/guardians", "POST", {
            name: "家长",
            phone: "13812344321",
            relation: "mother"
        }), 201);
        user = r.parent || r.user || r;
    }
    const row = s.f.db.raw.prepare("SELECT * FROM users WHERE tenant_id=? AND roles='[\"parent\"]'").get(s.t.id);
    s.f.db.raw.prepare("UPDATE users SET must_change=0 WHERE tenant_id=? AND id=?").run(s.t.id, row.id);
    const token = b64(bytes(32));
    await s.r.createSession(await sha(token), await s.r.user(row.id), {
        ip: "test",
        ua: "plans"
    });
    return {
        id: row.id,
        token: token
    };
}

export { accountToken };
