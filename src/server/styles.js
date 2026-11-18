import { repo } from "./repo.js";
import { json, fail } from "./core.js";
import { assetPath } from "./style-package.js";
import { styleImage } from "./platform-ops.js";

// Shared feedback-card styles outlive the retired plan/article/report editors.
export const stylesPath = (path) =>
  /^\/api\/styles(?:\/[^/]+\/versions\/[^/]+(?:\/assets\/.+)?)?$/.test(path);

export async function stylesApi(req, env, resolved, user, policy, url) {
  if (!stylesPath(resolved.relative)) return undefined;
  if (req.method !== "GET" || !policy.modules.feedback)
    fail(404, "不存在", "not_found");
  if (
    !user.roles.some((role) =>
      ["supervisor", "academic", "consultant", "teacher"].includes(role),
    )
  )
    fail(403, "没有权限", "forbidden");
  const r = repo(env, resolved.tenant.id);
  if (!(await r.platformOps.available())) fail(404, "不存在", "not_found");
  const base = resolved.root
    ? "/api"
    : resolved.base.replace(/\/$/, "") + "/api";
  const dto = (row) => ({
    id: row.id,
    name: row.name,
    version: row.version,
    manifest: JSON.parse(row.manifest_json),
    asset_base:
      base +
      "/styles/" +
      encodeURIComponent(row.id) +
      "/versions/" +
      encodeURIComponent(row.version) +
      "/assets/",
  });
  const match =
    /^\/api\/styles\/([^/]+)\/versions\/([^/]+)(?:\/assets\/(.+))?$/.exec(
      resolved.relative,
    );
  if (!match) {
    if (
      url.searchParams.has("doc_type") &&
      url.searchParams.get("doc_type") !== "feedback_card"
    )
      fail(404, "不存在", "not_found");
    return json({
      items: (await r.platformOps.tenantStyles("feedback_card")).map((row) => ({
        ...dto(row),
        thumbnail: JSON.parse(row.manifest_json).thumbnail,
      })),
    });
  }
  const row = await r.platformOps.tenantStyle(match[1], match[2], true);
  if (
    !row ||
    !JSON.parse(row.manifest_json).doc_types.includes("feedback_card")
  )
    fail(404, "不存在", "not_found");
  if (!match[3]) return json(dto(row));
  let path;
  try {
    path = assetPath(decodeURIComponent(match[3]));
  } catch {
    fail(404, "不存在", "not_found");
  }
  return styleImage(env, await r.platformOps.asset(match[1], match[2], path));
}
