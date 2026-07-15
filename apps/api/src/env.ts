import { config } from "dotenv";
import { z } from "zod";

config({ path: "../../.env" });
config();

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  API_PORT: z.coerce.number().default(4000),
  DEFAULT_RTSP_URL: z.string().default(""),
  API_BASE_URL: z.string().default("http://localhost:4000"),
  AI_BASE_URL: z.string().default("http://localhost:8000"),
  RTMP_PORT: z.coerce.number().default(1935),
  RTMP_SERVER_ENABLED: z
    .string()
    .default("true")
    .transform((value) => value !== "false" && value !== "0"),
  RTMP_APP: z.string().min(1).default("live"),
  RTMP_REJECT_INACTIVE_PUBLISH: z
    .string()
    .default("false")
    .transform((value) => value === "true" || value === "1"),
  JWT_SECRET: z.string().min(16).default("troque-esta-chave-em-producao"),
  INTERNAL_API_KEY: z.string().min(1).default("local-internal-key"),
  TELEGRAM_ALERT_BOT_TOKEN: z.string().default(""),
  TELEGRAM_CHAT_ID: z.string().default(""),
  SMTP_HOST: z.string().default(""),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_SECURE: z
    .string()
    .default("false")
    .transform((value) => value === "true" || value === "1"),
  SMTP_USER: z.string().default(""),
  SMTP_PASS: z.string().default(""),
  SMTP_FROM: z.string().default("")
});

export const env = envSchema.parse(process.env);
