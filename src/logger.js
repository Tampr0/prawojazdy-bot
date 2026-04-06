const fs = require("fs");
const readline = require("readline");

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
const CONSOLE_PATCH_STATE_KEY = "__prawojazdyBotConsolePatchState";

function getConsolePatchState() {
  if (!global[CONSOLE_PATCH_STATE_KEY]) {
    global[CONSOLE_PATCH_STATE_KEY] = {
      applied: false,
      bypass: false,
      original: {
        log: console.log.bind(console),
        error: console.error.bind(console),
        warn: console.warn.bind(console),
        info: console.info.bind(console),
      },
    };
  }

  return global[CONSOLE_PATCH_STATE_KEY];
}

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
SESSION_REFRESH_INTERVAL_MS=${config.sessionRefreshIntervalMs}

==================================================\n`;

  fs.appendFileSync(FETCH_LOG_FILE, header);
}

function clearActiveStatusLine() {
  if (!process.stdout.isTTY) {
    return;
  }

  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
}

function moveFromStatusToNextLine() {
  if (!lastStatusLength) {
    return;
  }

  if (process.stdout.isTTY) {
    clearActiveStatusLine();
    process.stdout.write("\n");
  }

  lastStatusLength = 0;
}

function fitStatusToTerminalWidth(message) {
  const columns = process.stdout.columns || 120;
  const maxWidth = Math.max(1, columns - 1);

  if (message.length <= maxWidth) {
    return message;
  }

  if (maxWidth <= 3) {
    return message.slice(0, maxWidth);
  }

  return `${message.slice(0, maxWidth - 3)}...`;
}

function callOriginalConsole(method, ...args) {
  const patchState = getConsolePatchState();
  const previousBypass = patchState.bypass;
  patchState.bypass = true;

  try {
    return patchState.original[method](...args);
  } finally {
    patchState.bypass = previousBypass;
  }
}

function patchConsoleOnce() {
  const patchState = getConsolePatchState();

  if (patchState.applied) {
    return;
  }

  for (const method of ["log", "error", "warn", "info"]) {
    console[method] = (...args) => {
      if (!patchState.bypass) {
        moveFromStatusToNextLine();
      }

      return patchState.original[method](...args);
    };
  }

  patchState.applied = true;
}

patchConsoleOnce();

module.exports = {
  logInfo(message) {
    moveFromStatusToNextLine();
    callOriginalConsole("log", formatMessage("INFO", message));
  },

  logStatus(message) {
    if (!process.stdout.isTTY) {
      callOriginalConsole("log", message);
      lastStatusLength = 0;
      return;
    }

    const fittedMessage = fitStatusToTerminalWidth(message);

    clearActiveStatusLine();
    process.stdout.write(fittedMessage);

    lastStatusLength = fittedMessage.length;
  },

  logError(message, error) {
    moveFromStatusToNextLine();

    const formatted = formatMessage("ERROR", message);

    callOriginalConsole("error", formatted);
    writeErrorToFile(formatted);

    if (error) {
      callOriginalConsole("error", error);

      const errorDetails = error.stack || error.toString();
      writeErrorToFile(formatMessage("ERROR", errorDetails) + "\n");
    }
  },

  logFetch,
  logFetchHeader,
};
