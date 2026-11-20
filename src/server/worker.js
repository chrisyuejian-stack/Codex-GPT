import {todoActionsApi,todoActionsPath} from './todo-actions.js';
import {todoInboxApi,todoInboxPath} from './todo-inbox.js';
import {fullBackupApi,fullBackupPath} from './full-backup.js';
import { feedbackPath, feedbackApi } from "./feedback.js";
import { aiPath, aiApi } from "./ai.js";

import { toolSettingsPath, toolSettingsApi } from "./tool-settings.js";
import { identityErrorCode, identityLabels } from "./identity.js";
import { phoneIndex } from "./crypto.js";

import { maxDebtUnits } from "./debt.js";
import { apiTiming, measureDatabase } from "./request-timing.js";
import { rebuild3Api } from "./rebuild3.js";
import { rebuildApi } from "./rebuild.js";

import { readBatch } from "./read-batch.js";

import { importsApi, IMPORT_HEADERS } from "./imports.js";

import { toolsApi, LEAD_STAGES } from "./tools.js";
import { reviewApi, timetableApi } from "./reviews.js";
import {
  MODULE_LABELS,
  ACTION_LABELS,
  LESSON_LABELS,
  ATTENDANCE_LABELS,
  REVIEW_LABELS,
  AUTH_EVENT_LABELS,
  RATE_UNITS,
  beijingTime,
} from "./presentation.js";
import { effectivePolicies } from "./absence.js";
import { financeApi } from "./finance.js";
import { moneyOut, quantityIn } from "./numbers.js";
import { creditApi } from "./credits.js";
import {
  businessApi,
  addStudentSummaries,
  day,
  generateTemplates,
  scheduleView,
  fixedRulesView,
  reorderBusiness,
} from "./scheduling.js";
import {
  config,
  secureResponse,
  neutral404,
  json,
  body,
  fail,
  HttpError,
  string,
  integer,
  version,
  now,
} from "./core.js";
import { repo } from "./repo.js";
import { fixedTenant } from "./tenant.js";
import { setupApi } from "./setup.js";
import { aiSettingsApi } from "./ai-settings.js";
import {
  authenticate,
  loginTenant,
  clearCookie,
  changeTenantPassword,
} from "./auth.js";
import { modules, can, publicUser, projectRecord } from "./permissions.js";
import {
  requireCan,
  rolesInput,
  createAccount,
  resetAccount,
} from "./accounts.js";
import { encrypt, decrypt } from "./crypto.js";
import { randomId } from "./core.js";
const staticTenant = new Set([
  "/assets/tenant.js",
  "/assets/tenant.css",
  "/assets/tenant-fonts.css",
]);

const offsetOf = (url) => {
  const n = Number(url.searchParams.get("offset") || 0);
  return integer(n, "分页", 0, 1000000);
};
const idPattern = /^[a-z]+_[a-f0-9]{24}$/;
function recordId(x) {
  if (!idPattern.test(x)) fail(404, "不存在");
  return x;
}

