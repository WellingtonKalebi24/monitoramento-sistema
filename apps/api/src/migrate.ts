import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./db.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const migrationFiles = [
  "001_init.sql",
  "002_platform_expansion.sql",
  "003_client_notifications_and_schedules.sql",
  "004_face_embedding_model.sql",
  "005_camera_sources.sql"
];

for (const migrationFile of migrationFiles) {
  const migrationPath = join(currentDir, "..", "db", "migrations", migrationFile);
  const sql = await readFile(migrationPath, "utf8");
  await pool.query(sql);
  console.log(`Migration ${migrationFile} aplicada com sucesso.`);
}
await pool.end();
