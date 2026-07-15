import { createRequire } from "node:module";
import { pool } from "./db.js";
import { env } from "./env.js";

const require = createRequire(import.meta.url);
const NodeMediaServer = require("node-media-server") as new (config: unknown) => {
  run: () => void;
  on: (
    event: "prePublish" | "postPublish" | "donePublish",
    callback: (session: RtmpSession) => void
  ) => void;
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

function sessionApp(session: RtmpSession) {
  const app = session.streamApp?.replace(/^\/+/, "");

  if (app) {
    return app;
  }

  return session.streamPath?.split("/").filter(Boolean)[0] ?? "";
}

function sessionStreamName(session: RtmpSession) {
  const streamName = session.streamName || session.streamPath?.split("/").filter(Boolean).at(-1);

  return streamName ? decodeURIComponent(streamName) : "";
}

async function findRtmpCamera(streamName: string) {
  const result = await pool.query(
    `
      SELECT c.id, c.status, t.status AS tenant_status
      FROM cameras c
      INNER JOIN tenants t ON t.id = c.tenant_id
      WHERE c.source_type = 'rtmp'
        AND (
          c.rtsp_url = $1
          OR regexp_replace(c.rtsp_url, '^.*/', '') = $2
        )
      LIMIT 1
    `,
    [buildLocalRtmpUrl(streamName), streamName]
  );

  return result.rows[0] as
    | {
        id: string;
        status: string;
        tenant_status: string;
      }
    | undefined;
}

async function validatePublish(session: RtmpSession) {
  const app = sessionApp(session);
  const streamName = sessionStreamName(session);

  if (app !== env.RTMP_APP || !streamName) {
    closePublish(session, "app or stream key invalid");
    return;
  }

  const camera = await findRtmpCamera(streamName);

  if (!camera) {
    console.warn(
      `[rtmp] publish allowed without registered camera: ${session.streamPath ?? streamName}`
    );
    return;
  }

  if (camera.status === "inactive" || camera.tenant_status !== "active") {
    const reason = "camera or client inactive";

    if (env.RTMP_REJECT_INACTIVE_PUBLISH) {
      closePublish(session, reason);
      return;
    }

    console.warn(
      `[rtmp] publish ignored ${session.streamPath ?? streamName}: ${reason}`
    );
  }
}

async function updatePublishStatus(session: RtmpSession, status: "online" | "offline") {
  const app = sessionApp(session);
  const streamName = sessionStreamName(session);

  if (app !== env.RTMP_APP || !streamName) {
    return;
  }

  const camera = await findRtmpCamera(streamName);

  if (!camera || camera.status === "inactive") {
    return;
  }

  await pool.query(
    `
      UPDATE cameras
      SET status = $2, updated_at = NOW()
      WHERE id = $1
        AND status <> 'inactive'
    `,
    [camera.id, status]
  );

  console.info(`[rtmp] camera ${camera.id} marked ${status} from stream ${streamName}`);
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

  server.on("postPublish", (session) => {
    void updatePublishStatus(session, "online").catch((error) => {
      console.error("[rtmp] publish status update failed", error);
    });
  });

  server.on("donePublish", (session) => {
    void updatePublishStatus(session, "offline").catch((error) => {
      console.error("[rtmp] publish status update failed", error);
    });
  });

  server.run();
}

function normalizedRtmpPathPrefix() {
  return env.RTMP_PATH_PREFIX.trim().replace(/^\/+|\/+$/g, "");
}

export function buildLocalRtmpUrl(streamKey: string) {
  const prefix = normalizedRtmpPathPrefix();
  const path = prefix ? `${prefix}/${streamKey}` : streamKey;

  return `rtmp://127.0.0.1:${env.RTMP_PORT}/${path}`;
}

export function normalizeRtmpStreamKey(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
