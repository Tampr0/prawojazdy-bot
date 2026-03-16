const fs = require("fs/promises");

async function loadState(stateFilePath, logger) {
  try {
    const content = await fs.readFile(stateFilePath, "utf8");
    return JSON.parse(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      logger.info("State file not found, using default state.", { stateFilePath });
      return createInitialState();
    }

    throw error;
  }
}

async function saveState(stateFilePath, state, logger) {
  const payload = JSON.stringify(state, null, 2);
  await fs.writeFile(stateFilePath, payload, "utf8");
  logger.debug("State saved to disk.", { stateFilePath });
}

function createInitialState() {
  return {
    lastCheckedAt: null,
    lastResult: null,
    lastNotificationAt: null,
    metadata: {},
  };
}

module.exports = {
  loadState,
  saveState,
  createInitialState,
};
