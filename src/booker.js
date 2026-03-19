

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
    }),
  });
}

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

async function clickNext(page) {
  for (let i = 0; i < 5; i++) {
    const next = page.getByRole("button", { name: /dalej/i });

    if (await next.count()) {
      await next.first().click();
      await page.waitForTimeout(300); // mały delay zamiast networkidle
    } else {
      break;
    }
  }
}

async function safeClick(locator) {
  await locator.waitFor({ state: "visible", timeout: 5000 });
  await locator.click();
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

  const allOptions = await page.locator("text=Egzamin").allTextContents();
  console.log("DEBUG OPTIONS:", allOptions);
  throw new Error(`Nie znaleziono opcji: ${text}`);
}

async function waitForTerms(page, timeout = 30000) {
  const chooseButton = page.getByRole("button", { name: /wybierz/i }).first();
  await chooseButton.waitFor({ state: "visible", timeout });
  return chooseButton;
}

function normalizeSlotText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function normalizeDate(text) {
  const match = normalizeSlotText(text).match(/\d{2}\.\d{2}/);
  return match ? match[0] : "UNKNOWN_DATE";
}

function formatSlotText(rawText, date = "UNKNOWN_DATE") {
  let text = normalizeSlotText(rawText)
    .replace(/Informacje dodatkowe/gi, "")
    .replace(/Dodatkowe informacje/gi, "")
    .trim();

  text = text.replace(/(Praktyka|Teoria)(\d{1,2}:\d{2})/i, "$1 $2");
  text = text.replace(/(\d{2}:\d{2})\d+/g, "$1");

  const timeMatch = text.match(/\b([01]?\d|2[0-3]):[0-5]\d\b/);

  let type = "";
  if (/Praktyka/i.test(text)) {
    type = "Praktyka";
  } else if (/Teoria/i.test(text)) {
    type = "Teoria";
  }

  console.log("FOUND DATE:", date);

  if (type && timeMatch) {
    return `${date} | ${type} | ${timeMatch[0]}`;
  }

  return text || rawText || "UNKNOWN SLOT";
}

async function readSlotDate(slotButton) {
  const datePattern =
    /(pon|wt|śr|czw|pt|sob|nd|poniedziałek|wtorek|środa|czwartek|piątek|sobota|niedziela).*?\d{2}\.\d{2}/i;

  try {
    const dateText = await slotButton.evaluate((button, patternSource) => {
      const pattern = new RegExp(patternSource, "i");
      let current = button.parentElement;

      while (current) {
        const headerCandidates = [
          ...current.querySelectorAll("h5"),
          ...current.querySelectorAll("h4"),
          ...current.querySelectorAll("h3"),
          ...current.querySelectorAll("[role='heading']"),
        ];

        for (const header of headerCandidates) {
          const text = (header.innerText || header.textContent || "").replace(/\s+/g, " ").trim();
          if (pattern.test(text)) {
            return text;
          }
        }

        const currentText = (current.innerText || current.textContent || "")
          .replace(/\s+/g, " ")
          .trim();
        const match = currentText.match(pattern);
        if (match) {
          return match[0];
        }

        current = current.parentElement;
      }

      return "";
    }, datePattern.source);

    if (dateText) {
      return normalizeDate(dateText);
    }
  } catch (error) {
    // Try fallback strategies below.
  }

  const fallbacks = [
    slotButton.locator("xpath=ancestor::*[.//h5][1]//h5").first(),
    slotButton.locator("xpath=ancestor::*[.//h4][1]//h4").first(),
    slotButton.locator("xpath=ancestor::*[.//h3][1]//h3").first(),
    slotButton.locator("xpath=ancestor::*[1]").first(),
    slotButton.locator("xpath=ancestor::*[2]").first(),
    slotButton.locator("xpath=ancestor::*[3]").first(),
  ];

  for (const locator of fallbacks) {
    try {
      if ((await locator.count()) === 0) {
        continue;
      }

      const text = normalizeSlotText(await locator.innerText());
      if (datePattern.test(text)) {
        return normalizeDate(text);
      }
    } catch (error) {
      // Try the next date strategy.
    }
  }

  console.log("DATE EXTRACTION ERROR");
  return "UNKNOWN_DATE";
}

