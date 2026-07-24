import nodemailer from "nodemailer";
import { env } from "./env.js";

type EmailAlertInput = {
  to: string;
  employeeName?: string | null;
  cameraName: string;
  location: string;
  eventType: "entry" | "exit";
  occurredAt?: Date;
  anomaly?: string | null;
  snapshotUrl?: string | null;
};

function eventLabel(eventType: "entry" | "exit") {
  return eventType === "entry" ? "Entrada registrada" : "Sa?da registrada";
}

function smtpConfigured() {
  return Boolean(env.SMTP_HOST && env.SMTP_FROM);
}

export async function sendEmailAlert(input: EmailAlertInput) {
  if (!smtpConfigured()) {
    console.warn("[email] SMTP n?o configurado; alerta por e-mail ignorado.");
    return;
  }

  const transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth:
      env.SMTP_USER && env.SMTP_PASS
        ? {
            user: env.SMTP_USER,
            pass: env.SMTP_PASS
          }
        : undefined
  });

  if (!input.employeeName) {
    return;
  }

  const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
  const lines = [
    eventLabel(input.eventType),
    "",
    `Funcion?rio: ${input.employeeName}`,
    `Hor?rio: ${occurredAt.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo" })}`,
    `Local: ${input.location}`,
    `C?mera: ${input.cameraName}`,
    "",
    input.anomaly ? `Aten??o: ${input.anomaly}` : eventLabel(input.eventType),
    input.snapshotUrl ? "" : null,
    input.snapshotUrl ? `M?dia da detec??o: ${input.snapshotUrl}` : null
  ].filter(Boolean) as string[];

  await transporter.sendMail({
    from: env.SMTP_FROM,
    to: input.to,
    subject: `MEIP - ${eventLabel(input.eventType)}`,
    text: lines.join("\n")
  });
}
