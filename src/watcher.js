const fs = require("fs/promises");
const { loadConfig } = require("./config");
const { fetchSchedule } = require("./checker");
const { runBooker } = require("./booker");
const { logInfo, logError } = require("./logger");
const { ensureSession } = require("./session");
const { saveJson } = require("./storage");
const { sendTelegramMessage } = require("./notifier");

// const FORCE_BOOKING = true;

const POLL_INTERVAL_MS = 20000;
const RANGE_DAYS = 60;
const MAX_LOGGED_TERMS = 10;
const sentSlots = new Set();
let bookingInProgress = false;

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

async function notify(slots) {
  const nearestTerms = slots.slice(0, MAX_LOGGED_TERMS);

  for (const term of nearestTerms) {
    logInfo(`${formatTermDate(term)} | wordId: ${term.wordId}`);
  }

  await sendTelegramMessage(buildTelegramMessage(nearestTerms));

  return nearestTerms;
}

function buildSlotKey(slot) {
  const key = `${slot.dateTime}_${slot.wordId}_${slot.examType}`;
  return key;
}

async function loadSeenSlots(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(content);

    if (!Array.isArray(parsed)) {
      return new Set();
    }

    return new Set(parsed.filter((item) => typeof item === "string"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return new Set();
    }

    throw error;
  }
}

async function saveSeenSlots(filePath, slotsSet) {
  await saveJson(filePath, Array.from(slotsSet));
}

async function runWatcher() {
  const config = loadConfig();
  let session = await ensureSession(config);
  const loadedSlots = await loadSeenSlots(config.seenSlotsFilePath);

  sentSlots.clear();

  for (const slotKey of loadedSlots) {
    sentSlots.add(slotKey);
  }

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

        const newSlots = practicalTerms.filter((slot) => !sentSlots.has(buildSlotKey(slot)));
        console.log("NEW SLOTS:", newSlots.length);

        if (newSlots.length === 0) {
          logInfo("Brak nowych slotow do wyslania.");
        } else {
          const notifiedSlots = await notify(newSlots);
        // if (newSlots.length === 0 && !FORCE_BOOKING) {
        //   logInfo("Brak nowych slotow do wyslania.");
        //   } else {
        //     const notifiedSlots = await notify(newSlots.length > 0 ? newSlots : practicalTerms);

          for (const term of notifiedSlots) {
            sentSlots.add(buildSlotKey(term));
          }

          await saveSeenSlots(config.seenSlotsFilePath, sentSlots);

          if (!bookingInProgress) {
            bookingInProgress = true;

            try {
              await runBooker();
            } catch (err) {
              console.error("BOOKING ERROR:", err);
            } finally {
              bookingInProgress = false;
            }
          }
        }
      }

      await saveJson(config.debugSlotsFilePath, practicalTerms);
    } catch (error) {
      if (String(error?.message || error).includes("401")) {
        logInfo("SESSION EXPIRED");
        session = await ensureSession(config, { forceRefresh: true });
        continue;
      }

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
