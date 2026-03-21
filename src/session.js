const fs = require("fs/promises");
const path = require("path");
const { chromium } = require("playwright");
const { loadConfig } = require("./config");

const APP_ENTRY_URL = "https://info-car.pl/new";
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const USER_DATA_DIR = path.resolve(process.cwd(), "user-data");
let ensureSessionPromise = null;
let sharedContext = null;
let sharedPage = null;

async function resetBrowser() {
  console.log("RESETTING BROWSER CONTEXT");

  if (sharedContext) {
    try {
      await sharedContext.close();
    } catch {}
  }

  sharedContext = null;
  sharedPage = null;
}

async function launchBrowserContext() {
  return chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: "chrome",
    headless: false,
    viewport: null,
    args: [
      "--start-maximized",
      "--disable-blink-features=AutomationControlled",
      "--window-position=1920,0"
    ],
    // args: ["--start-maximized", "--disable-blink-features=AutomationControlled"],
  });
}

async function ensureSharedPage() {
  if (sharedPage && !sharedPage.isClosed()) {
    return sharedPage;
  }

  if (sharedContext) {
    try {
      await sharedContext.close();
    } catch { }
    sharedContext = null;
    sharedPage = null;
  }

  sharedContext = await launchBrowserContext();
  sharedPage = sharedContext.pages()[0] || (await sharedContext.newPage());

  return sharedPage;
}

