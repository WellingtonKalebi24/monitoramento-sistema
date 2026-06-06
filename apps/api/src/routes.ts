import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AuthUser, requireAuth, signToken, tenantScope } from "./auth.js";
import { pool } from "./db.js";
import { env } from "./env.js";
import { removeStoredFace, saveFaceDataUrl } from "./files.js";
import { buildLocalRtmpUrl } from "./rtmp.js";
import {
  buildTelegramConnectLink,
  findTelegramChatId,
  sendTelegramAlert
} from "./telegram.js";

const ACTIVE_EMBEDDING_MODEL = "opencv_sface_2021dec_v1";
type AccessEventType = "entry" | "exit" | "permanence";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

const tenantSchema = z.object({
  name: z.string().min(2),
  status: z.enum(["active", "inactive"]).default("active"),
  plan: z.string().min(1).default("local"),
  subscriptionStatus: z.string().min(1).default("active"),
  subscriptionDueDate: z.string().datetime().nullable().optional(),
  employeeLimit: z.number().int().positive().default(50),
  cameraLimit: z.number().int().positive().default(10),
  adminName: z.string().min(2),
  adminEmail: z.string().email(),
  adminPassword: z.string().min(6)
});

const tenantUpdateSchema = z.object({
  name: z.string().min(2).optional(),
  status: z.enum(["active", "inactive"]).optional(),
  plan: z.string().min(1).optional(),
  subscriptionStatus: z.string().min(1).optional(),
  subscriptionDueDate: z.string().datetime().nullable().optional(),
  employeeLimit: z.number().int().positive().optional(),
  cameraLimit: z.number().int().positive().optional(),
  adminName: z.string().min(2).optional(),
  adminEmail: z.string().email().optional(),
  adminPassword: z.string().min(6).optional()
});

const employeeSchema = z.object({
  fullName: z.string().min(2),
  cpf: z.string().optional().nullable(),
  registration: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  department: z.string().optional().nullable(),
  role: z.string().optional().nullable(),
  workSchedule: z.string().optional().nullable(),
  workDays: z
    .array(z.enum(["sun", "mon", "tue", "wed", "thu", "fri", "sat"]))
    .default(["mon", "tue", "wed", "thu", "fri"]),
  entryTime: z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
  exitTime: z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
  toleranceMinutes: z.number().int().min(0).max(180).default(10),
  status: z.enum(["active", "inactive"]).default("active")
});

const notificationSettingsSchema = z.object({
  notificationMode: z.enum(["all_events", "exceptions_only"])
});

const notificationContactSchema = z.object({
  name: z.string().min(2),
  status: z.enum(["active", "inactive"]).default("active")
});

const employeeFaceSchema = z.object({
  imageDataUrl: z.string().min(20)
});

const cameraFieldsSchema = z.object({
  name: z.string().min(2),
  sourceType: z.enum(["rtsp", "rtmp", "webcam"]).default("rtsp"),
  rtspUrl: z.string().trim().optional().nullable(),
  deviceIndex: z.coerce.number().int().min(0).max(20).optional().nullable(),
  location: z.string().min(2),
  sector: z.string().optional().nullable(),
  mode: z.enum(["entry", "exit", "general"]).default("general"),
  status: z.enum(["configured", "online", "offline", "inactive"]).default("configured")
});

const cameraSchema = cameraFieldsSchema.superRefine((camera, context) => {
  if (camera.sourceType === "rtsp" && (!camera.rtspUrl || camera.rtspUrl.length < 4)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["rtspUrl"],
      message: "Informe a URL RTSP da câmera."
    });
  }
});

const monitoringEventSchema = z.object({
  cameraId: z.string().min(1),
  employeeId: z.string().optional().nullable(),
  detectedAt: z.string().datetime({ offset: true }),
  faceCount: z.number().int().nonnegative().default(0),
  confidence: z
    .number()
    .finite()
    .optional()
    .nullable()
    .transform((value) => (value == null ? value : Math.min(1, Math.max(0, value)))),
  snapshotUrl: z.string().url().optional().nullable()
});

function unauthorized(reply: FastifyReply) {
  return reply.status(401).send({ message: "Não autenticado" });
}

function forbidden(reply: FastifyReply) {
  return reply.status(403).send({ message: "Acesso negado" });
}

function internalAuthorized(request: FastifyRequest) {
  return request.headers["x-internal-key"] === env.INTERNAL_API_KEY;
}

function getTenantId(user: AuthUser, request: FastifyRequest) {
  const query = request.query as { tenantId?: string };
  return tenantScope(user, query.tenantId);
}

function requireMaster(user: AuthUser, reply: FastifyReply) {
  if (user.role !== "master_admin") {
    forbidden(reply);
    return false;
  }

  return true;
}

function cameraModeEventType(mode?: "entry" | "exit" | "general" | null): AccessEventType {
  const modes: Record<"entry" | "exit" | "general", AccessEventType> = {
    entry: "entry",
    exit: "exit",
    general: "permanence"
  };

  return modes[mode ?? "general"] ?? "permanence";
}

function timeInMinutes(value?: string | null) {
  if (!value) {
    return null;
  }

  const [hours, minutes] = value.slice(0, 5).split(":").map(Number);
  return hours * 60 + minutes;
}

function localWorkday(occurredAt: Date) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    timeZone: "America/Sao_Paulo"
  })
    .format(occurredAt)
    .slice(0, 3)
    .toLowerCase();
}

function localTimeMinutes(occurredAt: Date) {
  const currentTime = new Intl.DateTimeFormat("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "America/Sao_Paulo"
  }).format(occurredAt);

  return timeInMinutes(currentTime) ?? 0;
}

function isEmployeeWorkday(employee: { work_days?: string[] }, occurredAt: Date) {
  const workDays = employee.work_days ?? [];
  return workDays.length === 0 || workDays.includes(localWorkday(occurredAt));
}

async function employeeEventExistsToday(
  employeeId: string,
  eventType: "entry" | "exit",
  occurredAt: Date
) {
  const result = await pool.query(
    `
      SELECT id
      FROM access_events
      WHERE employee_id = $1
        AND event_type = $2
        AND (occurred_at AT TIME ZONE 'America/Sao_Paulo')::date =
          ($3::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date
      LIMIT 1
    `,
    [employeeId, eventType, occurredAt]
  );

  return Boolean(result.rows[0]);
}

