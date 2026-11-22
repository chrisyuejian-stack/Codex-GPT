// 0033 线索回访记录：GET/POST /api/tools/leads/:id/followups 的权限、版本冲突、操作编号重放、审计与全量备份往返。
import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support.mjs";
import { setup, request, accountToken } from "./fixtures-credit.mjs";
import { passwordOpen, fullBackupTables, FULL_BACKUP_VERSION } from "../src/server/full-backup-format.js";

const PASSWORD = "FullBackupSecure9";
async function school(fn) {
  const f = await fixture();
  try {
    await fn({ ...(await setup(f, 1, "lead-fu")), f });
  } finally {
    f.restore();
  }
}
function ok(r, status = 200) {
  assert.equal(r.status, status, r.text);
  return r.body;
}
async function newLead(s, extra = {}) {
  const { id } = ok(await request(s, "tools/leads", "POST", { name: "沈若溪", source: "小红书", stage: "new", ...extra }));
  return ok(await request(s, "tools/leads/" + id)).record;
}
const path = (lead) => "tools/leads/" + lead.id + "/followups";

test("记录回访：写入回访记录并同批更新下次回访与阶段，按线索模块写审计", () =>
  school(async (s) => {
    const lead = await newLead(s);
    const res = ok(
      await request(s, path(lead), "POST", {
        version: lead.version,
        operation_id: "op_lead_fu_0001",
        channel: "wechat",
        content: "再跟进：周末家长有空",
        next_followup: "2026-11-25",
        stage: "contacted",
      }),
    );
    assert.equal(res.id, "op_lead_fu_0001");
    assert.equal(res.lead_version, lead.version + 1);
    const after = ok(await request(s, "tools/leads/" + lead.id)).record;
    assert.equal(after.next_followup, "2026-11-25");
    assert.equal(after.stage, "contacted");
    assert.equal(after.note, lead.note, "旧备注不被改写");
    const list = ok(await request(s, path(lead)));
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].channel, "wechat");
    assert.equal(list.items[0].content, "再跟进：周末家长有空");
    assert.ok(list.items[0].actor_name);
    assert.match(list.items[0].at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}\+08:00$/);
    assert.equal(list.lead.id, lead.id);
    assert.equal(list.lead.phone_enc, undefined);
    // 线索列表带最近一次回访摘要（看板卡片用）。
    const listed = ok(await request(s, "tools/leads")).items.find((x) => x.id === lead.id);
    assert.equal(listed.last_followup_content, "再跟进：周末家长有空");
    assert.equal(listed.last_followup_at, list.items[0].at);
    const audit = s.f.db.raw
      .prepare("SELECT module,action,entity_id FROM audit_log WHERE action='followup'")
      .all();
    assert.equal(audit.length, 1);
    assert.equal(audit[0].module, "leads");
    // 同一操作编号重放：返回原结果，不重复写入。
    const again = ok(
      await request(s, path(lead), "POST", {
        version: lead.version,
        operation_id: "op_lead_fu_0001",
        channel: "wechat",
        content: "再跟进：周末家长有空",
      }),
    );
    assert.equal(again.replayed, true);
    assert.equal(ok(await request(s, path(lead))).items.length, 1);
    // 暂不考虑：阶段改为流失，下次回访清空。
    ok(
      await request(s, path(lead), "POST", {
        version: after.version,
        operation_id: "op_lead_fu_0002",
        content: "暂不考虑：预算不够",
        next_followup: "2026-12-01",
        stage: "lost",
      }),
    );
    const lost = ok(await request(s, "tools/leads/" + lead.id)).record;
    assert.equal(lost.stage, "lost");
    assert.equal(lost.next_followup, null);
    const two = ok(await request(s, path(lead))).items;
    assert.equal(two.length, 2);
    assert.equal(two.find((x) => x.id === "op_lead_fu_0002").next_followup, null);
  }));

test("记录回访：版本冲突、操作编号、校验与已转正线索被拒绝", () =>
  school(async (s) => {
    const lead = await newLead(s);
    const base = { version: lead.version, operation_id: "op_lead_fu_1000", content: "没接通" };
    ok(await request(s, path(lead), "POST", { ...base, version: lead.version + 5 }), 409);
    ok(await request(s, path(lead), "POST", { ...base, operation_id: "x" }), 400);
    ok(await request(s, path(lead), "POST", { ...base, operation_id: undefined }), 400);
    ok(await request(s, path(lead), "POST", { ...base, channel: "fax" }), 400);
    ok(await request(s, path(lead), "POST", { ...base, content: "" }), 400);
    ok(await request(s, path(lead), "POST", { ...base, stage: "enrolled" }), 400);
    ok(await request(s, path(lead), "POST", { ...base, next_followup: "2026-13-40" }), 400);
    assert.equal(ok(await request(s, path(lead))).items.length, 0, "失败的请求不留记录");
    ok(await request(s, path(lead), "POST", base));
    // 同一编号用于另一条线索：拒绝。
    const other = await newLead(s, { name: "韩知夏" });
    ok(await request(s, path(other), "POST", { ...base, version: other.version }), 409);
    // 旧版本再写：冲突。
    ok(await request(s, path(lead), "POST", { ...base, operation_id: "op_lead_fu_1001" }), 409);
    // 已转正线索不可再记回访。
    const fresh = ok(await request(s, "tools/leads/" + other.id)).record;
    ok(await request(s, "tools/leads/" + other.id + "/convert", "POST", { version: fresh.version }));
    const enrolled = ok(await request(s, "tools/leads/" + other.id)).record;
    ok(await request(s, path(other), "POST", { version: enrolled.version, operation_id: "op_lead_fu_1002", content: "回访" }), 409);
    ok(await request(s, "tools/leads/missing/followups"), 404);
  }));

