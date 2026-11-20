#!/usr/bin/env bash
# edgeone_verify.sh — edu.fantasmearts.com EdgeOne 接入验证
#
# 配套文档：给WorkBuddy_EdgeOne配置任务_v2.md
# 纯只读：只发 GET，不登录、不写数据、不改 DNS、不改任何线上配置。
#
# 用法：
#   ./edgeone_verify.sh baseline                 # 第 0 步：切换前直连 Cloudflare 建立基线
#   EO=<EdgeOne分配的CNAME> ./edgeone_verify.sh pre   # 第 6 步：不改 DNS，直连 EdgeOne 节点
#   ./edgeone_verify.sh post                    # 第 8 步：DNS 切换后验证
#
# 可覆盖环境变量：
#   D=<域名>         默认 edu.fantasmearts.com
#   EO=<CNAME>       pre 模式必填
#   TIMEOUT=<秒>     默认 25
#   VERBOSE=1        打印每个请求的完整响应头（用于确定缓存状态头的真实名称）
#
# 注意：
#   * pre 模式用 curl --connect-to 把 TCP 连接指向 EdgeOne，但 TLS SNI 与 Host 头
#     仍保持为 $D —— 这正是真实用户请求经过 EdgeOne 时的形态，也用于验证回源 HOST。
#   * 通过 HTTP 代理时 --connect-to 会失效，因此本脚本强制 --noproxy '*'。
#     若仍检测到 remote_ip 为 127.0.0.1 / 198.18.x.x 等，说明存在透明代理，
#     结果仅作参考，请在无代理的干净终端（Mac 自带「终端」App）重跑。
#   * 完整输出建议保存： EO=xxx ./edgeone_verify.sh pre 2>&1 | tee edgeone_pre.log

set -u

MODE="${1:-}"
D="${D:-edu.fantasmearts.com}"
EO="${EO:-}"
TIMEOUT="${TIMEOUT:-25}"
VERBOSE="${VERBOSE:-0}"

if [ -z "$MODE" ]; then
  echo "用法: $0 {baseline|pre|post}   (pre 需设置 EO=<EdgeOne CNAME>)"; exit 2
fi
case "$MODE" in
  baseline|pre|post) ;;
  *) echo "未知模式: $MODE （只能是 baseline / pre / post）"; exit 2 ;;
esac
if [ "$MODE" = "pre" ] && [ -z "$EO" ]; then
  echo "pre 模式必须通过环境变量提供 EO，例如："; echo "  EO=edu.fantasmearts.com.eo.dnse3.com $0 pre"; exit 2
fi
EO="$(printf '%s' "$EO" | sed 's/\.$//')"   # 去掉可能的结尾点

TMP="$(mktemp -d "${TMPDIR:-/tmp}/eo_verify.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

