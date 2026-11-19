import { repo } from "./repo.js";
import { string, phone, fail, randomId } from "./core.js";
import { can } from "./permissions.js";
import {
  encrypt,
  phoneIndex,
  temporaryPassword,
  newPassword,
} from "./crypto.js";
export function requireCan(user, policy, module, action, record) {
  if (!can(user, policy, module, action, record))
    fail(403, "没有此操作权限", "PERMISSION_DENIED");
}
export function rolesInput(input) {
  if (
    !Array.isArray(input) ||
    !input.length ||
    input.length > 4 ||
    new Set(input).size !== input.length ||
    input.some(
      (x) =>
        ![
          "supervisor",
          "consultant",
          "academic",
          "finance",
          "teacher",
          "student",
        ].includes(x),
    ) ||
    (input.some((x) => ["teacher", "student"].includes(x)) &&
      input.length !== 1)
  )
    fail(400, "角色组合不正确");
  return input;
}
export async function createAccount(env, tenant, actor, policy, data) {
  const roles = rolesInput(data.roles);
  {
    requireCan(
      actor,
      policy,
      "accounts",
      roles.some((x) => ["teacher", "student"].includes(x))
        ? "create_personal"
        : "create",
      { roles },
    );
  }
  const r = repo(env, tenant.id),
    mobile = phone(data.phone);
  let teacherId = null,
    studentId = null;
  if (roles.some((x) => ["teacher", "student"].includes(x))) {
    const kind = roles[0],
      field = kind === "teacher" ? "teacher_id" : "student_id";
    if (typeof data[field] !== "string" || !data[field])
      fail(400, "必须关联本机构档案");
    const profile = await r.businessGet(
      kind === "teacher" ? "teachers" : "students",
      data[field],
    );
    if (!profile) fail(404, "不存在");
    if (profile.status !== "active") fail(400, "档案已停用或归档");
    if (await r.linkedAccount(kind, profile.id))
      fail(409, "该档案已有关联账号");
    if (kind === "teacher") teacherId = profile.id;
    else studentId = profile.id;
    if (
      (kind === "teacher" && data.student_id) ||
      (kind === "student" && data.teacher_id)
    )
      fail(400, "账号只能关联一种档案");
  } else if (data.teacher_id || data.student_id)
    fail(400, "员工账号不能关联个人档案");

  string(data.name, "姓名", 50);
  const index = await phoneIndex(env, tenant.id, mobile);
  if (await r.userByPhone(index)) fail(409, "该手机号已开通账号");
  const password = temporaryPassword(),
    id = randomId("usr");
  await r.createUser(
    {
      id,
      name: data.name,
      phone_hmac: index,
      phone_enc: await encrypt(env, mobile, tenant.id + ":phone"),
      phone_last4: mobile.slice(-4),
      roles: JSON.stringify(roles),
      teacher_id: teacherId,
      student_id: studentId,
      ...(await newPassword(env, password)),
    },
    actor,
  );
  return { id, temporary_password: password };
}
export async function resetAccount(env, tenant, actor, userId, policy) {
  const r = repo(env, tenant.id),
    u = await r.user(userId);
  if (!u) fail(404, "不存在");
  {
    requireCan(
      actor,
      policy,
      "accounts",
      JSON.parse(u.roles).some((x) => ["teacher", "student"].includes(x))
        ? "reset_personal"
        : "reset_staff",
      u,
    );
    if (u.id === actor.id) fail(403, "请使用修改密码入口修改自己的密码");
  }
  const password = temporaryPassword();
  await r.password(u.id, u.version, await newPassword(env, password), actor, 1);
  return { temporary_password: password };
}
