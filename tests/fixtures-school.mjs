import assert from "node:assert/strict";
import { repo } from "../src/server/repo.js";
import { randomId, bytes, b64, sha } from "../src/server/core.js";
// Legacy business suites use named aliases for independent single-tenant instances.
// The production worker receives only root paths and has no slug-routing compatibility.
export async function schoolFixture(f, suffix = "a", role = "supervisor") {
  const actual = f._created ? await f.fork() : f;
  f._created = true;
  const tid = randomId("ten");
  actual.env.TENANT_ID = tid;
  const response = await actual.directRequest("https://school.test/api/setup", {
    method: "POST",
    headers: {
      Origin: "https://school.test",
      "Content-Type": "application/json",
      "X-Setup-Key": actual.env.SETUP_KEY,
    },
    body: JSON.stringify({
      phone: "13911112222",
      password: "PhaseTwoSecure9",
      name: "主管",
    }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  const r = repo(actual.env, tid),
    row = actual.db.raw
      .prepare("SELECT * FROM users WHERE tenant_id=?")
      .get(tid);
  if (role !== "supervisor")
    actual.db.raw
      .prepare("UPDATE users SET roles=? WHERE tenant_id=? AND id=?")
      .run(JSON.stringify([role]), tid, row.id);
  const user = await r.user(row.id),
    t = { ...(await r.tenant()), slug: "schedule-" + suffix };
  actual.db.raw
    .prepare("UPDATE tenants SET slug=? WHERE id=?")
    .run(t.slug, tid);
  const token = b64(bytes(32));
  await r.createSession(await sha(token), user, {
    ip: "fixture",
    ua: "phase2",
  });
  f.instances.set(t.slug, actual);
  const call = async (path, method = "GET", data) => {
    const res = await f.request(
      "https://school.test/" + t.slug + "/api/" + path,
      {
        method,
        headers: {
          Origin: "https://school.test",
          Cookie: "channel_session=" + token,
          "Content-Type": "application/json",
        },
        body: data === undefined ? undefined : JSON.stringify(data),
      },
    );
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = {};
    }
    return { status: res.status, body, text };
  };
  return { t, r, user, token, call, instance: actual };
}