PASS=0; FAIL=0; INFO=0
pass() { printf '  \033[32m[PASS]\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
fail() { printf '  \033[31m[FAIL]\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }
info() { printf '  \033[36m[INFO]\033[0m %s\n' "$*"; INFO=$((INFO+1)); }
warn() { printf '  \033[33m[WARN]\033[0m %s\n' "$*"; INFO=$((INFO+1)); }
section() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

CURL_OPTS=(-sS --max-time "$TIMEOUT" --noproxy '*')
if [ "$MODE" = "pre" ]; then
  CURL_OPTS+=(--connect-to "$D:443:$EO:443")
fi

# 发出一次 GET，把 body / headers / 元数据分开存
req() {
  local path="$1" tag="$2"
  curl "${CURL_OPTS[@]}" \
    -D "$TMP/$tag.h" -o "$TMP/$tag.b" \
    -w '%{http_code}\t%{time_total}\t%{remote_ip}' \
    "https://$D$path" > "$TMP/$tag.meta" 2> "$TMP/$tag.err" || true
  [ -s "$TMP/$tag.meta" ] || printf '000\t0\t-\n' > "$TMP/$tag.meta"
}
code() { cut -f1 "$TMP/$1.meta"; }
timing() { cut -f2 "$TMP/$1.meta"; }
remote() { cut -f3 "$TMP/$1.meta"; }
hdr() { tr -d '\r' < "$TMP/$1.h" 2>/dev/null | grep -i "^$2:" | head -1 | sed 's/^[^:]*:[[:space:]]*//'; }
body() { tr -d '\r\n' < "$TMP/$1.b" 2>/dev/null | head -c 300; }
allhdrs() { tr -d '\r' < "$TMP/$1.h" 2>/dev/null; }
dump_hdrs() { if [ "$VERBOSE" = "1" ]; then allhdrs "$1" | sed 's/^/      | /'; fi; }

printf 'EdgeOne 接入验证  |  模式=%s  |  域名=%s  |  时间=%s\n' "$MODE" "$D" "$(date '+%Y-%m-%d %H:%M:%S %z')"
[ "$MODE" = "pre" ] && printf '直连目标(EO CNAME)=%s\n' "$EO"

# ---------- 0. 环境检查 ----------
section '0. 执行环境'
if [ -n "${HTTP_PROXY:-}${HTTPS_PROXY:-}${http_proxy:-}${https_proxy:-}" ]; then
  warn "检测到 HTTP(S)_PROXY 环境变量；脚本已强制 --noproxy '*' 绕过。"
  warn "若结果异常，请在无代理的干净终端重跑（代理会让 --connect-to 失效）。"
else
  pass '未检测到 HTTP 代理环境变量'
fi
if ! curl --version | grep -qE 'curl [8-9]\.|curl 7\.(6[2-9]|[7-9][0-9])'; then
  warn "curl 版本较旧，--connect-to / %{remote_ip} 可能不可用：$(curl --version | head -1)"
else
  pass "curl 支持所需参数：$(curl --version | head -1 | cut -c1-60)"
fi
if [ "$MODE" = "post" ]; then
  CN="$(dig +short CNAME "$D" 2>/dev/null | head -1)"
  info "当前 $D 的 CNAME = ${CN:-（未解析到 CNAME，可能已是 A 记录或未生效）}"
  case "$CN" in
    *pages.dev*) warn "CNAME 仍指向 Cloudflare，DNS 切换可能尚未生效" ;;
    *eo*) pass "CNAME 已指向 EdgeOne" ;;
  esac
fi

# ---------- 1. 页面与接口 ----------
section '1. 页面与接口可用性（不缓存）'
req /login login
C="$(code login)"; info "/login -> HTTP $C | $(timing login)s | remote=$(remote login)"
dump_hdrs login
if [ "$C" = "200" ]; then pass '/login 返回 200'; else fail "/login 返回 $C"; fi
CC="$(hdr login cache-control)"
info "/login cache-control = ${CC:-（无）}"
case "$CC" in *no-store*|*no-cache*) pass '/login 未被误设为长缓存' ;;
  *31536000*) fail '/login 被静态长缓存规则误伤（严重）' ;;
  *) warn '/login 没有明确的 no-store，请确认规则 B' ;; esac

req /api/setup setup
C="$(code setup)"; B="$(body setup)"; info "/api/setup -> HTTP $C | $B"
dump_hdrs setup
if [ "$C" = "200" ] && printf '%s' "$B" | grep -q '"initialized"[[:space:]]*:[[:space:]]*true'; then
  pass '/api/setup 返回 {"initialized":true}'
else
  fail "/api/setup 不符合预期（HTTP $C / $B）"
fi
CC="$(hdr setup cache-control)"; info "/api/setup cache-control = ${CC:-（无）}"
case "$CC" in *no-store*|*no-cache*) pass '/api/setup 未被缓存' ;;
  *31536000*|*max-age=[1-9]*) fail '/api/setup 被缓存（严重：可能导致登录态串号）' ;;
  *) warn '/api/setup 没有明确的 no-store，请确认规则 B' ;; esac

req /api/auth/status auth
C="$(code auth)"; B="$(body auth)"; info "/api/auth/status -> HTTP $C | $B"
dump_hdrs auth
if [ "$C" = "200" ] && printf '%s' "$B" | grep -q '"authenticated"[[:space:]]*:[[:space:]]*false'; then
  pass '/api/auth/status 返回未登录态'
else
  fail "/api/auth/status 不符合预期（HTTP $C / $B）"
fi

