import { buildApp } from "./app.js";
import { ensureLocalSeed } from "./bootstrap.js";
import { env } from "./env.js";
import { startRtmpServer } from "./rtmp.js";
import { startTelegramConnectionWorker } from "./telegram-worker.js";

const app = await buildApp();

await ensureLocalSeed();

const stopTelegramWorker = startTelegramConnectionWorker({
  info: (message) => app.log.info(message),
  error: (error, message) => app.log.error(error, message)
});

app.addHook("onClose", async () => {
  stopTelegramWorker();
});

if (env.RTMP_SERVER_ENABLED) {
  startRtmpServer();
} else {
  app.log.info("RTMP interno desativado; use MediaMTX/nginx-rtmp na porta configurada.");
}

await app.listen({
  host: "0.0.0.0",
  port: env.API_PORT
});
