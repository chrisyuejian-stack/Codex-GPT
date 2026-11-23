// 枫琴教务中心 · 设置（第三期设计稿 design/redesign/settings，决定见 DECISIONS 13–17）。
// 加载在 fq-backup.js 之后：通过 globalThis.fqNavHooks 把“设置”分组改成「左侧分区导航 + 总览」。
//   电脑：左侧 7 个分区 + 总览；手机：分组列表 → 整页二级页（顶部「‹ 设置」返回）。
//   课程与教室从“老师”分组移回设置（老师分组不留入口）；教师与学员端开关移到账号与权限；
//   续费提醒规则放进教务规则（待办里的入口保留）；手机端数据与备份只读（导入、恢复只在电脑上做）。
// 只换外框和展示：账号（accountsV）、角色权限（rightsPage）、主色与二维码（yxsBrandEditor）、
// 导入（importWizard）、导出（exportsPage）、备份（FengqinBackup.backupPage）、
// 教师与学员端（c3 settingsPage personal）、课程表单（recordForm）沿用原函数与原接口；
// 教务规则、AI 设置、操作记录按 .fq-se-* 新视觉体系原生实现并直接对接既有后端接口。
// 旧地址仍可用：settings-accounts / settings-rights / settings-institution / settings-import / settings-export /
// settings-backup / settings-logs 保留原 key；admin-courses → settings-courses，inst-ai → settings-ai（替换历史记录）。
(() => {
  "use strict";
  const n = el,
    F = UI.fmt,
    V = () => globalThis.ChannelV2,
    A = () => globalThis.ChannelV2Admin,
    R = () => globalThis.ChannelRebuild,
    P = () => globalThis.ChannelV2People;
  const SVG = "http://www.w3.org/2000/svg";
  const phone = globalThis.matchMedia?.("(max-width: 760px)");
  const isPhone = () => !!phone?.matches;
  const sup = () => !!me?.user?.roles?.includes("supervisor");
  const ROLE_NAME = { supervisor: "机构主管", consultant: "顾问", academic: "教务", finance: "财务" };
  const roleName = () => ROLE_NAME[me.user.roles.find((r) => ROLE_NAME[r])] || "";
  const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });

  // ---------- 图标 ----------
  const ICONS = {
    grid: [["rect", { x: "3", y: "3", width: "7", height: "7", rx: "1.5" }], ["rect", { x: "14", y: "3", width: "7", height: "7", rx: "1.5" }], ["rect", { x: "3", y: "14", width: "7", height: "7", rx: "1.5" }], ["rect", { x: "14", y: "14", width: "7", height: "7", rx: "1.5" }]],
    shield: [["path", { d: "M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6z" }], ["path", { d: "M8.5 12l2.5 2.5 4.5-5" }]],
    palette: [["path", { d: "M12 3a9 9 0 1 0 0 18c1.2 0 1.8-.8 1.8-1.7 0-1.2-1-1.6-1-2.6 0-.9.7-1.6 1.7-1.6H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3z" }], ["circle", { cx: "7.5", cy: "11", r: "1.2" }], ["circle", { cx: "10", cy: "7", r: "1.2" }], ["circle", { cx: "15", cy: "7.5", r: "1.2" }]],
    book: [["path", { d: "M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z" }], ["path", { d: "M5 17a3 3 0 0 1 3-3h11" }]],
    sliders: [["path", { d: "M4 7h10M18 7h2M4 17h4M12 17h8" }], ["circle", { cx: "16", cy: "7", r: "2" }], ["circle", { cx: "10", cy: "17", r: "2" }]],
    spark: [["path", { d: "M12 3v5M12 16v5M3 12h5M16 12h5" }], ["path", { d: "M12 8l1.5 2.5L16 12l-2.5 1.5L12 16l-1.5-2.5L8 12l2.5-1.5z" }]],
    db: [["ellipse", { cx: "12", cy: "6", rx: "7", ry: "3" }], ["path", { d: "M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" }]],
    clock: [["circle", { cx: "12", cy: "12", r: "9" }], ["path", { d: "M12 7v5l3 2" }]],
    users: [["circle", { cx: "9", cy: "8", r: "3.5" }], ["path", { d: "M2.5 20c1-3.5 3.5-5.5 6.5-5.5s5.5 2 6.5 5.5M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5c2 .8 3.2 2.6 3.7 5.5" }]],
    key: [["circle", { cx: "8", cy: "15", r: "4" }], ["path", { d: "M11 12l9-9M17 6l3 3" }]],
    phone: [["rect", { x: "7", y: "2.5", width: "10", height: "19", rx: "2" }], ["path", { d: "M11 18h2" }]],
    out: [["path", { d: "M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 8l-4 4 4 4M6 12h10" }]],
    lock: [["rect", { x: "5", y: "11", width: "14", height: "10", rx: "2" }], ["path", { d: "M8 11V8a4 4 0 0 1 8 0v3" }]],
  };
  function icon(name) {
    const s = document.createElementNS(SVG, "svg");
    for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "aria-hidden": "true" })) s.setAttribute(k, v);
    for (const [tag, attrs] of ICONS[name] || []) {
      const p = document.createElementNS(SVG, tag);
      for (const [k, v] of Object.entries(attrs)) p.setAttribute(k, v);
      s.append(p);
    }
    return s;
  }
  const ic = (name, tone = "") => {
    const s = n("span", null, { class: "fq-se-ic" + (tone ? " is-" + tone : "") });
    s.append(icon(name));
    return s;
  };
  const lock = () => {
    const s = n("span", null, { class: "fq-se-lock", title: "仅主管" });
    s.append(icon("lock"));
    return s;
  };
  const pill = (text, tone = "") => n("span", text, { class: "fq-se-pill" + (tone ? " is-" + tone : "") });
  const btn = (text, fn, cls = "") => {
    const b = n("button", text, { type: "button", class: "fq-se-btn" + (cls ? " " + cls : "") });
    b.addEventListener("click", fn);
    return b;
  };
  const go = (hash) => {
    location.hash = hash;
  };
  const safe = (p) => p.catch(() => null);
  // 页头副标题：其他页面迟到的异步刷新可能覆盖它，画完后再设一次。
  let lastSub = "";
  const setSub = (text) => {
    lastSub = text || "";
    vHead?.sub(lastSub);
  };

  // ---------- 分区 ----------
  // avail 在导航钩子里按原有页签（即原有权限）算出：有哪个页签，才有对应分区。
  let avail = {};
  const SECTIONS = [
    { key: "overview", hash: "settings-overview", label: "总览", en: "Overview", icon: "grid" },
    { key: "accounts", hash: "settings-accounts", label: "账号与权限", en: "Accounts", icon: "shield", group: "人员与权限", tone: "", desc: "谁能登录、能做什么；教师端和学员端能看到什么。" },
    { key: "institution", hash: "settings-institution", label: "机构与品牌", en: "Brand", icon: "palette", group: "机构", tone: "plum", desc: "机构名、Logo、主色、咨询二维码。出现在登录页、课表图、续费提醒图上。" },
    { key: "courses", hash: "settings-courses", label: "课程与教室", en: "Courses", icon: "book", group: "机构", tone: "amber", desc: "课程大类与颜色、细分课程（时长、扣课时、人数）、教室与地点。" },
    { key: "rules", hash: "settings-rules", label: "教务规则", en: "Rules", icon: "sliders", group: "机构", tone: "", desc: "缺勤是否扣课时、计课酬；欠课时上限；续费提醒；课表默认视图。" },
    { key: "ai", hash: "settings-ai", label: "AI 设置", en: "AI", icon: "spark", group: "系统", tone: "plum", desc: "快速 / 深度两档模型与每日额度，按工具、按账号的用量。" },
    { key: "data", hash: "settings-data", label: "数据与备份", en: "Data", icon: "db", group: "系统", tone: "ink", desc: "Excel 导入、集中导出、全量加密备份与恢复。" },
    { key: "logs", hash: "settings-logs", label: "操作记录", en: "Logs", icon: "clock", group: "系统", tone: "", desc: "谁在什么时候改了什么；登录记录。" },
  ];
  const sec = (key) => SECTIONS.find((s) => s.key === key);
  const shown = () => SECTIONS.filter((s) => s.key === "overview" || avail[s.key]);
  // 数据与备份里的小页签
  const DATA_TABS = [
    ["import", "settings-import", "导入"],
    ["export", "settings-export", "导出"],
    ["backup", "settings-backup", "数据备份"],
  ];
  // 总览统计的缓存（导航上的数字也用它）
  const stats = {};

  // ---------- 外框 ----------
  function navigation(active) {
    const nav = n("nav", null, { class: "fq-se-nav", "aria-label": "设置分区" });
    let group = null;
    for (const s of shown()) {
      if (s.group && s.group !== group) {
        group = s.group;
        nav.append(n("p", group, { class: "fq-se-nav-label" }));
      }
      const a = n("a", null, { href: "#" + s.hash, "aria-current": s.key === active ? "page" : "false" });
      a.append(icon(s.icon), n("span", s.label));
      const count = navCount(s.key);
      if (count) a.append(n("small", count));
      nav.append(a);
    }
    const foot = n("p", null, { class: "fq-se-nav-foot" });
    foot.append(lock(), " 角色权限、数据备份、AI 设置只有主管能改；教务、财务只看到自己有权限的分区。");
    nav.append(foot);
    return nav;
  }
  function navCount(key) {
    if (key === "accounts" && stats.accounts) return String(stats.accounts.total);
    if (key === "courses" && stats.courses) return String(stats.courses.cats.length + stats.courses.types.length + stats.courses.rooms.length);
    if (key === "ai" && stats.ai) return stats.ai.fast.used + stats.ai.deep.used + "/" + (stats.ai.fast.limit + stats.ai.deep.limit);
    if (key === "data" && stats.backup) return stats.backup.at && F.date(stats.backup.at) === today() ? "今天" : "";
    return "";
  }
  function title(s, extra) {
    const t = n("div", null, { class: "fq-se-title" }),
      box = n("div"),
      h = n("h2", s.label);
    h.append(n("em", s.en));
    box.append(h, n("p", s.desc || ""));
    t.append(box);
    if (extra) t.append(extra);
    return t;
  }
  function panel(head, sub, acts, cls = "") {
    const p = n("section", null, { class: "fq-se-panel" + (cls ? " " + cls : "") }),
      ph = n("div", null, { class: "fq-se-ph" }),
      left = n("div");
    const h = n("h3");
    h.append(...[].concat(head));
    left.append(h);
    if (sub) left.append(n("p", sub));
    ph.append(left);
    if (acts?.length) {
      const a = n("div", null, { class: "fq-se-ph-acts" });
      a.append(...acts.filter(Boolean));
      ph.append(a);
    }
    p.append(ph);
    return p;
  }
  function chipsRow(items, current) {
    const box = n("div", null, { class: "fq-se-chips", role: "group" });
    for (const [label, count, fn, key] of items) {
      const b = n("button", null, { type: "button", class: "fq-se-chip", "aria-pressed": String(key !== undefined && key === current) });
      b.append(label);
      if (count !== undefined && count !== null) b.append(" ", n("b", String(count)));
      b.addEventListener("click", fn);
      box.append(b);
    }
    return box;
  }
  const scrollTo = (node) => node?.scrollIntoView?.({ behavior: "smooth", block: "start" });

  async function page(c, key, sub) {
    c.classList.add("fq-se-host");
    const s = sec(key);
    lastSub = "";
    vHead?.actions();
    vHead?.bar();
    if (isPhone()) {
      if (key === "overview") {
        await phoneHome(c);
        if (lastSub) vHead?.sub(lastSub);
        return;
      }
      const head = document.querySelector(".v-head h1");
      if (head) {
        head.textContent = s.label;
        head.dataset.en = s.en;
      }
      const m = n("div", null, { class: "fq-se-m fq-se-sub" });
      const back = n("a", "‹ 设置", { href: "#settings-overview", class: "fq-se-back" });
      const main = n("div", null, { class: "fq-se-main" });
      m.append(back, main);
      c.replaceChildren(m);
      await RENDER[key](main, sub);
      if (lastSub) vHead?.sub(lastSub);
      return;
    }
    const wrap = n("div", null, { class: "fq-se" }),
      main = n("div", null, { class: "fq-se-main" });
    wrap.append(navigation(key), main);
    c.replaceChildren(wrap);
    await RENDER[key](main, sub);
    if (lastSub) vHead?.sub(lastSub);
    // 统计（数字）是总览取回来的；导航先画，数字到了再补上。
    if (key === "overview") wrap.firstChild.replaceWith(navigation(key));
  }

  // ---------- 总览 ----------
  async function loadStats() {
    const jobs = [];
    if (avail.accounts)
      jobs.push(
        safe(api("accounts?offset=0")).then((d) => {
          if (!d) return;
          const items = d.items || [];
          const has = (r) => items.filter((u) => u.roles.includes(r)).length;
          stats.accounts = {
            total: d.total ?? items.length,
            staff: items.filter((u) => u.roles.some((r) => ROLE_NAME[r])).length,
            teachers: has("teacher"),
            students: has("student"),
            mustChange: items.filter((u) => u.active !== false && u.must_change).length,
            inactive: items.filter((u) => u.active === false).length,
          };
        }),
      );
    if (avail.ai) jobs.push(safe(api("ai/usage?date=" + today())).then((d) => d && (stats.ai = d)));
    if (avail.ai && sup()) jobs.push(safe(api("settings/ai")).then((d) => d && (stats.aiConfig = d)));
    if (avail.backup)
      jobs.push(
        safe(api("backups")).then((d) => {
          if (d) stats.backup = (d.items || []).find((x) => x.status === "completed") || {};
        }),
      );
    if (avail.courses)
      jobs.push(
        safe(Promise.all([R().take("data/course_categories"), R().take("data/course_types"), R().take("data/locations")])).then((d) => {
          if (d) stats.courses = { cats: d[0], types: d[1], rooms: d[2] };
        }),
      );
    if (avail.institution) jobs.push(safe(api("settings/institution")).then((d) => d && (stats.inst = d)));
    if (avail.rules) jobs.push(safe(api("absence-policies")).then((d) => d && (stats.absence = d.policies)));
    if (avail.rules && enabled("packages")) jobs.push(safe(api("renewal-settings")).then((d) => d && (stats.renewal = d.settings)));
    if (avail.logs) jobs.push(safe(api("logs?kind=audit&offset=0")).then((d) => d && (stats.logs = d.items || [])));
    await Promise.all(jobs);
  }
  const absenceText = (p) => (!p ? "—" : (p.deduct ? "扣课时" : "不扣课时") + " · " + (p.teacherPaid ? "计课酬" : "不计课酬"));
  const debtText = () => {
    const v = me.policy.settings.max_debt_units ?? 3;
    return v ? v + " 课时" : "不允许欠课时";
  };
  const renewalText = () => (stats.renewal ? "≤ " + stats.renewal.low_balance_threshold + " 课时或 " + stats.renewal.expiry_warning_days + " 天内到期" : "—");
  const VIEW_NAME = { time: "按时间", calendar: "按时间", teacher: "按教师", location: "按教室", room: "按教室", list: "列表" };
  const normScheduleView = (v) => (v === "calendar" ? "time" : v === "room" ? "location" : ["time", "teacher", "location", "list"].includes(v) ? v : "time");
  function cardRows(key) {
    const a = stats.accounts,
      c = stats.courses,
      i = stats.inst,
      ai = stats.ai,
      set = me.policy.settings;
    const onOff = (v) => (v ? "开" : "关");
    switch (key) {
      case "accounts":
        return [
          ["员工 / 教师 / 学员账号", a ? a.staff + " · " + a.teachers + " · " + a.students : "—"],
          avail.rights ? ["角色权限", customCount("academic") + customCount("finance") ? pill("已自定义 " + (customCount("academic") + customCount("finance")) + " 项", "plum") : "按默认"] : null,
          ["学员可看课时余额 · 缴费", onOff(set.student_view_balance === true) + " · " + onOff(set.student_view_payments === true)],
        ];
      case "institution":
        return [
          ["机构显示名", i?.name || brand.display_name || "—"],
          ["主色", i?.primary_color || "—"],
          ["联系说明", i?.contact_text || "未填写"],
        ];
      case "courses":
        return [
          ["课程大类", c ? c.cats.length + " 个" : "—"],
          ["细分课程", c ? c.types.length + " 门" + (c.types.some((t) => !t.active) ? " · 停用 " + c.types.filter((t) => !t.active).length : "") : "—"],
          ["教室与地点", c ? c.rooms.length + " 处" + (c.rooms.some((r) => r.offsite) ? " · 校外 " + c.rooms.filter((r) => r.offsite).length : "") : "—"],
        ];
      case "rules":
        return [
          ["学员请假", absenceText(stats.absence?.student_leave)],
          ["欠课时上限", debtText()],
          stats.renewal ? ["续费提醒", renewalText()] : ["课表默认视图", VIEW_NAME[set.default_schedule_view || "time"] || "按时间"],
        ];
      case "ai":
        return [
          stats.aiConfig ? ["配置来源", pill(stats.aiConfig.source === "internal" ? "机构设置" : "环境变量", "muted")] : null,
          ai ? ["每日额度", "快速 " + ai.fast.limit + " · 深度 " + ai.deep.limit] : null,
          ai ? ["今天已用", "快速 " + ai.fast.used + " · 深度 " + ai.deep.used] : null,
        ];
      case "data":
        return [
          avail.import ? ["Excel 导入", "学员、教师、剩余课时"] : null,
          avail.export ? ["集中导出", "学员、收款、课酬等"] : null,
          avail.backup ? ["自动备份", stats.backup?.at ? pill(when(stats.backup.at), "ok") : "还没有备份"] : null,
        ];
      case "logs":
        return [["最近一条", stats.logs?.[0] ? when(stats.logs[0].at) + " · " + (stats.logs[0].actor_label || "") : "—"]];
    }
    return [];
  }
  const FOOT = {
    accounts: "改权限后全员重新登录",
    institution: "改完可在页内预览",
    courses: "排课、课表颜色都用这里",
    rules: "只影响未锁定的月份",
    ai: "仅主管可改",
    data: "备份与恢复仅主管",
    logs: "含登录记录与筛选",
  };
  function when(at) {
    const d = F.date(at);
    return (d === today() ? "今天" : d.slice(5)) + " " + F.time(at);
  }
  const customCount = (role) => (me.policy.rights || []).filter((r) => r.role === role).length;
  const LOG_MODULES = new Set(["settings", "accounts", "rights", "exports", "imports", "backups", "backup", "ai"]);

  async function overview(main) {
    const subText = shown().length - 1 + " 个分区" + (sup() ? " · 你是机构主管，全部可见" : " · " + roleName() + "，只显示有权限的分区");
    setSub(subText);
    await loadStats();
    // 统计卡
    const row = n("div", null, { class: "fq-se-stats" });
    const stat = (label, iconName, tone, num, unit, foot, onFoot, numCls = "") => {
      const s = n("div", null, { class: "fq-se-stat" });
      const top = n("div", null, { class: "fq-se-stat-top" });
      top.append(n("span", label), ic(iconName, tone));
      const v = n("div", String(num), { class: "fq-se-num" + numCls });
      if (unit) v.append(n("small", unit));
      s.append(top, v);
      const f = onFoot ? n("button", foot, { type: "button", class: "fq-se-stat-foot is-link" }) : n("div", foot, { class: "fq-se-stat-foot" });
      if (onFoot) f.addEventListener("click", onFoot);
      s.append(f);
      return s;
    };
    const a = stats.accounts;
    if (a) {
      row.append(stat("员工账号", "users", "", a.staff, "人", "另有教师 " + a.teachers + " · 学员 " + a.students));
      const todo = a.mustChange + a.inactive;
      row.append(stat("要处理", "key", todo ? "red" : "", todo, "", "待改密码 " + a.mustChange + " · 已停用 " + a.inactive + " →", () => go("settings-accounts"), todo ? " is-red" : ""));
    }
    if (stats.ai) row.append(stat("今日 AI 用量", "spark", "plum", stats.ai.fast.used + stats.ai.deep.used, "/ " + (stats.ai.fast.limit + stats.ai.deep.limit), "快速 " + stats.ai.fast.used + " · 深度 " + stats.ai.deep.used));
    if (stats.courses && row.childElementCount < 3) row.append(stat("课程与教室", "book", "amber", stats.courses.types.filter((t) => t.active).length, "门在用", "大类 " + stats.courses.cats.length + " · 教室 " + stats.courses.rooms.length));
    if (avail.backup) {
      const s = n("div", null, { class: "fq-se-stat is-dark" });
      s.append(n("div", "Last backup", { class: "fq-se-stat-top" }), n("div", stats.backup?.at ? when(stats.backup.at) : "还没有", { class: "fq-se-num" }), n("div", "自动加密 · 保留 30 天", { class: "fq-se-stat-foot" }));
      row.append(s);
    }
    if (row.childElementCount) main.append(row);
    // 分组卡
    const groups = n("div", null, { class: "fq-se-groups" });
    for (const s of shown().filter((x) => x.key !== "overview")) {
      const card = n("article", null, { class: "fq-se-gc" });
      const head = n("div", null, { class: "fq-se-gc-head" }),
        txt = n("div"),
        h = n("h3", s.label);
      h.append(n("em", s.en));
      txt.append(h, n("p", s.desc));
      head.append(ic(s.icon, s.tone), txt);
      const ul = n("ul");
      for (const r of cardRows(s.key).filter(Boolean)) {
        const li = n("li");
        li.append(n("span", r[0]));
        const v = n("span");
        v.append(r[1]);
        li.append(v);
        ul.append(li);
      }
      const foot = n("div", null, { class: "fq-se-gc-foot" });
      const note = n("span");
      if (["ai", "data"].includes(s.key)) note.append(lock(), " ");
      note.append(FOOT[s.key] || "");
      const enter = n("a", "进入 →", { href: "#" + s.hash, class: "fq-se-link" });
      foot.append(note, enter);
      card.append(head, ul, foot);
      groups.append(card);
    }
    main.append(groups);
    // 最近的设置改动
    if (avail.logs) {
      const p = panel("最近的设置改动", "来自操作记录（只列设置、账号、权限、导入导出类）。完整记录含登录记录与筛选。", [btn("打开操作记录 →", () => go("settings-logs"), "is-soft")]);
      const list = n("ul", null, { class: "fq-se-log" });
      const rows = (stats.logs || []).filter((r) => LOG_MODULES.has(r.module)).slice(0, 5);
      for (const r of rows) {
        const li = n("li");
        const who = r.actor_label || "系统";
        const what = n("span");
        what.append(n("b", who), " ", n("span", (me.labels?.actions?.[r.action] || "操作") + "了 ", { class: "is-sub" }), r.summary || "");
        li.append(n("time", when(r.at)), n("span", Array.from(who)[0], { class: "fq-se-av" + (who === "系统" ? " is-ink" : "") }), what, pill(me.labels?.modules?.[r.module] || r.module, "muted"));
        list.append(li);
      }
      if (!rows.length) list.append(n("li", "最近没有设置类改动。", { class: "fq-se-empty" }));
      p.append(list);
      main.append(p);
    }
  }

  // 手机：分组列表
  async function phoneHome(c) {
    setSub(shown().length - 1 + " 个分区 · " + roleName());
    const m = n("div", null, { class: "fq-se-m" });
    c.replaceChildren(m);
    await loadStats();
    const meCard = n("div", null, { class: "fq-se-me" }),
      who = n("div");
    who.append(n("strong", me.user.name || ""), n("small", roleName() + (me.user.phone ? " · " + me.user.phone : "")));
    meCard.append(n("span", Array.from(me.user.name || "我")[0], { class: "fq-se-av" }), who, n("em", sup() ? "Admin" : "Staff"));
    m.append(meCard);
    const group = (label, rows) => {
      const g = n("div", null, { class: "fq-se-mg" });
      g.append(n("p", label));
      const card = n("div", null, { class: "fq-se-mcard" });
      for (const r of rows) card.append(r);
      g.append(card);
      m.append(g);
    };
    const row = (iconName, tone, label, sub, extra, onClick) => {
      const b = n("button", null, { type: "button", class: "fq-se-mrow" });
      const t = n("div");
      t.append(n("strong", label));
      if (sub) t.append(n("small", sub));
      b.append(ic(iconName, tone), t);
      if (extra) b.append(extra);
      b.append(n("span", "›", { class: "fq-se-chev", "aria-hidden": "true" }));
      b.addEventListener("click", onClick);
      return b;
    };
    group("我的账号", [
      row("key", "", "修改密码", "", null, () => changePassword(UI.drawer({ title: "修改密码" }).body)),
      row("phone", "", "登录设备", "查看和下线本账号的设备", null, () => devices()),
    ]);
    const sub = {
      accounts: () => {
        const a = stats.accounts;
        return a ? "员工 " + a.staff + " · 教师 " + a.teachers + " · 学员 " + a.students + (avail.rights ? " · 权限" : "") : "";
      },
      institution: () => (stats.inst ? stats.inst.name + " · 主色 " + stats.inst.primary_color : ""),
      courses: () => (stats.courses ? "大类 " + stats.courses.cats.length + " · 课程 " + stats.courses.types.length + " · 教室 " + stats.courses.rooms.length : ""),
      rules: () => "缺勤 · 欠课时上限 " + (me.policy.settings.max_debt_units ?? 3) + " · 续费提醒 · 课表视图",
      ai: () => (stats.ai ? "今天 " + (stats.ai.fast.used + stats.ai.deep.used) + " / " + (stats.ai.fast.limit + stats.ai.deep.limit) : ""),
      data: () => (avail.import ? "导入 · " : "") + (avail.export ? "导出 · " : "") + (avail.backup ? "备份" : "") + "（导入、恢复请在电脑上操作）",
      logs: () => (stats.logs?.[0] ? when(stats.logs[0].at) + " " + (stats.logs[0].actor_label || "") + " " + (stats.logs[0].summary || "") : ""),
    };
    const extra = {
      accounts: () => (stats.accounts?.mustChange ? pill(stats.accounts.mustChange + " 待改密码", "warn") : null),
      data: () => (stats.backup?.at ? pill(when(stats.backup.at), "ok") : null),
    };
    const byGroup = new Map();
    for (const s of shown().filter((x) => x.key !== "overview")) {
      if (!byGroup.has(s.group)) byGroup.set(s.group, []);
      byGroup.get(s.group).push(row(s.icon, s.tone, s.label, sub[s.key]?.() || "", extra[s.key]?.() || null, () => go(s.hash)));
    }
    for (const [label, rows] of byGroup) group(label, rows);
    const out = n("div", null, { class: "fq-se-mcard" });
    out.append(
      row("out", "red", "退出登录", "", null, async () => {
        await api("logout", "POST", {});
        location.assign(base + "login");
      }),
    );
    m.append(out);
  }

  // ---------- c3 原表单：缺勤规则 / 教师与学员端 / 课表默认视图 ----------
  // 与 v2a.js institution() 同样的做法：用原 settingsPage 画到不挂载的容器，再把内容（带原事件与原写入）搬过来。
  async function c3Part(section) {
    const temp = n("div");
    await settingsPage(temp, section);
    const inner = temp.querySelector(".c3-settings > section");
    return inner ? [...inner.childNodes] : [];
  }
  const hasText = (node, text) => (node.textContent || "").includes(text);
  // 原“教师与学员端”页里的“课时不够时最多可欠”下拉：搬到教务规则。
  const isDebt = (x) => hasText(x, "最多可欠");

  // ---------- 账号与权限 ----------
  const PERSONAL = [
    ["学员端", [["student_view_balance", "学员可查看剩余课时", "学员端首页显示课时包与剩余课时。"], ["student_view_payments", "学员可查看缴费记录", "学员端显示每笔缴费的日期、金额、课时包。"]]],
    ["教师端", [["teacher_self_checkin", "教师可自助提交出勤", "下课后老师自己点名销课，不用等教务。"], ["teacher_view_student_balance", "教师可查看学生剩余课时", ""]]],
    ["教务开通账号", [["academic_can_create_accounts", "教务可开通教师与学员账号", ""], ["academic_can_reset_accounts", "教务可重置教师与学员账号", "重置后对方所有设备下线，新初始密码只显示一次。"]]],
  ];
  async function accountsSection(main, sub) {
    const s = sec("accounts");
    if (sub === "rights") {
      const back = n("a", "‹ 账号与权限", { href: "#settings-accounts", class: "fq-se-back" });
      const t = title({ ...s, label: "角色权限", en: "Rights", desc: "机构主管拥有全部权限，不在表里。勾选后浅黄标出改动，一次保存；保存后所有在线账号重新登录。" });
      const box = n("div", null, { class: "fq-se-legacy" });
      main.append(back, t, box);
      return pageHooks.rights(box);
    }
    const accPanel = n("div", null, { class: "fq-se-legacy fq-se-acc-box" });
    const rightsPanel = avail.rights ? rightsSummary() : null;
    const personal = avail.institution ? n("div") : null;
    main.append(
      title(
        s,
        chipsRow([
          ["账号", stats.accounts?.total, () => scrollTo(accPanel), 0],
          avail.rights ? ["角色权限", null, () => scrollTo(rightsPanel)] : null,
          personal ? ["教师端与学员端", null, () => scrollTo(personal)] : null,
        ].filter(Boolean), 0),
      ),
      accPanel,
    );
    if (rightsPanel) main.append(rightsPanel);
    if (personal) main.append(personal);
    // 账号表沿用 accountsV（筛选、新建、编辑、登录设备、查看号码、重置密码、分页），只把指向旧位置的说明改成本页。
    new MutationObserver(() => retarget(accPanel, personal)).observe(accPanel, { childList: true });
    await A().accountsV(accPanel);
    retarget(accPanel, personal);
    if (personal) personal.replaceWith(await personalPanel());
  }
  function retarget(box, personal) {
    for (const p of box.querySelectorAll(".v-ac-note")) {
      if (hasText(p, "机构设置 › 教师与学员端")) p.textContent = "教师端、学员端能看到什么（课时余额、缴费记录、自助销课），在本页下方「教师端与学员端能看到什么」里开关。";
      if (hasText(p, "上方“角色权限”分页")) p.textContent = "教务、财务能做什么，在本页「角色权限」里打开权限表整张调整；保存后本机构所有在线账号会重新登录。";
    }
    for (const b of box.querySelectorAll("button")) {
      if (b.dataset.fqSe || !hasText(b, "去机构设置")) continue;
      const nb = V().link("看下方开关 ↓", () => scrollTo(box.parentNode.querySelector(".fq-se-personal")));
      nb.dataset.fqSe = "1";
      b.replaceWith(nb);
      if (!personal) nb.remove();
    }
  }
  function rightsSummary() {
    const p = panel(["角色权限 ", lock(), n("small", " 仅主管")], "机构主管拥有全部权限，不在表里。教务、财务能做什么，在权限表里整张勾选、一次保存。", [btn("打开权限表 →", () => go("settings-rights"), "is-soft")]);
    const body = n("div", null, { class: "fq-se-pb" }),
      roles = n("div", null, { class: "fq-se-roles" });
    for (const [role, label, tone] of [["academic", "教务", ""], ["finance", "财务", "amber"]]) {
      const r = n("div", null, { class: "fq-se-role" }),
        h = n("h4", label),
        k = customCount(role);
      h.append(k ? pill("已自定义 " + k + " 项", "plum") : pill("按默认", "muted"));
      const bar = n("div", null, { class: "fq-se-bar" + (tone ? " is-" + tone : "") });
      bar.append(n("i", null, { class: k ? "is-some" : "" }));
      r.append(h, bar, n("p", role === "academic" ? "默认：日常教务全部、线索全部、课时包新增修改；不含财务。" : "默认：收款、课时包调整与转课时、课酬结算、成本；教务只读。"));
      roles.append(r);
    }
    const notes = n("ul", null, { class: "fq-se-notes" });
    for (const t of ["教师账号固定只看自己的学生和自己的课（含助教课），不在表里调整。", "学员账号只看自己的课表和点评；余额、缴费由下面的开关决定。", "保存权限后，所有在线账号会立即重新登录（包括你自己）。", "改过的格子标浅黄色，可以整体撤销。"])
      notes.append(n("li", t));
    body.append(roles, notes);
    p.append(body);
    return p;
  }
  async function personalPanel() {
    const p = panel("教师端与学员端能看到什么", "关掉的项目，服务器不再向教师或学员账号返回这些数据，不只是隐藏。只有主管可以改。", null, "fq-se-personal");
    p.id = "fq-se-personal";
    const nodes = await c3Part("personal");
    const switches = nodes.filter((x) => x.nodeType === 1 && x.tagName !== "P" && !isDebt(x));
    const list = n("div", null, { class: "fq-se-sws" });
    const used = new Set();
    for (const [group, items] of PERSONAL) {
      list.append(n("p", group, { class: "fq-se-swg" }));
      for (const [, label, hint] of items) {
        const sw = switches.find((x) => !used.has(x) && hasText(x, label));
        if (!sw) continue;
        used.add(sw);
        const row = n("div", null, { class: "fq-se-swr" });
        row.append(sw);
        if (hint && !hasText(sw, hint.slice(0, 6))) row.append(n("small", hint, { class: "fq-se-hint" }));
        list.append(row);
      }
    }
    // 万一原页面以后多了开关，也放进来，不丢功能。
    for (const sw of switches.filter((x) => !used.has(x))) {
      const row = n("div", null, { class: "fq-se-swr" });
      row.append(sw);
      list.append(row);
    }
    p.append(list);
    return p;
  }

  // ---------- 机构与品牌 ----------
  const MAX_LOGO = 180000; // 与后端品牌图片规则一致（data URL 字符数）
  const MAX_LOGIN_BG = 300000; // 登录背景 data URL 上限（对应压缩后 ≤200KB）
  const MAX_LOGIN_BG_BYTES = 200 * 1024;
  function readImage(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onerror = () => reject(Error("读取图片失败"));
      fr.onload = () => {
        const img = new Image();
        img.onerror = () => reject(Error("这不是可用的图片"));
        img.onload = () => resolve(img);
        img.src = fr.result;
      };
      fr.readAsDataURL(file);
    });
  }
  async function logoData(file) {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw Error("Logo 只支持 PNG、JPEG、WebP");
    const img = await readImage(file);
    for (const size of [512, 384, 256]) {
      const k = Math.min(1, size / Math.max(img.naturalWidth, img.naturalHeight));
      const cv = document.createElement("canvas");
      cv.width = Math.max(1, Math.round(img.naturalWidth * k));
      cv.height = Math.max(1, Math.round(img.naturalHeight * k));
      cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
      for (const [type, q] of [["image/png"], ["image/webp", 0.86], ["image/jpeg", 0.86]]) {
        const url = cv.toDataURL(type, q);
        if (url.startsWith("data:" + type) && url.length <= MAX_LOGO) return url;
      }
    }
    throw Error("图片压缩后仍太大，请换一张更小的 Logo");
  }
  async function loginBgData(file) {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw Error("登录背景图只支持 PNG、JPEG、WebP");
    const img = await readImage(file);
    const tries = [
      ["image/webp", 0.85],
      ["image/webp", 0.76],
      ["image/webp", 0.66],
      ["image/jpeg", 0.84],
      ["image/jpeg", 0.74],
      ["image/jpeg", 0.64],
      ["image/jpeg", 0.52],
    ];
    for (const edge of [1600, 1440, 1280, 1024, 800]) {
      const k = Math.min(1, edge / Math.max(img.naturalWidth, img.naturalHeight));
      const cv = document.createElement("canvas");
      cv.width = Math.max(1, Math.round(img.naturalWidth * k));
      cv.height = Math.max(1, Math.round(img.naturalHeight * k));
      const ctx = cv.getContext("2d");
      ctx.fillStyle = "#2a1f3e";
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.drawImage(img, 0, 0, cv.width, cv.height);
      for (const [type, q] of tries) {
        const url = cv.toDataURL(type, q);
        if (!url.startsWith("data:" + type)) continue;
        const payload = url.slice(url.indexOf(",") + 1);
        const pad = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
        const bytes = Math.floor((payload.length * 3) / 4) - pad;
        if (url.length <= MAX_LOGIN_BG && bytes <= MAX_LOGIN_BG_BYTES)
          return { url, width: cv.width, height: cv.height, bytes };
      }
    }
    throw Error("图片压缩后仍超过 200KB，请换一张更简洁或更小的图片");
  }
  function logoMark(src, name) {
    return src ? n("img", null, { src, alt: "机构 Logo", class: "fq-se-logo is-img" }) : n("span", Array.from(name || "枫")[0], { class: "fq-se-logo" });
  }
  async function institutionSection(main) {
    const s = sec("institution");
    setSub("机构与品牌 · 登录页、课表图、续费提醒图共用");
    main.append(title(s));
    const two = n("div", null, { class: "fq-se-two" });
    const info = await safe(api("settings/institution"));
    stats.inst = info || stats.inst;
    const preview = { name: info?.name || brand.display_name, logo: info?.logo, contact: info?.contact_text || "", color: info?.primary_color || "#6A35B8", loginBg: info?.login_bg_url || null };
    // 机构信息（DECISIONS 14：主管可直接编辑）
    const card = panel("机构信息", info?.editable ? "单机构部署，主管直接在这里改。" : "只有机构主管可以修改。", info?.editable ? [btn("编辑", () => editInstitution(info), "is-sm")] : null);
    const body = n("div", null, { class: "fq-se-pb" });
    if (info) {
      const top = n("div", null, { class: "fq-se-brandtop" }),
        txt = n("div");
      txt.append(n("strong", info.name || "未设置"), n("small", info.logo ? "Logo 已设置" : "还没有 Logo · 建议 512×512 PNG"));
      top.append(logoMark(info.logo, info.name), txt);
      const dl = n("dl", null, { class: "fq-se-dl" });
      for (const [k, v] of [["机构显示名", info.name || "未设置"], ["系统名称", "枫琴教务中心"], ["联系说明", info.contact_text || "未填写"]]) dl.append(n("dt", k), n("dd", v));
      body.append(top, dl);
    } else body.append(n("p", "机构信息暂时取不到。", { class: "fq-se-empty" }));
    card.append(body);
    // 主色与咨询二维码：沿用 yxsBrandEditor（图库选择、版本冲突处理都在原函数里）
    const color = panel("主色与咨询二维码", "改主色只影响对外图片和登录页，不改员工端界面。");
    const colorBody = n("div", null, { class: "fq-se-pb fq-se-legacy" });
    color.append(colorBody);
    const institutionAgain = () => {
      const c = main.closest(".fq-se-host");
      if (c) void page(c, "institution");
    };
    if (typeof yxsBrandEditor === "function") await yxsBrandEditor(colorBody, institutionAgain);
    two.append(card, color);
    main.append(two);
    // 登录页背景图（任务 #10：电脑与手机端登录页共用，仅主管可上传/恢复默认）
    const bgPanel = panel(
      "登录页背景图",
      info?.editable
        ? "电脑端与手机端登录页共用；支持 PNG / JPEG / WebP，上传时自动压缩至长边 ≤1600px、≤200KB。"
        : "当前登录页背景状态；只有机构主管可以更换或恢复默认。",
    );
    const bgBody = n("div", null, { class: "fq-se-pb fq-se-bg-wrap" });
    const bgPrev = n("div", null, { class: preview.loginBg ? "fq-se-bg-preview is-custom" : "fq-se-bg-preview" });
    if (preview.loginBg)
      bgPrev.append(n("img", null, { src: preview.loginBg, alt: "登录页背景预览", class: "fq-se-bg-img" }));
    bgPrev.append(n("span", preview.loginBg ? "自定义背景图" : "系统默认背景", { class: "fq-se-bg-badge" }));
    const bgMeta = n("div", null, { class: "fq-se-bg-meta" });
    bgMeta.append(
      n("strong", preview.loginBg ? "已使用自定义登录背景图" : "当前使用系统默认背景图"),
      n("p", "电脑端与手机端登录页都会显示此背景图；建议上传横图，系统会自动缩放至长边 ≤1600px 并压缩到 200KB 以内以保证首屏加载速度。"),
    );
    const bgStatus = n("small", "", { class: "fq-se-bg-status" });
    bgMeta.append(bgStatus);
    if (info?.editable) {
      const acts = n("div", null, { class: "fq-se-bg-acts" });
      const fileInput = n("input", null, {
        type: "file",
        accept: "image/png,image/jpeg,image/webp",
        class: "fq-se-bg-input",
        "aria-label": "上传登录页背景图",
      });
      const saveBg = async (nextBg, okText) => {
        try {
          await api("settings/institution", "PATCH", { version: info.version, login_bg: nextBg });
        } catch (e) {
          if (e.status === 409) {
            notice("机构信息刚被别人改过，已刷新，请重新操作。", "error");
            institutionAgain();
            return false;
          }
          throw e;
        }
        try {
          localStorage.removeItem("fq_brand_v1");
        } catch {}
        notice(okText, "success");
        institutionAgain();
        return true;
      };
      const uploadBtn = btn("上传背景图", () => fileInput.click(), "is-primary is-sm");
      const resetBtn = btn(
        "恢复默认",
        async () => {
          const yes = await UI.confirmDialog({
            title: "恢复默认登录背景",
            message: "将清除当前自定义背景图，电脑端和手机端登录页都恢复为系统默认背景。",
            confirmLabel: "恢复默认",
          });
          if (!yes) return;
          uploadBtn.disabled = true;
          resetBtn.disabled = true;
          bgStatus.textContent = "正在恢复默认背景…";
          try {
            await saveBg(null, "登录页背景已恢复默认");
          } catch (e) {
            notice(e.message || "恢复默认失败", "error");
            bgStatus.textContent = "";
            uploadBtn.disabled = false;
            resetBtn.disabled = !info.has_login_bg;
          }
        },
        "is-sm",
      );
      resetBtn.disabled = !info.has_login_bg;
      fileInput.addEventListener("change", async () => {
        const picked = fileInput.files?.[0];
        if (!picked) return;
        uploadBtn.disabled = true;
        resetBtn.disabled = true;
        bgStatus.textContent = "正在压缩图片…";
        try {
          const out = await loginBgData(picked);
          const kb = Math.max(1, Math.round(out.bytes / 1024));
          bgStatus.textContent = `已压缩为 ${out.width}×${out.height}（约 ${kb} KB），正在保存…`;
          await saveBg(out.url, `登录页背景已更新（${out.width}×${out.height}，约 ${kb} KB）`);
        } catch (e) {
          notice(e.message || "上传登录页背景失败", "error");
          bgStatus.textContent = "";
          fileInput.value = "";
          uploadBtn.disabled = false;
          resetBtn.disabled = !info.has_login_bg;
        }
      });
      acts.append(fileInput, uploadBtn, resetBtn);
      bgMeta.append(acts);
    }
    bgBody.append(bgPrev, bgMeta);
    bgPanel.append(bgBody);
    main.append(bgPanel);
    // 效果预览：主色改动即时反映（保存前）
    const pv = panel("效果预览", "按当前内容预览；保存后学员、老师下次打开即生效。");
    const grid = n("div", null, { class: "fq-se-previews fq-se-pb" });
    const login = n("div", null, { class: preview.loginBg ? "fq-se-pv-box fq-se-pv-login is-custom" : "fq-se-pv-box fq-se-pv-login" }),
      loginCard = n("div");
    if (preview.loginBg) login.append(n("img", null, { src: preview.loginBg, alt: "", class: "fq-se-pv-bg" }));
    loginCard.append(logoMark(preview.logo, preview.name), n("b", preview.name || "枫琴教务中心"), n("i"), n("i"), n("i", null, { class: "is-btn" }));
    login.append(loginCard);
    const sched = n("div", null, { class: "fq-se-pv-box fq-se-pv-sched" }),
      sg = n("div", null, { class: "fq-se-pv-grid" });
    sched.append(n("b", (preview.name || "") + " · 学员课表"));
    for (const k of "a.b.a.c..a.b.c.a..b.a".split(".")) sg.append(n("i", null, { class: k }));
    sched.append(sg);
    const renew = n("div", null, { class: "fq-se-pv-box fq-se-pv-renew" });
    renew.append(n("b", "示例学员 · 钢琴 1 对 1"), n("div", "2 课时", { class: "fq-se-pv-num" }), n("p", "课时包快用完了，续费请联系顾问。" + (preview.contact ? " " + preview.contact : "")), n("span", null, { class: "qr" }));
    const pvItem = (label, box) => {
      const d = n("div", null, { class: "fq-se-pv" });
      d.append(n("small", label), box);
      return d;
    };
    grid.append(pvItem("登录页", login), pvItem("课表图（发给学员）", sched), pvItem("续费提醒图", renew));
    pv.append(grid);
    main.append(pv);
    const paint = (hex) => {
      if (!/^#[0-9a-f]{6}$/i.test(hex || "")) return;
      pv.style.setProperty("--fq-se-brand", hex);
    };
    paint(preview.color);
    colorBody.addEventListener("input", (e) => {
      if (e.target?.name === "primary_color") paint(e.target.value);
    });
  }
  function editInstitution(info) {
    const d = UI.drawer({ title: "编辑机构信息", subtitle: "保存后登录页、课表图、续费提醒图片都会使用新的名称和 Logo。" });
    const f = n("form", null, { class: "fq-se-form" });
    const name = field(f, "机构显示名", "name", "text", info.name || "", true);
    name.maxLength = 100;
    const contact = field(f, "联系说明", "contact_text", "text", info.contact_text || "", false);
    contact.maxLength = 300;
    contact.placeholder = "如：咨询请加顾问微信，工作日 10:00–20:00";
    let logo = info.logo || null;
    const lg = n("div", null, { class: "fq-se-logo-edit" }),
      mark = n("span"),
      file = n("input", null, { type: "file", accept: "image/png,image/jpeg,image/webp", "aria-label": "选择 Logo 图片" });
    const show = () => mark.replaceChildren(logoMark(logo, name.value));
    show();
    file.addEventListener("change", async () => {
      const x = file.files?.[0];
      if (!x) return;
      try {
        logo = await logoData(x);
        show();
      } catch (e) {
        notice(e.message, "error");
        file.value = "";
      }
    });
    const clear = btn("去掉 Logo", () => {
      logo = null;
      file.value = "";
      show();
    }, "is-sm");
    lg.append(mark, file, clear, n("small", "PNG / JPEG / WebP，会自动缩到 512 像素以内。"));
    const lab = n("div", null, { class: "fq-se-field" });
    lab.append(n("label", "Logo"), lg);
    f.append(lab);
    submit(f, "保存", async () => {
      try {
        await api("settings/institution", "PATCH", { version: info.version, name: name.value, contact_text: contact.value, logo });
      } catch (e) {
        if (e.status === 409) {
          notice("机构信息刚被别人改过，已刷新，请重新修改。", "error");
          await d.close();
          location.hash === "#settings-institution" ? globalThis.dispatchEvent(new HashChangeEvent("hashchange")) : go("settings-institution");
          return;
        }
        throw e;
      }
      try {
        localStorage.removeItem("fq_brand_v1");
      } catch {}
      notice("机构信息已保存", "success");
      await d.close();
      globalThis.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    d.body.append(f);
  }

  // ---------- 课程与教室 ----------
  const RES = [
    ["categories", "course_categories", "课程大类", "大类决定颜色，周课表和课表图都用这套颜色。", "＋ 新增大类"],
    ["types", "course_types", "细分课程", "排课时选这里的课程；时长和扣课时作为默认值，单节课仍可改。", "＋ 新增细分课程"],
    ["rooms", "locations", "教室与地点", "排课时选择教室；校外地点用于演出、外出课。", "＋ 新增教室"],
  ];
  const FORMAT = { individual: "一对一", group: "小班课", class: "集训班" };
  async function coursesSection(main) {
    const s = sec("courses");
    setSub("课程与教室 · 排课、课表颜色、扣课时都按这里");
    const [cats, types, rooms] = await Promise.all([R().take("data/course_categories"), R().take("data/course_types"), R().take("data/locations")]);
    stats.courses = { cats, types, rooms };
    const rows = { course_categories: cats, course_types: types, locations: rooms };
    const again = () => {
      const c = main.closest(".fq-se-host");
      if (c) void page(c, "courses");
    };
    const panels = {};
    main.append(
      title(
        { ...s, desc: "删除有关联记录的项目时会被拒绝，可以改为停用；停用后不能再排新课，历史记录保留。" },
        chipsRow(RES.map(([k, , label]) => [label, rows[RES.find((x) => x[0] === k)[1]].length, () => scrollTo(panels[k])])),
      ),
    );
    const colorOf = (catId) => V().colorClass({ category_color: cats.find((x) => x.id === catId)?.color || "" });
    const typesOf = (catId) => types.filter((t) => t.category_id === catId);
    const state = (r) => (r.active ? pill("启用", "ok") : pill("停用", "muted"));
    const actions = (resource, r) => {
      const w = n("span", null, { class: "fq-se-acts" });
      if (enabled("settings", "update")) w.append(V().link("编辑", () => recordForm(P().sink(again), resource, r)));
      if (enabled("settings", "delete"))
        w.append(
          UI.actionMenu({
            label: "⋯",
            items: [
              {
                label: "删除",
                danger: true,
                onSelect: async () => {
                  if (!(await UI.confirm({ title: "删除" + r.name + "？", consequence: "有关联业务记录时服务器会拒绝，可改为停用。", danger: true }))) return;
                  await api("data/" + resource + "/" + r.id, "DELETE", { version: r.version });
                  again();
                },
              },
            ],
          }).element,
        );
      return w;
    };
    const name = (r, cls) => {
      const x = n("span", null, { class: "v-set-name " + cls });
      x.append(n("i", null, { class: "v-cl-dot" }), n("strong", r.name));
      return x;
    };
    for (const [key, resource, label, hint, addText] of RES) {
      const list = rows[resource];
      const acts = [];
      if (enabled("settings", "update") && globalThis.ChannelC3?.manualOrder) acts.push(btn("手动排序", () => globalThis.ChannelC3.manualOrder(resource), "is-sm"));
      if (enabled("settings", "create")) acts.push(btn(addText, () => recordForm(P().sink(again), resource), resource === "course_categories" ? "is-soft is-sm" : "is-dark is-sm"));
      const p = panel([label, n("span", list.length + " 项 · 启用 " + list.filter((r) => r.active).length)], hint, acts);
      panels[key] = p;
      if (!list.length) p.append(n("p", "还没有内容。", { class: "fq-se-empty fq-se-pb" }));
      else if (resource === "course_categories") {
        const grid = n("div", null, { class: "fq-se-cats" });
        for (const r of list) {
          const card = n("article", null, { class: "fq-se-cat " + colorOf(r.id) + (r.active ? "" : " is-off") });
          const h = n("h4");
          h.append(name(r, colorOf(r.id)));
          card.append(h, n("p", typesOf(r.id).map((t) => t.name).join("、") || "还没有细分课程"));
          const foot = n("footer");
          foot.append(state(r), actions(resource, r));
          card.append(foot);
          grid.append(card);
        }
        p.append(grid);
      } else {
        const cols =
          resource === "course_types"
            ? [
                ["课程", (r) => name(r, colorOf(r.category_id))],
                ["大类", (r) => cats.find((x) => x.id === r.category_id)?.name || "—"],
                ["形式", (r) => FORMAT[r.format] || "—"],
                ["每节时长", (r) => (r.default_minutes ? r.default_minutes + " 分钟" : "—"), "is-num"],
                ["扣课时", (r) => String(r.units_per_lesson ?? 1), "is-num"],
                ["人数上限", (r) => String(r.capacity ?? "—"), "is-num"],
                ["状态", state],
                ["", (r) => actions(resource, r), "is-act"],
              ]
            : [
                ["教室 / 地点", (r) => n("strong", r.name)],
                ["校区", (r) => r.campus || "—"],
                ["容纳人数", (r) => String(r.capacity ?? "—"), "is-num"],
                ["类型", (r) => (r.offsite ? pill("校外地点", "plum") : "校内")],
                ["状态", state],
                ["", (r) => actions(resource, r), "is-act"],
              ];
        const sorted = resource === "course_types" ? [...list].sort((a, b) => cats.findIndex((x) => x.id === a.category_id) - cats.findIndex((x) => x.id === b.category_id)) : list;
        p.append(table(cols, sorted));
      }
      if (resource === "locations") p.append(n("div", "“⋯”里：删除（有关联记录时会被拒绝）。", { class: "fq-se-pf" }));
      main.append(p);
    }
  }
  function table(cols, rows) {
    const wrap = n("div", null, { class: "fq-se-tw" }),
      t = n("table", null, { class: "fq-se-table" }),
      thead = n("thead"),
      hr = n("tr"),
      tbody = n("tbody");
    for (const [label, , cls] of cols) hr.append(n("th", label || null, cls ? { class: cls } : {}));
    thead.append(hr);
    for (const r of rows) {
      const tr = n("tr", null, r.active === false ? { class: "is-off" } : {});
      for (const [label, fn, cls] of cols) {
        const td = n("td", null, { "data-label": label, ...(cls ? { class: cls } : {}) });
        td.append(fn(r) ?? "");
        tr.append(td);
      }
      tbody.append(tr);
    }
    t.append(thead, tbody);
    wrap.append(t);
    return wrap;
  }

  // ---------- 通用新控件（开关 / 下拉 / 提示条） ----------
  function toggleSwitch({ checked, disabled, label, onToggle }) {
    const b = n("button", null, {
      type: "button",
      role: "switch",
      "aria-checked": String(!!checked),
      "aria-label": label,
      class: "fq-se-sw" + (checked ? " is-on" : ""),
    });
    if (disabled) b.disabled = true;
    const set = (v) => {
      b.setAttribute("aria-checked", String(!!v));
      b.classList.toggle("is-on", !!v);
    };
    b.addEventListener("click", () => {
      if (b.disabled) return;
      const next = b.getAttribute("aria-checked") !== "true";
      set(next);
      onToggle?.(next, set);
    });
    return { el: b, set };
  }
  function switchRow(label, hint, control, extraCls = "") {
    const r = n("div", null, { class: "fq-se-swr" + (extraCls ? " " + extraCls : "") }),
      txt = n("div");
    txt.append(n("strong", label));
    if (hint) txt.append(n("small", hint));
    r.append(txt, control);
    return r;
  }
  function selectInput({ value, options, disabled, ariaLabel, onChange }) {
    const s = n("select", null, { class: "fq-se-sel", "aria-label": ariaLabel });
    for (const [val, text] of options) {
      const o = n("option", text, { value: val });
      if (val === value) o.selected = true;
      s.append(o);
    }
    if (disabled) s.disabled = true;
    if (onChange) s.addEventListener("change", () => onChange(s.value, s));
    return s;
  }
  const banner = (text, tone = "info") => n("p", text, { class: "fq-se-banner is-" + tone, role: tone === "error" ? "alert" : "status" });

  // ---------- 教务规则 ----------
  const ABSENCE_KINDS = [
    ["student_leave", "学员请假", "学员提前请假未上课"],
    ["student_no_show", "学员旷课", "未请假无故缺席"],
    ["teacher_leave", "教师请假", "老师临时请假调课"],
    ["cancelled", "机构取消", "因机构安排取消本节课"],
  ];
  const DEBT_OPTIONS = [0, 1, 2, 3, 4, 5, 6, 8, 10].map((v) => [String(v), v ? v + " 课时" : "不允许欠课时"]);
  const VIEW_OPTIONS = [
    ["time", "按时间"],
    ["teacher", "按教师"],
    ["location", "按教室"],
    ["list", "列表"],
  ];
  async function rulesSection(main) {
    const s = sec("rules");
    const editable = sup();
    setSub("教务规则" + (editable ? " · 只有主管可以修改" : " · 只读（仅主管可修改）"));
    main.append(
      title(
        { ...s, desc: "缺勤是否扣课时、计课酬；欠课时上限；续费提醒；课表默认视图。修改只影响还没锁定的月份。" },
        editable ? null : pill("只读 · 仅主管可修改", "muted"),
      ),
    );

    const [abData, rnData] = await Promise.all([
      safe(api("absence-policies")),
      enabled("packages") ? safe(api("renewal-settings")) : Promise.resolve(null),
    ]);
    if (abData?.policies) stats.absence = abData.policies;
    if (rnData?.settings) stats.renewal = rnData.settings;

    // 1. 缺勤规则
    const initialAb = {};
    const draftAb = {};
    for (const [k] of ABSENCE_KINDS) {
      const src = abData?.policies?.[k] || { deduct: false, teacherPaid: false };
      initialAb[k] = { deduct: !!src.deduct, teacherPaid: !!src.teacherPaid };
      draftAb[k] = { deduct: !!src.deduct, teacherPaid: !!src.teacherPaid };
    }
    const abDirtyBadge = pill("有未保存修改", "warn");
    abDirtyBadge.hidden = true;
    const abErrBox = n("div", null, { class: "fq-se-msg-slot" });
    let abSaveBtn = null;
    const isAbDirty = () =>
      ABSENCE_KINDS.some(([k]) => draftAb[k].deduct !== initialAb[k].deduct || draftAb[k].teacherPaid !== initialAb[k].teacherPaid);
    const syncAbState = () => {
      const dirty = isAbDirty();
      abDirtyBadge.hidden = !dirty;
      if (abSaveBtn) abSaveBtn.disabled = !dirty;
    };
    if (editable) {
      abSaveBtn = btn("保存规则", async () => {
        if (!isAbDirty()) return;
        abErrBox.replaceChildren();
        abSaveBtn.disabled = true;
        abSaveBtn.textContent = "保存中…";
        try {
          await api("absence-policies", "PUT", { policies: draftAb });
          for (const [k] of ABSENCE_KINDS) initialAb[k] = { ...draftAb[k] };
          stats.absence = Object.fromEntries(ABSENCE_KINDS.map(([k]) => [k, { ...draftAb[k] }]));
          notice("缺勤规则已保存", "success");
        } catch (e) {
          const msg = e?.message || "保存缺勤规则失败，请重试。";
          abErrBox.replaceChildren(banner(msg, "error"));
          notice(msg, "error");
        } finally {
          abSaveBtn.textContent = "保存规则";
          syncAbState();
        }
      }, "is-dark is-sm");
      abSaveBtn.disabled = true;
    }
    const abPanel = panel(
      "缺勤规则",
      "学员请假、旷课，教师请假，机构取消时，是否扣学员课时、是否给老师计课酬。",
      editable ? [abDirtyBadge, abSaveBtn] : null,
    );
    if (!abData) {
      abPanel.append(n("p", "缺勤规则暂时取不到，请刷新重试。", { class: "fq-se-empty" }));
    } else {
      abPanel.append(abErrBox);
      const grid = n("div", null, { class: "fq-se-rule-grid fq-se-pb" });
      for (const [key, label, desc] of ABSENCE_KINDS) {
        const card = n("div", null, { class: "fq-se-rule-card" });
        const head = n("div", null, { class: "fq-se-rule-head" });
        head.append(n("h4", label), n("small", desc));
        const list = n("div", null, { class: "fq-se-sws" });
        for (const [flag, flagLabel] of [["deduct", "扣课时"], ["teacherPaid", "计课酬"]]) {
          const sw = toggleSwitch({
            checked: draftAb[key][flag],
            disabled: !editable,
            label: label + "：" + flagLabel,
            onToggle: (v) => {
              draftAb[key][flag] = v;
              abErrBox.replaceChildren();
              syncAbState();
            },
          });
          list.append(switchRow(flagLabel, "", sw.el, "is-compact"));
        }
        card.append(head, list);
        grid.append(card);
      }
      abPanel.append(grid);
      if (!editable) abPanel.append(n("div", "仅机构主管可修改缺勤规则。", { class: "fq-se-pf" }));
    }
    main.append(abPanel);

    // 2. 欠课时上限 & 课表默认视图（即点即存）
    const otherPanel = panel("欠课时与课表", "课时不够时最多可以欠几课时；打开课表时默认用哪种视图。修改后立即生效。");
    const otherErr = n("div", null, { class: "fq-se-msg-slot" });
    const otherList = n("div", null, { class: "fq-se-sws" });

    let prevDebt = String(me.policy.settings.max_debt_units ?? 3);
    const debtSel = selectInput({
      value: prevDebt,
      options: DEBT_OPTIONS,
      disabled: !editable,
      ariaLabel: "课时不够时最多可欠",
      onChange: async (v, sel) => {
        otherErr.replaceChildren();
        sel.disabled = true;
        try {
          const numVal = Number(v);
          await api("settings", "PUT", { key: "max_debt_units", value: numVal });
          me.policy.settings.max_debt_units = numVal;
          prevDebt = v;
          notice("欠课时上限已保存", "success");
        } catch (e) {
          sel.value = prevDebt;
          const msg = e?.message || "保存欠课时上限失败";
          otherErr.replaceChildren(banner(msg, "error"));
          notice(msg, "error");
        } finally {
          sel.disabled = !editable;
        }
      },
    });
    otherList.append(
      switchRow(
        "课时不够时最多可欠",
        "欠的课时在学员下次买课时包或用预收余额兑换时自动补扣；超过上限的学员这节课保持待销课，其他人照常销课。",
        debtSel,
      ),
    );

    let prevView = normScheduleView(me.policy.settings.default_schedule_view);
    const viewSel = selectInput({
      value: prevView,
      options: VIEW_OPTIONS,
      disabled: !editable,
      ariaLabel: "打开课表时的默认视图",
      onChange: async (v, sel) => {
        otherErr.replaceChildren();
        sel.disabled = true;
        try {
          await api("settings", "PUT", { key: "default_schedule_view", value: v });
          me.policy.settings.default_schedule_view = v;
          if (typeof scheduleView !== "undefined") scheduleView = v === "time" ? "calendar" : v === "location" ? "room" : v;
          prevView = v;
          notice("课表默认视图已保存", "success");
        } catch (e) {
          sel.value = prevView;
          const msg = e?.message || "保存课表默认视图失败";
          otherErr.replaceChildren(banner(msg, "error"));
          notice(msg, "error");
        } finally {
          sel.disabled = !editable;
        }
      },
    });
    otherList.append(switchRow("打开课表时的默认视图", "员工进入课表页时的默认展示方式。", viewSel));
    otherPanel.append(otherErr, otherList);
    if (!editable) otherPanel.append(n("div", "仅机构主管可修改欠课时上限与默认视图。", { class: "fq-se-pf" }));
    main.append(otherPanel);

    // 3. 续费提醒（DECISIONS 17：待办里的“提醒规则”入口保留，这里另有固定位置且可直接编辑保存）
    if (enabled("packages")) {
      const curRn = rnData?.settings || stats.renewal || { low_balance_threshold: 2, expiry_warning_days: 14 };
      const rnErr = n("div", null, { class: "fq-se-msg-slot" });
      const rnDirtyBadge = pill("有未保存修改", "warn");
      rnDirtyBadge.hidden = true;
      let savedLow = Number(curRn.low_balance_threshold ?? 2);
      let savedDays = Number(curRn.expiry_warning_days ?? 14);
      const lowIn = n("input", null, {
        type: "number",
        min: "0",
        max: "10000",
        step: "1",
        value: String(savedLow),
        class: "fq-se-in fq-se-num-in",
        "aria-label": "低余额课时",
      });
      const daysIn = n("input", null, {
        type: "number",
        min: "1",
        max: "365",
        step: "1",
        value: String(savedDays),
        class: "fq-se-in fq-se-num-in",
        "aria-label": "提前提醒天数",
      });
      if (!editable) {
        lowIn.disabled = true;
        daysIn.disabled = true;
      }
      const isRnDirty = () => String(lowIn.value).trim() !== String(savedLow) || String(daysIn.value).trim() !== String(savedDays);
      let rnSaveBtn = null;
      const syncRn = () => {
        const dirty = isRnDirty();
        rnDirtyBadge.hidden = !dirty;
        if (rnSaveBtn) rnSaveBtn.disabled = !dirty;
      };
      lowIn.addEventListener("input", () => {
        rnErr.replaceChildren();
        syncRn();
      });
      daysIn.addEventListener("input", () => {
        rnErr.replaceChildren();
        syncRn();
      });
      if (editable) {
        rnSaveBtn = btn("保存提醒规则", async () => {
          rnErr.replaceChildren();
          const low = Number(lowIn.value);
          const days = Number(daysIn.value);
          if (!Number.isInteger(low) || low < 0 || low > 10000) {
            rnErr.replaceChildren(banner("低余额课时须为 0 到 10000 的整数。", "error"));
            return;
          }
          if (!Number.isInteger(days) || days < 1 || days > 365) {
            rnErr.replaceChildren(banner("提前提醒天数须为 1 到 365 的整数。", "error"));
            return;
          }
          rnSaveBtn.disabled = true;
          rnSaveBtn.textContent = "保存中…";
          try {
            await api("renewal-settings", "PUT", { low_balance_threshold: low, expiry_warning_days: days });
            savedLow = low;
            savedDays = days;
            stats.renewal = { low_balance_threshold: low, expiry_warning_days: days };
            notice("续费提醒规则已保存", "success");
          } catch (e) {
            const msg = e?.message || "保存续费提醒规则失败";
            rnErr.replaceChildren(banner(msg, "error"));
            notice(msg, "error");
          } finally {
            rnSaveBtn.textContent = "保存提醒规则";
            syncRn();
          }
        }, "is-dark is-sm");
        rnSaveBtn.disabled = true;
      }
      const rnPanel = panel(
        "续费提醒",
        "剩余课时不超过“低余额课时”，或课时包在“提前提醒天数”内到期，就会出现在待办的续费提醒里。",
        editable ? [rnDirtyBadge, rnSaveBtn] : null,
      );
      const wrapUnit = (input, unit) => {
        const w = n("span", null, { class: "fq-se-unit-in" });
        w.append(input, n("span", unit));
        return w;
      };
      const rnList = n("div", null, { class: "fq-se-sws" });
      rnList.append(
        switchRow("低余额课时", "学员课时包剩余课时小于或等于该数值时触发续费提醒（0–10000）。", wrapUnit(lowIn, "课时")),
        switchRow("提前提醒天数", "课时包距到期日不超过该天数时触发续费提醒（1–365）。", wrapUnit(daysIn, "天")),
      );
      rnPanel.append(rnErr, rnList);
      if (!editable) rnPanel.append(n("div", "仅机构主管可修改续费提醒规则。", { class: "fq-se-pf" }));
      main.append(rnPanel);
    }
  }

  // ---------- AI 设置 ----------
  const AI_TOOL_LABELS = {
    plans: "课程方案",
    content: "招生内容",
    feedback: "课后反馈",
    growth_reports: "成长报告",
    settings: "设置",
    applications: "留学申请",
  };
  const AI_MODEL_SUGGESTIONS = ["deepseek-chat", "deepseek-reasoner"];
  async function aiSection(main) {
    const s = sec("ai");
    const editable = sup();
    setSub("AI 设置 · 每天北京时间 0 点重新计数");
    main.append(title(s, editable ? null : pill("只读 · 仅主管可修改", "muted")));

    // 关于 DEEPSEEK_API_KEY 的清晰友好说明
    main.append(
      banner(
        "说明：AI 密钥（DEEPSEEK_API_KEY）仅保存在服务器加密环境变量中，不在页面显示或修改。若服务器尚未配置 DEEPSEEK_API_KEY，仍可提前调整下方模型与每日额度，开启 AI 服务后自动生效；调用 AI 功能时如未配置密钥会给出明确提示。",
        "info",
      ),
    );

    const usageSlot = n("div");
    let usageDate = today();

    async function renderUsage() {
      usageSlot.replaceChildren(n("p", "正在加载 AI 用量统计…", { class: "fq-se-empty fq-se-panel" }));
      let u = null;
      let errMsg = "";
      try {
        u = await api("ai/usage?date=" + encodeURIComponent(usageDate));
      } catch (e) {
        errMsg = e?.message || "AI 用量加载失败";
      }
      if (u && usageDate === today()) stats.ai = u;

      const dateInput = n("input", null, {
        type: "date",
        value: usageDate,
        class: "fq-se-in fq-se-date-in",
        "aria-label": "统计日期",
      });
      dateInput.addEventListener("change", () => {
        if (!dateInput.value) return;
        usageDate = dateInput.value;
        void renderUsage();
      });
      const up = panel("AI 用量统计", "每天北京时间 0 点重新计数；快速和深度两档分开计算。", [dateInput]);
      if (errMsg || !u) {
        const errWrap = n("div", null, { class: "fq-se-pb" });
        errWrap.append(banner(errMsg || "暂时无法读取 AI 用量数据。", "error"));
        up.append(errWrap);
        usageSlot.replaceChildren(up);
        return;
      }

      const meters = n("div", null, { class: "fq-se-ai-meters fq-se-pb" });
      for (const [k, label, desc] of [
        ["fast", "快速模型额度", "日常辅助与轻量生成"],
        ["deep", "深度模型额度", "复杂分析与深度整理"],
      ]) {
        const used = Number(u[k]?.used || 0);
        const limit = Number(u[k]?.limit || 0);
        const remain = Math.max(0, limit - used);
        const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : used > 0 ? 100 : 0;
        const tone = limit === 0 ? "is-muted" : used >= limit ? "is-red" : pct >= 85 ? "is-warn" : "";
        const m = n("div", null, { class: "fq-se-meter" });
        const top = n("div", null, { class: "fq-se-meter-top" });
        const left = n("div");
        left.append(n("strong", label), n("small", desc));
        top.append(left, pill(limit > 0 ? pct + "%" : "额度为 0", tone.replace("is-", "")));
        const val = n("div", null, { class: "fq-se-meter-num" });
        val.append(n("b", String(used)), n("span", " / " + limit + " 次"), n("small", "剩余 " + remain + " 次"));
        const prog = n("progress", null, {
          class: "fq-se-prog" + (tone ? " " + tone : ""),
          value: String(Math.min(used, Math.max(1, limit))),
          max: String(Math.max(1, limit)),
        });
        m.append(top, val, prog);
        meters.append(m);
      }
      up.append(meters);

      if (u.by_tool) {
        const subHead = n("div", null, { class: "fq-se-subhead" });
        subHead.append(n("h4", "按工具统计"), n("small", usageDate));
        up.append(subHead);
        if (u.by_tool.length) {
          up.append(
            table(
              [
                ["工具", (r) => n("strong", AI_TOOL_LABELS[r.tool] || r.tool)],
                ["快速", (r) => String(r.fast || 0), "is-num"],
                ["深度", (r) => String(r.deep || 0), "is-num"],
                ["合计", (r) => n("strong", String((r.fast || 0) + (r.deep || 0))), "is-num"],
              ],
              u.by_tool,
            ),
          );
        } else {
          up.append(n("p", "当日还没有按工具的 AI 调用记录。", { class: "fq-se-empty" }));
        }
      }

      if (u.by_user) {
        const subHead = n("div", null, { class: "fq-se-subhead" });
        subHead.append(n("h4", "按账号统计"), n("small", usageDate));
        up.append(subHead);
        if (u.by_user.length) {
          up.append(
            table(
              [
                [
                  "账号",
                  (r) => {
                    const who = r.name || r.user_id || "未知账号";
                    const box = n("span", null, { class: "fq-se-who" });
                    box.append(n("span", Array.from(who)[0], { class: "fq-se-av" }), n("strong", who));
                    return box;
                  },
                ],
                ["快速", (r) => String(r.fast || 0), "is-num"],
                ["深度", (r) => String(r.deep || 0), "is-num"],
                ["合计", (r) => n("strong", String((r.fast || 0) + (r.deep || 0))), "is-num"],
              ],
              u.by_user,
            ),
          );
        } else {
          up.append(n("p", "当日还没有按账号的 AI 调用记录。", { class: "fq-se-empty" }));
        }
      }
      usageSlot.replaceChildren(up);
    }

    // 1. 模型与每日额度配置（仅主管可读写）
    const cfgSlot = n("div");
    main.append(cfgSlot, usageSlot);

    async function renderConfig() {
      if (!editable) {
        const p = panel(["模型与每日额度 ", lock()], "仅机构主管可查看与修改模型名称和每日调用额度。");
        p.append(n("p", "当前账号只读查看下方 AI 用量统计。", { class: "fq-se-empty" }));
        cfgSlot.replaceChildren(p);
        return;
      }
      let cfg = null;
      let errText = "";
      try {
        cfg = await api("settings/ai");
        stats.aiConfig = cfg;
      } catch (e) {
        errText = e?.message || "无法读取 AI 配置。";
      }
      if (!cfg) {
        const p = panel(["模型与每日额度 ", lock()], "快速 / 深度两档模型与每日额度。");
        const box = n("div", null, { class: "fq-se-pb" });
        box.append(banner(errText, "error"));
        p.append(box);
        cfgSlot.replaceChildren(p);
        return;
      }

      let useEnv = cfg.source !== "internal";
      const errSlot = n("div", null, { class: "fq-se-msg-slot" });
      const sourcePill = pill(useEnv ? "环境变量" : "机构设置", useEnv ? "muted" : "plum");
      const datalistId = "fq-se-ai-models";
      const dl = n("datalist", null, { id: datalistId });
      for (const m of AI_MODEL_SUGGESTIONS) dl.append(n("option", null, { value: m }));

      const fastModelIn = n("input", null, {
        type: "text",
        value: cfg.fast_model || "",
        maxlength: "200",
        list: datalistId,
        placeholder: "如 deepseek-chat",
        class: "fq-se-in",
        "aria-label": "快速模型名称",
      });
      const deepModelIn = n("input", null, {
        type: "text",
        value: cfg.deep_model || "",
        maxlength: "200",
        list: datalistId,
        placeholder: "如 deepseek-reasoner",
        class: "fq-se-in",
        "aria-label": "深度模型名称",
      });
      const fastLimitIn = n("input", null, {
        type: "number",
        min: "0",
        max: "1000000",
        step: "1",
        value: String(cfg.fast_daily_limit ?? 80),
        class: "fq-se-in",
        "aria-label": "快速每日额度",
      });
      const deepLimitIn = n("input", null, {
        type: "number",
        min: "0",
        max: "1000000",
        step: "1",
        value: String(cfg.deep_daily_limit ?? 50),
        class: "fq-se-in",
        "aria-label": "深度每日额度",
      });
      const inputs = [fastModelIn, deepModelIn, fastLimitIn, deepLimitIn];
      const syncDisabled = () => {
        for (const elIn of inputs) elIn.disabled = useEnv;
      };
      syncDisabled();

      const saveBtn = btn("保存设置", async () => {
        errSlot.replaceChildren();
        const payload = { version: cfg.version, use_environment: useEnv };
        if (!useEnv) {
          const fm = fastModelIn.value.trim();
          const dm = deepModelIn.value.trim();
          const fl = Number(fastLimitIn.value);
          const dlVal = Number(deepLimitIn.value);
          if (!fm || fm.length > 200) {
            errSlot.replaceChildren(banner("请填写快速模型名称（不超过 200 字符）。", "error"));
            return;
          }
          if (!dm || dm.length > 200) {
            errSlot.replaceChildren(banner("请填写深度模型名称（不超过 200 字符）。", "error"));
            return;
          }
          if (!Number.isInteger(fl) || fl < 0 || fl > 1000000) {
            errSlot.replaceChildren(banner("快速每日额度须为 0 到 1000000 的整数。", "error"));
            return;
          }
          if (!Number.isInteger(dlVal) || dlVal < 0 || dlVal > 1000000) {
            errSlot.replaceChildren(banner("深度每日额度须为 0 到 1000000 的整数。", "error"));
            return;
          }
          payload.fast_model = fm;
          payload.deep_model = dm;
          payload.fast_daily_limit = fl;
          payload.deep_daily_limit = dlVal;
        }
        saveBtn.disabled = true;
        saveBtn.textContent = "保存中…";
        try {
          const next = await api("settings/ai", "PUT", payload);
          stats.aiConfig = next;
          notice("AI 设置已保存", "success");
          await Promise.all([renderConfig(), renderUsage()]);
        } catch (e) {
          if (e?.status === 409) {
            notice("AI 设置刚被别人改过，已刷新最新配置。", "error");
            await renderConfig();
            return;
          }
          const msg = e?.message || "保存 AI 设置失败";
          errSlot.replaceChildren(banner(msg, "error"));
          notice(msg, "error");
          saveBtn.disabled = false;
          saveBtn.textContent = "保存设置";
        }
      }, "is-dark is-sm");

      const envSw = toggleSwitch({
        checked: useEnv,
        disabled: false,
        label: "跟随服务器环境变量",
        onToggle: (v) => {
          useEnv = v;
          errSlot.replaceChildren();
          syncDisabled();
        },
      });

      const p = panel(
        ["模型与每日额度 ", lock()],
        "开启“跟随环境变量”时直接使用服务器默认值；关闭后可由机构自定义模型名称与每日额度。",
        [sourcePill, saveBtn],
      );
      const swWrap = n("div", null, { class: "fq-se-sws" });
      swWrap.append(
        switchRow(
          "跟随服务器环境变量",
          useEnv ? "当前沿用环境变量默认模型与额度，关闭后可自定义。" : "当前使用机构自定义模型与额度。",
          envSw.el,
        ),
      );
      const grid = n("div", null, { class: "fq-se-ai-grid fq-se-pb" });
      const mkField = (labelText, inputEl, hintText) => {
        const f = n("div", null, { class: "fq-se-field" });
        f.append(n("label", labelText), inputEl);
        if (hintText) f.append(n("small", hintText));
        return f;
      };
      grid.append(
        mkField("快速模型", fastModelIn, "日常辅助调用，默认 deepseek-chat"),
        mkField("深度模型", deepModelIn, "复杂分析调用，默认 deepseek-reasoner"),
        mkField("快速每日额度（次/天）", fastLimitIn, "0–1000000 整数，全机构共用"),
        mkField("深度每日额度（次/天）", deepLimitIn, "0–1000000 整数，全机构共用"),
      );
      p.append(errSlot, swWrap, grid, dl);
      cfgSlot.replaceChildren(p);
    }

    await Promise.all([renderConfig(), renderUsage()]);
  }

  // ---------- 数据与备份 ----------
  async function dataSection(main, sub) {
    const s = sec("data");
    const tabs = DATA_TABS.filter(([k]) => avail[k]);
    const cur = tabs.find(([k]) => k === sub) || tabs[0];
    setSub("数据与备份" + (isPhone() ? " · 手机上只读，导入和恢复请在电脑上操作" : ""));
    main.append(title(s, chipsRow(tabs.map(([k, hash, label]) => [label, null, () => go(hash), k]), cur[0])));
    const box = n("div", null, { class: "fq-se-legacy fq-se-data is-" + cur[0] });
    main.append(box);
    if (cur[0] === "import") {
      if (isPhone()) {
        const p = panel("Excel 导入", "导入会批量写入学员、教师、剩余课时，请在电脑上操作。");
        p.append(n("p", "手机上只能查看。请在电脑上打开「设置 › 数据与备份 › 导入」。", { class: "fq-se-pb fq-se-empty" }));
        return box.append(p);
      }
      return importWizard(box);
    }
    if (cur[0] === "export") return pageHooks.exports(box);
    if (isPhone()) box.append(n("p", "手机上只读：可以查看和下载备份；从备份恢复请在电脑上操作。", { class: "fq-se-mnote" }));
    const inner = n("div");
    box.append(inner);
    return globalThis.FengqinBackup.backupPage(inner);
  }

  // ---------- 操作记录 ----------
  const logState = { kind: "audit", module: "", action: "", actor: "", from: "", to: "", q: "" };
  let logActorNames = null;
  const LOG_QUICK = [
    ["", "全部"],
    ["export", "只看导出"],
    ["delete", "只看删除"],
    ["reset_password", "只看重置密码"],
  ];
  function parseJsonPretty(raw) {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return String(raw || "");
    }
  }
  async function logsSection(main) {
    const s = sec("logs");
    let currentOffset = 0;

    if (!logActorNames && enabled("accounts")) {
      logActorNames = await safe(api("accounts?offset=0")).then((d) =>
        d ? [...new Set((d.items || []).map((u) => u.name).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN")) : null,
      );
    }

    const headSlot = n("div");
    const filterSlot = n("div");
    const listSlot = n("div");
    main.append(headSlot, filterSlot, listSlot);

    const hasFilters = () =>
      Boolean(
        (logState.kind === "audit" && (logState.module || logState.action)) ||
          logState.actor ||
          logState.from ||
          logState.to ||
          logState.q,
      );

    function renderHead() {
      setSub("操作记录 · " + (logState.kind === "login" ? "账号登录与会话记录" : "谁在什么时候改了什么"));
      headSlot.replaceChildren(
        title(
          s,
          chipsRow(
            [
              [
                "操作记录",
                null,
                () => {
                  if (logState.kind === "audit") return;
                  logState.kind = "audit";
                  currentOffset = 0;
                  renderHead();
                  renderFilters();
                  void loadList(0);
                },
                "audit",
              ],
              [
                "登录记录",
                null,
                () => {
                  if (logState.kind === "login") return;
                  logState.kind = "login";
                  currentOffset = 0;
                  renderHead();
                  renderFilters();
                  void loadList(0);
                },
                "login",
              ],
            ],
            logState.kind,
          ),
        ),
      );
    }

    let lastData = null;
    function renderFilters() {
      const clearBtn = hasFilters()
        ? btn(
            "清除筛选",
            () => {
              Object.assign(logState, { module: "", action: "", actor: "", from: "", to: "", q: "" });
              currentOffset = 0;
              renderFilters();
              void loadList(0);
            },
            "is-soft is-sm",
          )
        : null;
      const fp = panel("筛选条件", logState.kind === "audit" ? "按动作、模块、操作人、日期或关键字筛选。" : "按操作人、日期或关键字筛选登录记录。", clearBtn ? [clearBtn] : null);
      const body = n("div", null, { class: "fq-se-pb fq-se-log-filters" });

      if (logState.kind === "audit") {
        body.append(
          chipsRow(
            LOG_QUICK.map(([k, label]) => [
              label,
              null,
              () => {
                logState.action = k;
                currentOffset = 0;
                renderFilters();
                void loadList(0);
              },
              k,
            ]),
            logState.action,
          ),
        );
      }

      const grid = n("div", null, { class: "fq-se-filter-grid" });
      const wrapField = (labelText, ctrl) => {
        const d = n("div", null, { class: "fq-se-fitem" });
        d.append(n("label", labelText), ctrl);
        return d;
      };

      if (logState.kind === "audit") {
        const modOpts = [
          ["", "全部模块"],
          ...Object.entries(me.labels?.modules || {})
            .filter(([k]) => !["home", "profile"].includes(k))
            .map(([k, v]) => [k, v]),
        ];
        grid.append(
          wrapField(
            "模块",
            selectInput({
              value: logState.module,
              options: modOpts,
              disabled: false,
              ariaLabel: "按模块筛选",
              onChange: (v) => {
                logState.module = v;
                currentOffset = 0;
                renderFilters();
                void loadList(0);
              },
            }),
          ),
        );
      }

      if (logActorNames) {
        const names = [...logActorNames, "系统", "系统维护"];
        if (logState.actor && !names.includes(logState.actor)) names.unshift(logState.actor);
        grid.append(
          wrapField(
            "操作人",
            selectInput({
              value: logState.actor,
              options: [["", "全部操作人"], ...names.map((x) => [x, x])],
              disabled: false,
              ariaLabel: "按操作人筛选",
              onChange: (v) => {
                logState.actor = v;
                currentOffset = 0;
                renderFilters();
                void loadList(0);
              },
            }),
          ),
        );
      } else {
        const actorIn = n("input", null, {
          type: "search",
          value: logState.actor,
          maxlength: "100",
          placeholder: "输入姓名后回车",
          class: "fq-se-in",
          "aria-label": "按操作人筛选",
        });
        actorIn.addEventListener("change", () => {
          logState.actor = actorIn.value.trim();
          currentOffset = 0;
          renderFilters();
          void loadList(0);
        });
        grid.append(wrapField("操作人", actorIn));
      }

      const fromIn = n("input", null, { type: "date", value: logState.from, class: "fq-se-in", "aria-label": "开始日期" });
      const toIn = n("input", null, { type: "date", value: logState.to, class: "fq-se-in", "aria-label": "结束日期" });
      fromIn.addEventListener("change", () => {
        logState.from = fromIn.value || "";
        currentOffset = 0;
        renderFilters();
        void loadList(0);
      });
      toIn.addEventListener("change", () => {
        logState.to = toIn.value || "";
        currentOffset = 0;
        renderFilters();
        void loadList(0);
      });
      grid.append(wrapField("开始日期", fromIn), wrapField("结束日期", toIn));

      const qIn = n("input", null, {
        type: "search",
        value: logState.q,
        maxlength: "100",
        placeholder: "搜索摘要 / 对象（当前页）",
        class: "fq-se-in",
        "aria-label": "关键字筛选当前页",
      });
      qIn.addEventListener("input", () => {
        logState.q = qIn.value.trim();
        if (lastData) drawTable(lastData, currentOffset);
      });
      grid.append(wrapField("关键字", qIn));

      body.append(grid);
      fp.append(body);
      filterSlot.replaceChildren(fp);
    }

    function openDetail(r, whatText) {
      const d = UI.drawer({ title: whatText, subtitle: (r.actor_label || "本人登录账号") + " · " + F.date(r.at) + " " + F.time(r.at) });
      for (const x of r.rows) {
        const box = n("section", null, { class: "fq-se-panel fq-se-log-det" });
        const head = n("div", null, { class: "fq-se-ph" });
        const left = n("div");
        left.append(n("h3", F.time(x.at) + " · " + (x.summary || (logState.kind === "login" ? "登录会话" : "操作记录"))));
        head.append(left);
        box.append(head);
        let hasDiff = false;
        const body = n("div", null, { class: "fq-se-pb" });
        for (const key of ["before_json", "after_json"]) {
          if (!x[key]) continue;
          hasDiff = true;
          const det = n("details", null, { class: "fq-se-diff" });
          det.append(n("summary", key === "before_json" ? "修改前" : "修改后"), n("pre", parseJsonPretty(x[key]), { class: "fq-se-pre" }));
          body.append(det);
        }
        if (!hasDiff) body.append(n("p", "该条记录无字段变更明细。", { class: "fq-se-empty" }));
        box.append(body);
        d.body.append(box);
      }
    }

    function drawTable(data, offset) {
      // 同一人、同类操作、同一分钟合并（仅限已加载的这一页）。
      const grouped = new Map();
      for (const row of data.items || []) {
        const key = [row.actor_label || row.user_id, row.module, row.action || row.event, Math.floor(row.at / 60000)].join("|");
        if (!grouped.has(key)) grouped.set(key, { ...row, rows: [] });
        grouped.get(key).rows.push(row);
      }
      let rows = [...grouped.values()];
      const what = (r) =>
        (me.labels?.modules?.[r.module] || (logState.kind === "login" ? "登录" : "其他")) +
        " · " +
        (me.labels?.actions?.[r.action] || me.labels?.events?.[r.event] || "操作") +
        (r.rows.length > 1 ? " " + r.rows.length + " 条" : "");
      const pillTone = (r) => (r.action === "delete" || r.action === "reset_password" ? "red" : r.action === "export" || r.action === "download" ? "plum" : "muted");

      if (logState.q) {
        const kw = logState.q.toLowerCase();
        rows = rows.filter((r) => {
          const hay = [r.actor_label, what(r), r.summary, ...r.rows.map((x) => x.summary)].filter(Boolean).join(" ").toLowerCase();
          return hay.includes(kw);
        });
      }

      const lp = panel(
        [logState.kind === "login" ? "登录记录" : "操作记录", n("span", "共 " + (data.total ?? 0) + " 条")],
        rows.length < (data.items || []).length && !logState.q ? "同一人同一分钟的同类操作已合并；点击「查看」展开完整明细。" : "点击「查看」展开该条记录的变更前后明细。",
      );

      if (!rows.length) {
        lp.append(n("p", hasFilters() ? "没有符合筛选条件的记录。" : "还没有记录。", { class: "fq-se-empty" }));
      } else {
        const cols = [
          ["时间", (r) => n("span", F.date(r.at).slice(5) + " " + F.time(r.at), { class: "fq-se-mono" })],
          [
            "操作人",
            (r) => {
              const who = r.actor_label || "本人登录账号";
              const w = n("span", null, { class: "fq-se-who" });
              w.append(n("span", Array.from(who)[0], { class: "fq-se-av" + (who === "系统" ? " is-ink" : "") }), n("strong", who));
              return w;
            },
          ],
          ["动作", (r) => pill(what(r), pillTone(r))],
          [
            "对象 / 摘要",
            (r) => n("span", r.rows.length > 1 ? "多个对象（" + r.rows.length + " 条）" : r.summary || (logState.kind === "login" ? "登录会话" : "—"), { class: "fq-se-log-sum" }),
          ],
          ["", (r) => btn("查看", () => openDetail(r, what(r)), "is-soft is-sm"), "is-act"],
        ];
        lp.append(table(cols, rows));
      }

      const pf = n("div", null, { class: "fq-se-pf" });
      const infoText =
        "共 " +
        (data.total ?? 0) +
        " 条" +
        (logState.q ? " · 当前页匹配 " + rows.length + " 组" : rows.length < (data.items || []).length ? " · 本页已合并同分钟同类操作" : "");
      const pagerBtns = n("div", null, { class: "fq-se-ph-acts" });
      if (offset > 0) pagerBtns.append(btn("上一页", () => void loadList(Math.max(0, offset - 200)), "is-sm"));
      if (data.next_offset !== null && data.next_offset !== undefined) pagerBtns.append(btn("下一页", () => void loadList(data.next_offset), "is-sm"));
      pf.append(n("span", infoText), pagerBtns);
      lp.append(pf);
      listSlot.replaceChildren(lp);
    }

    async function loadList(offset = 0) {
      currentOffset = offset;
      if (logState.from && logState.to && logState.from > logState.to) {
        const ep = panel("筛选有误");
        const b = n("div", null, { class: "fq-se-pb" });
        b.append(banner("开始日期不能晚于结束日期，请重新选择。", "error"));
        ep.append(b);
        listSlot.replaceChildren(ep);
        return;
      }
      listSlot.replaceChildren(n("p", "正在加载记录…", { class: "fq-se-empty fq-se-panel" }));
      const q = new URLSearchParams({ kind: logState.kind, offset: String(offset) });
      for (const k of ["actor", "from", "to"]) if (logState[k]) q.set(k, logState[k]);
      if (logState.kind === "audit") for (const k of ["module", "action"]) if (logState[k]) q.set(k, logState[k]);
      try {
        const data = await api("logs?" + q);
        lastData = data;
        if (logState.kind === "audit" && offset === 0 && !hasFilters()) stats.logs = data.items || [];
        drawTable(data, offset);
      } catch (e) {
        const ep = panel("记录加载失败");
        const b = n("div", null, { class: "fq-se-pb" });
        b.append(banner(e?.message || "加载操作记录失败，请稍后重试。", "error"));
        ep.append(b);
        listSlot.replaceChildren(ep);
      }
    }

    renderHead();
    renderFilters();
    await loadList(0);
  }

  const RENDER = {
    overview,
    accounts: accountsSection,
    institution: institutionSection,
    courses: coursesSection,
    rules: rulesSection,
    ai: aiSection,
    data: dataSection,
    logs: logsSection,
  };

  // ---------- 导航钩子 ----------
  (globalThis.fqNavHooks ||= []).push((daily, manage, register) => {
    // DECISIONS 13：课程与教室从老师分组移回设置，老师分组不留入口。
    let coursesTab = null;
    for (const list of [manage, daily]) {
      const t = list.find((x) => x && x.key === "teachers");
      const i = t ? t.tabs.findIndex((x) => x && x.key === "admin-courses") : -1;
      if (i >= 0) coursesTab = t.tabs.splice(i, 1)[0];
    }
    let g = manage.find((x) => x && x.key === "settings");
    if (!g && !coursesTab) return;
    if (!g) manage.push((g = { key: "settings", label: "设置", icon: "settings", tabs: [] }));
    const old = Object.fromEntries(g.tabs.filter(Boolean).map((t) => [t.key, t]));
    avail = {
      accounts: !!old["settings-accounts"],
      rights: !!old["settings-rights"],
      institution: !!old["settings-institution"],
      rules: !!old["settings-institution"],
      courses: !!coursesTab,
      ai: !!old["inst-ai"],
      import: !!old["settings-import"],
      export: !!old["settings-export"],
      backup: !!old["settings-backup"],
      logs: !!old["settings-logs"],
    };
    avail.data = avail.import || avail.export || avail.backup;
    let overviewTab = null;
    for (const m of ["home", "settings", "accounts", "logs", "imports"]) if (!overviewTab) overviewTab = register("settings-overview", "总览", m, (c) => page(c, "overview"));
    if (!overviewTab) return;
    const tabs = [overviewTab];
    const use = (key, section, sub) => {
      const t = old[key];
      if (!t) return;
      t.fn = (c) => page(c, section, sub);
      tabs.push(t);
    };
    use("settings-accounts", "accounts");
    use("settings-rights", "accounts", "rights");
    use("settings-institution", "institution");
    if (coursesTab) {
      const t = register("settings-courses", "课程与教室", "settings", (c) => page(c, "courses"));
      if (t) tabs.push(t);
      coursesTab.fn = () => location.replace("#settings-courses");
    }
    if (avail.rules) {
      const t = register("settings-rules", "教务规则", "settings", (c) => page(c, "rules"));
      if (t) tabs.push(t);
      else avail.rules = false;
    }
    if (avail.ai) {
      const t = register("settings-ai", "AI 设置", "ai", (c) => page(c, "ai"), "use");
      if (t) tabs.push(t);
      old["inst-ai"].fn = () => location.replace("#settings-ai");
    }
    if (avail.data) {
      // 手机端只读：默认打开导出或备份，不先进导入。
      const first = () => (isPhone() && DATA_TABS.find(([k]) => k !== "import" && avail[k])) || DATA_TABS.find(([k]) => avail[k]);
      const t = register("settings-data", "数据与备份", "home", () => location.replace("#" + first()[1]));
      if (t) tabs.push(t);
    }
    use("settings-import", "data", "import");
    use("settings-export", "data", "export");
    use("settings-backup", "data", "backup");
    use("settings-logs", "logs");
    // 其他钩子以后加进设置的页签：原样保留（显示在总览之后）。
    const known = new Set(["settings-accounts", "settings-rights", "settings-institution", "inst-ai", "settings-import", "settings-export", "settings-backup", "settings-logs"]);
    for (const t of g.tabs.filter((x) => x && !known.has(x.key))) tabs.push(t);
    g.tabs = tabs;
  });
  globalThis.FengqinSettings = { page, sections: () => shown().map((s) => s.key) };
})();