async function readSlotText(slotButton) {
  const strategies = [
    async () =>
      slotButton.evaluate((button) => {
        const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();

        const getContainerText = (node) => {
          if (!node) {
            return "";
          }

          const clone = node.cloneNode(true);
          clone.querySelectorAll("button").forEach((element) => element.remove());
          return normalize(clone.textContent || "");
        };

        const candidates = [];

        if (button.parentElement) {
          candidates.push(getContainerText(button.parentElement));
        }

        const closestDiv = button.closest("div");
        if (closestDiv) {
          candidates.push(getContainerText(closestDiv));
        }

        let current = button.parentElement;
        let depth = 0;
        while (current && depth < 4) {
          candidates.push(getContainerText(current));
          current = current.parentElement;
          depth += 1;
        }

        if (button.parentElement && button.parentElement.parentElement) {
          const siblingText = Array.from(button.parentElement.parentElement.children)
            .map((child) => getContainerText(child))
            .join(" ");
          candidates.push(normalize(siblingText));
        }

        const bestCandidate = candidates
          .map(normalize)
          .filter((text) => text && !/^wybierz$/i.test(text))
          .sort((first, second) => second.length - first.length)[0];

        return bestCandidate || "";
      }),
    async () => normalizeSlotText(await slotButton.locator("xpath=..").innerText()),
    async () => normalizeSlotText(await slotButton.locator("xpath=ancestor::div[1]").innerText()),
    async () => normalizeSlotText(await slotButton.locator("xpath=ancestor::div[2]").innerText()),
    async () =>
      slotButton.evaluate((button) => {
        const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const parent = button.parentElement;

        if (!parent) {
          return "";
        }

        const siblingText = Array.from(parent.children)
          .filter((child) => child !== button)
          .map((child) => normalize(child.textContent || ""))
          .join(" ");

        return normalize(siblingText);
      }),
  ];

  for (const strategy of strategies) {
    try {
      const text = normalizeSlotText(await strategy());
      if (text && !/^wybierz$/i.test(text)) {
        return text;
      }
    } catch (error) {
      // Try the next slot text strategy.
    }
  }

  return "UNKNOWN SLOT";
}