async function ensureAppPage(page) {
  const currentUrl = page.url();

  if (currentUrl !== "about:blank" && currentUrl.includes("info-car.pl")) {
    return;
  }

  console.log("INIT APP PAGE");
  await page.goto(APP_ENTRY_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForLoadState("domcontentloaded").catch(() => { });
  await page.waitForTimeout(2000);
}

async function isLocatorVisible(locator, timeout = 1500) {
  try {
    await locator.first().waitFor({ state: "visible", timeout });
    return true;
  } catch (error) {
    return false;
  }
}

async function isLoggedIn(page) {
  if (page.url().includes("logowanie")) {
    return false;
  }

  const logoutCandidates = [
    page.getByRole("button", { name: /wyloguj/i }),
    page.getByRole("link", { name: /wyloguj/i }),
    page.getByText(/wyloguj/i),
  ];

  for (const locator of logoutCandidates) {
    if (await isLocatorVisible(locator)) {
      return true;
    }
  }

  const loginCandidates = [
    page.getByRole("button", { name: /zaloguj/i }),
    page.getByRole("link", { name: /zaloguj/i }),
    page.getByText(/zaloguj/i),
  ];

  for (const locator of loginCandidates) {
    if (await isLocatorVisible(locator)) {
      return false;
    }
  }

  return page.url().includes("info-car.pl/new");
}

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

async function acceptCookies(page) {
  try {
    const btn = page.getByRole("button", { name: /akceptuj/i });
    if (await btn.isVisible({ timeout: 3000 })) {
      console.log("ACCEPT COOKIES");
      await btn.click();
    }
  } catch (e) {
    // brak cookies -> ignoruj
  }
}

async function triggerExamScheduleRequest(page) {
  await acceptCookies(page);
  await clickVisible(page, "Prawo jazdy");
  await clickVisible(page, "Sprawd");

  const pkkCard = page.getByText(/Egzamin na prawo jazdy\s*\(PKK\)/i).first();
  await pkkCard.waitFor({ state: "visible", timeout: 30000 });
  await pkkCard.locator("..").click();

  await acceptCookies(page);
  await page.getByPlaceholder(/Wybierz woj/i).click();
  await page.getByText(/doln/i).click();
  await acceptCookies(page);
  await page.getByPlaceholder(/Wybierz o/i).click();
  await page.getByRole("button", { name: /WORD Wroc/i }).click();
  await acceptCookies(page);
  
  await page.mouse.wheel(0, 400);
  const categoryInput = page.getByPlaceholder("Wybierz kategorię");
  await categoryInput.scrollIntoViewIfNeeded();
  await categoryInput.click();
  await page.waitForTimeout(500);
  await page.keyboard.type("B");
  await page.waitForTimeout(500);
  await page.keyboard.press("Enter");
  
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
function isTokenExpired(session) {
  try {
    const payload = JSON.parse(
      Buffer.from(session.bearerToken.split(".")[1], "base64").toString()
    );

    return Date.now() / 1000 > payload.exp - 60;
  } catch {
    return false;
  }
}

async function getValidSession(sessionFilePath) {
  try {
    const session = await loadSession(sessionFilePath);

    if (
      !isSessionShapeValid(session) ||
      !isSessionFresh(session) ||
      isTokenExpired(session)
    ) {
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

  const page = await ensureSharedPage();
  const context = sharedContext;

  try {
    console.log("SESSION CAPTURE START");

    if (page.isClosed()) {
      console.log("PAGE CLOSED - ABORT SESSION");
      return null;
    }

    console.log("RESET PAGE BEFORE LOGIN");

    await page.goto("about:blank");
    await page.waitForTimeout(500);

    await page.goto(config.targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await acceptCookies(page);

    try {
      await clickVisible(page, "Zaloguj");
    } catch {
      console.log("LOGIN BUTTON NOT FOUND -> FORCE RESET FLOW");

      await page.goto("https://info-car.pl/new");
      await page.waitForTimeout(1000);

      await clickVisible(page, "Zaloguj");
    }

    console.log("FILL LOGIN");
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
    

    
    await page.waitForSelector('input[type="password"]');

    try {
      await page.getByPlaceholder("Hasło").fill(password);
    } catch (error) {
      await page.locator('input[type="password"]').fill(password);
    }
    

    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => { }),
      submitLoginForm(page),
    ]);
    await page.waitForLoadState("domcontentloaded").catch(() => { });
    await acceptCookies(page);

    if (page.url().includes("logowanie")) {
      console.log("RETRY AFTER LOGIN STUCK");
      await page.reload();
      await page.waitForLoadState("domcontentloaded").catch(() => { });
      await acceptCookies(page);
    }

    for (let i = 0; i < 3; i++) {
      
      if (page.url().includes("/new/konto")) {
        console.log("FORCE CLICK FLOW");
        await acceptCookies(page);
        await page.getByText("Prawo jazdy").click();
        await page.waitForTimeout(1000);
        await page.getByText("Sprawdź dostępność terminów").click();
        await page.waitForTimeout(2000);
      }
    }

    if (page.isClosed()) {
      console.log("PAGE CLOSED - ABORT SESSION");
      return null;
    }

    console.log("TRIGGERING REQUEST");
    const requestPromise = page
      .waitForRequest(
        (request) =>
          request.method() === "PUT" && request.url().includes("/exam-schedule"),
        { timeout: 30000 }
      )
      .catch((error) => {
        if (
          page.isClosed() ||
          /Target page, context or browser has been closed/i.test(error.message)
        ) {
          console.log("Page closed during session capture");
          return null;
        }

        throw error;
      });

    await triggerExamScheduleRequest(page);

    if (page.isClosed()) {
      console.log("PAGE CLOSED - ABORT SESSION");
      return null;
    }

    const request = await requestPromise;

    if (!request) {
      console.log("REQUEST NOT TRIGGERED");
      return null;
    }

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
    console.log("SESSION CAPTURE SUCCESS");
    return session;
  } catch (err) {
    console.error("SESSION FLOW ERROR:", err);
    return null;
  }
}

async function ensureSession(config = loadConfig(), options = {}) {
  const { forceRefresh = false } = options;

  const page = await ensureSharedPage();
  await ensureAppPage(page);
  await acceptCookies(page);

  if (!forceRefresh) {
    const existingSession = await getValidSession(config.sessionFilePath);

    if (existingSession && (await isLoggedIn(page))) {
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
  ensureSharedPage,
  getSessionPage: () => (sharedPage && !sharedPage.isClosed() ? sharedPage : null),
  saveSession,
  loadSession,
  resetBrowser, // 🔥 DODANE
};
