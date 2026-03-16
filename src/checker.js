const { chromium, firefox, webkit } = require("playwright");
const { parseAppointments } = require("./parser");

const browsers = {
  chromium,
  firefox,
  webkit,
};

function resolveBrowser(browserName) {
  return browsers[browserName] || chromium;
}

async function runCheck(config, state, logger) {
  const browserType = resolveBrowser(config.browserName);
  const browser = await browserType.launch({ headless: config.headless });

  logger.info("Starting availability check.", {
    browser: config.browserName,
    headless: config.headless,
  });

  try {
    const page = await browser.newPage();

    if (config.targetUrl) {
      logger.info("Target URL configured, opening placeholder page.", {
        targetUrl: config.targetUrl,
      });
      await page.goto(config.targetUrl, { waitUntil: "domcontentloaded" });
    } else {
      logger.warn("TARGET_URL is empty. Using inline placeholder content.");
      await page.setContent("<html><body><h1>Placeholder</h1></body></html>");
    }

    const pageContent = await page.content();
    const parsedResult = parseAppointments(pageContent, logger);

    return {
      ...parsedResult,
      checkedAt: new Date().toISOString(),
      previousState: state,
    };
  } finally {
    await browser.close();
  }
}

module.exports = {
  runCheck,
};
