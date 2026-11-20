# 任务 v2：为 edu.fantasmearts.com 接入腾讯云 EdgeOne 加速

> 本文件由 WorkBuddy 于 2026-11-20 基于原版（Claude 撰写）修订，**原文件保留未改动**。
> 修订性质：**不推翻原方案，补强前置决策门、修正 3 处会导致误判的验证项、补齐回滚触发条件与复查日历**。
> 执行约定沿用原版：严格按顺序操作；每完成一步记录结果；遇到需要付费、选套餐升级、或与本文描述不一致的界面，**先停下来问用户**，不要自行决定。

---

## 0. 先读这一节：方案定性与两个 Go / No-Go 决策门

### 0.1 这不是「迁移」，是「在 Cloudflare 前面加一层」

| 项目 | 实际状态 |
|---|---|
| 源站代码 | 仍在 Cloudflare Pages（`fengqin-crm-prod.pages.dev`） |
| 数据与 Worker / D1 | 仍在 Cloudflare |
| EdgeOne 的角色 | 前置边缘入口：静态文件在 EdgeOne 缓存，其余请求经 EdgeOne 回源到 Cloudflare |
| DNSPod 变更 | **只改 `edu` 一条 CNAME**，从 `pages.dev` 改为 EdgeOne 分配的 CNAME |
| 原版第 13 行「Cloudflare 侧不需要任何改动」 | **这是本方案风险最高的假设，见 0.2** |

如果你要的是「把 Pages + Worker + D1 整套搬离 Cloudflare」，本文件不是那件事，需要另立迁移方案。

### 0.2 【最高优先级·原版遗漏】Cloudflare 自定义域名可能在切换后失效

**因果链**：第 7 步把 `edu` 的 CNAME 改走 EdgeOne 后，Cloudflare Pages 上绑定的自定义域 `edu.fantasmearts.com` 就不再指向 CF。CF 会周期性做域名归属验证与证书续签检查，很可能把该域名标记为 `Inactive (Requires DNS setup)` 或停止续签证书。而**整套方案恰恰依赖 CF 认 `Host/SNI: edu.fantasmearts.com`**（原版第 57–60 行，且已实测 `pages.dev` 直连返回 404，回源 HOST 必须填 `edu`）——一旦自定义域失效，全站会出现 404 / 421 / 525 / 526，正好是原版第 125 行列出的错误码，但归因会指错方向（去查回源 HOST，实际是 CF 侧域名掉了）。

这是**延迟引爆型风险**：短期可能一切正常，最可能在证书到期续签时暴雷。原版把「Cloudflare 侧不需要任何改动」写进背景、把 CF 检查推到最后交给 Claude，等于把定时炸弹后置。

**切换 DNS 之前必须二选一，请用户 / Claude 拍板：**

- **方案 ①（保守，改动最小）**：接受风险，但把监控做实。
  - 切换前记录：CF Pages 自定义域状态（Active / Inactive）、该域名证书到期日、证书颁发机构。
  - 按 §0.4 的复查日历定期检查，一旦变 Inactive 或证书临近到期，立即执行方案 ② 或回滚。
- **方案 ②（推荐，根治）**：新增一个**始终指向 `pages.dev` 的独立回源域名**，例如 `origin.fantasmearts.com`。
  - 回源地址 / 回源 HOST / 回源 SNI 全部改用 `origin.fantasmearts.com`，让 `edu` 的 DNS 变动完全不影响回源链路。
  - 需要同步做三件事，**超出原版禁止事项第 1、2 条范围，必须用户明确同意后才能动**：
    1. DNSPod 新增 `origin` 一条 CNAME → `fengqin-crm-prod.pages.dev`（只新增，不动其他记录）；
    2. Cloudflare Pages 侧把 `origin.fantasmearts.com` 加为自定义域并确认状态 Active；
    3. 确认应用侧的 `Origin` 校验逻辑：浏览器发出的 `Origin` 仍是 `https://edu.fantasmearts.com`（EdgeOne 按禁止事项第 4 条不改写），而回源 HOST 变成 `origin`，两者是不同字段，需确认应用不会因 Host 变化拒绝写入请求。
  - 采用方案 ② 后，本文档第 3 步表格中「回源 HOST 头 / 回源 SNI」以及第 60 行的说明要相应改写，且第 6 步的 `Origin` 相关验证项仍然有效。

