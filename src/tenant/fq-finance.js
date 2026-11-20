// 枫琴教务中心 · 财务概览与月度结账进度（设计稿 04）。
// 加载在 v2f.js、v2pay.js 之后：通过 globalThis.fqNavHooks 在财务分组最前面加“概览”页签。
// 财务页签：概览 · 收款 · 课时包 · 课酬结算 · 成本。原“报表”并入概览（导出报表沿用原导出），路由 #finance-reports 仍可直接打开。
// 只读既有接口（c3/report、c3/receipts、credits/payments、credits/packages、finance/payroll、finance/settlement），不新增写入。
(() => {
  "use strict";
  const n = el,
    F = UI.fmt,
    R = () => globalThis.ChannelRebuild,
    Pay = () => globalThis.ChannelV2Pay,
    Fin = () => globalThis.ChannelV2Finance;
  const money = (v) => (v === null || v === undefined ? "—" : F.money(v));
  const go = (hash) => {
    location.hash = hash;
  };
  // 某一块取不到（权限、网络）不影响其他块。
  const may = (ok, fn) => (ok ? Promise.resolve().then(fn).catch(() => null) : Promise.resolve(null));
  const monthText = (m) => Number(m.slice(0, 4)) + " 年 " + Number(m.slice(5)) + " 月";
  const shiftMonth = (m, d) =>
    new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5)) - 1 + d, 1)).toISOString().slice(0, 7);
  const dayShift = (day, d) => new Date(Date.parse(day + "T00:00:00Z") + d * 86400000).toISOString().slice(0, 10);
  const pill = (text, tone = "") => n("span", text, { class: "fq-fin-pill" + (tone ? " is-" + tone : "") });
  const linkTo = (text, fn, cls = "fq-fin-go") => {
    const b = n("button", text, { type: "button", class: cls });
    b.addEventListener("click", fn);
    return b;
  };

  // ---------- 顶部：月份切换 + 导出报表 + 登记缴费 ----------
  function monthSwitch(reload) {
    const box = n("div", null, { class: "fq-finance fq-fin-month", role: "group", "aria-label": "月份" });
    const step = (d) => async () => {
      financeMonth = shiftMonth(financeMonth, d);
      await reload();
    };
    box.append(
      UI.iconButton("上个月", "chevron-left", step(-1)),
      n("strong", monthText(financeMonth), { "aria-live": "polite" }),
      UI.iconButton("下个月", "chevron-right", step(1)),
    );
    return box;
  }
  function headActions(c) {
    let exp = null;
    if (enabled("exports", "export") && enabled("reports")) {
      exp = exportLink("report", "导出报表");
      exp.href += "&scope=occurred";
      exp.classList.add("v-export");
    }
    vHead?.actions(exp, enabled("tuition", "create") ? button("＋ 登记缴费", () => Pay().payForm({}, () => overview(c)), "primary") : null);
  }

  // ---------- 结账进度 ----------
  function closing({ report, receipt, payroll, settlement }) {
    const mm = Number(financeMonth.slice(5)) + " 月";
    const rec = settlement?.record || { status: payroll?.locked || report?.locked ? "locked" : "draft" };
    const status = rec.locked || rec.status === "locked" ? "locked" : rec.status === "pending" ? "pending" : "draft";
    const pend = report && "pending_count" in report ? Number(report.pending_count || 0) : null;
    const unresolved = receipt ? Number(receipt.metrics?.unresolved || 0) : null;
    const canCheckin = enabled("attendance", "update") || enabled("attendance", "confirm");
    const steps = [];
    // 1 销课
    if (status === "locked") steps.push({ state: "done", title: "销课", em: "· 已锁定" });
    else if (pend === null) steps.push({ state: "off", title: "销课", note: "没有报表权限，无法统计" });
    else if (pend > 0)
      steps.push({
        state: "todo",
        title: "销课",
        em: "· " + pend + " 节没点名",
        act: canCheckin ? ["去处理 →", () => go("todo-unchecked")] : null,
        note: canCheckin ? "" : "请教务点名销课",
      });
    else steps.push({ state: "done", title: "销课", em: "· 都点完了" });
    // 2 收款核对
    if (unresolved === null) steps.push({ state: "off", title: "收款核对", note: "没有收款权限" });
    else if (unresolved > 0)
      steps.push({
        state: "todo",
        title: "收款核对",
        em: "· " + unresolved + " 笔",
        act: [
          "去处理 →",
          () => {
            Fin()?.payTab("pending");
            go("finance-income");
          },
        ],
      });
    else steps.push({ state: "done", title: "收款核对", em: "· 没有待核对" });
    // 3 课酬（按课次自动算）
    if (payroll) {
      const items = payroll.items || [];
      const paid = items.filter((r) => Number(r.total_amount) > 0);
      const total = items.reduce((s, r) => s + Number(r.total_amount || 0), 0);
      steps.push({
        state: status === "locked" || pend === 0 ? "done" : "auto",
        title: "课酬 · " + paid.length + " 位老师 " + F.money(total),
        note: status === "locked" ? "已随结算锁定" : pend === 0 ? "已按本月课次算好" : "数据齐了自动算好",
        act: enabled("teacher_pay") ? ["查看明细 →", () => go("finance-pay")] : null,
      });
    } else steps.push({ state: "off", title: "课酬", note: "没有课酬权限" });
    // 4 提交并锁定（状态取自原月度结算）
    const before = steps.slice(0, 2).filter((s) => s.state !== "done").length;
    if (status === "locked") steps.push({ state: "done", title: "提交并锁定", em: "· 已锁定" });
    else if (status === "pending")
      steps.push({
        state: "wait",
        title: "提交并锁定",
        em: "· 待主管批准",
        act: enabled("settlements", "approve") ? ["去批准 →", () => go("finance-pay")] : null,
        note: enabled("settlements", "approve") ? "" : "财务已提交，等主管批准",
      });
    else if (!before)
      steps.push({
        state: "todo",
        title: "提交并锁定",
        em: "· 可以提交了",
        act: enabled("settlements", "submit") ? ["去提交 →", () => go("finance-pay")] : null,
        note: enabled("settlements", "submit") ? "" : "由财务提交结算",
      });
    else steps.push({ state: "off", title: "提交并锁定", note: "前面完成后可用" });

    const box = n("section", null, { class: "fq-fin-close is-" + status, "aria-label": "本月结账进度" });
    const head = n("div", null, { class: "fq-fin-close-head" });
    head.append(
      n(
        "h2",
        status === "locked"
          ? mm + "已结账 · 本月已锁定"
          : status === "pending"
            ? mm + "结账 · 已提交，等主管批准"
            : before
              ? mm + "结账 · 还差 " + before + " 步就能提交"
              : mm + "结账 · 可以提交了",
      ),
      n("span", status === "locked" ? "课程、出勤和课时流水不可再改，付款记录仍可登记" : "提交后由主管批准并锁定本月"),
    );
    const list = n("ol", null, { class: "fq-fin-steps" });
    for (const s of steps) {
      const li = n("li", null, { class: "fq-fin-step is-" + s.state });
      li.append(n("i", null, { "aria-hidden": "true" }));
      const t = n("span", s.title, { class: "fq-fin-step-t" });
      if (s.em) t.append(" ", n("em", s.em));
      li.append(t);
      if (s.act) li.append(linkTo(s.act[0], s.act[1]));
      else if (s.note) li.append(n("span", s.note, { class: "fq-fin-step-n" }));
      list.append(li);
    }
    box.append(head, list);
    return box;
  }

  // ---------- 五张数字卡 ----------
  function stats({ report, receipt, payroll, costs }) {
    const has = (k) => !!report && k in report;
    const earnedMissing = has("earned_amount") && report.earned_amount === null;
    const lessons = payroll ? (payroll.items || []).reduce((s, r) => s + Number(r.lesson_count || 0), 0) : report?.lesson_count;
    const cats = new Map();
    for (const r of costs || []) cats.set(r.category || "未分类", (cats.get(r.category || "未分类") || 0) + Number(r.amount || 0));
    const catText = [...cats].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k).join("、");
    const profit = has("profit_earned") && !earnedMissing ? report.profit_earned : has("profit_cash") ? report.profit_cash : report?.profit_amount;
    const cards = [
      ["实收现金", has("tuition_amount") ? report.tuition_amount : receipt?.metrics?.total_amount, receipt ? (receipt.metrics?.payment_count || 0) + " 笔缴费" : "按收款日期", "wallet"],
      [
        "确认收入",
        has("earned_amount") ? report.earned_amount : null,
        earnedMissing ? "该月锁定早于新口径，只有实收" : "已上的课 × 单价" + (report?.unpriced_units ? " · " + report.unpriced_units + " 课时无单价" : ""),
        "check",
      ],
      ["老师课酬", has("teacher_pay_amount") ? report.teacher_pay_amount : null, lessons !== undefined && lessons !== null ? lessons + " 节" : "已发生的课", "users"],
      ["其他成本", has("cost_amount") ? report.cost_amount : null, catText || "不含今天之后的成本", "book"],
      [
        report?.locked ? "利润" : "利润（截至今天）",
        profit,
        has("profit_earned") && !earnedMissing ? "确认收入 − 课酬 − 成本" : "实收 − 课酬 − 成本",
        "arrow-up",
        "is-profit" + (Number(profit) < 0 ? " is-neg" : ""),
      ],
    ];
    const row = n("section", null, { class: "fq-fin-stats", "aria-label": "本月关键数字" });
    for (const [label, value, foot, icon, cls] of cards) {
      const card = n("div", null, { class: "fq-fin-stat" + (cls ? " " + cls : "") });
      const h = n("div", label, { class: "fq-fin-stat-h" });
      const ic = n("span", null, { class: "fq-fin-ic" });
      ic.append(UI.icon(icon));
      h.append(ic);
      card.append(h, n("strong", money(value), { class: "fq-fin-num" }), n("span", foot, { class: "fq-fin-ft" }));
      row.append(card);
    }
    return row;
  }

  // ---------- 近 6 个月柱状图（高度用 class 分档，不写行内样式） ----------
  function panel(title, sub, ...extra) {
    const box = n("section", null, { class: "fq-fin-panel" }),
      head = n("div", null, { class: "fq-fin-ph" }),
      t = n("div");
    t.append(n("h2", title));
    if (sub) t.append(n("p", sub));
    head.append(t, ...extra.filter(Boolean));
    box.append(head);
    return box;
  }
  function trendPanel(report) {
    const trend = report?.trend || [];
    const earned = trend.some((r) => "earned_amount" in r);
    const incKey = earned ? "earned_amount" : "tuition_amount",
      incLabel = earned ? "确认收入" : "实收现金";
    const legend = n("div", null, { class: "fq-fin-legend" });
    for (const [cls, text] of [
      ["is-in", incLabel],
      ["is-out", "课酬 + 成本"],
    ]) {
      const it = n("span");
      it.append(n("i", null, { class: cls }), text);
      legend.append(it);
    }
    const box = panel("近 6 个月", "按" + incLabel + "口径", legend);
    box.classList.add("fq-fin-trend");
    const body = n("div", null, { class: "fq-fin-pb" });
    if (!trend.length) {
      body.append(n("p", "没有报表权限或还没有数据。", { class: "fq-fin-empty" }));
      box.append(body);
      return box;
    }
    const rows = trend.map((r) => ({
      month: r.month,
      inc: r[incKey] === null || r[incKey] === undefined ? null : Number(r[incKey]),
      out: Number(r.teacher_pay_amount || 0) + Number(r.cost_amount || 0),
    }));
    const max = Math.max(1, ...rows.flatMap((r) => [Math.abs(r.inc || 0), Math.abs(r.out)]));
    const level = (v) => (v === null || !v ? 0 : Math.max(1, Math.round((Math.abs(v) / max) * 20)));
    const said = rows.map((r) => Number(r.month.slice(5)) + " 月 " + incLabel + " " + money(r.inc) + "，课酬加成本 " + F.money(r.out)).join("；");
    const bars = n("div", null, { class: "fq-fin-bars", role: "img", "aria-label": said });
    const labels = n("div", null, { class: "fq-fin-bar-labels", "aria-hidden": "true" });
    rows.forEach((r, i) => {
      const col = n("div", null, { class: i === rows.length - 1 ? "is-now" : "" });
      col.append(
        n("i", null, { class: "is-in fq-h" + level(r.inc) + (r.inc === null ? " is-missing" : ""), title: Number(r.month.slice(5)) + " 月 " + incLabel + " " + money(r.inc) }),
        n("b", null, { class: "is-out fq-h" + level(r.out), title: Number(r.month.slice(5)) + " 月 课酬 + 成本 " + F.money(r.out) }),
      );
      bars.append(col);
      labels.append(n("span", Number(r.month.slice(5)) + " 月", { class: i === rows.length - 1 ? "is-now" : "" }));
    });
    body.append(bars, labels);
    if (earned && rows.some((r) => r.inc === null)) body.append(n("p", "新口径上线前已锁定的月份没有确认收入，图中留空。", { class: "fq-fin-note" }));
    box.append(body);
    return box;
  }

  // ---------- 右栏：待收款、课时包提醒 ----------
  function rowLink(text, right, fn) {
    const b = n("button", null, { type: "button", class: "fq-fin-row" });
    b.append(n("span", text, { class: "fq-fin-row-t" }), right);
    b.addEventListener("click", fn);
    return b;
  }
  function duePanel(receipt) {
    const total = Number(receipt.metrics?.due_amount || 0);
    const box = panel("待收款", "", n("strong", F.money(total), { class: "fq-fin-num fq-fin-due" + (total ? "" : " is-zero") }));
    const by = new Map();
    for (const r of receipt.items || []) {
      const g = by.get(r.student_id) || { id: r.student_id, name: r.student_name, courses: [], amount: 0 };
      g.courses.push(r.course_name);
      g.amount += Number(r.due_amount || 0);
      by.set(r.student_id, g);
    }
    const people = [...by.values()].sort((a, b) => b.amount - a.amount);
    const top = people.slice(0, 2);
    for (const g of top)
      box.append(
        rowLink(g.name + " · " + (g.courses.length > 1 ? g.courses.length + " 个课时包" : g.courses[0] || "课时包"), n("span", F.money(g.amount), { class: "fq-fin-amt" }), () =>
          R().goStudent(g.id, "packages"),
        ),
      );
    const restCount = Math.max(0, (receipt.total || people.length) - top.reduce((s, g) => s + g.courses.length, 0));
    const restAmount = Math.max(0, total - top.reduce((s, g) => s + g.amount, 0));
    if (restAmount > 0 || restCount > 0) {
      const others = people.length - top.length;
      box.append(
        rowLink(others > 0 ? "另外 " + others + " 位学员" : "另外 " + restCount + " 个课时包", n("span", F.money(restAmount), { class: "fq-fin-amt" }), () => {
          Fin()?.payTab("due");
          go("finance-income");
        }),
      );
    }
    if (!top.length) box.append(n("p", "没有应收未收的课时包。", { class: "fq-fin-empty" }));
    return box;
  }
  function packagePanel(packs) {
    const day = todayBJ(),
      soon = dayShift(day, 30);
    const live = packs.filter((p) => p.status !== "paused" && !(p.valid_to && p.valid_to < day));
    const low = live.filter((p) => p.display_status?.code === "low").sort((a, b) => a.balance - b.balance);
    const ending = live
      .filter((p) => Number(p.balance) > 0 && p.display_status?.code !== "low" && p.valid_to && p.valid_to <= soon)
      .sort((a, b) => a.valid_to.localeCompare(b.valid_to));
    const empty = live.filter((p) => p.display_status?.code === "empty");
    const list = [
      ...low.map((p) => [p, pill("剩 " + F.units(p.balance) + " 课时", "warn")]),
      ...ending.map((p) => [p, pill(p.valid_to.slice(5).replace("-", "/") + " 到期")]),
      ...empty.map((p) => [p, pill("已用完", "err")]),
    ];
    const all = n("button", "全部 →", { type: "button", class: "fq-fin-more" });
    all.addEventListener("click", () => go("finance-packages"));
    const box = panel("课时包提醒", list.length ? "余额低 " + low.length + " · 30 天内到期 " + ending.length + " · 已用完 " + empty.length : "", all);
    for (const [p, tag] of list.slice(0, 4)) box.append(rowLink(p.student_name + " · " + p.course_name, tag, () => R().goStudent(p.student_id, "packages")));
    if (!list.length) box.append(n("p", "没有余额低或快到期的课时包。", { class: "fq-fin-empty" }));
    return box;
  }

  // ---------- 最近收款 ----------
  function recentPanel(payments, packs, receipt) {
    const month = payments
      .filter((r) => String(r.paid_at || "").slice(0, 7) === financeMonth)
      .sort((a, b) => String(b.paid_at).localeCompare(String(a.paid_at)) || String(b.id).localeCompare(String(a.id)));
    const unresolved = Number(receipt?.metrics?.unresolved || 0);
    const allBtn = n("button", "全部收款 →", { type: "button", class: "fq-fin-chipbtn" });
    allBtn.addEventListener("click", () => {
      Fin()?.payTab("received");
      go("finance-income");
    });
    const box = panel("最近收款", "本月 " + month.length + " 笔" + (unresolved ? " · " + unresolved + " 笔待核对" : ""), allBtn);
    box.classList.add("fq-fin-recent");
    if (!month.length) {
      box.append(n("p", "这个月还没有收款记录。", { class: "fq-fin-empty" }));
      return box;
    }
    const by = new Map(packs.map((p) => [p.id, p]));
    const wrap = n("div", null, { class: "fq-fin-tw" }),
      t = n("table", null, { class: "fq-fin-tbl" }),
      head = n("tr");
    for (const [h, cls] of [["日期"], ["学员"], ["分到"], ["方式"], ["状态"], ["金额", "is-num"]]) head.append(n("th", h, cls ? { class: cls } : {}));
    const thead = n("thead"),
      tbody = n("tbody");
    thead.append(head);
    for (const r of month.slice(0, 6)) {
      let target, state;
      if (r.kind === "other_income") {
        target = n("td", "其他收入" + (r.other_category ? " · " + r.other_category : ""));
        state = pill("已确认", "ok");
      } else if (r.unresolved || (!r.kind && !r.package_id)) {
        target = n("td", "未分配", { class: "is-faint" });
        state = pill("待核对", "warn");
      } else if (r.package_id) {
        target = n("td", by.get(r.package_id)?.course_name || "已关联课时包");
        state = pill("已分配", "ok");
      } else {
        target = n("td", "学费（已分配 / 预收）");
        state = pill("已分配", "ok");
      }
      const tr = n("tr"),
        who = n("td", null, { class: "is-who" }),
        st = n("td");
      who.append(linkTo(r.student_name || "—", () => R().goStudent(r.student_id, "packages"), "fq-fin-name"));
      st.append(state);
      tr.append(n("td", String(r.paid_at || "").slice(5, 10).replace("-", "/")), who, target, n("td", r.method || "—"), st, n("td", F.money(r.amount), { class: "is-num is-amt" }));
      tbody.append(tr);
    }
    t.append(thead, tbody);
    wrap.append(t);
    box.append(wrap);
    return box;
  }

  // ---------- 概览页 ----------
  async function overview(c) {
    c.classList.add("fq-finance", "fq-fin-overview");
    const month = financeMonth;
    const [report, receipt, payroll, settlement, payments, packs, costRows] = await Promise.all([
      may(enabled("reports"), () => api("c3/report?month=" + month)),
      may(enabled("tuition"), () => api("c3/receipts?month=" + month)),
      may(enabled("teacher_pay"), () => api("finance/payroll?month=" + month)),
      may(enabled("settlements"), () => api("finance/settlement?month=" + month)),
      may(enabled("tuition"), () => R().take("credits/payments")),
      may(enabled("packages"), () => R().take("credits/packages")),
      may(enabled("settlements"), () => R().take("finance/costs")),
    ]);
    if (month !== financeMonth) return;
    const costs = (costRows || []).filter((r) => String(r.date || "").slice(0, 7) === month);
    headActions(c);
    vHead?.bar(monthSwitch(() => overview(c)));
    c.replaceChildren();
    if (!vHead) c.append(monthSwitch(() => overview(c)));
    if (report || receipt || payroll || settlement) c.append(closing({ report, receipt, payroll, settlement }));
    c.append(stats({ report, receipt, payroll, costs }));
    const cols = n("div", null, { class: "fq-fin-cols" }),
      side = n("div", null, { class: "fq-fin-side" });
    if (receipt) side.append(duePanel(receipt));
    if (packs) side.append(packagePanel(packs));
    cols.append(trendPanel(report));
    if (side.childElementCount) cols.append(side);
    c.append(cols);
    if (payments) c.append(recentPanel(payments, packs || [], receipt));
  }

  // ---------- 导航：概览放第一，页签精简改名；其余财务页统一套 fq-finance 外观 ----------
  const skin = (t) => {
    if (!t || t.fqSkin) return t;
    const fn = t.fn;
    t.fn = async (c) => {
      c.classList.add("fq-finance");
      await fn(c);
      for (const b of document.querySelectorAll(".v-toolbar-left > .v-fin-bar")) b.classList.add("fq-finance");
    };
    t.fqSkin = true;
    return t;
  };
  (globalThis.fqNavHooks ||= []).push((daily, manage, register) => {
    const g = manage.find((x) => x && x.key === "finance") || daily.find((x) => x && x.key === "finance");
    if (!g) return;
    const tabs = g.tabs.filter(Boolean);
    const find = (k) => tabs.find((t) => t.key === k);
    const page = (c) => overview(c);
    const first = register("finance-overview", "概览", "reports", page) || register("finance-overview", "概览", "tuition", page);
    const rename = { "finance-pay": "课酬结算", "finance-costs": "成本" };
    for (const t of tabs) {
      if (rename[t.key]) t.label = rename[t.key];
      skin(t);
    }
    const order = ["finance-income", "finance-packages", "finance-pay", "finance-costs"];
    g.tabs = [
      first,
      ...order.map(find),
      // 只有财务角色（没有“老师”菜单）时，课酬标准仍留在财务里。
      ...tabs.filter((t) => !order.includes(t.key) && t.key !== "finance-reports"),
    ].filter(Boolean);
  });
  globalThis.FQFinance = { overview };
})();