async function scheduledEventType(
  camera: { mode: "entry" | "exit" | "general" },
  employee: {
    id: string;
    work_days?: string[];
    entry_time?: string | null;
    exit_time?: string | null;
    tolerance_minutes?: number;
  },
  occurredAt: Date
): Promise<AccessEventType> {
  if (camera.mode !== "general") {
    return cameraModeEventType(camera.mode);
  }

  if (!isEmployeeWorkday(employee, occurredAt)) {
    return "permanence";
  }

  const currentMinutes = localTimeMinutes(occurredAt);
  const tolerance = employee.tolerance_minutes ?? 10;
  const entryMinutes = timeInMinutes(employee.entry_time);
  const exitMinutes = timeInMinutes(employee.exit_time);
  const [hasEntryToday, hasExitToday] = await Promise.all([
    employeeEventExistsToday(employee.id, "entry", occurredAt),
    employeeEventExistsToday(employee.id, "exit", occurredAt)
  ]);

  if (entryMinutes != null && !hasEntryToday) {
    const beforeExitWindow = exitMinutes == null || currentMinutes < exitMinutes - tolerance;
    const insideEntryTolerance = currentMinutes <= entryMinutes + tolerance;

    if (beforeExitWindow || insideEntryTolerance) {
      return "entry";
    }
  }

  if (exitMinutes != null && !hasExitToday && currentMinutes >= exitMinutes - tolerance) {
    return "exit";
  }

  return "permanence";
}

function eventAnomaly(
  eventType: string,
  employee: {
    work_days?: string[];
    entry_time?: string | null;
    exit_time?: string | null;
    tolerance_minutes?: number;
  },
  occurredAt: Date
) {
  const localDate = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    timeZone: "America/Sao_Paulo"
  })
    .format(occurredAt)
    .slice(0, 3)
    .toLowerCase();
  const workDays = employee.work_days ?? [];

  if (workDays.length > 0 && !workDays.includes(localDate)) {
    return "Detecção fora dos dias previstos.";
  }

  const currentTime = new Intl.DateTimeFormat("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "America/Sao_Paulo"
  }).format(occurredAt);
  const currentMinutes = timeInMinutes(currentTime) ?? 0;
  const tolerance = employee.tolerance_minutes ?? 10;
  const entryMinutes = timeInMinutes(employee.entry_time);
  const exitMinutes = timeInMinutes(employee.exit_time);

  if (eventType === "entry" && entryMinutes != null && currentMinutes > entryMinutes + tolerance) {
    return "Entrada registrada após o horário previsto.";
  }

  if (eventType === "exit" && exitMinutes != null && currentMinutes < exitMinutes - tolerance) {
    return "Saída registrada antes do horário previsto.";
  }

  return null;
}

async function notifyTenant(
  tenantId: string,
  input: Parameters<typeof sendTelegramAlert>[0],
  alwaysNotify = false
) {
  const [tenant, contacts] = await Promise.all([
    pool.query(`SELECT notification_mode FROM tenants WHERE id = $1`, [tenantId]),
    pool.query(
      `
        SELECT telegram_chat_id
        FROM tenant_notification_contacts
        WHERE tenant_id = $1
          AND status = 'active'
          AND telegram_chat_id IS NOT NULL
      `,
      [tenantId]
    )
  ]);

  if (
    !alwaysNotify &&
    tenant.rows[0]?.notification_mode === "exceptions_only" &&
    !input.anomaly
  ) {
    return;
  }

  await Promise.all(
    contacts.rows.map((contact) =>
      sendTelegramAlert({
        ...input,
        chatId: contact.telegram_chat_id
      })
    )
  );
}

