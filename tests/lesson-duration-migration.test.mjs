import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

test("0035历史回填不重写时长/课时；六个触发器允许历史值原样更新，拦截新增及修改的非法值", () => {
  const db = new DatabaseSync(":memory:");
  try {
    // 独立投影旧表，只隔离验证真实迁移的回填与六个触发器；完整结构由preflight验证。
    db.exec("CREATE TABLE trusted_imports(tenant_id TEXT); CREATE TABLE course_types(tenant_id TEXT,id TEXT,default_minutes INTEGER,units_per_lesson REAL,note TEXT)");
    for (const table of ["lessons", "schedule_templates"])
      db.exec(`CREATE TABLE ${table}(tenant_id TEXT,id TEXT,duration INTEGER,units REAL,note TEXT); INSERT INTO ${table} VALUES('t','legacy',45,1.3,''),('t','pair',90,2,''),('t','half',23,0.5,'')`);
    db.exec("INSERT INTO course_types VALUES('t','legacy',90,1.3,'')");
    db.exec(readFileSync(new URL("../migrations/0035_lesson_unit_minutes.sql", import.meta.url), "utf8"));
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'course_limits_%'").get().n, 6);
    for (const table of ["lessons", "schedule_templates"]) {
      const before = db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
      // 23/0.5=46 无法推断，使用迁移约定的60兜底；历史duration本身保持23。
      assert.deepEqual(before.map(r => [r.id, r.duration, r.units, r.unit_minutes]), [["half",23,0.5,60],["legacy",45,1.3,45],["pair",90,2,45]]);
      db.exec(`UPDATE ${table} SET note='changed'`);
      assert.deepEqual(db.prepare(`SELECT duration,units,unit_minutes FROM ${table} ORDER BY id`).all().map(r => ({...r})), before.map(({duration,units,unit_minutes}) => ({duration,units,unit_minutes})));
      for (const values of ["31,1,31", "45,1.3,45", "60,0.25,15", "60,25,1500"])
        assert.throws(() => db.exec(`INSERT INTO ${table}(tenant_id,id,unit_minutes,units,duration) VALUES('t','bad',${values})`), /course_duration_or_units/);
      for (const change of ["units=1.01", "unit_minutes=31", "unit_minutes=NULL", "duration=1441"])
        assert.throws(() => db.exec(`UPDATE ${table} SET ${change} WHERE id='pair'`), /course_duration_or_units/);
      db.exec(`INSERT INTO ${table}(tenant_id,id,unit_minutes,units,duration) VALUES('t','valid',45,0.5,23)`);
    }
    db.exec("UPDATE course_types SET note='changed'");
    assert.throws(() => db.exec("UPDATE course_types SET units_per_lesson=1.01"), /course_duration_or_units/);
    assert.throws(() => db.exec("INSERT INTO course_types VALUES('t','bad',60,0.25,'')"), /course_duration_or_units/);
    db.exec("UPDATE course_types SET default_minutes=45,units_per_lesson=0.5");
  } finally { db.close(); }
});
