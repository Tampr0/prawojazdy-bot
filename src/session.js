const fs = require("fs/promises");

async function saveSession(sessionFilePath, session) {
  await fs.writeFile(sessionFilePath, JSON.stringify(session, null, 2), "utf8");
}

async function loadSession(sessionFilePath) {
  const content = await fs.readFile(sessionFilePath, "utf8");
  return JSON.parse(content);
}

module.exports = {
  saveSession,
  loadSession,
};
