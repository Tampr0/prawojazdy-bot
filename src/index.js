const { loadConfig } = require("./config");
const { runCheck } = require("./checker");
const { parseAppointments } = require("./parser");
const { notify } = require("./notify");
const { logInfo, logError } = require("./logger");
const { loadState, saveState } = require("./storage");

async function main() {
  try {
    const config = loadConfig();
    const currentState = await loadState(config.stateFilePath);

    logInfo("Start aplikacji.");

    const checkResult = await runCheck(config);
    const parsedResult = parseAppointments();

    const nextState = {
      ...currentState,
      lastCheckedAt: checkResult.checkedAt,
      lastPageTitle: checkResult.pageTitle,
      lastResult: parsedResult,
    };

    await saveState(config.stateFilePath, nextState);
    await notify(`Sprawdzanie zakonczone. Znaleziono ${parsedResult.slots.length} terminow.`);

    logInfo("Koniec pracy.");
  } catch (error) {
    logError("Aplikacja zakonczyla sie bledem.", error);
    process.exitCode = 1;
  }
}

main();
