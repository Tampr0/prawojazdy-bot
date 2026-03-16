const fs = require("fs/promises");

function createDefaultState() {
  return {
    lastCheckedAt: null,
    lastPageTitle: null,
    lastResult: null,
  };
}

async function loadState(stateFilePath) {
  try {
    const content = await fs.readFile(stateFilePath, "utf8");
    return JSON.parse(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      return createDefaultState();
    }

    throw error;
  }
}

async function saveState(stateFilePath, state) {
  const payload = JSON.stringify(state, null, 2);
  await fs.writeFile(stateFilePath, payload, "utf8");
}

module.exports = {
  loadState,
  saveState,
  createDefaultState,
};
