-- 0035: 排课总时长 = 单课时时长(unit_minutes) × 课时数(units)，课时数按 0.5 步进（最小 0.5）。
-- 保留 0001–0033 不变，安全回填历史课程与固定排课模板的 unit_minutes。

ALTER TABLE lessons ADD COLUMN unit_minutes INTEGER;
ALTER TABLE schedule_templates ADD COLUMN unit_minutes INTEGER;

UPDATE lessons
SET unit_minutes = CASE
  WHEN duration IN (30, 45, 60) AND COALESCE(units, 1) = 1 THEN duration
  WHEN units > 0 AND CAST(ROUND(duration * 1.0 / units) AS INTEGER) IN (30, 45, 60) THEN CAST(ROUND(duration * 1.0 / units) AS INTEGER)
  WHEN duration IN (30, 45, 60) THEN duration
  ELSE 60
END
WHERE unit_minutes IS NULL;

UPDATE schedule_templates
SET unit_minutes = CASE
  WHEN duration IN (30, 45, 60) AND COALESCE(units, 1) = 1 THEN duration
  WHEN units > 0 AND CAST(ROUND(duration * 1.0 / units) AS INTEGER) IN (30, 45, 60) THEN CAST(ROUND(duration * 1.0 / units) AS INTEGER)
  WHEN duration IN (30, 45, 60) THEN duration
  ELSE 60
END
WHERE unit_minutes IS NULL;

DROP TRIGGER IF EXISTS course_limits_course_types_insert;
DROP TRIGGER IF EXISTS course_limits_course_types_update;
DROP TRIGGER IF EXISTS course_limits_schedule_templates_insert;
DROP TRIGGER IF EXISTS course_limits_schedule_templates_update;
DROP TRIGGER IF EXISTS course_limits_lessons_insert;
DROP TRIGGER IF EXISTS course_limits_lessons_update;

CREATE TRIGGER course_limits_course_types_insert BEFORE INSERT ON course_types
WHEN NOT EXISTS(SELECT 1 FROM trusted_imports WHERE tenant_id=NEW.tenant_id)
  AND (
    NEW.default_minutes NOT IN (30, 45, 60)
    OR NEW.units_per_lesson < 0.5
    OR ABS(NEW.units_per_lesson * 2 - ROUND(NEW.units_per_lesson * 2)) > 1e-6
  )
BEGIN SELECT RAISE(ABORT, 'course_duration_or_units'); END;

CREATE TRIGGER course_limits_course_types_update BEFORE UPDATE ON course_types
WHEN (
    NEW.default_minutes IS NOT OLD.default_minutes
    AND NEW.default_minutes NOT IN (30, 45, 60)
  )
  OR (
    NEW.units_per_lesson IS NOT OLD.units_per_lesson
    AND (
      NEW.units_per_lesson < 0.5
      OR ABS(NEW.units_per_lesson * 2 - ROUND(NEW.units_per_lesson * 2)) > 1e-6
    )
  )
BEGIN SELECT RAISE(ABORT, 'course_duration_or_units'); END;

CREATE TRIGGER course_limits_schedule_templates_insert BEFORE INSERT ON schedule_templates
WHEN NOT EXISTS(SELECT 1 FROM trusted_imports WHERE tenant_id=NEW.tenant_id)
  AND (
    (NEW.unit_minutes IS NOT NULL AND NEW.unit_minutes NOT IN (30, 45, 60))
    OR (NEW.unit_minutes IS NULL AND NEW.duration NOT IN (30, 45, 60))
    OR NEW.units < 0.5
    OR ABS(NEW.units * 2 - ROUND(NEW.units * 2)) > 1e-6
    OR NEW.duration < 15
    OR NEW.duration > 1440
  )
BEGIN SELECT RAISE(ABORT, 'course_duration_or_units'); END;

CREATE TRIGGER course_limits_schedule_templates_update BEFORE UPDATE ON schedule_templates
WHEN (
    NEW.unit_minutes IS NOT OLD.unit_minutes
    AND (NEW.unit_minutes IS NULL OR NEW.unit_minutes NOT IN (30, 45, 60))
  )
  OR (
    NEW.units IS NOT OLD.units
    AND (
      NEW.units < 0.5
      OR ABS(NEW.units * 2 - ROUND(NEW.units * 2)) > 1e-6
    )
  )
  OR (
    NEW.duration IS NOT OLD.duration
    AND (NEW.duration < 15 OR NEW.duration > 1440)
  )
BEGIN SELECT RAISE(ABORT, 'course_duration_or_units'); END;

CREATE TRIGGER course_limits_lessons_insert BEFORE INSERT ON lessons
WHEN NOT EXISTS(SELECT 1 FROM trusted_imports WHERE tenant_id=NEW.tenant_id)
  AND (
    (NEW.unit_minutes IS NOT NULL AND NEW.unit_minutes NOT IN (30, 45, 60))
    OR (NEW.unit_minutes IS NULL AND NEW.duration NOT IN (30, 45, 60))
    OR NEW.units < 0.5
    OR ABS(NEW.units * 2 - ROUND(NEW.units * 2)) > 1e-6
    OR NEW.duration < 15
    OR NEW.duration > 1440
  )
BEGIN SELECT RAISE(ABORT, 'course_duration_or_units'); END;

CREATE TRIGGER course_limits_lessons_update BEFORE UPDATE ON lessons
WHEN (
    NEW.unit_minutes IS NOT OLD.unit_minutes
    AND (NEW.unit_minutes IS NULL OR NEW.unit_minutes NOT IN (30, 45, 60))
  )
  OR (
    NEW.units IS NOT OLD.units
    AND (
      NEW.units < 0.5
      OR ABS(NEW.units * 2 - ROUND(NEW.units * 2)) > 1e-6
    )
  )
  OR (
    NEW.duration IS NOT OLD.duration
    AND (NEW.duration < 15 OR NEW.duration > 1440)
  )
BEGIN SELECT RAISE(ABORT, 'course_duration_or_units'); END;
