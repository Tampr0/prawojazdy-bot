const fs = require("fs");
const { loadConfig } = require("./config");

function getLocalTimestamp() {
  return new Date()
    .toLocaleString("sv-SE", {
      timeZone: "Europe/Warsaw",
      hour12: false,
    })
    .replace(" ", "T");
}

function maskValue(value, visibleStart = 2, visibleEnd = 2) {
  if (typeof value !== "string") {
    return value;
  }

  if (value.length <= visibleStart + visibleEnd) {
    return "***";
  }

  return `${value.slice(0, visibleStart)}***${value.slice(-visibleEnd)}`;
}

function redactHeaders(headers = {}) {
  const redacted = { ...headers };

  for (const key of Object.keys(redacted)) {
    const lowerKey = key.toLowerCase();

    if (lowerKey === "authorization") {
      redacted[key] = "Bearer ***";
    }

    if (lowerKey === "cookie") {
      redacted[key] = "***";
    }

    if (lowerKey === "set-cookie") {
      redacted[key] = "***";
    }
  }

  return redacted;
}

function redactCandidate(candidate = {}) {
  return {
    ...candidate,
    email: candidate.email ? maskValue(candidate.email, 2, 6) : candidate.email,
    firstname: candidate.firstname ? maskValue(candidate.firstname, 1, 1) : candidate.firstname,
    lastname: candidate.lastname ? maskValue(candidate.lastname, 1, 1) : candidate.lastname,
    pesel: candidate.pesel ? "***" : candidate.pesel,
    phoneNumber: candidate.phoneNumber ? "***" : candidate.phoneNumber,
    pkk: candidate.pkk ? "***" : candidate.pkk,
    pkz: candidate.pkz ? "***" : candidate.pkz,
  };
}

function redactBody(body) {
  if (body == null) {
    return body;
  }

  if (typeof body === "string") {
    return body
      .replace(/"pesel"\s*:\s*"[^"]*"/gi, '"pesel":"***"')
      .replace(/"phoneNumber"\s*:\s*"[^"]*"/gi, '"phoneNumber":"***"')
      .replace(/"pkk"\s*:\s*"[^"]*"/gi, '"pkk":"***"')
      .replace(/"pkz"\s*:\s*"[^"]*"/gi, '"pkz":"***"')
      .replace(/"email"\s*:\s*"[^"]*"/gi, '"email":"***"')
      .replace(/"firstname"\s*:\s*"[^"]*"/gi, '"firstname":"***"')
      .replace(/"lastname"\s*:\s*"[^"]*"/gi, '"lastname":"***"');
  }

  if (Array.isArray(body)) {
    return body.map(redactBody);
  }

  if (typeof body === "object") {
    const clone = { ...body };

    if (clone.candidate) {
      clone.candidate = redactCandidate(clone.candidate);
    }

    for (const key of Object.keys(clone)) {
      if (!["candidate"].includes(key)) {
        clone[key] = redactBody(clone[key]);
      }
    }

    return clone;
  }

  return body;
}

function writeDiagnosticEvent(event) {
  const config = loadConfig();

  if (!config.bookingDiagnostics) {
    return;
  }

  const entry = {
    ts: getLocalTimestamp(),
    ...event,
  };

  fs.appendFileSync(
    config.bookingDiagnosticsFilePath,
    JSON.stringify(entry) + "\n"
  );
}

module.exports = {
  writeDiagnosticEvent,
  redactHeaders,
  redactBody,
};