import { repo } from "./repo.js";
import { fail } from "./core.js";

// Single installation identity; host/slug/status never select or disable an institution.
export async function fixedTenant(env) {
  const tenant = await repo(env, null).instanceTenant();
  if (!tenant) return null;
  if (env.TENANT_ID && env.TENANT_ID !== tenant.id)
    fail(503, "TENANT_ID 与初始化记录不一致", "CONFIG_INVALID");
  return tenant;
}
