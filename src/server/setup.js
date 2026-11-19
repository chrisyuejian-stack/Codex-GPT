import { repo } from "./repo.js";
import { body, json, fail, equal, phone, string, randomId } from "./core.js";
import {
  newPassword,
  validatePassword,
  phoneIndex,
  encrypt,
} from "./crypto.js";
import { modules, publicUser } from "./permissions.js";

export async function setupApi(req, env) {
  const r = repo(env, null),
    old = await r.instance();
  if (req.method === "GET") return json({ initialized: !!old });
  if (req.method !== "POST" || old) fail(404, "初始化已关闭", "not_found");
  if (typeof env.SETUP_KEY !== "string" || env.SETUP_KEY.length < 32)
    fail(503, "请配置至少32字符的SETUP_KEY", "CONFIG_MISSING");
  const d = await body(req),
    provided = req.headers.get("X-Setup-Key") || d.setup_key;
  if (typeof provided !== "string" || !equal(provided, env.SETUP_KEY))
    fail(403, "初始化密钥不正确", "forbidden");
  const mobile = phone(d.phone);
  validatePassword(d.password, mobile);
  const id = env.TENANT_ID || randomId("ten"),
    user = {
      id: randomId("usr"),
      name: string(d.name || "主管", "姓名", 50),
      phone_hmac: await phoneIndex(env, id, mobile),
      phone_enc: await encrypt(env, mobile, id + ":phone"),
      phone_last4: mobile.slice(-4),
      roles: '["supervisor"]',
      active: 1,
      must_change: 0,
      version: 1,
      ...(await newPassword(env, d.password)),
    };
  try {
    await r.initializeInstance({ id, name: "枫琴教务中心" }, user, modules);
  } catch (e) {
    if (await r.instance()) fail(404, "初始化已关闭", "not_found");
    throw e;
  }
  return json(
    { initialized: true, user: publicUser(user), api_base: "/api" },
    201,
  );
}