export async function registerRoutes(app: FastifyInstance) {
  app.get("/health", async () => ({ status: "ok" }));

  app.post("/auth/login", async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const result = await pool.query(
      `
        SELECT
          u.id,
          u.tenant_id AS "tenantId",
          u.name,
          u.email,
          u.password_hash AS "passwordHash",
          u.role,
          u.status,
          t.status AS "tenantStatus"
        FROM users u
        LEFT JOIN tenants t ON t.id = u.tenant_id
        WHERE u.email = $1
        LIMIT 1
      `,
      [body.email.toLowerCase()]
    );

    const user = result.rows[0];

    if (!user || user.status !== "active") {
      return unauthorized(reply);
    }

    if (user.role !== "master_admin" && user.tenantStatus !== "active") {
      return unauthorized(reply);
    }

    const validPassword = await bcrypt.compare(body.password, user.passwordHash);

    if (!validPassword) {
      return unauthorized(reply);
    }

    const authUser: AuthUser = {
      id: user.id,
      tenantId: user.tenantId,
      name: user.name,
      email: user.email,
      role: user.role
    };

    return {
      token: signToken(authUser),
      user: authUser
    };
  });

  app.get("/auth/me", async (request, reply) => {
    try {
      return requireAuth(request);
    } catch {
      return unauthorized(reply);
    }
  });

  app.get("/master/summary", async (request, reply) => {
    let user: AuthUser;
    try {
      user = requireAuth(request);
    } catch {
      return unauthorized(reply);
    }

    if (user.role !== "master_admin") {
      return forbidden(reply);
    }

    const [tenants, detections, employees, camerasOnline, activeClients] =
      await Promise.all([
        pool.query(`SELECT COUNT(*)::int AS count FROM tenants`),
        pool.query(`SELECT COUNT(*)::int AS count FROM detection_events`),
        pool.query(`SELECT COUNT(*)::int AS count FROM employees WHERE status <> 'deleted'`),
        pool.query(`SELECT COUNT(*)::int AS count FROM cameras WHERE status = 'online'`),
        pool.query(`SELECT COUNT(*)::int AS count FROM tenants WHERE status = 'active'`)
      ]);

    return {
      tenantCount: tenants.rows[0].count,
      detectionCount: detections.rows[0].count,
      employeeCount: employees.rows[0].count,
      camerasOnline: camerasOnline.rows[0].count,
      activeClients: activeClients.rows[0].count
    };
  });

  app.get("/tenants", async (request, reply) => {
    let user: AuthUser;
    try {
      user = requireAuth(request);
    } catch {
      return unauthorized(reply);
    }

    if (user.role !== "master_admin") {
      return forbidden(reply);
    }

    const result = await pool.query(
      `
        SELECT
          t.id,
          t.name,
          t.status,
          t.plan,
          t.subscription_status AS "subscriptionStatus",
          t.subscription_due_date AS "subscriptionDueDate",
          t.employee_limit AS "employeeLimit",
          t.camera_limit AS "cameraLimit",
          t.created_at AS "createdAt",
          u.name AS "adminName",
          u.email AS "adminEmail"
        FROM tenants t
        LEFT JOIN LATERAL (
          SELECT name, email
          FROM users
          WHERE tenant_id = t.id
            AND role = 'tenant_admin'
          ORDER BY created_at ASC
          LIMIT 1
        ) u ON TRUE
        ORDER BY t.created_at DESC
      `
    );

    return result.rows;
  });

  app.post("/tenants", async (request, reply) => {
    let user: AuthUser;
    try {
      user = requireAuth(request);
    } catch {
      return unauthorized(reply);
    }

    if (user.role !== "master_admin") {
      return forbidden(reply);
    }

    const body = tenantSchema.parse(request.body);
    const tenantId = randomUUID();
    const tenantAdminId = randomUUID();
    const passwordHash = await bcrypt.hash(body.adminPassword, 10);
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      const tenantResult = await client.query(
        `
          INSERT INTO tenants (
            id,
            name,
            status,
            plan,
            subscription_status,
            subscription_due_date,
            employee_limit,
            camera_limit
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING
            id,
            name,
            status,
            plan,
            subscription_status AS "subscriptionStatus",
            subscription_due_date AS "subscriptionDueDate",
            employee_limit AS "employeeLimit",
            camera_limit AS "cameraLimit",
            created_at AS "createdAt"
        `,
        [
          tenantId,
          body.name,
          body.status,
          body.plan,
          body.subscriptionStatus,
          body.subscriptionDueDate ? new Date(body.subscriptionDueDate) : null,
          body.employeeLimit,
          body.cameraLimit
        ]
      );

      await client.query(
        `
          INSERT INTO users (
            id,
            tenant_id,
            name,
            email,
            password_hash,
            role,
            status
          )
          VALUES ($1, $2, $3, $4, $5, 'tenant_admin', 'active')
        `,
        [
          tenantAdminId,
          tenantId,
          body.adminName,
          body.adminEmail.toLowerCase(),
          passwordHash
        ]
      );

      await client.query("COMMIT");

      return reply.status(201).send({
        ...tenantResult.rows[0],
        adminName: body.adminName,
        adminEmail: body.adminEmail.toLowerCase()
      });
    } catch (error) {
      await client.query("ROLLBACK");

      if ((error as { code?: string }).code === "23505") {
        return reply.status(409).send({ message: "Este e-mail de acesso já está em uso." });
      }

      throw error;
    } finally {
      client.release();
    }
  });

  app.patch("/tenants/:id", async (request, reply) => {
    let user: AuthUser;
    try {
      user = requireAuth(request);
    } catch {
      return unauthorized(reply);
    }

    if (user.role !== "master_admin") {
      return forbidden(reply);
    }

    const body = tenantUpdateSchema.parse(request.body);
    const params = request.params as { id: string };
    const passwordHash = body.adminPassword ? await bcrypt.hash(body.adminPassword, 10) : null;
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const tenantResult = await client.query(
        `
          UPDATE tenants
          SET
            name = COALESCE($2, name),
            status = COALESCE($3, status),
            plan = COALESCE($4, plan),
            subscription_status = COALESCE($5, subscription_status),
            subscription_due_date = COALESCE($6, subscription_due_date),
            employee_limit = COALESCE($7, employee_limit),
            camera_limit = COALESCE($8, camera_limit)
          WHERE id = $1
          RETURNING
            id,
            name,
            status,
            plan,
            subscription_status AS "subscriptionStatus",
            subscription_due_date AS "subscriptionDueDate",
            employee_limit AS "employeeLimit",
            camera_limit AS "cameraLimit",
            created_at AS "createdAt"
        `,
        [
          params.id,
          body.name ?? null,
          body.status ?? null,
          body.plan ?? null,
          body.subscriptionStatus ?? null,
          body.subscriptionDueDate ? new Date(body.subscriptionDueDate) : null,
          body.employeeLimit ?? null,
          body.cameraLimit ?? null
        ]
      );

      if (!tenantResult.rows[0]) {
        await client.query("ROLLBACK");
        return reply.status(404).send({ message: "Cliente nao encontrado" });
      }

      if (body.adminName || body.adminEmail || passwordHash || body.status) {
        await client.query(
          `
            UPDATE users
            SET
              name = COALESCE($2, name),
              email = COALESCE($3, email),
              password_hash = COALESCE($4, password_hash),
              status = COALESCE($5, status)
            WHERE id = (
              SELECT id
              FROM users
              WHERE tenant_id = $1
                AND role = 'tenant_admin'
              ORDER BY created_at ASC
              LIMIT 1
            )
          `,
          [
            params.id,
            body.adminName ?? null,
            body.adminEmail?.toLowerCase() ?? null,
            passwordHash,
            body.status ?? null
          ]
        );
      }

      const result = await client.query(
        `
          SELECT
            t.id,
            t.name,
            t.status,
            t.plan,
            t.subscription_status AS "subscriptionStatus",
            t.subscription_due_date AS "subscriptionDueDate",
            t.employee_limit AS "employeeLimit",
            t.camera_limit AS "cameraLimit",
            t.created_at AS "createdAt",
            u.name AS "adminName",
            u.email AS "adminEmail"
          FROM tenants t
          LEFT JOIN LATERAL (
            SELECT name, email
            FROM users
            WHERE tenant_id = t.id
              AND role = 'tenant_admin'
            ORDER BY created_at ASC
            LIMIT 1
          ) u ON TRUE
          WHERE t.id = $1
        `,
        [params.id]
      );

      await client.query("COMMIT");
      return result.rows[0];
    } catch (error) {
      await client.query("ROLLBACK");

      if ((error as { code?: string }).code === "23505") {
        return reply.status(409).send({ message: "Este e-mail de acesso ja esta em uso." });
      }

      throw error;
    } finally {
      client.release();
    }
  });

  app.delete("/tenants/:id", async (request, reply) => {
    let user: AuthUser;
    try {
      user = requireAuth(request);
    } catch {
      return unauthorized(reply);
    }

    if (user.role !== "master_admin") {
      return forbidden(reply);
    }

    const params = request.params as { id: string };
    await pool.query(
      `
        UPDATE tenants
        SET status = 'inactive'
        WHERE id = $1
      `,
      [params.id]
    );

    return reply.status(204).send();
  });

  app.get("/dashboard/summary", async (request, reply) => {
    let user: AuthUser;
    try {
      user = requireAuth(request);
    } catch {
      return unauthorized(reply);
    }

    const tenantId = getTenantId(user, request);

    if (!tenantId) {
      return forbidden(reply);
    }

    const [
      entriesToday,
      exitsToday,
      presentEmployees,
      employeeCount,
      camerasOnline,
      latestDetections,
      dailyChart,
      monthlyChart,
      yearlyChart
    ] = await Promise.all([
      pool.query(
        `
          SELECT COUNT(*)::int AS count
          FROM access_events
          WHERE tenant_id = $1
            AND event_type = 'entry'
            AND occurred_at >= date_trunc('day', NOW())
        `,
        [tenantId]
      ),
      pool.query(
        `
          SELECT COUNT(*)::int AS count
          FROM access_events
          WHERE tenant_id = $1
            AND event_type = 'exit'
            AND occurred_at >= date_trunc('day', NOW())
        `,
        [tenantId]
      ),
      pool.query(
        `
          WITH latest AS (
            SELECT DISTINCT ON (employee_id)
              employee_id,
              event_type
            FROM access_events
            WHERE tenant_id = $1
            ORDER BY employee_id, occurred_at DESC
          )
          SELECT COUNT(*)::int AS count
          FROM latest
          WHERE event_type IN ('entry', 'permanence')
        `,
        [tenantId]
      ),
      pool.query(`SELECT COUNT(*)::int AS count FROM employees WHERE tenant_id = $1 AND status <> 'deleted'`, [
        tenantId
      ]),
      pool.query(
        `SELECT COUNT(*)::int AS count FROM cameras WHERE tenant_id = $1 AND status = 'online'`,
        [tenantId]
      ),
      pool.query(
        `
          SELECT
            d.id,
            d.detected_at AS "detectedAt",
            d.event_type AS "eventType",
            d.confidence,
            d.snapshot_url AS "snapshotUrl",
            json_build_object(
              'id', c.id,
              'name', c.name,
              'location', c.location
            ) AS camera,
            CASE WHEN e.id IS NULL THEN NULL ELSE json_build_object(
              'id', e.id,
              'fullName', e.full_name
            ) END AS employee
          FROM detection_events d
          INNER JOIN cameras c ON c.id = d.camera_id
          LEFT JOIN employees e ON e.id = d.employee_id
          WHERE d.tenant_id = $1
          ORDER BY d.detected_at DESC
          LIMIT 8
        `,
        [tenantId]
      ),
      pool.query(
        `
          SELECT TO_CHAR(occurred_at, 'HH24:00') AS label, COUNT(*)::int AS value
          FROM access_events
          WHERE tenant_id = $1
            AND occurred_at >= date_trunc('day', NOW())
          GROUP BY 1
          ORDER BY 1
        `,
        [tenantId]
      ),
      pool.query(
        `
          SELECT TO_CHAR(date_trunc('day', occurred_at), 'DD/MM') AS label, COUNT(*)::int AS value
          FROM access_events
          WHERE tenant_id = $1
            AND occurred_at >= NOW() - INTERVAL '30 days'
          GROUP BY date_trunc('day', occurred_at)
          ORDER BY date_trunc('day', occurred_at)
        `,
        [tenantId]
      ),
      pool.query(
        `
          SELECT TO_CHAR(date_trunc('month', occurred_at), 'MM/YYYY') AS label, COUNT(*)::int AS value
          FROM access_events
          WHERE tenant_id = $1
            AND occurred_at >= NOW() - INTERVAL '12 months'
          GROUP BY date_trunc('month', occurred_at)
          ORDER BY date_trunc('month', occurred_at)
        `,
        [tenantId]
      )
    ]);

    return {
      entriesToday: entriesToday.rows[0].count,
      exitsToday: exitsToday.rows[0].count,
      presentEmployees: presentEmployees.rows[0].count,
      absentEmployees: Math.max(
        employeeCount.rows[0].count - presentEmployees.rows[0].count,
        0
      ),
      camerasOnline: camerasOnline.rows[0].count,
      latestDetections: latestDetections.rows,
      charts: {
        daily: dailyChart.rows,
        monthly: monthlyChart.rows,
        yearly: yearlyChart.rows
      }
    };
  });

  app.get("/employees", async (request, reply) => {
    let user: AuthUser;
    try {
      user = requireAuth(request);
    } catch {
      return unauthorized(reply);
    }

    const tenantId = getTenantId(user, request);

    if (!tenantId) {
      return forbidden(reply);
    }

    const result = await pool.query(
      `
        SELECT
          e.id,
          e.tenant_id AS "tenantId",
          e.full_name AS "fullName",
          e.cpf,
          e.registration,
          e.phone,
          e.department,
          e.role,
          e.work_schedule AS "workSchedule",
          e.work_days AS "workDays",
          TO_CHAR(e.entry_time, 'HH24:MI') AS "entryTime",
          TO_CHAR(e.exit_time, 'HH24:MI') AS "exitTime",
          e.tolerance_minutes AS "toleranceMinutes",
          e.status,
          e.created_at AS "createdAt",
          COUNT(f.id)::int AS "faceCount",
          COUNT(f.id) FILTER (WHERE f.embedding_model = $2)::int AS "recognitionFaceCount"
        FROM employees e
        LEFT JOIN employee_faces f ON f.employee_id = e.id
        WHERE e.tenant_id = $1
          AND e.status <> 'deleted'
        GROUP BY e.id
        ORDER BY e.created_at DESC
      `,
      [tenantId, ACTIVE_EMBEDDING_MODEL]
    );

    return result.rows;
  });

  app.post("/employees", async (request, reply) => {
    let user: AuthUser;
    try {
      user = requireAuth(request);
    } catch {
      return unauthorized(reply);
    }

    const tenantId = getTenantId(user, request);

    if (!tenantId) {
      return forbidden(reply);
    }

    const body = employeeSchema.parse(request.body);
    const result = await pool.query(
      `
        INSERT INTO employees (
          id,
          tenant_id,
          full_name,
          cpf,
          registration,
          phone,
          department,
          role,
          work_schedule,
          work_days,
          entry_time,
          exit_time,
          tolerance_minutes,
          status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14)
        RETURNING
          id,
          tenant_id AS "tenantId",
          full_name AS "fullName",
          cpf,
          registration,
          phone,
          department,
          role,
          work_schedule AS "workSchedule",
          work_days AS "workDays",
          TO_CHAR(entry_time, 'HH24:MI') AS "entryTime",
          TO_CHAR(exit_time, 'HH24:MI') AS "exitTime",
          tolerance_minutes AS "toleranceMinutes",
          status,
          created_at AS "createdAt"
      `,
      [
        randomUUID(),
        tenantId,
        body.fullName,
        body.cpf ?? null,
        body.registration ?? null,
        body.phone ?? null,
        body.department ?? null,
        body.role ?? null,
        body.workSchedule ?? null,
        JSON.stringify(body.workDays),
        body.entryTime ?? null,
        body.exitTime ?? null,
        body.toleranceMinutes,
        body.status
      ]
    );

    return reply.status(201).send(result.rows[0]);
  });

  app.patch("/employees/:id", async (request, reply) => {
    let user: AuthUser;
    try {
      user = requireAuth(request);
    } catch {
      return unauthorized(reply);
    }

    const tenantId = getTenantId(user, request);
    const body = employeeSchema.partial().parse(request.body);
    const params = request.params as { id: string };

    const result = await pool.query(
      `
        UPDATE employees
        SET
          full_name = COALESCE($3, full_name),
          cpf = COALESCE($4, cpf),
          registration = COALESCE($5, registration),
          phone = COALESCE($6, phone),
          department = COALESCE($7, department),
          role = COALESCE($8, role),
          work_schedule = COALESCE($9, work_schedule),
          work_days = COALESCE($10::jsonb, work_days),
          entry_time = COALESCE($11::time, entry_time),
          exit_time = COALESCE($12::time, exit_time),
          tolerance_minutes = COALESCE($13, tolerance_minutes),
          status = COALESCE($14, status)
        WHERE id = $1
          AND tenant_id = $2
        RETURNING
          id,
          tenant_id AS "tenantId",
          full_name AS "fullName",
          cpf,
          registration,
          phone,
          department,
          role,
          work_schedule AS "workSchedule",
          work_days AS "workDays",
          TO_CHAR(entry_time, 'HH24:MI') AS "entryTime",
          TO_CHAR(exit_time, 'HH24:MI') AS "exitTime",
          tolerance_minutes AS "toleranceMinutes",
          status,
          created_at AS "createdAt"
      `,
      [
        params.id,
        tenantId,
        body.fullName ?? null,
        body.cpf ?? null,
        body.registration ?? null,
        body.phone ?? null,
        body.department ?? null,
        body.role ?? null,
        body.workSchedule ?? null,
        body.workDays ? JSON.stringify(body.workDays) : null,
        body.entryTime ?? null,
        body.exitTime ?? null,
        body.toleranceMinutes ?? null,
        body.status ?? null
      ]
    );

    if (!result.rows[0]) {
      return reply.status(404).send({ message: "Funcionário não encontrado" });
    }

    return result.rows[0];
  });

  app.delete("/employees/:id", async (request, reply) => {
    let user: AuthUser;
    try {
      user = requireAuth(request);
    } catch {
      return unauthorized(reply);
    }

    const tenantId = getTenantId(user, request);
    const params = request.params as { id: string };
    if (!tenantId) {
      return forbidden(reply);
    }

    const client = await pool.connect();
    let storedImages: string[] = [];
    try {
      await client.query("BEGIN");
      const employee = await client.query(
        `SELECT id FROM employees WHERE id = $1 AND tenant_id = $2 AND status <> 'deleted'`,
        [params.id, tenantId]
      );
      if (!employee.rows[0]) {
        await client.query("ROLLBACK");
        return reply.status(404).send({ message: "Funcionário não encontrado" });
      }

      const faces = await client.query(
        `SELECT image_url FROM employee_faces WHERE employee_id = $1`,
        [params.id]
      );
      storedImages = faces.rows.map((row) => row.image_url);
      await client.query(`DELETE FROM employee_faces WHERE employee_id = $1`, [params.id]);
      await client.query(
        `UPDATE employees SET status = 'deleted' WHERE id = $1 AND tenant_id = $2`,
        [params.id, tenantId]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    await Promise.all(storedImages.map((imageUrl) => removeStoredFace(imageUrl)));
    return reply.status(204).send();
  });

  app.post("/employees/:id/faces", async (request, reply) => {
    let user: AuthUser;
    try {
      user = requireAuth(request);
    } catch {
      return unauthorized(reply);
    }

    const tenantId = getTenantId(user, request);
    const params = request.params as { id: string };
    const body = employeeFaceSchema.parse(request.body);
    const employee = await pool.query(
      `SELECT id FROM employees WHERE id = $1 AND tenant_id = $2`,
      [params.id, tenantId]
    );

    if (!employee.rows[0]) {
      return reply.status(404).send({ message: "Funcionário não encontrado" });
    }

    const embeddingResponse = await fetch(`${env.AI_BASE_URL}/embedding`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        imageDataUrl: body.imageDataUrl
      })
    });

    if (!embeddingResponse.ok) {
      const payload = await embeddingResponse.json().catch(() => ({}));
      return reply.status(400).send({
        message: payload.message ?? "Não foi possível gerar embedding facial"
      });
    }

    const embeddingPayload = (await embeddingResponse.json()) as {
      embedding: number[];
      model?: string;
    };
    if (embeddingPayload.model !== ACTIVE_EMBEDDING_MODEL) {
      return reply.status(503).send({
        message:
          "Serviço facial ainda não está no modelo local atual. Reinicie o serviço de IA e tente novamente."
      });
    }
    const saved = await saveFaceDataUrl(body.imageDataUrl);
    const result = await pool.query(
      `
        INSERT INTO employee_faces (id, employee_id, image_url, embedding, embedding_model)
        VALUES ($1, $2, $3, $4::jsonb, $5)
        RETURNING
          id,
          employee_id AS "employeeId",
          image_url AS "imageUrl",
          embedding_model AS "embeddingModel",
          created_at AS "createdAt"
      `,
      [
        randomUUID(),
        params.id,
        `${env.API_BASE_URL}${saved.imageUrl}`,
        JSON.stringify(embeddingPayload.embedding),
        ACTIVE_EMBEDDING_MODEL
      ]
    );

    return reply.status(201).send(result.rows[0]);
  });

  app.get("/notification-settings", async (request, reply) => {
    let user: AuthUser;
    try {
      user = requireAuth(request);
    } catch {
      return unauthorized(reply);
    }

    const tenantId = getTenantId(user, request);

    if (!tenantId) {
      return forbidden(reply);
    }

    const result = await pool.query(
      `SELECT notification_mode AS "notificationMode" FROM tenants WHERE id = $1`,
      [tenantId]
    );

    return result.rows[0] ?? { notificationMode: "all_events" };
  });

  app.patch("/notification-settings", async (request, reply) => {
    let user: AuthUser;
    try {
      user = requireAuth(request);
    } catch {
      return unauthorized(reply);
    }

    const tenantId = getTenantId(user, request);
    const body = notificationSettingsSchema.parse(request.body);

    if (!tenantId) {
      return forbidden(reply);
    }

    const result = await pool.query(
      `
        UPDATE tenants
        SET notification_mode = $2
        WHERE id = $1
        RETURNING notification_mode AS "notificationMode"
      `,
      [tenantId, body.notificationMode]
    );

    return result.rows[0];
  });

  app.get("/notification-contacts", async (request, reply) => {
    let user: AuthUser;
    try {
      user = requireAuth(request);
    } catch {
      return unauthorized(reply);
    }

    const tenantId = getTenantId(user, request);
    if (!tenantId) {
      return forbidden(reply);
    }

    const result = await pool.query(
      `
        SELECT
          id,
          name,
          status,
          (telegram_chat_id IS NOT NULL) AS connected,
          created_at AS "createdAt"
        FROM tenant_notification_contacts
        WHERE tenant_id = $1
        ORDER BY created_at DESC
      `,
      [tenantId]
    );

    return result.rows;
  });

  app.post("/notification-contacts", async (request, reply) => {
    let user: AuthUser;
    try {
      user = requireAuth(request);
    } catch {
      return unauthorized(reply);
    }

    const tenantId = getTenantId(user, request);
    const body = notificationContactSchema.parse(request.body);
    if (!tenantId) {
      return forbidden(reply);
    }

    const result = await pool.query(
      `
        INSERT INTO tenant_notification_contacts (id, tenant_id, name, status)
        VALUES ($1, $2, $3, $4)
        RETURNING id, name, status, false AS connected, created_at AS "createdAt"
      `,
      [randomUUID(), tenantId, body.name, body.status]
    );

    return reply.status(201).send(result.rows[0]);
  });

  app.get("/notification-contacts/:id/telegram/connect-link", async (request, reply) => {
    let user: AuthUser;
    try {
      user = requireAuth(request);
    } catch {
      return unauthorized(reply);
    }

    const tenantId = getTenantId(user, request);
    const params = request.params as { id: string };
    const contact = await pool.query(
      `SELECT id FROM tenant_notification_contacts WHERE id = $1 AND tenant_id = $2`,
      [params.id, tenantId]
    );

    if (!contact.rows[0]) {
      return reply.status(404).send({ message: "Responsável não encontrado" });
    }

    try {
      return await buildTelegramConnectLink(`contact_${params.id}`);
    } catch (error) {
      return reply.status(400).send({
        message:
          error instanceof Error
            ? error.message
            : "Não foi possível gerar o link do Telegram."
      });
    }
  });

  app.post("/notification-contacts/:id/telegram/verify", async (request, reply) => {
    let user: AuthUser;
    try {
      user = requireAuth(request);
    } catch {
      return unauthorized(reply);
    }

    const tenantId = getTenantId(user, request);
    const params = request.params as { id: string };
    const contact = await pool.query(
      `SELECT id FROM tenant_notification_contacts WHERE id = $1 AND tenant_id = $2`,
      [params.id, tenantId]
    );

    if (!contact.rows[0]) {
      return reply.status(404).send({ message: "Responsável não encontrado" });
    }

    try {
      const chatId = await findTelegramChatId(`contact_${params.id}`);

      if (!chatId) {
        return reply.status(404).send({
          message:
            "Ainda não encontrei a conexão. Abra o link do Telegram e toque em Iniciar."
        });
      }

      await pool.query(
        `
          UPDATE tenant_notification_contacts
          SET telegram_chat_id = $3
          WHERE id = $1 AND tenant_id = $2
        `,
        [params.id, tenantId, chatId]
      );

      return { connected: true, message: "Telegram conectado com sucesso." };
    } catch (error) {
      return reply.status(400).send({
        message:
          error instanceof Error
            ? error.message
            : "Não foi possível verificar a conexão com o Telegram."
      });
    }
  });

  app.get("/cameras", async (request, reply) => {
    let user: AuthUser;
    try {
      user = requireAuth(request);
    } catch {
      return unauthorized(reply);
    }

    const tenantId = getTenantId(user, request);

    if (!tenantId) {
      return forbidden(reply);
    }

    const result = await pool.query(
      `
        SELECT
          id,
          tenant_id AS "tenantId",
          name,
          rtsp_url AS "rtspUrl",
          source_type AS "sourceType",
          device_index AS "deviceIndex",
          location,
          sector,
          mode,
          status,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM cameras
        WHERE tenant_id = $1
          AND ($2::boolean OR status <> 'inactive')
        ORDER BY created_at ASC
      `,
      [tenantId, user.role === "master_admin"]
    );

    return result.rows;
  });

  app.post("/cameras", async (request, reply) => {
    let user: AuthUser;
    try {
      user = requireAuth(request);
    } catch {
      return unauthorized(reply);
    }

    if (!requireMaster(user, reply)) {
      return;
    }

    const tenantId = getTenantId(user, request);

    if (!tenantId) {
      return forbidden(reply);
    }

    const body = cameraSchema.parse(request.body);
    const cameraId = randomUUID();
    const streamUrl =
      body.sourceType === "rtmp"
        ? body.rtspUrl || buildLocalRtmpUrl(cameraId)
        : body.sourceType === "rtsp"
          ? body.rtspUrl
          : null;
    const result = await pool.query(
      `
        INSERT INTO cameras (
          id,
          tenant_id,
          name,
          rtsp_url,
          source_type,
          device_index,
          location,
          sector,
          mode,
          status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING
          id,
          tenant_id AS "tenantId",
          name,
          rtsp_url AS "rtspUrl",
          source_type AS "sourceType",
          device_index AS "deviceIndex",
          location,
          sector,
          mode,
          status,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `,
      [
        cameraId,
        tenantId,
        body.name,
        streamUrl,
        body.sourceType,
        body.sourceType === "webcam" ? body.deviceIndex ?? 0 : null,
        body.location,
        body.sector ?? null,
        body.mode,
        body.status
      ]
    );

    return reply.status(201).send(result.rows[0]);
  });

  app.patch("/cameras/:id", async (request, reply) => {
    let user: AuthUser;
    try {
      user = requireAuth(request);
    } catch {
      return unauthorized(reply);
    }

    if (!requireMaster(user, reply)) {
      return;
    }

    const tenantId = getTenantId(user, request);
    const params = request.params as { id: string };
    const body = cameraFieldsSchema.partial().parse(request.body);
    const result = await pool.query(
      `
        UPDATE cameras
        SET
          name = COALESCE($3, name),
          rtsp_url = CASE
            WHEN COALESCE($9, source_type) = 'webcam' THEN NULL
            WHEN COALESCE($9, source_type) = 'rtmp' THEN COALESCE($4, rtsp_url, $11)
            ELSE COALESCE($4, rtsp_url)
          END,
          location = COALESCE($5, location),
          sector = COALESCE($6, sector),
          mode = COALESCE($7, mode),
          status = COALESCE($8, status),
          source_type = COALESCE($9, source_type),
          device_index = CASE
            WHEN COALESCE($9, source_type) = 'webcam' THEN COALESCE($10, device_index, 0)
            ELSE NULL
          END,
          updated_at = NOW()
        WHERE id = $1
          AND tenant_id = $2
        RETURNING
          id,
          tenant_id AS "tenantId",
          name,
          rtsp_url AS "rtspUrl",
          source_type AS "sourceType",
          device_index AS "deviceIndex",
          location,
          sector,
          mode,
          status,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `,
      [
        params.id,
        tenantId,
        body.name ?? null,
        body.rtspUrl ?? null,
        body.location ?? null,
        body.sector ?? null,
        body.mode ?? null,
        body.status ?? null,
        body.sourceType ?? null,
        body.deviceIndex ?? null,
        buildLocalRtmpUrl(params.id)
      ]
    );

    if (!result.rows[0]) {
      return reply.status(404).send({ message: "Câmera não encontrada" });
    }

    return result.rows[0];
  });

  app.post("/cameras/:id/test", async (request, reply) => {
    let user: AuthUser;
    try {
      user = requireAuth(request);
    } catch {
      return unauthorized(reply);
    }

    if (!requireMaster(user, reply)) {
      return;
    }

    const tenantId = getTenantId(user, request);
    const params = request.params as { id: string };
    const camera = await pool.query(
      `SELECT id, rtsp_url, source_type, device_index, status FROM cameras WHERE id = $1 AND tenant_id = $2`,
      [params.id, tenantId]
    );

    if (!camera.rows[0]) {
      return reply.status(404).send({ message: "Câmera não encontrada" });
    }

    if (camera.rows[0].status === "inactive") {
      return {
        connected: false,
        status: "inactive",
        message: "Câmera inativa. Ative a câmera antes de testar ou transmitir."
      };
    }

    const response = await fetch(`${env.AI_BASE_URL}/cameras/test`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        cameraId: camera.rows[0].id,
        sourceType: camera.rows[0].source_type,
        rtspUrl: camera.rows[0].rtsp_url,
        deviceIndex: camera.rows[0].device_index
      })
    });

    const payload = (await response.json()) as {
      connected?: boolean;
      message?: string;
    };
    const status = payload.connected ? "online" : "offline";

    await pool.query(
      `
        UPDATE cameras
        SET status = $3, updated_at = NOW()
        WHERE id = $1
          AND tenant_id = $2
      `,
      [params.id, tenantId, status]
    );

    return reply.status(response.status).send({
      ...payload,
      status
    });
  });

  app.get("/detections", async (request, reply) => {
    let user: AuthUser;
    try {
      user = requireAuth(request);
    } catch {
      return unauthorized(reply);
    }

    const tenantId = getTenantId(user, request);
    const query = z
      .object({
        limit: z.coerce.number().int().positive().max(100).default(20)
      })
      .parse(request.query);

    if (!tenantId) {
      return forbidden(reply);
    }

    const result = await pool.query(
      `
        SELECT
          d.id,
          d.tenant_id AS "tenantId",
          d.camera_id AS "cameraId",
          d.employee_id AS "employeeId",
          d.event_type AS "eventType",
          d.detected_at AS "detectedAt",
          d.face_count AS "faceCount",
          d.confidence,
          d.snapshot_url AS "snapshotUrl",
          d.created_at AS "createdAt",
          json_build_object(
            'id', c.id,
            'tenantId', c.tenant_id,
            'name', c.name,
            'location', c.location,
            'status', c.status
          ) AS camera,
          CASE WHEN e.id IS NULL THEN NULL ELSE json_build_object(
            'id', e.id,
            'fullName', e.full_name
          ) END AS employee
        FROM detection_events d
        INNER JOIN cameras c ON c.id = d.camera_id
        LEFT JOIN employees e ON e.id = d.employee_id
        WHERE d.tenant_id = $1
        ORDER BY d.detected_at DESC
        LIMIT $2
      `,
      [tenantId, query.limit]
    );

    return result.rows;
  });

  app.get("/access-events", async (request, reply) => {
    let user: AuthUser;
    try {
      user = requireAuth(request);
    } catch {
      return unauthorized(reply);
    }

    const tenantId = getTenantId(user, request);

    if (!tenantId) {
      return forbidden(reply);
    }

    const result = await pool.query(
      `
        SELECT
          a.id,
          a.event_type AS "eventType",
          a.occurred_at AS "occurredAt",
          a.confidence,
          a.snapshot_url AS "snapshotUrl",
          json_build_object('id', e.id, 'fullName', e.full_name) AS employee,
          json_build_object('id', c.id, 'name', c.name, 'location', c.location) AS camera
        FROM access_events a
        INNER JOIN employees e ON e.id = a.employee_id
        INNER JOIN cameras c ON c.id = a.camera_id
        WHERE a.tenant_id = $1
        ORDER BY a.occurred_at DESC
        LIMIT 30
      `,
      [tenantId]
    );

    return result.rows;
  });

  app.get("/internal/monitoring-context", async (request, reply) => {
    if (!internalAuthorized(request)) {
      return unauthorized(reply);
    }

    const [cameras, faces] = await Promise.all([
      pool.query(
        `
          SELECT
            c.id,
            c.tenant_id AS "tenantId",
            c.name,
            c.rtsp_url AS "rtspUrl",
            c.source_type AS "sourceType",
            c.device_index AS "deviceIndex",
            c.location,
            c.mode,
            c.status
          FROM cameras c
          INNER JOIN tenants t ON t.id = c.tenant_id
          WHERE c.status <> 'inactive'
            AND t.status = 'active'
        `
      ),
      pool.query(
        `
          SELECT
            f.id,
            f.embedding,
            f.embedding_model AS "embeddingModel",
            e.id AS "employeeId",
            e.tenant_id AS "tenantId",
            e.full_name AS "fullName"
          FROM employee_faces f
          INNER JOIN employees e ON e.id = f.employee_id
          INNER JOIN tenants t ON t.id = e.tenant_id
          WHERE e.status = 'active'
            AND t.status = 'active'
            AND f.embedding_model = $1
        `,
        [ACTIVE_EMBEDDING_MODEL]
      )
    ]);

    return {
      cameras: cameras.rows,
      faces: faces.rows
    };
  });

  app.post("/internal/monitoring-events", async (request, reply) => {
    if (!internalAuthorized(request)) {
      return unauthorized(reply);
    }

    const body = monitoringEventSchema.parse(request.body);
    const cameraResult = await pool.query(
      `
        SELECT
          id,
          tenant_id,
          name,
          location,
          mode,
          status
        FROM cameras
        WHERE id = $1
      `,
      [body.cameraId]
    );
    const camera = cameraResult.rows[0];

    if (!camera) {
      return reply.status(404).send({ message: "Câmera não encontrada" });
    }

    if (camera.status === "inactive") {
      return reply.status(202).send({
        accessEventCreated: false,
        ignoredInactiveCamera: true
      });
    }

    if (!body.employeeId) {
      await pool.query(
        `
          UPDATE cameras
          SET status = 'online', updated_at = NOW()
          WHERE id = $1
        `,
        [camera.id]
      );

      return reply.status(202).send({
        accessEventCreated: false,
        ignoredUnknownFace: true
      });
    }

    const detectionEventType = body.employeeId ? "recognized_face" : "unknown_face";
    const detectionResult = await pool.query(
      `
        INSERT INTO detection_events (
          id,
          tenant_id,
          camera_id,
          employee_id,
          event_type,
          detected_at,
          face_count,
          confidence,
          snapshot_url
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id
      `,
      [
        randomUUID(),
        camera.tenant_id,
        camera.id,
        body.employeeId ?? null,
        detectionEventType,
        new Date(body.detectedAt),
        body.faceCount,
        body.confidence ?? null,
        body.snapshotUrl ?? null
      ]
    );

    await pool.query(
      `
        UPDATE cameras
        SET status = 'online', updated_at = NOW()
        WHERE id = $1
      `,
      [camera.id]
    );

    const employee = await pool.query(
      `
        SELECT
          id,
          full_name,
          work_days,
          entry_time::text,
          exit_time::text,
          tolerance_minutes
        FROM employees
        WHERE id = $1
      `,
      [body.employeeId]
    );
    const detectedAt = new Date(body.detectedAt);
    const employeeRow = employee.rows[0];
    const eventType = employeeRow
      ? await scheduledEventType(camera, employeeRow, detectedAt)
      : cameraModeEventType(camera.mode);
    const duplicate = await pool.query(
      `
        SELECT id
        FROM access_events
        WHERE employee_id = $1
          AND camera_id = $2
          AND event_type = $3
          AND occurred_at >= NOW() - INTERVAL '20 seconds'
        LIMIT 1
      `,
      [body.employeeId, camera.id, eventType]
    );

    const dailyDuplicate =
      eventType === "entry" || eventType === "exit"
        ? await employeeEventExistsToday(body.employeeId, eventType, detectedAt)
        : false;

    if (duplicate.rows[0] || dailyDuplicate) {
      return reply.status(201).send({
        detectionId: detectionResult.rows[0].id,
        accessEventCreated: false,
        duplicateSuppressed: true,
        dailyDuplicateSuppressed: dailyDuplicate
      });
    }

    const accessEvent = await pool.query(
      `
        INSERT INTO access_events (
          id,
          tenant_id,
          employee_id,
          camera_id,
          event_type,
          occurred_at,
          confidence,
          snapshot_url
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id
      `,
      [
        randomUUID(),
        camera.tenant_id,
        body.employeeId,
        camera.id,
        eventType,
        detectedAt,
        body.confidence ?? null,
        body.snapshotUrl ?? null
      ]
    );

    if (employeeRow) {
      const anomaly = eventAnomaly(eventType, employeeRow, detectedAt);

      await notifyTenant(camera.tenant_id, {
        employeeName: employeeRow.full_name,
        cameraName: camera.name,
        location: camera.location,
        eventType,
        confidence: body.confidence,
        snapshotUrl: body.snapshotUrl,
        anomaly
      });
    }

    return reply.status(201).send({
      detectionId: detectionResult.rows[0].id,
      accessEventId: accessEvent.rows[0].id,
      accessEventCreated: true
    });
  });
}
