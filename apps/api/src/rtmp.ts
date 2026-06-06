import { createRequire } from "node:module";
import { pool } from "./db.js";
import { env } from "./env.js";

const require = createRequire(import.meta.url);
const NodeMediaServer = require("node-media-server") as new (config: unknown) => {
  run: () => void;
  on: (event: "prePublish", callback: (session: RtmpSession) => void) => void;
};

let started = false;

type RtmpSession = {
  id?: string;
  streamApp?: string;
  streamName?: string;
  streamPath?: string;
  close?: () => void;
  socket?: {
    end: () => void;
  };
};

function closePublish(session: RtmpSession, reason: string) {
  console.warn(`[rtmp] publish rejected ${session.streamPath ?? ""}: ${reason}`);

  if (typeof session.close === "function") {
    session.close();
    return;
  }

  session.socket?.end();
}

async function validatePublish(session: RtmpSession) {
  const streamName = session.streamName;

  if (session.streamApp !== env.RTMP_APP || !streamName) {
    closePublish(session, "app or stream key invalid");
    return;
  }

  const result = await pool.query(
    `
      SELECT c.id, c.status, t.status AS tenant_status
      FROM cameras c
      INNER JOIN tenants t ON t.id = c.tenant_id
      WHERE c.source_type = 'rtmp'
        AND c.rtsp_url = $1
      LIMIT 1
    `,
    [buildLocalRtmpUrl(streamName)]
  );
  const camera = result.rows[0];

  if (!camera) {
    closePublish(session, "stream key not registered");
    return;
  }

  if (camera.status === "inactive" || camera.tenant_status !== "active") {
    closePublish(session, "camera or client inactive");
  }
}

export function startRtmpServer() {
  if (started) {
    return;
  }

  started = true;
  const server = new NodeMediaServer({
    bind: "0.0.0.0",
    auth: {
      play: false,
      publish: false
    },
    rtmp: {
      port: env.RTMP_PORT
    }
  });

  server.on("prePublish", (session) => {
    void validatePublish(session).catch((error) => {
      console.error("[rtmp] publish validation failed", error);
      closePublish(session, "validation error");
    });
  });

  server.run();
}

export function buildLocalRtmpUrl(streamKey: string) {
  return `rtmp://127.0.0.1:${env.RTMP_PORT}/${env.RTMP_APP}/${streamKey}`;
}
