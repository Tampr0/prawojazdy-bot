const fs = require("fs/promises");
const { loadConfig } = require("./config");
const { fetchSchedule, fetchWithRetry } = require("./checker");
const { runBooker } = require("./booker");
const { bookSlotAPI } = require("./bookerApi");
const { logInfo, logError, logStatus, logFetchHeader } = require("./logger");
const { ensureSession, getSessionPage, resetBrowser } = require("./session");
const { saveJson } = require("./storage");
const { sendTelegramMessage } = require("./notifier");
const activityTracker = require("./activityTracker");
const { writeDiagnosticEvent } = require("./bookingDiagnostics");

const FORCE_BOOKING = false; // true dla testow
const DEBUG = false;

const POLL_INTERVAL_MS = 8000;
const BOOKING_LOOP_DELAY_MS = 1500; // keep current timing in step 1
const BOOKING_BURST_INTERVAL_MS = 1000; // delay between booking rounds in background worker
const FETCH_FAILURE_COOLDOWN_MS = 30000;
const RANGE_DAYS = 60;
const MAX_LOGGED_TERMS = 10;
const MAX_CONSECUTIVE_FETCH_FAILURES = 3;
const sentSlots = new Set();
let globalBookingSuccess = false;
let postSuccessCheckDone = false; // do testów czy termin jest widoczny dalej po zarezerwowaniu
let bookingInProgress = false;
let statusDots = "";

let burstWorkerStarted = false;
let fightModeActive = false;
let fightSlotsSnapshot = [];
let fightModeLastSeenAt = 0;

