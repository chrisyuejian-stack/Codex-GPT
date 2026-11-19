import assert from "node:assert/strict";
import { subjectPacks } from "./fixtures-catalog-data.mjs";
import { call, ok } from "./fixtures-plans.mjs";
// Test data is entered through the retained manual settings APIs. No production pack importer.
export async function seedCatalog(s, key = "music_interest") {
  const pack = subjectPacks[key];
  assert.ok(pack);
  s._catalogSeeds ??= new Set();
  if (s._catalogSeeds.has(key)) return;
  s._catalogSeeds.add(key);
  const old = ok(await call(s, "settings/calendar"));
  const nodes = [
    ...old.items,
    ...pack.calendar.filter((n) => !old.items.some((x) => x.key === n.key)),
  ];
  ok(
    await call(s, "settings/calendar", "PUT", {
      version: old.version,
      region: old.region,
      items: nodes,
    }),
  );
  for (const [path, items] of [
    ["courses", pack.courses],
    ["stage-types", pack.stages],
    ["report-classes", pack.classes],
  ])
    for (const doc of items)
      ok(
        await call(s, "settings/" + path, "POST", { ...doc, subject: key }),
        201,
      );
  const rules = ok(await call(s, "settings/stage-rules"));
  ok(
    await call(s, "settings/stage-rules", "PUT", {
      version: rules.version,
      rules: pack.rules,
    }),
  );
}
