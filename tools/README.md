# tools/：开发与排障脚本

均为开发辅助，不进生产包。需要 Node.js 24+、仓库根目录运行；浏览器脚本使用 Playwright（`require('playwright')`）。

## tools/qa/（浏览器验收与测速，Playwright）

先起本地预览：`npm run build`，`TEST_BUNDLE=1 PREVIEW_PORT=<端口> npm run dev`，再 `PREVIEW_URL=http://localhost:<端口> node scripts/preview-seed.mjs`。脚本里的 `BASE` 端口按需修改（历史上用过 4173/4180/4185）。老师账号 13700000001 / TeacherPreview9Z 需先用主管创建并改密（做法见 `docs/fengqin/项目状态.md`「本地复现」）。

| 脚本 | 用途 |
|---|---|
| `wf.cjs`、`wf2.cjs` | 登录后与切页的接口请求链（时间、请求体） |
| `wf3.cjs` | 冷启动登录请求链：每个 /api 加 150ms 延迟以显示串行层数，列出重复请求与错误 |
| `offline.cjs` | PWA 离线：浏览→断网刷新→提示条→恢复网络 |
| `swr.cjs` | 老师/学员端切页是否先显示上次画面（无骨架）与彩条随滚动 |
| `todo.cjs` | 待办页按钮逐个点击，查禁用与报错 |
| `lp.cjs`、`shot.cjs` | 登录页加载的资源与截图 |
| `ref.cjs` | 截取现有新界面作为设计参照（`design/redesign/ref/`） |
| `template.cjs` | 由线上外壳生成设计稿模板（`design/redesign/_shared/`） |

## tools/diagnostics/（线上与数据排障）

| 脚本 | 用途 |
|---|---|
| `inboxsql.mjs` | 捕获 `repo.inbox()` 的 SQL 并内联参数，便于在 D1 只读执行复现（2026-11-20 定位「too many terms in compound SELECT」） |
| `sched.mjs` | 本地运行备份 Worker 的定时任务（`BW=backup-dist/backup-worker.js` 可测打包产物） |
| `schema.mjs` | 打印本地完整迁移后的表/索引清单，用于和生产 `sqlite_master` 对比 |
| `explain_d1.py` | 把收集到的 SQL 逐条以 `EXPLAIN` 发到 D1（只编译不执行），找线上编译期不兼容；结果样例见 `docs/fengqin/reports/explain_result.json` |
| `cf_graphql.py` | 调 Cloudflare GraphQL Analytics（Worker/Pages 调用量、状态、CPU） |

调用 Cloudflare API 需要 API 令牌（`Authorization: Bearer …`），令牌不进仓库，由用户提供或在 Claude 云环境的网络密钥中注入。对生产 D1 只允许只读查询与 `EXPLAIN`。
