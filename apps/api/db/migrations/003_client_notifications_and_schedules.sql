ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS notification_mode TEXT NOT NULL DEFAULT 'all_events';

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS work_days JSONB NOT NULL DEFAULT '["mon", "tue", "wed", "thu", "fri"]'::jsonb,
  ADD COLUMN IF NOT EXISTS entry_time TIME,
  ADD COLUMN IF NOT EXISTS exit_time TIME,
  ADD COLUMN IF NOT EXISTS tolerance_minutes INTEGER NOT NULL DEFAULT 10;

CREATE TABLE IF NOT EXISTS tenant_notification_contacts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  telegram_chat_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tenant_notification_contacts_tenant_id
  ON tenant_notification_contacts(tenant_id);
