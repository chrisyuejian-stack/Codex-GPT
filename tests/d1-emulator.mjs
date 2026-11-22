import { DatabaseSync } from "node:sqlite";

// Cloudflare D1 official limits & SQL compatibility reference:
// - https://developers.cloudflare.com/d1/platform/limits/
// - https://developers.cloudflare.com/d1/sql-api/sql-statements/
// - https://developers.cloudflare.com/d1/worker-api/
// - https://developers.cloudflare.com/d1/observability/debug-d1/
export const D1_LIMITS = {
  MAX_SQL_BYTES: 100000,
  MAX_BOUND_PARAMS: 100,
  MAX_COMPOUND_TERMS: 5,
  MAX_FUNCTION_ARGS: 32,
  MAX_PATTERN_BYTES: 50,
  MAX_VALUE_BYTES: 2000000,
  MAX_ROW_BYTES: 2000000,
  MAX_COLUMNS_PER_TABLE: 100,
  MAX_COLUMNS_PER_RESULT: 100,
  MAX_RESULT_BYTES: 50 * 1024 * 1024,
};

// Official 17 compatible PRAGMA statements in Cloudflare D1.
export const D1_ALLOWED_PRAGMAS = new Set([
  "table_list",
  "table_info",
  "table_xinfo",
  "index_list",
  "index_info",
  "index_xinfo",
  "quick_check",
  "foreign_key_check",
  "foreign_key_list",
  "case_sensitive_like",
  "ignore_check_constraints",
  "legacy_alter_table",
  "recursive_triggers",
  "reverse_unordered_selects",
  "foreign_keys",
  "defer_foreign_keys",
  "optimize",
]);

const NON_FUNCTION_WORDS = new Set([
  "select",
  "from",
  "where",
  "and",
  "or",
  "not",
  "in",
  "exists",
  "values",
  "as",
  "on",
  "using",
  "over",
  "partition",
  "order",
  "group",
  "by",
  "having",
  "check",
  "primary",
  "foreign",
  "references",
  "unique",
  "index",
  "table",
  "view",
  "set",
  "into",
  "case",
  "when",
  "then",
  "else",
  "end",
  "cast",
  "filter",
  "with",
  "recursive",
  "returning",
  "conflict",
  "update",
  "insert",
  "create",
  "alter",
  "drop",
  "trigger",
  "key",
  "begin",
  "except",
  "union",
  "intersect",
  "join",
  "left",
  "right",
  "inner",
  "cross",
  "outer",
  "natural",
  "default",
  "generated",
  "always",
  "constraint",
  "pragma",
  "all",
  "distinct",
  "is",
  "like",
  "glob",
  "between",
  "case",
  "collate",
  "window",
  "rows",
  "range",
  "groups",
  "preceding",
  "following",
]);

const COLUMN_LIST_PRECEDERS = new Set([
  "into",
  "table",
  "exists",
  "on",
  "references",
  "with",
  "recursive",
  "conflict",
]);

export const byteSize = (value) =>
  typeof value === "string"
    ? Buffer.byteLength(value)
    : value instanceof ArrayBuffer
      ? value.byteLength
      : ArrayBuffer.isView(value)
        ? value.byteLength
        : 8;

export function normalizeD1Param(value) {
  if (value === undefined)
    throw Error("D1_TYPE_ERROR: Type 'undefined' not supported for bound parameter");
  if (value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw Error("D1_TYPE_ERROR: Non-finite number not supported for bound parameter");
    return value;
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value))
    return value instanceof Uint8Array
      ? value
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === "bigint")
    throw Error("D1_TYPE_ERROR: Type 'bigint' not supported for bound parameter");
  throw Error(
    "D1_TYPE_ERROR: Unsupported bound parameter type '" + typeof value + "'",
  );
}