> 决策记录（执行前填写）：采用方案 ____ ，确认人 ____ ，日期 ____ 。
> 若未决策，**不要进入第 7 步**。

### 0.3 【必须告知】验证环境有代理时，`--connect-to` 会失效

实测（2026-11-20，WorkBuddy 执行环境）：`HTTP_PROXY/HTTPS_PROXY=http://127.0.0.1:62230` 时，同一条 `--connect-to` 命令返回 `403`、`remote_ip=127.0.0.1`；加 `--noproxy '*'` 后才返回 `200`。原因是通过 HTTP 代理时 curl 建立 CONNECT 隧道到代理，`--connect-to` 的重定向不生效。

**因此第 6 步必须在无代理的干净终端（你自己的 Mac「终端」App）里执行**，不要在带沙箱代理的 AI 执行环境里跑。配套的 `edgeone_verify.sh` 会自动检测代理并告警，且强制 `--noproxy`；若检测到透明代理（remote_ip 落在 `198.18.0.0/15` 等保留段），结果仍应视为**仅参考**，以真机 / 干净网络结果为准。

### 0.4 切换后 30 天复查日历（针对 0.2）

| 时点 | 检查 | 期望 |
|---|---|---|
| T+1 天 | CF Pages 自定义域状态、`edu` 证书到期日 | 与切换前记录一致 |
| T+7 天 | 同上 + 全站功能（登录、写入、导出） | 正常 |
| T+30 天 | 同上 | 正常 |
| 证书到期前 30 天 | CF 是否自动续签成功 | 已续签；若未续签**立即**执行方案 ② |
| 每次 CF / EdgeOne 控制台提示域名异常 | 立即全量验证 | 见 §9 |

---

## 1. 背景（只读，不需要操作）

- 系统：枫琴教务中心，内部教务 CRM，运行在 Cloudflare Pages。
- 现状：`edu.fantasmearts.com` 在 DNSPod 是一条 CNAME，指向 `fengqin-crm-prod.pages.dev`。
- 问题：国内手机访问被 Cloudflare 分配到洛杉矶机房，晚高峰 20 秒打不开。
- 目标：在 Cloudflare 前面加一层 EdgeOne（香港等境外节点），静态文件在 EdgeOne 缓存，接口请求经 EdgeOne 回源到 Cloudflare。
- 域名 **没有 ICP 备案**，所以加速区域只能选「全球可用区（不含中国大陆）」。
- **实测基线（2026-11-20，只读 GET，未改动任何配置）**：

| 检查 | 实测结果 |
|---|---|
| `edu` CNAME | `fengqin-crm-prod.pages.dev.` |
| `/login` | `200`，`cache-control: no-store`，`server: cloudflare` |
| `/api/setup` | `200`，`{"initialized":true}`，`cache-control: no-store` |
| `/api/auth/status` | `200`，`{"authenticated":false,"api_base":"/api"}` |
| `/cdn-cgi/trace` | `colo=LAX`、`loc=US`、`ip=142.249.36.112` |
| 静态资源 | `/assets/tenant.js?v=05ccb5408ac3` 等 3 个，`cache-control: public, max-age=31536000, immutable` |
| `server-timing` | `served_by_region;desc="APAC"`（后端计算其实在亚太） |
| `pages.dev` 直连 | `404`（印证原版第 60 行：回源 HOST 必须是 `edu.fantasmearts.com`） |
| 只改 Host、不改 SNI | `403`（旁证；本机走代理，最终以第 6 步真实 EdgeOne 环境为准） |

> 补充观察：`colo=LAX` 但 `served_by_region=APAC`，说明慢的是 **CF 边缘接入这一段**，后端并不慢。这佐证了「加一层亚洲边缘入口」的思路方向正确。

## 2. 禁止事项（原版 6 条全部保留，新增 3 条）