async function ensureAppPage(page) {
  const url = page.url();

  if (url !== "about:blank" && url.includes("info-car.pl")) {
    return;
  }

  console.log("BOOKER INIT APP PAGE");
  await page.goto("https://info-car.pl/new/prawo-jazdy", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForLoadState("domcontentloaded").catch(() => { });
  await page.waitForTimeout(1000);
}

async function runBooker(page) {
  if (!page || page.isClosed()) {
    throw new Error("PAGE_NOT_AVAILABLE");
  }

  await ensureAppPage(page);

  let url = page.url();
  console.log("BOOKER URL:", url);

  if (url.includes("/prawo-jazdy") && !url.includes("sprawdz-wolny-termin")) {
    console.log("STEP 1: go to availability");
    await clickByText(page, "Sprawdź dostępność");
    await page.waitForTimeout(300);
    url = page.url();
  }

  if (url.includes("sprawdz-wolny-termin") && !url.includes("wybor-terminu")) {
    console.log("STEP 2: exam type selection");

    const examOption = page.getByText("Egzamin na prawo jazdy");

    if ((await examOption.count()) > 0) {
      await safeClick(examOption.first());
      await page.waitForTimeout(300);
      url = page.url();
    } else {
      console.log("Exam option already selected or not present");
    }
  }

  if (url.includes("wybor-terminu")) {
    console.log("STEP 3: selecting location and category");

    const regionInput = page.getByPlaceholder("Wybierz województwo");
    if ((await regionInput.count()) > 0) {
      await safeClick(regionInput.first());
    }

    const regionOption = page.getByText("dolnośląskie", { exact: false });
    if ((await regionOption.count()) > 0) {
      await safeClick(regionOption.first());
    }

    const centerInput = page.getByPlaceholder("Wybierz ośrodek egzaminacyjny");
    if ((await centerInput.count()) > 0) {
      await safeClick(centerInput.first());
    }

    const centerOption = page.getByRole("button", { name: "WORD Wrocław" });
    if ((await centerOption.count()) > 0) {
      await safeClick(centerOption.first());
    }

    const categoryInput = page.getByPlaceholder("Wybierz kategorię");
    if ((await categoryInput.count()) > 0) {
      await safeClick(categoryInput.first());
    }

    const categoryOption = page.getByText("B", { exact: true });
    if ((await categoryOption.count()) > 0) {
      await safeClick(categoryOption.first());
    }

    const nextButton = page.getByRole("button", { name: "Dalej" });
    if ((await nextButton.count()) > 0) {
      await safeClick(nextButton.first());
    }
  }

  console.log("ENSURE PRACTICAL MODE");

  const practiceRadio = page.locator('input[type="radio"]').nth(1);

  try {
    await practiceRadio.waitFor({ state: "visible", timeout: 5000 });
    await practiceRadio.check();
    console.log("MODE SET TO PRACTICE");
  } catch (error) {
    console.log("PRACTICE RADIO NOT FOUND");
  }

  await page.waitForSelector("text=Wybierz", { timeout: 120000 });

  const firstSlot = page.getByRole("button", { name: "Wybierz" }).first();
  const rawSlotText = await readSlotText(firstSlot);
  const slotDate = await readSlotDate(firstSlot);
  const slotText = formatSlotText(rawSlotText, slotDate);

  console.log("CLICKING SLOT:", slotText);

  await firstSlot.click();
  const dalej = page.getByRole("button", { name: "Dalej" });

  await dalej.first().waitFor({ state: "visible", timeout: 5000 });
  await dalej.first().click();

  await page.waitForTimeout(300);

  await fillPersonalData(page);

  // klikamy kolejne "Dalej"
  await clickNext(page);

  // TERAZ dopiero podsumowanie
  try {
    const confirm = page.getByRole("button", { name: /potwierdzam/i });

    if (await confirm.count()) {
      await confirm.click();
      console.log("CONFIRMED");
    }
  } catch { }

  console.log("BOOKING ATTEMPTED");

  if (page.url().includes("platnosc") || page.url().includes("payment")) {
    console.log("=== GOT PAYMENT PAGE ===");

    await sendTelegram("🔥 TERMIN ZŁAPANY – WEJDŹ I ZAPŁAĆ!");
  }
}

async function fillPersonalData(page) {
  console.log("STEP: filling personal data");

  const tryFill = async (locator, value) => {
    try {
      await locator.first().waitFor({ state: "visible", timeout: 3000 });
      await locator.first().fill(value);
      return true;
    } catch {
      return false;
    }
  };

  await tryFill(page.getByPlaceholder(/imi/i), process.env.FIRST_NAME);
  await tryFill(page.getByPlaceholder(/nazw/i), process.env.LAST_NAME);
  await tryFill(page.getByPlaceholder(/PESEL/i), process.env.PESEL);
  await tryFill(page.getByPlaceholder(/PKK/i), process.env.PKK);
  // KATEGORIA PRAWA JAZDY
  await page.click('input[placeholder="Wybierz kategorię prawa jazdy"]');

  const optionB = page.locator('text="B"').last();

  await optionB.waitFor({ state: "visible" });
  await optionB.click();

  // KLUCZOWE — czekamy aż dropdown zniknie
  await optionB.waitFor({ state: "hidden", timeout: 5000 });
  await tryFill(page.getByPlaceholder(/mail/i), process.env.EMAIL);
  await tryFill(page.getByPlaceholder(/telefon/i), process.env.PHONE);

  // checkbox (zgoda)
  try {
    const checkbox = page.locator('input[type="checkbox"]').first();
    await checkbox.check();
    console.log("CHECKBOX CHECKED");
  } catch {
    console.log("CHECKBOX NOT FOUND");
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
