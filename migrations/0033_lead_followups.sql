-- 线索回访记录（第三期 DECISIONS 9）：谁、何时、方式、内容、下次回访日期。
-- 只追加：写入时同一批次更新线索的 next_followup（及阶段），旧备注里的回访行继续只读显示。
CREATE TABLE lead_followups (
 tenant_id TEXT NOT NULL REFERENCES tenants(id), id TEXT NOT NULL,
 lead_id TEXT NOT NULL, actor_id TEXT NOT NULL,
 at TEXT NOT NULL,
 channel TEXT NOT NULL DEFAULT 'phone' CHECK(channel IN('phone','wechat','visit','other')),
 content TEXT NOT NULL DEFAULT '',
 next_followup TEXT,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,lead_id) REFERENCES leads(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES users(tenant_id,id)
);
CREATE INDEX lead_followups_by_lead ON lead_followups(tenant_id,lead_id,at DESC,created_at DESC);
