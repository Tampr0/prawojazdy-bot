const fs = require("fs");

function writeErrorToFile(message) {
  const line = message + "\n";
  fs.appendFileSync("errors.log", line);
}

function getLocalTimestamp() {
  return new Date()
    .toLocaleString("sv-SE", {
      timeZone: "Europe/Warsaw",
      hour12: false,
    })
    .replace(" ", "T");
}

function formatMessage(level, message) {
  const timestamp = getLocalTimestamp();
  return `[${timestamp}] [${level}] ${message}`;
}

let lastStatusLength = 0;

const FETCH_LOG_FILE = "fetch-log.txt";

function logFetch(message) {
  const timestamp = getLocalTimestamp();
  const line = `[${timestamp}] ${message}\n`;
  fs.appendFileSync(FETCH_LOG_FILE, line);
}

function logFetchHeader(config) {
  const timestamp = getLocalTimestamp();

  const header = `
==================================================
[${timestamp}] NEW TEST START

POLL_INTERVAL_MS=${config.pollInterval}
POLL_JITTER_MAX_MS=${config.pollJitterMaxMs}
RETRY_DELAYS_MS=${JSON.stringify(config.retryDelays)}

==================================================\n`;

  fs.appendFileSync(FETCH_LOG_FILE, header);
}

module.exports = {
  logInfo(message) {
    console.log(formatMessage("INFO", message));
  },
  logStatus(message) {
    const paddedMessage =
      message + " ".repeat(Math.max(0, lastStatusLength - message.length));

    process.stdout.write(`\r${paddedMessage}`);
    lastStatusLength = message.length;
  },
  logError(message, error) {
    const formatted = formatMessage("ERROR", message);

    console.error(formatted);
    writeErrorToFile(formatted);

    if (error) {
      console.error(error);
      const errorDetails = error.stack || error.toString();
      writeErrorToFile(formatMessage("ERROR", errorDetails) + "\n");
    }
  }, 
  logFetch,
  logFetchHeader,

};