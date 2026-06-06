import bcrypt from "bcryptjs";
import { pool } from "./db.js";
import { env } from "./env.js";

export async function ensureLocalSeed() {
  await pool.query(
    `
      INSERT INTO tenants (id, name, status, plan)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (id) DO NOTHING
    `,
    ["tenant-local", "MEIP Local", "active", "local"]
  );

  await pool.query(
    `
      INSERT INTO cameras (id, tenant_id, name, rtsp_url, location, sector, mode, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (id) DO UPDATE SET
        rtsp_url = EXCLUDED.rtsp_url,
        updated_at = NOW()
    `,
    [
      "camera-local-1",
      "tenant-local",
      "Câmera local 1",
      env.DEFAULT_RTSP_URL,
      "Ambiente local",
      "Monitoramento",
      "entry",
      "configured"
    ]
  );

  const passwordHash = await bcrypt.hash("admin123", 10);

  await pool.query(
    `
      INSERT INTO users (id, tenant_id, name, email, password_hash, role, status)
      VALUES
        ($1, NULL, $2, $3, $4, $5, 'active'),
        ($6, $7, $8, $9, $10, $11, 'active')
      ON CONFLICT (email) DO NOTHING
    `,
    [
      "user-master-local",
      "Administrador Master",
      "master@meip.local",
      passwordHash,
      "master_admin",
      "user-tenant-local",
      "tenant-local",
      "Administrador Cliente",
      "cliente@meip.local",
      passwordHash,
      "tenant_admin"
    ]
  );
}
