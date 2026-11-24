# 进度：Antigravity

追加式，按日期写：做了什么、PR 编号、测试结果、发现的问题、需要用户或 Claude 决定的事。不要改 `任务板.md`、`项目状态.md`（由 Claude 统一维护）。

## 2026-11-23：迁移 0034 / 0035 临时库演练与生产部署上线（PR #31）

- **基线代码**：`main@fe731ef`（已合入 PR #23、#24、#25、#26、#27、#28、#29）
- **前提检查**（Node `v22.23.5`）：`npm run build` ✅、`npm run test:migrations:preflight` ✅（35 个迁移至 0035，0 外键错误）、`npm test` **375/375** ✅、`TEST_BUNDLE=1 npm test` **375/375** ✅。
- **临时库演练**（详见 `docs/qa/迁移演练_2026-11-23.md`）：
  - 在 APAC 创建临时库 `fengqin-parity-tmp`，按 `0001`–`0033` 建表并按 `restoreTables` 拓扑序导入生产数据行，演练 `0034`、`0035` 全部通过；
  - 验证回填完整（29 节课程、5 条固定排课模板 `unit_minutes` 均非空）、6 个 `course_limits_*` 触发器正反用例全部符合预期（合法 1.5 / 0.5 与旧行其他字段更新通过；非法 1.3 / 0.4 / 1.01 均被 `course_duration_or_units` 拦截）；
  - 演练完成后已删除临时库与 `/tmp` 下所有导出文件。
- **生产迁移与部署**：
  - 生产 D1 迁移前 Time Travel 回滚书签：`0000036b-00000000-0000512c-6da72a156445b4be267602dabdd2b602`；
  - 生产 D1 依次执行 `0034_merge_course_formats.sql`（2.63 ms）与 `0035_lesson_unit_minutes.sql`（17.22 ms，回填 34 行），只读核对行数、空值、触发器数全部一致；
  - 紧接着部署备份 Worker `fengqin-backup-prod`（Version ID `a8fd6b17-ad15-459c-adda-3bf129b109a4`）与 Pages `fengqin-crm-prod`（Deployment `a62bb759`，未改动任何环境变量与绑定）。
- **上线核对**：
  - `GET https://edu.fantasmearts.com/api/setup` 返回 `{"initialized":true}` ✅；
  - 线上 `/login` 静态资源版本号（`5b17145f900a` / `a64de5a4ecb0` / `bc2c6579b769` / `cfd92c17f2d8`）与 `dist/tenant.html` 完全一致 ✅；
  - 未登录访问 `/api/tools/leads`、`/api/c2/students`、`/api/teacher/today`、`/api/settings/institution` 均返回 HTTP 401 ✅；
  - 备份 Worker 定时任务执行核对见 `deployment/cloudflare/README.md` 与下方补充。
- **提醒用户**：
  1. 用真实账号点一遍：排课（45 分钟 × 2 课时占 90 分钟与冲突提示）、课时数 0.5 步进、课程形式仅「一对一 / 班课」、课酬标准两栏及计费方式说明、登录页背景自定义、设置各分区；
  2. 主管导出一次全量备份（因 0035 结构升级，旧备份不再用于恢复），并在次日核对 03:00 自动备份在 R2 生成文件；
  3. 本次部署完成后可随时在 Cloudflare 控制台撤销临时部署令牌。

## 2026-11-23：P0 线上 CSS 花括号未闭合修复与热更新（PR #32）

- **问题根因**：`src/tenant/fq-settings.css` 第 837 行的 `@media (max-width: 760px) {` 在合入 PR #23 与 PR #26 后缺少右花括号 `}`（第 849 行），导致打包在其后的 `fq-schedule.css`、`fq-students.css`、`fq-teachers.css`、`fq.css` 全部被包裹进移动端 `@media (max-width: 760px)`，致使桌面端登录页与内部主页卡片背景样式失效。
- **修复与防回归**：
  - 补齐 `src/tenant/fq-settings.css:849` 的 `}`；
  - 在 `tests/settings-institution.test.mjs` 新增全仓库 CSS 花括号配平测试（校验 `src/ui/`、`src/tenant/` 及打包产物 `dist/assets/tenant.css` 的 `{}` 深度归零）；
  - 已立即构建并部署到 Cloudflare Pages `fengqin-crm-prod`（Deployment `054f38a2`），线上登录页与内部主页卡片恢复正常。