1. 不要修改、删除 DNSPod 里除下面明确提到之外的任何记录（尤其是 `www`、`apply`、`selftest` 和根域名记录，它们属于其他网站）。
2. 不要把站点接入方式改成 NS 接入（不要改域名的 DNS 服务器）。
3. 不要对 `edu.fantasmearts.com` 开启 JS 挑战、人机校验、BOT 管理、CC 防护的拦截动作，也不要开启「缓存 POST 请求」。这些会让登录和接口失效。
4. 不要修改请求头里的 `Origin`、`Cookie`，也不要修改响应头里的 `Set-Cookie`。
5. 不要购买或升级任何付费套餐，除非用户明确同意。
6. 不要把任何密钥、密码写进本文件或聊天记录。
7. **【v2 新增】规则引擎是「命中即终止、按优先级顺序执行」：`/assets/*` 长缓存规则必须排在最上，其余不缓存规则紧随其后。不要在它之前加任何全局缓存 / 默认缓存规则**，否则 `/api/*` 会被缓存（轻则数据不刷新，重则登录态串号）。
8. **【v2 新增】不要删除证书自动 DNS 验证与站点归属验证自动添加的 TXT 记录**。第 1 步的证书验证 TXT 与第 2 步的站点归属 TXT 是**两条不同记录**，都属于正常流程，不属于禁止事项第 1 条要保护的记录。
9. **【v2 新增】未通过 §0.2 决策、未跑通第 6 步验证之前，不要动第 7 步的 DNS。**

---

## 3. 第 1 步：申请 HTTPS 证书（先做，避免切换时断网）

1. 打开腾讯云控制台 →「SSL 证书」→「我的证书」→「申请免费证书」。
2. 证书绑定域名：`edu.fantasmearts.com`。
3. 域名验证方式：**自动 DNS 验证**（域名在 DNSPod，会自动添加验证记录；见禁止事项第 8 条，勿删）。
4. 等待状态变为「已签发」。

**记录**：证书 ID、签发状态、**证书到期日**（§0.2 复查日历要用）。

## 4. 第 2 步：在 EdgeOne 添加站点

1. 打开「边缘安全加速平台 EO」→「站点列表」→「添加站点」。
2. 站点：`fantasmearts.com`。
3. 接入方式：**CNAME 接入**。
4. 加速区域：**全球可用区（不含中国大陆）**。
   > ⚠️ 加速区域创建时选定后通常不可更改，选错需要重建站点重新解析。本域名无 ICP 备案，选这个区域是合规上的正确选择，但要理解它的含义：**中国大陆境内不设节点**，国内用户会被分配到香港 / 新加坡 / 东京等境外节点。改善幅度取决于这些节点到国内运营商的线路质量，建议第 8 步后用国内手机在不同运营商网络实测，而不是只看机房代号。
5. 套餐：选择支持上述区域的套餐；**涉及付费先问用户**。若无符合要求的免费选项，停下来问，不要自行升级。
6. 按提示做站点归属验证：在 DNSPod 添加 EdgeOne 要求的 **TXT 记录**（只新增这一条 TXT，不动其他记录），然后点验证，直到通过。

**记录**：站点 ID、套餐名称、加速区域、归属验证 TXT 记录名。

## 5. 第 3 步：添加加速域名

在该站点下「域名管理」→「添加域名」：

| 项目 | 填写 |
|---|---|
| 加速域名 | `edu.fantasmearts.com` |
| 源站类型 | IP/域名 |
| 源站地址 | `fengqin-crm-prod.pages.dev`（若采用 §0.2 方案 ②，改为 `origin.fantasmearts.com`） |
| 回源协议 | **HTTPS** |
| 回源端口 | 443 |
| 回源 HOST 头 | **自定义：`edu.fantasmearts.com`**（必须是这个，不能用源站域名；方案 ② 下改为 `origin.fantasmearts.com`） |
| 回源 SNI（若有此项） | `edu.fantasmearts.com`（方案 ② 下同步改） |

