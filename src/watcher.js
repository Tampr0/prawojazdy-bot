const { loadConfig } = require("./config");
const { fetchSchedule } = require("./checker");
const { logInfo, logError } = require("./logger");
const { loadSession } = require("./session");
const { saveJson } = require("./storage");
const { sendTelegramMessage } = require("./notifier");

const POLL_INTERVAL_MS = 20000;
const RANGE_DAYS = 60;
const MAX_LOGGED_TERMS = 10;
const sentSlots = new Set();

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

  return practicalTerms
    .filter((term) => term.examType === "PRACTICAL")
    .sort((firstTerm, secondTerm) => {
      const firstDate = new Date(firstTerm.date).getTime();
      const secondDate = new Date(secondTerm.date).getTime();

      return firstDate - secondDate;
    });
}

function formatTermDate(term) {
  const date = new Date(term.date);

  if (Number.isNaN(date.getTime())) {
    return `${term.date || "brak-daty"} ${String(term.time || "").slice(0, 5)}`.trim();
  }

  const localDateTime = date.toLocaleString("pl-PL", {
    timeZone: "Europe/Warsaw",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const [datePart, timePart] = localDateTime.split(", ");
  const [day, month, year] = datePart.split(".");

  return `${year}-${month}-${day} ${timePart}`;
}

function buildTelegramMessage(terms) {
  const lines = terms.map((term) => formatTermDate(term));
  return `ZNALEZIONO TERMINY:\n${lines.join("\n")}`;
}

function buildSlotKey(term) {
  return `${term.date}_${term.wordId}`;
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

        const newTerms = practicalTerms.filter((term) => !sentSlots.has(buildSlotKey(term)));

        if (newTerms.length === 0) {
          logInfo("Brak nowych slotow do wyslania.");
        } else {
          const nearestTerms = newTerms.slice(0, MAX_LOGGED_TERMS);

          for (const term of nearestTerms) {
            logInfo(`${formatTermDate(term)} | wordId: ${term.wordId}`);
          }

          await sendTelegramMessage(buildTelegramMessage(nearestTerms));

          for (const term of nearestTerms) {
            sentSlots.add(buildSlotKey(term));
          }
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