test("记录回访：读沿用 leads.read，写沿用 leads.update；仅财务账号与学员账号被拒绝", () =>
  school(async (s) => {
    const lead = await newLead(s);
    const finance = await accountToken(s, ["finance"]);
    const consultant = await accountToken(s, ["consultant"]);
    const body = (op, version = lead.version) => ({ version, operation_id: op, content: "再跟进" });
    ok(await request(s, path(lead), "GET", undefined, finance.token), 403);
    ok(await request(s, path(lead), "POST", body("op_lead_fu_2000"), finance.token), 403);
    const student = await accountToken(s, ["student"], s.students[0]);
    ok(await request(s, path(lead), "GET", undefined, student.token), 403);
    ok(await request(s, path(lead), "POST", body("op_lead_fu_2001"), student.token), 403);
    ok(await request(s, path(lead), "GET", undefined, consultant.token));
    ok(await request(s, path(lead), "POST", body("op_lead_fu_2002"), consultant.token));
    // 另一账号重放别人用过的编号：拒绝。
    ok(await request(s, path(lead), "POST", body("op_lead_fu_2002", lead.version + 1)), 409);
  }));

test("回访记录进入全量备份（迁移版本 33）并随恢复整体回到备份时的状态", () =>
  school(async (s) => {
    assert.equal(FULL_BACKUP_VERSION, 33);
    assert.ok(fullBackupTables.lead_followups);
    const lead = await newLead(s);
    ok(await request(s, path(lead), "POST", { version: lead.version, operation_id: "op_lead_fu_3000", content: "有意向，约试听", channel: "visit" }));
    const exported = await request(s, "backups/export", "POST", { password: PASSWORD });
    ok(exported);
    const file = JSON.parse(exported.text),
      decoded = await passwordOpen(file, PASSWORD);
    assert.equal(decoded.migration_version, 33);
    assert.equal(decoded.tables.lead_followups.length, 1);
    assert.equal(decoded.tables.lead_followups[0].channel, "visit");
    const now = ok(await request(s, "tools/leads/" + lead.id)).record;
    ok(await request(s, path(lead), "POST", { version: now.version, operation_id: "op_lead_fu_3001", content: "备份之后的回访" }));
    assert.equal(ok(await request(s, path(lead))).items.length, 2);
    const p = ok(await request(s, "backups/restore/preview", "POST", { password: PASSWORD, file }), 201);
    assert.deepEqual(p.comparison.lead_followups, { backup: 1, current: 2, delta: -1 });
    ok(await request(s, "backups/restore/" + p.id + "/confirm", "POST", { confirm: true }));
    const rows = s.f.db.raw.prepare("SELECT id FROM lead_followups").all();
    assert.deepEqual(rows.map((x) => x.id), ["op_lead_fu_3000"]);
  }));

test("前端：线索与老师新页面加在打包列表末尾，接管原入口并保留原写入接口；待办“记录回访”挂到新详情", async () => {
  const { readFile } = await import("node:fs/promises");
  const bundle = await readFile("scripts/frontend-bundle.mjs", "utf8"),
    leads = await readFile("src/tenant/fq-leads.js", "utf8"),
    teachers = await readFile("src/tenant/fq-teachers.js", "utf8"),
    today = await readFile("src/tenant/fq-today.js", "utf8");
  assert.ok(bundle.indexOf("src/tenant/fq-backup.js") < bundle.indexOf("src/tenant/fq-leads.js"));
  assert.ok(bundle.indexOf("src/tenant/fq-leads.js") < bundle.indexOf("src/tenant/fq-teachers.js"));
  assert.ok(bundle.indexOf("src/tenant/fq-leads.css") > 0 && bundle.indexOf("src/tenant/fq-teachers.css") > 0);
  assert.match(leads, /leadsPage = \(c\) => leads\(c\)/);
  assert.match(leads, /leadForm = fqLeadForm/);
  assert.match(leads, /ChannelC3\.leadDetail = /);
  for (const path of ['"tools/leads/" + lead.id + "/followups", "POST"', '"/contact", "POST"', '"/convert", "POST"', '"c3/leads-summary"'])
    assert.ok(leads.includes(path), path);
  assert.match(leads, /const SOURCES = \["小红书", "老学员介绍", "大众点评", "抖音", "地推", "其他"\]/);
  assert.match(leads, /"其他：" \+ s/);
  assert.match(today, /globalThis\.FQLeads\?\.followup\) return globalThis\.FQLeads\.followup\(await recordOf\(it\), reload\)/);
  assert.match(teachers, /recordsPage = async \(c, resource, \.\.\.args\) =>/);
  assert.match(teachers, /pageHooks\.rates = ratesPage/);
  assert.match(teachers, /unpaid_amount/);
  assert.match(teachers, /enabled\("settings", "create"\) && !isPhone\(\)/);
  for (const path of ['"finance/payroll?month="', '"c2/students?status=active"', '"data/teachers/" + t.id + "/contact"', '"data/teachers" + (rec ? "/" + rec.id : "")'])
    assert.ok(teachers.includes(path), path);
});