function getNextInterval() {
  return POLL_INTERVAL_MS + Math.floor(Math.random() * 3000);
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

function cloneFightSlot(slot) {
  return {
    id: slot.id,
    date: slot.date,
    time: slot.time,
    wordId: slot.wordId,
    examType: slot.examType,
    places: slot.places ?? null,
    amount: slot.amount ?? null,
    additionalInfo: slot.additionalInfo ?? null,
  };
}

function updateFightState(slots) {
  fightSlotsSnapshot = Array.isArray(slots) ? slots.filter(Boolean).map(cloneFightSlot) : [];
  fightModeActive = fightSlotsSnapshot.length > 0;
  fightModeLastSeenAt = Date.now();
}

function clearFightState() {
  fightSlotsSnapshot = [];
  fightModeActive = false;
  fightModeLastSeenAt = 0;
}

function getFightSlotsSnapshot() {
  return fightSlotsSnapshot.map(cloneFightSlot);
}

async function runBookingBurstWorker(getSession) {
  if (burstWorkerStarted) {
    return;
  }

  burstWorkerStarted = true;
  console.log("⚙️ BOOKING BURST WORKER STARTED");

  while (true) {
    try {
      if (globalBookingSuccess) {
        await sleep(1000);
        continue;
      }

      const session = getSession();

      if (!session || !fightModeActive || bookingInProgress) {
        await sleep(250);
        continue;
      }

      const slots = getFightSlotsSnapshot();

      if (slots.length === 0) {
        await sleep(250);
        continue;
      }

      bookingInProgress = true;
      startEventLine();
      console.log(`🔥 BURST ROUND START | slots: ${slots.length}`);
      const isFirstBurstRound = fightModeLastSeenAt > 0 && Date.now() - fightModeLastSeenAt < BOOKING_BURST_INTERVAL_MS + 250;

      for (const slot of slots) {
        if (!slot || !slot.id || globalBookingSuccess) {
          continue;
        }

        try {
          console.log("TRY API BOOKING:", slot.id, slot.date, slot.time);

          writeDiagnosticEvent({
            source: "WATCHER",
            kind: "api-booking-attempt",
            slot: {
              id: slot.id,
              date: slot.date,
              time: slot.time,
              wordId: slot.wordId,
              amount: slot.amount ?? null,
              places: slot.places ?? null,
            },
            note: "Starting API booking attempt from watcher burst worker",
          });

          const result = await bookSlotAPI(session, slot);

          console.log("BOOK RESPONSE:", result);

          const paymentUrl = `https://info-car.pl/new/prawo-jazdy/zapisz-sie-na-egzamin-na-prawo-jazdy/${result.id}/platnosc`;

          console.log("PAYMENT URL:", paymentUrl);
          let page = getSessionPage();

          if (page && !page.isClosed()) {
            console.log("🌐 OPENING PAYMENT PAGE...");
            await sleep(500);
            await page.goto("https://info-car.pl/new/");
            await sleep(500);
            await page.goto(paymentUrl);
          }

          if (result && result.id && isFirstBurstRound) {
            await sendTelegramMessage(
              `🔥 PRÓBA REZERWACJI

                      📅 ${slot.date}
                      ⏰ ${slot.time}

                      💳 LINK:
                      ${paymentUrl}`
            );
          }
        } catch (apiError) {
          const msg = String(apiError?.message || apiError);

          console.log("BOOK ERROR:", msg);

          if (msg.includes("422")) {
            console.log("🔥 POSSIBLE SUCCESS (422) - STOP LOOP");

            await sendTelegramMessage("🔥 422 - PRAWDOPODOBNIE MAMY REZERWACJĘ");

            globalBookingSuccess = true;
            clearFightState();
            break;
          }
        }

        await sleep(BOOKING_LOOP_DELAY_MS);
      }

      startEventLine();
      console.log("🔥 BURST ROUND END");
    } catch (workerError) {
      console.log("BURST WORKER ERROR:", String(workerError?.message || workerError));
    } finally {
      bookingInProgress = false;
    }

    await sleep(BOOKING_BURST_INTERVAL_MS);
  }
}


async function runWatcher() {
  // let iteration = 0;
  // const MAX_ITERATIONS = 3; // TEST MODE - iteracje odpaleń + do odznaczenia na dole funkcji
  const config = loadConfig();
  // const loadedSlots = await loadSeenSlots(config.seenSlotsFilePath);
  const loadedSlots = new Set(); // TEST MODE - disable seen slots
  let session = null;
  let consecutiveFetchFailures = 0;

  sentSlots.clear();

  for (const slotKey of loadedSlots) {
    sentSlots.add(slotKey);
  }

  logInfo(`Watcher uruchomiony. Interwal: ${POLL_INTERVAL_MS / 1000}s`);
  logFetchHeader({
    pollInterval: POLL_INTERVAL_MS,
    retryDelays: [5000, 3000, 4000, 8000, 10000],
  });
  startEventLine();
  void runBookingBurstWorker(() => session);

  while (true) {
    if (globalBookingSuccess) {
      console.log("🛑 BOOKING SUCCESS - WATCHER PAUSED");
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

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
          clearFightState();
          await saveJson(config.debugSlotsFilePath, practicalTerms);
          await sleep(getNextInterval());
          continue;
        }

        // const newSlots = filteredByRange.filter((slot) => {
        //   const key = buildSlotKey(slot);
        //   return !sentSlots.has(key);
        // });

        const newSlots = filteredByRange; // TEST MODE - always try booking

        if (DEBUG) {
          console.log("NEW SLOTS:", newSlots.length);
        }

        if (!(newSlots.length === 0 && !FORCE_BOOKING) && !globalBookingSuccess) {
          startEventLine();
          const notifiedSlots = await notify(newSlots);
          const slotsToSave = notifiedSlots;

          for (const term of slotsToSave) {
            sentSlots.add(buildSlotKey(term));
          }

          // await saveSeenSlots(config.seenSlotsFilePath, sentSlots); // disabled for tests

          updateFightState(newSlots);

          startEventLine();
          console.log(`🔥 FIGHT MODE ARMED | slots: ${newSlots.length}`);
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

        logError("SESSION EXPIRED DETECTED -> HARD RESET");

        await resetBrowser();   // 🔥 KLUCZOWE
        session = null;

        continue;
      }

      if (isNetworkFetchError(errorMessage)) {
        consecutiveFetchFailures += 1;

        if (consecutiveFetchFailures >= MAX_CONSECUTIVE_FETCH_FAILURES) {
          startEventLine();
          logError("TOO MANY FETCH FAILURES -> HARD RESET");

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

    await sleep(getNextInterval());

  }
  // console.log("TEST DONE - exiting"); // odznaczyć jeśli chcemy aby iterował ilość odpaleń
  // process.exit(0);
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
