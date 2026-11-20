// 枫琴教务中心 · 设置 › 数据备份（设计稿 10）：导出加密备份、自动备份列表与下载、从备份恢复。仅主管。
// 通过 globalThis.fqNavHooks 在“设置”分组里加“数据备份”页签。接口见 docs/fengqin/接口变更.md「任务 3」。
// 下载与上传不用 api()：api() 会把响应当 JSON 解析，这里自己用 fetch 读取文件；出错时后端返回 JSON，显示其中的中文说明。
(() => {
  "use strict";
  const n = el,
    V = () => globalThis.ChannelV2;
  const PAGE = "settings-backup";
  const MIN_PASSWORD = 12; // 后端要求 12–256 个字符
  const SHOW_ROWS = 10;
  const isSupervisor = () => !!me?.user?.roles?.includes("supervisor");

  // ---------- 表名（能翻译的翻译，其余显示原名） ----------
  const TABLE_NAMES = {
    students: "学员",
    teachers: "老师",
    users: "账号",
    lessons: "课次",
    lesson_participants: "上课学员",
    schedule_templates: "排课模板",
    schedule_enrollments: "固定排课学员",
    packages: "课时包",
    package_transactions: "课时变动",
    student_payments: "收款",
    student_payment_allocations: "收款分配",
    student_payment_resolutions: "收款核对",
    student_balances_ledger: "余额流水",
    credit_income_entries: "课时收入",
    credit_debts: "欠课时",
    credit_operations: "课时操作",
    settlements: "结算",
    teacher_rates: "课酬标准",
    teacher_payments: "课酬发放",
    teacher_adjustments: "课酬调整",
    payroll_snapshots: "课酬快照",
    other_costs: "其他成本",
    lesson_submissions: "点名提交",
    submission_people: "点名学员",
    lesson_comments: "老师点评",
    classes: "班级",
    class_members: "班级成员",
    makeup_links: "补课安排",
    renewal_reminders: "续费提醒",
    followup_notes: "跟进记录",
    followup_tasks: "跟进任务",
    leads: "线索",
    student_stages: "学习阶段",
    student_routines: "学员日常安排",
    student_schedule_blocks: "学员时间偏好",
    course_categories: "课程大类",
    course_types: "细分课程",
    locations: "教室",
    stage_rules: "阶段规则",
    stage_types: "阶段类型",
    calendar_nodes: "日历节点",
    course_rules: "课程规则",
    offer_courses: "报价课程",
    tenant_price_lists: "价目表",
    tenants: "机构",
    tenant_profile: "机构档案",
    tenant_settings: "机构设置",
    tenant_branding: "品牌设置",
    tenant_brand: "品牌资料",
    tenant_modules: "功能模块",
    tenant_role_rights: "角色权限",
    gallery_images: "图库图片",
    audit_log: "操作记录",
    auth_log: "登录记录",
    ai_settings: "AI 设置",
    ai_usage: "AI 用量",
    ai_requests: "AI 请求",
    todo_snoozes: "待办稍后提醒",
  };
  // 预览里直接展示的主要数据，其余收进“其他数据表”。
  const MAIN_TABLES = [
    "students",
    "teachers",
    "users",
    "lessons",
    "lesson_participants",
    "packages",
    "student_payments",
    "lesson_comments",
    "followup_tasks",
    "leads",
    "teacher_payments",
    "gallery_images",
    "audit_log",
  ];
  const tableName = (t) => TABLE_NAMES[t] || t;
  const KIND = { automatic: "自动", manual: "手动", pre_restore: "恢复前" };
  const STATUS = { completed: ["完成", "ok"], running: ["进行中", "info"], failed: ["失败", "bad"] };

  // ---------- 时间（北京时间） ----------
  const parts = (ms) => {
    const o = {};
    for (const p of new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(ms)))
      o[p.type] = p.value;
    return o;
  };
  const dayKey = (ms) => {
    const p = parts(ms);
    return p.year + p.month + p.day;
  };
  const when = (ms) => {
    if (!Number.isFinite(ms)) return "—";
    const p = parts(ms),
      hm = p.hour + ":" + p.minute;
    if (dayKey(ms) === dayKey(Date.now())) return "今天 " + hm;
    if (dayKey(ms) === dayKey(Date.now() - 86400000)) return "昨天 " + hm;
    if (p.year !== parts(Date.now()).year) return p.year + "/" + p.month + "/" + p.day + " " + hm;
    return p.month + "/" + p.day + " " + hm;
  };
  const fullTime = (ms) => {
    if (!Number.isFinite(ms)) return "—";
    const p = parts(ms);
    return p.year + "年" + p.month + "月" + p.day + "日 " + p.hour + ":" + p.minute;
  };
  const fallbackName = () => {
    const p = parts(Date.now());
    return "fengqin-backup-" + p.year + p.month + p.day + "-" + p.hour + p.minute + ".fqbackup";
  };
  const total = (counts) =>
    counts && typeof counts === "object" ? Object.values(counts).reduce((s, x) => s + (Number(x) || 0), 0) : null;
  const num = (v) => (v === null || v === undefined ? "—" : Number(v).toLocaleString("zh-CN"));

  // ---------- 请求与错误 ----------
  const MESSAGES = {
    backup_decryption_failed: "密码不对，或备份文件已损坏。请输入导出这份备份时设置的密码。",
    backup_version_mismatch: "这份备份的数据版本和当前系统不一致，不能恢复。",
    backup_instance_mismatch: "这份备份来自另一套系统（机构不一致），不能恢复到这里。",
    backup_key_mismatch: "这份备份和当前系统的加密密钥不一致（服务器密钥已更换），不能恢复。",
    invalid_backup: "备份文件内容不完整或格式不对，不能恢复。",
    invalid_backup_password: "备份密码需要 12 到 256 个字符。",
    restore_data_changed: "恢复前的自动备份完成后，数据又有了新变化。为避免丢掉这些新数据，这次没有覆盖。请再点一次“确认恢复”，系统会重新备份后再恢复。",
    restore_not_ready: "这次恢复预览已过期或正在处理，请重新选择备份文件。",
    restore_in_progress: "已有一个恢复正在进行，请稍后再试。",
    restore_media_confirmation_required: "这份备份里有已缺失的图片，请勾选“我知道这些图片无法恢复”后再确认。",
    restore_media_conflict: "恢复图片时遇到冲突，请重新选择备份文件预览。",
    backup_media_missing: "图库里有图片文件缺失，无法生成完整备份。请联系技术人员检查图库。",
    backup_incomplete: "这份自动备份不完整，不能下载。请选择其他备份。",
    forbidden: "只有主管可以导出和恢复备份。",
  };
  function problem(status, data) {
    const code = data?.message ? data.error : data?.code || data?.error;
    const raw = data?.message || (typeof data?.error === "string" && !/^[a-z_]+$/.test(data.error) ? data.error : "");
    let text = MESSAGES[code];
    if (code === "backup_version_mismatch" || code === "invalid_backup") text = text + (raw ? "（" + raw + "）" : "");
    if (!text && (status === 413 || code === "backup_too_large"))
      text = (raw || "备份文件太大") + "。导出的备份不能超过 16MB，上传的文件不能超过 24MB。";
    if (!text && status === 404) text = raw || "这份备份已不存在或已超过保留期。";
    const e = Error(text || raw || "操作没有完成（错误 " + status + "），请稍后再试。");
    e.status = status;
    e.code = code;
    return e;
  }
  async function send(path, { json, form } = {}) {
    let response;
    try {
      response = await fetch(base + "api/" + path, {
        method: "POST",
        credentials: "same-origin",
        headers: json ? { "Content-Type": "application/json" } : {},
        body: json ? JSON.stringify(json) : form,
      });
    } catch {
      throw Error("网络连接失败，请检查网络后再试。");
    }
    if (response.status === 401) {
      location.assign(base + "login");
      throw Error("登录已过期，请重新登录。");
    }
    if (!response.ok) {
      let data = null;
      try {
        data = await response.json();
      } catch {}
      throw problem(response.status, data);
    }
    return response;
  }
  async function sendJson(path, body) {
    const response = await send(path, { json: body });
    return response.json();
  }
  // 下载附件：确认是备份文件而不是错误 JSON，再用临时链接保存。
  async function download(path, password) {
    const response = await send(path, { json: { password } });
    const type = response.headers.get("content-type") || "";
    if (/^application\/json/i.test(type)) {
      let data = null;
      try {
        data = await response.json();
      } catch {}
      throw problem(response.status, data);
    }
    const blob = await response.blob();
    const disposition = response.headers.get("content-disposition") || "";
    const match = /filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i.exec(disposition);
    let name = fallbackName();
    if (match) {
      try {
        name = decodeURIComponent(match[1] || match[2]);
      } catch {
        name = match[2] || name;
      }
    }
    const url = URL.createObjectURL(blob),
      a = n("a", null, { href: url, download: name, hidden: "" });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return name;
  }

  // ---------- 小部件 ----------
  const chip = (text, tone) => V().chip(text, tone);
  function plainButton(text, kind = "") {
    return button(text, undefined, kind);
  }
  // 按钮忙碌时换文字并禁用；结束后恢复。
  async function busy(btn, label, fn) {
    const face = btn.querySelector(".ui-button-face > span:last-child") || btn,
      old = face.textContent;
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    face.textContent = label;
    try {
      return await fn();
    } finally {
      face.textContent = old;
      btn.removeAttribute("aria-busy");
      btn.disabled = false;
    }
  }
  const errorLine = () => {
    const p = n("p", "", { class: "fq-bk-error", role: "alert" });
    p.hidden = true;
    return {
      element: p,
      set(message) {
        p.textContent = message || "";
        p.hidden = !message;
      },
    };
  };
  function icon(kind) {
    const span = n("span", null, { class: "fq-bk-ic fq-bk-ic-" + kind, "aria-hidden": "true" });
    const ns = "http://www.w3.org/2000/svg",
      svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.8");
    const path = document.createElementNS(ns, "path");
    path.setAttribute(
      "d",
      { down: "M12 3v12M7 10l5 5 5-5M4 19h16", up: "M12 21V9M7 14l5-5 5 5M4 5h16", warn: "M12 3l9 16H3zM12 10v4M12 17v.5" }[kind],
    );
    svg.append(path);
    span.append(svg);
    return span;
  }
  function warnBar(text) {
    const box = n("div", null, { class: "fq-bk-notice", role: "note" });
    box.append(icon("warn"), n("span", text));
    return box;
  }

  // ---------- 输入备份密码（导出与下载共用） ----------
  function passwordDialog({ title, intro, submit, working, onSubmit }) {
    const view = UI.overlay({ title, kind: "drawer" });
    view.element.classList.add("fq-backup-dialog");
    const form = n("form", null, { class: "fq-backup fq-bk-form" });
    const first = UI.field({ label: "备份密码", name: "backup_password", type: "password", hint: "至少 " + MIN_PASSWORD + " 个字符" }),
      second = UI.field({ label: "再输入一次", name: "backup_password_again", type: "password" });
    for (const f of [first, second]) {
      f.input.setAttribute("autocomplete", "new-password");
      f.input.setAttribute("maxlength", "256");
    }
    const err = errorLine();
    form.append(
      n("p", intro, { class: "fq-bk-lead" }),
      first.element,
      second.element,
      warnBar("恢复时需要同一个密码，系统不保存这个密码。忘记密码就无法用这份文件恢复，请妥善保管。"),
      err.element,
    );
    view.body.append(form);
    const cancel = plainButton("取消"),
      go = plainButton(submit, "primary");
    view.footer.append(cancel, go);
    const valid = () => first.input.value.trim().length >= MIN_PASSWORD && first.input.value.length <= 256 && first.input.value === second.input.value;
    const sync = () => {
      if (go.getAttribute("aria-busy") !== "true") go.disabled = !valid();
      const a = first.input.value,
        b = second.input.value;
      first.setError(a && a.trim().length < MIN_PASSWORD ? "密码至少需要 " + MIN_PASSWORD + " 个字符" : "");
      second.setError(b && a !== b ? "两次输入的密码不一致" : "");
    };
    first.input.addEventListener("input", sync);
    second.input.addEventListener("input", sync);
    sync();
    cancel.addEventListener("click", () => view.requestClose());
    const run = async () => {
      if (!valid() || go.disabled) return;
      err.set("");
      view.setBusy(true);
      cancel.disabled = true;
      try {
        await busy(go, working, () => onSubmit(first.input.value));
        view.setBusy(false);
        await view.close();
      } catch (e) {
        err.set(e.message);
      } finally {
        view.setBusy(false);
        cancel.disabled = false;
        sync();
      }
    };
    go.addEventListener("click", run);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void run();
    });
    return view;
  }

  // ---------- 从备份恢复 ----------
  function restoreDialog(latest) {
    const view = UI.overlay({ title: "从备份恢复", kind: "drawer" });
    view.element.classList.add("fq-backup-dialog");
    const showPick = () => {
      const form = n("form", null, { class: "fq-backup fq-bk-form" });
      const file = UI.field({ label: "备份文件（.fqbackup）", name: "backup_file", type: "file" }),
        pass = UI.field({ label: "备份密码", name: "backup_password", type: "password", hint: "导出这份备份时设置的密码" });
      file.input.setAttribute("accept", ".fqbackup,application/vnd.fengqin.backup+json,application/json");
      pass.input.setAttribute("autocomplete", "off");
      const err = errorLine();
      form.append(
        n("p", "上传备份文件，先预览每类数据的条数，确认后整体替换当前数据。这一步只校验文件，不会改动现有数据。", { class: "fq-bk-lead" }),
        file.element,
        pass.element,
        err.element,
      );
      const cancel = plainButton("取消"),
        go = plainButton("校验并预览", "primary");
      const sync = () => {
        if (go.getAttribute("aria-busy") !== "true") go.disabled = !(file.input.files?.length && pass.input.value.trim().length >= MIN_PASSWORD);
      };
      file.input.addEventListener("change", () => {
        const f = file.input.files?.[0];
        file.setError(f && f.size > 24 * 1024 * 1024 ? "文件超过 24MB，不能上传恢复" : "");
        sync();
      });
      pass.input.addEventListener("input", sync);
      sync();
      cancel.addEventListener("click", () => view.requestClose());
      const run = async () => {
        if (go.disabled) return;
        const f = file.input.files?.[0];
        if (!f) return;
        if (f.size > 24 * 1024 * 1024) {
          err.set("文件超过 24MB，不能上传恢复。");
          return;
        }
        err.set("");
        view.setBusy(true);
        cancel.disabled = true;
        try {
          const data = new FormData();
          data.append("file", f, f.name);
          data.append("password", pass.input.value);
          const preview = await busy(go, "正在校验…", async () => (await send("backups/restore/preview", { form: data })).json());
          view.setBusy(false);
          showPreview(preview, f.name);
        } catch (e) {
          err.set(e.message);
        } finally {
          view.setBusy(false);
          cancel.disabled = false;
          sync();
        }
      };
      go.addEventListener("click", run);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        void run();
      });
      view.body.replaceChildren(form);
      view.footer.replaceChildren(cancel, go);
    };

    const showPreview = (p, filename) => {
      const box = n("div", null, { class: "fq-backup fq-bk-preview" });
      const meta = n("dl", null, { class: "fq-bk-meta" });
      const row = (k, v) => meta.append(n("dt", k), n("dd", v));
      row("文件", filename);
      row("备份时间", fullTime(p.created_at));
      row("数据版本", p.schema_version || "—");
      row("合计行数", num(total(p.counts)));
      row("图片文件", num(p.media_count) + " 张" + (p.missing_media_count ? "，缺失 " + p.missing_media_count + " 张" : ""));
      if (Number.isFinite(p.expires_at)) row("预览有效至", when(p.expires_at) + "（30 分钟内确认）");
      box.append(meta);

      const warnings = [...(p.warnings || [])];
      if (p.current_account_in_backup === false)
        warnings.unshift("这份备份里没有你现在登录的账号。恢复后请用备份里的主管账号和密码登录。");
      if (p.login_notice) warnings.push(p.login_notice);
      for (const w of warnings) box.append(warnBar(w));

      // 每张表的行数：备份 vs. 最近一次备份（后端不返回当前实时行数，用最近一次成功备份作对比）。
      const counts = p.counts || {},
        ref = latest?.counts || null;
      const head = n("p", null, { class: "fq-bk-cmp-note" });
      head.textContent = ref
        ? "“对比”列是最近一次备份（" + when(latest.at) + "）时的行数，可大致看出恢复后数据会怎样变化。"
        : "暂无其他备份可对比，下面只列出这份备份里的行数。";
      const tableFor = (names) => {
        const wrap = n("div", null, { class: "fq-bk-table-wrap" });
        const t = n("table", null, { class: "fq-bk-table fq-bk-counts" }),
          thead = n("thead"),
          tr = n("tr");
        tr.append(n("th", "数据"), n("th", "这份备份"), ...(ref ? [n("th", "对比"), n("th", "变化")] : []));
        thead.append(tr);
        const tbody = n("tbody");
        for (const name of names) {
          const r = n("tr"),
            v = Number(counts[name]) || 0;
          const label = n("td", null, { "data-label": "数据" });
          label.append(n("span", tableName(name)));
          if (TABLE_NAMES[name]) label.append(n("small", name, { class: "fq-bk-raw" }));
          r.append(label, n("td", num(v), { class: "fq-bk-num", "data-label": "这份备份" }));
          if (ref) {
            const c = ref[name],
              diff = c === undefined || c === null ? null : v - Number(c);
            const d = n("td", diff === null ? "—" : diff === 0 ? "不变" : (diff > 0 ? "+" : "") + num(diff), {
              class: "fq-bk-num" + (diff ? (diff > 0 ? " is-up" : " is-down") : ""),
              "data-label": "变化",
            });
            r.append(n("td", num(c), { class: "fq-bk-num", "data-label": "对比" }), d);
          }
          tbody.append(r);
        }
        t.append(thead, tbody);
        wrap.append(t);
        return wrap;
      };
      const all = Object.keys(counts),
        main = MAIN_TABLES.filter((t) => t in counts),
        rest = all
          .filter((t) => !main.includes(t))
          .sort((a, b) => (TABLE_NAMES[a] ? 0 : 1) - (TABLE_NAMES[b] ? 0 : 1) || tableName(a).localeCompare(tableName(b), "zh-CN"));
      box.append(n("h3", "每类数据的行数", { class: "fq-bk-h3" }), head, tableFor(main));
      if (rest.length) {
        const more = UI.disclosure("其他 " + rest.length + " 张数据表", [tableFor(rest)]);
        more.classList.add("fq-bk-more");
        box.append(more);
      }

      let allowMissing = !p.missing_media_count;
      if (p.missing_media_count) {
        const label = n("label", null, { class: "fq-bk-check" }),
          check = n("input", null, { type: "checkbox", name: "allow_missing_media" });
        check.addEventListener("change", () => {
          allowMissing = check.checked;
          sync();
        });
        label.append(check, n("span", "我知道这份备份里有 " + p.missing_media_count + " 张图片已经缺失，恢复后这些图片无法显示，仍要恢复。"));
        box.append(label);
      }
      const err = errorLine();
      box.append(err.element);

      const back = plainButton("重新选择"),
        go = plainButton("确认恢复", "danger");
      const sync = () => {
        if (go.getAttribute("aria-busy") !== "true") go.disabled = !allowMissing;
      };
      sync();
      back.addEventListener("click", showPick);
      go.addEventListener("click", async () => {
        if (go.disabled) return;
        err.set("");
        const ok = await UI.confirmDialog({
          title: "覆盖当前全部数据？",
          message:
            "将用 " +
            fullTime(p.created_at) +
            " 的备份覆盖当前全部数据（不做逐条合并），备份之后录入的内容都会消失。恢复前系统会自动备份一次当前数据。恢复完成后所有人都需要重新登录。",
          confirmLabel: "覆盖并恢复",
          cancelLabel: "再想想",
          danger: true,
        });
        if (!ok) return;
        view.setBusy(true);
        back.disabled = true;
        try {
          const body = { confirm: true };
          if (p.missing_media_count) body.allow_missing_media = true;
          await busy(go, "正在恢复…", () => sendJson("backups/restore/" + encodeURIComponent(p.id) + "/confirm", body));
          view.setBusy(false);
          box.replaceChildren(warnBar("恢复完成。所有会话已失效，正在前往登录页，请用备份里的账号和密码重新登录。"));
          view.footer.replaceChildren();
          notice("恢复完成，请重新登录", "success");
          setTimeout(() => location.assign(base + "login"), 1600);
        } catch (e) {
          err.set(e.message);
          view.setBusy(false);
          back.disabled = false;
          sync();
        }
      });
      view.body.replaceChildren(box);
      view.footer.replaceChildren(back, go);
      view.body.scrollTop = 0;
    };
    showPick();
    return view;
  }

  // ---------- 页面 ----------
  async function backupPage(c) {
    c.replaceChildren(UI.tableSkeleton());
    let list = null,
      listError = "";
    try {
      list = await api("backups");
    } catch (e) {
      listError = e.message || "备份列表暂时取不到";
    }
    const items = list?.items || [];
    const done = items.filter((x) => x.status === "completed");
    const latest = done[0] || null;
    const page = n("div", null, { class: "fq-backup fq-bk-page" });

    // 全量备份
    const full = V().panel("全量备份", latest ? chip("上次备份：" + when(latest.at), "ok") : chip(listError ? "备份记录暂不可用" : "还没有备份", "muted"));
    full.classList.add("fq-bk-panel");
    const h = full.querySelector(".v-panel-head h2"),
      titleBox = n("div", null, { class: "fq-bk-title" });
    h.replaceWith(titleBox);
    titleBox.append(h, n("p", "包含学员、课表、出勤、点评、课时、收款、课酬、线索、账号和全部设置（含图库图片），不含登录会话"));
    const body = n("div", null, { class: "fq-bk-body" }),
      two = n("div", null, { class: "fq-bk-two" });
    const exportBox = n("div", null, { class: "fq-bk-box" }),
      restoreBox = n("div", null, { class: "fq-bk-box" });
    const h3a = n("h3"),
      h3b = n("h3");
    h3a.append(icon("down"), n("span", "导出全部数据"));
    h3b.append(icon("up"), n("span", "从备份恢复"));
    const exportBtn = plainButton("导出备份文件", "primary"),
      restoreBtn = plainButton("选择备份文件…", "fq-bk-red");
    exportBtn.addEventListener("click", () =>
      passwordDialog({
        title: "导出全部数据",
        intro: "生成一个加密备份文件下载到本机。请设置备份密码，恢复时用同一个密码。",
        submit: "生成并下载",
        working: "正在生成…",
        onSubmit: async (password) => {
          const name = await download("backups/export", password);
          notice("备份文件已下载：" + name, "success");
          void backupPage(c);
        },
      }),
    );
    restoreBtn.addEventListener("click", () => restoreDialog(latest));
    exportBox.append(h3a, n("p", "生成一个加密备份文件下载到本机。需要输入备份密码，恢复时用同一个密码。"), exportBtn);
    restoreBox.append(h3b, n("p", "上传备份文件，先预览每类数据的条数，确认后整体替换当前数据。恢复前会自动再备份一次。"), restoreBtn);
    two.append(exportBox, restoreBox);
    body.append(two, warnBar("只有主管能导出和恢复。恢复会覆盖现有数据，所有人需要重新登录。"));
    full.append(body);

    // 自动备份
    const auto = V().panel("自动备份", chip("已开启", "info"));
    auto.classList.add("fq-bk-panel");
    const h2 = auto.querySelector(".v-panel-head h2"),
      titleBox2 = n("div", null, { class: "fq-bk-title" });
    h2.replaceWith(titleBox2);
    titleBox2.append(h2, n("p", "每天凌晨 3 点自动备份到云端存储，保留 " + (list?.retention_days || 30) + " 天。手动导出和恢复前的备份也列在这里。"));
    const listBox = n("div", null, { class: "fq-bk-list" });
    auto.append(listBox);
    let expanded = false;
    const renderList = () => {
      if (listError) {
        const p = n("p", "备份列表取不到：" + listError, { class: "fq-bk-empty" });
        listBox.replaceChildren(p, n("div", null, { class: "fq-bk-foot" }));
        listBox.lastChild.append(plainButton("重试", "link"));
        listBox.lastChild.firstChild.addEventListener("click", () => backupPage(c));
        return;
      }
      if (!items.length) {
        const empty = n("div", null, { class: "fq-bk-empty" });
        empty.append(
          n("strong", "最近 " + (list?.retention_days || 30) + " 天还没有备份"),
          n("p", "每天凌晨 3 点会自动生成一份；也可以点上方“导出备份文件”手动备份一次。"),
        );
        listBox.replaceChildren(empty);
        return;
      }
      const wrap = n("div", null, { class: "fq-bk-table-wrap" });
      const t = n("table", null, { class: "fq-bk-table fq-bk-history" }),
        thead = n("thead"),
        hr = n("tr");
      for (const label of ["时间", "类型", "行数合计", "状态", ""]) hr.append(n("th", label || null, label ? {} : { "aria-label": "操作" }));
      thead.append(hr);
      const tbody = n("tbody");
      for (const item of expanded ? items : items.slice(0, SHOW_ROWS)) {
        const tr = n("tr"),
          [statusText, tone] = STATUS[item.status] || [item.status || "—", "muted"];
        const st = n("td", null, { "data-label": "状态" });
        st.append(chip(statusText, tone));
        const kind = n("td", KIND[item.kind] || item.kind || "—", { "data-label": "类型" });
        if (item.kind === "automatic" && item.compatible === false) kind.append(n("small", "旧版本，不能恢复", { class: "fq-bk-raw" }));
        const act = n("td", null, { class: "fq-bk-act" });
        if (item.download_url && item.compatible !== false) {
          const b = plainButton("下载", "fq-bk-sm");
          b.setAttribute("aria-label", "下载 " + fullTime(item.at) + " 的备份");
          b.addEventListener("click", () =>
            passwordDialog({
              title: "下载备份",
              intro: "下载 " + fullTime(item.at) + " 的" + (KIND[item.kind] || "") + "备份。请设置一个密码，系统会用这个密码生成可恢复的加密文件。",
              submit: "生成并下载",
              working: "正在生成…",
              onSubmit: async (password) => {
                const path = String(item.download_url).replace(/^\/?api\//, "");
                const name = await download(path, password);
                notice("备份文件已下载：" + name, "success");
              },
            }),
          );
          act.append(b);
        }
        tr.append(
          n("td", when(item.at), { class: "fq-bk-when", "data-label": "时间" }),
          kind,
          n("td", num(total(item.counts)), { class: "fq-bk-num", "data-label": "行数合计" }),
          st,
          act,
        );
        tbody.append(tr);
      }
      t.append(thead, tbody);
      wrap.append(t);
      listBox.replaceChildren(wrap);
      if (items.length > SHOW_ROWS) {
        const foot = n("div", null, { class: "fq-bk-foot" });
        const toggle = plainButton(expanded ? "只看最近 " + SHOW_ROWS + " 份" : "查看全部 " + items.length + " 份 →", "link");
        toggle.addEventListener("click", () => {
          expanded = !expanded;
          renderList();
        });
        foot.append(toggle);
        listBox.append(foot);
      }
    };
    renderList();
    page.append(full, auto);
    c.replaceChildren(page);
  }

  (globalThis.fqNavHooks ||= []).push((daily, manage, register) => {
    if (!isSupervisor()) return;
    const g = manage.find((x) => x && x.key === "settings");
    if (!g) return;
    const tab = register(PAGE, "数据备份", "settings", (c) => backupPage(c));
    if (!tab) return;
    g.tabs = g.tabs.filter(Boolean);
    const logs = g.tabs.findIndex((t) => t.key === "settings-logs" || /操作记录/.test(t.label || ""));
    if (logs < 0) g.tabs.push(tab);
    else g.tabs.splice(logs, 0, tab);
  });
  globalThis.FengqinBackup = { backupPage };
})();
