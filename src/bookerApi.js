const fetch = require("node-fetch");
const {
  writeDiagnosticEvent,
  redactHeaders,
  redactBody,
} = require("./bookingDiagnostics");
const { getSessionPage } = require("./session");

function extractCookiePairsFromSetCookie(setCookieHeaders = []) {
  if (!Array.isArray(setCookieHeaders)) {
    return [];
  }

  return setCookieHeaders
    .map((header) => String(header || "").split(";")[0].trim())
    .filter(Boolean);
}

function mergeCookieHeaders(baseCookieHeader = "", extraCookiePairs = []) {
  const cookieMap = new Map();

  for (const part of String(baseCookieHeader || "").split(";")) {
    const trimmed = part.trim();

    if (!trimmed) continue;

    const eqIndex = trimmed.indexOf("=");

    if (eqIndex === -1) continue;

    const name = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();

    if (!name) continue;

    cookieMap.set(name, value);
  }

  for (const pair of extraCookiePairs) {
    const trimmed = String(pair || "").trim();

    if (!trimmed) continue;

    const eqIndex = trimmed.indexOf("=");

    if (eqIndex === -1) continue;

    const name = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();

    if (!name) continue;

    cookieMap.set(name, value);
  }

  return Array.from(cookieMap.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function getBookingReferer() {
  const page = getSessionPage();

  if (page && !page.isClosed()) {
    const currentUrl = page.url();

    if (currentUrl && currentUrl.startsWith("https://info-car.pl/")) {
      return currentUrl;
    }
  }

  return "https://info-car.pl/new/prawo-jazdy/sprawdz-wolny-termin/wybor-terminu";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RESERVATION_DETAILS_POLL_ATTEMPTS = 4;
const RESERVATION_DETAILS_POLL_INTERVAL_MS = 1000;

function extractExpireTimeValue(parsed) {
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  if (parsed.expireTime == null) {
    return null;
  }

  const numericValue = Number(parsed.expireTime);

  if (Number.isNaN(numericValue)) {
    return null;
  }

  return numericValue;
}

async function pollExpireTimeDiagnostic({
  session,
  slot,
  reservationId,
  cookieHeaderOverride,
}) {
  const expireTimeUrl = `https://info-car.pl/api/word/reservations/${reservationId}/expire/time`;

  const pollDelaysMs = [0, 300, 700, 1500, 2500, 4000];
  const pollResults = [];

  writeDiagnosticEvent({
    source: "API",
    kind: "expire-time-polling-start",
    method: "GET",
    url: expireTimeUrl,
    reservationId,
    pollPlanMs: pollDelaysMs,
    slot: {
      id: slot.id,
      date: slot.date,
      time: slot.time,
      wordId: slot.wordId,
      amount: slot.amount ?? null,
      places: slot.places ?? null,
    },
    note: "Starting expire/time polling diagnostics after successful booking",
  });

  for (let index = 0; index < pollDelaysMs.length; index++) {
    const delayMs = pollDelaysMs[index];

    if (delayMs > 0) {
      await sleep(delayMs);
    }

    const response = await runDiagnosticGet({
      session,
      slot,
      url: expireTimeUrl,
      label: `reservation-expire-time-poll-${index + 1}`,
      cookieHeaderOverride,
    });

    const expireTimeValue = extractExpireTimeValue(response.parsed);

    pollResults.push({
      attempt: index + 1,
      delayMs,
      status: response.status,
      ok: response.ok,
      expireTime: expireTimeValue,
      rawParsed: response.parsed ?? null,
      error: response.error ?? null,
    });

    writeDiagnosticEvent({
      source: "API",
      kind: "expire-time-polling-attempt",
      method: "GET",
      url: expireTimeUrl,
      reservationId,
      attempt: index + 1,
      delayMs,
      status: response.status,
      ok: response.ok,
      expireTime: expireTimeValue,
      parsedBody: redactBody(response.parsed),
      errorMessage: response.error ?? null,
      slot: {
        id: slot.id,
        date: slot.date,
        time: slot.time,
        wordId: slot.wordId,
        amount: slot.amount ?? null,
        places: slot.places ?? null,
      },
      note: "Expire/time polling attempt completed",
    });

    if (expireTimeValue !== null) {
      writeDiagnosticEvent({
        source: "API",
        kind: "expire-time-polling-hit",
        method: "GET",
        url: expireTimeUrl,
        reservationId,
        attempt: index + 1,
        delayMs,
        expireTime: expireTimeValue,
        slot: {
          id: slot.id,
          date: slot.date,
          time: slot.time,
          wordId: slot.wordId,
          amount: slot.amount ?? null,
          places: slot.places ?? null,
        },
        note: "Expire/time returned numeric value during polling",
      });

      break;
    }
  }

  const firstNonNullResult =
    pollResults.find((entry) => entry.expireTime !== null) || null;

  writeDiagnosticEvent({
    source: "API",
    kind: "expire-time-polling-summary",
    method: "GET",
    url: expireTimeUrl,
    reservationId,
    firstNonNullExpireTime:
      firstNonNullResult ? firstNonNullResult.expireTime : null,
    firstNonNullAttempt:
      firstNonNullResult ? firstNonNullResult.attempt : null,
    pollResults,
    slot: {
      id: slot.id,
      date: slot.date,
      time: slot.time,
      wordId: slot.wordId,
      amount: slot.amount ?? null,
      places: slot.places ?? null,
    },
    note: "Expire/time polling diagnostics finished",
  });

  return {
    pollResults,
    firstNonNullExpireTime: firstNonNullResult
      ? firstNonNullResult.expireTime
      : null,
    firstNonNullAttempt: firstNonNullResult
      ? firstNonNullResult.attempt
      : null,
  };
}

async function pollReservationDetailsDiagnostic({
  session,
  slot,
  reservationId,
  cookieHeaderOverride,
}) {
  const reservationDetailsUrl = `https://info-car.pl/api/word/reservations/${reservationId}`;
  const pollResults = [];

  for (
    let attempt = 1;
    attempt <= RESERVATION_DETAILS_POLL_ATTEMPTS;
    attempt += 1
  ) {
    const response = await runDiagnosticGet({
      session,
      slot,
      url: reservationDetailsUrl,
      label: `reservation-details-poll-${attempt}`,
      cookieHeaderOverride,
    });

    pollResults.push({
      attempt,
      status: response.status,
      ok: response.ok,
      parsed: redactBody(response.parsed ?? null),
      error: response.error ?? null,
    });

    writeDiagnosticEvent({
      source: "API",
      kind: "reservation-details-polling-attempt",
      method: "GET",
      url: reservationDetailsUrl,
      reservationId,
      attempt,
      status: response.status,
      ok: response.ok,
      parsedBody: redactBody(response.parsed),
      errorMessage: response.error ?? null,
      slot: {
        id: slot.id,
        date: slot.date,
        time: slot.time,
        wordId: slot.wordId,
        amount: slot.amount ?? null,
        places: slot.places ?? null,
      },
      note: "Reservation details polling attempt completed",
    });

    if (attempt < RESERVATION_DETAILS_POLL_ATTEMPTS) {
      await sleep(RESERVATION_DETAILS_POLL_INTERVAL_MS);
    }
  }

  writeDiagnosticEvent({
    source: "API",
    kind: "reservation-details-polling-summary",
    method: "GET",
    url: reservationDetailsUrl,
    reservationId,
    attempts: RESERVATION_DETAILS_POLL_ATTEMPTS,
    intervalMs: RESERVATION_DETAILS_POLL_INTERVAL_MS,
    pollResults,
    slot: {
      id: slot.id,
      date: slot.date,
      time: slot.time,
      wordId: slot.wordId,
      amount: slot.amount ?? null,
      places: slot.places ?? null,
    },
    note: "Reservation details polling finished",
  });

  return {
    pollResults,
    attempts: RESERVATION_DETAILS_POLL_ATTEMPTS,
    intervalMs: RESERVATION_DETAILS_POLL_INTERVAL_MS,
  };
}

function buildBrowserLikeHeaders(session, cookieHeader, extraHeaders = {}) {
  return {
    Authorization: `Bearer ${session.bearerToken}`,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "pl-PL,pl;q=0.9",
    "Content-Type": "application/json",
    Cookie: cookieHeader,
    Origin: "https://info-car.pl",
    Referer: getBookingReferer(),
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "User-Agent": session.userAgent || "Mozilla/5.0",
    ...extraHeaders,
  };
}

async function runDiagnosticGet({
  session,
  slot,
  url,
  label,
  cookieHeaderOverride = null,
}) {
  const cookieHeader =
    cookieHeaderOverride ||
    (session.cookies || [])
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");

  const requestHeaders = buildBrowserLikeHeaders(session, cookieHeader, {
    "Content-Type": undefined,
  });

  delete requestHeaders["Content-Type"];

  const startedAt = Date.now();

  writeDiagnosticEvent({
    source: "API",
    kind: "follow-up-request",
    method: "GET",
    url,
    requestHeaders: redactHeaders(requestHeaders),
    diagnosticCookieHeader: cookieHeader,
    slot: {
      id: slot.id,
      date: slot.date,
      time: slot.time,
      wordId: slot.wordId,
      amount: slot.amount ?? null,
      places: slot.places ?? null,
    },
    note: `Starting diagnostic follow-up GET: ${label}`,
  });

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: requestHeaders,
    });

    const status = response.status;
    const headers = Object.fromEntries(response.headers.entries());
    const text = await response.text();

    writeDiagnosticEvent({
      source: "API",
      kind: "follow-up-response",
      method: "GET",
      url,
      status,
      ok: response.ok,
      durationMs: Date.now() - startedAt,
      responseHeaders: redactHeaders(headers),
      responseBody: redactBody(text),
      slot: {
        id: slot.id,
        date: slot.date,
        time: slot.time,
        wordId: slot.wordId,
        amount: slot.amount ?? null,
        places: slot.places ?? null,
      },
      note: `Received diagnostic follow-up response: ${label}`,
    });

    let parsed;

    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }

    writeDiagnosticEvent({
      source: "API",
      kind: "follow-up-parsed-response",
      method: "GET",
      url,
      status,
      parsedBody: redactBody(parsed),
      slot: {
        id: slot.id,
        date: slot.date,
        time: slot.time,
        wordId: slot.wordId,
        amount: slot.amount ?? null,
        places: slot.places ?? null,
      },
      note: `Parsed diagnostic follow-up response: ${label}`,
    });

    return {
      status,
      ok: response.ok,
      headers,
      text,
      parsed,
    };
  } catch (error) {
    writeDiagnosticEvent({
      source: "API",
      kind: "follow-up-error",
      method: "GET",
      url,
      durationMs: Date.now() - startedAt,
      errorMessage: error.message,
      slot: {
        id: slot.id,
        date: slot.date,
        time: slot.time,
        wordId: slot.wordId,
      },
      note: `Diagnostic follow-up GET failed: ${label}`,
    });

    return {
      status: null,
      ok: false,
      headers: {},
      text: null,
      parsed: null,
      error: error.message,
    };
  }
}