function stripLeadingCommentsAndSpace(sql) {
  let i = 0;
  while (i < sql.length) {
    if (/\s/.test(sql[i])) {
      i++;
      continue;
    }
    if (sql[i] === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (sql[i] === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    break;
  }
  return sql.slice(i);
}

function validateLeadingStatement(sql) {
  const head = stripLeadingCommentsAndSpace(sql);
  if (!head) throw Error("D1_ERROR: No SQL statements detected.");
  if (
    /^(?:BEGIN(?:\s+(?:DEFERRED|IMMEDIATE|EXCLUSIVE))?(?:\s+TRANSACTION)?|COMMIT(?:\s+TRANSACTION)?|END(?:\s+TRANSACTION)?|ROLLBACK(?:\s+TRANSACTION)?|SAVEPOINT\b|RELEASE(?:\s+SAVEPOINT)?)(?![A-Za-z0-9_])/i.test(
      head,
    )
  )
    throw Error(
      "D1_TRANSACTION_NOT_ALLOWED: Explicit SQL transactions (BEGIN/COMMIT/ROLLBACK/SAVEPOINT) are not supported in D1; use db.batch()",
    );
  const pragma = /^PRAGMA\s+(?:[A-Za-z0-9_"]+\.)?([A-Za-z_][A-Za-z0-9_]*)(?:\s*\(([^)]*)\))?/i.exec(
    head,
  );
  if (pragma) {
    const name = pragma[1].toLowerCase();
    const arg = pragma[2]?.trim();
    if (!D1_ALLOWED_PRAGMAS.has(name))
      throw Error("D1_UNSUPPORTED_PRAGMA: PRAGMA " + name + " is not supported in D1");
    if (name === "optimize" && arg === "-1")
      throw Error("D1_UNSUPPORTED_PRAGMA: PRAGMA optimize(-1) is not supported in D1");
  }
}

export function validateD1(sql, params = []) {
  if (typeof sql !== "string") throw Error("D1_ERROR: SQL must be a string");
  if (Buffer.byteLength(sql) > D1_LIMITS.MAX_SQL_BYTES)
    throw Error("D1_SQL_TOO_LONG");
  validateLeadingStatement(sql);
  const stack = [];
  // D1 每个 compound SELECT 最多 5 段（实测第 6 段报 too many terms in compound SELECT）。
  // 按括号层级分别统计 UNION / INTERSECT / EXCEPT，嵌套子查询各算各的。
  const compound = [0];
  const checkCompound = (n) => {
    if (n + 1 > D1_LIMITS.MAX_COMPOUND_TERMS)
      throw Error("D1_TOO_MANY_COMPOUND_TERMS: too many terms in compound SELECT");
  };
  let quoted = false;
  let dquoted = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (lineComment) {
      if (c === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (c === "*" && sql[i + 1] === "/") {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (quoted) {
      if (c === "'") {
        if (sql[i + 1] === "'") {
          i++;
          continue;
        }
        quoted = false;
      }
      continue;
    }
    if (dquoted) {
      if (c === '"') {
        if (sql[i + 1] === '"') {
          i++;
          continue;
        }
        dquoted = false;
      }
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      lineComment = true;
      i++;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      blockComment = true;
      i++;
      continue;
    }
    if (c === "'") {
      quoted = true;
      continue;
    }
    if (c === '"') {
      dquoted = true;
      continue;
    }
    if (c === "?" && /[0-9]/.test(sql[i + 1] || "")) {
      const m = /^\?(\d+)/.exec(sql.slice(i));
      const idx = Number(m[1]);
      if (idx < 1 || idx > D1_LIMITS.MAX_BOUND_PARAMS)
        throw Error("D1_TOO_MANY_PARAMETERS");
    }
    if (
      (c === "U" || c === "u" || c === "I" || c === "i" || c === "E" || c === "e") &&
      !/[A-Za-z0-9_]/.test(sql[i - 1] || "") &&
      /^(?:UNION|INTERSECT|EXCEPT)(?![A-Za-z0-9_])/i.test(sql.slice(i, i + 10))
    )
      compound[compound.length - 1]++;
    if (c === "(") {
      compound.push(0);
      const before = sql.slice(0, i);
      const fnMatch = before.match(/([a-z_][a-z0-9_]*)\s*$/i);
      let isFunction = false;
      let fnName = null;
      if (fnMatch) {
        fnName = fnMatch[1].toLowerCase();
        if (!NON_FUNCTION_WORDS.has(fnName)) {
          const prevSlice = before.slice(0, fnMatch.index).trimEnd();
          const prevWord = prevSlice.match(/([a-z_][a-z0-9_]*)$/i)?.[1]?.toLowerCase();
          const prevChar = prevSlice.at(-1);
          // Skip table/CTE/index column lists like INSERT INTO tbl(...), CREATE TABLE tbl(...), ON tbl(...), WITH cte(...)
          if (
            !COLUMN_LIST_PRECEDERS.has(prevWord) &&
            !(prevWord === "if" || prevWord === "not") &&
            prevChar !== "."
          )
            isFunction = true;
        }
      }
      stack.push({ name: fnName, isFunction, count: 0, hasToken: false });
    } else if (c === "," && stack.length) {
      const top = stack.at(-1);
      top.count = Math.max(top.count, 1) + 1;
      top.hasToken = true;
    } else if (c === ")" && stack.length) {
      if (compound.length > 1) checkCompound(compound.pop());
      const f = stack.pop();
      const args = f.hasToken ? Math.max(f.count, 1) : 0;
      if (f.isFunction && args > D1_LIMITS.MAX_FUNCTION_ARGS)
        throw Error("D1_TOO_MANY_FUNCTION_ARGUMENTS: " + f.name + "() exceeds 32 arguments");
    } else if (!/\s/.test(c) && stack.length) {
      stack.at(-1).hasToken = true;
    }
  }
  for (const n of compound) checkCompound(n);
  if (params.length > D1_LIMITS.MAX_BOUND_PARAMS)
    throw Error("D1_TOO_MANY_PARAMETERS");
  for (const x of params) {
    const normalized = normalizeD1Param(x);
    if (byteSize(normalized) > D1_LIMITS.MAX_VALUE_BYTES)
      throw Error("D1_VALUE_TOO_BIG");
  }
}

export function emulateD1(raw, { maxResultBytes = D1_LIMITS.MAX_RESULT_BYTES } = {}) {
  const native = new DatabaseSync(":memory:");
  for (const op of ["like", "glob"])
    raw.function(op, { varargs: true }, (...args) => {
      if (args[0] !== null && byteSize(args[0]) > D1_LIMITS.MAX_PATTERN_BYTES)
        throw Error("D1_PATTERN_TOO_COMPLEX");
      return native
        .prepare(
          op === "glob"
            ? "SELECT ? GLOB ? AS value"
            : args.length === 3
              ? "SELECT ? LIKE ? ESCAPE ? AS value"
              : "SELECT ? LIKE ? AS value",
        )
        .get(args[1], args[0], ...args.slice(2)).value;
    });
  raw.function("__d1_row", { varargs: true }, (...values) => {
    // Conservative SQLite record-header allowance; catches the whole-row limit too.
    if (
      values.some((x) => byteSize(x) > D1_LIMITS.MAX_VALUE_BYTES) ||
      values.reduce((n, x) => n + byteSize(x) + 9, 1) > D1_LIMITS.MAX_ROW_BYTES
    )
      throw Error("D1_ROW_TOO_BIG");
    return 1;
  });
  let version = -1;
  const quote = (x) => '"' + x.replaceAll('"', '""') + '"';
  return {
    close() {
      native.close();
    },
    installRows() {
      const next = raw.prepare("PRAGMA schema_version").get().schema_version;
      if (next === version) return;
      for (const { name } of raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all()) {
        const info = raw.prepare("PRAGMA table_info(" + quote(name) + ")").all();
        if (info.length > D1_LIMITS.MAX_COLUMNS_PER_TABLE)
          throw Error(
            "D1_TOO_MANY_COLUMNS: table " + name + " has " + info.length + " columns (max 100)",
          );
        const columns = info.map((x) => "NEW." + quote(x.name)).join(",");
        for (const action of ["INSERT", "UPDATE"])
          raw.exec(
            "CREATE TEMP TRIGGER IF NOT EXISTS " +
              quote("__d1_" + name + action) +
              " AFTER " +
              action +
              " ON " +
              quote(name) +
              " BEGIN SELECT __d1_row(" +
              columns +
              "); END",
          );
      }
      version = raw.prepare("PRAGMA schema_version").get().schema_version;
    },
    result(value, columnCount) {
      if (columnCount !== undefined && columnCount > D1_LIMITS.MAX_COLUMNS_PER_RESULT)
        throw Error(
          "D1_TOO_MANY_COLUMNS: query result has " + columnCount + " columns (max 100)",
        );
      const rows = Array.isArray(value) ? value : value ? [value] : [];
      let totalBytes = 0;
      for (const row of rows) {
        const entries = Object.entries(row);
        if (entries.length > D1_LIMITS.MAX_COLUMNS_PER_RESULT)
          throw Error(
            "D1_TOO_MANY_COLUMNS: query result has " + entries.length + " columns (max 100)",
          );
        for (const [k, v] of entries) {
          const sz = byteSize(v);
          if (sz > D1_LIMITS.MAX_VALUE_BYTES) throw Error("D1_RESULT_TOO_BIG");
          totalBytes += Buffer.byteLength(k) + sz + 8;
          if (totalBytes > maxResultBytes)
            throw Error(
              "D1_RESULT_SIZE_EXCEEDED: D1 query result exceeded the maximum response size limit of 50 MB",
            );
        }
      }
      return value;
    },
  };
}
