const dotenv = require("dotenv");

dotenv.config();

async function sendTelegramMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log("Brak TELEGRAM_BOT_TOKEN lub TELEGRAM_CHAT_ID w .env");
    return;
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        text,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.log("Blad Telegram API:", response.status, errorText);
      return;
    }

    console.log("Wiadomosc Telegram wyslana poprawnie");
  } catch (error) {
    console.log("Blad wysylania wiadomosci Telegram:", error.message);
  }
}

module.exports = {
  sendTelegramMessage,
};
