CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  plan TEXT NOT NULL DEFAULT 'local',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cameras (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  rtsp_url TEXT NOT NULL,
  location TEXT NOT NULL,
  sector TEXT,
  status TEXT NOT NULL DEFAULT 'configured',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  full_name TEXT NOT NULL,
  cpf TEXT,
  registration TEXT,
  phone TEXT,
  department TEXT,
  role TEXT,
  telegram TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS detection_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  camera_id TEXT NOT NULL REFERENCES cameras(id),
  event_type TEXT NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL,
  face_count INTEGER NOT NULL DEFAULT 0,
  confidence DOUBLE PRECISION,
  snapshot_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cameras_tenant_id
  ON cameras(tenant_id);

CREATE INDEX IF NOT EXISTS idx_employees_tenant_id
  ON employees(tenant_id);

CREATE INDEX IF NOT EXISTS idx_detection_events_tenant_detected_at
  ON detection_events(tenant_id, detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_detection_events_camera_detected_at
  ON detection_events(camera_id, detected_at DESC);

