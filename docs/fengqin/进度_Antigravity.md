# 进度：Antigravity

追加式，按日期写：做了什么、PR 编号、测试结果、发现的问题、需要用户或 Claude 决定的事。不要改 `任务板.md`、`项目状态.md`（由 Claude 统一维护）。

## 2026-11-23：迁移 0034 / 0035 临时库演练与生产部署上线（PR #31）

- **基线代码**：`main@fe731ef`（已合入 PR #23、#24、#25、#26、#27、#28、#29）
- **前提检查**（Node `v22.23.5`）：`npm run build` ✅、`npm run test:migrations:preflight` ✅（35 个迁移至 0035，0 外键错误）、`npm test` **375/375** ✅、`TEST_BUNDLE=1 npm test` **375/375** ✅。
- **临时库演练**（详见 `docs/qa/迁移演练_2026-11-23.md`）：
  - 在 APAC 创建临时库 `fengqin-parity-tmp`，按 `0001`–`0033` 建表并按 `restoreTables` 拓扑序导入生产数据行，演练 `0034`、`0035` 全部通过；
  - 验证回填完整（29 节课程、5 条固定排课模板 `unit_minutes` 均非空）、6 个 `course_limits_*` 触发器正反用例全部符合预期；
  - 演练完成后已删除临时库与 `/tmp` 下所有导出文件。
- **生产迁移与部署**：
  - 生产 D1 迁移前 Time Travel 回滚书签：`0000036b-00000000-0000512c-6da72a156445b4be267602dabdd2b602`；
  - 生产 D1 依次执行 `0034_merge_course_formats.sql`（2.63 ms）与 `0035_lesson_unit_minutes.sql`（17.22 ms，回填 34 行），只读核对行数、空值、触发器数全部一致；
  - 部署备份 Worker `fengqin-backup-prod`（Version ID `a8fd6b17-ad15-459c-adda-3bf129b109a4`）与 Pages `fengqin-crm-prod`。

## 2026-11-23：P0 线上 CSS 花括号未闭合修复与热更新（PR #32）

- **问题根因**：`src/tenant/fq-settings.css` 第 837 行的 `@media (max-width: 760px) {` 在合入 PR #23 与 PR #26 后缺少右花括号 `}`（第 849 行），导致打包在其后的 `fq-schedule.css`、`fq-students.css`、`fq-teachers.css`、`fq.css` 全部被包裹进移动端 `@media (max-width: 760px)`，致使桌面端登录页与内部主页卡片背景样式失效。
- **修复与防回归**：
  - 补齐 `src/tenant/fq-settings.css:849` 的 `}`；
  - 在 `tests/settings-institution.test.mjs` 新增全仓库 CSS 花括号配平测试（校验 `src/ui/`、`src/tenant/` 及打包产物 `dist/assets/tenant.css` 的 `{}` 深度归零）；
  - 已立即构建并部署到 Cloudflare Pages `fengqin-crm-prod`（Deployment `054f38a2`），线上登录页与内部主页卡片恢复正常。

## 2026-11-23：任务 #14 日期输入可手动输入 + 日历翻月按钮修复（分支 `antigravity/date-input`）

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
- **生产部署**：已将含 P0 CSS 修复 + 任务 #14 日期/日历组件修复的最新 `dist/` 部署至 Cloudflare Pages `fengqin-crm-prod`。
