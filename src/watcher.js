const { loadConfig } = require("./config");
const { fetchSchedule } = require("./checker");
const { logInfo, logError } = require("./logger");
const { loadSession } = require("./session");
const { saveJson } = require("./storage");

const POLL_INTERVAL_MS = 20000;
const RANGE_DAYS = 60;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildPayload() {
  return {
    category: "B",
    wordId: "3",
    startDate: new Date().toISOString(),
    endDate: new Date(Date.now() + RANGE_DAYS * 24 * 60 * 60 * 1000).toISOString(),
  };
}

function getPracticalTerms(responseData, payload) {
  const scheduledDays = responseData?.schedule?.scheduledDays || [];
  const practicalTerms = [];

  for (const day of scheduledDays) {
    const scheduledHours = day?.scheduledHours || [];

    for (const hour of scheduledHours) {
      const practiceExams = hour?.practiceExams || [];

      for (const exam of practiceExams) {
        practicalTerms.push({
          examType: "PRACTICAL",
          id: exam?.id || null,
          date: exam?.date || day?.day || null,
          time: hour?.time || null,
          wordId: responseData?.organizationId || payload.wordId,
          places: exam?.places ?? null,
          amount: exam?.amount ?? null,
          additionalInfo: exam?.additionalInfo ?? null,
        });
      }
    }
  }

  return practicalTerms.filter((term) => term.examType === "PRACTICAL");
}

async function runWatcher() {
  const config = loadConfig();
  const session = await loadSession(config.sessionFilePath);

  logInfo(`Watcher uruchomiony. Interwal: ${POLL_INTERVAL_MS / 1000}s`);

  while (true) {
    try {
      const payload = buildPayload();
      const responseData = await fetchSchedule(session, payload, config);
      const practicalTerms = getPracticalTerms(responseData, payload);

      if (practicalTerms.length === 0) {
        logInfo("Brak terminow praktycznych");
      } else {
        logInfo(`Znaleziono ${practicalTerms.length} terminow praktycznych.`);

        for (const term of practicalTerms) {
          logInfo(`Data: ${term.date}, godzina: ${term.time}, wordId: ${term.wordId}`);
        }
      }

      await saveJson(config.debugSlotsFilePath, practicalTerms);
    } catch (error) {
      logError("Blad podczas pobierania terminarza.", error);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

module.exports = {
  runWatcher,
  buildPayload,
  getPracticalTerms,
};

if (require.main === module) {
  runWatcher().catch((error) => {
    logError("Watcher zakonczyl sie bledem.", error);
    process.exit(1);
  });
}
