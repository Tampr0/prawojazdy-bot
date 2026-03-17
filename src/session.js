const fs = require("fs/promises");
const { loadConfig } = require("./config");
const { launchBrowserContext } = require("./booker");

const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
let ensureSessionPromise = null;

function extractBearerToken(authorizationHeader) {
  if (!authorizationHeader) {
    return null;
  }

  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function isSessionShapeValid(session) {
  return Boolean(
    session &&
      typeof session.bearerToken === "string" &&
      session.bearerToken.length > 0 &&
      Array.isArray(session.cookies) &&
      typeof session.userAgent === "string" &&
      session.userAgent.length > 0 &&
      typeof session.capturedAt === "string"
  );
}

function isSessionFresh(session) {
  const capturedAtMs = new Date(session.capturedAt).getTime();

  if (Number.isNaN(capturedAtMs)) {
    return false;
  }

  return Date.now() - capturedAtMs < SESSION_MAX_AGE_MS;
}

async function clickVisible(page, text, timeout = 30000) {
  const pattern = new RegExp(text, "i");
  const candidates = [
    page.getByRole("link", { name: pattern }).first(),
    page.getByRole("button", { name: pattern }).first(),
    page.getByText(pattern).first(),
  ];

  for (const locator of candidates) {
    try {
      await locator.waitFor({ state: "visible", timeout });
      await locator.click();
      return;
    } catch (error) {
      // Try the next selector strategy.
    }
  }

  throw new Error(`Nie znaleziono elementu: ${text}`);
}

async function fillVisible(page, selectors, value, timeout = 30000) {
  for (const locatorFactory of selectors) {
    const locator = locatorFactory(page).first();

    try {
      await locator.waitFor({ state: "visible", timeout });
      await locator.fill(value);
      return;
    } catch (error) {
      // Try the next selector strategy.
    }
  }

  throw new Error("Nie znaleziono pola formularza logowania.");
}

async function submitLoginForm(page, timeout = 30000) {
  const candidates = [
    page.locator('form button[type="submit"]').first(),
    page.locator('form input[type="submit"]').first(),
    page.getByRole("button", { name: /zaloguj/i }).last(),
  ];

  for (const locator of candidates) {
    try {
      await locator.waitFor({ state: "visible", timeout });
      await locator.click();
      return;
    } catch (error) {
      // Try the next selector strategy.
    }
  }

  throw new Error("Nie znaleziono przycisku logowania.");
}

async function triggerExamScheduleRequest(page) {
  await clickVisible(page, "Prawo jazdy");
  await clickVisible(page, "Sprawd");

  const pkkCard = page.getByText(/Egzamin na prawo jazdy\s*\(PKK\)/i).first();
  await pkkCard.waitFor({ state: "visible", timeout: 30000 });
  await pkkCard.locator("..").click();

  await page.getByPlaceholder(/Wybierz woj/i).click();
  await page.getByText(/doln/i).click();
  await page.getByPlaceholder(/Wybierz o/i).click();
  await page.getByRole("button", { name: /WORD Wroc/i }).click();
  await page.getByPlaceholder(/Wybierz kateg/i).click();
  await page.getByText(/^B$/).click();
  await page.getByRole("button", { name: /Dalej/i }).click();
  await page.locator('input[type="radio"]').nth(1).click();
}

async function saveSession(sessionFilePath, session) {
  await fs.writeFile(sessionFilePath, JSON.stringify(session, null, 2), "utf8");
}

async function loadSession(sessionFilePath) {
  const content = await fs.readFile(sessionFilePath, "utf8");
  return JSON.parse(content);
}

async function getValidSession(sessionFilePath) {
  try {
    const session = await loadSession(sessionFilePath);

    if (!isSessionShapeValid(session) || !isSessionFresh(session)) {
      return null;
    }

    return session;
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function loginAndCaptureSession(config = loadConfig()) {
  const login = process.env.LOGIN;
  const password = process.env.PASSWORD;

  if (!login || !password) {
    throw new Error("Missing required environment variables: LOGIN and PASSWORD");
  }

  const context = await launchBrowserContext();
  const page = context.pages()[0] || (await context.newPage());

  try {
    const requestPromise = page.waitForRequest(
      (request) =>
        request.method() === "PUT" && request.url().includes("/exam-schedule"),
      { timeout: config.captureTimeoutMs }
    );

    await page.goto(config.targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await clickVisible(page, "Zaloguj");

    await fillVisible(
      page,
      [
        (currentPage) => currentPage.getByLabel(/login|e-mail|email/i),
        (currentPage) => currentPage.getByPlaceholder(/login|e-mail|email/i),
        (currentPage) => currentPage.locator('input[type="text"]'),
        (currentPage) => currentPage.locator('input[type="email"]'),
      ],
      login
    );

    await fillVisible(
      page,
      [
        (currentPage) => currentPage.getByLabel(/haslo|password/i),
        (currentPage) => currentPage.getByPlaceholder(/haslo|password/i),
        (currentPage) => currentPage.locator('input[type="password"]'),
      ],
      password
    );

    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => {}),
      submitLoginForm(page),
    ]);

    await triggerExamScheduleRequest(page);

    const request = await requestPromise;
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
    return session;
  } finally {
    await context.close();
  }
}

async function ensureSession(config = loadConfig(), options = {}) {
  const { forceRefresh = false } = options;

  if (!forceRefresh) {
    const existingSession = await getValidSession(config.sessionFilePath);

    if (existingSession) {
      return existingSession;
    }
  }

  if (!ensureSessionPromise) {
    ensureSessionPromise = loginAndCaptureSession(config).finally(() => {
      ensureSessionPromise = null;
    });
  }

  return ensureSessionPromise;
}

module.exports = {
  ensureSession,
  loginAndCaptureSession,
  saveSession,
  loadSession,
};
