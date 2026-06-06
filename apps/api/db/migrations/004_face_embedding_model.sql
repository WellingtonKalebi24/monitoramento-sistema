ALTER TABLE employee_faces
  ADD COLUMN IF NOT EXISTS embedding_model TEXT NOT NULL DEFAULT 'legacy_simple_v1';
