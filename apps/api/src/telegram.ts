import { env } from "./env.js";

type TelegramAlertInput = {
  chatId?: string | null;
  employeeName?: string | null;
  cameraName: string;
  location: string;
  eventType: "entry" | "exit";
  occurredAt?: Date;
  snapshotUrl?: string | null;
  anomaly?: string | null;
};

function telegramBotToken() {
  return env.TELEGRAM_ALERT_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN;
}

function telegramApiUrl(method: string, query?: Record<string, string>) {
  const url = new URL(`https://api.telegram.org/bot${telegramBotToken()}/${method}`);

  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value);
  }

  return url;
}

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
    telegramApiUrl(endpoint),
    {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
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
  const response = await fetch(snapshotUrl, {
    signal: AbortSignal.timeout(20_000)
  });

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
    telegramApiUrl(kind.endpoint),
    {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
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

export async function sendTelegramText(chatId: string, text: string) {
  if (!telegramBotToken() || !chatId) {
    throw new Error("Bot de alerta ou chat do Telegram não configurado.");
  }

  await postTelegramJson("sendMessage", {
    chat_id: chatId,
    text
  });
}

export async function sendTelegramAlert(input: TelegramAlertInput) {
  const chatId = input.chatId || env.TELEGRAM_CHAT_ID;

  if (!telegramBotToken() || !chatId || !input.employeeName) {
    return;
  }

  const eventLabel = {
    entry: "Entrada registrada",
    exit: "Saida registrada"
  }[input.eventType];
  const statusLine = input.anomaly ? `Atencao: ${input.anomaly}` : eventLabel;
  const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();

  const caption = [
    eventLabel,
    "",
    `Funcionario: ${input.employeeName}`,
    `Horario: ${occurredAt.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo" })}`,
    `Local: ${input.location}`,
    `Camera: ${input.cameraName}`,
    "",
    statusLine
  ]
    .filter(Boolean)
    .join("\n");

  if (input.snapshotUrl) {
    try {
      await postTelegramMedia(String(chatId), input.snapshotUrl, caption);
      return;
    } catch (error) {
      console.error("[telegram] falha ao enviar midia da deteccao", error);
    }
  }

  try {
    await postTelegramJson("sendMessage", {
      chat_id: chatId,
      text: input.snapshotUrl
        ? `${caption}\n\nMidia nao anexada automaticamente.`
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

export type TelegramBotUpdate = TelegramUpdate;

export function telegramIsConfigured() {
  return Boolean(telegramBotToken());
}

export function telegramStartPayload(text?: string) {
  const match = text?.trim().match(/^\/start(?:@[a-z0-9_]+)?(?:\s+([^\s]+))?$/i);
  return match?.[1] ?? null;
}

export async function telegramRequest<T>(
  method: string,
  query?: Record<string, string>,
  timeoutMs = 12_000
) {
  if (!telegramBotToken()) {
    throw new Error("Bot de alerta do Telegram não configurado.");
  }

  const response = await fetch(telegramApiUrl(method, query), {
    signal: AbortSignal.timeout(timeoutMs)
  });
  const payload = (await response.json().catch(() => null)) as {
    ok: boolean;
    result?: T;
    description?: string;
  } | null;

  if (!response.ok || !payload?.ok || payload.result == null) {
    throw new Error(
      payload?.description ?? `Falha ao consultar o Telegram (HTTP ${response.status}).`
    );
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
