import { buildApp } from "./app.js";
import { ensureLocalSeed } from "./bootstrap.js";
import { env } from "./env.js";
import { startRtmpServer } from "./rtmp.js";

const app = await buildApp();

await ensureLocalSeed();
startRtmpServer();

await app.listen({
  host: "0.0.0.0",
  port: env.API_PORT
});
