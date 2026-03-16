const path = require("path");
const dotenv = require("dotenv");

dotenv.config();

function requireEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function loadConfig() {
  return {
    targetUrl: process.env.TARGET_URL || "",
    checkIntervalMs: Number(process.env.CHECK_INTERVAL_MS || 300000),
    headless: process.env.PLAYWRIGHT_HEADLESS !== "false",
    browserName: process.env.PLAYWRIGHT_BROWSER || "chromium",
    stateFilePath: path.resolve(process.cwd(), process.env.STATE_FILE || "state.json"),
    notificationChannel: process.env.NOTIFICATION_CHANNEL || "log",
    notificationTarget: process.env.NOTIFICATION_TARGET || "",
    logLevel: process.env.LOG_LEVEL || "info",
    dryRun: process.env.DRY_RUN === "true",
  };
}

module.exports = {
  loadConfig,
  requireEnv,
};
