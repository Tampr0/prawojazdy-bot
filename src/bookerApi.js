const fetch = require("node-fetch");
const {
  writeDiagnosticEvent,
  redactHeaders,
  redactBody,
} = require("./bookingDiagnostics");

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

  try {
    response = await fetch(url, {
      method: "POST",
      headers: requestHeaders,
      body: requestBody,
    });

    status = response.status;
    headers = Object.fromEntries(response.headers.entries());
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

  return parsed;
}

module.exports = {
  bookSlotAPI,
};
