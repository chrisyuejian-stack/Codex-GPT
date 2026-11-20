// 本机预览示例数据（仅开发用，不进入生产包）：在 `npm run dev` 启动后运行，通过真实接口写入虚构的枫琴数据。
//   node scripts/preview-seed.mjs            # 默认 http://localhost:4173，主管 13911112222 / PreviewSecure9Z
// 写入：老师 4、课程大类/细分课程 4、教室 3、学员 8、本周与今天的课、已销课与点评、课时包、缴费、线索 6、学员账号 1。
// 结束时打印学员账号（13800000008 / StudentPreview9Z）。所有人名、手机号均为虚构。
const BASE = process.env.PREVIEW_URL || "http://localhost:4173";
const STUDENT_PASSWORD = "StudentPreview9Z";

async function session(phone, password) {
  const r = await fetch(BASE + "/api/auth/login", {
    method: "POST",
    headers: { Origin: BASE, "Content-Type": "application/json" },
    body: JSON.stringify({ phone, password }),
  });
  if (!r.ok) throw Error("登录失败 " + phone + "：" + (await r.text()));
  const cookie = (r.headers.getSetCookie?.() || [r.headers.get("set-cookie")]).map((c) => c.split(";")[0]).join("; ");
  return { cookie, body: await r.json() };
}
function client(cookie) {
  return async (path, method = "GET", data) => {
    // 财务、课时、出勤类写入要求操作编号（防重复提交）；示例数据每次生成新的。
    if (data && typeof data === "object" && !Array.isArray(data) && method !== "GET" && data.operation_id === undefined)
      data = { ...data, operation_id: "seed_" + Math.random().toString(36).slice(2, 12) };
    const r = await fetch(BASE + "/api/" + path, {
      method,
      headers: { Origin: BASE, Cookie: cookie, ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const text = await r.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    if (!r.ok) throw Error(method + " " + path + " → " + r.status + " " + text.slice(0, 300));
    return body;
  };
}

const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
const shift = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const weekday = (new Date(today + "T12:00:00Z").getUTCDay() + 6) % 7; // 0 = 周一
const monday = shift(today, -weekday);

const admin = client((await session("13911112222", "PreviewSecure9Z")).cookie);
const add = async (resource, data) => (await admin("data/" + resource, "POST", data)).id;

// ---- 基础资料
const cats = {};
for (const [k, name, color] of [
  ["piano", "钢琴", "#8B7BB5"],
  ["voice", "声乐", "#B7768C"],
  ["theory", "乐理", "#C99A54"],
  ["comp", "作曲与制作", "#5B8DB8"],
])
  cats[k] = await add("course_categories", { name, color });
const course = {
  piano: await add("course_types", { name: "钢琴 1 对 1", category_id: cats.piano, format: "individual", capacity: 1, default_minutes: 60, units_per_lesson: 1 }),
  voice: await add("course_types", { name: "声乐 1 对 1", category_id: cats.voice, format: "individual", capacity: 1, default_minutes: 60, units_per_lesson: 1 }),
  theory: await add("course_types", { name: "乐理与视唱练耳", category_id: cats.theory, format: "group", capacity: 8, default_minutes: 60, units_per_lesson: 1 }),
  comp: await add("course_types", { name: "音乐制作 · 作品集", category_id: cats.comp, format: "individual", capacity: 1, default_minutes: 60, units_per_lesson: 1 }),
};
const teacher = {
  li: await add("teachers", { name: "李嘉文", phone: "13700000001" }),
  emily: await add("teachers", { name: "Emily", phone: "13700000002" }),
  zhou: await add("teachers", { name: "周舟", phone: "13700000003" }),
  liu: await add("teachers", { name: "刘洋", phone: "13700000004" }),
};
const room = {
  r302: await add("locations", { name: "302 琴房", capacity: 2 }),
  r305: await add("locations", { name: "305 琴房", capacity: 2 }),
  r201: await add("locations", { name: "201 教室", capacity: 10 }),
};
const names = [
  ["王一然", "高二", "古典钢琴"],
  ["陈思语", "高三", "声乐"],
  ["赵子航", "大三", "音乐制作"],
  ["林可欣", "高一", "作曲"],
  ["许嘉宁", "高三", "古典钢琴"],
  ["孙雨桐", "高二", "爵士钢琴"],
  ["周安", "高三", "流行演唱"],
  ["何沐阳", "初三", "古典钢琴"],
];
const st = [];
for (const [name, grade, direction] of names) st.push(await add("students", { name, grade, direction, parent_phone: "1390000" + String(st.length + 1).padStart(4, "0") }));

// ---- 课时包与缴费
const packs = [
  [0, "piano", 40, 160],
  [1, "voice", 30, 320],
  [2, "comp", 24, 400],
  [3, "comp", 20, 340],
  [4, "piano", 40, 160],
  [5, "piano", 60, 200],
  [6, "voice", 20, 300],
  [0, "theory", 20, 80],
  [1, "theory", 20, 80],
  [4, "theory", 20, 80],
];
for (const [s, c, units, price] of packs) await admin("credits/packages", "POST", { student_id: st[s], course_type_id: course[c], units_total: units, unit_price: price });
for (const [s, amount, d, method] of [
  [1, 9600, shift(today, -1), "转账"],
  [4, 6400, shift(today, -3), "微信"],
  [3, 6800, shift(today, -4), "微信"],
  [2, 500, shift(today, -5), "支付宝"],
])
  await admin("credits/payments", "POST", { student_id: st[s], amount, paid_at: d, method });
for (const [t, c, rate] of [
  ["li", "piano", 300],
  ["emily", "voice", 350],
  ["zhou", "theory", 200],
  ["liu", "comp", 320],
])
  await admin("finance/rates", "POST", { teacher_id: teacher[t], course_type_id: course[c], rate, rate_basis: "legacy", effective_from: "2026-01-01", effective_to: "2027-12-31" });

// ---- 课程：本周每天若干节；今天的课覆盖已上、进行中、未开始
const lesson = (date, time, c, t, r, students, duration = 60) =>
  add("lessons", { start_at: date + "T" + time, course_type_id: course[c], teacher_id: teacher[t], location_id: room[r], duration, units: 1, student_ids: students.map((i) => st[i]), force: true });
const plan = [
  ["10:00", "piano", "li", "r302", [4]],
  ["14:00", "theory", "zhou", "r201", [0, 1, 4]],
  ["16:00", "voice", "emily", "r305", [1]],
  ["18:30", "piano", "li", "r302", [5]],
];
for (let i = 0; i < 7; i++) {
  const d = shift(monday, i);
  if (d === today) continue;
  for (const [time, c, t, r, s] of plan.slice(0, 2 + (i % 3))) await lesson(d, time, c, t, r, s);
}
const nowBJ = new Date(Date.now() + 8 * 3600000).toISOString().slice(11, 16);
const hhmm = (h) => String(Math.max(8, Math.min(22, h))).padStart(2, "0") + ":00";
const h = Number(nowBJ.slice(0, 2));
const todays = [];
todays.push(await lesson(today, hhmm(h - 3), "piano", "li", "r302", [0]));
todays.push(await lesson(today, hhmm(h - 2), "theory", "zhou", "r201", [0, 1, 4]));
todays.push(await lesson(today, nowBJ < "22:00" ? nowBJ.slice(0, 3) + "00" : "21:00", "voice", "emily", "r305", [1]));
todays.push(await lesson(today, hhmm(h + 1), "comp", "liu", "r201", [2]));
todays.push(await lesson(today, hhmm(h + 2), "piano", "li", "r302", [5]));

// 前天的一节课销课并写点评（学员端“老师点评”有内容）
const past = await lesson(shift(today, -2), "15:00", "piano", "li", "r302", [7]);
const pastRow = (await admin("data/lessons/" + past)).record;
await admin("credits/lessons/" + past + "/status", "POST", { lesson_version: pastRow.version, status: "completed" }).catch((e) => console.warn("销课跳过：", e.message));
const review = await admin("lessons/" + past + "/review").catch(() => null);
if (review?.participants)
  await admin("lessons/" + past + "/comments", "PUT", {
    comment_fingerprint: review.comment_fingerprint,
    public_text: "肖邦夜曲第二段踏板更干净了，句子的呼吸也比上周自然。",
    homework: "左手音阶每天 15 分钟慢练。",
    people: review.participants.map((p) => ({ participant_id: p.id, student_id: p.student_id, comment: "进步明显，下周检查左手音阶。" })),
  }).catch((e) => console.warn("点评跳过：", e.message));

// ---- 线索
for (const [name, grade, direction, source, stage, next, trial] of [
  ["孙雨桐（家长咨询）", "高二", "爵士钢琴", "公众号白皮书", "contacted", shift(today, -1), null],
  ["唐若溪", "高一", "音乐剧", "学员转介绍", "new", today, null],
  ["Kevin 刘", "大二", "电子音乐制作", "讲座", "new", shift(today, 1), null],
  ["吴昊然", "高三", "小提琴", "转介绍", "contacted", today, null],
  ["许若晨", "高二", "流行演唱", "公众号白皮书", "trial", shift(today, 2), shift(today, 2) + "T10:00"],
  ["钱多多", "初二", "古典钢琴", "讲座", "trial", shift(today, 5), shift(today, 5) + "T15:00"],
])
  await admin("tools/leads", "POST", { name, grade, direction, source, stage, next_followup: next, trial_at: trial, phone: "1360000" + String(Math.floor(Math.random() * 9000) + 1000) });

// ---- 学员账号（何沐阳），并改成固定密码；缴费对学员可见
const acc = await admin("accounts", "POST", { name: "何沐阳", phone: "13800000008", roles: ["student"], student_id: st[7] });
const stu = await session("13800000008", acc.temporary_password);
await client(stu.cookie)("password", "POST", { old_password: acc.temporary_password, password: STUDENT_PASSWORD }).catch((e) => console.warn("学员改密跳过：", e.message));
for (const key of ["student_view_payments", "student_view_balance", "teacher_self_checkin"])
  await admin("settings", "PUT", { key, value: true }).catch((e) => console.warn("设置跳过：", e.message));

console.log("示例数据已写入：学员 " + st.length + "、今天 " + todays.length + " 节课。");
console.log("主管：13911112222 / PreviewSecure9Z    学员：13800000008 / " + STUDENT_PASSWORD);
