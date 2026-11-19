import { effectiveAIConfig } from './ai-config.js';

import { boundedText, storedRecord, auditChunks, checkBindings, assertPattern, MANIFEST_BUDGET, D1_VALUE_BUDGET, SNAPSHOT_SAFE_ASCII_PATTERN } from "./d1-limits.js";
import { backupTables, creditTables, BACKUP_STATUS_LABELS } from "./backup-model.js";
import { randomId, now, fail } from "./core.js";

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

const snapshotCaptureSql=Object.entries(backupTables).map(([table,spec])=>{const keys=spec.pk||spec.columns.slice(0,1);const where=table==='tenants'?'id=?2':spec.tenant?'tenant_id=?2':'?2 IS NOT NULL';return `INSERT INTO backup_snapshot_rows(tenant_id,id,snapshot_id,table_name,source_id,row_json) SELECT ${spec.tenant?'tenant_id':"'app'"},'brow_'||lower(hex(randomblob(12))),?1,'${table}',json_array(${keys.join(',')}),json_object(${spec.columns.map(c=>"'"+c+"',"+c).join(',')}) FROM ${table} WHERE ${where}`;});
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
      "INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT 'backup',?||':" +
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

function policyRows(modules, settings, rights) {
  return {
    modules: Object.fromEntries(modules.map((x) => [x.id, !!x.enabled])),
    settings: Object.fromEntries(settings.map((x) => [x.id, JSON.parse(x.value)])),
    rights,
  };
}

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
  const globalScope = () => {
    if (tenantId !== null) throw Error("global backup scope required");
  };
  const conflict=async(id)=>{const row=await first('SELECT actor.name FROM users target LEFT JOIN users actor ON actor.tenant_id=target.tenant_id AND actor.id=target.updated_by WHERE target.tenant_id=? AND target.id=?',tenantId,id);fail(409,'这条记录刚被'+(row?.name||'系统维护')+'修改，请刷新');};
  async function authentication(hash) {
 scoped(); const at=now(), eligible="SELECT s.id session_id,s.expires_at,s.last_seen_at,s.idle_ms,u.* FROM sessions s JOIN users u ON u.tenant_id=s.tenant_id AND u.id=s.user_id WHERE s.tenant_id=?1 AND s.token_hash=?2 AND u.active=1 AND u.deleted_at IS NULL AND s.expires_at>?3 AND (s.idle_ms IS NULL OR s.last_seen_at+s.idle_ms>?3)", selected='(SELECT tenant_id FROM ('+eligible+'))';
 const result=await db.batch([sql(eligible,tenantId,hash,at),sql('SELECT id,enabled FROM tenant_modules WHERE tenant_id='+selected+' AND deleted_at IS NULL',tenantId,hash,at),sql('SELECT id,value FROM tenant_settings WHERE tenant_id='+selected+' AND deleted_at IS NULL',tenantId,hash,at),sql('SELECT role,module,action,allowed FROM tenant_role_rights WHERE tenant_id='+selected+' AND deleted_at IS NULL',tenantId,hash,at),sql('UPDATE sessions SET last_seen_at=?3,updated_at=?3 WHERE tenant_id=?1 AND token_hash=?2 AND last_seen_at<=?3-60000 AND EXISTS('+eligible+')',tenantId,hash,at)]);
 const user=result[0].results[0]||null;if(user)cache.policy=policyRows(result[1].results,result[2].results,result[3].results);return user;
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

  function settingReferenceGuards(refs,tid=tenantId) {
    const groups=new Map();for(const [kind,id,version] of refs||[]) {const table=settingTables[kind]||({course_types:'course_types',teachers:'teachers',gallery:'gallery_images'}[kind]);if(!table)throw Error('invalid setting reference');if(!groups.has(table))groups.set(table,[]);if(!groups.get(table).some(x=>x[0]===id))groups.get(table).push([id,version??null]);}
    return [...groups].map(([table,ids])=>sql(`INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?1,?2,1,CASE WHEN COUNT(*)=json_array_length(?3) THEN 1 ELSE 0 END FROM ${table} t JOIN json_each(?3) j ON t.id=json_extract(j.value,'$[0]') WHERE t.tenant_id=?1 AND t.deleted_at IS NULL AND (json_extract(j.value,'$[1]') IS NULL OR t.version=json_extract(j.value,'$[1]'))`,tid,randomId('guard'),JSON.stringify(ids)));
  }

  return {

async studentFeedback(studentId,offset,limit){scoped();const query=`SELECT 'feedback' type,f.id,'confirmed' status,f.student_id,f.id revision_id,'课后反馈' title,f.confirmed_at at,f.doc_json,f.lesson_id FROM growth_feedback f JOIN lessons l ON l.tenant_id=f.tenant_id AND l.id=f.lesson_id AND l.deleted_at IS NULL WHERE f.tenant_id=?1 AND f.student_id=?2 AND f.status='confirmed' AND f.deleted_at IS NULL AND f.seq=(SELECT MAX(x.seq) FROM growth_feedback x WHERE x.tenant_id=?1 AND x.lesson_id=f.lesson_id AND x.student_id=f.student_id AND x.status='confirmed' AND x.deleted_at IS NULL)`;const legacy=` UNION ALL SELECT 'feedback','legacy_'||l.id||'_'||p.student_id,'confirmed',p.student_id,NULL,'课后反馈',MAX(c.updated_at),json_object('message',json_object('learned',GROUP_CONCAT(c.text,char(10)),'good','','attention','','homework',MAX(c.homework)),'tags',json('[]'),'image_ids',json('[]')),l.id FROM lesson_participants p JOIN lessons l ON l.tenant_id=p.tenant_id AND l.id=p.lesson_id AND l.deleted_at IS NULL JOIN lesson_comments c ON c.tenant_id=p.tenant_id AND c.lesson_id=l.id AND c.deleted_at IS NULL AND (c.student_id=p.student_id OR c.student_id IS NULL) WHERE p.tenant_id=?1 AND p.student_id=?2 AND p.deleted_at IS NULL AND p.deducted=1 AND NOT EXISTS(SELECT 1 FROM growth_feedback f WHERE f.tenant_id=?1 AND f.lesson_id=l.id AND f.student_id=p.student_id AND f.status='confirmed' AND f.deleted_at IS NULL) GROUP BY l.id,p.student_id`;const combined=query+legacy;const results=await db.batch([sql('SELECT * FROM ('+combined+') ORDER BY at DESC,id LIMIT ?3 OFFSET ?4',tenantId,studentId,limit,offset),sql('SELECT COUNT(*) n FROM ('+combined+')',tenantId,studentId)]);return {items:results[0].results,total:results[1].results[0].n};},
async studentFeedbackMedia(image,children) { scoped(); return first(`SELECT a.* FROM gallery_images a WHERE a.tenant_id=?1 AND a.id=?2 AND a.deleted_at IS NULL AND EXISTS(SELECT 1 FROM growth_feedback f JOIN students s ON s.tenant_id=f.tenant_id AND s.id=f.student_id AND s.parent_consent_media=1 AND s.deleted_at IS NULL WHERE f.tenant_id=?1 AND f.student_id IN(SELECT value FROM json_each(?3)) AND f.status='confirmed' AND f.deleted_at IS NULL AND a.id IN(SELECT value FROM json_each(f.doc_json,'$.image_ids')) AND f.seq=(SELECT MAX(x.seq) FROM growth_feedback x WHERE x.tenant_id=?1 AND x.lesson_id=f.lesson_id AND x.student_id=f.student_id AND x.status='confirmed' AND x.deleted_at IS NULL))`,tenantId,image,JSON.stringify(children)); },
    async instanceTenant(){return first("SELECT t.*,i.tenant_id instance_tenant_id FROM app_instance i JOIN tenants t ON t.id=i.tenant_id WHERE i.id='main'");},
    async instance(){return first("SELECT tenant_id,initialized_at FROM app_instance WHERE id='main'");},
    async initializeInstance(tenant,user,moduleIds) {
      const at=now(),tid=tenant.id,actor=user.id;
      const ops=[sql("INSERT INTO tenants(id,slug,name,type,city,status,staff_seat_limit,student_seat_limit,created_at,created_by,updated_at,updated_by) VALUES(?,'fengqin',?,'其他','','active',1000000,1000000,?,?,?,?)",tid,tenant.name,at,actor,at,actor),
       sql("INSERT INTO app_instance(id,tenant_id,initialized_at) VALUES('main',?,?)",tid,at),
       sql('INSERT INTO tenant_data_versions(tenant_id,version) VALUES(?,1)',tid),
       sql("INSERT INTO tenant_branding(tenant_id,id,display_name,theme_color,welcome_text,created_at,created_by,updated_at,updated_by) VALUES(?,'brand',?,'#6A35B8','欢迎来到枫琴教务中心',?,?,?,?)",tid,tenant.name,at,actor,at,actor),
       sql("INSERT INTO users(tenant_id,id,name,phone_hmac,phone_enc,phone_last4,roles,salt,digest,must_change,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,?,'[\"supervisor\"]',?,?,0,?,?,?,?)",tid,user.id,user.name,user.phone_hmac,user.phone_enc,user.phone_last4,user.salt,user.digest,at,actor,at,actor),
       sql("INSERT INTO audit_log(tenant_id,id,at,actor_id,actor_label,module,action,entity_id,summary) VALUES(?,?,?,?,?,'accounts','initialize',?,'初始化首个主管账号')",tid,randomId('aud'),at,user.id,user.name,user.id)];
      for(const id of moduleIds)ops.push(sql('INSERT INTO tenant_modules(tenant_id,id,enabled,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,?,?)',tid,id,id==='school_db'?0:1,at,actor,at,actor));
      for(const [id,value] of Object.entries({student_view_balance:true,student_view_payments:false}))ops.push(sql('INSERT INTO tenant_settings(tenant_id,id,value,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,?,?)',tid,id,JSON.stringify(value),at,actor,at,actor));
      await db.batch(ops);
    },
    async aiSettings(){return first("SELECT id,fast_daily_limit,deep_daily_limit,fast_model,deep_model,version,configured FROM ai_settings WHERE id='main'");},
    async saveAISettings(data,actor){scoped();const result=await db.batch([sql("UPDATE ai_settings SET configured=?,fast_daily_limit=?,deep_daily_limit=?,fast_model=?,deep_model=?,version=version+1,updated_at=?,updated_by=? WHERE id='main' AND version=?",Number(data.configured),data.fast_daily_limit,data.deep_daily_limit,data.fast_model,data.deep_model,now(),actor.id,data.version),sql("INSERT INTO audit_log(tenant_id,id,at,actor_id,actor_label,module,action,summary) SELECT ?,?,?,?,?,'ai','settings','修改内部AI模型与额度（不含密钥）' WHERE changes()=1",tenantId,randomId('aud'),now(),actor.id,actor.name)]);if(!result[0].meta.changes)fail(409,'AI设置已变化，请刷新','version_conflict');},

    async aiCatalog() {
 scoped(); const data=await db.batch([
 sql('SELECT * FROM offer_courses WHERE tenant_id=? AND deleted_at IS NULL ORDER BY id LIMIT 500',tenantId),
 sql('SELECT * FROM stage_types WHERE tenant_id=? AND deleted_at IS NULL ORDER BY id LIMIT 500',tenantId),
 sql("SELECT 'stage_rules' kind,doc_json,version FROM stage_rules WHERE tenant_id=?1 AND id='main' UNION ALL SELECT 'calendar',doc_json,version FROM calendar_nodes WHERE tenant_id=?1 AND id='main' UNION ALL SELECT 'course_rules',doc_json,version FROM course_rules WHERE tenant_id=?1 AND id='main' UNION ALL SELECT 'profile',doc_json,version FROM tenant_profile WHERE tenant_id=?1 AND id='main' UNION ALL SELECT 'prices',doc_json,version FROM tenant_price_lists WHERE tenant_id=?1 AND id='main'",tenantId),
 sql('SELECT * FROM report_classes WHERE tenant_id=? AND deleted_at IS NULL LIMIT 500',tenantId)]);
 return {courses:data[0].results,stages:data[1].results,settings:Object.fromEntries(data[2].results.map(x=>[x.kind,{...JSON.parse(x.doc_json),version:x.version}])),report_classes:data[3].results};
},

    async aiConfig(){scoped();return effectiveAIConfig(env,await this.aiSettings());},

    async aiRequest(userId,key){scoped();return first('SELECT * FROM ai_requests WHERE tenant_id=? AND user_id=? AND idem_key=?',tenantId,userId,key);},
    async aiRequestId(id){scoped();return first('SELECT * FROM ai_requests WHERE tenant_id=? AND id=?',tenantId,id);},
    async aiReplay(record){scoped();if(record.response&&record.cache_expires_at>now())return JSON.parse(record.response);const receipt=JSON.parse(record.receipt_json);const rows=await all('SELECT id,doc_json FROM ai_suggestions WHERE tenant_id=? AND id IN(SELECT value FROM json_each(?))',tenantId,JSON.stringify(receipt.ids));const byId=new Map(rows.map(x=>[x.id,JSON.parse(x.doc_json)]));if(receipt.ids.some(id=>!byId.has(id)))throw Error('AI_REPLAY_MISSING');return {...(receipt.extra||{}),suggestions:receipt.ids.map(id=>{const s=byId.get(id);return {id:s.id,kind:s.kind,target:s.target,payload:s.payload,basis:s.basis,warnings:s.warnings,...(s.flags?{flags:s.flags}:{})}}),warnings:receipt.warnings,usage:receipt.usage};},
    async aiCapacity(userId,date,tier,limit,at,excludeHold=null){scoped();return first(`SELECT COALESCE((SELECT used FROM ai_quota_daily WHERE tenant_id=?1 AND date=?2 AND tier=?3),0) used,(SELECT COUNT(*) FROM ai_quota_holds WHERE tenant_id=?1 AND date=?2 AND tier=?3 AND status='held' AND expires_at>?4 AND (?6 IS NULL OR id<>?6)) held,(SELECT COUNT(*) FROM ai_requests WHERE tenant_id=?1 AND user_id=?5 AND batch_parent_id IS NULL AND status='pending' AND deadline_at>?4) pending`,tenantId,date,tier,at,userId,excludeHold);},
    async aiAcquire(record,old,limit,at){scoped();const state=old?`(SELECT version FROM ai_requests WHERE tenant_id=?1 AND id=?2 AND (status='failed' OR status='pending' AND deadline_at<=?3))=${old.version}`:`NOT EXISTS(SELECT 1 FROM ai_requests WHERE tenant_id=?1 AND user_id=?4 AND idem_key=?5)`;
      const guard=`INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?1,?6,1,CASE WHEN ${state} AND (SELECT COUNT(*) FROM ai_requests WHERE tenant_id=?1 AND user_id=?4 AND batch_parent_id IS NULL AND status='pending' AND deadline_at>?3)<2 AND COALESCE((SELECT used FROM ai_quota_daily WHERE tenant_id=?1 AND date=?7 AND tier=?8),0)+(SELECT COUNT(*) FROM ai_quota_holds WHERE tenant_id=?1 AND date=?7 AND tier=?8 AND status='held' AND expires_at>?3 AND (?9 IS NULL OR id<>?9))<?10 THEN 1 ELSE 0 END`;
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
      const receipt={ids:suggestions.map(x=>x.id),warnings:response.warnings,usage:response.usage,...record.reference_audit?{internal_reference_audit:record.reference_audit}:{}};storedRecord({response:JSON.stringify(response)},'AI响应');const guard=sql(`INSERT INTO mutation_guards(tenant_id,id,expected,actual) SELECT ?1,?2,1,CASE WHEN EXISTS(SELECT 1 FROM ai_requests q JOIN ai_quota_holds h ON h.tenant_id=q.tenant_id AND h.id=q.hold_id WHERE q.tenant_id=?1 AND q.id=?3 AND q.status='pending' AND h.id=?4 AND h.status='held' AND (h.expires_at>?5 OR COALESCE((SELECT used FROM ai_quota_daily d WHERE d.tenant_id=?1 AND d.date=h.date AND d.tier=h.tier),0)+(SELECT COUNT(*) FROM ai_quota_holds x WHERE x.tenant_id=?1 AND x.date=h.date AND x.tier=h.tier AND x.status='held' AND x.expires_at>?5)<?6)) THEN 1 ELSE 0 END`,tenantId,randomId('guard'),record.id,record.hold_id,at,limit);
      const ops=[guard,sql("UPDATE ai_quota_holds SET status='settled',settled_at=? WHERE tenant_id=? AND id=? AND status='held'",at,tenantId,record.hold_id),sql('INSERT INTO ai_quota_daily(tenant_id,id,date,tier,used) VALUES(?,?,?,?,1) ON CONFLICT(tenant_id,date,tier) DO UPDATE SET used=ai_quota_daily.used+1',tenantId,hold.date+':'+hold.tier,hold.date,hold.tier)];
      for(const suggestion of suggestions){storedRecord(suggestion,'AI建议');ops.push(sql('INSERT INTO ai_suggestions(tenant_id,id,user_id,kind,doc_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?)',tenantId,suggestion.id,record.user_id,suggestion.kind,JSON.stringify(suggestion),at,at+7*86400000));}
      ops.push(sql('INSERT INTO ai_usage(tenant_id,id,hold_id,request_id,user_id,date,tool,action,tier,model,prompt_tokens,completion_tokens,duration_ms,result,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',tenantId,randomId('aiu'),record.hold_id,record.id,record.user_id,hold.date,metrics.tool,metrics.action,hold.tier,metrics.model,metrics.prompt_tokens,metrics.completion_tokens,metrics.duration_ms,'ok',at));
      ops.push(sql("UPDATE ai_requests SET status='done',response=json_set(?,'$.usage.used_today',(SELECT used FROM ai_quota_daily d WHERE d.tenant_id=ai_requests.tenant_id AND d.date=? AND d.tier=?)),cache_expires_at=?,receipt_json=json_set(?,'$.usage.used_today',(SELECT used FROM ai_quota_daily d WHERE d.tenant_id=ai_requests.tenant_id AND d.date=? AND d.tier=?)),finished_at=?,retain_until=?,version=version+1 WHERE tenant_id=? AND id=? AND hold_id=?",JSON.stringify(response),hold.date,hold.tier,at+600000,JSON.stringify(receipt),hold.date,hold.tier,at,at+2*86400000,tenantId,record.id,record.hold_id));
      try{await db.batch(ops);return {ok:true}}catch(e){if(!/expected=actual/.test(String(e)))throw e;const latest=await this.aiRequestId(record.id);if(latest.status==='done')return {replay:true,request:latest};if(latest.hold_id!==record.hold_id)return {lost:true};await this.aiFailure(record,{...metrics,result:'blocked_after_expiry'},at,'expired');return {blocked:true}}
    },
    async aiFailure(record,metrics,at,status='released'){scoped();const h=await this.aiHold(record.hold_id);if(!h||h.status!=='held')return;await db.batch([sql('UPDATE ai_quota_holds SET status=? WHERE tenant_id=? AND id=? AND status=\'held\'',status,tenantId,record.hold_id),sql("UPDATE ai_requests SET status='failed',finished_at=?,version=version+1 WHERE tenant_id=? AND id=? AND hold_id=? AND status='pending'",at,tenantId,record.id,record.hold_id),sql(`INSERT INTO ai_usage(tenant_id,id,hold_id,request_id,user_id,date,tool,action,tier,model,prompt_tokens,completion_tokens,duration_ms,result,created_at) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15 WHERE NOT EXISTS(SELECT 1 FROM ai_usage WHERE tenant_id=?1 AND hold_id=?3)`,tenantId,randomId('aiu'),record.hold_id,record.id,record.user_id,h.date,metrics.tool,metrics.action,h.tier,metrics.model,metrics.prompt_tokens,metrics.completion_tokens,metrics.duration_ms,metrics.result||metrics.failure_reason||'other',at)]);},
    async aiRejected(record,metrics,at){scoped();await db.batch([sql("INSERT OR IGNORE INTO ai_requests(tenant_id,id,user_id,idem_key,request_hash,path,status,hold_id,deadline_at,created_at,finished_at,retain_until) VALUES(?,?,?,?,?,?,'failed',?,?,?,?,?)",tenantId,record.id,record.user_id,record.idem_key,record.request_hash,record.path,record.hold_id,record.deadline_at,at,at,at+2*86400000),sql("INSERT INTO ai_usage(tenant_id,id,hold_id,request_id,user_id,date,tool,action,tier,model,duration_ms,result,created_at) VALUES(?,?,NULL,?,?,?,?,?,?,?,0,'blocked',?)",tenantId,randomId('aiu'),record.id,record.user_id,record.date,metrics.tool,metrics.action,record.tier,metrics.model,at)]);},

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

    async beginBackup(id, at, manifest) {
      globalScope();
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
      const selected=env.TENANT_ID||(await this.instance())?.tenant_id;if(!selected)fail(503,"请先初始化系统","setup_required");
      for (const statement of snapshotCaptureSql) ops.push(sql(statement, id,selected));
      ops.push(
        sql(
          "DELETE FROM mutation_guards WHERE tenant_id='backup' AND id>=? AND id<?",
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
      globalScope();
      return first(
        "SELECT * FROM backup_snapshots WHERE status='running' ORDER BY at LIMIT 1",
      );
    },
    async backupCounts(id) {
      globalScope();
      return all(
        "SELECT table_name,COUNT(*) n FROM backup_snapshot_rows WHERE snapshot_id=? GROUP BY table_name",
        id,
      );
    },
    async snapshotPage(id, table, offset) {
      globalScope();
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
      globalScope();
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
    async backupGcCursor(){return (await first("SELECT value FROM app_state WHERE id='backup_gc_cursor'"))?.value||'';},
    async saveBackupGcCursor(cursor){await sql("INSERT INTO app_state(id,value) VALUES('backup_gc_cursor',?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",cursor||'').run();},
    async backupLog(id, status, detail) {
      globalScope();
      await sql(
        "INSERT INTO backup_runs(id,at,status,detail) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,detail=excluded.detail",
        id,
        now(),
        status,
        detail,
      ).run();
    },
    async backupRuns() {
      globalScope();
      return (
        await all(
          "SELECT id,at,status,detail FROM backup_runs ORDER BY at DESC LIMIT 200",
        )
      ).map((row) => ({
        ...row,
        status_label: BACKUP_STATUS_LABELS[row.status] || "未知状态",
      }));
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
    async createUser(data,actor) {
 scoped();const at=now();await db.batch([sql('INSERT INTO users(tenant_id,id,name,phone_hmac,phone_enc,phone_last4,roles,teacher_id,student_id,salt,digest,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',tenantId,data.id,data.name,data.phone_hmac,data.phone_enc,data.phone_last4,data.roles,data.teacher_id||null,data.student_id||null,data.salt,data.digest,at,actor.id,at,actor.id),auditStmt(actor,'accounts','create',data.id,'创建账号（手机号已脱敏）')]);
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
          "UPDATE users SET name=?,roles=?,active=?,disabled_reason=CASE WHEN ?=0 THEN 'manual' ELSE NULL END,phone_hmac=COALESCE(?,phone_hmac),phone_enc=COALESCE(?,phone_enc),phone_last4=COALESCE(?,phone_last4),version=version+1,updated_at=?,updated_by=? WHERE tenant_id=? AND id=? AND version=? AND deleted_at IS NULL",
          data.name,
          data.roles,
          data.active,
          data.active,
          data.phone_hmac ?? null,
          data.phone_enc ?? null,
          data.phone_last4 ?? null,
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
    async createSession(hash,user,info) {
 scoped();const at=now(),personal=JSON.parse(user.roles).some(x=>['teacher','student'].includes(x));const result=await sql("INSERT INTO sessions(tenant_id,id,token_hash,user_id,expires_at,last_seen_at,idle_ms,ip,ua,created_at,created_by,updated_at,updated_by,kind) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,'root' WHERE EXISTS(SELECT 1 FROM users WHERE tenant_id=? AND id=? AND version=? AND digest=? AND active=1 AND deleted_at IS NULL)",tenantId,randomId('ses'),hash,user.id,at+(personal?14*86400000:43200000),at,personal?null:7200000,info.ip,info.ua,at,user.id,at,user.id,tenantId,user.id,user.version||1,user.digest).run();if(!result.meta.changes)fail(401,'手机号或密码不正确','LOGIN_FAILED');
},
    async authenticateRequest(hash) {
      scoped();
      return authentication(hash);
    },
    // 固定自然小时计数，告警与拦截分开；不会撤销任何会话。

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
    async authEvent(user,last4,event,info){scoped();await sql('INSERT INTO auth_log(tenant_id,id,at,user_id,phone_last4,event,ip,ua) VALUES(?,?,?,?,?,?,?,?)',tenantId,randomId('auth'),now(),user||null,last4||null,event,info.ip,info.ua).run();},
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

    async identityLeadExists(id) {
      scoped();
      return !!await first("SELECT id FROM leads WHERE tenant_id=? AND id=? AND deleted_at IS NULL",tenantId,id);
    },

  };
}
