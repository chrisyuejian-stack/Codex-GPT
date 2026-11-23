-- 0034: 课程形式合并（小组课 group + 集训班 class -> 班课 group），含教师课酬标准合并。
-- 仅更新历史数据，不修改表结构，不提升 FULL_BACKUP_VERSION（保持 33）。
--
-- 冲突处理规则：
-- 若同一 tenant_id、同一 teacher_id、同一 course_type_id（含 NULL）下，
-- 同时存在未删除（deleted_at IS NULL）且生效期重叠的 group 与 class 教师课酬标准
-- （other.effective_from <= teacher_rates.effective_to AND other.effective_to >= teacher_rates.effective_from），
-- 则保留 created_at 较晚的一条（created_at 相等时保留 id 较大者），
-- 另一条执行软删除（设置 deleted_at、updated_at 并递增 version）。
UPDATE teacher_rates
SET
  deleted_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  version = version + 1
WHERE deleted_at IS NULL
  AND format IN ('group', 'class')
  AND EXISTS (
    SELECT 1
    FROM teacher_rates AS other
    WHERE other.tenant_id = teacher_rates.tenant_id
      AND other.teacher_id = teacher_rates.teacher_id
      AND other.course_type_id IS teacher_rates.course_type_id
      AND other.deleted_at IS NULL
      AND other.format IN ('group', 'class')
      AND other.format <> teacher_rates.format
      AND other.effective_from <= teacher_rates.effective_to
      AND other.effective_to >= teacher_rates.effective_from
      AND (
        other.created_at > teacher_rates.created_at
        OR (other.created_at = teacher_rates.created_at AND other.id > teacher_rates.id)
      )
  );

UPDATE course_types
SET format = 'group'
WHERE format = 'class';

UPDATE lessons
SET format = 'group'
WHERE format = 'class';

UPDATE teacher_rates
SET format = 'group'
WHERE format = 'class';