> 为什么回源 HOST 必须是 `edu.fantasmearts.com`：源站只接受这个域名的请求，并校验写入请求的 `Origin` 与该域名一致。填成 `fengqin-crm-prod.pages.dev` 会导致全部 404 或登录后无法保存。
> **【v2 补充】** 回源 HOST 与请求 `Origin` 头是两个不同字段：EdgeOne 按禁止事项第 4 条不改写 `Origin`，浏览器仍发 `https://edu.fantasmearts.com`；若把回源 HOST 换成别的域名，需确认应用侧不会因 Host 变化拒绝写入（见 §0.2 方案 ② 第 3 点）。

添加完成后，**记下 EdgeOne 分配的 CNAME 地址**（形如 `edu.fantasmearts.com.eo.dnse?.com`）。**此时先不要改 DNSPod 的 `edu` 记录。**

## 6. 第 4 步：HTTPS 与协议

在加速域名的「HTTPS 配置」：

- 证书：选择第 1 步申请的 `edu.fantasmearts.com` 证书（SSL 托管证书）。
- 强制 HTTPS：开启（HTTP 301 跳转到 HTTPS）。
- TLS 版本：TLS 1.2、TLS 1.3。
- HTTP/2：开启。
- **HTTP/3（QUIC）：开启**（对手机弱网有帮助）。
  > 【v2 补充】本机 curl 8.7.1 未编译 HTTP/3，命令行无法验证 QUIC 是否生效；此项以 EdgeOne 控制台状态 + 手机实测为准，不要用 curl 结果判定。

## 7. 第 5 步：缓存与回源规则（规则引擎）

在「规则引擎」为 `edu.fantasmearts.com` 添加以下规则，**顺序从上到下**（见禁止事项第 7 条）：

**规则 A：静态文件长缓存**

- 匹配条件：URL 路径 匹配 `/assets/*`
- 节点缓存 TTL：**遵循源站**（源站返回 `Cache-Control: public, max-age=31536000, immutable`，已实测）
- 浏览器缓存 TTL：遵循源站
- 缓存键：**查询字符串 = 全部保留**（地址带 `?v=版本号`，不保留会导致发新版后拿到旧文件；已实测 `?v=05ccb5408ac3`）
- 智能压缩：开启 Brotli 与 Gzip

**规则 B：其余全部不缓存（必须排在 A 之后）**

- 匹配条件：URL 路径 不匹配 `/assets/*`（或作为全局默认规则）
- 节点缓存 TTL：**不缓存**（源站对页面与接口返回 `no-store`/`no-cache`，已实测 `/login` 与 `/api/setup` 均为 `no-store`）
- 浏览器缓存 TTL：遵循源站
- 关闭「启发式缓存」

**回源相关（在域名或站点的回源配置里）**

- 回源超时：设为可选的最大值（不少于 60 秒）。主管导出全量备份时请求较慢。
- 请求体上传上限：不少于 **30 MB**（备份恢复要上传最大 24 MB 的文件）。
- 回源跟随重定向：关闭。

> **【v2 新增·重要】** 这三项在 EdgeOne 控制台 / 当前套餐里**未必有对应可配项**（可能是固定值或套餐限制）。按文档开头的总约定：**界面与本文描述不一致时先停下来问用户**，不要找一个名字相近的设置硬填，也不要为了凑 30 MB 去升级付费套餐。找不到就记录「本套餐无此项 / 采用平台默认值」并继续，交给 Claude / 用户评估。

---

## 8. 第 6 步：切换前测试（不改 DNS，直接测 EdgeOne）

**执行要求**：在无代理的干净终端（你自己的 Mac「终端」App）运行；不要复制原版第 6 步那几条命令——它们有 3 个问题（见下方「原版 3 处修正」）。改用配套脚本：

```bash
chmod +x edgeone_verify.sh
EO=<第3步得到的 EdgeOne CNAME> ./edgeone_verify.sh pre
```

脚本会依次检查并输出 `PASS / FAIL / INFO` 与汇总，纯只读（只发 GET、不登录、不写数据、不改 DNS）。

**必须全部满足才能进入第 7 步：**

