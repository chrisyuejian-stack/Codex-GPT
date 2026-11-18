import { invalid } from "./tool-validation.js";

import { subjectPacks } from "./subject-packs.js";
import { decrypt, platformPhoneIndex } from "./crypto.js";
import { PURGE_TABLES } from "./purge-schema.js";
import { boundedText, storedRecord, auditChunks, jsonChunks, checkBindings, assertPattern, MANIFEST_BUDGET, D1_VALUE_BUDGET, D1_RECORD_BUDGET, SNAPSHOT_SAFE_ASCII_PATTERN } from "./d1-limits.js";
import { backupTables, creditTables, restoreTables, BUSINESS_SETTINGS, BACKUP_STATUS_LABELS } from "./backup-model.js";
import { randomId, now, fail } from "./core.js";

function purgeFilter(table, id) {
  const scopedKey = "instr(key, 'login:'||?||':')=1 OR instr(key, 'read:'||?||':')=1 OR instr(key, 'request:'||?||':')=1 OR instr(key, 'request-get:'||?||':')=1 OR instr(key, 'city:'||?||':')=1";
  if (table === "security_limits")
    return { where: scopedKey, values: [id,id,id,id,id] };
  if (table === "backup_snapshot_rows")
    return { where: "tenant_id=? OR (table_name='tenants' AND source_id=json_array(?)) OR (table_name='security_limits' AND instr(source_id, ':'||?||':')>0)", values: [id,id,id] };
  return { where: "tenant_id=?", values: [id] };
}

const stage6ReferenceSql = {
  students:
    "SELECT id FROM class_members WHERE tenant_id=?1 AND student_id=?2 AND deleted_at IS NULL UNION ALL SELECT id FROM followup_notes WHERE tenant_id=?1 AND student_id=?2 AND deleted_at IS NULL UNION ALL SELECT id FROM followup_tasks WHERE tenant_id=?1 AND student_id=?2 AND deleted_at IS NULL UNION ALL SELECT id FROM student_routines WHERE tenant_id=?1 AND student_id=?2 AND deleted_at IS NULL UNION ALL SELECT id FROM leads WHERE tenant_id=?1 AND student_id=?2 AND deleted_at IS NULL LIMIT 1",
  teachers:
    "SELECT id FROM classes WHERE tenant_id=?1 AND teacher_id=?2 AND deleted_at IS NULL LIMIT 1",
  course_types:
    "SELECT id FROM classes WHERE tenant_id=?1 AND course_type_id=?2 AND deleted_at IS NULL LIMIT 1",
  locations:
    "SELECT id FROM classes WHERE tenant_id=?1 AND location_id=?2 AND deleted_at IS NULL LIMIT 1",
};
const renewalGroups = `
, ledger AS (
  SELECT x.package_id,ROUND(SUM(x.delta),2) balance,
    -SUM(CASE WHEN x.delta<0 AND x.date>=date((SELECT today FROM args),'-30 days') THEN x.delta ELSE 0 END) used
  FROM package_transactions x
  WHERE x.tenant_id=(SELECT tenant_id FROM args) AND x.deleted_at IS NULL GROUP BY x.package_id
), packs AS (
  SELECT p.*,s.name student_name,COALESCE(b.balance,0) balance,COALESCE(b.used,0) used,
    CASE WHEN p.scope_kind='category' THEN p.category_id ELSE p.course_type_id END scope_id,
    CASE WHEN p.scope_kind='category' THEN g.name ELSE c.name END course_name,
    (p.valid_to IS NULL OR p.valid_to>=a.today) valid
  FROM packages p JOIN args a ON a.tenant_id=p.tenant_id
  JOIN students s ON s.tenant_id=p.tenant_id AND s.id=p.student_id
  JOIN course_types c ON c.tenant_id=p.tenant_id AND c.id=p.course_type_id
  LEFT JOIN course_categories g ON g.tenant_id=p.tenant_id AND g.id=p.category_id
  LEFT JOIN ledger b ON b.package_id=p.id
  WHERE p.deleted_at IS NULL AND p.status='active' AND s.deleted_at IS NULL AND s.status='active'
    AND (p.valid_from IS NULL OR p.valid_from<=a.today)
), package_groups AS (
  SELECT p.student_id,p.student_name,p.scope_kind,p.scope_id,p.course_name,
    CASE WHEN p.scope_kind='type' THEN p.scope_id END course_type_id,
    CASE WHEN p.scope_kind='category' THEN p.scope_id END category_id,
    MIN(CASE WHEN p.valid THEN p.course_type_id END) reminder_course_type_id,
    json_group_array(p.id) FILTER(WHERE p.valid) package_ids,
    ROUND(SUM(CASE WHEN p.valid THEN p.balance ELSE 0 END),2) balance,
    SUM(p.valid) valid_count,
    MIN(CASE WHEN p.valid THEN p.valid_to END) valid_to,
    MAX(CASE WHEN p.valid AND p.valid_to<=date(a.today,'+'||a.days||' days') THEN 1 ELSE 0 END) expiring,
    SUM(CASE WHEN p.valid THEN p.used ELSE 0 END) used
  FROM packs p,args a GROUP BY p.student_id,p.scope_kind,p.scope_id
), debt_scoped AS (
  SELECT d.student_id,s.name student_name,d.course_type_id,d.category_id,
    c.name type_name,g.name category_name,d.remaining_units,
    COALESCE((
      SELECT p.scope_kind FROM packages p
      WHERE p.tenant_id=d.tenant_id AND p.student_id=d.student_id
        AND p.deleted_at IS NULL AND p.status='active'
        AND (p.valid_from IS NULL OR p.valid_from<=a.today)
        AND (p.valid_to IS NULL OR p.valid_to>=a.today)
        AND ((p.scope_kind='type' AND p.course_type_id=d.course_type_id)
          OR (p.scope_kind='category' AND p.category_id=d.category_id))
      ORDER BY (p.scope_kind='type') DESC LIMIT 1
    ),'type') scope_kind
  FROM credit_debts d INDEXED BY p1_credit_debt_active
  JOIN args a ON a.tenant_id=d.tenant_id
  JOIN students s ON s.tenant_id=d.tenant_id AND s.id=d.student_id
  JOIN course_types c ON c.tenant_id=d.tenant_id AND c.id=d.course_type_id
  LEFT JOIN course_categories g ON g.tenant_id=d.tenant_id AND g.id=d.category_id
  WHERE d.deleted_at IS NULL AND d.remaining_units>0 AND s.deleted_at IS NULL AND s.status='active'
), debt_groups AS (
  SELECT student_id,student_name,scope_kind,
    CASE WHEN scope_kind='category' THEN category_id ELSE course_type_id END scope_id,
    CASE WHEN scope_kind='category' THEN COALESCE(category_name,type_name) ELSE type_name END course_name,
    MIN(course_type_id) reminder_course_type_id,ROUND(SUM(remaining_units),2) debt_units
  FROM debt_scoped GROUP BY student_id,scope_kind,scope_id
), grouped AS (
  SELECT p.student_id,p.student_name,p.scope_kind,p.scope_id,p.course_name,
    p.course_type_id,p.category_id,p.reminder_course_type_id,p.package_ids,
    ROUND(p.balance-COALESCE(d.debt_units,0),2) balance,p.valid_count,
    p.valid_to,p.expiring,p.used,COALESCE(d.debt_units,0) debt_units
  FROM package_groups p LEFT JOIN debt_groups d
    ON p.student_id=d.student_id AND p.scope_kind=d.scope_kind AND p.scope_id=d.scope_id AND p.valid_count>0
  UNION ALL
  SELECT d.student_id,d.student_name,d.scope_kind,d.scope_id,d.course_name,
    d.scope_id,NULL,d.reminder_course_type_id,'[]',-d.debt_units,0,NULL,0,0,d.debt_units
  FROM debt_groups d WHERE NOT EXISTS (
    SELECT 1 FROM package_groups p WHERE p.student_id=d.student_id
      AND p.scope_kind=d.scope_kind AND p.scope_id=d.scope_id AND p.valid_count>0
  )
), expired AS (
  SELECT p.student_id,p.student_name,p.scope_kind,p.scope_id,p.course_name,
    CASE WHEN p.scope_kind='type' THEN p.scope_id END course_type_id,
    CASE WHEN p.scope_kind='category' THEN p.scope_id END category_id,
    MIN(p.course_type_id) reminder_course_type_id,
    json_group_array(p.id) package_ids,ROUND(SUM(p.balance),2) balance,0 valid_count,
    MIN(p.valid_to) valid_to,0 expiring,0 used,0 debt_units
  FROM packs p WHERE NOT p.valid AND p.balance>0 GROUP BY p.student_id,p.scope_kind,p.scope_id
)`;
const renewalQuery = (home = false) =>
  `WITH args AS(SELECT ? tenant_id,? today,? low,? days,? filter)` +
  renewalGroups +
  `
, selected AS (
  SELECT g.* FROM grouped g,args a WHERE (g.valid_count>0 OR g.debt_units>0) AND CASE a.filter
    WHEN 'debt' THEN g.debt_units>0
    WHEN 'zero' THEN g.debt_units>0 OR g.balance<=0
    WHEN 'low' THEN g.debt_units=0 AND g.balance>0 AND g.balance<=a.low
    WHEN 'expiring' THEN g.expiring=1
    WHEN 'expired' THEN 0
    ELSE g.debt_units>0 OR g.balance<=a.low OR g.expiring=1 END
  UNION ALL SELECT e.* FROM expired e,args a WHERE a.filter='expired'
), reminders AS (
  SELECT r.student_id,r.scope_kind,r.scope_id,MAX(r.sent_at) last_reminded_at,COUNT(*) reminded_count
  FROM renewal_reminders r JOIN args a ON a.tenant_id=r.tenant_id WHERE r.deleted_at IS NULL
  GROUP BY r.student_id,r.scope_kind,r.scope_id
)
SELECT g.*,COUNT(*) OVER() page_total,
  ${home ? `COUNT(CASE WHEN g.debt_units>0 OR (g.valid_count>0 AND g.balance<=0) THEN 1 END) OVER() renewal_zero,
  COUNT(CASE WHEN g.debt_units=0 AND g.valid_count>0 AND g.balance>0 AND g.balance<=a.low THEN 1 END) OVER() renewal_low,
  COUNT(CASE WHEN g.valid_count>0 AND g.expiring=1 THEN 1 END) OVER() renewal_expiring,
  COUNT(CASE WHEN g.debt_units>0 THEN 1 END) OVER() renewal_debt,` : ""}
  r.last_reminded_at,COALESCE(r.reminded_count,0) reminded_count,
  (SELECT MAX(n.at) FROM followup_notes n WHERE n.tenant_id=a.tenant_id AND n.student_id=g.student_id AND n.deleted_at IS NULL) last_contact,
  CASE WHEN g.used>0 THEN date(a.today,'+'||CAST(MAX(0,g.balance)/g.used*30 AS INTEGER)||' days') END estimated_end
FROM selected g CROSS JOIN args a LEFT JOIN reminders r ON r.student_id=g.student_id AND r.scope_kind=g.scope_kind AND r.scope_id=g.scope_id
ORDER BY (g.debt_units>0) DESC,g.balance,g.valid_to,g.student_id,g.scope_kind,g.scope_id LIMIT ? OFFSET ?`;
const renewalSql = renewalQuery();
const homeRenewalSql = renewalQuery(true);
function renewalRow(row) {
  const { valid_count, scope_id, used, ...data } = row;
  return {
    ...data,
    id: JSON.stringify([row.student_id, row.scope_kind, scope_id]),
    ...(row.debt_units > 0 ? { state: "debt" } : {}),
    package_ids: JSON.parse(data.package_ids),
    expiring: !!data.expiring,
    last_reminded_at:
      data.last_reminded_at == null
        ? null
        : new Date(data.last_reminded_at + 28800000)
            .toISOString()
            .slice(0, 19) + "+08:00",
  };
}
const creditTableSql = (build) =>
  Object.fromEntries(Object.entries(creditTables).map(([table, { columns }]) => [
    table,
    build(table, columns),
  ]));
const businessExportSql = {
  ...creditTableSql((table) => `SELECT * FROM ${table} WHERE tenant_id=? ORDER BY id LIMIT 200 OFFSET ?`),
  renewal_reminders:
    "SELECT * FROM renewal_reminders WHERE tenant_id=? ORDER BY id LIMIT 200 OFFSET ?",
  students:
    "SELECT * FROM students WHERE tenant_id=? ORDER BY id LIMIT 200 OFFSET ?",
  teachers:
    "SELECT * FROM teachers WHERE tenant_id=? ORDER BY id LIMIT 200 OFFSET ?",
  course_categories:
    "SELECT * FROM course_categories WHERE tenant_id=? ORDER BY id LIMIT 200 OFFSET ?",
  course_types:
    "SELECT * FROM course_types WHERE tenant_id=? ORDER BY id LIMIT 200 OFFSET ?",
  locations:
    "SELECT * FROM locations WHERE tenant_id=? ORDER BY id LIMIT 200 OFFSET ?",
  student_stages:
    "SELECT * FROM student_stages WHERE tenant_id=? ORDER BY id LIMIT 200 OFFSET ?",
  classes:
    "SELECT * FROM classes WHERE tenant_id=? ORDER BY id LIMIT 200 OFFSET ?",
  class_members:
    "SELECT * FROM class_members WHERE tenant_id=? ORDER BY id LIMIT 200 OFFSET ?",
  student_schedule_blocks:
    "SELECT * FROM student_schedule_blocks WHERE tenant_id=? ORDER BY id LIMIT 200 OFFSET ?",
  student_routines:
    "SELECT * FROM student_routines WHERE tenant_id=? ORDER BY id LIMIT 200 OFFSET ?",
  schedule_templates:
    "SELECT * FROM schedule_templates WHERE tenant_id=? ORDER BY id LIMIT 200 OFFSET ?",
  schedule_enrollments:
    "SELECT * FROM schedule_enrollments WHERE tenant_id=? ORDER BY id LIMIT 200 OFFSET ?",
  packages:
    "SELECT * FROM packages WHERE tenant_id=? ORDER BY id LIMIT 200 OFFSET ?",
  lessons:
    "SELECT * FROM lessons WHERE tenant_id=? ORDER BY id LIMIT 200 OFFSET ?",
  lesson_participants:
    "SELECT * FROM lesson_participants WHERE tenant_id=? ORDER BY id LIMIT 200 OFFSET ?",
  package_transactions:
    "SELECT * FROM package_transactions WHERE tenant_id=? ORDER BY id LIMIT 200 OFFSET ?",
  student_payments:
    "SELECT * FROM student_payments WHERE tenant_id=? ORDER BY id LIMIT 200 OFFSET ?",
  makeup_links:
    "SELECT * FROM makeup_links WHERE tenant_id=? ORDER BY id LIMIT 200 OFFSET ?",
  settlements:
    "SELECT * FROM settlements WHERE tenant_id=? ORDER BY id LIMIT 200 OFFSET ?",
  credit_operations:
    "SELECT * FROM credit_operations WHERE tenant_id=? ORDER BY id LIMIT 200 OFFSET ?",
  teacher_rates:
    "SELECT * FROM teacher_rates WHERE tenant_id=? ORDER BY id LIMIT 200 OFFSET ?",
  teacher_payments:
    "SELECT * FROM teacher_payments WHERE tenant_id=? ORDER BY id LIMIT 200 OFFSET ?",
  teacher_adjustments:
    "SELECT * FROM teacher_adjustments WHERE tenant_id=? ORDER BY id LIMIT 200 OFFSET ?",
  other_costs:
    "SELECT * FROM other_costs WHERE tenant_id=? ORDER BY id LIMIT 200 OFFSET ?",
  payroll_snapshots:
    "SELECT * FROM payroll_snapshots WHERE tenant_id=? ORDER BY id LIMIT 200 OFFSET ?",
  lesson_submissions:
    "SELECT * FROM lesson_submissions WHERE tenant_id=? ORDER BY id LIMIT 200 OFFSET ?",
  submission_people:
    "SELECT * FROM submission_people WHERE tenant_id=? ORDER BY id LIMIT 200 OFFSET ?",
  lesson_comments:
    "SELECT * FROM lesson_comments WHERE tenant_id=? ORDER BY id LIMIT 200 OFFSET ?",
  followup_notes:
    "SELECT * FROM followup_notes WHERE tenant_id=? ORDER BY id LIMIT 200 OFFSET ?",
  followup_tasks:
    "SELECT * FROM followup_tasks WHERE tenant_id=? ORDER BY id LIMIT 200 OFFSET ?",
  leads: "SELECT * FROM leads WHERE tenant_id=? ORDER BY id LIMIT 200 OFFSET ?",

  tenant_settings:
    "SELECT * FROM tenant_settings WHERE tenant_id=? AND id IN ('absence_policies','low_balance_threshold','expiry_warning_days','default_unit_minutes') ORDER BY id LIMIT 200 OFFSET ?",
};
const emptyBusinessSql = [
  "SELECT COUNT(*) n FROM students WHERE tenant_id=?",
  "SELECT COUNT(*) n FROM teachers WHERE tenant_id=?",
  "SELECT COUNT(*) n FROM course_categories WHERE tenant_id=?",
  "SELECT COUNT(*) n FROM course_types WHERE tenant_id=?",
  "SELECT COUNT(*) n FROM locations WHERE tenant_id=?",
  "SELECT COUNT(*) n FROM student_stages WHERE tenant_id=?",
  "SELECT COUNT(*) n FROM classes WHERE tenant_id=?",
  "SELECT COUNT(*) n FROM class_members WHERE tenant_id=?",
  "SELECT COUNT(*) n FROM student_schedule_blocks WHERE tenant_id=?",
  "SELECT COUNT(*) n FROM student_routines WHERE tenant_id=?",
  "SELECT COUNT(*) n FROM schedule_templates WHERE tenant_id=?",
  "SELECT COUNT(*) n FROM schedule_enrollments WHERE tenant_id=?",
  "SELECT COUNT(*) n FROM packages WHERE tenant_id=?",
  "SELECT COUNT(*) n FROM lessons WHERE tenant_id=?",
  "SELECT COUNT(*) n FROM lesson_participants WHERE tenant_id=?",
  "SELECT COUNT(*) n FROM package_transactions WHERE tenant_id=?",
  "SELECT COUNT(*) n FROM student_payments WHERE tenant_id=?",
  "SELECT COUNT(*) n FROM makeup_links WHERE tenant_id=?",
  "SELECT COUNT(*) n FROM settlements WHERE tenant_id=?",
  "SELECT COUNT(*) n FROM credit_operations WHERE tenant_id=?",
  "SELECT COUNT(*) n FROM teacher_rates WHERE tenant_id=?",
  "SELECT COUNT(*) n FROM teacher_payments WHERE tenant_id=?",
  "SELECT COUNT(*) n FROM teacher_adjustments WHERE tenant_id=?",
  "SELECT COUNT(*) n FROM other_costs WHERE tenant_id=?",
  "SELECT COUNT(*) n FROM payroll_snapshots WHERE tenant_id=?",
  "SELECT COUNT(*) n FROM lesson_submissions WHERE tenant_id=?",
  "SELECT COUNT(*) n FROM submission_people WHERE tenant_id=?",
  "SELECT COUNT(*) n FROM lesson_comments WHERE tenant_id=?",
  "SELECT COUNT(*) n FROM renewal_reminders WHERE tenant_id=?",
  "SELECT COUNT(*) n FROM followup_notes WHERE tenant_id=?",
  "SELECT COUNT(*) n FROM followup_tasks WHERE tenant_id=?",
  "SELECT COUNT(*) n FROM leads WHERE tenant_id=?",

];
const snapshotCaptureSql = [
  ...Object.values(creditTableSql((table, columns) =>
    `INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json)
      SELECT tenant_id,'brow_'||lower(hex(randomblob(12))),?,'${table}',json_array(tenant_id,id),
      json_object(${columns.map((column) => `'${column}',${column}`).join(",")}) FROM ${table}`,
  )),

  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT tenant_id,'brow_'||lower(hex(randomblob(12))),?,'renewal_reminders',json_array(tenant_id,id),json_object('tenant_id',tenant_id,'id',id,'student_id',student_id,'course_type_id',course_type_id,'scope_kind',scope_kind,'scope_id',scope_id,'package_ids_json',package_ids_json,'channel',channel,'sent_at',sent_at,'created_at',created_at,'created_by',created_by,'updated_at',updated_at,'updated_by',updated_by,'version',version,'deleted_at',deleted_at) FROM renewal_reminders",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT 'platform','brow_'||lower(hex(randomblob(12))),?, 'tenants',json_array(id),json_object('id',id,'slug',slug,'name',name,'type',type,'city',city,'status',status,'expires_at',expires_at,'staff_seat_limit',staff_seat_limit,'student_seat_limit',student_seat_limit,'contact_enc',contact_enc,'disabled_at',disabled_at,'disabled_by',disabled_by,'disabled_reason',disabled_reason,'created_at',created_at,'created_by',created_by,'updated_at',updated_at,'updated_by',updated_by,'version',version,'deleted_at',deleted_at,'gallery_storage_limit',gallery_storage_limit) FROM tenants",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT COALESCE(tenant_id,'platform'),'brow_'||lower(hex(randomblob(12))),?, 'tenant_slug_aliases',json_array(slug),json_object('slug',slug,'tenant_id',tenant_id,'expires_at',expires_at) FROM tenant_slug_aliases",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT COALESCE(tenant_id,'platform'),'brow_'||lower(hex(randomblob(12))),?, 'tenant_domains',json_array(domain),json_object('domain',domain,'tenant_id',tenant_id,'kind',kind,'verified',verified) FROM tenant_domains",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT COALESCE(tenant_id,'platform'),'brow_'||lower(hex(randomblob(12))),?, 'tenant_branding',json_array(tenant_id,id),json_object('tenant_id',tenant_id,'id',id,'display_name',display_name,'logo',logo,'login_bg',login_bg,'theme_color',theme_color,'welcome_text',welcome_text,'consultant_qr',consultant_qr,'created_at',created_at,'created_by',created_by,'updated_at',updated_at,'updated_by',updated_by,'version',version,'deleted_at',deleted_at,'contact_text',contact_text) FROM tenant_branding",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT COALESCE(tenant_id,'platform'),'brow_'||lower(hex(randomblob(12))),?, 'tenant_modules',json_array(tenant_id,id),json_object('tenant_id',tenant_id,'id',id,'enabled',enabled,'created_at',created_at,'created_by',created_by,'updated_at',updated_at,'updated_by',updated_by,'version',version,'deleted_at',deleted_at) FROM tenant_modules",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT COALESCE(tenant_id,'platform'),'brow_'||lower(hex(randomblob(12))),?, 'tenant_settings',json_array(tenant_id,id),json_object('tenant_id',tenant_id,'id',id,'value',value,'created_at',created_at,'created_by',created_by,'updated_at',updated_at,'updated_by',updated_by,'version',version,'deleted_at',deleted_at) FROM tenant_settings",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT COALESCE(tenant_id,'platform'),'brow_'||lower(hex(randomblob(12))),?, 'tenant_role_rights',json_array(tenant_id,id),json_object('tenant_id',tenant_id,'id',id,'role',role,'module',module,'action',action,'allowed',allowed,'created_at',created_at,'created_by',created_by,'updated_at',updated_at,'updated_by',updated_by,'version',version,'deleted_at',deleted_at) FROM tenant_role_rights",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT COALESCE(tenant_id,'platform'),'brow_'||lower(hex(randomblob(12))),?, 'users',json_array(tenant_id,id),json_object('tenant_id',tenant_id,'id',id,'phone_hmac',phone_hmac,'phone_enc',phone_enc,'phone_last4',phone_last4,'name',name,'roles',roles,'teacher_id',teacher_id,'student_id',student_id,'salt',salt,'digest',digest,'iterations',iterations,'must_change',must_change,'active',active,'created_at',created_at,'created_by',created_by,'updated_at',updated_at,'updated_by',updated_by,'version',version,'deleted_at',deleted_at) FROM users",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT COALESCE(tenant_id,'platform'),'brow_'||lower(hex(randomblob(12))),?, 'sessions',json_array(tenant_id,id),json_object('tenant_id',tenant_id,'id',id,'token_hash',token_hash,'user_id',user_id,'expires_at',expires_at,'last_seen_at',last_seen_at,'idle_ms',idle_ms,'ip',ip,'ua',ua,'created_at',created_at,'created_by',created_by,'updated_at',updated_at,'updated_by',updated_by,'version',version,'deleted_at',deleted_at) FROM sessions",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT 'platform','brow_'||lower(hex(randomblob(12))),?, 'security_limits',json_array(key),json_object('key',key,'count',count,'window_start',window_start,'locked_until',locked_until) FROM security_limits",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT COALESCE(tenant_id,'platform'),'brow_'||lower(hex(randomblob(12))),?, 'auth_log',json_array(tenant_id,id),json_object('tenant_id',tenant_id,'id',id,'at',at,'user_id',user_id,'phone_last4',phone_last4,'event',event,'ip',ip,'ua',ua) FROM auth_log",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT COALESCE(tenant_id,'platform'),'brow_'||lower(hex(randomblob(12))),?, 'audit_log',json_array(tenant_id,id),json_object('tenant_id',tenant_id,'id',id,'at',at,'actor_id',actor_id,'actor_label',actor_label,'module',module,'action',action,'entity_id',entity_id,'summary',summary,'before_json',before_json,'after_json',after_json,'money_version',money_version) FROM audit_log",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT 'platform','brow_'||lower(hex(randomblob(12))),?, 'platform_admins',json_array(id),json_object('id',id,'username',username,'salt',salt,'digest',digest,'totp_enc',totp_enc,'last_totp_step',last_totp_step,'active',active,'created_at',created_at,'role',role) FROM platform_admins",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT 'platform','brow_'||lower(hex(randomblob(12))),?, 'platform_sessions',json_array(token_hash),json_object('token_hash',token_hash,'admin_id',admin_id,'expires_at',expires_at,'last_seen_at',last_seen_at,'ip',ip,'ua',ua) FROM platform_sessions",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT COALESCE(tenant_id,'platform'),'brow_'||lower(hex(randomblob(12))),?, 'platform_audit',json_array(id),json_object('id',id,'at',at,'admin_id',admin_id,'action',action,'tenant_id',tenant_id,'target',target,'detail',detail,'reason',reason,'ip',ip) FROM platform_audit",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT 'platform','brow_'||lower(hex(randomblob(12))),?, 'platform_state',json_array(id),json_object('id',id,'value',value) FROM platform_state",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT COALESCE(tenant_id,'platform'),'brow_'||lower(hex(randomblob(12))),?, 'students',json_array(tenant_id,id),json_object('tenant_id',tenant_id,'id',id,'name',name,'gender',gender,'birth_year',birth_year,'school',school,'grade',grade,'direction',direction,'phone_enc',phone_enc,'parent_name',parent_name,'parent_phone_enc',parent_phone_enc,'status',status,'notes',notes,'sort_order',sort_order,'created_at',created_at,'created_by',created_by,'updated_at',updated_at,'updated_by',updated_by,'version',version,'deleted_at',deleted_at,'billing_mode',billing_mode) FROM students",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT COALESCE(tenant_id,'platform'),'brow_'||lower(hex(randomblob(12))),?, 'teachers',json_array(tenant_id,id),json_object('tenant_id',tenant_id,'id',id,'name',name,'phone_enc',phone_enc,'subjects',subjects,'employment',employment,'show_in_timetable',show_in_timetable,'status',status,'sort_order',sort_order,'created_at',created_at,'created_by',created_by,'updated_at',updated_at,'updated_by',updated_by,'version',version,'deleted_at',deleted_at) FROM teachers",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT COALESCE(tenant_id,'platform'),'brow_'||lower(hex(randomblob(12))),?, 'course_categories',json_array(tenant_id,id),json_object('tenant_id',tenant_id,'id',id,'name',name,'color',color,'active',active,'sort_order',sort_order,'created_at',created_at,'created_by',created_by,'updated_at',updated_at,'updated_by',updated_by,'version',version,'deleted_at',deleted_at) FROM course_categories",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT COALESCE(tenant_id,'platform'),'brow_'||lower(hex(randomblob(12))),?, 'course_types',json_array(tenant_id,id),json_object('tenant_id',tenant_id,'id',id,'name',name,'category_id',category_id,'format',format,'default_minutes',default_minutes,'units_per_lesson',units_per_lesson,'capacity',capacity,'active',active,'sort_order',sort_order,'created_at',created_at,'created_by',created_by,'updated_at',updated_at,'updated_by',updated_by,'version',version,'deleted_at',deleted_at) FROM course_types",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT COALESCE(tenant_id,'platform'),'brow_'||lower(hex(randomblob(12))),?, 'locations',json_array(tenant_id,id),json_object('tenant_id',tenant_id,'id',id,'name',name,'campus',campus,'offsite',offsite,'capacity',capacity,'active',active,'sort_order',sort_order,'created_at',created_at,'created_by',created_by,'updated_at',updated_at,'updated_by',updated_by,'version',version,'deleted_at',deleted_at) FROM locations",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT COALESCE(tenant_id,'platform'),'brow_'||lower(hex(randomblob(12))),?, 'student_schedule_blocks',json_array(tenant_id,id),json_object('tenant_id',tenant_id,'id',id,'student_id',student_id,'weekday',weekday,'start_time',start_time,'end_time',end_time,'label',label,'active',active,'created_at',created_at,'created_by',created_by,'updated_at',updated_at,'updated_by',updated_by,'version',version,'deleted_at',deleted_at) FROM student_schedule_blocks",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT COALESCE(tenant_id,'platform'),'brow_'||lower(hex(randomblob(12))),?, 'schedule_templates',json_array(tenant_id,id),json_object('tenant_id',tenant_id,'id',id,'teacher_id',teacher_id,'assistant_id',assistant_id,'course_type_id',course_type_id,'location_id',location_id,'weekday',weekday,'start_time',start_time,'duration',duration,'units',units,'mode',mode,'date_from',date_from,'date_to',date_to,'active',active,'note',note,'created_at',created_at,'created_by',created_by,'updated_at',updated_at,'updated_by',updated_by,'version',version,'deleted_at',deleted_at,'class_id',class_id) FROM schedule_templates",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT COALESCE(tenant_id,'platform'),'brow_'||lower(hex(randomblob(12))),?, 'schedule_enrollments',json_array(tenant_id,id),json_object('tenant_id',tenant_id,'id',id,'template_id',template_id,'student_id',student_id,'date_from',date_from,'date_to',date_to,'created_at',created_at,'created_by',created_by,'updated_at',updated_at,'updated_by',updated_by,'version',version,'deleted_at',deleted_at) FROM schedule_enrollments",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT COALESCE(tenant_id,'platform'),'brow_'||lower(hex(randomblob(12))),?, 'lessons',json_array(tenant_id,id),json_object('tenant_id',tenant_id,'id',id,'start_at',start_at,'duration',duration,'units',units,'teacher_id',teacher_id,'assistant_id',assistant_id,'course_type_id',course_type_id,'location_id',location_id,'mode',mode,'status',status,'template_id',template_id,'occurrence_date',occurrence_date,'note',note,'created_at',created_at,'created_by',created_by,'updated_at',updated_at,'updated_by',updated_by,'version',version,'deleted_at',deleted_at,'teacher_paid',teacher_paid,'format',format,'override_rate',override_rate,'override_basis',override_basis,'locked_rate',locked_rate,'current_submission_id',current_submission_id,'class_id',class_id) FROM lessons",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT COALESCE(tenant_id,'platform'),'brow_'||lower(hex(randomblob(12))),?, 'lesson_participants',json_array(tenant_id,id),json_object('tenant_id',tenant_id,'id',id,'lesson_id',lesson_id,'student_id',student_id,'attendance',attendance,'deducted',deducted,'package_id',package_id,'makeup_for',makeup_for,'created_at',created_at,'created_by',created_by,'updated_at',updated_at,'updated_by',updated_by,'version',version,'deleted_at',deleted_at) FROM lesson_participants",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT COALESCE(tenant_id,'platform'),'brow_'||lower(hex(randomblob(12))),?, 'packages',json_array(tenant_id,id),json_object('tenant_id',tenant_id,'id',id,'student_id',student_id,'course_type_id',course_type_id,'units_total',units_total,'valid_from',valid_from,'valid_to',valid_to,'status',status,'created_at',created_at,'created_by',created_by,'updated_at',updated_at,'updated_by',updated_by,'version',version,'deleted_at',deleted_at,'stage_id',stage_id,'purchase_date',purchase_date,'scope_kind',scope_kind,'category_id',category_id,'unit_price',unit_price,'amount',amount) FROM packages",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT COALESCE(tenant_id,'platform'),'brow_'||lower(hex(randomblob(12))),?, 'tenant_data_versions',json_array(tenant_id),json_object('tenant_id',tenant_id,'version',version) FROM tenant_data_versions",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT COALESCE(tenant_id,'platform'),'brow_'||lower(hex(randomblob(12))),?, 'student_stages',json_array(tenant_id,id),json_object('tenant_id',tenant_id,'id',id,'student_id',student_id,'name',name,'date_from',date_from,'date_to',date_to,'goal',goal,'status',status,'created_at',created_at,'created_by',created_by,'updated_at',updated_at,'updated_by',updated_by,'version',version,'deleted_at',deleted_at) FROM student_stages",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT COALESCE(tenant_id,'platform'),'brow_'||lower(hex(randomblob(12))),?, 'package_transactions',json_array(tenant_id,id),json_object('tenant_id',tenant_id,'id',id,'package_id',package_id,'student_id',student_id,'delta',delta,'type',type,'date',date,'participant_id',participant_id,'reference_id',reference_id,'note',note,'created_at',created_at,'created_by',created_by,'updated_at',updated_at,'updated_by',updated_by,'version',version,'deleted_at',deleted_at) FROM package_transactions",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT COALESCE(tenant_id,'platform'),'brow_'||lower(hex(randomblob(12))),?, 'student_payments',json_array(tenant_id,id),json_object('tenant_id',tenant_id,'id',id,'student_id',student_id,'package_id',package_id,'paid_at',paid_at,'method',method,'note',note,'created_at',created_at,'created_by',created_by,'updated_at',updated_at,'updated_by',updated_by,'version',version,'deleted_at',deleted_at,'amount',amount) FROM student_payments",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT COALESCE(tenant_id,'platform'),'brow_'||lower(hex(randomblob(12))),?, 'makeup_links',json_array(tenant_id,id),json_object('tenant_id',tenant_id,'id',id,'original_participant_id',original_participant_id,'target_participant_id',target_participant_id,'target_lesson_id',target_lesson_id,'note',note,'created_at',created_at,'created_by',created_by,'updated_at',updated_at,'updated_by',updated_by,'version',version,'deleted_at',deleted_at) FROM makeup_links",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT COALESCE(tenant_id,'platform'),'brow_'||lower(hex(randomblob(12))),?, 'settlements',json_array(tenant_id,id),json_object('tenant_id',tenant_id,'id',id,'month',month,'locked',locked,'summary',summary,'created_at',created_at,'created_by',created_by,'updated_at',updated_at,'updated_by',updated_by,'version',version,'deleted_at',deleted_at,'status',status,'submitted_by',submitted_by,'submitted_at',submitted_at,'submitted_revision',submitted_revision,'approved_by',approved_by,'approved_at',approved_at,'snapshot_token',snapshot_token,'reason',reason,'total_amount',total_amount,'tuition_amount',tuition_amount,'cost_amount',cost_amount,'profit_amount',profit_amount,'submitted_fingerprint',submitted_fingerprint) FROM settlements",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT COALESCE(tenant_id,'platform'),'brow_'||lower(hex(randomblob(12))),?, 'credit_operations',json_array(tenant_id,id),json_object('tenant_id',tenant_id,'id',id,'actor_id',actor_id,'request_hash',request_hash,'response_json',response_json,'created_at',created_at,'created_by',created_by,'updated_at',updated_at,'updated_by',updated_by,'version',version,'deleted_at',deleted_at) FROM credit_operations",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT COALESCE(tenant_id,'platform'),'brow_'||lower(hex(randomblob(12))),?, 'teacher_rates',json_array(tenant_id,id),json_object('tenant_id',tenant_id,'id',id,'teacher_id',teacher_id,'course_type_id',course_type_id,'format',format,'rate_basis',rate_basis,'rate',rate,'effective_from',effective_from,'effective_to',effective_to,'created_at',created_at,'created_by',created_by,'updated_at',updated_at,'updated_by',updated_by,'version',version,'deleted_at',deleted_at) FROM teacher_rates",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT COALESCE(tenant_id,'platform'),'brow_'||lower(hex(randomblob(12))),?, 'teacher_payments',json_array(tenant_id,id),json_object('tenant_id',tenant_id,'id',id,'teacher_id',teacher_id,'month',month,'amount',amount,'paid_at',paid_at,'note',note,'created_at',created_at,'created_by',created_by,'updated_at',updated_at,'updated_by',updated_by,'version',version,'deleted_at',deleted_at) FROM teacher_payments",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT COALESCE(tenant_id,'platform'),'brow_'||lower(hex(randomblob(12))),?, 'teacher_adjustments',json_array(tenant_id,id),json_object('tenant_id',tenant_id,'id',id,'teacher_id',teacher_id,'month',month,'amount',amount,'reason',reason,'created_at',created_at,'created_by',created_by,'updated_at',updated_at,'updated_by',updated_by,'version',version,'deleted_at',deleted_at) FROM teacher_adjustments",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT COALESCE(tenant_id,'platform'),'brow_'||lower(hex(randomblob(12))),?, 'other_costs',json_array(tenant_id,id),json_object('tenant_id',tenant_id,'id',id,'date',date,'category',category,'amount',amount,'note',note,'created_at',created_at,'created_by',created_by,'updated_at',updated_at,'updated_by',updated_by,'version',version,'deleted_at',deleted_at) FROM other_costs",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT COALESCE(tenant_id,'platform'),'brow_'||lower(hex(randomblob(12))),?, 'payroll_snapshots',json_array(tenant_id,id),json_object('tenant_id',tenant_id,'id',id,'month',month,'snapshot_token',snapshot_token,'lesson_id',lesson_id,'teacher_id',teacher_id,'rate',rate,'rate_basis',rate_basis,'quantity',quantity,'amount',amount,'lesson_json',lesson_json,'created_at',created_at,'created_by',created_by,'updated_at',updated_at,'updated_by',updated_by,'version',version,'deleted_at',deleted_at) FROM payroll_snapshots",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT COALESCE(tenant_id,'platform'),'brow_'||lower(hex(randomblob(12))),?, 'lesson_submissions',json_array(tenant_id,id),json_object('tenant_id',tenant_id,'id',id,'lesson_id',lesson_id,'kind',kind,'status',status,'public_text',public_text,'homework',homework,'base_fingerprint',base_fingerprint,'comment_fingerprint',comment_fingerprint,'submitted_by',submitted_by,'submitted_at',submitted_at,'reviewed_by',reviewed_by,'reviewed_at',reviewed_at,'reason',reason,'created_at',created_at,'created_by',created_by,'updated_at',updated_at,'updated_by',updated_by,'version',version,'deleted_at',deleted_at) FROM lesson_submissions",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT COALESCE(tenant_id,'platform'),'brow_'||lower(hex(randomblob(12))),?, 'submission_people',json_array(tenant_id,id),json_object('tenant_id',tenant_id,'id',id,'submission_id',submission_id,'participant_id',participant_id,'student_id',student_id,'attendance',attendance,'comment',comment,'created_at',created_at,'created_by',created_by,'updated_at',updated_at,'updated_by',updated_by,'version',version,'deleted_at',deleted_at) FROM submission_people",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT COALESCE(tenant_id,'platform'),'brow_'||lower(hex(randomblob(12))),?, 'lesson_comments',json_array(tenant_id,id),json_object('tenant_id',tenant_id,'id',id,'lesson_id',lesson_id,'student_id',student_id,'text',text,'homework',homework,'published_by',published_by,'created_at',created_at,'created_by',created_by,'updated_at',updated_at,'updated_by',updated_by,'version',version,'deleted_at',deleted_at) FROM lesson_comments",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT COALESCE(tenant_id,'platform'),'brow_'||lower(hex(randomblob(12))),?, 'classes',json_array(tenant_id,id),json_object('tenant_id',tenant_id,'id',id,'name',name,'course_type_id',course_type_id,'teacher_id',teacher_id,'location_id',location_id,'date_from',date_from,'date_to',date_to,'status',status,'note',note,'created_at',created_at,'created_by',created_by,'updated_at',updated_at,'updated_by',updated_by,'version',version,'deleted_at',deleted_at) FROM classes",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT COALESCE(tenant_id,'platform'),'brow_'||lower(hex(randomblob(12))),?, 'class_members',json_array(tenant_id,id),json_object('tenant_id',tenant_id,'id',id,'class_id',class_id,'student_id',student_id,'created_at',created_at,'created_by',created_by,'updated_at',updated_at,'updated_by',updated_by,'version',version,'deleted_at',deleted_at) FROM class_members",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT COALESCE(tenant_id,'platform'),'brow_'||lower(hex(randomblob(12))),?, 'followup_notes',json_array(tenant_id,id),json_object('tenant_id',tenant_id,'id',id,'student_id',student_id,'at',at,'content',content,'created_at',created_at,'created_by',created_by,'updated_at',updated_at,'updated_by',updated_by,'version',version,'deleted_at',deleted_at) FROM followup_notes",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT COALESCE(tenant_id,'platform'),'brow_'||lower(hex(randomblob(12))),?, 'followup_tasks',json_array(tenant_id,id),json_object('tenant_id',tenant_id,'id',id,'student_id',student_id,'title',title,'due_date',due_date,'assignee_id',assignee_id,'legacy_owner',legacy_owner,'done',done,'created_at',created_at,'created_by',created_by,'updated_at',updated_at,'updated_by',updated_by,'version',version,'deleted_at',deleted_at) FROM followup_tasks",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT COALESCE(tenant_id,'platform'),'brow_'||lower(hex(randomblob(12))),?, 'student_routines',json_array(tenant_id,id),json_object('tenant_id',tenant_id,'id',id,'student_id',student_id,'weekday',weekday,'time',time,'content',content,'created_at',created_at,'created_by',created_by,'updated_at',updated_at,'updated_by',updated_by,'version',version,'deleted_at',deleted_at) FROM student_routines",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT COALESCE(tenant_id,'platform'),'brow_'||lower(hex(randomblob(12))),?, 'leads',json_array(tenant_id,id),json_object('tenant_id',tenant_id,'id',id,'name',name,'phone_enc',phone_enc,'parent_phone_enc',parent_phone_enc,'phone_last4',phone_last4,'source',source,'stage',stage,'next_followup',next_followup,'trial_at',trial_at,'grade',grade,'direction',direction,'note',note,'student_id',student_id,'created_at',created_at,'created_by',created_by,'updated_at',updated_at,'updated_by',updated_by,'version',version,'deleted_at',deleted_at) FROM leads",

  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT COALESCE(tenant_id,'platform'),'brow_'||lower(hex(randomblob(12))),?, 'announcement_reads',json_array(tenant_id,id),json_object('tenant_id',tenant_id,'id',id,'announcement_id',announcement_id,'user_id',user_id,'created_at',created_at,'created_by',created_by,'updated_at',updated_at,'updated_by',updated_by,'version',version,'deleted_at',deleted_at) FROM announcement_reads",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT 'platform','brow_'||lower(hex(randomblob(12))),?, 'platform_announcements',json_array(id),json_object('id',id,'title',title,'content',content,'roles',roles,'starts_at',starts_at,'ends_at',ends_at,'created_at',created_at,'created_by',created_by,'withdrawn_at',withdrawn_at,'withdrawn_by',withdrawn_by,'withdrawal_reason',withdrawal_reason) FROM platform_announcements",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT COALESCE(tenant_id,'platform'),'brow_'||lower(hex(randomblob(12))),?, 'announcement_targets',json_array(tenant_id,id),json_object('tenant_id',tenant_id,'id',id,'announcement_id',announcement_id) FROM announcement_targets",
  "INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT 'platform','brow_'||lower(hex(randomblob(12))),?, 'backup_runs',json_array(id),json_object('id',id,'at',at,'status',status,'detail',detail) FROM backup_runs",

];
// Identity additions extend the full snapshot; all SQL remains in this repository.
const identityBackupNames = ['subject_packs','subject_pack_versions','setting_template_refs','style_version_meta','style_version_tenants','style_assets','style_defaults','lesson_submissions', 'lesson_comments', 'growth_repertoire', 'growth_feedback_copies',       'ai_settings', 'ai_quota_daily', 'ai_requests', 'ai_quota_holds', 'ai_usage',      'style_packs', 'style_pack_versions', 'style_pack_scopes', 'compliance_terms', 'tenant_compliance_terms', 'offer_courses', 'stage_types', 'report_classes', 'stage_rules', 'calendar_nodes', 'course_rules', 'tenant_profile', 'tenant_price_lists', 'report_dimensions', 'tenant_brand', 'gallery_images', 'setting_asset_refs', 'setting_imports', 'ai_suggestions', 'setting_changes', 'guardian_links', 'login_choices', 'platform_phone_index', 'tenant_subjects', 'tenant_ai_overrides', 'users', 'sessions', 'students'];
for (let i=snapshotCaptureSql.length-1;i>=0;i--) {
  if (identityBackupNames.some(name => new RegExp("\\?,\\s*'"+name+"',").test(snapshotCaptureSql[i]))) snapshotCaptureSql.splice(i,1);
}
for (const table of identityBackupNames) {
  const spec=backupTables[table], keys=spec.pk || ['tenant_id','id'];
  snapshotCaptureSql.push(`INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json)
    SELECT ${spec.tenant?'tenant_id':"'platform'"},'brow_'||lower(hex(randomblob(12))),?,'${table}',json_array(${keys.join(',')}),
    json_object(${spec.columns.map(c=>`'${c}',${c}`).join(',')}) FROM ${table}`);
}
const snapshotSql = {

  tenants: "SELECT * FROM tenants",
  tenant_slug_aliases: "SELECT * FROM tenant_slug_aliases WHERE tenant_id=?",
  tenant_domains: "SELECT * FROM tenant_domains WHERE tenant_id=?",
  tenant_branding: "SELECT * FROM tenant_branding WHERE tenant_id=?",
  tenant_modules: "SELECT * FROM tenant_modules WHERE tenant_id=?",
  tenant_settings: "SELECT * FROM tenant_settings WHERE tenant_id=?",
  tenant_role_rights: "SELECT * FROM tenant_role_rights WHERE tenant_id=?",
  users: "SELECT * FROM users WHERE tenant_id=?",
  sessions: "SELECT * FROM sessions WHERE tenant_id=?",
  security_limits: "SELECT * FROM security_limits",
  auth_log: "SELECT * FROM auth_log WHERE tenant_id=?",
  audit_log: "SELECT * FROM audit_log WHERE tenant_id=?",
  platform_admins: "SELECT * FROM platform_admins",
  platform_sessions: "SELECT * FROM platform_sessions",
  platform_audit: "SELECT * FROM platform_audit WHERE tenant_id=?",
  platform_state: "SELECT * FROM platform_state",
  students: "SELECT * FROM students WHERE tenant_id=?",
  teachers: "SELECT * FROM teachers WHERE tenant_id=?",
  course_categories: "SELECT * FROM course_categories WHERE tenant_id=?",
  course_types: "SELECT * FROM course_types WHERE tenant_id=?",
  locations: "SELECT * FROM locations WHERE tenant_id=?",
  student_schedule_blocks:
    "SELECT * FROM student_schedule_blocks WHERE tenant_id=?",
  schedule_templates: "SELECT * FROM schedule_templates WHERE tenant_id=?",
  schedule_enrollments: "SELECT * FROM schedule_enrollments WHERE tenant_id=?",
  lessons: "SELECT * FROM lessons WHERE tenant_id=?",
  lesson_participants: "SELECT * FROM lesson_participants WHERE tenant_id=?",
  packages: "SELECT * FROM packages WHERE tenant_id=?",
  tenant_data_versions: "SELECT * FROM tenant_data_versions WHERE tenant_id=?",
  student_stages: "SELECT * FROM student_stages WHERE tenant_id=?",
  package_transactions: "SELECT * FROM package_transactions WHERE tenant_id=?",
  student_payments: "SELECT * FROM student_payments WHERE tenant_id=?",
  makeup_links: "SELECT * FROM makeup_links WHERE tenant_id=?",
  settlements: "SELECT * FROM settlements WHERE tenant_id=?",
  credit_operations: "SELECT * FROM credit_operations WHERE tenant_id=?",
  teacher_rates: "SELECT * FROM teacher_rates WHERE tenant_id=?",
  teacher_payments: "SELECT * FROM teacher_payments WHERE tenant_id=?",
  teacher_adjustments: "SELECT * FROM teacher_adjustments WHERE tenant_id=?",
  other_costs: "SELECT * FROM other_costs WHERE tenant_id=?",
  payroll_snapshots: "SELECT * FROM payroll_snapshots WHERE tenant_id=?",
  lesson_submissions: "SELECT * FROM lesson_submissions WHERE tenant_id=?",
  submission_people: "SELECT * FROM submission_people WHERE tenant_id=?",
  lesson_comments: "SELECT * FROM lesson_comments WHERE tenant_id=?",
  classes: "SELECT * FROM classes WHERE tenant_id=?",
  class_members: "SELECT * FROM class_members WHERE tenant_id=?",
  renewal_reminders: "SELECT * FROM renewal_reminders WHERE tenant_id=?",
  followup_notes: "SELECT * FROM followup_notes WHERE tenant_id=?",
  followup_tasks: "SELECT * FROM followup_tasks WHERE tenant_id=?",
  student_routines: "SELECT * FROM student_routines WHERE tenant_id=?",
  leads: "SELECT * FROM leads WHERE tenant_id=?",

  announcement_reads: "SELECT * FROM announcement_reads WHERE tenant_id=?",
  platform_announcements: "SELECT * FROM platform_announcements",
  announcement_targets: "SELECT * FROM announcement_targets WHERE tenant_id=?",
  backup_runs: "SELECT * FROM backup_runs",
};
const restoreSql = {
  ...creditTableSql((table) => ({ clear: `DELETE FROM ${table} WHERE tenant_id=?` })),
  renewal_reminders: {
    clear: "DELETE FROM renewal_reminders WHERE tenant_id=?",
    insert:
      "INSERT INTO renewal_reminders(tenant_id,id,student_id,course_type_id,scope_kind,scope_id,package_ids_json,channel,sent_at,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.student_id'),json_extract(value,'$.course_type_id'),json_extract(value,'$.scope_kind'),json_extract(value,'$.scope_id'),json_extract(value,'$.package_ids_json'),json_extract(value,'$.channel'),json_extract(value,'$.sent_at'),json_extract(value,'$.created_at'),json_extract(value,'$.created_by'),json_extract(value,'$.updated_at'),json_extract(value,'$.updated_by'),json_extract(value,'$.version'),json_extract(value,'$.deleted_at') FROM json_each(?)",
  },
  students: {
    clear: "DELETE FROM students WHERE tenant_id=?",
    insert:
      "INSERT INTO students(tenant_id,id,name,gender,birth_year,school,grade,direction,phone_enc,parent_name,parent_phone_enc,status,notes,sort_order,created_at,created_by,updated_at,updated_by,version,deleted_at,billing_mode,report_class_id,source_lead_id,nickname,parent_consent_media) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.name'),json_extract(value,'$.gender'),json_extract(value,'$.birth_year'),json_extract(value,'$.school'),json_extract(value,'$.grade'),json_extract(value,'$.direction'),json_extract(value,'$.phone_enc'),json_extract(value,'$.parent_name'),json_extract(value,'$.parent_phone_enc'),json_extract(value,'$.status'),json_extract(value,'$.notes'),json_extract(value,'$.sort_order'),json_extract(value,'$.created_at'),json_extract(value,'$.created_by'),json_extract(value,'$.updated_at'),json_extract(value,'$.updated_by'),json_extract(value,'$.version'),json_extract(value,'$.deleted_at'),json_extract(value,'$.billing_mode'),json_extract(value,'$.report_class_id'),json_extract(value,'$.source_lead_id'),COALESCE(json_extract(value,'$.nickname'),'X 同学'),COALESCE(json_extract(value,'$.parent_consent_media'),0) FROM json_each(?)",
  },
  teachers: {
    clear: "DELETE FROM teachers WHERE tenant_id=?",
    insert:
      "INSERT INTO teachers(tenant_id,id,name,phone_enc,subjects,employment,status,sort_order,created_at,created_by,updated_at,updated_by,version,deleted_at,show_in_timetable) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.name'),json_extract(value,'$.phone_enc'),json_extract(value,'$.subjects'),json_extract(value,'$.employment'),json_extract(value,'$.status'),json_extract(value,'$.sort_order'),json_extract(value,'$.created_at'),json_extract(value,'$.created_by'),json_extract(value,'$.updated_at'),json_extract(value,'$.updated_by'),json_extract(value,'$.version'),json_extract(value,'$.deleted_at'),COALESCE(json_extract(value,'$.show_in_timetable'),1) FROM json_each(?)",
  },
  course_categories: {
    clear: "DELETE FROM course_categories WHERE tenant_id=?",
    insert:
      "INSERT INTO course_categories(tenant_id,id,name,color,active,sort_order,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.name'),json_extract(value,'$.color'),json_extract(value,'$.active'),json_extract(value,'$.sort_order'),json_extract(value,'$.created_at'),json_extract(value,'$.created_by'),json_extract(value,'$.updated_at'),json_extract(value,'$.updated_by'),json_extract(value,'$.version'),json_extract(value,'$.deleted_at') FROM json_each(?)",
  },
  course_types: {
    clear: "DELETE FROM course_types WHERE tenant_id=?",
    insert:
      "INSERT INTO course_types(tenant_id,id,name,category_id,format,default_minutes,units_per_lesson,capacity,active,sort_order,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.name'),json_extract(value,'$.category_id'),json_extract(value,'$.format'),json_extract(value,'$.default_minutes'),json_extract(value,'$.units_per_lesson'),json_extract(value,'$.capacity'),json_extract(value,'$.active'),json_extract(value,'$.sort_order'),json_extract(value,'$.created_at'),json_extract(value,'$.created_by'),json_extract(value,'$.updated_at'),json_extract(value,'$.updated_by'),json_extract(value,'$.version'),json_extract(value,'$.deleted_at') FROM json_each(?)",
  },
  locations: {
    clear: "DELETE FROM locations WHERE tenant_id=?",
    insert:
      "INSERT INTO locations(tenant_id,id,name,campus,offsite,capacity,active,sort_order,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.name'),json_extract(value,'$.campus'),json_extract(value,'$.offsite'),json_extract(value,'$.capacity'),json_extract(value,'$.active'),json_extract(value,'$.sort_order'),json_extract(value,'$.created_at'),json_extract(value,'$.created_by'),json_extract(value,'$.updated_at'),json_extract(value,'$.updated_by'),json_extract(value,'$.version'),json_extract(value,'$.deleted_at') FROM json_each(?)",
  },
  student_schedule_blocks: {
    clear: "DELETE FROM student_schedule_blocks WHERE tenant_id=?",
    insert:
      "INSERT INTO student_schedule_blocks(tenant_id,id,student_id,weekday,start_time,end_time,label,active,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.student_id'),json_extract(value,'$.weekday'),json_extract(value,'$.start_time'),json_extract(value,'$.end_time'),json_extract(value,'$.label'),json_extract(value,'$.active'),json_extract(value,'$.created_at'),json_extract(value,'$.created_by'),json_extract(value,'$.updated_at'),json_extract(value,'$.updated_by'),json_extract(value,'$.version'),json_extract(value,'$.deleted_at') FROM json_each(?)",
  },
  schedule_templates: {
    clear: "DELETE FROM schedule_templates WHERE tenant_id=?",
    insert:
      "INSERT INTO schedule_templates(tenant_id,id,teacher_id,assistant_id,course_type_id,location_id,weekday,start_time,duration,units,mode,date_from,date_to,active,note,created_at,created_by,updated_at,updated_by,version,deleted_at,class_id) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.teacher_id'),json_extract(value,'$.assistant_id'),json_extract(value,'$.course_type_id'),json_extract(value,'$.location_id'),json_extract(value,'$.weekday'),json_extract(value,'$.start_time'),json_extract(value,'$.duration'),json_extract(value,'$.units'),json_extract(value,'$.mode'),json_extract(value,'$.date_from'),json_extract(value,'$.date_to'),json_extract(value,'$.active'),json_extract(value,'$.note'),json_extract(value,'$.created_at'),json_extract(value,'$.created_by'),json_extract(value,'$.updated_at'),json_extract(value,'$.updated_by'),json_extract(value,'$.version'),json_extract(value,'$.deleted_at'),json_extract(value,'$.class_id') FROM json_each(?)",
  },
  schedule_enrollments: {
    clear: "DELETE FROM schedule_enrollments WHERE tenant_id=?",
    insert:
      "INSERT INTO schedule_enrollments(tenant_id,id,template_id,student_id,date_from,date_to,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.template_id'),json_extract(value,'$.student_id'),json_extract(value,'$.date_from'),json_extract(value,'$.date_to'),json_extract(value,'$.created_at'),json_extract(value,'$.created_by'),json_extract(value,'$.updated_at'),json_extract(value,'$.updated_by'),json_extract(value,'$.version'),json_extract(value,'$.deleted_at') FROM json_each(?)",
  },
  lessons: {
    clear: "DELETE FROM lessons WHERE tenant_id=?",
    insert:
      "INSERT INTO lessons(tenant_id,id,start_at,duration,units,teacher_id,assistant_id,course_type_id,location_id,mode,status,template_id,occurrence_date,note,created_at,created_by,updated_at,updated_by,version,deleted_at,teacher_paid,format,override_rate,override_basis,locked_rate,current_submission_id,class_id) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.start_at'),json_extract(value,'$.duration'),json_extract(value,'$.units'),json_extract(value,'$.teacher_id'),json_extract(value,'$.assistant_id'),json_extract(value,'$.course_type_id'),json_extract(value,'$.location_id'),json_extract(value,'$.mode'),json_extract(value,'$.status'),json_extract(value,'$.template_id'),json_extract(value,'$.occurrence_date'),json_extract(value,'$.note'),json_extract(value,'$.created_at'),json_extract(value,'$.created_by'),json_extract(value,'$.updated_at'),json_extract(value,'$.updated_by'),json_extract(value,'$.version'),json_extract(value,'$.deleted_at'),json_extract(value,'$.teacher_paid'),json_extract(value,'$.format'),json_extract(value,'$.override_rate'),json_extract(value,'$.override_basis'),json_extract(value,'$.locked_rate'),json_extract(value,'$.current_submission_id'),json_extract(value,'$.class_id') FROM json_each(?)",
  },
  lesson_participants: {
    clear: "DELETE FROM lesson_participants WHERE tenant_id=?",
    insert:
      "INSERT INTO lesson_participants(tenant_id,id,lesson_id,student_id,attendance,deducted,package_id,makeup_for,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.lesson_id'),json_extract(value,'$.student_id'),json_extract(value,'$.attendance'),json_extract(value,'$.deducted'),json_extract(value,'$.package_id'),json_extract(value,'$.makeup_for'),json_extract(value,'$.created_at'),json_extract(value,'$.created_by'),json_extract(value,'$.updated_at'),json_extract(value,'$.updated_by'),json_extract(value,'$.version'),json_extract(value,'$.deleted_at') FROM json_each(?)",
  },
  packages: {
    clear: "DELETE FROM packages WHERE tenant_id=?",
    insert:
      "INSERT INTO packages(tenant_id,id,student_id,course_type_id,units_total,valid_from,valid_to,status,created_at,created_by,updated_at,updated_by,version,deleted_at,stage_id,purchase_date,scope_kind,category_id,unit_price,amount) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.student_id'),json_extract(value,'$.course_type_id'),json_extract(value,'$.units_total'),json_extract(value,'$.valid_from'),json_extract(value,'$.valid_to'),json_extract(value,'$.status'),json_extract(value,'$.created_at'),json_extract(value,'$.created_by'),json_extract(value,'$.updated_at'),json_extract(value,'$.updated_by'),json_extract(value,'$.version'),json_extract(value,'$.deleted_at'),json_extract(value,'$.stage_id'),json_extract(value,'$.purchase_date'),json_extract(value,'$.scope_kind'),json_extract(value,'$.category_id'),json_extract(value,'$.unit_price'),json_extract(value,'$.amount') FROM json_each(?)",
  },
  student_stages: {
    clear: "DELETE FROM student_stages WHERE tenant_id=?",
    insert:
      "INSERT INTO student_stages(tenant_id,id,student_id,name,date_from,date_to,goal,status,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.student_id'),json_extract(value,'$.name'),json_extract(value,'$.date_from'),json_extract(value,'$.date_to'),json_extract(value,'$.goal'),json_extract(value,'$.status'),json_extract(value,'$.created_at'),json_extract(value,'$.created_by'),json_extract(value,'$.updated_at'),json_extract(value,'$.updated_by'),json_extract(value,'$.version'),json_extract(value,'$.deleted_at') FROM json_each(?)",
  },
  package_transactions: {
    clear: "DELETE FROM package_transactions WHERE tenant_id=?",
    insert:
      "INSERT INTO package_transactions(tenant_id,id,package_id,student_id,delta,type,date,participant_id,reference_id,note,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.package_id'),json_extract(value,'$.student_id'),json_extract(value,'$.delta'),json_extract(value,'$.type'),json_extract(value,'$.date'),json_extract(value,'$.participant_id'),json_extract(value,'$.reference_id'),json_extract(value,'$.note'),json_extract(value,'$.created_at'),json_extract(value,'$.created_by'),json_extract(value,'$.updated_at'),json_extract(value,'$.updated_by'),json_extract(value,'$.version'),json_extract(value,'$.deleted_at') FROM json_each(?)",
  },
  student_payments: {
    clear: "DELETE FROM student_payments WHERE tenant_id=?",
    insert:
      "INSERT INTO student_payments(tenant_id,id,student_id,package_id,paid_at,method,note,created_at,created_by,updated_at,updated_by,version,deleted_at,amount) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.student_id'),json_extract(value,'$.package_id'),json_extract(value,'$.paid_at'),json_extract(value,'$.method'),json_extract(value,'$.note'),json_extract(value,'$.created_at'),json_extract(value,'$.created_by'),json_extract(value,'$.updated_at'),json_extract(value,'$.updated_by'),json_extract(value,'$.version'),json_extract(value,'$.deleted_at'),json_extract(value,'$.amount') FROM json_each(?)",
  },
  makeup_links: {
    clear: "DELETE FROM makeup_links WHERE tenant_id=?",
    insert:
      "INSERT INTO makeup_links(tenant_id,id,original_participant_id,target_participant_id,target_lesson_id,note,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.original_participant_id'),json_extract(value,'$.target_participant_id'),json_extract(value,'$.target_lesson_id'),json_extract(value,'$.note'),json_extract(value,'$.created_at'),json_extract(value,'$.created_by'),json_extract(value,'$.updated_at'),json_extract(value,'$.updated_by'),json_extract(value,'$.version'),json_extract(value,'$.deleted_at') FROM json_each(?)",
  },
  settlements: {
    clear: "DELETE FROM settlements WHERE tenant_id=?",
    insert:
      "INSERT INTO settlements(tenant_id,id,month,locked,summary,created_at,created_by,updated_at,updated_by,version,deleted_at,status,submitted_by,submitted_at,submitted_revision,approved_by,approved_at,snapshot_token,reason,total_amount,tuition_amount,cost_amount,profit_amount,submitted_fingerprint) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.month'),json_extract(value,'$.locked'),json_extract(value,'$.summary'),json_extract(value,'$.created_at'),json_extract(value,'$.created_by'),json_extract(value,'$.updated_at'),json_extract(value,'$.updated_by'),json_extract(value,'$.version'),json_extract(value,'$.deleted_at'),json_extract(value,'$.status'),json_extract(value,'$.submitted_by'),json_extract(value,'$.submitted_at'),json_extract(value,'$.submitted_revision'),json_extract(value,'$.approved_by'),json_extract(value,'$.approved_at'),json_extract(value,'$.snapshot_token'),json_extract(value,'$.reason'),json_extract(value,'$.total_amount'),json_extract(value,'$.tuition_amount'),json_extract(value,'$.cost_amount'),json_extract(value,'$.profit_amount'),json_extract(value,'$.submitted_fingerprint') FROM json_each(?)",
  },
  credit_operations: {
    clear: "DELETE FROM credit_operations WHERE tenant_id=?",
    insert:
      "INSERT INTO credit_operations(tenant_id,id,actor_id,request_hash,response_json,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.actor_id'),json_extract(value,'$.request_hash'),json_extract(value,'$.response_json'),json_extract(value,'$.created_at'),json_extract(value,'$.created_by'),json_extract(value,'$.updated_at'),json_extract(value,'$.updated_by'),json_extract(value,'$.version'),json_extract(value,'$.deleted_at') FROM json_each(?)",
  },
  teacher_rates: {
    clear: "DELETE FROM teacher_rates WHERE tenant_id=?",
    insert:
      "INSERT INTO teacher_rates(tenant_id,id,teacher_id,course_type_id,format,rate_basis,rate,effective_from,effective_to,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.teacher_id'),json_extract(value,'$.course_type_id'),json_extract(value,'$.format'),json_extract(value,'$.rate_basis'),json_extract(value,'$.rate'),json_extract(value,'$.effective_from'),json_extract(value,'$.effective_to'),json_extract(value,'$.created_at'),json_extract(value,'$.created_by'),json_extract(value,'$.updated_at'),json_extract(value,'$.updated_by'),json_extract(value,'$.version'),json_extract(value,'$.deleted_at') FROM json_each(?)",
  },
  teacher_payments: {
    clear: "DELETE FROM teacher_payments WHERE tenant_id=?",
    insert:
      "INSERT INTO teacher_payments(tenant_id,id,teacher_id,month,amount,paid_at,note,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.teacher_id'),json_extract(value,'$.month'),json_extract(value,'$.amount'),json_extract(value,'$.paid_at'),json_extract(value,'$.note'),json_extract(value,'$.created_at'),json_extract(value,'$.created_by'),json_extract(value,'$.updated_at'),json_extract(value,'$.updated_by'),json_extract(value,'$.version'),json_extract(value,'$.deleted_at') FROM json_each(?)",
  },
  teacher_adjustments: {
    clear: "DELETE FROM teacher_adjustments WHERE tenant_id=?",
    insert:
      "INSERT INTO teacher_adjustments(tenant_id,id,teacher_id,month,amount,reason,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.teacher_id'),json_extract(value,'$.month'),json_extract(value,'$.amount'),json_extract(value,'$.reason'),json_extract(value,'$.created_at'),json_extract(value,'$.created_by'),json_extract(value,'$.updated_at'),json_extract(value,'$.updated_by'),json_extract(value,'$.version'),json_extract(value,'$.deleted_at') FROM json_each(?)",
  },
  other_costs: {
    clear: "DELETE FROM other_costs WHERE tenant_id=?",
    insert:
      "INSERT INTO other_costs(tenant_id,id,date,category,amount,note,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.date'),json_extract(value,'$.category'),json_extract(value,'$.amount'),json_extract(value,'$.note'),json_extract(value,'$.created_at'),json_extract(value,'$.created_by'),json_extract(value,'$.updated_at'),json_extract(value,'$.updated_by'),json_extract(value,'$.version'),json_extract(value,'$.deleted_at') FROM json_each(?)",
  },
  payroll_snapshots: {
    clear: "DELETE FROM payroll_snapshots WHERE tenant_id=?",
    insert:
      "INSERT INTO payroll_snapshots(tenant_id,id,month,snapshot_token,lesson_id,teacher_id,rate,rate_basis,quantity,amount,lesson_json,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.month'),json_extract(value,'$.snapshot_token'),json_extract(value,'$.lesson_id'),json_extract(value,'$.teacher_id'),json_extract(value,'$.rate'),json_extract(value,'$.rate_basis'),json_extract(value,'$.quantity'),json_extract(value,'$.amount'),json_extract(value,'$.lesson_json'),json_extract(value,'$.created_at'),json_extract(value,'$.created_by'),json_extract(value,'$.updated_at'),json_extract(value,'$.updated_by'),json_extract(value,'$.version'),json_extract(value,'$.deleted_at') FROM json_each(?)",
  },
  lesson_submissions: {
    clear: "DELETE FROM lesson_submissions WHERE tenant_id=?",
    insert:
      "INSERT INTO lesson_submissions(tenant_id,id,lesson_id,kind,status,public_text,homework,base_fingerprint,comment_fingerprint,submitted_by,submitted_at,reviewed_by,reviewed_at,reason,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.lesson_id'),json_extract(value,'$.kind'),json_extract(value,'$.status'),json_extract(value,'$.public_text'),json_extract(value,'$.homework'),json_extract(value,'$.base_fingerprint'),json_extract(value,'$.comment_fingerprint'),json_extract(value,'$.submitted_by'),json_extract(value,'$.submitted_at'),json_extract(value,'$.reviewed_by'),json_extract(value,'$.reviewed_at'),json_extract(value,'$.reason'),json_extract(value,'$.created_at'),json_extract(value,'$.created_by'),json_extract(value,'$.updated_at'),json_extract(value,'$.updated_by'),json_extract(value,'$.version'),json_extract(value,'$.deleted_at') FROM json_each(?)",
  },
  submission_people: {
    clear: "DELETE FROM submission_people WHERE tenant_id=?",
    insert:
      "INSERT INTO submission_people(tenant_id,id,submission_id,participant_id,student_id,attendance,comment,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.submission_id'),json_extract(value,'$.participant_id'),json_extract(value,'$.student_id'),json_extract(value,'$.attendance'),json_extract(value,'$.comment'),json_extract(value,'$.created_at'),json_extract(value,'$.created_by'),json_extract(value,'$.updated_at'),json_extract(value,'$.updated_by'),json_extract(value,'$.version'),json_extract(value,'$.deleted_at') FROM json_each(?)",
  },
  lesson_comments: {
    clear: "DELETE FROM lesson_comments WHERE tenant_id=?",
    insert:
      "INSERT INTO lesson_comments(tenant_id,id,lesson_id,student_id,text,homework,published_by,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.lesson_id'),json_extract(value,'$.student_id'),json_extract(value,'$.text'),json_extract(value,'$.homework'),json_extract(value,'$.published_by'),json_extract(value,'$.created_at'),json_extract(value,'$.created_by'),json_extract(value,'$.updated_at'),json_extract(value,'$.updated_by'),json_extract(value,'$.version'),json_extract(value,'$.deleted_at') FROM json_each(?)",
  },
  classes: {
    clear: "DELETE FROM classes WHERE tenant_id=?",
    insert:
      "INSERT INTO classes(tenant_id,id,name,course_type_id,teacher_id,location_id,date_from,date_to,status,note,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.name'),json_extract(value,'$.course_type_id'),json_extract(value,'$.teacher_id'),json_extract(value,'$.location_id'),json_extract(value,'$.date_from'),json_extract(value,'$.date_to'),json_extract(value,'$.status'),json_extract(value,'$.note'),json_extract(value,'$.created_at'),json_extract(value,'$.created_by'),json_extract(value,'$.updated_at'),json_extract(value,'$.updated_by'),json_extract(value,'$.version'),json_extract(value,'$.deleted_at') FROM json_each(?)",
  },
  class_members: {
    clear: "DELETE FROM class_members WHERE tenant_id=?",
    insert:
      "INSERT INTO class_members(tenant_id,id,class_id,student_id,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.class_id'),json_extract(value,'$.student_id'),json_extract(value,'$.created_at'),json_extract(value,'$.created_by'),json_extract(value,'$.updated_at'),json_extract(value,'$.updated_by'),json_extract(value,'$.version'),json_extract(value,'$.deleted_at') FROM json_each(?)",
  },
  followup_notes: {
    clear: "DELETE FROM followup_notes WHERE tenant_id=?",
    insert:
      "INSERT INTO followup_notes(tenant_id,id,student_id,at,content,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.student_id'),json_extract(value,'$.at'),json_extract(value,'$.content'),json_extract(value,'$.created_at'),json_extract(value,'$.created_by'),json_extract(value,'$.updated_at'),json_extract(value,'$.updated_by'),json_extract(value,'$.version'),json_extract(value,'$.deleted_at') FROM json_each(?)",
  },
  followup_tasks: {
    clear: "DELETE FROM followup_tasks WHERE tenant_id=?",
    insert:
      "INSERT INTO followup_tasks(tenant_id,id,student_id,title,due_date,assignee_id,legacy_owner,done,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.student_id'),json_extract(value,'$.title'),json_extract(value,'$.due_date'),json_extract(value,'$.assignee_id'),json_extract(value,'$.legacy_owner'),json_extract(value,'$.done'),json_extract(value,'$.created_at'),json_extract(value,'$.created_by'),json_extract(value,'$.updated_at'),json_extract(value,'$.updated_by'),json_extract(value,'$.version'),json_extract(value,'$.deleted_at') FROM json_each(?)",
  },
  student_routines: {
    clear: "DELETE FROM student_routines WHERE tenant_id=?",
    insert:
      "INSERT INTO student_routines(tenant_id,id,student_id,weekday,time,content,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.student_id'),json_extract(value,'$.weekday'),json_extract(value,'$.time'),json_extract(value,'$.content'),json_extract(value,'$.created_at'),json_extract(value,'$.created_by'),json_extract(value,'$.updated_at'),json_extract(value,'$.updated_by'),json_extract(value,'$.version'),json_extract(value,'$.deleted_at') FROM json_each(?)",
  },
  leads: {
    clear: "DELETE FROM leads WHERE tenant_id=?",
    insert:
      "INSERT INTO leads(tenant_id,id,name,phone_enc,parent_phone_enc,phone_last4,source,stage,next_followup,trial_at,grade,direction,note,student_id,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.name'),json_extract(value,'$.phone_enc'),json_extract(value,'$.parent_phone_enc'),json_extract(value,'$.phone_last4'),json_extract(value,'$.source'),json_extract(value,'$.stage'),json_extract(value,'$.next_followup'),json_extract(value,'$.trial_at'),json_extract(value,'$.grade'),json_extract(value,'$.direction'),json_extract(value,'$.note'),json_extract(value,'$.student_id'),json_extract(value,'$.created_at'),json_extract(value,'$.created_by'),json_extract(value,'$.updated_at'),json_extract(value,'$.updated_by'),json_extract(value,'$.version'),json_extract(value,'$.deleted_at') FROM json_each(?)",
  },

};
const stagedRestoreSql = {
  ...creditTableSql((table, columns) =>
    `INSERT INTO ${table}(${columns.join(",")})
      SELECT ?,${columns.slice(1).map((column) => `json_extract(row_json,'$.${column}')`).join(",")}
      FROM data_job_rows WHERE tenant_id=? AND job_id=? AND table_name='${table}'`,
  ),
  renewal_reminders:
    "INSERT INTO renewal_reminders(tenant_id,id,student_id,course_type_id,scope_kind,scope_id,package_ids_json,channel,sent_at,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(row_json,'$.id'),json_extract(row_json,'$.student_id'),json_extract(row_json,'$.course_type_id'),json_extract(row_json,'$.scope_kind'),json_extract(row_json,'$.scope_id'),json_extract(row_json,'$.package_ids_json'),json_extract(row_json,'$.channel'),json_extract(row_json,'$.sent_at'),json_extract(row_json,'$.created_at'),json_extract(row_json,'$.created_by'),json_extract(row_json,'$.updated_at'),json_extract(row_json,'$.updated_by'),json_extract(row_json,'$.version'),json_extract(row_json,'$.deleted_at') FROM data_job_rows WHERE tenant_id=? AND job_id=? AND table_name='renewal_reminders'",
  students:
    "INSERT INTO students(tenant_id,id,name,gender,birth_year,school,grade,direction,phone_enc,parent_name,parent_phone_enc,status,notes,sort_order,created_at,created_by,updated_at,updated_by,version,deleted_at,billing_mode,report_class_id,source_lead_id,nickname,parent_consent_media) SELECT ?,json_extract(row_json,'$.id'),json_extract(row_json,'$.name'),json_extract(row_json,'$.gender'),json_extract(row_json,'$.birth_year'),json_extract(row_json,'$.school'),json_extract(row_json,'$.grade'),json_extract(row_json,'$.direction'),json_extract(row_json,'$.phone_enc'),json_extract(row_json,'$.parent_name'),json_extract(row_json,'$.parent_phone_enc'),json_extract(row_json,'$.status'),json_extract(row_json,'$.notes'),json_extract(row_json,'$.sort_order'),json_extract(row_json,'$.created_at'),json_extract(row_json,'$.created_by'),json_extract(row_json,'$.updated_at'),json_extract(row_json,'$.updated_by'),json_extract(row_json,'$.version'),json_extract(row_json,'$.deleted_at'),json_extract(row_json,'$.billing_mode'),json_extract(row_json,'$.report_class_id'),json_extract(row_json,'$.source_lead_id'),COALESCE(json_extract(row_json,'$.nickname'),'X 同学'),COALESCE(json_extract(row_json,'$.parent_consent_media'),0) FROM data_job_rows WHERE tenant_id=? AND job_id=? AND table_name='students'",
  teachers:
    "INSERT INTO teachers(tenant_id,id,name,phone_enc,subjects,employment,status,sort_order,created_at,created_by,updated_at,updated_by,version,deleted_at,show_in_timetable) SELECT ?,json_extract(row_json,'$.id'),json_extract(row_json,'$.name'),json_extract(row_json,'$.phone_enc'),json_extract(row_json,'$.subjects'),json_extract(row_json,'$.employment'),json_extract(row_json,'$.status'),json_extract(row_json,'$.sort_order'),json_extract(row_json,'$.created_at'),json_extract(row_json,'$.created_by'),json_extract(row_json,'$.updated_at'),json_extract(row_json,'$.updated_by'),json_extract(row_json,'$.version'),json_extract(row_json,'$.deleted_at'),COALESCE(json_extract(row_json,'$.show_in_timetable'),1) FROM data_job_rows WHERE tenant_id=? AND job_id=? AND table_name='teachers'",
  course_categories:
    "INSERT INTO course_categories(tenant_id,id,name,color,active,sort_order,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(row_json,'$.id'),json_extract(row_json,'$.name'),json_extract(row_json,'$.color'),json_extract(row_json,'$.active'),json_extract(row_json,'$.sort_order'),json_extract(row_json,'$.created_at'),json_extract(row_json,'$.created_by'),json_extract(row_json,'$.updated_at'),json_extract(row_json,'$.updated_by'),json_extract(row_json,'$.version'),json_extract(row_json,'$.deleted_at') FROM data_job_rows WHERE tenant_id=? AND job_id=? AND table_name='course_categories'",
  course_types:
    "INSERT INTO course_types(tenant_id,id,name,category_id,format,default_minutes,units_per_lesson,capacity,active,sort_order,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(row_json,'$.id'),json_extract(row_json,'$.name'),json_extract(row_json,'$.category_id'),json_extract(row_json,'$.format'),json_extract(row_json,'$.default_minutes'),json_extract(row_json,'$.units_per_lesson'),json_extract(row_json,'$.capacity'),json_extract(row_json,'$.active'),json_extract(row_json,'$.sort_order'),json_extract(row_json,'$.created_at'),json_extract(row_json,'$.created_by'),json_extract(row_json,'$.updated_at'),json_extract(row_json,'$.updated_by'),json_extract(row_json,'$.version'),json_extract(row_json,'$.deleted_at') FROM data_job_rows WHERE tenant_id=? AND job_id=? AND table_name='course_types'",
  locations:
    "INSERT INTO locations(tenant_id,id,name,campus,offsite,capacity,active,sort_order,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(row_json,'$.id'),json_extract(row_json,'$.name'),json_extract(row_json,'$.campus'),json_extract(row_json,'$.offsite'),json_extract(row_json,'$.capacity'),json_extract(row_json,'$.active'),json_extract(row_json,'$.sort_order'),json_extract(row_json,'$.created_at'),json_extract(row_json,'$.created_by'),json_extract(row_json,'$.updated_at'),json_extract(row_json,'$.updated_by'),json_extract(row_json,'$.version'),json_extract(row_json,'$.deleted_at') FROM data_job_rows WHERE tenant_id=? AND job_id=? AND table_name='locations'",
  student_schedule_blocks:
    "INSERT INTO student_schedule_blocks(tenant_id,id,student_id,weekday,start_time,end_time,label,active,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(row_json,'$.id'),json_extract(row_json,'$.student_id'),json_extract(row_json,'$.weekday'),json_extract(row_json,'$.start_time'),json_extract(row_json,'$.end_time'),json_extract(row_json,'$.label'),json_extract(row_json,'$.active'),json_extract(row_json,'$.created_at'),json_extract(row_json,'$.created_by'),json_extract(row_json,'$.updated_at'),json_extract(row_json,'$.updated_by'),json_extract(row_json,'$.version'),json_extract(row_json,'$.deleted_at') FROM data_job_rows WHERE tenant_id=? AND job_id=? AND table_name='student_schedule_blocks'",
  schedule_templates:
    "INSERT INTO schedule_templates(tenant_id,id,teacher_id,assistant_id,course_type_id,location_id,weekday,start_time,duration,units,mode,date_from,date_to,active,note,created_at,created_by,updated_at,updated_by,version,deleted_at,class_id) SELECT ?,json_extract(row_json,'$.id'),json_extract(row_json,'$.teacher_id'),json_extract(row_json,'$.assistant_id'),json_extract(row_json,'$.course_type_id'),json_extract(row_json,'$.location_id'),json_extract(row_json,'$.weekday'),json_extract(row_json,'$.start_time'),json_extract(row_json,'$.duration'),json_extract(row_json,'$.units'),json_extract(row_json,'$.mode'),json_extract(row_json,'$.date_from'),json_extract(row_json,'$.date_to'),json_extract(row_json,'$.active'),json_extract(row_json,'$.note'),json_extract(row_json,'$.created_at'),json_extract(row_json,'$.created_by'),json_extract(row_json,'$.updated_at'),json_extract(row_json,'$.updated_by'),json_extract(row_json,'$.version'),json_extract(row_json,'$.deleted_at'),json_extract(row_json,'$.class_id') FROM data_job_rows WHERE tenant_id=? AND job_id=? AND table_name='schedule_templates'",
  schedule_enrollments:
    "INSERT INTO schedule_enrollments(tenant_id,id,template_id,student_id,date_from,date_to,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(row_json,'$.id'),json_extract(row_json,'$.template_id'),json_extract(row_json,'$.student_id'),json_extract(row_json,'$.date_from'),json_extract(row_json,'$.date_to'),json_extract(row_json,'$.created_at'),json_extract(row_json,'$.created_by'),json_extract(row_json,'$.updated_at'),json_extract(row_json,'$.updated_by'),json_extract(row_json,'$.version'),json_extract(row_json,'$.deleted_at') FROM data_job_rows WHERE tenant_id=? AND job_id=? AND table_name='schedule_enrollments'",
  lessons:
    "INSERT INTO lessons(tenant_id,id,start_at,duration,units,teacher_id,assistant_id,course_type_id,location_id,mode,status,template_id,occurrence_date,note,created_at,created_by,updated_at,updated_by,version,deleted_at,teacher_paid,format,override_rate,override_basis,locked_rate,current_submission_id,class_id) SELECT ?,json_extract(row_json,'$.id'),json_extract(row_json,'$.start_at'),json_extract(row_json,'$.duration'),json_extract(row_json,'$.units'),json_extract(row_json,'$.teacher_id'),json_extract(row_json,'$.assistant_id'),json_extract(row_json,'$.course_type_id'),json_extract(row_json,'$.location_id'),json_extract(row_json,'$.mode'),json_extract(row_json,'$.status'),json_extract(row_json,'$.template_id'),json_extract(row_json,'$.occurrence_date'),json_extract(row_json,'$.note'),json_extract(row_json,'$.created_at'),json_extract(row_json,'$.created_by'),json_extract(row_json,'$.updated_at'),json_extract(row_json,'$.updated_by'),json_extract(row_json,'$.version'),json_extract(row_json,'$.deleted_at'),json_extract(row_json,'$.teacher_paid'),json_extract(row_json,'$.format'),json_extract(row_json,'$.override_rate'),json_extract(row_json,'$.override_basis'),json_extract(row_json,'$.locked_rate'),json_extract(row_json,'$.current_submission_id'),json_extract(row_json,'$.class_id') FROM data_job_rows WHERE tenant_id=? AND job_id=? AND table_name='lessons'",
  lesson_participants:
    "INSERT INTO lesson_participants(tenant_id,id,lesson_id,student_id,attendance,deducted,package_id,makeup_for,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(row_json,'$.id'),json_extract(row_json,'$.lesson_id'),json_extract(row_json,'$.student_id'),json_extract(row_json,'$.attendance'),json_extract(row_json,'$.deducted'),json_extract(row_json,'$.package_id'),json_extract(row_json,'$.makeup_for'),json_extract(row_json,'$.created_at'),json_extract(row_json,'$.created_by'),json_extract(row_json,'$.updated_at'),json_extract(row_json,'$.updated_by'),json_extract(row_json,'$.version'),json_extract(row_json,'$.deleted_at') FROM data_job_rows WHERE tenant_id=? AND job_id=? AND table_name='lesson_participants'",
  packages:
    "INSERT INTO packages(tenant_id,id,student_id,course_type_id,units_total,valid_from,valid_to,status,created_at,created_by,updated_at,updated_by,version,deleted_at,stage_id,purchase_date,scope_kind,category_id,unit_price,amount) SELECT ?,json_extract(row_json,'$.id'),json_extract(row_json,'$.student_id'),json_extract(row_json,'$.course_type_id'),json_extract(row_json,'$.units_total'),json_extract(row_json,'$.valid_from'),json_extract(row_json,'$.valid_to'),json_extract(row_json,'$.status'),json_extract(row_json,'$.created_at'),json_extract(row_json,'$.created_by'),json_extract(row_json,'$.updated_at'),json_extract(row_json,'$.updated_by'),json_extract(row_json,'$.version'),json_extract(row_json,'$.deleted_at'),json_extract(row_json,'$.stage_id'),json_extract(row_json,'$.purchase_date'),json_extract(row_json,'$.scope_kind'),json_extract(row_json,'$.category_id'),json_extract(row_json,'$.unit_price'),json_extract(row_json,'$.amount') FROM data_job_rows WHERE tenant_id=? AND job_id=? AND table_name='packages'",
  student_stages:
    "INSERT INTO student_stages(tenant_id,id,student_id,name,date_from,date_to,goal,status,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(row_json,'$.id'),json_extract(row_json,'$.student_id'),json_extract(row_json,'$.name'),json_extract(row_json,'$.date_from'),json_extract(row_json,'$.date_to'),json_extract(row_json,'$.goal'),json_extract(row_json,'$.status'),json_extract(row_json,'$.created_at'),json_extract(row_json,'$.created_by'),json_extract(row_json,'$.updated_at'),json_extract(row_json,'$.updated_by'),json_extract(row_json,'$.version'),json_extract(row_json,'$.deleted_at') FROM data_job_rows WHERE tenant_id=? AND job_id=? AND table_name='student_stages'",
  package_transactions:
    "INSERT INTO package_transactions(tenant_id,id,package_id,student_id,delta,type,date,participant_id,reference_id,note,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(row_json,'$.id'),json_extract(row_json,'$.package_id'),json_extract(row_json,'$.student_id'),json_extract(row_json,'$.delta'),json_extract(row_json,'$.type'),json_extract(row_json,'$.date'),json_extract(row_json,'$.participant_id'),json_extract(row_json,'$.reference_id'),json_extract(row_json,'$.note'),json_extract(row_json,'$.created_at'),json_extract(row_json,'$.created_by'),json_extract(row_json,'$.updated_at'),json_extract(row_json,'$.updated_by'),json_extract(row_json,'$.version'),json_extract(row_json,'$.deleted_at') FROM data_job_rows WHERE tenant_id=? AND job_id=? AND table_name='package_transactions'",
  student_payments:
    "INSERT INTO student_payments(tenant_id,id,student_id,package_id,paid_at,method,note,created_at,created_by,updated_at,updated_by,version,deleted_at,amount) SELECT ?,json_extract(row_json,'$.id'),json_extract(row_json,'$.student_id'),json_extract(row_json,'$.package_id'),json_extract(row_json,'$.paid_at'),json_extract(row_json,'$.method'),json_extract(row_json,'$.note'),json_extract(row_json,'$.created_at'),json_extract(row_json,'$.created_by'),json_extract(row_json,'$.updated_at'),json_extract(row_json,'$.updated_by'),json_extract(row_json,'$.version'),json_extract(row_json,'$.deleted_at'),json_extract(row_json,'$.amount') FROM data_job_rows WHERE tenant_id=? AND job_id=? AND table_name='student_payments'",
  makeup_links:
    "INSERT INTO makeup_links(tenant_id,id,original_participant_id,target_participant_id,target_lesson_id,note,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(row_json,'$.id'),json_extract(row_json,'$.original_participant_id'),json_extract(row_json,'$.target_participant_id'),json_extract(row_json,'$.target_lesson_id'),json_extract(row_json,'$.note'),json_extract(row_json,'$.created_at'),json_extract(row_json,'$.created_by'),json_extract(row_json,'$.updated_at'),json_extract(row_json,'$.updated_by'),json_extract(row_json,'$.version'),json_extract(row_json,'$.deleted_at') FROM data_job_rows WHERE tenant_id=? AND job_id=? AND table_name='makeup_links'",
  settlements:
    "INSERT INTO settlements(tenant_id,id,month,locked,summary,created_at,created_by,updated_at,updated_by,version,deleted_at,status,submitted_by,submitted_at,submitted_revision,approved_by,approved_at,snapshot_token,reason,total_amount,tuition_amount,cost_amount,profit_amount,submitted_fingerprint) SELECT ?,json_extract(row_json,'$.id'),json_extract(row_json,'$.month'),json_extract(row_json,'$.locked'),json_extract(row_json,'$.summary'),json_extract(row_json,'$.created_at'),json_extract(row_json,'$.created_by'),json_extract(row_json,'$.updated_at'),json_extract(row_json,'$.updated_by'),json_extract(row_json,'$.version'),json_extract(row_json,'$.deleted_at'),json_extract(row_json,'$.status'),json_extract(row_json,'$.submitted_by'),json_extract(row_json,'$.submitted_at'),json_extract(row_json,'$.submitted_revision'),json_extract(row_json,'$.approved_by'),json_extract(row_json,'$.approved_at'),json_extract(row_json,'$.snapshot_token'),json_extract(row_json,'$.reason'),json_extract(row_json,'$.total_amount'),json_extract(row_json,'$.tuition_amount'),json_extract(row_json,'$.cost_amount'),json_extract(row_json,'$.profit_amount'),json_extract(row_json,'$.submitted_fingerprint') FROM data_job_rows WHERE tenant_id=? AND job_id=? AND table_name='settlements'",
  credit_operations:
    "INSERT INTO credit_operations(tenant_id,id,actor_id,request_hash,response_json,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(row_json,'$.id'),json_extract(row_json,'$.actor_id'),json_extract(row_json,'$.request_hash'),json_extract(row_json,'$.response_json'),json_extract(row_json,'$.created_at'),json_extract(row_json,'$.created_by'),json_extract(row_json,'$.updated_at'),json_extract(row_json,'$.updated_by'),json_extract(row_json,'$.version'),json_extract(row_json,'$.deleted_at') FROM data_job_rows WHERE tenant_id=? AND job_id=? AND table_name='credit_operations'",
  teacher_rates:
    "INSERT INTO teacher_rates(tenant_id,id,teacher_id,course_type_id,format,rate_basis,rate,effective_from,effective_to,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(row_json,'$.id'),json_extract(row_json,'$.teacher_id'),json_extract(row_json,'$.course_type_id'),json_extract(row_json,'$.format'),json_extract(row_json,'$.rate_basis'),json_extract(row_json,'$.rate'),json_extract(row_json,'$.effective_from'),json_extract(row_json,'$.effective_to'),json_extract(row_json,'$.created_at'),json_extract(row_json,'$.created_by'),json_extract(row_json,'$.updated_at'),json_extract(row_json,'$.updated_by'),json_extract(row_json,'$.version'),json_extract(row_json,'$.deleted_at') FROM data_job_rows WHERE tenant_id=? AND job_id=? AND table_name='teacher_rates'",
  teacher_payments:
    "INSERT INTO teacher_payments(tenant_id,id,teacher_id,month,amount,paid_at,note,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(row_json,'$.id'),json_extract(row_json,'$.teacher_id'),json_extract(row_json,'$.month'),json_extract(row_json,'$.amount'),json_extract(row_json,'$.paid_at'),json_extract(row_json,'$.note'),json_extract(row_json,'$.created_at'),json_extract(row_json,'$.created_by'),json_extract(row_json,'$.updated_at'),json_extract(row_json,'$.updated_by'),json_extract(row_json,'$.version'),json_extract(row_json,'$.deleted_at') FROM data_job_rows WHERE tenant_id=? AND job_id=? AND table_name='teacher_payments'",
  teacher_adjustments:
    "INSERT INTO teacher_adjustments(tenant_id,id,teacher_id,month,amount,reason,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(row_json,'$.id'),json_extract(row_json,'$.teacher_id'),json_extract(row_json,'$.month'),json_extract(row_json,'$.amount'),json_extract(row_json,'$.reason'),json_extract(row_json,'$.created_at'),json_extract(row_json,'$.created_by'),json_extract(row_json,'$.updated_at'),json_extract(row_json,'$.updated_by'),json_extract(row_json,'$.version'),json_extract(row_json,'$.deleted_at') FROM data_job_rows WHERE tenant_id=? AND job_id=? AND table_name='teacher_adjustments'",
  other_costs:
    "INSERT INTO other_costs(tenant_id,id,date,category,amount,note,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(row_json,'$.id'),json_extract(row_json,'$.date'),json_extract(row_json,'$.category'),json_extract(row_json,'$.amount'),json_extract(row_json,'$.note'),json_extract(row_json,'$.created_at'),json_extract(row_json,'$.created_by'),json_extract(row_json,'$.updated_at'),json_extract(row_json,'$.updated_by'),json_extract(row_json,'$.version'),json_extract(row_json,'$.deleted_at') FROM data_job_rows WHERE tenant_id=? AND job_id=? AND table_name='other_costs'",
  payroll_snapshots:
    "INSERT INTO payroll_snapshots(tenant_id,id,month,snapshot_token,lesson_id,teacher_id,rate,rate_basis,quantity,amount,lesson_json,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(row_json,'$.id'),json_extract(row_json,'$.month'),json_extract(row_json,'$.snapshot_token'),json_extract(row_json,'$.lesson_id'),json_extract(row_json,'$.teacher_id'),json_extract(row_json,'$.rate'),json_extract(row_json,'$.rate_basis'),json_extract(row_json,'$.quantity'),json_extract(row_json,'$.amount'),json_extract(row_json,'$.lesson_json'),json_extract(row_json,'$.created_at'),json_extract(row_json,'$.created_by'),json_extract(row_json,'$.updated_at'),json_extract(row_json,'$.updated_by'),json_extract(row_json,'$.version'),json_extract(row_json,'$.deleted_at') FROM data_job_rows WHERE tenant_id=? AND job_id=? AND table_name='payroll_snapshots'",
  lesson_submissions:
    "INSERT INTO lesson_submissions(tenant_id,id,lesson_id,kind,status,public_text,homework,base_fingerprint,comment_fingerprint,submitted_by,submitted_at,reviewed_by,reviewed_at,reason,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(row_json,'$.id'),json_extract(row_json,'$.lesson_id'),json_extract(row_json,'$.kind'),json_extract(row_json,'$.status'),json_extract(row_json,'$.public_text'),json_extract(row_json,'$.homework'),json_extract(row_json,'$.base_fingerprint'),json_extract(row_json,'$.comment_fingerprint'),json_extract(row_json,'$.submitted_by'),json_extract(row_json,'$.submitted_at'),json_extract(row_json,'$.reviewed_by'),json_extract(row_json,'$.reviewed_at'),json_extract(row_json,'$.reason'),json_extract(row_json,'$.created_at'),json_extract(row_json,'$.created_by'),json_extract(row_json,'$.updated_at'),json_extract(row_json,'$.updated_by'),json_extract(row_json,'$.version'),json_extract(row_json,'$.deleted_at') FROM data_job_rows WHERE tenant_id=? AND job_id=? AND table_name='lesson_submissions'",
  submission_people:
    "INSERT INTO submission_people(tenant_id,id,submission_id,participant_id,student_id,attendance,comment,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(row_json,'$.id'),json_extract(row_json,'$.submission_id'),json_extract(row_json,'$.participant_id'),json_extract(row_json,'$.student_id'),json_extract(row_json,'$.attendance'),json_extract(row_json,'$.comment'),json_extract(row_json,'$.created_at'),json_extract(row_json,'$.created_by'),json_extract(row_json,'$.updated_at'),json_extract(row_json,'$.updated_by'),json_extract(row_json,'$.version'),json_extract(row_json,'$.deleted_at') FROM data_job_rows WHERE tenant_id=? AND job_id=? AND table_name='submission_people'",
  lesson_comments:
    "INSERT INTO lesson_comments(tenant_id,id,lesson_id,student_id,text,homework,published_by,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(row_json,'$.id'),json_extract(row_json,'$.lesson_id'),json_extract(row_json,'$.student_id'),json_extract(row_json,'$.text'),json_extract(row_json,'$.homework'),json_extract(row_json,'$.published_by'),json_extract(row_json,'$.created_at'),json_extract(row_json,'$.created_by'),json_extract(row_json,'$.updated_at'),json_extract(row_json,'$.updated_by'),json_extract(row_json,'$.version'),json_extract(row_json,'$.deleted_at') FROM data_job_rows WHERE tenant_id=? AND job_id=? AND table_name='lesson_comments'",
  classes:
    "INSERT INTO classes(tenant_id,id,name,course_type_id,teacher_id,location_id,date_from,date_to,status,note,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(row_json,'$.id'),json_extract(row_json,'$.name'),json_extract(row_json,'$.course_type_id'),json_extract(row_json,'$.teacher_id'),json_extract(row_json,'$.location_id'),json_extract(row_json,'$.date_from'),json_extract(row_json,'$.date_to'),json_extract(row_json,'$.status'),json_extract(row_json,'$.note'),json_extract(row_json,'$.created_at'),json_extract(row_json,'$.created_by'),json_extract(row_json,'$.updated_at'),json_extract(row_json,'$.updated_by'),json_extract(row_json,'$.version'),json_extract(row_json,'$.deleted_at') FROM data_job_rows WHERE tenant_id=? AND job_id=? AND table_name='classes'",
  class_members:
    "INSERT INTO class_members(tenant_id,id,class_id,student_id,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(row_json,'$.id'),json_extract(row_json,'$.class_id'),json_extract(row_json,'$.student_id'),json_extract(row_json,'$.created_at'),json_extract(row_json,'$.created_by'),json_extract(row_json,'$.updated_at'),json_extract(row_json,'$.updated_by'),json_extract(row_json,'$.version'),json_extract(row_json,'$.deleted_at') FROM data_job_rows WHERE tenant_id=? AND job_id=? AND table_name='class_members'",
  followup_notes:
    "INSERT INTO followup_notes(tenant_id,id,student_id,at,content,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(row_json,'$.id'),json_extract(row_json,'$.student_id'),json_extract(row_json,'$.at'),json_extract(row_json,'$.content'),json_extract(row_json,'$.created_at'),json_extract(row_json,'$.created_by'),json_extract(row_json,'$.updated_at'),json_extract(row_json,'$.updated_by'),json_extract(row_json,'$.version'),json_extract(row_json,'$.deleted_at') FROM data_job_rows WHERE tenant_id=? AND job_id=? AND table_name='followup_notes'",
  followup_tasks:
    "INSERT INTO followup_tasks(tenant_id,id,student_id,title,due_date,assignee_id,legacy_owner,done,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(row_json,'$.id'),json_extract(row_json,'$.student_id'),json_extract(row_json,'$.title'),json_extract(row_json,'$.due_date'),json_extract(row_json,'$.assignee_id'),json_extract(row_json,'$.legacy_owner'),json_extract(row_json,'$.done'),json_extract(row_json,'$.created_at'),json_extract(row_json,'$.created_by'),json_extract(row_json,'$.updated_at'),json_extract(row_json,'$.updated_by'),json_extract(row_json,'$.version'),json_extract(row_json,'$.deleted_at') FROM data_job_rows WHERE tenant_id=? AND job_id=? AND table_name='followup_tasks'",
  student_routines:
    "INSERT INTO student_routines(tenant_id,id,student_id,weekday,time,content,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(row_json,'$.id'),json_extract(row_json,'$.student_id'),json_extract(row_json,'$.weekday'),json_extract(row_json,'$.time'),json_extract(row_json,'$.content'),json_extract(row_json,'$.created_at'),json_extract(row_json,'$.created_by'),json_extract(row_json,'$.updated_at'),json_extract(row_json,'$.updated_by'),json_extract(row_json,'$.version'),json_extract(row_json,'$.deleted_at') FROM data_job_rows WHERE tenant_id=? AND job_id=? AND table_name='student_routines'",
  leads:
    "INSERT INTO leads(tenant_id,id,name,phone_enc,parent_phone_enc,phone_last4,source,stage,next_followup,trial_at,grade,direction,note,student_id,created_at,created_by,updated_at,updated_by,version,deleted_at) SELECT ?,json_extract(row_json,'$.id'),json_extract(row_json,'$.name'),json_extract(row_json,'$.phone_enc'),json_extract(row_json,'$.parent_phone_enc'),json_extract(row_json,'$.phone_last4'),json_extract(row_json,'$.source'),json_extract(row_json,'$.stage'),json_extract(row_json,'$.next_followup'),json_extract(row_json,'$.trial_at'),json_extract(row_json,'$.grade'),json_extract(row_json,'$.direction'),json_extract(row_json,'$.note'),json_extract(row_json,'$.student_id'),json_extract(row_json,'$.created_at'),json_extract(row_json,'$.created_by'),json_extract(row_json,'$.updated_at'),json_extract(row_json,'$.updated_by'),json_extract(row_json,'$.version'),json_extract(row_json,'$.deleted_at') FROM data_job_rows WHERE tenant_id=? AND job_id=? AND table_name='leads'",

};
const toolListSql = {
  classes:
    "SELECT * FROM classes WHERE tenant_id=? AND deleted_at IS NULL AND (? IS NULL OR id=?) ORDER BY created_at DESC,id LIMIT 200 OFFSET ?",
  class_members:
    "SELECT m.*,s.name FROM class_members m LEFT JOIN students s ON s.tenant_id=m.tenant_id AND s.id=m.student_id AND s.deleted_at IS NULL WHERE m.tenant_id=? AND m.deleted_at IS NULL AND (? IS NULL OR m.class_id=?) ORDER BY m.created_at DESC,m.id LIMIT 200 OFFSET ?",
  followup_notes:
    "SELECT * FROM followup_notes WHERE tenant_id=? AND deleted_at IS NULL AND (? IS NULL OR student_id=?) ORDER BY created_at DESC,id LIMIT 200 OFFSET ?",
  followup_tasks:
    "SELECT * FROM followup_tasks WHERE tenant_id=? AND deleted_at IS NULL AND (? IS NULL OR student_id=?) ORDER BY created_at DESC,id LIMIT 200 OFFSET ?",
  student_routines:
    "SELECT * FROM student_routines WHERE tenant_id=? AND deleted_at IS NULL AND (? IS NULL OR student_id=?) ORDER BY created_at DESC,id LIMIT 200 OFFSET ?",
  leads:
    "SELECT * FROM leads WHERE tenant_id=? AND deleted_at IS NULL AND (? IS NULL OR id=?) ORDER BY created_at DESC,id LIMIT 200 OFFSET ?",

};

const businessSql = {
  ...creditTableSql((table, columns) => ({
    columns: columns.slice(2),
    insert: `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
    update: `UPDATE ${table} SET ${columns.slice(2).map((column) => column + "=?").join(",")} WHERE tenant_id=? AND id=?`,
    get: `SELECT * FROM ${table} WHERE tenant_id=? AND id=? AND deleted_at IS NULL`,
    guard: `INSERT INTO mutation_guards(tenant_id,id,expected,actual)
      SELECT ?,?,?,COALESCE((SELECT version FROM ${table} WHERE tenant_id=? AND id=? AND deleted_at IS NULL),-1)`,
  })),
  classes: {
    columns: [
      "name",
      "course_type_id",
      "teacher_id",
      "location_id",
      "date_from",
      "date_to",
      "status",
      "note",
      "created_at",
      "created_by",
      "updated_at",
      "updated_by",
      "version",
      "deleted_at",
    ],
    insert:
      "INSERT INTO classes(tenant_id,id,name,course_type_id,teacher_id,location_id,date_from,date_to,status,note,created_at,created_by,updated_at,updated_by,version,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    update:
      "UPDATE classes SET name=?,course_type_id=?,teacher_id=?,location_id=?,date_from=?,date_to=?,status=?,note=?,created_at=?,created_by=?,updated_at=?,updated_by=?,version=?,deleted_at=? WHERE tenant_id=? AND id=?",
    get: "SELECT * FROM classes WHERE tenant_id=? AND id=? AND deleted_at IS NULL",
    list: "SELECT * FROM classes WHERE tenant_id=? AND deleted_at IS NULL ORDER BY created_at DESC,id LIMIT 200 OFFSET ?",
    guard:
      "INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?,?,?,COALESCE((SELECT version FROM classes WHERE tenant_id=? AND id=? AND deleted_at IS NULL),-1)",
  },
  class_members: {
    columns: [
      "class_id",
      "student_id",
      "created_at",
      "created_by",
      "updated_at",
      "updated_by",
      "version",
      "deleted_at",
    ],
    insert:
      "INSERT INTO class_members(tenant_id,id,class_id,student_id,created_at,created_by,updated_at,updated_by,version,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    update:
      "UPDATE class_members SET class_id=?,student_id=?,created_at=?,created_by=?,updated_at=?,updated_by=?,version=?,deleted_at=? WHERE tenant_id=? AND id=?",
    get: "SELECT * FROM class_members WHERE tenant_id=? AND id=? AND deleted_at IS NULL",
    list: "SELECT * FROM class_members WHERE tenant_id=? AND deleted_at IS NULL ORDER BY created_at DESC,id LIMIT 200 OFFSET ?",
    guard:
      "INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?,?,?,COALESCE((SELECT version FROM class_members WHERE tenant_id=? AND id=? AND deleted_at IS NULL),-1)",
  },
  followup_notes: {
    columns: [
      "student_id",
      "at",
      "content",
      "created_at",
      "created_by",
      "updated_at",
      "updated_by",
      "version",
      "deleted_at",
    ],
    insert:
      "INSERT INTO followup_notes(tenant_id,id,student_id,at,content,created_at,created_by,updated_at,updated_by,version,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    update:
      "UPDATE followup_notes SET student_id=?,at=?,content=?,created_at=?,created_by=?,updated_at=?,updated_by=?,version=?,deleted_at=? WHERE tenant_id=? AND id=?",
    get: "SELECT * FROM followup_notes WHERE tenant_id=? AND id=? AND deleted_at IS NULL",
    list: "SELECT * FROM followup_notes WHERE tenant_id=? AND deleted_at IS NULL ORDER BY created_at DESC,id LIMIT 200 OFFSET ?",
    guard:
      "INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?,?,?,COALESCE((SELECT version FROM followup_notes WHERE tenant_id=? AND id=? AND deleted_at IS NULL),-1)",
  },
  followup_tasks: {
    columns: [
      "student_id",
      "title",
      "due_date",
      "assignee_id",
      "legacy_owner",
      "done",
      "created_at",
      "created_by",
      "updated_at",
      "updated_by",
      "version",
      "deleted_at",
    ],
    insert:
      "INSERT INTO followup_tasks(tenant_id,id,student_id,title,due_date,assignee_id,legacy_owner,done,created_at,created_by,updated_at,updated_by,version,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    update:
      "UPDATE followup_tasks SET student_id=?,title=?,due_date=?,assignee_id=?,legacy_owner=?,done=?,created_at=?,created_by=?,updated_at=?,updated_by=?,version=?,deleted_at=? WHERE tenant_id=? AND id=?",
    get: "SELECT * FROM followup_tasks WHERE tenant_id=? AND id=? AND deleted_at IS NULL",
    list: "SELECT * FROM followup_tasks WHERE tenant_id=? AND deleted_at IS NULL ORDER BY created_at DESC,id LIMIT 200 OFFSET ?",
    guard:
      "INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?,?,?,COALESCE((SELECT version FROM followup_tasks WHERE tenant_id=? AND id=? AND deleted_at IS NULL),-1)",
  },
  student_routines: {
    columns: [
      "student_id",
      "weekday",
      "time",
      "content",
      "created_at",
      "created_by",
      "updated_at",
      "updated_by",
      "version",
      "deleted_at",
    ],
    insert:
      "INSERT INTO student_routines(tenant_id,id,student_id,weekday,time,content,created_at,created_by,updated_at,updated_by,version,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    update:
      "UPDATE student_routines SET student_id=?,weekday=?,time=?,content=?,created_at=?,created_by=?,updated_at=?,updated_by=?,version=?,deleted_at=? WHERE tenant_id=? AND id=?",
    get: "SELECT * FROM student_routines WHERE tenant_id=? AND id=? AND deleted_at IS NULL",
    list: "SELECT * FROM student_routines WHERE tenant_id=? AND deleted_at IS NULL ORDER BY created_at DESC,id LIMIT 200 OFFSET ?",
    guard:
      "INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?,?,?,COALESCE((SELECT version FROM student_routines WHERE tenant_id=? AND id=? AND deleted_at IS NULL),-1)",
  },
  leads: {
    columns: [
      "name",
      "phone_enc",
      "parent_phone_enc",
      "phone_last4",
      "source",
      "stage",
      "next_followup",
      "trial_at",
      "grade",
      "direction",
      "note",
      "student_id",
      "created_at",
      "created_by",
      "updated_at",
      "updated_by",
      "version",
      "deleted_at",
    ],
    insert:
      "INSERT INTO leads(tenant_id,id,name,phone_enc,parent_phone_enc,phone_last4,source,stage,next_followup,trial_at,grade,direction,note,student_id,created_at,created_by,updated_at,updated_by,version,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    update:
      "UPDATE leads SET name=?,phone_enc=?,parent_phone_enc=?,phone_last4=?,source=?,stage=?,next_followup=?,trial_at=?,grade=?,direction=?,note=?,student_id=?,created_at=?,created_by=?,updated_at=?,updated_by=?,version=?,deleted_at=? WHERE tenant_id=? AND id=?",
    get: "SELECT * FROM leads WHERE tenant_id=? AND id=? AND deleted_at IS NULL",
    list: "SELECT * FROM leads WHERE tenant_id=? AND deleted_at IS NULL ORDER BY created_at DESC,id LIMIT 200 OFFSET ?",
    guard:
      "INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?,?,?,COALESCE((SELECT version FROM leads WHERE tenant_id=? AND id=? AND deleted_at IS NULL),-1)",
  },

  announcement_reads: {
    columns: [
      "announcement_id",
      "user_id",
      "created_at",
      "created_by",
      "updated_at",
      "updated_by",
      "version",
      "deleted_at",
    ],
    insert:
      "INSERT INTO announcement_reads(tenant_id,id,announcement_id,user_id,created_at,created_by,updated_at,updated_by,version,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    update:
      "UPDATE announcement_reads SET announcement_id=?,user_id=?,created_at=?,created_by=?,updated_at=?,updated_by=?,version=?,deleted_at=? WHERE tenant_id=? AND id=?",
    get: "SELECT * FROM announcement_reads WHERE tenant_id=? AND id=? AND deleted_at IS NULL",
    list: "SELECT * FROM announcement_reads WHERE tenant_id=? AND deleted_at IS NULL ORDER BY created_at DESC,id LIMIT 200 OFFSET ?",
    guard:
      "INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?,?,?,COALESCE((SELECT version FROM announcement_reads WHERE tenant_id=? AND id=? AND deleted_at IS NULL),-1)",
  },
  lesson_submissions: {
    columns: [
      "lesson_id",
      "kind",
      "status",
      "public_text",
      "homework",
      "base_fingerprint",
      "comment_fingerprint",
      "submitted_by",
      "submitted_at",
      "reviewed_by",
      "reviewed_at",
      "reason",
      "created_at",
      "created_by",
      "updated_at",
      "updated_by",
      "version",
      "deleted_at",
    ],
    insert:
      "INSERT INTO lesson_submissions(tenant_id,id,lesson_id,kind,status,public_text,homework,base_fingerprint,comment_fingerprint,submitted_by,submitted_at,reviewed_by,reviewed_at,reason,created_at,created_by,updated_at,updated_by,version,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    update:
      "UPDATE lesson_submissions SET lesson_id=?,kind=?,status=?,public_text=?,homework=?,base_fingerprint=?,comment_fingerprint=?,submitted_by=?,submitted_at=?,reviewed_by=?,reviewed_at=?,reason=?,created_at=?,created_by=?,updated_at=?,updated_by=?,version=?,deleted_at=? WHERE tenant_id=? AND id=?",
    get: "SELECT * FROM lesson_submissions WHERE tenant_id=? AND id=? AND deleted_at IS NULL",
    list: "SELECT * FROM lesson_submissions WHERE tenant_id=? AND deleted_at IS NULL ORDER BY id LIMIT 200 OFFSET ?",
    guard:
      "INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?,?,?,COALESCE((SELECT version FROM lesson_submissions WHERE tenant_id=? AND id=? AND deleted_at IS NULL),-1)",
  },
  submission_people: {
    columns: [
      "submission_id",
      "participant_id",
      "student_id",
      "attendance",
      "comment",
      "created_at",
      "created_by",
      "updated_at",
      "updated_by",
      "version",
      "deleted_at",
    ],
    insert:
      "INSERT INTO submission_people(tenant_id,id,submission_id,participant_id,student_id,attendance,comment,created_at,created_by,updated_at,updated_by,version,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    update:
      "UPDATE submission_people SET submission_id=?,participant_id=?,student_id=?,attendance=?,comment=?,created_at=?,created_by=?,updated_at=?,updated_by=?,version=?,deleted_at=? WHERE tenant_id=? AND id=?",
    get: "SELECT * FROM submission_people WHERE tenant_id=? AND id=? AND deleted_at IS NULL",
    list: "SELECT * FROM submission_people WHERE tenant_id=? AND deleted_at IS NULL ORDER BY id LIMIT 200 OFFSET ?",
    guard:
      "INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?,?,?,COALESCE((SELECT version FROM submission_people WHERE tenant_id=? AND id=? AND deleted_at IS NULL),-1)",
  },
  lesson_comments: {
    columns: [
      "lesson_id",
      "student_id",
      "text",
      "homework",
      "published_by",
      "created_at",
      "created_by",
      "updated_at",
      "updated_by",
      "version",
      "deleted_at",
    ],
    insert:
      "INSERT INTO lesson_comments(tenant_id,id,lesson_id,student_id,text,homework,published_by,created_at,created_by,updated_at,updated_by,version,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    update:
      "UPDATE lesson_comments SET lesson_id=?,student_id=?,text=?,homework=?,published_by=?,created_at=?,created_by=?,updated_at=?,updated_by=?,version=?,deleted_at=? WHERE tenant_id=? AND id=?",
    get: "SELECT * FROM lesson_comments WHERE tenant_id=? AND id=? AND deleted_at IS NULL",
    list: "SELECT * FROM lesson_comments WHERE tenant_id=? AND deleted_at IS NULL ORDER BY id LIMIT 200 OFFSET ?",
    guard:
      "INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?,?,?,COALESCE((SELECT version FROM lesson_comments WHERE tenant_id=? AND id=? AND deleted_at IS NULL),-1)",
  },
  students: {
    columns: [
      "name",
      "gender",
      "birth_year",
      "school",
      "grade",
      "direction",
      "phone_enc",
      "parent_name",
      "parent_phone_enc",
      "status",
      "notes",
      "sort_order",
      "billing_mode",
      "report_class_id",
      "source_lead_id",
      "nickname",
      "parent_consent_media",
      "created_at",
      "created_by",
      "updated_at",
      "updated_by",
      "version",
      "deleted_at",
    ],
    list: "SELECT p.*,u.id AS account_id,u.active AS account_active FROM students p LEFT JOIN users u ON u.tenant_id=p.tenant_id AND u.student_id=p.id AND u.deleted_at IS NULL WHERE p.tenant_id=? AND p.deleted_at IS NULL ORDER BY p.sort_order,p.id LIMIT 200 OFFSET ?",
    get: "SELECT p.*,u.id AS account_id,u.active AS account_active FROM students p LEFT JOIN users u ON u.tenant_id=p.tenant_id AND u.student_id=p.id AND u.deleted_at IS NULL WHERE p.tenant_id=? AND p.id=? AND p.deleted_at IS NULL",
    insert:
      "INSERT INTO students(tenant_id,id,name,gender,birth_year,school,grade,direction,phone_enc,parent_name,parent_phone_enc,status,notes,sort_order,billing_mode,report_class_id,source_lead_id,nickname,parent_consent_media,created_at,created_by,updated_at,updated_by,version,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    update:
      "UPDATE students SET name=?,gender=?,birth_year=?,school=?,grade=?,direction=?,phone_enc=?,parent_name=?,parent_phone_enc=?,status=?,notes=?,sort_order=?,billing_mode=?,report_class_id=?,source_lead_id=?,nickname=?,parent_consent_media=?,created_at=?,created_by=?,updated_at=?,updated_by=?,version=?,deleted_at=? WHERE tenant_id=? AND id=?",
    guard:
      "INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?,?,?,COALESCE((SELECT version FROM students WHERE tenant_id=? AND id=? AND deleted_at IS NULL),-1)",
  },
  teachers: {
    columns: [
      "name",
      "phone_enc",
      "subjects",
      "employment",
      "status",
      "sort_order",
      "created_at",
      "created_by",
      "updated_at",
      "updated_by",
      "version",
      "deleted_at",
      "show_in_timetable",
    ],
    list: "SELECT p.*,u.id AS account_id,u.active AS account_active FROM teachers p LEFT JOIN users u ON u.tenant_id=p.tenant_id AND u.teacher_id=p.id AND u.deleted_at IS NULL WHERE p.tenant_id=? AND p.deleted_at IS NULL ORDER BY p.sort_order,p.id LIMIT 200 OFFSET ?",
    get: "SELECT p.*,u.id AS account_id,u.active AS account_active FROM teachers p LEFT JOIN users u ON u.tenant_id=p.tenant_id AND u.teacher_id=p.id AND u.deleted_at IS NULL WHERE p.tenant_id=? AND p.id=? AND p.deleted_at IS NULL",
    insert:
      "INSERT INTO teachers(tenant_id,id,name,phone_enc,subjects,employment,status,sort_order,created_at,created_by,updated_at,updated_by,version,deleted_at,show_in_timetable) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,COALESCE(?,1))",
    update:
      "UPDATE teachers SET name=?,phone_enc=?,subjects=?,employment=?,status=?,sort_order=?,created_at=?,created_by=?,updated_at=?,updated_by=?,version=?,deleted_at=?,show_in_timetable=COALESCE(?,show_in_timetable) WHERE tenant_id=? AND id=?",
    guard:
      "INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?,?,?,COALESCE((SELECT version FROM teachers WHERE tenant_id=? AND id=? AND deleted_at IS NULL),-1)",
  },
  course_categories: {
    columns: [
      "name",
      "color",
      "active",
      "sort_order",
      "created_at",
      "created_by",
      "updated_at",
      "updated_by",
      "version",
      "deleted_at",
    ],
    list: "SELECT * FROM course_categories WHERE tenant_id=? AND deleted_at IS NULL ORDER BY sort_order,id LIMIT 200 OFFSET ?",
    get: "SELECT * FROM course_categories WHERE tenant_id=? AND id=? AND deleted_at IS NULL",
    insert:
      "INSERT INTO course_categories(tenant_id,id,name,color,active,sort_order,created_at,created_by,updated_at,updated_by,version,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    update:
      "UPDATE course_categories SET name=?,color=?,active=?,sort_order=?,created_at=?,created_by=?,updated_at=?,updated_by=?,version=?,deleted_at=? WHERE tenant_id=? AND id=?",
    guard:
      "INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?,?,?,COALESCE((SELECT version FROM course_categories WHERE tenant_id=? AND id=? AND deleted_at IS NULL),-1)",
  },
  course_types: {
    columns: [
      "name",
      "category_id",
      "format",
      "default_minutes",
      "units_per_lesson",
      "capacity",
      "active",
      "sort_order",
      "created_at",
      "created_by",
      "updated_at",
      "updated_by",
      "version",
      "deleted_at",
    ],
    list: "SELECT * FROM course_types WHERE tenant_id=? AND deleted_at IS NULL ORDER BY sort_order,id LIMIT 200 OFFSET ?",
    get: "SELECT * FROM course_types WHERE tenant_id=? AND id=? AND deleted_at IS NULL",
    insert:
      "INSERT INTO course_types(tenant_id,id,name,category_id,format,default_minutes,units_per_lesson,capacity,active,sort_order,created_at,created_by,updated_at,updated_by,version,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    update:
      "UPDATE course_types SET name=?,category_id=?,format=?,default_minutes=?,units_per_lesson=?,capacity=?,active=?,sort_order=?,created_at=?,created_by=?,updated_at=?,updated_by=?,version=?,deleted_at=? WHERE tenant_id=? AND id=?",
    guard:
      "INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?,?,?,COALESCE((SELECT version FROM course_types WHERE tenant_id=? AND id=? AND deleted_at IS NULL),-1)",
  },
  locations: {
    columns: [
      "name",
      "campus",
      "offsite",
      "capacity",
      "active",
      "sort_order",
      "created_at",
      "created_by",
      "updated_at",
      "updated_by",
      "version",
      "deleted_at",
    ],
    list: "SELECT * FROM locations WHERE tenant_id=? AND deleted_at IS NULL ORDER BY sort_order,id LIMIT 200 OFFSET ?",
    get: "SELECT * FROM locations WHERE tenant_id=? AND id=? AND deleted_at IS NULL",
    insert:
      "INSERT INTO locations(tenant_id,id,name,campus,offsite,capacity,active,sort_order,created_at,created_by,updated_at,updated_by,version,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    update:
      "UPDATE locations SET name=?,campus=?,offsite=?,capacity=?,active=?,sort_order=?,created_at=?,created_by=?,updated_at=?,updated_by=?,version=?,deleted_at=? WHERE tenant_id=? AND id=?",
    guard:
      "INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?,?,?,COALESCE((SELECT version FROM locations WHERE tenant_id=? AND id=? AND deleted_at IS NULL),-1)",
  },
  student_schedule_blocks: {
    columns: [
      "student_id",
      "weekday",
      "start_time",
      "end_time",
      "label",
      "active",
      "created_at",
      "created_by",
      "updated_at",
      "updated_by",
      "version",
      "deleted_at",
    ],
    list: "SELECT p.*,s.name AS student_name FROM student_schedule_blocks p JOIN students s ON s.tenant_id=p.tenant_id AND s.id=p.student_id WHERE p.tenant_id=? AND p.deleted_at IS NULL ORDER BY p.id LIMIT 200 OFFSET ?",
    get: "SELECT * FROM student_schedule_blocks WHERE tenant_id=? AND id=? AND deleted_at IS NULL",
    insert:
      "INSERT INTO student_schedule_blocks(tenant_id,id,student_id,weekday,start_time,end_time,label,active,created_at,created_by,updated_at,updated_by,version,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    update:
      "UPDATE student_schedule_blocks SET student_id=?,weekday=?,start_time=?,end_time=?,label=?,active=?,created_at=?,created_by=?,updated_at=?,updated_by=?,version=?,deleted_at=? WHERE tenant_id=? AND id=?",
    guard:
      "INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?,?,?,COALESCE((SELECT version FROM student_schedule_blocks WHERE tenant_id=? AND id=? AND deleted_at IS NULL),-1)",
  },
  schedule_templates: {
    columns: [
      "teacher_id",
      "assistant_id",
      "course_type_id",
      "location_id",
      "weekday",
      "start_time",
      "duration",
      "units",
      "mode",
      "date_from",
      "date_to",
      "active",
      "note",
      "created_at",
      "created_by",
      "updated_at",
      "updated_by",
      "version",
      "deleted_at",
      "class_id",
    ],
    list: "SELECT p.*,t.name AS teacher_name,c.name AS course_name,o.name AS location_name FROM schedule_templates p JOIN teachers t ON t.tenant_id=p.tenant_id AND t.id=p.teacher_id JOIN course_types c ON c.tenant_id=p.tenant_id AND c.id=p.course_type_id LEFT JOIN locations o ON o.tenant_id=p.tenant_id AND o.id=p.location_id WHERE p.tenant_id=? AND p.deleted_at IS NULL ORDER BY p.id LIMIT 200 OFFSET ?",
    get: "SELECT * FROM schedule_templates WHERE tenant_id=? AND id=? AND deleted_at IS NULL",
    insert:
      "INSERT INTO schedule_templates(tenant_id,id,teacher_id,assistant_id,course_type_id,location_id,weekday,start_time,duration,units,mode,date_from,date_to,active,note,created_at,created_by,updated_at,updated_by,version,deleted_at,class_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    update:
      "UPDATE schedule_templates SET teacher_id=?,assistant_id=?,course_type_id=?,location_id=?,weekday=?,start_time=?,duration=?,units=?,mode=?,date_from=?,date_to=?,active=?,note=?,created_at=?,created_by=?,updated_at=?,updated_by=?,version=?,deleted_at=?,class_id=? WHERE tenant_id=? AND id=?",
    guard:
      "INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?,?,?,COALESCE((SELECT version FROM schedule_templates WHERE tenant_id=? AND id=? AND deleted_at IS NULL),-1)",
  },
  schedule_enrollments: {
    columns: [
      "template_id",
      "student_id",
      "date_from",
      "date_to",
      "created_at",
      "created_by",
      "updated_at",
      "updated_by",
      "version",
      "deleted_at",
    ],
    list: "SELECT p.*,s.name AS student_name,c.name AS course_name FROM schedule_enrollments p JOIN students s ON s.tenant_id=p.tenant_id AND s.id=p.student_id JOIN schedule_templates t ON t.tenant_id=p.tenant_id AND t.id=p.template_id JOIN course_types c ON c.tenant_id=t.tenant_id AND c.id=t.course_type_id WHERE p.tenant_id=? AND p.deleted_at IS NULL ORDER BY p.id LIMIT 200 OFFSET ?",
    get: "SELECT * FROM schedule_enrollments WHERE tenant_id=? AND id=? AND deleted_at IS NULL",
    insert:
      "INSERT INTO schedule_enrollments(tenant_id,id,template_id,student_id,date_from,date_to,created_at,created_by,updated_at,updated_by,version,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    update:
      "UPDATE schedule_enrollments SET template_id=?,student_id=?,date_from=?,date_to=?,created_at=?,created_by=?,updated_at=?,updated_by=?,version=?,deleted_at=? WHERE tenant_id=? AND id=?",
    guard:
      "INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?,?,?,COALESCE((SELECT version FROM schedule_enrollments WHERE tenant_id=? AND id=? AND deleted_at IS NULL),-1)",
  },
  lessons: {
    columns: [
      "start_at",
      "duration",
      "units",
      "teacher_id",
      "assistant_id",
      "course_type_id",
      "location_id",
      "mode",
      "status",
      "template_id",
      "occurrence_date",
      "note",
      "teacher_paid",
      "override_rate",
      "override_basis",
      "locked_rate",
      "format",
      "current_submission_id",
      "created_at",
      "created_by",
      "updated_at",
      "updated_by",
      "version",
      "deleted_at",
      "class_id",
    ],
    list: "SELECT * FROM lessons WHERE tenant_id=? AND deleted_at IS NULL ORDER BY id LIMIT 200 OFFSET ?",
    get: "SELECT l.*,c.name course_name,t.name teacher_name,o.name location_name FROM lessons l JOIN course_types c ON c.tenant_id=l.tenant_id AND c.id=l.course_type_id JOIN teachers t ON t.tenant_id=l.tenant_id AND t.id=l.teacher_id LEFT JOIN locations o ON o.tenant_id=l.tenant_id AND o.id=l.location_id WHERE l.tenant_id=? AND l.id=? AND l.deleted_at IS NULL",
    insert:
      "INSERT INTO lessons(tenant_id,id,start_at,duration,units,teacher_id,assistant_id,course_type_id,location_id,mode,status,template_id,occurrence_date,note,teacher_paid,override_rate,override_basis,locked_rate,format,current_submission_id,created_at,created_by,updated_at,updated_by,version,deleted_at,class_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    update:
      "UPDATE lessons SET start_at=?,duration=?,units=?,teacher_id=?,assistant_id=?,course_type_id=?,location_id=?,mode=?,status=?,template_id=?,occurrence_date=?,note=?,teacher_paid=?,override_rate=?,override_basis=?,locked_rate=?,format=?,current_submission_id=?,created_at=?,created_by=?,updated_at=?,updated_by=?,version=?,deleted_at=?,class_id=? WHERE tenant_id=? AND id=?",
    guard:
      "INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?,?,?,COALESCE((SELECT version FROM lessons WHERE tenant_id=? AND id=? AND deleted_at IS NULL),-1)",
  },
  lesson_participants: {
    columns: [
      "lesson_id",
      "student_id",
      "attendance",
      "deducted",
      "package_id",
      "makeup_for",
      "created_at",
      "created_by",
      "updated_at",
      "updated_by",
      "version",
      "deleted_at",
    ],
    list: "SELECT * FROM lesson_participants WHERE tenant_id=? AND deleted_at IS NULL ORDER BY id LIMIT 200 OFFSET ?",
    get: "SELECT * FROM lesson_participants WHERE tenant_id=? AND id=? AND deleted_at IS NULL",
    insert:
      "INSERT INTO lesson_participants(tenant_id,id,lesson_id,student_id,attendance,deducted,package_id,makeup_for,created_at,created_by,updated_at,updated_by,version,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    update:
      "UPDATE lesson_participants SET lesson_id=?,student_id=?,attendance=?,deducted=?,package_id=?,makeup_for=?,created_at=?,created_by=?,updated_at=?,updated_by=?,version=?,deleted_at=? WHERE tenant_id=? AND id=?",
    guard:
      "INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?,?,?,COALESCE((SELECT version FROM lesson_participants WHERE tenant_id=? AND id=? AND deleted_at IS NULL),-1)",
  },
  packages: {
    columns: [
      "student_id",
      "course_type_id",
      "units_total",
      "valid_from",
      "valid_to",
      "status",
      "unit_price",
      "amount",
      "stage_id",
      "purchase_date",
      "scope_kind",
      "category_id",
      "created_at",
      "created_by",
      "updated_at",
      "updated_by",
      "version",
      "deleted_at",
    ],
    list: "SELECT * FROM packages WHERE tenant_id=? AND deleted_at IS NULL ORDER BY id LIMIT 200 OFFSET ?",
    get: "SELECT * FROM packages WHERE tenant_id=? AND id=? AND deleted_at IS NULL",
    insert:
      "INSERT INTO packages(tenant_id,id,student_id,course_type_id,units_total,valid_from,valid_to,status,unit_price,amount,stage_id,purchase_date,scope_kind,category_id,created_at,created_by,updated_at,updated_by,version,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    update:
      "UPDATE packages SET student_id=?,course_type_id=?,units_total=?,valid_from=?,valid_to=?,status=?,unit_price=?,amount=?,stage_id=?,purchase_date=?,scope_kind=?,category_id=?,created_at=?,created_by=?,updated_at=?,updated_by=?,version=?,deleted_at=? WHERE tenant_id=? AND id=?",
    guard:
      "INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?,?,?,COALESCE((SELECT version FROM packages WHERE tenant_id=? AND id=? AND deleted_at IS NULL),-1)",
  },
  student_stages: {
    columns: [
      "student_id",
      "name",
      "date_from",
      "date_to",
      "goal",
      "status",
      "created_at",
      "created_by",
      "updated_at",
      "updated_by",
      "version",
      "deleted_at",
    ],
    insert:
      "INSERT INTO student_stages(tenant_id,id,student_id,name,date_from,date_to,goal,status,created_at,created_by,updated_at,updated_by,version,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    update:
      "UPDATE student_stages SET student_id=?,name=?,date_from=?,date_to=?,goal=?,status=?,created_at=?,created_by=?,updated_at=?,updated_by=?,version=?,deleted_at=? WHERE tenant_id=? AND id=?",
    get: "SELECT * FROM student_stages WHERE tenant_id=? AND id=? AND deleted_at IS NULL",
    list: "SELECT * FROM student_stages WHERE tenant_id=? AND deleted_at IS NULL ORDER BY id LIMIT 200 OFFSET ?",
    guard:
      "INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?,?,?,COALESCE((SELECT version FROM student_stages WHERE tenant_id=? AND id=? AND deleted_at IS NULL),-1)",
  },
  package_transactions: {
    columns: [
      "package_id",
      "student_id",
      "delta",
      "type",
      "date",
      "participant_id",
      "reference_id",
      "note",
      "created_at",
      "created_by",
      "updated_at",
      "updated_by",
      "version",
      "deleted_at",
    ],
    insert:
      "INSERT INTO package_transactions(tenant_id,id,package_id,student_id,delta,type,date,participant_id,reference_id,note,created_at,created_by,updated_at,updated_by,version,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    update:
      "UPDATE package_transactions SET package_id=?,student_id=?,delta=?,type=?,date=?,participant_id=?,reference_id=?,note=?,created_at=?,created_by=?,updated_at=?,updated_by=?,version=?,deleted_at=? WHERE tenant_id=? AND id=?",
    get: "SELECT * FROM package_transactions WHERE tenant_id=? AND id=? AND deleted_at IS NULL",
    list: "SELECT * FROM package_transactions WHERE tenant_id=? AND deleted_at IS NULL ORDER BY id LIMIT 200 OFFSET ?",
    guard:
      "INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?,?,?,COALESCE((SELECT version FROM package_transactions WHERE tenant_id=? AND id=? AND deleted_at IS NULL),-1)",
  },
  student_payments: {
    columns: [
      "student_id",
      "package_id",
      "amount",
      "paid_at",
      "method",
      "note",
      "created_at",
      "created_by",
      "updated_at",
      "updated_by",
      "version",
      "deleted_at",
    ],
    insert:
      "INSERT INTO student_payments(tenant_id,id,student_id,package_id,amount,paid_at,method,note,created_at,created_by,updated_at,updated_by,version,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    update:
      "UPDATE student_payments SET student_id=?,package_id=?,amount=?,paid_at=?,method=?,note=?,created_at=?,created_by=?,updated_at=?,updated_by=?,version=?,deleted_at=? WHERE tenant_id=? AND id=?",
    get: "SELECT * FROM student_payments WHERE tenant_id=? AND id=? AND deleted_at IS NULL",
    list: "SELECT * FROM student_payments WHERE tenant_id=? AND deleted_at IS NULL ORDER BY id LIMIT 200 OFFSET ?",
    guard:
      "INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?,?,?,COALESCE((SELECT version FROM student_payments WHERE tenant_id=? AND id=? AND deleted_at IS NULL),-1)",
  },
  makeup_links: {
    columns: [
      "original_participant_id",
      "target_participant_id",
      "target_lesson_id",
      "note",
      "created_at",
      "created_by",
      "updated_at",
      "updated_by",
      "version",
      "deleted_at",
    ],
    insert:
      "INSERT INTO makeup_links(tenant_id,id,original_participant_id,target_participant_id,target_lesson_id,note,created_at,created_by,updated_at,updated_by,version,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    update:
      "UPDATE makeup_links SET original_participant_id=?,target_participant_id=?,target_lesson_id=?,note=?,created_at=?,created_by=?,updated_at=?,updated_by=?,version=?,deleted_at=? WHERE tenant_id=? AND id=?",
    get: "SELECT * FROM makeup_links WHERE tenant_id=? AND id=? AND deleted_at IS NULL",
    list: "SELECT * FROM makeup_links WHERE tenant_id=? AND deleted_at IS NULL ORDER BY id LIMIT 200 OFFSET ?",
    guard:
      "INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?,?,?,COALESCE((SELECT version FROM makeup_links WHERE tenant_id=? AND id=? AND deleted_at IS NULL),-1)",
  },
  settlements: {
    columns: [
      "month",
      "locked",
      "summary",
      "status",
      "submitted_by",
      "submitted_at",
      "submitted_revision",
      "submitted_fingerprint",
      "approved_by",
      "approved_at",
      "snapshot_token",
      "reason",
      "total_amount",
      "tuition_amount",
      "cost_amount",
      "profit_amount",
      "created_at",
      "created_by",
      "updated_at",
      "updated_by",
      "version",
      "deleted_at",
    ],
    insert:
      "INSERT INTO settlements(tenant_id,id,month,locked,summary,status,submitted_by,submitted_at,submitted_revision,submitted_fingerprint,approved_by,approved_at,snapshot_token,reason,total_amount,tuition_amount,cost_amount,profit_amount,created_at,created_by,updated_at,updated_by,version,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    update:
      "UPDATE settlements SET month=?,locked=?,summary=?,status=?,submitted_by=?,submitted_at=?,submitted_revision=?,submitted_fingerprint=?,approved_by=?,approved_at=?,snapshot_token=?,reason=?,total_amount=?,tuition_amount=?,cost_amount=?,profit_amount=?,created_at=?,created_by=?,updated_at=?,updated_by=?,version=?,deleted_at=? WHERE tenant_id=? AND id=?",
    get: "SELECT * FROM settlements WHERE tenant_id=? AND id=? AND deleted_at IS NULL",
    list: "SELECT * FROM settlements WHERE tenant_id=? AND deleted_at IS NULL ORDER BY id LIMIT 200 OFFSET ?",
    guard:
      "INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?,?,?,COALESCE((SELECT version FROM settlements WHERE tenant_id=? AND id=? AND deleted_at IS NULL),-1)",
  },
  credit_operations: {
    columns: [
      "actor_id",
      "request_hash",
      "response_json",
      "created_at",
      "created_by",
      "updated_at",
      "updated_by",
      "version",
      "deleted_at",
    ],
    insert:
      "INSERT INTO credit_operations(tenant_id,id,actor_id,request_hash,response_json,created_at,created_by,updated_at,updated_by,version,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    update:
      "UPDATE credit_operations SET actor_id=?,request_hash=?,response_json=?,created_at=?,created_by=?,updated_at=?,updated_by=?,version=?,deleted_at=? WHERE tenant_id=? AND id=?",
    get: "SELECT * FROM credit_operations WHERE tenant_id=? AND id=? AND deleted_at IS NULL",
    list: "SELECT * FROM credit_operations WHERE tenant_id=? AND deleted_at IS NULL ORDER BY id LIMIT 200 OFFSET ?",
    guard:
      "INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?,?,?,COALESCE((SELECT version FROM credit_operations WHERE tenant_id=? AND id=? AND deleted_at IS NULL),-1)",
  },
  teacher_rates: {
    columns: [
      "teacher_id",
      "course_type_id",
      "format",
      "rate_basis",
      "rate",
      "effective_from",
      "effective_to",
      "created_at",
      "created_by",
      "updated_at",
      "updated_by",
      "version",
      "deleted_at",
    ],
    insert:
      "INSERT INTO teacher_rates(tenant_id,id,teacher_id,course_type_id,format,rate_basis,rate,effective_from,effective_to,created_at,created_by,updated_at,updated_by,version,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    update:
      "UPDATE teacher_rates SET teacher_id=?,course_type_id=?,format=?,rate_basis=?,rate=?,effective_from=?,effective_to=?,created_at=?,created_by=?,updated_at=?,updated_by=?,version=?,deleted_at=? WHERE tenant_id=? AND id=?",
    get: "SELECT * FROM teacher_rates WHERE tenant_id=? AND id=? AND deleted_at IS NULL",
    list: "SELECT * FROM teacher_rates WHERE tenant_id=? AND deleted_at IS NULL ORDER BY id LIMIT 200 OFFSET ?",
    guard:
      "INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?,?,?,COALESCE((SELECT version FROM teacher_rates WHERE tenant_id=? AND id=? AND deleted_at IS NULL),-1)",
  },
  teacher_payments: {
    columns: [
      "teacher_id",
      "month",
      "amount",
      "paid_at",
      "note",
      "created_at",
      "created_by",
      "updated_at",
      "updated_by",
      "version",
      "deleted_at",
    ],
    insert:
      "INSERT INTO teacher_payments(tenant_id,id,teacher_id,month,amount,paid_at,note,created_at,created_by,updated_at,updated_by,version,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    update:
      "UPDATE teacher_payments SET teacher_id=?,month=?,amount=?,paid_at=?,note=?,created_at=?,created_by=?,updated_at=?,updated_by=?,version=?,deleted_at=? WHERE tenant_id=? AND id=?",
    get: "SELECT * FROM teacher_payments WHERE tenant_id=? AND id=? AND deleted_at IS NULL",
    list: "SELECT * FROM teacher_payments WHERE tenant_id=? AND deleted_at IS NULL ORDER BY id LIMIT 200 OFFSET ?",
    guard:
      "INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?,?,?,COALESCE((SELECT version FROM teacher_payments WHERE tenant_id=? AND id=? AND deleted_at IS NULL),-1)",
  },
  teacher_adjustments: {
    columns: [
      "teacher_id",
      "month",
      "amount",
      "reason",
      "created_at",
      "created_by",
      "updated_at",
      "updated_by",
      "version",
      "deleted_at",
    ],
    insert:
      "INSERT INTO teacher_adjustments(tenant_id,id,teacher_id,month,amount,reason,created_at,created_by,updated_at,updated_by,version,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    update:
      "UPDATE teacher_adjustments SET teacher_id=?,month=?,amount=?,reason=?,created_at=?,created_by=?,updated_at=?,updated_by=?,version=?,deleted_at=? WHERE tenant_id=? AND id=?",
    get: "SELECT * FROM teacher_adjustments WHERE tenant_id=? AND id=? AND deleted_at IS NULL",
    list: "SELECT * FROM teacher_adjustments WHERE tenant_id=? AND deleted_at IS NULL ORDER BY id LIMIT 200 OFFSET ?",
    guard:
      "INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?,?,?,COALESCE((SELECT version FROM teacher_adjustments WHERE tenant_id=? AND id=? AND deleted_at IS NULL),-1)",
  },
  other_costs: {
    columns: [
      "date",
      "category",
      "amount",
      "note",
      "created_at",
      "created_by",
      "updated_at",
      "updated_by",
      "version",
      "deleted_at",
    ],
    insert:
      "INSERT INTO other_costs(tenant_id,id,date,category,amount,note,created_at,created_by,updated_at,updated_by,version,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    update:
      "UPDATE other_costs SET date=?,category=?,amount=?,note=?,created_at=?,created_by=?,updated_at=?,updated_by=?,version=?,deleted_at=? WHERE tenant_id=? AND id=?",
    get: "SELECT * FROM other_costs WHERE tenant_id=? AND id=? AND deleted_at IS NULL",
    list: "SELECT * FROM other_costs WHERE tenant_id=? AND deleted_at IS NULL ORDER BY id LIMIT 200 OFFSET ?",
    guard:
      "INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?,?,?,COALESCE((SELECT version FROM other_costs WHERE tenant_id=? AND id=? AND deleted_at IS NULL),-1)",
  },
  payroll_snapshots: {
    columns: [
      "month",
      "snapshot_token",
      "lesson_id",
      "teacher_id",
      "rate",
      "rate_basis",
      "quantity",
      "amount",
      "lesson_json",
      "created_at",
      "created_by",
      "updated_at",
      "updated_by",
      "version",
      "deleted_at",
    ],
    insert:
      "INSERT INTO payroll_snapshots(tenant_id,id,month,snapshot_token,lesson_id,teacher_id,rate,rate_basis,quantity,amount,lesson_json,created_at,created_by,updated_at,updated_by,version,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    update:
      "UPDATE payroll_snapshots SET month=?,snapshot_token=?,lesson_id=?,teacher_id=?,rate=?,rate_basis=?,quantity=?,amount=?,lesson_json=?,created_at=?,created_by=?,updated_at=?,updated_by=?,version=?,deleted_at=? WHERE tenant_id=? AND id=?",
    get: "SELECT * FROM payroll_snapshots WHERE tenant_id=? AND id=? AND deleted_at IS NULL",
    list: "SELECT * FROM payroll_snapshots WHERE tenant_id=? AND deleted_at IS NULL ORDER BY id LIMIT 200 OFFSET ?",
    guard:
      "INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?,?,?,COALESCE((SELECT version FROM payroll_snapshots WHERE tenant_id=? AND id=? AND deleted_at IS NULL),-1)",
  },
};
const searchSql = {
  students:
    "SELECT p.*,u.id AS account_id,u.active AS account_active FROM students p LEFT JOIN users u ON u.tenant_id=p.tenant_id AND u.student_id=p.id AND u.deleted_at IS NULL WHERE p.tenant_id=? AND p.deleted_at IS NULL AND instr(lower(p.name),lower(?))>0 ORDER BY p.sort_order,p.id LIMIT 200 OFFSET ?",
  teachers:
    "SELECT p.*,u.id AS account_id,u.active AS account_active FROM teachers p LEFT JOIN users u ON u.tenant_id=p.tenant_id AND u.teacher_id=p.id AND u.deleted_at IS NULL WHERE p.tenant_id=? AND p.deleted_at IS NULL AND instr(lower(p.name),lower(?))>0 ORDER BY p.sort_order,p.id LIMIT 200 OFFSET ?",
  course_categories:
    "SELECT * FROM course_categories WHERE tenant_id=? AND deleted_at IS NULL AND instr(lower(name),lower(?))>0 ORDER BY sort_order,id LIMIT 200 OFFSET ?",
  course_types:
    "SELECT * FROM course_types WHERE tenant_id=? AND deleted_at IS NULL AND instr(lower(name),lower(?))>0 ORDER BY sort_order,id LIMIT 200 OFFSET ?",
  locations:
    "SELECT * FROM locations WHERE tenant_id=? AND deleted_at IS NULL AND instr(lower(name),lower(?))>0 ORDER BY sort_order,id LIMIT 200 OFFSET ?",
};
function safeBusinessAudit(row) {
  if (!row) return null;
  const result = { ...row };
  for (const key of [
    "phone_enc",
    "parent_phone_enc",
    "notes",
    "parent_name",
    "lesson_json",
    "summary",
    "response_json",
    "request_hash",
  ])
    delete result[key];
  return result;
}
// Large JSON objects are built in groups: json_object <=32 args, json_set <=31.
const boundedSqlCache = new Map();
function boundedJsonSql(query) {
  if (boundedSqlCache.has(query)) return boundedSqlCache.get(query);
  const result = query.replace(/json_object\(/gi, "__JSON_OBJECT__(");
  // Implemented below with a balanced scanner, never inspect quoted commas.
  let value = result;
  while (value.includes("__JSON_OBJECT__(")) {
    const at = value.lastIndexOf("__JSON_OBJECT__("),
      start = at + "__JSON_OBJECT__(".length;
    let depth = 1,
      quoted = false,
      part = start,
      end = start,
      args = [];
    for (; end < value.length; end++) {
      const c = value[end];
      if (c === "'") {
        if (quoted && value[end + 1] === "'") {
          end++;
          continue;
        }
        quoted = !quoted;
        continue;
      }
      if (quoted) continue;
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (!depth) {
          args.push(value.slice(part, end));
          break;
        }
      } else if (c === "," && depth === 1) {
        args.push(value.slice(part, end));
        part = end + 1;
      }
    }
    let expression = "json_object(" + args.slice(0, 32).join(",") + ")";
    for (let i = 32; i < args.length; i += 30) {
      const tail = args
        .slice(i, i + 30)
        .map((x, j) => (j % 2 ? x : "'$." + x.trim().slice(1, -1) + "'"));
      expression = "json_set(" + expression + "," + tail.join(",") + ")";
    }
    value = value.slice(0, at) + expression + value.slice(end + 1);
  }
  boundedSqlCache.set(query, value);
  return value;
}
const snapshotPreflightSql = Object.entries(backupTables).map(
  ([table, spec]) => {
    const terms = spec.columns.map((k) => {
      const col = '"' + k + '"',
        n = "length(CAST(" + col + " AS BLOB))";
      return (
        "CASE WHEN typeof(" +
        col +
        ")='text' THEN CASE WHEN json_valid(" +
        col +
        ") OR " +
        col +
        " NOT GLOB '" +
        assertPattern(SNAPSHOT_SAFE_ASCII_PATTERN) +
        "' THEN 2 ELSE 6 END*" +
        n +
        " ELSE 32 END"
      );
    });
    return (
      "INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT 'platform',?||':" +
      table +
      "',1,CASE WHEN EXISTS(SELECT 1 FROM " +
      table +
      " WHERE (4096+" +
      terms.join("+") +
      ")>" +
      D1_VALUE_BUDGET +
      ") THEN 0 ELSE 1 END"
    );
  },
);
// 本文件是唯一 SQL 边界。null 作用域只供机构识别和平台认证/控制台使用。
const requestRepoCache = new WeakMap();
const referenceSql = {
  students:
    "SELECT * FROM students WHERE tenant_id=? AND id IN(SELECT value FROM json_each(?)) AND deleted_at IS NULL",
  teachers:
    "SELECT * FROM teachers WHERE tenant_id=? AND id IN(SELECT value FROM json_each(?)) AND deleted_at IS NULL",
  locations:
    "SELECT * FROM locations WHERE tenant_id=? AND id IN(SELECT value FROM json_each(?)) AND deleted_at IS NULL",
  course_types:
    "SELECT * FROM course_types WHERE tenant_id=? AND id IN(SELECT value FROM json_each(?)) AND deleted_at IS NULL",
  schedule_templates:
    "SELECT * FROM schedule_templates WHERE tenant_id=? AND id IN(SELECT value FROM json_each(?)) AND deleted_at IS NULL",
  packages:
    "SELECT * FROM packages WHERE tenant_id=? AND id IN(SELECT value FROM json_each(?)) AND deleted_at IS NULL",
};
const studentHistorySql =
  "SELECT l.id,l.start_at,l.duration,l.status,p.attendance,p.deducted,c.name course_name,t.name teacher_name,o.name location_name,pub.text public_text,priv.text private_comment FROM lessons l JOIN lesson_participants p ON p.tenant_id=l.tenant_id AND p.lesson_id=l.id JOIN course_types c ON c.tenant_id=l.tenant_id AND c.id=l.course_type_id JOIN teachers t ON t.tenant_id=l.tenant_id AND t.id=l.teacher_id LEFT JOIN locations o ON o.tenant_id=l.tenant_id AND o.id=l.location_id LEFT JOIN lesson_comments pub ON pub.tenant_id=l.tenant_id AND pub.lesson_id=l.id AND pub.student_id IS NULL AND pub.deleted_at IS NULL LEFT JOIN lesson_comments priv ON priv.tenant_id=l.tenant_id AND priv.lesson_id=l.id AND priv.student_id=p.student_id AND priv.deleted_at IS NULL WHERE l.tenant_id=? AND p.student_id=? AND p.deleted_at IS NULL AND l.deleted_at IS NULL AND strftime('%s',l.start_at)*1000<=? ORDER BY l.start_at DESC,l.id LIMIT ? OFFSET ?";
const tenantRouteSql = (host, slug, at) => `WITH candidates AS (
  SELECT t.*,0 route_priority FROM tenants t JOIN tenant_domains d ON d.tenant_id=t.id WHERE d.domain=${host} AND d.verified=1
  UNION ALL SELECT t.*,1 route_priority FROM tenants t WHERE t.slug=${slug} COLLATE NOCASE
  UNION ALL SELECT t.*,2 route_priority FROM tenants t JOIN tenant_slug_aliases a ON a.tenant_id=t.id
    WHERE a.slug=${slug} COLLATE NOCASE AND a.expires_at>${at}
) SELECT * FROM candidates ORDER BY route_priority LIMIT 1`;
function tenantRoute(row, auth) {
  if (!row) return null;
  const { route_priority, ...tenant } = row;
  return { tenant, domain: route_priority === 0, alias: route_priority === 2, auth };
}
function policyRows(modules, settings, rights) {
  return {
    modules: Object.fromEntries(modules.map((x) => [x.id, !!x.enabled])),
    settings: Object.fromEntries(settings.map((x) => [x.id, JSON.parse(x.value)])),
    rights,
  };
}

const announcementUnreadSql = "SELECT COUNT(*) n FROM announcement_targets t JOIN platform_announcements a ON a.id=t.announcement_id AND a.withdrawn_at IS NULL WHERE t.tenant_id=? AND a.starts_at<=? AND (a.ends_at IS NULL OR a.ends_at>?) AND EXISTS(SELECT 1 FROM json_each(a.roles) r WHERE r.value IN(SELECT value FROM json_each(?))) AND NOT EXISTS(SELECT 1 FROM announcement_reads x WHERE x.tenant_id=t.tenant_id AND x.announcement_id=a.id AND x.user_id=? AND x.deleted_at IS NULL)";
const announcementPageSql = "SELECT a.id,a.title,a.content,a.starts_at,EXISTS(SELECT 1 FROM announcement_reads r WHERE r.tenant_id=t.tenant_id AND r.announcement_id=a.id AND r.user_id=? AND r.deleted_at IS NULL) is_read FROM announcement_targets t JOIN platform_announcements a ON a.id=t.announcement_id AND a.withdrawn_at IS NULL WHERE t.tenant_id=? AND a.starts_at<=? AND (a.ends_at IS NULL OR a.ends_at>?) AND EXISTS(SELECT 1 FROM json_each(a.roles) r WHERE r.value IN (SELECT value FROM json_each(?))) ORDER BY a.starts_at DESC,a.id LIMIT 200 OFFSET ?";
const weekCountsSql = "SELECT SUBSTR(start_at,1,10) date,COUNT(*) n FROM lessons WHERE tenant_id=? AND deleted_at IS NULL AND start_at>=? AND start_at<? GROUP BY SUBSTR(start_at,1,10)";
const expiredStagesSql = "SELECT x.*,s.name student_name FROM student_stages x JOIN students s ON s.tenant_id=x.tenant_id AND s.id=x.student_id WHERE x.tenant_id=? AND x.deleted_at IS NULL AND s.deleted_at IS NULL AND x.status='active' AND x.date_to<? ORDER BY x.date_to,x.id LIMIT 50 OFFSET ?";
const dueLeadsSql = "SELECT id,name FROM leads WHERE tenant_id=? AND deleted_at IS NULL AND next_followup=? AND stage NOT IN ('enrolled','lost') ORDER BY id LIMIT 6";
const studentFactsSql = "SELECT (SELECT ROUND(COALESCE(SUM(x.delta),0),2) FROM package_transactions x JOIN packages p ON p.tenant_id=x.tenant_id AND p.id=x.package_id WHERE x.tenant_id=?1 AND x.student_id=?2 AND p.deleted_at IS NULL) balance,(SELECT ROUND(COALESCE(SUM(d.remaining_units),0),2) FROM credit_debts d WHERE d.tenant_id=?1 AND d.student_id=?2 AND d.deleted_at IS NULL) debt_units,(SELECT COUNT(*) FROM packages WHERE tenant_id=?1 AND student_id=?2 AND deleted_at IS NULL) package_count,(SELECT COALESCE(SUM(amount),0) FROM student_payments WHERE tenant_id=?1 AND student_id=?2 AND deleted_at IS NULL) paid_amount,(SELECT COUNT(*) FROM pending_student_payments WHERE tenant_id=?1 AND student_id=?2)+(SELECT COUNT(*) FROM packages WHERE tenant_id=?1 AND student_id=?2 AND amount IS NULL AND deleted_at IS NULL) due_unresolved,(SELECT COALESCE(SUM(MAX(0,p.amount-COALESCE((SELECT SUM(s.amount) FROM package_receipt_lines s WHERE s.tenant_id=p.tenant_id AND s.package_id=p.id),0))),0) FROM packages p WHERE p.tenant_id=?1 AND p.student_id=?2 AND p.deleted_at IS NULL AND p.amount IS NOT NULL) due_amount";
const nextLessonSql = "SELECT l.id,l.start_at,l.duration,l.units,l.mode,l.status,l.teacher_id,l.assistant_id,c.name course_name,t.name teacher_name,o.name location_name FROM lessons l JOIN course_types c ON c.tenant_id=l.tenant_id AND c.id=l.course_type_id JOIN teachers t ON t.tenant_id=l.tenant_id AND t.id=l.teacher_id LEFT JOIN locations o ON o.tenant_id=l.tenant_id AND o.id=l.location_id WHERE l.tenant_id=? AND l.deleted_at IS NULL AND l.status='planned' AND l.start_at>=? AND strftime('%s',l.start_at)*1000>=? AND (? IS NULL OR l.teacher_id=? OR l.assistant_id=?) AND (? IS NULL OR EXISTS(SELECT 1 FROM lesson_participants p WHERE p.tenant_id=l.tenant_id AND p.lesson_id=l.id AND p.student_id=? AND p.deleted_at IS NULL AND p.attendance='planned')) ORDER BY l.start_at,l.id LIMIT 1";
function renewalStudentRows(rows, settings) { return rows.map((row) => {
        const { last_reminded_at, ...data } = renewalRow(row);
        return {
          ...data,
          state:
            data.debt_units > 0
              ? "debt"
              : data.balance <= 0
              ? "zero"
              : data.balance <= settings.low_balance_threshold
                ? "low"
                : "active",
        };
      }); }
const creditDebtTotalSql = "SELECT ROUND(COALESCE(SUM(remaining_units),0),2) debt_units,COUNT(DISTINCT student_id) debt_student_count,ROUND((SELECT COALESCE(SUM(x.delta),0) FROM package_transactions x JOIN packages p ON p.tenant_id=x.tenant_id AND p.id=x.package_id WHERE x.tenant_id=?1 AND (?2 IS NULL OR x.student_id=?2) AND p.deleted_at IS NULL AND p.status='active' AND (p.valid_from IS NULL OR p.valid_from<=?3) AND (p.valid_to IS NULL OR p.valid_to>=?3))-COALESCE(SUM(remaining_units),0),2) available_units FROM credit_debts INDEXED BY p1_credit_debt_active WHERE tenant_id=?1 AND (?2 IS NULL OR student_id=?2) AND deleted_at IS NULL AND remaining_units>0";
const overdueFollowupsCount = `(SELECT COUNT(*) FROM followup_tasks f,args a WHERE f.tenant_id=a.tenant_id AND f.deleted_at IS NULL AND f.done=0 AND f.due_date<a.today)`;
const uncheckedLessonsCount = `(SELECT COUNT(*) FROM lessons l,args a WHERE l.tenant_id=a.tenant_id AND l.deleted_at IS NULL AND (l.status='planned' OR EXISTS(SELECT 1 FROM lesson_participants p WHERE p.tenant_id=l.tenant_id AND p.lesson_id=l.id AND p.deleted_at IS NULL AND p.attendance='planned')) AND strftime('%s',l.start_at)*1000<=a.at)`;
const todoSummarySql = `WITH args AS(SELECT ? tenant_id,? today,? at,? low,? days)` +
          renewalGroups +
          `, pending_makeups AS (
        SELECT p.lesson_id FROM lesson_participants p JOIN args a ON a.tenant_id=p.tenant_id
        WHERE p.deleted_at IS NULL AND p.attendance='student_leave'
          AND NOT EXISTS(SELECT 1 FROM makeup_links m WHERE m.tenant_id=p.tenant_id AND m.original_participant_id=p.id AND m.deleted_at IS NULL)
      ), renewal_counts AS (
        SELECT COUNT(CASE WHEN g.debt_units>0 OR (g.valid_count>0 AND g.balance<=0) THEN 1 END) renewal_zero,
          COUNT(CASE WHEN g.debt_units=0 AND g.valid_count>0 AND g.balance>0 AND g.balance<=a.low THEN 1 END) renewal_low,
          COUNT(CASE WHEN g.valid_count>0 AND g.expiring=1 THEN 1 END) renewal_expiring,
          COUNT(CASE WHEN g.debt_units>0 THEN 1 END) renewal_debt
        FROM grouped g CROSS JOIN args a
      ) SELECT
      ${uncheckedLessonsCount} unchecked_lessons,
      (SELECT COUNT(*) FROM lesson_submissions s,args a WHERE s.tenant_id=a.tenant_id AND s.deleted_at IS NULL AND s.status='pending') teacher_submissions,
      (SELECT COUNT(*) FROM pending_makeups) makeup_pending,
      (SELECT COUNT(*) FROM pending_makeups p,args a
        JOIN lessons l ON l.tenant_id=a.tenant_id AND l.id=p.lesson_id
        WHERE strftime('%s',l.start_at)>=strftime('%s',date(a.today,'-30 days')||'T00:00:00+08:00')) makeup_recent,
      ${overdueFollowupsCount} followup_overdue,
      (SELECT COUNT(*) FROM followup_tasks f,args a WHERE f.tenant_id=a.tenant_id AND f.deleted_at IS NULL AND f.done=0 AND f.due_date=a.today) followup_today,
      (SELECT COUNT(*) FROM student_stages s,args a WHERE s.tenant_id=a.tenant_id AND s.deleted_at IS NULL AND s.status='active' AND s.date_to<a.today) stage_expired,
      renewal_zero,renewal_low,renewal_expiring,renewal_debt
      FROM renewal_counts`;

const homeActionCountsSql = `WITH args AS(SELECT ? tenant_id,? today,? at)
  SELECT ${uncheckedLessonsCount} unchecked_lessons,${overdueFollowupsCount} followup_overdue`;
const reportDebtSql = `SELECT ROUND(COALESCE(SUM(remaining_units),0),2) debt_units,
  COUNT(DISTINCT student_id) debt_student_count FROM credit_debts INDEXED BY p1_credit_debt_active
  WHERE tenant_id=? AND deleted_at IS NULL AND remaining_units>0`;
// Growth feedback joins the original atomic review transaction.
Object.assign(businessSql,{
  "growth_repertoire": {
    "columns": [
      "student_id",
      "name",
      "status",
      "start_date",
      "completed_date",
      "image_ids_json",
      "created_at",
      "created_by",
      "updated_at",
      "updated_by",
      "version",
      "deleted_at"
    ],
    "insert": "INSERT INTO growth_repertoire(tenant_id,id,student_id,name,status,start_date,completed_date,image_ids_json,created_at,created_by,updated_at,updated_by,version,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    "update": "UPDATE growth_repertoire SET student_id=?,name=?,status=?,start_date=?,completed_date=?,image_ids_json=?,created_at=?,created_by=?,updated_at=?,updated_by=?,version=?,deleted_at=? WHERE tenant_id=? AND id=?",
    "get": "SELECT * FROM growth_repertoire WHERE tenant_id=? AND id=? AND deleted_at IS NULL",
    "list": "SELECT * FROM growth_repertoire WHERE tenant_id=? AND deleted_at IS NULL ORDER BY id LIMIT 200 OFFSET ?",
    "guard": "INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?,?,?,COALESCE((SELECT version FROM growth_repertoire WHERE tenant_id=? AND id=? AND deleted_at IS NULL),-1)"
  },
  "growth_feedback": {
    "columns": [
      "lesson_id",
      "submission_id",
      "student_id",
      "seq",
      "doc_json",
      "status",
      "confirmed_at",
      "created_at",
      "created_by",
      "updated_at",
      "updated_by",
      "version",
      "deleted_at"
    ],
    "insert": "INSERT INTO growth_feedback(tenant_id,id,lesson_id,submission_id,student_id,seq,doc_json,status,confirmed_at,created_at,created_by,updated_at,updated_by,version,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    "update": "UPDATE growth_feedback SET lesson_id=?,submission_id=?,student_id=?,seq=?,doc_json=?,status=?,confirmed_at=?,created_at=?,created_by=?,updated_at=?,updated_by=?,version=?,deleted_at=? WHERE tenant_id=? AND id=?",
    "get": "SELECT * FROM growth_feedback WHERE tenant_id=? AND id=? AND deleted_at IS NULL",
    "list": "SELECT * FROM growth_feedback WHERE tenant_id=? AND deleted_at IS NULL ORDER BY id LIMIT 200 OFFSET ?",
    "guard": "INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?,?,?,COALESCE((SELECT version FROM growth_feedback WHERE tenant_id=? AND id=? AND deleted_at IS NULL),-1)"
  },

});
export function repo(env, tenantId) {
  const db = env.CHANNEL_DB,
    scoped = () => {
      if (!tenantId) throw Error("tenant scope required");
    };
  if (!requestRepoCache.has(env)) requestRepoCache.set(env, new Map());
  const scopes = requestRepoCache.get(env);
  if (!scopes.has(tenantId))
    scopes.set(tenantId, {
      records: new Map(),
      blocks: new Map(),
      enrollments: new Map(),
      participants: new Map(),
    });
  const cache = scopes.get(tenantId);
  const sql = (query, ...params) => {
    query = boundedJsonSql(query);
    checkBindings(query, params);
    return db.prepare(query).bind(...params);
  };
  const first = (q, ...p) => sql(q, ...p).first();
  const all = async (q, ...p) => (await sql(q, ...p).all()).results || [];
  const participantSummarySql = (lessonScope) => `
    SELECT p.lesson_id,p.student_id,s.name,c.format,cl.name class_name
    FROM lesson_participants p JOIN students s ON s.tenant_id=p.tenant_id AND s.id=p.student_id
    JOIN lessons l ON l.tenant_id=p.tenant_id AND l.id=p.lesson_id
    JOIN course_types c ON c.tenant_id=l.tenant_id AND c.id=l.course_type_id
    LEFT JOIN classes cl ON cl.tenant_id=l.tenant_id AND cl.id=l.class_id
    WHERE p.tenant_id=? AND p.lesson_id IN(${lessonScope})
      AND p.deleted_at IS NULL AND s.deleted_at IS NULL AND l.deleted_at IS NULL
      AND (? IS NULL OR p.student_id=?) ORDER BY s.name,p.id`;
  const templateRosterSql = `
    SELECT e.template_id,e.id enrollment_id,e.student_id id,s.name,e.date_from AS date_from,e.date_to AS date_to
    FROM selected t CROSS JOIN schedule_enrollments e ON e.tenant_id=t.tenant_id AND e.template_id=t.id
    JOIN students s ON s.tenant_id=e.tenant_id AND s.id=e.student_id
    WHERE t.class_id IS NULL AND e.deleted_at IS NULL AND s.deleted_at IS NULL
    UNION ALL
    SELECT t.id,NULL,m.student_id,s.name,MAX(t.date_from,c.date_from),MIN(t.date_to,c.date_to)
    FROM selected t CROSS JOIN classes c ON c.tenant_id=t.tenant_id AND c.id=t.class_id
    CROSS JOIN class_members m ON m.tenant_id=c.tenant_id AND m.class_id=c.id
    JOIN students s ON s.tenant_id=m.tenant_id AND s.id=m.student_id
    WHERE c.deleted_at IS NULL AND c.status='active'
      AND m.deleted_at IS NULL AND s.deleted_at IS NULL AND s.status='active'
      AND MAX(t.date_from,c.date_from)<=MIN(t.date_to,c.date_to)`;
  const studentTemplateIds = (tenant, student) => `
    SELECT e.template_id FROM schedule_enrollments e
    WHERE e.tenant_id=${tenant} AND e.student_id=${student} AND e.deleted_at IS NULL
    UNION ALL
    SELECT t.id FROM class_members m CROSS JOIN schedule_templates t ON t.tenant_id=m.tenant_id AND t.class_id=m.class_id
    WHERE m.tenant_id=${tenant} AND m.student_id=${student} AND m.deleted_at IS NULL AND t.deleted_at IS NULL AND t.class_id IS NOT NULL`;
  const studentScheduleAccess = (student, teacher) => sql(`
    SELECT s.id FROM students s WHERE s.tenant_id=?1 AND s.id=?2 AND s.deleted_at IS NULL AND (
      ?3 IS NULL OR EXISTS(
        SELECT 1 FROM lesson_participants p JOIN lessons l ON l.tenant_id=p.tenant_id AND l.id=p.lesson_id
        WHERE p.tenant_id=s.tenant_id AND p.student_id=s.id AND p.deleted_at IS NULL
          AND l.deleted_at IS NULL AND (l.teacher_id=?3 OR l.assistant_id=?3)
      ) OR EXISTS(
        SELECT 1 FROM schedule_templates t WHERE t.tenant_id=?1 AND t.deleted_at IS NULL
          AND t.id IN(${studentTemplateIds("?1", "?2")})
          AND (t.teacher_id=?3 OR t.assistant_id=?3)
      )
    )`, tenantId, student, teacher);
  function weekQuery(from, to, offset, user, outward, filter = null) {
    const self = user.roles.includes("student");
    const student = self ? user.student_id : filter;
    const teacher = !self && user.roles.includes("teacher") ? user.teacher_id : null;
    const ownDetails = student && !teacher;
    const query = `
      SELECT l.*${student ? ",mine.attendance own_attendance" : ""}${ownDetails ? ",mine.deducted own_deducted,pub.text public_text,pub.homework homework,private.text private_comment" : ""},
        r.status review_status,r.kind review_kind,c.name course_name,g.color category_color,t.name teacher_name,o.name location_name
      FROM lessons l
      ${student ? `JOIN lesson_participants mine ON mine.tenant_id=l.tenant_id AND mine.lesson_id=l.id
        AND mine.student_id=? AND mine.deleted_at IS NULL` : ""}
      ${ownDetails ? `LEFT JOIN lesson_comments pub ON pub.tenant_id=l.tenant_id AND pub.lesson_id=l.id AND pub.student_id IS NULL AND pub.deleted_at IS NULL
        LEFT JOIN lesson_comments private ON private.tenant_id=l.tenant_id AND private.lesson_id=l.id AND private.student_id=mine.student_id AND private.deleted_at IS NULL` : ""}
      LEFT JOIN lesson_submissions r ON r.tenant_id=l.tenant_id AND r.id=l.current_submission_id
      JOIN course_types c ON c.tenant_id=l.tenant_id AND c.id=l.course_type_id
      JOIN course_categories g ON g.tenant_id=c.tenant_id AND g.id=c.category_id
      JOIN teachers t ON t.tenant_id=l.tenant_id AND t.id=l.teacher_id
      LEFT JOIN locations o ON o.tenant_id=l.tenant_id AND o.id=l.location_id
      WHERE l.tenant_id=? AND (?=0 OR t.show_in_timetable=1) AND l.deleted_at IS NULL
        AND l.start_at>=? AND l.start_at<? ${teacher ? "AND (l.teacher_id=? OR l.assistant_id=?)" : ""}
      ORDER BY l.start_at,l.id LIMIT 200 OFFSET ?`;
    const args = [...(student ? [student] : []), tenantId, Number(outward), from, to,
      ...(teacher ? [teacher, teacher] : []), offset];
    return { query, args };
  }
  const incrementLimit = (key, at, window) => sql(
    `INSERT INTO security_limits(key,count,window_start,locked_until) VALUES(?1,1,?2,0)
      ON CONFLICT(key) DO UPDATE SET
        count=CASE WHEN window_start<=?3 AND locked_until<=?2 THEN 1 ELSE count+1 END,
        window_start=CASE WHEN window_start<=?3 AND locked_until<=?2 THEN ?2 ELSE window_start END`,
    key, at, at - window,
  );
  const platform = () => {
    if (tenantId !== null) throw Error("platform scope required");
  };
  const conflict = async (id) => {
    const row = tenantId
      ? await first(
          "SELECT actor.name FROM users target LEFT JOIN users actor ON actor.tenant_id=target.tenant_id AND actor.id=target.updated_by WHERE target.tenant_id=? AND target.id=?",
          tenantId,
          id,
        )
      : await first(
          "SELECT a.username AS name FROM tenants t LEFT JOIN platform_admins a ON a.id=t.updated_by WHERE t.id=?",
          id,
        );
    fail(409, "这条记录刚被" + (row?.name || "系统维护") + "修改，请刷新");
  };
  async function authentication(hash, route = null) {
    const at = now();
    const target = route
      ? `(SELECT id FROM (${tenantRouteSql("?5", "?6", "?3")}) t
        WHERE t.deleted_at IS NULL
          AND CASE t.route_priority WHEN 0 THEN ?7 WHEN 1 THEN ?8 ELSE 0 END)`
      : "?1";
    const eligible = `SELECT s.id AS session_id,s.expires_at,s.last_seen_at,s.idle_ms,u.*
      FROM sessions s JOIN users u ON u.tenant_id=s.tenant_id AND u.id=s.user_id
      WHERE s.tenant_id=${target} AND s.token_hash=?2 ${route ? "AND s.kind='path'" : ""} AND u.active=1 AND u.deleted_at IS NULL
        AND s.expires_at>?3 AND (COALESCE(s.idle_ms,0)=0 OR s.last_seen_at+s.idle_ms>?3)`;
    const countable = `${eligible} AND EXISTS(SELECT 1 FROM tenants t WHERE t.id=s.tenant_id AND t.status='active'
      AND (t.expires_at IS NULL OR unixepoch(t.expires_at||'T23:59:59+08:00')*1000>?3))`;
    const prefix = env.__readRequest ? "'request-get:'" : "'request:'";
    const key = prefix + "||tenant_id||':'||id";
    const max = env.__readRequest ? "240" :
      "CASE WHEN EXISTS(SELECT 1 FROM json_each(e.roles) WHERE value IN ('teacher','student','parent')) THEN 60 ELSE 120 END";
    const incident = randomId("pa");
    const args = route
      ? [null, hash, at, incident, route.host, route.slug, Number(route.domainAuth), Number(route.slugAuth)]
      : [tenantId, hash, at];
    const query = (text) => sql(text, ...args);
    const policyTarget = "(SELECT tenant_id FROM (" + eligible + "))";
    const ops = [
      query(eligible),
      query("SELECT id,enabled FROM tenant_modules WHERE tenant_id=" + policyTarget + " AND deleted_at IS NULL"),
      query("SELECT id,value FROM tenant_settings WHERE tenant_id=" + policyTarget + " AND deleted_at IS NULL"),
      query("SELECT role,module,action,allowed FROM tenant_role_rights WHERE tenant_id=" + policyTarget + " AND deleted_at IS NULL"),
      query(`INSERT INTO security_limits(key,count,window_start,locked_until)
        SELECT ${key},1,?3,0 FROM (${countable}) WHERE 1
        ON CONFLICT(key) DO UPDATE SET count=CASE WHEN window_start<=?3-60000 THEN 1 ELSE count+1 END,
        window_start=CASE WHEN window_start<=?3-60000 THEN ?3 ELSE window_start END`),
      query(`SELECT l.count,${max} maximum FROM (${countable}) e JOIN security_limits l
        ON l.key=(${prefix}||e.tenant_id||':'||e.id)`),
      sql(`INSERT INTO platform_audit(id,at,admin_id,action,tenant_id,target,detail,ip)
        SELECT ?4,?3,'system','请求限流告警',e.tenant_id,e.id,'账号一分钟请求超过'||(${max})||'次',''
        FROM (${countable}) e JOIN security_limits l ON l.key=(${prefix}||e.tenant_id||':'||e.id)
        WHERE l.count=(${max})+1`, ...(route ? args : [...args, incident])),
      query(`UPDATE sessions SET last_seen_at=?3,updated_at=?3 WHERE tenant_id=${target} AND token_hash=?2
        AND last_seen_at<=?3-60000 AND EXISTS(SELECT 1 FROM (${eligible}))
        AND EXISTS(SELECT 1 FROM tenants t WHERE t.id=sessions.tenant_id AND t.status='active'
          AND (t.expires_at IS NULL OR unixepoch(t.expires_at||'T23:59:59+08:00')*1000>?3))`),
    ];
    if (route) ops.push(sql(tenantRouteSql("?1", "?2", "?3"), route.host, route.slug, at));
    const [users, modules, settings, rights, , limits, , , routed] =
      (await db.batch(ops)).map((item) => item.results || []);
    const user = users[0] || null;
    if (user && limits[0] && limits[0].count > limits[0].maximum)
      fail(429, "操作太频繁，请稍后再试");
    if (user) {
      // Create the request-local scope before filling its policy snapshot.
      if (!scopes.has(user.tenant_id)) repo(env, user.tenant_id);
      scopes.get(user.tenant_id).policy = policyRows(modules, settings, rights);
    }
    return route ? tenantRoute(routed[0], user) : user;
  }
  const auditStmt = (actor, module, action, id, summary) => {
    scoped();
    return sql(
      "INSERT INTO audit_log(tenant_id,id,at,actor_id,actor_label,module,action,entity_id,summary) VALUES(?,?,?,?,?,?,?,?,?)",
      tenantId,
      randomId("aud"),
      now(),
      actor.id,
      actor.name,
      module,
      action,
      id,
      summary,
    );
  };
  const platformStmt = (
    actor,
    action,
    target,
    detail,
    ip = "",
    reason = "",
  ) => {
    platform();
    return sql(
      "INSERT INTO platform_audit(id,at,admin_id,action,tenant_id,target,detail,reason,ip) VALUES(?,?,?,?,?,?,?,?,?)",
      randomId("pa"),
      now(),
      actor,
      action,
      target,
      target,
      detail,
      reason,
      ip,
    );
  };
  const settingTables={courses:'offer_courses',stage_types:'stage_types',report_classes:'report_classes',stage_rules:'stage_rules',calendar:'calendar_nodes',course_rules:'course_rules',profile:'tenant_profile',prices:'tenant_price_lists'};
  function settingTable(kind) {if(!Object.hasOwn(settingTables,kind))throw Error('invalid setting kind');return settingTables[kind];}
  const settingAudit=(tid,actor,action,id,before,after)=>sql('INSERT INTO audit_log(tenant_id,id,at,actor_id,actor_label,module,action,entity_id,summary,before_json,after_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)',tid,randomId('aud'),now(),actor.id,actor.name||actor.username||'系统维护','settings',action,id,'机构工具设置变更',before?JSON.stringify(before):null,after?JSON.stringify(after):null);
  function settingGuard(kind,id,expected,tid=tenantId,initial=false) {
    const table=settingTable(kind);
    return sql(`INSERT INTO mutation_guards(tenant_id,id,expected,actual) VALUES(?,?,?,COALESCE((SELECT version FROM ${table} WHERE tenant_id=? AND id=? AND deleted_at IS NULL),?))`,tid,randomId('guard'),expected,tid,id,initial?1:-1);
  }
  function settingUpsert(kind,id,doc,old,actor,tid=tenantId,source='manual') {
    const table=settingTable(kind),at=now(),catalog=['courses','stage_types','report_classes'].includes(kind);
    if(catalog) {
      const {id:ignored,version,created_at,created_by,updated_at,updated_by,source:inputSource,...clean}=doc;
      const stored={...clean};if(kind==='courses'&&stored.pricing) {stored.pricing={...stored.pricing};delete stored.pricing.amount;}
      if(old) return sql(`UPDATE ${table} SET subject=?,name=?,active=?,doc_json=?${kind==='courses'?',price_cents=?':''},updated_at=?,updated_by=?,version=version+1 WHERE tenant_id=? AND id=? AND deleted_at IS NULL`,clean.subject,clean.name,Number(clean.active!==false),JSON.stringify(stored),...(kind==='courses'?[doc.pricing?Math.round(doc.pricing.amount*100):null]:[]),at,actor.id,tid,id);
      return sql(`INSERT INTO ${table}(tenant_id,id,subject,name,active,source,doc_json${kind==='courses'?',price_cents':''},created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,?,?${kind==='courses'?',?':''},?,?,?,?)`,tid,id,clean.subject,clean.name,Number(clean.active!==false),source,JSON.stringify(stored),...(kind==='courses'?[doc.pricing?Math.round(doc.pricing.amount*100):null]:[]),at,actor.id,at,actor.id);
    }
    const clean={...doc};delete clean.version;
    return sql(`INSERT INTO ${table}(tenant_id,id,doc_json,created_at,created_by,updated_at,updated_by,version) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,id) DO UPDATE SET doc_json=excluded.doc_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by,version=${table}.version+1`,tid,id,JSON.stringify(clean),at,actor.id,at,actor.id,old?old.version+1:2);
  }
  function dimensionOps(id,dimensions,tid=tenantId,allowRetired=false) {
    return [
      sql(`UPDATE report_dimensions SET retired=1 WHERE tenant_id=? AND class_id=? AND dim_key NOT IN(SELECT json_extract(value,'$.key') FROM json_each(?))`,tid,id,JSON.stringify(dimensions)),
      sql(`INSERT INTO report_dimensions(tenant_id,id,class_id,dim_key,retired) SELECT ?,'dim_'||lower(hex(randomblob(12))),?,json_extract(value,'$.key'),0 FROM json_each(?) WHERE 1 ON CONFLICT(tenant_id,class_id,dim_key) DO UPDATE SET retired=CASE WHEN ?=1 THEN 0 ELSE report_dimensions.retired END`,tid,id,JSON.stringify(dimensions),Number(allowRetired)),
    ];
  }
  const platformMethods=platformRepo(db,tenantId);
  async function subjectOps(keys,actor,tid=tenantId,explicit=false) {
    if(await platformMethods.available()) return platformMethods.subjectStatements(keys,actor,tid,explicit);
    const ops=[],at=now();
    if(!keys.length)return ops;
    const state=await db.batch(['stage_rules','calendar','course_rules'].map(k=>sql(`SELECT * FROM ${settingTable(k)} WHERE tenant_id=? AND id='main'`,tid)));
    const old=Object.fromEntries(['stage_rules','calendar','course_rules'].map((k,i)=>[k,state[i].results[0]||null]));
    const docs={stage_rules:old.stage_rules?JSON.parse(old.stage_rules.doc_json):{rules:{}},calendar:old.calendar?JSON.parse(old.calendar.doc_json):{region:null,items:[]},course_rules:old.course_rules?JSON.parse(old.course_rules.doc_json):{items:[]}};
    for(const key of keys) {
      const pack=subjectPacks[key];if(!pack)fail(422,'学科包不存在','validation_failed');
      const existing=await first('SELECT imported_at FROM tenant_subjects WHERE tenant_id=? AND id=?',tid,key);
      if(existing?.imported_at)continue;
      for(const [kind,rows,prefix] of [['courses',pack.courses,'crs'],['stage_types',pack.stages.map((x,i)=>({...x,order:(i+1)*10})),'stg'],['report_classes',pack.classes,'rcl']]) {
        const table=settingTable(kind),payload=JSON.stringify(rows.map(x=>({...x,subject:key})));
        ops.push(sql(`INSERT INTO ${table}(tenant_id,id,subject,name,active,source,doc_json,created_at,created_by,updated_at,updated_by) SELECT ?1,?2||'_'||lower(hex(randomblob(12))),?3,json_extract(j.value,'$.name'),1,'template',j.value,?4,?5,?4,?5 FROM json_each(?6) j WHERE NOT EXISTS(SELECT 1 FROM ${table} x WHERE x.tenant_id=?1 AND x.subject=?3 AND x.name=json_extract(j.value,'$.name') AND x.deleted_at IS NULL)`,tid,prefix,key,at,actor.id,payload));
      }
      ops.push(sql(`INSERT OR IGNORE INTO report_dimensions(tenant_id,id,class_id,dim_key) SELECT ?1,'dim_'||lower(hex(randomblob(12))),c.id,json_extract(d.value,'$.key') FROM report_classes c,json_each(c.doc_json,'$.dimensions') d WHERE c.tenant_id=?1 AND c.subject=?2`,tid,key));
      docs.stage_rules.rules={...pack.rules,...docs.stage_rules.rules};
      const seen=new Set(docs.calendar.items.map(x=>x.key));for(const node of pack.calendar)if(!seen.has(node.key)){docs.calendar.items.push(node);seen.add(node.key);}
      ops.push(sql(`INSERT INTO tenant_subjects(tenant_id,id,pack_version,created_at,created_by,imported_at,content_json) VALUES(?,?,?,?,?,?,?) ON CONFLICT(tenant_id,id) DO UPDATE SET imported_at=excluded.imported_at,content_json=excluded.content_json`,tid,key,pack.version,at,actor.id,at,JSON.stringify({content_types:pack.content_types,constraints:pack.constraints,tone:pack.tone})));
      ops.push(settingAudit(tid,actor,'import_template',key,null,{key,pack_version:pack.version}));
    }
    if(!ops.length)return ops;
    for(const kind of ['stage_rules','calendar','course_rules']) {
      ops.push(settingGuard(kind,'main',old[kind]?.version||1,tid,true));
      const row=old[kind];
      // Template initialization is version 1; later imports increment the existing collection.
      ops.push(sql(`INSERT INTO ${settingTable(kind)}(tenant_id,id,doc_json,created_at,created_by,updated_at,updated_by,version) VALUES(?,'main',?,?,?,?,?,1) ON CONFLICT(tenant_id,id) DO UPDATE SET doc_json=excluded.doc_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by,version=${settingTable(kind)}.version+1`,tid,JSON.stringify(docs[kind]),at,actor.id,at,actor.id));
    }
    ops.push(sql(`INSERT INTO tenant_price_lists(tenant_id,id,doc_json,created_at,created_by,updated_at,updated_by,version) VALUES(?,'main','{}',?,?,?,?,2) ON CONFLICT(tenant_id,id) DO UPDATE SET version=tenant_price_lists.version+1,updated_at=excluded.updated_at,updated_by=excluded.updated_by`,tid,at,actor.id,at,actor.id));
    return ops;
  }
  function settingReferenceGuards(refs,tid=tenantId) {
    const groups=new Map();for(const [kind,id,version] of refs||[]) {const table=settingTables[kind]||({course_types:'course_types',teachers:'teachers',gallery:'gallery_images'}[kind]);if(!table)throw Error('invalid setting reference');if(!groups.has(table))groups.set(table,[]);if(!groups.get(table).some(x=>x[0]===id))groups.get(table).push([id,version??null]);}
    return [...groups].map(([table,ids])=>sql(`INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?1,?2,1,CASE WHEN COUNT(*)=json_array_length(?3) THEN 1 ELSE 0 END FROM ${table} t JOIN json_each(?3) j ON t.id=json_extract(j.value,'$[0]') WHERE t.tenant_id=?1 AND t.deleted_at IS NULL AND (json_extract(j.value,'$[1]') IS NULL OR t.version=json_extract(j.value,'$[1]'))`,tid,randomId('guard'),JSON.stringify(ids)));
  }

  return {
    platformOps:platformMethods,
async feedbackFeed(studentId,offset,limit){scoped();const query=`SELECT 'feedback' type,f.id,'confirmed' status,f.student_id,f.id revision_id,'课后反馈' title,f.confirmed_at at,f.doc_json,f.lesson_id FROM growth_feedback f JOIN lessons l ON l.tenant_id=f.tenant_id AND l.id=f.lesson_id AND l.deleted_at IS NULL WHERE f.tenant_id=?1 AND f.student_id=?2 AND f.status='confirmed' AND f.deleted_at IS NULL AND f.seq=(SELECT MAX(x.seq) FROM growth_feedback x WHERE x.tenant_id=?1 AND x.lesson_id=f.lesson_id AND x.student_id=f.student_id AND x.status='confirmed' AND x.deleted_at IS NULL)`;const legacy=` UNION ALL SELECT 'feedback','legacy_'||l.id||'_'||p.student_id,'confirmed',p.student_id,NULL,'课后反馈',MAX(c.updated_at),json_object('message',json_object('learned',GROUP_CONCAT(c.text,char(10)),'good','','attention','','homework',MAX(c.homework)),'tags',json('[]'),'image_ids',json('[]')),l.id FROM lesson_participants p JOIN lessons l ON l.tenant_id=p.tenant_id AND l.id=p.lesson_id AND l.deleted_at IS NULL JOIN lesson_comments c ON c.tenant_id=p.tenant_id AND c.lesson_id=l.id AND c.deleted_at IS NULL AND (c.student_id=p.student_id OR c.student_id IS NULL) WHERE p.tenant_id=?1 AND p.student_id=?2 AND p.deleted_at IS NULL AND p.deducted=1 AND NOT EXISTS(SELECT 1 FROM growth_feedback f WHERE f.tenant_id=?1 AND f.lesson_id=l.id AND f.student_id=p.student_id AND f.status='confirmed' AND f.deleted_at IS NULL) GROUP BY l.id,p.student_id`;const combined=query+legacy;const results=await db.batch([sql('SELECT * FROM ('+combined+') ORDER BY at DESC,id LIMIT ?3 OFFSET ?4',tenantId,studentId,limit,offset),sql('SELECT COUNT(*) n FROM ('+combined+')',tenantId,studentId)]);return {items:results[0].results,total:results[1].results[0].n};},
async feedbackParentMedia(image,children) { scoped(); return first(`SELECT a.* FROM gallery_images a WHERE a.tenant_id=?1 AND a.id=?2 AND a.deleted_at IS NULL AND EXISTS(SELECT 1 FROM growth_feedback f JOIN students s ON s.tenant_id=f.tenant_id AND s.id=f.student_id AND s.parent_consent_media=1 AND s.deleted_at IS NULL WHERE f.tenant_id=?1 AND f.student_id IN(SELECT value FROM json_each(?3)) AND f.status='confirmed' AND f.deleted_at IS NULL AND a.id IN(SELECT value FROM json_each(f.doc_json,'$.image_ids')) AND f.seq=(SELECT MAX(x.seq) FROM growth_feedback x WHERE x.tenant_id=?1 AND x.lesson_id=f.lesson_id AND x.student_id=f.student_id AND x.status='confirmed' AND x.deleted_at IS NULL))`,tenantId,image,JSON.stringify(children)); },

async feedbackChildIds(user) {
      scoped();if(user.roles.includes('student'))return (await all('SELECT id FROM students WHERE tenant_id=? AND id=? AND deleted_at IS NULL',tenantId,user.student_id)).map(x=>x.id);
      if(!user.roles.includes('parent'))return [];
      return (await all('SELECT s.id FROM guardian_links g JOIN students s ON s.tenant_id=g.tenant_id AND s.id=g.student_id WHERE g.tenant_id=? AND g.parent_user_id=? AND g.revoked_at IS NULL AND s.deleted_at IS NULL',tenantId,user.id)).map(x=>x.id);
    },

    async aiCatalog() {
 scoped(); const data=await db.batch([
 sql('SELECT * FROM offer_courses WHERE tenant_id=? AND deleted_at IS NULL ORDER BY id LIMIT 500',tenantId),
 sql('SELECT * FROM stage_types WHERE tenant_id=? AND deleted_at IS NULL ORDER BY id LIMIT 500',tenantId),
 sql("SELECT 'stage_rules' kind,doc_json,version FROM stage_rules WHERE tenant_id=?1 AND id='main' UNION ALL SELECT 'calendar',doc_json,version FROM calendar_nodes WHERE tenant_id=?1 AND id='main' UNION ALL SELECT 'course_rules',doc_json,version FROM course_rules WHERE tenant_id=?1 AND id='main' UNION ALL SELECT 'profile',doc_json,version FROM tenant_profile WHERE tenant_id=?1 AND id='main' UNION ALL SELECT 'prices',doc_json,version FROM tenant_price_lists WHERE tenant_id=?1 AND id='main'",tenantId),
 sql('SELECT * FROM report_classes WHERE tenant_id=? AND deleted_at IS NULL LIMIT 500',tenantId)]);
 return {courses:data[0].results,stages:data[1].results,settings:Object.fromEntries(data[2].results.map(x=>[x.kind,{...JSON.parse(x.doc_json),version:x.version}])),report_classes:data[3].results};
},

    async aiConfig(){scoped();return first("SELECT s.*,COALESCE(o.fast_daily_limit,s.fast_daily_limit) fast_limit,COALESCE(o.deep_daily_limit,s.deep_daily_limit) deep_limit FROM ai_settings s LEFT JOIN tenant_ai_overrides o ON o.tenant_id=? AND o.id='limits' WHERE s.id='main'",tenantId);},
    async aiPlatformSettings(){platform();return first("SELECT * FROM ai_settings WHERE id='main'");},
    async aiSaveSettings(data,actor){platform();await db.batch([sql("INSERT INTO mutation_guards(tenant_id,id,expected,actual) VALUES('platform',?,?,(SELECT version FROM ai_settings WHERE id='main'))",randomId('guard'),data.version),sql("UPDATE ai_settings SET fast_daily_limit=?,deep_daily_limit=?,fast_model=?,deep_model=?,version=version+1,updated_at=?,updated_by=? WHERE id='main'",data.fast_daily_limit,data.deep_daily_limit,data.fast_model,data.deep_model,now(),actor.id),sql('INSERT INTO platform_audit(id,admin_id,action,tenant_id,detail,at,ip) VALUES(?,?,?,?,?,?,?)',randomId('pa'),actor.id,'ai_settings',null,'修改AI模型与每日上限',now(),'')]);},
    async aiRequest(userId,key){scoped();return first('SELECT * FROM ai_requests WHERE tenant_id=? AND user_id=? AND idem_key=?',tenantId,userId,key);},
    async aiRequestId(id){scoped();return first('SELECT * FROM ai_requests WHERE tenant_id=? AND id=?',tenantId,id);},
    async aiReplay(record){scoped();if(record.response&&record.cache_expires_at>now())return JSON.parse(record.response);const receipt=JSON.parse(record.receipt_json);const rows=await all('SELECT id,doc_json FROM ai_suggestions WHERE tenant_id=? AND id IN(SELECT value FROM json_each(?))',tenantId,JSON.stringify(receipt.ids));const byId=new Map(rows.map(x=>[x.id,JSON.parse(x.doc_json)]));if(receipt.ids.some(id=>!byId.has(id)))throw Error('AI_REPLAY_MISSING');return {...(receipt.extra||{}),suggestions:receipt.ids.map(id=>{const s=byId.get(id);return {id:s.id,kind:s.kind,target:s.target,payload:s.payload,basis:s.basis,warnings:s.warnings,...(s.flags?{flags:s.flags}:{})}}),warnings:receipt.warnings,usage:receipt.usage};},
    async aiCapacity(userId,date,tier,limit,at,excludeHold=null){scoped();return first(`SELECT COALESCE((SELECT used FROM ai_quota_daily WHERE tenant_id=?1 AND date=?2 AND tier=?3),0) used,(SELECT COUNT(*) FROM ai_quota_holds WHERE tenant_id=?1 AND date=?2 AND tier=?3 AND status='held' AND expires_at>?4 AND (?6 IS NULL OR id<>?6)) held,(SELECT COUNT(*) FROM ai_requests WHERE tenant_id=?1 AND user_id=?5 AND batch_parent_id IS NULL AND status='pending' AND deadline_at>?4) pending`,tenantId,date,tier,at,userId,excludeHold);},
    async aiAcquire(record,old,limit,at){scoped();const state=old?`(SELECT version FROM ai_requests WHERE tenant_id=?1 AND id=?2 AND (status='failed' OR status='pending' AND deadline_at<=?3))=${old.version}`:`NOT EXISTS(SELECT 1 FROM ai_requests WHERE tenant_id=?1 AND user_id=?4 AND idem_key=?5)`;
      const guard=`INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?1,?6,1,CASE WHEN ${state} AND EXISTS(SELECT 1 FROM tenants t WHERE t.id=?1 AND t.status='active' AND t.deleted_at IS NULL AND (t.expires_at IS NULL OR strftime('%s',t.expires_at||'T23:59:59+08:00')*1000>?3)) AND (SELECT COUNT(*) FROM ai_requests WHERE tenant_id=?1 AND user_id=?4 AND batch_parent_id IS NULL AND status='pending' AND deadline_at>?3)<2 AND COALESCE((SELECT used FROM ai_quota_daily WHERE tenant_id=?1 AND date=?7 AND tier=?8),0)+(SELECT COUNT(*) FROM ai_quota_holds WHERE tenant_id=?1 AND date=?7 AND tier=?8 AND status='held' AND expires_at>?3 AND (?9 IS NULL OR id<>?9))<?10 THEN 1 ELSE 0 END`;
      const ops=[sql(guard,tenantId,record.id,at,record.user_id,record.idem_key,randomId('guard'),record.date,record.tier,old?.hold_id??null,limit)];
      if(old){ops.push(sql("UPDATE ai_quota_holds SET status='released' WHERE tenant_id=? AND id=? AND status='held'",tenantId,old.hold_id));ops.push(sql("UPDATE ai_requests SET status='pending',hold_id=?,deadline_at=?,response=NULL,receipt_json=NULL,finished_at=NULL,retain_until=?,version=version+1 WHERE tenant_id=? AND id=?",record.hold_id,record.deadline_at,at+2*86400000,tenantId,record.id));}
      else ops.push(sql("INSERT INTO ai_requests(tenant_id,id,user_id,idem_key,request_hash,path,status,hold_id,deadline_at,created_at,retain_until) VALUES(?,?,?,?,?,?,'pending',?,?,?,?)",tenantId,record.id,record.user_id,record.idem_key,record.request_hash,record.path,record.hold_id,record.deadline_at,at,at+2*86400000));
      ops.push(sql("INSERT INTO ai_quota_holds(tenant_id,id,date,tier,user_id,request_id,status,expires_at,created_at) VALUES(?,?,?,?,?,?,'held',?,?)",tenantId,record.hold_id,record.date,record.tier,record.user_id,record.id,record.hold_expires_at??at+120000,at));
      try{await db.batch(ops);return {ok:true}}catch(e){if(!/expected=actual|UNIQUE constraint/.test(String(e)))throw e;return {ok:false,capacity:await this.aiCapacity(record.user_id,record.date,record.tier,limit,at,old?.hold_id??null),latest:await this.aiRequest(record.user_id,record.idem_key)}}
    },
    async aiReserveBatch(parent,students,limit,at){scoped();const entries=students.map(student_id=>({student_id,id:randomId('air'),hold:randomId('hold')})),payload=JSON.stringify(entries),ops=[];
      ops.push(sql("INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?1,?2,1,CASE WHEN (SELECT COUNT(*) FROM ai_requests WHERE tenant_id=?1 AND user_id=?3 AND batch_parent_id IS NULL AND status='pending' AND deadline_at>?4)<2 AND (SELECT COUNT(*) FROM students WHERE tenant_id=?1 AND id IN(SELECT json_extract(value,'$.student_id') FROM json_each(?5)) AND deleted_at IS NULL)=json_array_length(?5) THEN 1 ELSE 0 END",tenantId,randomId('guard'),parent.user_id,at,payload));
      ops.push(sql("INSERT INTO ai_requests(tenant_id,id,user_id,idem_key,request_hash,path,status,hold_id,deadline_at,created_at,retain_until) VALUES(?,?,?,?,?,?,'pending',?,?,?,?)",tenantId,parent.id,parent.user_id,parent.idem_key,parent.request_hash,parent.path,'batch_'+parent.id,parent.deadline_at,at,at+2*86400000));
      ops.push(sql(`INSERT INTO ai_requests(tenant_id,id,user_id,idem_key,request_hash,path,batch_parent_id,status,hold_id,deadline_at,created_at,retain_until) SELECT ?1,json_extract(j.value,'$.id'),?2,?3||':'||json_extract(j.value,'$.student_id'),?4,?5,?6,'pending',json_extract(j.value,'$.hold'),?7,?8,?8+172800000 FROM json_each(?9) j WHERE CAST(j.key AS INTEGER)<MAX(0,?10-COALESCE((SELECT used FROM ai_quota_daily WHERE tenant_id=?1 AND date=?11 AND tier=?12),0)-(SELECT COUNT(*) FROM ai_quota_holds WHERE tenant_id=?1 AND date=?11 AND tier=?12 AND status='held' AND expires_at>?8))`,tenantId,parent.user_id,parent.idem_key,parent.request_hash,parent.path,parent.id,parent.deadline_at,at,payload,limit,parent.date,parent.tier));
      ops.push(sql("INSERT INTO ai_quota_holds(tenant_id,id,date,tier,user_id,request_id,status,expires_at,created_at) SELECT tenant_id,hold_id,?2,?3,user_id,id,'held',?4+120000,?4 FROM ai_requests WHERE tenant_id=?1 AND batch_parent_id=?5",tenantId,parent.date,parent.tier,at,parent.id));
      try{await db.batch(ops)}catch(e){if(!/expected=actual|UNIQUE constraint/.test(String(e)))throw e;return {ok:false,latest:await this.aiRequest(parent.user_id,parent.idem_key)}}
      const records=await all('SELECT * FROM ai_requests WHERE tenant_id=? AND batch_parent_id=? ORDER BY created_at,id',tenantId,parent.id);const byId=new Map(records.map(x=>[x.id,x]));return {ok:true,records:entries.filter(x=>byId.has(x.id)).map(x=>({student_id:x.student_id,...byId.get(x.id)})),skipped:entries.filter(x=>!byId.has(x.id)).map(x=>({student_id:x.student_id,reason:'ai_quota_exceeded'}))};
    },
    async aiCompleteBatch(parent,response,at){scoped();const receipt={ids:response.suggestions.map(x=>x.id),warnings:response.warnings,usage:response.usage,extra:{processed:response.processed,skipped:response.skipped}};storedRecord({response:JSON.stringify(response)},'批量AI响应');await sql("UPDATE ai_requests SET status='done',response=?,cache_expires_at=?,receipt_json=?,finished_at=?,retain_until=?,version=version+1 WHERE tenant_id=? AND id=? AND status='pending'",JSON.stringify(response),at+600000,JSON.stringify(receipt),at,at+2*86400000,tenantId,parent.id).run();},
    async aiHold(id){scoped();return first('SELECT * FROM ai_quota_holds WHERE tenant_id=? AND id=?',tenantId,id);},
    async aiFinish(record,response,suggestions,metrics,limit,at){scoped();const current=await this.aiRequestId(record.id),hold=await this.aiHold(record.hold_id);if(current.status==='done'&&hold?.status==='settled')return {replay:true,request:current};if(current.hold_id!==record.hold_id||current.status!=='pending'||hold?.status!=='held')return {lost:true};
      const receipt={ids:suggestions.map(x=>x.id),warnings:response.warnings,usage:response.usage,...record.reference_audit?{internal_reference_audit:record.reference_audit}:{}};storedRecord({response:JSON.stringify(response)},'AI响应');const guard=sql(`INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?1,?2,1,CASE WHEN EXISTS(SELECT 1 FROM ai_requests q JOIN ai_quota_holds h ON h.tenant_id=q.tenant_id AND h.id=q.hold_id WHERE q.tenant_id=?1 AND q.id=?3 AND EXISTS(SELECT 1 FROM tenants t WHERE t.id=?1 AND t.status='active' AND t.deleted_at IS NULL AND (t.expires_at IS NULL OR strftime('%s',t.expires_at||'T23:59:59+08:00')*1000>?5)) AND q.status='pending' AND h.id=?4 AND h.status='held' AND (h.expires_at>?5 OR COALESCE((SELECT used FROM ai_quota_daily d WHERE d.tenant_id=?1 AND d.date=h.date AND d.tier=h.tier),0)+(SELECT COUNT(*) FROM ai_quota_holds x WHERE x.tenant_id=?1 AND x.date=h.date AND x.tier=h.tier AND x.status='held' AND x.expires_at>?5)<?6)) THEN 1 ELSE 0 END`,tenantId,randomId('guard'),record.id,record.hold_id,at,limit);
      const ops=[guard,sql("UPDATE ai_quota_holds SET status='settled',settled_at=? WHERE tenant_id=? AND id=? AND status='held'",at,tenantId,record.hold_id),sql('INSERT INTO ai_quota_daily(tenant_id,id,date,tier,used) VALUES(?,?,?,?,1) ON CONFLICT(tenant_id,date,tier) DO UPDATE SET used=ai_quota_daily.used+1',tenantId,hold.date+':'+hold.tier,hold.date,hold.tier)];
      for(const suggestion of suggestions){storedRecord(suggestion,'AI建议');ops.push(sql('INSERT INTO ai_suggestions(tenant_id,id,user_id,kind,doc_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?)',tenantId,suggestion.id,record.user_id,suggestion.kind,JSON.stringify(suggestion),at,at+7*86400000));}
      ops.push(sql('INSERT INTO ai_usage(tenant_id,id,hold_id,request_id,user_id,date,tool,action,tier,model,prompt_tokens,completion_tokens,duration_ms,result,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',tenantId,randomId('aiu'),record.hold_id,record.id,record.user_id,hold.date,metrics.tool,metrics.action,hold.tier,metrics.model,metrics.prompt_tokens,metrics.completion_tokens,metrics.duration_ms,'ok',at));
      ops.push(sql("UPDATE ai_requests SET status='done',response=json_set(?,'$.usage.used_today',(SELECT used FROM ai_quota_daily d WHERE d.tenant_id=ai_requests.tenant_id AND d.date=? AND d.tier=?)),cache_expires_at=?,receipt_json=json_set(?,'$.usage.used_today',(SELECT used FROM ai_quota_daily d WHERE d.tenant_id=ai_requests.tenant_id AND d.date=? AND d.tier=?)),finished_at=?,retain_until=?,version=version+1 WHERE tenant_id=? AND id=? AND hold_id=?",JSON.stringify(response),hold.date,hold.tier,at+600000,JSON.stringify(receipt),hold.date,hold.tier,at,at+2*86400000,tenantId,record.id,record.hold_id));
      try{await db.batch(ops);return {ok:true}}catch(e){if(!/expected=actual/.test(String(e)))throw e;const latest=await this.aiRequestId(record.id);if(latest.status==='done')return {replay:true,request:latest};if(latest.hold_id!==record.hold_id)return {lost:true};await this.aiFailure(record,{...metrics,result:'blocked_after_expiry'},at,'expired');return {blocked:true}}
    },
    async aiFailure(record,metrics,at,status='released'){scoped();const h=await this.aiHold(record.hold_id);if(!h||h.status!=='held')return;await db.batch([sql('UPDATE ai_quota_holds SET status=? WHERE tenant_id=? AND id=? AND status=\'held\'',status,tenantId,record.hold_id),sql("UPDATE ai_requests SET status='failed',finished_at=?,version=version+1 WHERE tenant_id=? AND id=? AND hold_id=? AND status='pending'",at,tenantId,record.id,record.hold_id),sql(`INSERT INTO ai_usage(tenant_id,id,hold_id,request_id,user_id,date,tool,action,tier,model,prompt_tokens,completion_tokens,duration_ms,result,created_at) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15 WHERE NOT EXISTS(SELECT 1 FROM ai_usage WHERE tenant_id=?1 AND hold_id=?3)`,tenantId,randomId('aiu'),record.hold_id,record.id,record.user_id,h.date,metrics.tool,metrics.action,h.tier,metrics.model,metrics.prompt_tokens,metrics.completion_tokens,metrics.duration_ms,metrics.result||metrics.failure_reason||'other',at)]);},
    async aiRejected(record,metrics,at){scoped();await db.batch([sql("INSERT OR IGNORE INTO ai_requests(tenant_id,id,user_id,idem_key,request_hash,path,status,hold_id,deadline_at,created_at,finished_at,retain_until) VALUES(?,?,?,?,?,?,'failed',?,?,?,?,?)",tenantId,record.id,record.user_id,record.idem_key,record.request_hash,record.path,record.hold_id,record.deadline_at,at,at,at+2*86400000),sql("INSERT INTO ai_usage(tenant_id,id,hold_id,request_id,user_id,date,tool,action,tier,model,duration_ms,result,created_at) VALUES(?,?,NULL,?,?,?,?,?,?,?,0,'blocked',?)",tenantId,randomId('aiu'),record.id,record.user_id,record.date,metrics.tool,metrics.action,record.tier,metrics.model,at)]);},
    async aiCleanupPage(at){platform();const state=await first("SELECT value FROM platform_state WHERE id='ai_cleanup_cursor'"),rows=await all('SELECT id FROM tenants WHERE id>? ORDER BY id LIMIT 20',state?.value||'');const ids=JSON.stringify(rows.map(x=>x.id)),scope='tenant_id IN(SELECT value FROM json_each(?1))';await db.batch([sql(`UPDATE ai_requests SET response=NULL WHERE ${scope} AND status='done' AND cache_expires_at<=?2`,ids,at),sql(`DELETE FROM ai_quota_holds WHERE ${scope} AND EXISTS(SELECT 1 FROM ai_requests q WHERE q.tenant_id=ai_quota_holds.tenant_id AND q.id=ai_quota_holds.request_id AND q.retain_until<=?2)`,ids,at),sql(`DELETE FROM ai_requests WHERE ${scope} AND retain_until<=?2`,ids,at),sql(`DELETE FROM ai_suggestions WHERE ${scope} AND expires_at<=?2 AND NOT EXISTS(SELECT 1 FROM setting_changes c WHERE c.tenant_id=ai_suggestions.tenant_id AND c.suggestion_id=ai_suggestions.id)`,ids,at),sql("INSERT INTO platform_state(id,value) VALUES('ai_cleanup_cursor',?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",rows.length===20?rows.at(-1).id:'')]);return {institutions:rows.length};},
    async aiDayUsed(date,tier){scoped();return (await first('SELECT used FROM ai_quota_daily WHERE tenant_id=? AND date=? AND tier=?',tenantId,date,tier))?.used||0;},
    async aiUsage(date,supervisor){scoped();const daily=await all('SELECT tier,used FROM ai_quota_daily WHERE tenant_id=? AND date=?',tenantId,date);if(!supervisor)return {daily};const data=await db.batch([sql("SELECT tool,SUM(CASE WHEN tier='fast' AND result='ok' THEN 1 ELSE 0 END) fast,SUM(CASE WHEN tier='deep' AND result='ok' THEN 1 ELSE 0 END) deep FROM ai_usage WHERE tenant_id=? AND date=? GROUP BY tool ORDER BY tool",tenantId,date),sql("SELECT a.user_id,u.name,SUM(CASE WHEN a.tier='fast' AND result='ok' THEN 1 ELSE 0 END) fast,SUM(CASE WHEN a.tier='deep' AND result='ok' THEN 1 ELSE 0 END) deep FROM ai_usage a LEFT JOIN users u ON u.tenant_id=a.tenant_id AND u.id=a.user_id WHERE a.tenant_id=? AND a.date=? GROUP BY a.user_id ORDER BY a.user_id",tenantId,date)]);return {daily,by_tool:data[0].results,by_user:data[1].results};},
    async aiCleanup(at){scoped();await db.batch([sql("UPDATE ai_requests SET response=NULL WHERE tenant_id=? AND status='done' AND cache_expires_at<=?",tenantId,at),sql('DELETE FROM ai_quota_holds WHERE tenant_id=?1 AND request_id IN(SELECT id FROM ai_requests WHERE tenant_id=?1 AND retain_until<=?2)',tenantId,at),sql('DELETE FROM ai_requests WHERE tenant_id=? AND retain_until<=?',tenantId,at),sql('DELETE FROM ai_suggestions WHERE tenant_id=?1 AND expires_at<=?2 AND NOT EXISTS(SELECT 1 FROM setting_changes c WHERE c.tenant_id=?1 AND c.suggestion_id=ai_suggestions.id)',tenantId,at)]);},
    async growthStudent(id,teacherId=null){scoped();return first(`SELECT s.* FROM students s WHERE s.tenant_id=?1 AND s.id=?2 AND s.deleted_at IS NULL AND (?3 IS NULL OR EXISTS(SELECT 1 FROM lessons l JOIN lesson_participants p ON p.tenant_id=l.tenant_id AND p.lesson_id=l.id WHERE l.tenant_id=?1 AND l.teacher_id=?3 AND p.student_id=s.id AND l.deleted_at IS NULL AND p.deleted_at IS NULL))`,tenantId,id,teacherId);},
    async growthRepertoire(studentId){scoped();return all('SELECT * FROM growth_repertoire WHERE tenant_id=? AND student_id=? AND deleted_at IS NULL ORDER BY created_at,id',tenantId,studentId);},
    async growthReviewRows(lessonId){scoped();return all(`SELECT f.*,(SELECT COUNT(*) FROM growth_feedback_copies c WHERE c.tenant_id=f.tenant_id AND c.feedback_id=f.id) copied_count FROM growth_feedback f WHERE f.tenant_id=?1 AND f.lesson_id=?2 AND f.deleted_at IS NULL AND (f.seq=(SELECT MAX(x.seq) FROM growth_feedback x WHERE x.tenant_id=?1 AND x.lesson_id=f.lesson_id AND x.student_id=f.student_id) OR f.submission_id=(SELECT current_submission_id FROM lessons WHERE tenant_id=?1 AND id=?2) OR f.seq=(SELECT MAX(x.seq) FROM growth_feedback x WHERE x.tenant_id=?1 AND x.lesson_id=f.lesson_id AND x.student_id=f.student_id AND x.status='confirmed')) ORDER BY f.seq`,tenantId,lessonId);},
    async growthFeedbackRefs(studentIds,repertoireIds,images,suggestions=[]){scoped();const data=await db.batch([sql('SELECT id,student_id,name FROM growth_repertoire WHERE tenant_id=? AND id IN(SELECT value FROM json_each(?)) AND deleted_at IS NULL',tenantId,JSON.stringify(repertoireIds)),sql('SELECT id,version,hidden FROM gallery_images WHERE tenant_id=? AND id IN(SELECT value FROM json_each(?)) AND deleted_at IS NULL',tenantId,JSON.stringify(images)),sql("SELECT id,kind FROM ai_suggestions WHERE tenant_id=? AND id IN(SELECT value FROM json_each(?)) AND kind='feedback.message' AND expires_at>?",tenantId,JSON.stringify(suggestions),now())]);return {repertoire:data[0].results,images:data[1].results,suggestions:data[2].results};},
    async growthToday(teacher,from,to){scoped();const rows=await all(`SELECT l.id lesson_id,l.start_at,l.duration,l.teacher_id,l.assistant_id,l.status lesson_status,c.name course_name,s.id submission_id,s.status submission_status,s.kind,s.version,COALESCE(st.locked,0) locked,(SELECT json_group_array(name) FROM (SELECT st.name FROM lesson_participants lp JOIN students st ON st.tenant_id=lp.tenant_id AND st.id=lp.student_id AND st.deleted_at IS NULL WHERE lp.tenant_id=l.tenant_id AND lp.lesson_id=l.id AND lp.deleted_at IS NULL ORDER BY lp.created_at,lp.id LIMIT 6)) student_names_json FROM lessons l JOIN course_types c ON c.tenant_id=l.tenant_id AND c.id=l.course_type_id LEFT JOIN lesson_submissions s ON s.tenant_id=l.tenant_id AND s.id=l.current_submission_id LEFT JOIN settlements st ON st.tenant_id=l.tenant_id AND st.month=substr(l.start_at,1,7) AND st.deleted_at IS NULL WHERE l.tenant_id=? AND (l.teacher_id=? OR l.assistant_id=?) AND l.start_at>=? AND l.start_at<? AND l.deleted_at IS NULL ORDER BY l.start_at,l.id`,tenantId,teacher,teacher,from,to);return rows.map(({student_names_json,...row})=>({...row,student_names:JSON.parse(student_names_json||'[]')}));},
    async growthCopied(submissionId,studentId,user){scoped();const row=await first(`SELECT f.*,l.teacher_id FROM growth_feedback f JOIN lessons l ON l.tenant_id=f.tenant_id AND l.id=f.lesson_id WHERE f.tenant_id=? AND f.submission_id=? AND f.student_id=? AND f.deleted_at IS NULL AND l.deleted_at IS NULL ORDER BY f.seq DESC LIMIT 1`,tenantId,submissionId,studentId);if(!row){const legacy=await first(`SELECT r.id submission_id,r.lesson_id,r.status,l.teacher_id,p.student_id FROM lesson_submissions r JOIN lessons l ON l.tenant_id=r.tenant_id AND l.id=r.lesson_id AND l.deleted_at IS NULL JOIN submission_people p ON p.tenant_id=r.tenant_id AND p.submission_id=r.id AND p.student_id=?3 AND p.deleted_at IS NULL JOIN lesson_comments c ON c.tenant_id=r.tenant_id AND c.lesson_id=r.lesson_id AND c.student_id=p.student_id AND c.deleted_at IS NULL AND c.text=p.comment WHERE r.tenant_id=?1 AND r.id=?2 AND r.status='confirmed' AND r.deleted_at IS NULL`,tenantId,submissionId,studentId);return legacy?{row:{...legacy,id:null},current:true}:null;}const current=await first("SELECT id FROM growth_feedback WHERE tenant_id=? AND lesson_id=? AND student_id=? AND status='confirmed' AND deleted_at IS NULL ORDER BY seq DESC LIMIT 1",tenantId,row.lesson_id,studentId);return {row,current:current?.id===row.id};},
    async growthRecordCopy(row,user){scoped();await sql('INSERT INTO growth_feedback_copies(tenant_id,id,feedback_id,submission_id,student_id,actor_id,copied_at) VALUES(?,?,?,?,?,?,?)',tenantId,randomId('gfc'),row.id,row.submission_id,row.student_id,user.id,now()).run();},

    async settingsMissingCalendarNodes(keys) {scoped();return all("SELECT id FROM stage_types WHERE tenant_id=? AND deleted_at IS NULL AND json_extract(doc_json,'$.anchor') IN('on_node','before_node','after_node') AND json_extract(doc_json,'$.anchor_node') NOT IN(SELECT value FROM json_each(?))",tenantId,JSON.stringify(keys));},
    async settingsExistingCourseNames(names) {scoped();return all("SELECT subject,name FROM offer_courses WHERE tenant_id=? AND name IN(SELECT value FROM json_each(?)) AND deleted_at IS NULL",tenantId,JSON.stringify(names));},
    async settingsGet(kind,id='main') {
      scoped();return first(`SELECT * FROM ${settingTable(kind)} WHERE tenant_id=? AND id=? AND deleted_at IS NULL`,tenantId,id);
    },
    async settingsList(kind,{subject=null,group=null,q='',inactive=false,offset=0,limit=50}={}) {
      scoped();const table=settingTable(kind);
      const where="tenant_id=? AND deleted_at IS NULL AND (? IS NULL OR subject=?) AND (? IS NULL OR json_extract(doc_json,'$.group')=?) AND (?=1 OR active=1) AND instr(lower(name),lower(?))>0";
      const p=[tenantId,subject,subject,group,group,Number(inactive),q];
      const out=await db.batch([sql(`SELECT * FROM ${table} WHERE ${where} ORDER BY name,id LIMIT ? OFFSET ?`,...p,limit,offset),sql(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`,...p)]);
      return {rows:out[0].results,total:out[1].results[0].n};
    },
    async settingsReferences(kind,ids) {
      scoped();const table=settingTables[kind]||({course_types:'course_types',teachers:'teachers',gallery:'gallery_images'}[kind]);if(!table)throw Error('invalid reference kind');
      return all(`SELECT id,version FROM ${table} WHERE tenant_id=? AND id IN(SELECT value FROM json_each(?)) AND deleted_at IS NULL`,tenantId,JSON.stringify(ids));
    },
    async settingsDimensions(id) {scoped();return all('SELECT dim_key,retired FROM report_dimensions WHERE tenant_id=? AND class_id=?',tenantId,id);},
    async settingsWrite(kind,id,doc,old,actor,refs=[],action='save') {
      scoped();const ops=settingReferenceGuards(refs);
      if(old||!['courses','stage_types','report_classes'].includes(kind))ops.push(settingGuard(kind,id,old?.version||1,tenantId,!old));
      ops.push(settingUpsert(kind,id,doc,old,actor));
      if(kind==='report_classes')ops.push(...dimensionOps(id,doc.dimensions));
      if(kind==='courses')ops.push(sql(`INSERT INTO tenant_price_lists(tenant_id,id,doc_json,created_at,created_by,updated_at,updated_by,version) VALUES(?,'main','{}',?,?,?,?,2) ON CONFLICT(tenant_id,id) DO UPDATE SET version=tenant_price_lists.version+1,updated_at=excluded.updated_at,updated_by=excluded.updated_by`,tenantId,now(),actor.id,now(),actor.id));
      ops.push(settingAudit(tenantId,actor,action,id,old?{version:old.version,doc:JSON.parse(old.doc_json)}:null,{doc,applied_suggestion_ids:doc.applied_suggestion_ids||[]}));
      await db.batch(ops);
    },
    async settingsSubjects() {scoped();if(await platformMethods.available()){const rows=await all('SELECT t.id,t.pack_version,t.imported_at,p.name FROM tenant_subjects t JOIN subject_packs p ON p.key=t.id WHERE t.tenant_id=? ORDER BY t.id',tenantId),warnings=await platformMethods.importWarnings();return rows.map(x=>({...x,...warnings.some(w=>w.subject===x.id)?{warnings:['部分历史模板条目无法可靠映射，已保留，请在机构设置维护']}: {}}));}return all('SELECT id,pack_version,imported_at FROM tenant_subjects WHERE tenant_id=? ORDER BY id',tenantId);},
    async settingsImportSubject(key,actor) {scoped();const ops=await subjectOps([key],actor,tenantId,true);if(ops.length)try{await db.batch(ops);}catch(e){if(await platformMethods.available()&&await platformMethods.currentImport(key))return;if(/UNIQUE constraint|expected=actual/.test(String(e)))fail(422,'导入发生并发变更，请刷新后重试','validation_failed');throw e;}},
    async settingsBrand() {scoped();return first(`SELECT b.display_name,b.logo,b.login_bg,b.theme_color,b.version,x.qr_image_id FROM tenant_branding b LEFT JOIN tenant_brand x ON x.tenant_id=b.tenant_id AND x.id='brand' WHERE b.tenant_id=? AND b.id='brand'`,tenantId);},
    async settingsBrandWrite(data,old,actor) {
      scoped();const ops=settingReferenceGuards(data.qr_image_id?[['gallery',data.qr_image_id]]:[]);
      ops.push(sql(`INSERT INTO mutation_guards(tenant_id,id,expected,actual) VALUES(?,?,?,COALESCE((SELECT version FROM tenant_branding WHERE tenant_id=? AND id='brand'),-1))`,tenantId,randomId('guard'),old.version,tenantId));
      ops.push(sql(`UPDATE tenant_branding SET theme_color=?,version=version+1,updated_at=?,updated_by=? WHERE tenant_id=? AND id='brand'`,data.primary_color,now(),actor.id,tenantId));
      ops.push(sql(`INSERT INTO tenant_brand(tenant_id,id,qr_image_id) VALUES(?,'brand',?) ON CONFLICT(tenant_id,id) DO UPDATE SET qr_image_id=excluded.qr_image_id`,tenantId,data.qr_image_id));
      ops.push(settingAudit(tenantId,actor,'brand','brand',old,data));await db.batch(ops);
    },
    async galleryUnmeasured(limit=20){scoped();return all('SELECT id,r2_key FROM gallery_images WHERE tenant_id=? AND bytes=0 ORDER BY id LIMIT ?',tenantId,limit);},
    async gallerySetSizes(rows){scoped();await db.batch(rows.map(x=>sql('UPDATE gallery_images SET bytes=? WHERE tenant_id=? AND id=? AND bytes=0',x.bytes,tenantId,x.id)));},
    async galleryStorage(){scoped();const row=await first(`SELECT t.gallery_storage_limit AS "limit",COALESCE(SUM(g.bytes),0) used,COALESCE(SUM(CASE WHEN g.bytes=0 THEN 1 ELSE 0 END),0) pending,COALESCE(SUM(CASE WHEN g.id IS NOT NULL AND g.deleted_at IS NULL AND g.bytes IS NULL THEN 1 ELSE 0 END),0) missing,t.version FROM tenants t LEFT JOIN gallery_images g ON g.tenant_id=t.id WHERE t.id=? GROUP BY t.id`,tenantId);if(!row)fail(404,'不存在','not_found');return {...row,complete:row.pending===0};},
    async galleryStorageSetLimit(limit,expected,actor){scoped();await db.batch([sql('INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?,?,?,COALESCE((SELECT version FROM tenants WHERE id=? AND deleted_at IS NULL),-1)',tenantId,randomId('guard'),expected,tenantId),sql('UPDATE tenants SET gallery_storage_limit=?,version=version+1,updated_at=?,updated_by=? WHERE id=?',limit,now(),actor.id,tenantId),sql('INSERT INTO platform_audit(id,admin_id,action,tenant_id,detail,at,ip) VALUES(?,?,?,?,?,?,?)',randomId('pa'),actor.id,'gallery_storage_limit',tenantId,JSON.stringify({limit}),now(),'')]);return this.galleryStorage();},
    async galleryReleaseBytes(id){scoped();await sql('UPDATE gallery_images SET bytes=NULL WHERE tenant_id=? AND id=? AND deleted_at IS NOT NULL',tenantId,id).run();},
    async settingsGallery(id,includeDeleted=false) {scoped();return first('SELECT * FROM gallery_images WHERE tenant_id=? AND id=? AND (?=1 OR deleted_at IS NULL)',tenantId,id,Number(includeDeleted));},
    async settingsGalleryList(tag,offset,limit) {
      scoped();const p=[tenantId,tag,tag];const where="tenant_id=? AND deleted_at IS NULL AND hidden=0 AND (? IS NULL OR EXISTS(SELECT 1 FROM json_each(tags_json) WHERE value=?))";
      const data=await db.batch([sql(`SELECT * FROM gallery_images WHERE ${where} ORDER BY created_at DESC,id LIMIT ? OFFSET ?`,...p,limit,offset),sql(`SELECT COUNT(*) n FROM gallery_images WHERE ${where}`,...p)]);return {rows:data[0].results,total:data[1].results[0].n};
    },
    async settingsGalleryCreate(row,actor) {scoped();const ops=[];if(row.bytes!==undefined)ops.push(sql(`INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?1,?2,1,CASE WHEN NOT EXISTS(SELECT 1 FROM gallery_images WHERE tenant_id=?1 AND bytes=0) AND COALESCE((SELECT SUM(bytes) FROM gallery_images WHERE tenant_id=?1),0)+?3<=(SELECT gallery_storage_limit FROM tenants WHERE id=?1) THEN 1 ELSE 0 END`,tenantId,randomId('guard'),row.bytes));ops.push(sql('INSERT INTO gallery_images(tenant_id,id,r2_key,mime,width,height,tags_json,consent,bytes,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',tenantId,row.id,row.r2_key,row.mime,row.width,row.height,JSON.stringify(row.tags),Number(row.consent),row.bytes??0,now(),actor.id,now(),actor.id),settingAudit(tenantId,actor,'upload',row.id,null,{width:row.width,height:row.height,tags:row.tags}));await db.batch(ops);} ,
    async settingsGalleryWrite(row,tags,consent,actor,remove=false) {
      scoped();const refs=await first(`SELECT (SELECT COUNT(*) FROM setting_asset_refs WHERE tenant_id=?1 AND image_id=?2)+(SELECT COUNT(*) FROM tenant_brand WHERE tenant_id=?1 AND qr_image_id=?2) n`,tenantId,row.id);
      const keep=refs.n>0,at=now();
      await db.batch([sql(`INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?1,?2,?3,(SELECT COUNT(*) FROM setting_asset_refs WHERE tenant_id=?1 AND image_id=?4)+(SELECT COUNT(*) FROM tenant_brand WHERE tenant_id=?1 AND qr_image_id=?4)`,tenantId,randomId('guard'),refs.n,row.id),sql('INSERT INTO mutation_guards(tenant_id,id,expected,actual) VALUES(?,?,?,COALESCE((SELECT version FROM gallery_images WHERE tenant_id=? AND id=? AND deleted_at IS NULL),-1))',tenantId,randomId('guard'),row.version,tenantId,row.id),sql('UPDATE gallery_images SET tags_json=?,consent=?,hidden=?,deleted_at=?,version=version+1,updated_at=?,updated_by=? WHERE tenant_id=? AND id=?',JSON.stringify(tags),Number(consent),Number(remove),remove&&!keep?at:null,at,actor.id,tenantId,row.id),settingAudit(tenantId,actor,remove?'delete_image':'tag_image',row.id,{tags:JSON.parse(row.tags_json)},{tags,hidden:remove,kept:keep})]);return {kept:keep};
    },
    async settingsAssetReference(imageId,entity,entityId) {scoped();await db.batch([...settingReferenceGuards([['gallery',imageId]]),sql('INSERT INTO setting_asset_refs(tenant_id,id,image_id,entity,entity_id) VALUES(?,?,?,?,?)',tenantId,randomId('ref'),imageId,entity,entityId)]);},
    async settingsImportPreview(id,rows,rev,user) {scoped();await db.batch([sql('INSERT INTO setting_imports(tenant_id,id,owner_id,rows_json,price_rev,expires_at) VALUES(?,?,?,?,?,?)',tenantId,id,user.id,JSON.stringify(rows),rev,now()+1200000),settingAudit(tenantId,user,'preview_courses',id,null,{rows:rows.length})]);},
    async settingsImportPreviewGet(id,user) {scoped();return first('SELECT * FROM setting_imports WHERE tenant_id=? AND id=? AND owner_id=? AND expires_at>?',tenantId,id,user.id,now());},
    async settingsImportCommit(preview,rows,user) {
      scoped();const ops=[settingGuard('prices','main',preview.price_rev,tenantId,true),sql(`INSERT INTO mutation_guards(tenant_id,id,expected,actual) VALUES(?,?,0,COALESCE((SELECT consumed FROM setting_imports WHERE tenant_id=? AND id=? AND owner_id=? AND expires_at>?),-1))`,tenantId,randomId('guard'),tenantId,preview.id,user.id,now())];
      for(const doc of rows)ops.push(...settingReferenceGuards(doc.course_type_id?[['course_types',doc.course_type_id]]:[]),settingUpsert('courses',randomId('crs'),doc,null,user));
      ops.push(sql('UPDATE setting_imports SET consumed=1 WHERE tenant_id=? AND id=?',tenantId,preview.id));
      ops.push(sql(`INSERT INTO tenant_price_lists(tenant_id,id,doc_json,created_at,created_by,updated_at,updated_by,version) VALUES(?,'main','{}',?,?,?,?,2) ON CONFLICT(tenant_id,id) DO UPDATE SET version=tenant_price_lists.version+1`,tenantId,now(),user.id,now(),user.id));
      ops.push(settingAudit(tenantId,user,'import_courses',preview.id,null,{count:rows.length}));await db.batch(ops);
    },
    async settingsSuggestion(id,user,payload,targets={}) {
      scoped();const captured={...targets},entities={course:'courses',price:'courses',stage_type:'stage_types',stage_rule:'stage_rules',calendar:'calendar',course_rule:'course_rules',report_class:'report_classes'};
      for(const op of payload.ops||[]) {
        const kind=entities[op.entity];if(!kind)continue;
        const id=['stage_rules','calendar','course_rules'].includes(kind)?'main':op.id,key=kind+':'+id;
        if(captured[key]===undefined)captured[key]=(await first(`SELECT version FROM ${settingTable(kind)} WHERE tenant_id=? AND id=? AND deleted_at IS NULL`,tenantId,id))?.version||1;
      }
      await db.batch([sql('INSERT INTO ai_suggestions(tenant_id,id,user_id,kind,doc_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?)',tenantId,id,user.id,'settings.change',JSON.stringify({payload,target_versions:captured}),now(),now()+7*86400000)]);
    },
    async settingsSuggestionGet(id,user) {scoped();return first(`SELECT * FROM ai_suggestions WHERE tenant_id=? AND id=? AND kind='settings.change' AND expires_at>? AND user_id=?`,tenantId,id,now(),user.id);},
    async settingsChangeCreate(id,suggestion,payload,before,user) {scoped();await db.batch([sql('INSERT INTO setting_changes(tenant_id,id,suggestion_id,payload_json,before_json,status,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,\'pending\',?,?,?,?)',tenantId,id,suggestion,JSON.stringify(payload),JSON.stringify(before),now(),user.id,now(),user.id),settingAudit(tenantId,user,'propose_change',id,null,{suggestion_id:suggestion,payload})]);},
    async settingsChange(id) {scoped();return first('SELECT * FROM setting_changes WHERE tenant_id=? AND id=?',tenantId,id);},
    async settingsChanges(status,offset,limit) {scoped();const data=await db.batch([sql('SELECT * FROM setting_changes WHERE tenant_id=? AND (? IS NULL OR status=?) ORDER BY created_at DESC,id LIMIT ? OFFSET ?',tenantId,status,status,limit,offset),sql('SELECT COUNT(*) n FROM setting_changes WHERE tenant_id=? AND (? IS NULL OR status=?)',tenantId,status,status)]);return {rows:data[0].results,total:data[1].results[0].n};},
    async settingsChangeApply(change,targets,user,status) {
      scoped();const ops=[sql('INSERT INTO mutation_guards(tenant_id,id,expected,actual) VALUES(?,?,?,COALESCE((SELECT version FROM setting_changes WHERE tenant_id=? AND id=?),-1))',tenantId,randomId('guard'),change.version,tenantId,change.id)];
      for(const target of targets) {
        ops.push(settingGuard(target.kind,target.id,target.old?.version||1,tenantId,!target.old),...settingReferenceGuards(target.refs),settingUpsert(target.kind,target.id,target.doc,target.old,user));
        if(target.kind==='report_classes')ops.push(...dimensionOps(target.id,target.doc.dimensions,tenantId,status==='reverted'));
      }
      if(targets.some(x=>x.kind==='courses'))ops.push(sql(`INSERT INTO tenant_price_lists(tenant_id,id,doc_json,created_at,created_by,updated_at,updated_by,version) VALUES(?,'main','{}',?,?,?,?,2) ON CONFLICT(tenant_id,id) DO UPDATE SET version=tenant_price_lists.version+1`,tenantId,now(),user.id,now(),user.id));
      ops.push(sql('UPDATE setting_changes SET status=?,after_json=?,version=version+1,updated_at=?,updated_by=? WHERE tenant_id=? AND id=?',status,JSON.stringify(targets.map(x=>({kind:x.kind,id:x.id,version:(x.old?.version||1)+1,doc:x.doc}))),now(),user.id,tenantId,change.id));
      ops.push(settingAudit(tenantId,user,status,change.id,{status:change.status},{status,suggestion_id:change.suggestion_id}));await db.batch(ops);
    },

    async importReferences(names, typeNames = [], ids = []) {
      scoped();
      const ns = JSON.stringify([...new Set(names)]),
        ts = JSON.stringify([...new Set(typeNames)]),
        rs = JSON.stringify(ids);
      const result = await db.batch([
        sql(
          "SELECT id,name,grade,school,status FROM students WHERE tenant_id=? AND name IN(SELECT value FROM json_each(?)) AND deleted_at IS NULL",
          tenantId,
          ns,
        ),
        sql(
          "SELECT id,name FROM teachers WHERE tenant_id=? AND name IN(SELECT value FROM json_each(?)) AND deleted_at IS NULL",
          tenantId,
          ns,
        ),
        sql(
          "SELECT id,name FROM course_types WHERE tenant_id=? AND name IN(SELECT value FROM json_each(?)) AND deleted_at IS NULL AND active=1",
          tenantId,
          ts,
        ),
        sql(
          "SELECT id FROM students WHERE tenant_id=? AND id IN(SELECT value FROM json_each(?)) UNION ALL SELECT id FROM teachers WHERE tenant_id=? AND id IN(SELECT value FROM json_each(?)) UNION ALL SELECT id FROM packages WHERE tenant_id=? AND id IN(SELECT value FROM json_each(?))",
          tenantId,
          rs,
          tenantId,
          rs,
          tenantId,
          rs,
        ),
      ]);
      return {
        students: result[0].results,
        teachers: result[1].results,
        types: result[2].results,
        existing: result[3].results.map((x) => x.id),
      };
    },
    async businessExport(table, offset) {
      scoped();
      const q = businessExportSql[table];
      if (!q) throw Error("invalid export table");
      return all(q, tenantId, offset);
    },
    async updateJobManifest(id, previous, manifest) {
      scoped();
      const out = await sql(
        "UPDATE data_jobs SET manifest_json=? WHERE tenant_id=? AND id=? AND status='staging' AND manifest_json=?",
        boundedText(JSON.stringify(manifest), MANIFEST_BUDGET, "作业/备份清单"),
        tenantId,
        id,
        previous,
      ).run();
      if (!out.meta.changes) fail(409, "作业进度已变更，请刷新后重试");
    },
    async stageConverted(id, rows) {
      scoped();
      const ops = [
        sql(
          "DELETE FROM data_job_rows WHERE tenant_id=? AND job_id=? AND table_name NOT LIKE 'raw:%'",
          tenantId,
          id,
        ),
      ];
      for (const table of restoreTables)
        for (const row of rows[table] || [])
          ops.push(
            sql(
              "INSERT INTO data_job_rows(tenant_id,id,job_id,table_name,row_id,row_json) VALUES(?,?,?,?,?,?)",
              tenantId,
              randomId("row"),
              id,
              table,
              row.id,
              JSON.stringify(storedRecord(row, "导入记录")),
            ),
          );
      await db.batch(ops);
    },
    async beginBackup(id, at, manifest) {
      platform();
      const ops = [
        sql(
          "INSERT INTO backup_snapshots(id,at,status,manifest_json) VALUES(?,?,'running',?)",
          id,
          at,
          boundedText(
            JSON.stringify(manifest),
            MANIFEST_BUDGET,
            "作业/备份清单",
          ),
        ),
      ];
      for (const statement of snapshotPreflightSql)
        ops.push(sql(statement, id));
      for (const statement of snapshotCaptureSql) ops.push(sql(statement, id));
      ops.push(
        sql(
          "DELETE FROM mutation_guards WHERE tenant_id='platform' AND id>=? AND id<?",
          id + ":",
          id + ":" + String.fromCharCode(127),
        ),
      );
      ops.push(
        sql(
          "INSERT INTO backup_runs(id,at,status,detail) VALUES(?,?,'running','正在分批加密备份')",
          id,
          at,
        ),
      );
      try {
        await db.batch(ops);
      } catch (e) {
        if (/CHECK constraint/.test(String(e.message)))
          fail(
            413,
            "备份发现过大的历史记录，请先按只读检查定位并人工处理；未生成半份快照",
            "D1_SIZE_LIMIT",
          );
        throw e;
      }
    },
    async activeBackup() {
      platform();
      return first(
        "SELECT * FROM backup_snapshots WHERE status='running' ORDER BY at LIMIT 1",
      );
    },
    async backupCounts(id) {
      platform();
      return all(
        "SELECT table_name,COUNT(*) n FROM backup_snapshot_rows WHERE snapshot_id=? GROUP BY table_name",
        id,
      );
    },
    async snapshotPage(id, table, offset) {
      platform();
      return (
        await all(
          "WITH candidates AS (SELECT source_id,tenant_id,row_json FROM backup_snapshot_rows WHERE snapshot_id=? AND table_name=? ORDER BY source_id,tenant_id LIMIT 200 OFFSET ?), sized AS (SELECT row_json,source_id,tenant_id,SUM(length(CAST(row_json AS BLOB))) OVER(ORDER BY source_id,tenant_id) bytes,ROW_NUMBER() OVER(ORDER BY source_id,tenant_id) seq FROM candidates) SELECT row_json FROM sized WHERE bytes<=1048576 OR seq=1 ORDER BY source_id,tenant_id",
          id,
          table,
          offset,
        )
      ).map((x) => JSON.parse(x.row_json));
    },
    async advanceBackup(id, previous, manifest, done = false) {
      platform();
      const ops = [
        sql(
          "UPDATE backup_snapshots SET manifest_json=?,status=? WHERE id=? AND status='running' AND manifest_json=?",
          boundedText(
            JSON.stringify(manifest),
            MANIFEST_BUDGET,
            "作业/备份清单",
          ),
          done ? "completed" : "running",
          id,
          previous,
        ),
      ];
      if (!done)
        ops.push(
          sql(
            "UPDATE backup_runs SET status='running',detail='正在分批加密备份' WHERE id=? AND changes()=1",
            id,
          ),
        );
      if (done)
        ops.push(
          sql(
            "UPDATE backup_runs SET status='completed',detail='加密全库备份完成' WHERE id=? AND EXISTS(SELECT 1 FROM backup_snapshots WHERE id=? AND status='completed')",
            id,
            id,
          ),
          sql(
            "DELETE FROM backup_snapshot_rows WHERE snapshot_id=? AND EXISTS(SELECT 1 FROM backup_snapshots WHERE id=? AND status='completed')",
            id,
            id,
          ),
        );
      const result = await db.batch(ops);
      return !!result[0].meta.changes;
    },
    async backupGcCursor() {
      platform();
      return (
        (
          await first(
            "SELECT value FROM platform_state WHERE id='backup_gc_cursor'",
          )
        )?.value || undefined
      );
    },
    async saveBackupGcCursor(cursor) {
      platform();
      await sql(
        "INSERT INTO platform_state(id,value) VALUES('backup_gc_cursor',?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
        cursor || "",
      ).run();
    },
    async backupLog(id, status, detail) {
      platform();
      await sql(
        "INSERT INTO backup_runs(id,at,status,detail) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,detail=excluded.detail",
        id,
        now(),
        status,
        detail,
      ).run();
    },
    async backupRuns() {
      platform();
      return (
        await all(
          "SELECT id,at,status,detail FROM backup_runs ORDER BY at DESC LIMIT 200",
        )
      ).map((row) => ({
        ...row,
        status_label: BACKUP_STATUS_LABELS[row.status] || "未知状态",
      }));
    },
    async jobs() {
      scoped();
      return all(
        "SELECT id,kind,status,created_at,reason FROM data_jobs WHERE tenant_id=? ORDER BY created_at DESC LIMIT 200",
        tenantId,
      );
    },
    async job(id) {
      scoped();
      return first(
        "SELECT * FROM data_jobs WHERE tenant_id=? AND id=?",
        tenantId,
        id,
      );
    },
    async createJob(job, admin, revision) {
      scoped();
      await db.batch([
        sql(
          "INSERT INTO mutation_guards(tenant_id,id,expected,actual) VALUES(?,?,?,COALESCE((SELECT version FROM tenant_data_versions WHERE tenant_id=?),0))",
          tenantId,
          randomId("guard"),
          revision,
          tenantId,
        ),
        sql("DELETE FROM mutation_guards WHERE tenant_id=?", tenantId),
        sql(
          "INSERT INTO data_jobs(tenant_id,id,kind,status,source_tenant,manifest_json,created_at,admin_id,reason) VALUES(?,?,?,'staging',?,?,?,?,?)",
          tenantId,
          job.id,
          job.kind,
          job.source_tenant,
          boundedText(
            JSON.stringify(job.manifest),
            MANIFEST_BUDGET,
            "作业清单",
          ),
          now(),
          admin.id,
          job.reason,
        ),
        sql(
          "INSERT INTO platform_audit(id,at,admin_id,action,tenant_id,target,detail,reason,ip) VALUES(?,?,?,?,?,?,?,?,?)",
          randomId("pa"),
          now(),
          admin.id,
          "data_job_start",
          tenantId,
          job.id,
          "创建数据导入/恢复作业",
          job.reason,
          "",
        ),
      ]);
    },
    async stageJob(id, table, rows) {
      scoped();
      if (rows.length > 200) fail(400, "每批最多200行");
      await db.batch(
        rows.map((row) =>
          sql(
            "INSERT INTO data_job_rows(tenant_id,id,job_id,table_name,row_id,row_json) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM data_jobs WHERE tenant_id=? AND id=? AND status='staging') ON CONFLICT(tenant_id,job_id,table_name,row_id) DO UPDATE SET row_json=excluded.row_json",
            tenantId,
            randomId("row"),
            id,
            table,
            String(row.id),
            table.startsWith("raw:")
              ? boundedText(
                  JSON.stringify(row),
                  D1_RECORD_BUDGET,
                  "加密导入暂存行",
                )
              : JSON.stringify(storedRecord(row, "导入记录")),
            tenantId,
            id,
          ),
        ),
      );
    },
    async stagedRows(id) {
      scoped();
      return all(
        "SELECT table_name,row_json FROM data_job_rows WHERE tenant_id=? AND job_id=? ORDER BY table_name,row_id LIMIT 20001",
        tenantId,
        id,
      );
    },
    async cancelJob(id, admin) {
      scoped();
      await db.batch([
        sql(
          "UPDATE data_jobs SET status='cancelled' WHERE tenant_id=? AND id=? AND status IN ('staging','ready')",
          tenantId,
          id,
        ),
        sql(
          "DELETE FROM data_job_rows WHERE tenant_id=? AND job_id=? AND EXISTS(SELECT 1 FROM data_jobs WHERE tenant_id=? AND id=? AND status='cancelled')",
          tenantId,
          id,
          tenantId,
          id,
        ),
      ]);
      await sql(
        "INSERT INTO platform_audit(id,at,admin_id,action,tenant_id,target,detail,ip) VALUES(?,?,?,?,?,?,?,?)",
        randomId("pa"),
        now(),
        admin.id,
        "data_job_cancel",
        tenantId,
        id,
        "取消导入/恢复作业",
        "",
      ).run();
    },
    async emptyBusiness() {
      scoped();
      const result = await db.batch(
        emptyBusinessSql.map((q) => sql(q, tenantId)),
      );
      return result.every((x) => !x.results[0]?.n);
    },

    async restoreReferences(id) {
      scoped();
      return all(
        "SELECT u.name,u.teacher_id,u.student_id FROM users u WHERE u.tenant_id=? AND u.deleted_at IS NULL AND ((u.teacher_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM data_job_rows r WHERE r.tenant_id=u.tenant_id AND r.job_id=? AND r.table_name='teachers' AND r.row_id=u.teacher_id AND json_extract(r.row_json,'$.deleted_at') IS NULL AND (u.active=0 OR json_extract(r.row_json,'$.status')='active'))) OR (u.student_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM data_job_rows r WHERE r.tenant_id=u.tenant_id AND r.job_id=? AND r.table_name='students' AND r.row_id=u.student_id AND json_extract(r.row_json,'$.deleted_at') IS NULL AND (u.active=0 OR json_extract(r.row_json,'$.status')='active'))))",
        tenantId,
        id,
        id,
      );
    },
    async finalizeJob(id, admin, kind, settings, expectedCounts) {
      scoped();
      const operations = [
        sql(
          "INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?,?,1,CASE WHEN status='staging' THEN 1 ELSE 0 END FROM data_jobs WHERE tenant_id=? AND id=?",
          tenantId,
          randomId("guard"),
          tenantId,
          id,
        ),
        sql(
          "INSERT INTO trusted_imports(tenant_id,id) VALUES(?,?)",
          tenantId,
          id,
        ),
      ];
      // FK deferral is transaction-local; never disable FK validation.
      operations.push(sql("PRAGMA defer_foreign_keys=ON"));
      operations.push(
        sql(
          "INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?,?,0,COUNT(*) FROM users u WHERE u.tenant_id=? AND u.deleted_at IS NULL AND ((u.teacher_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM data_job_rows r WHERE r.tenant_id=u.tenant_id AND r.job_id=? AND r.table_name='teachers' AND r.row_id=u.teacher_id AND json_extract(r.row_json,'$.deleted_at') IS NULL AND (u.active=0 OR json_extract(r.row_json,'$.status')='active'))) OR (u.student_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM data_job_rows r WHERE r.tenant_id=u.tenant_id AND r.job_id=? AND r.table_name='students' AND r.row_id=u.student_id AND json_extract(r.row_json,'$.deleted_at') IS NULL AND (u.active=0 OR json_extract(r.row_json,'$.status')='active'))))",
          tenantId,
          randomId("guard"),
          tenantId,
          id,
          id,
        ),
      );

      // 合作课程属于平台当前状态：在同一恢复事务中保留，而非回滚旧备份排期。

      for (const table of [...restoreTables].reverse())
        operations.push(sql(restoreSql[table].clear, tenantId));
      for (const table of restoreTables)
        operations.push(sql(stagedRestoreSql[table], tenantId, tenantId, id));
      // A pre-0018 backup or a legacy import has no frozen valuation records.
      operations.push(sql(`INSERT INTO credit_income_entries
        SELECT e.* FROM credit_income_legacy_estimates e WHERE e.tenant_id=?
          AND NOT EXISTS(SELECT 1 FROM credit_income_entries x WHERE x.tenant_id=e.tenant_id AND x.id=e.id)`, tenantId));
      for (const key of BUSINESS_SETTINGS) {
        operations.push(
          sql(
            "DELETE FROM tenant_settings WHERE tenant_id=? AND id=?",
            tenantId,
            key,
          ),
        );
        if (settings[key] !== undefined)
          operations.push(
            sql(
              "INSERT INTO tenant_settings(tenant_id,id,value,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,?,?)",
              tenantId,
              key,
              JSON.stringify(settings[key]),
              now(),
              admin.id,
              now(),
              admin.id,
            ),
          );
      }
      operations.push(
        sql("DELETE FROM sessions WHERE tenant_id=?", tenantId),
        sql(
          "UPDATE tenant_data_versions SET version=version+1 WHERE tenant_id=?",
          tenantId,
        ),
        sql(
          "DELETE FROM trusted_imports WHERE tenant_id=? AND id=?",
          tenantId,
          id,
        ),
        sql(
          "UPDATE data_jobs SET status='completed' WHERE tenant_id=? AND id=?",
          tenantId,
          id,
        ),
        sql(
          "DELETE FROM data_job_rows WHERE tenant_id=? AND job_id=?",
          tenantId,
          id,
        ),
        sql("DELETE FROM mutation_guards WHERE tenant_id=?", tenantId),
        sql(
          "INSERT INTO audit_log(tenant_id,id,at,actor_id,actor_label,module,action,entity_id,summary) VALUES(?,?,?,?,?,?,?,?,?)",
          tenantId,
          randomId("aud"),
          now(),
          admin.id,
          "系统维护",
          "imports",
          kind,
          id,
          "按机构" +
            (kind === "restore" ? "恢复" : "旧版导入") +
            "，保留当前账号、权限、品牌及审计",
        ),
        sql(
          "INSERT INTO platform_audit(id,at,admin_id,action,tenant_id,target,detail,reason,ip) SELECT ?,?,?,?,?,?,?,reason,? FROM data_jobs WHERE tenant_id=? AND id=?",
          randomId("pa"),
          now(),
          admin.id,
          kind,
          tenantId,
          id,
          JSON.stringify(expectedCounts),
          "",
          tenantId,
          id,
        ),
      );
      await db.batch(operations);
    },
    async overview(offset = 0) {
      platform();
      return all(
        "SELECT t.id,t.name,t.slug,t.status,t.expires_at,t.type,t.city,t.staff_seat_limit,t.student_seat_limit,(SELECT COUNT(*) FROM students s WHERE s.tenant_id=t.id AND s.deleted_at IS NULL AND s.status='active') student_count,(SELECT COUNT(*) FROM lessons l WHERE l.tenant_id=t.id AND l.deleted_at IS NULL AND SUBSTR(l.start_at,1,7)=strftime('%Y-%m','now','+8 hours')) lesson_count,(SELECT MAX(at) FROM auth_log a WHERE a.tenant_id=t.id AND a.event='login_success') last_active,(SELECT COUNT(*) FROM auth_log a WHERE a.tenant_id=t.id AND a.at>? AND a.event IN ('login_failed','login_locked')) login_failures FROM tenants t ORDER BY t.created_at DESC,t.id LIMIT 200 OFFSET ?",
        now() - 86400000,
        offset,
      );
    },

    async announcements(offset = 0, status = "") {
      platform();
      return all(
        `SELECT a.*,CASE WHEN a.withdrawn_at IS NULL THEN 'published' ELSE 'withdrawn' END status,
         (SELECT json_group_array(tenant_id) FROM announcement_targets t WHERE t.announcement_id=a.id) tenants
         FROM platform_announcements a WHERE ?1='' OR (a.withdrawn_at IS NULL)= (?1='published')
         ORDER BY a.created_at DESC,a.id LIMIT 200 OFFSET ?2`,
        status, offset,
      );
    },
    async withdrawAnnouncement(id, op, actor, reason) {
      platform();
      const prior = await this.platformOperation(op.id, op.fingerprint);
      if (prior) return prior;
      const row = await first("SELECT title,withdrawn_at FROM platform_announcements WHERE id=?", id);
      if (!row) fail(404, "不存在");
      const at = now(), result = { id, status: "withdrawn", withdrawn_at: at };
      const out = await db.batch([
        sql("UPDATE platform_announcements SET withdrawn_at=?,withdrawn_by=?,withdrawal_reason=? WHERE id=? AND withdrawn_at IS NULL", at, actor.id, reason, id),
        sql("INSERT INTO platform_audit(id,at,admin_id,action,target,detail,reason,ip) SELECT ?,?,?,'withdraw_announcement',?,?,?,? WHERE changes()=1",
          op.id, at, actor.id, id, JSON.stringify({ fingerprint: op.fingerprint, result, title: row.title }), reason, actor.ip || ""),
      ]);
      if (!out[0].meta.changes) {
        const replay = await this.platformOperation(op.id, op.fingerprint);
        if (replay) return replay;
        fail(409, "公告已撤回");
      }
      return result;
    },

    async publishAnnouncement(row, tenants, admin) {
      platform();
      const ops = [
        sql(
          "INSERT INTO platform_announcements(id,title,content,roles,starts_at,ends_at,created_at,created_by) VALUES(?,?,?,?,?,?,?,?)",
          row.id,
          row.title,
          row.content,
          JSON.stringify(row.roles),
          row.starts_at,
          row.ends_at,
          now(),
          admin.id,
        ),
      ];
      for (const id of tenants)
        ops.push(
          sql(
            "INSERT INTO announcement_targets(tenant_id,id,announcement_id) VALUES(?,?,?)",
            id,
            randomId("rec"),
            row.id,
          ),
        );
      ops.push(
        platformStmt(
          admin.id,
          "announcement",
          null,
          "发布系统消息，" + tenants.length + "个机构",
        ),
      );
      await db.batch(ops);
    },
    async endMaintenance(id, admin) {
      scoped();
      await db.batch([
        sql(
          "UPDATE maintenance_leases SET revoked=1 WHERE tenant_id=? AND id=? AND admin_id=?",
          tenantId,
          id,
          admin.id,
        ),
        sql(
          "INSERT INTO platform_audit(id,at,admin_id,action,tenant_id,target,detail,ip) SELECT ?,?,?,?,?,?,?,? WHERE changes()=1",
          randomId("pa"),
          now(),
          admin.id,
          "maintenance_end",
          tenantId,
          id,
          "退出代管",
          "",
        ),
      ]);
    },
    async lookupNames(rows) {
      scoped();
      const ids = JSON.stringify([
        ...new Set(
          rows
            .flatMap((row) => [
              row.student_id,
              row.teacher_id,
              row.course_type_id,
              row.location_id,
              row.class_id,
              row.assignee_id,
            ])
            .filter(Boolean),
        ),
      ]);
      return all(
        "SELECT 'student' kind,id,name FROM students WHERE tenant_id=?1 AND id IN(SELECT value FROM json_each(?2)) UNION ALL SELECT 'teacher',id,name FROM teachers WHERE tenant_id=?1 AND id IN(SELECT value FROM json_each(?2)) UNION ALL SELECT 'course',id,name FROM course_types WHERE tenant_id=?1 AND id IN(SELECT value FROM json_each(?2)) UNION ALL SELECT 'location',id,name FROM locations WHERE tenant_id=?1 AND id IN(SELECT value FROM json_each(?2)) UNION ALL SELECT 'class',id,name FROM classes WHERE tenant_id=?1 AND id IN(SELECT value FROM json_each(?2)) UNION ALL SELECT 'assignee',id,name FROM users WHERE tenant_id=?1 AND id IN(SELECT value FROM json_each(?2))",
        tenantId,
        ids,
      );
    },
    async maintenanceLease(id, admin) {
      scoped();
      return first(
        "SELECT * FROM maintenance_leases WHERE tenant_id=? AND id=? AND admin_id=? AND expires_at>? AND revoked=0",
        tenantId,
        id,
        admin.id,
        now(),
      );
    },
    async startMaintenance(lease, admin) {
      scoped();
      await db.batch([
        sql(
          "INSERT INTO maintenance_leases(tenant_id,id,admin_id,reason,expires_at) VALUES(?,?,?,?,?)",
          tenantId,
          lease.id,
          admin.id,
          lease.reason,
          now() + 30 * 60000,
        ),
        sql(
          "INSERT INTO platform_audit(id,at,admin_id,action,tenant_id,target,detail,reason,ip) VALUES(?,?,?,?,?,?,?,?,?)",
          randomId("pa"),
          now(),
          admin.id,
          "maintenance_start",
          tenantId,
          lease.id,
          "开启30分钟代管",
          lease.reason,
          "",
        ),
      ]);
    },
    async toolList(kind, offset, filter = null) {
      scoped();
      const q = toolListSql[kind];
      if (!q) throw Error("invalid tool resource");
      return all(q, tenantId, filter, filter, offset);
    },
    async classRosterMap(ids) {
      scoped();
      if (!ids.length) return {};
      const rows = await all(
        "SELECT m.class_id,m.student_id,c.date_from,c.date_to,c.status class_status FROM class_members m JOIN classes c ON c.tenant_id=m.tenant_id AND c.id=m.class_id JOIN students s ON s.tenant_id=m.tenant_id AND s.id=m.student_id WHERE m.tenant_id=? AND m.class_id IN(SELECT value FROM json_each(?)) AND m.deleted_at IS NULL AND c.deleted_at IS NULL AND s.deleted_at IS NULL AND s.status='active' ORDER BY m.id",
        tenantId,
        JSON.stringify([...new Set(ids)]),
      );
      for (const row of rows)
        cache.records.set("classes:" + row.class_id, {
          id: row.class_id,
          status: row.class_status,
          date_from: row.date_from,
          date_to: row.date_to,
          deleted_at: null,
        });
      return Object.groupBy(rows, (x) => x.class_id);
    },
    async followupAssignees() {
      scoped();
      return all(
        "SELECT id,name FROM users WHERE tenant_id=? AND active=1 AND deleted_at IS NULL AND (instr(roles,'\"supervisor\"')>0 OR instr(roles,'\"academic\"')>0 OR instr(roles,'\"finance\"')>0) ORDER BY name,id LIMIT 200",
        tenantId,
      );
    },
    async classMembers(id) {
      scoped();
      return all(
        "SELECT m.id,m.student_id,m.version,s.name FROM class_members m JOIN students s ON s.tenant_id=m.tenant_id AND s.id=m.student_id WHERE m.tenant_id=? AND m.class_id=? AND m.deleted_at IS NULL AND s.deleted_at IS NULL ORDER BY s.name,m.id LIMIT 201",
        tenantId,
        id,
      );
    },
    async renewals(date, settings, offset = 0, group = "", size = 200) {
      scoped();
      return (
        await all(
          renewalSql,
          tenantId,
          date,
          settings.low_balance_threshold,
          settings.expiry_warning_days,
          group,
          size,
          offset,
        )
      ).map(renewalRow);
    },
    async studentRenewalGroups(date, settings, ids) {
      scoped();
      if (!ids.length) return [];
      const rows = await all(
        "WITH args AS(SELECT ? tenant_id,? today,? low,? days)" +
          renewalGroups +
          " SELECT g.*,NULL last_reminded_at FROM grouped g WHERE (g.valid_count>0 OR g.debt_units>0) AND g.student_id IN (SELECT value FROM json_each(?)) ORDER BY g.student_id,g.course_name,g.scope_id",
        tenantId,
        date,
        settings.low_balance_threshold,
        settings.expiry_warning_days,
        JSON.stringify(ids),
      );
      return rows.map((row) => {
        const { last_reminded_at, ...data } = renewalRow(row);
        return {
          ...data,
          state:
            data.debt_units > 0
              ? "debt"
              : data.balance <= 0
              ? "zero"
              : data.balance <= settings.low_balance_threshold
                ? "low"
                : "active",
        };
      });
    },
    async recordRenewalReminder(actor, studentId, courseId, ids, channel) {
      scoped();
      const rows = ids.length ? await all(
        `SELECT p.id,p.scope_kind,CASE WHEN p.scope_kind='category' THEN p.category_id ELSE p.course_type_id END scope_id
        FROM packages p JOIN course_types c ON c.tenant_id=p.tenant_id AND c.id=?
        WHERE p.tenant_id=? AND p.student_id=? AND p.deleted_at IS NULL
          AND p.id IN (SELECT value FROM json_each(?))
          AND ((p.scope_kind='type' AND p.course_type_id=c.id) OR (p.scope_kind='category' AND p.category_id=c.category_id))`,
        courseId,
        tenantId,
        studentId,
        JSON.stringify(ids),
      ) : await all(
        "SELECT 'type' scope_kind,course_type_id scope_id FROM credit_debts WHERE tenant_id=? AND student_id=? AND course_type_id=? AND deleted_at IS NULL AND remaining_units>0 LIMIT 1",
        tenantId, studentId, courseId,
      );
      if (ids.length ? rows.length !== ids.length : !rows.length)
        fail(404, "课时包不存在或不属于该学员和课程");
      const { scope_kind, scope_id } = rows[0];
      if (
        rows.some(
          (row) => row.scope_kind !== scope_kind || row.scope_id !== scope_id,
        )
      )
        fail(400, "请选择同一课时包范围");
      const t = now(),
        id = randomId("rem");
      await db.batch([
        sql(
          "INSERT INTO renewal_reminders(tenant_id,id,student_id,course_type_id,scope_kind,scope_id,package_ids_json,channel,sent_at,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
          tenantId,
          id,
          studentId,
          courseId,
          scope_kind,
          scope_id,
          JSON.stringify(ids),
          channel,
          t,
          t,
          actor.id,
          t,
          actor.id,
        ),
        auditStmt(actor, "packages", "remind", id, "登记续费提醒"),
      ]);
      return new Date(t + 28800000).toISOString().slice(0, 19) + "+08:00";
    },
    async receivableSummary() {
      scoped();
      return first(
        `WITH paid AS (
          SELECT package_id,SUM(amount) amount FROM package_receipt_lines WHERE tenant_id=?1 GROUP BY package_id
        )
        SELECT COALESCE(SUM(CASE WHEN p.amount IS NOT NULL THEN MAX(0,p.amount-COALESCE(paid.amount,0)) ELSE 0 END),0) amount,
          COUNT(CASE WHEN p.amount IS NULL THEN 1 END)+(SELECT COUNT(*) FROM pending_student_payments WHERE tenant_id=?1) unresolved
        FROM packages p LEFT JOIN paid ON paid.package_id=p.id WHERE p.tenant_id=?1 AND p.deleted_at IS NULL`,
        tenantId,
      );
    },
    async participantSummaries(lessonIds, studentId = null) {
      scoped();
      if (!lessonIds.length) return [];
      return all(
        participantSummarySql("SELECT value FROM json_each(?)"),
        tenantId,
        JSON.stringify(lessonIds),
        studentId,
        studentId,
      );
    },
    async businessPage(resource, offset, query) {
      scoped();
      const q = businessSql[resource];
      if (!q) throw Error("invalid resource");
      const searched = searchSql[resource] && query;
      const withRoster = resource === "schedule_templates";
      const [page, count, roster] = await db.batch([
        searched ? sql(searchSql[resource], tenantId, query, offset) : sql(q.list, tenantId, offset),
        sql("SELECT COUNT(*) total FROM " + resource + " WHERE tenant_id=? AND deleted_at IS NULL" +
          (searched ? " AND instr(lower(name),lower(?))>0" : ""), tenantId, ...(searched ? [query] : [])),
        ...(withRoster ? [sql(`WITH selected AS (${q.list}), roster AS (${templateRosterSql})
          SELECT * FROM roster ORDER BY name,date_from,id`, tenantId, offset)] : []),
      ]);
      return { rows: page.results, total: count.results[0].total, roster: roster?.results };
    },
    async templateDetail(id) {
      scoped();
      const query = businessSql.schedule_templates.get;
      const [record, roster] = await db.batch([
        sql(query, tenantId, id),
        sql(`WITH selected AS (${query}), roster AS (${templateRosterSql})
          SELECT * FROM roster ORDER BY name,date_from,id`, tenantId, id),
      ]);
      return { row: record.results[0] || null, roster: roster.results };
    },
    async pickerRecord(resource, id) {
      scoped();
      const name = { schedule_enrollments: "student_name", class_members: "name" }[resource];
      if (!name) throw Error("invalid picker resource");
      return first(`SELECT m.*,s.name AS ${name} FROM ${resource} m
        LEFT JOIN students s ON s.tenant_id=m.tenant_id AND s.id=m.student_id AND s.deleted_at IS NULL
        WHERE m.tenant_id=? AND m.id=? AND m.deleted_at IS NULL`, tenantId, id);
    },
    async globalSearch(query, groups) {
      scoped();
      const result = {};
      for (const kind of groups) {
        if (!["students", "teachers", "leads"].includes(kind))
          throw Error("invalid resource");
        const cols =
          kind === "students" ? "id,name,grade,parent_name" : "id,name";
        result[kind] = await all(
          "SELECT " +
            cols +
            " FROM " +
            kind +
            " WHERE tenant_id=? AND deleted_at IS NULL AND instr(lower(name),lower(?))>0 ORDER BY name,id LIMIT 8",
          tenantId,
          query,
        );
      }
      return result;
    },
    async todoSummary(date, at, settings) {
      scoped();
      return first(
        todoSummarySql,
        tenantId,
        date,
        at,
        settings.low_balance_threshold,
        settings.expiry_warning_days,
      );
    },
    async c3Receipts(month, studentId, offset) {
      scoped();
      const from = month + "-01",
        end = new Date(
          Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1),
        )
          .toISOString()
          .slice(0, 10),
        cte =
          "WITH paid AS(SELECT package_id,SUM(amount) amount FROM package_receipt_lines WHERE tenant_id=? GROUP BY package_id), due AS(SELECT p.*,COALESCE(x.amount,0) paid FROM packages p LEFT JOIN paid x ON x.package_id=p.id WHERE p.tenant_id=? AND p.deleted_at IS NULL AND (? IS NULL OR p.student_id=?)) ",
        args = [tenantId, tenantId, studentId, studentId];
      const out = await db.batch([
        sql(
          cte +
            "SELECT COALESCE(SUM(CASE WHEN amount IS NOT NULL THEN MAX(0,amount-paid) ELSE 0 END),0) due_amount,COUNT(CASE WHEN amount>paid THEN 1 END) total,COUNT(CASE WHEN amount IS NULL THEN 1 END) unresolved_packages,(SELECT COUNT(*) FROM pending_student_payments WHERE tenant_id=? AND (? IS NULL OR student_id=?)) unresolved_payments,(SELECT COALESCE(SUM(amount),0) FROM student_payments WHERE tenant_id=? AND deleted_at IS NULL AND paid_at>=? AND paid_at<? AND (? IS NULL OR student_id=?)) total_amount,(SELECT COUNT(*) FROM student_payments WHERE tenant_id=? AND deleted_at IS NULL AND paid_at>=? AND paid_at<? AND (? IS NULL OR student_id=?)) payment_count FROM due",
          ...args,
          tenantId,
          studentId,
          studentId,
          tenantId,
          from,
          end,
          studentId,
          studentId,
          tenantId,
          from,
          end,
          studentId,
          studentId,
        ),
        sql(
          cte +
            "SELECT p.id,p.id package_id,p.student_id,s.name student_name,c.name course_name,p.valid_to,p.amount-p.paid due_amount FROM due p JOIN students s ON s.tenant_id=p.tenant_id AND s.id=p.student_id JOIN course_types c ON c.tenant_id=p.tenant_id AND c.id=p.course_type_id WHERE p.amount>p.paid ORDER BY s.name,p.id LIMIT 50 OFFSET ?",
          ...args,
          offset,
        ),
      ]);
      const facts = out[0].results[0];
      return {
        total: facts.total,
        metrics: {
          total_amount: facts.total_amount,
          due_amount: facts.due_amount,
          payment_count: facts.payment_count,
          unresolved: facts.unresolved_packages + facts.unresolved_payments,
        },
        items: out[1].results || [],
      };
    },
    async c3CostSummary(month) {
      scoped();
      return first(
        "SELECT COALESCE(SUM(amount),0) cost_amount FROM other_costs WHERE tenant_id=? AND deleted_at IS NULL AND SUBSTR(date,1,7)=?",
        tenantId,
        month,
      );
    },
    async c3LeadSummary(from, to) {
      scoped();
      return first(
        "SELECT COUNT(CASE WHEN created_at>=? AND created_at<? THEN 1 END) added,COUNT(CASE WHEN stage='trial' THEN 1 END) trial,COUNT(CASE WHEN stage='enrolled' AND updated_at>=? AND updated_at<? THEN 1 END) converted FROM leads WHERE tenant_id=? AND deleted_at IS NULL",
        from,
        to,
        from,
        to,
        tenantId,
      );
    },
    async c3Teachers(from, to) {
      scoped();
      return all(
        "SELECT t.id,t.name,t.status,t.employment,t.subjects,t.version,(SELECT COUNT(*) FROM lessons l WHERE l.tenant_id=t.tenant_id AND (l.teacher_id=t.id OR l.assistant_id=t.id) AND l.start_at>=? AND l.start_at<? AND l.deleted_at IS NULL AND l.status<>'cancelled') week_count,(SELECT GROUP_CONCAT(DISTINCT c.name) FROM lessons l JOIN course_types c ON c.tenant_id=l.tenant_id AND c.id=l.course_type_id WHERE l.tenant_id=t.tenant_id AND (l.teacher_id=t.id OR l.assistant_id=t.id) AND l.deleted_at IS NULL) course_names FROM teachers t WHERE t.tenant_id=? AND t.deleted_at IS NULL ORDER BY t.sort_order,t.id",
        from,
        to,
        tenantId,
      );
    },
    async c3ClassRoster(id, date, at, includeBalance) {
      scoped();
      const rows = await all(
        `WITH args AS(SELECT ? tenant_id,? class_id,? today,? at),
        members AS(SELECT s.id student_id,s.name FROM args a JOIN class_members m ON m.tenant_id=a.tenant_id AND m.class_id=a.class_id AND m.deleted_at IS NULL JOIN students s ON s.tenant_id=m.tenant_id AND s.id=m.student_id AND s.deleted_at IS NULL),
        recent AS(SELECT l.id,l.start_at FROM lessons l,args a WHERE l.tenant_id=a.tenant_id AND l.class_id=a.class_id AND l.deleted_at IS NULL AND strftime('%s',l.start_at)*1000<=a.at ORDER BY l.start_at DESC,l.id DESC LIMIT 7)
        SELECT m.*,COALESCE((SELECT json_group_array(json_object('lesson_id',x.id,'start_at',x.start_at,'attendance',x.attendance)) FROM (
          SELECT l.id,l.start_at,p.attendance FROM recent l JOIN lesson_participants p ON p.lesson_id=l.id JOIN args a ON a.tenant_id=p.tenant_id WHERE p.student_id=m.student_id AND p.deleted_at IS NULL ORDER BY l.start_at DESC,l.id DESC
        ) x),'[]') recent_attendance` +
          (includeBalance
            ? `,
        COALESCE((SELECT ROUND(SUM(x.delta),2) FROM args a JOIN classes cl ON cl.tenant_id=a.tenant_id AND cl.id=a.class_id JOIN course_types c ON c.tenant_id=cl.tenant_id AND c.id=cl.course_type_id JOIN packages k ON k.tenant_id=cl.tenant_id AND k.student_id=m.student_id
        JOIN package_transactions x ON x.tenant_id=k.tenant_id AND x.package_id=k.id AND x.deleted_at IS NULL
        WHERE k.deleted_at IS NULL AND k.status='active' AND (k.valid_from IS NULL OR k.valid_from<=a.today) AND (k.valid_to IS NULL OR k.valid_to>=a.today)
        AND ((k.scope_kind='type' AND k.course_type_id=c.id) OR (k.scope_kind='category' AND k.category_id=c.category_id))),0) balance`
            : "") +
          " FROM members m ORDER BY m.name,m.student_id",
        tenantId,
        id,
        date,
        at,
      );
      return rows.map((row) => ({
        ...row,
        recent_attendance: JSON.parse(row.recent_attendance),
      }));
    },
    async c3TeacherRoster(teacher, at, today) {
      scoped();
      return all(
        `WITH pairs AS (
        SELECT p.student_id,l.course_type_id,MAX(CASE WHEN l.teacher_id=?1 AND l.status='planned' AND l.start_at>=?2 THEN 1 ELSE 0 END) current_main
        FROM lesson_participants p JOIN lessons l ON l.tenant_id=p.tenant_id AND l.id=p.lesson_id
        WHERE p.tenant_id=?3 AND p.deleted_at IS NULL AND l.deleted_at IS NULL AND (l.teacher_id=?1 OR l.assistant_id=?1) GROUP BY p.student_id,l.course_type_id
        UNION ALL
        SELECT e.student_id,t.course_type_id,CASE WHEN t.teacher_id=?1 THEN 1 ELSE 0 END FROM schedule_enrollments e JOIN schedule_templates t ON t.tenant_id=e.tenant_id AND t.id=e.template_id
        WHERE e.tenant_id=?3 AND e.deleted_at IS NULL AND t.deleted_at IS NULL AND t.active=1 AND (t.teacher_id=?1 OR t.assistant_id=?1) AND MIN(e.date_to,t.date_to)>=?4 AND MAX(e.date_from,t.date_from)<=MIN(e.date_to,t.date_to)
      ), own AS (SELECT student_id,course_type_id,MAX(current_main) current_main FROM pairs GROUP BY student_id,course_type_id)
      SELECT s.id student_id,s.name,s.grade,s.parent_name,c.id course_type_id,c.name course_name,own.current_main,
      (SELECT MAX(l.start_at) FROM lesson_comments x JOIN lessons l ON l.tenant_id=x.tenant_id AND l.id=x.lesson_id WHERE x.tenant_id=s.tenant_id AND x.deleted_at IS NULL AND l.deleted_at IS NULL AND x.student_id=s.id AND l.course_type_id=c.id AND (l.teacher_id=?1 OR l.assistant_id=?1)) last_comment,
      COALESCE((SELECT ROUND(SUM(x.delta),2) FROM packages k JOIN package_transactions x ON x.tenant_id=k.tenant_id AND x.package_id=k.id WHERE k.tenant_id=s.tenant_id AND k.student_id=s.id AND k.deleted_at IS NULL AND k.status='active' AND (k.course_type_id=c.id OR (k.scope_kind='category' AND k.category_id=c.category_id))),0) balance
      FROM own JOIN students s ON s.tenant_id=?3 AND s.id=own.student_id JOIN course_types c ON c.tenant_id=s.tenant_id AND c.id=own.course_type_id WHERE s.deleted_at IS NULL AND c.deleted_at IS NULL ORDER BY s.name,s.id,c.name`,
        teacher,
        at,
        tenantId,
        today,
      );
    },
    async c3TeacherHistory(teacher, student, offset) {
      scoped();
      return all(
        "SELECT l.id,l.start_at,l.duration,l.status,c.name course_name,p.attendance,p.deducted,(SELECT text FROM lesson_comments x WHERE x.tenant_id=l.tenant_id AND x.lesson_id=l.id AND x.student_id IS NULL AND x.deleted_at IS NULL LIMIT 1) public_text,(SELECT text FROM lesson_comments x WHERE x.tenant_id=l.tenant_id AND x.lesson_id=l.id AND x.student_id=p.student_id AND x.deleted_at IS NULL LIMIT 1) private_comment FROM lesson_participants p JOIN lessons l ON l.tenant_id=p.tenant_id AND l.id=p.lesson_id JOIN course_types c ON c.tenant_id=l.tenant_id AND c.id=l.course_type_id WHERE p.tenant_id=? AND p.student_id=? AND p.deleted_at IS NULL AND l.deleted_at IS NULL AND (l.teacher_id=? OR l.assistant_id=?) AND l.start_at<=? ORDER BY l.start_at DESC,l.id LIMIT 50 OFFSET ?",
        tenantId,
        student,
        teacher,
        teacher,
        new Date(now() + 8 * 3600000).toISOString().slice(0, 16) + "+08:00",
        offset,
      );
    },
    async c3StudentComments(student) {
      scoped();
      return all(
        "SELECT l.id,l.start_at,c.name course_name,t.name teacher_name,(SELECT text FROM lesson_comments x WHERE x.tenant_id=l.tenant_id AND x.lesson_id=l.id AND x.student_id IS NULL AND x.deleted_at IS NULL LIMIT 1) public_text,(SELECT text FROM lesson_comments x WHERE x.tenant_id=l.tenant_id AND x.lesson_id=l.id AND x.student_id=p.student_id AND x.deleted_at IS NULL LIMIT 1) private_comment FROM lesson_participants p JOIN lessons l ON l.tenant_id=p.tenant_id AND l.id=p.lesson_id JOIN course_types c ON c.tenant_id=l.tenant_id AND c.id=l.course_type_id JOIN teachers t ON t.tenant_id=l.tenant_id AND t.id=l.teacher_id WHERE p.tenant_id=? AND p.student_id=? AND p.deleted_at IS NULL AND l.deleted_at IS NULL AND EXISTS(SELECT 1 FROM lesson_comments x WHERE x.tenant_id=l.tenant_id AND x.lesson_id=l.id AND (x.student_id IS NULL OR x.student_id=p.student_id) AND x.deleted_at IS NULL) ORDER BY l.start_at DESC,l.id LIMIT 3",
        tenantId,
        student,
      );
    },
    async c2StudentPage(v) {
      scoped();
      const base = `WITH a AS(SELECT ? tenant_id,? at),b AS(SELECT x.package_id,SUM(x.delta) balance FROM package_transactions x,a WHERE x.tenant_id=a.tenant_id GROUP BY x.package_id),p AS(SELECT p.*,COALESCE(b.balance,0) balance,c.name course_name FROM packages p JOIN a ON p.tenant_id=a.tenant_id LEFT JOIN b ON b.package_id=p.id JOIN course_types c ON c.tenant_id=p.tenant_id AND c.id=p.course_type_id WHERE p.deleted_at IS NULL),s AS(SELECT s.id,s.name,s.grade,s.parent_name,s.status,s.version,s.sort_order,COUNT(*) OVER(PARTITION BY s.name) same_name_count,COUNT(*) OVER(PARTITION BY s.name,s.grade) same_grade_count,COALESCE((SELECT ROUND(SUM(balance),2) FROM p WHERE p.student_id=s.id),0) balance,(SELECT COUNT(*) FROM p WHERE p.student_id=s.id) package_count,(SELECT group_concat(DISTINCT course_name) FROM p WHERE p.student_id=s.id) course_names,(SELECT MIN(l.start_at) FROM lessons l JOIN lesson_participants x ON x.tenant_id=l.tenant_id AND x.lesson_id=l.id WHERE l.tenant_id=s.tenant_id AND x.student_id=s.id AND l.deleted_at IS NULL AND x.deleted_at IS NULL AND l.status='planned' AND strftime('%s',l.start_at)*1000>=a.at) next_start,(SELECT group_concat(DISTINCT t.name) FROM lessons l JOIN lesson_participants x ON x.tenant_id=l.tenant_id AND x.lesson_id=l.id JOIN teachers t ON t.tenant_id=l.tenant_id AND t.id=l.teacher_id WHERE l.tenant_id=s.tenant_id AND x.student_id=s.id AND l.deleted_at IS NULL AND x.deleted_at IS NULL AND l.status='planned' AND strftime('%s',l.start_at)*1000>=a.at) teacher_names FROM students s JOIN a ON s.tenant_id=a.tenant_id WHERE s.deleted_at IS NULL AND instr(lower(s.name),lower(?))>0 AND (?='' OR s.status=?) AND (?='' OR EXISTS(SELECT 1 FROM p WHERE p.student_id=s.id AND p.course_type_id=?)))`;
      const balanceFilter = v.balance === "zero" || v.balance === "low";
      const groupedFilter = balanceFilter
        ? ",args AS(SELECT tenant_id,? today,? low,? days FROM a)" +
          renewalGroups +
          ",filtered AS(SELECT s.* FROM s WHERE EXISTS(SELECT 1 FROM grouped g,args a WHERE g.student_id=s.id AND (g.valid_count>0 OR g.debt_units>0) AND " +
          (v.balance === "zero"
            ? "(g.debt_units>0 OR g.balance<=0)"
            : "g.debt_units=0 AND g.balance>0 AND g.balance<=a.low") +
          ")) "
        : ",filtered AS(SELECT * FROM s WHERE ?='') ";
      const values = [
        tenantId,
        v.at,
        v.q,
        v.status,
        v.status,
        v.course,
        v.course,
        ...(balanceFilter ? [v.today, v.low, v.days] : [v.balance]),
      ];
      const order =
        Object.assign(Object.create(null), {
          name: "name",
          balance: "balance",
          next_start: "next_start",
          status: "status",
          course_names: "course_names",
          teacher_names: "teacher_names",
          default: "sort_order",
        })[v.sort] || "sort_order";
      const dir = v.dir === "desc" ? "DESC" : "ASC";
      const rows = await all(base + groupedFilter +
        ",paged AS(SELECT * FROM filtered ORDER BY " + order + " " + dir + ",id LIMIT 50 OFFSET ?) " +
        "SELECT paged.*,totals.__total FROM (SELECT COUNT(*) __total FROM filtered) totals LEFT JOIN paged ON 1=1 ORDER BY paged." + order + " " + dir + ",paged.id",
        ...values, v.offset);
      return {
        items: rows.filter((row) => row.id != null).map(({ __total, ...row }) => row),
        total: rows[0]?.__total || 0,
      };
    },
    async c2StudentCounts(today, settings) {
      scoped();
      return first("WITH args AS(SELECT ? tenant_id,? today,? low,? days)" + renewalGroups + `,
        flags AS(SELECT g.student_id,MAX(g.debt_units>0 OR g.balance<=0) zero,MAX(g.debt_units=0 AND g.balance>0 AND g.balance<=a.low) low FROM grouped g,args a WHERE g.valid_count>0 OR g.debt_units>0 GROUP BY g.student_id)
        SELECT COALESCE(SUM(s.status='active'),0) active,COALESCE(SUM(s.status='paused'),0) paused,COALESCE(SUM(s.status='archived'),0) archived,
        COALESCE(SUM(s.status='active' AND COALESCE(f.zero,0)),0) zero,COALESCE(SUM(s.status='active' AND COALESCE(f.low,0)),0) low
        FROM students s JOIN args a ON s.tenant_id=a.tenant_id LEFT JOIN flags f ON f.student_id=s.id WHERE s.deleted_at IS NULL`, tenantId,today,settings.low_balance_threshold,settings.expiry_warning_days);
    },
    async c2StudentSnapshot(studentId, at, today, settings, packages, schedule) {
      scoped();
      const statements = [
        sql("SELECT id FROM students WHERE tenant_id=? AND id=? AND deleted_at IS NULL", tenantId,studentId),
        sql(studentFactsSql,tenantId,studentId),
        sql(studentHistorySql,tenantId,studentId,at,5,0),
      ];
      if (packages) statements.push(sql(creditDebtTotalSql,tenantId,studentId,new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" })),
        sql("WITH args AS(SELECT ? tenant_id,? today,? low,? days)" + renewalGroups + " SELECT g.*,NULL last_reminded_at FROM grouped g WHERE (g.valid_count>0 OR g.debt_units>0) AND g.student_id=? ORDER BY g.student_id,g.course_name,g.scope_id",tenantId,today,settings.low_balance_threshold,settings.expiry_warning_days,studentId));
      if (schedule) statements.push(sql(nextLessonSql,tenantId,today,at,null,null,null,studentId,studentId));
      const rows = (await db.batch(statements)).map((item) => item.results || []);
      if (!rows[0].length) return null;
      const out = {facts:rows[1][0], recent:rows[2]};
      let index=3;
      if (packages) {out.facts.available_units=rows[index++][0].available_units;out.renewal_groups=renewalStudentRows(rows[index++],settings);}
      if (schedule) out.next=rows[index][0] || null;
      return out;
    },
    async c2StudentFacts(studentId, at) {
      scoped();
      const out = await db.batch([
        sql(
          studentFactsSql,
          tenantId,
          studentId,
        ),
        sql(studentHistorySql, tenantId, studentId, at, 5, 0),
      ]);
      return { facts: out[0].results[0], recent: out[1].results || [] };
    },
    async c2StudentBlocks(id, offset) {
      scoped();
      return all(
        "SELECT id,student_id,weekday,start_time,end_time,label,active,version FROM student_schedule_blocks WHERE tenant_id=? AND student_id=? AND deleted_at IS NULL ORDER BY weekday,start_time,id LIMIT 50 OFFSET ?",
        tenantId,
        id,
        offset,
      );
    },
    async c2StudentHistory(studentId, at, offset) {
      scoped();
      return all(studentHistorySql, tenantId, studentId, at, 50, offset);
    },
    async c2Unchecked(at, offset = 0) {
      scoped();
      return all(
        "SELECT l.*,COUNT(*) OVER() page_total,c.name course_name,t.name teacher_name,o.name location_name FROM lessons l JOIN course_types c ON c.tenant_id=l.tenant_id AND c.id=l.course_type_id JOIN teachers t ON t.tenant_id=l.tenant_id AND t.id=l.teacher_id LEFT JOIN locations o ON o.tenant_id=l.tenant_id AND o.id=l.location_id WHERE l.tenant_id=? AND l.deleted_at IS NULL AND (l.status='planned' OR EXISTS(SELECT 1 FROM lesson_participants p WHERE p.tenant_id=l.tenant_id AND p.lesson_id=l.id AND p.deleted_at IS NULL AND p.attendance='planned')) AND strftime('%s',l.start_at)*1000<=? ORDER BY l.start_at,l.id LIMIT 50 OFFSET ?",
        tenantId,
        at,
        offset,
      );
    },
    async c2PendingMakeups(offset = 0) {
      scoped();
      return all(
        "SELECT COUNT(*) OVER() page_total,p.id,p.student_id,s.name student_name,p.lesson_id,l.start_at,l.duration,l.units,l.teacher_id,l.assistant_id,l.course_type_id,l.location_id,l.mode,c.name course_name,t.name teacher_name FROM lesson_participants p JOIN students s ON s.tenant_id=p.tenant_id AND s.id=p.student_id JOIN lessons l ON l.tenant_id=p.tenant_id AND l.id=p.lesson_id JOIN course_types c ON c.tenant_id=l.tenant_id AND c.id=l.course_type_id JOIN teachers t ON t.tenant_id=l.tenant_id AND t.id=l.teacher_id WHERE p.tenant_id=? AND p.deleted_at IS NULL AND l.deleted_at IS NULL AND p.attendance='student_leave' AND NOT EXISTS(SELECT 1 FROM makeup_links m WHERE m.tenant_id=p.tenant_id AND m.original_participant_id=p.id AND m.deleted_at IS NULL) ORDER BY l.start_at,p.id LIMIT 50 OFFSET ?",
        tenantId,
        offset,
      );
    },
    async c2Followups(date, group, owner, offset = 0) {
      scoped();
      const where = {
        overdue: "f.done=0 AND f.due_date<?",
        today: "f.done=0 AND f.due_date=?",
        future: "f.done=0 AND f.due_date>?",
        done: "f.done=1 AND ? IS NOT NULL",
      }[group];
      if (!where) throw Error("invalid group");
      return all(
        "SELECT f.*,s.name student_name,COALESCE(u.name,f.legacy_owner,'待指派') assignee_name FROM followup_tasks f LEFT JOIN students s ON s.tenant_id=f.tenant_id AND s.id=f.student_id LEFT JOIN users u ON u.tenant_id=f.tenant_id AND u.id=f.assignee_id WHERE f.tenant_id=? AND f.deleted_at IS NULL AND " +
          where +
          " AND (?='' OR f.assignee_id=?) ORDER BY f.due_date,f.id LIMIT 50 OFFSET ?",
        tenantId,
        date,
        owner,
        owner,
        offset,
      );
    },
    async c2ExpiredStages(date, offset = 0) {
      scoped();
      return all(
        expiredStagesSql,
        tenantId,
        date,
        offset,
      );
    },
    async c2Renewals(date, settings, offset = 0, group = "") {
      return this.renewals(date, settings, offset, group, 50);
    },

    async workbench(date, settings, home = null) {
      scoped();
      const month = date.slice(0, 7);
      const monthStart = month + "-01";
      const monthEnd = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 1))
        .toISOString().slice(0, 10);
      const ops = [
        sql(
          "SELECT l.id,l.start_at,l.duration,l.units,l.status,c.name course_name,t.name teacher_name,o.name location_name FROM lessons l JOIN course_types c ON c.tenant_id=l.tenant_id AND c.id=l.course_type_id JOIN teachers t ON t.tenant_id=l.tenant_id AND t.id=l.teacher_id LEFT JOIN locations o ON o.tenant_id=l.tenant_id AND o.id=l.location_id WHERE l.tenant_id=? AND l.deleted_at IS NULL AND SUBSTR(l.start_at,1,10)=? ORDER BY l.start_at,l.id LIMIT 200",
          tenantId,
          date,
        ),
        sql(
          "SELECT SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending FROM lesson_submissions WHERE tenant_id=? AND deleted_at IS NULL",
          tenantId,
        ),
        sql(
          "SELECT COUNT(*) n FROM lessons l WHERE l.tenant_id=? AND l.deleted_at IS NULL AND l.status='planned' AND strftime('%s',l.start_at)*1000+l.duration*60000+48*3600000<? AND NOT EXISTS(SELECT 1 FROM lesson_submissions s WHERE s.tenant_id=l.tenant_id AND s.lesson_id=l.id AND s.kind='attendance' AND s.deleted_at IS NULL)",
          tenantId,
          now(),
        ),
        sql(
          home ? homeRenewalSql : renewalSql,
          tenantId,
          date,
          settings.low_balance_threshold,
          settings.expiry_warning_days,
          "",
          200,
          0,
        ),
        sql(
          "SELECT f.id,f.student_id,f.title,f.due_date,s.name student_name,COALESCE(u.name,f.legacy_owner,'待指派') assignee_name FROM followup_tasks f LEFT JOIN students s ON s.tenant_id=f.tenant_id AND s.id=f.student_id LEFT JOIN users u ON u.tenant_id=f.tenant_id AND u.id=f.assignee_id WHERE f.tenant_id=? AND f.deleted_at IS NULL AND f.done=0 ORDER BY f.due_date,f.id LIMIT 200",
          tenantId,
        ),
        sql(
          "SELECT (SELECT COUNT(*) FROM lessons WHERE tenant_id=? AND SUBSTR(start_at,1,7)=? AND deleted_at IS NULL) lesson_count,(SELECT COALESCE(SUM(amount),0) FROM student_payments WHERE tenant_id=? AND paid_at>=? AND paid_at<? AND deleted_at IS NULL) tuition_amount",
          tenantId,
          month,
          tenantId,
          monthStart,
          monthEnd,
        ),
      ];
      const homeSlots = {};
      if (home) {
        const push = (key, query, ...args) => {
          homeSlots[key] = ops.length;
          ops.push(sql(query, ...args));
        };
        push("counts", homeActionCountsSql, tenantId, date, home.at);
        if (home.week) push("week", weekCountsSql, tenantId, ...home.week);
        if (home.stages) push("stages", expiredStagesSql, tenantId, date, 0);
        if (home.leads) push("leads", dueLeadsSql, tenantId, date);
      }
      const results = await db.batch(ops);
      const rows = results.map((x) => x.results || []),
        renewals = rows[3].map(({ page_total, renewal_zero, renewal_low, renewal_expiring, renewal_debt, ...row }) => renewalRow(row));
      const data = {
        lessons: rows[0],
        pending: rows[1][0]?.pending || 0,
        overdue: rows[2][0]?.n || 0,
        renewals,
        expiring: renewals.filter((x) => x.expiring),
        tasks: rows[4],
        ...rows[5][0],
      };
      if (!home) return data;
      return {
        data,
        counts: {
          ...rows[homeSlots.counts][0],
          renewal_zero: rows[3][0]?.renewal_zero ?? 0,
          renewal_low: rows[3][0]?.renewal_low ?? 0,
          renewal_expiring: rows[3][0]?.renewal_expiring ?? 0,
          renewal_debt: rows[3][0]?.renewal_debt ?? 0,
        },
        week: rows[homeSlots.week] || [],
        stages: rows[homeSlots.stages] || [],
        leads: rows[homeSlots.leads] || [],
      };
    },
    async systemMessagePage(user, offset) {
 scoped(); const at=now(); const result=await db.batch([sql(announcementPageSql,user.id,tenantId,at,at,JSON.stringify(user.roles),offset),sql(announcementUnreadSql,tenantId,at,at,JSON.stringify(user.roles),user.id)]);
 return {items:result[0].results,unread:result[1].results[0].n};
},
    async readMessage(id, user) {
      scoped();
      const result = await db.batch([
        sql(
          "INSERT OR IGNORE INTO announcement_reads(tenant_id,id,announcement_id,user_id,created_at,created_by,updated_at,updated_by) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM announcement_targets t JOIN platform_announcements a ON a.id=t.announcement_id AND a.withdrawn_at IS NULL WHERE t.tenant_id=? AND a.id=? AND a.starts_at<=? AND (a.ends_at IS NULL OR a.ends_at>?) AND EXISTS(SELECT 1 FROM json_each(a.roles) r WHERE r.value IN(SELECT value FROM json_each(?))))",
          tenantId,
          randomId("rec"),
          id,
          user.id,
          now(),
          user.id,
          now(),
          user.id,
          tenantId,
          id,
          now(),
          now(),
          JSON.stringify(user.roles),
        ),
        sql(
          "SELECT id FROM announcement_targets WHERE tenant_id=? AND announcement_id=?",
          tenantId,
          id,
        ),
      ]);
      if (!result[0].meta.changes && !result[1].results.length)
        fail(404, "不存在");
    },
    async reviewContext(
      lessonId,
      studentId = null,
      draftStaff = false,
      teacherId = null,
    ) {
      scoped();
      const queries = [
        [
          "settlements",
          "SELECT locked FROM settlements WHERE tenant_id=? AND month=(SELECT SUBSTR(start_at,1,7) FROM lessons WHERE tenant_id=? AND id=?) AND deleted_at IS NULL",
          [tenantId, tenantId, lessonId],
        ],
        [
          "lessons",
          "SELECT l.*,c.name course_name,t.name teacher_name,o.name location_name FROM lessons l JOIN course_types c ON c.tenant_id=l.tenant_id AND c.id=l.course_type_id JOIN teachers t ON t.tenant_id=l.tenant_id AND t.id=l.teacher_id LEFT JOIN locations o ON o.tenant_id=l.tenant_id AND o.id=l.location_id WHERE l.tenant_id=? AND l.id=? AND l.deleted_at IS NULL",
          [tenantId, lessonId],
        ],
        [
          "participants",
          "SELECT p.*,s.name student_name FROM lesson_participants p JOIN students s ON s.tenant_id=p.tenant_id AND s.id=p.student_id WHERE p.tenant_id=? AND p.lesson_id=? AND p.deleted_at IS NULL AND (? IS NULL OR p.student_id=?) ORDER BY p.id",
          [tenantId, lessonId, studentId, studentId],
        ],
        [
          "comments",
          "SELECT * FROM lesson_comments WHERE tenant_id=? AND lesson_id=? AND deleted_at IS NULL AND (? IS NULL OR student_id IS NULL OR student_id=?) ORDER BY id",
          [tenantId, lessonId, studentId, studentId],
        ],
        [
          "submissions",
          "SELECT r.* FROM lesson_submissions r JOIN lessons l ON l.tenant_id=r.tenant_id AND l.current_submission_id=r.id WHERE r.tenant_id=? AND l.id=? AND r.deleted_at IS NULL AND (?=1 OR l.teacher_id=?)",
          [tenantId, lessonId, draftStaff ? 1 : 0, teacherId],
        ],
        [
          "people",
          "SELECT p.* FROM submission_people p JOIN lesson_submissions r ON r.tenant_id=p.tenant_id AND r.id=p.submission_id JOIN lessons l ON l.tenant_id=r.tenant_id AND l.current_submission_id=r.id WHERE p.tenant_id=? AND l.id=? AND p.deleted_at IS NULL AND (?=1 OR l.teacher_id=?) ORDER BY p.id",
          [tenantId, lessonId, draftStaff ? 1 : 0, teacherId],
        ],
        [
          "confirmed",
          "SELECT id FROM lesson_submissions WHERE tenant_id=? AND lesson_id=? AND kind='attendance' AND status='confirmed' AND deleted_at IS NULL LIMIT 1",
          [tenantId, lessonId],
        ],
        [
          "absence_settings",
          "SELECT value FROM tenant_settings WHERE tenant_id=? AND id='absence_policies'",
          [tenantId],
        ],
      ];
      const result = await db.batch(
        queries.map(([, q, args]) => sql(q, ...args)),
      );
      return Object.fromEntries(
        queries.map(([key], i) => [key, result[i].results || []]),
      );
    },
    async reviewQueue(status, from, to, at, graceMs, offset = 0) {
      scoped();
      return all(
        "SELECT COUNT(*) OVER() page_total,l.id lesson_id,l.start_at,l.duration,l.status lesson_status,c.name course_name,t.name teacher_name,r.id submission_id,r.status,r.kind,r.version,r.submitted_at,r.reason FROM lessons l JOIN course_types c ON c.tenant_id=l.tenant_id AND c.id=l.course_type_id JOIN teachers t ON t.tenant_id=l.tenant_id AND t.id=l.teacher_id LEFT JOIN lesson_submissions r ON r.tenant_id=l.tenant_id AND r.id=l.current_submission_id WHERE l.tenant_id=? AND l.deleted_at IS NULL AND l.start_at>=? AND l.start_at<? AND ((?='overdue' AND l.status='planned' AND strftime('%s',l.start_at)*1000+l.duration*60000+?<? AND NOT EXISTS(SELECT 1 FROM lesson_submissions x WHERE x.tenant_id=l.tenant_id AND x.lesson_id=l.id AND x.kind='attendance' AND x.deleted_at IS NULL)) OR (?<>'overdue' AND r.status=?)) ORDER BY l.start_at,l.id LIMIT 200 OFFSET ?",
        tenantId,
        from,
        to,
        status,
        graceMs,
        at,
        status,
        status,
        offset,
      );
    },
    async financeContext(month, teacherId = null, includeDebt = false, checkCheckout = false) {
      scoped();
      const from = month + "-01",
        end = new Date(
          Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1),
        )
          .toISOString()
          .slice(0, 10);
      const queries = [
        [
          "pending_submissions",
          "SELECT r.id,r.lesson_id,l.start_at,c.name course_name FROM lesson_submissions r JOIN lessons l ON l.tenant_id=r.tenant_id AND l.id=r.lesson_id JOIN course_types c ON c.tenant_id=l.tenant_id AND c.id=l.course_type_id WHERE r.tenant_id=? AND r.status='pending' AND r.deleted_at IS NULL AND l.deleted_at IS NULL AND l.start_at>=? AND l.start_at<? ORDER BY l.start_at,r.id LIMIT 5001",
          [tenantId, from, end],
          5000,
        ],
        [
          "absence_settings",
          "SELECT value FROM tenant_settings WHERE tenant_id=? AND id='absence_policies'",
          [tenantId],
          1,
        ],
        [
          "lessons",
          "SELECT l.*,c.name course_name,c.format course_format,c.category_id,t.name teacher_name,lo.name location_name FROM lessons l JOIN course_types c ON c.tenant_id=l.tenant_id AND c.id=l.course_type_id JOIN teachers t ON t.tenant_id=l.tenant_id AND t.id=l.teacher_id LEFT JOIN locations lo ON lo.tenant_id=l.tenant_id AND lo.id=l.location_id WHERE l.tenant_id=? AND l.deleted_at IS NULL AND l.start_at>=? AND l.start_at<? AND (? IS NULL OR l.teacher_id=?) ORDER BY l.start_at,l.id LIMIT 5001",
          [tenantId, from, end, teacherId, teacherId],
          5000,
        ],
        [
          "participants",
          "SELECT p.*,s.name student_name,s.billing_mode FROM lesson_participants p JOIN lessons l ON l.tenant_id=p.tenant_id AND l.id=p.lesson_id JOIN students s ON s.tenant_id=p.tenant_id AND s.id=p.student_id WHERE p.tenant_id=? AND p.deleted_at IS NULL AND l.deleted_at IS NULL AND l.start_at>=? AND l.start_at<? AND (? IS NULL OR l.teacher_id=?) ORDER BY p.id LIMIT 50001",
          [tenantId, from, end, teacherId, teacherId],
          50000,
        ],
        [
          "rates",
          "SELECT * FROM teacher_rates WHERE tenant_id=? AND deleted_at IS NULL AND effective_from<? AND effective_to>=? AND (? IS NULL OR teacher_id=?) ORDER BY effective_from DESC,created_at,id LIMIT 10001",
          [tenantId, end, from, teacherId, teacherId],
          10000,
        ],
        [
          "payments",
          "SELECT * FROM teacher_payments WHERE tenant_id=? AND month=? AND deleted_at IS NULL AND (? IS NULL OR teacher_id=?) ORDER BY paid_at,id LIMIT 10001",
          [tenantId, month, teacherId, teacherId],
          10000,
        ],
        [
          "adjustments",
          "SELECT * FROM teacher_adjustments WHERE tenant_id=? AND month=? AND deleted_at IS NULL AND (? IS NULL OR teacher_id=?) ORDER BY created_at,id LIMIT 10001",
          [tenantId, month, teacherId, teacherId],
          10000,
        ],
        [
          "costs",
          "SELECT * FROM other_costs WHERE tenant_id=? AND date>=? AND date<? AND deleted_at IS NULL AND ? IS NULL ORDER BY date,id LIMIT 10001",
          [tenantId, from, end, teacherId],
          10000,
        ],
        [
          "tuition",
          "SELECT p.*,s.name student_name FROM student_payments p JOIN students s ON s.tenant_id=p.tenant_id AND s.id=p.student_id WHERE p.tenant_id=? AND p.paid_at>=? AND p.paid_at<? AND p.deleted_at IS NULL AND ? IS NULL ORDER BY p.paid_at,p.id LIMIT 10001",
          [tenantId, from, end, teacherId],
          10000,
        ],
        [
          "other_income",
          "SELECT r.recognized_date date,r.other_category category,SUM(p.amount) amount FROM student_payment_resolutions r JOIN student_payments p ON p.tenant_id=r.tenant_id AND p.id=r.id AND p.deleted_at IS NULL WHERE r.tenant_id=? AND r.kind='other_income' AND r.deleted_at IS NULL AND r.recognized_date>=? AND r.recognized_date<? AND ? IS NULL GROUP BY r.recognized_date,r.other_category ORDER BY r.recognized_date,r.other_category",
          [tenantId, from, end, teacherId],
          93,
        ],
        [
          "earned",
          `SELECT booked_on date,SUM(amount) amount,ROUND(SUM(unpriced_units),2) unpriced_units
            FROM credit_income_entries WHERE tenant_id=? AND booked_on>=? AND booked_on<?
              AND deleted_at IS NULL AND ? IS NULL GROUP BY booked_on ORDER BY booked_on`,
          [tenantId, from, end, teacherId],
          31,
        ],
        [
          "settlements",
          "SELECT * FROM settlements WHERE tenant_id=? AND month=? AND deleted_at IS NULL",
          [tenantId, month],
          1,
        ],
        [
          "teachers",
          "SELECT t.id,t.name FROM teachers t WHERE t.tenant_id=? AND t.deleted_at IS NULL AND (? IS NULL OR t.id=?) ORDER BY t.sort_order,t.id LIMIT 5001",
          [tenantId, teacherId, teacherId],
          5000,
        ],
        [
          "snapshots",
          "SELECT * FROM payroll_snapshots WHERE tenant_id=? AND month=? AND snapshot_token=(SELECT snapshot_token FROM settlements WHERE tenant_id=? AND month=? AND locked=1) AND (? IS NULL OR teacher_id=?) ORDER BY lesson_id LIMIT 5001",
          [tenantId, month, tenantId, month, teacherId, teacherId],
          5000,
        ],
      ];
      if (checkCheckout)
        queries.push(["pending_checkout", `SELECT l.start_at,c.name course_name,h.name teacher_name,
          json_group_array(s.name) student_names,COUNT(*) OVER() total
          FROM lessons l JOIN lesson_participants p ON p.tenant_id=l.tenant_id AND p.lesson_id=l.id
          JOIN students s ON s.tenant_id=p.tenant_id AND s.id=p.student_id
          JOIN course_types c ON c.tenant_id=l.tenant_id AND c.id=l.course_type_id
          JOIN teachers h ON h.tenant_id=l.tenant_id AND h.id=l.teacher_id
          WHERE l.tenant_id=? AND l.start_at>=? AND l.start_at<? AND l.start_at<=?
            AND l.deleted_at IS NULL
            AND l.status NOT IN ('cancelled','rescheduled','teacher_leave')
            AND p.deleted_at IS NULL AND p.attendance='planned'
          GROUP BY l.id ORDER BY l.start_at,l.id LIMIT 20`,
          [tenantId, from, end, new Date(now()+28800000).toISOString().slice(0,19)+"+08:00"], 20]);
      if (includeDebt)
        queries.push(["debt", reportDebtSql, [tenantId], 1]);
      const results = await db.batch(
        queries.map(([, query, args]) => sql(query, ...args)),
      );
      const ctx = {};
      for (let i = 0; i < queries.length; i++) {
        const [key, , args, max] = queries[i],
          rows = results[i].results || [];
        if (rows.length > max) fail(400, "月份数据过多，请分期归档");
        ctx[key] = rows;
      }
      return ctx;
    },
    async financeList(kind, id = null, teacherId = null, offset = 0) {
      scoped();
      const queries = {
        rates:
          "SELECT r.*,t.name teacher_name,c.name course_name FROM teacher_rates r JOIN teachers t ON t.tenant_id=r.tenant_id AND t.id=r.teacher_id JOIN course_types c ON c.tenant_id=r.tenant_id AND c.id=r.course_type_id WHERE r.tenant_id=? AND r.deleted_at IS NULL AND (? IS NULL OR r.id=?) AND (? IS NULL OR r.teacher_id=?) ORDER BY r.effective_from DESC,r.id LIMIT 200 OFFSET ?",
        payments:
          "SELECT p.*,t.name teacher_name FROM teacher_payments p JOIN teachers t ON t.tenant_id=p.tenant_id AND t.id=p.teacher_id WHERE p.tenant_id=? AND p.deleted_at IS NULL AND (? IS NULL OR p.id=?) AND (? IS NULL OR p.teacher_id=?) ORDER BY p.month DESC,p.id LIMIT 200 OFFSET ?",
        adjustments:
          "SELECT p.*,t.name teacher_name FROM teacher_adjustments p JOIN teachers t ON t.tenant_id=p.tenant_id AND t.id=p.teacher_id WHERE p.tenant_id=? AND p.deleted_at IS NULL AND (? IS NULL OR p.id=?) AND (? IS NULL OR p.teacher_id=?) ORDER BY p.month DESC,p.id LIMIT 200 OFFSET ?",
        costs:
          "SELECT * FROM other_costs WHERE tenant_id=? AND deleted_at IS NULL AND (? IS NULL OR id=?) AND ? IS NULL AND ? IS NULL ORDER BY date DESC,id LIMIT 200 OFFSET ?",
      };
      if (!queries[kind]) fail(404, "不存在");
      return all(queries[kind], tenantId, id, id, teacherId, teacherId, offset);
    },
    async rateOverlap(row) {
      scoped();
      return first(
        "SELECT id FROM teacher_rates WHERE tenant_id=? AND teacher_id=? AND course_type_id=? AND format=? AND id<>? AND deleted_at IS NULL AND effective_from<=? AND effective_to>=? LIMIT 1",
        tenantId,
        row.teacher_id,
        row.course_type_id,
        row.format,
        row.id,
        row.effective_to,
        row.effective_from,
      );
    },
    async rateLocks(from, to) {
      scoped();
      return all(
        "SELECT month FROM settlements WHERE tenant_id=? AND locked=1 AND month>=? AND month<=?",
        tenantId,
        from.slice(0, 7),
        to.slice(0, 7),
      );
    },
    async exportLessons(month, user) {
      scoped();
      const teacher = user.roles.includes("teacher") ? user.teacher_id : null,
        student = user.roles.includes("student") ? user.student_id : null,
        from = month + "-01",
        end = new Date(
          Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1),
        )
          .toISOString()
          .slice(0, 10);
      const rows = await all(
        "SELECT l.id,l.start_at,l.duration,l.units,l.status,c.name course_name,t.name teacher_name,lo.name location_name FROM lessons l JOIN course_types c ON c.tenant_id=l.tenant_id AND c.id=l.course_type_id JOIN teachers t ON t.tenant_id=l.tenant_id AND t.id=l.teacher_id LEFT JOIN locations lo ON lo.tenant_id=l.tenant_id AND lo.id=l.location_id WHERE l.tenant_id=? AND l.deleted_at IS NULL AND l.start_at>=? AND l.start_at<? AND (? IS NULL OR l.teacher_id=? OR l.assistant_id=?) AND (? IS NULL OR EXISTS(SELECT 1 FROM lesson_participants p WHERE p.tenant_id=l.tenant_id AND p.lesson_id=l.id AND p.student_id=? AND p.deleted_at IS NULL)) ORDER BY l.start_at,l.id LIMIT 5001",
        tenantId,
        from,
        end,
        teacher,
        teacher,
        teacher,
        student,
        student,
      );
      if (rows.length > 5000) fail(400, "导出最多5000节，请按月拆分");
      return rows;
    },
    async creditOperation(id) {
      scoped();
      return first(
        "SELECT * FROM credit_operations WHERE tenant_id=? AND id=? AND deleted_at IS NULL",
        tenantId,
        id,
      );
    },
    async assertUnlocked(months) {
      scoped();
      const row = await first(
        "SELECT month FROM settlements WHERE tenant_id=? AND locked=1 AND month IN(SELECT value FROM json_each(?)) LIMIT 1",
        tenantId,
        JSON.stringify([...new Set(months)]),
      );
      if (row) fail(409, row.month + " 已锁定，不能修改课程、出勤或课时流水");
    },
    async creditStudentNames(ids) {
      scoped();
      return all(
        "SELECT id,name FROM students WHERE tenant_id=? AND id IN (SELECT value FROM json_each(?))",
        tenantId,
        JSON.stringify(ids),
      );
    },
    async creditRead(kind, studentId, id, offset) {
      scoped();
      const queries = {
        packages:
          "SELECT p.*,c.name AS course_name,s.name AS student_name,COALESCE(t.balance,0) AS balance,COALESCE((SELECT SUM(a.amount) FROM package_receipt_lines a WHERE a.tenant_id=p.tenant_id AND a.package_id=p.id),0) paid_amount FROM packages p JOIN course_types c ON c.tenant_id=p.tenant_id AND c.id=p.course_type_id JOIN students s ON s.tenant_id=p.tenant_id AND s.id=p.student_id LEFT JOIN (SELECT package_id,ROUND(SUM(delta),2) balance FROM package_transactions WHERE tenant_id=? GROUP BY package_id) t ON t.package_id=p.id WHERE p.tenant_id=? AND p.deleted_at IS NULL AND (? IS NULL OR p.student_id=?) AND (? IS NULL OR p.id=?) ORDER BY p.purchase_date,p.id LIMIT 200 OFFSET ?",
        transactions:
          "SELECT * FROM package_transactions WHERE tenant_id=? AND deleted_at IS NULL AND (? IS NULL OR student_id=?) AND (? IS NULL OR id=?) ORDER BY date DESC,created_at DESC,id LIMIT 200 OFFSET ?",
        payments:
          "SELECT p.*,r.kind,r.stage_id,r.other_category,r.other_note,r.recognized_date,CASE WHEN r.id IS NULL AND p.package_id IS NULL THEN 1 ELSE 0 END unresolved FROM student_payments p LEFT JOIN student_payment_resolutions r ON r.tenant_id=p.tenant_id AND r.id=p.id AND r.deleted_at IS NULL WHERE p.tenant_id=? AND p.deleted_at IS NULL AND (? IS NULL OR p.student_id=?) AND (? IS NULL OR p.id=?) ORDER BY p.paid_at DESC,p.id LIMIT 200 OFFSET ?",
        makeups:
          "SELECT m.*,p.student_id,s.name student_name,ol.start_at original_start,tl.start_at target_start,oc.name original_course,tc.name target_course FROM makeup_links m JOIN lesson_participants p ON p.tenant_id=m.tenant_id AND p.id=m.original_participant_id JOIN students s ON s.tenant_id=p.tenant_id AND s.id=p.student_id JOIN lessons ol ON ol.tenant_id=p.tenant_id AND ol.id=p.lesson_id JOIN lessons tl ON tl.tenant_id=m.tenant_id AND tl.id=m.target_lesson_id JOIN course_types oc ON oc.tenant_id=ol.tenant_id AND oc.id=ol.course_type_id JOIN course_types tc ON tc.tenant_id=tl.tenant_id AND tc.id=tl.course_type_id WHERE m.tenant_id=? AND m.deleted_at IS NULL AND (? IS NULL OR p.student_id=?) AND (? IS NULL OR m.id=?) ORDER BY m.created_at,m.id LIMIT 200 OFFSET ?",
        stages:
          "SELECT * FROM student_stages WHERE tenant_id=? AND deleted_at IS NULL AND (? IS NULL OR student_id=?) AND (? IS NULL OR id=?) ORDER BY created_at,id LIMIT 200 OFFSET ?",
      };
      if (kind === "packages")
        return all(
          queries[kind],
          tenantId,
          tenantId,
          studentId,
          studentId,
          id,
          id,
          offset,
        );
      return all(queries[kind], tenantId, studentId, studentId, id, id, offset);
    },
    async stageReferences(id) {
      scoped();
      return first(`SELECT
        EXISTS(SELECT 1 FROM packages WHERE tenant_id=?1 AND stage_id=?2 AND deleted_at IS NULL) packages,
        EXISTS(SELECT 1 FROM student_payment_resolutions r JOIN student_payments p ON p.tenant_id=r.tenant_id AND p.id=r.id
          WHERE r.tenant_id=?1 AND r.stage_id=?2 AND r.deleted_at IS NULL AND p.deleted_at IS NULL) payments`, tenantId, id);
    },
    async tuitionForEdit(id) {
      scoped();
      return first(`SELECT p.*,k.amount package_due,
        COALESCE((SELECT SUM(x.amount) FROM package_receipt_lines x WHERE x.tenant_id=p.tenant_id
          AND x.package_id=p.package_id),0)-p.amount package_paid_elsewhere
        FROM student_payments p LEFT JOIN packages k ON k.tenant_id=p.tenant_id AND k.id=p.package_id
        WHERE p.tenant_id=? AND p.id=? AND p.deleted_at IS NULL`, tenantId,id);
    },
    async legacyPaymentPackage(id) {
      scoped();
      return first(`SELECT p.*,COALESCE((SELECT SUM(x.amount) FROM package_receipt_lines x
        WHERE x.tenant_id=p.tenant_id AND x.package_id=p.id),0) paid_amount
        FROM packages p WHERE p.tenant_id=? AND p.id=? AND p.deleted_at IS NULL`,tenantId,id);
    },
    async packageInUse(id) {
      scoped();
      const row = await first(
        `SELECT EXISTS(SELECT 1 FROM package_transactions WHERE tenant_id=?1 AND package_id=?2)
         OR EXISTS(SELECT 1 FROM lesson_participants WHERE tenant_id=?1 AND package_id=?2)
         OR EXISTS(SELECT 1 FROM student_payments WHERE tenant_id=?1 AND package_id=?2)
         OR EXISTS(SELECT 1 FROM student_payment_allocations WHERE tenant_id=?1 AND package_id=?2)
         OR EXISTS(SELECT 1 FROM student_balances_ledger WHERE tenant_id=?1 AND package_id=?2) linked`,
        tenantId, id,
      );
      return !!row.linked;
    },
    async studentBalance(student, offset = 0) {
      scoped();
      const [total, rows] = await db.batch([
        sql("SELECT COALESCE(SUM(amount),0) balance FROM student_balances_ledger WHERE tenant_id=? AND student_id=? AND deleted_at IS NULL", tenantId, student),
        sql("SELECT id,type,amount,payment_id,package_id,reason,created_at FROM student_balances_ledger WHERE tenant_id=? AND student_id=? AND deleted_at IS NULL ORDER BY created_at DESC,id LIMIT 200 OFFSET ?", tenantId, student, offset),
      ]);
      return { balance: total.results[0].balance, ledger: rows.results };
    },
    async paymentPending(student, offset) {
      scoped();
      const rows = await db.batch([
        sql("SELECT p.*,s.name student_name FROM pending_student_payments p JOIN students s ON s.tenant_id=p.tenant_id AND s.id=p.student_id WHERE p.tenant_id=?1 AND (?2 IS NULL OR p.student_id=?2) ORDER BY p.paid_at DESC,p.id LIMIT 200 OFFSET ?3", tenantId, student, offset),
        sql("SELECT p.*,s.name student_name,c.name course_name FROM packages p JOIN students s ON s.tenant_id=p.tenant_id AND s.id=p.student_id JOIN course_types c ON c.tenant_id=p.tenant_id AND c.id=p.course_type_id WHERE p.tenant_id=?1 AND (?2 IS NULL OR p.student_id=?2) AND p.deleted_at IS NULL AND p.amount IS NULL ORDER BY p.purchase_date DESC,p.id LIMIT 200 OFFSET ?3", tenantId, student, offset),
      ]);
      return { unlinked_payments: rows[0].results, packages_without_price: rows[1].results };
    },
    async paymentReversalFacts(payment, student) {
      scoped();
      const [allocations, totals] = await db.batch([
        sql("SELECT * FROM student_payment_allocations WHERE tenant_id=? AND payment_id=? AND student_id=? AND deleted_at IS NULL", tenantId, payment, student),
        sql("SELECT COALESCE(SUM(CASE WHEN payment_id=? AND type='deposit' THEN amount ELSE 0 END),0) deposit,COALESCE(SUM(amount),0) balance FROM student_balances_ledger WHERE tenant_id=? AND student_id=? AND deleted_at IS NULL", payment, tenantId, student),
      ]);
      return { allocations: allocations.results, ...totals.results[0] };
    },
    async paymentStages(ids, student) {
      scoped();
      return all("SELECT id FROM student_stages WHERE tenant_id=? AND student_id=? AND deleted_at IS NULL AND id IN(SELECT value FROM json_each(?))", tenantId, student, JSON.stringify(ids));
    },
    async categoryPackageTypes(ids) {
      scoped();
      return all("SELECT category_id,MIN(id) id FROM course_types WHERE tenant_id=? AND active=1 AND deleted_at IS NULL AND category_id IN(SELECT value FROM json_each(?)) GROUP BY category_id", tenantId, JSON.stringify(ids));
    },
    async paymentPackageTotals(ids) {
      scoped();
      return all("SELECT package_id,SUM(amount) amount FROM package_receipt_lines WHERE tenant_id=? AND package_id IN (SELECT value FROM json_each(?)) GROUP BY package_id", tenantId, JSON.stringify(ids));
    },
    async creditDebtTotal(student = null) {
      scoped();
      return first(creditDebtTotalSql, tenantId, student, new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" }));
    },
    async creditContext(lessonId, extraStudents = [], extraPackages = []) {
      scoped();
      let participants = [];
      if (lessonId)
        participants = await all(
          "WITH RECURSIVE connected(id,makeup_for,lesson_id) AS (SELECT id,makeup_for,lesson_id FROM lesson_participants WHERE tenant_id=? AND lesson_id=? AND deleted_at IS NULL UNION SELECT p.id,p.makeup_for,p.lesson_id FROM lesson_participants p JOIN connected c ON (p.makeup_for=c.id OR p.id=c.makeup_for OR p.lesson_id=c.lesson_id) WHERE p.tenant_id=? AND p.deleted_at IS NULL) SELECT p.* FROM lesson_participants p JOIN connected c ON c.id=p.id WHERE p.tenant_id=? AND p.deleted_at IS NULL LIMIT 2001",
          tenantId,
          lessonId,
          tenantId,
          tenantId,
        );
      if (participants.length > 2000) fail(400, "关联补课范围过大，请分开处理");
      const students = [
          ...new Set([
            ...extraStudents,
            ...participants.map((x) => x.student_id),
          ]),
        ],
        lessons = [
          ...new Set(
            [lessonId, ...participants.map((x) => x.lesson_id)].filter(Boolean),
          ),
        ],
        partIds = participants.map((x) => x.id),
        pids = extraPackages;
      const result = await db.batch([
        sql(
          "SELECT * FROM lessons WHERE tenant_id=? AND id IN(SELECT value FROM json_each(?)) AND deleted_at IS NULL",
          tenantId,
          JSON.stringify(lessons),
        ),
        sql(
          "SELECT * FROM packages WHERE tenant_id=? AND deleted_at IS NULL AND (student_id IN(SELECT value FROM json_each(?)) OR id IN(SELECT value FROM json_each(?))) ORDER BY purchase_date,created_at,id LIMIT 5001",
          tenantId,
          JSON.stringify(students),
          JSON.stringify(pids),
        ),
        sql(
          "SELECT package_id,ROUND(SUM(delta),2) AS balance FROM package_transactions WHERE tenant_id=? AND (student_id IN(SELECT value FROM json_each(?)) OR package_id IN(SELECT value FROM json_each(?))) GROUP BY package_id",
          tenantId,
          JSON.stringify(students),
          JSON.stringify(pids),
        ),
        sql(
          "SELECT package_id,participant_id,ROUND(SUM(delta),2) AS net FROM package_transactions WHERE tenant_id=? AND participant_id IN(SELECT value FROM json_each(?)) GROUP BY package_id,participant_id",
          tenantId,
          JSON.stringify(partIds),
        ),
        sql(
          "SELECT * FROM students WHERE tenant_id=? AND id IN(SELECT value FROM json_each(?)) AND deleted_at IS NULL",
          tenantId,
          JSON.stringify(students),
        ),
        sql(
          "SELECT * FROM makeup_links WHERE tenant_id=? AND deleted_at IS NULL AND (original_participant_id IN(SELECT value FROM json_each(?)) OR target_participant_id IN(SELECT value FROM json_each(?)))",
          tenantId,
          JSON.stringify(partIds),
          JSON.stringify(partIds),
        ),
        sql(
          "SELECT d.*,substr(l.start_at,1,10) lesson_date FROM credit_debts d JOIN lessons l ON l.tenant_id=d.tenant_id AND l.id=d.lesson_id WHERE d.tenant_id=? AND d.deleted_at IS NULL AND (d.participant_id IN(SELECT value FROM json_each(?)) OR (d.remaining_units>0 AND d.student_id IN(SELECT value FROM json_each(?)))) ORDER BY d.created_at,d.id LIMIT 10001",
          tenantId, JSON.stringify(partIds), JSON.stringify(students),
        ),
      ]);
      const [lessonRows, packages, balances, nets, profiles, links, debts] =
        result.map((x) => x.results || []);
      if (debts.length > 10000) fail(400, "欠课时范围过大，请分开处理");
      if (packages.length > 5000) fail(400, "课时包范围过大");
      return {
        participants,
        lessons: lessonRows,
        packages,
        balances,
        nets,
        students: profiles,
        links,
        debts,
      };
    },
    async primeReferences(input) {
      scoped();
      const groups = {
        students: input.studentIds || [],
        teachers: input.teacherIds || [],
        locations: input.locationIds || [],
        course_types: input.typeIds || [],
        schedule_templates: input.templateIds || [],
        packages: input.packageIds || [],
      };
      const ops = [],
        keys = [];
      for (const [kind, values] of Object.entries(groups)) {
        const ids = [...new Set(values.filter(Boolean))].filter(
          (id) => !cache.records.has(kind + ":" + id),
        );
        if (!ids.length) continue;
        keys.push({ kind, ids });
        ops.push(sql(referenceSql[kind], tenantId, JSON.stringify(ids)));
      }
      const categories = [
        ...new Set((input.categoryIds || []).filter(Boolean)),
      ];
      if (categories.length || (input.typeIds || []).length) {
        keys.push({ kind: "course_categories", ids: categories });
        ops.push(
          sql(
            "SELECT * FROM course_categories WHERE tenant_id=? AND deleted_at IS NULL AND (id IN(SELECT value FROM json_each(?)) OR id IN(SELECT category_id FROM course_types WHERE tenant_id=? AND id IN(SELECT value FROM json_each(?)) AND deleted_at IS NULL))",
            tenantId,
            JSON.stringify(categories),
            tenantId,
            JSON.stringify(input.typeIds || []),
          ),
        );
      }
      const students = [...new Set((input.studentIds || []).filter(Boolean))];
      if (students.length) {
        keys.push({ kind: "blocks", ids: students });
        ops.push(
          sql(
            "SELECT * FROM student_schedule_blocks WHERE tenant_id=? AND student_id IN(SELECT value FROM json_each(?)) AND active=1 AND deleted_at IS NULL",
            tenantId,
            JSON.stringify(students),
          ),
        );
      }
      const templates = [...new Set((input.templateIds || []).filter(Boolean))];
      if (templates.length) {
        keys.push({ kind: "enrollments", ids: templates });
        ops.push(
          sql(
            "SELECT * FROM schedule_enrollments WHERE tenant_id=? AND template_id IN(SELECT value FROM json_each(?)) AND deleted_at IS NULL AND date_from<=? AND date_to>=?",
            tenantId,
            JSON.stringify(templates),
            input.to || "9999-12-31",
            input.from || "0001-01-01",
          ),
        );
      }
      if (!ops.length) return;
      const results = await db.batch(ops);
      for (let i = 0; i < keys.length; i++) {
        const { kind, ids } = keys[i],
          rows = results[i].results || [];
        if (kind === "blocks" || kind === "enrollments") {
          const map = kind === "blocks" ? cache.blocks : cache.enrollments,
            field = kind === "blocks" ? "student_id" : "template_id";
          for (const id of ids)
            map.set(
              id,
              rows.filter((x) => x[field] === id),
            );
        } else {
          for (const id of ids) cache.records.set(kind + ":" + id, null);
          for (const row of rows) cache.records.set(kind + ":" + row.id, row);
        }
      }
    },
    async generationTemplates(from, to, classId = null) {
      scoped();
      const rows = await all(
        "SELECT * FROM schedule_templates WHERE tenant_id=? AND deleted_at IS NULL AND active=1 AND date_from<=? AND date_to>=? AND (? IS NULL OR class_id=?) ORDER BY id LIMIT 1001",
        tenantId,
        to,
        from,
        classId,
        classId,
      );
      for (const row of rows)
        cache.records.set("schedule_templates:" + row.id, row);
      return rows;
    },
    async dataVersion() {
      scoped();
      if (
        await first(
          "SELECT id FROM data_jobs WHERE tenant_id=? AND status IN ('staging','ready') LIMIT 1",
          tenantId,
        )
      )
        fail(409, "机构正在导入或恢复，请稍后再试");
      await sql(
        "INSERT OR IGNORE INTO tenant_data_versions(tenant_id,version) VALUES(?,0)",
        tenantId,
      ).run();
      return (
        await first(
          "SELECT version FROM tenant_data_versions WHERE tenant_id=?",
          tenantId,
        )
      ).version;
    },
    async personalList(resource, user, offset) {
      scoped();
      if (resource === "lessons" && user.roles.includes("teacher"))
        return all(
          "SELECT * FROM lessons WHERE tenant_id=? AND deleted_at IS NULL AND (teacher_id=? OR assistant_id=?) ORDER BY start_at,id LIMIT 200 OFFSET ?",
          tenantId,
          user.teacher_id,
          user.teacher_id,
          offset,
        );
      if (resource === "lessons" && user.roles.includes("student"))
        return all(
          "SELECT l.* FROM lessons l JOIN lesson_participants p ON p.tenant_id=l.tenant_id AND p.lesson_id=l.id WHERE l.tenant_id=? AND l.deleted_at IS NULL AND p.deleted_at IS NULL AND p.student_id=? ORDER BY l.start_at,l.id LIMIT 200 OFFSET ?",
          tenantId,
          user.student_id,
          offset,
        );
      if (resource === "students" && user.roles.includes("student")) {
        const row = await first(
          businessSql.students.get,
          tenantId,
          user.student_id,
        );
        return row ? [row] : [];
      }
      return [];
    },
    async businessGet(resource, id) {
      scoped();
      const q = businessSql[resource];
      if (!q) throw Error("invalid resource");
      const key = resource + ":" + id;
      if (env.__requestScope && cache.records.has(key))
        return cache.records.get(key);
      const row = await first(q.get, tenantId, id);
      cache.records.set(key, row);
      return row;
    },
    async businessList(resource, offset = 0, query = "") {
      scoped();
      const q = businessSql[resource];
      if (!q) throw Error("invalid resource");
      if (query && searchSql[resource])
        return all(searchSql[resource], tenantId, query, offset);
      return all(q.list, tenantId, offset);
    },
    async nextLesson(user, at, fromDate) {
      scoped();
      const teacher = user.roles.includes("teacher") ? user.teacher_id : null,
        student = user.roles.includes("student") ? user.student_id : null;
      return first(
        nextLessonSql,
        tenantId,
        fromDate,
        at,
        teacher,
        teacher,
        teacher,
        student,
        student,
      );
    },
    async weekPage(from, to, offset, user, outward = false) {
      scoped();
      const { query, args } = weekQuery(from, to, offset, user, outward);
      return all(query, ...args);
    },
    async scheduleWeek(from, to, offset, user, filter) {
      scoped();
      const { query, args } = weekQuery(from, to, offset, user, false, filter);
      const page = `WITH page AS (${query})`;
      const own = user.roles.includes("student") ? user.student_id : null;
      const teacher = user.roles.includes("teacher") ? user.teacher_id : null;
      const [rows, participants, ...extra] = await db.batch([
        sql(query, ...args),
        sql(`${page} ${participantSummarySql("SELECT id FROM page")}`, ...args, tenantId, own, own),
        ...(filter ? [studentScheduleAccess(filter, teacher)] : []),

      ]);
      if (filter && !extra[0].results.length) fail(404, "不存在");
      return { rows: rows.results, participants: participants.results, meetings: [] };
    },
    async studentFixedRules(student, teacher, date) {
      scoped();
      const [access, rules] = await db.batch([
        studentScheduleAccess(student, teacher),
        sql(`WITH selected AS MATERIALIZED (
            SELECT * FROM schedule_templates t WHERE t.tenant_id=?1 AND t.active=1 AND t.deleted_at IS NULL
              AND t.date_from<=?3 AND t.date_to>=?3
              AND (?4 IS NULL OR t.teacher_id=?4 OR t.assistant_id=?4)
              AND t.id IN(${studentTemplateIds("?1", "?2")})
          ), roster AS (${templateRosterSql}), counts AS (
            SELECT template_id,COUNT(DISTINCT id) member_count FROM roster
            WHERE date_from<=?3 AND date_to>=?3 GROUP BY template_id
          )
          SELECT t.id,t.weekday,t.start_time,t.duration,
            CASE WHEN time(t.start_time,'+'||t.duration||' minutes')='00:00:00' THEN '24:00'
              ELSE substr(time(t.start_time,'+'||t.duration||' minutes'),1,5) END end_time,
            c.id course_type_id,c.name course_name,h.id teacher_id,h.name teacher_name,
            o.id location_id,o.name location_name,e.date_from,e.date_to,n.member_count
          FROM roster e JOIN selected t ON t.id=e.template_id
          JOIN counts n ON n.template_id=t.id
          JOIN course_types c ON c.tenant_id=t.tenant_id AND c.id=t.course_type_id
          JOIN teachers h ON h.tenant_id=t.tenant_id AND h.id=t.teacher_id
          LEFT JOIN locations o ON o.tenant_id=t.tenant_id AND o.id=t.location_id
          WHERE e.id=?2 AND e.date_from<=?3 AND e.date_to>=?3
          ORDER BY t.weekday,t.start_time,t.id`, tenantId, student, date, teacher),
      ]);
      if (!access.results.length) fail(404, "不存在");
      return rules.results;
    },
    async makeupSchedule({
      teacher,
      assistant,
      room,
      student,
      from,
      to,
      historyFrom,
      historyTo,
      at,
    }) {
      scoped();
      const own = `EXISTS(SELECT 1 FROM lesson_participants p
        WHERE p.tenant_id=l.tenant_id AND p.lesson_id=l.id AND p.student_id=?2 AND p.deleted_at IS NULL)`;
      const result = await db.batch([
        sql(
          `SELECT l.id,l.start_at,l.duration,l.status,l.mode,l.teacher_id,l.assistant_id,l.location_id,
          c.name course_name,t.name teacher_name,${own} own
          FROM lessons l LEFT JOIN course_types c ON c.tenant_id=l.tenant_id AND c.id=l.course_type_id
          LEFT JOIN teachers t ON t.tenant_id=l.tenant_id AND t.id=l.teacher_id
          WHERE l.tenant_id=?1 AND l.deleted_at IS NULL AND l.start_at>=?3 AND l.start_at<?4
          AND (l.teacher_id IN (?5,?6) OR l.assistant_id IN (?5,?6) OR l.location_id=?7 OR ${own})
          ORDER BY l.start_at,l.id LIMIT 5001`,
          tenantId,
          student,
          from,
          to,
          teacher,
          assistant,
          room,
        ),
        sql(
          `SELECT l.start_at,l.duration,l.teacher_id=?5 teacher,${own} own
          FROM lessons l WHERE l.tenant_id=?1 AND l.deleted_at IS NULL AND l.start_at>=?3 AND l.start_at<?4
          AND (l.teacher_id=?5 OR ${own}) AND l.status NOT IN ('cancelled','rescheduled','teacher_leave')
          AND strftime('%s',l.start_at)*1000>=?6-4838400000 AND strftime('%s',l.start_at)*1000<?6
          ORDER BY l.start_at,l.id LIMIT 5001`,
          tenantId,
          student,
          historyFrom,
          historyTo,
          teacher,
          at,
        ),
      ]);
      const [lessons, history] = result.map((x) => x.results || []);
      if (lessons.length > 5000 || history.length > 5000)
        fail(400, "相关课程过多，请使用自选日期");
      return {
        lessons: lessons.map((row) => ({
          ...row,
          student_ids: row.own ? [student] : [],
        })),
        history,
      };
    },
    async scheduleWindow(from, to, includeMoved = false) {
      scoped();
      const lessons = await all(
        `SELECT * FROM lessons WHERE tenant_id=?1 AND deleted_at IS NULL AND start_at>=?2 AND start_at<?3
          ${includeMoved ? `UNION ALL SELECT * FROM lessons WHERE tenant_id=?1 AND deleted_at IS NULL AND template_id IS NOT NULL
            AND occurrence_date>=?2 AND occurrence_date<?3 AND (start_at<?2 OR start_at>=?3)` : ""}
          ORDER BY start_at,id LIMIT 5001`,
        tenantId,
        from,
        to,
      );
      if (lessons.length > 5000) fail(400, "日期范围课程过多，请缩小范围");
      const participants = await all(
        "SELECT p.* FROM lesson_participants p JOIN lessons l ON l.tenant_id=p.tenant_id AND l.id=p.lesson_id WHERE p.tenant_id=? AND p.deleted_at IS NULL AND l.deleted_at IS NULL AND l.start_at>=? AND l.start_at<? LIMIT 50001",
        tenantId,
        from,
        to,
      );
      if (participants.length > 50000) fail(400, "课程人数过多，请缩小范围");
      return { lessons, participants };
    },
    async blocksFor(studentId) {
      scoped();
      if (cache.blocks.has(studentId)) return cache.blocks.get(studentId);
      const rows = await all(
        "SELECT * FROM student_schedule_blocks WHERE tenant_id=? AND student_id=? AND active=1 AND deleted_at IS NULL LIMIT 1000",
        tenantId,
        studentId,
      );
      cache.blocks.set(studentId, rows);
      return rows;
    },
    async enrollmentsFor(templateId) {
      scoped();
      if (cache.enrollments.has(templateId))
        return cache.enrollments.get(templateId);
      const rows = await all(
        "SELECT * FROM schedule_enrollments WHERE tenant_id=? AND template_id=? AND deleted_at IS NULL ORDER BY date_from LIMIT 1001",
        tenantId,
        templateId,
      );
      cache.enrollments.set(templateId, rows);
      return rows;
    },
    async participantsFor(lessonId) {
      scoped();
      if (cache.participants.has(lessonId))
        return cache.participants.get(lessonId);
      const rows = await all(
        "SELECT * FROM lesson_participants WHERE tenant_id=? AND lesson_id=? AND deleted_at IS NULL LIMIT 1001",
        tenantId,
        lessonId,
      );
      cache.participants.set(lessonId, rows);
      return rows;
    },
    async linkedAccount(kind, id) {
      scoped();
      return kind === "teacher"
        ? first(
            "SELECT id FROM users WHERE tenant_id=? AND teacher_id=? AND deleted_at IS NULL",
            tenantId,
            id,
          )
        : first(
            "SELECT id FROM users WHERE tenant_id=? AND student_id=? AND deleted_at IS NULL",
            tenantId,
            id,
          );
    },
    async references(resource, id) {
      scoped();
      const checks = stage6ReferenceSql[resource];
      if (checks && (await first(checks, tenantId, id))) return true;

      const statements = {
        students:
          "SELECT id FROM users WHERE tenant_id=? AND student_id=? AND deleted_at IS NULL UNION ALL SELECT id FROM lesson_participants WHERE tenant_id=? AND student_id=? AND deleted_at IS NULL UNION ALL SELECT id FROM schedule_enrollments WHERE tenant_id=? AND student_id=? AND deleted_at IS NULL UNION ALL SELECT id FROM packages WHERE tenant_id=? AND student_id=? AND deleted_at IS NULL UNION ALL SELECT id FROM student_schedule_blocks WHERE tenant_id=? AND student_id=? AND deleted_at IS NULL UNION ALL SELECT id FROM student_stages WHERE tenant_id=? AND student_id=? AND deleted_at IS NULL UNION ALL SELECT id FROM student_payments WHERE tenant_id=? AND student_id=? AND deleted_at IS NULL LIMIT 1",
        teachers:
          "SELECT id FROM users WHERE tenant_id=? AND teacher_id=? AND deleted_at IS NULL UNION ALL SELECT id FROM lessons WHERE tenant_id=? AND (teacher_id=? OR assistant_id=?) AND deleted_at IS NULL UNION ALL SELECT id FROM schedule_templates WHERE tenant_id=? AND (teacher_id=? OR assistant_id=?) AND deleted_at IS NULL UNION ALL SELECT id FROM teacher_rates WHERE tenant_id=? AND teacher_id=? AND deleted_at IS NULL UNION ALL SELECT id FROM teacher_payments WHERE tenant_id=? AND teacher_id=? AND deleted_at IS NULL UNION ALL SELECT id FROM teacher_adjustments WHERE tenant_id=? AND teacher_id=? AND deleted_at IS NULL LIMIT 1",
        locations:
          "SELECT id FROM lessons WHERE tenant_id=? AND location_id=? AND deleted_at IS NULL UNION ALL SELECT id FROM schedule_templates WHERE tenant_id=? AND location_id=? AND deleted_at IS NULL LIMIT 1",
        course_categories:
          "SELECT id FROM course_types WHERE tenant_id=? AND category_id=? AND deleted_at IS NULL LIMIT 1",
        course_types:
          "SELECT id FROM lessons WHERE tenant_id=? AND course_type_id=? AND deleted_at IS NULL UNION ALL SELECT id FROM schedule_templates WHERE tenant_id=? AND course_type_id=? AND deleted_at IS NULL UNION ALL SELECT id FROM packages WHERE tenant_id=? AND course_type_id=? AND deleted_at IS NULL UNION ALL SELECT id FROM teacher_rates WHERE tenant_id=? AND course_type_id=? AND deleted_at IS NULL LIMIT 1",
        schedule_templates:
          "SELECT id FROM lessons WHERE tenant_id=? AND template_id=? AND deleted_at IS NULL UNION ALL SELECT id FROM schedule_enrollments WHERE tenant_id=? AND template_id=? AND deleted_at IS NULL LIMIT 1",
      };
      if (!statements[resource]) return false;
      const counts = {
        students: 7,
        teachers: 4,
        locations: 2,
        course_categories: 1,
        course_types: 4,
        schedule_templates: 2,
      };
      const p = [];
      if (resource === "teachers")
        p.push(
          tenantId,
          id,
          tenantId,
          id,
          id,
          tenantId,
          id,
          id,
          tenantId,
          id,
          tenantId,
          id,
          tenantId,
          id,
        );
      else for (let i = 0; i < counts[resource]; i++) p.push(tenantId, id);
      return !!(await first(statements[resource], ...p));
    },
    async commitBusiness(revision, changes, actor, module, action) {
      scoped();
      const guard = randomId("guard"),
        t = now(),
        ops = [
          sql(
            "INSERT INTO mutation_guards(tenant_id,id,expected,actual) VALUES(?,?,0,(SELECT COUNT(*) FROM data_jobs WHERE tenant_id=? AND status IN ('staging','ready')))",
            tenantId,
            randomId("guard"),
            tenantId,
          ),
          sql(
            "INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?,?,?,version FROM tenant_data_versions WHERE tenant_id=?",
            tenantId,
            guard,
            revision,
            tenantId,
          ),
          sql(
            "UPDATE tenant_data_versions SET version=version+1 WHERE tenant_id=?",
            tenantId,
          ),
        ];
      if (env.__maintenance?.tenantId === tenantId)
        ops.push(
          sql(
            "INSERT INTO mutation_guards(tenant_id,id,expected,actual) VALUES(?,?,1,COALESCE((SELECT 1 FROM maintenance_leases WHERE tenant_id=? AND id=? AND admin_id=? AND revoked=0 AND expires_at>?),0))",
            tenantId,
            randomId("guard"),
            tenantId,
            env.__maintenance.id,
            env.__maintenance.adminId,
            now(),
          ),
        );
      for (const change of changes) {
        const q = businessSql[change.resource];
        if (!q) throw Error("invalid resource");
        const row = { ...change.data, updated_at: t, updated_by: actor.id };
        if (change.resource === "students") row.billing_mode ??= "package";
        if (change.resource === "lessons") {
          row.teacher_paid ??= 0;
          row.override_basis ??= "legacy";
          row.format ??= "individual";
        }
        if (change.resource === "settlements") {
          row.status ??= "draft";
          row.reason ??= "";
          for (const key of [
            "total_amount",
            "tuition_amount",
            "cost_amount",
            "profit_amount",
          ])
            row[key] ??= 0;
        }
        if (change.resource === "packages") {
          row.scope_kind ??= "type";
          row.purchase_date ??= new Date().toLocaleDateString("sv-SE", {
            timeZone: "Asia/Shanghai",
          });
        }

        if(change.resource==='growth_feedback'){
          const d=JSON.parse(row.doc_json),pictures=[...new Set(d.image_ids||[])],repertoire=[...new Set(d.repertoire_ids||[])],prior=change.growth_previous_image_ids||(change.previous?JSON.parse(change.previous.doc_json).image_ids||[]:[]);
          if(pictures.length)ops.push(sql('INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?,?,?,(SELECT COUNT(*) FROM gallery_images WHERE tenant_id=? AND id IN(SELECT value FROM json_each(?)) AND deleted_at IS NULL AND (hidden=0 OR id IN(SELECT value FROM json_each(?))))',tenantId,randomId('guard'),pictures.length,tenantId,JSON.stringify(pictures),JSON.stringify(prior)));
          if(repertoire.length)ops.push(sql('INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?,?,?,(SELECT COUNT(*) FROM growth_repertoire WHERE tenant_id=? AND student_id=? AND id IN(SELECT value FROM json_each(?)) AND deleted_at IS NULL)',tenantId,randomId('guard'),repertoire.length,tenantId,row.student_id,JSON.stringify(repertoire)));
        }
        storedRecord(row, "业务记录");
        if (change.previous) {
          ops.push(
            sql(
              q.guard,
              tenantId,
              randomId("guard"),
              change.previous.version,
              tenantId,
              row.id,
            ),
          );
          row.version = change.previous.version + 1;
          ops.push(
            sql(
              q.update,
              ...q.columns.map((k) => row[k] ?? null),
              tenantId,
              row.id,
            ),
          );
        } else {
          row.created_at = t;
          row.created_by = actor.id;
          row.version = 1;
          ops.push(
            sql(
              q.insert,
              tenantId,
              row.id,
              ...q.columns.map((k) => row[k] ?? null),
            ),
          );
        }
      }
      for (const [before, after] of auditChunks(
        changes.map((x) => [
          safeBusinessAudit(x.previous),
          safeBusinessAudit(x.data),
        ]),
      ))
        ops.push(
          sql(
            "INSERT INTO audit_log(tenant_id,id,at,actor_id,actor_label,module,action,entity_id,summary,before_json,after_json,money_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,1)",
            tenantId,
            randomId("aud"),
            t,
            actor.id,
            actor.name,
            module,
            action,
            changes[0]?.data.id || null,
            "基础资料/排课变更 " + changes.length + " 条",
            before,
            after,
          ),
        );
      ops.push(sql("DELETE FROM mutation_guards WHERE tenant_id=?", tenantId));
      try {
        await db.batch(ops);
        cache.records.clear();
        cache.blocks.clear();
        cache.enrollments.clear();
        cache.participants.clear();
      } catch (e) {
        cache.records.clear();
        cache.blocks.clear();
        cache.enrollments.clear();
        cache.participants.clear();
        if (/CHECK constraint/.test(String(e.message))) {
          for (const change of changes)
            if (change.previous) {
              const current = await first(
                businessSql[change.resource].get,
                tenantId,
                change.data.id,
              );
              if (!current || current.version !== change.previous.version)
                fail(409, "这条记录刚被其他用户修改，请刷新");
            }
          fail(409, "课表快照发生变化，请重新检查", "SCHEDULE_RETRY");
        }
        throw e;
      }
    },
    async resolve(host, slug, auth = null) {
      platform();
      if (auth) return authentication(auth.hash, { host, slug, ...auth });
      return tenantRoute(await first(tenantRouteSql("?1", "?2", "?3"), host, slug, now()));
    },
    async tenant() {
      scoped();
      return first("SELECT * FROM tenants WHERE id=?", tenantId);
    },
    async brandLite() {
      scoped();
      return first("SELECT display_name,theme_color,welcome_text,version,CASE WHEN logo IS NOT NULL AND logo<>'' THEN 1 ELSE 0 END has_logo,CASE WHEN login_bg IS NOT NULL AND login_bg<>'' THEN 1 ELSE 0 END has_bg FROM tenant_branding WHERE tenant_id=? AND id='brand'",tenantId);
    },
    async brandImage(field, version) {
      scoped();
      if (!["logo", "login_bg"].includes(field)) throw Error("invalid brand image");
      return first("SELECT " + field + " image FROM tenant_branding WHERE tenant_id=? AND id='brand' AND version=?",tenantId,version);
    },
    async brand() {
      scoped();
      return first(
        "SELECT display_name,logo,login_bg,theme_color,welcome_text,consultant_qr,contact_text,version FROM tenant_branding WHERE tenant_id=? AND id=?",
        tenantId,
        "brand",
      );
    },
    async policy() {
      scoped();
      if (cache.policy) return cache.policy;
      const results = await db.batch([
        sql(
          "SELECT id,enabled FROM tenant_modules WHERE tenant_id=? AND deleted_at IS NULL",
          tenantId,
        ),
        sql(
          "SELECT id,value FROM tenant_settings WHERE tenant_id=? AND deleted_at IS NULL",
          tenantId,
        ),
        sql(
          "SELECT role,module,action,allowed FROM tenant_role_rights WHERE tenant_id=? AND deleted_at IS NULL",
          tenantId,
        ),
      ]);
      const [modules, settings, rights] = results.map((x) => x.results || []);
      return policyRows(modules, settings, rights);
    },
    async userByPhone(index) {
      scoped();
      return first(
        "SELECT * FROM users WHERE tenant_id=? AND phone_hmac=? AND deleted_at IS NULL",
        tenantId,
        index,
      );
    },
    async user(id) {
      scoped();
      return first(
        "SELECT * FROM users WHERE tenant_id=? AND id=? AND deleted_at IS NULL",
        tenantId,
        id,
      );
    },
    async userCount() {
      scoped();
      return (
        await first(
          "SELECT COUNT(*) n FROM users WHERE tenant_id=? AND deleted_at IS NULL",
          tenantId,
        )
      ).n;
    },
    async users(offset = 0) {
      scoped();
      return all(
        "SELECT id,name,roles,phone_last4,teacher_id,student_id,active,must_change,version FROM users WHERE tenant_id=? AND deleted_at IS NULL ORDER BY created_at,id LIMIT 200 OFFSET ?",
        tenantId,
        offset,
      );
    },
    async createUser(data, actor) {
      scoped();
      const t = now(),
        student = JSON.parse(data.roles).includes("student");
      const platformHash = data.platform_phone_hmac ??
        (data.phone_enc?.startsWith("v1.") && env.PLATFORM_PHONE_HMAC_KEY
          ? await platformPhoneIndex(env, await decrypt(env, data.phone_enc, tenantId + ":phone")) : null);
      let result;
      try { result = await db.batch([
        sql(
          `INSERT INTO users(tenant_id,id,name,phone_hmac,phone_enc,phone_last4,roles,teacher_id,student_id,salt,digest,created_at,created_by,updated_at,updated_by,platform_phone_hmac)
 SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ?=0 OR (SELECT COUNT(*) FROM users WHERE tenant_id=? AND deleted_at IS NULL AND instr(roles,'"student"')>0) < (SELECT student_seat_limit FROM tenants WHERE id=?)`,
          tenantId,
          data.id,
          data.name,
          data.phone_hmac,
          data.phone_enc,
          data.phone_last4,
          data.roles,
          data.teacher_id || null,
          data.student_id || null,
          data.salt,
          data.digest,
          t,
          actor.id,
          t,
          actor.id,
          platformHash,
          student ? 1 : 0,
          tenantId,
          tenantId,
        ),
        sql(
          "INSERT INTO audit_log(tenant_id,id,at,actor_id,actor_label,module,action,entity_id,summary) SELECT ?,?,?,?,?,?,?,?,? WHERE changes()=1",
          tenantId,
          randomId("aud"),
          t,
          actor.id,
          actor.name,
          "accounts",
          "create",
          data.id,
          "创建账号（手机号已脱敏）",
        ),
      ]); } catch (e) {
        if (/staff_seat_limit/.test(String(e.message))) fail(409, "账号数量已达到上限", "seat_limit_reached");
        throw e;
      }
      if (!result[0].meta.changes) fail(409, "账号数量已达到上限", "seat_limit_reached");
    },
    async updateUser(id, v, data, actor) {
      scoped();
      const previous = await first(
        "SELECT name,roles,active FROM users WHERE tenant_id=? AND id=?",
        tenantId,
        id,
      );
      const result = await db.batch([
        sql(
          "UPDATE users SET name=?,roles=?,active=?,disabled_reason=CASE WHEN ?=0 THEN 'manual' ELSE NULL END,phone_hmac=COALESCE(?,phone_hmac),phone_enc=COALESCE(?,phone_enc),phone_last4=COALESCE(?,phone_last4),platform_phone_hmac=COALESCE(?,platform_phone_hmac),version=version+1,updated_at=?,updated_by=? WHERE tenant_id=? AND id=? AND version=? AND deleted_at IS NULL",
          data.name,
          data.roles,
          data.active,
          data.active,
          data.phone_hmac ?? null,
          data.phone_enc ?? null,
          data.phone_last4 ?? null,
          data.platform_phone_hmac ?? null,
          now(),
          actor.id,
          tenantId,
          id,
          v,
        ),
        sql(
          "INSERT INTO audit_log(tenant_id,id,at,actor_id,actor_label,module,action,entity_id,summary,before_json,after_json) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE changes()=1",
          tenantId,
          randomId("aud"),
          now(),
          actor.id,
          actor.name,
          "accounts",
          "update",
          id,
          "修改账号状态或角色",
          JSON.stringify(previous),
          JSON.stringify(data),
        ),
      ]);
      if (!result[0].meta.changes) await conflict(id);
    },
    async password(id, v, password, actor, mustChange = 1) {
      scoped();
      const result = await db.batch([
        sql(
          "UPDATE users SET salt=?,digest=?,must_change=?,version=version+1,updated_at=?,updated_by=? WHERE tenant_id=? AND id=? AND version=?",
          password.salt,
          password.digest,
          mustChange,
          now(),
          actor.id,
          tenantId,
          id,
          v,
        ),
        sql(
          "INSERT INTO audit_log(tenant_id,id,at,actor_id,actor_label,module,action,entity_id,summary) SELECT ?,?,?,?,?,?,?,?,? WHERE changes()=1",
          tenantId,
          randomId("aud"),
          now(),
          actor.id,
          actor.name,
          "accounts",
          mustChange ? "reset_password" : "change_password",
          id,
          "密码变更，会话已失效",
        ),
      ]);
      if (!result[0].meta.changes) await conflict(id);
    },
    async createSession(hash, user, info, tenantVersion = null, kind = "path") {
      scoped();
      const personal = JSON.parse(user.roles).some((x) =>
          ["teacher", "student", "parent"].includes(x),
        ),
        t = now();
      const result = await sql(
        "INSERT INTO sessions(tenant_id,id,token_hash,user_id,expires_at,last_seen_at,idle_ms,ip,ua,created_at,created_by,updated_at,updated_by,kind) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE u.tenant_id=? AND u.id=? AND u.version=? AND u.digest=? AND u.active=1 AND u.deleted_at IS NULL AND t.status=? AND (? IS NULL OR t.version=?) AND (t.expires_at IS NULL OR unixepoch(t.expires_at||?) * 1000 > ?))",
        tenantId,
        randomId("ses"),
        hash,
        user.id,
        t + (personal ? 14 * 86400000 : 43200000),
        t,
        personal ? null : 7200000,
        info.ip,
        info.ua,
        t,
        user.id,
        t,
        user.id,
        kind,
        tenantId,
        user.id,
        user.version || 1,
        user.digest,
        "active",
        tenantVersion,
        tenantVersion,
        "T23:59:59+08:00",
        t,
      ).run();
      if (!result.meta.changes) fail(401, "手机号或密码不正确", "LOGIN_FAILED");
    },
    async authenticateRequest(hash) {
      scoped();
      return authentication(hash);
    },
    // 固定自然小时计数，告警与拦截分开；不会撤销任何会话。
    async recordReads(user, counts) {
      scoped();
      if (!counts.some(Boolean)) return counts.map(() => null);
      const t = now(),
        start = Math.floor(t / 3600000) * 3600000,
        key = "read:" + tenantId + ":" + user.id,
        personal = (
          Array.isArray(user.roles) ? user.roles : JSON.parse(user.roles)
        ).some((role) => ["teacher", "student", "parent"].includes(role)),
        warning = personal ? 5001 : 20000,
        blocking = personal ? 5001 : 50000;
      const statements = counts.flatMap((count) => !count ? [] : [
        sql(
          "INSERT INTO security_limits(key,count,window_start,locked_until) VALUES(?,?,?,0) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN window_start<>excluded.window_start THEN excluded.count ELSE count+excluded.count END,window_start=excluded.window_start",
          key,
          count,
          start,
        ),
        sql("SELECT count FROM security_limits WHERE key=?", key),
        sql(
          "INSERT INTO platform_audit(id,at,admin_id,action,tenant_id,target,detail,ip) SELECT ?,?,'system','读取量告警',?,?,'本小时累计读取 '||count||' 条；告警线 '||?||' 条，拦截线 '||?||' 条','' FROM security_limits WHERE key=? AND count>=? AND count-?<?",
          randomId("pa"),
          t,
          tenantId,
          user.id,
          personal ? 5000 : warning,
          personal ? 5000 : blocking,
          key,
          warning,
          count,
          warning,
        ),
      ]);
      const result = await db.batch(statements);
      let index = 0;
      return counts.map((count) => {
        if (!count) return null;
        const total = result[index + 1].results[0].count;
        index += 3;
        if (total >= blocking) {
        const resume = new Intl.DateTimeFormat("sv-SE", {
          timeZone: "Asia/Shanghai",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(new Date(start + 3600000));
        return { status: 429, body: { error:
          "本小时读取量已达安全上限，将在 " + resume + " 后恢复", code: "READ_LIMIT" } };
        }
        return null;
      });
    },
    async recordRead(user, count) {
      const [error] = await this.recordReads(user, [count]);
      if (error) fail(error.status, error.body.error, error.body.code);
    },
    async loginCity(user, cityHash, ip) {
      scoped();
      const t = now(),
        prefix = "city:" + tenantId + ":" + user + ":";
      await db.batch([
        sql(
          "INSERT INTO platform_audit(id,at,admin_id,action,tenant_id,target,detail,ip) SELECT ?,?,'system','异地登录告警',?,?,?,? WHERE EXISTS(SELECT 1 FROM security_limits WHERE key>=? AND key<? AND key<>? AND window_start>?) AND NOT EXISTS(SELECT 1 FROM security_limits WHERE key=? AND window_start>?)",
          randomId("pa"),
          t,
          tenantId,
          user,
          "一小时内出现不同城市的成功登录，请核对设备",
          ip,
          prefix,
          prefix + String.fromCharCode(127),
          prefix + cityHash,
          t - 3600000,
          prefix + cityHash,
          t - 3600000,
        ),
        sql(
          "INSERT INTO security_limits(key,count,window_start,locked_until) VALUES(?,1,?,0) ON CONFLICT(key) DO UPDATE SET window_start=excluded.window_start",
          prefix + cityHash,
          t,
        ),
      ]);
    },
    async session(hash) {
      scoped();
      return first(
        "SELECT s.id AS session_id,s.expires_at,s.last_seen_at,s.idle_ms,u.* FROM sessions s JOIN users u ON u.tenant_id=s.tenant_id AND u.id=s.user_id WHERE s.tenant_id=? AND s.token_hash=? AND u.active=1 AND u.deleted_at IS NULL",
        tenantId,
        hash,
      );
    },
    async touchSession(hash) {
      scoped();
      await sql(
        "UPDATE sessions SET last_seen_at=?,updated_at=? WHERE tenant_id=? AND token_hash=?",
        now(),
        now(),
        tenantId,
        hash,
      ).run();
    },
    async revokeSession(hash) {
      scoped();
      await sql(
        "DELETE FROM sessions WHERE tenant_id=? AND token_hash=?",
        tenantId,
        hash,
      ).run();
    },
    async sessions(user) {
      scoped();
      return all(
        "SELECT id,created_at,last_seen_at,expires_at,ip,ua FROM sessions WHERE tenant_id=? AND user_id=? AND expires_at>? ORDER BY created_at DESC LIMIT 200",
        tenantId,
        user,
        now(),
      );
    },
    async revokeDevice(user, id, actor) {
      scoped();
      await db.batch([
        sql(
          "DELETE FROM sessions WHERE tenant_id=? AND user_id=? AND id=?",
          tenantId,
          user,
          id,
        ),
        auditStmt(actor, "accounts", "revoke_device", user, "强制设备下线"),
      ]);
    },
    async authEvent(user, last4, event, info) {
      scoped();
      const t = now();
      await db.batch([
        sql(
          "INSERT INTO auth_log(tenant_id,id,at,user_id,phone_last4,event,ip,ua) VALUES(?,?,?,?,?,?,?,?)",
          tenantId,
          randomId("auth"),
          t,
          user || null,
          last4 || null,
          event,
          info.ip,
          info.ua,
        ),
        sql(
          "INSERT INTO platform_audit(id,at,admin_id,action,tenant_id,target,detail,ip) SELECT ?,?,'system','登录失败告警',?,?,?,? WHERE ? IN ('login_failed','login_locked') AND (SELECT COUNT(*) FROM auth_log WHERE tenant_id=? AND ip=? AND at>? AND event IN ('login_failed','login_locked'))%5=0",
          randomId("pa"),
          t,
          tenantId,
          user || null,
          "同机构同IP一小时内连续累计5次失败，请核对登录",
          info.ip,
          event,
          tenantId,
          info.ip,
          t - 3600000,
        ),
      ]);
    },
    async audit(actor, module, action, id, summary) {
      scoped();
      await auditStmt(actor, module, action, id, summary).run();
    },
    async logs(kind, offset, financeOnly = false, filter = {}, count = false) {
      scoped();
      if (financeOnly && kind === "login") return count ? 0 : [];
      const login = kind === "login";
      const actor = filter.actor || "",
        from = filter.from ?? 0,
        to = filter.to ?? 8640000000000000,
        tail = count
          ? ""
          : login
            ? " ORDER BY a.at DESC, a.id LIMIT 200 OFFSET ?"
            : " ORDER BY at DESC,id LIMIT 200 OFFSET ?",
        args = [tenantId, actor, actor, from, to];
      const columns = login
        ? "a.id,a.at,a.user_id,u.name actor_label,a.phone_last4,a.event,a.ip,a.ua"
        : "id,at,actor_label,module,action,entity_id,summary,before_json,after_json,money_version";
      const where = login
        ? " FROM auth_log a LEFT JOIN users u ON u.tenant_id=a.tenant_id AND u.id=a.user_id WHERE a.tenant_id=? AND (?='' OR instr(lower(COALESCE(u.name,'')),lower(?))>0) AND a.at>=? AND a.at<?"
        : " FROM audit_log WHERE tenant_id=? AND (?='' OR instr(lower(actor_label),lower(?))>0) AND at>=? AND at<? AND (?='' OR module=?) AND (?='' OR action=?)" +
          (financeOnly
            ? " AND module IN ('tuition','teacher_pay','settlements')"
            : "");
      if (!login)
        args.push(
          filter.module || "",
          filter.module || "",
          filter.action || "",
          filter.action || "",
        );
      if (!count) args.push(offset);
      const query = "SELECT " + (count ? "COUNT(*) n" : columns) + where + tail;
      return count ? (await first(query, ...args)).n : all(query, ...args);
    },
    async saveRights(role, module, action, allowed, actor) {
      return this.saveRightsBatch(
        [{ role, module, action, allowed }],
        actor,
        true,
      );
    },
    async saveRightsBatch(changes, actor, legacy = false) {
      scoped();
      const t = now();
      const payload = JSON.stringify(
        changes.map(({ role, module, action, allowed }) => ({
          id: role + ":" + module + ":" + action,
          role,
          module,
          action,
          allowed: allowed ? 1 : 0,
        })),
      );
      await db.batch([
        sql(
          `INSERT INTO tenant_role_rights(tenant_id,id,role,module,action,allowed,created_at,created_by,updated_at,updated_by)
          SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.role'),json_extract(value,'$.module'),
            json_extract(value,'$.action'),json_extract(value,'$.allowed'),?,?,?,?
          FROM json_each(?) WHERE 1
          ON CONFLICT(tenant_id,role,module,action) DO UPDATE SET
            allowed=excluded.allowed,version=version+1,updated_at=excluded.updated_at,updated_by=excluded.updated_by`,
          tenantId,
          t,
          actor.id,
          t,
          actor.id,
          payload,
        ),
        sql("DELETE FROM sessions WHERE tenant_id=?", tenantId),
        auditStmt(
          actor,
          "accounts",
          "rights",
          legacy ? changes[0].role : null,
          legacy
            ? "修改角色权限，机构会话已失效"
            : "修改角色权限 " + changes.length + " 项，机构会话已失效",
        ),
      ]);
    },
    async saveRenewalSettings(settings, actor) {
      scoped();
      const t = now();
      await db.batch([
        ...Object.entries(settings).map(([key, value]) =>
          sql(
            "INSERT INTO tenant_settings(tenant_id,id,value,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,?,?) ON CONFLICT(tenant_id,id) DO UPDATE SET value=excluded.value,version=version+1,updated_at=excluded.updated_at,updated_by=excluded.updated_by",
            tenantId,
            key,
            JSON.stringify(value),
            t,
            actor.id,
            t,
            actor.id,
          ),
        ),
        auditStmt(actor, "packages", "setting", null, "修改续费预警规则"),
      ]);
    },
    async saveSetting(key, value, actor) {
      scoped();
      const t = now();
      await db.batch([
        sql(
          "INSERT INTO tenant_settings(tenant_id,id,value,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,?,?) ON CONFLICT(tenant_id,id) DO UPDATE SET value=excluded.value,version=version+1,updated_at=excluded.updated_at,updated_by=excluded.updated_by",
          tenantId,
          key,
          JSON.stringify(value),
          t,
          actor.id,
          t,
          actor.id,
        ),
        auditStmt(actor, "accounts", "setting", key, "修改机构设置"),
      ]);
    },
    async tenantLoginLimited(phoneKey, ipKey, phoneMax, ipMax, increment = false) {
      const t = now();
      const limits = [
        { key: phoneKey, window: 900000, max: phoneMax },
        { key: ipKey, window: 3600000, max: ipMax },
      ];
      const lookup = sql(`SELECT EXISTS(SELECT 1 FROM security_limits
        WHERE (key=? AND (locked_until>? OR (window_start>? AND count>=?)))
           OR (key=? AND (locked_until>? OR (window_start>? AND count>=?)))) locked`,
        ...limits.flatMap(({ key, window, max }) => [key, t, t - window, max]));
      if (!increment) return !!(await lookup.first()).locked;
      const writes = limits.flatMap(({ key, window, max }) => [
        incrementLimit(key, t, window),
        sql("UPDATE security_limits SET locked_until=? WHERE key=? AND count>=? AND locked_until<=?",
          t + window, key, max, t),
      ]);
      const result = await db.batch([...writes, lookup]);
      return !!result.at(-1).results[0].locked;
    },
    // 全局限流通过原子 UPSERT 累加，不能由浏览器提供 IP。
    async limit(key, windowMs, threshold, lockMs, increment = true) {
      const t = now();
      if (increment)
        await incrementLimit(key, t, windowMs).run();
      let row = await first(
        "SELECT count,locked_until,window_start FROM security_limits WHERE key=?",
        key,
      );
      if (increment && row.count >= threshold && row.locked_until <= t) {
        await sql(
          "UPDATE security_limits SET locked_until=MAX(locked_until,?) WHERE key=?",
          t + lockMs,
          key,
        ).run();
        row.locked_until = Math.max(row.locked_until, t + lockMs);
      }
      return (
        row &&
        (row.locked_until > t ||
          (row.window_start > t - windowMs && row.count >= threshold))
      );
    },
    async clearLimit(key) {
      await sql("DELETE FROM security_limits WHERE key=?", key).run();
    },
    async initialized() {
      platform();
      return !!(await first(
        "SELECT id FROM platform_state WHERE id=?",
        "initialized",
      ));
    },
    async initAdmin(data, ip) {
      platform();
      const result = await db.batch([
        sql(
          "INSERT INTO platform_admins(id,username,salt,digest,totp_enc,last_totp_step,created_at) SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM platform_state WHERE id=?)",
          data.id,
          data.username,
          data.salt,
          data.digest,
          data.totp_enc,
          data.step,
          now(),
          "initialized",
        ),
        sql(
          "INSERT INTO platform_audit(id,at,admin_id,action,detail,ip) SELECT ?,?,?,?,?,? WHERE changes()=1",
          randomId("pa"),
          now(),
          data.id,
          "initialize",
          "首个超管已创建",
          ip,
        ),
      ]);
      if (!result[0].meta.changes) fail(404, "页面不存在");
    },

    async platformAccounts(offset) {
      platform();
      return all(
        "SELECT id,username,role,active,created_at FROM platform_admins ORDER BY created_at,id LIMIT 200 OFFSET ?",
        offset,
      );
    },
    async createConsultant(data, actor, ip) {
      platform();
      const res = await db.batch([
        sql(
          "INSERT INTO platform_admins(id,username,salt,digest,totp_enc,last_totp_step,created_at,role) VALUES(?,?,?,?,?,?,?,'consultant') ON CONFLICT(username) DO NOTHING",
          data.id,
          data.username,
          data.salt,
          data.digest,
          data.totp_enc,
          data.step,
          now(),
        ),
        sql(
          "INSERT INTO platform_audit(id,at,admin_id,action,target,detail,ip) SELECT ?,?,?,?,?,?,? WHERE changes()=1",
          randomId("pa"),
          now(),
          actor,
          "consultant_create",
          data.id,
          "新建主管顾问",
          ip,
        ),
      ]);
      if (!res[0].meta.changes) fail(409, "用户名已存在");
    },
    async setPlatformAccountActive(id, active, actor, ip) {
      platform();
      const res = await db.batch([
        sql(
          "UPDATE platform_admins SET active=? WHERE id=? AND (?=1 OR (id<>? AND (role<>'owner' OR (SELECT COUNT(*) FROM platform_admins WHERE role='owner' AND active=1 AND id<>?)>0)))",
          active,
          id,
          active,
          actor,
          id,
        ),
        sql(
          "INSERT INTO platform_audit(id,at,admin_id,action,target,detail,ip) SELECT ?,?,?,?,?,?,? WHERE changes()=1",
          randomId("pa"),
          now(),
          actor,
          "platform_account_active",
          id,
          active ? "启用控制台账号" : "停用控制台账号",
          ip,
        ),
        sql(
          "DELETE FROM platform_sessions WHERE admin_id=? AND EXISTS(SELECT 1 FROM platform_admins WHERE id=? AND active=0)",
          id,
          id,
        ),
      ]);
      if (!res[0].meta.changes) fail(409, "账号不存在或不能停用");
    },
    async admin(username) {
      platform();
      return first("SELECT * FROM platform_admins WHERE username=?", username);
    },
    async adminSession(hash) {
      platform();
      return first(
        "SELECT s.*,a.username,a.active,a.role FROM platform_sessions s JOIN platform_admins a ON a.id=s.admin_id WHERE s.token_hash=?",
        hash,
      );
    },
    async authenticateAdminRequest(hash) {
      platform();
      const t = now();
      const eligible = `SELECT s.*,a.username,a.active,a.role FROM platform_sessions s
        JOIN platform_admins a ON a.id=s.admin_id WHERE s.token_hash=?1 AND a.active=1
        AND s.expires_at>?2 AND s.last_seen_at+1800000>?2`;
      const args = [hash, t];
      const key = env.__readRequest ? "'console-request-get:'||admin_id" : "'console-request:'||admin_id";
      const max = env.__readRequest ? 240 : 120;
      const rows = await db.batch([
        sql(eligible, ...args),
        sql(
          `INSERT INTO security_limits(key,count,window_start,locked_until)
          SELECT ${key},1,?2,0 FROM (${eligible}) WHERE 1
          ON CONFLICT(key) DO UPDATE SET
            count=CASE WHEN window_start<=?2-60000 AND locked_until<=?2 THEN 1 ELSE count+1 END,
            window_start=CASE WHEN window_start<=?2-60000 AND locked_until<=?2 THEN ?2 ELSE window_start END`,
          ...args,
        ),
        sql(
          `UPDATE security_limits SET locked_until=?2+60000 WHERE count>${max} AND locked_until<=?2
          AND key IN (SELECT ${key} FROM (${eligible}))`,
          ...args,
        ),
        sql(
          `SELECT locked_until,window_start,count FROM security_limits
          WHERE key IN (SELECT ${key} FROM (${eligible}))`,
          ...args,
        ),
        sql(
          `UPDATE platform_sessions SET last_seen_at=?2 WHERE token_hash=?1
          AND last_seen_at<=?2-60000 AND EXISTS(SELECT 1 FROM (${eligible}))`,
          ...args,
        ),
      ]);
      const admin = rows[0].results?.[0];
      if (!admin) return null;
      const limit = rows[3].results[0];
      if (
        limit.locked_until > t ||
        (limit.window_start > t - 60000 && limit.count > max)
      )
        fail(429, "操作太频繁，请稍后再试");
      return admin;
    },
    async newAdminSession(hash, admin, step, info) {
      platform();
      const t = now(),
        result = await db.batch([
          sql(
            "UPDATE platform_admins SET last_totp_step=? WHERE id=? AND last_totp_step<? AND active=1",
            step,
            admin.id,
            step,
          ),
          sql(
            "INSERT INTO platform_sessions(token_hash,admin_id,expires_at,last_seen_at,ip,ua) SELECT ?,?,?,?,?,? WHERE changes()=1",
            hash,
            admin.id,
            t + 28800000,
            t,
            info.ip,
            info.ua,
          ),
        ]);
      if (!result[0].meta.changes) fail(401, "用户名、密码或动态口令不正确");
    },
    async touchAdmin(hash) {
      platform();
      await sql(
        "UPDATE platform_sessions SET last_seen_at=? WHERE token_hash=?",
        now(),
        hash,
      ).run();
    },
    async revokeAdmin(hash) {
      platform();
      await sql("DELETE FROM platform_sessions WHERE token_hash=?", hash).run();
    },
    async platformLog(actor, action, target, detail, ip, reason) {
      platform();
      await platformStmt(actor, action, target, detail, ip, reason).run();
    },
    async platformAlerts(offset) {
      platform();
      return all(
        "SELECT p.id,p.at,p.action,p.detail,p.ip,t.name tenant_name,u.name user_name FROM platform_audit p LEFT JOIN tenants t ON t.id=p.tenant_id LEFT JOIN users u ON u.tenant_id=p.tenant_id AND u.id=p.target WHERE p.action IN ('读取量告警','异地登录告警','登录失败告警','请求限流告警') ORDER BY p.at DESC,p.id LIMIT 200 OFFSET ?",
        offset,
      );
    },
    async platformOperation(id, fingerprint) {
      platform();
      const row = await first("SELECT detail FROM platform_audit WHERE id=?", id);
      if (!row) return null;
      const data = JSON.parse(row.detail);
      if (data.fingerprint !== fingerprint) fail(409, "操作编号已用于其他请求");
      return data.result;
    },
    async lifecycleState(id) {
      platform();
      return first(
        "SELECT t.id,t.name,t.status,t.version,t.disabled_at,t.expires_at,v.version data_version FROM tenants t JOIN tenant_data_versions v ON v.tenant_id=t.id WHERE t.id=? AND t.deleted_at IS NULL",
        id,
      );
    },
    async changeTenantLifecycle(id, row, enable, op, admin, reason) {
      platform();
      const result = { ok: true, status: enable ? "active" : "paused" };
      const at = now();
      const changed = await db.batch([
        sql(
          "UPDATE tenants SET status=?,disabled_at=?,disabled_by=?,disabled_reason=?,version=version+1,updated_at=?,updated_by=? WHERE id=? AND version=? AND NOT EXISTS(SELECT 1 FROM tenant_purge_jobs j WHERE j.tenant_id=tenants.id)",
          result.status, enable ? null : at, enable ? null : admin.id,
          enable ? null : reason, at, admin.id, id, row.version,
        ),
        sql(
          "INSERT INTO platform_audit(id,at,admin_id,action,tenant_id,target,detail,reason,ip) SELECT ?,?,?,?,?,?,?,?,? WHERE changes()=1",
          op.id, at, admin.id, enable ? "enable_tenant" : "disable_tenant",
          id, id, JSON.stringify({ fingerprint: op.fingerprint, tenant_name: row.name, result }), reason, admin.ip,
        ),
        sql("UPDATE maintenance_leases SET revoked=1 WHERE tenant_id=? AND EXISTS(SELECT 1 FROM platform_audit WHERE id=?)", id, op.id),
      ]);
      if (!changed[0].meta.changes) {
        const replay = await this.platformOperation(op.id, op.fingerprint);
        if (replay) return replay;
        fail(409, "机构状态已变化，请刷新");
      }
      return result;
    },
    async startExportRun(id, admin) {
      platform();
      const run = randomId("export");
      const out = await sql(
        `INSERT INTO tenant_export_runs(tenant_id,id,admin_id,tenant_version,data_version)
         SELECT t.id,?,?,t.version,v.version FROM tenants t JOIN tenant_data_versions v ON v.tenant_id=t.id
         WHERE t.id=? AND t.status='paused' AND t.disabled_at IS NOT NULL AND t.deleted_at IS NULL
         AND NOT EXISTS(SELECT 1 FROM tenant_purge_jobs j WHERE j.tenant_id=t.id)
         ON CONFLICT(tenant_id) DO UPDATE SET id=excluded.id,admin_id=excluded.admin_id,
         tenant_version=excluded.tenant_version,data_version=excluded.data_version,table_index=0,next_offset=0,completed_at=NULL`,
        run, admin, id,
      ).run();
      if (!out.meta.changes) fail(409, "请先停用机构");
      return run;
    },
    async exportRun(id, run, admin) {
      platform();
      return first(
        `SELECT e.* FROM tenant_export_runs e JOIN tenants t ON t.id=e.tenant_id AND t.version=e.tenant_version
         JOIN tenant_data_versions v ON v.tenant_id=t.id AND v.version=e.data_version
         WHERE e.tenant_id=? AND e.id=? AND e.admin_id=? AND t.status='paused'
         AND NOT EXISTS(SELECT 1 FROM tenant_purge_jobs j WHERE j.tenant_id=t.id)`,
        id, run, admin,
      );
    },
    async advanceExport(run, index, offset, completed) {
      platform();
      const at = now();
      const update = sql(
        `UPDATE tenant_export_runs SET table_index=?,next_offset=?,completed_at=?
         WHERE id=? AND table_index=? AND next_offset=? AND completed_at IS NULL
           AND EXISTS(SELECT 1 FROM tenants t JOIN tenant_data_versions v ON v.tenant_id=t.id
             WHERE t.id=tenant_export_runs.tenant_id AND t.version=tenant_version AND v.version=data_version)`,
        index, offset, completed ? at : null, run.id, run.table_index, run.next_offset,
      );
      const out = completed ? (await db.batch([
        update,
        sql("INSERT INTO platform_audit(id,at,admin_id,action,tenant_id,target,detail,ip) SELECT ?,?,?,'tenant_export_complete',?,?,?,'' WHERE changes()=1",
          randomId("pa"), at, run.admin_id, run.tenant_id, run.id, "完成机构完整加密导出"),
      ]))[0] : await update.run();
      if (!out.meta.changes) fail(409, "导出进度或机构数据已变化，请刷新");
    },
    async purgeJob(id) {
      platform();
      return first("SELECT * FROM tenant_purge_jobs WHERE tenant_id=?", id);
    },
    async purgeReceipt(id) {
      platform();
      const row = await first(
        "SELECT detail FROM platform_audit WHERE tenant_id=? AND action='purge_tenant' ORDER BY at DESC LIMIT 1", id,
      );
      return row ? JSON.parse(row.detail) : null;
    },
    async hasFreshExport(id) {
      platform();
      return !!await first(
        `SELECT 1 FROM tenant_export_runs e JOIN tenants t ON t.id=e.tenant_id AND t.version=e.tenant_version
         JOIN tenant_data_versions v ON v.tenant_id=t.id AND v.version=e.data_version
         WHERE e.tenant_id=? AND e.completed_at>=?`, id, now()-86400000,
      );
    },
    async ownerTotp(id) {
      platform();
      return first("SELECT totp_enc,last_totp_step FROM platform_admins WHERE id=? AND role='owner' AND active=1", id);
    },
    async startPurge(id, row, admin, op, reason, step, cutoff) {
      platform();
      const t = now(), guard = randomId("guard");
      try {
        await db.batch([
          sql(
            `INSERT INTO tenant_purge_jobs(tenant_id,id,admin_id,tenant_name,reason,fingerprint,ip,created_at,phase)
             SELECT t.id,?,?,t.name,?,?,?,?,0 FROM tenants t JOIN tenant_export_runs e ON e.tenant_id=t.id
             JOIN tenant_data_versions v ON v.tenant_id=t.id
             WHERE t.id=? AND t.version=? AND t.status='paused' AND t.disabled_at IS NOT NULL AND t.disabled_at<=?
             AND e.tenant_version=t.version AND e.data_version=v.version AND e.completed_at>=?`,
            op.id, admin.id, reason, op.fingerprint, admin.ip, t, id, row.version, cutoff, t-86400000,
          ),
          sql("INSERT INTO mutation_guards(tenant_id,id,expected,actual) VALUES('platform',?,1,changes())", guard),
          sql(
            "UPDATE platform_admins SET last_totp_step=? WHERE id=? AND active=1 AND role='owner' AND last_totp_step<?",
            step, admin.id, step,
          ),
          sql("INSERT INTO mutation_guards(tenant_id,id,expected,actual) VALUES('platform',?,1,changes())", guard+"t"),
          sql("UPDATE tenant_data_versions SET version=version+1 WHERE tenant_id=?", id),
          sql("DELETE FROM mutation_guards WHERE tenant_id='platform' AND id IN (?,?)", guard, guard+"t"),
        ]);
      } catch (error) {
        if (!/CHECK constraint|UNIQUE constraint/i.test(String(error.message))) throw error;
        const job = await this.purgeJob(id);
        if (job?.id === op.id && job.fingerprint === op.fingerprint) return job;
        fail(409, "机构、导出凭证或动态口令已变化，请重新检查");
      }
      return this.purgeJob(id);
    },
    async purgeTableStep(job) {
      platform();
      const table = PURGE_TABLES[job.phase];
      if (!table) fail(409, "删除作业阶段不正确");
      const id = job.tenant_id, guard = randomId("guard");
      const { where, values } = purgeFilter(table, id);
      const protectedTable = ["package_transactions", "payroll_snapshots", "lessons", "lesson_participants"].includes(table);
      const ops = [
        sql("INSERT INTO mutation_guards(tenant_id,id,expected,actual) VALUES('platform',?,1,(SELECT COUNT(*) FROM tenant_purge_jobs WHERE tenant_id=? AND id=? AND phase=?))", guard, id, job.id, job.phase),
      ];
      if (protectedTable) ops.push(sql("INSERT INTO trusted_imports(tenant_id,id) VALUES(?,?)", id, guard));
      ops.push(
        sql(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT 200)`, ...values),
        sql(
          `UPDATE tenant_purge_jobs SET phase=phase+CASE WHEN changes()<200 THEN 1 ELSE 0 END,
           counts=json_set(counts,?,COALESCE(json_extract(counts,?),0)+changes()) WHERE tenant_id=? AND id=?`,
          "$."+table, "$."+table, id, job.id,
        ),
      );
      if (protectedTable) ops.push(sql("DELETE FROM trusted_imports WHERE tenant_id=? AND id=?", id, guard));
      ops.push(sql("DELETE FROM mutation_guards WHERE tenant_id='platform' AND id=?", guard));
      try {
        await db.batch(ops);
      } catch (error) {
        if (!String(error.message).includes("CHECK constraint")) throw error;
        const current = await this.purgeJob(id);
        if (current?.id === job.id && current.phase !== job.phase) return current;
        fail(409, "删除进度已变化，请刷新");
      }
      return this.purgeJob(id);
    },
    async finishPurge(job) {
      platform();
      const id = job.tenant_id, guard = randomId("guard");
      const filters = PURGE_TABLES.map((table) => ({ table, ...purgeFilter(table, id) }));
      const conditions = filters.map(({ table, where }) => `EXISTS(SELECT 1 FROM ${table} WHERE ${where})`);
      const exportCount = (await first("SELECT COUNT(*) n FROM tenant_export_runs WHERE tenant_id=?", id)).n;
      const result = {
        id: job.id, status: "completed", tenant_name: job.tenant_name,
        completed_at: now(), counts: { ...JSON.parse(job.counts), tenant_export_runs: exportCount, tenant_purge_jobs: 1, tenants: 1 },
      };
      const detail = { fingerprint: job.fingerprint, result };
      // Rewind if a previously admitted writer added a row after its table was swept.
      const newRows = await db.batch(filters.map(({ table, where, values }) =>
        sql(`SELECT 1 FROM ${table} WHERE ${where} LIMIT 1`, ...values),
      ));
      const dirty = newRows.findIndex((x) => x.results.length);
      if (dirty >= 0) {
        await sql("UPDATE tenant_purge_jobs SET phase=? WHERE id=? AND phase=?", dirty, job.id, PURGE_TABLES.length).run();
        return null;
      }
      try {
        await db.batch([
          // The final atomic check also covers writers between the scan and this transaction.
          ...filters.map(({ table, where, values }, n) =>
            sql(`INSERT INTO mutation_guards(tenant_id,id,expected,actual) VALUES('platform',?,0,${conditions[n]})`, guard+n, ...values),
          ),
          sql("INSERT INTO mutation_guards(tenant_id,id,expected,actual) VALUES('platform',?,1,(SELECT COUNT(*) FROM tenant_purge_jobs WHERE tenant_id=? AND id=? AND phase=?))", guard, id, job.id, PURGE_TABLES.length),
          sql("DELETE FROM tenant_export_runs WHERE tenant_id=?", id),
          sql("DELETE FROM tenant_purge_jobs WHERE tenant_id=?", id),
          sql("DELETE FROM tenants WHERE id=? AND status='paused'", id),
          sql("INSERT INTO platform_audit(id,at,admin_id,action,tenant_id,target,detail,reason,ip) VALUES(?,?,?,?,?,?,?,?,?)",
            job.id, result.completed_at, job.admin_id, "purge_tenant", id, id, JSON.stringify(detail), job.reason, job.ip),
          sql("DELETE FROM mutation_guards WHERE tenant_id='platform' AND substr(id,1,?)=?", guard.length, guard),
        ]);
      } catch (error) {
        if (!String(error.message).includes("CHECK constraint")) throw error;
        return (await this.purgeReceipt(id))?.result || null;
      }
      return result;
    },
    async platformLogs(offset) {
      platform();
      return all(
        "SELECT p.*,CASE WHEN p.action='purge_tenant' THEN json_extract(p.detail,'$.result.tenant_name') ELSE t.name END tenant_name FROM platform_audit p LEFT JOIN tenants t ON t.id=p.tenant_id ORDER BY p.at DESC,p.id LIMIT 200 OFFSET ?",
        offset,
      );
    },
    async listTenants(offset) {
      platform();
      return all(
        "SELECT id,slug,name,type,city,status,expires_at,staff_seat_limit,student_seat_limit,version,disabled_at,disabled_by,disabled_reason FROM tenants WHERE deleted_at IS NULL ORDER BY created_at DESC,id LIMIT 200 OFFSET ?",
        offset,
      );
    },
    async createTenant(data, actor, modules) {
      platform();
      const t = now();
      const statements = [
        sql(
          "INSERT INTO tenants(id,slug,name,type,city,status,expires_at,staff_seat_limit,student_seat_limit,contact_enc,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          data.id,
          data.slug,
          data.name,
          data.type,
          data.city,
          "active",
          data.expires_at,
          data.staff_seat_limit,
          data.student_seat_limit,
          data.contact_enc,
          t,
          actor,
          t,
          actor,
        ),
        sql(
          "INSERT INTO tenant_branding(tenant_id,id,display_name,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,?,?)",
          data.id,
          "brand",
          data.name,
          t,
          actor,
          t,
          actor,
        ),
        ...modules.map((m) =>
          sql(
            "INSERT INTO tenant_modules(tenant_id,id,enabled,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,?,?)",
            data.id,
            m,
            m === "school_db" ? 0 : 1,
            t,
            actor,
            t,
            actor,
          ),
        ),
        platformStmt(actor, "create_tenant", data.id, "开通机构"),
      ];
      await db.batch(statements);
    },
    async slugTaken(slug, except = "") {
      platform();
      return !!(await first(
        "SELECT id FROM tenants WHERE slug=? AND id<>? UNION ALL SELECT tenant_id AS id FROM tenant_slug_aliases WHERE slug=? AND expires_at>? LIMIT 1",
        slug,
        except,
        slug,
        now(),
      ));
    },
    async updateTenant(id, v, data, actor) {
      platform();
      const t = now();
      const result = await db.batch([
        sql(
          "UPDATE tenants SET slug=?,name=?,type=?,city=?,status=?,expires_at=?,staff_seat_limit=?,student_seat_limit=?,version=version+1,updated_at=?,updated_by=? WHERE id=? AND version=? AND deleted_at IS NULL",
          data.slug,
          data.name,
          data.type,
          data.city,
          data.status,
          data.expires_at,
          data.staff_seat_limit,
          data.student_seat_limit,
          t,
          actor,
          id,
          v,
        ),
        sql(
          "INSERT INTO platform_audit(id,at,admin_id,action,tenant_id,target,detail,ip) SELECT ?,?,?,?,?,?,?,? WHERE changes()=1",
          randomId("pa"),
          t,
          actor,
          "update_tenant",
          id,
          id,
          "修改机构、路径或账号上限",
          "",
        ),
      ]);
      if (!result[0].meta.changes) await conflict(id);
    },
    async saveBrand(id, v, b, actor) {
      platform();
      storedRecord(b, "机构品牌");
      const result = await db.batch([
        sql(
          "UPDATE tenant_branding SET display_name=?,logo=?,login_bg=?,theme_color=?,welcome_text=?,consultant_qr=?,contact_text=?,version=version+1,updated_at=?,updated_by=? WHERE tenant_id=? AND id=? AND version=?",
          b.display_name,
          b.logo,
          b.login_bg,
          b.theme_color,
          b.welcome_text,
          b.consultant_qr ?? null,
          b.contact_text ?? "",
          now(),
          actor,
          id,
          "brand",
          v,
        ),
        sql(
          "INSERT INTO platform_audit(id,at,admin_id,action,tenant_id,target,detail,ip) SELECT ?,?,?,?,?,?,?,? WHERE changes()=1",
          randomId("pa"),
          now(),
          actor,
          "brand",
          id,
          id,
          "更新品牌",
          "",
        ),
      ]);
      if (!result[0].meta.changes) await conflict(id);
    },
    async module(id, module, enabled, actor) {
      platform();
      await db.batch([
        sql(
          "UPDATE tenant_modules SET enabled=?,version=version+1,updated_at=?,updated_by=? WHERE tenant_id=? AND id=?",
          enabled ? 1 : 0,
          now(),
          actor,
          id,
          module,
        ),
        platformStmt(actor, "module", id, module + ":" + enabled),
      ]);
    },
    async identitySessionOwner(hash, kind = null) {
      platform();
      return first("SELECT tenant_id,kind FROM sessions WHERE token_hash=? AND (? IS NULL OR kind=?)", hash, kind, kind);
    },
    async identityCandidates(index) {
      platform();
      return all(`SELECT u.*,t.name tenant_name,t.slug,t.version tenant_version,b.logo,
        (SELECT COUNT(*) FROM platform_phone_index WHERE phone_hmac_platform=?) candidate_count
        FROM platform_phone_index p JOIN users u ON u.tenant_id=p.tenant_id AND u.id=p.user_id
        JOIN tenants t ON t.id=u.tenant_id LEFT JOIN tenant_branding b ON b.tenant_id=t.id AND b.id='brand'
        WHERE p.phone_hmac_platform=? AND u.active=1 AND u.deleted_at IS NULL AND t.deleted_at IS NULL AND t.status='active'
        ORDER BY COALESCE((SELECT MAX(at) FROM auth_log WHERE tenant_id=u.tenant_id AND user_id=u.id AND event='login_success'),(SELECT MAX(created_at) FROM sessions WHERE tenant_id=u.tenant_id AND user_id=u.id),0) DESC,u.tenant_id,u.id LIMIT 5`, index, index);
    },
    async identityChoices(matches, group, until) {
      platform();
      await db.batch(matches.map(m => sql(`INSERT INTO login_choices(tenant_id,id,token_hash,user_id,user_version,tenant_version,group_id,expires_at,created_at)
        SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM users u JOIN tenants t ON t.id=u.tenant_id
        WHERE u.tenant_id=? AND u.id=? AND u.version=? AND u.digest=? AND u.active=1 AND t.version=? AND t.status='active')`,
        m.tenant_id,randomId('lc'),m.choice_hash,m.id,m.version,m.tenant_version,group,until,now(),m.tenant_id,m.id,m.version,m.digest,m.tenant_version)));
    },
    async identityChoice(hash) {
      platform();
      return first(`SELECT c.*,u.name,u.phone_last4,u.roles,u.must_change,u.active,u.version,u.digest
        FROM login_choices c JOIN users u ON u.tenant_id=c.tenant_id AND u.id=c.user_id
        WHERE c.token_hash=? AND c.expires_at>?`, hash, now());
    },
    async identityConsumeChoice(hash, sessionHash, info) {
      platform();
      const at=now(), id=randomId('ses');
      const results=await db.batch([
        sql(`INSERT INTO sessions(tenant_id,id,token_hash,user_id,expires_at,last_seen_at,idle_ms,ip,ua,created_at,created_by,updated_at,updated_by,kind)
          SELECT c.tenant_id,?,?,c.user_id,?,?,7200000,?,?,?,c.user_id,?,c.user_id,'root'
          FROM login_choices c JOIN users u ON u.tenant_id=c.tenant_id AND u.id=c.user_id JOIN tenants t ON t.id=c.tenant_id
          WHERE c.token_hash=? AND c.expires_at>? AND u.version=c.user_version AND t.version=c.tenant_version
          AND u.active=1 AND u.deleted_at IS NULL AND t.status='active' AND t.deleted_at IS NULL
          AND (t.expires_at IS NULL OR unixepoch(t.expires_at||'T23:59:59+08:00')*1000>?)`,
          id,sessionHash,at+43200000,at,info.ip,info.ua,at,at,hash,at,at),
        sql(`DELETE FROM login_choices WHERE group_id=(SELECT group_id FROM login_choices WHERE token_hash=?)
          AND EXISTS(SELECT 1 FROM sessions WHERE id=? AND token_hash=?)`,hash,id,sessionHash),
      ]);
      if(!results[0].meta.changes) fail(401,'机构选择已过期，请重新登录','unauthenticated');
    },
    async identityChildren(parent) {
      scoped();
      return all(`SELECT s.id,s.name,s.nickname,s.grade,s.direction,g.relation FROM guardian_links g
        JOIN students s ON s.tenant_id=g.tenant_id AND s.id=g.student_id
        JOIN users u ON u.tenant_id=g.tenant_id AND u.id=g.parent_user_id
        WHERE g.tenant_id=? AND g.parent_user_id=? AND g.revoked_at IS NULL AND s.deleted_at IS NULL
        AND u.active=1 AND u.deleted_at IS NULL ORDER BY s.name,s.id`,tenantId,parent);
    },
    async identityGuardians(student) {
      scoped();
      return all(`SELECT g.id,g.student_id,g.parent_user_id,g.relation,g.version,u.name,u.phone_last4,u.active,u.disabled_reason
        FROM guardian_links g JOIN users u ON u.tenant_id=g.tenant_id AND u.id=g.parent_user_id
        WHERE g.tenant_id=? AND g.student_id=? AND g.revoked_at IS NULL AND u.deleted_at IS NULL ORDER BY g.created_at,g.id`,tenantId,student);
    },
    async identityGuardian(student,id) {
      scoped();
      return first('SELECT * FROM guardian_links WHERE tenant_id=? AND student_id=? AND id=? AND revoked_at IS NULL',tenantId,student,id);
    },
    async identityBindGuardian(student,parent,relation,actor,newUser=null) {
      scoped();
      const at=now(),link=randomId('gdn'),ops=[];
      ops.push(sql(`INSERT INTO mutation_guards(tenant_id,id,expected,actual) VALUES(?,?,1,
        CASE WHEN EXISTS(SELECT 1 FROM students WHERE tenant_id=? AND id=? AND deleted_at IS NULL) THEN 1 ELSE 0 END)`,tenantId,randomId('guard'),tenantId,student));
      if(newUser) {
        ops.push(sql(`INSERT INTO users(tenant_id,id,phone_hmac,phone_enc,phone_last4,name,roles,salt,digest,must_change,active,created_at,created_by,updated_at,updated_by)
          VALUES(?,?,?,?,?,?,'["parent"]',?,?,1,1,?,?,?,?)`,tenantId,parent.id,newUser.phone_hmac,newUser.phone_enc,newUser.phone_last4,newUser.name,newUser.salt,newUser.digest,at,actor.id,at,actor.id));
      } else {
        ops.push(sql(`INSERT INTO mutation_guards(tenant_id,id,expected,actual)
          SELECT ?,?,?,COALESCE((SELECT version FROM users WHERE tenant_id=? AND id=? AND deleted_at IS NULL AND roles='["parent"]' AND (active=1 OR disabled_reason='no_children')),-1)`,tenantId,randomId('guard'),parent.version,tenantId,parent.id));
        ops.push(sql(`UPDATE users SET active=1,disabled_reason=NULL,version=version+1,updated_at=?,updated_by=?
          WHERE tenant_id=? AND id=? AND active=0 AND disabled_reason='no_children'`,at,actor.id,tenantId,parent.id));
      }
      ops.push(sql('INSERT INTO guardian_links(tenant_id,id,parent_user_id,student_id,relation,created_by,created_at,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',tenantId,link,parent.id,student,relation,actor.id,at,actor.id,at));
      ops.push(auditStmt(actor,'parents','bind',link,'绑定家长与学员'));
      await db.batch(ops);
      return this.identityGuardian(student,link);
    },
    async identityChangeGuardian(old,relation,revoke,v,actor) {
      scoped();
      const at=now();
      const result=await db.batch([
        sql('UPDATE guardian_links SET relation=?,revoked_at=?,version=version+1,updated_at=?,updated_by=? WHERE tenant_id=? AND id=? AND student_id=? AND version=? AND revoked_at IS NULL',relation,revoke?at:null,at,actor.id,tenantId,old.id,old.student_id,v),
        sql('INSERT INTO audit_log(tenant_id,id,at,actor_id,actor_label,module,action,entity_id,summary) SELECT ?,?,?,?,?,?,?,?,? WHERE changes()=1',tenantId,randomId('aud'),at,actor.id,actor.name,'parents',revoke?'unbind':'update',old.id,revoke?'解绑家长与学员':'修改家长关系'),
      ]);
      if(!result[0].meta.changes) {
        fail(409,'家长绑定已被修改，请刷新','version_conflict');
      }
    },
    async identityDisableParent(user,actor) {
      scoped();
      const result=await db.batch([
        sql(`UPDATE users SET active=0,disabled_reason='manual',version=version+1,updated_at=?,updated_by=? WHERE tenant_id=? AND id=? AND roles='["parent"]' AND version=? AND deleted_at IS NULL`,now(),actor.id,tenantId,user.id,user.version),
        auditStmt(actor,'parents','disable',user.id,'手动停用家长账号'),
      ]);
      if(!result[0].meta.changes) await conflict(user.id);
    },
    async identityPublicBrand(slug) {
      platform();
      return first(`SELECT t.id,t.status,t.expires_at,b.display_name name,b.logo logo_url,b.login_bg login_bg_url,b.theme_color primary_color
        FROM tenants t JOIN tenant_branding b ON b.tenant_id=t.id AND b.id='brand' WHERE t.slug=? AND t.deleted_at IS NULL`,slug);
    },
    async identityIndexRows(offset,limit=100) {
      platform();
      return all('SELECT tenant_id,id,phone_enc,version FROM users WHERE deleted_at IS NULL ORDER BY tenant_id,id LIMIT ? OFFSET ?',limit,offset);
    },
    async identityIndexPage(rows,admin) {
      platform();
      const writes=[];
      for(const row of rows) {
        writes.push(sql(`INSERT INTO mutation_guards(tenant_id,id,expected,actual) VALUES(?,?,?,COALESCE((SELECT version FROM users WHERE tenant_id=? AND id=?),-1))`,row.tenant_id,randomId('guard'),row.version,row.tenant_id,row.id));
        writes.push(sql('UPDATE users SET platform_phone_hmac=? WHERE tenant_id=? AND id=? AND version=?',row.hash,row.tenant_id,row.id,row.version));
      }
      if(writes.length) await db.batch(writes);
    },
    async identityIndexFinish(admin) {
      platform();
      await db.batch([
        sql(`DELETE FROM platform_phone_index WHERE NOT EXISTS(SELECT 1 FROM users u JOIN tenants t ON t.id=u.tenant_id
          WHERE u.tenant_id=platform_phone_index.tenant_id AND u.id=platform_phone_index.user_id AND u.active=1 AND u.deleted_at IS NULL
          AND t.status='active' AND t.deleted_at IS NULL AND u.platform_phone_hmac=platform_phone_index.phone_hmac_platform
          AND EXISTS(SELECT 1 FROM json_each(u.roles) WHERE value IN ('supervisor','consultant','academic','finance')))`),
        platformStmt(admin,'rebuild_phone_index',null,'重建平台手机号索引'),
      ]);
    },
    async identityOpsTenants(offset,limit) {
      platform();
      const result=await db.batch([
        sql('SELECT id FROM tenants WHERE deleted_at IS NULL ORDER BY created_at DESC,id LIMIT ? OFFSET ?',limit,offset),
        sql('SELECT COUNT(*) n FROM tenants WHERE deleted_at IS NULL'),
      ]);
      return {ids:result[0].results.map(r=>r.id),total:result[1].results[0].n};
    },
    async identityOpsConfig() {
      scoped();
      const data=await db.batch([
        sql('SELECT * FROM tenants WHERE id=? AND deleted_at IS NULL',tenantId),
        sql('SELECT display_name,logo,login_bg,theme_color,version FROM tenant_branding WHERE tenant_id=? AND id=?',tenantId,'brand'),
        sql('SELECT id,enabled,version FROM tenant_modules WHERE tenant_id=? AND deleted_at IS NULL',tenantId),
        sql('SELECT id,pack_version FROM tenant_subjects WHERE tenant_id=?',tenantId),
        sql('SELECT fast_daily_limit,deep_daily_limit FROM tenant_ai_overrides WHERE tenant_id=?',tenantId),
      ]);
      if(!data[0].results.length) return null;
      return {tenant:data[0].results[0],brand:data[1].results[0],modules:data[2].results,subjects:data[3].results,ai_override:data[4].results[0]||null};
    },
    async identityOpsSave(data,old,actor,moduleIds) {
      platform();
      const at=now(),id=data.id,ops=[];
      if(old) {
        ops.push(sql('INSERT INTO mutation_guards(tenant_id,id,expected,actual) VALUES(?,?,?,COALESCE((SELECT version FROM tenants WHERE id=? AND deleted_at IS NULL),-1))',id,randomId('guard'),data.version,id));
        ops.push(sql(`UPDATE tenants SET slug=?,name=?,expires_at=?,staff_seat_limit=?,version=version+1,updated_at=?,updated_by=? WHERE id=? AND deleted_at IS NULL`,data.slug,data.name,data.expires_at,data.staff_seat_limit,at,actor.id,id));
      } else {
        ops.push(sql(`INSERT INTO tenants(id,slug,name,status,expires_at,staff_seat_limit,student_seat_limit,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,'active',?,?,100000,?,?,?,?)`,id,data.slug,data.name,data.expires_at,data.staff_seat_limit,at,actor.id,at,actor.id));
        ops.push(sql(`INSERT INTO tenant_branding(tenant_id,id,display_name,created_at,created_by,updated_at,updated_by) VALUES(?,'brand',?,?,?,?,?)`,id,data.name,at,actor.id,at,actor.id));
        ops.push(sql(`INSERT INTO tenant_modules(tenant_id,id,enabled,created_at,created_by,updated_at,updated_by) SELECT ?,value,CASE WHEN value='school_db' THEN 0 ELSE 1 END,?,?,?,? FROM json_each(?)`,id,at,actor.id,at,actor.id,JSON.stringify(moduleIds)));
      }
      ops.push(sql('UPDATE tenant_branding SET display_name=?,logo=?,login_bg=?,theme_color=?,version=version+1,updated_at=?,updated_by=? WHERE tenant_id=? AND id=?',data.name,data.logo,data.login_bg,data.primary_color,at,actor.id,id,'brand'));
      if(data.modules) ops.push(sql(`UPDATE tenant_modules SET enabled=CAST(json_extract(?, '$.'||id) AS INTEGER),version=version+1,updated_at=?,updated_by=? WHERE tenant_id=? AND id IN(SELECT key FROM json_each(?))`,JSON.stringify(data.modules),at,actor.id,id,JSON.stringify(data.modules)));
      if(data.subjects) {
        ops.push(sql('DELETE FROM tenant_subjects WHERE tenant_id=? AND id NOT IN(SELECT value FROM json_each(?))',id,JSON.stringify(data.subjects)));
        ops.push(sql(`INSERT INTO tenant_subjects(tenant_id,id,created_at,created_by) SELECT ?,value,?,? FROM json_each(?) WHERE 1 ON CONFLICT(tenant_id,id) DO NOTHING`,id,at,actor.id,JSON.stringify(data.subjects)));
      }
      if(data.ai_override) ops.push(sql(`INSERT INTO tenant_ai_overrides(tenant_id,id,fast_daily_limit,deep_daily_limit) VALUES(?,'limits',?,?) ON CONFLICT(tenant_id,id) DO UPDATE SET fast_daily_limit=excluded.fast_daily_limit,deep_daily_limit=excluded.deep_daily_limit`,id,data.ai_override.fast_daily_limit,data.ai_override.deep_daily_limit));
      if(data.status !== undefined) ops.push(sql(`UPDATE tenants SET status=?,disabled_at=CASE WHEN ?='active' THEN NULL ELSE COALESCE(disabled_at,?) END,
        disabled_by=CASE WHEN ?='active' THEN NULL ELSE ? END,disabled_reason=CASE WHEN ?='active' THEN NULL ELSE '机构管理停用' END
        WHERE id=?`,data.status,data.status,at,data.status,actor.id,data.status,id));
      if(data.subjects) ops.push(...await subjectOps(data.subjects,actor,id));
      ops.push(platformStmt(actor.id,old?'update_tenant':'create_tenant',id,'机构管理配置（不含密钥或明文手机号）'));
      await db.batch(ops);
    },
    async identityRevokeSessions(actor,reason) {
      scoped();
      await db.batch([sql('DELETE FROM sessions WHERE tenant_id=?',tenantId),sql('DELETE FROM login_choices WHERE tenant_id=?',tenantId),auditStmt(actor,'accounts','revoke_sessions',tenantId,reason)]);
    },
    async identityLeadExists(id) {
      scoped();
      return !!await first("SELECT id FROM leads WHERE tenant_id=? AND id=? AND deleted_at IS NULL",tenantId,id);
    },
    async identityGuardedChildCount(parent) {
      scoped();
      return (await first("SELECT COUNT(*) n FROM guardian_links WHERE tenant_id=? AND parent_user_id=? AND revoked_at IS NULL",tenantId,parent)).n;
    },
    async identityOpsPage(ids) {
      platform();
      const payload=JSON.stringify(ids);
      const data=await db.batch([
        sql("SELECT * FROM tenants WHERE id IN(SELECT value FROM json_each(?)) AND deleted_at IS NULL",payload),
        sql("SELECT * FROM tenant_branding WHERE tenant_id IN(SELECT value FROM json_each(?)) AND id='brand'",payload),
        sql("SELECT * FROM tenant_modules WHERE tenant_id IN(SELECT value FROM json_each(?)) AND deleted_at IS NULL",payload),
        sql("SELECT * FROM tenant_subjects WHERE tenant_id IN(SELECT value FROM json_each(?))",payload),
        sql("SELECT * FROM tenant_ai_overrides WHERE tenant_id IN(SELECT value FROM json_each(?))",payload),
      ]);
      return ids.map(id=>({tenant:data[0].results.find(r=>r.id===id),brand:data[1].results.find(r=>r.tenant_id===id),modules:data[2].results.filter(r=>r.tenant_id===id),subjects:data[3].results.filter(r=>r.tenant_id===id),ai_override:data[4].results.find(r=>r.tenant_id===id)||null}));
    },
  };
}

function platformRepo(db, tenantId) {
    const sql = (q, ...p) => db.prepare(q).bind(...p), first = (q, ...p) => sql(q, ...p).first(), all = async (q, ...p) => (await sql(q, ...p).all()).results || [];
    const platform = () => {
        if (tenantId) throw Error("platform scope required");
    }, scoped = () => {
        if (!tenantId) throw Error("tenant scope required");
    };
    let exists;
    const available = async () => exists ?? (exists = !!await first("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='subject_packs'"));
    const audit = (a, action, detail) => sql("INSERT INTO platform_audit(id,at,admin_id,action,detail,ip) VALUES(?,?,?,?,?,'')", randomId("pa"), now(), a.id, action, JSON.stringify(detail));
    const guard = (query, args, expected) => {
        const id = randomId("pg");
        return [ sql("INSERT INTO platform_ops_guards(id,expected,actual) VALUES(?,?,COALESCE((" + query + "),-1))", id, expected, ...args), id ];
    };
    const end = id => sql("DELETE FROM platform_ops_guards WHERE id=?", id);
    const subjectRow = (k, v) => first("SELECT p.name,v.* FROM subject_pack_versions v JOIN subject_packs p ON p.key=v.key WHERE v.key=? AND v.pack_version=?", k, v);
    const visible = `COALESCE(m.status,'published')='published' AND (m.scope='all' AND p.scope_all=1 OR m.scope IS NULL AND p.scope_all=1 OR EXISTS(SELECT 1 FROM style_version_tenants s WHERE s.tenant_id=?1 AND s.pack_id=p.id AND s.pack_version=v.version) OR m.scope IS NULL AND EXISTS(SELECT 1 FROM style_pack_scopes s WHERE s.tenant_id=?1 AND s.pack_id=p.id))`;
    const owned = "0";
    return {
        available: available,
        async subjects() {
            platform();
            const rows = await all("SELECT p.name pack_name,p.current_published_version,v.* FROM subject_packs p JOIN subject_pack_versions v ON v.key=p.key ORDER BY p.key,v.created_at,v.pack_version");
            return rows;
        },
        async subject(k, v) {
            platform();
            return subjectRow(k, v);
        },
        async saveSubject(d, old, a, publish = false) {
            platform();
            storedRecord(d.content, "学科模板");
            const at = now(), ops = [];

            let g;
            if (old) {
                const pair = guard("SELECT version FROM subject_pack_versions WHERE key=? AND pack_version=? AND status='draft'", [ d.key, d.pack_version ], old.version);
                g = pair[1];
                ops.push(pair[0]);
                ops.push(sql("UPDATE subject_pack_versions SET name=?,content_json=?,version=version+1,status=?,updated_at=?,updated_by=?,published_at=? WHERE key=? AND pack_version=?", d.name, JSON.stringify(d.content), publish ? "published" : "draft", at, a.id, publish ? at : null, d.key, d.pack_version));
            } else {
                ops.push(sql("INSERT INTO subject_pack_versions(key,pack_version,name,status,content_json,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,'draft',?,?,?,?,?)", d.key, d.pack_version, d.name, JSON.stringify(d.content), at, a.id, at, a.id));
            }
            if (publish) ops.push(sql("UPDATE subject_packs SET name=?,current_published_version=? WHERE key=?", d.name, d.pack_version, d.key));
            ops.push(audit(a, publish ? "publish_subject" : "save_subject", {
                key: d.key,
                pack_version: d.pack_version
            }));
            if (g) ops.push(end(g));
            await db.batch(ops);
            return subjectRow(d.key, d.pack_version);
        },
        async styleRows(id = null) {
            platform();
            return all("SELECT p.id,p.name,p.active,p.current_version,v.version pack_version,v.manifest_json,m.version,m.status,m.scope,m.checks_json,m.published_at FROM style_packs p JOIN style_pack_versions v ON v.pack_id=p.id LEFT JOIN style_version_meta m ON m.pack_id=v.pack_id AND m.pack_version=v.version WHERE (? IS NULL OR p.id=?) ORDER BY p.id,v.created_at,v.version", id, id);
        },
        async styleTenants(id) {
            platform();
            return all("SELECT tenant_id AS id,pack_version FROM style_version_tenants WHERE pack_id=? ORDER BY tenant_id", id);
        },
        async styleUsage(id) { platform(); return 0; },
        async style(id, v) {
            platform();
            return first("SELECT p.id,p.name,p.active,v.version pack_version,v.manifest_json,m.version,m.status,m.scope,m.checks_json FROM style_packs p JOIN style_pack_versions v ON v.pack_id=p.id LEFT JOIN style_version_meta m ON m.pack_id=v.pack_id AND m.pack_version=v.version WHERE p.id=? AND v.version=?", id, v);
        },
        async styleUpload(data, assets, a) {
            platform();
            const m = data.manifest, at = now(), ops = [ sql("INSERT INTO style_packs(id,name,current_version,active,scope_all,default_plan,created_at) VALUES(?,?,?,0,0,0,?) ON CONFLICT(id) DO NOTHING", m.id, m.name, m.version, at), sql("INSERT INTO style_pack_versions(id,pack_id,version,manifest_json,created_at) VALUES(?,?,?,?,?)", randomId("sv"), m.id, m.version, JSON.stringify(m), at), sql("INSERT INTO style_version_meta(pack_id,pack_version,status,scope,checks_json,created_by) VALUES(?,?,'draft','admin_only',?,?)", m.id, m.version, JSON.stringify(data.checks), a.id) ];
            for (const x of assets) ops.push(sql("INSERT INTO style_assets(pack_id,pack_version,path,r2_key,mime,width,height,bytes,sha256) VALUES(?,?,?,?,?,?,?,?,?)", m.id, m.version, x.path, x.r2_key, x.mime, x.width, x.height, x.bytes, x.sha256));
            ops.push(audit(a, "upload_style", {
                id: m.id,
                pack_version: m.version
            }));
            await db.batch(ops);
            return this.style(m.id, m.version);
        },
        async validTenants(ids) {
            platform();
            return all("SELECT id FROM tenants WHERE id IN(SELECT value FROM json_each(?)) AND deleted_at IS NULL", JSON.stringify(ids));
        },
        async publishStyle(row, scope, tenants, a) {
            platform();
            const [g, id] = guard("SELECT version FROM style_version_meta WHERE pack_id=? AND pack_version=? AND status='draft'", [ row.id, row.pack_version ], row.version), ops = [ g, sql("UPDATE style_version_meta SET status='published',scope=?,version=version+1,published_at=? WHERE pack_id=? AND pack_version=?", scope, now(), row.id, row.pack_version), sql("UPDATE style_packs SET current_version=?,name=?,active=1,scope_all=? WHERE id=?", row.pack_version, JSON.parse(row.manifest_json).name, Number(scope === "all"), row.id), sql("DELETE FROM style_pack_scopes WHERE pack_id=?", row.id) ];
            for (const tid of tenants) ops.push(sql("INSERT INTO style_version_tenants(tenant_id,id,pack_id,pack_version) VALUES(?,?,?,?)", tid, randomId("svt"), row.id, row.pack_version), sql("INSERT INTO style_pack_scopes(tenant_id,id,pack_id) VALUES(?,?,?)", tid, randomId("scope"), row.id));
            ops.push(audit(a, "publish_style", {
                id: row.id,
                pack_version: row.pack_version,
                scope: scope,
                tenants: tenants
            }), end(id));
            await db.batch(ops);
        },
        async disableStyle(id, a) {
            platform();
            const p = await first("SELECT id FROM style_packs WHERE id=?", id);
            if (!p) fail(404, "不存在", "not_found");
            await db.batch([ sql("UPDATE style_packs SET active=0 WHERE id=?", id), audit(a, "disable_style", {
                id: id
            }) ]);
        },
        async defaultStyle(type, id, a) {
            platform();
            const row = await first("SELECT p.id,v.manifest_json FROM style_packs p JOIN style_pack_versions v ON v.pack_id=p.id AND v.version=p.current_version JOIN style_version_meta m ON m.pack_id=v.pack_id AND m.pack_version=v.version WHERE p.id=? AND p.active=1 AND m.status='published'", id);
            if (!row) fail(404, "不存在", "not_found");
            if (!JSON.parse(row.manifest_json).doc_types.includes(type)) invalid("风格不支持此文档类型", "doc_type");
            await db.batch([ sql("INSERT INTO style_defaults(doc_type,pack_id) VALUES(?,?) ON CONFLICT(doc_type) DO UPDATE SET pack_id=excluded.pack_id", type, id), audit(a, "default_style", {
                doc_type: type,
                pack_id: id
            }) ]);
        },
        async defaults() {
            platform();
            return all("SELECT * FROM style_defaults ORDER BY doc_type");
        },
        async styleAssets(id, v) {
            if (tenantId) scoped();
            return all("SELECT path,mime,width,height,bytes,sha256 FROM style_assets WHERE pack_id=? AND pack_version=? ORDER BY path", id, v);
        },
        async asset(id, v, path) {
            if (tenantId && !await this.tenantStyle(id, v, true)) return null;
            return first("SELECT * FROM style_assets WHERE pack_id=? AND pack_version=? AND path=?", id, v, path);
        },
        async tenantStyle(id, v, historical = false) {
            scoped();
            return first(`SELECT p.id,p.name,p.active,p.current_version,v.version,v.manifest_json FROM style_packs p JOIN style_pack_versions v ON v.pack_id=p.id AND v.version=COALESCE(?3,p.current_version) LEFT JOIN style_version_meta m ON m.pack_id=v.pack_id AND m.pack_version=v.version WHERE p.id=?2 AND (((?4=0 OR p.active=1) AND v.version=p.current_version AND (${visible})) OR ?4=1 AND (${owned}))`, tenantId, id, v, Number(historical));
        },
        async tenantStyles(type) {
            scoped();
            return all(`SELECT p.id,p.name,p.active,p.current_version,v.version,v.manifest_json FROM style_packs p JOIN style_pack_versions v ON v.pack_id=p.id AND v.version=p.current_version LEFT JOIN style_version_meta m ON m.pack_id=v.pack_id AND m.pack_version=v.version WHERE p.active=1 AND (${visible}) AND EXISTS(SELECT 1 FROM json_each(v.manifest_json,'$.doc_types') WHERE value=?2) ORDER BY CASE WHEN p.id=(SELECT pack_id FROM style_defaults WHERE doc_type=?2) THEN 0 ELSE 1 END,p.default_plan DESC,p.id`, tenantId, type);
        },

        async compliance() {
            platform();
            return all("SELECT id,term,active,version FROM compliance_terms ORDER BY id");
        },
        async saveTerms(terms, a) {
            platform();
            const before = await this.compliance(), ops = before.map(x => sql("UPDATE compliance_terms SET active=0,version=version+1 WHERE id=?", x.id));
            for (const term of terms) ops.push(sql("INSERT INTO compliance_terms(id,term,active,version) VALUES(?,?,1,1) ON CONFLICT(term) DO UPDATE SET active=1", randomId("term"), term));
            ops.push(audit(a, "save_compliance", {
                terms: terms
            }));
            await db.batch(ops);
            return this.compliance();
        },
        async aiOverride(id, d, a) {
            platform();
            if (!(await this.validTenants([ id ])).length) fail(404, "不存在", "not_found");
            await db.batch([ sql("INSERT INTO tenant_ai_overrides(tenant_id,fast_daily_limit,deep_daily_limit) VALUES(?,?,?) ON CONFLICT(tenant_id,id) DO UPDATE SET fast_daily_limit=excluded.fast_daily_limit,deep_daily_limit=excluded.deep_daily_limit", id, d.fast_daily_limit, d.deep_daily_limit), audit(a, "ai_override", {
                id: id,
                ...d
            }) ]);
        },
        async usage(from, to, tenant, group) {
            platform();
            if (tenant && !(await this.validTenants([ tenant ])).length) fail(404, "不存在", "not_found");
            const col = {
                day: "date(datetime(created_at/1000,'unixepoch','+8 hours'))",
                tenant: "tenant_id",
                tool: "tool"
            }[group];
            const data=await db.batch([sql(`SELECT ${col} key,tier,COUNT(*) calls,SUM(CASE WHEN result='ok' THEN 1 ELSE 0 END) successful,SUM(CASE WHEN result<>'ok' THEN 1 ELSE 0 END) failed,SUM(prompt_tokens) prompt_tokens,SUM(completion_tokens) completion_tokens,SUM(duration_ms) duration_ms FROM ai_usage WHERE created_at>=? AND created_at<? AND (? IS NULL OR tenant_id=?) GROUP BY ${col},tier ORDER BY key,tier`,from,to,tenant,tenant),sql(`SELECT ${col} key,tier,result reason,COUNT(*) count FROM ai_usage WHERE created_at>=? AND created_at<? AND (? IS NULL OR tenant_id=?) AND result<>'ok' GROUP BY ${col},tier,result`,from,to,tenant,tenant)]);return data[0].results.map(x=>{const failure_reasons={timeout:0,protocol_invalid:0,response_too_large:0,other:0};for(const f of data[1].results.filter(y=>y.key===x.key&&y.tier===x.tier)){const reason=['timeout','protocol_invalid','response_too_large'].includes(f.reason)||/^provider_http_[1-5]\d\d$/.test(f.reason)?f.reason:'other';failure_reasons[reason]=(failure_reasons[reason]||0)+f.count;}return {...x,failure_reasons};});
        },
        async subjectStatements(keys, a, tid, explicit = false) {
            if (!tid) throw Error("tenant scope required");
            const at = now(), state = await db.batch([ "offer_courses", "stage_types", "report_classes", "stage_rules", "calendar_nodes", "course_rules", "tenant_subjects", "setting_template_refs" ].map(t => sql("SELECT * FROM " + t + " WHERE tenant_id=?", tid))), rows = state.map(x => x.results), oldCfg = rows.slice(3, 6).map(x => x.find(y => y.id === "main"));
            const docs = {
                rules: oldCfg[0] ? JSON.parse(oldCfg[0].doc_json) : {
                    rules: {}
                },
                calendar: oldCfg[1] ? JSON.parse(oldCfg[1].doc_json) : {
                    region: null,
                    items: []
                },
                course: oldCfg[2] ? JSON.parse(oldCfg[2].doc_json) : {
                    items: []
                }
            }, ops = [];
            for (const key of keys) {
                const pack = await first("SELECT p.name,v.* FROM subject_packs p JOIN subject_pack_versions v ON v.key=p.key AND v.pack_version=p.current_published_version WHERE p.key=? AND v.status='published'", key);
                if (!pack) invalid("学科模板未发布", "key");
                const old = rows[6].find(x => x.id === key);
                if (old?.imported_at && (!explicit || old.pack_version === pack.pack_version)) continue;
                const c = JSON.parse(pack.content_json), maps = {};
                for (const [kind, table, input, prefix, index] of [ [ "courses", "offer_courses", c.courses, "crs", 0 ], [ "stage_types", "stage_types", c.stages, "stg", 1 ], [ "report_classes", "report_classes", c.classes, "rcl", 2 ] ]) {
                    maps[kind] = new Map;
                    const inserts = [], refs = [];
                    for (const [i, item] of input.entries()) {
                        const found = rows[7].find(x => x.subject === key && x.kind === kind && x.template_key === item.key), entity = found && rows[index].find(x => x.id === found.entity_id);
                        if (found) {
                            if (entity && !entity.deleted_at) maps[kind].set(item.key, entity.id);
                            continue;
                        }
                        if (rows[index].some(x => x.subject === key && x.name === item.name && !x.deleted_at)) continue;
                        const id = randomId(prefix), {key: templateKey, ...doc} = item;
                        doc.subject = key;
                        if (kind === "stage_types") doc.order ??= (i + 1) * 10;
                        inserts.push({
                            id: id,
                            doc: doc,
                            name: item.name,
                            active: Number(item.active ?? true)
                        });
                        maps[kind].set(templateKey, id);
                        refs.push({
                            id: randomId("tref"),
                            template_key: templateKey,
                            entity_id: id
                        });
                    }
                    for (const chunk of jsonChunks(inserts, 15e4)) ops.push(sql(`INSERT INTO ${table}(tenant_id,id,subject,name,active,source,doc_json,created_at,created_by,updated_at,updated_by,version) SELECT ?1,json_extract(value,'$.id'),?2,json_extract(value,'$.name'),json_extract(value,'$.active'),'template',json_extract(value,'$.doc'),?3,?4,?3,?4,1 FROM json_each(?5)`, tid, key, at, a.id, chunk));
                    for (const chunk of jsonChunks(refs, 15e4)) ops.push(sql("INSERT INTO setting_template_refs(tenant_id,id,subject,kind,template_key,entity_id) SELECT ?1,json_extract(value,'$.id'),?2,?3,json_extract(value,'$.template_key'),json_extract(value,'$.entity_id') FROM json_each(?4)", tid, key, kind, chunk));
                }

                for (const rule of c.course_rules) {
                    const stage = maps.stage_types.get(rule.stage_key);
                    if (!stage) invalid("模板阶段无法可靠映射，请在机构设置维护", "course_rules");
                    if (docs.course.items.some(x => x.stage_type_id === stage)) continue;
                    const convert = k => {
                        const id = maps.courses.get(k);
                        if (!id) invalid("模板课程无法可靠映射，请在机构设置维护", "course_rules");
                        return id;
                    };
                    docs.course.items.push({
                        stage_type_id: stage,
                        required: rule.required.map(convert),
                        recommended: rule.recommended.map(convert),
                        exclusive: rule.exclusive.map(g => g.map(convert)),
                        units: rule.units
                    });
                }
                docs.rules.rules = {
                    ...c.rules,
                    ...docs.rules.rules
                };
                const nodeKeys = new Set(docs.calendar.items.map(x => x.key));
                for (const n of c.calendar) if (!nodeKeys.has(n.key)) {
                    docs.calendar.items.push(n);
                    nodeKeys.add(n.key);
                }
                ops.push(sql("INSERT OR IGNORE INTO report_dimensions(tenant_id,id,class_id,dim_key) SELECT ?1,'dim_'||lower(hex(randomblob(12))),c.id,json_extract(d.value,'$.key') FROM report_classes c,json_each(c.doc_json,'$.dimensions') d WHERE c.tenant_id=?1 AND c.subject=?2", tid, key));
                ops.push(sql("INSERT INTO tenant_subjects(tenant_id,id,pack_version,created_at,created_by,imported_at,content_json) VALUES(?,?,?,?,?,?,?) ON CONFLICT(tenant_id,id) DO UPDATE SET pack_version=excluded.pack_version,imported_at=excluded.imported_at,content_json=excluded.content_json", tid, key, pack.pack_version, at, a.id, at, JSON.stringify({
                    content_types: c.content_types,
                    constraints: c.constraints,
                    tone: c.tone
                })));
                const [g, gid] = guard("SELECT CASE WHEN current_published_version=? THEN 1 ELSE 0 END FROM subject_packs WHERE key=?", [ pack.pack_version, key ], 1);
                ops.push(g, end(gid));
            }
            if (!ops.length) return ops;
            for (const [i, table, doc] of [ [ 0, "stage_rules", docs.rules ], [ 1, "calendar_nodes", docs.calendar ], [ 2, "course_rules", docs.course ] ]) {
                if (oldCfg[i]) ops.push(sql("INSERT INTO mutation_guards(tenant_id,id,expected,actual) VALUES(?,?,?,COALESCE((SELECT version FROM " + table + " WHERE tenant_id=? AND id='main'),-1))", tid, randomId("guard"), oldCfg[i].version, tid));
                ops.push(sql(`INSERT INTO ${table}(tenant_id,id,doc_json,created_at,created_by,updated_at,updated_by,version) VALUES(?,'main',?,?,?,?,?,1) ON CONFLICT(tenant_id,id) DO UPDATE SET doc_json=excluded.doc_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by,version=${table}.version+1`, tid, JSON.stringify(doc), at, a.id, at, a.id));
            }
            ops.push(sql("INSERT INTO tenant_price_lists(tenant_id,id,doc_json,created_at,created_by,updated_at,updated_by,version) VALUES(?,'main','{}',?,?,?,?,2) ON CONFLICT(tenant_id,id) DO UPDATE SET version=tenant_price_lists.version+1,updated_at=excluded.updated_at,updated_by=excluded.updated_by", tid, at, a.id, at, a.id));
            ops.push(sql("INSERT INTO audit_log(tenant_id,id,at,actor_id,actor_label,module,action,entity_id,summary,before_json,after_json) VALUES(?,?,?,?,?,'settings','import_template',?,'显式导入学科模板',NULL,?)", tid, randomId("aud"), at, a.id, a.name || "平台", keys.join(","), JSON.stringify({
                keys: keys
            })), sql("DELETE FROM mutation_guards WHERE tenant_id=?", tid));
            return ops;
        },
        async currentImport(key) {
            scoped();
            return !!await first("SELECT 1 ok FROM tenant_subjects t JOIN subject_packs p ON p.key=t.id WHERE t.tenant_id=? AND t.id=? AND t.pack_version=p.current_published_version AND t.imported_at IS NOT NULL", tenantId, key);
        },
        async importWarnings() {
            scoped();
            return all("SELECT DISTINCT t.subject FROM (SELECT subject,id FROM offer_courses WHERE tenant_id=?1 AND source='template' AND deleted_at IS NULL UNION ALL SELECT subject,id FROM stage_types WHERE tenant_id=?1 AND source='template' AND deleted_at IS NULL UNION ALL SELECT subject,id FROM report_classes WHERE tenant_id=?1 AND source='template' AND deleted_at IS NULL) t WHERE NOT EXISTS(SELECT 1 FROM setting_template_refs r WHERE r.tenant_id=?1 AND r.entity_id=t.id)", tenantId);
        }
    };
}