## 2026-11-23：任务 #14 日期输入可手动输入 + 日历翻月按钮修复（PR #33，`antigravity/date-input`）

- **问题根因**：
  1. 旧版 `src/ui/components.js` 中 `dateControl`（`UI.datePicker`）渲染的是 `<button class="ui-picker-trigger">` + `<input type="hidden">`，不支持键盘手动输入；且 `fq-settings.js`（操作记录/AI 设置日期筛选）、`fq-schedule.js`（固定排课学员开始/结束日期）、`fq-leads.js`（行内写回访）、`v2pay.js`（登记/编辑缴费日期）仍使用原生 `<input type="date">`。
  2. 旧版日历弹层在 `root` 监听 `focusout`，而「上个月 / 下个月」使用异步 `iconButton`（点击瞬间 `disabled = true`）且 `render()` 执行 `popup.replaceChildren(...)` 销毁被点按钮，导致 `document.activeElement` 落回 `document.body`，立即触发 `focusout` 将日历关闭。
- **修复内容**：
  - 升级 `src/ui/components.js` & `src/ui/components.css`：`.ui-date-combo` 含真实可编辑 `<input type="text" class="ui-control ui-date-input" placeholder="YYYY-MM-DD" inputmode="numeric">` + 右侧日历触发按钮 `.ui-date-btn`；新增并导出 `normalizeDateInput` / `normalizeMonthInput`，支持 `YYYY-MM-DD`、`YYYY/MM/DD`、`YYYY.MM.DD`、`YYYYMMDD`、`YYYY年M月D日`、`MM-DD` / `MMDD`（默认当前年），失焦/回车自动归一，非法日期或超出 `min`/`max` 显示中文错误提示且保留用户输入原文，并在 `src/tenant/app.js` 表单提交入口拦截非法日期。
  - 修复日历「上个月 / 下个月」按钮（`40×40px` 触控区，同步 `makeNavBtn` + `pointerdown` `preventDefault()` + `pointerInside` 焦点守卫，重绘不丢焦点不关弹层），新增点击顶部年月标题展开「年份 + 1–12 月」快速选择面板及底部「今天 / 清除」快捷操作。
  - 将 `fq-settings.js`、`fq-schedule.js`、`fq-leads.js`、`v2pay.js` 中剩余原生 `<input type="date">` 全部统一替换为 `UI.datePicker`。
- **测试结果**（Node `v22.23.5`）：
  - 单元测试 `tests/date-input.test.mjs`：2/2 通过；
  - Playwright E2E `tests/e2e/date-input.spec.mjs`（覆盖设置操作记录日期筛选、课表新建课程、课表固定排课、线索新建回访日期、财务登记缴费 5 个页面 × Desktop `1280×800` + Mobile `390×844`）：**2/2 passed (36.7s)**；
  - 全量门禁 `npm run build && npm test && TEST_BUNDLE=1 npm test`：**377/377** 全绿（0 失败、0 跳过）；
  - 验收报告：`docs/qa/任务14_日期输入验收记录_2026-11-23.md`。
- **生产部署**：已将含 P0 CSS 修复 + 任务 #14 日期/日历组件修复的最新 `dist/` 部署至 Cloudflare Pages `fengqin-crm-prod`（Deployment `ea427c1f`）。

## 2026-11-23：任务 #12 全站界面溢出彻查修复 & 任务 #11 按钮交互反馈统一规范（分支 `antigravity/ui-audit-fix`）

- **#12 全站溢出彻查与修复**（详见 `docs/qa/界面溢出彻查_2026-11-22.md`）：
  - 使用 `scripts/e2e/ui-audit-crawl.mjs` 遍历 5 视口 × 5 角色（210 个页面状态），共检出 183 条问题（全部集中在 `768×1024` 平板竖屏顶栏不换行溢出、老师/课酬标准按钮被裁切、学员「显示号码」截断），以及设置 › 课程大类「⋯」菜单非锚点定位兼容与 `.fq-se-acts` 选择器误伤菜单高度问题；
  - 在 `v2.css`、`components.js`、`fq-settings.css`、`fq-teachers.css`、`fq-students.css` 统一层修复后，平板竖屏问题降至 **0 条**。
