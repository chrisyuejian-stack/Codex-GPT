# 任务：为 edu.fantasmearts.com 接入腾讯云 EdgeOne 加速

> 本文件交给 WorkBuddy 执行。请严格按顺序操作；每完成一步，记录结果。
> 遇到需要付费、需要选择套餐升级、或与本文描述不一致的界面，**先停下来问用户**，不要自行决定。

## 背景（只读，不需要操作）

- 系统：枫琴教务中心，内部教务 CRM，运行在 Cloudflare Pages。
- 现状：`edu.fantasmearts.com` 在 DNSPod 是一条 CNAME，指向 `fengqin-crm-prod.pages.dev`。
- 问题：国内手机访问被 Cloudflare 分配到洛杉矶机房，晚高峰 20 秒打不开。
- 目标：在 Cloudflare 前面加一层 EdgeOne（香港等境外节点），静态文件在 EdgeOne 缓存，接口请求经 EdgeOne 回源到 Cloudflare。
- 域名 **没有 ICP 备案**，所以加速区域只能选「全球可用区（不含中国大陆）」。
- 源站已经配好，**Cloudflare 侧不需要任何改动**。

## 禁止事项

1. 不要修改、删除 DNSPod 里除下面明确提到之外的任何记录（尤其是 `www`、`apply`、`selftest` 和根域名记录，它们属于其他网站）。
2. 不要把站点接入方式改成 NS 接入（不要改域名的 DNS 服务器）。
3. 不要对 `edu.fantasmearts.com` 开启 JS 挑战、人机校验、BOT 管理、CC 防护的拦截动作，也不要开启「缓存 POST 请求」。这些会让登录和接口失效。
4. 不要修改请求头里的 `Origin`、`Cookie`，也不要修改响应头里的 `Set-Cookie`。
5. 不要购买或升级任何付费套餐，除非用户明确同意。
6. 不要把任何密钥、密码写进本文件或聊天记录。

---

## 第 1 步：申请 HTTPS 证书（先做，避免切换时断网）

1. 打开腾讯云控制台 →「SSL 证书」→「我的证书」→「申请免费证书」。
2. 证书绑定域名：`edu.fantasmearts.com`。
3. 域名验证方式：**自动 DNS 验证**（域名在 DNSPod，会自动添加验证记录）。
4. 等待状态变为「已签发」。

**记录**：证书 ID、签发状态。

## 第 2 步：在 EdgeOne 添加站点

1. 打开「边缘安全加速平台 EO」→「站点列表」→「添加站点」。
2. 站点：`fantasmearts.com`。
3. 接入方式：**CNAME 接入**。
4. 加速区域：**全球可用区（不含中国大陆）**。
5. 套餐：选择支持上述区域的套餐；**涉及付费先问用户**。
6. 按提示做站点归属验证：在 DNSPod 添加 EdgeOne 要求的 **TXT 记录**（只新增这一条 TXT，不动其他记录），然后点验证，直到通过。

**记录**：站点 ID、套餐名称、加速区域。

## 第 3 步：添加加速域名

在该站点下「域名管理」→「添加域名」：

| 项目 | 填写 |
|---|---|
| 加速域名 | `edu.fantasmearts.com` |
| 源站类型 | IP/域名 |
| 源站地址 | `fengqin-crm-prod.pages.dev` |
| 回源协议 | **HTTPS** |
| 回源端口 | 443 |
| 回源 HOST 头 | **自定义：`edu.fantasmearts.com`**（必须是这个，不能用源站域名） |
| 回源 SNI（若有此项） | `edu.fantasmearts.com` |

> 为什么回源 HOST 必须是 `edu.fantasmearts.com`：源站只接受这个域名的请求，并校验写入请求的 `Origin` 与该域名一致。填成 `fengqin-crm-prod.pages.dev` 会导致全部 404 或登录后无法保存。

添加完成后，**记下 EdgeOne 分配的 CNAME 地址**（形如 `edu.fantasmearts.com.eo.dnse?.com`）。**此时先不要改 DNSPod 的 `edu` 记录。**

## 第 4 步：HTTPS 与协议

在加速域名的「HTTPS 配置」：

- 证书：选择第 1 步申请的 `edu.fantasmearts.com` 证书（SSL 托管证书）。
- 强制 HTTPS：开启（HTTP 301 跳转到 HTTPS）。
- TLS 版本：TLS 1.2、TLS 1.3。
- HTTP/2：开启。
- **HTTP/3（QUIC）：开启**（对手机弱网有帮助）。

## 第 5 步：缓存与回源规则（规则引擎）

在「规则引擎」为 `edu.fantasmearts.com` 添加以下规则，**顺序从上到下**：

**规则 A：静态文件长缓存**

