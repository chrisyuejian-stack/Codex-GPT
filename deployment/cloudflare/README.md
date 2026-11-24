# 枫琴教务中心 · Cloudflare 线上部署记录

首次部署：2026-11-20（Claude）。代码版本：`claude/fengqin-internal-crm-dqg2c9` 分支 b1db8a2。

## 资源（账户 a9d8fe2813029e34c9a30534a1d05551）

| 类型 | 名称 | 说明 |
|---|---|---|
| Pages | `fengqin-crm-prod` | 站点，正式地址 https://edu.fantasmearts.com（腾讯云 DNS：`edu` CNAME → `fengqin-crm-prod.pages.dev`）；`pages.dev` 地址因 APP_HOST 限制返回 404 |
| D1 | `fengqin-crm-prod`（f4eaf652-ce6d-4098-909b-0f6563dbfd31，APAC） | 已执行迁移 0001–0035 |
| R2 | `fengqin-media-prod`、`fengqin-backups-prod` | 私有 |
| Worker | `fengqin-backup-prod` | 定时备份，cron `0 19 * * *`、`*/5 * * * *`，无公开地址 |

Pages 生产环境变量：`APP_HOST=edu.fantasmearts.com`（2026-11-20 起）、`AI_FAST_MODEL`、`AI_DEEP_MODEL`、`AI_FAST_DAILY_LIMIT`、`AI_DEEP_DAILY_LIMIT`；
密钥：`FIELD_KEY`、`BACKUP_KEY`、`HMAC_KEY`、`PW_PEPPER`、`SETUP_KEY`（暂未配置 `DEEPSEEK_API_KEY`，AI 功能不可用）。
备份 Worker 密钥：`FIELD_KEY`、`BACKUP_KEY`、`HMAC_KEY`、`PW_PEPPER`（与 Pages 相同）。密钥值由用户自行保管，不在仓库中。
兼容日期 2026-11-16，与原艺界星途线上一致。

注意：`edu.fantasmearts.com` 已于 2026-11-20 从旧站点 Pages `fantasme-academic` 解绑并绑定到本项目；`edu.yijiexingtu.com` 属于艺界星途站点，不要占用。

## 更新站点

```sh
npm run build
node deployment/cloudflare/make-bundle.mjs dist /tmp/fq-bundle
```

`make-bundle.mjs` 把 `dist/` 的静态文件（tenant.html、tenant.js、tenant.css）内嵌进 `_worker.js`，用内存 `ASSETS` 代替 Pages 静态资源。
原因：Claude 的云端会话经代理访问 api.cloudflare.com 时，认证头会被统一替换成 API 令牌，而 Pages 静态资源上传接口只接受临时 JWT。
在普通电脑上也可以直接用 `npx wrangler pages deploy dist --project-name fengqin-crm-prod --branch main`，两种方式效果相同。

单文件上传（只需 API 令牌）：

```sh
curl -X POST "https://api.cloudflare.com/client/v4/accounts/<账户ID>/pages/projects/fengqin-crm-prod/deployments" \
  -H "Authorization: Bearer <令牌>" \
  --form-string "manifest={}" --form-string "branch=main" \
  -F "_worker.js=@/tmp/fq-bundle/_worker.js;type=application/javascript+module" \
  -F "_routes.json=@/tmp/fq-bundle/_routes.json;type=application/json"
```

新迁移：`npx wrangler d1 execute fengqin-crm-prod --remote --file migrations/00xx_*.sql`（先在站点停用期或低峰执行，再部署代码）。

## 更新备份 Worker

```sh
npm run build
npx wrangler deploy --config deployment/cloudflare/backup-wrangler.toml
```

## 部署记录

| 时间（UTC） | 代码 | 内容 |
|---|---|---|
| 2026-11-20 07:58 | b1db8a2 | 首次部署，迁移 0001–0031 |
| 2026-11-20 08:20 | d4938f6 | 修复账号页席位上限报错 |
| 2026-11-20 11:02 | d82b8b0 | 合入 main（PR #7：备份行数/大小、单条待办操作）；线上执行迁移 0032；同时重新部署备份 Worker。执行 0032 前的 D1 书签：`0000002a-00000000-00005129-b75c43ccc381025bb320986e102e9f3e` |

