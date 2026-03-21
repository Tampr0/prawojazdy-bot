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

function createEmptyHourlyStats() {
  return Object.fromEntries(HOUR_KEYS.map((hour) => [hour, 0]));
}

function createEmptyDailyStats() {
  return {
    appearancesByHour: createEmptyHourlyStats(),
    disappearancesByHour: createEmptyHourlyStats(),
    lifetimes: [],
    totalAppeared: 0,
    totalDisappeared: 0,
  };
}

function buildSlotKey(slot) {
  return `${slot.date}_${slot.time}_${slot.wordId}_${slot.examType}`;
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
  const lifetimeCount = stats.lifetimes.length;
  const lifetimeSum = stats.lifetimes.reduce((sum, value) => sum + value, 0);

  return {
    appearByHour: { ...stats.appearancesByHour },
    disappearByHour: { ...stats.disappearancesByHour },
    avgLifetimeSeconds: lifetimeCount === 0 ? 0 : Number((lifetimeSum / lifetimeCount).toFixed(2)),
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
      report[reportDate] = buildReportEntry(statsSnapshot);
      await fs.writeFile(DAILY_REPORT_FILE, JSON.stringify(report, null, 2), "utf8");
    })
    .catch((error) => {
      console.error("activityTracker report flush failed:", error);
    });

  return reportFlushChain;
}

function ensureStatsDate(nowParts) {
  if (!currentStatsDate) {
    currentStatsDate = nowParts.date;
    return Promise.resolve();
  }

  if (currentStatsDate === nowParts.date) {
    return Promise.resolve();
  }

  const previousDate = currentStatsDate;
  const previousStats = {
    appearancesByHour: { ...dailyStats.appearancesByHour },
    disappearancesByHour: { ...dailyStats.disappearancesByHour },
    lifetimes: [...dailyStats.lifetimes],
    totalAppeared: dailyStats.totalAppeared,
    totalDisappeared: dailyStats.totalDisappeared,
  };

  currentStatsDate = nowParts.date;
  dailyStats = createEmptyDailyStats();

  return queueReportFlush(previousDate, previousStats);
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

    const statsSnapshot = {
      appearancesByHour: { ...dailyStats.appearancesByHour },
      disappearancesByHour: { ...dailyStats.disappearancesByHour },
      lifetimes: [...dailyStats.lifetimes],
      totalAppeared: dailyStats.totalAppeared,
      totalDisappeared: dailyStats.totalDisappeared,
    };

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

    if (lastSlotsMap.size === 0) {
      console.log("TRACKER INIT - seeding state (no logs)");

      for (const slot of currentSlots) {
        const slotKey = buildSlotKey(slot);
        currentSlotsMap.set(slotKey, Date.now());
      }

      lastSlotsMap = currentSlotsMap;
      await saveState(lastSlotsMap);
      return;
    }

    for (const slot of currentSlots) {
      const slotKey = buildSlotKey(slot);
      const firstSeenTimestamp = lastSlotsMap.get(slotKey) ?? now;

      currentSlotsMap.set(slotKey, firstSeenTimestamp);

      if (!lastSlotsMap.has(slotKey)) {
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

    console.log("APPEARED:", appearedSlots.length);
    console.log("DISAPPEARED:", disappearedSlots.length);

    for (const slotKey of appearedSlots) {
      dailyStats.appearancesByHour[nowParts.hour] += 1;
      dailyStats.totalAppeared += 1;
      await appendEvent(createEvent("APPEARED", slotKey, nowParts.date));
    }

    for (const disappearedSlot of disappearedSlots) {
      dailyStats.disappearancesByHour[nowParts.hour] += 1;
      dailyStats.totalDisappeared += 1;
      dailyStats.lifetimes.push(disappearedSlot.lifetimeSec);
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
  } catch (error) {
    console.error("activityTracker process failed:", error);
  }
}

module.exports = {
  processSlots,
};
