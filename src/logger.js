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
};