- 匹配条件：URL 路径 匹配 `/assets/*`
- 节点缓存 TTL：**遵循源站**（源站返回 `Cache-Control: public, max-age=31536000, immutable`）
- 浏览器缓存 TTL：遵循源站
- 缓存键：**查询字符串 = 全部保留**（地址带 `?v=版本号`，不保留会导致发新版后拿到旧文件）
- 智能压缩：开启 Brotli 与 Gzip

**规则 B：其余全部不缓存**

- 匹配条件：URL 路径 不匹配 `/assets/*`（或作为全局默认规则）
- 节点缓存 TTL：**不缓存**（源站对页面与接口返回 `no-store`/`no-cache`）
- 浏览器缓存 TTL：遵循源站
- 关闭「启发式缓存」

**回源相关（在域名或站点的回源配置里）**

- 回源超时：设为可选的最大值（不少于 60 秒）。主管导出全量备份时请求较慢。
- 请求体上传上限：不少于 **30 MB**（备份恢复要上传最大 24 MB 的文件）。
- 回源跟随重定向：关闭。

## 第 6 步：切换前测试（不改 DNS，直接测 EdgeOne）

在终端执行（把 `<EO_CNAME>` 换成第 3 步得到的地址）：

```bash
EO=<EO_CNAME>
D=edu.fantasmearts.com
curl -s -o /dev/null -w "login %{http_code}\n" --connect-to $D:443:$EO:443 https://$D/login
curl -s --connect-to $D:443:$EO:443 https://$D/api/setup; echo
curl -s --connect-to $D:443:$EO:443 https://$D/api/auth/status; echo
JS=$(curl -s --connect-to $D:443:$EO:443 https://$D/login | grep -oE '/assets/tenant\.js\?v=[a-f0-9]+')
curl -s -o /dev/null -D - --connect-to $D:443:$EO:443 "https://$D$JS" | grep -iE 'HTTP/|cache-control|eo-cache-status'
curl -s -o /dev/null -D - --connect-to $D:443:$EO:443 "https://$D$JS" | grep -iE 'HTTP/|cache-control|eo-cache-status'
curl -s --connect-to $D:443:$EO:443 https://$D/cdn-cgi/trace | grep -E 'colo|loc'
```

**必须全部满足才能进入第 7 步：**

| 检查 | 期望结果 |
|---|---|
| `login` | `200` |
| `/api/setup` | `{"initialized":true}` |
| `/api/auth/status` | `{"authenticated":false,"api_base":"/api"}` |
| tenant.js 两次请求 | 都是 `200`，带 `cache-control: public, max-age=31536000, immutable`；第二次 `eo-cache-status` 为 `HIT`（若显示 MISS，隔几秒再试一次） |
| `/cdn-cgi/trace` | 有 `colo=` 一行（期望是香港 `HKG` 或亚洲机房，不应是 `LAX`） |

若 `login` 或 `/api/*` 返回 403、404、421、525、526：通常是回源 HOST 或回源 SNI 没填 `edu.fantasmearts.com`，或回源协议不是 HTTPS。修正后重测，**不要切换 DNS**。

## 第 7 步：切换 DNS

1. 打开 DNSPod → `fantasmearts.com` → 记录列表。
2. **只修改** 主机记录为 `edu`、类型为 `CNAME` 的那一条：
   - 原值：`fengqin-crm-prod.pages.dev`
   - 新值：第 3 步得到的 EdgeOne CNAME
   - TTL：600
3. 保存。等待 EdgeOne 控制台中该域名的 CNAME 状态变为「已生效」。

## 第 8 步：切换后验证

等 5–10 分钟后执行：

```bash
D=edu.fantasmearts.com
curl -s -o /dev/null -D - https://$D/login | grep -iE 'HTTP/|eo-|server'
curl -s https://$D/api/setup; echo
curl -s https://$D/cdn-cgi/trace | grep -E 'colo|loc'
```

期望：响应头里出现 `eo-` 开头的头（说明经过 EdgeOne），`/api/setup` 返回 `{"initialized":true}`。

然后请用户用手机打开 `https://edu.fantasmearts.com`，登录一次，确认能进入首页、能看到数据。

## 出问题时回滚（1 分钟内恢复）

DNSPod 把 `edu` 的 CNAME 改回 **`fengqin-crm-prod.pages.dev`** 即可，EdgeOne 配置可以保留以后再调。

## 完成后请交给用户的结果

1. EdgeOne 分配的 CNAME 地址。
2. 套餐名称与加速区域。
3. 第 6 步、第 8 步各条命令的完整输出。
4. 规则引擎配置截图。
5. 是否进行了 DNS 切换；如回滚，说明原因。

用户会把这些结果转给 Claude，Claude 负责检查 Cloudflare 一侧的证书和域名状态。
