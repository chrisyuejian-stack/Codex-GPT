// 枫琴教务中心 · 今天与待办（设计稿 02、03）。
// 加载在 v2today.js、yx-home.js 之后：通过重新赋值 `home` 接管今天页；通过 globalThis.fqNavHooks 把待办换成一个收件箱。
// 今天 = 今天在发生什么：四张统计卡、今日课程时间线、右栏（今天要处理摘要、本周小结、通知）。
// 待办 = 收件箱：条目、各类型计数、范围（我负责的 / 全部）都来自后端汇总接口 /api/todo/inbox，“稍后”写 /api/todo/snooze
// （见 docs/fengqin/接口变更.md「任务 3 · 待办收件箱」）。按已逾期 / 今天 / 本周晚些时候 / 更晚分组（北京时间）。
// 原来的请假待补课、跟进任务、续费提醒三个完整页并进收件箱：旧地址进入收件箱并预选对应类型；
// 它们独有的操作（批量续费提醒、提醒规则、指派跟进、已完成的跟进）在选中该类型时出现。
// 写入沿用原来的表单与接口（点名面板、补课面板、缴费核对、续费提醒、跟进任务 PATCH、线索 PATCH）。
(() => {
  "use strict";
  const n = el,
    F = UI.fmt,
    R = () => globalThis.ChannelRebuild,
    Pay = () => globalThis.ChannelV2Pay;
  const prevHome = home;
  const go = (hash) => (location.hash = hash);
  const INBOX = "todo-unchecked";
  // 收件箱的类型（左侧筛选的顺序）：接口里的 type、名称、胶囊色调、样式用的短名。
  const TYPES = [
    ["attendance", "点名销课", "err", "lesson"],
    ["lead_followup", "线索回访", "info", "lead"],
    ["renewal", "续费提醒", "warn", "renewal"],
    ["makeup", "请假补课", "blue", "makeup"],
    ["student_followup", "学员跟进", "muted", "follow"],
    ["payment_check", "收款核对", "ok", "payment"],
  ];
  const typeOf = (k) => TYPES.find((t) => t[0] === k) || TYPES[0];
  // 原来的完整页 → 收件箱里预选的类型（别处 navigate("todo-renewal") 仍能到对的地方）。
  const LEGACY = { "todo-makeup": "makeup", "todo-followup": "student_followup", "todo-renewal": "renewal" };
  const GROUPS = [
    ["late", "已逾期"],
    ["today", "今天"],
    ["later", "本周晚些时候"],
    ["future", "更晚 · 无固定期限"],
  ];
  // 主按钮：primary_action.kind → [按钮文字, 置灰时的说明]。
  const ACTIONS = {
    lesson_attendance: ["点名", "当前账号没有点名销课权限"],
    confirm_submission: ["确认出勤", "当前账号没有确认出勤的权限"],
    contact_lead: ["记录回访", "当前账号没有编辑线索的权限"],
    renewal: ["发提醒", "当前账号没有查看课时包的权限"],
    schedule_makeup: ["安排补课", "当前账号没有排课权限"],
    student_followup: ["记录回访", "当前账号没有编辑跟进任务的权限"],
    student_stage: ["更新阶段", "当前账号没有编辑学员的权限"],
    resolve_payment: ["去核对", "当前账号没有编辑学费的权限"],
    price_package: ["补价格", "当前账号没有编辑课时包的权限"],
  };
  const INLINE = new Set(["contact_lead", "student_followup"]);
  // 页面状态：收件箱筛选、展开项、加载页数；今天页的折叠。
  const st = { who: "mine", type: "", open: null, more: false, later: false, pages: 1, onlyLate: false, showDone: false, showEvening: false };
  let preset = null;

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
  // 下拉菜单（UI.actionMenu）：出错统一提示。
  const menu = (label, items) => {
    const m = UI.actionMenu({
      label,
      items: items.filter(Boolean).map((x) => ({
        ...x,
        onSelect: async () => {
          try {
            await x.onSelect();
          } catch (err) {
            notice(err.message || String(err));
          }
        },
      })),
    });
    m.element.classList.add("fq-menu");
    return m.element;
  };
  const endMs = (r) => Date.parse(r.start_at) + (Number(r.duration) || 0) * 60000;
  const ago = (ms) => {
    const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
    if (m < 60) return m + " 分钟";
    if (m < 24 * 60) return Math.floor(m / 60) + " 小时";
    return Math.floor(m / 1440) + " 天";
  };
  const dayOf = (iso) => String(iso || "").slice(0, 10);
  const hourOf = (iso) => Number(F.time(iso).slice(0, 2));
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

  // ---------- 收件箱接口 ----------
  // 接口返回的时间都是北京时间 ISO 字符串（+08:00），前 10 位就是北京日期。
  const inboxUrl = (q) =>
    "todo/inbox?" +
    new URLSearchParams(
      Object.entries(q)
        .filter(([, v]) => v !== "" && v !== null && v !== undefined)
        .map(([k, v]) => [k, String(v)]),
    ).toString();
  const sumActive = (counts) => Object.values(counts || {}).reduce((s, x) => s + (x.active || 0), 0);
  // 侧栏“待办”角标（app.js 的 refreshCounts 调用）：与收件箱“我负责的”总数同一个数。
  globalThis.fqTodoCount = async () => (await api(inboxUrl({ scope: "mine", limit: 1 }))).total;
  const snoozeItem = (it, until) => api("todo/snooze", "POST", { item_key: it.item_key, version: it.version, until });
  const isSnoozed = (it) => !!it.snoozed_until && Date.parse(it.snoozed_until) > Date.now();
  function groupOf(it, today, sunday) {
    if (it.overdue) return "late";
    const d = dayOf(it.effective_due_at);
    if (!d) return "future";
    if (d <= today) return "today";
    return d <= sunday ? "later" : "future";
  }
  // 条目第二行：原因 · 时间 · 负责人。
  function detailOf(it, today) {
    const at = it.effective_due_at,
      d = dayOf(at),
      t = String(at || "").slice(11, 16),
      ms = Date.parse(at);
    let when;
    if (isSnoozed(it)) when = "已推迟到 " + shortDay(dayOf(it.snoozed_until), today) + " " + it.snoozed_until.slice(11, 16);
    else if (!at) when = "无固定期限";
    else if (it.type === "attendance" && it.subtype === "checkin") when = shortDay(d, today) + " " + t + " 下课" + (it.overdue ? " · 已过 " + ago(ms) : "");
    else if (it.type === "attendance") when = shortDay(d, today) + " " + t + " 提交";
    else if (it.overdue) when = "原定 " + shortDay(d, today) + " · 已过 " + ago(ms);
    else when = shortDay(d, today) + (t && t !== "18:00" ? " " + t : "") + "到期";
    return [it.reason, when, it.assignee?.name ? "负责人 " + it.assignee.name : ""].filter(Boolean).join(" · ");
  }
  const actionLabel = (it) => {
    const a = it.primary_action || {};
    if (a.kind === "renewal" && !enabled("exports", "export")) return enabled("packages", "create") ? "加课时包" : "查看学员";
    return (ACTIONS[a.kind] || ["处理"])[0];
  };

  // ---------- 读数据（今天页） ----------
  async function load() {
    const day = todayBJ();
    const may = (ok, run) => (ok ? run().catch(() => null) : Promise.resolve(null));
    const [data, sched, unchecked, subs, makeups, leads, inbox, att] = await Promise.all([
      api("c2/home"),
      may(enabled("schedule"), () => api("schedule?from=" + day + "&to=" + dateShift(day, 1))),
      may(enabled("schedule") && enabled("attendance", "update"), () => R().take("c2/unchecked")),
      may(enabled("attendance", "confirm"), () => api("submissions?status=pending&from=" + dateShift(day, -60) + "&to=" + dateShift(day, 1) + "&offset=0")),
      may(enabled("attendance", "create"), () => api("c2/makeups?offset=0")),
      may(enabled("leads"), () => R().take("tools/leads")),
      may(true, () => api(inboxUrl({ scope: "mine", limit: 1 }))),
      may(true, () => api(inboxUrl({ scope: "all", type: "attendance", limit: 100 }))),
    ]);
    const extra = new Map((sched?.items || []).map((x) => [x.id, x]));
    for (const row of data.lessons || []) {
      const s = extra.get(row.id);
      if (s) for (const k of ["category_color", "review_status", "review_kind", "format", "version"]) row[k] ??= s[k];
    }
    return { day, data, unchecked, subs, makeups, leads, inbox, att };
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

  // ---------- 主按钮与条目菜单（写入都沿用原来的函数与接口） ----------
  // 就地填写（线索回访、学员跟进）要用原记录的最新版本：打开时按 id 读一次，本次刷新内缓存。
  const recs = new Map();
  async function recordOf(it) {
    if (recs.has(it.item_key)) return recs.get(it.item_key);
    const a = it.primary_action;
    const rec = (await api((a.kind === "contact_lead" ? "tools/leads/" : "tools/followup_tasks/") + encodeURIComponent(a.id))).record;
    recs.set(it.item_key, rec);
    return rec;
  }
  // 续费分组与原续费提醒页同一份数据（c2/renewals），按 学员 + 范围 对上收件箱条目。
  async function renewalRows(items) {
    const rows = await R().take("c2/renewals");
    const byId = new Map(rows.map((r) => [r.id, r]));
    return items
      .map((it) => {
        const a = it.primary_action;
        return [it, byId.get(JSON.stringify([a.student_id, a.scope_kind, a.scope_id])) || rows.find((r) => r.student_id === a.student_id && (r.course_type_id || r.reminder_course_type_id) === a.course_type_id)];
      })
      .filter(([, r]) => r);
  }
  // 收款核对：原“财务 · 待核对”列表放进抽屉（关联课时包 / 转预收余额 / 记为其他收入），关掉后刷新。
  async function paymentDrawer(reload) {
    const view = UI.drawer({ title: "收款核对" });
    view.element.addEventListener("close", () => void reload(), { once: true });
    const box = n("div", null, { class: "fq-drawer-pay" });
    view.body.append(box);
    const draw = async () => {
      box.replaceChildren();
      await Pay().pendingList(box, draw);
    };
    await draw();
  }
  async function runPrimary(it, reload) {
    const a = it.primary_action;
    switch (a.kind) {
      case "lesson_attendance":
      case "confirm_submission":
        return lessonDetail(sinkTo(reload), { id: a.lesson_id, status: "planned" });
      case "renewal": {
        if (!enabled("exports", "export")) {
          if (enabled("packages", "create")) return creditForm(sinkTo(reload), "packages", { student_id: a.student_id, course_type_id: a.course_type_id });
          return R().goStudent(a.student_id, "packages");
        }
        const [pair] = await renewalRows([it]);
        if (!pair) throw Error("这条续费记录已经变化，请刷新后再试");
        return remindRenewal(pair[1], reload);
      }
      case "schedule_makeup": {
        const l = (await api("data/lessons/" + a.lesson_id)).record;
        return makeupForm(sinkTo(reload), l, l.participants.find((x) => x.id === a.original_participant_id) || l.participants[0]);
      }
      case "student_stage":
        return R().goStudent(a.student_id, "stages");
      case "resolve_payment":
        return paymentDrawer(reload);
      case "price_package": {
        const data = await api("credits/payments/pending");
        const p = (data.packages_without_price || []).find((x) => x.id === a.id);
        if (!p) throw Error("这个课时包已经补过价格，请刷新");
        return Pay().priceForm(p, () => reload());
      }
      default:
        throw Error("这类待办暂不支持在这里处理");
    }
  }
  // 学员跟进：指派给…（原“转给…”，负责人名单 followup-assignees）。
  async function assignFollowup(it, reload) {
    const [people, t] = await Promise.all([api("followup-assignees"), recordOf(it)]);
    const view = UI.overlay({ title: "指派给谁负责", kind: "modal" });
    const box = n("div", null, { class: "fq-people" });
    for (const p of people.items || []) {
      const b = button(p.name, async () => {
        await followupSave(t, { assignee_id: p.id });
        await view.close();
        notice("已指派给 " + p.name, "success");
        await reload();
      });
      if (p.id === t.assignee_id) b.setAttribute("aria-current", "true");
      box.append(b);
    }
    if (!box.children.length) box.append(n("p", "还没有可以指派的账号。", { class: "fq-note is-muted" }));
    view.body.append(box);
  }
  function itemMenu(it, reload) {
    const a = it.primary_action || {},
      items = [];
    if (a.kind === "student_followup" && enabled("followup", "update")) {
      items.push({ label: "指派给…", onSelect: () => assignFollowup(it, reload) });
      items.push({
        label: "标记完成",
        onSelect: async () => {
          await followupSave(await recordOf(it), { done: true });
          notice("已标记完成", "success");
          await reload();
        },
      });
    }
    if (a.kind === "contact_lead") items.push({ label: "查看线索", onSelect: async () => openLead(await recordOf(it), reload) });
    if (a.kind === "renewal") {
      if (enabled("followup", "create")) items.push({ label: "记录联系", onSelect: () => followupForm(sinkTo(reload), "followup_notes", a.student_id) });
      if (enabled("packages", "create") && enabled("exports", "export"))
        items.push({ label: "加课时包", onSelect: () => creditForm(sinkTo(reload), "packages", { student_id: a.student_id, course_type_id: a.course_type_id }) });
    }
    if (a.kind === "confirm_submission" || a.kind === "lesson_attendance") items.push({ label: "查看课程", onSelect: () => lessonDetail(sinkTo(reload), { id: a.lesson_id, status: "planned" }) });
    if (a.student_id && enabled("students") && a.kind !== "student_stage")
      items.push({ label: "查看学员", onSelect: () => R().goStudent(a.student_id, a.kind === "renewal" ? "packages" : a.kind === "student_followup" ? "followup" : "overview") });
    return items.length ? menu("更多", items) : null;
  }
  function laterMenu(it, reload) {
    const pick = (until, text) => async () => {
      await snoozeItem(it, until);
      notice("已推迟到" + text, "success");
      if (st.open === it.item_key) st.open = null;
      await reload();
    };
    return menu("稍后", [
      { label: "明天 9:00", onSelect: pick("tomorrow", "明天") },
      { label: "下周一 9:00", onSelect: pick("next_week", "下周一") },
    ]);
  }

  // ---------- 续费：批量提醒、提醒规则 ----------
  async function batchRenewal(items, reload) {
    const pairs = await renewalRows(items);
    if (!pairs.length) throw Error("现在没有要提醒续费的学员");
    const brand = await api("renewal-brand");
    const view = UI.drawer({ title: "批量续费提醒", subtitle: "勾选学员，逐个生成提醒；复制文字或保存图片后自动记一次“上次提醒”。" });
    view.element.addEventListener("close", () => void reload(), { once: true });
    const box = n("div", null, { class: "fq-batch" });
    view.body.append(box);
    const picked = new Set(pairs.map(([, r]) => r.id));
    const pickList = () => {
      box.replaceChildren();
      const list = n("div", null, { class: "fq-batch-list" });
      for (const [it, r] of pairs) {
        const lab = n("label", null, { class: "fq-batch-row" });
        const ck = n("input", null, { type: "checkbox" });
        ck.checked = picked.has(r.id);
        ck.addEventListener("change", () => {
          ck.checked ? picked.add(r.id) : picked.delete(r.id);
          const face = go2.querySelector(".ui-button-face > span:last-child") || go2;
          face.textContent = "生成 " + picked.size + " 份提醒";
        });
        const who = n("span", null, { class: "fq-batch-who" });
        who.append(n("b", it.title), n("span", it.reason + " · 剩 " + F.units(r.balance)));
        lab.append(ck, who);
        list.append(lab);
      }
      const go2 = button("生成 " + picked.size + " 份提醒", () => {
        const rows = pairs.map(([, r]) => r).filter((r) => picked.has(r.id));
        if (!rows.length) throw Error("请先勾选要提醒的学员");
        return show(rows, 0);
      }, "primary");
      box.append(list, go2);
    };
    const show = async (rows, i) => {
      box.replaceChildren();
      const head = n("div", null, { class: "fq-batch-nav" });
      const back = button("‹ 重新勾选", () => pickList(), "link");
      const prev = button("上一位", () => show(rows, i - 1)),
        next = button("下一位", () => show(rows, i + 1));
      prev.disabled = i === 0;
      next.disabled = i === rows.length - 1;
      head.append(back, n("span", i + 1 + " / " + rows.length + " · " + rows[i].student_name), prev, next);
      const body = n("div", null, { class: "v-rn" });
      box.append(head, body);
      await renewalNotice(body, brand, rows[i]);
    };
    pickList();
  }
  async function renewalRules(reload) {
    const { settings } = await api("renewal-settings");
    const view = UI.formDialog(
      [
        { name: "low_balance_threshold", label: "低余额课时", type: "number", value: settings.low_balance_threshold },
        { name: "expiry_warning_days", label: "提前提醒天数", type: "number", value: settings.expiry_warning_days },
      ],
      { title: "续费提醒规则" },
    );
    view.body.prepend(n("p", "剩余课时不超过“低余额课时”，或课时包在“提前提醒天数”内到期，就会出现在续费提醒里。", { class: "ui-muted" }));
    submit(view.form, "保存规则", async (d) => {
      await api("renewal-settings", "PUT", {
        low_balance_threshold: Number(d.low_balance_threshold),
        expiry_warning_days: Number(d.expiry_warning_days),
      });
      await view.close();
      notice("提醒规则已保存", "success");
      await reload();
    });
  }

  // ---------- 学员跟进：已完成的跟进 ----------
  async function doneFollowups(reload) {
    const view = UI.drawer({ title: "已完成的跟进", subtitle: "最近完成的跟进任务；需要时可以重新打开。" });
    let changed = false;
    view.element.addEventListener("close", () => changed && void reload(), { once: true });
    const box = n("div", null, { class: "fq-drawer-list" });
    view.body.append(box);
    const draw = async () => {
      const data = await api("c2/followups?group=done&owner=&offset=0");
      box.replaceChildren();
      const rows = (data.items || []).filter((t) => t.id && t.version !== undefined);
      if (!rows.length) box.append(n("p", "最近没有完成的跟进任务。", { class: "fq-note is-muted" }));
      for (const t of rows) {
        const line = n("div", null, { class: "fq-drawer-row" });
        const who = n("div", null, { class: "fq-who" });
        who.append(n("b", (t.student_name ? t.student_name + " · " : "") + t.title), n("span", "原定 " + (t.due_date ? F.day(t.due_date) : "未定") + " · 负责人 " + (t.assignee_name || "待指派")));
        line.append(who);
        if (enabled("followup", "update"))
          line.append(
            button("重新打开", async () => {
              await followupSave(t, { done: false });
              changed = true;
              notice("已重新打开，回到收件箱", "success");
              await draw();
            }),
          );
        box.append(line);
      }
    };
    await draw();
  }

  // ---------- 已推迟：查看与撤回 ----------
  async function snoozedDrawer(base, reload) {
    const view = UI.drawer({ title: "已推迟的待办", subtitle: "到时间会自动回到收件箱；撤回后马上回来。" });
    let changed = false;
    view.element.addEventListener("close", () => changed && void reload(), { once: true });
    const box = n("div", null, { class: "fq-drawer-list" });
    view.body.append(box);
    const today = todayBJ();
    const draw = async () => {
      // 推迟中的条目排在所有未推迟条目之后：从 total 开始读。
      const head = await api(inboxUrl({ ...base, limit: 1 }));
      const rows = [];
      for (let offset = head.total, guard = 0; offset !== null && guard < 20; guard++) {
        const p = await api(inboxUrl({ ...base, include_snoozed: 1, offset, limit: 100 }));
        rows.push(...p.items.filter(isSnoozed));
        offset = p.next_offset;
      }
      box.replaceChildren();
      if (!rows.length) box.append(n("p", "没有推迟中的待办。", { class: "fq-note is-muted" }));
      for (const it of rows) {
        const line = n("div", null, { class: "fq-drawer-row" });
        const [, tlabel, tone] = typeOf(it.type);
        const who = n("div", null, { class: "fq-who" });
        who.append(n("b", it.title), n("span", detailOf(it, today)));
        line.append(pill(tlabel, tone), who);
        line.append(
          button("撤回", async () => {
            await snoozeItem(it, "clear");
            changed = true;
            notice("已撤回，回到收件箱", "success");
            await draw();
            vHead?.refresh?.();
          }),
        );
        box.append(line);
      }
    };
    await draw();
  }

  // ---------- 待办 · 收件箱 ----------
  const inbox = { data: null };
  async function fetchInbox() {
    const base = { scope: st.who, type: st.type };
    const other = { scope: st.who === "mine" ? "all" : "mine", limit: 1 };
    const [first, otherData] = await Promise.all([api(inboxUrl({ ...base, limit: 100 })), api(inboxUrl(other)).catch(() => null)]);
    const items = [...first.items];
    let next = first.next_offset;
    for (let i = 1; i < st.pages && next !== null && next !== undefined; i++) {
      const p = await api(inboxUrl({ ...base, offset: next, limit: 100 }));
      items.push(...p.items);
      next = p.next_offset;
    }
    return { ...first, items, next_offset: next, base, other: otherData };
  }
  async function todoPage(c, quick) {
    const data = quick && inbox.data ? inbox.data : await fetchInbox();
    if (!quick) recs.clear();
    inbox.data = data;
    const reload = async (local) => {
      if (local !== true) {
        inbox.data = null;
        vHead?.refresh?.();
      }
      if (c.isConnected || local !== true) await todoPage(c, local === true);
    };
    const today = todayBJ(),
      [, sunday] = weekBounds(today);
    const total = (counts) => sumActive(counts);
    const mineTotal = st.who === "mine" ? total(data.counts) : data.other ? total(data.other.counts) : null,
      allTotal = st.who === "all" ? total(data.counts) : data.other ? total(data.other.counts) : null;
    vHead?.sub("处理完的事自动消失；“稍后”可推迟到明天或下周");
    const seg = n("div", null, { class: "fq-seg", role: "group", "aria-label": "范围" });
    for (const [k, label, count] of [
      ["mine", "我负责的", mineTotal],
      ["all", "全部", allTotal],
    ]) {
      const b = n("button", label + (count === null ? "" : " " + count), { type: "button", "aria-pressed": String(st.who === k) });
      b.addEventListener("click", () => {
        st.who = k;
        st.pages = 1;
        st.open = null;
        void reload();
      });
      seg.append(b);
    }
    // 顶部按钮：选中某一类时出现原完整页独有的操作。
    const tops = [];
    if (st.type === "renewal") {
      if (enabled("exports", "export")) tops.push(act("批量提醒", () => batchRenewal(data.items.filter((x) => x.type === "renewal"), reload), "soft"));
      if (me.user.roles.includes("supervisor")) tops.push(act("提醒规则", () => renewalRules(reload)));
    }
    if (st.type === "student_followup" && enabled("followup")) tops.push(act("已完成的跟进", () => doneFollowups(reload)));
    if ((!st.type || st.type === "student_followup") && enabled("followup", "create")) tops.push(act("＋ 新建跟进", () => followupForm(sinkTo(reload), "followup_tasks"), "ink"));
    vHead?.bar();
    vHead?.actions(seg, ...tops);
    c.replaceChildren();
    c.classList.add("fq-todo");
    c.dataset.page = "todo";

    const layout = n("div", null, { class: "fq-todo-cols" });
    // 左：按类型筛选（计数来自接口 counts，与当前类型和分页无关）
    const filt = n("nav", null, { class: "fq-card fq-filt", "aria-label": "按类型筛选" });
    const count = (k) => (k ? data.counts?.[k]?.active || 0 : total(data.counts));
    for (const [k, label] of [["", "全部"], ...TYPES.map((t) => [t[0], t[1]])]) {
      const on = st.type === k;
      const short = k ? typeOf(k)[3] : "";
      const b = n("button", null, { type: "button", class: cls("fq-filt-item", on && "is-on", short && "is-" + short), "aria-pressed": String(on), "data-type": k || "all" });
      const name = n("span", null, { class: "fq-filt-name" });
      if (k) name.append(n("i", null, { class: "fq-dot is-" + short, "aria-hidden": "true" }));
      name.append(label);
      const late = k ? data.counts?.[k]?.overdue || 0 : 0;
      b.append(name, n("span", String(count(k)), { class: cls("fq-filt-count", late && "is-late"), title: late ? "其中已逾期 " + late + " 条" : "" }));
      b.addEventListener("click", () => {
        st.type = k;
        st.more = false;
        st.pages = 1;
        st.open = null;
        void reload();
      });
      filt.append(b);
    }
    // 右：清单
    const list = n("section", null, { class: "fq-card fq-inbox", "aria-label": "待办清单" });
    const shown = data.items.map((it) => ({ ...it, group: groupOf(it, today, sunday) }));
    const folded = (g) => (g === "later" || g === "future") && !st.later && !st.type;
    const inlineKeys = GROUPS.flatMap(([g]) => (folded(g) ? [] : shown.filter((x) => x.group === g)))
      .filter((x) => INLINE.has(x.primary_action?.kind) && x.primary_action.enabled)
      .map((x) => x.item_key);
    // 就地填写需要原记录：先读好再画。
    const openItem = st.open && shown.find((x) => x.item_key === st.open);
    if (st.open && !openItem) st.open = null;
    let openRec = null;
    if (openItem)
      try {
        openRec = await recordOf(openItem);
      } catch (err) {
        notice(err.message || String(err));
        st.open = null;
      }
    if (data.snoozed_count) {
      const p = n("p", "已推迟 " + data.snoozed_count + " 条，到时间会自动回来。", { class: "fq-later fq-snoozed" });
      p.append(textLink("查看或撤回", () => snoozedDrawer(data.base, reload)));
      list.append(p);
    }
    if (!shown.length) {
      const empty = n("div", null, { class: "fq-empty" });
      const elsewhere = st.who === "mine" && allTotal > mineTotal;
      empty.append(
        n("p", st.type && total(data.counts) ? "这一类现在没有要处理的事。" : "都处理完了。", { class: "fq-empty-title" }),
        n("p", elsewhere ? "切到“全部”可以看别人负责的事。" : "新的待办会自动出现在这里。", { class: "fq-empty-sub" }),
      );
      list.append(empty);
    }
    for (const [g, label] of GROUPS) {
      const rows = shown.filter((x) => x.group === g);
      if (!rows.length) continue;
      list.append(n("p", label + " · " + rows.length, { class: "fq-grp is-" + g }));
      // 本周晚些时候与更晚：看“全部”时默认收起，只说有哪些。
      if (folded(g)) {
        const by = new Map();
        for (const r of rows) by.set(r.type, (by.get(r.type) || 0) + 1);
        const p = n("p", [...by].map(([k, v]) => v + " 条" + typeOf(k)[1]).join("、") + (g === "later" ? "，到期那天会移到“今天”。" : "。"), { class: "fq-later" });
        p.append(
          textLink("展开", () => {
            st.later = true;
            return reload(true);
          }),
        );
        list.append(p);
        continue;
      }
      // 看“全部”类型时每组每类最多列 4 条，其余收成一行“还有 N 条… →”（点了只看这一类）。
      const seen = new Map(),
        rest = new Map();
      const visible = rows.filter((r) => {
        const k = (seen.get(r.type) || 0) + 1;
        seen.set(r.type, k);
        if (st.type || st.more || k <= 4 || r.item_key === st.open) return true;
        rest.set(r.type, (rest.get(r.type) || 0) + 1);
        return false;
      });
      for (const it of visible) {
        const a = it.primary_action || { kind: "", enabled: false };
        const open = st.open === it.item_key && openRec;
        const wrap = open ? n("div", null, { class: "fq-item-open" }) : null;
        const line = n("div", null, { class: "fq-item", "data-key": it.item_key });
        const [, tlabel, tone] = typeOf(it.type);
        const who = n("div", null, { class: "fq-who" });
        who.append(n("b", it.title), n("span", detailOf(it, today)));
        line.append(pill(tlabel, tone), who);
        const ops = n("div", null, { class: "fq-ops" });
        const view = { ...it, lead: a.kind === "contact_lead" ? openRec : null, task: a.kind === "student_followup" ? { student_name: "", ...openRec } : null };
        if (open) {
          if (view.lead?.phone && enabled("leads", "update"))
            ops.append(
              act(
                "拨打电话",
                async () => {
                  const ct = await api("tools/leads/" + view.lead.id + "/contact", "POST", {});
                  if (ct.phone) location.href = "tel:" + ct.phone;
                  else notice("这条线索没有登记手机号");
                },
                "soft",
              ),
            );
          if (view.lead) ops.append(textLink("查看线索", () => openLead(view.lead, reload)));
        } else {
          ops.append(laterMenu(it, reload));
          const more = itemMenu(it, reload);
          if (more) ops.append(more);
          const main = act(
            actionLabel(it),
            async () => {
              if (INLINE.has(a.kind)) {
                await recordOf(it);
                st.open = it.item_key;
                return reload(true);
              }
              return runPrimary(it, reload);
            },
            "ink",
          );
          if (!a.enabled) {
            main.disabled = true;
            main.title = (ACTIONS[a.kind] || [, "当前账号不能处理这条待办"])[1];
            main.classList.add("is-off");
            ops.append(n("span", main.title, { class: "fq-noperm" }));
          }
          ops.append(main);
        }
        line.append(ops);
        if (wrap) {
          const i = inlineKeys.indexOf(it.item_key);
          wrap.append(line, a.kind === "contact_lead" ? leadInline(view, reload, inlineKeys[i + 1]) : followInline(view, reload, inlineKeys[i + 1]));
          list.append(wrap);
        } else list.append(line);
      }
      for (const [k, v] of rest) {
        const more = textLink("还有 " + v + " 条" + typeOf(k)[1] + " →", () => {
          st.type = k;
          st.pages = 1;
          return reload();
        });
        more.classList.add("fq-more");
        list.append(more);
      }
    }
    if (data.next_offset !== null && data.next_offset !== undefined) {
      const more = textLink("再加载 " + Math.min(100, data.total - data.items.length) + " 条（共 " + data.total + " 条）", () => {
        st.pages += 1;
        return reload();
      });
      more.classList.add("fq-more");
      list.append(more);
    }
    layout.append(filt, list);
    c.append(layout);
    // 手机上类型筛选是横向滚动的一行：把选中的类型滚到可见处。
    setTimeout(() => {
      const on = filt.querySelector(".is-on");
      if (on && filt.scrollWidth > filt.clientWidth) filt.scrollLeft = Math.max(0, on.offsetLeft - filt.offsetLeft - 12);
    }, 0);
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

  // “今天要处理”：数字来自收件箱（我负责的），与侧栏角标、“待办”统计卡同一个数。
  function summaryPanel(inboxData) {
    const box = n("section", null, { class: "fq-card fq-sum" });
    box.append(n("div", null, { class: "fq-ribbon", "aria-hidden": "true" }));
    const head = n("div", null, { class: "fq-ph" });
    const ht = n("div");
    ht.append(n("h2", "今天要处理"), n("p", "完整清单在待办"));
    const counts = inboxData?.counts || {};
    const all = inboxData ? inboxData.total : 0;
    head.append(ht, textLink("全部 " + all + " 件 →", () => toTodo("")));
    box.append(head);
    const k = (type) => counts[type]?.active || 0;
    const lines = [
      ["attendance", k("attendance"), (x) => x + " 节课待点名或确认", ["逾期", "err"]],
      ["lead_followup", k("lead_followup"), (x) => x + " 条线索要回访", ["线索", "info"]],
      ["renewal", k("renewal"), (x) => x + " 位学员要续费", ["续费", "warn"]],
      ["makeup", k("makeup"), (x) => x + " 位请假待补课", ["补课", "blue"]],
      ["student_followup", k("student_followup"), (x) => x + " 条学员跟进", ["跟进", "muted"]],
      ["payment_check", k("payment_check"), (x) => x + " 笔收款或课时包待核对", ["收款", "ok"]],
    ].filter((x) => x[1]);
    if (!inboxData) box.append(n("p", "待办数字暂时读不到，稍后刷新。", { class: "fq-sum-empty" }));
    else if (!lines.length) box.append(n("p", "今天没有要处理的事，都清空了。", { class: "fq-sum-empty" }));
    for (const [type, x, text, [tag, tone]] of lines.slice(0, 4)) {
      const row = n("button", null, { type: "button", class: "fq-sum-row" });
      const late = counts[type]?.overdue || 0;
      row.append(n("span", text(x) + (late && type !== "attendance" ? "（逾期 " + late + "）" : "")), pill(tag, tone));
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
    // 待点名：全机构下课未点名 + 老师已提交待确认（收件箱 attendance 条目，与时间线同一口径）。
    if (ctx.att) {
      const rows = ctx.att.items || [],
        total = ctx.att.total,
        subsN = rows.filter((x) => x.subtype === "confirm").length,
        todayLate = rows.filter((x) => x.subtype === "checkin" && dayOf(x.due_at) === ctx.day).length,
        earlier = total - subsN - todayLate;
      const foot = total ? [todayLate ? "今天 " + todayLate + " 节" : "", earlier > 0 ? "更早 " + earlier + " 节" : "", subsN ? "老师提交 " + subsN : ""].filter(Boolean).join(" · ") : "下课的课都点过名了";
      stats.append(statCard("待点名", total, foot, { icon: "warning", tone: total ? "red" : "", onClick: () => toTodo("attendance") }));
    }
    if (ctx.leads) {
      const trials = ctx.leads.filter((l) => l.trial_at && dayOf(l.trial_at) === ctx.day && l.stage !== "lost").sort((a, b) => a.trial_at.localeCompare(b.trial_at));
      stats.append(statCard("今日试听", trials.length, trials.length ? trials.map((l) => F.time(l.trial_at)).join(" · ") : "今天没有约试听", { icon: "filter", onClick: () => go("enrol-leads") }));
    }
    // 待办：与侧栏角标、“今天要处理”同一个数（收件箱“我负责的”总数）。
    const late = sumActive(ctx.inbox?.counts) ? Object.values(ctx.inbox.counts).reduce((s, x) => s + (x.overdue || 0), 0) : 0;
    stats.append(statCard("待办", ctx.inbox ? ctx.inbox.total : "—", ctx.inbox && late ? "已逾期 " + late + " 件 · 打开待办 →" : "打开待办 →", { icon: "check", onClick: () => toTodo(""), footLink: true }));
    c.append(stats);
    // 主体：时间线 + 右栏
    const cols = n("div", null, { class: "fq-today-cols" });
    const main = n("div", null, { class: "fq-today-main" });
    if (ctx.data.lessons) main.append(timeline(c, ctx, reload));
    else main.append(summaryPanel(ctx.inbox));
    const side = n("div", null, { class: "fq-today-side", role: "complementary", "aria-label": "今天要处理与本周小结" });
    if (ctx.data.lessons) side.append(summaryPanel(ctx.inbox));
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
  // 原来的 todo-unchecked 地址进入收件箱（别处 navigate("todo-unchecked") 也到这里）。
  // 请假待补课、跟进任务、续费提醒不再是独立页面：旧地址换成“进入收件箱并预选对应类型”（替换历史记录，不多一步返回）。
  (globalThis.fqNavHooks ||= []).push((daily, manage, register) => {
    const g = daily.find((x) => x && x.key === "todo");
    if (!g) return;
    const fn = (c) => {
      st.type = preset ?? "";
      preset = null;
      st.open = null;
      st.more = false;
      st.later = false;
      st.pages = 1;
      inbox.data = null;
      return todoPage(c);
    };
    let route = null;
    for (const m of ["schedule", "attendance", "followup", "packages", "leads", "home"]) if (!route) route = register(INBOX, "全部待办", m, fn);
    if (!route) return;
    const rest = g.tabs.filter((t) => t && t.key !== INBOX);
    for (const [key, type] of Object.entries(LEGACY)) {
      const redirect = () => {
        preset = type;
        location.replace("#" + INBOX);
      };
      const t = rest.find((x) => x.key === key);
      if (t) t.fn = redirect;
      else register(key, typeOf(type)[1], "home", redirect);
    }
    g.tabs = [route, ...rest.filter((t) => !LEGACY[t.key])];
  });
  globalThis.FengqinToday = { todayPage, todoPage };
})();
