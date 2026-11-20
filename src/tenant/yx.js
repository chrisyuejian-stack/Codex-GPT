// 枫琴教务中心 · 登录、首次初始化、学员 AI 称呼（Claude 编写）
// 单机构：所有角色都从 /login 登录，接口统一在根 /api/。原艺界星途的机构选择、机构停用页、家长端已删除。
// 约束：只用 DOM 构造与 textContent；不写内联 style（CSP 不允许）；归属、权限一律由服务器判断。
// 本文件拼在前端脚本后部，函数声明会被提前，app.js 的启动流程可以直接调用。

function yxInput(form, label, name, type, attrs = {}) {
  const wrap = el("label", null, { class: "yx-field" }),
    input = el("input", null, { name, type, required: "", ...attrs });
  wrap.append(el("span", label), input);
  form.append(wrap);
  return input;
}

// 左侧钢琴照片 + 系统名；右侧放表单。登录页和初始化页共用。
function fqAuthLayout() {
  root.replaceChildren();
  const page = el("div", null, { class: "fq-login" }),
    side = el("section", null, { class: "fq-login-side" }),
    titleBox = el("div");
  titleBox.append(
    el("p", "MUSIC & PERFORMING ARTS", { class: "fq-login-kicker" }),
    el("h1", "枫琴教务中心"),
    el("div", null, { class: "fq-login-rule", "aria-hidden": "true" }),
  );
  side.append(
    el("span", null, { class: "fq-logo", role: "img", "aria-label": "fantasme 枫琴国际艺术" }),
    titleBox,
    el("p", "FANTASME ACADEMY OF ARTS · SHANGHAI", { class: "fq-login-foot" }),
  );
  const main = el("main", null, { class: "fq-login-main" }),
    card = el("div", null, { class: "yx-login-card" });
  main.append(card);
  page.append(side, main);
  root.append(page);
  return card;
}

// ---------- 登录 ----------
function yxLoginPage() {
  document.title = "枫琴教务中心 · 登录";
  yxLoginForm(fqAuthLayout());
}
function yxLoginForm(card) {
  card.replaceChildren();
  const form = el("form", null, { class: "yx-login-form", novalidate: "" }),
    head = el("div", null, { class: "yx-login-head" });
  head.append(el("p", "Welcome back", { class: "fq-welcome" }), el("h2", "登录"));
  form.append(head);
  const phone = yxInput(form, "手机号", "phone", "tel", {
    autocomplete: "username",
    inputmode: "tel",
    placeholder: "请输入 11 位手机号",
    maxlength: "11",
  });
  yxInput(form, "密码", "password", "password", { autocomplete: "current-password", placeholder: "请输入密码" });
  const error = el("p", "", { class: "yx-login-error", role: "alert", hidden: "" });
  const go = el("button", "登录", { type: "submit", class: "yx-btn yx-btn--primary yx-btn--block" });
  form.append(error, go, el("p", "忘记密码请联系教务老师", { class: "yx-login-note" }));
  card.append(form);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (go.disabled) return;
    const d = Object.fromEntries(new FormData(form));
    const show = (text) => {
      error.textContent = text;
      error.hidden = false;
      notice(text);
    };
    if (!/^1[3-9]\d{9}$/.test(d.phone || "")) return show("请输入正确的 11 位手机号");
    if (!d.password) return show("请输入密码");
    error.hidden = true;
    go.disabled = true;
    go.textContent = "登录中…";
    try {
      await api("auth/login", "POST", { phone: d.phone, password: d.password });
      location.assign(base + "app/");
    } catch (err) {
      show(err.message || "登录失败，请稍后重试");
    } finally {
      go.disabled = false;
      go.textContent = "登录";
    }
  });
  phone.focus?.();
}

// ---------- 首次初始化（系统还没有任何账号时，代替登录页出现一次） ----------
// 需要部署时配置的 SETUP_KEY；成功后服务器永久关闭初始化入口。
function fqSetupPage() {
  document.title = "枫琴教务中心 · 初始化";
  const card = fqAuthLayout(),
    form = el("form", null, { class: "yx-login-form", novalidate: "" }),
    head = el("div", null, { class: "yx-login-head" });
  head.append(el("p", "First-time setup", { class: "fq-welcome" }), el("h2", "创建第一位主管"));
  form.append(head);
  const key = yxInput(form, "初始化密钥（部署时设置的 SETUP_KEY）", "setup_key", "password", { autocomplete: "off" });
  yxInput(form, "主管姓名", "name", "text", { autocomplete: "name", maxlength: "50", placeholder: "例如 陈老师" });
  yxInput(form, "主管手机号", "phone", "tel", { autocomplete: "username", inputmode: "tel", maxlength: "11", placeholder: "以后用这个手机号登录" });
  yxInput(form, "登录密码", "password", "password", { autocomplete: "new-password", placeholder: "至少 10 位，包含字母和数字" });
  const error = el("p", "", { class: "yx-login-error", role: "alert", hidden: "" });
  const go = el("button", "完成初始化", { type: "submit", class: "yx-btn yx-btn--primary yx-btn--block" });
  form.append(error, go, el("p", "初始化只能做一次。完成后请用上面的手机号和密码登录，并可在 Cloudflare 里删除 SETUP_KEY。", { class: "yx-login-note" }));
  card.append(form);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (go.disabled) return;
    const d = Object.fromEntries(new FormData(form));
    const show = (text) => {
      error.textContent = text;
      error.hidden = false;
    };
    if (!d.setup_key) return show("请输入初始化密钥");
    if (!/^1[3-9]\d{9}$/.test(d.phone || "")) return show("请输入正确的 11 位手机号");
    if (!d.password) return show("请设置登录密码");
    error.hidden = true;
    go.disabled = true;
    go.textContent = "正在初始化…";
    try {
      await api("setup", "POST", { setup_key: d.setup_key, name: d.name || "主管", phone: d.phone, password: d.password });
      notice("初始化完成，请登录", "success");
      yxLoginPage();
    } catch (err) {
      show(err.message || "初始化失败");
      go.disabled = false;
      go.textContent = "完成初始化";
    }
  });
  key.focus?.();
}

// ---------- 学员 AI 称呼 ----------
// 默认按姓生成“某同学”；复姓按常见表；外文名用名字本身。
const YX_COMPOUND = "欧阳 司马 上官 诸葛 东方 皇甫 尉迟 公孙 慕容 长孙 宇文 司徒 夏侯 轩辕 令狐 端木 独孤 南宫 西门 申屠".split(" ");
function yxNickname(name) {
  const n = String(name || "").trim();
  if (!n) return "";
  if (!/^[一-龥]/.test(n)) return n;
  const surname = YX_COMPOUND.find((s) => n.startsWith(s) && n.length > s.length) || n[0];
  return surname + "同学";
}
