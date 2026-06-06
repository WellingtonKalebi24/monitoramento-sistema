import cors from "@fastify/cors";
import staticPlugin from "@fastify/static";
import Fastify from "fastify";
import { uploadsDir, ensureUploadDirs } from "./files.js";
import { registerRoutes } from "./routes.js";

export async function buildApp() {
  await ensureUploadDirs();

  const app = Fastify({
    logger: true
  });

  await app.register(cors, {
    origin: true
  });

  await app.register(staticPlugin, {
    root: uploadsDir,
    prefix: "/uploads/"
  });

  await app.register(registerRoutes);

  return app;
}
