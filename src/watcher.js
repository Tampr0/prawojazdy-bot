const fs = require("fs/promises");
const { getFetchTimingConfig, loadConfig } = require("./config");
const { fetchSchedule, fetchWithRetry } = require("./checker");
const { runBooker } = require("./booker");
const { bookSlotAPI, pollReservationDetailsDiagnostic } = require("./bookerApi");
const { logInfo, logError, logStatus, logFetchHeader, logFetch } = require("./logger");
const {
  ensureSession,
  getSessionPage,
  resetBrowser,
  shouldRefreshSession,
} = require("./session");
const { saveJson } = require("./storage");
const { sendTelegramMessage } = require("./notifier");
const activityTracker = require("./activityTracker");
const { writeDiagnosticEvent } = require("./bookingDiagnostics");
const { createFetchStatsSession, getLiveStats } = require("./fetchStats");

const FORCE_BOOKING = false; // true dla testow
const DEBUG = false;
const fetchTimingConfig = getFetchTimingConfig();

const BOOKING_LOOP_DELAY_MS = 400; // delay between slot booking attempts inside one burst round
const BOOKING_BURST_INTERVAL_MS = 500; // delay between booking rounds in background worker
const PARALLEL_BOOKING_STAGGER_MS = 200;
const FIGHT_MODE_TIMEOUT_MS = 15000; // stale fight mode timeout
const MAX_ACTIVE_SLOT_VALIDATIONS = 2;
const FETCH_FAILURE_COOLDOWN_MS = 30000;
const RANGE_DAYS = 60;
const MAX_LOGGED_TERMS = 10;
const MAX_CONSECUTIVE_FETCH_FAILURES = 3;
const sentSlots = new Set();
let globalBookingSuccess = false;
let postSuccessCheckDone = false; // do testów czy termin jest widoczny dalej po zarezerwowaniu
let bookingInProgress = false;
let statusDots = "";
let singleReservationAttemptDone = false;
let winningReservationId = null;
let bookingBatchRotationOffset = 0;

let burstWorkerStarted = false;
let fightModeActive = false;
let fightSlotsSnapshot = [];
let fightModeLastSeenAt = 0;

let validationWorkerStarted = false;
let slotCombatState = new Map();

let combatStats = createEmptyCombatStats();

