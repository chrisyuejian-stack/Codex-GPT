// Verify fixed installation scope, spoofed IDs and independent instance sessions.
import { spawnSync } from "node:child_process";
const result = spawnSync(
  process.execPath,
  ["--test", "tests/single-tenant.test.mjs"],
  { stdio: "inherit", env: process.env },
);
process.exit(result.status ?? 1);
