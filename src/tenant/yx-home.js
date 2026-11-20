// 艺界星途 · 工作台与导航入口（Claude）
// 左侧“日常”下加一组“招生工具”：工作台、招生内容、课程方案、课后反馈（老师）、成长报告。

// 设计稿 v3：不再单独设“招生工具”分组，入口由 yxNavRework 挂到原有分组里。
function yxNavGroups() {
  return [];
}
// 设计稿 v3 的导航：
// 招生：线索 · 推广中心 · 招生内容 · 课程方案 · 成长报告（老师另有课后反馈）
// 课程与教室：排课课程与教室 · 报价课程与价目表 · 阶段与节点
// 机构设置：机构档案 · 品牌与图库 · 成长报告维度 · AI 用量 · 学科模板 · 修改卡片 · 基本设置
const YX_SETTING_ROUTE = {
  yx_courses: "courses-quote",
  yx_stages: "courses-stages",
  yx_calendar: "courses-stages",
  yx_profile: "inst-profile",
  yx_gallery: "inst-brand",
  yx_reports: "inst-dims",
  yx_subjects: "inst-subjects",
  yx_changes: "inst-changes",
};
// 枫琴教务中心导航（2026-11 设计稿 v2，用户确认）：
//   Workspace：今天 · 待办 · 课表 · 学员 · 线索
//   Management：财务 · 老师（含课程与教室）· 设置（基本设置、账号、导入导出、AI 用量、操作记录）
// 招生只保留线索；合作升学、推广中心、招生内容、课程方案、成长报告不再进入导航（后端已删除）。
function yxNavRework(daily, manage, register) {
  const find = (list, k) => list.find((g) => g && g.key === k);
  const take = (list, k) => {
    const i = list.findIndex((g) => g && g.key === k);
    return i < 0 ? null : list.splice(i, 1)[0];
  };

  // 线索：原“招生”分组只留线索一页，作为独立一级入口。
  const enrol = take(daily, "enrol");
  const leadTab = enrol?.tabs.find((t) => t && t.key === "enrol-leads");
  if (leadTab) daily.push({ key: "leads", label: "线索", icon: "filter", tabs: [leadTab] });

  // 老师上课后的反馈页暂时挂在课表下，后续并入点名。
  const schedule = find(daily, "schedule");
  if (schedule && yxIsTeacher()) schedule.tabs.push(register("yx-feedback", "课后反馈", "schedule", (c) => yxFeedbackPage(c)));

  // 老师：从日常移到管理，课程与教室并进来。
  const teachers = take(daily, "teachers");
  const courses = take(manage, "courses");
  if (teachers || courses) {
    const tabs = [...(teachers?.tabs || []), ...(courses?.tabs || [])].filter(Boolean);
    if (tabs[0] && teachers) tabs[0].label = "老师";
    if (courses?.tabs[0]) courses.tabs[0].label = "课程与教室";
    manage.unshift({ key: "teachers", label: "老师", icon: "users", tabs });
  }

  // 设置：机构设置、账号与权限、数据导入导出、操作记录合并为一个入口。
  const settingsTabs = [];
  for (const k of ["institution", "accounts", "import", "logs"]) {
    const g = take(manage, k);
    if (g) settingsTabs.push(...g.tabs);
  }
  if (settingsTabs[0]?.key === "settings-institution") settingsTabs[0].label = "基本设置";
  if (enabled("ai", "use")) settingsTabs.push(register("inst-ai", "AI 用量", "settings", (c) => yxAiUsagePage(c)));
  if (settingsTabs.length) manage.push({ key: "settings", label: "设置", icon: "settings", tabs: settingsTabs });

  // 财务排在管理的第一位。
  const finance = take(daily, "finance") || take(manage, "finance");
  if (finance) manage.unshift(finance);

  // 各页面改版文件（fq-*.js）在这里调整自己的导航：hook(daily, manage, register)。
  for (const hook of globalThis.fqNavHooks || []) hook(daily, manage, register);
}
// 一个导航页里放一个或几个设置区块。
async function yxSettingsPage(c, keys) {
  c.replaceChildren(UI.tableSkeleton());
  const again = () => yxSettingsPage(c, keys);
  const frag = [],
    side = [];
  for (const k of keys) {
    const box = el("section", null, { class: "yxs-page-sec" });
    if (k === "yx_subjects_bar") {
      await yxsSubjectBar(box, again);
      frag.push(box);
      continue;
    }
    // 右栏：用一句话改设置（设计稿 v3）、计价方式说明
    if (k === "yx_assist") {
      if (enabled("ai", "use") && enabled("settings", "propose")) side.push(yxsAssist(again));
      continue;
    }
    if (k === "yx_price_legend") {
      side.push(yxsPriceLegend());
      continue;
    }
    const head = el("div", null, { class: "v-set-head" });
    head.append(el("h2", (YXS_SECTIONS.find((x) => x[0] === k) || [, ""])[1]));
    box.append(head);
    frag.push(box);
    await yxSettingsSection(box, head, k, again);
  }
  if (side.length) {
    const grid = el("div", null, { class: "yxs-split" });
    const main = el("div", null, { class: "yxs-split-main" }),
      aside = el("div", null, { class: "yxs-split-side" });
    const bar = frag[0]?.querySelector?.(".yxs-subjectbar") ? frag.shift() : null;
    main.append(...frag);
    aside.append(...side);
    grid.append(main, aside);
    c.replaceChildren(...(bar ? [bar] : []), grid);
  } else c.replaceChildren(...frag);
  c.classList.add("yx-page");
}
// AI 用量（机构设置 · 设计稿 v3）
async function yxAiUsagePage(c) {
  const V = globalThis.ChannelV2;
  const st = (c.__yxu ||= { date: new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" }) });
  const u = await apiRequest("ai/usage?date=" + st.date);
  c.replaceChildren();
  c.classList.add("yx-page");
  const bar = el("div", null, { class: "yxs-bar" });
  const d = el("input", null, { type: "date", value: st.date, "aria-label": "日期" });
  d.addEventListener("change", () => ((st.date = d.value), yxAiUsagePage(c)));
  bar.append(d, el("span", "每天北京时间 0 点重新计数；快速和深度分开计算。", { class: "v-muted" }));
  c.append(bar);
  const meters = el("div", null, { class: "yxu-meters" });
  for (const [k, t] of [["fast", "快速"], ["deep", "深度"]]) {
    const m = el("div", null, { class: "v-panel yxu-meter" });
    m.append(el("small", t, { class: "v-muted" }));
    const n = el("p");
    n.append(el("b", String(u[k].used), { class: "yx-num" }), " / " + u[k].limit);
    const track = el("div", null, { class: "yxh-progress" }),
      fill = el("span");
    fill.style.setProperty("width", Math.min(100, (u[k].used / Math.max(1, u[k].limit)) * 100) + "%");
    track.append(fill);
    m.append(n, track);
    meters.append(m);
  }
  c.append(meters);
  const tools = { plans: "课程方案", content: "招生内容", feedback: "课后反馈", growth_reports: "成长报告", settings: "设置" };
  if (u.by_tool?.length) {
    const p = V.panel("按工具");
    p.append(yxsTable(["工具", "快速", "深度"], u.by_tool.map((x) => [tools[x.tool] || x.tool, String(x.fast), String(x.deep)])));
    c.append(p);
  }
  if (u.by_user?.length) {
    const p = V.panel("按账号");
    p.append(yxsTable(["账号", "快速", "深度"], u.by_user.map((x) => [x.name || x.user_id, String(x.fast), String(x.deep)])));
    c.append(p);
  }
}
function yxGoSettings(section) {
  location.hash = YX_SETTING_ROUTE[section] || "settings-institution";
}

// ---------- 日期输入（v0.4.1）----------
// 浏览器自带的日期框年份可以敲 6 位，打快了会被夹到上限（2099），也不好手输。
// 这里把每个 <input type=date|month> 包一层：可见的是文本框，支持 20261117 / 2026-11-17 / 2026.11.17 / 11-17 / 2026年11月17日；
// 原来的日期框隐藏保留（名字、取值、事件都不变），右边的日历按钮打开它的选择器。2099 年及以后显示“长期有效”。
const YXDATE_FAR = "2099-01-01";
function yxDateParse(raw, month) {
  const s = String(raw || "").trim().replace(/[年月/.\s]/g, "-").replace(/日$/, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!s) return "";
  if (/^长期/.test(String(raw).trim())) return month ? "2099-12" : "2099-12-31";
  const y0 = new Date().getFullYear();
  let y, m, d;
  let r;
  if (month) {
    if ((r = /^(\d{4})-?(\d{1,2})$/.exec(s))) [y, m] = [+r[1], +r[2]];
    else if ((r = /^(\d{1,2})$/.exec(s))) [y, m] = [y0, +r[1]];
    else return null;
    if (m < 1 || m > 12 || y < 1900 || y > 2099) return null;
    return y + "-" + String(m).padStart(2, "0");
  }
  if ((r = /^(\d{4})(\d{2})(\d{2})$/.exec(s)) || (r = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) [y, m, d] = [+r[1], +r[2], +r[3]];
  else if ((r = /^(\d{1,2})-(\d{1,2})$/.exec(s)) || (r = /^(\d{2})(\d{2})$/.exec(s))) [y, m, d] = [y0, +r[1], +r[2]];
  else return null;
  if (y < 1900 || y > 2099 || m < 1 || m > 12 || d < 1) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
}
function yxDateShow(v) {
  return v && v >= (v.length === 7 ? "2099-01" : YXDATE_FAR) ? "长期有效" : v || "";
}
function yxDateEnhance(input) {
  if (input.dataset.yxDate || input.closest(".yx-date-off")) return;
  input.dataset.yxDate = "1";
  const month = input.type === "month";
  const wrap = document.createElement("span");
  wrap.className = "yx-date" + (input.closest(".ui-field, .field, label, .v-field") ? " is-block" : "");
  const text = document.createElement("input");
  text.type = "text";
  text.inputMode = "numeric";
  text.autocomplete = "off";
  text.className = input.className;
  text.placeholder = month ? "如 2026-11" : "如 2026-11-17";
  for (const a of ["aria-label", "aria-describedby", "title"]) if (input.hasAttribute(a)) text.setAttribute(a, input.getAttribute(a));
  if (input.id) {
    text.id = input.id;
    input.removeAttribute("id");
  }
  const pick = document.createElement("button");
  pick.type = "button";
  pick.className = "yx-date-pick";
  pick.setAttribute("aria-label", "打开日历");
  pick.textContent = "▾";
  input.parentNode.insertBefore(wrap, input);
  wrap.append(text, pick, input);
  input.classList.add("yx-date-native");
  input.tabIndex = -1;
  input.setAttribute("aria-hidden", "true");
  const syncAttrs = () => {
    text.disabled = input.disabled;
    text.readOnly = input.readOnly;
    pick.disabled = input.disabled || input.readOnly;
    if (input.required) {
      text.required = true;
      input.required = false;
    }
  };
  const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  const show = () => {
    if (document.activeElement !== text) text.value = yxDateShow(desc.get.call(input));
  };
  Object.defineProperty(input, "value", {
    configurable: true,
    get() {
      return desc.get.call(this);
    },
    set(v) {
      desc.set.call(this, v);
      show();
    },
  });
  const commit = () => {
    const raw = text.value.trim();
    const v = yxDateParse(raw, month);
    if (v === null) {
      text.setCustomValidity(month ? "月份格式不对，请写成 2026-11" : "日期格式不对，请写成 2026-11-17 或 20261117");
      text.reportValidity();
      return;
    }
    const lo = input.min, hi = input.max;
    if (v && ((lo && v < lo) || (hi && v > hi && !v.startsWith("2099")))) {
      text.setCustomValidity("超出可选范围" + (lo ? "：最早 " + lo : "") + (hi ? "，最晚 " + hi : ""));
      text.reportValidity();
      return;
    }
    text.setCustomValidity("");
    if (v !== desc.get.call(input)) {
      desc.set.call(input, v);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    text.value = yxDateShow(v);
  };
  text.addEventListener("focus", () => {
    const v = desc.get.call(input);
    if (v && v >= (month ? "2099-01" : YXDATE_FAR)) text.value = "长期有效";
    text.select();
  });
  text.addEventListener("input", () => text.setCustomValidity(""));
  text.addEventListener("blur", commit);
  text.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      commit();
      if (text.validationMessage) e.preventDefault();
    }
  });
  pick.addEventListener("click", () => {
    try {
      input.showPicker();
    } catch {
      text.focus();
    }
  });
  input.addEventListener("change", show);
  new MutationObserver(syncAttrs).observe(input, { attributes: true, attributeFilter: ["disabled", "readonly", "required"] });
  syncAttrs();
  show();
}
function yxDateScan(root) {
  if (root.nodeType !== 1) return;
  if (root.matches?.('input[type="date"], input[type="month"]')) yxDateEnhance(root);
  for (const x of root.querySelectorAll?.('input[type="date"], input[type="month"]') || []) yxDateEnhance(x);
}
if (typeof document !== "undefined" && typeof MutationObserver !== "undefined") {
  const go = () => {
    yxDateScan(document.body);
    new MutationObserver((list) => {
      for (const m of list) for (const n of m.addedNodes) yxDateScan(n);
    }).observe(document.body, { childList: true, subtree: true });
  };
  if (document.body) go();
  else document.addEventListener("DOMContentLoaded", go);
}
