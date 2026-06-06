ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS subscription_status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS subscription_due_date TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS employee_limit INTEGER NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS camera_limit INTEGER NOT NULL DEFAULT 10;

ALTER TABLE cameras
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'general';

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT,
  ADD COLUMN IF NOT EXISTS work_schedule TEXT;

ALTER TABLE detection_events
  ADD COLUMN IF NOT EXISTS employee_id TEXT REFERENCES employees(id);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS employee_faces (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  embedding JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS access_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  employee_id TEXT NOT NULL REFERENCES employees(id),
  camera_id TEXT NOT NULL REFERENCES cameras(id),
  event_type TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  confidence DOUBLE PRECISION,
  snapshot_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_tenant_id
  ON users(tenant_id);

CREATE INDEX IF NOT EXISTS idx_employee_faces_employee_id
  ON employee_faces(employee_id);

CREATE INDEX IF NOT EXISTS idx_access_events_tenant_occurred_at
  ON access_events(tenant_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_access_events_employee_occurred_at
  ON access_events(employee_id, occurred_at DESC);