# /api/* 绝不能出现缓存命中迹象（头名不硬编码，宽松匹配）
section '2. 接口防缓存检查（最高优先级）'
CACHE_SIG="$(allhdrs auth | grep -iE '^(age|x-cache|eo-cache|x-nws|cf-cache-status|x-cache-lookup|x-via|x-hit|cache-status)' | tr '\n' ' ')"
if [ -z "$CACHE_SIG" ]; then
  pass '/api/auth/status 无任何缓存相关响应头'
else
  info "/api/* 缓存相关头：$CACHE_SIG"
  if printf '%s' "$CACHE_SIG" | grep -qiE 'hit|age:[[:space:]]*[1-9]'; then
    fail '/api/* 疑似被缓存命中（严重：立即回滚或修规则顺序）'
  else
    pass '/api/* 出现缓存相关头但未见命中迹象（建议人工确认）'
  fi
fi

# ---------- 3. 静态资源长缓存 ----------
section '3. 静态资源长缓存（规则 A）'
JS="$(grep -oE '/assets/[A-Za-z0-9._-]+\.js\?v=[A-Za-z0-9]+' "$TMP/login.b" 2>/dev/null | head -1)"
if [ -z "$JS" ]; then
  JS="$(grep -oE '/assets/[A-Za-z0-9._?-]+\.(js|css)' "$TMP/login.b" 2>/dev/null | head -1)"
fi
if [ -z "$JS" ]; then
  fail '未能从 /login 页面提取 /assets/ 资源路径（页面结构可能变化）'
else
  info "提取到静态资源：$JS"
  req "$JS" asset1
  C1="$(code asset1)"; info "第 1 次 -> HTTP $C1 | $(timing asset1)s"
  dump_hdrs asset1
  req "$JS" asset2
  C2="$(code asset2)"; info "第 2 次 -> HTTP $C2 | $(timing asset2)s"
  dump_hdrs asset2
  [ "$C1" = "200" ] && [ "$C2" = "200" ] && pass '静态资源两次请求均为 200' || fail "静态资源状态码 $C1 / $C2"
  CC="$(hdr asset1 cache-control)"; info "cache-control = ${CC:-（无）}"
  case "$CC" in
    *31536000*immutable*|*immutable*31536000*) pass '静态资源带 max-age=31536000, immutable' ;;
    *31536000*) pass '静态资源带长缓存 max-age=31536000' ;;
    *) fail "静态资源缺少长缓存头（${CC:-无}）" ;;
  esac

  # 缓存命中：头名不硬编码（EdgeOne 各版本可能是 eo-cache-status / x-nws-log-uuid / x-cache / Age 等）
  SIG1="$(allhdrs asset1 | grep -iE '^(age|x-cache|eo-|x-nws|cf-cache-status|x-cache-lookup|cache-status|x-via)' | tr '\n' ' ')"
  SIG2="$(allhdrs asset2 | grep -iE '^(age|x-cache|eo-|x-nws|cf-cache-status|x-cache-lookup|cache-status|x-via)' | tr '\n' ' ')"
  info "第 1 次缓存相关头：${SIG1:-（无）}"
  info "第 2 次缓存相关头：${SIG2:-（无）}"
  if printf '%s' "$SIG2" | grep -qiE 'hit|age:[[:space:]]*[1-9]'; then
    pass '第 2 次请求出现缓存命中迹象'
  else
    # 不判 FAIL：头名因区域/版本而异，且首次预热后可能需几秒
    warn '未识别到明确的 HIT 标记 —— 不等同于缓存失败；请对照上面两次响应头人工确认'
    info '判定缓存是否生效以 cache-control + 两次 Age/命中头对比为准，不要依赖某个固定头名'
    sleep 2
    req "$JS" asset3
    SIG3="$(allhdrs asset3 | grep -iE '^(age|x-cache|eo-|x-nws|cf-cache-status|x-cache-lookup|cache-status)' | tr '\n' ' ')"
    info "第 3 次（隔 2s）缓存相关头：${SIG3:-（无）}"
    if printf '%s' "$SIG3" | grep -qiE 'hit|age:[[:space:]]*[1-9]'; then
      pass '第 3 次出现缓存命中迹象'
    elif [ "$MODE" = "baseline" ]; then
      info 'baseline 直连 Cloudflare，本就不经过 EdgeOne，无命中头属正常；此处仅作基线'
    else
      warn '第 3 次仍未见命中标记，请在 EdgeOne 控制台查缓存命中率'
    fi
  fi
  # 保留查询字符串检查：带 ?v= 的资源不能被剥成无参数版本
  printf '%s' "$JS" | grep -q '?v=' && pass '静态资源 URL 带 ?v= 版本参数（规则 A 的缓存键需保留查询字符串）' || warn '该资源未带版本参数'
