const fs = require("fs");
const path = require("path");

const inputFile = path.join(__dirname, "booking-diagnostic-success.jsonl");
const outputFile = path.join(__dirname, "booking-diagnostic-success.csv");

console.log("INPUT:", inputFile);
console.log("OUTPUT:", outputFile);

if (!fs.existsSync(inputFile)) {
  console.error("ERROR: input file not found:", inputFile);
  process.exit(1);
}

const raw = fs.readFileSync(inputFile, "utf-8");

if (!raw.trim()) {
  console.error("ERROR: input file is empty:", inputFile);
  process.exit(1);
}

const lines = raw
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.length > 0);

console.log("LINES FOUND:", lines.length);

const rows = [];
let skipped = 0;

for (const [index, line] of lines.entries()) {
  try {
    const obj = JSON.parse(line);
    const p = obj.payload || obj;
    const slot = obj.slot || {};
    const pb = obj.parsedBody || {};

    rows.push({
      timestamp: obj.ts || obj.timestamp || "",
      source: obj.source || "",
      kind: obj.kind || "",

      status: obj.status ?? "",
      reservationId: obj.reservationId ?? pb.id ?? "",

      slotId: slot.id ?? "",
      wordId: slot.wordId ?? "",

      date: slot.date ?? "",
      time: slot.time ?? "",

      expireTime: pb.expireTime ?? "",

      attempt: obj.attempt ?? "",
      delayMs: obj.delayMs ?? "",

      errorCode: obj.errorCode ?? "",
      message: obj.note ?? obj.message ?? "",
    });
  } catch (error) {
    skipped += 1;
    console.log(`SKIP line ${index + 1}: invalid JSON`);
  }
}

console.log("ROWS PARSED:", rows.length);
console.log("ROWS SKIPPED:", skipped);

if (rows.length === 0) {
  console.error("ERROR: no valid rows parsed from file");
  process.exit(1);
}

const headers = [
  "timestamp",
  "source",
  "kind",
  "status",
  "reservationId",
  "slotId",
  "wordId",
  "date",
  "time",
  "expireTime",
  "attempt",
  "delayMs",
  "errorCode",
  "message",
];

const escapeCsv = (value) => {
  const str = String(value ?? "");
  return `"${str.replace(/"/g, '""')}"`;
};

const csv = [
  headers.join(","),
  ...rows.map((row) => headers.map((header) => escapeCsv(row[header])).join(",")),
].join("\n");

fs.writeFileSync(outputFile, csv, "utf-8");

console.log("CSV generated:", outputFile);