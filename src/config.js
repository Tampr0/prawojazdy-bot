const path = require("path");
const dotenv = require("dotenv");

dotenv.config();

function loadConfig() {
  const targetUrl = process.env.TARGET_URL;

  if (!targetUrl) {
    throw new Error("Missing required environment variable: TARGET_URL");
  }

  return {
    targetUrl,
    headless: process.env.PLAYWRIGHT_HEADLESS !== "false",
    browserName: process.env.PLAYWRIGHT_BROWSER || "chromium",
    stateFilePath: path.resolve(process.cwd(), process.env.STATE_FILE || "state.json"),
  };
}

module.exports = {
  loadConfig,
};
