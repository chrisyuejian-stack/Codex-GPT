// Capture the SQL that repo.inbox() would run, inline its numbered parameters, and print it.
import { repo } from "../../src/server/repo.js";
import { writeFileSync } from "node:fs";
const captured = [];
const db = {
  prepare(sql) {
    const st = { sql, args: [], bind(...a) { return { ...st, args: a }; }, all: async () => ({ results: [] }), first: async () => null, run: async () => ({}) };
    return st;
  },
  async batch(list) {
    captured.push(...list);
    return list.map(() => ({ results: [] }));
  },
};
const tenantId = process.argv[2], userId = process.argv[3];
const at = Date.now();
const input = {
  today: new Date(at + 28800000).toISOString().slice(0, 10),
  at,
  low: 8,
  days: 14,
  user_id: userId,
  roles: ["supervisor"],
  teacher_id: null,
  allowed: ["attendance:checkin", "attendance:confirm", "lead_followup:lead", "renewal:balance", "makeup:leave", "student_followup:task", "student_followup:stage", "payment_check:payment", "payment_check:price"],
  scope: process.argv[4] || "mine",
  type: "",
  include_snoozed: false,
  limit: Number(process.argv[5] || 100),
  offset: 0,
};
const r = repo({ CHANNEL_DB: db }, tenantId);
await r.inbox(input);
const lit = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : "'" + String(v).replaceAll("'", "''") + "'");
captured.forEach((st, i) => {
  const out = st.sql.replace(/\?(\d+)/g, (_, n) => lit(st.args[Number(n) - 1]));
  if (/\?(?!\d)/.test(out)) console.error("unnumbered ? present in statement", i);
  writeFileSync(process.argv[6] + "/inbox" + i + ".sql", out);
  console.log("statement", i, "length", out.length, "args", st.args.length);
});
