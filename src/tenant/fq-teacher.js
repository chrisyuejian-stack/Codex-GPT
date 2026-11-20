// 枫琴教务中心 · 老师端（设计稿 05：今天、点名与课后点评同屏）。
// 加载在 fq-student.js 之后：重新赋值 `personalShell`，老师账号进入新界面，其他账号调用之前的函数（学员端由 fq-student.js 处理）。
// 只换外壳和“今天”页：课表、我的学员、课后反馈、课酬、改密码、登录设备都直接调用原来的函数。
// 点名与点评不另写提交：把原来的课程详情（reviewScreen，经 c3.js、v2m.js 改造的点名表单）嵌进待点名卡片，
// 写入仍走原表单的 lessons/:id/review 与它的校验；教师不能自助提交时显示原有提示。
(() => {
  "use strict";
  const original = personalShell;
  const n = el,
    F = UI.fmt,
    M = () => globalThis.ChannelV2Mobile,
    C3 = () => globalThis.ChannelC3;
  const SVG = "http://www.w3.org/2000/svg";
  const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const isTeacher = () => !!me?.user?.roles?.includes("teacher");
  const settings = () => me.policy?.settings || {};
  const canFeedback = () => typeof yxFeedbackPage === "function" && me.policy?.modules?.feedback !== false;
  const selfCheckin = () => settings().teacher_self_checkin === true && enabled("attendance", "submit");
  const phone = globalThis.matchMedia?.("(max-width: 760px)");
  const isPhone = () => !!phone?.matches;

  // ---------- 小工具 ----------
  const day = (iso) => String(iso).slice(0, 10);
  const wd = (d) => WEEK[new Date(day(d) + "T12:00:00Z").getUTCDay()];
  const md = (d) => Number(d.slice(5, 7)) + " 月 " + Number(d.slice(8, 10)) + " 日";
  const startMs = (r) => Date.parse(r.start_at);
  const endMs = (r) => startMs(r) + Number(r.duration || 0) * 60000;
  const range = (r) => F.time(r.start_at) + "–" + F.time(endMs(r));
  const place = (r) => (r.mode === "online" ? "线上课" : r.location_name || "待定地点");
  const who = (r) => r.participants_summary?.class_name || (r.participants_summary?.names || []).join("、");
  const hourOf = (r) => Number(F.time(r.start_at).slice(0, 2));
  const partOfDay = (h) => (h < 12 ? "上午" : h < 13 ? "中午" : h < 18 ? "下午" : "晚上");
  // 李嘉文 → 李老师；非中文姓名直接加“老师”。
  const callName = () => {
    const name = String(me.user.name || "").trim();
    if (/老师$/.test(name)) return name;
    return /^[一-龥]{2,4}$/.test(name) ? name[0] + "老师" : (name || "") + "老师";
  };
  const initial = () => Array.from(String(me.user.name || "师").trim())[0] || "师";
  const enDate = (long = false) =>
    new Date().toLocaleDateString("en-GB", { timeZone: "Asia/Shanghai", weekday: long ? "long" : "short", day: "numeric", month: "short" }).replace(/^(\w+)/, "$1,").replace(",,", ",");
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
    today: [["path", { d: "M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" }]],
    schedule: [["rect", { x: "3", y: "4", width: "18", height: "17", rx: "2" }], ["path", { d: "M3 9h18M8 2v4M16 2v4" }]],
    students: [["circle", { cx: "9", cy: "8", r: "3.5" }], ["path", { d: "M2.5 20c1-3.5 3.5-5.5 6.5-5.5s5.5 2 6.5 5.5M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5c2 .8 3.2 2.6 3.7 5.5" }]],
    feedback: [["path", { d: "M4 5h16v11H9l-5 4z" }], ["path", { d: "M8 9h8M8 12h5" }]],
    pay: [["rect", { x: "2", y: "5", width: "20", height: "14", rx: "2" }], ["path", { d: "M2 10h20M6 15h4" }]],
    my: [["circle", { cx: "12", cy: "8", r: "4" }], ["path", { d: "M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" }]],
  };
  const logo = () => n("span", null, { class: "fq-logo", role: "img", "aria-label": "fantasme 枫琴国际艺术" });
  const avatar = (cls = "") => n("span", initial(), { class: "fq-tc-av" + (cls ? " " + cls : ""), "aria-hidden": "true" });
  const link = (text, fn, cls = "fq-tc-link") => {
    const b = n("button", text, { type: "button", class: cls });
    b.addEventListener("click", fn);
    return b;
  };
  const logOut = async () => {
    await api("logout", "POST", {});
    location.assign(base + "login");
  };
  const changePw = () => changePassword(UI.drawer({ title: "修改密码" }).body);

  // ---------- 外壳 ----------
  let view = "today",
    frame = null,
    content = null,
    run = 0;
  const VIEWS = {
    today: { label: "今天", en: "Today", fn: (c, g) => todayPage(c, g), on: () => true },
    schedule: { label: "课表", en: "My timetable", fn: (c) => M().teacherWeek(c), on: () => enabled("schedule") },
    students: { label: "我的学员", en: "My students", fn: (c) => C3().teacherStudents(c), on: () => enabled("students") },
    feedback: { label: "课后反馈", en: "Lesson feedback", fn: (c) => yxFeedbackPage(c), on: canFeedback },
    pay: { label: "课酬", en: "My pay", fn: (c) => M().teacherPay(c), on: () => enabled("teacher_pay") },
    my: { label: "我的", en: "My account", fn: (c) => myPage(c), on: () => true },
  };
  const DESK_NAV = ["today", "schedule", "students", "feedback", "pay"];
  const PHONE_NAV = ["today", "schedule", "students", "my"];

  // 今天页标题里的课数在数据到手后再填。
  const todayTitle = () => {
    const h = n("h1", null);
    h.append(callName() + "，", n("span", "今天的课", { class: "fq-tc-count" }));
    return h;
  };
  function deskHeader(key) {
    const top = n("header", null, { class: "fq-tc-top" });
    const t = n("div");
    if (key === "today") {
      const today = todayBJ();
      t.append(n("p", "Today · " + enDate(true), { class: "fq-tc-eb" }), todayTitle(), n("p", md(today) + " " + wd(today) + " · 下课后 48 小时内提交点名与点评", { class: "fq-tc-sub" }));
    } else t.append(n("p", VIEWS[key].en, { class: "fq-tc-eb" }), n("h1", VIEWS[key].label));
    top.append(t);
    if (key !== "today" && VIEWS.today.on()) top.append(link("回到今天", () => go("today"), "fq-tc-btn"));
    return top;
  }
  function phoneHeader(key) {
    const top = n("header", null, { class: "fq-tc-phead" + (key === "today" ? " is-today" : "") });
    const row = n("div", null, { class: "fq-tc-prow" });
    if (key === "today") row.append(logo(), n("span", "Today · " + enDate(), { class: "fq-tc-eb" }));
    else {
      const meBtn = n("button", null, { type: "button", class: "fq-tc-avbtn", "aria-label": "我的" });
      meBtn.append(avatar());
      meBtn.addEventListener("click", () => go("my"));
      row.append(logo(), meBtn);
    }
    top.append(row);
    if (key === "today") top.append(todayTitle(), n("i", null, { class: "fq-tc-rule", "aria-hidden": "true" }));
    else top.append(n("p", VIEWS[key].en, { class: "fq-tc-eb" }), n("h1", VIEWS[key].label));
    return top;
  }
  function navItem(key) {
    const b = n("button", null, { type: "button", class: "fq-tc-item", "data-key": key });
    b.append(icon(ICONS[key]), n("span", VIEWS[key].label));
    b.addEventListener("click", () => go(key));
    return b;
  }
  function sideBar() {
    const side = n("aside", null, { class: "fq-tc-side", "aria-label": "老师菜单" });
    const brandBox = n("div", null, { class: "fq-tc-brand" });
    const copy = n("span");
    copy.append(n("b", "枫琴教务中心"), n("i", "Teacher Portal"));
    brandBox.append(logo(), copy);
    const nav = n("nav", null, { class: "fq-tc-nav", "aria-label": "老师导航" });
    nav.append(n("p", "MY TEACHING", { class: "fq-tc-nl" }));
    for (const key of DESK_NAV.filter((k) => VIEWS[k].on())) nav.append(navItem(key));
    const acc = n("nav", null, { class: "fq-tc-nav", "aria-label": "账号" });
    acc.append(n("p", "ACCOUNT", { class: "fq-tc-nl" }), navItem("my"));
    const who_ = n("div", null, { class: "fq-tc-me" });
    const name = n("span", null, { class: "fq-tc-mename" });
    name.append(n("b", me.user.name), n("small", "老师"));
    const card = n("div", null, { class: "fq-tc-mecard" });
    card.append(avatar(), name);
    who_.append(card, link("退出", logOut, "fq-tc-out"));
    side.append(brandBox, nav, acc, who_);
    return side;
  }
  function tabBar() {
    const nav = n("nav", null, { class: "fq-tc-tabs", "aria-label": "底部导航" });
    for (const key of PHONE_NAV.filter((k) => VIEWS[k].on())) {
      const b = n("button", null, { type: "button", class: "fq-tc-tab", "data-key": key });
      b.append(n("i", null, { "aria-hidden": "true" }), n("span", VIEWS[key].label));
      b.addEventListener("click", () => go(key));
      nav.append(b);
    }
    return nav;
  }
  function render() {
    root.replaceChildren();
    document.title = "枫琴教务中心 · 老师";
    const p = isPhone();
    // v-personal：原来的课程详情 / 点名表单（v2m.js）按个人页排版。
    frame = n("div", null, { class: "fq-teacher v-personal " + (p ? "is-phone" : "is-desk") });
    content = n("section", null, { class: "personal-content fq-tc-body", "aria-busy": "false" });
    if (p) frame.append(n("div", null, { class: "fq-tc-head-slot" }), content, tabBar());
    else {
      const main = n("main", null, { class: "fq-tc-main" });
      main.append(n("div", null, { class: "fq-tc-head-slot" }), content);
      frame.append(sideBar(), main);
    }
    root.append(frame);
    if (!VIEWS[view]?.on()) view = "today";
    void go(view);
  }
  async function go(key) {
    view = key;
    personalTab = key;
    const v = VIEWS[key];
    // 手机底栏没有“课后反馈”“课酬”，从“我的”进入时仍高亮“我的”。
    const navKey = isPhone() && !PHONE_NAV.includes(key) ? "my" : key;
    for (const b of frame.querySelectorAll("[data-key]")) b.setAttribute("aria-current", b.dataset.key === navKey ? "page" : "false");
    frame.dataset.view = key;
    frame.querySelector(".fq-tc-head-slot").replaceChildren(isPhone() ? phoneHeader(key) : deskHeader(key));
    // 课后反馈页会给内容区加自己的类名，切页时还原。
    content.className = "personal-content fq-tc-body";
    content.dataset.personalTab = key;
    content.setAttribute("aria-busy", "true");
    content.replaceChildren(UI.tableSkeleton());
    const g = ++run;
    try {
      await v.fn(content, g);
      if (g === run) globalThis.scrollTo?.(0, 0);
    } catch (e) {
      if (g === run) content.replaceChildren(UI.empty({ text: e.message, action: { label: "重试", onSelect: () => go(key) } }));
      notice(e.message);
    } finally {
      if (g === run) content.setAttribute("aria-busy", "false");
    }
  }
  phone?.addEventListener?.("change", () => {
    if (isTeacher() && frame && root.contains(frame)) render();
  });

  personalShell = () => {
    // 初始密码未改：沿用原来的强制改密流程。
    if (!isTeacher() || me.user.must_change) return original();
    render();
  };

  // ---------- 今天 ----------
  // 每节课的状态：todo（下课了、我主讲、还没提交）展开点名；done 折叠成一行；其他简洁一行。
  function stateOf(r, now) {
    const mine = !r.source_course_id && r.teacher_id === me.user.teacher_id;
    if (r.status === "cancelled") return "cancelled";
    if (r.status === "completed") return "done";
    if (r.review_status === "pending") return "sent";
    if (r.status !== "planned") return "other";
    if (endMs(r) <= now) return mine ? "todo" : "late";
    if (startMs(r) <= now) return "now";
    return "later";
  }
  function relText(r, now) {
    const mins = Math.round((startMs(r) - now) / 60000);
    if (mins <= 0) return "上课中";
    if (mins < 60) return mins + " 分钟后";
    if (mins < 180) return Math.floor(mins / 60) + " 小时" + (mins % 60 >= 10 ? " " + (mins % 60) + " 分" : "") + "后";
    return partOfDay(hourOf(r));
  }
  const openLesson = (r) => (r.source_course_id ? personalPartner(content, r, () => go("today")) : reviewScreen(content, r.id, () => go("today")));
  function lessonRow(r, state, now) {
    const b = n("button", null, { type: "button", class: "fq-tc-row is-" + state });
    const text = n("span", null, { class: "fq-tc-rowtext" });
    const names = who(r);
    text.append(
      n("b", range(r), { class: "fq-tc-time" }),
      n("strong", r.course_name + (names ? " · " + names : "")),
      n("small", place(r) + (r.participants_summary?.count > 1 ? " · " + r.participants_summary.count + " 人" : "")),
    );
    const right =
      state === "now"
        ? n("span", "上课中 · 点名 ›", { class: "fq-tc-rel is-now" })
        : state === "late"
          ? n("span", "待主讲点名", { class: "fq-tc-rel" })
          : state === "cancelled"
            ? n("span", "已取消", { class: "fq-tc-rel" })
            : n("span", relText(r, now), { class: "fq-tc-rel" });
    b.append(text, right);
    b.addEventListener("click", () => openLesson(r));
    return b;
  }
  function doneLine(r, state) {
    const b = n("button", null, { type: "button", class: "fq-tc-done" });
    const names = who(r) || r.course_name;
    b.append(
      n("span", partOfDay(hourOf(r)) + " " + F.time(r.start_at) + " " + names + " · " + (state === "sent" ? "已点名，待教务确认" : "已点名")),
      n("b", "✓", { "aria-hidden": "true" }),
    );
    b.addEventListener("click", () => openLesson(r));
    return b;
  }
  // 待点名卡片：卡片头是课程信息，下面嵌入原来的点名表单（只显示表单或原有提示）。
  function todoCard(r) {
    const card = n("article", null, { class: "fq-tc-todo", "aria-label": range(r) + " " + r.course_name + " 待点名" });
    const top = n("div", null, { class: "fq-tc-todo-top" });
    top.append(n("b", range(r), { class: "fq-tc-time" }), n("span", r.review_status === "returned" ? "已退回，请重新提交" : "还没点名", { class: "fq-tc-flag" }));
    const info = n("div", null, { class: "fq-tc-todo-info" });
    const names = who(r);
    info.append(n("strong", r.course_name + (names ? " · " + names : "")), n("small", place(r) + (r.participants_summary?.count > 1 ? " · " + r.participants_summary.count + " 人" : "")));
    const host = n("div", null, { class: "fq-tc-embed" });
    host.append(n("p", "正在载入点名…", { class: "fq-tc-muted fq-tc-keep" }));
    card.append(top, info, host);
    return { card, host };
  }
  const RELABEL = { attended: "到了", student_leave: "请假", no_show: "缺课" };
  async function embedReview(r, host, g) {
    const back = () => go("today");
    try {
      await reviewScreen(host, r.id, back);
    } catch (e) {
      if (g !== run) return;
      host.replaceChildren(n("p", e.message, { class: "fq-tc-muted fq-tc-keep" }), link("打开课程详情", () => openLesson(r), "fq-tc-btn fq-tc-keep"));
      return;
    }
    if (g !== run || !host.isConnected) return;
    const form = host.querySelector("form.v-m-checkin") || host.querySelector("form");
    if (form) {
      const rows = form.querySelectorAll(".c3-checkin-row");
      if (rows.length <= 1) form.classList.add("is-single");
      for (const x of form.querySelectorAll(".c2-attendance-buttons button")) {
        const face = x.querySelector(".ui-button-face span") || x;
        if (RELABEL[x.dataset.attendance]) face.textContent = RELABEL[x.dataset.attendance];
      }
      const pub = form.elements.public_text?.closest("label")?.querySelector("span");
      if (pub) pub.textContent = "课后点评（选填，该课学员可见）";
      const hw = form.elements.homework?.closest("label")?.querySelector("span");
      if (hw) hw.textContent = "作业（选填）";
      if (form.elements.homework) form.elements.homework.rows = 2;
      if (form.elements.public_text) form.elements.public_text.rows = 3;
      const face = form.querySelector("button[type=submit] .ui-button-face span:last-child");
      if (face) face.textContent = "提交点名与点评";
    } else if (!host.querySelector(".impact-note")) {
      host.append(n("p", "这节课暂时不能在这里点名，请联系教务。", { class: "impact-note" }));
    }
    // 原表单提交成功后会用新数据重画课程详情；看到重画就回到今天页，卡片随之变为已点名。
    const snap = host.__reviewSnapshot;
    const watch = new MutationObserver(() => {
      if (host.__reviewSnapshot === snap) return;
      watch.disconnect();
      const st = host.__reviewSnapshot?.submission?.status;
      if (st === "pending") notice("已提交，等待教务确认", "success");
      if (g === run) setTimeout(() => go("today"), 0);
    });
    watch.observe(host, { childList: true });
  }
  async function todayPage(c, g) {
    const today = todayBJ();
    if (!enabled("schedule")) {
      c.replaceChildren(UI.empty({ text: "机构暂未开放课表。" }));
      return;
    }
    // 前两天下课还没点名的课（仍可能在 48 小时提交窗口内）只提示数量，点进课表处理。
    const [all, before] = await Promise.all([scheduleRows(today, dateShift(today, 1)), scheduleRows(dateShift(today, -2), today).catch(() => [])]);
    if (g !== run) return;
    const rows = all.filter((x) => day(x.start_at) === today).sort((a, b) => a.start_at.localeCompare(b.start_at));
    const now = Date.now();
    const missed = before.filter((r) => day(r.start_at) < today && stateOf(r, now) === "todo").sort((a, b) => b.start_at.localeCompare(a.start_at));
    const count = rows.filter((r) => r.status !== "cancelled").length;
    for (const x of frame.querySelectorAll(".fq-tc-count")) x.textContent = count ? "今天 " + count + " 节课" : "今天没有课";
    const groups = { todo: [], list: [], done: [] };
    for (const r of rows) {
      const st = stateOf(r, now);
      if (st === "todo") groups.todo.push(r);
      else if (st === "done" || st === "sent") groups.done.push([r, st]);
      else groups.list.push([r, st]);
    }
    c.replaceChildren();
    const cols = n("div", null, { class: "fq-tc-cols" });
    const line = n("section", null, { class: "fq-tc-line", "aria-label": "今天的课" });
    const embeds = [];
    // 按时间排：待点名卡片与其他课一起按开始时间排序；已点名的收在最后。
    const ordered = [...groups.todo.map((r) => [r, "todo"]), ...groups.list].sort((a, b) => a[0].start_at.localeCompare(b[0].start_at));
    for (const [r, st] of ordered) {
      if (st === "todo") {
        const { card, host } = todoCard(r);
        line.append(card);
        embeds.push([r, host]);
      } else line.append(lessonRow(r, st, now));
    }
    if (groups.done.length) {
      const box = n("div", null, { class: "fq-tc-donelist" });
      for (const [r, st] of groups.done) box.append(doneLine(r, st));
      line.append(box);
    }
    if (!rows.length) line.append(UI.empty({ text: "今天没有你的课。", action: VIEWS.schedule.on() ? { label: "看本周课表", onSelect: () => go("schedule") } : undefined }));
    if (missed.length && VIEWS.schedule.on()) {
      const b = n("button", null, { type: "button", class: "fq-tc-missed" });
      b.append(n("span", (day(missed[0].start_at) === dateShift(today, -1) ? "昨天" : "前两天") + "还有 " + missed.length + " 节课没点名"), n("b", "去课表 ›"));
      b.addEventListener("click", () => {
        personalDate = day(missed[0].start_at);
        void go("schedule");
      });
      line.prepend(b);
    }
    if (!selfCheckin() && !groups.todo.length && missed.length) line.prepend(n("p", "机构未开启老师自助点名，下课后的点名请联系教务处理。", { class: "fq-tc-note is-warn" }));
    cols.append(line);
    if (!isPhone()) cols.append(sidePanel(rows, groups));
    c.append(cols);
    await Promise.all(embeds.map(([r, host]) => embedReview(r, host, g)));
  }
  function sidePanel(rows, groups) {
    const side = n("aside", null, { class: "fq-tc-aside", "aria-label": "今天概览" });
    const p = n("section", null, { class: "fq-tc-panel" });
    p.append(n("h2", "今天概览"));
    const stats = n("div", null, { class: "fq-tc-stats" });
    const lessons = rows.filter((r) => r.status !== "cancelled");
    for (const [label, num, tone] of [
      ["节课", lessons.length, ""],
      ["待点名", groups.todo.length, groups.todo.length ? "red" : ""],
      ["已点名", groups.done.length, ""],
    ]) {
      const s = n("div", null, { class: "fq-tc-stat" });
      s.append(n("b", String(num), { class: tone ? "is-" + tone : "" }), n("span", label));
      stats.append(s);
    }
    p.append(stats);
    const next = rows.find((r) => r.status === "planned" && startMs(r) > Date.now());
    if (next) p.append(n("p", "下一节 " + F.time(next.start_at) + " · " + next.course_name + (who(next) ? " · " + who(next) : ""), { class: "fq-tc-muted" }));
    side.append(p);
    const q = n("section", null, { class: "fq-tc-panel" });
    q.append(n("h2", "点名须知"));
    q.append(
      n("p", "下课后 48 小时内由主讲老师提交出勤与点评；提交后由教务确认，确认后才扣课时、计课酬，点评向学员公开。", { class: "fq-tc-muted" }),
      n("p", selfCheckin() ? "已提交的课在这里显示 ✓，教务退回时会重新展开。" : "机构未开启老师自助点名，点名请联系教务。", { class: "fq-tc-muted" }),
    );
    const links = n("div", null, { class: "fq-tc-links" });
    if (VIEWS.schedule.on()) links.append(link("本周课表 →", () => go("schedule")));
    if (VIEWS.feedback.on()) links.append(link("课后反馈 →", () => go("feedback")));
    q.append(links);
    side.append(q);
    return side;
  }

  // ---------- 我的 ----------
  function myPage(c) {
    c.replaceChildren();
    const card = n("section", null, { class: "fq-tc-card fq-tc-mebox" });
    const t = n("div");
    t.append(n("b", me.user.name + (/老师$/.test(me.user.name) ? "" : " 老师")), n("span", "老师 · " + (brand?.display_name || "枫琴教务中心"), { class: "fq-tc-muted" }));
    card.append(avatar("is-big"), t);
    const menu = n("div", null, { class: "fq-tc-card fq-tc-menu" });
    const items = [
      isPhone() && VIEWS.feedback.on() ? ["课后反馈", () => go("feedback")] : null,
      isPhone() && VIEWS.pay.on() ? ["我的课酬", () => go("pay")] : null,
      ["修改密码", changePw],
      ["登录设备", () => devices()],
      ["退出登录", logOut, true],
    ].filter(Boolean);
    for (const [label, fn, danger] of items) {
      const b = n("button", null, { type: "button", class: "fq-tc-menu-item" + (danger ? " is-danger" : "") });
      b.append(n("span", label), n("span", "›", { class: "fq-tc-muted", "aria-hidden": "true" }));
      b.addEventListener("click", fn);
      menu.append(b);
    }
    c.append(card, menu, n("p", "调课、代课、请假请联系教务。", { class: "fq-tc-note" }));
  }

  globalThis.ChannelFqTeacher = { render, go };
})();