D1 没有 `d1_migrations` 表，迁移是逐个文件手动执行的；新增迁移后在上表登记。

**待执行**：`0033_lead_followups.sql`（第三期线索回访记录表，分支 `claude/` 第三期提交带入）。上线时由主会话在生产 D1 执行，执行前记下 D1 书签；全量备份迁移版本随之升到 33，需同时重新部署 Pages 与备份 Worker，执行后在上表登记。
| 2026-11-20 11:46 | e9dd0bc | 手机端提速（字体/登录图延迟加载、老师学员首屏预取） |
| 2026-11-20 11:50 | e9dd0bc | 自定义域名切到 `edu.fantasmearts.com`，APP_HOST 同步修改并重新部署 |
| 2026-11-20 13:47 | 新提交 | 新增自定义域 `origin.fantasmearts.com`（DNSPod CNAME → pages.dev，供 EdgeOne 回源，始终不改）；设置 `ORIGIN_HOST=origin.fantasmearts.com`；Smart Placement 已开启 |
| 2026-11-22 13:2x | 本提交 | **第三期上线**：学员/课表/线索/老师/设置重做、线索回访、学员手机尾号搜索、机构信息编辑。生产 D1 执行迁移 0033（Time Travel 回滚书签 `000002a0-00000000-0000512b-199329542096b945854722f0de15e299`，表数 83→84）；重新部署 Pages 与备份 Worker（版本 `739eabbe`，备份版本 32→33，首次定时运行成功）。注意：0032 及更早生成的全量备份不能再恢复，须上线后导出一次新的全量备份（主管在「设置 › 数据备份」操作） |
| 2026-11-23 06:21 | fe731ef | Antigravity 临时授权上线（含 PR #22–#29：设置三区、设计稿差距、E2E、登录页背景、课程形式合并 0034、排课总时长 0035）。临时库 `fengqin-parity-tmp` 全量演练与 6 触发器验证通过后删除（见 `docs/qa/迁移演练_2026-11-23.md`）。生产 D1 迁移前书签：`0000036b-00000000-0000512c-6da72a156445b4be267602dabdd2b602`；依次执行 `0034`（2.63ms）与 `0035`（17.22ms，回填 29 课程 + 5 模板）；同步部署备份 Worker `fengqin-backup-prod`（Version `a8fd6b17-ad15-459c-adda-3bf129b109a4`）与 Pages `fengqin-crm-prod`（Deployment `a62bb759`，环境变量与绑定未改动）。上线核对：`/api/setup` `{"initialized":true}`、`/login` 资源版本与 `dist/tenant.html` 一致、4 个受保护接口未登录均 401。 |
| 2026-11-23 08:05 | 5b251da | PR #32 P0 热更新：`fq-settings.css:849` 补齐未闭合 `@media (max-width: 760px)` 右花括号并新增全仓库 CSS 花括号配平测试；Pages `fengqin-crm-prod`（Deployment `054f38a2`）恢复登录页与主页卡片样式。 |
| 2026-11-23 09:00 | 1d29e4a | PR #33 任务 #14 上线：`UI.datePicker` 支持键盘多格式手动输入与日历「上/下个月」防失焦翻月、年月快选面板；Pages `fengqin-crm-prod`（Deployment `ea427c1f`）。 |
| 2026-11-24 07:40 | fee425a | PR #34/#35/#36（#12 平板溢出清零与菜单视口夹紧、#11 全站按钮交互反馈、#4 死代码第 5 批、`#15` 可用性回归）合入 `main` 后更新 Pages `fengqin-crm-prod`（Deployment `2af262cb`）；只读核对线上 `/login` 资源 `tenant.css?v=8468806870ad`、`tenant.js?v=535dc52e35e9` SHA-256 与本地构建一致、桌面/手机零报错零溢出、`/api/setup` 正常、`/api/tools/leads` 返回 401。 |
