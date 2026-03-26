const path = require("path");
const dotenv = require("dotenv");

dotenv.config();

function getFetchTimingConfig() {
  return {
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 13000),
    pollJitterMaxMs: Number(process.env.POLL_JITTER_MAX_MS || 1000),
    fetchRetryDelaysMs: (process.env.FETCH_RETRY_DELAYS_MS || "5000,4000,4000,8000,10000")
      .split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isFinite(value) && value >= 0),
  };
}

function loadConfig() {
  const targetUrl = process.env.TARGET_URL;
  const fetchTiming = getFetchTimingConfig();

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
    pollIntervalMs: fetchTiming.pollIntervalMs,
    pollJitterMaxMs: fetchTiming.pollJitterMaxMs,
    fetchRetryDelaysMs: fetchTiming.fetchRetryDelaysMs,
    debug: process.env.DEBUG === "true",
    bookingDiagnostics: process.env.BOOKING_DIAGNOSTICS === "true",
    bookingDiagnosticsFilePath: path.resolve(
      process.cwd(),
      process.env.BOOKING_DIAGNOSTICS_FILE || "booking-diagnostic.jsonl"
    ),
  };
}

module.exports = {
  getFetchTimingConfig,
  loadConfig,
};
