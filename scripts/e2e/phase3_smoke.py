#!/usr/bin/env python3
"""第三期整合（#7 + #8）五角色 × 双视口（1280×800 / iPhone 13）真实浏览器冒烟脚本。

用法：python3 scripts/e2e/phase3_smoke.py
依赖本机已运行 `npm run build`，自动以 TEST_BUNDLE=1 启动内存预览服务、灌入虚构数据并退出时清理。
"""
import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
PORT = int(os.environ.get("PHASE3_SMOKE_PORT", "4188"))
BASE = f"http://localhost:{PORT}"
CHROME = os.environ.get("CHROME_PATH", "/usr/bin/google-chrome")


def http_json(path, method="GET", body=None, cookie=None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {"Origin": BASE}
    if data is not None:
        headers["Content-Type"] = "application/json"
    if cookie:
        headers["Cookie"] = cookie
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            cookies = resp.headers.get_all("Set-Cookie") or []
            parsed = json.loads(raw) if raw.startswith("{") or raw.startswith("[") else raw
            return resp.status, parsed, "; ".join(c.split(";")[0] for c in cookies)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        return e.code, raw, ""


def wait_ready(timeout=25):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            st, _, _ = http_json("/api/public/brand?lite=1")
            if st == 200:
                return
        except Exception:
            pass
        time.sleep(0.3)
    raise RuntimeError("预览服务未能在预期时间内启动")


def seed_and_create_accounts():
    env = {**os.environ, "PREVIEW_URL": BASE}
    subprocess.run(["node", "scripts/preview-seed.mjs"], cwd=ROOT, env=env, check=True)
    st, _, sup_cookie = http_json(
        "/api/auth/login", "POST", {"phone": "13911112222", "password": "PreviewSecure9Z"}
    )
    assert st == 200, f"主管登录失败: {st}"

    st, teachers, _ = http_json("/api/data/teachers", "GET", cookie=sup_cookie)
    assert st == 200 and teachers["items"], f"获取老师失败: {st}"
    teacher_id = teachers["items"][0]["id"]

    def make_account(name, phone, roles, final_pw, teacher_id_val=None):
        payload = {"name": name, "phone": phone, "roles": roles}
        if teacher_id_val:
            payload["teacher_id"] = teacher_id_val
        st, created, _ = http_json("/api/accounts", "POST", payload, cookie=sup_cookie)
        assert st == 201, f"创建账号 {name} 失败: {st} {created}"
        tmp_pw = created["temporary_password"]
        st, _, tmp_cookie = http_json(
            "/api/auth/login", "POST", {"phone": phone, "password": tmp_pw}
        )
        assert st == 200, f"临时密码登录 {name} 失败: {st}"
        st, changed, _ = http_json(
            "/api/auth/password",
            "POST",
            {"current_password": tmp_pw, "new_password": final_pw},
            cookie=tmp_cookie,
        )
        if st != 200:
            st, changed, _ = http_json(
                "/api/password",
                "POST",
                {"old_password": tmp_pw, "password": final_pw},
                cookie=tmp_cookie,
            )
        assert st == 200, f"改密 {name} 失败: {st} {changed}"

    make_account("冒烟教务", "13700000002", ["academic"], "AcademicPreview9Z")
    make_account("冒烟财务", "13700000003", ["finance"], "FinancePreview9Z")
    make_account("冒烟老师", "13700000001", ["teacher"], "TeacherPreview9Z", teacher_id)
    return sup_cookie


def login_ui(page, phone, password):
    page.goto(BASE + "/login", wait_until="networkidle")
    # 兼容不同输入框选择器（手机号 + 密码）
    phone_in = page.locator("input[type='tel'], input[name='phone'], input[placeholder*='手机']").first
    pw_in = page.locator("input[type='password']").first
    phone_in.fill(phone)
    pw_in.fill(password)
    page.locator("button[type='submit'], button:has-text('登录')").first.click()
    page.wait_for_url("**/app**", timeout=15000)
    page.wait_for_timeout(1200)


def goto_hash(page, h, wait_ms=900):
    page.evaluate("(h) => { location.hash = h; }", h)
    page.wait_for_timeout(wait_ms)


def check_overflow(page):
    return page.evaluate(
        "() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth })"
    )


def run_role(browser, role_name, phone, password, viewport_name, vp_opts, routes, extra_fn=None):
    ctx = browser.new_context(**vp_opts)
    page = ctx.new_page()
    page_errors = []
    console_errors = []
    http_errors = []
    page.on("pageerror", lambda err: page_errors.append(str(err)))
    page.on(
        "console",
        lambda msg: console_errors.append({"text": msg.text, "url": (msg.location or {}).get("url", "")})
        if msg.type == "error"
        else None,
    )
    page.on(
        "response",
        lambda resp: http_errors.append(f"{resp.status} {resp.url}") if resp.status >= 400 else None,
    )
    route_results = []
    extra_results = {}
    try:
        login_ui(page, phone, password)
        for r in routes:
            goto_hash(page, r, 900)
            ov = check_overflow(page)
            txt_len = page.evaluate("() => (document.body.innerText || '').trim().length")
            route_results.append(
                {
                    "route": r,
                    "actual_hash": page.evaluate("() => location.hash"),
                    "text_len": txt_len,
                    "overflow_px": ov["overflow"],
                }
            )
        if extra_fn:
            extra_results = extra_fn(page)
    finally:
        ctx.close()
    http_5xx = [e for e in http_errors if e.startswith("5")]
    real_console = [
        c for c in console_errors
        if "/favicon.ico" not in c.get("url", "")
    ]
    return {
        "role": role_name,
        "viewport": viewport_name,
        "routes": route_results,
        "extra": extra_results,
        "page_errors": page_errors,
        "console_errors": real_console,
        "http_errors": http_errors,
        "http_5xx": http_5xx,
        "ok": not page_errors and not real_console and not http_5xx,
    }


def supervisor_desktop_extra(page):
    out = {}
    # 1. 学员页手机尾号搜索 0008
    goto_hash(page, "#students", 1000)
    search = page.locator("input[placeholder*='手机尾号']").first
    search.fill("0008")
    page.wait_for_timeout(1000)
    out["student_phone_search_0008_count"] = page.locator(".fq-st-row, .fq-st-item, [data-student-id]").count()
    search.fill("")
    page.wait_for_timeout(600)

    # 2. 课表页周/日视图切换
    goto_hash(page, "#schedule-week", 1000)
    out["schedule_rendered"] = page.locator(".fq-sc-cal, .fq-sc-bar").count() > 0
    day_btn = page.locator(".fq-sc-bar button:has-text('日')").first
    if day_btn.count():
        day_btn.click()
        page.wait_for_timeout(700)
        out["schedule_day_switch"] = True
    else:
        out["schedule_day_switch"] = False

    # 3. 线索页（#enrol-leads）打开详情并提交一条真实回访记录
    goto_hash(page, "#enrol-leads", 1000)
    out["leads_rendered"] = page.locator(".fq-ld-page, .fq-ld-board").count() > 0
    card = page.locator(".fq-ld-lead").first
    if card.count():
        card.click()
        page.wait_for_timeout(900)
        ta = page.locator(".ui-sheet textarea, textarea[placeholder*='回访'], textarea[placeholder*='沟通']").first
        if not ta.count():
            open_fu = page.locator(".ui-sheet button:has-text('记录回访')").first
            if open_fu.count():
                open_fu.click()
                page.wait_for_timeout(500)
                ta = page.locator(".ui-sheet textarea").first
        if ta.count():
            ta.fill("冒烟测试回访：家长确认周六试听")
            save_btn = page.locator(".ui-sheet button:has-text('保存回访'), .ui-sheet button:has-text('保存'), .ui-sheet button[type='submit']").first
            if save_btn.count():
                save_btn.click()
                page.wait_for_timeout(1000)
                out["lead_followup_saved"] = "冒烟测试回访" in page.inner_text("body")
            else:
                out["lead_followup_saved"] = "no_submit_btn"
        else:
            out["lead_followup_saved"] = "no_textarea"
        page.keyboard.press("Escape")
        page.wait_for_timeout(400)
    else:
        out["lead_followup_saved"] = "no_card"

    # 4. 老师页（#settings-teachers）渲染与详情课酬卡
    goto_hash(page, "#settings-teachers", 1000)
    out["teachers_rendered"] = page.locator(".fq-tp-page, .fq-tp-split").count() > 0

    # 5. 设置页旧路由验证 + 编辑机构信息（验证 P1 密文修复端到端生效）
    old_map = {}
    for old_h in ["#settings-institution", "#settings-logs", "#settings-accounts", "#admin-courses"]:
        goto_hash(page, old_h, 800)
        old_map[old_h] = {
            "hash": page.evaluate("() => location.hash"),
            "has_fq_se": page.locator(".fq-se, .fq-se-host").count() > 0,
        }
    out["old_routes"] = old_map

    # 编辑机构名称和联系说明并保存，随后请求 /api/renewal-brand 验证 200 解密
    goto_hash(page, "#settings-institution", 1000)
    edit_btn = page.locator(".fq-se-main button:has-text('编辑')").first
    assert edit_btn.count() > 0, "主管在机构信息卡片未看到编辑按钮"
    edit_btn.click()
    page.wait_for_timeout(600)
    page.locator("input[name='name']").fill("枫琴冒烟校验机构")
    page.locator("input[name='contact_text']").fill("冒烟教务微信：fq_smoke_88")
    page.locator(".ui-sheet button:has-text('保存')").first.click()
    page.wait_for_timeout(1200)
    out["inst_saved_text_visible"] = "枫琴冒烟校验机构" in page.inner_text("body") and "fq_smoke_88" in page.inner_text("body")
    rb = page.evaluate(
        "async () => { const r = await fetch('/api/renewal-brand'); return { status: r.status, body: await r.json() }; }"
    )
    out["renewal_brand_after_edit"] = rb
    assert rb["status"] == 200 and rb["body"].get("contact_text") == "冒烟教务微信：fq_smoke_88", f"renewal-brand 解密失败: {rb}"
    return out


def supervisor_phone_extra(page):
    out = {}
    # 决定 4：手机端学员页不出导出按钮
    goto_hash(page, "#students", 1000)
    out["phone_students_no_export"] = page.locator("button:has-text('导出 Excel')").count() == 0
    # 决定 10：手机端线索页只显示列表，不显示看板列
    goto_hash(page, "#enrol-leads", 1000)
    out["phone_leads_rendered"] = page.locator(".fq-ld-page").count() > 0 and page.locator(".fq-ld-board").count() == 0
    # 决定 11：手机端老师页不出新建老师按钮
    goto_hash(page, "#settings-teachers", 1000)
    out["phone_teachers_no_create"] = page.locator("button:has-text('新建老师')").count() == 0
    # 决定 16：手机端数据与备份导入只读提示
    goto_hash(page, "#settings-import", 900)
    out["phone_import_readonly"] = "电脑" in page.inner_text("body")
    # 旧路由在手机端可用
    goto_hash(page, "#settings-institution", 900)
    out["phone_old_inst_ok"] = "枫琴冒烟校验机构" in page.inner_text("body")
    return out


def academic_extra(page):
    goto_hash(page, "#settings-institution", 900)
    body = page.inner_text("body")
    return {
        "academic_inst_readonly": "只有机构主管可以修改" in body and page.locator(".fq-se-main button:has-text('编辑')").count() == 0,
    }


def main():
    env = {**os.environ, "TEST_BUNDLE": "1", "PREVIEW_PORT": str(PORT)}
    proc = subprocess.Popen(
        ["node", "scripts/dev.mjs"],
        cwd=ROOT,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    results = []
    try:
        wait_ready()
        seed_and_create_accounts()
        desktop_vp = {"viewport": {"width": 1280, "height": 800}}
        iphone_vp = {
            "viewport": {"width": 390, "height": 844},
            "is_mobile": True,
            "has_touch": True,
            "device_scale_factor": 3,
        }
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=CHROME, headless=True)
            try:
                sup_routes = ["#today", "#todo-unchecked", "#schedule-week", "#students", "#enrol-leads", "#finance-overview", "#settings-teachers", "#teachers-rates", "#settings-overview", "#settings-accounts", "#settings-institution", "#settings-courses", "#settings-rules", "#settings-ai", "#settings-data", "#settings-logs"]
                sup_phone_routes = ["#today", "#todo-unchecked", "#schedule-week", "#students", "#enrol-leads", "#finance-overview", "#settings-teachers", "#settings-overview", "#settings-accounts", "#settings-institution", "#settings-courses", "#settings-data", "#settings-logs"]
                acad_routes = ["#today", "#todo-unchecked", "#schedule-week", "#students", "#enrol-leads", "#settings-teachers", "#settings-overview", "#settings-institution", "#settings-courses", "#admin-courses"]
                acad_phone_routes = ["#today", "#schedule-week", "#students", "#enrol-leads", "#settings-teachers", "#settings-overview", "#settings-institution", "#settings-courses"]
                fin_routes = ["#today", "#finance-overview", "#students", "#settings-overview", "#settings-logs"]
                teacher_routes = ["#today", "#schedule"]
                student_routes = ["#today", "#schedule"]

                results.append(run_role(browser, "supervisor", "13911112222", "PreviewSecure9Z", "1280x800", desktop_vp, sup_routes, supervisor_desktop_extra))
                results.append(run_role(browser, "supervisor", "13911112222", "PreviewSecure9Z", "iPhone13(390x844)", iphone_vp, sup_phone_routes, supervisor_phone_extra))
                results.append(run_role(browser, "academic", "13700000002", "AcademicPreview9Z", "1280x800", desktop_vp, acad_routes, academic_extra))
                results.append(run_role(browser, "academic", "13700000002", "AcademicPreview9Z", "iPhone13(390x844)", iphone_vp, acad_phone_routes, academic_extra))
                results.append(run_role(browser, "finance", "13700000003", "FinancePreview9Z", "1280x800", desktop_vp, fin_routes))
                results.append(run_role(browser, "finance", "13700000003", "FinancePreview9Z", "iPhone13(390x844)", iphone_vp, fin_routes))
                results.append(run_role(browser, "teacher", "13700000001", "TeacherPreview9Z", "1280x800", desktop_vp, teacher_routes))
                results.append(run_role(browser, "teacher", "13700000001", "TeacherPreview9Z", "iPhone13(390x844)", iphone_vp, teacher_routes))
                results.append(run_role(browser, "student", "13800000008", "StudentPreview9Z", "1280x800", desktop_vp, student_routes))
                results.append(run_role(browser, "student", "13800000008", "StudentPreview9Z", "iPhone13(390x844)", iphone_vp, student_routes))
            finally:
                browser.close()
    finally:
        proc.send_signal(signal.SIGINT)
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()

    print(json.dumps(results, ensure_ascii=False, indent=2))
    failed = [r for r in results if not r["ok"]]
    if failed:
        print(f"\nFAILED RUNS: {len(failed)}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