- **#11 按钮悬停/按下/焦点/禁用/减弱动态统一规范**（详见 `docs/qa/按钮交互规范验收_2026-11-23.md`）：
  - 在 `src/ui/components.css` 与 `src/tenant/fq.css` 统一层为所有第三期 `.fq-*` 按钮、筛选药丸、页签、列表行、图标按钮、手机底栏补充 `0.16s` 过渡、`@media (hover: hover)` 悬停反馈、`:active` 按下微缩、`:focus-visible` 焦点环、禁用态及 `prefers-reduced-motion: reduce` 支持。
- **验证**：`tests/e2e/ui-audit-and-hover.spec.mjs` 4/4 通过（Desktop / Tablet `768×1024` / Mobile `390×844`）。

## 2026-11-23：任务 #4 死代码第 5 批：清理 `c2 / c3` 无人调用旧后备入口（分支 `antigravity/deadcode-batch5`）

- **盘点结果**：
  - `src/tenant/v2pay.js` 全部分支与 8 个导出均仍在被 `fq-today.js`、`fq-students.js`、`fq-finance.js`、`v2f.js`、`c3.js` 调用，**完整保留**；
  - `src/tenant/c2.js`：移除确认 0 调用的 `pendingItem`、`courseLine`、`studentDetail`（已被 `v2p.js`/`fq-students.js` 覆盖）、`recordsPage`/`creditPage` 中不可达的 `dataset.studentDetail` 分支及 `ChannelRebuild.legacy` / `ChannelRebuild.studentDetail` 初始导出；
  - `src/tenant/c3.js`：移除确认 0 调用的 `leadDetail`（已被 `v2t.js`/`fq-leads.js` 无条件覆盖）、`dialogPassword`、`logOut`、`personalCourse`、`teacherToday`、`studentHome`、`personalSchedule`、`personalProfile`、`studentPayments`、`personalRecords` 及对应初始导出。
- **验证**：`npm run build && npm test` 与 `TEST_BUNDLE=1 npm test` 均 **378 / 378** 全绿。

## 2026-11-23：任务 #15 全站页面元素可用性彻查（分支 `antigravity/usability-audit`）

- **彻查内容**（详见 `docs/qa/页面元素可用性彻查_2026-11-22.md`）：
  - 复用 `ui-audit-crawl.mjs` 在 Desktop（`1280×800`）与 Mobile（`390×844`）双视口下遍历主管 13 个核心页面与老师端/学员端首页；
  - 验证全站 0 `pageerror`、0 非预期 `5xx`、线索抽屉必填校验/手机键盘类型/脏关闭「放弃更改」确认、`Esc` 关闭铃铛弹层、手机底栏热区 ≥ 40px 及老师/学员端离线提示条 `.fq-offline-bar`。
- **回归测试**：`tests/e2e/usability-audit.spec.mjs` **2 / 2 通过**（51.3s）。

## 2026-11-24：最新 `main@fee425a` 部署上线、只读浏览器核对与暂代 Claude 同步文档

- **Pages 部署上线**：将合入 PR #34（#12 溢出修复 + #11 按钮交互规范）、PR #35（#4 死代码第 5 批）、PR #36（#15 可用性彻查）的 `main@fee425a` 构建部署至 Cloudflare Pages `fengqin-crm-prod`（Deployment `2af262cb`）。
- **只读线上核对**：
  - 使用 Playwright 无头浏览器（桌面 `1440×900` + 手机 `390×844`）实测 `https://edu.fantasmearts.com/login`：HTTP 200、`errs: []`、`bad: []`、`overflow: false`；线上 `/assets/tenant.css?v=8468806870ad` 与 `/assets/tenant.js?v=535dc52e35e9` SHA-256 与本地构建 `dist/` **完全一致**；
  - `GET /api/setup` → `{"initialized":true}`，未登录 `GET /api/tools/leads` → HTTP 401。
- **暂代 Claude 文档同步**：Claude 暂休期间，按用户委托同步更新过时的 `docs/fengqin/任务板.md`、`docs/fengqin/项目状态.md` 与 `deployment/cloudflare/README.md`，与 GPT 当前正在执行的后端补审及 #5 清理零冲突。

