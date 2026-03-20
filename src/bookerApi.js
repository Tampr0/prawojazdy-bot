const fetch = require("node-fetch");

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

  console.log("BOOK PAYLOAD:", JSON.stringify(payload, null, 2));
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.bearerToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      Cookie: cookieHeader,
      "User-Agent": session.userAgent || "Mozilla/5.0",
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`BOOKING_API_ERROR: ${response.status} ${text}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

module.exports = {
  bookSlotAPI,
};
