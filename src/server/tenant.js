import { repo } from "./repo.js";
import { fail } from "./core.js";

// 机构记录写入后不会变（单机构，只有初始化和整体恢复会写 app_instance/tenants），
// 每个请求都查一次会多一个串行 D1 往返。按 isolate 内存缓存 60 秒，键是原始 D1 绑定对象
// （worker 入口包装计时之前的 CHANNEL_DB），不同数据库/测试实例互不串用。
// 只缓存已初始化的结果；初始化与整体恢复后主动清除。TENANT_ID 一致性每次照常检查。
const TENANT_TTL_MS = 60 * 1000;
const tenantCache = new WeakMap();
const cacheKey = (env) => {
  const key = env.__rawDb || env.CHANNEL_DB;
  return key && typeof key === "object" ? key : null;
};

export function clearTenantCache(env) {
  const key = cacheKey(env);
  if (key) tenantCache.delete(key);
}

// Single installation identity; host/slug/status never select or disable an institution.
export async function fixedTenant(env) {
  const key = cacheKey(env);
  const hit = key ? tenantCache.get(key) : null;
  let tenant;
  if (hit && Date.now() - hit.at < TENANT_TTL_MS) tenant = hit.tenant;
  else {
    tenant = await repo(env, null).instanceTenant();
    if (key) {
      if (tenant) tenantCache.set(key, { at: Date.now(), tenant });
      else tenantCache.delete(key);
    }
  }
  if (!tenant) return null;
  if (env.TENANT_ID && env.TENANT_ID !== tenant.id)
    fail(503, "TENANT_ID 与初始化记录不一致", "CONFIG_INVALID");
  return { ...tenant };
}
