const fs = require("fs/promises");
const path = require("path");

const ACTIVITY_LOG_FILE = path.resolve(process.cwd(), "activity-log.jsonl");
const DAILY_REPORT_FILE = path.resolve(process.cwd(), "daily-report.json");
const STATE_FILE = path.resolve(process.cwd(), "activity-state.json");
const HOUR_KEYS = Array.from({ length: 24 }, (_, index) => String(index).padStart(2, "0"));

let lastSlotsMap = new Map();
let currentStatsDate = null;
let dailyStats = createEmptyDailyStats();
let reportFlushChain = Promise.resolve();
let exitHooksRegistered = false;
let stateLoadPromise = null;
let dailyStatsLoadPromise = null;
const flushedStatsByDate = new Map();

function createEmptyHourlyStats() {
  return Object.fromEntries(HOUR_KEYS.map((hour) => [hour, 0]));
}

function createEmptyDailyStats() {
  return {
    appearancesByHour: createEmptyHourlyStats(),
    disappearancesByHour: createEmptyHourlyStats(),
    lifetimes: [],
    lifetimeSum: 0,
    lifetimeCount: 0,
    totalAppeared: 0,
    totalDisappeared: 0,
  };
}

function buildSlotKey(slot) {
  return `${slot.date}_${slot.time}_${slot.wordId}_${slot.examType}`;
}

function createStatsSnapshot(stats) {
  return {
    appearancesByHour: { ...stats.appearancesByHour },
    disappearancesByHour: { ...stats.disappearancesByHour },
    lifetimes: [...stats.lifetimes],
    lifetimeSum: stats.lifetimeSum,
    lifetimeCount: stats.lifetimeCount,
    totalAppeared: stats.totalAppeared,
    totalDisappeared: stats.totalDisappeared,
  };
}

function getWarsawDateParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Warsaw",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value])
  );

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
    hour: parts.hour,
  };
}

function createEvent(type, slotKey, date, lifetimeSec) {
  const now = new Date();
  const parts = getWarsawDateParts(now);

  return {
    type,
    source: "FULL", // 👈 DODAJ TUTAJ
    slotKey,
    date: parts.date,
    time: parts.time,
    ts: now.toISOString(),
    ...(typeof lifetimeSec === "number" ? { lifetimeSec } : {}),
  };
}

async function appendEvent(event) {
  await fs.appendFile(ACTIVITY_LOG_FILE, `${JSON.stringify(event)}\n`, "utf8");
}

