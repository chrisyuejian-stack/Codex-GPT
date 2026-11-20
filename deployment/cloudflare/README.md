# 枫琴教务中心 · Cloudflare 线上部署记录

首次部署：2026-11-20（Claude）。代码版本：`claude/fengqin-internal-crm-dqg2c9` 分支 b1db8a2。

## 资源（账户 a9d8fe2813029e34c9a30534a1d05551）

| 类型 | 名称 | 说明 |
|---|---|---|
| Pages | `fengqin-crm-prod` | 站点，地址 https://fengqin-crm-prod.pages.dev（尚未绑定自定义域名） |
| D1 | `fengqin-crm-prod`（f4eaf652-ce6d-4098-909b-0f6563dbfd31，APAC） | 已执行迁移 0001–0031 |
| R2 | `fengqin-media-prod`、`fengqin-backups-prod` | 私有 |
| Worker | `fengqin-backup-prod` | 定时备份，cron `0 19 * * *`、`*/5 * * * *`，无公开地址 |

Pages 生产环境变量：`APP_HOST=fengqin-crm-prod.pages.dev`、`AI_FAST_MODEL`、`AI_DEEP_MODEL`、`AI_FAST_DAILY_LIMIT`、`AI_DEEP_DAILY_LIMIT`；
密钥：`FIELD_KEY`、`BACKUP_KEY`、`HMAC_KEY`、`PW_PEPPER`、`SETUP_KEY`（暂未配置 `DEEPSEEK_API_KEY`，AI 功能不可用）。
备份 Worker 密钥：`FIELD_KEY`、`BACKUP_KEY`、`HMAC_KEY`、`PW_PEPPER`（与 Pages 相同）。密钥值由用户自行保管，不在仓库中。
兼容日期 2026-11-16，与原艺界星途线上一致。

注意：`edu.fantasmearts.com` 目前绑定在旧站点 Pages `fantasme-academic` 上，切换前须确认；`edu.yijiexingtu.com` 属于艺界星途站点，不要占用。

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
