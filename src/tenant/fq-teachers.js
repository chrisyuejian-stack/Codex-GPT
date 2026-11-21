// 枫琴教务中心 · 老师（第三期设计稿 design/redesign/teachers，DECISIONS 11–12）。
// 加载在最后：重新赋值 `recordsPage`（只接管 teachers，其他资源照旧）与 pageHooks.rates（课酬标准分页）。
// 只读既有接口：c3/teachers、data/teachers/:id（含 /contact）、schedule、finance/rates、finance/payroll、c2/students?status=active；
// 写入沿用 data/teachers POST/PATCH/DELETE、lessonForm、personalAccount、financeRecordForm（课酬标准分页仍由 v2p.js ratesPage 渲染）。
// 课酬“待付”直接用 finance/payroll 的 unpaid_amount（= 应发课酬 total_amount − 已付 paid_amount，与财务 › 课酬结算“未付”同一口径）。
(() => {
  "use strict";
  const n = el,
    F = UI.fmt,
    V = () => globalThis.ChannelV2,
    R = () => globalThis.ChannelRebuild,
    P = () => globalThis.ChannelV2People;
  const SVG = "http://www.w3.org/2000/svg";
  const mq = globalThis.matchMedia?.("(max-width: 760px)");
  const isPhone = () => !!mq?.matches;
  const cls = (...xs) => xs.filter(Boolean).join(" ");
  const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const EMPLOY = { full_time: "全职", part_time: "兼职" };
  const subjectsOf = (t) => {
    try {
      const v = JSON.parse(t.subjects || "[]");
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };
  const md = (d) => d.slice(5, 10);
  const wd = (d) => WEEK[new Date(d.slice(0, 10) + "T12:00:00Z").getUTCDay()];
  function icon(paths) {
    const s = document.createElementNS(SVG, "svg");
    for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.7", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) s.setAttribute(k, v);
    for (const [tag, attrs] of paths) {
      const p = document.createElementNS(SVG, tag);
      for (const [k, v] of Object.entries(attrs)) p.setAttribute(k, v);
      s.append(p);
    }
    return s;
  }
  const IC = {
    calendar: [["rect", { x: "3", y: "5", width: "18", height: "16", rx: "3" }], ["path", { d: "M7 3v4m10-4v4M3 11h18" }]],
    warn: [["path", { d: "M12 4 2.5 20h19Z" }], ["path", { d: "M12 10v4m0 3h.01" }]],
    check: [["path", { d: "m5 12 4 4L19 6" }]],
    users: [["circle", { cx: "9", cy: "8", r: "3" }], ["path", { d: "M3 20v-2a6 6 0 0 1 12 0v2m1-15a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 4v2" }]],
    search: [["circle", { cx: "10.5", cy: "10.5", r: "6.5" }], ["path", { d: "m16 16 4 4" }]],
    back: [["path", { d: "m15 6-6 6 6 6" }]],
    plus: [["path", { d: "M12 5v14M5 12h14" }]],
    image: [["rect", { x: "3", y: "5", width: "18", height: "14", rx: "2" }], ["circle", { cx: "9", cy: "10", r: "2" }], ["path", { d: "m21 16-5-5-8 8" }]],
  };
  const pill = (text, tone = "", dot = false) => n("span", text, { class: cls("fq-tp-pill", tone && "is-" + tone, dot && "is-dot") });
  function btn(text, fn, kind = "", ic) {
    const b = n("button", null, { type: "button", class: cls("fq-tp-btn", kind && kind.split(" ").map((k) => "is-" + k).join(" ")) });
    if (ic) b.append(icon(IC[ic]));
    if (text) b.append(n("span", text));
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
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
  const link = (text, fn, extra = "") => {
    const b = n("button", text, { type: "button", class: cls("fq-tp-link", extra) });
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await fn(e);
      } catch (err) {
        notice(err.message || String(err));
      }
    });
    return b;
  };
  const avatar = (name, extra = "") => n("span", Array.from(String(name || "?").trim())[0] || "?", { class: cls("fq-tp-av", extra), "aria-hidden": "true" });
  const card = (extra = "") => n("section", null, { class: cls("fq-tp-card", extra) });
  function cardHead(title, sub, extra) {
    const h = n("div", null, { class: "fq-tp-ph" });
    const t = n("div");
    t.append(n("h2", title));
    if (sub) t.append(n("p", sub));
    h.append(t);
    if (extra) h.append(extra);
    return h;
  }
  function statCard(label, num, unit, foot, { ic, tone, footLink, onClick } = {}) {
    const box = n(onClick ? "button" : "div", null, { class: cls("fq-tp-card fq-tp-stat", onClick && "is-link"), ...(onClick ? { type: "button" } : {}) });
    const head = n("div", null, { class: "fq-tp-stat-head" });
    const i = n("span", null, { class: cls("fq-tp-ic", tone === "red" && "is-red", tone === "ok" && "is-ok") });
    i.append(icon(IC[ic]));
    head.append(n("span", label), i);
    const v = n("div", String(num), { class: cls("fq-tp-num", tone && "is-" + tone) });
    if (unit) v.append(n("small", unit));
    box.append(head, v, n("div", foot, { class: cls("fq-tp-stat-foot", footLink && "is-link") }));
    if (onClick) box.addEventListener("click", onClick);
    return box;
  }
  // 原有表单保存后会把结果页渲染进传入的容器；给一个不挂载的容器，被写入就说明保存完成。
  const sink = (done) => P().sink(done);

  // ---------- 名单 + 详情 ----------
  const st = { q: "", subject: "", selected: null, data: null, shared: {}, seq: 0, phoneDetail: false };
  async function load() {
    const day = todayBJ(),
      from = weekStart(day),
      to = dateShift(from, 7),
      monthFrom = day.slice(0, 8) + "01",
      start = monthFrom < from ? monthFrom : from;
    const shared = {};
    if (enabled("teacher_pay")) (shared.rates = R().take("finance/rates")).catch(() => {});
    if (enabled("teacher_pay")) (shared.payroll = api("finance/payroll?month=" + day.slice(0, 7)).then((d) => d.items || [])).catch(() => {});
    if (enabled("students")) (shared.students = R().take("c2/students?status=active")).catch(() => {});
    const [rows, lessons] = await Promise.all([
      api("c3/teachers").then((d) => d.items || []),
      enabled("schedule") ? api("schedule?from=" + start + "&to=" + to).then((d) => d.items || []).catch(() => []) : [],
    ]);
    st.data = { rows, lessons, from, to, monthFrom };
    st.shared = shared;
  }
  async function teachersView(c, reuse) {
    if (!c?.isConnected) {
      c?.replaceChildren(n("span"));
      return;
    }
    if (!reuse || !st.data) await load();
    const { rows, lessons, from } = st.data;
    c.classList.add("fq-teachers");
    c.dataset.page = "teachers";
    const active = rows.filter((t) => t.status === "active");
    const weekTotal = lessons.filter((l) => l.start_at.slice(0, 10) >= from && l.status !== "cancelled").length;
    vHead?.sub("在职 " + active.length + " · 离职 " + (rows.length - active.length) + (enabled("schedule") ? " · 本周共 " + weekTotal + " 节" : ""));
    vHead?.bar();
    // DECISIONS 11：手机端不新建老师。
    vHead?.actions(enabled("settings", "create") && !isPhone() ? btn("新建老师", () => editTeacher(c, null), "ink", "plus") : null);
    const shown = rows
      .filter((t) => {
        const q = st.q.trim().toLowerCase();
        return (!q || (t.name + (t.course_names || "") + subjectsOf(t).join("")).toLowerCase().includes(q)) && (!st.subject || subjectsOf(t).includes(st.subject));
      })
      .sort((a, b) => (a.status === "active" ? 0 : 1) - (b.status === "active" ? 0 : 1));
    if (!shown.some((t) => t.id === st.selected)) {
      st.selected = isPhone() ? null : shown[0]?.id || null;
      st.phoneDetail = false;
    }
    const picked = rows.find((t) => t.id === st.selected);
    if (isPhone() && picked && st.phoneDetail) {
      const seq = ++st.seq;
      const d = await detailView(c, picked);
      if (seq !== st.seq || !c.isConnected) return;
      c.replaceChildren(d);
      globalThis.scrollTo?.(0, 0);
      return;
    }
    const list = listCard(c, rows, shown);
    if (isPhone()) {
      const page = n("div", null, { class: "fq-tp-page" });
      page.append(list);
      c.replaceChildren(page);
      return;
    }
    const split = n("div", null, { class: "fq-tp-split" });
    const holder = n("div", picked ? "正在载入老师详情…" : "没有符合条件的老师。", { class: "fq-tp-card fq-tp-pad fq-tp-muted" });
    const old = c.querySelector(":scope > .fq-tp-page > .fq-tp-split");
    const page = n("div", null, { class: "fq-tp-page" });
    split.append(list, old?.lastElementChild && reuse ? old.lastElementChild : holder);
    page.append(split);
    // 同一次访问内切换：保留搜索框焦点。
    const focus = document.activeElement?.classList?.contains("fq-tp-q") ? document.activeElement.selectionStart : null;
    c.replaceChildren(page);
    if (focus !== null) {
      const q = list.querySelector(".fq-tp-q");
      q?.focus();
      q?.setSelectionRange?.(focus, focus);
    }
    if (!picked) {
      split.lastElementChild.replaceWith(holder);
      return;
    }
    const seq = ++st.seq;
    split.lastElementChild.classList.add("is-loading");
    const d = await detailView(c, picked);
    if (seq !== st.seq || !split.isConnected) return;
    split.lastElementChild.replaceWith(d);
  }
  function listCard(c, rows, shown) {
    const box = card("fq-tp-list");
    const head = n("div", null, { class: "fq-tp-list-head" });
    const sb = n("label", null, { class: "fq-tp-search" });
    const q = n("input", null, { type: "search", class: "fq-tp-q", placeholder: "姓名、科目", "aria-label": "搜索老师", maxlength: "50" });
    q.value = st.q;
    let t;
    q.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => {
        st.q = q.value;
        teachersView(c, true);
      }, 250);
    });
    sb.append(icon(IC.search), q);
    const chips = n("div", null, { class: cls("fq-tp-chips", isPhone() && "is-scroll"), role: "group", "aria-label": "科目" });
    for (const s of ["", ...new Set(rows.flatMap(subjectsOf))]) {
      const b = n("button", s || "全部科目", { type: "button", class: cls("fq-tp-chip", st.subject === s && "is-on"), "aria-pressed": String(st.subject === s) });
      b.addEventListener("click", () => {
        st.subject = s;
        teachersView(c, true);
      });
      chips.append(b);
    }
    head.append(sb, chips);
    box.append(head);
    for (const t of shown) {
      const gone = t.status !== "active";
      const row = n("button", null, { type: "button", class: cls("fq-tp-lrow", t.id === st.selected && !isPhone() && "is-on", gone && "is-gone") });
      const who = n("span", null, { class: "fq-tp-grow" });
      const nm = n("strong", t.name);
      who.append(nm);
      if (gone) who.append(" ", pill("已离职", "line"));
      who.append(n("small", [subjectsOf(t).join(" · ") || t.course_names, gone ? "已离职" : EMPLOY[t.employment]].filter(Boolean).join(" · ")));
      const cnt = n("span", null, { class: "fq-tp-cnt" });
      cnt.append(n("b", String(t.week_count ?? 0)), " 节", n("small", "本周"));
      row.append(avatar(t.name, gone ? "is-gone" : ""), who, cnt);
      row.addEventListener("click", () => {
        st.selected = t.id;
        st.phoneDetail = true;
        teachersView(c, true);
      });
      box.append(row);
    }
    if (!shown.length) box.append(n("p", "没有符合条件的老师。", { class: "fq-tp-pad fq-tp-muted" }));
    box.append(n("div", "共 " + shown.length + " 位 · 离职的排在最后" + (isPhone() && enabled("settings", "create") ? " · 新建老师请用电脑端" : ""), { class: "fq-tp-list-foot" }));
    return box;
  }

  async function detailView(c, t) {
    const again = async () => {
      st.data = null;
      await teachersView(c);
    };
    const { lessons, from, to, monthFrom } = st.data;
    const [rec, rates, pay, students] = await Promise.all([
      api("data/teachers/" + encodeURIComponent(t.id)).then((d) => d.record).catch(() => t),
      enabled("teacher_pay") ? (st.shared.rates ??= R().take("finance/rates")).then((r) => r.filter((x) => x.teacher_id === t.id)).catch(() => null) : null,
      enabled("teacher_pay") ? (st.shared.payroll ??= api("finance/payroll?month=" + todayBJ().slice(0, 7)).then((d) => d.items || [])).then((r) => r.find((x) => x.teacher_id === t.id) || null).catch(() => null) : null,
      enabled("students") ? (st.shared.students ??= R().take("c2/students?status=active")).then((r) => r.filter((s) => (s.teacher_names || "").split(",").includes(t.name))).catch(() => null) : null,
    ]);
    const today = todayBJ();
    const mine = lessons.filter((l) => l.teacher_id === t.id || l.assistant_id === t.id);
    const week = mine.filter((l) => l.start_at.slice(0, 10) >= from && l.start_at.slice(0, 10) < to).sort((a, b) => a.start_at.localeCompare(b.start_at));
    const monthDone = mine.filter((l) => l.start_at.slice(0, 10) >= monthFrom && l.status === "completed");
    const late = mine.filter((l) => V().overdue(l)).sort((a, b) => a.start_at.localeCompare(b.start_at));
    const phone = isPhone();
    const wrap = n("div", null, { class: cls("fq-tp-detail", phone && "fq-tp-page has-bar") });
    if (phone) {
      const bk = n("button", null, { type: "button", class: "fq-tp-back" });
      bk.append(icon(IC.back), n("span", "老师"));
      bk.addEventListener("click", () => {
        st.phoneDetail = false;
        st.selected = null;
        teachersView(c, true);
      });
      wrap.append(bk);
    }

    // 头卡
    const headCard = n("section", null, { class: phone ? "fq-tp-hero" : "fq-tp-card fq-tp-headcard" });
    const id = n("div", null, { class: "fq-tp-id" });
    const info = n("div");
    const h = n("h2", t.name + " ");
    h.append(t.status === "active" ? pill("在职", "ok", true) : pill("已离职", "line"));
    for (const s of subjectsOf(t)) h.append(" ", pill(s, "info"));
    if (EMPLOY[t.employment]) h.append(" ", pill(EMPLOY[t.employment], "line"));
    const sub = n("p");
    if (rec.phone) {
      const no = n("span", rec.phone);
      sub.append("手机 ", no);
      if (enabled("accounts", "reveal_phone")) {
        const show = link("显示号码", async () => {
          const r = await api("data/teachers/" + t.id + "/contact", "POST", {});
          no.textContent = r.phone || "未填";
          show.remove();
        });
        sub.append(" ", show);
      }
      sub.append(n("span", "·", { class: "fq-tp-sep" }));
    }
    sub.append(rec.account_id ? "教师账号已开通，可自助提交点名" : "未开通教师账号");
    sub.append(n("span", "·", { class: "fq-tp-sep" }), rec.show_in_timetable === 0 ? "不在对外课表图显示" : "在对外课表图显示");
    info.append(h, sub);
    id.append(avatar(t.name, "is-big"), info);
    headCard.append(id);
    const ops = [];
    if (enabled("settings", "update")) ops.push(btn("编辑资料", () => editTeacher(c, rec)));
    if (enabled("exports", "export") && enabled("schedule"))
      ops.push(
        btn(
          "导出课表图",
          async () => {
            const view = UI.drawer({ title: t.name + " · 本周课表图" });
            await timetableImage(view.body, from, "teacher_id=" + encodeURIComponent(t.id));
          },
          "",
          "image",
        ),
      );
    const canSchedule = enabled("schedule", "create") && t.status === "active";
    if (canSchedule) ops.push(btn("给他排课", () => lessonForm(sink(again), { teacher_id: t.id }), "ink", "plus"));
    const more = [];
    if (!rec.account_id && enabled("accounts", "create_personal")) more.push({ label: "开通教师账号", onSelect: () => personalAccount("teachers", rec) });
    if (enabled("settings", "delete"))
      more.push({
        label: "删除教师",
        danger: true,
        onSelect: async () => {
          if (await UI.confirm({ title: "删除教师？", consequence: "有关联课程时将被拒绝；保留历史可改为离职。", danger: true })) {
            await api("data/teachers/" + t.id, "DELETE", { version: rec.version ?? t.version });
            st.selected = null;
            st.phoneDetail = false;
            await again();
          }
        },
      });
    const moreMenu = more.length ? UI.actionMenu({ label: phone ? "" : "更多", items: more }).element : null;
    if (!phone) {
      const row = n("div", null, { class: "fq-tp-ops" });
      row.append(...ops);
      if (moreMenu) row.append(moreMenu);
      if (row.children.length) headCard.append(row);
    }
    wrap.append(headCard);

    // 统计卡
    if (enabled("schedule")) {
      const stats = n("div", null, { class: "fq-tp-stats" });
      const done = week.filter((l) => l.status === "completed").length,
        planned = week.filter((l) => l.status === "planned" && !V().overdue(l)).length;
      stats.append(statCard("本周课", week.filter((l) => l.status !== "cancelled").length, "节", "已上 " + done + " · 待上 " + planned, { ic: "calendar", tone: "violet" }));
      const first = late[0];
      stats.append(
        statCard("待点名", late.length, "", first ? (first.start_at.slice(0, 10) === today ? "今天" : md(first.start_at) + " " + wd(first.start_at)) + " " + F.time(first.start_at) + " · 去点名 →" : "没有待点名的课", {
          ic: "warn",
          tone: late.length ? "red" : "",
          footLink: !!first,
          onClick: first ? () => lessonDetail(c, first) : null,
        }),
      );
      stats.append(statCard("本月已上", pay ? pay.lesson_count : monthDone.length, "节", md(monthFrom) + " 起，已销课", { ic: "check", tone: "ok" }));
      if (students) stats.append(statCard("在读学员", students.length, "人", students.length ? "按接下来的排课统计" : "接下来没有排课", { ic: "users" }));
      wrap.append(stats);
    }

    // 课酬（深紫卡）：待付 = finance/payroll 的 unpaid_amount（与财务 › 课酬结算一致）。
    const payCard = () => {
      const box = n("section", null, { class: "fq-tp-dark" });
      const top = n("div", null, { class: "fq-tp-row" });
      const en = n("span", null, { class: "fq-tp-dark-en" });
      en.append("This month · ", n("span", "课酬"));
      top.append(en, n("span", null, { class: "fq-tp-grow" }), pill(pay.confirmation_status === "confirmed" ? "已确认" : "未结算", pay.confirmation_status === "confirmed" ? "ok" : "warn", true));
      const g = n("div", null, { class: "fq-tp-pay-grid" });
      for (const [v, l] of [
        [String(pay.lesson_count), "已销课节数"],
        [F.money(pay.paid_amount || 0), "已付"],
        [F.money(pay.unpaid_amount ?? (pay.total_amount || 0) - (pay.paid_amount || 0)), "待付"],
      ]) {
        const cell = n("div");
        cell.append(n("b", v), n("span", l));
        g.append(cell);
      }
      box.append(top, n("div", F.money(pay.total_amount), { class: "fq-tp-num" }), g);
      if (Number(pay.adjustment_amount)) box.append(n("p", "含课酬调整 " + F.money(pay.adjustment_amount), { class: "fq-tp-dark-label" }));
      if (enabled("teacher_pay")) box.append(link("去财务 · 课酬结算 →", () => (location.hash = "finance-pay"), "fq-tp-dark-link"));
      return box;
    };
    const weekCard = () => {
      const box = card("fq-tp-weekcard");
      box.append(
        cardHead(
          "本周课表",
          md(from) + " " + wd(from) + " — " + md(dateShift(to, -1)) + " " + wd(dateShift(to, -1)) + (phone ? "" : " · 点一节课看详情"),
          link(phone ? "去课表 →" : "在课表里按老师查看 →", () => (location.hash = "schedule-week"), phone ? "" : "is-soft"),
        ),
      );
      const body = n("div", null, { class: "fq-tp-week" });
      const days = new Map();
      for (const l of week) {
        const d = l.start_at.slice(0, 10);
        if (!days.has(d)) days.set(d, []);
        days.get(d).push(l);
      }
      for (const [d, ls] of days) {
        const g = n("div", null, { class: cls("fq-tp-day", d === today && "is-today") });
        g.append(n("div", wd(d) + " " + md(d) + (d === today ? " · 今天" : ""), { class: "fq-tp-day-t" }));
        for (const l of ls) {
          const isLate = V().overdue(l);
          const r = n("button", null, { type: "button", class: cls("fq-tp-les", isLate && "is-late", l.status === "cancelled" && "is-off") });
          const who = n("span", null, { class: "fq-tp-grow" });
          who.append(n("strong", V().person(l)), n("small", [l.course_name, l.location_name || (l.mode === "online" ? "线上课" : "未指定教室")].filter(Boolean).join(" · ")));
          const s =
            l.status === "completed"
              ? pill("已上", "ok", true)
              : isLate
                ? pill("待点名", "err", true)
                : l.status === "planned"
                  ? pill("待上", "info", true)
                  : pill(me.labels.lessons?.[l.status] || "已取消", "line");
          r.append(n("time", F.time(l.start_at)), who, s);
          r.addEventListener("click", () => lessonDetail(c, l));
          g.append(r);
        }
        body.append(g);
      }
      if (!week.length) body.append(n("p", "本周没有课。", { class: "fq-tp-muted fq-tp-pad" }));
      box.append(body);
      return box;
    };
    const ratesCard = () => {
      const box = card();
      box.append(cardHead("课酬标准", "当前生效", enabled("teacher_pay", "create") || enabled("teacher_pay") ? link("全部课酬标准 →", () => vHead?.navigate?.("teachers-rates")) : null));
      const current = rates.filter((r) => r.effective_from <= today && (!r.effective_to || r.effective_to >= today));
      for (const r of current) {
        const line = n("div", null, { class: "fq-tp-rate" });
        line.append(
          n("span", (r.course_name || "全部课程") + (r.format === "group" && !/班/.test(r.course_name || "") ? " · 小班" : "") + " · 按" + (me.labels.rate_units?.[r.rate_basis] || "节")),
          n("strong", F.money(r.rate) + " / " + (me.labels.rate_units?.[r.rate_basis] || "节")),
        );
        box.append(line);
      }
      box.append(n("p", current.length ? "改价时新增一条并填生效日，从那天起算，不影响已锁定月份。" : "还没有设置课酬标准。", { class: "fq-tp-pad fq-tp-muted fq-tp-small fq-tp-nomt" }));
      return box;
    };
    const studentsCard = () => {
      const box = card();
      box.append(cardHead("在读学员 · " + students.length, "点名字打开学员档案"));
      const tags = n("div", null, { class: "fq-tp-tags fq-tp-pad" });
      for (const s of students) {
        const b = n("button", null, { type: "button", class: "fq-tp-tag" });
        b.append(n("i", Array.from(s.name || "?")[0]), s.name);
        b.addEventListener("click", () => R().goStudent(s.id));
        tags.append(b);
      }
      if (!students.length) tags.append(n("p", "接下来没有排到这位老师的学员。", { class: "fq-tp-muted fq-tp-nomt" }));
      box.append(tags);
      return box;
    };
    if (phone) {
      if (pay) wrap.append(payCard());
      if (enabled("schedule")) wrap.append(weekCard());
      if (rates) wrap.append(ratesCard());
      if (students) wrap.append(studentsCard());
      const bar = n("div", null, { class: "fq-tp-bar" });
      bar.append(...ops.filter((b) => !b.textContent.includes("导出")));
      if (moreMenu) {
        moreMenu.classList.add("fq-tp-barmore");
        moreMenu.querySelector("button")?.setAttribute("aria-label", "更多");
        bar.append(moreMenu);
      }
      if (bar.children.length) wrap.append(bar);
      else wrap.classList.remove("has-bar");
      return wrap;
    }
    const grid = n("div", null, { class: "fq-tp-grid" });
    if (enabled("schedule")) grid.append(weekCard());
    const side = n("div", null, { class: "fq-tp-side" });
    if (pay) side.append(payCard());
    if (rates) side.append(ratesCard());
    if (students) side.append(studentsCard());
    grid.append(side);
    wrap.append(grid);
    return wrap;
  }

  // ---------- 新建 / 编辑老师（字段与提交内容同原 recordForm("teachers")） ----------
  function editTeacher(c, rec) {
    const view = UI.drawer({ title: rec ? "编辑老师资料" : "新建老师", subtitle: rec ? rec.name + " · 保存后名单和课表立即更新" : "保存后出现在老师名单，排课时可选" });
    view.element.classList.add("fq-tp-dr");
    const form = n("form", null, { class: "fq-tp-form" });
    const fld = (label, ...controls) => {
      const f = n("div", null, { class: "fq-tp-fld" });
      f.append(n("b", label), ...controls);
      return f;
    };
    const seg = (opts, cur, onPick, label) => {
      const g = n("div", null, { class: "fq-tp-seg is-full", role: "group", "aria-label": label });
      for (const [v, t] of opts) {
        const b = n("button", t, { type: "button", class: v === cur ? "is-on" : "", "aria-pressed": String(v === cur) });
        b.addEventListener("click", () => {
          for (const x of g.children) {
            x.classList.toggle("is-on", x === b);
            x.setAttribute("aria-pressed", String(x === b));
          }
          onPick(v);
        });
        g.append(b);
      }
      return g;
    };
    const name = n("input", null, { class: "fq-tp-input", required: "", maxlength: "50", "aria-label": "姓名" });
    name.value = rec?.name || "";
    // 在职 / 已离职；原状态是“暂停”（旧数据）且仍选离职时保留原值。
    let status = rec?.status || "active",
      employment = rec?.employment || "part_time",
      shown = rec ? rec.show_in_timetable !== 0 : true;
    const leftNote = n("p", "改为“已离职”：历史课、点名和课酬都保留，名单里排到最后并变灰，排课时不再可选。要彻底删除请用“更多 → 删除教师”（有关联课程时会被拒绝）。", { class: "fq-tp-note" });
    const syncNote = () => (leftNote.hidden = status === "active");
    const two = n("div", null, { class: "fq-tp-two" });
    two.append(
      fld("在职状态", seg([["active", "在职"], ["archived", "已离职"]], status === "active" ? "active" : "archived", (v) => {
        status = v === "archived" && rec && rec.status !== "active" ? rec.status : v;
        syncNote();
      }, "在职状态")),
      fld("用工方式", seg([["full_time", "全职"], ["part_time", "兼职"]], employment, (v) => (employment = v), "用工方式")),
    );
    const phone = n("input", null, { class: "fq-tp-input", type: "tel", maxlength: "20", placeholder: rec ? "已有号码不显示；不改就留空" : "选填", "aria-label": "手机" });
    const subjects = subjectsOf(rec || {});
    const subBox = n("div", null, { class: "fq-tp-row is-wrap" });
    const subInput = n("input", null, { class: "fq-tp-input fq-tp-subin", maxlength: "50", placeholder: "输入科目后回车", "aria-label": "添加科目" });
    const drawSubs = () => {
      subBox.replaceChildren();
      for (const s of subjects) {
        const b = n("button", s + " ×", { type: "button", class: "fq-tp-chip is-on", "aria-label": "去掉科目 " + s });
        b.addEventListener("click", () => {
          subjects.splice(subjects.indexOf(s), 1);
          drawSubs();
        });
        subBox.append(b);
      }
      subBox.append(subInput, addSub);
    };
    const add = () => {
      for (const s of subInput.value.split(/[,，]/).map((x) => x.trim()).filter(Boolean)) if (!subjects.includes(s)) subjects.push(s);
      subInput.value = "";
      drawSubs();
      subInput.focus();
    };
    const addSub = n("button", "＋ 添加科目", { type: "button", class: "fq-tp-chip" });
    addSub.addEventListener("click", add);
    subInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        add();
      }
    });
    drawSubs();
    const sw = n("button", null, { type: "button", class: cls("fq-tp-switch", shown && "is-on"), role: "switch", "aria-checked": String(shown), "aria-label": "在对外课表图里显示" });
    sw.append(n("i"));
    sw.addEventListener("click", () => {
      shown = !shown;
      sw.classList.toggle("is-on", shown);
      sw.setAttribute("aria-checked", String(shown));
    });
    const swRow = n("div", null, { class: "fq-tp-switch-row" });
    const swText = n("div", null, { class: "fq-tp-grow" });
    swText.append(n("b", "在对外课表图里显示"), n("small", "关闭后，导出给学员的课表图不出现这位老师的名字；普通课表不受影响"));
    swRow.append(swText, sw);
    const order = n("input", null, { class: "fq-tp-input", type: "number", min: "0", max: "1000000", "aria-label": "名单排序" });
    order.value = String(rec?.sort_order ?? 0);
    const adv = n("details", null, { class: "fq-tp-advbox" });
    adv.append(n("summary", "高级：名单排序"), fld("排序（数字小的排前面）", order));
    form.append(
      n("div", "基本信息", { class: "fq-tp-sec-t" }),
      fld("姓名", name),
      two,
      leftNote,
      fld("手机", phone),
      fld("教授科目", subBox, n("span", "用于老师名单的科目筛选", { class: "fq-tp-hint" })),
      n("div", "对外课表图", { class: "fq-tp-sec-t" }),
      swRow,
      adv,
    );
    syncNote();
    view.body.append(form);
    const save = async () => {
      if (subInput.value.trim()) add();
      const d = {
        name: name.value.trim(),
        status,
        employment,
        subjects,
        show_in_timetable: shown ? 1 : 0,
        sort_order: Number(order.value || 0),
      };
      if (!d.name) throw Error("请填写姓名");
      if (phone.value.trim()) d.phone = phone.value.trim();
      await api("data/teachers" + (rec ? "/" + rec.id : ""), rec ? "PATCH" : "POST", { ...d, ...(rec ? { version: rec.version } : {}) });
      notice(rec ? "已保存" : "已新建老师", "success");
      await view.close();
      st.data = null;
      await teachersView(c);
    };
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      save().catch((err) => notice(err.message));
    });
    view.footer.append(btn("取消", () => view.close()), btn(rec ? "保存老师" : "新建老师", save, "ink"));
    setTimeout(() => name.focus(), 0);
  }

  // ---------- 课酬标准分页：沿用 v2p.js ratesPage，外面套新样式 ----------
  const ratesOriginal = pageHooks.rates;
  async function ratesPage(c) {
    c.classList.add("fq-teachers", "fq-tp-ratespage");
    await ratesOriginal(c);
    const live = c.querySelectorAll(".v-rate-row:not(.is-old)").length;
    vHead?.sub("按老师分组 · " + (c.querySelector(".v-rate-row.is-old") ? "显示 " + c.querySelectorAll(".v-rate-row").length + " 条" : "当前生效 " + live + " 条"));
  }

  const previous = recordsPage;
  recordsPage = async (c, resource, ...args) => {
    if (resource !== "teachers" || c.closest?.(".ui-sheet")) return previous(c, resource, ...args);
    return teachersView(c);
  };
  if (typeof pageHooks !== "undefined" && ratesOriginal) pageHooks.rates = ratesPage;
  globalThis.FQTeachers = { teachersView, editTeacher };
})();