| 检查 | 期望结果 | 判定级别 |
|---|---|---|
| `/login` | `200`，且 `cache-control` 含 `no-store` | 必须 |
| `/api/setup` | `200`，`{"initialized":true}`，`no-store` | 必须 |
| `/api/auth/status` | `200`，`{"authenticated":false,...}`，`no-store` | 必须 |
| `/api/*` 未被缓存 | 响应头无 `Age`、无缓存命中头 | 必须（防止登录态串号） |
| `/assets/*.js?v=...` 两次请求 | 都 `200`，带 `cache-control: public, max-age=31536000, immutable`；第二次出现任意缓存命中迹象（见下） | 必须 |
| 页面与接口未被静态规则误伤 | 页面 / 接口不出现 `max-age=31536000` | 必须 |
| 响应头含 EdgeOne 痕迹 | 出现 `eo-` / `x-nws-` / 平台标识类响应头 | 仅记录，**不作为硬门槛**（头名因版本而异） |
| `/cdn-cgi/trace` 的 `colo` / `loc` / `ip` | 仅记录 | **不作判定**，见下 |

**原版 3 处修正（这三条是 v2 的核心价值）：**

1. **`/cdn-cgi/trace` 不能作为「命中 EdgeOne 节点」的判据。** 该端点是 Cloudflare 的，反映的是 **CF 看到的回源来源**（即 EdgeOne 出口 IP 归属的 CF 机房），不是用户设备命中的 EdgeOne 节点。期望「`HKG`、不应是 `LAX`」在逻辑上不成立，且可能误导排障。真正判断加速是否生效应看：EdgeOne 响应头、国内真机延迟对比、`ip=` 是否变为 EdgeOne 回源段。故降级为「仅记录」。
2. **`eo-cache-status` 头名硬编码会误判。** EdgeOne 各版本 / 各区域的缓存状态头名不统一（常见 `x-nws-log-uuid`、`x-cache`、`x-cache-lookup`、`eo-cache-status` 等），实测当前基线的静态资源响应里**没有任何 `eo-` 头**。因此脚本改为：打印全部响应头，用宽松规则匹配任意 `age` / `x-cache*` / `x-nws-*` / `eo-*` / `*hit*` 迹象，并给出一个明确的 `INFO` 让人确认，而**不因为缺某个特定头名就判 FAIL**。缓存是否生效以 `cache-control` + 两次请求头对比 + `Age` 为准。
3. **原版命令第 110、111 行是两条完全相同的重复命令**，且 `JS` 的正则 `/assets/tenant\.js\?v=[a-f0-9]+` 硬编码了文件名，构建产物一旦改名就抓不到。脚本改为从 `/login` 页面动态提取任意 `/assets/*.js?v=...`，并明确区分第 1 次 / 第 2 次请求。

若 `login` 或 `/api/*` 返回 **403、404、421、525、526**：按以下顺序排查，**不要切换 DNS**：

1. 回源 HOST / 回源 SNI 是否填了 `edu.fantasmearts.com`、回源协议是否 HTTPS 443；
2. 证书是否已在该加速域名上生效（未生效常见 525/526）；
3. 是否命中了 JS 挑战 / CC 拦截等禁止动作（403）；
4. **【v2 新增】** 若以上都对，去 Cloudflare Pages 检查 `edu.fantasmearts.com` 自定义域是否仍是 Active（§0.2）——错误码一样，但根因在 CF 侧。

修正后重测。

## 9. 第 7 步：切换 DNS

**前置检查（v2 新增，全部为「是」才继续）**：

- [ ] §0.2 已决策（方案 ① 或 ②），方案 ② 若采用，其三项改动已全部完成并生效；
- [ ] 已记录 CF Pages 自定义域状态与证书到期日；
- [ ] 第 6 步脚本 `pre` 模式全部必须项 PASS；
- [ ] 第 1 步证书状态为「已签发」且已绑定到加速域名；
- [ ] 当前业务低峰期，且手上有 DNSPod 回滚权限。

操作步骤：

1. 打开 DNSPod → `fantasmearts.com` → 记录列表。
2. **只修改** 主机记录为 `edu`、类型为 `CNAME` 的那一条：
   - 原值：`fengqin-crm-prod.pages.dev`
   - 新值：第 3 步得到的 EdgeOne CNAME
   - TTL：600
3. 保存。等待 EdgeOne 控制台中该域名的 CNAME 状态变为「已生效」。

## 10. 第 8 步：切换后验证

等 5–10 分钟后执行：

