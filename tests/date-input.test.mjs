import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDateInput,
  normalizeMonthInput,
  validDate,
  isoDate,
} from "../src/ui/components.js";

test("任务 #14 日期规范化 normalizeDateInput：支持多种分隔符、紧凑8位、省略年份及长期，拒绝非法日期与闰年边界", () => {
  assert.equal(normalizeDateInput("2026-11-22"), "2026-11-22");
  assert.equal(normalizeDateInput(" 2026/11/22 "), "2026-11-22");
  assert.equal(normalizeDateInput("2026.11.22"), "2026-11-22");
  assert.equal(normalizeDateInput("20261122"), "2026-11-22");
  assert.equal(normalizeDateInput("2026-1-5"), "2026-01-05");
  assert.equal(normalizeDateInput("2026年11月22日"), "2026-11-22");
  assert.equal(normalizeDateInput("11-22", { defaultYear: 2026 }), "2026-11-22");
  assert.equal(normalizeDateInput("11/05", { defaultYear: 2026 }), "2026-11-05");
  assert.equal(normalizeDateInput("1122", { defaultYear: 2026 }), "2026-11-22");
  assert.equal(normalizeDateInput("长期有效"), "2099-12-31");
  assert.equal(normalizeDateInput(""), "");
  assert.equal(normalizeDateInput("   "), "");

  // 闰年与非法日期
  assert.equal(normalizeDateInput("2028-02-29"), "2028-02-29");
  assert.equal(normalizeDateInput("2026-02-29"), null);
  assert.equal(normalizeDateInput("2026-02-30"), null);
  assert.equal(normalizeDateInput("2026-11-31"), null);
  assert.equal(normalizeDateInput("2026-13-01"), null);
  assert.equal(normalizeDateInput("2026-00-10"), null);
  assert.equal(normalizeDateInput("1899-12-31"), null);
  assert.equal(normalizeDateInput("2100-01-01"), null);
  assert.equal(normalizeDateInput("abc"), null);
  assert.equal(normalizeDateInput("2026-11"), null);
});

test("任务 #14 月份规范化 normalizeMonthInput：支持多种分隔符、紧凑6位与单月，拒绝越界月份", () => {
  assert.equal(normalizeMonthInput("2026-11"), "2026-11");
  assert.equal(normalizeMonthInput("2026/03"), "2026-03");
  assert.equal(normalizeMonthInput("2026.3"), "2026-03");
  assert.equal(normalizeMonthInput("202611"), "2026-11");
  assert.equal(normalizeMonthInput("2026年11月"), "2026-11");
  assert.equal(normalizeMonthInput("11", { defaultYear: 2026 }), "2026-11");
  assert.equal(normalizeMonthInput("3", { defaultYear: 2026 }), "2026-03");
  assert.equal(normalizeMonthInput("长期"), "2099-12");
  assert.equal(normalizeMonthInput(""), "");

  assert.equal(normalizeMonthInput("2026-13"), null);
  assert.equal(normalizeMonthInput("2026-00"), null);
  assert.equal(normalizeMonthInput("1800-05"), null);
  assert.equal(normalizeMonthInput("xyz"), null);
  assert.equal(validDate(isoDate(2026, 12, 31)), true);
});
