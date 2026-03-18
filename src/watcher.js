const fs = require("fs/promises");
const { loadConfig } = require("./config");
const { fetchSchedule, fetchWithRetry } = require("./checker");
const { runBooker } = require("./booker");
const { logInfo, logError } = require("./logger");
const { ensureSession, getSessionPage } = require("./session");
const { saveJson } = require("./storage");
const { sendTelegramMessage } = require("./notifier");

const FORCE_BOOKING = false; // true dla testów

const POLL_INTERVAL_MS = 20000;
const FETCH_FAILURE_COOLDOWN_MS = 30000;
const RANGE_DAYS = 60;
const MAX_LOGGED_TERMS = 10;
const MAX_CONSECUTIVE_FETCH_FAILURES = 3;
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
  const key = slot.time
    ? `${slot.date}_${slot.time}_${slot.wordId}_${slot.examType}`
    : `${slot.date}_${slot.wordId}_${slot.examType}`;
  console.log("SLOT KEY:", key);
  return key;
}

function getEarliestTimestampFromSet(slotsSet) {
  const timestamps = [];

  for (const key of slotsSet) {
    const [date, time] = key.split("_");

    const ts = new Date(`${date}T${time}`).getTime();
    if (!Number.isNaN(ts)) {
      timestamps.push(ts);
    }
  }

  return timestamps.length ? Math.min(...timestamps) : null;
}

function getSlotTimestamp(slot) {
  return new Date(`${slot.date}T${slot.time}`).getTime();
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

function isNetworkFetchError(errorMessage) {
  return (
    errorMessage.includes("ECONNRESET") ||
    errorMessage.includes("fetch failed") ||
    errorMessage.includes("ETIMEDOUT") ||
    errorMessage.includes("ECONNREFUSED") ||
    errorMessage.includes("ENOTFOUND") ||
    errorMessage.includes("EAI_AGAIN") ||
    errorMessage.includes("socket hang up") ||
    errorMessage.includes("UND_ERR")
  );
}

async function runWatcher() {
  const config = loadConfig();
  const loadedSlots = await loadSeenSlots(config.seenSlotsFilePath);
  let session = null;
  let consecutiveFetchFailures = 0;

  sentSlots.clear();

  for (const slotKey of loadedSlots) {
    sentSlots.add(slotKey);
  }

  logInfo(`Watcher uruchomiony. Interwal: ${POLL_INTERVAL_MS / 1000}s`);

  while (true) {
    try {
      console.log("SESSION STATE:", session ? "OK" : "MISSING");
      if (!session) {
        console.log("NO SESSION -> creating...");
        session = await ensureSession(config);
        console.log("SESSION STATE:", session ? "OK" : "MISSING");
        console.log("SESSION READY");
      }

      const payload = buildPayload();
      const responseData = await fetchWithRetry(() => fetchSchedule(session, payload, config));
      consecutiveFetchFailures = 0;
      const practicalTerms = getPracticalTerms(responseData, payload);

      if (practicalTerms.length === 0) {
        logInfo("Brak terminow praktycznych");
      } else {
        logInfo(`Znaleziono ${practicalTerms.length} terminow praktycznych.`);

        const earliestSavedTs = getEarliestTimestampFromSet(sentSlots);
        console.log("EARLIEST SAVED TS:", earliestSavedTs);

        let betterSlots = [];

        if (!earliestSavedTs) {
          const initialSlots = practicalTerms.slice(0, 5);

          for (const term of initialSlots) {
            sentSlots.add(buildSlotKey(term));
          }

          await saveSeenSlots(config.seenSlotsFilePath, sentSlots);
          logInfo("Initial slots saved (no notification).");
          await saveJson(config.debugSlotsFilePath, practicalTerms);
          await sleep(POLL_INTERVAL_MS);
          continue;
        } else {
          betterSlots = practicalTerms.filter((slot) => {
            const ts = getSlotTimestamp(slot);
            return ts < earliestSavedTs;
          });
        }

        console.log("BETTER SLOTS:", betterSlots.length);

        if (betterSlots.length === 0 && !FORCE_BOOKING) {
          logInfo("Brak wcześniejszych slotów.");
        } else {
          const notifiedSlots = await notify(betterSlots);

          for (const term of notifiedSlots) {
            sentSlots.add(buildSlotKey(term));
          }

          await saveSeenSlots(config.seenSlotsFilePath, sentSlots);

          if (!bookingInProgress) {
            bookingInProgress = true;

            try {
              await runBooker(getSessionPage());
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
      const errorMessage = String(error?.message || error);

      if (
        errorMessage.includes("401") ||
        errorMessage.includes("SESSION_EXPIRED_HTML")
      ) {
        session = null;
        console.log("SESSION STATE:", session ? "OK" : "MISSING");
        continue;
      }

      if (isNetworkFetchError(errorMessage)) {
        consecutiveFetchFailures += 1;

        if (consecutiveFetchFailures >= MAX_CONSECUTIVE_FETCH_FAILURES) {
          session = null;
        }

        logError("Blad sieci podczas pobierania terminarza.", error);
        await sleep(FETCH_FAILURE_COOLDOWN_MS);
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
