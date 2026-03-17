const { loadConfig } = require("./config");
const { captureSession, fetchSchedule } = require("./checker");
const { parseScheduleResponse } = require("./parser");
const { notify } = require("./notify");
const { logInfo, logError } = require("./logger");
const { loadState, saveState, saveJson } = require("./storage");
const { loadSession } = require("./session");

function parsePayload(payloadJson) {
  if (!payloadJson) {
    throw new Error("Missing required environment variable: EXAM_SCHEDULE_PAYLOAD_JSON");
  }

  try {
    return JSON.parse(payloadJson);
  } catch (error) {
    throw new Error("EXAM_SCHEDULE_PAYLOAD_JSON is not valid JSON.");
  }
}

async function main() {
  try {
    const config = loadConfig();
    const currentState = await loadState(config.stateFilePath);
    const payload = parsePayload(config.payloadJson);

    logInfo("Start aplikacji.");

    let session;

    try {
      session = await loadSession(config.sessionFilePath);
      logInfo("Wczytano istniejaca sesje z session.json.");
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }

      logInfo("Brak session.json. Uruchamiam Playwright, aby przechwycic sesje.");
      session = await captureSession(config);
    }

    const responseData = await fetchSchedule(session, payload, config);
    const slots = parseScheduleResponse(responseData);

    await saveJson(config.debugSlotsFilePath, slots);

    const nextState = {
      ...currentState,
      lastCheckedAt: new Date().toISOString(),
      lastResult: {
        slotsCount: slots.length,
        debugSlotsFilePath: config.debugSlotsFilePath,
      },
    };

    await saveState(config.stateFilePath, nextState);
    await notify(`Pobrano ${slots.length} praktycznych terminow i zapisano debug-slots.json.`);

    logInfo("Koniec pracy.");
  } catch (error) {
    logError("Aplikacja zakonczyla sie bledem.", error);
    process.exitCode = 1;
  }
}

main();
