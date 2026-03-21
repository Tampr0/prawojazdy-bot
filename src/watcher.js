const fs = require("fs/promises");
const { loadConfig } = require("./config");
const { fetchSchedule, fetchWithRetry } = require("./checker");
const { runBooker } = require("./booker");
const { bookSlotAPI } = require("./bookerApi");
const { logInfo, logError, logStatus } = require("./logger");
const { ensureSession, getSessionPage, resetBrowser } = require("./session");
const { saveJson } = require("./storage");
const { sendTelegramMessage } = require("./notifier");
const activityTracker = require("./activityTracker");

const FORCE_BOOKING = false; // true dla testow
const DEBUG = false;

const POLL_INTERVAL_MS = 15000;
const FETCH_FAILURE_COOLDOWN_MS = 30000;
const RANGE_DAYS = 60;
const MAX_LOGGED_TERMS = 10;
const MAX_CONSECUTIVE_FETCH_FAILURES = 3;
const sentSlots = new Set();
let bookingInProgress = false;
let statusDots = "";

function getNextInterval() {
  return POLL_INTERVAL_MS + Math.floor(Math.random() * 3000); // +0–3s
}

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
          date: exam?.date || day?.date || null,
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
  const key = `${slot.date}_${slot.time}_${slot.wordId}_${slot.examType}`;
  if (DEBUG) {
    console.log("SLOT KEY:", key);
  }
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

function getDots() {
  statusDots = statusDots.length >= 3 ? "" : `${statusDots}.`;
  return statusDots;
}

function startEventLine() {
  console.log("");
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
  startEventLine();

  while (true) {
    try {
      if (!session) {
        startEventLine();
        console.log("NO SESSION -> creating...");
        session = await ensureSession(config);
        startEventLine();
        console.log("SESSION READY");
      }

      const payload = buildPayload();
      const responseData = await fetchWithRetry(() => fetchSchedule(session, payload, config));
      consecutiveFetchFailures = 0;
      const practicalTerms = getPracticalTerms(responseData, payload);

      void activityTracker.processSlots(practicalTerms);

      const now = Date.now();
      if (DEBUG) {
        const minTs = now + config.slotMinDays * 24 * 60 * 60 * 1000;
        const maxTs = now + config.slotMaxDays * 24 * 60 * 60 * 1000;
        const mockTs = Math.floor((minTs + maxTs) / 2);

        practicalTerms.unshift({
          id: "MOCK_" + Date.now(),
          date: new Date(mockTs).toISOString(),
          time: "08:00",
          wordId: "3",
          examType: "PRACTICAL",
          places: 1,
          amount: 222,
        });
      }

      const minTs = now + config.slotMinDays * 24 * 60 * 60 * 1000;
      const maxTs = now + config.slotMaxDays * 24 * 60 * 60 * 1000;

      const filteredByRange = practicalTerms.filter((slot) => {
        const ts = new Date(slot.date).getTime();
        return ts >= minTs && ts <= maxTs;
      });
      const statusTime = new Date().toLocaleTimeString("pl-PL", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      const status = `STATUS${getDots()} | ${statusTime} | slots: ${filteredByRange.length} | session: ${session ? "OK" : "NO"}`;
      logStatus(status);

      if (practicalTerms.length !== 0) {
        if (filteredByRange.length === 0) {
          await saveJson(config.debugSlotsFilePath, practicalTerms);
          await sleep(getNextInterval());
          continue;
        }

        const newSlots = filteredByRange.filter((slot) => {
          const key = buildSlotKey(slot);
          return !sentSlots.has(key);
        });

        if (DEBUG) {
          console.log("NEW SLOTS:", newSlots.length);
        }

        if (!(newSlots.length === 0 && !FORCE_BOOKING)) {
          startEventLine();
          const notifiedSlots = await notify(newSlots);
          const slotsToSave = notifiedSlots;

          for (const term of slotsToSave) {
            sentSlots.add(buildSlotKey(term));
          }

          await saveSeenSlots(config.seenSlotsFilePath, sentSlots);

          if (!bookingInProgress) {
            bookingInProgress = true;

            try {
              let page = getSessionPage();

              if (!page || page.isClosed()) {
                startEventLine();
                console.log("BOOKER PAGE CLOSED -> HARD RESET");

                await resetBrowser();   // 🔥
                session = await ensureSession(config, { forceRefresh: true });
                page = getSessionPage();
              }

              if (!page || page.isClosed()) {
                throw new Error("PAGE_NOT_AVAILABLE");
              }

              const slot = newSlots[0];

              if (!slot || !slot.id) {
                startEventLine();
                console.log("INVALID SLOT - SKIP");
              } else {
                try {
                  startEventLine();
                  console.log("TRY API BOOKING:", slot);
                  console.log("FULL SLOT DEBUG:", JSON.stringify(slot, null, 2));

                  const result = await bookSlotAPI(session, slot);

                  console.log("API BOOK SUCCESS:", result);
                  const paymentUrl = `https://info-car.pl/new/prawo-jazdy/zapisz-sie-na-egzamin-na-prawo-jazdy/${result.id}/platnosc`;

                  console.log("OPEN PAYMENT:", paymentUrl);

                  await page.goto(paymentUrl);

                  startEventLine();
                  await sendTelegramMessage(
                    `🔥 SLOT ZAREZERWOWANY API

                    📅 ${slot.date}
                    ⏰ ${slot.time}

                    💳 PŁATNOŚĆ:
                    ${paymentUrl}`
                  );
                } catch (apiError) {
                  startEventLine();
                  console.log("API BOOK FAILED -> fallback to Playwright", apiError);

                  await runBooker(page);
                }
              }
            } catch (err) {
              startEventLine();
              console.error("BOOKING ERROR:", err);

              const errorMessage = String(err?.message || err);

              if (
                errorMessage.includes("PAGE_NOT_AVAILABLE") ||
                errorMessage.includes("Target page, context or browser has been closed")
              ) {
                startEventLine();
                console.log("BOOKER PAGE LOST -> HARD RESET");

                await resetBrowser();   // 🔥 BRAKOWAŁO
                session = null;
              }
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
        errorMessage.includes("403") ||
        errorMessage.includes("SESSION_EXPIRED_HTML") ||
        errorMessage.includes("<!DOCTYPE html") ||
        errorMessage.includes("<html")
      ) {
        startEventLine();
        console.log("SESSION EXPIRED DETECTED -> HARD RESET");

        await resetBrowser();   // 🔥 KLUCZOWE
        session = null;

        continue;
      }

      if (isNetworkFetchError(errorMessage)) {
        consecutiveFetchFailures += 1;

        if (consecutiveFetchFailures >= MAX_CONSECUTIVE_FETCH_FAILURES) {
          startEventLine();
          console.log("TOO MANY FETCH FAILURES -> HARD RESET");

          await resetBrowser();   // 🔥 DODAJ
          session = null;
        }

        startEventLine();
        logError("Blad sieci podczas pobierania terminarza.", error);
        await sleep(FETCH_FAILURE_COOLDOWN_MS);
        continue;
      }

      startEventLine();
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
