const fs = require("fs/promises");
const path = require("path");

const ACTIVITY_LOG_FILE = path.resolve(process.cwd(), "activity-log.jsonl");
const DAILY_REPORT_FILE = path.resolve(process.cwd(), "daily-report.json");
const STATE_FILE = path.resolve(process.cwd(), "activity-state.json");
const HOUR_KEYS = Array.from({ length: 24 }, (_, index) => String(index).padStart(2, "0"));

let lastSlotsMap = new Map();
let exitHooksRegistered = false;
let stateLoadPromise = null;

function createEmptyHourlyStats() {
  return Object.fromEntries(HOUR_KEYS.map((hour) => [hour, 0]));
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
  };
}

function createEvent(type, slotKey, lifetimeSec) {
  const now = new Date();
  const parts = getWarsawDateParts(now);

  return {
    type,
    source: "FULL",
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

function registerExitHooks() {
  if (exitHooksRegistered) {
    return;
  }

  exitHooksRegistered = true;

  process.once("beforeExit", async () => {
    await rebuildDailyReportFromLog();
  });

  process.once("SIGINT", async () => {
    await rebuildDailyReportFromLog();
    process.exit(0);
  });

  process.once("SIGTERM", async () => {
    await rebuildDailyReportFromLog();
    process.exit(0);
  });
}

async function processSlots(currentSlots) {
  registerExitHooks();

  try {
    await ensureStateLoaded();

    const now = Date.now();
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
      await appendEvent(createEvent("APPEARED", slotKey));
    }

    for (const disappearedSlot of disappearedSlots) {
      await appendEvent(
        createEvent("DISAPPEARED", disappearedSlot.slotKey, disappearedSlot.lifetimeSec)
      );
    }

    lastSlotsMap = currentSlotsMap;
    await saveState(lastSlotsMap);
    await rebuildDailyReportFromLog();
  } catch (error) {
    console.error("activityTracker process failed:", error);
  }
}

async function rebuildDailyReportFromLog() {
  try {
    const raw = await fs.readFile(ACTIVITY_LOG_FILE, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    const report = {};

    for (const line of lines) {
      let event;

      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }

      const date = event.date;
      const hour = event.time?.slice(0, 2);

      if (!date || !hour) {
        continue;
      }

      if (!report[date]) {
        report[date] = {
          appearByHour: createEmptyHourlyStats(),
          disappearByHour: createEmptyHourlyStats(),
          totalAppeared: 0,
          totalDisappeared: 0,
          lifetimeSum: 0,
          lifetimeCount: 0,
        };
      }

      if (event.type === "APPEARED") {
        report[date].appearByHour[hour] += 1;
        report[date].totalAppeared += 1;
      }

      if (event.type === "DISAPPEARED") {
        report[date].disappearByHour[hour] += 1;
        report[date].totalDisappeared += 1;

        if (typeof event.lifetimeSec === "number") {
          report[date].lifetimeSum += event.lifetimeSec;
          report[date].lifetimeCount += 1;
        }
      }
    }

    for (const date of Object.keys(report)) {
      const stats = report[date];

      stats.avgLifetimeSeconds =
        stats.lifetimeCount === 0 ? 0 : Math.round(stats.lifetimeSum / stats.lifetimeCount);

      delete stats.lifetimeSum;
      delete stats.lifetimeCount;
    }

    await fs.writeFile(DAILY_REPORT_FILE, JSON.stringify(report, null, 2), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      await fs.writeFile(DAILY_REPORT_FILE, JSON.stringify({}, null, 2), "utf8");
      return;
    }

    console.error("rebuildDailyReportFromLog failed:", error);
  }
}

module.exports = {
  processSlots,
};
