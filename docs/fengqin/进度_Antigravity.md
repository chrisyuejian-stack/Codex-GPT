# 进度：Antigravity

追加式，按日期写：做了什么、PR 编号、测试结果、发现的问题、需要用户或 Claude 决定的事。不要改 `任务板.md`、`项目状态.md`（由 Claude 统一维护）。

## 2026-11-23：迁移 0034 / 0035 临时库演练与生产部署上线

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
