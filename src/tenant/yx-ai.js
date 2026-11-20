// 艺界星途 · AI 公共部分与课程方案 AI 助手（Claude，接口 v0.3.6 §3.2、§4.3.4）
// 原则：AI 只给建议；人点“采用”后才写进页面，再由人点“保存”走普通保存接口。

var yxAiUsageCache = null;
var yxAiKeys = {}; // 同一请求体在得到明确结果前复用幂等键：网络断了重点一次不会重复计次。
const YXAI_BASIS = {
  rule: ["机构规则", "info"],
  consult: ["咨询原话", "ok"],
  feedback: ["课后反馈", "ok"],
  profile: ["机构档案", "ok"],
  ai_judgement: ["AI 判断", "muted"],
  unsupported: ["需核对", "warn"],
};
const YXAI_ERR = {
  configuration_missing: "AI 还没开通：平台管理员需要先配置模型和服务密钥。",
  ai_timeout: "AI 写得比较久没完成，本次不计次数。可以把长度调短、只选中一段来改，或切到“深度”再试。",
  ai_unavailable: "AI 暂时没能完成，本次不计次数。请稍后再试一次。",
  network: "网络中断了。AI 可能还在处理，稍后再点一次同一个按钮会取回结果，不会重复计次。",
};

function yxUuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64;
  b[8] = (b[8] & 63) | 128;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
}
function yxSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
// 调用一个 AI 接口。fresh=true 表示“重新生成”，换新的幂等键。
async function yxAi(route, body, fresh) {
  const sig = route + "|" + JSON.stringify(body);
  if (fresh || !yxAiKeys[sig]) yxAiKeys[sig] = yxUuid();
  const key = yxAiKeys[sig];
  let path = "ai/" + route;
  if (typeof yxScopedPath === "function") path = yxScopedPath(path);
  for (let i = 0; ; i++) {
    let res;
    try {
      res = await fetch(base + "api/" + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify(body),
        credentials: "same-origin",
      });
    } catch {
      if (i < 2) {
        await yxSleep(2000);
        continue;
      }
      const e = Error(YXAI_ERR.network);
      e.code = "network";
      throw e;
    }
    let data = {};
    try {
      data = await res.json();
    } catch {}
    if (res.ok) {
      delete yxAiKeys[sig];
      if (data.usage) yxAiUsageCache = null;
      return data;
    }
    const code = data.message ? data.error : data.code;
    // 同一个请求还在处理：等一会儿用同一个键取结果。
    if (res.status === 409 && code === "in_progress" && i < 60) {
      await yxSleep(2500);
      continue;
    }
    if (res.status === 401) location.assign(base + "login");
    if (res.status === 403 && code === "tenant_expired" && typeof yxTenantPaused === "function") yxTenantPaused(data.message);
    if (code !== "rate_limited") delete yxAiKeys[sig];
    const e = Error(YXAI_ERR[code] || data.message || "AI 请求失败");
    e.code = code;
    e.status = res.status;
    e.details = data.details;
    throw e;
  }
}
async function yxAiUsage() {
  if (!yxAiUsageCache) yxAiUsageCache = apiRequest("ai/usage").catch(() => null);
  return yxAiUsageCache;
}
// “今日 AI 3 / 80”，深度模式用过才显示。
function yxAiUsageChip() {
  const chip = el("span", "今日 AI …", { class: "yxai-usage" });
  yxAiUsage().then((u) => {
    if (!u) return chip.remove();
    chip.textContent = "今日 AI " + u.fast.used + " / " + u.fast.limit + (u.deep.used ? " · 深度 " + u.deep.used + " / " + u.deep.limit : "");
    if (u.fast.used >= u.fast.limit) chip.classList.add("is-full");
  });
  return chip;
}
// 按钮：点了显示“AI 生成中…”，结束恢复。
function yxAiButton(text, run, kind = "") {
  // UI.button 本身会在执行期间禁用按钮、防止连点，这里只换文字和显示错误。
  const b = button(text, async () => {
    const face = b.querySelector(".ui-button-face > span:last-child") || b;
    const old = face.textContent;
    face.textContent = "AI 生成中…";
    try {
      await run();
    } catch (e) {
      notice(e.message);
    } finally {
      face.textContent = old;
    }
  }, kind);
  b.classList.add("yxai-btn");
  return b;
}
// 依据标签；没有依据的句子单独列出，提醒人工核对。
function yxAiBasis(basis, only) {
  const V = globalThis.ChannelV2;
  const box = el("div", null, { class: "yxai-basis" });
  const list = only ? only.map((i) => basis?.[i]).filter(Boolean) : basis || [];
  const tags = el("div", null, { class: "yxai-tags" });
  const miss = [];
  for (const b of list) {
    if (b.type === "unsupported") {
      miss.push(b.text);
      continue;
    }
    const [label, tone] = YXAI_BASIS[b.type] || [b.type, "muted"];
    const t = V.chip(label, tone);
    const detail = b.quote || b.text || b.ref || "";
    if (detail) t.setAttribute("title", detail);
    tags.append(t);
  }
  if (tags.childElementCount) box.append(tags);
  if (miss.length) {
    // 句子多时折叠，只显示条数，点开再看。
    const w = el("details", null, { class: "yxai-miss" });
    if (miss.length <= 3) w.setAttribute("open", "");
    w.append(el("summary", miss.length + " 处在资料里找不到依据，请人工核对或删改"));
    const ul = el("ul");
    for (const m of miss) ul.append(el("li", m));
    w.append(ul);
    box.append(w);
  }
  return box;
}
// AI 返回的 warnings 多是内部校验细节（path、格式、引用核验）。界面只给用户有用的提醒，其余合成一句。
const YXAI_WARN_KEEP = [
  [/超过预算/, "有的配法超出了预算上限，没有列出"],
  [/选课规则/, "有的配法不符合本机构的选课规则，没有列出"],
  [/未定价|报价范围/, "有的课程不在价目表里或还没定价，没有列出"],
  [/与其他学员比较/, "去掉了拿学员互相比较的说法"],
  [/没有符合|未找到符合/, "这次没有合适的建议，可以补充资料或换个说法再试"],
];
function yxAiWarnings(list) {
  if (!list?.length) return null;
  const out = new Set();
  let dropped = 0;
  for (const w of list) {
    const k = YXAI_WARN_KEEP.find(([re]) => re.test(w));
    if (k) out.add(k[1]);
    else if (/^已丢弃/.test(w)) dropped++;
  }
  if (dropped) out.add("有 " + dropped + " 条建议没能用上，可以再试一次或换个说法");
  if (!out.size) return null;
  const ul = el("ul", null, { class: "yxai-warn" });
  for (const w of out) ul.append(el("li", w));
  return ul;
}
function yxClone(v) {
  return JSON.parse(JSON.stringify(v));
}