async function serve(env, req, path, replacements = {}) {
  const response = await env.ASSETS.fetch(
    new Request(new URL(path, req.url), { method: "GET" }),
  );
  if (!response.ok) return neutral404();
  if (Object.keys(replacements).length) {
    let html = await response.text();
    for (const [k, v] of Object.entries(replacements))
      html = html.replaceAll(k, v);
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  return response;
}
async function serveStatic(env, req, url) {
  const response = await serve(env, req, url.pathname);
  if (response.ok) {
    const versions = url.searchParams.getAll("v");
    env.__cacheControl =
      versions.length === 1 && /^[a-f0-9]{8,64}$/.test(versions[0])
        ? "public, max-age=31536000, immutable"
        : "no-cache";
  }
  return response;
}

const tenantAuthenticatedApi = (path) =>
  fullBackupPath(path) || todoInboxPath(path) || todoActionsPath(path) ||
  toolSettingsPath(path) ||
  aiPath(path) ||
  feedbackPath(path) ||
  ["/api/read-batch", "/api/schedule-templates", "/api/settings/ai"].includes(
    path,
  ) ||
  /^\/api\/c[23]\//.test(path) ||
  /^\/api\/students\/[^/]+\/fixed-rules$/.test(path) ||
  [
    "/api/imports/template",
    "/api/imports/preview",
    "/api/imports/commit",
  ].includes(path) ||
  /^\/api\/tools\/[a-z_]+(?:\/[^/]+)?(?:\/(convert|contact|members))?$/.test(
    path,
  ) ||
  [
    "/api/finance/receivable-summary",
    "/api/search",
    "/api/todo/summary",
    "/api/workbench",
    "/api/renewals",
    "/api/renewals/remind",
    "/api/renewal-brand",
    "/api/renewal-settings",
    "/api/followup-assignees",
  ].includes(path) ||
  /^\/api\/lessons\/[^/]+\/(review|comments)$/.test(path) ||
  /^\/api\/submissions\/[^/]+\/(confirm|return)$/.test(path) ||
  ["/api/submissions", "/api/brand-timetable", "/api/schedule-next"].includes(
    path,
  ) ||
  /^\/api\/finance\/(rates|payments|adjustments|costs|tuition)(?:\/[^/]+)?$/.test(
    path,
  ) ||
  [
    "/api/finance/payroll",
    "/api/finance/report",
    "/api/finance/settlement",
    "/api/export",
  ].includes(path) ||
  /^\/api\/finance\/settlements\/(submit|approve|unlock|reject)$/.test(path) ||
  /^\/api\/finance\/lessons\/[^/]+\/rate$/.test(path) ||
  /^\/api\/credits\/(?:balance(?:\/(?:redeem|adjust))?|payments\/[^/]+\/(?:resolve|reverse))$/.test(
    path,
  ) ||
  /^\/api\/credits\/(packages|transactions|payments|stages|makeups)(?:\/[^/]+)?$/.test(
    path,
  ) ||
  /^\/api\/credits\/lessons\/[^/]+\/(attendance|status|undo|delete)$/.test(
    path,
  ) ||
  /^\/api\/credits\/makeups\/[^/]+\/unlink$/.test(path) ||
  [
    "/api/credits/transfer",
    "/api/credits/adjust",
    "/api/credits/makeups",
  ].includes(path) ||
  /^\/api\/data\/(students|teachers|course_categories|course_types|locations|student_schedule_blocks|schedule_templates|schedule_enrollments|lessons|packages)(?:\/[^/]+)?(?:\/contact)?$/.test(
    path,
  ) ||
  path === "/api/templates/generate" ||
  path === "/api/schedule" ||
  path === "/api/reorder" ||
  path === "/api/absence-policies" ||
  path === "/api/me" ||
  path === "/api/logout" ||
  path === "/api/password" ||
  path === "/api/accounts" ||
  path === "/api/rights" ||
  path === "/api/settings" ||
  path === "/api/logs" ||
  /^\/api\/accounts\/[^/]+(?:\/(reset-password|phone|sessions)(?:\/[^/]+)?)?$/.test(
    path,
  ) ||
  path === "/api/sessions" ||
  /^\/api\/sessions\/[^/]+$/.test(path);

const tenantHtmlRoutes = new Set([
  "/",
  "/login",
  "/app",
  "/app/",
  "/app/accounts",
  "/app/profile",
  "/app/logs",
  "/app/students",
  "/app/teachers",
  "/app/schedule",
  "/app/templates",
  "/app/settings",
]);

async function tenantApi(req, env, resolved, url, context) {
  const { tenant: t, base, relative: path } = resolved,
    r = repo(env, t.id);
  env.__identityContract = true;
  env.__identityStatus = path === "/api/auth/status";

  if (
    ["/api/public/brand/login-bg", "/api/public/brand/logo"].includes(path) &&
    req.method === "GET"
  ) {
    const version = url.searchParams.get("v");
    if (!/^[1-9][0-9]{0,14}$/.test(version || "")) return neutral404();
    const row = await r.brandImage(
      path.endsWith("/logo") ? "logo" : "login_bg",
      Number(version),
    );
    if (!row?.image) return neutral404();
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(
      row.image,
    );
    if (!match) return neutral404();
    let bytes;
    try {
      bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0));
    } catch {
      return neutral404();
    }
    env.__cacheControl = "public, max-age=31536000, immutable";
    return new Response(bytes, {
      headers: { "Content-Type": "image/" + match[1] },
    });
  }
  if (path === "/api/public/brand" && req.method === "GET") {
    if (url.searchParams.get("lite") === "1") {
      const b = await r.brandLite();
      env.__cacheControl = "private, max-age=60";
      return json({
        display_name: b.display_name,
        theme_color: b.theme_color,
        welcome_text: b.welcome_text,
        logo: b.has_logo ? base + "api/public/brand/logo?v=" + b.version : null,
        login_bg_url: b.has_bg
          ? base + "api/public/brand/login-bg?v=" + b.version
          : null,
      });
    }
    const b = await r.brand();
    env.__cacheControl = "private, max-age=60";
    return json({
      display_name: b.display_name,
      logo: b.logo,
      login_bg: b.login_bg,
      theme_color: b.theme_color,
      welcome_text: b.welcome_text,
    });
  }
  if (path === "/api/public/theme.css" && req.method === "GET") {
    const b = await r.brand();
    const color = /^#[a-f0-9]{6}$/i.test(b.theme_color)
      ? b.theme_color
      : "#2B4C7E";
    return new Response(":root { --theme: " + color + "; }", {
      headers: { "Content-Type": "text/css; charset=utf-8" },
    });
  }
  if (["/api/login", "/api/auth/login"].includes(path) && req.method === "POST")
    return loginTenant(req, env, t, base, await body(req));
  if (!tenantAuthenticatedApi(path)) return neutral404();
  let user = context?.user ?? (await authenticate(req, env, t, base, resolved));
  const policy = context?.policy ?? (await r.policy());
  if (
    user.roles.includes("student") &&
    !["GET", "HEAD"].includes(req.method) &&
    !(
      ["/api/logout", "/api/password", "/api/read-batch"].includes(path) &&
      req.method === "POST"
    ) &&
    !(req.method === "DELETE" && /^\/api\/sessions\/[^/]+$/.test(path))
  )
    fail(403, "学员账号仅可读取教务数据", "forbidden");
  if (
    user.must_change &&
    !["/api/me", "/api/password", "/api/logout", "/api/auth/status"].includes(
      path,
    )
  )
    fail(403, "请先修改初始密码", "PASSWORD_CHANGE_REQUIRED");

  const actionResult=await todoActionsApi(req,env,resolved,user,policy,url);
  if(actionResult!==undefined)return actionResult;
  const inboxResult=await todoInboxApi(req,env,resolved,user,policy,url);
  if(inboxResult!==undefined)return inboxResult;
  const backupResult=await fullBackupApi(req,env,resolved,user);
  if(backupResult!==undefined)return backupResult;
  const aiSettings = await aiSettingsApi(req, env, resolved, user);
  if (aiSettings !== undefined) return aiSettings;
  const aiResult = await aiApi(req, env, resolved, user, policy, url);
  if (aiResult !== undefined) return aiResult;

  const growthResult = await feedbackApi(req, env, resolved, user, policy, url);
  if (growthResult !== undefined) return growthResult;

  const settingsResult = await toolSettingsApi(
    req,
    env,
    resolved,
    user,
    policy,
    url,
  );
  if (settingsResult !== undefined) return settingsResult;

  if (path === "/api/read-batch" && req.method === "POST")
    return readBatch(
      req,
      env,
      resolved,
      async (child, childUrl, childResolved) => {
        try {
          return await normalizeResponse(
            await tenantApi(child, env, childResolved, childUrl, {
              user,
              policy,
            }),
            env,
          );
        } catch (error) {
          return normalizeResponse(errorResponse(error, env, childUrl), env);
        }
      },
    );
  if (path === "/api/schedule-templates" && req.method === "GET") {
    const alias = "/api/data/schedule_templates";
    return tenantApi(req, env, { ...resolved, relative: alias }, url, {
      user,
      policy,
    });
  }
  if (path === "/api/schedule-next" && req.method === "GET") {
    const scope = { teacher_id: user.teacher_id, student_id: user.student_id };
    requireCan(user, policy, "schedule", "read", scope);
    const row = await r.nextLesson(
      user,
      now(),
      beijingTime(now()).slice(0, 10),
    );
    if (
      row &&
      !can(user, policy, "schedule", "read", {
        ...row,
        ...(user.roles.includes("student")
          ? { student_id: user.student_id }
          : {}),
      })
    )
      return json({ record: null });
    if (row) await addStudentSummaries(r, [row], user);
    return json({
      record: row
        ? Object.fromEntries(
            [
              "id",
              "start_at",
              "duration",
              "units",
              "mode",
              "status",
              "course_name",
              "teacher_name",
              "location_name",
              "participants_summary",
            ].map((k) => [k, row[k]]),
          )
        : null,
    });
  }
  if (path.startsWith("/api/c3/"))
    return json(await rebuild3Api(req, env, t, user, policy, path, url, body));
  if (/^\/api\/c[23]\//.test(path))
    return json(await rebuildApi(req, env, t, user, policy, path, url, body));

  if (path.startsWith("/api/imports/")) {
    const result = await importsApi(req, env, t, user, policy, path, url, body);
    return result instanceof Response ? result : json(result);
  }
  if (
    path.startsWith("/api/tools/") ||
    [
      "/api/finance/receivable-summary",
      "/api/search",
      "/api/todo/summary",
      "/api/workbench",
      "/api/renewals",
      "/api/renewals/remind",
      "/api/renewal-brand",
      "/api/renewal-settings",
      "/api/followup-assignees",
    ].includes(path)
  )
    return json(await toolsApi(req, env, t, user, policy, path, url, body));
  if (path.startsWith("/api/lessons/") || path.startsWith("/api/submissions"))
    return json(await reviewApi(req, env, t, user, policy, path, url, body));
  if (path === "/api/brand-timetable" && req.method === "GET")
    return json(await timetableApi(env, t, user, policy, url));
  if (path === "/api/reorder" && req.method === "PUT")
    return json(await reorderBusiness(env, t, user, policy, await body(req)));
  if (path === "/api/schedule" && req.method === "GET")
    return json(await scheduleView(env, t, user, policy, url));
  const fixedRules = /^\/api\/students\/([^/]+)\/fixed-rules$/.exec(path);
  if (fixedRules && req.method === "GET")
    return json(await fixedRulesView(env, t, user, policy, fixedRules[1]));
  if (path === "/api/absence-policies") {
    if (req.method === "GET") {
      requireCan(user, policy, "settings", "read");
      return json({
        policies: effectivePolicies(policy.settings),
      });
    }
    if (req.method === "PUT") {
      requireCan(user, policy, "settings", "configure_absence");
      const data = await body(req),
        policies = {};
      for (const key of [
        "student_leave",
        "student_no_show",
        "teacher_leave",
        "cancelled",
      ]) {
        if (
          typeof data.policies?.[key]?.deduct !== "boolean" ||
          typeof data.policies?.[key]?.teacherPaid !== "boolean"
        )
          fail(400, "规则格式不正确");
        policies[key] = {
          deduct: data.policies[key].deduct,
          teacherPaid: data.policies[key].teacherPaid,
        };
      }
      await r.saveSetting("absence_policies", policies, user);
      return json({ ok: true });
    }
  }
  if (path.startsWith("/api/finance/") || path === "/api/export") {
    const result = await financeApi(req, env, t, user, policy, path, url, body);
    return result instanceof Response ? result : json(result);
  }
  if (
    path.startsWith("/api/credits/") ||
    /^\/api\/data\/packages(?:\/[^/]+)?$/.test(path) ||
    (req.method === "DELETE" && /^\/api\/data\/lessons\/[^/]+$/.test(path))
  )
    return json(await creditApi(req, env, t, user, policy, path, url, body));
  if (path.startsWith("/api/data/"))
    return json(await businessApi(req, env, t, user, policy, path, url, body));
  if (path === "/api/templates/generate" && req.method === "POST")
    return json(
      await generateTemplates(req, env, t, user, policy, await body(req)),
    );
  if (path === "/api/me" && req.method === "GET") {
    return json({
      user: publicUser(user),
      labels: {
        import_headers: IMPORT_HEADERS,
        lead_stages: LEAD_STAGES,
        modules: MODULE_LABELS,
        actions: ACTION_LABELS,
        lessons: LESSON_LABELS,
        attendance: ATTENDANCE_LABELS,
        reviews: REVIEW_LABELS,
        events: AUTH_EVENT_LABELS,
        rate_units: RATE_UNITS,
      },
      tenant_id: t.id,
      api_base: resolved.root ? "/api" : base.replace(/\/$/, "") + "/api",

      module_labels: { ...MODULE_LABELS, ...identityLabels },
      policy: {
        ...policy,
        settings: {
          ...policy.settings,
          max_debt_units: maxDebtUnits(policy.settings),
        },
      },
      capabilities: Object.fromEntries(
        modules.map((module) => [
          module,
          Object.fromEntries(
            [
              "read",
              "write",
              "share",
              "publish",
              "unpublish",
              "manage",
              "use",
              "propose",
              "read_finance",
              "create",
              "update",
              "delete",
              "export",
              "approve",
              "adjust",
              "transfer",
              "submit",
              "unlock",
              "confirm",
              "return",
              "correct",
              "create_personal",
              "reset_personal",
              "reveal_phone",
            ].map((action) => [
              action,
              can(
                user,
                policy,
                module,
                action,
                module === "accounts" &&
                  ["create_personal", "reset_personal"].includes(action)
                  ? { roles: ["student"] }
                  : module === "profile"
                    ? user
                    : {
                        teacher_id: user.teacher_id,
                        student_id: user.student_id,
                      },
              ),
            ]),
          ),
        ]),
      ),
    });
  }
  if (path === "/api/logout" && req.method === "POST") {
    await body(req);
    await r.revokeSession(user.token_hash);
    return json({ ok: true }, 200, {
      "Set-Cookie": resolved.root ? clearCookie() : clearCookie(base),
    });
  }
  if (path === "/api/password" && req.method === "POST") {
    requireCan(user, policy, "profile", "read", user);
    await changeTenantPassword(env, t, user, await body(req));
    return json({ ok: true }, 200, {
      "Set-Cookie": resolved.root ? clearCookie() : clearCookie(base),
    });
  }
  if (path === "/api/accounts" && req.method === "GET") {
    requireCan(user, policy, "accounts", "read");
    const offset = offsetOf(url),
      [items, total] = await Promise.all([r.users(offset), r.userCount()]);
    return json({
      items: items.map(publicUser),
      total,
      next_offset: offset + 200 < total ? offset + 200 : null,
    });
  }
  if (path === "/api/accounts" && req.method === "POST") {
    return json(
      await createAccount(env, t, user, policy, await body(req)),
      201,
    );
  }
  if (path === "/api/rights" && req.method === "PUT") {
    requireCan(user, policy, "accounts", "manage_rights");
    const d = await body(req);
    const batch = Object.hasOwn(d, "changes");
    const changes = batch ? d.changes : [d];
    if (!Array.isArray(changes) || changes.length < 1 || changes.length > 100)
      fail(400, "每次保存须包含 1 至 100 项权限");
    const actions = [
      "read",
      "create",
      "update",
      "delete",
      "export",
      "approve",
      "create_personal",
      "rates_update",
      "adjust",
      "transfer",
      "submit",
    ];
    const unique = new Map();
    for (const change of changes) {
      if (
        !change ||
        typeof change !== "object" ||
        Array.isArray(change) ||
        !["academic", "finance"].includes(change.role) ||
        !modules.includes(change.module) ||
        change.module === "accounts" ||
        !actions.includes(change.action) ||
        typeof change.allowed !== "boolean"
      )
        fail(400, "权限配置不正确");
      const { role, module, action, allowed } = change;
      unique.set(role + ":" + module + ":" + action, {
        role,
        module,
        action,
        allowed,
      });
    }
    if (batch) await r.saveRightsBatch([...unique.values()], user);
    else await r.saveRights(d.role, d.module, d.action, d.allowed, user);
    return json({ ok: true });
  }
  if (path === "/api/settings" && req.method === "GET") {
    requireCan(user, policy, "settings", "read");
    return json({
      feedback_auto_confirm: false,
      teacher_can_publish_reports: false,
      ...policy.settings,
      max_debt_units: maxDebtUnits(policy.settings),
    });
  }
  if (path === "/api/settings" && req.method === "PUT") {
    requireCan(user, policy, "accounts", "manage_settings");
    const d = await body(req);
    if (d.key === "max_debt_units") {
      quantityIn(d.value, { zero: true });
    } else if (d.key === "default_schedule_view") {
      if (!["time", "teacher", "location", "list"].includes(d.value))
        fail(400, "课表视图不正确");
    } else if (
      ![
        "student_view_payments",
        "student_view_balance",
        "teacher_self_checkin",
        "teacher_view_student_balance",
        "academic_can_create_accounts",
        "academic_can_reset_accounts",
        "feedback_auto_confirm",
        "teacher_can_publish_reports",
      ].includes(d.key) ||
      typeof d.value !== "boolean"
    )
      fail(400, "设置格式不正确");
    if (
      ["feedback_auto_confirm", "teacher_can_publish_reports"].includes(
        d.key,
      ) &&
      !user.roles.includes("supervisor")
    )
      fail(403, "仅主管可修改", "forbidden");
    await r.saveSetting(d.key, d.value, user);
    return json({ ok: true });
  }
  if (path === "/api/logs" && req.method === "GET") {
    const full = can(user, policy, "logs", "read");
    if (!full) requireCan(user, policy, "logs", "read_finance");
    const from = url.searchParams.get("from") || "",
      to = url.searchParams.get("to") || "";
    if (from) day(from);
    if (to) day(to);
    if (from && to && from > to) fail(400, "开始日期不能晚于结束日期");
    const filters = {
      actor: string(url.searchParams.get("actor") || "", "操作人", 100, 0),
      module: string(url.searchParams.get("module") || "", "模块", 80, 0),
      action: string(url.searchParams.get("action") || "", "操作", 80, 0),
      from: from ? Date.parse(from + "T00:00:00+08:00") : 0,
      to: to ? Date.parse(to + "T00:00:00+08:00") + 86400000 : 8640000000000000,
    };
    const kind = url.searchParams.get("kind") === "login" ? "login" : "audit",
      offset = offsetOf(url),
      [items, total] = await Promise.all([
        r.logs(kind, offset, !full, filters),
        r.logs(kind, offset, !full, filters, true),
      ]);
    return json({
      total,
      next_offset: offset + 200 < total ? offset + 200 : null,
      items: items.map((row) => {
        const out = { ...row };
        for (const key of ["before_json", "after_json"]) {
          if (!out[key]) continue;
          try {
            out[key] = JSON.stringify(
              projectRecord(
                user,
                policy,
                row.module,
                row.money_version === 1
                  ? moneyOut(JSON.parse(out[key]))
                  : JSON.parse(out[key]),
              ),
            );
          } catch {
            out[key] = null;
          }
        }
        return out;
      }),
    });
  }
  if (path === "/api/sessions" && req.method === "GET") {
    requireCan(user, policy, "profile", "read", user);
    return json({ items: await r.sessions(user.id) });
  }
  if (path.startsWith("/api/sessions/") && req.method === "DELETE") {
    await body(req);
    requireCan(user, policy, "profile", "read", user);
    await r.revokeDevice(user.id, recordId(path.split("/").at(-1)), user);
    return json({ ok: true });
  }
  const m =
    /^\/api\/accounts\/([^/]+)(?:\/(reset-password|phone|sessions)(?:\/([^/]+))?)?$/.exec(
      path,
    );
  if (m) {
    if (m[2] === "reset-password" && req.method === "POST") {
      await body(req);
      return json(await resetAccount(env, t, user, recordId(m[1]), policy));
    }
    requireCan(user, policy, "accounts", "read");
    const target = await r.user(recordId(m[1]));
    if (!target) fail(404, "不存在");
    if (!m[2] && req.method === "GET")
      return json({ user: publicUser(target) });
    if (!m[2] && req.method === "PATCH") {
      requireCan(user, policy, "accounts", "update", target);
      const d = await body(req);
      const roles = rolesInput(d.roles);
      const previousRoles = JSON.parse(target.roles);
      if (
        roles.some((x) => ["teacher", "student"].includes(x)) ||
        previousRoles.some((x) => ["teacher", "student"].includes(x))
      ) {
        if (JSON.stringify(roles) !== target.roles)
          fail(400, "个人账号与员工角色不能互换");
        if (d.active) {
          const kind = roles[0] === "teacher" ? "teachers" : "students",
            profile = await r.businessGet(
              kind,
              roles[0] === "teacher" ? target.teacher_id : target.student_id,
            );
          if (!profile || profile.status !== "active")
            fail(400, "请先重新启用关联档案");
        }
      }
      if (typeof d.active !== "boolean") fail(400, "账号状态不正确");
      await r.updateUser(
        target.id,
        version(d.version),
        {
          name: string(d.name, "姓名", 50),
          roles: JSON.stringify(roles),
          active: d.active ? 1 : 0,
          ...(d.phone !== undefined
            ? {
                phone_hmac: await phoneIndex(env, t.id, d.phone),
                phone_enc: await encrypt(env, d.phone, t.id + ":phone"),
                phone_last4: d.phone.slice(-4),
              }
            : {}),
        },
        user,
      );
      return json({ ok: true });
    }
    if (m[2] === "phone" && req.method === "POST") {
      await body(req);
      requireCan(user, policy, "accounts", "reveal_phone", target);
      await r.audit(
        user,
        "accounts",
        "reveal_phone",
        target.id,
        "查看完整手机号",
      );
      return json({
        phone: await decrypt(env, target.phone_enc, t.id + ":phone"),
      });
    }
    if (m[2] === "sessions" && req.method === "GET")
      return json({ items: await r.sessions(target.id) });
    if (m[2] === "sessions" && m[3] && req.method === "DELETE") {
      await body(req);
      requireCan(user, policy, "accounts", "update");
      await r.revokeDevice(target.id, recordId(m[3]), user);
      return json({ ok: true });
    }
  }
  return neutral404();
}
async function dispatch(req, env, url) {
  if (url.hostname !== (env.APP_HOST || "edu.fantasmearts.com"))
    return neutral404();
  if (
    /^\/(?:console(?:-assets)?|src)(?:\/|$)/.test(url.pathname) ||
    url.pathname === "/_worker.js" ||
    url.pathname.endsWith(".map")
  )
    return neutral404();
  if (staticTenant.has(url.pathname) && ["GET", "HEAD"].includes(req.method))
    return serveStatic(env, req, url);
  if (
    ["GET", "HEAD"].includes(req.method) &&
    tenantHtmlRoutes.has(url.pathname)
  ) {
    if (url.pathname === "/")
      return new Response(null, {
        status: 302,
        headers: { Location: "/login" },
      });
    if (url.pathname.startsWith("/app")) {
      const t = await fixedTenant(env);
      try {
        if (!t) fail(401, "请初始化");
        await authenticate(req, env, t);
      } catch (e) {
        if (!(e instanceof HttpError) || e.status !== 401) throw e;
        return new Response(null, {
          status: 302,
          headers: { Location: "/login", "Set-Cookie": clearCookie() },
        });
      }
    }
    return serve(env, req, "/tenant.html", {
      __BASE__: "/",
      __TURNSTILE_MODE__: "off",
      __SITEKEY__: "",
    });
  }
  if (url.pathname === "/api/setup") return setupApi(req, env);
  if (
    !url.pathname.startsWith("/api/") ||
    /^\/api\/(?:platform|tenants|ops|parent|parents)(?:\/|$)/.test(url.pathname)
  )
    return neutral404();
  const t = await fixedTenant(env);
  if (url.pathname === "/api/auth/status" && req.method === "GET") {
    if (!t)
      return json({
        authenticated: false,
        initialized: false,
        api_base: "/api",
      });
    try {
      const user = await authenticate(req, env, t);
      return json({
        authenticated: true,
        user: publicUser(user),
        api_base: "/api",
      });
    } catch (e) {
      if (e instanceof HttpError && e.status === 401)
        return json({ authenticated: false, api_base: "/api" });
      throw e;
    }
  }
  if (!t) fail(503, "请先初始化系统", "setup_required");
  const resolved = { tenant: t, base: "/", relative: url.pathname, root: true };
  env.__tenantResolved = resolved;
  return tenantApi(req, env, resolved, url);
}
function errorResponse(e, env, url) {
  let response;

  if (["not_found"].includes(e.code)) env.__identityContract = true;
  if (e instanceof HttpError) {
    response =
      e.status === 404
        ? neutral404()
        : json(
            {
              error: e.message,
              code: e.code,
              ...(e.details ? { details: e.details } : {}),
            },
            e.status,
          );
    if (e.status === 401) {
      const resolved = env.__tenantResolved;
      if (resolved)
        response.headers.set(
          "Set-Cookie",
          resolved.root ? clearCookie() : clearCookie(resolved.base),
        );
    }
  } else if (
    /invalid_teacher_reference|invalid_student_reference|profile_in_use/.test(
      String(e?.message),
    )
  ) {
    response = json(
      {
        error: "关联档案状态或引用已变化，请刷新重试",
        code: "REFERENCE_CONFLICT",
      },
      409,
    );
  } else if (/tenant_disabled/.test(String(e?.message))) {
    response = json(
      { error: "机构已停用或正在删除", code: "TENANT_DISABLED" },
      409,
    );
  } else if (/UNIQUE constraint|slug_reserved/.test(String(e?.message))) {
    response = json(
      { error: "记录或机构路径已存在，请刷新后重试", code: "CONFLICT" },
      409,
    );
  } else {
    const incident = randomId("err");
    console.error("request_failure", incident, e?.name, String(e?.message || "").slice(0, 300));
    response = json(
      { error: "暂时无法完成操作，请稍后重试", code: incident },
      500,
    );
  }
  return response;
}
async function normalizeResponse(response, env) {
  if (env.__identityContract) {
    if (response.status === 404)
      response = json({ error: "not_found", message: "不存在" }, 404);
    else if (response.status >= 400) {
      const value = await response
        .clone()
        .json()
        .catch(() => null);
      if (value) {
        const code = identityErrorCode({
          code: value.code || value.error,
          status: response.status,
        });
        const headers = response.headers.get("Set-Cookie");
        response = json(
          {
            error: code,
            code: value.code || value.error,
            message: value.message || value.error,
            ...(value.details ? { details: value.details } : {}),
            ...(code === "possible_duplicate" &&
            Array.isArray(value.details?.duplicates)
              ? { duplicates: value.details.duplicates }
              : {}),
          },
          response.status,
        );
        if (headers) response.headers.set("Set-Cookie", headers);
      }
    }
  }
  return response;
}
const worker = {
  async fetch(req, env) {
    const timerStart = performance.now(),
      timing = { trips: 0, dbMs: 0 };
    // 前置 CDN（EdgeOne）回源专用域名：ORIGIN_HOST 的 DNS 始终指向 Pages，与用户访问的 APP_HOST 解耦。
    // 从它进来的请求按 APP_HOST 处理，浏览器发来的 Origin（APP_HOST）因此仍能通过同源写入检查。
    // 未设置 ORIGIN_HOST 时行为不变；直接在浏览器打开 ORIGIN_HOST 时写入会因 Origin 不符被拒绝。
    if (env.ORIGIN_HOST) {
      const incoming = new URL(req.url);
      if (incoming.hostname === env.ORIGIN_HOST && env.APP_HOST && env.ORIGIN_HOST !== env.APP_HOST) {
        incoming.hostname = env.APP_HOST;
        req = new Request(incoming, req);
      }
    }
    env = {
      ...env,
      CHANNEL_DB: measureDatabase(env.CHANNEL_DB, timing),
      __requestScope: true,
      __identityContract: new URL(req.url).pathname.startsWith("/api/"),
      __readRequest:
        req.method === "GET" ||
        req.method === "HEAD" ||
        (req.method === "POST" &&
          /^\/(?:[^/]+\/)?api\/read-batch$/.test(new URL(req.url).pathname)),
    }; // 每个请求独立的仓储缓存，绝不跨请求复用授权或业务快照。
    const started = now(),
      url = new URL(req.url);
    let response;
    try {
      config(env);
      response = await dispatch(req, env, url);
    } catch (e) {
      response = errorResponse(e, env, url);
    }
    response = await normalizeResponse(response, env);
    // 所有中性 404 使用相同模板、响应头及最低耗时；真实网络延迟无法保证逐毫秒相等。
    if (response.status === 404) {
      const remaining = 200 - (now() - started);
      if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
    }
    const secured = secureResponse(
      response,
      false,
      response.status === 200 ? env.__cacheControl : undefined,
    );
    if (/^\/(?:[^/]+\/)?api\//.test(url.pathname))
      secured.headers.set("Server-Timing", apiTiming(timing, timerStart));
    return secured;
  },
};
export default worker;