function getNextInterval() {
  return (
    fetchTimingConfig.pollIntervalMs +
    Math.floor(Math.random() * (fetchTimingConfig.pollJitterMaxMs + 1))
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rotateSlots(slots, offset) {
  if (!Array.isArray(slots) || slots.length === 0) {
    return [];
  }

  const normalizedOffset = ((offset % slots.length) + slots.length) % slots.length;
  return [...slots.slice(normalizedOffset), ...slots.slice(0, normalizedOffset)];
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

function formatFetchStatsForStatus() {
  const liveStats = getLiveStats();
  const raw = liveStats?.raw || {};
  const derived = liveStats?.derived || {};

  return [
    `avg:${Number(derived.avgSuccessIntervalSec || 0).toFixed(1)}s`,
    `ALL:${Number(raw.allAttempts || 0)}`,
    `noWAF:${Number(derived.noWafPercent || 0).toFixed(1)}%`,
    `R1:${Math.round(Number(derived.retry1PercentOfWaf || 0))}%(${Number(raw.retry1Count || 0)})`,
    `R2:${Math.round(Number(derived.retry2PercentOfWaf || 0))}%(${Number(raw.retry2Count || 0)})`,
    `R3:${Math.round(Number(derived.retry3PercentOfWaf || 0))}%(${Number(raw.retry3Count || 0)})`,
    `R4:${Math.round(Number(derived.retry4PercentOfWaf || 0))}%(${Number(raw.retry4Count || 0)})`,
    `FAIL:${Math.round(Number(derived.failedPercentOfWaf || 0))}%(${Number(raw.fetchFailedCount || 0)})`,
  ].join(" | ");
}

function startEventLine() {
  console.log("");
}

function createEmptyCombatStats() {
  return {
    fightStartedAt: 0,
    fightArmedCount: 0,
    fightClearedCount: 0,
    burstRounds: 0,
    reservationAttempts: 0,
    reservationCandidates201: 0,
    reservation422: 0,
    validationStarts: 0,
    validationSuccesses: 0,
    validationNullFinishes: 0,
    bookingWorkerErrors: 0,
    validationWorkerErrors: 0,
  };
}

function resetCombatStatsForNewFight() {
  combatStats = {
    ...createEmptyCombatStats(),
    fightStartedAt: Date.now(),
    fightArmedCount: combatStats.fightArmedCount + 1,
  };
}

function getCombatDurationMs() {
  if (!combatStats.fightStartedAt) {
    return 0;
  }

  return Date.now() - combatStats.fightStartedAt;
}

function logCombatSummary(reason) {
  const durationMs = getCombatDurationMs();

  console.log(
    `[COMBAT SUMMARY] reason=${reason} durationMs=${durationMs} ` +
    `armed=${combatStats.fightArmedCount} cleared=${combatStats.fightClearedCount} ` +
    `burstRounds=${combatStats.burstRounds} reservationAttempts=${combatStats.reservationAttempts} ` +
    `candidates201=${combatStats.reservationCandidates201} reservation422=${combatStats.reservation422} ` +
    `validationStarts=${combatStats.validationStarts} validationSuccesses=${combatStats.validationSuccesses} ` +
    `validationNullFinishes=${combatStats.validationNullFinishes} ` +
    `bookingWorkerErrors=${combatStats.bookingWorkerErrors} validationWorkerErrors=${combatStats.validationWorkerErrors}`
  );
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

function createSlotCombatState(slotId) {
  return {
    slotId,
    pausedBecause422: false,
    activeValidation: null,
    recentCandidates: [],
    last422At: 0,
    new201After422: false,
  };
}

function getSlotCombatState(slotId) {
  if (!slotId) {
    return null;
  }

  if (!slotCombatState.has(slotId)) {
    slotCombatState.set(slotId, createSlotCombatState(slotId));
  }

  return slotCombatState.get(slotId);
}

function cleanupSlotCombatState(slotId) {
  const state = slotCombatState.get(slotId);

  if (!state) {
    return;
  }

  const hasActiveValidation = !!state.activeValidation;
  const hasRecentCandidates =
    Array.isArray(state.recentCandidates) && state.recentCandidates.length > 0;

  if (!state.pausedBecause422 && !hasActiveValidation && !hasRecentCandidates) {
    slotCombatState.delete(slotId);
  }
}

function resetSlotPause(slotId) {
  const state = getSlotCombatState(slotId);

  if (!state) {
    return;
  }

  state.pausedBecause422 = false;
  state.last422At = 0;
  state.new201After422 = false;
  state.activeValidation = null;
  cleanupSlotCombatState(slotId);
}

function pauseSlotAfter422(slotId) {
  const state = getSlotCombatState(slotId);

  if (!state) {
    return;
  }

  state.pausedBecause422 = true;
  state.last422At = Date.now();
  state.new201After422 = false;
}

function addSlotReservationCandidate(slot, result, session) {
  const reservationId =
    result?.__diagnostics?.reservationId ||
    result?.id ||
    null;

  if (!slot || !slot.id || !reservationId) {
    return null;
  }

  const candidate = {
    storedAt: Date.now(),
    reservationId,
    slot: {
      id: slot.id,
      date: slot.date,
      time: slot.time,
      wordId: slot.wordId,
      amount: slot.amount ?? null,
      places: slot.places ?? null,
    },
    diagnostics: result?.__diagnostics || null,
    session,
  };

  const state = getSlotCombatState(slot.id);

  if (!state) {
    return candidate;
  }

  state.recentCandidates = [
    candidate,
    ...(state.recentCandidates || []).filter(
      (entry) => entry && entry.reservationId !== candidate.reservationId
    ),
  ].slice(0, 2);

  return candidate;
}

function buildPaymentUrlFromReservationId(reservationId) {
  return `https://info-car.pl/new/prawo-jazdy/zapisz-sie-na-egzamin-na-prawo-jazdy/${reservationId}/platnosc`;
}

function getCandidatesToValidateForSlot(slotId) {
  const state = getSlotCombatState(slotId);

  if (!state) {
    return [];
  }

  state.recentCandidates = (state.recentCandidates || [])
    .filter((candidate) => candidate && candidate.reservationId)
    .slice(0, 2);

  return state.recentCandidates;
}

function clearSlotCandidates(slotId) {
  const state = getSlotCombatState(slotId);

  if (!state) {
    return;
  }

  state.recentCandidates = [];
  cleanupSlotCombatState(slotId);
}

function markNew201After422(slotId) {
  const state = getSlotCombatState(slotId);

  if (!state || !state.pausedBecause422) {
    return;
  }

  state.new201After422 = true;
}

function resetSlotSuspicion(slotId) {
  const state = getSlotCombatState(slotId);

  if (!state) {
    return;
  }

  state.new201After422 = false;
}

function shouldSkipSecondOldCandidate(slotId) {
  const state = getSlotCombatState(slotId);

  if (!state) {
    return false;
  }

  return !!state.new201After422;
}

function clearAllSlotCombatState() {
  slotCombatState.clear();
}

function getActiveSlotValidationCount() {
  let count = 0;

  for (const state of slotCombatState.values()) {
    if (state?.activeValidation) {
      count += 1;
    }
  }

  return count;
}

function isFightModeStale() {
  if (!fightModeActive || fightModeLastSeenAt <= 0) {
    return false;
  }

  return Date.now() - fightModeLastSeenAt > FIGHT_MODE_TIMEOUT_MS;
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

      if (isFightModeStale()) {
        combatStats.fightClearedCount += 1;
        console.log("🧹 FIGHT MODE CLEARED | stale timeout");
        logCombatSummary("stale-timeout");
        clearFightState();
        await sleep(250);
        continue;
      }

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
      console.log(`🔥 BURST ROUND START | slots: ${slots.length} | slotDelayMs: ${BOOKING_LOOP_DELAY_MS} | burstIntervalMs: ${BOOKING_BURST_INTERVAL_MS}`);
      combatStats.burstRounds += 1;
      const isFirstBurstRound = fightModeLastSeenAt > 0 && Date.now() - fightModeLastSeenAt < BOOKING_BURST_INTERVAL_MS + 250;

      for (const slot of slots) {
        if (!slot || !slot.id || globalBookingSuccess) {
          continue;
        }

        try {
          console.log("TRY API BOOKING:", slot.id, slot.date, slot.time);
          combatStats.reservationAttempts += 1;

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

          combatStats.reservationCandidates201 += 1;
          const candidate = addSlotReservationCandidate(slot, {
            ...result,
            __diagnostics: {
              ...(result?.__diagnostics || {}),
            },
          }, session);

          console.log("RESERVATION CANDIDATE:", candidate);

          const slotState = getSlotCombatState(slot.id);

          if (slotState?.pausedBecause422) {
            markNew201After422(slot.id);
          }

          writeDiagnosticEvent({
            source: "WATCHER",
            kind: "reservation-candidate",
            reservationId: candidate?.reservationId || null,
            slot: candidate?.slot || null,
            diagnostics: candidate?.diagnostics || null,
            slotPaused: slotState ? slotState.pausedBecause422 : false,
            slotQueuedCandidates: slotState ? slotState.recentCandidates.length : 0,
            new201After422: slotState ? slotState.new201After422 : false,
            combatStatsSnapshot: {
              burstRounds: combatStats.burstRounds,
              reservationAttempts: combatStats.reservationAttempts,
              reservationCandidates201: combatStats.reservationCandidates201,
              reservation422: combatStats.reservation422,
              validationStarts: combatStats.validationStarts,
              validationSuccesses: combatStats.validationSuccesses,
              validationNullFinishes: combatStats.validationNullFinishes,
            },
            note: "Reservation POST returned candidate result; stored in slot-local recent reservation candidates",
          });
        } catch (apiError) {
          const msg = String(apiError?.message || apiError);

          console.log("BOOK ERROR:", msg);

          if (msg.includes("422")) {
            console.log("ℹ️ 422 another-started - keeping burst alive, no success assumption");
            combatStats.reservation422 += 1;

            pauseSlotAfter422(slot.id);
            console.log("SLOT PAUSED AFTER 422:", slot.id);

            const slotState = getSlotCombatState(slot.id);

            writeDiagnosticEvent({
              source: "WATCHER",
              kind: "reservation-422",
              slot: {
                id: slot.id,
                date: slot.date,
                time: slot.time,
                wordId: slot.wordId,
                amount: slot.amount ?? null,
                places: slot.places ?? null,
              },
              errorMessage: msg,
              slotPaused: true,
              slotQueuedCandidates: slotState ? slotState.recentCandidates.length : 0,
              note: "Reservation returned 422; slot paused and moved into slot-local validation mode",
            });

            continue;
          }
        }

        await sleep(BOOKING_LOOP_DELAY_MS);
      }

      startEventLine();
      console.log("🔥 BURST ROUND END");
    } catch (workerError) {
      console.log("BURST WORKER ERROR:", String(workerError?.message || workerError));
      combatStats.bookingWorkerErrors += 1;
    } finally {
      bookingInProgress = false;
    }

    await sleep(BOOKING_BURST_INTERVAL_MS);
  }
}

async function runReservationValidationWorker() {
  if (validationWorkerStarted) {
    return;
  }

  validationWorkerStarted = true;
  console.log("🧪 RESERVATION VALIDATION WORKER STARTED");

  while (true) {
    try {
      if (globalBookingSuccess) {
        await sleep(1000);
        continue;
      }

      if (getActiveSlotValidationCount() >= MAX_ACTIVE_SLOT_VALIDATIONS) {
        await sleep(100);
        continue;
      }

      for (const state of slotCombatState.values()) {
        if (!state || !state.pausedBecause422) {
          continue;
        }

        if (state.activeValidation) {
          continue;
        }

        const candidates = getCandidatesToValidateForSlot(state.slotId);

        if (candidates.length === 0) {
          resetSlotPause(state.slotId);
          clearSlotCandidates(state.slotId);
          continue;
        }

        state.activeValidation = {
          startedAt: Date.now(),
          candidateReservationIds: candidates.map((candidate) => candidate.reservationId),
        };

        console.log("SLOT VALIDATION START:", state.slotId);

        void (async () => {
          try {
            const candidatesToValidate = getCandidatesToValidateForSlot(state.slotId).slice(0, 2);
            let validated = false;

            for (let index = 0; index < candidatesToValidate.length; index++) {
              if (globalBookingSuccess) {
                return;
              }

              const candidate = candidatesToValidate[index];

              if (!candidate || !candidate.reservationId) {
                continue;
              }

              combatStats.validationStarts += 1;

              console.log(`SLOT VALIDATION TRY ${index + 1}:`, candidate.reservationId);

              const diagnostics = candidate.diagnostics || {};
              const reservationId = candidate.reservationId;
              const diagnosticCookieHeader = diagnostics.diagnosticCookieHeader || null;

              writeDiagnosticEvent({
                source: "WATCHER",
                kind: "reservation-validation-start",
                reservationId,
                slot: candidate.slot,
                diagnostics,
                slotPaused: true,
                note: "Starting slot-local background reservation validation from watcher",
              });

              const validationResult = await pollExpireTimeDiagnostic({
                session: candidate.session,
                slot: candidate.slot,
                reservationId,
                cookieHeaderOverride: diagnosticCookieHeader,
              });

              writeDiagnosticEvent({
                source: "WATCHER",
                kind: "reservation-validation-finished",
                reservationId,
                slot: candidate.slot,
                validationResult,
                slotPaused: true,
                note: "Finished slot-local background reservation validation from watcher",
              });

              if (globalBookingSuccess) {
                return;
              }

              if (validationResult && validationResult.firstNonNullExpireTime !== null) {
                combatStats.validationSuccesses += 1;
                globalBookingSuccess = true;
                clearFightState();
                clearAllSlotCombatState();

                const paymentUrl = buildPaymentUrlFromReservationId(reservationId);

                console.log("SLOT VALIDATION SUCCESS:", state.slotId, reservationId);
                console.log("✅ VALIDATED RESERVATION:", reservationId, validationResult.firstNonNullExpireTime);
                console.log("✅ VALIDATED PAYMENT URL:", paymentUrl);
                logCombatSummary("validated-success");

                await sendTelegramMessage(
                  `🔥 POTWIERDZONA REZERWACJA

📅 ${candidate.slot.date}
⏰ ${candidate.slot.time}

💳 LINK:
${paymentUrl}`
                );

                const page = getSessionPage();

                if (page && !page.isClosed()) {
                  console.log("🌐 OPENING VALIDATED PAYMENT PAGE...");
                  await sleep(500);
                  await page.goto("https://info-car.pl/new/");
                  await sleep(500);
                  await page.goto(paymentUrl);
                }

                validated = true;
                return;
              }

              if (index === 0 && shouldSkipSecondOldCandidate(state.slotId)) {
                combatStats.validationNullFinishes += 1;
                console.log("SLOT VALIDATION FAILED -> UNPAUSE:", state.slotId);
                resetSlotSuspicion(state.slotId);
                resetSlotPause(state.slotId);
                clearSlotCandidates(state.slotId);
                return;
              }
            }

            if (!validated && !globalBookingSuccess) {
              combatStats.validationNullFinishes += 1;
              console.log("SLOT VALIDATION FAILED -> UNPAUSE:", state.slotId);
              resetSlotSuspicion(state.slotId);
              resetSlotPause(state.slotId);
              clearSlotCandidates(state.slotId);
            }
          } catch (validationError) {
            console.log("VALIDATION WORKER ERROR:", String(validationError?.message || validationError));
            combatStats.validationWorkerErrors += 1;
            resetSlotSuspicion(state.slotId);
            resetSlotPause(state.slotId);
            clearSlotCandidates(state.slotId);
          } finally {
            const currentState = slotCombatState.get(state.slotId);

            if (currentState) {
              currentState.activeValidation = null;
              cleanupSlotCombatState(state.slotId);
            }
          }
        })();

        if (getActiveSlotValidationCount() >= MAX_ACTIVE_SLOT_VALIDATIONS) {
          break;
        }
      }
    } catch (validationWorkerLoopError) {
      console.log("VALIDATION WORKER ERROR:", String(validationWorkerLoopError?.message || validationWorkerLoopError));
      combatStats.validationWorkerErrors += 1;
    }

    await sleep(100);
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

  function clearSessionDependentState() {
    singleReservationAttemptDone = false;
    winningReservationId = null;
    bookingBatchRotationOffset = 0;
  }

  function isValidSessionShape(sessionToValidate) {
    return Boolean(
      sessionToValidate &&
      typeof sessionToValidate.bearerToken === "string" &&
      sessionToValidate.bearerToken.length > 0 &&
      Array.isArray(sessionToValidate.cookies)
    );
  }

  async function refreshSessionNow(reason, { hardReset }) {
    logInfo(reason);
    logFetch(`SESSION_REFRESH_START reason=${reason} hardReset=${hardReset}`);

    if (hardReset) {
      await resetBrowser();
    }

    clearSessionDependentState();

    try {
      const refreshedSession = await ensureSession(config, { forceRefresh: true });

      if (!isValidSessionShape(refreshedSession)) {
        throw new Error("SESSION_REFRESH_INVALID_SHAPE");
      }

      session = refreshedSession;
      logFetch(`SESSION_REFRESH_SUCCESS reason=${reason}`);

      if (reason === "PROACTIVE SESSION REFRESH START") {
        logInfo("PROACTIVE SESSION REFRESH SUCCESS");
      }

      return true;
    } catch (refreshError) {
      session = null;
      logError("SESSION REFRESH FAILED", refreshError);
      logFetch(
        `SESSION_REFRESH_FAILED reason=${reason} cause=${String(
          refreshError?.message || refreshError
        ).replace(/[\r\n]+/g, " ")}`
      );
      return false;
    }
  }

  function getSlotsInConfiguredRange(practicalTerms, referenceNow = Date.now()) {
    const minTs = referenceNow + config.slotMinDays * 24 * 60 * 60 * 1000;
    const maxTs = referenceNow + config.slotMaxDays * 24 * 60 * 60 * 1000;

    return practicalTerms.filter((slot) => {
      const ts = new Date(slot.date).getTime();
      return ts >= minTs && ts <= maxTs;
    });
  }

  async function runSequentialBookingBatch(slots) {
    winningReservationId = null;

    const reversedSlots = [...slots].reverse();
    const slotsToAttempt = rotateSlots(reversedSlots, bookingBatchRotationOffset);
    const firstSlotToAttempt = slotsToAttempt[0] || null;

    console.log(
      "🎯 SEQUENTIAL BOOKING BATCH START:",
      slotsToAttempt.length,
      "| rotationOffset:",
      bookingBatchRotationOffset,
      "| firstSlot:",
      firstSlotToAttempt ? firstSlotToAttempt.id : null,
      firstSlotToAttempt ? firstSlotToAttempt.date : null,
      firstSlotToAttempt ? firstSlotToAttempt.time : null
    );

    const batchResults = [];

    for (const slot of slotsToAttempt) {
      try {
        if (globalBookingSuccess) {
          batchResults.push({
            slotId: slot.id || null,
            reservationId: null,
            outcome: "INCONCLUSIVE",
          });
          break;
        }

        console.log("🎯 BOOKING SLOT:", slot.id, slot.date, slot.time);

        const result = await bookSlotAPI(session, slot);

        const reservationId =
          result?.__diagnostics?.reservationId ||
          result?.id ||
          null;

        if (!reservationId) {
          console.log("BOOKING RESULT WITHOUT RESERVATION ID");

          writeDiagnosticEvent({
            source: "WATCHER",
            kind: "sequential-booking-missing-reservation-id",
            slot: {
              id: slot.id,
              date: slot.date,
              time: slot.time,
              wordId: slot.wordId,
              amount: slot.amount ?? null,
              places: slot.places ?? null,
            },
            bookingResult: result,
            note: "Sequential booking response did not include reservationId",
          });

          batchResults.push({
            slotId: slot.id || null,
            reservationId: null,
            outcome: "INCONCLUSIVE",
          });
          continue;
        }

        const reservationDetailsResult =
          await pollReservationDetailsDiagnostic({
            session,
            slot,
            reservationId,
            cookieHeaderOverride:
              result?.__diagnostics?.diagnosticCookieHeader || null,
            shouldAbort: () =>
              globalBookingSuccess &&
              winningReservationId !== reservationId,
          });

        const validationOutcome =
          reservationDetailsResult?.validationOutcome || "INCONCLUSIVE";

        if (validationOutcome === "SUCCESS" && !globalBookingSuccess) {
          globalBookingSuccess = true;
          winningReservationId = reservationId;

          const paymentUrl =
            buildPaymentUrlFromReservationId(reservationId);

          console.log("💳 PAYMENT URL:", paymentUrl);

          writeDiagnosticEvent({
            source: "WATCHER",
            kind: "sequential-booking-success",
            reservationId,
            paymentUrl,
            slot: {
              id: slot.id,
              date: slot.date,
              time: slot.time,
              wordId: slot.wordId,
              amount: slot.amount ?? null,
              places: slot.places ?? null,
            },
            reservationDetailsResult,
            note: "Reservation validated as PLACE_RESERVED in sequential booking batch",
          });

          await sendTelegramMessage(
            `✅ REZERWACJA POTWIERDZONA

📅 ${slot.date}
⏰ ${slot.time}

💳 LINK:
${paymentUrl}`
          );

          batchResults.push({
            slotId: slot.id || null,
            reservationId,
            outcome: "SUCCESS",
          });
          break;
        }

        if (validationOutcome === "FAILED") {
          writeDiagnosticEvent({
            source: "WATCHER",
            kind: "sequential-booking-cancelled",
            reservationId,
            slot: {
              id: slot.id,
              date: slot.date,
              time: slot.time,
              wordId: slot.wordId,
              amount: slot.amount ?? null,
              places: slot.places ?? null,
            },
            reservationDetailsResult,
            note: "Reservation validation ended with CANCELLED status",
          });

          batchResults.push({
            slotId: slot.id || null,
            reservationId,
            outcome: "FAILED",
          });
          continue;
        }

        writeDiagnosticEvent({
          source: "WATCHER",
          kind: "sequential-booking-inconclusive",
          reservationId,
          slot: {
            id: slot.id,
            date: slot.date,
            time: slot.time,
            wordId: slot.wordId,
            amount: slot.amount ?? null,
            places: slot.places ?? null,
          },
          reservationDetailsResult,
          note: "Reservation validation finished without PLACE_RESERVED or CANCELLED",
        });

        batchResults.push({
          slotId: slot.id || null,
          reservationId,
          outcome: "INCONCLUSIVE",
        });
      } catch (error) {
        writeDiagnosticEvent({
          source: "WATCHER",
          kind: "sequential-booking-task-error",
          slot: {
            id: slot.id,
            date: slot.date,
            time: slot.time,
            wordId: slot.wordId,
            amount: slot.amount ?? null,
            places: slot.places ?? null,
          },
          errorMessage: String(error?.message || error),
          note: "Sequential booking task failed",
        });

        console.log(
          "SEQUENTIAL BOOKING TASK ERROR:",
          String(error?.message || error)
        );

        batchResults.push({
          slotId: slot.id || null,
          reservationId: null,
          outcome: "ERROR",
        });
      }
    }

    if (!globalBookingSuccess && slots.length > 0) {
      bookingBatchRotationOffset =
        (bookingBatchRotationOffset + 1) % slots.length;
    }

    writeDiagnosticEvent({
      source: "WATCHER",
      kind: "sequential-booking-batch-finished",
      winningReservationId,
      batchResults,
      note: "Sequential booking batch finished",
    });

    return {
      batchResults,
      success: globalBookingSuccess,
    };
  }

  sentSlots.clear();

  for (const slotKey of loadedSlots) {
    sentSlots.add(slotKey);
  }

  createFetchStatsSession({
    pollIntervalMs: fetchTimingConfig.pollIntervalMs,
    pollJitterMaxMs: fetchTimingConfig.pollJitterMaxMs,
    fetchRetryDelaysMs: fetchTimingConfig.fetchRetryDelaysMs,
  });

  logInfo(`Watcher uruchomiony. Interwal: ${fetchTimingConfig.pollIntervalMs / 1000}s`);
  logFetchHeader({
    pollInterval: fetchTimingConfig.pollIntervalMs,
    pollJitterMaxMs: fetchTimingConfig.pollJitterMaxMs,
    retryDelays: fetchTimingConfig.fetchRetryDelaysMs,
    sessionRefreshIntervalMs: config.sessionRefreshIntervalMs,
  });
  startEventLine();

  while (true) {
    if (globalBookingSuccess) {
      console.log("🛑 BOOKING SUCCESS - WATCHER PAUSED");
      await sleep(fetchTimingConfig.pollIntervalMs);
      continue;
    }

    try {
      if (!session) {
        startEventLine();
        console.log("NO SESSION -> creating...");
        session = await ensureSession(config);

        if (
          !session ||
          typeof session.bearerToken !== "string" ||
          session.bearerToken.length === 0 ||
          !Array.isArray(session.cookies)
        ) {
          startEventLine();
          logError("SESSION INVALID AFTER CAPTURE -> HARD RESET");
          await resetBrowser();
          session = null;
          clearSessionDependentState();
          await sleep(1000);
          continue;
        }

        startEventLine();
        console.log("SESSION READY");
        console.log(`WARMUP WAIT -> first fetch in ${fetchTimingConfig.pollIntervalMs}ms`);
        await sleep(fetchTimingConfig.pollIntervalMs);
      }

      if (shouldRefreshSession(session, config.sessionRefreshIntervalMs)) {
        startEventLine();

        if (!(await refreshSessionNow("PROACTIVE SESSION REFRESH START", { hardReset: false }))) {
          continue;
        }
      }

      const payload = buildPayload();
      const responseData = await fetchWithRetry(() => fetchSchedule(session, payload, config));
      consecutiveFetchFailures = 0;
      let practicalTerms = getPracticalTerms(responseData, payload);

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

      const filteredByRange = getSlotsInConfiguredRange(practicalTerms, now);
      const statusTime = new Date().toLocaleTimeString("pl-PL", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      const status = `STATUS${getDots()} | ${statusTime} | session: ${session ? "OK" : "NO"} | ${formatFetchStatsForStatus()}`;
      logStatus(status);

      if (filteredByRange.length === 0) {
        if (fightModeActive) {
          combatStats.fightClearedCount += 1;
          startEventLine();
          console.log("🧹 FIGHT MODE CLEARED | no slots in current fetch");
          logCombatSummary("no-slots-in-fetch");
        }

        clearFightState();
        clearSessionDependentState();
      } else {
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

          if (newSlots.length > 0) {
            console.log("IMMEDIATE RETRY LOOP START");

            let retrySlots = newSlots;

            while (retrySlots.length > 0 && !globalBookingSuccess) {
              const batchResult = await runSequentialBookingBatch(retrySlots);

              if (batchResult.success || globalBookingSuccess) {
                console.log("IMMEDIATE RETRY LOOP STOP | success");
                break;
              }

              console.log("IMMEDIATE RETRY LOOP REFRESH");

              const retryPayload = buildPayload();
              const retryResponseData = await fetchWithRetry(() =>
                fetchSchedule(session, retryPayload, config)
              );
              consecutiveFetchFailures = 0;
              practicalTerms = getPracticalTerms(retryResponseData, retryPayload);

              void activityTracker.processSlots(practicalTerms);

              if (DEBUG) {
                const retryNow = Date.now();
                const retryMinTs = retryNow + config.slotMinDays * 24 * 60 * 60 * 1000;
                const retryMaxTs = retryNow + config.slotMaxDays * 24 * 60 * 60 * 1000;
                const retryMockTs = Math.floor((retryMinTs + retryMaxTs) / 2);

                practicalTerms.unshift({
                  id: "MOCK_" + Date.now(),
                  date: new Date(retryMockTs).toISOString(),
                  time: "08:00",
                  wordId: "3",
                  examType: "PRACTICAL",
                  places: 1,
                  amount: 222,
                });
              }

              retrySlots = getSlotsInConfiguredRange(practicalTerms, Date.now());

              if (retrySlots.length === 0) {
                console.log("IMMEDIATE RETRY LOOP STOP | no slots");
                break;
              }
            }
          }
        }
      }

      await saveJson(config.debugSlotsFilePath, practicalTerms);
    } catch (error) {
      const errorMessage = String(error?.message || error);

      if (
        error?.code === "SESSION_INVALID_STATUS" ||
        error?.code === "SESSION_INVALID_HTML" ||
        errorMessage.includes("401") ||
        errorMessage.includes("403") ||
        errorMessage.includes("SESSION_MISSING") ||
        errorMessage.includes("SESSION_EXPIRED_HTML") ||
        errorMessage.includes("<!DOCTYPE html") ||
        errorMessage.includes("<html")
      ) {
        startEventLine();

        const refreshReason =
          error?.status === 401 || errorMessage.includes("401")
            ? "IMMEDIATE SESSION REFRESH AFTER 401"
            : error?.status === 403 || errorMessage.includes("403")
              ? "IMMEDIATE SESSION REFRESH AFTER 403"
              : "IMMEDIATE SESSION REFRESH AFTER SESSION INVALIDATION";

        await refreshSessionNow(refreshReason, { hardReset: true });

        continue;
      }

      if (isNetworkFetchError(errorMessage)) {
        consecutiveFetchFailures += 1;

        if (consecutiveFetchFailures >= MAX_CONSECUTIVE_FETCH_FAILURES) {
          startEventLine();
          logError("TOO MANY FETCH FAILURES -> HARD RESET");

          await resetBrowser();   // 🔥 DODAJ
          session = null;
          clearSessionDependentState();
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
