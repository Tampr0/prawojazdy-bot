const fetch = require("node-fetch");
const {
  writeDiagnosticEvent,
  redactHeaders,
  redactBody,
} = require("./bookingDiagnostics");

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

  const requestHeaders = {
    Authorization: `Bearer ${session.bearerToken}`,
    Accept: "application/json",
    Cookie: cookieHeader,
    "User-Agent": session.userAgent || "Mozilla/5.0",
  };

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

  const requestHeaders = {
    Authorization: `Bearer ${session.bearerToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    Cookie: cookieHeader,
    "User-Agent": session.userAgent || "Mozilla/5.0",
  };

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

  if (reservationId) {
    const reservationDetailsUrl = `https://info-car.pl/api/word/reservations/${reservationId}`;
    const expireTimeUrl = `https://info-car.pl/api/word/reservations/${reservationId}/expire/time`;

    await runDiagnosticGet({
      session,
      slot,
      url: reservationDetailsUrl,
      label: "reservation-details",
      cookieHeaderOverride: diagnosticCookieHeader,
    });

    await runDiagnosticGet({
      session,
      slot,
      url: expireTimeUrl,
      label: "reservation-expire-time",
      cookieHeaderOverride: diagnosticCookieHeader,
    });
  } else {
    writeDiagnosticEvent({
      source: "API",
      kind: "post-booking-diagnostics-skipped",
      method: "POST",
      url,
      status,
      slot: {
        id: slot.id,
        date: slot.date,
        time: slot.time,
        wordId: slot.wordId,
        amount: slot.amount ?? null,
        places: slot.places ?? null,
      },
      note: "Skipped diagnostic follow-up requests because reservationId was not available",
    });
  }

  return parsed;
}


module.exports = {
  bookSlotAPI,
};
