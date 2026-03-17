const path = require("path");
const { chromium } = require("playwright");

const START_URL = "https://info-car.pl";
const USER_DATA_DIR = path.resolve(process.cwd(), "user-data");

async function clickByText(page, text, timeout = 30000) {
  const candidates = [
    page.getByRole("link", { name: new RegExp(text, "i") }).first(),
    page.getByRole("button", { name: new RegExp(text, "i") }).first(),
    page.getByText(new RegExp(text, "i")).first(),
  ];

  for (const locator of candidates) {
    try {
      await locator.waitFor({ state: "visible", timeout });
      await locator.click();
      return;
    } catch (error) {
      // Probe the next locator strategy.
    }
  }

  throw new Error(`Nie znaleziono elementu: ${text}`);
}

async function selectOption(page, text, timeout = 30000) {
  const optionPattern = new RegExp(`^${text}$`, "i");
  const candidates = [
    page.getByRole("option", { name: optionPattern }).first(),
    page.getByRole("radio", { name: optionPattern }).first(),
    page.getByRole("button", { name: optionPattern }).first(),
    page.getByText(optionPattern).first(),
  ];

  for (const locator of candidates) {
    try {
      await locator.waitFor({ state: "visible", timeout });
      await locator.click();
      return;
    } catch (error) {
      // Probe the next locator strategy.
    }
  }

  throw new Error(`Nie znaleziono opcji: ${text}`);
}

async function waitForTerms(page, timeout = 30000) {
  const chooseButton = page.getByRole("button", { name: /wybierz/i }).first();
  await chooseButton.waitFor({ state: "visible", timeout });
  return chooseButton;
}

async function runBooker() {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: "chrome",
    headless: false,
    viewport: null,
    args: ["--start-maximized", "--disable-blink-features=AutomationControlled"],
  });

  const page = context.pages()[0] || (await context.newPage());

  try {
    await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

    await clickByText(page, "Prawo jazdy");
    await clickByText(page, "Sprawdź dostępność");
    await selectOption(page, "PKK");
    await selectOption(page, "dolnośląskie");
    await selectOption(page, "Wrocław");
    await selectOption(page, "kategoria B");
    await selectOption(page, "praktyka");

    const chooseButton = await waitForTerms(page, 60000);
    await chooseButton.click();

    console.log("BOOKING ATTEMPTED");
  } finally {
    await context.close();
  }
}

module.exports = {
  runBooker,
};

if (require.main === module) {
  runBooker().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
