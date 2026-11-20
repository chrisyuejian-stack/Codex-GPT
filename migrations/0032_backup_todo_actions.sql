-- Backup sizes and explicit decisions to waive a leave's makeup.
ALTER TABLE full_backup_files ADD COLUMN size_bytes INTEGER NOT NULL DEFAULT 0 CHECK(size_bytes>=0);
ALTER TABLE backup_snapshots ADD COLUMN size_bytes INTEGER NOT NULL DEFAULT 0 CHECK(size_bytes>=0);
CREATE TABLE makeup_decisions (
 tenant_id TEXT NOT NULL REFERENCES tenants(id), id TEXT NOT NULL,
 skipped INTEGER NOT NULL CHECK(skipped IN(0,1)),reason TEXT NOT NULL DEFAULT '',
 version INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,created_by TEXT NOT NULL,
 updated_at INTEGER NOT NULL,updated_by TEXT NOT NULL,
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,id) REFERENCES lesson_participants(tenant_id,id)
);
