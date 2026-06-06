import { env } from "./env.js";

type TelegramAlertInput = {
  chatId?: string | null;
  employeeName?: string | null;
  cameraName: string;
  location: string;
  eventType: string;
  confidence?: number | null;
  snapshotUrl?: string | null;
  anomaly?: string | null;
};

export async function sendTelegramAlert(input: TelegramAlertInput) {
  const chatId = input.chatId || env.TELEGRAM_CHAT_ID;

  if (!env.TELEGRAM_ALERT_BOT_TOKEN || !chatId) {
    return;
  }

  const eventLabel = {
    entry: "Entrada registrada",
    exit: "Saída registrada",
    permanence: "Permanência registrada"
  }[input.eventType] ?? "Evento registrado";

  const caption = [
    input.employeeName ? "🚨 Colaborador detectado" : "⚠️ Pessoa desconhecida detectada",
    "",
    input.employeeName ? `👤 Nome: ${input.employeeName}` : null,
    `🕒 Horário: ${new Date().toLocaleTimeString("pt-BR")}`,
    `📍 Local: ${input.location}`,
    input.confidence != null
      ? `📈 Confiança: ${(input.confidence * 100).toFixed(1)}%`
      : null,
    "",
    input.anomaly ? `⚠️ ${input.anomaly}` : `✅ ${eventLabel}`
  ]
    .filter(Boolean)
    .join("\n");

  const endpoint = input.snapshotUrl ? "sendPhoto" : "sendMessage";
  const body = input.snapshotUrl
    ? {
        chat_id: chatId,
        photo: input.snapshotUrl,
        caption
      }
    : {
        chat_id: chatId,
        text: caption
      };

  await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_ALERT_BOT_TOKEN}/${endpoint}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    }
  ).catch(() => undefined);
}

type TelegramUser = {
  id: number;
  is_bot: boolean;
  username?: string;
};

type TelegramUpdate = {
  update_id: number;
  message?: {
    text?: string;
    chat?: {
      id?: number | string;
    };
  };
};

async function telegramRequest<T>(method: string) {
  if (!env.TELEGRAM_ALERT_BOT_TOKEN) {
    throw new Error("Bot de alerta do Telegram não configurado.");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_ALERT_BOT_TOKEN}/${method}`
  );
  const payload = (await response.json()) as {
    ok: boolean;
    result?: T;
    description?: string;
  };

  if (!response.ok || !payload.ok || payload.result == null) {
    throw new Error(payload.description ?? "Falha ao consultar o Telegram.");
  }

  return payload.result;
}

export async function buildTelegramConnectLink(payloadId: string) {
  const bot = await telegramRequest<TelegramUser>("getMe");

  if (!bot.username) {
    throw new Error("O bot do Telegram não possui username configurado.");
  }

  return {
    link: `https://t.me/${bot.username}?start=${payloadId}`,
    botUsername: bot.username
  };
}

export async function findTelegramChatId(payloadId: string) {
  const updates = await telegramRequest<TelegramUpdate[]>("getUpdates");
  const command = `/start ${payloadId}`;
  const matchedUpdate = [...updates]
    .reverse()
    .find((update) => update.message?.text?.trim() === command);
  const chatId = matchedUpdate?.message?.chat?.id;

  return chatId == null ? null : String(chatId);
}
