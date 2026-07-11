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

function filenameFromUrl(url: string) {
  try {
    return new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "deteccao.jpg";
  } catch {
    return "deteccao.jpg";
  }
}

function mediaKind(url: string) {
  const filename = filenameFromUrl(url).toLowerCase();

  if (/\.(mp4|mov|m4v)$/i.test(filename)) {
    return { endpoint: "sendVideo", field: "video", fallbackType: "video/mp4" };
  }

  if (/\.(webm|avi|mkv)$/i.test(filename)) {
    return { endpoint: "sendDocument", field: "document", fallbackType: "video/webm" };
  }

  return { endpoint: "sendPhoto", field: "photo", fallbackType: "image/jpeg" };
}

async function postTelegramJson(endpoint: string, body: Record<string, unknown>) {
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_ALERT_BOT_TOKEN}/${endpoint}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );
  const payload = (await response.json().catch(() => null)) as
    | { ok?: boolean; description?: string }
    | null;

  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.description ?? `Telegram retornou HTTP ${response.status}`);
  }
}

async function postTelegramMedia(chatId: string, snapshotUrl: string, caption: string) {
  const kind = mediaKind(snapshotUrl);
  const response = await fetch(snapshotUrl);

  if (!response.ok) {
    throw new Error(`Falha ao baixar mídia da detecção: HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type") ?? kind.fallbackType;
  const media = new Blob([await response.arrayBuffer()], { type: contentType });
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("caption", caption);
  form.append(kind.field, media, filenameFromUrl(snapshotUrl));

  const telegramResponse = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_ALERT_BOT_TOKEN}/${kind.endpoint}`,
    {
      method: "POST",
      body: form
    }
  );
  const payload = (await telegramResponse.json().catch(() => null)) as
    | { ok?: boolean; description?: string }
    | null;

  if (!telegramResponse.ok || payload?.ok === false) {
    throw new Error(payload?.description ?? `Telegram retornou HTTP ${telegramResponse.status}`);
  }
}

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

  if (input.snapshotUrl) {
    try {
      await postTelegramMedia(String(chatId), input.snapshotUrl, caption);
      return;
    } catch (error) {
      console.error("[telegram] falha ao enviar mídia da detecção", error);
    }
  }

  try {
    await postTelegramJson("sendMessage", {
      chat_id: chatId,
      text: input.snapshotUrl
        ? `${caption}\n\nMídia não anexada automaticamente.`
        : caption
    });
  } catch (error) {
    console.error("[telegram] falha ao enviar alerta", error);
  }
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
