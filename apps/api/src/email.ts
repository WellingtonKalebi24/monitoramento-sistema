import nodemailer from "nodemailer";
import { env } from "./env.js";

type EmailAlertInput = {
  to: string;
  employeeName?: string | null;
  cameraName: string;
  location: string;
  eventType: string;
  anomaly?: string | null;
  snapshotUrl?: string | null;
};

function eventLabel(eventType: string) {
  return (
    {
      entry: "Entrada registrada",
      exit: "Sa?da registrada",
      permanence: "Perman?ncia registrada"
    }[eventType] ?? "Evento registrado"
  );
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

  const lines = [
    "Colaborador detectado",
    "",
    input.employeeName ? `Nome: ${input.employeeName}` : null,
    `Hor?rio: ${new Date().toLocaleTimeString("pt-BR")}`,
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