```bash
./edgeone_verify.sh post          # 命令行全量验证（脚本会自动记录并比对基线）
```

期望：`/login`、`/api/*` 全部 200 且保持 `no-store`；静态资源长缓存且第二次命中；响应头出现 EdgeOne 平台痕迹。

然后请用户用**国内手机**打开 `https://edu.fantasmearts.com`：

- 登录一次，确认能进入首页、能看到数据；
- **执行一次写入操作**（新增 / 保存一条记录），确认 `Origin` 校验与 `Set-Cookie` 未被改写；
- **执行一次导出或较大文件上传**（如条件允许，接近 24 MB 的备份恢复），确认请求体上限与回源超时够用；
- 分别在 Wi-Fi 与蜂窝网络、晚高峰时段对比打开速度，与切换前体感对照。

> 这三项功能测试是命令行验证覆盖不到的，必须人工做——原版禁止事项第 3、4 条只能靠功能测试证明没被破坏。

## 11. 回滚触发条件（v2 新增：把「出问题就回滚」量化）

**立即回滚**（DNSPod 把 `edu` CNAME 改回 `fengqin-crm-prod.pages.dev`，TTL 600，约 1 分钟内恢复；EdgeOne 配置保留以后再调）：

- `/login` 非 200，或 `/api/setup` 不返回 `{"initialized":true}`；
- 登录后无法写入 / 保存，或 `Set-Cookie` 丢失导致反复掉登录；
- `/api/*` 出现缓存命中头或 `Age`（**有登录态串号 / 数据泄露风险，优先级最高**）；
- 出现 525 / 526（TLS 握手失败）且 15 分钟内无法修复；
- 国内真机实测比切换前明显更慢且持续；
- CF Pages 自定义域变 Inactive 且短期无法恢复（§0.2）。

**先修配置、不切 DNS 重试**（第 6 步阶段）：403 / 404 / 421 / 525 / 526 且原因明确、可在控制台修正。

**回滚后必做**：重新跑一次 `./edgeone_verify.sh post` 确认直连 CF 已恢复，并**再次记录 CF Pages 自定义域状态**（切走再切回可能触发 CF 重新验证）。

## 12. 完成后请交给用户 / Claude 的结果

1. EdgeOne 分配的 CNAME 地址。
2. 套餐名称、加速区域、站点 ID。
3. 第 6 步（`pre`）与第 8 步（`post`）脚本的**完整输出**（脚本可直接重定向保存）。
4. 规则引擎配置截图（**含规则顺序**）。
5. 是否进行了 DNS 切换；如回滚，说明原因与触发的是 §11 哪一条。
6. **【v2 新增】** 切换前后 Cloudflare Pages 自定义域状态、证书到期日、证书颁发机构。
7. **【v2 新增】** 缓存状态响应头的实际名称（脚本会打印全部响应头，便于确定）。
8. **【v2 新增】** §0.2 采用的是方案 ① 还是 ②，及确认人。
9. **【v2 新增】** 国内手机功能测试结果（登录 / 写入 / 导出）与晚高峰体感对比。

---

## 附：WorkBuddy 能做与不能做的边界（诚实说明）

**不能做**：没有腾讯云控制台登录态，第 1–5、7 步的点按钮操作无法代点；套餐与加速区域涉及付费，不擅自决定；DNSPod DNS 记录不擅自修改；已连接的 `edgeone-pages`（EdgeOne Makers）与 `cloudbase` 连接器管的是**应用部署 / 云开发**，不是「站点加速 / 加速域名 / 规则引擎 / 证书 / DNSPod 记录」，对本任务帮不上。

**已做**：本 v2 文档、`edgeone_verify.sh` 验证脚本、一组纯只读的基线核实（DNS、接口响应、静态资源缓存头、回源 HOST 行为、代理对 `--connect-to` 的影响）。**未改动任何线上配置、未改 DNS、未读取任何密钥文件。**

**可继续做**：把控制台操作脚本化（Terraform `tencentcloud_teo_*` / tccli / API 3.0，先给 `plan` 再 `apply`，凭证走环境变量）；在切换当天同步跑 `pre` / `post` 脚本并解读输出。
