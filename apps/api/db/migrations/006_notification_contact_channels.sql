ALTER TABLE tenant_notification_contacts
  ADD COLUMN IF NOT EXISTS notify_telegram BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_email BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE TABLE IF NOT EXISTS tenant_notification_contact_cameras (
  contact_id TEXT NOT NULL REFERENCES tenant_notification_contacts(id) ON DELETE CASCADE,
  camera_id TEXT NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  PRIMARY KEY (contact_id, camera_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_notification_contact_cameras_camera_id
  ON tenant_notification_contact_cameras(camera_id);
