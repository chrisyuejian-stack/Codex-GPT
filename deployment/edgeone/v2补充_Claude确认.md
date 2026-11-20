# 对 v2 的确认与补充（Claude，2026-11-20）

配合 `给WorkBuddy_EdgeOne配置任务_v2.md` 与 `edgeone_verify.sh` 使用。v2 的结构、禁止事项、回滚条件全部沿用，下面只写**决策结果**和**与 v2 不同的地方**。

## 1. §0.2 决策：采用方案 ②（独立回源域名）

> 决策记录：采用方案 **②**，回源域名 `origin.fantasmearts.com`，确认人：用户（待签），日期 2026-11-20。

v2 §0.2 第 3 点担心的问题确实存在：原后端只接受 `APP_HOST` 一个域名，且写入请求要求 `Origin` 与请求地址同源，回源 HOST 换成 `origin` 会全部 404 / 403。**Claude 已改后端解决**（分支 `claude/wizardly-mccarthy-mc72l0`，有自动化测试）：

- 新增可选配置 `ORIGIN_HOST`。从该域名进来的请求按 `APP_HOST`（`edu.fantasmearts.com`）处理。
- 浏览器发来的 `Origin: https://edu.fantasmearts.com` 照常通过；直接在 `origin` 域名页面上发起的写入会被拒绝。
- 会话 Cookie 是 `__Host-` 前缀、不带 Domain，不受影响。

### 方案 ② 的分工

| # | 事项 | 谁来做 | 状态 |
|---|---|---|---|
| a | DNSPod **新增** `origin` CNAME → `fengqin-crm-prod.pages.dev`，TTL 600（只新增，不动其他记录） | 用户 / WorkBuddy | 待做 |
| b | Cloudflare Pages 添加自定义域 `origin.fantasmearts.com`，确认 Active | Claude | a 完成后做 |
| c | Cloudflare Pages 设置 `ORIGIN_HOST=origin.fantasmearts.com` 并重新部署 | Claude | 与 b 一起 |
| d | Claude 直连验证 `https://origin.fantasmearts.com/api/setup` 返回 `{"initialized":true}` | Claude | b、c 之后 |

**a–d 全部完成之前，不要配置 EdgeOne 的回源（第 3 步）。**

### 第 3 步表格按方案 ② 的最终值

| 项目 | 填写 |
|---|---|
| 源站类型 | IP/域名 |
| 源站地址 | `origin.fantasmearts.com` |
| 回源协议 | HTTPS，端口 443 |
| 回源 HOST 头 | 自定义：`origin.fantasmearts.com` |
| 回源 SNI（若有） | `origin.fantasmearts.com` |

`edu` 在 Cloudflare 上的自定义域**保留不删**：切换前它就是现状，回滚时把 `edu` CNAME 改回 `pages.dev` 即可直接恢复。切换后它即使变成 Inactive 也不影响 EdgeOne 回源。

## 2. 对 v2「原版 3 处修正」的意见

1. `/cdn-cgi/trace` 改为仅记录：**同意**。经过 EdgeOne 后，它显示的是 EdgeOne 出口进入 Cloudflare 的机房。如果是 `HKG`、`SIN` 这类亚洲机房，说明回源链路走得近，可以作为参考，但不作通过判定。
2. 缓存命中头不硬编码：**同意**。
3. 原版两条相同命令：这是**故意**请求两次，用来看第二次是否命中缓存，不是笔误。v2 脚本里已经明确区分第 1 次和第 2 次请求，效果一样，按脚本执行即可。

## 3. 第 6 步测试补充

方案 ② 下，`edgeone_verify.sh pre` 的用法不变（Host、SNI 仍是 `edu`，连接指向 EdgeOne）。在此之前，可以先确认回源域名本身可用（d 项 Claude 也会做）：

```bash
curl -s https://origin.fantasmearts.com/api/setup; echo
```

期望 `{"initialized":true}`。

## 4. 其他

- 回源超时、上传上限：找不到配置项就按 v2 §7 的约定记录为「平台默认」。Claude 会在切换后测一次全量备份导出和恢复，确认够用。
- 登录失败的按 IP 限制：经过 EdgeOne 后，后端看到的是 EdgeOne 节点 IP，所有人的失败次数会合在一起计算（一小时 100 次）。机构内部规模可以接受；按手机号的限制（15 分钟 20 次）照常有效。
