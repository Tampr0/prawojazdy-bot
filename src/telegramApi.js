const fs = require("fs");

const TELEGRAM_API_BASE = "https://api.telegram.org";

function getTelegramConfig() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  return {
    token,
    chatId,
  };
}

async function telegramRequest(method, payload = {}) {
  const { token } = getTelegramConfig();

  if (!token) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN");
  }

  const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let parsed;

  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { ok: false, raw: text };
  }

  if (!response.ok || !parsed.ok) {
    throw new Error(`Telegram API error: ${response.status} ${text}`);
  }

  return parsed.result;
}

async function sendTelegramMessage(text, options = {}) {
  const { chatId } = getTelegramConfig();

  if (!chatId) {
    console.log("Brak TELEGRAM_CHAT_ID w .env");
    return;
  }

  try {
    await telegramRequest("sendMessage", {
      chat_id: chatId,
      text,
      ...options,
    });
  } catch (error) {
    console.log("Blad wysylania wiadomosci Telegram:", error.message);
  }
}

async function getUpdates(offset = null, timeout = 20) {
  const payload = {
    timeout,
    allowed_updates: ["message"],
  };

  if (offset !== null) {
    payload.offset = offset;
  }

  return telegramRequest("getUpdates", payload);
}

module.exports = {
  sendTelegramMessage,
  getUpdates,
};