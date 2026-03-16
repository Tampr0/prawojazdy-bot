const { loadConfig } = require("./config");
const { runCheck } = require("./checker");
const { notify } = require("./notify");
const { createLogger } = require("./logger");
const { loadState, saveState } = require("./storage");

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const state = await loadState(config.stateFilePath, logger);

  logger.info("Application started.", {
    stateFilePath: config.stateFilePath,
    dryRun: config.dryRun,
  });

  const result = await runCheck(config, state, logger);

  const nextState = {
    ...state,
    lastCheckedAt: result.checkedAt,
    lastResult: result,
  };

  await saveState(config.stateFilePath, nextState, logger);

  if (!config.dryRun) {
    await notify(result, config, logger);
  } else {
    logger.info("Dry run enabled, skipping notifications.");
  }

  logger.info("Application finished.");
}

main().catch((error) => {
  console.error(`[FATAL] ${error.message}`);
  process.exitCode = 1;
});
