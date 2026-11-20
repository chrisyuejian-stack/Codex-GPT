// 枫琴教务中心 · 学员端（设计稿 11 电脑版、12 手机版）。
// 加载在 v2m.js、c3.js 之后：重新赋值 `personalShell`，学员账号进入新界面，老师账号仍走原来的个人页。
// 学员端只读：首页、课表、老师点评、课时与缴费、我的（改密码 / 登录设备 / 退出）。
// 课时余额、缴费分别受 student_view_balance、student_view_payments 控制；读接口被拒时只隐藏对应区块，不报错。
(() => {
  "use strict";
  const original = personalShell;
  const n = el,
    F = UI.fmt,
    M = () => globalThis.ChannelV2Mobile;
  const SVG = "http://www.w3.org/2000/svg";
  const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const isStudent = () => !!me?.user?.roles?.includes("student");
  const settings = () => me.policy?.settings || {};
  const canSchedule = () => enabled("schedule");
  const canComments = () => enabled("comments");
  const canBalance = () => enabled("packages") && settings().student_view_balance !== false;
  const canPay = () => enabled("tuition") && settings().student_view_payments === true;
  const phone = globalThis.matchMedia?.("(max-width: 760px)");
  const isPhone = () => !!phone?.matches;

  // ---------- 小工具 ----------
  const soft = (p) => api(p).catch(() => null);
  const day = (iso) => String(iso).slice(0, 10);
  const wd = (d) => WEEK[new Date(day(d) + "T12:00:00Z").getUTCDay()];
  const md = (d) => Number(d.slice(5, 7)) + " 月 " + Number(d.slice(8, 10)) + " 日";
  const slash = (d) => Number(d.slice(5, 7)) + "/" + Number(d.slice(8, 10));
  const round = (v) => Math.round(Number(v || 0) * 100) / 100;
  const teacherName = (t) => (t ? t + (/老师$/.test(t) ? "" : "老师") : "老师");
  const place = (r) => (r.mode === "online" ? "线上课" : r.location_name || "待定地点");
  const daysUntil = (d) =>
    Math.round((Date.parse(day(d) + "T12:00:00Z") - Date.parse(todayBJ() + "T12:00:00Z")) / 86400000);
  const relText = (d) => {
    const k = daysUntil(d);
    return k <= 0 ? "今天" : k === 1 ? "明天" : k + " 天后";
  };
  const hourBJ = () => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", hourCycle: "h23" }).format(new Date()));
  const greeting = () => {
    const h = hourBJ();
    return h < 5 ? ["Good evening", "晚上好"] : h < 12 ? ["Good morning", "上午好"] : h < 18 ? ["Good afternoon", "下午好"] : ["Good evening", "晚上好"];
  };
  // 三个汉字的姓名去掉姓（王一然 → 一然）；其他情况用全名。
  const callName = () => {
    const name = String(me.user.name || "").trim();
    return /^[一-龥]{3}$/.test(name) ? name.slice(1) : name || "同学";
  };
  const initial = () => Array.from(String(me.user.name || "学").trim())[0] || "学";
  const monthBounds = (month) => {
    const from = month + "-01";
    return [from, dateShift(dateShift(from, 32).slice(0, 7) + "-01", -1)];
  };
  function icon(paths) {
    const s = document.createElementNS(SVG, "svg");
    for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "aria-hidden": "true" })) s.setAttribute(k, v);
    for (const [tag, attrs] of paths) {
      const p = document.createElementNS(SVG, tag);
      for (const [k, v] of Object.entries(attrs)) p.setAttribute(k, v);
      s.append(p);
    }
    return s;
  }
  const ICONS = {
    home: [["path", { d: "M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" }]],
    schedule: [["rect", { x: "3", y: "4", width: "18", height: "17", rx: "2" }], ["path", { d: "M3 9h18M8 2v4M16 2v4" }]],
    comments: [["path", { d: "M4 5h16v14H4z" }], ["path", { d: "M8 9h8M8 13h5" }]],
    credits: [["rect", { x: "2", y: "5", width: "20", height: "14", rx: "2" }], ["path", { d: "M2 10h20M6 15h4" }]],
    apply: [["path", { d: "M22 10L12 5 2 10l10 5z" }], ["path", { d: "M6 12v5c3 2 9 2 12 0v-5" }]],
    my: [["circle", { cx: "12", cy: "8", r: "4" }], ["path", { d: "M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" }]],
    clock: [["circle", { cx: "12", cy: "12", r: "9" }], ["path", { d: "M12 7v5l3 2" }]],
    check: [["path", { d: "M5 12l5 5 9-10" }]],
  };
  const logo = () => n("span", null, { class: "fq-logo", role: "img", "aria-label": "fantasme 枫琴国际艺术" });
  const avatar = (cls = "") => n("span", initial(), { class: "fq-st-av" + (cls ? " " + cls : ""), "aria-hidden": "true" });
  const link = (text, fn, cls = "fq-st-link") => {
    const b = n("button", text, { type: "button", class: cls });
    b.addEventListener("click", fn);
    return b;
  };
  const pill = (text, tone = "") => n("span", text, { class: "fq-st-pill" + (tone ? " is-" + tone : "") });
  // 进度条宽度：按 5% 分档的类名（CSP 不允许内联样式）。
  function bar(balance, total) {
    const pct = total > 0 ? Math.max(0, Math.min(100, (Number(balance) / Number(total)) * 100)) : 0;
    const b = n("div", null, { class: "fq-st-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(total || 0), "aria-valuenow": String(Math.max(0, balance)) });
    b.append(n("span", null, { class: "fq-st-w" + Math.round(pct / 5) * 5 }));
    return b;
  }
  function panel(title, sub, action) {
    const p = n("section", null, { class: "fq-st-panel" });
    const h = n("div", null, { class: "fq-st-ph" });
    const t = n("div");
    t.append(n("h2", title));
    if (sub) t.append(n("p", sub));
    h.append(t);
    if (action) h.append(action);
    p.append(h);
    return p;
  }
  const emptyLine = (text) => n("p", text, { class: "fq-st-empty" });
  const logOut = async () => {
    await api("logout", "POST", {});
    location.assign(base + "login");
  };
  const changePw = () => changePassword(UI.drawer({ title: "修改密码" }).body);

  // ---------- 数据 ----------
  // 点评：student/comments 只带 lesson_id，课程、老师、出勤从课表行补上（c3/student-comments 作后备）。
  async function lessonMap(items, seed = []) {
    const map = new Map();
    for (const r of seed) map.set(r.id, r);
    const missing = items.filter((x) => x.lesson_id && !map.has(x.lesson_id));
    if (missing.length && canSchedule()) {
      const months = [...new Set(missing.map((x) => day(x.at).slice(0, 7)))].slice(0, 6);
      // 点评确认时间可能晚于上课，所以连同上一个月一起查。
      const wanted = [...new Set(months.flatMap((m) => [m, dateShift(m + "-01", -1).slice(0, 7)]))].slice(0, 8);
      const pages = await Promise.all(wanted.map((m) => scheduleRows(...monthBounds(m)).catch(() => [])));
      for (const rows of pages) for (const r of rows) if (!map.has(r.id)) map.set(r.id, r);
    }
    return map;
  }
  function noteOf(x, map) {
    const l = map.get(x.lesson_id) || {};
    const m = x.message || {};
    const main = x.public_comment || m.learned || "";
    return {
      date: l.start_at || x.at,
      course: l.course_name || x.title || "课后反馈",
      teacher: l.teacher_name || "",
      attendance: l.own_attendance,
      main,
      extra: [
        main !== m.learned && m.learned ? ["给你的话", m.learned] : null,
        m.good ? ["做得好", m.good] : null,
        m.attention ? ["要注意", m.attention] : null,
        m.homework ? ["作业", m.homework] : null,
      ].filter(Boolean),
      tags: x.tags || [],
      images: x.image_urls || [],
      homework: m.homework || l.homework || "",
    };
  }
  const ATT = { attended: ["已出勤", "ok"], student_leave: ["请假", "warn"], no_show: ["缺勤", "bad"], teacher_leave: ["老师请假", ""], cancelled: ["已取消", ""] };
  function noteCard(note, { full = false } = {}) {
    const box = n("article", null, { class: "fq-st-cmt" });
    const top = n("div", null, { class: "fq-st-cmt-top" });
    top.append(n("strong", [slash(day(note.date)), note.course, note.teacher ? teacherName(note.teacher) : ""].filter(Boolean).join(" · ")));
    const att = ATT[note.attendance];
    if (att) top.append(pill(att[0], att[1]));
    box.append(top);
    if (note.main) box.append(n("q", note.main, { class: "preserve-text" }));
    const extra = full ? note.extra : note.extra.filter(([k]) => k === "作业");
    for (const [k, v] of extra) {
      const p = n("p", null, { class: "fq-st-cmt-extra preserve-text" });
      p.append(n("b", k + "："), v);
      box.append(p);
    }
    if (full && note.tags.length) {
      const t = n("div", null, { class: "fq-st-tags" });
      for (const tag of note.tags) t.append(pill(String(tag), "info"));
      box.append(t);
    }
    if (full && note.images.length) {
      const g = n("div", null, { class: "fq-st-imgs" });
      for (const src of note.images) g.append(n("img", null, { src, alt: "课堂图片", loading: "lazy" }));
      box.append(g);
    }
    return box;
  }
  // 启动预取（见 app.js apiPrefetch）：首页数据，路径须与 homeData 发出的请求完全一致。
  const schedulePath = (from, to) => "schedule?from=" + from + "&to=" + to + "&offset=0";
  (globalThis.fqPrefetch ||= {}).student = {
    flags: () => ({ schedule: canSchedule(), balance: canBalance(), comments: canComments() }),
    paths: (f) => {
      const today = todayBJ();
      return [
        ...(f.schedule ? ["schedule-next", schedulePath(...monthBounds(today.slice(0, 7))), schedulePath(today, dateShift(today, 30))] : []),
        ...(f.balance ? ["credits/packages"] : []),
        ...(f.comments ? ["student/comments?limit=50", "c3/student-comments"] : []),
      ];
    },
  };
  async function homeData() {
    const today = todayBJ(),
      month = today.slice(0, 7);
    const [next, monthRows, ahead, pkgs, comments, recent] = await Promise.all([
      canSchedule() ? soft("schedule-next").then((x) => x?.record || null) : null,
      canSchedule() ? scheduleRows(...monthBounds(month)).catch(() => []) : [],
      canSchedule() ? scheduleRows(today, dateShift(today, 30)).catch(() => []) : [],
      canBalance() ? soft("credits/packages") : null,
      canComments() ? soft("student/comments?limit=50") : null,
      canComments() ? soft("c3/student-comments") : null,
    ]);
    const now = Date.now();
    const upcoming = ahead
      .filter((r) => r.status === "planned" && !r.source_course_id && Date.parse(r.start_at) > now)
      .sort((a, b) => a.start_at.localeCompare(b.start_at));
    const own = monthRows.filter((r) => !r.source_course_id && Date.parse(r.start_at) <= now);
    const map = comments ? await lessonMap(comments.items.slice(0, 3), [...(recent?.items || []), ...monthRows]) : new Map();
    const notes = (comments?.items || []).map((x) => noteOf(x, map));
    const packages = pkgs ? pkgs.items.filter((p) => p.status === "active" || Number(p.balance) > 0) : null;
    const lastHomework = notes.find((x) => x.homework)?.homework || own.sort((a, b) => b.start_at.localeCompare(a.start_at)).find((r) => r.homework)?.homework || "";
    return {
      next: next || upcoming[0] || null,
      upcoming: upcoming.slice(0, 4),
      attended: own.filter((r) => r.own_attendance === "attended").length,
      leave: own.filter((r) => r.own_attendance === "student_leave").length,
      packages,
      balance: packages ? round(packages.reduce((s, p) => s + Number(p.balance || 0), 0)) : null,
      notes,
      total: comments ? comments.total ?? notes.length : null,
      monthNotes: (comments?.items || []).filter((x) => day(x.at).slice(0, 7) === month).length,
      lastHomework,
    };
  }

  // ---------- 外壳 ----------
  let view = "home",
    frame = null,
    content = null,
    run = 0;
  const VIEWS = {
    home: { label: "首页", en: "Home", fn: (c) => (isPhone() ? phoneHome(c) : deskHome(c)), on: () => true },
    schedule: { label: "我的课表", short: "课表", en: "My timetable", fn: (c) => M().studentWeek(c), on: canSchedule },
    comments: { label: "老师点评", short: "点评", en: "Teacher notes", fn: (c) => commentsPage(c), on: canComments },
    credits: { label: "课时与缴费", en: "Lessons & payments", fn: (c) => creditsPage(c), on: () => canBalance() || canPay() },
    my: { label: "我的", en: "My account", fn: (c) => myPage(c), on: () => true },
  };
  const DESK_NAV = ["home", "schedule", "comments", "credits"];
  const PHONE_NAV = ["home", "schedule", "comments", "my"];

  function deskHeader(key) {
    const top = n("header", null, { class: "fq-st-top" });
    const t = n("div");
    if (key === "home") {
      const [en, cn] = greeting();
      const today = todayBJ();
      t.append(n("p", en, { class: "fq-st-eb" }), n("h1", callName() + "，" + cn), n("p", md(today) + " " + wd(today), { class: "fq-st-sub" }));
    } else t.append(n("p", VIEWS[key].en, { class: "fq-st-eb" }), n("h1", VIEWS[key].label));
    top.append(t, n("span", "请假请联系教务老师", { class: "fq-st-hint" }));
    return top;
  }
  function phoneHeader(key) {
    const top = n("header", null, { class: "fq-st-phead" + (key === "home" ? " is-home" : "") });
    const row = n("div", null, { class: "fq-st-prow" });
    const me_ = n("button", null, { type: "button", class: "fq-st-avbtn", "aria-label": "我的" });
    me_.append(avatar());
    me_.addEventListener("click", () => go("my"));
    row.append(logo(), me_);
    top.append(row);
    if (key === "home") {
      const [en, cn] = greeting();
      top.append(n("p", en, { class: "fq-st-eb" }), n("h1", callName() + "，" + cn));
    } else top.append(n("p", VIEWS[key].en, { class: "fq-st-eb" }), n("h1", VIEWS[key].label));
    return top;
  }
  function sideBar() {
    const side = n("aside", null, { class: "fq-st-side", "aria-label": "学员菜单" });
    const brandBox = n("div", null, { class: "fq-st-brand" });
    const copy = n("span");
    copy.append(n("b", "枫琴教务中心"), n("i", "Student Portal"));
    brandBox.append(logo(), copy);
    const nav = n("nav", null, { class: "fq-st-nav", "aria-label": "学员导航" });
    nav.append(n("p", "MY STUDY", { class: "fq-st-nl" }));
    for (const key of DESK_NAV.filter((k) => VIEWS[k].on())) {
      const b = n("button", null, { type: "button", class: "fq-st-item", "data-key": key });
      b.append(icon(ICONS[key]), n("span", VIEWS[key].label));
      b.addEventListener("click", () => go(key));
      nav.append(b);
    }
    const apply = n("nav", null, { class: "fq-st-nav", "aria-label": "申请" });
    const soon = n("div", null, { class: "fq-st-item is-soon", "aria-disabled": "true" });
    soon.append(icon(ICONS.apply), n("span", "留学申请"), n("small", "即将开放", { class: "fq-st-soon" }));
    apply.append(n("p", "APPLICATION", { class: "fq-st-nl" }), soon);
    const who = n("div", null, { class: "fq-st-me" });
    const meBtn = n("button", null, { type: "button", class: "fq-st-mebtn", "data-key": "my", "aria-label": "我的账号" });
    const name = n("span", null, { class: "fq-st-mename" });
    name.append(n("b", me.user.name), n("small", "学员"));
    meBtn.append(avatar(), name);
    meBtn.addEventListener("click", () => go("my"));
    who.append(meBtn, link("退出", logOut, "fq-st-out"));
    side.append(brandBox, nav, apply, who);
    return side;
  }
  function tabBar() {
    const nav = n("nav", null, { class: "fq-st-tabs", "aria-label": "底部导航" });
    for (const key of PHONE_NAV.filter((k) => VIEWS[k].on())) {
      const b = n("button", null, { type: "button", class: "fq-st-tab", "data-key": key });
      b.append(n("i", null, { "aria-hidden": "true" }), n("span", VIEWS[key].short || VIEWS[key].label));
      b.addEventListener("click", () => go(key));
      nav.append(b);
    }
    return nav;
  }
  function render() {
    root.replaceChildren();
    document.title = "枫琴教务中心 · 学员";
    const p = isPhone();
    frame = n("div", null, { class: "fq-student v-personal " + (p ? "is-phone" : "is-desk") });
    content = n("section", null, { class: "personal-content fq-st-body", "aria-busy": "false" });
    if (p) frame.append(n("div", null, { class: "fq-st-head-slot" }), content, tabBar());
    else {
      const main = n("main", null, { class: "fq-st-main" });
      main.append(n("div", null, { class: "fq-st-head-slot" }), content);
      frame.append(sideBar(), main);
    }
    root.append(frame);
    if (!VIEWS[view]?.on()) view = "home";
    void go(view);
  }
  async function go(key) {
    view = key;
    personalTab = key;
    const v = VIEWS[key];
    // 手机底栏没有“课时与缴费”，从“我的”进入时仍高亮“我的”。
    const navKey = isPhone() && key === "credits" ? "my" : key;
    for (const b of frame.querySelectorAll("[data-key]")) b.setAttribute("aria-current", b.dataset.key === navKey ? "page" : "false");
    frame.dataset.view = key;
    frame.querySelector(".fq-st-head-slot").replaceChildren(isPhone() ? phoneHeader(key) : deskHeader(key));
    content.dataset.personalTab = key;
    content.setAttribute("aria-busy", "true");
    content.replaceChildren(UI.tableSkeleton());
    const g = ++run;
    try {
      await v.fn(content);
      if (g === run) globalThis.scrollTo?.(0, 0);
    } catch (e) {
      if (g === run) content.replaceChildren(UI.empty({ text: e.message, action: { label: "重试", onSelect: () => go(key) } }));
      notice(e.message);
    } finally {
      if (g === run) content.setAttribute("aria-busy", "false");
    }
  }
  phone?.addEventListener?.("change", () => {
    if (isStudent() && frame && root.contains(frame)) render();
  });

  personalShell = () => {
    if (!isStudent()) return original();
    render();
  };

  // ---------- 电脑版首页 ----------
  function heroCard(d) {
    const hero = n("section", null, { class: "fq-st-hero" });
    const body = n("div", null, { class: "fq-st-hero-body" });
    const left = n("div", null, { class: "fq-st-hero-main" });
    const right = n("div", null, { class: "fq-st-hero-side" });
    const x = d.next;
    left.append(n("p", "Next lesson", { class: "fq-st-eb" }));
    if (x) {
      const k = daysUntil(x.start_at);
      left.append(
        n("h2", x.course_name + " · " + teacherName(x.teacher_name)),
        n("p", wd(x.start_at) + " " + md(day(x.start_at)) + " " + F.range(x.start_at, x.duration || 60) + " · " + place(x)),
      );
      const big = n("span", null, { class: "fq-st-hero-num" });
      if (k >= 2) big.append(String(k), n("small", "天后"));
      else big.append(n("small", relText(x.start_at), { class: "is-word" }));
      right.append(big);
    } else left.append(n("h2", "暂未安排下一节课"), n("p", "排课后会显示在这里，有疑问请联系教务老师。"));
    if (d.lastHomework) right.append(n("span", "上次作业：" + d.lastHomework, { class: "fq-st-hero-hw" }));
    body.append(left);
    if (right.childNodes.length) body.append(right);
    hero.append(body);
    if (x) {
      hero.classList.add("is-link");
      hero.tabIndex = 0;
      hero.setAttribute("role", "button");
      hero.setAttribute("aria-label", "查看下一节课详情");
      const open = () => reviewScreen(content, x.id, () => go("home"));
      hero.addEventListener("click", open);
      hero.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), open()));
    }
    return hero;
  }
  function stat(label, ic, num, foot, tone = "") {
    const s = n("div", null, { class: "fq-st-stat" });
    const h = n("div", null, { class: "fq-st-sh" });
    const i = n("span", null, { class: "fq-st-ic" });
    i.append(icon(ICONS[ic]));
    h.append(n("span", label), i);
    s.append(h, n("div", String(num), { class: "fq-st-num" + (tone ? " is-" + tone : "") }), n("div", foot, { class: "fq-st-ft" }));
    return s;
  }
  function packageFoot(pkgs) {
    if (!pkgs.length) return "暂无在用的课时包";
    if (pkgs.length === 1) {
      const p = pkgs[0];
      return p.course_name + " " + p.units_total + " 课时包 · 已上 " + round(p.units_total - p.balance);
    }
    return pkgs.length + " 个课时包 · 共 " + round(pkgs.reduce((s, p) => s + Number(p.units_total || 0), 0)) + " 课时";
  }
  function upcomingPanel(d) {
    const p = panel("接下来的课", null, canSchedule() ? link("我的课表 →", () => go("schedule")) : null);
    p.setAttribute("aria-label", "接下来的课");
    for (const r of d.upcoming) {
      const row = n("button", null, { type: "button", class: "fq-st-row" });
      const dt = n("span", null, { class: "fq-st-dt" });
      dt.append(n("b", String(Number(day(r.start_at).slice(8)))), n("span", wd(r.start_at)));
      const info = n("span", null, { class: "fq-st-rowtext" });
      info.append(n("b", r.course_name), n("small", F.time(r.start_at) + " · " + place(r) + " · " + teacherName(r.teacher_name)));
      row.append(dt, info);
      const cnt = r.participants_summary?.count || 0;
      if (r.participants_summary?.class_name || cnt > 1) row.append(pill("班课", "info"));
      row.addEventListener("click", () => reviewScreen(content, r.id, () => go("home")));
      p.append(row);
    }
    if (!d.upcoming.length) p.append(emptyLine("未来 30 天还没有排课。"));
    return p;
  }
  function packagesPanel(pkgs, title = "我的课时包") {
    const p = panel(title);
    p.setAttribute("aria-label", "课时包");
    const list = n("div", null, { class: "fq-st-pkgs" });
    for (const x of pkgs) {
      const item = n("div", null, { class: "fq-st-pkg" });
      const top = n("div", null, { class: "fq-st-pkg-top" });
      top.append(n("b", x.course_name || "课时包"), n("span", "剩 " + round(x.balance) + " / " + round(x.units_total)));
      item.append(top, bar(x.balance, x.units_total), n("small", x.valid_to ? "有效期至 " + x.valid_to : "不限有效期"));
      if (Number(x.balance) <= 0) item.append(n("small", "课时已用完，请联系教务老师续费。", { class: "fq-st-warn" }));
      list.append(item);
    }
    if (!pkgs.length) list.append(emptyLine("目前没有在用的课时包。"));
    p.append(list);
    return p;
  }
  async function deskHome(c) {
    const d = await homeData();
    c.replaceChildren();
    c.append(heroCard(d));
    const stats = n("section", null, { class: "fq-st-stats", "aria-label": "我的概况" });
    if (d.packages) stats.append(stat("剩余课时", "clock", d.balance, packageFoot(d.packages), "violet"));
    if (canSchedule()) stats.append(stat("本月已上", "check", d.attended, "节课 · 请假 " + d.leave + " 次"));
    if (d.total !== null) stats.append(stat("老师点评", "comments", d.total, "本月新增 " + d.monthNotes + " 条"));
    stats.classList.add("is-" + stats.childElementCount);
    if (stats.childElementCount) c.append(stats);
    const cols = n("div", null, { class: "fq-st-cols" });
    const mainCol = n("div", null, { class: "fq-st-cm" });
    const sideCol = n("div", null, { class: "fq-st-cs" });
    if (d.total !== null) {
      const p = panel("最近的老师点评", "每节课后老师写给你的反馈", link("全部点评", () => go("comments"), "fq-st-btn"));
      p.setAttribute("aria-label", "最近点评");
      for (const note of d.notes.slice(0, 3)) p.append(noteCard(note));
      if (!d.notes.length) p.append(emptyLine("还没有老师点评，上完课后老师写的反馈会出现在这里。"));
      mainCol.append(p);
    }
    if (canSchedule()) sideCol.append(upcomingPanel(d));
    if (d.packages) sideCol.append(packagesPanel(d.packages));
    if (mainCol.childElementCount) cols.append(mainCol);
    if (sideCol.childElementCount) cols.append(sideCol);
    c.append(cols);
  }

  // ---------- 手机版首页 ----------
  async function phoneHome(c) {
    const d = await homeData();
    c.replaceChildren();
    const x = d.next;
    if (canSchedule()) {
      const card = n("section", null, { class: "fq-st-card fq-st-next" });
      const top = n("div", null, { class: "fq-st-card-top" });
      top.append(n("span", "Next lesson", { class: "fq-st-eb" }), x ? n("b", relText(x.start_at), { class: "fq-st-rel" }) : n("span"));
      card.append(top);
      const row = n("div", null, { class: "fq-st-next-row" });
      if (x) {
        const box = n("span", null, { class: "fq-st-datebox" });
        box.append(n("b", String(Number(day(x.start_at).slice(8)))), n("small", wd(x.start_at)));
        const info = n("span", null, { class: "fq-st-rowtext" });
        info.append(n("b", x.course_name), n("small", F.range(x.start_at, x.duration || 60) + " · " + teacherName(x.teacher_name) + " · " + place(x)));
        row.append(box, info);
        card.classList.add("is-link");
        card.addEventListener("click", () => reviewScreen(c, x.id, () => go("home")));
      } else row.append(n("span", "暂未安排下一节课，有疑问请联系教务老师。", { class: "fq-st-muted" }));
      card.append(row);
      c.append(card);
    }
    if (d.packages) {
      const card = n("section", null, { class: "fq-st-card" });
      const top = n("div", null, { class: "fq-st-card-top" });
      top.append(n("b", "剩余课时"), link("明细", () => go("credits")));
      card.append(top);
      for (const p of d.packages) {
        const item = n("div", null, { class: "fq-st-pkg" });
        const line = n("div", null, { class: "fq-st-pkg-top" });
        const num = n("span");
        num.append(n("b", String(round(p.balance)), { class: "fq-st-serif" }), " / " + round(p.units_total));
        line.append(n("span", p.course_name || "课时包"), num);
        item.append(line, bar(p.balance, p.units_total));
        card.append(item);
      }
      if (!d.packages.length) card.append(emptyLine("目前没有在用的课时包。"));
      c.append(card);
    }
    if (d.total !== null) {
      const card = n("section", null, { class: "fq-st-card" });
      const top = n("div", null, { class: "fq-st-card-top" });
      const note = d.notes[0];
      top.append(n("b", "最新点评"), note ? n("span", slash(day(note.date)) + " · " + teacherName(note.teacher), { class: "fq-st-muted" }) : n("span"));
      card.append(top);
      if (note) {
        card.append(n("p", note.main || note.extra[0]?.[1] || "", { class: "fq-st-quote preserve-text" }));
        card.append(link("全部 " + d.total + " 条 →", () => go("comments")));
      } else card.append(emptyLine("还没有老师点评。"));
      c.append(card);
    }
    c.append(n("p", "请假请联系教务老师", { class: "fq-st-phint" }));
  }

  // ---------- 老师点评 ----------
  async function commentsPage(c) {
    const items = [];
    let next = 0,
      total = 0;
    const list = n("div", null, { class: "fq-st-cmts" });
    const more = n("div", null, { class: "fq-st-more" });
    const p = panel("全部点评", null);
    const load = async () => {
      // 第一页：点评与本月、上月课表同时取（点评要用课表补课程名、老师、出勤），省掉一轮等待。
      const today = todayBJ();
      const seedMonths =
        next === 0 && canSchedule()
          ? [today.slice(0, 7), dateShift(today.slice(0, 7) + "-01", -1).slice(0, 7)].map((m) => scheduleRows(...monthBounds(m)).catch(() => []))
          : [];
      const [page, ...seeds] = await Promise.all([api("student/comments?offset=" + next + "&limit=20"), ...seedMonths]);
      total = page.total ?? total;
      next = page.next_offset;
      items.push(...page.items);
      const map = await lessonMap(page.items, seeds.flat());
      for (const x of page.items) list.append(noteCard(noteOf(x, map), { full: true }));
      p.querySelector(".fq-st-ph p")?.remove();
      p.querySelector(".fq-st-ph div").append(n("p", "共 " + total + " 条 · 每节课后老师写给你的反馈"));
      more.replaceChildren();
      if (next !== null && next !== undefined)
        more.append(
          button("加载更多", async () => {
            for (const b of more.querySelectorAll("button")) b.disabled = true;
            try {
              await load();
            } catch (e) {
              notice(e.message);
              for (const b of more.querySelectorAll("button")) b.disabled = false;
            }
          }),
        );
    };
    await load();
    c.replaceChildren();
    if (!items.length) list.append(emptyLine("还没有老师点评，上完课后老师写的反馈会出现在这里。"));
    p.append(list, more);
    c.append(p);
  }

  // ---------- 课时与缴费 ----------
  const TX = { purchase: "购买", consume: "上课", reversal: "回补", adjustment: "调整", transfer_in: "转入", transfer_out: "转出" };
  async function creditsPage(c) {
    const [pkgs, tx, pays] = await Promise.all([
      canBalance() ? soft("credits/packages") : null,
      canBalance() ? soft("credits/transactions") : null,
      canPay() ? soft("credits/payments") : null,
    ]);
    c.replaceChildren();
    const grid = n("div", null, { class: "fq-st-cols" });
    const mainCol = n("div", null, { class: "fq-st-cm" });
    const sideCol = n("div", null, { class: "fq-st-cs" });
    if (pkgs) {
      const live = pkgs.items.filter((p) => p.status === "active" || Number(p.balance) > 0);
      mainCol.append(packagesPanel(live, "课时包余额"));
      if (Number(pkgs.debt_units) > 0) mainCol.append(n("p", "有 " + round(pkgs.debt_units) + " 课时待补扣，请联系教务老师续费。", { class: "fq-st-note is-warn" }));
    }
    if (tx) {
      const p = panel("课时变动", "最近的购买、上课扣课与调整");
      for (const t of tx.items.slice(0, 20)) {
        const line = n("div", null, { class: "fq-st-line" });
        line.append(n("span", slash(day(t.date)) + " " + (t.note || TX[t.type] || "变动")), n("b", (t.delta > 0 ? "+" : "") + round(t.delta), { class: t.delta < 0 ? "is-minus" : "is-plus" }));
        p.append(line);
      }
      if (!tx.items.length) p.append(emptyLine("暂无课时变动。"));
      mainCol.append(p);
    }
    if (pays) {
      const p = panel("缴费记录");
      for (const r of [...pays.items].sort((a, b) => String(b.paid_at).localeCompare(String(a.paid_at)))) {
        const line = n("div", null, { class: "fq-st-line" });
        const l = n("span");
        l.append(r.paid_at, n("small", " " + (r.method || "已登记") + (r.note ? " · " + r.note : "")));
        line.append(l, n("b", F.money(r.amount)));
        p.append(line);
      }
      if (!pays.items.length) p.append(emptyLine("还没有缴费记录。"));
      sideCol.append(p);
    }
    if (mainCol.childElementCount) grid.append(mainCol);
    if (sideCol.childElementCount) grid.append(sideCol);
    if (grid.childElementCount) c.append(grid);
    else c.append(UI.empty({ text: "机构暂未开放此页内容，请联系教务老师。" }));
  }

  // ---------- 我的 ----------
  function myPage(c) {
    c.replaceChildren();
    const card = n("section", null, { class: "fq-st-card fq-st-mecard" });
    const t = n("div");
    t.append(n("b", me.user.name), n("span", "学员 · 枫琴教务中心", { class: "fq-st-muted" }));
    card.append(avatar("is-big"), t);
    const menu = n("div", null, { class: "fq-st-card fq-st-menu" });
    const items = [
      isPhone() && VIEWS.credits.on() ? ["课时与缴费", () => go("credits")] : null,
      ["修改密码", changePw],
      ["登录设备", () => devices()],
      ["退出登录", logOut, true],
    ].filter(Boolean);
    for (const [label, fn, danger] of items) {
      const b = n("button", null, { type: "button", class: "fq-st-menu-item" + (danger ? " is-danger" : "") });
      b.append(n("span", label), n("span", "›", { class: "fq-st-muted", "aria-hidden": "true" }));
      b.addEventListener("click", fn);
      menu.append(b);
    }
    c.append(card, menu, n("p", "学员账号只能查看。请假、调课、续费请联系教务老师。", { class: "fq-st-note" }));
  }

  globalThis.ChannelFqStudent = { render, go, homeData };
})();
