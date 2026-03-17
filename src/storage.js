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

async function saveJson(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

module.exports = {
  loadState,
  saveState,
  saveJson,
  createDefaultState,
};
