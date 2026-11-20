// 枫琴教务中心 · 今天与待办（设计稿 02、03）。
// 加载在 v2today.js、yx-home.js 之后：通过重新赋值 `home` 接管今天页；通过 globalThis.fqNavHooks 把待办换成一个收件箱。
// 今天 = 今天在发生什么：四张统计卡、今日课程时间线、右栏（今天要处理摘要、本周小结、通知）。
// 待办 = 收件箱：点名销课、线索回访、续费提醒、请假补课、学员跟进、收款核对合在一页，按已逾期 / 今天 / 本周晚些时候分组。
// 只读既有接口；写入沿用原来的表单与接口（点名面板、补课面板、缴费表单、续费提醒、跟进任务 PATCH、线索 PATCH）。
(() => {
  "use strict";
  const n = el,
    F = UI.fmt,
    R = () => globalThis.ChannelRebuild,
    Pay = () => globalThis.ChannelV2Pay;
  const prevHome = home;
  const go = (hash) => (location.hash = hash);
  const INBOX = "todo-unchecked";
  // 收件箱的类型（左侧筛选的顺序）：键、名称、胶囊色调、导航里原来的完整页面。
  const TYPES = [
    ["lesson", "点名销课", "err", null],
    ["lead", "线索回访", "info", "enrol-leads"],
    ["renewal", "续费提醒", "warn", "todo-renewal"],
    ["makeup", "请假补课", "blue", "todo-makeup"],
    ["follow", "学员跟进", "muted", "todo-followup"],
    ["payment", "收款核对", "ok", null],
  ];
  const typeOf = (k) => TYPES.find((t) => t[0] === k) || TYPES[0];
  const GROUPS = [
    ["late", "已逾期"],
    ["today", "今天"],
    ["later", "本周晚些时候"],
  ];
  // 页面状态：收件箱筛选、展开项；今天页的折叠。
  const st = { who: "mine", type: "", open: null, more: false, later: false, onlyLate: false, showDone: false, showEvening: false };
  let preset = null;
  const routeKeys = new Set();

  // ---------- 小工具 ----------
  const cls = (...xs) => xs.filter(Boolean).join(" ");
  const pill = (text, tone) => n("span", text, { class: "fq-pill is-" + (tone || "muted") });
  // 自己的按钮：点下立即防重复，出错统一提示。
  function act(label, fn, kind = "") {
    const b = n("button", label, { type: "button", class: cls("fq-btn", kind && kind.split(" ").map((k) => "is-" + k).join(" ")) });
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
  const textLink = (label, fn) => {
    const b = act(label, fn);
    b.className = "fq-link";
    return b;
  };
  // 原有表单保存后会把结果渲染进传入的容器：给它一个不挂载的容器，一被写入就重新读本页。
  const sinkTo = (fn) => {
    const box = n("div");
    new MutationObserver((_, o) => {
      o.disconnect();
      void fn();
    }).observe(box, { childList: true });
    return box;
  };
  const endMs = (r) => Date.parse(r.start_at) + (Number(r.duration) || 0) * 60000;
  const ago = (ms) => {
    const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
    if (m < 60) return m + " 分钟";
    if (m < 24 * 60) return Math.floor(m / 60) + " 小时";
    return Math.floor(m / 1440) + " 天";
  };
  const dayOf = (iso) => String(iso || "").slice(0, 10);
  const days = (a, b) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 86400000);
  const hourOf = (iso) => Number(F.time(iso).slice(0, 2));
  const bjDay = (ms) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date(ms));
  const nowText = () => F.time(new Date().toISOString());
  const nowLocal = () =>
    new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
      .format(new Date())
      .replace(" ", "T");
  const shortDay = (d, today) => (d === today ? "今天" : d === dateShift(today, -1) ? "昨天" : d === dateShift(today, 1) ? "明天" : F.day(d));
  const weekBounds = (day) => {
    const monday = dateShift(day, -((new Date(day + "T12:00:00Z").getUTCDay() + 6) % 7));
    return [monday, dateShift(monday, 6)];
  };
  const lessonTitle = (r) => {
    const p = r.participants_summary || { count: 0, names: [] };
    if (p.count > 1) return r.course_name + " · " + (p.class_name ? p.class_name + " " : "小班 ") + p.count + " 人";
    return r.course_name + " · " + (p.names[0] || "暂无学员");
  };
  const lessonWhere = (r) => [r.teacher_name ? r.teacher_name + "老师" : "", r.location_name || ""].filter(Boolean).join(" · ");

  // “稍后”：跟进任务和线索改回访日期（原接口）；其他沿用“明天再说”的本机记录。
  const SNOOZE = "v-today-snooze";
  const snoozed = () => {
    try {
      const all = JSON.parse(localStorage.getItem(SNOOZE) || "{}"),
        day = todayBJ();
      return new Set(Object.entries(all).filter(([, d]) => d > day).map(([k]) => k));
    } catch {
      return new Set();
    }
  };
  const snooze = (key) => {
    try {
      const all = JSON.parse(localStorage.getItem(SNOOZE) || "{}"),
        day = todayBJ();
      for (const [k, d] of Object.entries(all)) if (d <= day) delete all[k];
      all[key] = dateShift(day, 1);
      localStorage.setItem(SNOOZE, JSON.stringify(all));
    } catch {
      /* 浏览器不让存时，本次刷新前隐藏 */
    }
  };

  // ---------- 读数据（今天页与待办共用） ----------
  async function load() {
    const day = todayBJ();
    const may = (ok, run) => (ok ? run().catch(() => null) : Promise.resolve(null));
    const fu = (g) => may(enabled("followup"), () => api("c2/followups?group=" + g + "&owner=&offset=0"));
    const [data, sched, unchecked, subs, makeups, due, debt, leads, fLate, fToday, fFuture] = await Promise.all([
      api("c2/home"),
      may(enabled("schedule"), () => api("schedule?from=" + day + "&to=" + dateShift(day, 1))),
      may(enabled("schedule") && enabled("attendance", "update"), () => R().take("c2/unchecked")),
      may(enabled("attendance", "confirm"), () => api("submissions?status=pending&from=" + dateShift(day, -60) + "&to=" + dateShift(day, 1) + "&offset=0")),
      may(enabled("attendance", "create"), () => api("c2/makeups?offset=0")),
      may(enabled("tuition"), () => api("finance/receivable-summary")),
      may(enabled("packages"), () => api("c2/renewals?group=debt&offset=0")),
      may(enabled("leads"), () => R().take("tools/leads")),
      fu("overdue"),
      fu("today"),
      fu("future"),
    ]);
    const extra = new Map((sched?.items || []).map((x) => [x.id, x]));
    for (const row of data.lessons || []) {
      const s = extra.get(row.id);
      if (s) for (const k of ["category_color", "review_status", "review_kind", "format", "version"]) row[k] ??= s[k];
    }
    const tasks = [fLate, fToday, fFuture].every((x) => x === null)
      ? null
      : [...(fLate?.items || []), ...(fToday?.items || []), ...(fFuture?.items || [])].filter((t) => t.id && t.version !== undefined);
    const stages = new Map();
    for (const s of [...(fLate?.stages || []), ...(fToday?.stages || [])]) stages.set(s.id, s);
    return { day, data, unchecked, subs, makeups, due, debt, leads, tasks, stages: [...stages.values()] };
  }

  // ---------- 待办条目 ----------
  function buildItems(ctx, host, reload) {
    const { day, data } = ctx,
      [, sunday] = weekBounds(day),
      items = [],
      hide = snoozed(),
      now = Date.now();
    const add = (it) => {
      if (!hide.has(it.key)) items.push({ mine: true, ...it });
    };
    // 点名面板保存后会按当前页面重画：今天页直接画回本页，待办页先画进不挂载的容器再重读。
    const lessonHost = () => (host.closest?.(".fq-today") ? host : sinkTo(reload));
    // 点名销课：下课后还没点名的课；老师提交了出勤、等确认的课。
    const pendingIds = new Set((ctx.subs?.items || []).map((r) => r.lesson_id));
    for (const r of ctx.unchecked || []) {
      if (endMs(r) > now || pendingIds.has(r.id)) continue;
      const d = dayOf(r.start_at);
      add({
        key: "u:" + r.id,
        type: "lesson",
        group: "late",
        title: lessonTitle(r),
        detail: shortDay(d, day) + " " + F.time(r.start_at) + " · " + (r.teacher_name ? r.teacher_name + "老师 · " : "") + "下课 " + ago(endMs(r)) + "还没点名",
        primary: ["点名", () => lessonDetail(lessonHost(), r)],
      });
    }
    for (const r of ctx.subs?.items || [])
      add({
        key: "s:" + r.submission_id,
        type: "lesson",
        group: "late",
        title: r.course_name + " · " + F.day(r.start_at) + " " + F.time(r.start_at),
        detail: (r.teacher_name || "老师") + "老师已提交出勤，等你确认 · 确认前不扣课时、不计课酬",
        primary: ["确认出勤", () => lessonDetail(lessonHost(), { id: r.lesson_id, start_at: r.start_at, status: r.lesson_status })],
      });
    // 欠课时：最急，排进已逾期（类型算续费提醒）。
    const debtStudents = new Set();
    for (const r of ctx.debt?.items || []) {
      debtStudents.add(r.student_id + ":" + (r.course_type_id || r.category_id || ""));
      add({
        key: "d:" + r.student_id + ":" + (r.course_type_id || r.category_id || ""),
        type: "renewal",
        group: "late",
        title: r.student_name + " · " + (r.course_name || "课程") + " 欠 " + F.units(r.debt_units),
        detail: "买课时包或用预收余额兑换后自动补扣",
        primary: enabled("tuition", "create")
          ? ["登记缴费", () => Pay().payForm({ student_id: r.student_id, student_name: r.student_name }, () => reload())]
          : ["查看学员", () => R().goStudent(r.student_id, "packages")],
      });
    }
    // 线索回访：约好的回访日在本周内（含已过期）。
    for (const l of ctx.leads || []) {
      if (l.student_id || l.stage === "lost" || l.stage === "enrolled" || !l.next_followup || l.next_followup > sunday) continue;
      const late = l.next_followup < day;
      const S = me.labels.lead_stages || {};
      add({
        key: "l:" + l.id,
        type: "lead",
        group: late ? "late" : l.next_followup === day ? "today" : "later",
        title: [l.name, l.grade, l.direction ? "想学" + l.direction : ""].filter(Boolean).join(" · "),
        detail:
          "约好" + shortDay(l.next_followup, day) + "回访" + (late ? "（已过 " + days(l.next_followup, day) + " 天）" : "") + (l.source ? " · 来源：" + l.source : "") + (S[l.stage] ? " · " + S[l.stage] : ""),
        lead: l,
        primary: enabled("leads", "update") ? ["记录回访", null] : ["查看线索", () => openLead(l, reload)],
        later: enabled("leads", "update") ? () => leadPatch(l, { next_followup: dateShift(day, 1) }) : null,
      });
    }
    // 续费：用首页数据里的完整名单；欠课时的已在上面；三天内提醒过的算已处理。
    for (const a of data.renewals || []) {
      if (ctx.debt && (a.debt_units > 0 || a.balance < 0) && debtStudents.has(a.student_id + ":" + (a.course_type_id || a.category_id || ""))) continue;
      const zero = a.balance <= 0;
      if (!zero && !a.expiring && a.state !== "low") continue;
      const reminded = a.last_reminded_at ? bjDay(typeof a.last_reminded_at === "number" ? a.last_reminded_at : Date.parse(a.last_reminded_at)) : "";
      if (reminded && reminded >= dateShift(day, -2)) continue;
      const canMake = enabled("exports", "export");
      add({
        key: "r:" + a.id,
        type: "renewal",
        group: zero ? "today" : "later",
        title: a.student_name + " · " + (a.course_name || "课时包"),
        detail: (zero ? "课时已用完" : "剩 " + F.units(a.balance)) + (a.valid_to ? " · 有效期至 " + a.valid_to : "") + " · 上次提醒 " + (reminded ? F.day(reminded) : "从未"),
        primary: canMake
          ? ["发提醒", () => remindRenewal(a, reload)]
          : enabled("packages", "create")
            ? ["加课时包", () => creditForm(sinkTo(reload), "packages", { student_id: a.student_id, course_type_id: a.course_type_id })]
            : ["查看学员", () => R().goStudent(a.student_id, "packages")],
      });
    }
    // 请假待补课：最近 30 天（与原待办角标一致）。
    const cut = dateShift(day, -7),
      oldest = dateShift(day, -30);
    for (const r of (ctx.makeups?.items || []).filter((x) => dayOf(x.start_at) >= oldest))
      add({
        key: "m:" + r.id,
        type: "makeup",
        group: dayOf(r.start_at) >= cut ? "today" : "later",
        title: r.student_name + " · " + r.course_name,
        detail: F.day(r.start_at) + " 请假 · 原老师 " + (r.teacher_name || "未指定") + " · 需要排补课",
        primary: [
          "安排补课",
          async () => {
            const l = (await api("data/lessons/" + r.lesson_id)).record;
            await makeupForm(sinkTo(reload), l, l.participants.find((x) => x.id === r.id) || l.participants[0]);
          },
        ],
      });
    // 学员跟进：跟进任务（逾期 / 今天 / 本周到期）与学习阶段到期。
    for (const t of ctx.tasks || []) {
      if (t.done || t.due_date > sunday) continue;
      const late = t.due_date < day;
      add({
        key: "f:" + t.id,
        type: "follow",
        group: late ? "late" : t.due_date === day ? "today" : "later",
        mine: !t.assignee_id || t.assignee_id === me.user.id,
        title: (t.student_name ? t.student_name + " · " : "") + t.title,
        detail: (late ? "逾期 " + days(t.due_date, day) + " 天" : shortDay(t.due_date, day) + "到期") + " · 负责人 " + (t.assignee_name || "待指派"),
        task: t,
        primary: enabled("followup", "update") ? ["记录回访", null] : ["查看", () => go("todo-followup")],
        later: enabled("followup", "update") ? () => followupSave(t, { due_date: dateShift(day, 1) }) : null,
      });
    }
    for (const s of ctx.stages || [])
      add({
        key: "g:" + s.id,
        type: "follow",
        group: "today",
        title: s.student_name + " · 学习阶段已到期",
        detail: "到期日 " + (s.date_to ? F.day(s.date_to) : "") + " · 需要定下一阶段目标",
        primary: ["更新阶段", () => R().goStudent(s.student_id, "stages")],
      });
    // 收款核对：没关联课时包的缴费、没填价格的课时包。
    if (ctx.due?.unresolved)
      add({
        key: "p:" + day,
        type: "payment",
        group: "today",
        title: ctx.due.unresolved + " 笔缴费或课时包待核对",
        detail: "没关联课时包的缴费、没填价格的课时包，处理一条少一条",
        primary: [
          "去核对",
          () => {
            globalThis.ChannelV2Finance?.payTab?.("pending");
            go("finance-income");
          },
        ],
      });
    return items;
  }

  // ---------- 写入（全部沿用原接口） ----------
  async function followupSave(t, changes) {
    // 没有负责人的旧任务改日期时，服务器要求指定负责人：就记在当前账号名下。
    const reassign = !t.assignee_id && changes.due_date && changes.due_date !== t.due_date;
    return api("tools/followup_tasks/" + t.id, "PATCH", {
      student_id: t.student_id,
      title: t.title,
      due_date: t.due_date,
      assignee_id: reassign ? me.user.id : t.assignee_id,
      done: !!t.done,
      ...changes,
      version: t.version,
    });
  }
  // 与线索详情的保存一致：带全部字段，不改手机号。
  const leadPatch = (row, changes) =>
    api("tools/leads/" + row.id, "PATCH", {
      name: row.name,
      grade: row.grade || "",
      direction: row.direction || "",
      source: row.source || "",
      note: row.note || "",
      stage: row.stage,
      next_followup: row.next_followup || null,
      trial_at: row.trial_at || null,
      ...changes,
      version: row.version,
    });
  function openLead(row, reload) {
    const C3 = globalThis.ChannelC3;
    if (C3?.leadDetail) return C3.leadDetail(sinkTo(reload), row);
    return searchLeadDetail(sinkTo(reload), row.id);
  }
  // 续费提醒：打开原来的提醒预览（复制文字 / 保存图片时自动登记“上次提醒”），关掉后刷新。
  async function remindRenewal(row, reload) {
    const brand = await api("renewal-brand");
    const view = UI.drawer({ title: "续费提醒 · " + row.student_name, subtitle: row.course_name });
    view.element.addEventListener("close", () => void reload(), { once: true });
    const box = n("div", null, { class: "v-rn" });
    view.body.append(box);
    await renewalNotice(box, brand, row);
  }

  // 结果胶囊（单选）。
  function chips(options, current, onPick, label) {
    const g = n("div", null, { class: "fq-chips", role: "group", "aria-label": label });
    for (const [v, text] of options) {
      const b = n("button", text, { type: "button", class: "fq-chip", "aria-pressed": String(v === current) });
      b.addEventListener("click", () => {
        for (const x of g.children) x.setAttribute("aria-pressed", String(x === b));
        onPick(v);
      });
      g.append(b);
    }
    return g;
  }
  const field = (label, control, extra) => {
    const f = n("label", null, { class: cls("fq-fld", extra) });
    f.append(n("span", label), control);
    return f;
  };

  // 线索回访：就地填写（结果 + 时间 + 沟通内容），保存后打开下一条。
  function leadInline(it, reload, nextKey) {
    const l = it.lead,
      day = todayBJ();
    const form = n("form", null, { class: "fq-inline", "aria-label": "记录回访 · " + l.name });
    let result = "trial";
    const trial = n("input", null, { type: "datetime-local", "aria-label": "试听时间" });
    trial.value = (l.trial_at || dateShift(day, 2) + "T10:00").slice(0, 16);
    const nextDay = n("input", null, { type: "date", "aria-label": "下次回访" });
    nextDay.value = dateShift(day, 3);
    const note = n("input", null, { type: "text", maxlength: "500", placeholder: "家长关心什么、聊到哪、下一步做什么" });
    const trialField = field("试听时间", trial, "is-time"),
      nextField = field("下次回访", nextDay, "is-time"),
      noteField = field("沟通内容（选填）", note, "is-note");
    const when = n("div", null, { class: "fq-inline-row" });
    const sync = () => {
      trialField.hidden = result !== "trial";
      nextField.hidden = result === "trial" || result === "lost";
      if (result === "noanswer" && nextDay.value === dateShift(day, 3)) nextDay.value = dateShift(day, 1);
      if (result === "again" && nextDay.value === dateShift(day, 1)) nextDay.value = dateShift(day, 3);
    };
    when.append(trialField, nextField, noteField);
    const set = n("fieldset", null, { class: "fq-inline-set" });
    set.append(
      n("legend", "这次回访结果"),
      chips(
        [
          ["trial", "有意向，约试听"],
          ["again", "再跟进"],
          ["noanswer", "没接通"],
          ["lost", "暂不考虑"],
        ],
        result,
        (v) => {
          result = v;
          sync();
        },
        "回访结果",
      ),
    );
    const foot = n("div", null, { class: "fq-inline-foot" });
    const save = n("button", "保存，下一条", { type: "submit", class: "fq-btn is-violet" });
    foot.append(
      act("取消", () => {
        st.open = null;
        return reload(true);
      }),
      save,
    );
    form.append(set, when, foot);
    sync();
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (save.disabled) return;
      save.disabled = true;
      try {
        const label = { trial: "有意向，约试听", again: "再跟进", noanswer: "没接通", lost: "暂不考虑" }[result];
        const text = note.value.trim();
        const line = day.slice(5) + " 回访：" + label + (result === "trial" && trial.value ? "（试听 " + trial.value.replace("T", " ").slice(5) + "）" : "") + (text ? "；" + text : "");
        const changes = { note: (line + (l.note ? "\n" + l.note : "")).slice(0, 6000) };
        if (result === "trial") {
          if (!trial.value) throw Error("请填写试听时间");
          Object.assign(changes, { stage: "trial", trial_at: trial.value.slice(0, 16), next_followup: trial.value.slice(0, 10) });
        } else if (result === "lost") Object.assign(changes, { stage: "lost", next_followup: null });
        else {
          if (!nextDay.value) throw Error("请填写下次回访日期");
          Object.assign(changes, { next_followup: nextDay.value, stage: l.stage === "new" ? "contacted" : l.stage });
        }
        await leadPatch(l, changes);
        notice(result === "lost" ? "已记录，" + l.name + " 标记为暂不考虑" : result === "trial" ? "已记录，试听约在 " + trial.value.replace("T", " ").slice(5) : "已记录，" + shortDay(nextDay.value, day) + "再回访", "success");
        st.open = nextKey || null;
        await reload();
      } catch (err) {
        notice(err.message || String(err));
      } finally {
        save.disabled = false;
      }
    });
    setTimeout(() => form.querySelector(".fq-chip")?.focus(), 0);
    return form;
  }

  // 学员跟进：记录回访（与原今天页相同的写入：跟进记录 + 改任务日期或完成）。
  function followInline(it, reload, nextKey) {
    const t = it.task,
      day = todayBJ();
    const form = n("form", null, { class: "fq-inline", "aria-label": "记录回访 · " + (t.student_name || t.title) });
    let result = "已联系，有意向",
      nextDays = 3;
    const note = n("input", null, { type: "text", maxlength: "500", placeholder: "沟通了什么（选填）" });
    const set = n("fieldset", null, { class: "fq-inline-set" });
    set.append(
      n("legend", "这次跟进结果"),
      chips(
        [
          ["已联系，有意向", "已联系，有意向"],
          ["已联系，暂不考虑", "暂不考虑"],
          ["没接通", "没接通"],
        ],
        result,
        (v) => (result = v),
        "跟进结果",
      ),
    );
    const row = n("div", null, { class: "fq-inline-row" });
    const nextWrap = n("div", null, { class: "fq-fld is-time" });
    nextWrap.append(
      n("span", "下次跟进"),
      chips(
        [
          [1, "明天"],
          [3, "3 天后"],
          [7, "下周"],
          [0, "不再跟进"],
        ],
        nextDays,
        (v) => (nextDays = v),
        "下次跟进",
      ),
    );
    row.append(nextWrap, field("沟通内容（选填）", note, "is-note"));
    const foot = n("div", null, { class: "fq-inline-foot" });
    const save = n("button", "保存，下一条", { type: "submit", class: "fq-btn is-violet" });
    foot.append(
      act("取消", () => {
        st.open = null;
        return reload(true);
      }),
      save,
    );
    form.append(set, row, foot);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (save.disabled) return;
      save.disabled = true;
      try {
        const text = result + (note.value.trim() ? "：" + note.value.trim() : "");
        if (t.student_id && enabled("followup", "create")) await api("tools/followup_notes", "POST", { student_id: t.student_id, at: nowLocal(), content: t.title + " · " + text });
        await followupSave(t, nextDays ? { due_date: dateShift(day, nextDays) } : { done: true });
        notice(nextDays ? "已记录，" + (nextDays === 1 ? "明天" : nextDays + " 天后") + "再跟进" : "已记录，这条跟进完成", "success");
        st.open = nextKey || null;
        await reload();
      } catch (err) {
        notice(err.message || String(err));
      } finally {
        save.disabled = false;
      }
    });
    return form;
  }

  // ---------- 待办 · 收件箱 ----------
  const inbox = { ctx: null };
  async function todoPage(c, quick) {
    const ctx = quick && inbox.ctx ? inbox.ctx : await load();
    inbox.ctx = ctx;
    const reload = async (local) => {
      if (local !== true) inbox.ctx = null;
      if (c.isConnected || local !== true) await todoPage(c, local === true);
    };
    const items = buildItems(ctx, c, reload);
    const mineItems = items.filter((x) => x.mine);
    const scoped = st.who === "all" ? items : mineItems;
    vHead?.sub("处理完的事自动消失；点“稍后”推迟到明天");
    const seg = n("div", null, { class: "fq-seg", role: "group", "aria-label": "范围" });
    for (const [k, label, count] of [
      ["mine", "我负责的", mineItems.length],
      ["all", "全部", items.length],
    ]) {
      const b = n("button", label + " " + count, { type: "button", "aria-pressed": String(st.who === k) });
      b.addEventListener("click", () => {
        st.who = k;
        void reload(true);
      });
      seg.append(b);
    }
    vHead?.bar();
    vHead?.actions(seg, enabled("followup", "create") ? act("＋ 新建任务", () => followupForm(sinkTo(reload), "followup_tasks"), "ink") : null);
    c.replaceChildren();
    c.classList.add("fq-todo");
    c.dataset.page = "todo";

    const layout = n("div", null, { class: "fq-todo-cols" });
    // 左：按类型筛选
    const filt = n("nav", null, { class: "fq-card fq-filt", "aria-label": "按类型筛选" });
    const count = (k) => scoped.filter((x) => !k || x.type === k).length;
    for (const [k, label] of [["", "全部"], ...TYPES.map((t) => [t[0], t[1]])]) {
      const on = st.type === k;
      const b = n("button", null, { type: "button", class: cls("fq-filt-item", on && "is-on", k && "is-" + k), "aria-pressed": String(on) });
      const name = n("span", null, { class: "fq-filt-name" });
      if (k) name.append(n("i", null, { class: "fq-dot is-" + k, "aria-hidden": "true" }));
      name.append(label);
      b.append(name, n("span", String(count(k)), { class: "fq-filt-count" }));
      b.addEventListener("click", () => {
        st.type = k;
        st.more = false;
        void reload(true);
      });
      filt.append(b);
    }
    // 右：清单
    const list = n("section", null, { class: "fq-card fq-inbox", "aria-label": "待办清单" });
    const shown = scoped.filter((x) => !st.type || x.type === st.type);
    const inlineKeys = GROUPS.flatMap(([g]) => shown.filter((x) => x.group === g && (g !== "later" || st.later || st.type))).filter((x) => (x.type === "lead" || x.type === "follow") && x.primary[1] === null).map((x) => x.key);
    if (!shown.length) {
      const empty = n("div", null, { class: "fq-empty" });
      empty.append(
        n("p", items.length ? "这一类现在没有要处理的事。" : "都处理完了。", { class: "fq-empty-title" }),
        n("p", st.who === "mine" && items.length > mineItems.length ? "切到“全部”可以看别人负责的事。" : "新的待办会自动出现在这里。", { class: "fq-empty-sub" }),
      );
      list.append(empty);
    }
    for (const [g, label] of GROUPS) {
      const rows = shown.filter((x) => x.group === g);
      if (!rows.length) continue;
      list.append(n("p", label + " · " + rows.length, { class: "fq-grp is-" + g }));
      // 本周晚些时候：默认收起，只说有哪些。
      if (g === "later" && !st.later && !st.type) {
        const by = new Map();
        for (const r of rows) by.set(r.type, (by.get(r.type) || 0) + 1);
        const p = n("p", [...by].map(([k, v]) => v + " 条" + typeOf(k)[1]).join("、") + "，到期那天会移到“今天”。", { class: "fq-later" });
        p.append(
          textLink("展开", () => {
            st.later = true;
            return reload(true);
          }),
        );
        list.append(p);
        continue;
      }
      // 看“全部”时每组每类最多列 4 条，其余收成一行“还有 N 条… →”（点了只看这一类）。
      const seen = new Map(),
        rest = new Map();
      const visible = rows.filter((r) => {
        const k = (seen.get(r.type) || 0) + 1;
        seen.set(r.type, k);
        if (st.type || st.more || k <= 4 || r.key === st.open) return true;
        rest.set(r.type, (rest.get(r.type) || 0) + 1);
        return false;
      });
      for (const it of visible) {
        const open = st.open === it.key && it.primary[1] === null;
        const wrap = open ? n("div", null, { class: "fq-item-open" }) : null;
        const line = n("div", null, { class: "fq-item" });
        const [, tlabel, tone] = typeOf(it.type);
        const who = n("div", null, { class: "fq-who" });
        who.append(n("b", it.title), n("span", it.detail));
        line.append(pill(tlabel, tone), who);
        const ops = n("div", null, { class: "fq-ops" });
        if (open) {
          if (it.lead?.phone && enabled("leads", "update"))
            ops.append(
              act(
                "拨打电话",
                async () => {
                  const ct = await api("tools/leads/" + it.lead.id + "/contact", "POST", {});
                  if (ct.phone) location.href = "tel:" + ct.phone;
                  else notice("这条线索没有登记手机号");
                },
                "soft",
              ),
            );
          if (it.lead) ops.append(textLink("查看线索", () => openLead(it.lead, reload)));
        } else {
          ops.append(
            act("稍后", async () => {
              if (it.later) {
                await it.later();
                notice("已推迟到明天", "success");
                await reload();
              } else {
                snooze(it.key);
                notice("已推迟到明天", "success");
                await reload(true);
              }
            }),
          );
          const [plabel, pfn] = it.primary;
          ops.append(
            act(
              plabel,
              async () => {
                if (pfn === null) {
                  st.open = it.key;
                  return reload(true);
                }
                return pfn();
              },
              "ink",
            ),
          );
        }
        line.append(ops);
        if (wrap) {
          const i = inlineKeys.indexOf(it.key);
          wrap.append(line, it.lead ? leadInline(it, reload, inlineKeys[i + 1]) : followInline(it, reload, inlineKeys[i + 1]));
          list.append(wrap);
        } else list.append(line);
      }
      for (const [k, v] of rest) {
        const more = textLink("还有 " + v + " 条" + typeOf(k)[1] + " →", () => {
          st.type = k;
          return reload(true);
        });
        more.classList.add("fq-more");
        list.append(more);
      }
    }
    // 选中一类时：给原来的完整页面留入口（批量提醒、指派负责人等仍在那里）。
    const full = st.type && typeOf(st.type)[3];
    if (full && routeKeys.has(full)) {
      const p = n("p", null, { class: "fq-later" });
      p.append("需要批量处理或看已完成的？", textLink("打开完整的" + typeOf(st.type)[1] + "页 →", () => go(full)));
      list.append(p);
    }
    layout.append(filt, list);
    c.append(layout);
    if (st.open) setTimeout(() => list.querySelector(".fq-item-open")?.scrollIntoView?.({ block: "nearest" }), 0);
  }

  // ---------- 今天 ----------
  const today = { ctx: null };
  function statCard(label, value, foot, { icon, tone, onClick, footLink } = {}) {
    const card = n(onClick ? "button" : "div", null, { class: cls("fq-card fq-stat", onClick && "is-link"), ...(onClick ? { type: "button" } : {}) });
    const head = n("div", null, { class: "fq-stat-head" });
    head.append(n("span", label));
    const ic = n("span", null, { class: cls("fq-stat-ic", tone === "red" && "is-red"), "aria-hidden": "true" });
    ic.append(UI.icon(icon));
    head.append(ic);
    card.append(head, n("div", String(value), { class: cls("fq-num", tone && "is-" + tone) }), n("div", foot, { class: cls("fq-stat-foot", footLink && "is-link") }));
    if (onClick) card.addEventListener("click", onClick);
    return card;
  }
  const toTodo = (type) => {
    preset = type || "";
    go(INBOX);
  };

  function timeline(c, ctx, reload) {
    const now = Date.now(),
      day = ctx.day;
    const box = n("section", null, { class: "fq-card fq-tl-panel", "aria-label": "今日课程时间线" });
    const head = n("div", null, { class: "fq-ph" });
    const ht = n("div");
    ht.append(n("h2", "今日课程"), n("p", "按时间排列；下课后还没点名的标红"));
    const ha = n("div", null, { class: "fq-ph-acts" });
    ha.append(
      act(st.onlyLate ? "看全部课程" : "只看待点名", () => {
        st.onlyLate = !st.onlyLate;
        return reload(true);
      }, st.onlyLate ? "on" : ""),
    );
    if (enabled("schedule")) ha.append(act("去课表 →", () => go("schedule-week"), "soft"));
    head.append(ht, ha);
    box.append(head);
    const pendingLessons = new Set((ctx.subs?.items || []).map((r) => r.lesson_id));
    const entries = [];
    for (const r of (ctx.data.lessons || []).slice()) {
      const start = Date.parse(r.start_at),
        end = endMs(r);
      const planned = r.status === "planned";
      const submitted = planned && (pendingLessons.has(r.id) || r.review_status === "pending");
      const state = !planned ? "done" : end <= now ? "late" : start <= now ? "now" : "next";
      entries.push({ kind: "lesson", row: r, start, end, state, submitted });
    }
    // 今天的试听（来自线索的试听时间）。
    for (const l of ctx.leads || []) {
      if (!l.trial_at || dayOf(l.trial_at) !== day || l.stage === "lost") continue;
      const start = Date.parse(l.trial_at);
      entries.push({ kind: "trial", lead: l, start, end: start + 3600000, state: start + 3600000 <= now ? "past" : start <= now ? "now" : "next" });
    }
    entries.sort((a, b) => a.start - b.start);
    const done = entries.filter((e) => e.kind === "lesson" && e.state === "done");
    let visible = entries.filter((e) => st.showDone || e.state !== "done");
    if (st.onlyLate) visible = visible.filter((e) => e.state === "late");
    // 晚上的课（18 点后、还没开始、两节以上）先收起。
    const evening = visible.filter((e) => e.state === "next" && hourOf(new Date(e.start).toISOString()) >= 18);
    const foldEvening = !st.showEvening && !st.onlyLate && evening.length >= 2;
    if (foldEvening) visible = visible.filter((e) => !evening.includes(e));
    const tl = n("div", null, { class: "fq-tl" });
    const rows = [];
    for (const e of visible) {
      const time = e.kind === "lesson" ? F.range(e.row.start_at, e.row.duration) : F.time(e.lead.trial_at) + " 试听";
      const card = n("div", null, { class: cls("fq-lc", "is-" + e.state, e.submitted && "is-submitted", e.kind === "trial" && "is-trial") });
      const who = n("button", null, { type: "button", class: "fq-lc-who" });
      let tail = [];
      if (e.kind === "lesson") {
        const r = e.row;
        who.append(n("b", lessonTitle(r)), n("span", lessonWhere(r) + (e.submitted ? " · 老师已提交出勤" : "")));
        who.addEventListener("click", () => lessonDetail(c, r));
        if (e.state === "late" || (e.submitted && e.state !== "done")) {
          tail = e.submitted
            ? [pill("待确认", "err"), act("确认", () => lessonDetail(c, r), "red")]
            : [pill("下课 " + ago(e.end) + "未点名", "err"), enabled("attendance", "update") ? act("点名", () => lessonDetail(c, r), "red") : null];
        } else if (e.state === "now") tail = [n("span", "进行中 · 还剩 " + Math.max(1, Math.ceil((e.end - now) / 60000)) + " 分钟", { class: "fq-lc-live" })];
        else if (e.state === "done") tail = [pill(r.status === "completed" ? "已点名" : me.labels.lessons?.[r.status] || "已处理", r.status === "completed" ? "ok" : "muted")];
        else tail = [pill(F.time(r.start_at) + " 开始", "muted")];
      } else {
        const l = e.lead;
        who.append(n("b", "试听 · " + (l.direction || "课程") + " · " + l.name), n("span", [l.grade, l.source ? "来源 " + l.source : ""].filter(Boolean).join(" · ") || "试听线索"));
        who.addEventListener("click", () => openLead(l, reload));
        tail = [pill("线索", "warn"), textLink("查看线索", () => openLead(l, reload))];
      }
      card.append(who, ...tail.filter(Boolean));
      rows.push([n("div", time, { class: cls("fq-tt", "is-" + e.state) }), e.state, card]);
    }
    if (foldEvening) {
      const card = n("div", null, { class: "fq-lc is-fold" });
      const who = n("div", null, { class: "fq-lc-who is-static" });
      const names = [...new Set(evening.map((e) => (e.kind === "lesson" ? e.row.course_name : "试听 · " + (e.lead.direction || e.lead.name))))];
      who.append(n("b", "还有 " + evening.length + " 节课"), n("span", names.join("、")));
      card.append(
        who,
        textLink("展开", () => {
          st.showEvening = true;
          return reload(true);
        }),
      );
      rows.push([n("div", F.time(new Date(evening[0].start).toISOString()) + " 起", { class: "fq-tt is-next" }), "evening", card]);
    }
    rows.forEach(([t, state, card], i) => {
      const rail = n("div", null, { class: "fq-tr", "aria-hidden": "true" });
      rail.append(n("i", null, { class: "fq-tr-dot is-" + state }));
      if (i < rows.length - 1) rail.append(n("b"));
      tl.append(t, rail, card);
    });
    if (rows.length) box.append(tl);
    else
      box.append(
        n(
          "p",
          st.onlyLate ? "今天没有下课后还没点名的课。" : (ctx.data.lessons || []).length ? "今天的课都已处理完。" : "今天没有排课。",
          { class: "fq-tl-empty" },
        ),
      );
    if (done.length) {
      const foot = n("p", null, { class: "fq-tl-foot" });
      foot.append(
        "已点名 " + done.length + " 节 · ",
        textLink(st.showDone ? "收起" : "查看", () => {
          st.showDone = !st.showDone;
          return reload(true);
        }),
      );
      box.append(foot);
    } else if (st.showEvening && evening.length >= 2) {
      const foot = n("p", null, { class: "fq-tl-foot" });
      foot.append(
        textLink("收起晚上的课", () => {
          st.showEvening = false;
          return reload(true);
        }),
      );
      box.append(foot);
    }
    return box;
  }

  function summaryPanel(items) {
    const box = n("section", null, { class: "fq-card fq-sum" });
    box.append(n("div", null, { class: "fq-ribbon", "aria-hidden": "true" }));
    const head = n("div", null, { class: "fq-ph" });
    const ht = n("div");
    ht.append(n("h2", "今天要处理"), n("p", "完整清单在待办"));
    head.append(ht, textLink("全部 " + items.length + " 件 →", () => toTodo("")));
    box.append(head);
    const due = items.filter((x) => x.group !== "later");
    const count = (type, pred = () => true) => due.filter((x) => x.type === type && pred(x)).length;
    const lines = [
      ["lesson", count("lesson"), (k) => k + " 节课待点名或确认", ["逾期", "err"]],
      ["lead", count("lead"), (k) => k + " 条线索要回访", ["线索", "info"]],
      ["renewal", count("renewal"), (k) => k + " 位学员要续费", ["续费", "warn"]],
      ["makeup", count("makeup"), (k) => k + " 位请假待补课", ["补课", "blue"]],
      ["follow", count("follow"), (k) => k + " 条学员跟进", ["跟进", "muted"]],
      ["payment", count("payment"), () => (items.find((x) => x.type === "payment")?.title || "收款待核对"), ["收款", "ok"]],
    ].filter((x) => x[1]);
    if (!lines.length) box.append(n("p", "今天没有要处理的事，都清空了。", { class: "fq-sum-empty" }));
    for (const [type, k, text, [tag, tone]] of lines.slice(0, 4)) {
      const row = n("button", null, { type: "button", class: "fq-sum-row" });
      row.append(n("span", text(k)), pill(tag, tone));
      row.addEventListener("click", () => toTodo(type));
      box.append(row);
    }
    if (lines.length > 4) box.append(n("p", "另有 " + lines.slice(4).reduce((s, x) => s + x[1], 0) + " 件，在待办里。", { class: "fq-sum-more" }));
    return box;
  }

  function weekPanel(ctx) {
    const [monday] = weekBounds(ctx.day);
    const from = Date.parse(monday + "T00:00:00+08:00");
    const cells = [];
    if (ctx.data.week) cells.push([ctx.data.week.reduce((s, x) => s + (x.n || 0), 0), "本周课次"]);
    if (ctx.leads) {
      cells.push([ctx.leads.filter((l) => l.created_at >= from).length, "新线索"]);
      cells.push([ctx.leads.filter((l) => l.student_id && l.updated_at >= from).length, "试听转正"]);
    }
    if (ctx.makeups) cells.push([(ctx.makeups.items || []).filter((x) => dayOf(x.start_at) >= monday).length, "请假待补"]);
    if (!cells.length) return null;
    const box = n("section", null, { class: "fq-week", "aria-label": "本周小结" });
    box.append(n("p", "This week", { class: "fq-eb" }));
    const grid = n("div", null, { class: "fq-week-grid" });
    for (const [v, label] of cells) {
      const cell = n("div");
      cell.append(n("div", String(v), { class: "fq-num" }), n("div", label, { class: "fq-week-label" }));
      grid.append(cell);
    }
    box.append(grid);
    return box;
  }

  function noticePanel(c, ctx) {
    const box = n("section", null, { class: "fq-card fq-notes" });
    const head = n("div", null, { class: "fq-ph" });
    head.append(n("h2", "通知"));
    box.append(head);
    const subs = (ctx.subs?.items || []).slice(0, 3);
    for (const r of subs) {
      const p = n("p", (r.teacher_name || "老师") + "老师提交了 " + F.day(r.start_at).slice(0, 5).replace("-", "/") + " " + r.course_name + " 的出勤，等你确认。", { class: "fq-note" });
      p.append(textLink("去确认", () => lessonDetail(c, { id: r.lesson_id, start_at: r.start_at, status: r.lesson_status })));
      box.append(p);
    }
    const more = (ctx.subs?.items || []).length - subs.length;
    if (more > 0) box.append(n("p", "还有 " + more + " 条老师提交等确认，在待办里。", { class: "fq-note is-muted" }));
    if (!subs.length) box.append(n("p", "没有新的通知。老师提交出勤后会出现在这里。", { class: "fq-note is-muted" }));
    return box;
  }

  async function todayPage(c, quick) {
    const ctx = quick && today.ctx ? today.ctx : await load();
    today.ctx = ctx;
    const reload = async (local) => {
      if (local !== true) today.ctx = null;
      await todayPage(c, local === true);
    };
    const [, m, d] = ctx.day.split("-");
    vHead?.sub(Number(m) + " 月 " + Number(d) + " 日 " + F.day(ctx.day).slice(-2) + " · 现在 " + nowText());
    vHead?.bar();
    vHead?.actions();
    const items = buildItems(ctx, c, reload);
    c.replaceChildren();
    c.classList.add("fq-today");
    c.dataset.page = "home";
    const now = Date.now();
    const lessons = ctx.data.lessons || [];
    // 统计卡
    const stats = n("section", null, { class: "fq-stats", "aria-label": "今日概况" });
    if (ctx.data.lessons) {
      const finished = lessons.filter((r) => endMs(r) <= now && r.status !== "cancelled").length,
        live = lessons.filter((r) => Date.parse(r.start_at) <= now && endMs(r) > now).length;
      stats.append(statCard("今日课程", lessons.length, "已上完 " + finished + " · 进行中 " + live, { icon: "calendar", tone: "violet", onClick: enabled("schedule") ? () => go("schedule-week") : null }));
    }
    const lessonItems = items.filter((x) => x.type === "lesson");
    if (ctx.unchecked || ctx.subs) {
      const todayLate = lessonItems.filter((x) => x.key.startsWith("u:") && x.detail.startsWith("今天")).length,
        subsN = lessonItems.filter((x) => x.key.startsWith("s:")).length;
      const foot = lessonItems.length ? [todayLate ? "今天 " + todayLate + " 节" : "", lessonItems.length - todayLate - subsN ? "更早 " + (lessonItems.length - todayLate - subsN) + " 节" : "", subsN ? "老师提交 " + subsN : ""].filter(Boolean).join(" · ") : "下课的课都点过名了";
      stats.append(statCard("待点名", lessonItems.length, foot, { icon: "warning", tone: lessonItems.length ? "red" : "", onClick: () => toTodo("lesson") }));
    }
    if (ctx.leads) {
      const trials = ctx.leads.filter((l) => l.trial_at && dayOf(l.trial_at) === ctx.day && l.stage !== "lost").sort((a, b) => a.trial_at.localeCompare(b.trial_at));
      stats.append(statCard("今日试听", trials.length, trials.length ? trials.map((l) => F.time(l.trial_at)).join(" · ") : "今天没有约试听", { icon: "filter", onClick: () => go("enrol-leads") }));
    }
    stats.append(statCard("待办", items.length, "打开待办 →", { icon: "check", onClick: () => toTodo(""), footLink: true }));
    c.append(stats);
    // 主体：时间线 + 右栏
    const cols = n("div", null, { class: "fq-today-cols" });
    const main = n("div", null, { class: "fq-today-main" });
    if (ctx.data.lessons) main.append(timeline(c, ctx, reload));
    else main.append(summaryPanel(items));
    const side = n("div", null, { class: "fq-today-side", role: "complementary", "aria-label": "今天要处理与本周小结" });
    if (ctx.data.lessons) side.append(summaryPanel(items));
    const week = weekPanel(ctx);
    if (week) side.append(week);
    if (ctx.subs) side.append(noticePanel(c, ctx));
    cols.append(main, side);
    c.append(cols);
  }

  home = async (c) => {
    const finance = me.user.roles.includes("finance") && !me.user.roles.some((r) => ["supervisor", "academic"].includes(r));
    if (finance) return prevHome(c);
    today.ctx = null;
    return todayPage(c);
  };

  // ---------- 导航：待办只留一个收件箱 ----------
  // 原来的 todo-unchecked 地址进入收件箱（别处 navigate("todo-unchecked") 也到这里）；
  // 请假待补课、跟进任务、续费提醒的完整页保留可直接访问（收件箱里选中该类时有入口），只是不再单独占二级菜单。
  (globalThis.fqNavHooks ||= []).push((daily, manage, register) => {
    const g = daily.find((x) => x && x.key === "todo");
    if (!g) return;
    const fn = (c) => {
      st.type = preset ?? "";
      preset = null;
      st.open = null;
      st.more = false;
      inbox.ctx = null;
      return todoPage(c);
    };
    let route = null;
    for (const m of ["schedule", "attendance", "followup", "packages", "leads", "home"]) if (!route) route = register(INBOX, "全部待办", m, fn);
    if (!route) return;
    const rest = g.tabs.filter((t) => t && t.key !== INBOX);
    g.tabs = [route, ...rest];
    for (const t of rest) routeKeys.add(t.key);
    for (const list of [daily, manage]) for (const x of list) for (const t of x?.tabs || []) if (t?.key === "enrol-leads") routeKeys.add(t.key);
  });
  globalThis.FengqinToday = { todayPage, todoPage };
})();
