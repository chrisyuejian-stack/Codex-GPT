// 第十阶段重构（v2）第 5 组：财务（收款、课时包、月度结算、其他成本、报表）。
// 只读既有接口；写入全部沿用原表单与原写入路径。报表收入口径（B1）默认“确认收入”，可切换“实收现金”。
(() => {
  "use strict";
  const n = el,
    F = UI.fmt,
    V = () => globalThis.ChannelV2,
    P = () => globalThis.ChannelV2People,
    R = () => globalThis.ChannelRebuild,
    Pay = () => globalThis.ChannelV2Pay;
  const chip = (text, tone) => V().chip(text, tone);
  const link = (text, fn) => V().link(text, fn);
  const money = (v) => (v === null || v === undefined ? "—" : F.money(v));
  const cell = (v) => (v === 0 || v === null || v === undefined ? "—" : F.money(v));
  const today = () => todayBJ();
  const old = { creditPage, financePage, financeRecords, reportsPage };
  const fState = { payTab: "received", payQ: "", payMethod: "", pkStatus: "", pkQ: "", payrollTab: "payroll", basis: "earned", repTab: "teachers", repFilter: "all", repQ: "" };

  // ---------- 公共件 ----------
  function monthBar(c, reload, ...extra) {
    const bar = n("div", null, { class: "v-fin-bar" });
    bar.append(
      UI.monthPicker({
        value: financeMonth,
        onChange: (v) => {
          financeMonth = v;
          return reload();
        },
      }).element,
      ...extra.filter(Boolean),
    );
    // 月份切换放到顶栏下的按钮行左边（页面内只留内容）；不在新外壳里时退回原位置。
    if (vHead?.bar && inPage(c)) vHead.bar(bar);
    else c.append(bar);
    return bar;
  }
  function toolbar(c, ...nodes) {
    const bar = n("div", null, { class: "v-fin-bar is-tools" });
    bar.append(...nodes.filter(Boolean));
    c.append(bar);
    return bar;
  }
  function exportBtn(kind, extra = "") {
    if (!enabled("exports", "export")) return null;
    const a = exportLink(kind);
    if (extra) a.href += extra;
    a.classList.add("v-export");
    return a;
  }
  // 简单表格：列 {label, value(row) => 文本或节点, num, cls}；可带合计行与行点击。
  // 长列表分批显示：先 50 行，底部“再显示 50 条”，不一次铺满几百行。
  const PAGE_ROWS = 50;
  function vtable(cols, rows, { rowAction, foot, empty, cls = "" } = {}) {
    if (!rows.length) return UI.empty({ text: empty || "这个月没有记录。" });
    const wrap = n("div", null, { class: "v-renew-table panel v-fin-table " + cls }),
      t = n("table", null, { class: "v-table" }),
      head = n("tr");
    for (const col of cols) head.append(n("th", col.label, { class: (col.num ? "is-num " : "") + (col.cls || "") }));
    const thead = n("thead"),
      tbody = n("tbody");
    thead.append(head);
    let shown = 0;
    const addRows = () => {
    for (const r of rows.slice(shown, shown + PAGE_ROWS)) {
      const tr = n("tr", null, rowAction ? { class: "is-click" } : {});
      for (const col of cols) {
        const v = col.value(r),
          td = n("td", null, { class: (col.num ? "is-num " : "") + (col.cls || ""), "data-label": col.label });
        td.append(v === null || v === undefined ? "" : v);
        tr.append(td);
      }
      if (rowAction)
        tr.addEventListener("click", (e) => {
          if (!e.target.closest("button, a, input")) void rowAction(r);
        });
      tbody.append(tr);
    }
    shown = Math.min(rows.length, shown + PAGE_ROWS);
    };
    addRows();
    t.append(thead, tbody);
    if (foot) {
      const tf = n("tfoot"),
        tr = n("tr");
      for (const col of cols) tr.append(n("td", foot[col.key] ?? "", { class: (col.num ? "is-num" : "") + (foot[col.key] ? "" : " is-blank"), "data-label": col.label }));
      tf.append(tr);
      t.append(tf);
    }
    wrap.append(t);
    if (rows.length > shown) {
      const more = n("button", null, { type: "button", class: "v-more-rows" });
      const label = () => (more.textContent = "再显示 " + Math.min(PAGE_ROWS, rows.length - shown) + " 条（已显示 " + shown + " / 共 " + rows.length + " 条）");
      label();
      more.addEventListener("click", () => {
        addRows();
        if (shown >= rows.length) more.remove();
        else label();
      });
      wrap.append(more);
    }
    return wrap;
  }
  function chips(items, current, onPick, label) {
    const box = n("div", null, { class: "v-filter-chips", role: "group", "aria-label": label });
    for (const [key, text, count, tone] of items) {
      const on = current === key;
      const b = n("button", text, {
        type: "button",
        class: "v-filter-chip" + (on ? " is-on" : "") + (tone ? " is-" + tone : ""),
        "aria-pressed": String(on),
      });
      if (count !== undefined && count !== null) b.append(n("span", String(count), { class: "v-chip-count" }));
      b.addEventListener("click", () => onPick(key));
      box.append(b);
    }
    return box;
  }
  function search(value, placeholder, onInput) {
    const box = n("label", null, { class: "v-fin-search" });
    box.append(UI.icon("search"));
    const input = n("input", null, { type: "search", placeholder, value, "aria-label": placeholder });
    let t;
    input.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => onInput(input.value.trim()), 250);
    });
    box.append(input);
    return box;
  }
  const keepFocus = async (c, sel, fn) => {
    const pos = c.querySelector(sel)?.selectionStart;
    await fn();
    const again = c.querySelector(sel);
    if (again && pos !== undefined) {
      again.focus();
      again.setSelectionRange(pos, pos);
    }
  };
  const studentLink = (id, name) => {
    const b = n("button", name, { type: "button", class: "v-cell-link" });
    b.addEventListener("click", () => R().goStudent(id, "packages"));
    return b;
  };

  // ---------- 收款 ----------
  async function payments(c) {
    const receiptPath = "c3/receipts?month=" + financeMonth;
    const [rows, receipt, packages, due] = await Promise.all([
      R().take("credits/payments"),
      api(receiptPath),
      enabled("packages") ? R().take("credits/packages") : [],
      fState.payTab === "due" ? R().take(receiptPath) : null,
    ]);
    const by = new Map(packages.map((p) => [p.id, p]));
    const month = rows.filter((r) => r.paid_at.slice(0, 7) === financeMonth);
    vHead?.actions(
      exportBtn("payments"),
      enabled("tuition", "create") ? button("＋ 登记缴费", () => Pay().payForm({}, () => payments(c)), "primary") : null,
    );
    c.replaceChildren();
    const m = receipt.metrics;
    monthBar(c, () => payments(c));
    c.append(
      P().kpis([
        P().kpi("本月已收", F.money(m.total_amount), "按收款日期 · " + m.payment_count + " 笔", "money"),
        P().kpi("待收", F.money(m.due_amount), m.unresolved ? "另有 " + m.unresolved + " 笔待核对" : "应收减已收", m.due_amount ? "warn" : ""),
        P().kpi("本月笔数", String(m.payment_count), ""),
      ]),
    );
    const methods = [...new Set(month.map((r) => r.method).filter(Boolean))];
    toolbar(
      c,
      chips(
        [
          ["received", "收款记录", month.length],
          ["due", "待收款", null],
          ...(enabled("tuition", "update") || m.unresolved ? [["pending", "待核对", m.unresolved || 0, m.unresolved ? "warn" : ""]] : []),
          ["balance", "预收余额", null],
        ],
        fState.payTab,
        (k) => {
          fState.payTab = k;
          void payments(c);
        },
        "收款分页",
      ),
      n("span", null, { class: "v-spacer" }),
      fState.payTab === "received" && methods.length > 1
        ? chips(
            [["", "全部方式"], ...methods.map((x) => [x, x])],
            fState.payMethod,
            (k) => {
              fState.payMethod = k;
              void payments(c);
            },
            "收款方式",
          )
        : null,
      fState.payTab === "received"
        ? search(fState.payQ, "搜索学员", (q) => {
            fState.payQ = q;
            void keepFocus(c, ".v-fin-search input", () => payments(c));
          })
        : null,
    );
    if (fState.payTab === "pending") return Pay().pendingList(c, () => payments(c));
    if (fState.payTab === "balance") return Pay().balanceTab(c, () => payments(c));
    if (due) {
      c.append(
        vtable(
          [
            { label: "学员", value: (r) => studentLink(r.student_id, r.student_name) },
            { label: "对应课时包", value: (r) => r.course_name },
            { label: "有效期", value: (r) => r.valid_to || "不限" },
            { key: "due", label: "待收", num: true, value: (r) => F.money(r.due_amount) },
          ],
          due,
          { empty: "没有应收未收的课时包。" },
        ),
      );
      if (m.unresolved) {
        const p = n("p", "另有 " + m.unresolved + " 笔待核对：缺应收价格或未关联课时包。", { class: "v-muted v-fin-note" });
        p.append(" ", link("去处理", () => ((fState.payTab = "pending"), payments(c))));
        c.append(p);
      }
      return;
    }
    const q = fState.payQ.toLowerCase();
    const shown = month.filter(
      (r) => (!q || r.student_name.toLowerCase().includes(q)) && (!fState.payMethod || r.method === fState.payMethod),
    );
    const sum = shown.reduce((s, r) => s + Number(r.amount || 0), 0);
    c.append(
      vtable(
        [
          { key: "paid_at", label: "日期", value: (r) => P().dayLabel(r.paid_at) },
          { key: "student", label: "学员", value: (r) => studentLink(r.student_id, r.student_name) },
          {
            key: "pkg",
            label: "对应课时包",
            value: (r) => Pay().payTarget(r, by),
          },
          { key: "amount", label: "金额", num: true, value: (r) => F.money(r.amount) },
          { key: "method", label: "方式", value: (r) => r.method || "—" },
          { key: "note", label: "说明", value: (r) => r.note || "", cls: "v-fin-note-cell" },
          {
            key: "op",
            label: "",
            cls: "is-act",
            value: (r) => (enabled("tuition", "update") ? link("编辑", () => Pay().payEdit(r, () => payments(c))) : ""),
          },
        ],
        shown,
        {
          empty: q || fState.payMethod ? "没有符合条件的收款。" : "这个月还没有收款记录。",
          foot: shown.length > 1 ? { paid_at: "合计 " + shown.length + " 笔", amount: F.money(sum) } : null,
        },
      ),
    );
  }

  // ---------- 课时包 ----------
  const PK = [
    ["", "全部"],
    ["active", "使用中"],
    ["low", "余额低", "warn"],
    ["empty", "已用完", "bad"],
    ["expired", "已过期"],
    ["paused", "已暂停"],
  ];
  const TX = { purchase: "购买", consume: "销课", reversal: "回补", adjustment: "调整", transfer_in: "转入", transfer_out: "转出" };
  async function packages(c) {
    const rows = await R().take("credits/packages");
    vHead?.actions(
      button("课时流水", () => old.creditPage(c, "transactions", "")),
      exportBtn("packages"),
      enabled("packages", "create") ? button("＋ 课时包", () => creditForm(c, "packages", {}), "primary") : null,
    );
    c.replaceChildren();
    const count = (k) => rows.filter((r) => !k || r.display_status.code === k).length;
    const bar = n("div", null, { class: "v-fin-bar is-tools" });
    bar.append(
      chips(
        PK.map(([k, t, tone]) => [k, t, count(k), tone]),
        fState.pkStatus,
        (k) => {
          fState.pkStatus = k;
          void packages(c);
        },
        "课时包状态",
      ),
      n("span", null, { class: "v-spacer" }),
      search(fState.pkQ, "搜索学员或课程", (q) => {
        fState.pkQ = q;
        void keepFocus(c, ".v-fin-search input", () => packages(c));
      }),
    );
    c.append(bar);
    const q = fState.pkQ.toLowerCase();
    const shown = rows.filter(
      (r) =>
        (!fState.pkStatus || r.display_status.code === fState.pkStatus) &&
        (!q || r.student_name.toLowerCase().includes(q) || r.course_name.toLowerCase().includes(q)),
    );
    const money = enabled("tuition");
    const tone = (k) => ({ danger: "bad", warning: "warn", success: "ok", info: "info" })[k] || "muted";
    c.append(
      vtable(
        [
          { label: "学员", value: (r) => studentLink(r.student_id, r.student_name) },
          { label: "课程", value: (r) => r.course_name },
          {
            label: "剩余 / 总课时",
            num: true,
            value: (r) => {
              const s = n("span", null, { class: "v-pk-bal v-pk-" + r.display_status.code });
              s.append(n("strong", String(r.balance)), n("small", " / " + r.units_total + " 课时"));
              return s;
            },
          },
          { label: "有效期", value: (r) => (r.valid_to ? "至 " + r.valid_to : "不限") },
          ...(money
            ? [
                { label: "单价", num: true, value: (r) => cell(r.unit_price) },
                { label: "金额", num: true, value: (r) => cell(r.amount) },
              ]
            : []),
          { label: "状态", value: (r) => chip(r.display_status.text, tone(r.display_status.kind)) },
          {
            label: "",
            cls: "is-act",
            value: (r) => {
              const items = [
                ...(enabled("packages", "update") ? [{ label: "编辑", onSelect: () => creditForm(c, "packages", r) }] : []),
                ...(enabled("packages", "adjust") ? [{ label: "手工调整", onSelect: () => adjustForm(c, r) }] : []),
                ...(enabled("packages", "transfer") ? [{ label: "课时转移", onSelect: () => transferForm(c, r.student_id) }] : []),
                ...(enabled("packages", "delete")
                  ? [{ label: "删除", danger: true, onSelect: () => Pay().removeItem({ title: "删除这个课时包？", consequence: "只有没用过（没有销课、流水、缴费记录）的课时包能删；用过的请改为暂停。", path: "data/packages/" + r.id, body: { version: r.version }, done: () => packages(c) }) }]
                  : []),
              ];
              return items.length ? UI.actionMenu({ items }).element : "";
            },
          },
        ],
        shown,
        { rowAction: (r) => flow(r), empty: q || fState.pkStatus ? "没有符合条件的课时包。" : "还没有课时包。" },
      ),
      n("p", "状态按暂停、有效期和余额计算；点一行查看这个课时包的流水。" + (money ? "" : "金额只对有学费权限的账号显示。"), { class: "v-muted v-fin-note" }),
    );
  }
  async function flow(row) {
    const view = UI.drawer({ title: row.student_name + " · " + row.course_name, subtitle: "剩余 " + F.units(row.balance) + " / 共 " + row.units_total + " 课时" });
    const rows = (await R().take("credits/transactions?student_id=" + encodeURIComponent(row.student_id))).filter((x) => x.package_id === row.id);
    view.body.append(
      vtable(
        [
          { label: "日期", value: (r) => r.date },
          { label: "类型", value: (r) => TX[r.type] || "课时变动" },
          { label: "变动", num: true, value: (r) => (r.delta > 0 ? "+" : "") + r.delta },
          { label: "说明", value: (r) => r.note || "" },
        ],
        rows,
        { empty: "还没有流水。" },
      ),
    );
  }

  // ---------- 月度结算 ----------
  const SETTLE = { draft: ["未提交", "muted"], pending: ["待主管批准", "warn"], locked: ["已锁定", "ok"] };
  async function payroll(c) {
    const [data, settlement] = await Promise.all([
      api("finance/payroll?month=" + financeMonth),
      enabled("settlements") ? api("finance/settlement?month=" + financeMonth) : Promise.resolve(null),
    ]);
    const rec = settlement?.record || { status: data.locked ? "locked" : "draft", locked: data.locked },
      [stText, stTone] = SETTLE[rec.status] || SETTLE.draft;
    vHead?.actions(exportBtn("finance"));
    c.replaceChildren();
    const bar = monthBar(c, () => payroll(c), chip(stText, stTone));
    // 结算状态条：说清楚现在在哪一步、下一步谁来做。
    const mm = Number(financeMonth.slice(5)) + " 月";
    const banner = n("div", null, { class: "v-fin-banner is-" + rec.status });
    const say = n("p");
    const acts = n("div", null, { class: "v-fin-banner-acts" });
    const run = async (action, title, consequence) => {
      if (!(await UI.confirm({ title, consequence, danger: false }))) return;
      try {
        await api("finance/settlements/" + action, "POST", { month: financeMonth, version: rec.version, reason: "", operation_id: operation() });
      } catch (e) {
        // 本月还有上完没销的课：把是哪几节列在结算条下面，处理完再提交。
        if (!e.details?.items?.length) throw e;
        banner.querySelector(".v-fin-block")?.remove();
        const box = n("div", null, { class: "v-fin-block", role: "alert" });
        const total = e.details.total || e.details.items.length;
        box.append(n("p", "还有 " + total + " 节课上完了但没销课，先处理完才能" + (action === "approve" ? "批准" : "提交") + "：", { class: "v-fin-block-title" }));
        const list = n("ul");
        for (const x of e.details.items)
          list.append(n("li", String(x.start_at || "").slice(0, 16).replace("T", " ") + " · " + (x.course_name || "") + " · " + (x.teacher_name || "") + " · 待销：" + (x.student_names || []).join("、")));
        box.append(list);
        if (total > e.details.items.length) box.append(n("p", "只列出前 " + e.details.items.length + " 节。", { class: "v-muted" }));
        if (enabled("attendance", "update") || enabled("attendance", "confirm"))
          box.append(button("去销课", () => (location.hash = "todo-unchecked"), "primary"));
        else
          box.append(n("p", "请联系教务或主管处理上述课程后，再提交结算。", { class: "v-muted" }));
        banner.append(box);
        return;
      }
      await payroll(c);
    };
    if (rec.status === "pending") {
      say.append(mm + "结算已由财务提交，等待主管批准。批准锁定后，" + mm + "的课程、出勤、课时流水不可再改，教师端课酬显示“已确认”。");
      if (me.user.roles.includes("supervisor")) acts.append(button("退回", () => settlementForm(c)));
      if (enabled("settlements", "approve"))
        acts.append(button("批准并锁定", () => run("approve", "批准并锁定 " + mm + "？", "锁定后本月课程、出勤和课时流水不可修改；付款记录仍可登记。"), "primary"));
    } else if (rec.locked || rec.status === "locked") {
      say.append(mm + "已锁定：课程、出勤和课时流水不可再改，付款记录可以继续登记。");
      if (me.user.roles.includes("supervisor")) acts.append(button("解锁", () => settlementForm(c)));
    } else {
      say.append(mm + "还没提交结算。核对课酬和付款后由财务提交，主管批准后锁定。");
      if (enabled("settlements", "submit"))
        acts.append(button("提交审批", () => run("submit", "提交 " + mm + "结算？", "提交后由主管批准锁定；在此之前本月数据变化需要重新提交。"), "primary"));
    }
    banner.append(say, acts);
    if (enabled("settlements")) c.append(banner);

    const items = data.items;
    const sum = (k) => items.reduce((s, r) => s + Number(r[k] || 0), 0);
    const adj = sum("adjustment_amount");
    c.append(
      P().kpis([
        P().kpi("应发课酬", F.money(sum("total_amount")), (adj ? "含调整 " + (adj > 0 ? "+" : "") + F.money(adj) + " · " : "") + sum("lesson_count") + " 节课"),
        P().kpi("已付", F.money(sum("paid_amount")), (data.payments?.length || 0) + " 笔付款"),
        P().kpi("未付", F.money(sum("unpaid_amount")), items.filter((r) => r.unpaid_amount > 0).length + " 位老师待付", sum("unpaid_amount") ? "warn" : ""),
      ]),
    );
    // 课酬标准已移到“教师 › 课酬标准”；这里只留本月相关的三项，作为按钮行里的小分页（不再是第三层整排分页）。
    const tabs = [["payroll", "教师课酬"]];
    if (enabled("teacher_pay", "create")) tabs.push(["adjustments", "课酬调整"], ["payments", "付款记录"]);
    if (fState.payrollTab === "rates") fState.payrollTab = "payroll";
    const nav = n("div", null, { class: "v-inner-tabs", role: "group", "aria-label": "结算分页" });
    for (const [k, t] of tabs) {
      const b = button(t, () => {
        fState.payrollTab = k;
        return payroll(c);
      });
      b.setAttribute("aria-current", fState.payrollTab === k ? "page" : "false");
      nav.append(b);
    }
    if (tabs.length > 1) (bar || c).append(nav);
    const body = n("div", null, { class: "v-fin-body" });
    c.append(body);
    if (fState.payrollTab !== "payroll") {
      await old.financeRecords(body, fState.payrollTab);
      return;
    }
    const state = (r) =>
      !r.total_amount ? ["—", ""] : r.unpaid_amount <= 0 ? ["已付清", "ok"] : r.paid_amount > 0 ? ["待付尾款", "warn"] : ["未付", "bad"];
    body.append(
      vtable(
        [
          { key: "name", label: "教师", value: (r) => r.teacher_name },
          { key: "count", label: "课次", num: true, value: (r) => String(r.lesson_count) },
          {
            key: "total",
            label: "应发",
            num: true,
            value: (r) => {
              const s = n("span", cell(r.total_amount));
              if (r.adjustment_amount) s.append(n("small", "调整 " + (r.adjustment_amount > 0 ? "+" : "") + F.money(r.adjustment_amount), { class: "v-fin-sub" }));
              return s;
            },
          },
          { key: "paid", label: "已付", num: true, value: (r) => cell(r.paid_amount) },
          { key: "unpaid", label: "未付", num: true, value: (r) => n("strong", cell(r.unpaid_amount)) },
          {
            key: "st",
            label: "状态",
            value: (r) => {
              const [t, tone] = state(r);
              return tone ? chip(t, tone) : t;
            },
          },
          {
            key: "op",
            label: "",
            cls: "is-act",
            value: (r) => {
              const w = n("span", null, { class: "v-renew-acts" });
              w.append(link("明细", () => payrollDetail(r, data.lessons.filter((l) => l.teacher_id === r.teacher_id))));
              if (enabled("teacher_pay", "create") && r.unpaid_amount > 0)
                w.append(link("登记付款", () => financeRecordForm(c, "payments", { teacher_id: r.teacher_id, month: financeMonth })));
              return w;
            },
          },
        ],
        items,
        {
          rowAction: (r) => payrollDetail(r, data.lessons.filter((l) => l.teacher_id === r.teacher_id)),
          foot: items.length > 1
            ? { name: "合计", count: String(sum("lesson_count")), total: F.money(sum("total_amount")), paid: F.money(sum("paid_amount")), unpaid: F.money(sum("unpaid_amount")) }
            : null,
          empty: "这个月没有课酬。",
        },
      ),
      n("p", "课酬按“教师 × 课程类型”当天生效的标准计算；请假、取消按缺勤规则处理。点一行看每节课的计算明细。", { class: "v-muted v-fin-note" }),
    );
  }

  // ---------- 其他成本 ----------
  async function costs(c) {
    const [rows, summary] = await Promise.all([R().take("finance/costs"), api("c3/costs-summary?month=" + financeMonth)]);
    const month = rows.filter((r) => r.date.slice(0, 7) === financeMonth).sort((a, b) => b.date.localeCompare(a.date));
    vHead?.actions(enabled("settlements", "create") ? button("＋ 新增成本", () => financeRecordForm(c, "costs"), "primary") : null);
    c.replaceChildren();
    const byCat = new Map();
    for (const r of month) byCat.set(r.category || "未分类", (byCat.get(r.category || "未分类") || 0) + Number(r.amount || 0));
    const future = month.filter((r) => r.date > today());
    monthBar(c, () => costs(c));
    c.append(
      P().kpis([
        P().kpi("本月合计", F.money(summary.cost_amount), month.length + " 笔"),
        ...[...byCat]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([k, v]) => P().kpi(k, F.money(v), "")),
      ]),
    );
    c.append(
      vtable(
        [
          { label: "日期", value: (r) => P().dayLabel(r.date) },
          { label: "类别", value: (r) => r.category || "未分类" },
          { label: "金额", num: true, value: (r) => F.money(r.amount) },
          { label: "说明", value: (r) => r.note || "" },
          {
            label: "",
            cls: "is-act",
            value: (r) => {
              const w = n("span", null, { class: "v-renew-acts" });
              if (enabled("settlements", "update")) w.append(link("编辑", () => financeRecordForm(c, "costs", r)));
              if (enabled("settlements", "delete"))
                w.append(
                  UI.actionMenu({
                    items: [
                      {
                        label: "删除",
                        danger: true,
                        onSelect: async () => {
                          if (!(await UI.confirm({ title: "删除这笔成本？", consequence: "已锁定月份需先解锁。", danger: true }))) return;
                          await api("finance/costs/" + r.id, "DELETE", { version: r.version, operation_id: operation() });
                          await costs(c);
                        },
                      },
                    ],
                  }).element,
                );
              return w;
            },
          },
        ],
        month,
        { empty: "这个月还没有登记成本。" },
      ),
    );
    if (future.length)
      c.append(
        n("p", "其中 " + future.length + " 笔日期在今天之后，报表到那天才计入利润。", { class: "v-muted v-fin-note" }),
      );
  }

  // ---------- 报表 ----------
  const SVG = "http://www.w3.org/2000/svg";
  const sv = (tag, attrs = {}, text) => {
    const x = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) x.setAttribute(k, String(v));
    if (text !== undefined) x.textContent = text;
    return x;
  };
  function trendChart(trend, incomeKey, incomeLabel, width) {
    const series = [
      [incomeKey, incomeLabel, "v-s-income"],
      ["teacher_pay_amount", "课酬", "v-s-pay"],
      ["cost_amount", "成本", "v-s-cost"],
    ].filter(([k]) => trend.some((r) => k in r));
    // 按页面实际宽度画，文字不被缩放；手机上更矮一些。
    const W = Math.max(300, Math.round(width || 720)),
      H = W < 600 ? 180 : 220,
      top = 16,
      bottom = 28,
      left = 8,
      plot = H - top - bottom;
    const max = Math.max(1, ...trend.flatMap((r) => series.map(([k]) => Math.abs(Number(r[k]) || 0))));
    const svg = sv("svg", { viewBox: "0 0 " + W + " " + H, class: "v-trend", role: "img", "aria-label": "近 6 个月" + incomeLabel + "、课酬、成本" });
    for (let i = 0; i <= 4; i++) {
      const y = top + (plot * i) / 4;
      svg.append(sv("line", { x1: left, x2: W, y1: y, y2: y, class: "v-trend-grid" }));
    }
    const slot = (W - left) / trend.length,
      bw = Math.min(22, (slot - 24) / series.length);
    trend.forEach((r, i) => {
      const x0 = left + slot * i + (slot - bw * series.length - 4 * (series.length - 1)) / 2;
      series.forEach(([k, label, cls], j) => {
        const raw = r[k],
          v = Math.abs(Number(raw) || 0),
          h = raw === null || raw === undefined ? 0 : Math.max(v ? 2 : 0, (v / max) * plot);
        const rect = sv("rect", { x: x0 + j * (bw + 4), y: top + plot - h, width: bw, height: h, rx: 3, class: "v-trend-bar " + cls });
        rect.append(sv("title", {}, r.month + " " + label + " " + (raw === null || raw === undefined ? "无数据" : F.money(raw))));
        svg.append(rect);
      });
      svg.append(sv("text", { x: left + slot * i + slot / 2, y: H - 8, class: "v-trend-label", "text-anchor": "middle" }, Number(r.month.slice(5)) + " 月"));
    });
    const box = n("div", null, { class: "v-trend-box" }),
      legend = n("div", null, { class: "v-trend-legend" });
    for (const [, label, cls] of series) {
      const it = n("span");
      it.append(n("i", null, { class: cls }), label);
      legend.append(it);
    }
    box.append(legend, svg);
    return box;
  }
  function renderEarnedDetails(host, data, { initialFilter = "all", initialQuery = "", onClose = null } = {}) {
    host.replaceChildren();
    if (!data || !Array.isArray(data.items)) {
      host.append(UI.empty({ text: data?._error ? "暂时无法加载确认收入明细：" + data._error : "当前暂无确认收入明细，或明细接口尚未启用。" }));
      return;
    }
    const local = { filter: initialFilter || "all", q: initialQuery || "" };
    const items = data.items || [];
    const hasSnapshot = typeof data.earned_amount === "number" && Number.isFinite(data.earned_amount);
    if (!hasSnapshot && items.length === 0) {
      host.append(UI.empty({ text: "历史快照未记录确认收入口径，且当月暂无实时明细，暂不可核对。" }));
      return;
    }
    const toCents = (v) => Math.round(Number(v || 0) * 100);
    const sum = data.summary || {};
    const lessonCents = sum.lesson_amount !== undefined
      ? toCents(sum.lesson_amount)
      : items.filter((r) => r.category === "lesson").reduce((s, r) => s + toCents(r.amount), 0);
    const otherCents = sum.other_income_amount !== undefined
      ? toCents(sum.other_income_amount)
      : items.filter((r) => r.category === "other").reduce((s, r) => s + toCents(r.amount), 0);
    const revCents = sum.reversal_amount !== undefined
      ? toCents(sum.reversal_amount)
      : items.filter((r) => r.category === "reversal").reduce((s, r) => s + toCents(r.amount), 0);
    const itemsCents = items.reduce((s, r) => s + toCents(r.amount), 0);
    const totalCents = hasSnapshot ? toCents(data.earned_amount) : null;
    const itemsTotal = itemsCents / 100;
    const totalAmt = totalCents !== null ? totalCents / 100 : null;
    const matched = hasSnapshot && itemsCents === totalCents;
    const wrap = n("div", null, { class: "fq-fin-edwrap" });

    // 顶部来源核对条
    const rec = n("div", null, { class: "fq-fin-edsum" });
    const formula = n("div", null, { class: "fq-fin-edform" });
    formula.append(
      n("span", "课程消课 "), n("strong", money(lessonCents / 100)),
      n("span", " + 其他收入 ", { class: "is-sep" }), n("strong", money(otherCents / 100), { class: "is-ok" }),
      n("span", " − 冲红撤回 ", { class: "is-sep" }), n("strong", money(Math.abs(revCents) / 100), { class: "is-bad" }),
      n("span", " = ", { class: "is-sep" }),
      hasSnapshot
        ? n("strong", money(totalAmt), { class: "is-tot" })
        : n("strong", "快照未记录", { class: "is-warn" }),
    );
    const check = n(
      "div",
      !hasSnapshot
        ? "历史快照未记录确认收入口径，暂不可核对（实时台账合计 " + money(itemsTotal) + "）"
        : matched
          ? (data.locked ? "✓ 已锁月 · 台账明细与锁月快照核对一致" : "✓ 明细合计与本月确认收入完全一致")
          : "明细合计 " + money(itemsTotal) + " · 快照 " + money(totalAmt),
      { class: "fq-fin-edchk" + (matched ? " is-ok" : " is-warn") },
    );
    rec.append(formula, check);

    const tools = n("div", null, { class: "fq-fin-edtools" });
    const filterHost = n("div", null, { class: "fq-fin-edfilters" });
    const qInput = n("input", null, {
      type: "search",
      class: "ui-control fq-fin-edq",
      placeholder: "搜学员 / 课程 / 老师...",
      value: local.q,
      "aria-label": "筛选确认收入明细",
    });
    const listHost = n("div", null, { class: "fq-fin-edlist" });

    const counts = {
      all: items.length,
      lesson: items.filter((r) => r.category === "lesson").length,
      other: items.filter((r) => r.category === "other").length,
      reversal: items.filter((r) => r.category === "reversal").length,
      unpriced: items.filter((r) => r.category === "unpriced").length,
    };

    const redraw = () => {
      filterHost.replaceChildren(
        chips(
          [
            ["all", "全部 · " + counts.all],
            ["lesson", "课程消课 · " + counts.lesson],
            ["other", "其他收入 · " + counts.other],
            ["reversal", "冲红撤回 · " + counts.reversal],
            ["unpriced", "仅看无单价 · " + counts.unpriced],
          ],
          local.filter,
          (k) => {
            local.filter = k;
            redraw();
          },
          "来源筛选",
        ),
      );

      const q = local.q.trim().toLowerCase();
      const filtered = items.filter((r) => {
        if (local.filter !== "all" && r.category !== local.filter) return false;
        if (!q) return true;
        return [r.student_name, r.course_name, r.teacher_name, r.source_label, r.package_name, r.note]
          .some((v) => String(v || "").toLowerCase().includes(q));
      });
      const sub = Math.round(filtered.reduce((s, r) => s + Number(r.amount || 0), 0) * 100) / 100;

      const tone = (cat) => ({ lesson: "violet", other: "ok", reversal: "err", unpriced: "warn" }[cat] || "");
      listHost.replaceChildren(
        vtable(
          [
            { label: "入账日期", key: "date", value: (r) => r.date || "—" },
            {
              label: "来源类型",
              key: "source",
              value: (r) => n("span", r.source_label || r.source || "—", { class: "fq-fin-pill is-" + tone(r.category) }),
            },
            {
              label: "学员",
              key: "student",
              value: (r) =>
                r.student_id
                  ? link(r.student_name || "未命名学员", () => {
                      onClose?.();
                      R().goStudent(r.student_id, "packages");
                    })
                  : (r.student_name || "—"),
            },
            {
              label: "课程与老师 / 说明",
              key: "detail",
              value: (r) => {
                const box = n("div", null, { class: "fq-fin-edcell" });
                box.append(n("strong", r.course_name || r.note || "—"));
                const meta = [r.start_at ? String(r.start_at).slice(5, 16).replace("T", " ") : "", r.teacher_name || "", r.package_name || "", r.note && r.course_name !== r.note ? r.note : ""]
                  .filter(Boolean)
                  .join(" · ");
                if (meta) box.append(n("small", meta));
                return box;
              },
            },
            {
              label: "课时 × 单价",
              key: "qty",
              num: true,
              value: (r) => {
                if (r.category === "other") return "—";
                if (r.unit_price === null || r.unit_price === undefined) return (r.unpriced_units || r.units || 0) + " 课时 × 未定价";
                return (r.units ?? 0) + " × " + money(r.unit_price);
              },
            },
            {
              label: "确认金额",
              key: "amount",
              num: true,
              value: (r) => {
                const box = n("div", null, { class: "fq-fin-edamt" + (Number(r.amount) < 0 ? " is-neg" : r.category === "unpriced" ? " is-warn" : "") });
                box.append(n("strong", money(r.amount)));
                if (r.category === "unpriced" && r.can_fix_price && r.student_id) {
                  box.append(
                    link("去补单价 →", () => {
                      onClose?.();
                      R().goStudent(r.student_id, "packages");
                    }),
                  );
                }
                return box;
              },
            },
          ],
          filtered,
          {
            empty: "当前筛选条件下暂无确认收入明细。",
            cls: "is-flat",
            foot: filtered.length
              ? {
                  date: "筛选小计",
                  source: filtered.length + " 笔",
                  student: "",
                  detail: "",
                  qty: "",
                  amount: money(sub),
                }
              : null,
          },
        ),
      );
    };

    qInput.addEventListener("input", () => {
      local.q = qInput.value;
      redraw();
    });
    tools.append(filterHost, qInput);
    wrap.append(rec, tools, listHost);
    host.append(wrap);
    redraw();
  }

  async function openEarnedDrawer(month = financeMonth, initialFilter = "all", initialQuery = "") {
    const mm = Number(month.slice(0, 4)) + " 年 " + Number(month.slice(5)) + " 月";
    const d = UI.drawer({
      title: mm + " · 确认收入明细",
      subtitle: "逐笔追溯至具体课程、学员与非学费其他收入",
    });
    d.body.append(n("p", "正在加载当月确认收入明细…", { class: "v-muted" }));
    const exp = exportBtn("report", "&scope=occurred");
    if (exp) d.footer.append(exp);
    const data = await api("c3/report/earned?month=" + month).catch((err) => ({ _error: err?.message || "加载失败" }));
    if (data?._error) {
      d.body.replaceChildren(UI.empty({ text: "明细暂不可用：" + data._error }));
      return;
    }
    renderEarnedDetails(d.body, data, {
      initialFilter,
      initialQuery,
      onClose: () => void d.close(),
    });
  }

  async function reports(c) {
    const [data, earnedData] = await Promise.all([
      api("c3/report?month=" + financeMonth),
      api("c3/report/earned?month=" + financeMonth).catch(() => null),
    ]);
    const hasEarned = "earned_amount" in data,
      basis = hasEarned ? fState.basis : "cash",
      earnedMissing = basis === "earned" && data.earned_amount === null;
    vHead?.actions(exportBtn("report", "&scope=occurred"));
    c.replaceChildren();
    const toggle = hasEarned
      ? chips(
          [
            ["earned", "确认收入"],
            ["cash", "实收现金"],
          ],
          basis,
          (k) => {
            fState.basis = k;
            void reports(c);
          },
          "收入口径",
        )
      : null;
    if (toggle) toggle.classList.add("v-seg-chips");
    monthBar(c, () => reports(c), toggle, n("span", null, { class: "v-spacer" }), n("span", (data.locked ? "已锁月 · " : "截至 ") + data.cutoff, { class: "v-muted v-fin-cut" }));
    const income = basis === "earned" ? data.earned_amount : data.tuition_amount,
      profit = basis === "earned" ? data.profit_earned : "profit_cash" in data ? data.profit_cash : data.profit_amount;
    const kpis = [];
    if ("tuition_amount" in data)
      kpis.push(
        P().kpi(
          basis === "earned" ? "确认收入" : "实收学费",
          earnedMissing ? "—" : money(income),
          basis === "earned"
            ? earnedMissing
              ? "该月在新口径上线前已锁定，只有实收口径"
              : "已消耗课时 × 课时包单价" + (data.unpriced_units ? " · 另有 " + data.unpriced_units + " 课时无单价未计入" : "")
            : "按收款日期",
          "money",
        ),
      );
    if ("teacher_pay_amount" in data) kpis.push(P().kpi("教师课酬", money(data.teacher_pay_amount), "已发生的课及计酬缺勤"));
    if ("cost_amount" in data) kpis.push(P().kpi("其他成本", money(data.cost_amount), "不含今天之后的成本"));
    if (profit !== undefined)
      kpis.push(
        P().kpi(
          data.locked ? "利润" : "利润（截至今天）",
          earnedMissing ? "—" : money(profit),
          basis === "earned" ? "确认收入 − 课酬 − 成本" : "实收 − 课酬 − 成本",
          profit < 0 ? "bad" : "money",
        ),
      );
    if (kpis.length) c.append(P().kpis(kpis));
    const ops = n("div", null, { class: "v-fin-ops" });
    for (const [label, v, hint] of [
      ["已发生课次", data.lesson_count, "已销课及计费缺勤"],
      ["已发生人次", data.participant_count, ""],
      ["待销课", data.pending_count, "过了时间还没点名"],
      ["已排未上", data.scheduled_count, "本月后面的课"],
    ]) {
      const it = n("div", null, { class: "v-fin-op" });
      it.append(n("span", label), n("strong", String(v ?? "—")), n("small", hint));
      ops.append(it);
    }
    c.append(ops);
    if (data.trend?.length) {
      const p = V().panel("近 6 个月趋势");
      p.append(trendChart(data.trend, basis === "earned" ? "earned_amount" : "tuition_amount", basis === "earned" ? "确认收入" : "实收", c.clientWidth - 46));
      if (basis === "earned" && data.trend.some((r) => r.earned_amount === null))
        p.append(n("p", "新口径上线前已锁定的月份没有确认收入，图中留空。", { class: "v-muted v-fin-note" }));
      c.append(p);
    }
    const tabs = [
      ["teachers", "按教师", data.teachers?.length || 0],
      ["courses", "按课程", data.courses?.length || 0],
      ["students", "按学员", data.students?.length || 0],
      ...(earnedData ? [["earned", "收入明细", earnedData.items?.length || 0]] : []),
    ];
    if (!tabs.some(([k]) => k === fState.repTab)) fState.repTab = "teachers";
    const box = V().panel("明细");
    const nav = n("nav", null, { class: "v-ptabs", "aria-label": "报表明细" });
    for (const [k, t, cnt] of tabs) {
      const b = n("button", t + " · " + cnt, { type: "button", class: "v-ptab" + (fState.repTab === k ? " is-on" : "") });
      b.addEventListener("click", () => {
        fState.repTab = k;
        if (k === "earned") {
          fState.repFilter = "all";
          fState.repQ = "";
        }
        void reports(c);
      });
      nav.append(b);
    }
    box.append(nav);

    if (fState.repTab === "earned" && earnedData) {
      const body = n("div");
      box.append(body);
      renderEarnedDetails(body, earnedData, {
        initialFilter: fState.repFilter,
        initialQuery: fState.repQ,
      });
      c.append(box);
      return;
    }

    const dimMap = new Map((earnedData?.dimensions?.[fState.repTab] || []).map((x) => [x.id, x]));
    const rows = [...(data[fState.repTab] || [])]
      .map((r) => {
        const extra = dimMap.get(r.id);
        return extra ? { ...r, earned_amount: extra.earned_amount, unpriced_units: extra.unpriced_units, other_income_amount: extra.other_income_amount } : r;
      })
      .sort((a, b) => (b.earned_amount ?? b.teacher_pay_amount ?? b.units) - (a.earned_amount ?? a.teacher_pay_amount ?? a.units));
    const pay = rows.some((r) => "teacher_pay_amount" in r);
    const hasRowEarned = rows.some((r) => "earned_amount" in r && r.earned_amount !== null && r.earned_amount !== undefined);
    box.append(
      vtable(
        [
          {
            label: fState.repTab === "courses" ? "课程" : "姓名",
            value: (r) => {
              const box = n("div", null, { class: "fq-fin-edcell" });
              box.append(n("strong", r.name));
              const notes = [];
              if (r.other_income_amount) notes.push("含其他收入 " + money(r.other_income_amount));
              if (r.unpriced_units) notes.push(r.unpriced_units + " 课时无单价");
              if (notes.length) box.append(n("small", notes.join(" · ")));
              return box;
            },
          },
          { label: "已发生课次", num: true, value: (r) => String(r.lesson_count) },
          { label: "课时", num: true, value: (r) => String(r.units) },
          ...(hasRowEarned ? [{ label: "确认收入", num: true, value: (r) => (r.earned_amount === null || r.earned_amount === undefined ? "—" : money(r.earned_amount)) }] : []),
          ...(pay ? [{ label: "课酬分摊", num: true, value: (r) => cell(r.teacher_pay_amount) }] : []),
          ...(hasRowEarned && pay
            ? [
                {
                  label: "课酬后毛利",
                  num: true,
                  value: (r) =>
                    r.earned_amount === null || r.earned_amount === undefined || r.teacher_pay_amount === null || r.teacher_pay_amount === undefined
                      ? "—"
                      : money((Math.round(Number(r.earned_amount) * 100) - Math.round(Number(r.teacher_pay_amount) * 100)) / 100),
                },
              ]
            : []),
        ],
        rows,
        {
          empty: "这个月还没有已发生的课。",
          cls: "is-flat",
          rowAction: earnedData
            ? (r) => {
                fState.repTab = "earned";
                fState.repFilter = "all";
                fState.repQ = r.name || "";
                return reports(c);
              }
            : null,
        },
      ),
    );
    c.append(box);
  }

  // ---------- 挂到原入口 ----------
  // 只接管财务各分页本身（页面主体里）；抽屉、学员详情里的同名调用仍走原实现。
  const inPage = (c) => !!c?.closest?.(".v-content") && !c.closest(".ui-overlay, .ui-sheet, .v-detail, .v-ptab-body");
  creditPage = (c, kind = "packages", studentId = "", ...args) => {
    c.dataset.creditScope = studentId || "";
    if (!studentId && inPage(c)) {
      if (kind === "payments") return payments(c);
      if (kind === "packages") return packages(c);
    }
    return old.creditPage(c, kind, studentId, ...args);
  };
  financePage = (c) => (inPage(c) ? payroll(c) : old.financePage(c));
  financeRecords = (c, kind, ...args) =>
    kind === "costs" && inPage(c) ? costs(c) : old.financeRecords(c, kind, ...args);
  reportsPage = (c) => (inPage(c) ? reports(c) : old.reportsPage(c));
  globalThis.ChannelV2Finance = {
    payments,
    packages,
    payroll,
    costs,
    reports,
    payTab: (k) => (fState.payTab = k),
    openEarnedDrawer,
    renderEarnedDetails,
  };
})();
