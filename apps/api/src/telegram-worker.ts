import { pool } from "./db.js";
import {
  sendTelegramText,
  telegramIsConfigured,
  telegramRequest,
  telegramStartPayload,
  type TelegramBotUpdate
} from "./telegram.js";

type WorkerLogger = {
  info: (message: string) => void;
  error: (error: unknown, message: string) => void;
};

const CONTACT_PAYLOAD = /^contact_([0-9a-f-]{36})$/i;

let workerStarted = false;
let workerStopped = false;

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function connectContact(update: TelegramBotUpdate) {
  const chatId = update.message?.chat?.id;
  const text = update.message?.text?.trim();
  const payload = telegramStartPayload(text);

  if (chatId == null || !text?.match(/^\/start(?:@[a-z0-9_]+)?(?:\s|$)/i)) {
    return;
  }

  if (!payload) {
    await sendTelegramText(
      String(chatId),
      "Para conectar o MEIP, abra o link gerado na tela de Notificações do sistema."
    );
    return;
  }

  const contactId = CONTACT_PAYLOAD.exec(payload)?.[1];

  if (!contactId) {
    await sendTelegramText(
      String(chatId),
      "Este link de conexão não é válido. Gere um novo link no sistema MEIP."
    );
    return;
  }

  const result = await pool.query<{ name: string }>(
    `
      UPDATE tenant_notification_contacts
      SET telegram_chat_id = $2
      WHERE id = $1
        AND status = 'active'
        AND notify_telegram = TRUE
      RETURNING name
    `,
    [contactId, String(chatId)]
  );

  if (!result.rows[0]) {
    await sendTelegramText(
      String(chatId),
      "Não foi possível conectar este responsável. Confirme se ele está ativo e com Telegram habilitado."
    );
    return;
  }

  await sendTelegramText(
    String(chatId),
    `✅ Telegram conectado ao MEIP para ${result.rows[0].name}. Os alertas já estão ativos.`
  );
}

async function preparePolling() {
  const webhook = await telegramRequest<{ url?: string }>("getWebhookInfo");

  if (webhook.url) {
    await telegramRequest<boolean>("deleteWebhook", {
      drop_pending_updates: "false"
    });
  }
}

async function pollingLoop(logger: WorkerLogger) {
  let offset: number | undefined;

  try {
    await preparePolling();
    logger.info("Telegram pronto para conectar responsáveis automaticamente.");
  } catch (error) {
    logger.error(error, "Falha ao preparar o bot do Telegram.");
  }

  while (!workerStopped) {
    try {
      const updates = await telegramRequest<TelegramBotUpdate[]>(
        "getUpdates",
        {
          ...(offset == null ? {} : { offset: String(offset) }),
          limit: "100",
          timeout: "5",
          allowed_updates: JSON.stringify(["message"])
        },
        10_000
      );

      for (const update of updates) {
        offset = Math.max(offset ?? 0, update.update_id + 1);

        try {
          await connectContact(update);
        } catch (error) {
          logger.error(error, `Falha ao processar atualização ${update.update_id} do Telegram.`);
        }
      }
    } catch (error) {
      logger.error(error, "Falha ao consultar novas conexões do Telegram; nova tentativa em 3s.");
      await wait(3_000);

      try {
        await preparePolling();
      } catch (prepareError) {
        logger.error(prepareError, "O bot do Telegram ainda não está pronto para receber conexões.");
      }
    }
  }
}

export function startTelegramConnectionWorker(logger: WorkerLogger) {
  if (workerStarted || !telegramIsConfigured()) {
    if (!telegramIsConfigured()) {
      logger.info("Bot do Telegram não configurado; conexão automática desativada.");
    }

    return () => undefined;
  }

  workerStarted = true;
  workerStopped = false;
  void pollingLoop(logger);

  return () => {
    workerStopped = true;
    workerStarted = false;
  };
}
