function createLogger(level = "info") {
  function formatMessage(logLevel, message, meta) {
    const timestamp = new Date().toISOString();

    if (!meta) {
      return `[${timestamp}] [${logLevel.toUpperCase()}] ${message}`;
    }

    return `[${timestamp}] [${logLevel.toUpperCase()}] ${message} ${JSON.stringify(meta)}`;
  }

  return {
    debug(message, meta) {
      if (level === "debug") {
        console.debug(formatMessage("debug", message, meta));
      }
    },
    info(message, meta) {
      console.info(formatMessage("info", message, meta));
    },
    warn(message, meta) {
      console.warn(formatMessage("warn", message, meta));
    },
    error(message, meta) {
      console.error(formatMessage("error", message, meta));
    },
  };
}

module.exports = {
  createLogger,
};
