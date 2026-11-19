-- Supervisor-only full restore staging and per-user inbox postponement.
CREATE TABLE full_backup_files (
 tenant_id TEXT NOT NULL REFERENCES tenants(id), id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN('manual','pre_restore')), at INTEGER NOT NULL,
 r2_key TEXT NOT NULL, schema_version INTEGER NOT NULL, counts_json TEXT NOT NULL CHECK(json_valid(counts_json)),
 PRIMARY KEY(tenant_id,id)
);
CREATE TABLE restore_previews (
 tenant_id TEXT NOT NULL REFERENCES tenants(id),id TEXT NOT NULL,owner_id TEXT NOT NULL,
 created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN('ready','applying','done')),
 object_key TEXT NOT NULL,document_hash TEXT NOT NULL,counts_json TEXT NOT NULL,
 pre_backup_id TEXT,completed_at INTEGER,PRIMARY KEY(tenant_id,id)
);
CREATE UNIQUE INDEX one_full_restore ON restore_previews(tenant_id) WHERE status='applying';
CREATE TABLE todo_snoozes (
 tenant_id TEXT NOT NULL REFERENCES tenants(id),user_id TEXT NOT NULL,item_key TEXT NOT NULL,
 source_version TEXT NOT NULL,until_at INTEGER NOT NULL,version INTEGER NOT NULL DEFAULT 1,
 created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
 PRIMARY KEY(tenant_id,user_id,item_key),FOREIGN KEY(tenant_id,user_id) REFERENCES users(tenant_id,id)
);
CREATE INDEX todo_snooze_until ON todo_snoozes(tenant_id,user_id,until_at);