fi

# ---------- 4. EdgeOne 平台痕迹 ----------
section '4. EdgeOne 平台痕迹（仅记录，不作硬门槛）'
PLAT="$(allhdrs login | grep -iE '^(eo-|x-nws|x-edgeone|x-tencent|via|server|x-cache)' | tr '\n' ' ')"
info "/login 平台类响应头：${PLAT:-（无 —— 请确认请求确实经过 EdgeOne）}"
if [ "$MODE" = "post" ] && [ -z "$PLAT" ]; then
  warn '切换后仍未看到任何 EdgeOne/平台响应头，需确认 DNS 已生效'
fi

# ---------- 5. /cdn-cgi/trace ----------
section '5. /cdn-cgi/trace（仅记录，不作判定）'
req /cdn-cgi/trace trace
T="$(tr -d '\r' < "$TMP/trace.b" 2>/dev/null | grep -E '^(colo|loc|ip)=' | tr '\n' ' ')"
info "trace: ${T:-（未取到）}"
info '说明：该端点属于 Cloudflare，colo 反映的是 CF 看到的「回源来源」机房，'
info '      不等于用户命中的 EdgeOne 节点，因此不能用「期望 HKG / 不应 LAX」来做通过判定。'
info '      判断加速是否生效请看 EdgeOne 响应头、国内真机延迟对比、以及 ip= 是否变为 EdgeOne 回源段。'

# ---------- 6. 错误码归因 ----------
section '6. 错误码归因提示'
for t in login setup auth asset1; do
  C="$(code "$t" 2>/dev/null)"
  case "$C" in
    403|404|421) fail "$t 返回 $C —— 依次排查：回源 HOST/SNI 是否 $D、回源协议是否 HTTPS 443、是否误开 JS 挑战/CC 拦截、证书是否绑定" ;;
    525|526)     fail "$t 返回 $C —— TLS 握手/证书失败，检查加速域名证书是否已生效" ;;
    000)         fail "$t 连接失败：$(head -c 120 "$TMP/$t.err" 2>/dev/null)" ;;
    5[0-9][0-9]) fail "$t 返回 $C —— 源站或回源异常" ;;
  esac
done
if [ "$MODE" = "pre" ]; then
  R="$(remote login)"
  case "$R" in
    127.0.0.1|198.18.*|198.19.*|10.*|192.168.*) warn "remote_ip=$R 疑似代理/透明转发，本次 pre 结果仅供参考，请在干净终端重跑" ;;
    *) pass "remote_ip=$R（连接已指向 EdgeOne 节点）" ;;
  esac
fi

# ---------- 汇总 ----------
printf '\n\033[1m== 汇总 ==\033[0m\n'
printf '  PASS=%d  FAIL=%d  INFO/WARN=%d  (模式=%s)\n' "$PASS" "$FAIL" "$INFO" "$MODE"
if [ "$FAIL" -gt 0 ]; then
  printf '  \033[31m结论：未通过。%s\033[0m\n' \
    "$( [ "$MODE" = "pre" ] && echo '不要切换 DNS，修正后重跑；若已切换请按文档 §11 判断是否需要回滚。' || echo '请按文档 §11 判断是否立即回滚。')"
  printf '  排查补充：若回源 HOST/SNI/协议/证书均正确，去 Cloudflare Pages 检查 %s 自定义域是否仍为 Active（证书续期风险）。\n' "$D"
  exit 1
else
  printf '  \033[32m结论：全部必须项通过。\033[0m\n'
  [ "$MODE" = "pre" ] && printf '  下一步可按文档第 7 步切换 DNS（前提：§0.2 决策门已通过）。\n'
  [ "$MODE" = "post" ] && printf '  仍需人工完成：国内手机登录 / 写入 / 导出测试与晚高峰速度对比。\n'
  exit 0
fi