async function loadReport() {
  try {
    const raw = await fs.readFile(DAILY_REPORT_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

function mergeHours(a, b) {
  const result = {};

  for (const hour of HOUR_KEYS) {
    result[hour] = (a?.[hour] || 0) + (b?.[hour] || 0);
  }

  return result;
}

function subtractHours(currentHours, previousHours) {
  const result = {};

  for (const hour of HOUR_KEYS) {
    result[hour] = Math.max(0, (currentHours?.[hour] || 0) - (previousHours?.[hour] || 0));
  }

  return result;
}

function buildStatsFromReportEntry(reportEntry) {
  const stats = createEmptyDailyStats();

  if (!reportEntry || typeof reportEntry !== "object") {
    return stats;
  }

  stats.appearancesByHour = mergeHours(stats.appearancesByHour, reportEntry.appearByHour);
  stats.disappearancesByHour = mergeHours(stats.disappearancesByHour, reportEntry.disappearByHour);
  stats.totalAppeared = Number(reportEntry.totalAppeared || 0);
  stats.totalDisappeared = Number(reportEntry.totalDisappeared || 0);
  stats.lifetimeCount = stats.totalDisappeared;
  stats.lifetimeSum = Number(reportEntry.avgLifetimeSeconds || 0) * stats.lifetimeCount;

  return stats;
}

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return new Map(Object.entries(parsed.slots || {}));
  } catch (error) {
    if (error.code === "ENOENT") {
      return new Map();
    }

    throw error;
  }
}

async function saveState(map) {
  const slots = Object.fromEntries(map);
  await fs.writeFile(STATE_FILE, JSON.stringify({ slots }, null, 2), "utf8");
}

async function ensureStateLoaded() {
  if (!stateLoadPromise) {
    stateLoadPromise = loadState()
      .then((loadedState) => {
        lastSlotsMap = new Map(
          Array.from(loadedState.entries(), ([slotKey, firstSeenTimestamp]) => [
            slotKey,
            Number(firstSeenTimestamp),
          ])
        );
      })
      .catch((error) => {
        stateLoadPromise = null;
        throw error;
      });
  }

  await stateLoadPromise;
}

function buildReportEntry(stats) {
  return {
    appearByHour: { ...stats.appearancesByHour },
    disappearByHour: { ...stats.disappearancesByHour },
    avgLifetimeSeconds:
      stats.lifetimeCount === 0 ? 0 : Number((stats.lifetimeSum / stats.lifetimeCount).toFixed(2)),
    totalAppeared: stats.totalAppeared,
    totalDisappeared: stats.totalDisappeared,
  };
}

function queueReportFlush(reportDate, statsSnapshot) {
  if (!reportDate) {
    return reportFlushChain;
  }

  reportFlushChain = reportFlushChain
    .then(async () => {
      const report = await loadReport();
      const existingEntry = report[reportDate] || {};
      const existingStats = buildStatsFromReportEntry(existingEntry);
      const previousFlushedStats = flushedStatsByDate.get(reportDate) || createEmptyDailyStats();
      const deltaLifetimeSum = Math.max(
        0,
        Number(statsSnapshot.lifetimeSum || 0) - Number(previousFlushedStats.lifetimeSum || 0)
      );
      const deltaLifetimeCount = Math.max(
        0,
        Number(statsSnapshot.lifetimeCount || 0) - Number(previousFlushedStats.lifetimeCount || 0)
      );
      const mergedStats = {
        appearancesByHour: mergeHours(
          existingEntry.appearByHour,
          subtractHours(statsSnapshot.appearancesByHour, previousFlushedStats.appearancesByHour)
        ),
        disappearancesByHour: mergeHours(
          existingEntry.disappearByHour,
          subtractHours(
            statsSnapshot.disappearancesByHour,
            previousFlushedStats.disappearancesByHour
          )
        ),
        lifetimes: [],
        lifetimeSum: existingStats.lifetimeSum + deltaLifetimeSum,
        lifetimeCount: existingStats.lifetimeCount + deltaLifetimeCount,
        totalAppeared:
          Number(existingEntry.totalAppeared || 0) +
          Math.max(0, statsSnapshot.totalAppeared - previousFlushedStats.totalAppeared),
        totalDisappeared:
          Number(existingEntry.totalDisappeared || 0) +
          Math.max(0, statsSnapshot.totalDisappeared - previousFlushedStats.totalDisappeared),
      };

      report[reportDate] = buildReportEntry(mergedStats);
      await fs.writeFile(DAILY_REPORT_FILE, JSON.stringify(report, null, 2), "utf8");
      flushedStatsByDate.set(reportDate, createStatsSnapshot(statsSnapshot));
    })
    .catch((error) => {
      console.error("activityTracker report flush failed:", error);
    });

  return reportFlushChain;
}

async function loadDailyStatsForDate(reportDate) {
  const report = await loadReport();
  const loadedStats = buildStatsFromReportEntry(report[reportDate]);
  dailyStats = loadedStats;
  flushedStatsByDate.set(reportDate, createStatsSnapshot(loadedStats));
}

async function ensureStatsDate(nowParts) {
  if (!currentStatsDate) {
    currentStatsDate = nowParts.date;
    if (!dailyStatsLoadPromise) {
      dailyStatsLoadPromise = loadDailyStatsForDate(currentStatsDate);
    }

    await dailyStatsLoadPromise;
    return;
  }

  if (currentStatsDate === nowParts.date) {
    if (dailyStatsLoadPromise) {
      await dailyStatsLoadPromise;
    }

    return;
  }

  const previousDate = currentStatsDate;
  const previousStats = createStatsSnapshot(dailyStats);

  currentStatsDate = nowParts.date;
  dailyStats = createEmptyDailyStats();
  dailyStatsLoadPromise = loadDailyStatsForDate(currentStatsDate);

  await queueReportFlush(previousDate, previousStats);
  await dailyStatsLoadPromise;
}

function registerExitHooks() {
  if (exitHooksRegistered) {
    return;
  }

  exitHooksRegistered = true;

  const flushCurrentStats = () => {
    if (!currentStatsDate) {
      return reportFlushChain;
    }

    const statsSnapshot = createStatsSnapshot(dailyStats);

    return queueReportFlush(currentStatsDate, statsSnapshot);
  };

  process.once("beforeExit", async () => {
    await flushCurrentStats();
  });

  process.once("SIGINT", async () => {
    await flushCurrentStats();
    process.exit(0);
  });

  process.once("SIGTERM", async () => {
    await flushCurrentStats();
    process.exit(0);
  });
}

async function processSlots(currentSlots) {
  registerExitHooks();

  try {
    await ensureStateLoaded();

    const now = Date.now();
    const nowParts = getWarsawDateParts(new Date(now));
    await ensureStatsDate(nowParts);

    const currentSlotsMap = new Map();
    const appearedSlots = [];
    const disappearedSlots = [];
    const isInitialSeed = lastSlotsMap.size === 0;

    for (const slot of currentSlots) {
      const slotKey = buildSlotKey(slot);
      const firstSeenTimestamp = lastSlotsMap.get(slotKey) ?? now;

      currentSlotsMap.set(slotKey, firstSeenTimestamp);

      if (!lastSlotsMap.has(slotKey) && !isInitialSeed) {
        appearedSlots.push(slotKey);
      }
    }

    for (const [slotKey, firstSeenTimestamp] of lastSlotsMap.entries()) {
      if (!currentSlotsMap.has(slotKey)) {
        disappearedSlots.push({
          slotKey,
          lifetimeSec: Math.max(0, Math.round((now - firstSeenTimestamp) / 1000)),
        });
      }
    }

    

    for (const slotKey of appearedSlots) {
      dailyStats.appearancesByHour[nowParts.hour] += 1;
      dailyStats.totalAppeared += 1;
      await appendEvent(createEvent("APPEARED", slotKey, nowParts.date));
    }

    for (const disappearedSlot of disappearedSlots) {
      dailyStats.disappearancesByHour[nowParts.hour] += 1;
      dailyStats.totalDisappeared += 1;
      dailyStats.lifetimes.push(disappearedSlot.lifetimeSec);
      dailyStats.lifetimeSum += disappearedSlot.lifetimeSec;
      dailyStats.lifetimeCount += 1;
      await appendEvent(
        createEvent(
          "DISAPPEARED",
          disappearedSlot.slotKey,
          nowParts.date,
          disappearedSlot.lifetimeSec
        )
      );
    }

    lastSlotsMap = currentSlotsMap;
    await saveState(lastSlotsMap);
    await queueReportFlush(currentStatsDate, createStatsSnapshot(dailyStats));
  } catch (error) {
    console.error("activityTracker process failed:", error);
  }
}

module.exports = {
  processSlots,
};
