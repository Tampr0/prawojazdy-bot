const fs = require("fs");
const path = require("path");

const FETCH_STATS_FILE_PATH = path.resolve(process.cwd(), "fetch-stats.json");

let currentSession = null;

function createEmptyRawStats() {
  return {
    allAttempts: 0,
    successAttempts: 0,
    wafAttempts: 0,
    fetchOkCount: 0,
    fetchRecoveredCount: 0,
    retry1Count: 0,
    retry2Count: 0,
    retry3Count: 0,
    retry4Count: 0,
    fetchFailedCount: 0,
    successIntervalSumMs: 0,
    successIntervalCount: 0,
  };
}

function buildConfigIdentity(config) {
  return {
    pollIntervalMs: Number(config?.pollIntervalMs || 0),
    jitterMinMs: 0,
    jitterMaxMs: Number(config?.pollJitterMaxMs || 0),
    retryDelaysMs: Array.isArray(config?.fetchRetryDelaysMs)
      ? config.fetchRetryDelaysMs.map((value) => Number(value))
      : [],
  };
}

function buildConfigKey(configIdentity) {
  return JSON.stringify(configIdentity);
}

function cloneRawStats(rawStats) {
  return {
    ...createEmptyRawStats(),
    ...(rawStats || {}),
  };
}

function sumRawStats(left, right) {
  const merged = createEmptyRawStats();

  for (const key of Object.keys(merged)) {
    merged[key] = Number(left?.[key] || 0) + Number(right?.[key] || 0);
  }

  return merged;
}

function buildDerivedStats(rawStats) {
  const allAttempts = Number(rawStats.allAttempts || 0);
  const wafAttempts = Number(rawStats.wafAttempts || 0);
  const successIntervalCount = Number(rawStats.successIntervalCount || 0);
  const successIntervalSumMs = Number(rawStats.successIntervalSumMs || 0);

  const noWafPercent =
    allAttempts > 0 ? (Number(rawStats.successAttempts || 0) / allAttempts) * 100 : 0;
  const wafPercent = allAttempts > 0 ? (wafAttempts / allAttempts) * 100 : 0;

  return {
    noWafPercent,
    wafPercent,
    retry1PercentOfWaf:
      wafAttempts > 0 ? (Number(rawStats.retry1Count || 0) / wafAttempts) * 100 : 0,
    retry2PercentOfWaf:
      wafAttempts > 0 ? (Number(rawStats.retry2Count || 0) / wafAttempts) * 100 : 0,
    retry3PercentOfWaf:
      wafAttempts > 0 ? (Number(rawStats.retry3Count || 0) / wafAttempts) * 100 : 0,
    retry4PercentOfWaf:
      wafAttempts > 0 ? (Number(rawStats.retry4Count || 0) / wafAttempts) * 100 : 0,
    failedPercentOfWaf:
      wafAttempts > 0 ? (Number(rawStats.fetchFailedCount || 0) / wafAttempts) * 100 : 0,
    avgSuccessIntervalMs:
      successIntervalCount > 0 ? successIntervalSumMs / successIntervalCount : 0,
    avgSuccessIntervalSec:
      successIntervalCount > 0 ? successIntervalSumMs / successIntervalCount / 1000 : 0,
  };
}

function readPersistedStatsFile() {
  try {
    const content = fs.readFileSync(FETCH_STATS_FILE_PATH, "utf8");
    const parsed = JSON.parse(content);

    if (!parsed || typeof parsed !== "object" || typeof parsed.configs !== "object") {
      return { configs: {} };
    }

    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") {
      return { configs: {} };
    }

    throw error;
  }
}

function writePersistedStatsFile(data) {
  fs.writeFileSync(FETCH_STATS_FILE_PATH, JSON.stringify(data, null, 2));
}

function persistCurrentSession() {
  if (!currentSession) {
    return;
  }

  const persisted = readPersistedStatsFile();
  const mergedRaw = sumRawStats(currentSession.baseRawStats, currentSession.liveRawStats);

  persisted.configs[currentSession.configKey] = {
    config: currentSession.configIdentity,
    raw: mergedRaw,
    derived: buildDerivedStats(mergedRaw),
  };

  writePersistedStatsFile(persisted);
}

function recordSuccessInterval(timestampMs) {
  if (!currentSession) {
    return;
  }

  if (currentSession.lastSuccessTimestamp !== null) {
    currentSession.liveRawStats.successIntervalSumMs +=
      timestampMs - currentSession.lastSuccessTimestamp;
    currentSession.liveRawStats.successIntervalCount += 1;
  }

  currentSession.lastSuccessTimestamp = timestampMs;
}

function createFetchStatsSession(config) {
  const configIdentity = buildConfigIdentity(config);
  const configKey = buildConfigKey(configIdentity);
  const persisted = readPersistedStatsFile();
  const existingEntry = persisted.configs[configKey] || null;

  currentSession = {
    configIdentity,
    configKey,
    baseRawStats: cloneRawStats(existingEntry?.raw),
    liveRawStats: createEmptyRawStats(),
    lastSuccessTimestamp: null,
  };

  persistCurrentSession();

  return getLiveStats();
}

function recordFetchEvent(eventName, timestampMs = Date.now()) {
  if (!currentSession) {
    return;
  }

  const rawStats = currentSession.liveRawStats;

  switch (eventName) {
    case "FETCH_OK":
      rawStats.allAttempts += 1;
      rawStats.successAttempts += 1;
      rawStats.fetchOkCount += 1;
      recordSuccessInterval(timestampMs);
      break;
    case "FETCH_RECOVERED":
      rawStats.allAttempts += 1;
      rawStats.successAttempts += 1;
      rawStats.fetchRecoveredCount += 1;
      recordSuccessInterval(timestampMs);
      break;
    case "FETCH_RETRY_1":
      rawStats.allAttempts += 1;
      rawStats.wafAttempts += 1;
      rawStats.retry1Count += 1;
      break;
    case "FETCH_RETRY_2":
      rawStats.allAttempts += 1;
      rawStats.wafAttempts += 1;
      rawStats.retry2Count += 1;
      break;
    case "FETCH_RETRY_3":
      rawStats.allAttempts += 1;
      rawStats.wafAttempts += 1;
      rawStats.retry3Count += 1;
      break;
    case "FETCH_RETRY_4":
      rawStats.allAttempts += 1;
      rawStats.wafAttempts += 1;
      rawStats.retry4Count += 1;
      break;
    case "FETCH_FAILED":
      rawStats.allAttempts += 1;
      rawStats.wafAttempts += 1;
      rawStats.fetchFailedCount += 1;
      break;
    default:
      return;
  }

  persistCurrentSession();
}

function getLiveStats() {
  if (!currentSession) {
    return null;
  }

  return {
    config: currentSession.configIdentity,
    raw: cloneRawStats(currentSession.liveRawStats),
    derived: buildDerivedStats(currentSession.liveRawStats),
  };
}

module.exports = {
  createFetchStatsSession,
  recordFetchEvent,
  getLiveStats,
};
