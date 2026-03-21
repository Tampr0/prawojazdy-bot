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
    apiEndpoint:
      process.env.EXAM_SCHEDULE_URL ||
      "https://info-car.pl/api/word/word-centers/exam-schedule",
    headless: process.env.PLAYWRIGHT_HEADLESS !== "false",
    browserName: process.env.PLAYWRIGHT_BROWSER || "chromium",
    captureTimeoutMs: Number(process.env.CAPTURE_TIMEOUT_MS || 120000),
    userDataDir: path.resolve(process.cwd(), process.env.USER_DATA_DIR || "user-data"),
    stateFilePath: path.resolve(process.cwd(), process.env.STATE_FILE || "state.json"),
    sessionFilePath: path.resolve(process.cwd(), process.env.SESSION_FILE || "session.json"),
    seenSlotsFilePath: path.resolve(
      process.cwd(),
      process.env.SEEN_SLOTS_FILE || "seen-slots.json"
    ),
    debugSlotsFilePath: path.resolve(
      process.cwd(),
      process.env.DEBUG_SLOTS_FILE || "debug-slots.json"
    ),
    payloadJson: process.env.EXAM_SCHEDULE_PAYLOAD_JSON || "",
    slotMinDays: Number(process.env.SLOT_MIN_DAYS || 0),
    slotMaxDays: Number(process.env.SLOT_MAX_DAYS || 999),
    debug: process.env.DEBUG === "true",
  };
}

module.exports = {
  loadConfig,
};
