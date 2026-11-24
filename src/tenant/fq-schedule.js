// 枫琴教务中心 · 课表（第三期设计稿 design/redesign/schedule/）。
// 加载在 fq-teacher.js 之后：重新赋值 `schedulePage`（与 fq-teacher.js 重新赋值 personalShell 同一种覆盖方式），
// 员工端“周课表”页签与所有保存后回到课表的调用都进入新界面；“按学员 / 固定排课 / 班级”仍调用原来的函数。
// 周网格、列表、拖动改时间、键盘移动、点空白格排课、冲突预检、“＋N 节”弹层都由 calendar.js（ChannelCalendar.mount，
// embedded 模式）完成；本文件只画工具条、统计卡、老师标签、冲突提示条、日视图（时间线 + 占用条）和手机界面。
// 课程详情 / 点名（lessonDetail，内含 reviewScreen）、新建与编辑（lessonForm）、改时间（moveDialog）、导出课表图（staffTimetable）
// 都直接调用原函数，不另写业务写入与冲突校验。按教师 / 按教室表格视图已去掉（DECISIONS 5、6），建议空档不做（DECISIONS 7）。
(() => {
  "use strict";
  if (typeof schedulePage === "undefined" || !globalThis.ChannelCalendar) return;
  const n = el,
    F = UI.fmt,
    CAL = globalThis.ChannelCalendar;
  const SVG = "http://www.w3.org/2000/svg";
  const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const phoneMQ = globalThis.matchMedia?.("(max-width: 760px)");
  const isPhone = () => !!phoneMQ?.matches;
  // 不占用时间的状态（与 calendar.js knownConflicts 的 excluded 一致）与“请假 / 停课”斜纹。
  const IDLE = ["cancelled", "rescheduled", "teacher_leave"];
  const OFF = ["student_leave", "teacher_leave", "cancelled", "rescheduled"];
  // 页面状态跨重画保留（换页签再回来仍是上次的视图、颜色、筛选）。
  const S = { mode: "week", colorBy: "teacher", teacher: "", room: "", category: "", text: "", phone: "day", onlyLate: false, open: new Set() };

  // ---------- 小工具 ----------
  const cls = (...xs) => xs.filter(Boolean).join(" ");
  const pad = (x) => String(x).padStart(2, "0");
  const minOf = (iso) => Number(String(iso).slice(11, 13)) * 60 + Number(String(iso).slice(14, 16));
  const hm = (m) => pad(Math.floor(m / 60)) + ":" + pad(m % 60);
  const dayOf = (iso) => String(iso || "").slice(0, 10);
  const startMs = (r) => Date.parse(r.start_at);
  const endMs = (r) => startMs(r) + (Number(r.duration) || 0) * 60000;
  const span = (r) => hm(minOf(r.start_at)) + "–" + hm(minOf(r.start_at) + (Number(r.duration) || 0));
  const wd = (d) => WEEK[new Date(d + "T12:00:00Z").getUTCDay()];
  const md = (d) => Number(d.slice(5, 7)) + " 月 " + Number(d.slice(8, 10)) + " 日";
  const isoWeek = (d) => {
    const t = new Date(d + "T12:00:00Z");
    t.setUTCDate(t.getUTCDate() + 3 - ((t.getUTCDay() + 6) % 7));
    const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
    return 1 + Math.round(((t - y) / 86400000 - 3 + ((y.getUTCDay() + 6) % 7)) / 7);
  };
  const weekLabel = (mon) => {
    const sun = CAL.shift(mon, 6);
    return md(mon) + " – " + (sun.slice(5, 7) === mon.slice(5, 7) ? Number(sun.slice(8)) + " 日" : md(sun));
  };
  const who = (r) => {
    const p = r.participants_summary || { count: 0, names: [] };
    return p.count > 1 ? (p.class_name || r.course_name) + " · " + p.count + " 人" : p.names[0] || "暂无学员";
  };
  const title = (r) => {
    const p = r.participants_summary || { count: 0, names: [] };
    return r.course_name + " · " + (p.count > 1 ? (p.class_name ? p.class_name + " " : "班课 ") + p.count + " 人" : p.names[0] || "暂无学员");
  };
  const where = (r) => [r.teacher_name ? r.teacher_name + "老师" : "", r.mode === "online" ? "线上课" : r.location_name || ""].filter(Boolean).join(" · ");
  const label = (r) => me.labels?.lessons?.[r.status] || "";
  const stateOf = (r, now = Date.now()) =>
    r.status !== "planned" ? "done" : endMs(r) <= now ? "late" : startMs(r) <= now ? "now" : "next";
  const ago = (ms) => {
    const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
    return m < 60 ? m + " 分钟" : m < 1440 ? Math.floor(m / 60) + " 小时" : Math.floor(m / 1440) + " 天";
  };
  const pill = (text, tone) => n("span", text, { class: "fq-pill is-" + (tone || "muted") });
  function act(text, fn, kind = "", icon = "") {
    const b = n("button", null, { type: "button", class: cls("fq-sc-tbtn", kind && kind.split(" ").map((k) => "is-" + k).join(" ")) });
    if (icon) b.append(UI.icon(icon));
    b.append(text);
    b.addEventListener("click", async (e) => {
      if (b.disabled) return;
      b.disabled = true;
      try {
        await fn(e);
      } catch (err) {
        notice(err.message || String(err));
      } finally {
        b.disabled = false;
      }
    });
    return b;
  }
  const btn = (text, fn, kind = "") => {
    const b = act(text, fn, kind);
    b.className = cls("fq-btn", kind && kind.split(" ").map((k) => "is-" + k).join(" "));
    return b;
  };
  const link = (text, fn) => {
    const b = act(text, fn);
    b.className = "fq-link";
    return b;
  };
  function seg(items, value, onPick, extra = "") {
    const box = n("div", null, { class: cls("fq-sc-seg", extra), role: "group" });
    for (const [key, text] of items) {
      const b = n("button", text, { type: "button", "aria-pressed": String(key === value) });
      b.addEventListener("click", () => onPick(key));
      box.append(b);
    }
    return box;
  }
  const go = (hash) => {
    location.hash = hash;
  };

  // ---------- 着色：按老师 / 教室 / 课程，6 组颜色 t1–t6，本次会话内同一位老师颜色不变 ----------
  const maps = { teacher: new Map(), room: new Map(), course: new Map() };
  const keyOf = (r, by) =>
    by === "room" ? (r.mode === "online" ? "online" : r.location_id || "none") : by === "course" ? String(r.category_color || r.course_id || r.course_name) : r.teacher_id || "none";
  const tone = (r, by = S.colorBy) => {
    const m = maps[by],
      k = keyOf(r, by);
    if (!m.has(k)) m.set(k, (m.size % 6) + 1);
    return "t" + m.get(k);
  };

  // ---------- 冲突：逐对调用 calendar.js 的 knownConflicts（与拖动预检同一规则） ----------
  function conflicts(snap) {
    const live = snap.rows.filter((r) => !IDLE.includes(r.status) && !r.source_course_id);
    const out = [];
    for (let i = 0; i < live.length; i++) {
      const a = live[i];
      for (let j = i + 1; j < live.length; j++) {
        const b = live[j];
        if (dayOf(a.start_at) !== dayOf(b.start_at)) continue;
        const reasons = CAL.knownConflicts(a, a.start_at, [b], snap.details);
        if (reasons.length) out.push({ a, b, reasons });
      }
      const own = CAL.knownConflicts(a, a.start_at, [], snap.details, snap.blocks || []);
      if (own.length) out.push({ a, b: null, reasons: own });
    }
    return out.sort((x, y) => x.a.start_at.localeCompare(y.a.start_at));
  }
  const conflictIds = (list) => new Set(list.flatMap((x) => [x.a.id, x.b?.id].filter(Boolean)));
  const conflictText = (x) => {
    const one = (r) => r.course_name + " " + who(r) + "（" + (r.mode === "online" ? "线上" : r.location_name || "未定教室") + " " + span(r) + "）";
    return x.b ? x.reasons.join("、") + "：" + one(x.a) + " 与 " + one(x.b) + "。" : x.reasons.join("、") + "：" + one(x.a) + "。";
  };
  const conflictHead = (x) => dayOf(x.a.start_at).slice(5) + " " + wd(dayOf(x.a.start_at)) + " " + span(x.a) + (x.a.teacher_name ? " · " + x.a.teacher_name + "老师" : "");

  // ---------- 页面 ----------
  let page = null;
  async function schedule(c) {
    page?.stop?.();
    c.dataset.page = "schedule";
    if (typeof pageIdentity === "function") pageIdentity("周课表");
    if (!["week", "day", "list"].includes(S.mode)) S.mode = "week";
    const root = n("div", null, { class: "fq-today fq-sc" });
    const calHost = n("div", null, { class: "fq-sc-cal" });
    const desk = n("div", null, { class: "fq-sc-stack" });
    const phone = n("div", null, { class: "fq-sc-phone" });
    const weekCard = n("section", null, { class: "fq-card fq-sc-weekcard" });
    const weekTop = n("div");
    const weekFoot = n("p", null, { class: "fq-sc-foot" });
    weekCard.append(weekTop, calHost, weekFoot);
    const stats = n("section", null, { class: "fq-stats fq-sc-stats", "aria-label": "本周概况" });
    const dayBox = n("div", null, { class: "fq-today-cols fq-sc-daycols" });
    desk.append(stats, weekCard, dayBox);
    root.append(desk, phone);
    c.replaceChildren(root);
    const P = { c, root, calHost, desk, phone, weekCard, weekTop, weekFoot, stats, dayBox, snap: null, ctl: null, lists: null, alive: true };
    page = P;
    P.stop = () => {
      P.alive = false;
      phoneMQ?.removeEventListener?.("change", P.onMQ);
    };
    // 跨过 760px 时整页按另一种布局重画（不重新取数据）。
    P.onMQ = () => P.snap && paint(P);
    phoneMQ?.addEventListener?.("change", P.onMQ);
    // 筛选名单（教师、教室、大类）与课程同时请求；没有设置权限时从本周课程里取。
    P.lists = enabled("settings")
      ? Promise.all([choices("teachers"), choices("locations"), choices("course_categories")]).catch(() => null)
      : Promise.resolve(null);
    P.lists.then((x) => {
      P.names = x ? { teachers: x[0], rooms: x[1], cats: x[2] } : null;
      if (P.snap && P.alive) paint(P);
    });
    buildBar(P);
    const start = S.day || scheduleWeek;
    P.ready = CAL.mount({
      container: calHost,
      UI,
      api,
      choices,
      enabled,
      week: start,
      initialDate: start,
      view: S.mode === "list" ? "list" : "calendar",
      today: todayBJ(),
      onNavigate: (date) => {
        scheduleWeek = date;
        scheduleView = "calendar";
      },
      onOpen: (row) => lessonDetail(c, row),
      onCreate: (row) => lessonForm(c, row),
      onTemplates: () => templatesPage(c),
      onExport: () => staffTimetable(c),
      onError: notice,
      labels: me.labels.lessons,
      embedded: true,
      views: [
        ["calendar", "周"],
        ["list", "列表"],
      ],
      decorate: (b, row) => decorate(P, b, row),
      dayHead: (h, d, rows) => dayHead(h, d, rows),
      onRender: (snap) => {
        if (!P.alive || !root.isConnected) return;
        P.snap = snap;
        S.day = snap.date;
        paint(P);
      },
    });
    P.ctl = await P.ready;
    P.ctl.setFilter({ teacher: S.teacher, room: S.room, category: S.category, text: S.text });
  }
  const ctl = async (P) => P.ctl || (P.ctl = await P.ready);

  // ---------- 周网格卡片与列头（calendar.js 每画一张卡调用一次） ----------
  function decorate(P, b, row) {
    const st = stateOf(row);
    b.classList.add("fq-sc-ev", tone(row));
    if (st === "now") b.classList.add("is-now");
    if (st === "done" && row.status === "completed") b.classList.add("is-done");
    if (OFF.includes(row.status)) b.classList.add("is-off");
    if (b.classList.contains("has-conflict")) {
      b.classList.add("is-conflict");
      const w = n("span", null, { class: "fq-sc-warn", title: "排课冲突" });
      w.append(UI.icon("warning"));
      b.querySelector("strong")?.append(w);
    }
    if (st === "late") b.append(n("em", "未点名", { class: "fq-sc-late" }));
    else if (st === "now") b.append(n("em", "进行中"));
    else if (OFF.includes(row.status)) b.append(n("em", label(row)));
  }
  function dayHead(h, d, rows) {
    const now = Date.now(),
      late = rows.filter((r) => stateOf(r, now) === "late").length,
      today = d === todayBJ(),
      w = new Date(d + "T12:00:00Z").getUTCDay();
    const top = n("span", wd(d));
    if (today) top.append(" ", n("i", "今天", { class: "fq-sc-today-tag" }));
    const small = n("small", rows.length + " 节");
    if (late) small.append(" · ", n("b", late + " 未点名", { class: "is-red" }));
    h.replaceChildren(top, n("strong", String(Number(d.slice(8)))), small);
    h.classList.add("fq-sc-wk-day");
    if (w === 0 || w === 6) h.classList.add("is-weekend");
  }

  // ---------- 工具条（顶栏下那一行）：电脑一次建好，之后只更新文字，搜索框不丢焦点 ----------
  function buildBar(P) {
    const B = {};
    B.prev = n("button", null, { type: "button", "aria-label": "上一段" });
    B.prev.append(UI.icon("chevron-left"));
    B.next = n("button", null, { type: "button", "aria-label": "下一段" });
    B.next.append(UI.icon("chevron-right"));
    B.range = n("strong", "");
    B.nav = n("div", null, { class: "fq-sc-nav" });
    B.nav.append(B.prev, B.range, B.next);
    B.prev.addEventListener("click", () => step(P, -1));
    B.next.addEventListener("click", () => step(P, 1));
    B.now = act("本周", async () => (await ctl(P)).go(todayBJ()));
    B.mode = n("span");
    B.teacher = n("select", null, { class: "fq-sc-sel", "aria-label": "老师" });
    B.room = n("select", null, { class: "fq-sc-sel", "aria-label": "教室" });
    B.teacher.addEventListener("change", () => setFilter(P, { teacher: B.teacher.value }));
    B.room.addEventListener("change", () => setFilter(P, { room: B.room.value }));
    // “筛选”：课程类别 + 本周搜索（原工具条的类别与搜索）。
    B.pop = n("section", null, { class: "ui-root fq-sc-pop", popover: "auto", "aria-label": "筛选" });
    B.cat = n("select", null, { class: "fq-sc-sel", "aria-label": "课程类别" });
    B.cat.addEventListener("change", () => setFilter(P, { category: B.cat.value }));
    B.find = n("label", null, { class: "fq-sc-find" });
    B.search = n("input", null, { type: "search", maxlength: "100", placeholder: "搜索本周课程、学员、老师", "aria-label": "本周课程搜索" });
    B.search.value = S.text;
    B.search.addEventListener("input", () => setFilter(P, { text: B.search.value }));
    B.find.append(UI.icon("search"), B.search);
    B.pop.append(n("p", "课程类别", { class: "fq-sc-lbl" }), B.cat, n("p", "本周搜索", { class: "fq-sc-lbl" }), B.find);
    B.filter = act("筛选", () => B.pop.showPopover?.({ source: B.filter }), "", "filter");
    B.tags = n("span", null, { class: "fq-sc-tags" });
    B.bar = n("div", null, { class: "fq-sc-bar" });
    B.bar.append(B.nav, B.now, B.mode, n("span", null, { class: "fq-sc-div" }), B.teacher, B.room, B.filter, B.pop, B.tags);
    B.acts = n("span", null, { class: "fq-sc-acts" });
    if (enabled("exports", "export")) B.acts.append(act("导出", () => staffTimetable(P.c), "", "download"));
    if (enabled("lessons", "create")) B.acts.append(act("排课", () => lessonForm(P.c, S.mode === "day" ? { start_at: (S.day || todayBJ()) + "T14:00" } : {}), "ink", "plus"));
    P.bar = B;
  }
  async function step(P, dir) {
    const c = await ctl(P),
      s = c.state();
    const daily = isPhone() ? S.phone === "day" : S.mode === "day";
    await c.go(daily ? CAL.shift(s.date, dir) : CAL.shift(s.weekDate, dir * 7));
  }
  async function setFilter(P, f) {
    Object.assign(S, f);
    (await ctl(P)).setFilter(f);
  }
  async function setMode(P, mode) {
    S.mode = mode;
    const c = await ctl(P);
    if (mode === "list" && c.state().view !== "list") return c.setView("list");
    if (mode !== "list" && c.state().view !== "calendar") return c.setView("calendar");
    paint(P);
  }
  function options(sel, list, all, value) {
    sel.replaceChildren(...[{ value: "", label: all }, ...list].map((o) => n("option", o.label, { value: o.value })));
    sel.value = list.some((o) => o.value === value) ? value : "";
  }
  function syncBar(P) {
    const B = P.bar,
      snap = P.snap,
      phone = isPhone();
    const daily = phone ? S.phone === "day" : S.mode === "day";
    B.range.textContent = daily ? md(snap.date) + " " + wd(snap.date) : weekLabel(snap.weekDate);
    B.now.lastChild.textContent = daily ? "今天" : "本周";
    B.mode.replaceChildren(
      seg(
        [
          ["week", "周"],
          ["day", "日"],
          ["list", "列表"],
        ],
        S.mode,
        (k) => setMode(P, k),
      ),
    );
    const names = P.names;
    const teachers = names?.teachers?.length
      ? names.teachers.map((t) => ({ value: t.id, label: t.name }))
      : [...new Map(snap.rows.filter((r) => r.teacher_id).map((r) => [r.teacher_id, r.teacher_name])).entries()].map(([value, label]) => ({ value, label }));
    const rooms = names?.rooms?.length
      ? names.rooms.map((x) => ({ value: x.id, label: x.name }))
      : [...new Map(snap.rows.filter((r) => r.location_id).map((r) => [r.location_id, r.location_name])).entries()].map(([value, label]) => ({ value, label }));
    options(B.teacher, teachers, "全部老师", S.teacher);
    options(B.room, [...rooms, { value: "online", label: "线上课" }], "全部教室", S.room);
    const colors = [...new Set(snap.rows.map((r) => r.category_color).filter(Boolean))];
    options(
      B.cat,
      colors.map((color, i) => ({ value: color, label: names?.cats?.find((x) => x.color === color)?.name || "颜色类别 " + (i + 1) })),
      "全部类别",
      S.category,
    );
    // 已选的筛选单独清除（原“教师筛选 ×”等标签）。
    B.tags.replaceChildren();
    const tag = (text, f) => B.tags.append(act(text + " ×", () => setFilter(P, f), "sm"));
    if (S.category) tag("类别：" + (B.cat.selectedOptions[0]?.textContent || ""), { category: "" });
    if (S.text) tag("搜索：" + S.text, { text: "" });
    if (S.teacher || S.room || S.category || S.text)
      B.tags.append(
        act("清除全部筛选", () => {
          B.search.value = "";
          return setFilter(P, { teacher: "", room: "", category: "", text: "" });
        }, "sm"),
      );
  }

  // ---------- 总画 ----------
  function paint(P) {
    const snap = P.snap;
    if (!snap) return;
    syncBar(P);
    const phone = isPhone();
    P.root.classList.toggle("is-phone", phone);
    if (phone) return paintPhone(P);
    // 手机布局借走了日期切换，回到电脑布局时放回工具条最前面。
    if (P.bar.nav.parentNode !== P.bar.bar) P.bar.bar.prepend(P.bar.nav);
    vHead?.bar(P.bar.bar);
    vHead?.actions(P.bar.acts);
    const conf = conflicts(snap);
    P.conf = conf;
    if (S.mode === "day") {
      vHead?.sub(md(snap.date) + " " + wd(snap.date) + (snap.date === todayBJ() ? " · 现在 " + F.time(new Date().toISOString()) : ""));
      P.stats.hidden = true;
      P.weekCard.classList.add("is-hidden");
      P.dayBox.hidden = false;
      paintDay(P, conf);
      return;
    }
    vHead?.sub(weekLabel(snap.weekDate) + " · 第 " + isoWeek(snap.weekDate) + " 周");
    P.stats.hidden = false;
    P.weekCard.classList.remove("is-hidden");
    P.dayBox.hidden = true;
    P.dayBox.replaceChildren();
    paintStats(P, conf);
    paintWeekTop(P, conf);
  }

  function statCard(text, value, foot, { icon, tone, onClick } = {}) {
    const card = n(onClick ? "button" : "div", null, { class: cls("fq-card fq-stat", onClick && "is-link"), ...(onClick ? { type: "button" } : {}) });
    const head = n("div", null, { class: "fq-stat-head" });
    const ic = n("span", null, { class: cls("fq-stat-ic", tone === "red" && "is-red"), "aria-hidden": "true" });
    ic.append(UI.icon(icon));
    head.append(n("span", text), ic);
    card.append(head, n("div", String(value), { class: cls("fq-num", tone && "is-" + tone) }), n("div", foot, { class: cls("fq-stat-foot", onClick && "is-link") }));
    if (onClick) card.addEventListener("click", onClick);
    return card;
  }
  function paintStats(P, conf) {
    const rows = P.snap.rows,
      now = Date.now();
    const live = rows.filter((r) => r.status !== "rescheduled");
    const done = rows.filter((r) => r.status === "completed").length,
      next = rows.filter((r) => stateOf(r, now) === "next" || stateOf(r, now) === "now").length,
      off = rows.filter((r) => ["teacher_leave", "cancelled"].includes(r.status)).length,
      late = rows.filter((r) => stateOf(r, now) === "late").length,
      leave = rows.filter((r) => r.status === "student_leave").length;
    const checkin = enabled("attendance", "update") && !financeOnlyUser();
    P.stats.replaceChildren(
      statCard("本周课次", live.length, "已上 " + done + " · 待上 " + next + " · 停课 " + off, { icon: "calendar", tone: "violet" }),
      statCard("待点名", late, late ? "本周过点未点名" + (checkin ? " · 去点名 →" : "") : "本周下课的课都点过名了", {
        icon: "warning",
        tone: late ? "red" : "",
        onClick: late && checkin ? () => go("todo-unchecked") : null,
      }),
      statCard("排课冲突", conf.length, conf.length ? conflictHead(conf[0]) + " · 去调整 →" : "本周没有冲突", {
        icon: "warning",
        tone: conf.length ? "red" : "",
        onClick: conf.length ? () => locate(P, conf[0].a) : null,
      }),
      statCard("请假 / 停课", leave + off, "学员请假 " + leave + " · 教师请假或取消 " + off + (leave && checkin ? " · 去安排 →" : ""), {
        icon: "users",
        onClick: leave && checkin ? () => go("todo-makeup") : null,
      }),
    );
  }
  const financeOnlyUser = () => {
    const roles = me.user?.roles || [];
    return roles.includes("finance") && !roles.some((r) => ["supervisor", "academic"].includes(r));
  };
  // 定位到这节：回到周视图，滚到卡片并高亮。
  async function locate(P, row) {
    if (S.mode !== "week") await setMode(P, "week");
    const c = await ctl(P);
    if (dayOf(row.start_at) < c.state().weekDate || dayOf(row.start_at) >= CAL.shift(c.state().weekDate, 7)) await c.go(dayOf(row.start_at));
    const card = P.calHost.querySelector('[data-lesson="' + CSS.escape(row.id) + '"]');
    if (!card) return notice("这节课被筛选或“＋N 节”收起了，清除筛选或点开“＋N 节”查看。");
    card.scrollIntoView?.({ block: "center", behavior: "smooth" });
    card.classList.add("is-located");
    card.focus?.();
    setTimeout(() => card.classList.remove("is-located"), 2400);
  }
  async function adjust(P, row) {
    const data = { ...row, ...(await api("data/lessons/" + row.id)).record };
    await lessonForm(P.c, data);
  }

  function legendChips(P, rows, compact = false) {
    const box = n("span", null, { class: compact ? "fq-sc-chiprow" : "fq-sc-legend-l" });
    const counts = new Map();
    for (const r of rows) if (r.teacher_id) counts.set(r.teacher_id, { name: r.teacher_name, n: (counts.get(r.teacher_id)?.n || 0) + 1, row: r });
    const list = [...counts.entries()].sort((a, b) => b[1].n - a[1].n || String(a[1].name).localeCompare(String(b[1].name), "zh-CN"));
    const chip = (id, text, count, row) => {
      const b = n("button", null, { type: "button", class: cls("fq-sc-chip", row && tone(row, "teacher")), "aria-pressed": String(S.teacher === id) });
      if (row) b.append(n("i", null, { class: "fq-sc-dot" }));
      b.append(text);
      if (count !== null) b.append(" ", n("b", String(count)));
      b.addEventListener("click", () => setFilter(P, { teacher: S.teacher === id ? "" : id }));
      return b;
    };
    box.append(chip("", compact ? "全部老师" : "全部", compact ? null : rows.length, null));
    for (const [id, x] of list) box.append(chip(id, x.name || "未定老师", compact ? null : x.n, S.colorBy === "teacher" || compact ? x.row : null));
    return box;
  }
  function alertBar(P, conf, phone = false) {
    if (!conf.length) return null;
    const x = conf[0];
    const box = n("div", null, { class: cls("fq-sc-alert", phone && "is-phone"), role: "alert" });
    const ic = n("span", null, { class: "fq-sc-alert-ic", "aria-hidden": "true" });
    ic.append(UI.icon("warning"));
    const text = n("div");
    text.append(n("b", conf.length + " 处冲突 · " + conflictHead(x)), n("span", conflictText(x) + (conf.length > 1 ? " 另有 " + (conf.length - 1) + " 处。" : "")));
    box.append(ic, text);
    if (!phone) box.append(act("定位到这节", () => locate(P, x.a), "sm"));
    if (enabled("lessons", "update") && !x.a.source_course_id) box.append(act("去调整", () => adjust(P, x.b && x.b.status === "planned" ? x.b : x.a), "sm red"));
    else box.append(act("查看", () => lessonDetail(P.c, x.a), "sm red"));
    return box;
  }
  function paintWeekTop(P, conf) {
    const snap = P.snap;
    const head = n("div", null, { class: "fq-ph" });
    const ht = n("div");
    const h2 = n("h2", weekLabel(snap.weekDate) + " ");
    h2.append(n("span", "Week " + isoWeek(snap.weekDate), { class: "fq-sc-en" }));
    const create = enabled("lessons", "create");
    ht.append(
      h2,
      n(
        "p",
        S.mode === "list"
          ? "本周全部课程，点一行看详情与点名；可按列排序、搜索。"
          : [create ? "点空白格子直接排课" : "", snap.canMove ? "拖动卡片改时间，松手前实时检查老师、教室、学员冲突（键盘：选中后按空格移动）" : "", "点卡片看详情与点名"].filter(Boolean).join("；") + "。",
      ),
    );
    const ha = n("div", null, { class: "fq-ph-acts" });
    if (S.mode === "week")
      ha.append(
        n("span", "颜色", { class: "fq-sc-lbl" }),
        seg(
          [
            ["teacher", "按老师"],
            ["room", "按教室"],
            ["course", "按课程"],
          ],
          S.colorBy,
          async (k) => {
            S.colorBy = k;
            (await ctl(P)).setFilter({});
          },
          "is-sm",
        ),
      );
    head.append(ht, ha);
    const legend = n("div", null, { class: "fq-sc-legend" });
    const keys = n("span", null, { class: "fq-sc-keys" });
    for (const [k, text] of [
      ["late", "过点未点名"],
      ["done", "已上完"],
      ["off", "请假 / 停课"],
      ["conf", "冲突"],
    ]) {
      const s = n("span");
      s.append(n("i", null, { class: "fq-sc-k-" + k }), text);
      keys.append(s);
    }
    legend.append(legendChips(P, snap.rows), keys);
    P.weekTop.replaceChildren(head, legend, alertBar(P, conf) || "");
    P.weekFoot.textContent =
      "共 " + snap.shown.length + " 节" + (snap.shown.length !== snap.rows.length ? "（本周 " + snap.rows.length + " 节，已按筛选显示）" : "（本周已加载）") +
      (S.mode === "week" ? " · 同一时段超过 2 节时折叠为「＋N 节」，点开看全部" : "") + " · 时间为北京时间";
  }

  // ---------- 日视图：时间线（沿用今天页）+ 老师 / 琴房占用条 ----------
  function dayRowsOf(P, date) {
    return P.snap.shown.filter((r) => dayOf(r.start_at) === date).sort((a, b) => a.start_at.localeCompare(b.start_at));
  }
  function timeline(P, date, { phone = false } = {}) {
    const now = Date.now();
    let rows = dayRowsOf(P, date);
    const box = n("section", null, { class: "fq-card fq-tl-panel fq-sc-tlcard", "aria-label": "当天课程时间线" });
    const late = rows.filter((r) => stateOf(r, now) === "late");
    if (!phone) {
      const head = n("div", null, { class: "fq-ph" });
      const ht = n("div");
      ht.append(n("h2", md(date) + " " + wd(date) + " · " + rows.length + " 节"), n("p", "按时间排列；下课后还没点名的标红" + (enabled("lessons", "create") ? "，空档可直接排课" : "")));
      const ha = n("div", null, { class: "fq-ph-acts" });
      ha.append(
        btn(S.onlyLate ? "看全部课程" : "只看待点名", () => {
          S.onlyLate = !S.onlyLate;
          paint(P);
        }, S.onlyLate ? "on" : ""),
      );
      if (late.length && enabled("attendance", "update") && !financeOnlyUser()) ha.append(btn("批量点名 →", () => go("todo-unchecked"), "violet"));
      head.append(ht, ha);
      box.append(head);
    }
    if (S.onlyLate && !phone) rows = late;
    const conf = conflictIds(P.conf || []);
    const tl = n("div", null, { class: "fq-tl" });
    const items = [];
    const create = enabled("lessons", "create");
    let cursor = null;
    for (const r of rows) {
      const s = minOf(r.start_at),
        e = s + (Number(r.duration) || 0);
      // 空档：两节课之间空出 1 小时以上（只看筛选后的课）。
      if (!S.onlyLate && cursor !== null && s - cursor >= 60) items.push(gapItem(P, date, cursor, s, create));
      cursor = Math.max(cursor ?? 0, e);
      items.push(lessonItem(P, r, now, conf));
    }
    items.forEach(([t, state, card], i) => {
      const rail = n("div", null, { class: "fq-tr", "aria-hidden": "true" });
      rail.append(n("i", null, { class: "fq-tr-dot is-" + state }));
      if (i < items.length - 1) rail.append(n("b"));
      tl.append(t, rail, card);
    });
    if (items.length) box.append(tl);
    else {
      const empty = n("div", null, { class: "fq-tl-empty" });
      empty.append(S.onlyLate && !phone ? "这一天没有下课后还没点名的课。" : "这一天没有课程。");
      if (create && !S.onlyLate) empty.append(" ", link("＋ 排课", () => lessonForm(P.c, { start_at: date + "T14:00" })));
      box.append(empty);
    }
    box.append(n("p", phone ? "左右滑动切换日期 · 点卡片看详情与点名" : "左右切换日期：顶部 ‹ › 或键盘 ← →；手机左右滑动。", { class: "fq-tl-foot" }));
    return box;
  }
  function lessonItem(P, r, now, conf) {
    const st = stateOf(r, now);
    const card = n("div", null, { class: cls("fq-lc fq-sc-lc", tone(r, "teacher"), "is-" + st, conf.has(r.id) && "is-conflict", OFF.includes(r.status) && "is-off") });
    const whoB = n("button", null, { type: "button", class: "fq-lc-who" });
    const sub = n("span");
    sub.append(n("i", null, { class: "fq-sc-dot" }), where(r));
    whoB.append(n("b", title(r)), sub);
    whoB.addEventListener("click", () => lessonDetail(P.c, r));
    let tail = [];
    if (st === "late")
      tail = [pill("下课 " + ago(endMs(r)) + "未点名", "err"), enabled("attendance", "update") ? btn("点名", () => lessonDetail(P.c, r), "red") : null];
    else if (st === "now") tail = [n("span", "进行中 · 还剩 " + Math.max(1, Math.ceil((endMs(r) - now) / 60000)) + " 分钟", { class: "fq-lc-live" })];
    else if (st === "done") tail = [pill(label(r) || "已处理", r.status === "completed" ? "ok" : "muted")];
    else {
      tail = [pill(F.time(r.start_at) + " 开始", "muted")];
      if (P.snap.canMove && !r.source_course_id) {
        const mv = btn("改时间", async () => (await ctl(P)).move(r));
        mv.classList.add("fq-sc-mini");
        tail.push(mv);
      }
    }
    if (conf.has(r.id)) tail.unshift(pill("冲突", "err"));
    card.append(whoB, ...tail.filter(Boolean));
    return [n("div", span(r), { class: "fq-tt is-" + (st === "done" ? "done" : st) }), st, card];
  }
  function gapItem(P, date, from, to, create) {
    const busy = P.snap.rows.filter((r) => dayOf(r.start_at) === date && !IDLE.includes(r.status) && minOf(r.start_at) < to && minOf(r.start_at) + Number(r.duration || 0) > from);
    const rooms = (P.names?.rooms || []).filter((x) => !busy.some((r) => r.location_id === x.id));
    const dayTeachers = new Set(P.snap.rows.filter((r) => dayOf(r.start_at) === date && r.teacher_id).map((r) => r.teacher_id));
    const freeT = [...dayTeachers].filter((id) => !busy.some((r) => r.teacher_id === id || r.assistant_id === id)).length;
    const hours = (to - from) / 60;
    const text = "空档 " + (Number.isInteger(hours) ? hours : hours.toFixed(1)) + " 小时 · " + (rooms.length ? rooms.slice(0, 3).map((x) => x.name).join("、") + (rooms.length > 3 ? " 等 " + rooms.length + " 间" : "") + "空着" : freeT + " 位老师有空");
    const card = n("div", null, { class: "fq-lc is-fold fq-sc-gap" });
    card.append(n("span", text));
    if (create) card.append(link("＋ 在这里排课", () => lessonForm(P.c, { start_at: date + "T" + hm(from) })));
    return [n("div", hm(from) + "–" + hm(to), { class: "fq-tt is-past" }), "past", card];
  }
  // 占用条用 SVG 的 x / width 属性定位（不写内联样式）。
  function occupancy(P, date, kind) {
    const rows = P.snap.rows.filter((r) => dayOf(r.start_at) === date && !IDLE.includes(r.status) && (kind === "teacher" ? r.teacher_id : r.mode !== "online" && r.location_id));
    const t0 = Math.min(480, ...rows.map((r) => Math.floor(minOf(r.start_at) / 60) * 60)),
      t1 = Math.max(1260, ...rows.map((r) => Math.ceil((minOf(r.start_at) + Number(r.duration || 0)) / 60) * 60)),
      W = t1 - t0;
    const box = n("section", null, { class: "fq-card fq-sc-occ" });
    const head = n("div", null, { class: "fq-ph" });
    const ht = n("div");
    ht.append(n("h2", kind === "teacher" ? "老师占用" : "琴房 / 教室占用"), n("p", kind === "teacher" ? "按老师分列 · 点色块打开课程" : "灰色 = 空闲，可排课"));
    head.append(ht);
    box.append(head);
    const body = n("div", null, { class: "fq-sc-gt" });
    const axis = n("div", null, { class: "fq-sc-gt-axis" });
    const ticks = n("div");
    for (let m = t0; m <= t1; m += 120) {
      const svgT = n("i", String(m / 60), { class: "fq-sc-tick" });
      ticks.append(svgT);
    }
    axis.append(n("span"), ticks);
    body.append(axis);
    const keys = new Map();
    for (const r of rows) {
      const k = kind === "teacher" ? r.teacher_id : r.location_id;
      if (!keys.has(k)) keys.set(k, { name: kind === "teacher" ? r.teacher_name : r.location_name, rows: [] });
      keys.get(k).rows.push(r);
    }
    const now = Date.now(),
      nowMin = date === todayBJ() ? minOf(new Date(now + 8 * 3600000).toISOString()) : null;
    for (const [, x] of [...keys.entries()].sort((a, b) => String(a[1].name).localeCompare(String(b[1].name), "zh-CN"))) {
      const line = n("div", null, { class: "fq-sc-gt-row" });
      const svg = document.createElementNS(SVG, "svg");
      for (const [k, v] of Object.entries({ viewBox: "0 0 " + W + " 20", preserveAspectRatio: "none", role: "img", "aria-label": x.name + " 当天占用" })) svg.setAttribute(k, v);
      for (let m = t0 + 60; m < t1; m += 60) {
        const l = document.createElementNS(SVG, "rect");
        for (const [k, v] of Object.entries({ x: m - t0, y: 0, width: 0.6, height: 20, class: "fq-sc-gt-grid" })) l.setAttribute(k, v);
        svg.append(l);
      }
      for (const r of x.rows) {
        const rect = document.createElementNS(SVG, "rect");
        const st = stateOf(r, now);
        for (const [k, v] of Object.entries({
          x: minOf(r.start_at) - t0 + 1,
          y: 2,
          width: Math.max(4, Number(r.duration || 0) - 2),
          height: 16,
          rx: 3,
          class: cls("fq-sc-bar-r", kind === "teacher" ? tone(r, "teacher") : "is-room", (st === "done" || st === "late") && "is-past", st === "now" && "is-now"),
          tabindex: "0",
        }))
          rect.setAttribute(k, v);
        const tt = document.createElementNS(SVG, "title");
        tt.textContent = span(r) + " " + title(r) + " · " + where(r);
        rect.append(tt);
        rect.addEventListener("click", () => lessonDetail(P.c, r));
        rect.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            void lessonDetail(P.c, r);
          }
        });
        svg.append(rect);
      }
      if (nowMin !== null && nowMin > t0 && nowMin < t1) {
        const l = document.createElementNS(SVG, "rect");
        for (const [k, v] of Object.entries({ x: nowMin - t0, y: 0, width: 2, height: 20, class: "fq-sc-gt-now" })) l.setAttribute(k, v);
        svg.append(l);
      }
      line.append(n("span", x.name || "—"), svg);
      body.append(line);
    }
    if (!keys.size) body.append(n("p", "这一天没有占用。", { class: "fq-sc-hint" }));
    box.append(body);
    return box;
  }
  function dayCard(P, date) {
    const rows = P.snap.rows.filter((r) => dayOf(r.start_at) === date),
      now = Date.now();
    const confs = (P.conf || []).filter((x) => dayOf(x.a.start_at) === date).length;
    const box = n("section", null, { class: "fq-week" });
    box.append(n("p", "This day", { class: "fq-eb" }));
    const grid = n("div", null, { class: "fq-week-grid" });
    for (const [v, text] of [
      [rows.filter((r) => r.status !== "rescheduled").length, date === todayBJ() ? "今日课次" : "当天课次"],
      [rows.filter((r) => stateOf(r, now) === "late").length, "待点名"],
      [new Set(rows.filter((r) => !IDLE.includes(r.status)).map((r) => r.teacher_id)).size, "上课老师"],
      [confs, "冲突"],
    ]) {
      const cell = n("div");
      cell.append(n("div", String(v), { class: "fq-num" }), n("div", text, { class: "fq-week-label" }));
      grid.append(cell);
    }
    box.append(grid);
    return box;
  }
  function paintDay(P, conf) {
    const date = P.snap.date;
    const main = n("div", null, { class: "fq-today-main" });
    const dayConf = conf.filter((x) => dayOf(x.a.start_at) === date);
    const alert = alertBar(P, dayConf);
    if (alert) {
      alert.classList.add("is-card");
      main.append(alert);
    }
    const tl = timeline(P, date);
    tl.tabIndex = -1;
    main.append(tl);
    const side = n("div", null, { class: "fq-today-side fq-sc-side", role: "complementary", "aria-label": "当天占用" });
    side.append(occupancy(P, date, "teacher"), occupancy(P, date, "room"), dayCard(P, date));
    P.dayBox.replaceChildren(main, side);
    if (!P.keys) {
      // 日视图里 ← → 切换日期（焦点不在输入框时）。
      P.keys = (e) => {
        if (!P.alive || !P.root.isConnected) return document.removeEventListener("keydown", P.keys);
        if (S.mode !== "day" || isPhone() || e.altKey || e.ctrlKey || e.metaKey) return;
        if (e.target.closest?.("input, select, textarea, [contenteditable], dialog, [popover]")) return;
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          void step(P, e.key === "ArrowLeft" ? -1 : 1);
        }
      };
      document.addEventListener("keydown", P.keys);
    }
  }

  // ---------- 手机：日（时间线）/ 周（按天分组列表，过去的天默认折叠），老师筛选代替按老师分列 ----------
  function paintPhone(P) {
    const snap = P.snap,
      B = P.bar,
      today = todayBJ(),
      now = Date.now();
    vHead?.sub(S.phone === "day" ? md(snap.date) + " " + wd(snap.date) + (snap.date === today ? " · 现在 " + F.time(new Date().toISOString()) : "") : weekLabel(snap.weekDate) + " · 第 " + isoWeek(snap.weekDate) + " 周");
    vHead?.bar();
    if (enabled("lessons", "create")) {
      const add = UI.iconButton("排课", "plus", () => lessonForm(P.c, { start_at: snap.date + "T14:00" }));
      add.classList.add("v-fab");
      vHead?.actions(add);
    } else vHead?.actions();
    const conf = conflicts(snap);
    P.conf = conf;
    const top = n("div", null, { class: "fq-sc-phone-top" });
    const row = n("div", null, { class: "fq-sc-phone-row" });
    B.range.textContent = S.phone === "day" ? md(snap.date).replace(/ /g, "") + " " + wd(snap.date) : snap.weekDate.slice(5).replace("-", "/") + " – " + CAL.shift(snap.weekDate, 6).slice(5).replace("-", "/");
    row.append(
      B.nav,
      seg(
        [
          ["day", "日"],
          ["week", "周"],
        ],
        S.phone,
        (k) => {
          S.phone = k;
          paint(P);
        },
        "is-fill",
      ),
    );
    top.append(row);
    if (S.phone === "day") {
      const strip = n("div", null, { class: "fq-sc-strip", role: "tablist", "aria-label": "选择日期" });
      for (let i = 0; i < 7; i++) {
        const d = CAL.shift(snap.weekDate, i),
          dr = snap.shown.filter((r) => dayOf(r.start_at) === d);
        const b = n("button", null, { type: "button", role: "tab", class: cls(d === snap.date && "is-on", d === today && "is-today"), "aria-selected": String(d === snap.date) });
        const cnt = n("span", dr.length + " 节");
        if (dr.some((r) => stateOf(r, now) === "late")) cnt.append(n("i", null, { class: "fq-sc-dot-red", "aria-label": "有未点名" }));
        b.append(n("small", "一二三四五六日"[i]), n("strong", String(Number(d.slice(8)))), cnt);
        b.addEventListener("click", async () => (await ctl(P)).go(d));
        strip.append(b);
      }
      top.append(strip);
    }
    top.append(legendChips(P, snap.rows, true));
    if (S.phone === "day") {
      const dr = dayRowsOf(P, snap.date);
      const sum = n("div", null, { class: "fq-sc-sumline" });
      const late = dr.filter((r) => stateOf(r, now) === "late").length,
        live = dr.filter((r) => stateOf(r, now) === "now").length;
      sum.append(pill(dr.length + " 节", "info"));
      if (late) sum.append(pill(late + " 节待点名", "err"));
      if (live) sum.append(pill("进行中 " + live, "muted"));
      top.append(sum);
    }
    const shownConf = S.phone === "day" ? conf.filter((x) => dayOf(x.a.start_at) === snap.date) : conf;
    const alert = alertBar(P, shownConf, true);
    if (alert) top.append(alert);
    const body = S.phone === "day" ? timeline(P, snap.date, { phone: true }) : agenda(P, conf);
    // 左右滑动切换日期（日）或周（周）。
    let sx = null;
    body.addEventListener("touchstart", (e) => (sx = e.touches[0].clientX), { passive: true });
    body.addEventListener("touchend", (e) => {
      if (sx === null) return;
      const dx = e.changedTouches[0].clientX - sx;
      sx = null;
      if (Math.abs(dx) >= 60) void step(P, dx < 0 ? 1 : -1);
    });
    P.phone.replaceChildren(top, body);
  }
  function agenda(P, conf) {
    const snap = P.snap,
      today = todayBJ(),
      now = Date.now(),
      ids = conflictIds(conf);
    const box = n("div", null, { class: "fq-sc-agenda" });
    for (let i = 0; i < 7; i++) {
      const d = CAL.shift(snap.weekDate, i),
        rows = dayRowsOf(P, d);
      const late = rows.filter((r) => stateOf(r, now) === "late").length;
      const card = n("section", null, { class: cls("fq-card fq-sc-agday", d === today && "is-today") });
      const head = n("header");
      const h = n("b", wd(d) + " " + Number(d.slice(8)));
      if (d === today) h.append(" ", n("i", "今天", { class: "fq-sc-today-tag" }));
      const count = n("span", rows.length + " 节");
      if (late) count.append(" · ", n("b", late + " 未点名", { class: "is-red" }));
      head.append(h, count);
      const folded = d < today && !S.open.has(d) && rows.length > 0;
      if (d < today && rows.length) {
        const t = link(folded ? "展开" : "收起", () => {
          if (folded) S.open.add(d);
          else S.open.delete(d);
          paint(P);
        });
        t.classList.add("fq-sc-fold");
        head.append(t);
      }
      card.append(head);
      if (!rows.length) card.append(n("p", "没有课程", { class: "fq-sc-agsum" }));
      else if (folded) {
        const sum = n("p", null, { class: "fq-sc-agsum" });
        for (const r of rows.slice(0, 8)) sum.append(n("i", null, { class: cls("fq-sc-dot", tone(r, "teacher")) }));
        sum.append(" " + rows.slice(0, 5).map((r) => F.time(r.start_at)).join(" · ") + (rows.length > 5 ? " …" : ""));
        card.append(sum);
      } else
        for (const r of rows) {
          const st = stateOf(r, now);
          const b = n("button", null, { type: "button", class: cls("fq-sc-ag", tone(r, "teacher"), st === "now" && "is-now", ids.has(r.id) && "is-conflict", OFF.includes(r.status) && "is-off") });
          const t = n("time", F.time(r.start_at));
          t.append(n("small", hm(minOf(r.start_at) + Number(r.duration || 0))));
          const w = n("span", null, { class: "fq-sc-ag-who" });
          w.append(n("b", who(r)), n("span", r.course_name + " · " + (r.teacher_name || "") + " · " + (r.mode === "online" ? "线上" : r.location_name || "")));
          const tag = ids.has(r.id)
            ? pill("冲突", "err")
            : st === "late"
              ? pill("未点名", "err")
              : st === "now"
                ? pill("进行中", "info")
                : st === "done"
                  ? pill(r.status === "completed" ? "已销" : label(r), r.status === "completed" ? "ok" : "muted")
                  : null;
          b.append(t, w, tag || "");
          b.addEventListener("click", () => lessonDetail(P.c, r));
          card.append(b);
        }
      box.append(card);
    }
    return box;
  }

  // ---------- 课程详情抽屉（按 design/redesign/schedule/lesson.html 重排，沿用 v2.js 写入与预览） ----------
  const prevLessonDetail = typeof lessonDetail === "function" ? lessonDetail : null;
  async function fqLessonDetail(c, row) {
    if (!prevLessonDetail) return;
    await prevLessonDetail(c, row);
    const dialogs = document.querySelectorAll("dialog.v-lesson");
    const dlg = dialogs[dialogs.length - 1];
    if (!dlg) return;
    dlg.classList.add("fq-sc-lesson-drawer", tone(row || {}, "teacher"));
    const body = dlg.querySelector(".ui-sheet-body");
    if (body) {
      const top = body.querySelector(".v-lesson-top");
      if (top && row?.template_id && !top.querySelector(".fq-sc-fixed-pill")) {
        const d = dayOf(row.start_at);
        const fp = n("span", "固定课" + (d ? " · 每" + wd(d) : ""), { class: "fq-pill is-info fq-sc-fixed-pill" });
        top.append(fp);
      }
      // 把“学员出勤”头与出勤表包进白底卡片，与 lesson.html 一致。
      const attHead = [...body.children].find((x) => x.classList?.contains("v-lesson-section") && !x.classList.contains("v-lesson-comments"));
      const roster = body.querySelector(":scope > .v-roster");
      if (attHead && roster && !attHead.closest(".fq-sc-dr-sec")) {
        const card = n("section", null, { class: "fq-sc-dr-sec fq-sc-att-card" });
        attHead.before(card);
        card.append(attHead, roster);
        const shortage = body.querySelector(":scope > .v-banner-bad");
        if (shortage) card.append(shortage);
      }
      const comments = body.querySelector(":scope > .v-lesson-comments");
      if (comments) comments.classList.add("fq-sc-dr-sec");
      const summary = body.querySelector(":scope > .v-lesson-summary");
      if (summary) summary.classList.add("fq-sc-dr-sec", "fq-sc-summary");
    }
    const foot = dlg.querySelector(".ui-sheet-foot");
    if (foot) {
      const moreBtn = foot.querySelector('.ui-menu-holder > button[aria-haspopup="menu"]');
      if (moreBtn) {
        moreBtn.classList.add("fq-sc-more-icon");
        moreBtn.setAttribute("aria-label", "更多操作");
        const face = moreBtn.querySelector(".ui-button-face");
        if (face) face.replaceChildren(UI.icon("more"));
      }
    }
  }

  // ---------- 新建 / 编辑课程表单（按 design/redesign/schedule/new.html 重排，沿用 app.js 提交与实时冲突预查） ----------
  const prevLessonForm = typeof lessonForm === "function" ? lessonForm : null;
  async function fqLessonForm(c, row = {}) {
    if (!prevLessonForm) return;
    await prevLessonForm(c, row);
    const dialogs = document.querySelectorAll("dialog.business-drawer");
    const dlg = dialogs[dialogs.length - 1];
    const form = dlg?.querySelector("form");
    if (!dlg || !form || !form.elements.start_at || !form.elements.course_type_id) return;
    dlg.classList.add("fq-sc-new-drawer");
    if (!row.id && row.start_at && !dlg.querySelector(".fq-sc-form-sub")) {
      const d = dayOf(row.start_at),
        t = String(row.start_at).slice(11, 16);
      const head = dlg.querySelector(".ui-sheet-head > div");
      if (head && d && t) head.append(n("p", "已填入 " + d.slice(5) + " " + wd(d) + " " + t + "，可随时修改", { class: "fq-sc-form-sub" }));
    }
    const holderOf = (name) => {
      const ctrl = form.elements[name];
      return ctrl?.closest?.(".ui-field, .field") || ctrl?.parentElement || null;
    };
    const makeGroup = (titleText, icName, subText) => {
      const fs = n("section", null, { class: "fq-sc-fs" });
      const h = n("h3");
      if (icName) h.append(UI.icon(icName));
      h.append(titleText);
      if (subText) h.append(n("small", subText));
      fs.append(h);
      return fs;
    };
    const gTime = makeGroup("时间", "clock");
    const gCourse = makeGroup("课程与老师", "users");
    const gPlace = makeGroup("地点", "calendar");
    const gStudents = makeGroup("学员", "users");

    const fStart = holderOf("start_at");
    const fDur = holderOf("duration");
    const fUnits = holderOf("units");
    const fCourse = holderOf("course_type_id");
    const fTeacher = holderOf("teacher_id");
    const fAssist = holderOf("assistant_id");
    const fMode = holderOf("mode");
    const fRoom = holderOf("location_id");
    const fNotes = holderOf("notes");
    const picker = form.querySelector(".v-spick");
    const live = form.querySelector(".v-live-check");
    const conflictNotice = form.querySelector(".v-conflict-error");
    const forceBox = form.querySelector(".v-force-row");
    const foot = form.querySelector(".v-form-foot");

    if (fStart) {
      fStart.classList.add("fq-sc-fwide");
      gTime.append(fStart);
    }
    if (fDur) {
      fDur.classList.add("fq-sc-fhalf");
      const durInput = form.elements.duration;
      if (durInput) {
        const opts = durInput.tagName === "SELECT"
          ? [...durInput.options].map((o) => o.value).filter(Boolean)
          : ["45", "60", "90", "120"];
        if (durInput.tagName === "SELECT") fDur.classList.add("fq-sc-modefield");
        const quick = n("div", null, { class: "fq-sc-seg is-sm fq-sc-durseg", role: "group", "aria-label": "常用时长" });
        const syncQuick = () => {
          for (const b of quick.children) b.setAttribute("aria-pressed", String(b.dataset.min === String(durInput.value)));
        };
        for (const m of opts) {
          const b = n("button", String(m), { type: "button", "data-min": String(m), "aria-pressed": String(String(durInput.value) === String(m)) });
          b.addEventListener("click", () => {
            durInput.value = String(m);
            durInput.dispatchEvent(new Event("input", { bubbles: true }));
            durInput.dispatchEvent(new Event("change", { bubbles: true }));
            syncQuick();
          });
          quick.append(b);
        }
        durInput.addEventListener("input", syncQuick);
        durInput.addEventListener("change", syncQuick);
        fDur.append(quick);
      }
      gTime.append(fDur);
    }
    if (fUnits) {
      fUnits.classList.add("fq-sc-fhalf");
      gTime.append(fUnits);
    }
    if (fCourse) {
      fCourse.classList.add("fq-sc-fwide");
      gCourse.append(fCourse);
    }
    if (fTeacher) {
      fTeacher.classList.add("fq-sc-fhalf");
      gCourse.append(fTeacher);
    }
    if (fAssist) {
      fAssist.classList.add("fq-sc-fhalf");
      gCourse.append(fAssist);
    }
    if (fMode) {
      fMode.classList.add("fq-sc-fhalf", "fq-sc-modefield");
      const modeSel = form.elements.mode;
      if (modeSel?.tagName === "SELECT") {
        const mSeg = n("div", null, { class: "fq-sc-seg is-fill", role: "group", "aria-label": "上课方式" });
        const paintMode = () => {
          for (const b of mSeg.children) b.setAttribute("aria-pressed", String(b.dataset.val === modeSel.value));
        };
        for (const [val, txt] of [["offline", "线下"], ["online", "线上"]]) {
          const b = n("button", txt, { type: "button", "data-val": val, "aria-pressed": String(modeSel.value === val) });
          b.addEventListener("click", () => {
            modeSel.value = val;
            modeSel.dispatchEvent(new Event("change", { bubbles: true }));
            paintMode();
          });
          mSeg.append(b);
        }
        modeSel.addEventListener("change", paintMode);
        fMode.append(mSeg);
      }
      gPlace.append(fMode);
    }
    if (fRoom) {
      fRoom.classList.add("fq-sc-fhalf");
      gPlace.append(fRoom);
    }
    if (picker) {
      picker.classList.add("fq-sc-fwide");
      gStudents.append(picker);
    }
    const rest = [...form.children].filter((x) => ![gTime, gCourse, gPlace, gStudents, fNotes, live, conflictNotice, forceBox, foot].includes(x) && !x.classList?.contains("v-fgroup"));
    form.classList.add("fq-sc-form");
    form.replaceChildren(
      ...[gTime, gCourse, gPlace, picker && gStudents, fNotes, ...rest, live, conflictNotice, forceBox, foot].filter(Boolean),
    );
  }

  // ---------- 固定排课看板与「未生成」提醒（按 design/redesign/schedule/fixed.html） ----------
  const prevTemplatesPage = typeof templatesPage === "function" ? templatesPage : null;
  const FState = { view: "board", teacher: "", inactive: true, phoneDay: (new Date(todayBJ() + "T12:00:00Z").getUTCDay() + 6) % 7 };
  const FIXED_WD = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  const isOpenEnd = (d) => !d || d >= "2099-01-01";
  const isOpenStart = (d) => !d || d <= "1901-01-01";
  const fixedUntil = (d) => (isOpenEnd(d) ? "长期" : "至 " + String(d).slice(5));
  const fixedSpan = (from, to) =>
    (isOpenStart(from) ? "" : from + " 起") + (isOpenEnd(to) ? (isOpenStart(from) ? "长期" : " · 长期") : " 至 " + to);
  const fixedEnd = (start, dur) => {
    const [h, m] = String(start || "09:00").split(":").map(Number);
    const total = h * 60 + m + (Number(dur) || 0);
    return pad(Math.floor(total / 60) % 24) + ":" + pad(total % 60);
  };

  async function runGenerate(c) {
    if (!prevTemplatesPage) return;
    const box = n("div");
    await prevTemplatesPage(box);
    const genBtn = [...box.querySelectorAll("button")].find((x) => x.textContent.trim().includes("生成未来课程"));
    if (genBtn) {
      new MutationObserver((_, o) => {
        o.disconnect();
        void fqTemplatesPage(c);
      }).observe(box, { childList: true });
      genBtn.click();
    }
  }

  async function addFixedEnrollees(r, who, reopen) {
    const students = await globalThis.ChannelRebuild.take("data/students");
    const chosen = new Set(who.map((e) => e.student_id));
    const list = students.filter((s) => s.status === "active" && !chosen.has(s.id));
    const pick = new Set();
    const view = UI.drawer({
      title: "给这节固定课加学员",
      subtitle: FIXED_WD[r.weekday] + " " + r.start_time + " · " + (r.course_name || "未设置课程"),
      secondary: { label: "取消", onSelect: (v) => v.close() },
      primary: {
        label: "确定加入",
        onSelect: async (v) => {
          if (!pick.size) throw Error("请至少选一位学员");
          const from = fromIn.value || todayBJ();
          const to = toIn.value || "2099-12-31";
          for (const sid of pick) await api("data/schedule_enrollments", "POST", { template_id: r.id, student_id: sid, date_from: from, date_to: to });
          notice("已加入 " + pick.size + " 位学员", "success");
          await v.close();
          await reopen();
        },
      },
    });
    const fromIn = UI.datePicker({ label: "开始日期", value: todayBJ() });
    const toIn = UI.datePicker({ label: "结束日期（留空为长期）", value: "", allowEmpty: true });
    const dates = n("div", null, { class: "fq-sc-fs" });
    fromIn.element.classList.add("fq-sc-fhalf");
    toIn.element.classList.add("fq-sc-fhalf");
    dates.append(fromIn.element, toIn.element);
    const qIn = n("input", null, { type: "search", placeholder: "搜索学员姓名", class: "fq-sc-input", "aria-label": "搜索学员" });
    const itemsBox = n("div", null, { class: "fq-sc-picklist" });
    const draw = () => {
      const q = qIn.value.trim().toLowerCase();
      itemsBox.replaceChildren();
      for (const s of list.filter((x) => !q || String(x.name).toLowerCase().includes(q))) {
        const lb = n("label", null, { class: "fq-sc-pickrow" });
        const cb = n("input", null, { type: "checkbox" });
        cb.checked = pick.has(s.id);
        cb.addEventListener("change", () => (cb.checked ? pick.add(s.id) : pick.delete(s.id)));
        lb.append(cb, n("span", s.name));
        itemsBox.append(lb);
      }
      if (!itemsBox.childElementCount) itemsBox.append(n("p", "没有可添加的在读学员。", { class: "fq-sc-hint" }));
    };
    qIn.addEventListener("input", draw);
    draw();
    view.body.append(dates, qIn, itemsBox);
  }

  async function openTemplateDetail(c, r, who, again) {
    const P = () => globalThis.ChannelV2People;
    const R = () => globalThis.ChannelRebuild;
    const view = UI.drawer({
      title: FIXED_WD[r.weekday] + " " + r.start_time + "–" + fixedEnd(r.start_time, r.duration) + " · " + (r.course_name || "未设置课程"),
      subtitle: (r.teacher_name || "未设老师") + " · " + (r.location_name || (r.mode === "online" ? "线上" : "未定教室")) + " · " + fixedSpan(r.date_from, r.date_to),
    });
    const reopen = async () => {
      await again();
      const [rows, enrollments] = await Promise.all([R().take("data/schedule_templates"), R().take("data/schedule_enrollments")]);
      const fresh = rows.find((x) => x.id === r.id);
      if (fresh) await openTemplateDetail(c, fresh, enrollments.filter((e) => e.template_id === r.id), again);
    };
    const sec = n("section", null, { class: "fq-sc-dr-sec" });
    const sh = n("div", null, { class: "fq-sc-dr-h" });
    sh.append(n("h3", r.class_id ? "按班级名单生成" : "报名学员 · " + who.length + " 人"));
    if (!r.class_id && enabled("templates", "create")) {
      sh.append(
        act("＋ 加学员", async () => {
          await view.close();
          await addFixedEnrollees(r, who, reopen);
        }, "sm"),
      );
    }
    sec.append(sh);
    if (!r.class_id) {
      if (!who.length) sec.append(n("p", "还没有学员。点「＋ 加学员」登记谁固定上这节课、从哪天开始。", { class: "fq-sc-hint" }));
      for (const e of who.slice().sort((a, b) => String(a.student_name).localeCompare(String(b.student_name), "zh-CN"))) {
        const line = n("div", null, { class: "fq-sc-enr" });
        const info = n("div", null, { class: "fq-sc-rwho" });
        const stuLink = link(e.student_name || "学员", async () => {
          await view.close();
          R().goStudent(e.student_id);
        });
        info.append(stuLink, n("small", fixedSpan(e.date_from, e.date_to)));
        const acts = n("span", null, { class: "fq-sc-enr-acts" });
        if (enabled("templates", "update"))
          acts.append(
            link("改日期", async () => {
              await view.close();
              recordForm(P().sink(reopen), "schedule_enrollments", e);
            }),
          );
        if (enabled("templates", "delete"))
          acts.append(
            link("退出", async () => {
              if (!(await UI.confirm({ title: e.student_name + " 退出这节固定课？", consequence: "已经生成的课程不受影响；之后再生成时不再带上这位学员。", danger: true }))) return;
              await api("data/schedule_enrollments/" + e.id, "DELETE", { version: e.version });
              await view.close();
              await reopen();
            }),
          );
        line.append(info, acts);
        sec.append(line);
      }
    } else sec.append(n("p", "这节固定课关联了班级，生成时读取班级当前名单。", { class: "fq-sc-hint" }));
    view.body.append(sec);
    if (enabled("templates", "update"))
      view.footer.append(
        act(
          "修改时间与老师",
          async () => {
            await view.close();
            recordForm(P().sink(again), "schedule_templates", r);
          },
          "ink",
        ),
      );
    if (enabled("templates", "delete"))
      view.footer.append(
        act(
          "删除",
          async () => {
            if (!(await UI.confirm({ title: "删除这个固定排课？", consequence: "有关联课程或报名时服务器会拒绝，可改为停用。", danger: true }))) return;
            await api("data/schedule_templates/" + r.id, "DELETE", { version: r.version });
            await view.close();
            await again();
          },
          "red",
        ),
      );
  }

  async function fqTemplatesPage(c) {
    if (!c?.isConnected || c.closest?.(".ui-sheet")) return prevTemplatesPage?.(c);
    const R = () => globalThis.ChannelRebuild;
    const P = () => globalThis.ChannelV2People;
    const today = todayBJ();
    const horizon = dateShift(today, 90);
    const [rows, enrollments, futureLessons] = await Promise.all([
      R().take("data/schedule_templates"),
      R().take("data/schedule_enrollments"),
      enabled("schedule") ? api("schedule?from=" + today + "&to=" + horizon).then((d) => d.items || []).catch(() => []) : [],
    ]);
    if (!c.isConnected) return;
    c.dataset.page = "schedule-templates";
    vHead?.sub("每周固定课 · 按有效期与报名名单批量生成");
    const again = () => fqTemplatesPage(c);
    const activeRows = rows.filter((r) => r.active !== 0);
    const studentCount = new Set(enrollments.map((e) => e.student_id)).size;
    const in60 = dateShift(today, 60);
    const expiringCount = activeRows.filter((r) => !isOpenEnd(r.date_to) && r.date_to >= today && r.date_to <= in60).length;
    const generatedDates = futureLessons.filter((l) => l.template_id && l.status !== "cancelled").map((l) => dayOf(l.start_at)).sort();
    const latestGen = generatedDates[generatedDates.length - 1] || "";
    const warnCut = dateShift(today, 30);
    const needsGen = activeRows.length > 0 && (!latestGen || latestGen < warnCut);
    const nextGenStart = latestGen ? dateShift(latestGen, 1) : today;
    const nextMonthNum = Number(nextGenStart.slice(5, 7));

    const teachers = [...new Map(rows.filter((r) => r.teacher_id).map((r) => [r.teacher_id, r.teacher_name || "未设老师"])).entries()]
      .sort((a, b) => String(a[1]).localeCompare(String(b[1]), "zh-CN"));

    const filtered = () =>
      rows.filter(
        (r) =>
          (FState.inactive || r.active !== 0) &&
          (!FState.teacher || r.teacher_id === FState.teacher),
      );

    const makeCard = (r) => {
      const who = enrollments.filter((e) => e.template_id === r.id);
      const art = n("article", null, { class: cls("fq-sc-tp", tone(r, "teacher"), r.active === 0 && "is-off"), tabindex: "0", role: "button" });
      const stuText = r.class_id
        ? (r.class_name || "班级") + "（班级名单）"
        : who.length === 1
          ? "1 位学员 · " + (who[0].student_name || "")
          : who.length + " 位学员";
      const foot = n("span", null, { class: "fq-sc-tp-foot" });
      foot.append(n("span", stuText), n("span", r.active === 0 ? "已停用" : fixedUntil(r.date_to)));
      art.append(
        n("span", r.start_time + "–" + fixedEnd(r.start_time, r.duration), { class: "fq-sc-tp-time" }),
        n("b", r.course_name || "未设置课程"),
        n("span", (r.teacher_name || "未设老师") + " · " + (r.mode === "online" ? "线上" : r.location_name || "未定教室"), { class: "fq-sc-tp-sub" }),
        foot,
      );
      art.title = who.map((e) => e.student_name).join("、");
      const open = () => openTemplateDetail(c, r, who, again);
      art.addEventListener("click", open);
      art.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          void open();
        }
      });
      return art;
    };

    const draw = () => {
      const shown = filtered();
      const todayWd = (new Date(today + "T12:00:00Z").getUTCDay() + 6) % 7;
      // 电脑工具条
      const bar = n("span", null, { class: "fq-sc-desk-only fq-sc-bar" });
      bar.append(
        seg(
          [
            ["board", "看板"],
            ["list", "列表"],
          ],
          FState.view,
          (v) => {
            FState.view = v;
            draw();
          },
        ),
      );
      const tSel = n("select", null, { class: "fq-sc-sel", "aria-label": "按老师筛选" });
      options(
        tSel,
        teachers.map(([value, label]) => ({ value, label })),
        "全部老师",
        FState.teacher,
      );
      tSel.addEventListener("change", () => {
        FState.teacher = tSel.value;
        draw();
      });
      const sSel = n("select", null, { class: "fq-sc-sel", "aria-label": "停用筛选" });
      sSel.append(n("option", "含已停用", { value: "all" }), n("option", "仅启用", { value: "active" }));
      sSel.value = FState.inactive ? "all" : "active";
      sSel.addEventListener("change", () => {
        FState.inactive = sSel.value === "all";
        draw();
      });
      bar.append(tSel, sSel);
      vHead?.bar(isPhone() ? null : bar);

      const acts = n("span", null, { class: "fq-sc-desk-only fq-sc-acts" });
      if (enabled("templates", "create")) {
        acts.append(
          act("固定排课", () => recordForm(P().sink(again), "schedule_templates"), "", "plus"),
          act("生成未来课程", () => runGenerate(c), "ink", "calendar"),
        );
      }
      vHead?.actions(isPhone() ? null : acts);

      const root = n("div", null, { class: "fq-today fq-sc fq-sc-fixed" });

      // 电脑视图
      const desk = n("div", null, { class: "fq-sc-desk-only fq-sc-stack" });
      const top = n("div", null, { class: "fq-sc-fixtop" });
      const sum = n("div", null, { class: "fq-card fq-sc-fixsum" });
      sum.append(
        n("b", activeRows.length + " 个每周固定课"),
        n(
          "span",
          [
            studentCount + " 位学员报名",
            expiringCount ? expiringCount + " 个 60 天内到期" : "",
            latestGen ? "已生成到 " + latestGen.slice(5) : "尚未生成未来课程",
          ]
            .filter(Boolean)
            .join(" · "),
        ),
      );
      top.append(sum);
      if (needsGen && enabled("templates", "create")) {
        const alert = n("div", null, { class: "fq-sc-alert is-amber", role: "status" });
        const ic = n("span", null, { class: "fq-sc-alert-ic", "aria-hidden": "true" });
        ic.append(UI.icon("calendar"));
        const txt = n("div");
        txt.append(
          n("b", nextMonthNum + " 月课程还没生成"),
          n("span", "按固定课和报名名单生成 " + nextGenStart.slice(5) + " 起的课程，先预览冲突再写入。"),
        );
        alert.append(ic, txt, act("生成未来课程", () => runGenerate(c), "sm ink"));
        top.append(alert);
      }
      desk.append(top);

      if (!rows.length) {
        desk.append(
          UI.empty({
            text: "固定排课用于按有效期与报名名单批量生成未来课程。",
            action: enabled("templates", "create") ? { label: "新建固定排课", onSelect: () => recordForm(P().sink(again), "schedule_templates") } : null,
          }),
        );
      } else if (FState.view === "list") {
        const listCard = n("section", null, { class: "fq-card fq-sc-flist" });
        const sorted = shown.slice().sort((a, b) => a.weekday - b.weekday || a.start_time.localeCompare(b.start_time));
        for (const r of sorted) {
          const who = enrollments.filter((e) => e.template_id === r.id);
          const item = n("button", null, { type: "button", class: cls("fq-sc-flrow", tone(r, "teacher"), r.active === 0 && "is-off") });
          item.append(
            n("span", FIXED_WD[r.weekday] + " " + r.start_time + "–" + fixedEnd(r.start_time, r.duration), { class: "fq-sc-tp-time" }),
            n("b", r.course_name || "未设置课程"),
            n("span", (r.teacher_name || "未设老师") + " · " + (r.mode === "online" ? "线上" : r.location_name || "未定教室"), { class: "fq-sc-tp-sub" }),
            n("span", r.class_id ? "班级名单" : who.length + " 位学员", { class: "fq-sc-tp-sub" }),
            n("span", r.active === 0 ? "已停用" : fixedUntil(r.date_to), { class: "fq-sc-tp-sub" }),
          );
          item.addEventListener("click", () => openTemplateDetail(c, r, who, again));
          listCard.append(item);
        }
        if (!sorted.length) listCard.append(n("p", "没有符合筛选条件的固定排课。", { class: "fq-sc-foot" }));
        desk.append(listCard);
      } else {
        const board = n("div", null, { class: "fq-sc-board" });
        for (let i = 0; i < 7; i++) {
          const col = n("section", null, { class: cls("fq-sc-bcol", i === todayWd && "is-on") });
          const list = shown.filter((r) => r.weekday === i).sort((a, b) => a.start_time.localeCompare(b.start_time));
          const h = n("header");
          h.append(n("h3", FIXED_WD[i]), n("span", String(list.length)));
          col.append(h);
          for (const r of list) col.append(makeCard(r));
          if (enabled("templates", "create")) {
            const addBtn = n("button", "＋ 在" + FIXED_WD[i] + "添加", { type: "button", class: "fq-sc-badd" });
            addBtn.addEventListener("click", () => recordForm(P().sink(again), "schedule_templates", { weekday: i }));
            col.append(addBtn);
          }
          board.append(col);
        }
        desk.append(board);
      }

      // 手机视图
      const phone = n("div", null, { class: "fq-sc-phone-only fq-sc-phone" });
      if (enabled("templates", "create")) {
        const prow = n("div", null, { class: "fq-sc-phone-row" });
        prow.append(
          act("＋ 固定排课", () => recordForm(P().sink(again), "schedule_templates")),
          act("生成未来课程", () => runGenerate(c), "ink grow"),
        );
        phone.append(prow);
      }
      if (needsGen && enabled("templates", "create")) {
        const pa = n("div", null, { class: "fq-sc-alert is-amber is-phone", role: "status" });
        const txt = n("div");
        txt.append(n("b", nextMonthNum + " 月课程还没生成"), n("span", "生成 " + nextGenStart.slice(5) + " 起的课程，先预览再写入。"));
        pa.append(txt);
        phone.append(pa);
      }
      const chips = n("div", null, { class: "fq-sc-chiprow", role: "tablist", "aria-label": "星期" });
      for (let i = 0; i < 7; i++) {
        const cnt = shown.filter((r) => r.weekday === i).length;
        const b = n("button", FIXED_WD[i] + " ", { type: "button", class: "fq-sc-chip", "aria-pressed": String(FState.phoneDay === i) });
        b.append(n("b", String(cnt)));
        b.addEventListener("click", () => {
          FState.phoneDay = i;
          draw();
        });
        chips.append(b);
      }
      phone.append(
        chips,
        n("p", "共 " + activeRows.length + " 个每周固定课 · " + studentCount + " 位学员" + (latestGen ? " · 已生成到 " + latestGen.slice(5) : ""), { class: "fq-sc-hint" }),
      );
      const dayList = n("div", null, { class: "fq-sc-tplist" });
      const dayRows = shown.filter((r) => r.weekday === FState.phoneDay).sort((a, b) => a.start_time.localeCompare(b.start_time));
      for (const r of dayRows) dayList.append(makeCard(r));
      if (!dayRows.length) dayList.append(n("p", FIXED_WD[FState.phoneDay] + "没有固定排课。", { class: "fq-sc-hint" }));
      if (enabled("templates", "create")) {
        const addBtn = n("button", "＋ 在" + FIXED_WD[FState.phoneDay] + "添加", { type: "button", class: "fq-sc-badd" });
        addBtn.addEventListener("click", () => recordForm(P().sink(again), "schedule_templates", { weekday: FState.phoneDay }));
        dayList.append(addBtn);
      }
      phone.append(dayList);

      root.append(desk, phone);
      c.replaceChildren(root);
    };
    draw();
  }

  schedulePage = (c) => schedule(c);
  if (prevLessonDetail) lessonDetail = fqLessonDetail;
  if (prevLessonForm) lessonForm = fqLessonForm;
  if (prevTemplatesPage) templatesPage = fqTemplatesPage;
  globalThis.FengqinSchedule = { schedule, conflicts, lessonDetail: fqLessonDetail, lessonForm: fqLessonForm, templatesPage: fqTemplatesPage };
})();
