// 枫琴教务中心 · 线索（第三期设计稿 design/redesign/leads，DECISIONS 8–10）。
// 加载在最后：重新赋值 `leadsPage`（路由 enrol-leads）、`leadForm`（登记/编辑表单，来源改为固定选项）、
// ChannelC3.leadDetail（今天/待办页“查看线索”打开的详情），并导出 globalThis.FQLeads.followup 给待办页“记录回访”。
// 写入沿用原接口：tools/leads（POST/PATCH/DELETE）、/contact、/convert；新增回访记录 tools/leads/:id/followups（0033）。
// 旧备注里“MM-DD 回访：…”的行继续只读显示在回访记录里。
(() => {
  "use strict";
  const n = el,
    F = UI.fmt,
    R = () => globalThis.ChannelRebuild,
    P = () => globalThis.ChannelV2People;
  const SVG = "http://www.w3.org/2000/svg";
  const mq = globalThis.matchMedia?.("(max-width: 760px)");
  const isPhone = () => !!mq?.matches;
  const cls = (...xs) => xs.filter(Boolean).join(" ");
  const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  // DECISIONS 8：来源固定选项；旧数据里的自由文本显示为“其他：原文”。
  const SOURCES = ["小红书", "老学员介绍", "大众点评", "抖音", "地推", "其他"];
  const srcKey = (s) => (!s ? "" : SOURCES.includes(s) ? s : "其他");
  const srcLabel = (s) => (!s ? "未填来源" : SOURCES.includes(s) ? s : "其他：" + s);
  const CHANNELS = [
    ["phone", "电话"],
    ["wechat", "微信"],
    ["visit", "到访"],
    ["other", "其他"],
  ];
  const RESULTS = [
    ["trial", "有意向，约试听"],
    ["again", "再跟进"],
    ["noanswer", "没接通"],
    ["lost", "暂不考虑"],
  ];
  const OPEN = ["new", "contacted", "trial"];
  const stageLabel = (s) => me.labels.lead_stages?.[s] || s;
  const STAGE_TONE = { new: "blue", contacted: "info", trial: "warn", enrolled: "ok", lost: "" };

  // ---------- 小工具 ----------
  const day = (v) => (v === null || v === undefined || v === "" ? "" : typeof v === "number" ? new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date(v)) : String(v).slice(0, 10));
  const md = (d) => d.slice(5, 10);
  const wd = (d) => WEEK[new Date(d.slice(0, 10) + "T12:00:00Z").getUTCDay()];
  const dayText = (d) => md(d) + " " + wd(d);
  const hm = (v) => (typeof v === "number" ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(v)) : String(v).slice(11, 16));
  const daysLate = (d) => Math.round((Date.parse(todayBJ() + "T12:00:00Z") - Date.parse(d + "T12:00:00Z")) / 86400000);
  const opId = () => "lfu_" + Array.from(crypto.getRandomValues(new Uint8Array(12)), (x) => x.toString(16).padStart(2, "0")).join("");
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
    phone: [["path", { d: "M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" }]],
    filter: [["path", { d: "M4 5h16l-6 7v6l-4 2v-8Z" }]],
    calendar: [["rect", { x: "3", y: "5", width: "18", height: "16", rx: "3" }], ["path", { d: "M7 3v4m10-4v4M3 11h18" }]],
    check: [["path", { d: "m5 12 4 4L19 6" }]],
    warn: [["path", { d: "M12 4 2.5 20h19Z" }], ["path", { d: "M12 10v4m0 3h.01" }]],
    search: [["circle", { cx: "10.5", cy: "10.5", r: "6.5" }], ["path", { d: "m16 16 4 4" }]],
    grip: [["path", { d: "M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" }]],
    note: [["path", { d: "M5 4h10l4 4v12H5Z" }], ["path", { d: "M9 12h6m-6 4h4" }]],
    back: [["path", { d: "m15 6-6 6 6 6" }]],
    more: [["path", { d: "M6 12h.01M12 12h.01M18 12h.01" }]],
    plus: [["path", { d: "M12 5v14M5 12h14" }]],
  };
  const pill = (text, tone = "", dot = false) => n("span", text, { class: cls("fq-ld-pill", tone && "is-" + tone, dot && "is-dot") });
  function btn(text, fn, kind = "", ic) {
    const b = n("button", null, { type: "button", class: cls("fq-ld-btn", kind && kind.split(" ").map((k) => "is-" + k).join(" ")) });
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
  const link = (text, fn) => {
    const b = n("button", text, { type: "button", class: "fq-ld-link" });
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
  const avatar = (name, extra = "") => n("span", Array.from(String(name || "?").trim())[0] || "?", { class: cls("fq-ld-av", extra), "aria-hidden": "true" });
  const card = (extra = "") => n("section", null, { class: cls("fq-ld-card", extra) });
  function statCard(label, value, foot, { ic, tone, footLink, onClick } = {}) {
    const box = n(onClick ? "button" : "div", null, { class: cls("fq-ld-card fq-ld-stat", onClick && "is-link"), ...(onClick ? { type: "button" } : {}) });
    const head = n("div", null, { class: "fq-ld-stat-head" });
    const i = n("span", null, { class: cls("fq-ld-ic", tone === "red" && "is-red", tone === "ok" && "is-ok") });
    i.append(icon(IC[ic]));
    head.append(n("span", label), i);
    box.append(head, n("div", String(value), { class: cls("fq-ld-num", tone && "is-" + tone) }), n("div", foot, { class: cls("fq-ld-stat-foot", footLink && "is-link") }));
    if (onClick) box.addEventListener("click", onClick);
    return box;
  }
  // 与原线索详情相同：PATCH 带全部字段，不改手机号。
  const patch = (row, changes) =>
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
  async function reveal(row) {
    const ct = await api("tools/leads/" + row.id + "/contact", "POST", {});
    return ct;
  }
  async function dial(row) {
    const ct = await reveal(row);
    if (ct.phone) location.href = "tel:" + ct.phone;
    else notice("这条线索没有登记手机号");
    return ct;
  }

  // 旧备注：“MM-DD 回访：结果（试听 …）；内容”逐行解析；解析不了的行原样保留。
  function legacyLines(note) {
    const visits = [],
      other = [];
    for (const line of String(note || "").split("\n").map((x) => x.trim()).filter(Boolean)) {
      const m = /^(\d{2}-\d{2}) 回访：([^；]+?)(?:；(.*))?$/.exec(line);
      if (m) visits.push({ date: m[1], label: m[2], text: m[3] || "" });
      else other.push(line);
    }
    return { visits, other };
  }
  // 卡片上的最近一次回访摘要：新回访记录优先，没有时取旧备注第一行回访。
  function lastSummary(r) {
    if (r.last_followup_content) return md(day(r.last_followup_at)) + " " + r.last_followup_content;
    const v = legacyLines(r.note).visits[0];
    return v ? v.date + " " + v.label + (v.text ? "：" + v.text : "") : "";
  }
  function lostReason(r) {
    const c = r.last_followup_content;
    if (c && /^暂不考虑/.test(c)) return c.replace(/^暂不考虑[：:]?/, "") || "未填写";
    const lines = legacyLines(r.note);
    const v = lines.visits[0];
    if (v && v.label === "暂不考虑") return v.text || "未填写";
    return lines.other[0] || "未填写";
  }
  // 卡片底部那一行：回访状态 / 试听时间 / 转正 / 流失原因。
  function dueLine(r) {
    const today = todayBJ();
    if (r.stage === "enrolled") return [md(day(r.updated_at)) + " 已转为学员", ""];
    if (r.stage === "lost") return ["原因：" + lostReason(r), ""];
    if (r.next_followup && r.next_followup < today) return ["回访逾期 · " + dayText(r.next_followup), "late"];
    if (r.next_followup === today) return ["今天回访", "today"];
    if (r.stage === "trial") {
      if (!r.trial_at) return ["试听时间待定", "warn"];
      const past = r.trial_at.slice(0, 16) < new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "short" }).format(new Date()).replace(" ", "T");
      return [dayText(r.trial_at) + " " + r.trial_at.slice(11, 16) + (past ? " 已试听" : " 试听"), past ? "" : "info"];
    }
    if (r.next_followup) return [dayText(r.next_followup) + "回访", ""];
    if (r.stage === "new") {
      const d = day(r.created_at);
      return [(d === today ? "今天 " + hm(r.created_at) : dayText(d)) + " 登记 · 待首次回访", "warn"];
    }
    return ["未安排回访", ""];
  }
  const isLate = (r) => OPEN.includes(r.stage) && r.next_followup && r.next_followup < todayBJ();
  const isToday = (r) => OPEN.includes(r.stage) && r.next_followup === todayBJ();

  // ---------- 页面状态 ----------
  const st = { view: "board", source: "", q: "", stage: "open", more: {}, showLater: false, detail: null };
  let current = null; // { c, rows, summary }

  function filtered(rows) {
    const q = st.q.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (!st.source || srcKey(r.source) === st.source) &&
        (!q || [r.name, r.direction, r.grade, r.source, r.phone].join(" ").toLowerCase().includes(q)),
    );
  }
  async function leads(c) {
    if (!c?.isConnected) {
      // 从别处（今天页的详情、新建菜单）保存后回调：不在线索页时只通知宿主刷新。
      c?.replaceChildren(n("span"));
      return;
    }
    const [rows, summary] = await Promise.all([R().take("tools/leads"), api("c3/leads-summary")]);
    current = { c, rows, summary };
    c.classList.add("fq-leads");
    c.dataset.page = "leads";
    if (st.detail && isPhone()) {
      const row = rows.find((r) => r.id === st.detail.id);
      if (row) return pageDetail(c, row, st.detail);
      st.detail = null;
    }
    draw(c);
  }
  function draw(c) {
    const { rows, summary } = current;
    const today = todayBJ(),
      monthStart = Date.parse(today.slice(0, 7) + "-01T00:00:00+08:00");
    const open = rows.filter((r) => OPEN.includes(r.stage));
    const dueToday = open.filter(isToday).length,
      late = open.filter(isLate).length;
    vHead?.sub("进行中 " + open.length + " · 今天回访 " + (dueToday + late) + (late ? "（逾期 " + late + "）" : ""));
    const sources = new Map();
    for (const r of rows.filter((x) => x.created_at >= monthStart)) sources.set(srcKey(r.source) || "未填来源", (sources.get(srcKey(r.source) || "未填来源") || 0) + 1);
    const srcText = [...sources].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => k + " " + v).join(" · ");
    const trials = rows.filter((r) => r.stage === "trial"),
      booked = trials.filter((r) => r.trial_at).length;
    const stats = n("div", null, { class: "fq-ld-stats" });
    stats.append(
      statCard("本月新线索", summary.added, srcText || "本月还没有新线索", { ic: "filter", tone: "violet" }),
      statCard("已试听", summary.trial, "已排时间 " + booked + " · 待排 " + (trials.length - booked), { ic: "calendar" }),
      statCard("本月转正", summary.converted, "转化率 " + summary.conversion_rate + "%", { ic: "check", tone: "ok" }),
      statCard("今天要回访", dueToday + late, late ? "其中已逾期 " + late + " · 去待办处理 →" : dueToday ? "去待办处理 →" : "没有逾期", {
        ic: "warn",
        tone: late || dueToday ? "red" : "",
        footLink: !!(late || dueToday),
        onClick: late || dueToday ? () => (location.hash = "todo-unchecked") : null,
      }),
    );
    const page = n("div", null, { class: "fq-ld-page" });
    const shown = filtered(rows);
    if (isPhone()) {
      vHead?.actions();
      vHead?.bar();
      page.append(phoneTools(c, rows), stats, phoneList(c, shown));
      c.replaceChildren(page);
      return;
    }
    deskTools(c, rows);
    page.append(stats);
    if (st.view === "table") page.append(table(c, shown));
    else page.append(board(c, shown), n("p", "拖动卡片可在相邻阶段间移动（新咨询 ⇄ 跟进中 ⇄ 已试听 ⇄ 已流失）；“已转正”只能在已试听卡片上点“转为正式学员”。", { class: "fq-ld-hint" }));
    c.replaceChildren(page);
  }

  // ---------- 工具行 ----------
  function sourceChips(rows) {
    const box = n("div", null, { class: "fq-ld-chips", role: "group", "aria-label": "来源" });
    const counts = new Map();
    for (const r of rows) counts.set(srcKey(r.source), (counts.get(srcKey(r.source)) || 0) + 1);
    const opts = [["", "全部来源", rows.length], ...SOURCES.filter((s) => counts.get(s)).map((s) => [s, s, counts.get(s)])];
    if (counts.get("")) opts.push(["", "未填来源", counts.get("")]);
    for (const [v, t, k] of opts.slice(0, opts.length - (counts.get("") ? 1 : 0))) {
      const b = n("button", null, { type: "button", class: cls("fq-ld-chip", st.source === v && "is-on"), "aria-pressed": String(st.source === v) });
      b.append(t + " ", n("b", String(k)));
      b.addEventListener("click", () => {
        st.source = v;
        draw(current.c);
      });
      box.append(b);
    }
    return box;
  }
  function searchBox(c) {
    const box = n("label", null, { class: "fq-ld-search" });
    const input = n("input", null, { type: "search", placeholder: "姓名、意向方向", "aria-label": "搜索线索", maxlength: "50" });
    input.value = st.q;
    let t;
    input.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => {
        st.q = input.value;
        draw(c);
        const again = document.querySelector(".fq-ld-search input");
        again?.focus();
        again?.setSelectionRange?.(again.value.length, again.value.length);
      }, 250);
    });
    box.append(icon(IC.search), input);
    return box;
  }
  function deskTools(c, rows) {
    const seg = n("div", null, { class: "fq-ld-seg", role: "group", "aria-label": "视图" });
    for (const [v, t] of [["board", "看板"], ["table", "列表"]]) {
      const b = n("button", t, { type: "button", class: st.view === v ? "is-on" : "", "aria-pressed": String(st.view === v) });
      b.addEventListener("click", () => {
        st.view = v;
        draw(c);
      });
      seg.append(b);
    }
    const bar = n("div", null, { class: "fq-ld-bar-row" });
    bar.append(seg, sourceChips(rows), searchBox(c));
    vHead?.bar(bar);
    vHead?.actions(enabled("leads", "create") ? btn("登记线索", () => leadForm(c), "ink", "plus") : null);
  }
  function phoneTools(c, rows) {
    const wrap = n("div", null, { class: "fq-ld-ptools" });
    const stages = n("div", null, { class: "fq-ld-chips is-scroll", role: "group", "aria-label": "阶段" });
    const src = filtered(rows);
    const count = (s) => src.filter((r) => (s === "open" ? OPEN.includes(r.stage) : r.stage === s)).length;
    for (const [v, t] of [["open", "进行中"], ["new", stageLabel("new")], ["contacted", stageLabel("contacted")], ["trial", stageLabel("trial")], ["enrolled", stageLabel("enrolled")], ["lost", stageLabel("lost")]]) {
      const b = n("button", null, { type: "button", class: cls("fq-ld-chip", st.stage === v && "is-on"), "aria-pressed": String(st.stage === v) });
      b.append(t + " ", n("b", String(count(v))));
      b.addEventListener("click", () => {
        st.stage = v;
        st.showLater = false;
        draw(c);
      });
      stages.append(b);
    }
    const row = n("div", null, { class: "fq-ld-bar-row" });
    const sel = n("select", null, { class: "fq-ld-select", "aria-label": "来源" });
    for (const [v, t] of [["", "来源：全部"], ...SOURCES.map((s) => [s, s])]) sel.append(n("option", t, { value: v }));
    sel.value = st.source;
    sel.addEventListener("change", () => {
      st.source = sel.value;
      draw(c);
    });
    row.append(sel, searchBox(c));
    if (enabled("leads", "create")) row.append(btn("登记线索", () => leadForm(c), "ink", "plus"));
    wrap.append(stages, row);
    return wrap;
  }

  // ---------- 看板 ----------
  let dragging = null;
  function dropZone(el, stage) {
    el.addEventListener("dragover", (e) => {
      if (dragging && UI.leadMoveAllowed(dragging.stage, stage)) {
        e.preventDefault();
        el.classList.add("is-over");
      }
    });
    el.addEventListener("dragleave", (e) => {
      if (!el.contains(e.relatedTarget)) el.classList.remove("is-over");
    });
    el.addEventListener("drop", async (e) => {
      e.preventDefault();
      el.classList.remove("is-over");
      const row = dragging;
      if (!row || !UI.leadMoveAllowed(row.stage, stage) || !enabled("leads", "update")) return;
      try {
        await patch(row, { stage, ...(stage === "lost" ? { next_followup: null } : {}) });
        await leads(current.c);
      } catch (err) {
        notice(err.message);
      }
    });
  }
  function colHead(stage, count, hint, extra = "") {
    const h = n("header", null, { class: extra });
    h.append(n("i"), n("h3", stageLabel(stage)), n("span", String(count), { class: "fq-ld-count" }), n("small", hint));
    return h;
  }
  function board(c, rows) {
    const wrap = n("div", null, { class: "fq-ld-board" });
    const by = (s) => rows.filter((r) => r.stage === s);
    const sorters = {
      new: (a, b) => b.created_at - a.created_at,
      contacted: (a, b) => String(a.next_followup || "9999").localeCompare(String(b.next_followup || "9999")),
      trial: (a, b) => String(a.trial_at || "9999").localeCompare(String(b.trial_at || "9999")),
    };
    const hints = { new: "24 小时内做首次回访", contacted: "按下次回访排序", trial: "试听后转为正式学员" };
    for (const s of OPEN) {
      const items = by(s).sort(sorters[s]);
      const col = n("section", null, { class: "fq-ld-col is-" + s, "data-stage": s });
      const list = n("div", null, { class: "fq-ld-col-list" });
      for (const r of items) list.append(leadCard(c, r));
      if (!items.length) list.append(n("p", "暂无", { class: "fq-ld-empty" }));
      col.append(colHead(s, items.length, hints[s]), list);
      dropZone(col, s);
      wrap.append(col);
    }
    const side = n("aside", null, { class: "fq-ld-col is-result" });
    const monthStart = todayBJ().slice(0, 7);
    const enrolled = by("enrolled").sort((a, b) => b.updated_at - a.updated_at);
    const lost = by("lost").sort((a, b) => b.updated_at - a.updated_at);
    const section = (stage, items, hint, limit, extra) => {
      const list = n("div", null, { class: "fq-ld-col-list" });
      const showAll = st.more[stage];
      for (const r of showAll ? items : items.slice(0, limit)) list.append(leadCard(c, r));
      if (!items.length) list.append(n("p", stage === "enrolled" ? "试听后转为学员的会出现在这里。" : "暂无", { class: "fq-ld-empty" }));
      if (items.length > limit) {
        const more = n("button", showAll ? "收起 ↑" : "再显示 " + (items.length - limit) + " 条 ↓", { type: "button", class: "fq-ld-more" });
        more.addEventListener("click", () => {
          st.more[stage] = !showAll;
          draw(c);
        });
        list.append(more);
      }
      const head = colHead(stage, items.length, hint, extra);
      const box = n("div", null, { class: "fq-ld-zone", "data-stage": stage });
      box.append(head, list);
      return box;
    };
    const thisMonth = enrolled.filter((r) => day(r.updated_at).slice(0, 7) === monthStart).length;
    side.append(section("enrolled", enrolled, thisMonth ? "本月 " + thisMonth : "最近", Math.max(3, thisMonth)));
    const lostBox = section("lost", lost, "可重新跟进", 2, "is-lost");
    dropZone(lostBox, "lost");
    side.append(lostBox);
    wrap.append(side);
    return wrap;
  }
  function leadCard(c, r) {
    const done = ["enrolled", "lost"].includes(r.stage);
    const box = n("article", null, { class: cls("fq-ld-lead", isLate(r) && "is-late", r.stage === "enrolled" && "is-done", r.stage === "lost" && "is-lost", st.selected === r.id && "is-on"), tabindex: "0", role: "button", "aria-label": r.name });
    const top = n("div", null, { class: "fq-ld-lead-top" });
    top.append(n("strong", r.name), n("span", r.grade || "", { class: "fq-ld-muted" }));
    const canDrag = enabled("leads", "update") && !done;
    if (canDrag) {
      const g = n("span", null, { class: "fq-ld-grip", "aria-hidden": "true" });
      g.append(icon(IC.grip));
      top.append(g);
    }
    box.append(top);
    if (!done) {
      const tags = n("div", null, { class: "fq-ld-tags" });
      if (r.direction) tags.append(pill(r.direction, "info"));
      tags.append(pill(srcLabel(r.source), "line"));
      box.append(tags);
      const last = lastSummary(r);
      if (last) box.append(n("p", last, { class: "fq-ld-last" }));
    }
    const [text, tone] = dueLine(r);
    box.append(n("div", text, { class: cls("fq-ld-due", tone && "is-" + tone) }));
    if (r.stage === "trial" && enabled("students", "create") && enabled("leads", "create")) box.append(link("转为正式学员 →", () => convert(r, () => leads(c))));
    if (r.stage === "enrolled" && r.student_id) box.append(link("查看学员档案 →", () => R().goStudent(r.student_id)));
    const openIt = () => {
      st.selected = r.id;
      for (const x of document.querySelectorAll(".fq-ld-lead.is-on")) x.classList.remove("is-on");
      box.classList.add("is-on");
      detail(c, r);
    };
    box.addEventListener("click", openIt);
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target === box) openIt();
    });
    if (canDrag) {
      box.draggable = true;
      box.addEventListener("dragstart", (e) => {
        dragging = r;
        box.classList.add("is-drag");
        e.dataTransfer.setData("text/plain", r.id);
      });
      box.addEventListener("dragend", () => {
        dragging = null;
        box.classList.remove("is-drag");
      });
    }
    return box;
  }
  async function convert(r, done) {
    if (!(await UI.confirm({ title: "把 " + r.name + " 转为正式学员？", consequence: "新建独立学员档案，保留线索历史。", danger: false }))) return false;
    await api("tools/leads/" + r.id + "/convert", "POST", { version: r.version });
    notice("已转为正式学员", "success");
    await done?.();
    return true;
  }

  // ---------- 列表视图（沿用原表格列） ----------
  function table(c, rows) {
    const host = n("div", null, { class: "panel v-lead-table fq-ld-table" });
    R().table(
      host,
      [
        { key: "name", label: "姓名" },
        { key: "stage", label: "阶段", render: (r) => stageLabel(r.stage) },
        { key: "grade", label: "年级", render: (r) => r.grade || "—" },
        { key: "source", label: "来源", render: (r) => srcLabel(r.source) },
        { key: "direction", label: "意向方向", render: (r) => r.direction || "待补充" },
        { key: "next_followup", label: "下次回访", render: (r) => (r.next_followup ? dayText(r.next_followup) : "—") },
        { key: "last", label: "最近回访", render: (r) => lastSummary(r) || "—" },
      ],
      rows,
      { rowAction: (r) => detail(c, r), empty: "登记的咨询会显示在这里。" },
    );
    return host;
  }

  // ---------- 手机列表 ----------
  function phoneList(c, rows) {
    const wrap = n("div", null, { class: "fq-ld-plist" });
    const pick = rows.filter((r) => (st.stage === "open" ? OPEN.includes(r.stage) : r.stage === st.stage));
    const key = (r) => r.next_followup || (r.trial_at || "").slice(0, 10) || "9999";
    const groups = [];
    if (st.stage === "open" || OPEN.includes(st.stage)) {
      const now = pick.filter((r) => isLate(r) || isToday(r) || (r.stage === "new" && !r.next_followup)).sort((a, b) => key(a).localeCompare(key(b)));
      const later = pick.filter((r) => !now.includes(r)).sort((a, b) => key(a).localeCompare(key(b)));
      groups.push(["今天要回访 · " + now.length, "逾期的排在最前", now, Infinity], ["之后 · " + later.length, "按下次回访 / 试听时间排序", later, st.showLater ? Infinity : 6]);
    } else groups.push([stageLabel(st.stage) + " · " + pick.length, st.stage === "lost" ? "可重新跟进" : "已转为正式学员", pick.sort((a, b) => b.updated_at - a.updated_at), st.showLater ? Infinity : 10]);
    for (const [title, sub, items, limit] of groups) {
      if (!items.length && title.startsWith("之后")) continue;
      const box = card("fq-ld-pgroup");
      const head = n("div", null, { class: "fq-ld-ph" });
      const t = n("div");
      t.append(n("h2", title), n("p", sub));
      head.append(t);
      box.append(head);
      for (const r of items.slice(0, limit)) box.append(phoneRow(c, r));
      if (!items.length) box.append(n("p", "没有需要处理的线索。", { class: "fq-ld-pad fq-ld-muted" }));
      if (items.length > limit) {
        const more = n("button", "再显示 " + (items.length - limit) + " 条 ↓", { type: "button", class: "fq-ld-more" });
        more.addEventListener("click", () => {
          st.showLater = true;
          draw(c);
        });
        box.append(more);
      }
      wrap.append(box);
    }
    return wrap;
  }
  function phoneRow(c, r) {
    const row = n("div", null, { class: cls("fq-ld-prow", isLate(r) && "is-late"), role: "button", tabindex: "0" });
    const top = n("div", null, { class: "fq-ld-prow-top" });
    const who = n("div", null, { class: "fq-ld-grow" });
    const name = n("div", null, { class: "fq-ld-lead-top" });
    name.append(n("strong", r.name), n("span", r.grade || "", { class: "fq-ld-muted" }));
    who.append(name, n("div", [r.direction, srcLabel(r.source)].filter(Boolean).join(" · "), { class: "fq-ld-muted fq-ld-small" }));
    top.append(avatar(r.name), who, pill(stageLabel(r.stage), STAGE_TONE[r.stage]));
    row.append(top);
    const last = OPEN.includes(r.stage) ? lastSummary(r) : "";
    if (last) row.append(n("p", last, { class: "fq-ld-last" }));
    const foot = n("div", null, { class: "fq-ld-prow-foot" });
    const [text, tone] = dueLine(r);
    foot.append(n("div", text, { class: cls("fq-ld-due", tone && "is-" + tone) }));
    if (r.phone && enabled("leads", "update")) {
      const call = btn("", () => dial(r), "icon-sm", "phone");
      call.setAttribute("aria-label", "拨打 " + r.name);
      foot.append(call);
    }
    if (OPEN.includes(r.stage) && enabled("leads", "update") && !r.student_id) foot.append(btn("记录回访", () => openPage(c, r, true), "soft"));
    row.append(foot);
    row.addEventListener("click", () => openPage(c, r, false));
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target === row) openPage(c, r, false);
    });
    return row;
  }
  function openPage(c, r, follow) {
    st.detail = { id: r.id, follow };
    return pageDetail(c, r, st.detail);
  }

  // ---------- 详情（共用部件） ----------
  async function fresh(row) {
    try {
      const d = await api("tools/leads/" + row.id + "/followups");
      return { lead: { ...row, ...d.lead }, items: d.items || [] };
    } catch (e) {
      if (e.status === 404 || /不存在/.test(e.message)) throw e;
      // 回访记录取不到时（如迁移未执行）仍显示旧备注，不挡详情。
      return { lead: row, items: [], broken: true };
    }
  }
  function steps(lead, canEdit, after) {
    const ol = n("ol", null, { class: "fq-ld-steps", "aria-label": "跟进阶段" });
    const at = lead.student_id ? 3 : OPEN.indexOf(lead.stage);
    [...OPEN, "enrolled"].forEach((k, i) => {
      const li = n("li", null, { class: cls(i < at && "is-done", i === at && "is-on", lead.stage === "lost" && "is-lost") });
      if (canEdit && k !== "enrolled" && lead.stage !== "lost" && k !== lead.stage) {
        const b = n("button", null, { type: "button", "aria-label": "改为" + stageLabel(k) });
        b.append(n("i"), n("span", stageLabel(k)));
        b.addEventListener("click", async () => {
          try {
            await patch(lead, { stage: k });
            notice("已改为" + stageLabel(k), "success");
            await after();
          } catch (e) {
            notice(e.message);
          }
        });
        li.append(b);
      } else li.append(n("i"), n("span", stageLabel(k)));
      ol.append(li);
    });
    return ol;
  }
  function timeline(lead, items, canEdit, after) {
    const box = n("div", null, { class: "fq-ld-tlbox" });
    const t = n("div", null, { class: "fq-ld-sec-t" });
    t.append(n("span", "回访记录"));
    if (canEdit) t.append(link("编辑全文", () => noteEditor(lead, after)));
    box.append(t);
    const ol = n("ol", null, { class: "fq-ld-tl" });
    const chan = Object.fromEntries(CHANNELS);
    for (const f of items) {
      const li = n("li");
      const body = n("div");
      const m = /^([^：:]{1,12})[：:](.*)$/s.exec(f.content || "");
      const label = m && RESULTS.some(([, t]) => t === m[1]) ? m[1] : f.content;
      body.append(n("b", label), n("small", " · " + (chan[f.channel] || "") + (f.actor_name ? " · " + f.actor_name : ""), { class: "fq-ld-muted" }));
      if (m && label === m[1] && m[2].trim()) body.append(n("p", m[2].trim()));
      if (f.next_followup) body.append(n("p", "下次回访 " + dayText(f.next_followup), { class: "fq-ld-muted" }));
      li.append(n("time", dayText(f.at.slice(0, 10)) + " " + f.at.slice(11, 16)), body);
      ol.append(li);
    }
    const legacy = legacyLines(lead.note);
    for (const v of legacy.visits) {
      const li = n("li", null, { class: "is-legacy" });
      const body = n("div");
      body.append(n("b", v.label), n("small", " · 旧备注", { class: "fq-ld-muted" }));
      if (v.text) body.append(n("p", v.text));
      li.append(n("time", v.date), body);
      ol.append(li);
    }
    const reg = n("li", null, { class: "is-first" });
    const regBody = n("div");
    regBody.append(n("b", "登记"));
    if (legacy.other.length) {
      const p = n("p", legacy.other.join("\n"), { class: "preserve-text" });
      regBody.append(p);
    }
    reg.append(n("time", dayText(day(lead.created_at))), regBody);
    ol.append(reg);
    box.append(ol);
    return box;
  }
  function noteEditor(lead, after) {
    const view = UI.drawer({ title: "编辑跟进备注", subtitle: lead.name + " · 旧备注全文；新回访请用“记录回访”" });
    view.element.classList.add("fq-ld-dr");
    const area = n("textarea", null, { class: "ui-control fq-ld-area", rows: "10", maxlength: "6000", "aria-label": "跟进备注" });
    area.value = lead.note || "";
    view.body.append(area);
    view.footer.append(
      btn("取消", () => view.close()),
      btn(
        "保存备注",
        async () => {
          await patch(lead, { note: area.value.trim() });
          notice("备注已保存", "success");
          await view.close();
          await after();
        },
        "violet",
      ),
    );
  }
  function dl(pairs) {
    const box = n("dl", null, { class: "fq-ld-dl" });
    for (const [k, v] of pairs) {
      const dd = n("dd");
      dd.append(v || n("span", "未填写", { class: "fq-ld-muted" }));
      box.append(n("dt", k), dd);
    }
    return box;
  }
  function phoneCell(lead) {
    const box = n("span");
    box.append(lead.phone || "未填写");
    if (lead.phone && enabled("leads", "update"))
      box.append(
        " ",
        link("显示号码", async () => {
          const ct = await reveal(lead);
          box.replaceChildren(ct.phone || "未填写", ct.parent_phone ? " · 家长 " + ct.parent_phone : "", n("span", "（已记录查看）", { class: "fq-ld-muted fq-ld-small" }));
        }),
      );
    return box;
  }
  const shiftDay = (d) => dateShift(todayBJ(), d);
  function nextQuick(lead, canEdit, after) {
    const box = n("div", null, { class: "fq-ld-row is-wrap" });
    const today = todayBJ();
    box.append(
      lead.next_followup
        ? pill(dayText(lead.next_followup) + (lead.next_followup < today ? " · 已过期" : lead.next_followup === today ? " · 今天" : ""), lead.next_followup < today ? "err" : lead.next_followup === today ? "warn" : "info", true)
        : pill("未安排", ""),
    );
    if (canEdit && lead.stage !== "lost")
      for (const [t, d] of [["明天", 1], ["3 天后", 3], ["下周", 7]])
        box.append(
          btn(t, async () => {
            await patch(lead, { next_followup: shiftDay(d) });
            notice("下次回访改到 " + dayText(shiftDay(d)), "success");
            await after();
          }),
        );
    return box;
  }
  function profile(lead, view) {
    return dl([
      ["手机", phoneCell(lead)],
      ["来源", lead.source ? srcLabel(lead.source) : ""],
      ["年级", lead.grade],
      ["意向方向", lead.direction],
      ["试听时间", lead.trial_at ? dayText(lead.trial_at) + " " + lead.trial_at.slice(11, 16) : n("span", "未安排", { class: "fq-ld-muted" })],
      ["登记时间", dayText(day(lead.created_at))],
      ...(lead.student_id ? [["正式学员", link("查看学员档案", async () => (await view?.close?.(), R().goStudent(lead.student_id)))]] : []),
    ]);
  }
  function moreItems(lead, after, host) {
    const items = [];
    if (lead.stage !== "lost")
      items.push({
        label: "标记流失…",
        danger: true,
        onSelect: () => markLost(lead, after),
      });
    if (enabled("leads", "delete"))
      items.push({
        label: "删除线索",
        danger: true,
        onSelect: () =>
          globalThis.ChannelV2Pay.removeItem({
            title: "删除线索“" + lead.name + "”？",
            consequence: "删除后不再显示；已经转为正式学员的档案不受影响。",
            path: "tools/leads/" + lead.id,
            body: { version: lead.version },
            done: host,
          }),
      });
    return items;
  }
  async function markLost(lead, after) {
    if (!(await UI.confirm({ title: "把 " + lead.name + " 标记为流失？", consequence: "以后可以点“重新跟进”恢复。", danger: true }))) return;
    await patch(lead, { stage: "lost", next_followup: null });
    await after();
  }

  // ---------- 记录回访表单（电脑抽屉里的紫色卡片 / 手机底部弹层） ----------
  function followForm(lead, { onSaved, onCancel, phone = false } = {}) {
    const today = todayBJ();
    const form = n("form", null, { class: cls("fq-ld-follow", phone && "is-phone"), "aria-label": "记录回访 · " + lead.name });
    let result = lead.stage === "trial" ? "again" : "again",
      channel = "phone";
    const title = n("div", null, { class: "fq-ld-sec-t" });
    title.append(icon(IC.note), n("span", "记录这次回访"));
    if (isLate(lead)) title.append(pill("已逾期 " + daysLate(lead.next_followup) + " 天", "err", true));
    else if (isToday(lead)) title.append(pill("今天回访", "warn", true));
    const chipGroup = (opts, cur, onPick, label) => {
      const g = n("div", null, { class: "fq-ld-results", role: "group", "aria-label": label });
      for (const [v, t] of opts) {
        const b = n("button", t, { type: "button", class: cls("fq-ld-chip", v === cur && "is-on"), "aria-pressed": String(v === cur) });
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
    const fld = (label, ...controls) => {
      const f = n("div", null, { class: "fq-ld-fld" });
      f.append(n("b", label), ...controls);
      return f;
    };
    const nextDay = UI.datePicker({
      label: "下次回访",
      value: dateShift(today, 3),
      allowEmpty: true,
      onChange: () => sync(),
    });
    nextDay.element.classList.add("ui-inner-pick", "fq-ld-grow");
    const quick = n("div", null, { class: "fq-ld-row" });
    const quickBtns = [];
    for (const [t, d] of [["明天", 1], ["3 天后", 3], ["下周", 7]]) {
      const b = n("button", t, { type: "button", class: "fq-ld-chip" });
      b.addEventListener("click", () => {
        nextDay.setValue(dateShift(today, d));
        sync();
      });
      quickBtns.push([b, d]);
      quick.append(b);
    }
    const nextRow = n("div", null, { class: "fq-ld-row is-wrap" });
    nextRow.append(nextDay.element, quick);
    const trial = n("input", null, { type: "datetime-local", class: "fq-ld-input", "aria-label": "试听时间" });
    trial.value = (lead.trial_at || dateShift(today, 2) + "T10:00").slice(0, 16);
    const note = n("textarea", null, { class: "fq-ld-input is-area", rows: "3", maxlength: "1900", placeholder: "家长关心什么、聊到哪、下一步做什么", "aria-label": "沟通内容" });
    const nextF = fld("下次回访", nextRow),
      trialF = fld("试听时间", trial);
    const sync = () => {
      trialF.hidden = result !== "trial";
      nextF.hidden = result === "trial" || result === "lost";
      for (const [b, d] of quickBtns) b.classList.toggle("is-on", nextDay.value === dateShift(today, d));
    };
    const foot = n("div", null, { class: "fq-ld-row is-end" });
    if (onCancel) foot.append(btn("取消", onCancel));
    const save = n("button", "保存回访", { type: "submit", class: "fq-ld-btn is-violet" });
    foot.append(save);
    form.append(
      title,
      fld(
        "这次回访结果",
        chipGroup(RESULTS, result, (v) => {
          if (v === "noanswer" && nextDay.value === dateShift(today, 3)) nextDay.value = dateShift(today, 1);
          if (v === "again" && nextDay.value === dateShift(today, 1)) nextDay.value = dateShift(today, 3);
          result = v;
          sync();
        }, "回访结果"),
      ),
      fld("方式", Object.assign(chipGroup(CHANNELS, channel, (v) => (channel = v), "回访方式"), { className: "fq-ld-results is-channel" })),
      nextF,
      trialF,
      fld("沟通内容（选填）", note),
      n("p", "选“有意向，约试听”会改为填试听时间，阶段自动变为已试听；“暂不考虑”会标记流失。保存后写进回访记录最上面。", { class: "fq-ld-hint" }),
      foot,
    );
    sync();
    const op = opId();
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (save.disabled) return;
      save.disabled = true;
      try {
        const label = Object.fromEntries(RESULTS)[result];
        const text = note.value.trim();
        const body = { version: lead.version, operation_id: op, channel };
        if (result === "trial") {
          if (!trial.value) throw Error("请填写试听时间");
          Object.assign(body, { stage: "trial", trial_at: trial.value.slice(0, 16), next_followup: trial.value.slice(0, 10) });
        } else if (result === "lost") Object.assign(body, { stage: "lost", next_followup: null });
        else {
          if (!nextDay.value) throw Error("请填写下次回访日期");
          body.next_followup = nextDay.value;
          if (lead.stage === "new") body.stage = "contacted";
        }
        body.content = (label + (result === "trial" ? "（试听 " + trial.value.replace("T", " ").slice(5) + "）" : "") + (text ? "：" + text : "")).slice(0, 2000);
        await api("tools/leads/" + lead.id + "/followups", "POST", body);
        notice(result === "lost" ? "已记录，" + lead.name + " 标记为暂不考虑" : result === "trial" ? "已记录，试听约在 " + trial.value.replace("T", " ").slice(5) : "已记录，" + dayText(nextDay.value) + " 再回访", "success");
        await onSaved?.();
      } catch (err) {
        notice(err.message || String(err));
      } finally {
        save.disabled = false;
      }
    });
    setTimeout(() => form.querySelector(".fq-ld-chip.is-on")?.focus?.({ preventScroll: true }), 0);
    return form;
  }

  // ---------- 详情：电脑抽屉（也用于今天/待办页与手机上的非线索页） ----------
  // host：调用方的容器；线索页时刷新看板，其他页（今天、待办）时通知宿主刷新。
  function refreshHost(c) {
    if (c?.isConnected && c.classList.contains("fq-leads")) return leads(c);
    if (c) c.replaceChildren(n("span"));
  }
  async function detail(c, row, { follow = false } = {}) {
    if (isPhone() && c?.isConnected && c.classList.contains("fq-leads")) return openPage(c, row, follow);
    const view = UI.drawer({ title: row.name });
    view.element.classList.add("fq-ld-dr");
    let changed = false;
    view.element.addEventListener(
      "close",
      () => {
        st.selected = null;
        if (changed) void refreshHost(c);
      },
      { once: true },
    );
    const render = async (showFollow) => {
      let data;
      try {
        data = await fresh(row);
      } catch (e) {
        notice(e.message);
        return view.close();
      }
      const lead = data.lead;
      row = lead;
      const canEdit = enabled("leads", "update") && !lead.student_id;
      const after = async () => {
        changed = true;
        await render(false);
      };
      const head = n("div", null, { class: "fq-ld-dhead" });
      // 抽屉标题已是姓名：头部只放头像、阶段与资料摘要。
      const id = n("div", null, { class: "fq-ld-dmeta" });
      id.append(pill(stageLabel(lead.stage), STAGE_TONE[lead.stage] || "info", true), n("p", [lead.grade, lead.direction, lead.source ? "来源 " + srcLabel(lead.source) : "", dayText(day(lead.created_at)) + " 登记"].filter(Boolean).join(" · ")));
      head.append(avatar(lead.name, "is-big"), id);
      const body = [head, steps(lead, canEdit, after)];
      if (lead.stage === "lost") body.push(n("p", "这条线索已标记流失 · 原因：" + lostReason(lead) + "。", { class: "fq-ld-lost" }));
      if (lead.phone && enabled("leads", "update")) {
        const strip = n("div", null, { class: "fq-ld-contact" });
        const ic = n("span", null, { class: "fq-ld-ic" });
        ic.append(icon(IC.phone));
        const txt = n("div");
        const num = n("b", lead.phone);
        txt.append(num, n("small", "查看完整号码会留记录"));
        strip.append(
          ic,
          txt,
          btn(
            "显示并拨打",
            async () => {
              const ct = await reveal(lead);
              num.textContent = (ct.phone || "未填写") + (ct.parent_phone ? " · 家长 " + ct.parent_phone : "");
              if (ct.phone) {
                const a = n("a", "拨打", { class: "fq-ld-btn is-soft", href: "tel:" + ct.phone });
                strip.lastElementChild.replaceWith(a);
              }
            },
            "soft",
            "phone",
          ),
        );
        body.push(strip);
      }
      if (canEdit && OPEN.includes(lead.stage)) {
        if (showFollow || follow) {
          body.push(followForm(lead, { onSaved: after, onCancel: () => render(false) }));
        } else {
          const nx = n("div", null, { class: "fq-ld-nextbox" });
          const t = n("div", null, { class: "fq-ld-sec-t" });
          t.append(n("span", "下次回访"));
          nx.append(t, nextQuick(lead, canEdit, after));
          const rec = btn("记录回访", () => render(true), "violet", "note");
          nx.append(rec);
          body.push(nx);
        }
      }
      follow = false;
      if (data.broken) body.push(n("p", "回访记录暂时取不到，下面只显示旧备注。", { class: "fq-ld-hint" }));
      body.push(timeline(lead, data.items, canEdit, after));
      const pf = n("div");
      pf.append(n("div", "资料", { class: "fq-ld-sec-t" }), profile(lead, view));
      body.push(pf);
      view.body.replaceChildren(...body);
      const ops = [];
      if (lead.stage === "lost" && canEdit)
        ops.push(
          btn(
            "重新跟进",
            async () => {
              await patch(lead, { stage: "contacted" });
              await after();
            },
            "ink",
          ),
        );
      if (lead.stage === "trial" && !lead.student_id && enabled("students", "create") && enabled("leads", "create"))
        ops.push(btn("转为正式学员", () => convert(lead, after), "ink"));
      if (canEdit) {
        ops.push(
          btn("编辑资料", async () => {
            changed = false;
            await view.close();
            leadForm(c, lead);
          }),
        );
        const items = moreItems(lead, after, async () => {
          changed = true;
          await view.close();
        });
        if (items.length) ops.push(UI.actionMenu({ items }).element);
        ops.push(n("span", null, { class: "fq-ld-grow" }), n("span", "标记流失、删除线索在“更多”里", { class: "fq-ld-muted fq-ld-small fq-ld-foot-hint" }));
      }
      const foot = n("div", null, { class: "fq-ld-dfoot" });
      foot.append(...ops);
      view.footer.replaceChildren(...(ops.length ? [foot] : []));
      if (showFollow) setTimeout(() => view.body.querySelector(".fq-ld-follow")?.scrollIntoView?.({ block: "nearest" }), 0);
    };
    await render(follow);
    return view;
  }

  // ---------- 详情：手机整页 ----------
  async function pageDetail(c, row, opts) {
    vHead?.actions();
    vHead?.bar();
    let data;
    try {
      data = await fresh(row);
    } catch (e) {
      notice(e.message);
      st.detail = null;
      return leads(c);
    }
    const lead = data.lead;
    const canEdit = enabled("leads", "update") && !lead.student_id;
    const back = async () => {
      st.detail = null;
      await leads(c);
    };
    const after = () => pageDetail(c, lead, { id: lead.id, follow: false });
    const page = n("div", null, { class: "fq-ld-page fq-ld-pdetail has-bar" });
    const bk = n("button", null, { type: "button", class: "fq-ld-back" });
    bk.append(icon(IC.back), n("span", "线索"));
    bk.addEventListener("click", back);
    const hero = n("section", null, { class: "fq-ld-hero" });
    const idr = n("div", null, { class: "fq-ld-row" });
    const idt = n("div");
    idt.append(n("h2", lead.name), n("p", [lead.grade, lead.direction].filter(Boolean).join(" · ")));
    idr.append(avatar(lead.name, "is-big"), idt);
    const tags = n("div", null, { class: "fq-ld-row is-wrap" });
    tags.append(pill(stageLabel(lead.stage), "info", true), pill(srcLabel(lead.source), "line"));
    if (isLate(lead)) tags.append(pill("回访逾期 " + daysLate(lead.next_followup) + " 天", "err", true));
    hero.append(idr, tags);
    const stepCard = card("fq-ld-pad");
    stepCard.append(steps(lead, canEdit, after));
    page.append(bk, hero, stepCard);
    if (lead.stage === "lost") page.append(n("p", "这条线索已标记流失 · 原因：" + lostReason(lead) + "。", { class: "fq-ld-lost" }));
    if (OPEN.includes(lead.stage)) {
      const nx = card("fq-ld-pad");
      nx.append(n("div", "下次回访", { class: "fq-ld-sec-t" }), nextQuick(lead, canEdit, after));
      page.append(nx);
    }
    const tl = card("fq-ld-pad");
    if (data.broken) tl.append(n("p", "回访记录暂时取不到，下面只显示旧备注。", { class: "fq-ld-hint" }));
    tl.append(timeline(lead, data.items, canEdit, after));
    page.append(tl);
    const pf = card("fq-ld-pad");
    pf.append(n("div", "资料", { class: "fq-ld-sec-t" }), profile(lead));
    const pfOps = n("div", null, { class: "fq-ld-row is-wrap fq-ld-mt" });
    if (canEdit) pfOps.append(btn("编辑资料", () => leadForm(c, lead)));
    if (canEdit && lead.stage !== "lost") pfOps.append(btn("标记流失…", () => markLost(lead, after), "red"));
    if (pfOps.children.length) pf.append(pfOps);
    page.append(pf);
    // 底部固定条：电话、记录回访（或重新跟进 / 转正）、更多。
    const bar = n("div", null, { class: "fq-ld-bar" });
    if (lead.phone && enabled("leads", "update")) {
      const call = btn("", () => dial(lead), "icon", "phone");
      call.setAttribute("aria-label", "拨打电话");
      bar.append(call);
    }
    const openFollow = () => {
      const view = UI.drawer({ title: "记录回访 · " + lead.name });
      view.element.classList.add("fq-ld-dr", "fq-ld-sheet");
      view.body.append(
        followForm(lead, {
          phone: true,
          onCancel: () => view.close(),
          onSaved: async () => {
            await view.close();
            await after();
          },
        }),
      );
    };
    if (canEdit && OPEN.includes(lead.stage)) bar.append(btn("记录回访", openFollow, "ink"));
    else if (canEdit && lead.stage === "lost")
      bar.append(
        btn(
          "重新跟进",
          async () => {
            await patch(lead, { stage: "contacted" });
            await after();
          },
          "ink",
        ),
      );
    else if (lead.student_id) bar.append(btn("查看学员档案", () => R().goStudent(lead.student_id), "ink"));
    if (lead.stage === "trial" && !lead.student_id && enabled("students", "create") && enabled("leads", "create")) bar.append(btn("转为学员", () => convert(lead, after)));
    const items = canEdit ? moreItems(lead, after, back).filter((x) => x.label !== "标记流失…") : [];
    if (items.length) {
      const m = UI.actionMenu({ label: "", items }).element;
      m.classList.add("fq-ld-barmore");
      m.querySelector("button")?.setAttribute("aria-label", "更多");
      bar.append(m);
    }
    if (bar.children.length) page.append(bar);
    else page.classList.remove("has-bar");
    c.replaceChildren(page);
    globalThis.scrollTo?.(0, 0);
    if (opts?.follow && canEdit && OPEN.includes(lead.stage)) {
      st.detail.follow = false;
      openFollow();
    }
  }

  // ---------- 登记 / 编辑表单（原 leadForm，来源改为固定选项） ----------
  async function fqLeadForm(c, row = {}) {
    const { panel, close } = drawer(row.id ? "编辑线索资料" : "登记线索"),
      f = n("form");
    if (row.id && me.user.roles.includes("supervisor"))
      f.append(
        button("查看完整联系方式（留审计）", async () => {
          const contact = await api("tools/leads/" + row.id + "/contact", "POST", {});
          notice("手机：" + (contact.phone || "未填写") + "；家长手机：" + (contact.parent_phone || "未填写"));
        }),
      );
    field(f, "姓名", "name", "text", row.name || "");
    for (const [label, key] of [
      ["手机", "phone"],
      ["家长手机", "parent_phone"],
    ]) {
      const input = field(f, label, key, "tel", "", false);
      if (row.id) input.closest(".ui-field")?.append(n("p", "已有号码不显示；不改就留空", { class: "ui-field-hint" }));
    }
    const key = srcKey(row.source);
    const src = selectField(f, "来源", "source", SOURCES.map((s) => ({ id: s, name: s })), key);
    src.required = false;
    const other = field(f, "其他来源（选“其他”时填写）", "source_other", "text", key === "其他" && row.source !== "其他" ? row.source : "", false);
    other.maxLength = 90;
    const otherBox = other.closest(".ui-field, .field");
    const syncOther = () => {
      if (otherBox) otherBox.hidden = f.elements.source.value !== "其他";
    };
    f.addEventListener("change", syncOther);
    f.addEventListener("input", syncOther);
    for (const [label, k] of [
      ["年级", "grade"],
      ["专业方向", "direction"],
    ])
      field(f, label, k, "text", row[k] || "", false);
    selectField(
      f,
      "阶段",
      "stage",
      Object.entries(me.labels.lead_stages)
        .filter(([id]) => id !== "enrolled")
        .map(([id, name]) => ({ id, name })),
      row.stage || "new",
    );
    field(f, "下次跟进日期", "next_followup", "date", row.next_followup || "", false);
    field(f, "试听时间（北京时间）", "trial_at", "datetime-local", (row.trial_at || "").slice(0, 16), false);
    textArea(f, "跟进备注", "note", row.note || "", 6000);
    submit(f, row.id ? "保存线索" : "登记线索", async (d) => {
      if (row.id) for (const k of ["phone", "parent_phone"]) if (!d[k]) delete d[k];
      d.source = d.source === "其他" ? String(d.source_other || "").trim() || "其他" : d.source || "";
      delete d.source_other;
      await api("tools/leads" + (row.id ? "/" + row.id : ""), row.id ? "PATCH" : "POST", { ...d, version: row.version });
      close();
      await leadsPage(c);
    });
    standardForm(
      f,
      {
        groups: [
          ["学员", ["name", "grade", "direction", "source", "source_other"]],
          ["联系方式", ["phone", "parent_phone"]],
          ["跟进", ["stage", "next_followup", "trial_at", "note"]],
        ],
        wide: ["trial_at", "note"],
      },
      close,
    );
    panel.append(f);
    syncOther();
  }

  leadsPage = (c) => leads(c);
  leadForm = fqLeadForm;
  if (globalThis.ChannelC3) globalThis.ChannelC3.leadDetail = (c, row) => detail(c, row);
  // 待办页“记录回访”：打开新的线索详情并展开记录表单；关闭时若有改动就刷新待办（reload）。
  globalThis.FQLeads = {
    detail,
    followup: (row, reload) => {
      const box = n("div");
      new MutationObserver((_, o) => {
        o.disconnect();
        void reload?.();
      }).observe(box, { childList: true });
      return detail(box, row, { follow: true });
    },
    srcLabel,
    legacyLines,
  };
})();
