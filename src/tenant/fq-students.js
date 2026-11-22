// 枫琴教务中心 · 第三期「学员」页（设计稿 design/redesign/students/）。
// 加载在 v2p.js 之后：替换员工端学员页入口（studentsPage 与 ChannelRebuild.studentDetail），
// 名单状态、取数与缓存沿用 v2p.js 的 studentData；新建/编辑、课时包、缴费、阶段、跟进、开通账号、
// 显示号码、课表图、导出等写入全部调用原有表单与原接口，这里只换界面。
(() => {
  "use strict";
  const n = el,
    F = UI.fmt,
    V = () => globalThis.ChannelV2,
    R = () => globalThis.ChannelRebuild,
    P = () => globalThis.ChannelV2People;
  if (!P()?.studentData) return;
  const D = P().studentData,
    S = D.state;
  const phone = () => matchMedia("(max-width: 760px)").matches;
  const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const dayLabel = (iso) => iso.slice(5, 10) + " " + WEEK[new Date(iso.slice(0, 10) + "T12:00:00Z").getUTCDay()];
  const sink = (done) => P().sink(done);
  const pill = (text, tone = "", dot = true) =>
    n("span", text, { class: "fq-st-pill" + (tone ? " " + tone : "") + (dot ? "" : " no-dot") });
  const card = (cls = "") => n("section", null, { class: "fq-st-card" + (cls ? " " + cls : "") });
  function cardHead(title, sub, ...extra) {
    const head = n("header", null, { class: "fq-st-card-head" }),
      h = n("h3", title);
    if (sub) h.append(n("small", sub));
    head.append(h, n("span", null, { class: "fq-st-sp" }), ...extra.filter(Boolean));
    return head;
  }
  function btn(text, fn, tone = "") {
    const b = button(text, fn, tone === "primary" ? "primary" : "");
    b.classList.add("fq-st-btn");
    if (tone) for (const t of tone.split(" ")) b.classList.add("is-" + t);
    return b;
  }
  function textLink(text, fn) {
    const b = n("button", text, { type: "button", class: "fq-st-link" });
    b.addEventListener("click", fn);
    return b;
  }
  const avatar = (name, extra = "") => n("span", Array.from(name || "?")[0], { class: "fq-st-av" + (extra ? " " + extra : "") });
  const balanceTone = (row) =>
    row.balance === undefined ? "" : row.balance <= 0 ? "bad" : row.balance <= S.threshold ? "warn" : "";
  const BILLING = { package: "课时包扣课", overall: "整体收费" };

  // ---------- 新建 / 编辑学员：原表单，按设计稿重新分组 ----------
  // FORM_LAYOUT 只决定字段排列（字段、字段名、提交内容不变）；决定 3 保留展示同意字段，决定 7 改称「学员端」。
  if (typeof FORM_LAYOUT === "object" && FORM_LAYOUT.students)
    FORM_LAYOUT.students.groups = [
      ["基本信息", ["name", "status", "school", "grade", "direction"]],
      ["联系方式", ["parent_name", "parent_phone", "phone"]],
      ["收费方式", ["billing_mode"]],
      ["学员端与 AI", ["nickname", "parent_consent_media"]],
      ["备注", ["notes"]],
    ];
  async function studentForm(done, row) {
    await recordForm(sink(done), "students", row ? D.unmask(row) : undefined);
    const sheets = document.querySelectorAll("dialog.business-drawer");
    const sheet = sheets[sheets.length - 1],
      form = sheet?.querySelector("form.v-std-form");
    if (!form) return;
    sheet.classList.add("fq-st-drawer-on");
    const title = sheet.querySelector(".ui-sheet-title");
    if (title && !row) {
      title.replaceChildren("新建学员", n("em", "New student"));
      form.before(n("p", "只有姓名必填；其他可以以后在「编辑档案」补。", { class: "fq-st-dr-sub" }));
    } else if (title) title.replaceChildren("编辑档案", n("em", row.name));
    for (const g of form.querySelectorAll(".v-fgroup > h3"))
      if (g.textContent === "联系方式") g.append(n("span", "号码保存后只显示打码，有权限的人可点「显示号码」"));
    // 决定 3：展示同意字段保留；成长报告已删除，说明里不再提它（只改文字，字段不变）。
    const consent = form.elements.parent_consent_media?.closest(".ui-field, .field");
    if (consent) {
      const walk = document.createTreeWalker(consent, NodeFilter.SHOW_TEXT);
      for (let t = walk.nextNode(); t; t = walk.nextNode()) t.textContent = t.textContent.replace("成长报告、", "");
    }
    // 收费方式：两段式选择，背后仍是原下拉框（提交值不变）。
    const sel = form.elements.billing_mode;
    if (sel?.tagName === "SELECT") {
      const seg = n("div", null, { class: "fq-st-seg", role: "radiogroup", "aria-label": "收费方式" });
      const hints = { package: "上课按课时包扣减", overall: "只记出勤课时" };
      const paint = () => {
        for (const b of seg.children) {
          const on = b.dataset.value === sel.value;
          b.classList.toggle("is-on", on);
          b.setAttribute("aria-checked", String(on));
        }
      };
      for (const o of sel.options) {
        if (!o.value) continue;
        const b = n("button", null, { type: "button", role: "radio", "data-value": o.value });
        b.append(n("span", BILLING[o.value] || o.textContent), n("small", hints[o.value] || ""));
        b.addEventListener("click", () => {
          sel.value = o.value;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          paint();
        });
        seg.append(b);
      }
      paint();
      const holder = sel.closest(".ui-field, .field");
      holder?.classList.add("fq-st-seg-field", "is-wide");
      sel.after(seg);
    }
  }

  // ---------- 名单 ----------
  function studentList(c, selected) {
    const box = card("fq-st-list"),
      head = n("div", null, { class: "fq-st-list-head" }),
      search = n("label", null, { class: "fq-st-search" }),
      input = n("input", null, {
        type: "search",
        placeholder: "搜索姓名、家长、手机尾号",
        "aria-label": "搜索学员（姓名、家长、手机尾号 4 位以上）",
        maxlength: "100",
      });
    input.value = S.q;
    search.append(UI.icon("search"), input);
    let timer;
    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        S.q = input.value.trim();
        refreshList(c);
      }, 300);
    });
    const chips = n("div", null, { class: "fq-st-chips", role: "group", "aria-label": "筛选" }),
      counts = S.counts || {};
    const opts = [
      ["active", "在读", counts.active],
      ...(enabled("packages") ? [["zero", "已用完", counts.zero], ["low", "快用完", counts.low]] : []),
      ["all", "全部", counts.active === undefined ? undefined : (counts.active || 0) + (counts.paused || 0) + (counts.archived || 0)],
    ];
    if (opts.length < 4) chips.classList.add("is-two");
    for (const [key, label, count] of opts) {
      const b = n("button", label, {
        type: "button",
        class: "fq-st-chip" + (S.filter === key ? " is-on" : "") + (key === "zero" ? " bad" : key === "low" ? " warn" : ""),
        "aria-pressed": String(S.filter === key),
        "data-count-key": key,
      });
      if (count !== undefined && count !== null) b.append(n("b", String(count)));
      b.addEventListener("click", () => {
        S.filter = key;
        for (const x of chips.children) {
          x.classList.toggle("is-on", x === b);
          x.setAttribute("aria-pressed", String(x === b));
        }
        refreshList(c);
      });
      chips.append(b);
    }
    head.append(search, chips);
    box.append(head, listRows(selected), listFoot(c));
    return box;
  }
  function listRows(selected) {
    const rows = n("div", null, { class: "fq-st-rows" });
    for (const row of S.items) {
      const item = n("button", null, {
        type: "button",
        class: "fq-st-row" + (row.id === selected ? " is-on" : ""),
        "data-id": row.id,
        ...(row.id === selected ? { "aria-current": "true" } : {}),
      });
      const who = n("span", null, { class: "fq-st-who" }),
        name = n("strong", row.name);
      if (row.same_name_count > 1 && row.grade) name.append(n("small", row.grade, { class: "fq-st-tag" }));
      if (row.status !== "active") name.append(n("small", UI.personStatus(row), { class: "fq-st-tag" }));
      who.append(name, n("span", row.course_names ? row.course_names.split(",").join(" · ") : "暂无课时包"));
      item.append(avatar(row.name), who);
      if (row.balance !== undefined) {
        if (!row.package_count) item.append(n("span", "无课时包", { class: "fq-st-bal none" }));
        else {
          const tone = balanceTone(row),
            bal = n("span", null, { class: "fq-st-bal" + (tone ? " " + tone : "") });
          const num = Number(row.balance);
          bal.append(
            n("b", String(Math.round(num * 100) / 100)),
            num < 0 ? "欠 " + F.units(-num) : num === 0 ? "已用完" : tone === "warn" ? "快用完" : "课时",
          );
          item.append(bal);
        }
      } else item.append(n("span"));
      item.addEventListener("click", () => R().goStudent(row.id));
      rows.append(item);
    }
    if (!S.items.length)
      rows.append(n("p", S.q ? "没有找到“" + S.q + "”。" : "这里还没有学员。", { class: "fq-st-empty" }));
    return rows;
  }
  function listFoot(c) {
    const foot = n("div", null, { class: "fq-st-list-foot" });
    foot.append(n("span", "共 " + (S.total ?? S.items.length) + " 人" + (S.next !== null ? " · 已显示 " + S.items.length : "")));
    if (S.next !== null)
      foot.append(
        textLink("加载更多", async () => {
          const f = { active: ["active", ""], zero: ["active", "zero"], low: ["active", "low"], all: ["", ""] }[S.filter];
          const more = await api("c2/students?" + new URLSearchParams({ q: S.q, status: f[0], balance: f[1], offset: S.next }));
          S.items.push(...more.items);
          S.next = more.next_offset ?? null;
          refreshList(c, true);
        }),
      );
    return foot;
  }

  // ---------- 详情 ----------
  async function detailView(c, id, tab, isPhone) {
    const key = encodeURIComponent(id);
    const want = {
      packs: tab === "overview" && enabled("packages") ? api("credits/packages?student_id=" + key).then((d) => d.items || []) : null,
      // 跟进页签的角标要未完成数，所以每次都取（与概况共用同一个请求）。
      tasks: enabled("followup") ? toolPage("followup_tasks", id).then((d) => d.items || []) : null,
      records: tab === "records" && !isPhone ? R().take("c2/students/" + key + "/history") : null,
      blocks: tab === "more" ? api("c2/students/" + key + "/blocks") : null,
    };
    for (const v of Object.values(want)) v?.catch(() => {});
    if (tab === "schedule" && enabled("schedule")) {
      const monday = weekStart(todayBJ());
      apiPrefetch(["schedule?from=" + monday + "&to=" + dateShift(monday, 7) + "&student_id=" + key + "&offset=0", "students/" + key + "/fixed-rules"]);
    }
    const [rec, data, history] = await D.base(id);
    const row = rec.record,
      facts = data.facts || {},
      groups = data.renewal_groups || [];
    const again = () => render(c, true);
    const openTasks = want.tasks ? await want.tasks.then((x) => x.filter((t) => !t.done)).catch(() => null) : null;
    const urgent = groups.find((g) => g.state === "zero") || groups.find((g) => g.state === "low");
    const remind = async (group) => {
      const view = UI.drawer({ title: "续费提醒 · " + row.name, subtitle: group.course_name });
      await renewalNotice(view.body, await api("renewal-brand"), group);
    };
    const wrap = n("div", null, { class: "fq-st fq-st-detail" + (isPhone ? " is-phone" : ""), "data-id": id });

    // 名字、标签、联系方式（手机与电脑共用，手机放进深紫英雄卡）
    const name = n("div", null, { class: "fq-st-name" });
    name.append(n("h2", row.name), pill(UI.personStatus(row), row.status === "active" ? "ok" : ""));
    if (row.direction) name.append(pill(row.direction, "info"));
    if (urgent && !isPhone) name.append(pill(urgent.course_name + (urgent.state === "zero" ? "课时已用完" : "课时快用完"), urgent.state === "zero" ? "bad" : "warn"));
    const same = S.items.filter((x) => x.name === row.name && x.id !== row.id);
    if (same.length) name.append(pill("同名：另有 " + row.name + (same[0].grade ? " · " + same[0].grade : ""), "warn"));
    const contact = n("p", null, { class: "fq-st-contact" });
    const seg = (...kids) => {
      const x = n("span");
      x.append(...kids);
      contact.append(x);
    };
    const school = [row.grade, !isPhone && row.school].filter(Boolean).join(" · ");
    if (school) seg(school);
    const parentNo = n("span", row.parent_phone || "", { class: "fq-st-num" }),
      studentNo = n("span", row.phone || "", { class: "fq-st-num" });
    if (row.parent_name || row.parent_phone) seg("家长 " + (row.parent_name || "") + (row.parent_phone ? " " : ""), parentNo);
    if (row.phone && !isPhone) seg("学员 ", studentNo);
    if (enabled("accounts", "reveal_phone") && (row.parent_phone || row.phone)) {
      const show = textLink("显示号码", async () => {
        const r = await api("data/students/" + id + "/contact", "POST", {});
        parentNo.textContent = r.parent_phone || "未填";
        studentNo.textContent = r.phone || "未填";
        if (isPhone && r.phone) seg("学员 ", studentNo);
        show.remove();
      });
      contact.append(show);
    }
    const acct = n("p", null, { class: "fq-st-acct" + (row.account_id && row.account_active ? "" : " is-off") });
    acct.append(
      n("i"),
      (row.account_id ? "学员账号已开通" + (row.account_active ? "" : " · 已停用") : "未开通学员账号") +
        (isPhone ? "" : " · 收费方式：" + (BILLING[row.billing_mode] || BILLING.package)),
    );

    // 更多：账号 / 状态 / 危险
    const more = [];
    if (!row.account_id && enabled("accounts", "create_personal"))
      more.push({ group: "学员账号", label: "开通学员账号", onSelect: () => personalAccount("students", row) });
    if (row.account_id && enabled("accounts", "reset_personal"))
      more.push({
        group: "学员账号",
        label: "重置学员账号密码",
        onSelect: async () => {
          if (await UI.confirm({ title: "重置学员密码？", consequence: "原密码失效，所有设备下线；初始密码仅显示一次。" }))
            showSecret(await api("accounts/" + row.account_id + "/reset-password", "POST", {}));
        },
      });
    if (enabled("students", "update"))
      for (const [value, label] of [["active", "恢复在读"], ["paused", "暂停"], ["archived", "归档"]])
        if (row.status !== value)
          more.push({
            group: "状态",
            label,
            onSelect: async () => {
              if (await UI.confirm({ title: label + "：" + row.name + "？", consequence: "保留历史课程、缴费与审计记录。" })) {
                await api("data/students/" + id, "PATCH", { status: value, version: row.version });
                S.counts = null;
                await again();
              }
            },
          });
    if (enabled("students", "delete"))
      more.push({
        group: "",
        label: "删除学员",
        danger: true,
        onSelect: async () => {
          if (await UI.confirm({ title: "删除学员？", consequence: "仅无课程、课时包等关联的档案可删除；有历史记录时请归档。", danger: true })) {
            await api("data/students/" + id, "DELETE", { version: row.version });
            S.counts = null;
            S.key = "";
            location.hash = "students";
          }
        },
      });
    const moreMenu = (label) => {
      if (!more.length) return null;
      const m = UI.actionMenu({ label, items: more });
      m.menu.classList.add("fq-st-menu");
      let last = null;
      [...m.menu.children].forEach((b, i) => {
        const g = more[i].group;
        if (i && g !== last) b.before(n("hr"));
        if (g && g !== last) b.before(n("small", g));
        last = g;
      });
      return m;
    };
    const timetable = async () => {
      const view = UI.drawer({ title: row.name + " · 本周课表图" });
      await timetableImage(view.body, weekStart(todayBJ()), "student_id=" + encodeURIComponent(id));
    };
    const addPack = (extra = {}) => creditForm(sink(again), "packages", { student_id: id, ...extra });

    // 四个数字
    const month = todayBJ().slice(0, 7),
      thisMonth = (history || []).filter((l) => l.start_at.slice(0, 7) === month && l.status !== "planned");
    const worst = groups.find((g) => g.state === "zero") ? "已用完" : groups.find((g) => g.state === "low") ? "快用完" : "";
    const nums = {
      balance:
        facts.balance !== undefined && {
          label: "剩余课时",
          value: facts.debt_units > 0 ? F.units(facts.available_units ?? -facts.debt_units) : F.units(facts.balance),
          hint:
            facts.debt_units > 0
              ? "欠 " + F.units(facts.debt_units) + " · 买课时包后自动补扣"
              : facts.package_count + " 个课时包" + (worst ? " · " + worst : ""),
          tone: facts.balance <= 0 || facts.debt_units > 0 ? "bad" : worst ? "warn" : "",
        },
      month: history && {
        label: "本月上课",
        value: thisMonth.filter((l) => l.attendance === "attended" || l.attendance === "no_show").length + " 次",
        hint: "请假 " + thisMonth.filter((l) => l.attendance === "student_leave").length + " · 缺课 " + thisMonth.filter((l) => l.attendance === "no_show").length,
      },
      next: enabled("schedule") && {
        label: "下次课",
        value: data.next ? dayLabel(data.next.start_at) + " " + F.time(data.next.start_at) : "暂无安排",
        hint: data.next ? data.next.course_name + " · " + data.next.teacher_name : "",
      },
      paid: facts.paid_amount !== undefined && {
        label: "累计缴费",
        value: F.money(facts.paid_amount),
        hint: facts.due_unresolved ? "收款待核对 " + facts.due_unresolved + " 笔" : "欠费 " + F.money(facts.due_amount || 0),
      },
    };
    // 「12 次」→ 大数字 12 + 小字「次」
    const big = (value, tone = "", extra = "") => {
      const b = n("div", null, { class: "fq-st-big" + (tone ? " " + tone : "") + (extra ? " " + extra : "") });
      const m = /^(-?[\d.,]+)\s*(\S+)$/.exec(String(value));
      if (m && !extra) b.append(m[1], n("small", m[2]));
      else b.append(String(value));
      return b;
    };

    // 页签
    const tabs = [
      ["overview", "概况", !isPhone],
      ["schedule", "课表", enabled("schedule")],
      ["records", "上课记录", enabled("schedule")],
      ["packages", "课时与缴费", enabled("packages") || enabled("tuition")],
      ["followup", "跟进", enabled("followup")],
      ["stages", "学习阶段", enabled("students")],
      ["repertoire", "曲目 / 作品", enabled("feedback") || (typeof yxIsTeacher === "function" && yxIsTeacher())],
      // 决定 1：原「更多」页签只剩这一项，直接叫「不可排时段」（路由仍是 -more）。
      ["more", "不可排时段", enabled("students", "read")],
    ].filter((x) => x[2]);
    if (tab === "payments") tab = "packages";
    if (!tabs.some((x) => x[0] === tab)) tab = tabs[0]?.[0] || "packages";
    const bar = n("nav", null, { class: "fq-st-tabs" + (isPhone ? " is-pills" : ""), "aria-label": "学员资料分页" });
    for (const [k, label] of tabs) {
      const b = n("button", label, { type: "button", class: "fq-st-tab" + (k === tab ? " is-on" : "") });
      if (k === "followup" && openTasks?.length) b.append(n("sup", String(openTasks.length)));
      if (k === tab) b.setAttribute("aria-current", "page");
      b.addEventListener("click", () => {
        for (const x of bar.children) {
          x.classList.toggle("is-on", x === b);
          x === b ? x.setAttribute("aria-current", "page") : x.removeAttribute("aria-current");
        }
        R().goStudent(id, k);
      });
      bar.append(b);
    }

    if (isPhone) {
      const back = n("div", null, { class: "fq-st-back" });
      back.append(textLink("‹ 学员", () => (location.hash = "students")), n("span", null, { class: "fq-st-sp" }));
      if (enabled("students", "update")) {
        const edit = n("button", null, { type: "button", class: "fq-st-iconbtn", "aria-label": "编辑档案" });
        edit.append(UI.icon("edit"));
        edit.addEventListener("click", () => studentForm(again, row));
        back.append(edit);
      }
      const m = moreMenu("");
      if (m) {
        m.trigger.classList.add("fq-st-iconbtn");
        m.trigger.setAttribute("aria-label", "更多操作");
        m.trigger.replaceChildren(UI.icon("more"));
        back.append(m.element);
      }
      const hero = n("section", null, { class: "fq-st-hero" }),
        top = n("div", null, { class: "fq-st-prof-top" }),
        main = n("div", null, { class: "fq-st-prof-main" });
      main.append(name, contact, acct);
      top.append(avatar(row.name, "is-big"), main);
      const grid = n("div", null, { class: "fq-st-hero-nums" });
      for (const x of [nums.balance, nums.next, nums.month, nums.paid].filter(Boolean)) {
        const cell = n("div");
        const isNext = x === nums.next;
        cell.append(n("small", x.label), n("b", x.value, { class: (x.tone ? x.tone : "") + (isNext ? " sm" : "") }), n("span", x.hint || ""));
        grid.append(cell);
      }
      hero.append(top);
      if (grid.childElementCount) hero.append(grid);
      const quick = n("div", null, { class: "fq-st-quick" });
      if (enabled("accounts", "reveal_phone") && row.parent_phone)
        quick.append(
          btn("打给家长", async () => {
            const r = await api("data/students/" + id + "/contact", "POST", {});
            if (r.parent_phone) location.href = "tel:" + r.parent_phone;
            else notice("没有填写家长手机");
          }),
        );
      if (urgent && enabled("exports", "export")) quick.append(btn("续费提醒", () => remind(urgent), "warn"));
      if (enabled("packages", "create")) quick.append(btn("＋ 课时包", () => addPack(), "primary"));
      quick.classList.add("is-" + quick.childElementCount);
      wrap.append(back, hero);
      if (quick.childElementCount) wrap.append(quick);
    } else {
      const prof = card("fq-st-profile"),
        top = n("div", null, { class: "fq-st-prof-top" }),
        main = n("div", null, { class: "fq-st-prof-main" });
      main.append(name, contact, acct);
      top.append(avatar(row.name, "is-big"), main);
      const ops = n("div", null, { class: "fq-st-ops" });
      if (enabled("students", "update")) ops.append(btn("编辑档案", () => studentForm(again, row)));
      if (enabled("exports", "export") && enabled("schedule")) ops.append(btn("生成课表图", timetable));
      if (urgent && enabled("exports", "export")) ops.append(btn("发续费提醒", () => remind(urgent), "warn"));
      ops.append(n("span", null, { class: "fq-st-sp" }));
      if (enabled("packages", "create")) ops.append(btn("＋ 课时包", () => addPack(), "primary"));
      const m = moreMenu("更多");
      if (m) {
        m.trigger.classList.add("fq-st-btn");
        ops.append(m.element);
      }
      prof.append(top, ops);
      const stats = n("div", null, { class: "fq-st-stats" });
      const stat = (x, icon, dark) => {
        if (!x) return;
        const box = card("fq-st-stat" + (dark ? " is-dark" : ""));
        const h = n("div", null, { class: "fq-st-stat-h" });
        if (dark) h.append(n("em", "Next lesson"), n("span", x.label));
        else {
          const ic = n("span", null, { class: "fq-st-ic" + (x.tone === "warn" ? " warn" : x.tone === "bad" ? " bad" : "") });
          ic.append(UI.icon(icon));
          h.append(n("span", x.label), ic);
        }
        box.append(h, big(x.value, x.tone, dark ? "is-when" : x === nums.paid ? "is-money" : ""), n("p", x.hint || ""));
        stats.append(box);
      };
      stat(nums.balance, "clock");
      stat(nums.month, "check");
      stat(nums.next, "calendar", true);
      stat(nums.paid, "wallet");
      stats.classList.add("is-" + stats.childElementCount);
      wrap.append(prof);
      if (stats.childElementCount) wrap.append(stats);
    }
    wrap.append(bar);
    const body = n("div", null, { class: "fq-st-tabbody is-" + tab });
    wrap.append(body);

    if (tab === "overview") {
      body.classList.add("fq-st-ov");
      const left = n("div", null, { class: "fq-st-col" }),
        right = n("div", null, { class: "fq-st-col" });
      const recent = card();
      recent.append(
        cardHead("最近上课与点评", "最近 5 次 · 点一条看课程详情", enabled("schedule") && textLink("全部记录 →", () => R().goStudent(id, "records"))),
      );
      const tl = n("div", null, { class: "fq-st-tl" });
      for (const l of data.recent || []) tl.append(timelineItem(c, l));
      if (!data.recent?.length) tl.append(n("p", "上课后，最近五次记录和点评会显示在这里。", { class: "fq-st-empty" }));
      recent.append(tl);
      left.append(recent);
      if (enabled("packages")) right.append(packsCard(await want.packs.catch(() => []), groups, data, remind, addPack));
      if (openTasks) right.append(tasksCard(openTasks, id, again));
      body.append(left, right);
    } else if (tab === "records" && isPhone) {
      const box = card("fq-st-records");
      const rows = (history || []).filter((l) => l.status !== "planned").slice(0, 20);
      const tl = n("div", null, { class: "fq-st-tl" });
      for (const l of rows) tl.append(timelineItem(c, l));
      if (!rows.length) tl.append(n("p", "还没有上课记录。", { class: "fq-st-empty" }));
      box.append(tl);
      body.append(box);
    } else if (tab === "records") {
      const box = card("fq-st-table");
      box.append(cardHead("上课记录", "点一行看课程详情"));
      const inner = n("div");
      box.append(inner);
      body.append(box);
      R().table(
        inner,
        [
          { key: "start_at", label: "时间", render: (r) => F.date(r.start_at) + " " + F.time(r.start_at) },
          { key: "course_name", label: "课程" },
          { key: "teacher_name", label: "教师" },
          {
            key: "attendance",
            label: "出勤",
            render: (r) => (r.status === "planned" ? "待销课" : me.labels.attendance[r.attendance] || me.labels.lessons?.[r.status] || ""),
          },
          { key: "public_text", label: "点评", sortable: false, render: (r) => r.public_text || r.private_comment || "—" },
        ],
        await want.records,
        { rowAction: (r) => lessonDetail(c, r) },
      );
    } else if (tab === "packages") {
      body.classList.add("fq-st-pkgs");
      const jobs = [];
      const funds = n("div", null, { class: "fq-st-fundsbox" });
      body.append(funds);
      jobs.push(globalThis.ChannelV2Pay.studentFunds(funds, id, row.name, again).catch(() => {}));
      const section = (title, en, sub, host) => {
        const h = n("div", null, { class: "fq-st-sec" });
        h.append(n("h3", title), n("em", en));
        if (sub) h.append(n("small", sub));
        const box = card("fq-st-table");
        box.append(host);
        body.append(h, box);
      };
      if (enabled("packages")) {
        const a = n("div");
        section("课时包", "Packages", groups.length ? "先买先扣 · " + groups.length + " 组有效" : "", a);
        jobs.push(creditPage(a, "packages", id));
      }
      if (enabled("tuition")) {
        const b = n("div");
        section("缴费记录", "Payments", facts.paid_amount !== undefined ? "累计 " + F.money(facts.paid_amount) : "", b);
        jobs.push(creditPage(b, "payments", id));
      }
      await Promise.all(jobs);
    } else if (tab === "schedule") {
      const box = n("div", null, { class: "fq-st-week-box" });
      body.append(box);
      await V().studentWeek(box, id, c);
      if (isPhone && enabled("exports", "export")) body.append(btn("生成本周课表图", timetable, "wide"));
    } else if (tab === "followup") {
      const box = card("fq-st-plain");
      body.append(box);
      await followupPage(box, id);
    } else if (tab === "stages") {
      const box = card("fq-st-plain");
      body.append(box);
      await creditPage(box, "stages", id);
    } else if (tab === "repertoire") {
      const box = card("fq-st-plain");
      body.append(box);
      await yxRepertoireTab(box, id);
    } else {
      const box = card();
      box.append(
        cardHead(
          "不可排时段",
          "排课时避开这些时间（每周重复）",
          btn(enabled("students", "update") ? "管理" : "查看", () => R().studentBlocks(c, id), "sm"),
        ),
      );
      const items = (await want.blocks.catch(() => [])) || [];
      const DAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
      for (const b of Array.isArray(items) ? items : items.items || []) {
        const r = n("div", null, { class: "fq-st-rule" + (b.active ? "" : " is-off") });
        r.append(n("strong", DAYS[b.weekday] + " " + b.start_time + "–" + b.end_time), n("small", (b.label || "未写说明") + (b.active ? "" : " · 已停用")));
        box.append(r);
      }
      if (box.childElementCount === 1) box.append(n("p", "还没有设置不可排时段。", { class: "fq-st-empty" }));
      body.append(box);
    }
    return wrap;
  }

  function timelineItem(c, l) {
    const planned = l.status === "planned",
      off = !planned && l.attendance !== "attended";
    const item = n("button", null, { type: "button", class: "fq-st-tl-item" + (planned ? " is-warn" : off ? " is-off" : "") });
    const main = n("div"),
      top = n("div", null, { class: "fq-st-tl-top" });
    top.append(
      n("strong", dayLabel(l.start_at) + " " + F.time(l.start_at)),
      n("span", null, { class: "fq-st-sp" }),
      planned
        ? pill("待销课", "warn")
        : pill(me.labels.attendance[l.attendance] || me.labels.lessons?.[l.status] || "", l.attendance === "attended" ? "ok" : ""),
    );
    main.append(top, n("div", l.course_name + (l.teacher_name ? " · " + l.teacher_name : ""), { class: "fq-st-tl-sub" }));
    if (l.public_text || l.private_comment) {
      const note = n("div", l.public_text || "", { class: "fq-st-tl-note preserve-text" });
      if (l.private_comment) note.append(n("span", "内部备注：" + l.private_comment, { class: "fq-st-priv" }));
      main.append(note);
    } else
      main.append(n("div", planned ? "下课后还没点名，去「待办」处理。" : "老师未填写点评", { class: "fq-st-tl-note is-empty" }));
    item.append(n("span", null, { class: "fq-st-tl-dot" }), main);
    item.addEventListener("click", () => lessonDetail(c, l));
    return item;
  }

  function packsCard(packs, groups, data, remind, addPack) {
    const box = card();
    box.append(cardHead("课时包", "", enabled("packages", "create") && textLink("＋ 课时包", () => addPack())));
    for (const g of groups) {
      const mine = packs.filter((p) => g.package_ids.includes(p.id)),
        total = mine.reduce((s, p) => s + Number(p.units_total || 0), 0);
      const item = n("div", null, { class: "fq-st-pack" }),
        top = n("div", null, { class: "fq-st-pack-top" });
      top.append(
        n("strong", g.course_name + (total ? " · " + F.units(total) : "")),
        g.state === "zero" ? pill("已用完", "bad") : g.state === "low" ? pill("快用完", "warn") : pill("正常", "ok"),
      );
      const meter = n("div", null, {
        class: "fq-st-meter" + (g.state === "zero" ? " bad" : g.state === "low" ? " warn" : ""),
        role: "meter",
        "aria-label": "剩余课时",
        "aria-valuemin": "0",
        "aria-valuemax": String(Math.max(total, 1)),
        "aria-valuenow": String(Math.max(0, Number(g.balance))),
      });
      const pct = Math.max(0, Math.min(100, (Number(g.balance) / Math.max(total, 1)) * 100));
      const fill = n("i");
      fill.setAttribute("data-pct", String(Math.round(pct / 5) * 5));
      meter.append(fill);
      const next = data.next && data.next.course_name === g.course_name ? " · " + data.next.start_at.slice(5, 10) + " 还有一节课" : "";
      item.append(
        top,
        meter,
        n("p", "剩 " + F.units(g.balance) + (total ? " / " + F.units(total) : "") + " · " + (g.valid_to ? "至 " + g.valid_to : "不限有效期") + (g.expiring ? "（快到期）" : "") + next),
      );
      const acts = n("div", null, { class: "fq-st-pack-ops" });
      if (g.state !== "active" && enabled("exports", "export")) acts.append(btn("发续费提醒", () => remind(g), "warn sm"));
      if (enabled("packages", "create")) acts.append(btn("＋ 同课程课时包", () => addPack({ course_type_id: g.course_type_id || undefined }), "sm"));
      if (acts.childNodes.length) item.append(acts);
      box.append(item);
    }
    if (!groups.length) box.append(n("p", "还没有有效的课时包。", { class: "fq-st-empty" }));
    return box;
  }

  function tasksCard(tasks, id, again) {
    const box = card();
    box.append(cardHead("跟进任务", "", enabled("followup", "create") && textLink("＋ 添加", () => followupForm(sink(again), "followup_tasks", id))));
    const today = todayBJ();
    for (const t of tasks) {
      const label = n("label", null, { class: "fq-st-task" }),
        check = n("input", null, { type: "checkbox", "aria-label": "完成：" + t.title });
      check.disabled = !enabled("followup", "update");
      check.addEventListener("change", async () => {
        check.disabled = true;
        try {
          await api("tools/followup_tasks/" + t.id, "PATCH", { ...t, version: t.version, done: true });
          await again();
        } catch (e) {
          check.checked = false;
          check.disabled = false;
          notice(e.message);
        }
      });
      const late = t.due_date && t.due_date < today;
      const text = n("span");
      if (t.due_date) text.append(n("b", t.due_date.slice(5), { class: late ? "late" : "" }));
      text.append(t.title);
      const meta = [t.owner_name && "负责人 " + t.owner_name, late && "已逾期 " + Math.round((Date.parse(today) - Date.parse(t.due_date)) / 86400000) + " 天"].filter(Boolean);
      if (meta.length) text.append(n("small", meta.join(" · ")));
      label.append(check, text);
      box.append(label);
    }
    if (!tasks.length) box.append(n("p", "没有未完成的跟进。", { class: "fq-st-empty" }));
    return box;
  }

  // ---------- 页面 ----------
  const showCounts = (c, k) => {
    vHead?.sub(["在读 " + k.active, k.paused && "暂停 " + k.paused, k.archived && "归档 " + k.archived].filter(Boolean).join(" · "));
    for (const b of c.querySelectorAll(".fq-st-chip[data-count-key]")) {
      const key = b.dataset.countKey;
      const v = key === "all" ? (k.active || 0) + (k.paused || 0) + (k.archived || 0) : k[key];
      if (v === undefined || v === null) continue;
      const tag = b.querySelector("b") || b.appendChild(n("b"));
      tag.textContent = String(v);
    }
  };
  async function render(c, force) {
    const route = R().parseStudentHash(location.hash.slice(1));
    const id = route?.[0],
      tab = route?.[1] || "overview";
    if (force) {
      S.counts = null;
      S.key = "";
      D.cache.clear();
    }
    if (phone() && id) {
      const wrap = await detailView(c, id, tab, true);
      c.replaceChildren(wrap);
      c.dataset.page = "student-detail";
      vHead?.sub("");
      vHead?.actions();
      return;
    }
    const countsRequest = D.loadCounts(force);
    countsRequest.catch(() => {});
    await D.loadStudents(force);
    const acts = [];
    if (enabled("exports", "export") && !phone()) {
      const b = btn("导出 Excel", () => exportLink("students").click());
      acts.push(b);
    }
    if (enabled("students", "create") && !phone()) acts.push(btn("＋ 新建学员", () => studentForm(() => render(c, true)), "primary"));
    vHead?.actions(...acts);
    const list = studentList(c, id || (!phone() && S.items[0]?.id));
    const after = () => {
      if (S.counts && S.countsSeq === apiWriteSeq) showCounts(c, S.counts);
      else void countsRequest.then((k) => showCounts(c, k), () => {});
    };
    if (phone()) {
      const page = n("div", null, { class: "fq-st fq-st-phone-list" });
      page.append(list);
      if (enabled("students", "create")) {
        const fab = btn("＋ 新建学员", () => studentForm(() => render(c, true)), "primary");
        fab.classList.add("fq-st-fab");
        page.append(fab, n("div", null, { class: "fq-st-pad-bottom" }));
      }
      c.replaceChildren(page);
      c.dataset.page = "students";
      after();
      return;
    }
    const pick = id || S.items[0]?.id;
    const split = n("div", null, { class: "fq-st fq-st-split" });
    split.append(list);
    const holder = n("div", pick ? "正在载入学员详情…" : "左侧选择一位学员查看详情。", { class: "fq-st-card fq-st-holder" });
    split.append(holder);
    c.replaceChildren(split);
    c.dataset.page = "students";
    after();
    // 电脑端：换学员、换分页只替换右侧详情（见 app.js render 的 __soft）。
    if (c.classList?.contains("ui-page-body"))
      c.__soft = (key) => {
        if (phone() || !c.querySelector(":scope > .fq-st-split")) return false;
        const r = R().parseStudentHash(key);
        if (!r) return false;
        swapDetail(c, r[0], r[1]);
        return true;
      };
    if (pick) await swapDetail(c, pick, tab);
  }
  let detailSeq = 0;
  async function swapDetail(c, id, tab) {
    const split = c.querySelector(":scope > .fq-st-split");
    const seq = ++detailSeq;
    const old = split.querySelector(":scope > .fq-st-detail, :scope > .fq-st-holder");
    old?.classList.add("is-loading");
    old?.setAttribute("aria-busy", "true");
    for (const r of split.querySelectorAll(".fq-st-row")) {
      const on = r.dataset.id === id;
      r.classList.toggle("is-on", on);
      on ? r.setAttribute("aria-current", "true") : r.removeAttribute("aria-current");
    }
    try {
      const view = await detailView(c, id, tab, false);
      if (seq !== detailSeq || !split.isConnected) return;
      if (old?.isConnected) old.replaceWith(view);
      else split.append(view);
    } catch (e) {
      if (seq !== detailSeq) return;
      old?.classList.remove("is-loading");
      old?.removeAttribute("aria-busy");
      notice(e.message);
    }
  }
  // 筛选、搜索、加载更多：只替换名单行和页脚；搜索框原地不动（不丢输入焦点）。
  let listSeq = 0;
  async function refreshList(c, loaded) {
    const list = c.querySelector(".fq-st-list");
    if (!list) return render(c);
    const seq = ++listSeq;
    const rowsBox = list.querySelector(".fq-st-rows");
    rowsBox?.classList.add("is-loading");
    if (!loaded)
      try {
        await D.loadStudents();
      } catch (e) {
        rowsBox?.classList.remove("is-loading");
        return notice(e.message);
      }
    if (seq !== listSeq || !list.isConnected) return;
    const split = c.querySelector(":scope > .fq-st-split");
    const route = R().parseStudentHash(location.hash.slice(1));
    const shown = split?.querySelector(":scope > .fq-st-detail")?.dataset.id;
    const pick = route?.[0] || S.items[0]?.id;
    rowsBox.replaceWith(listRows(split ? route?.[0] || shown || pick : null));
    list.querySelector(".fq-st-list-foot")?.replaceWith(listFoot(c));
    if (split && !route && pick && pick !== shown) swapDetail(c, pick, "overview");
  }

  // 入口：页面换成新版；原表单保存后刷新到不挂载的容器、手动排序抽屉仍走原实现。
  const previous = studentsPage;
  studentsPage = async (c, ...args) => {
    if (!c.isConnected || c.closest(".ui-sheet")) return previous(c, ...args);
    return render(c);
  };
  if (globalThis.ChannelRebuild) globalThis.ChannelRebuild.studentDetail = (c) => render(c);
  globalThis.FQStudents = { render, detailView, studentForm };
})();
