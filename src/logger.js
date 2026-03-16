function formatMessage(level, message) {
  const timestamp = new Date().toISOString();
  return `[${timestamp}] [${level}] ${message}`;
}

module.exports = {
  logInfo(message) {
    console.log(formatMessage("INFO", message));
  },
  logError(message, error) {
    console.error(formatMessage("ERROR", message));

    if (error) {
      console.error(error);
    }
  },
};
