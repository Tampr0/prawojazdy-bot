const { chromium, firefox, webkit } = require("playwright");
const { logInfo } = require("./logger");
const { saveSession } = require("./session");

const browsers = {
  chromium,
  firefox,
  webkit,
};

function resolveBrowser(browserName) {
  return browsers[browserName] || chromium;
}

function extractBearerToken(authorizationHeader) {
  if (!authorizationHeader) {
    return null;
  }

  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

async function captureSession(config) {
  const browserType = resolveBrowser(config.browserName);

  if (browserType !== chromium) {
    throw new Error("Persistent context jest obecnie wspierany tylko dla chromium/chrome.");
  }

  const context = await chromium.launchPersistentContext(config.userDataDir, {
    channel: "chrome",
    headless: false,
    viewport: null,
    args: ["--start-maximized", "--disable-blink-features=AutomationControlled"],
  });
  const page = context.pages()[0] || (await context.newPage());

  page.on("request", (req) => {
    if (req.url().includes("exam") || req.url().includes("word")) {
      console.log("REQUEST:", req.method(), req.url());
    }
  });

  try {
    logInfo(`Otwieram strone logowania: ${config.targetUrl}`);
    await page.goto(config.targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

    const pageTitle = await page.title();
    logInfo(`Tytul strony: ${pageTitle}`);

    logInfo("Czekam na request do exam-schedule, aby zapisac sesje.");

    const request = await page.waitForRequest(
      (currentRequest) =>
        currentRequest.method() === "PUT" && currentRequest.url().includes("/exam-schedule"),
      { timeout: config.captureTimeoutMs }
    );

    const headers = request.headers();
    const bearerToken = extractBearerToken(headers.authorization);
    const cookies = await context.cookies();
    const userAgent = await page.evaluate(() => navigator.userAgent);

    if (!bearerToken) {
      throw new Error("Nie udalo sie odczytac Bearer token z requestu exam-schedule.");
    }

    const session = {
      bearerToken,
      cookies,
      userAgent,
      capturedAt: new Date().toISOString(),
    };

    await saveSession(config.sessionFilePath, session);
    logInfo(`Zapisano sesje do pliku: ${config.sessionFilePath}`);

    return session;
  } finally {
    await context.close();
  }
}

async function fetchSchedule(session, payload, config) {
  const cookieHeader = (session.cookies || [])
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");

  const response = await fetch(config.apiEndpoint, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${session.bearerToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      Cookie: cookieHeader,
      "User-Agent": session.userAgent || "Mozilla/5.0",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API returned ${response.status}: ${errorText}`);
  }

  return response.json();
}

module.exports = {
  captureSession,
  fetchSchedule,
};

const { loadConfig } = require("./config");

if (require.main === module) {
  (async () => {
    const config = loadConfig();
    await captureSession(config);
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
