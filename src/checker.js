const { chromium, firefox, webkit } = require("playwright");
const { logInfo } = require("./logger");

const browsers = {
  chromium,
  firefox,
  webkit,
};

function resolveBrowser(browserName) {
  return browsers[browserName] || chromium;
}

async function runCheck(config) {
  const browserType = resolveBrowser(config.browserName);
  const browser = await browserType.launch({ headless: config.headless });
  let page;

  try {
    page = await browser.newPage();
    await page.goto(config.targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

    const pageTitle = await page.title();
    logInfo(`Tytul strony: ${pageTitle}`);

    return {
      pageTitle,
      checkedAt: new Date().toISOString(),
    };
  } finally {
    await browser.close();
  }
}

module.exports = {
  runCheck,
};