async function bookSlotAPI(session, slot) {
  const url = "https://info-car.pl/api/word/reservations";

  const cookieHeader = (session.cookies || [])
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");

  const payload = {
    candidate: {
      category: "B",
      email: process.env.EMAIL,
      firstname: process.env.FIRST_NAME,
      lastname: process.env.LAST_NAME,
      pesel: process.env.PESEL,
      phoneNumber: process.env.PHONE,
      pkk: process.env.PKK,
      pkz: null,
    },
    exam: {
      organizationUnitId: slot.wordId,
      practiceId: slot.id,
      theoryId: null,
    },
    languageAndOsk: {
      language: "POLISH",
      signLanguage: "NONE",
      oskVehicleReservation: null,
    },
  };

  const requestHeaders = buildBrowserLikeHeaders(session, cookieHeader);

  const requestBody = JSON.stringify(payload);
  const startedAt = Date.now();

  writeDiagnosticEvent({
    source: "API",
    kind: "request",
    method: "POST",
    url,
    requestHeaders: redactHeaders(requestHeaders),
    requestBody: redactBody(payload),
    slot: {
      id: slot.id,
      date: slot.date,
      time: slot.time,
      wordId: slot.wordId,
      amount: slot.amount ?? null,
      places: slot.places ?? null,
    },
    note: "Sending booking request to reservations endpoint",
  });

  let response;
  let status;
  let headers;
  let text;
  let setCookieHeaders = [];

  try {
    response = await fetch(url, {
      method: "POST",
      headers: requestHeaders,
      body: requestBody,
    });

    status = response.status;
    headers = Object.fromEntries(response.headers.entries());
    const rawHeaders = response.headers.raw();
    setCookieHeaders = rawHeaders["set-cookie"] || [];
    text = await response.text();

  } catch (error) {
    writeDiagnosticEvent({
      source: "API",
      kind: "request-error",
      method: "POST",
      url,
      durationMs: Date.now() - startedAt,
      errorMessage: error.message,
      slot: {
        id: slot.id,
        date: slot.date,
        time: slot.time,
        wordId: slot.wordId,
      },
      note: "Booking request failed before response was received",
    });

    throw error;
  }

  console.log("BOOK STATUS:", status);
  console.log("BOOK BODY:", text);

  writeDiagnosticEvent({
    source: "API",
    kind: "response",
    method: "POST",
    url,
    status,
    ok: response.ok,
    durationMs: Date.now() - startedAt,
    responseHeaders: redactHeaders(headers),
    rawSetCookieHeaders: setCookieHeaders,
    responseBody: redactBody(text),
    slot: {
      id: slot.id,
      date: slot.date,
      time: slot.time,
      wordId: slot.wordId,
      amount: slot.amount ?? null,
      places: slot.places ?? null,
    },
    note: "Received booking response from reservations endpoint",
  });

  if (!response.ok) {
    throw new Error(`BOOKING_API_ERROR: ${status} ${text}`);
  }

  let parsed;

  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }

  writeDiagnosticEvent({
    source: "API",
    kind: "parsed-response",
    method: "POST",
    url,
    status,
    parsedBody: redactBody(parsed),
    slot: {
      id: slot.id,
      date: slot.date,
      time: slot.time,
      wordId: slot.wordId,
      amount: slot.amount ?? null,
      places: slot.places ?? null,
    },
    note: "Parsed booking response body",
  });

  const locationHeader =
    headers.location ||
    headers.Location ||
    null;

  const reservationId =
    parsed?.id ||
    (locationHeader ? locationHeader.split("/").pop() : null);

  const setCookiePairs = extractCookiePairsFromSetCookie(setCookieHeaders);
  const originalCookieHeader = (session.cookies || [])
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  const diagnosticCookieHeader = mergeCookieHeaders(
    originalCookieHeader,
    setCookiePairs
  );

  writeDiagnosticEvent({
    source: "API",
    kind: "post-booking-diagnostics-start",
    method: "POST",
    url,
    status,
    reservationId,
    locationHeader,
    setCookiePairs,
    diagnosticCookieHeader,
    slot: {
      id: slot.id,
      date: slot.date,
      time: slot.time,
      wordId: slot.wordId,
      amount: slot.amount ?? null,
      places: slot.places ?? null,
    },
    note: "Starting diagnostic follow-up requests after successful booking",
  });

  return {
    ...parsed,
    __diagnostics: {
      reservationId,
      diagnosticCookieHeader,
      setCookiePairs,
      locationHeader,
    },
  };
}


module.exports = {
  bookSlotAPI,
  pollExpireTimeDiagnostic,
  pollReservationDetailsDiagnostic,
};