## 2026-11-24：财务「确认收入来源明细」接口契约与前端实现（分支 `antigravity/finance-earned-details`）

- **接口契约**（已写入 `docs/fengqin/接口变更.md`）：定义 `GET /api/c3/report/earned?month=YYYY-MM`（零新表/零迁移，基于 `credit_income_entries` + `student_payment_resolutions` 返回 `summary`、`dimensions`、`items`）与 `GET /api/export?kind=report&month=YYYY-MM&scope=occurred` 的明细导出要求，待 GPT 实现后端部分。
- **前端实现**（无内联样式/HTML 注入/原生弹窗，后端未合入前优雅兼容不崩溃）：
  - `src/tenant/v2f.js`：新增共享明细组件 `renderEarnedDetails` 与 `openEarnedDrawer`；`#finance-reports` 增强「按教师/课程/学员」维度表补「确认收入 / 课酬后毛利」列并支持点击行下钻，新增第 4 个页签「收入明细」。
  - `src/tenant/fq-finance.js` & `fq-finance.css`：「财务 › 概览」的「确认收入」数字卡升级为可点击下钻入口（带「查看明细 →」标签），下方增加「本月确认收入构成」摘要条与「无单价待补录」快捷跳转。
- **回归测试**：`tests/e2e/finance-earned-details.spec.mjs` 双端通过。

## 2026-11-24：PR #39 门禁解阻与 PR #42「确认收入明细」前后端联动（分支 `antigravity/earned-details-integration`）

- **PR #39（`codex/backend-review`）解阻**：合入最新 `main` 解决 `docs/fengqin/接口变更.md` 冲突并跑通全套门禁（`build`、源码/打包 387/387、35 项迁移预检、系统 Chrome `test:e2e:smoke` 28 通过 / 2 项原有手机 skip），已解除 Draft 标记为可合并。
- **PR #42 前端联动修复**（按 GPT 在 PR #41/#42 的交接要求）：
  - `src/tenant/app.js`：`BATCH_EXACT` 加入 `"c3/report/earned"`，与后端 `read-batch.js` 精确白名单一致。
  - `src/tenant/v2f.js`：`renderEarnedDetails` 区分 `earned_amount === null` 历史快照（显示「快照未记录 / 暂不可核对」并保留实时台账明细，不再误转为 `0` 元）；明细与快照改按整数分精确比对，1 分钱差异即显示警告；维度表 `确认收入` 与 `课酬后毛利` 在空值时展示 `—` 并按分相减。
  - `tests/e2e/finance-earned-details.spec.mjs`：升级为包含无 Mock 的真实前后端与 `read-batch` 联调冒烟，及 `earned_amount: null` 历史快照、1 分钱差异告警、来源筛选与搜索回归。

## 2026-11-24：最新 `main@25194ee` 部署上线与只读核对

- **部署范围**（含 PR #37–#43，无新增 D1 迁移，数据库保持 `0035_lesson_unit_minutes.sql`）：
  - 备份 Worker `fengqin-backup-prod`：已部署 Version `d42a0b99-90ff-41c3-9b13-581efbac0c99`（cron `0 19 * * *`、`*/5 * * * *`）。
  - Pages `fengqin-crm-prod`：已部署 Deployment `75074c20`（环境变量、密钥与 D1/R2 绑定均未改动）。
- **上线只读核对**（`https://edu.fantasmearts.com`）：
  - `GET /api/setup` → `200 {"initialized":true}`。
  - `/login` 资源版本 `tenant.css?v=283bc3ac3867`、`tenant.js?v=928a7b46c157` 与本地 `dist/` SHA-256 一致。
  - 未登录访问 `/api/tools/leads`、`/api/c2/students`、`/api/teacher/today`、`/api/settings/institution`、`/api/c3/report/earned?month=2026-11` 均返回 `401`。
  - 已下线 `/api/public/theme.css`、`/api/workbench`、`/api/renewals` 返回 `404`。
  - Google Chrome 158 桌面（`1440×900`）与手机（`390×844`）`/login` 页面均 HTTP `200`、零 `pageerror`、零 `>=400` 请求、无横向溢出。
