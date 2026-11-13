// OCR pipeline evaluation.
// Runs every test folder through the real processBatches() pipeline and writes
// a CSV with the VIN, how it was obtained, and the failure reason per image.
//
// Usage (from Backend/):
//   node scripts/ocr_eval.mjs                 # all folders, batch mode
//   MISTRAL_OCR_MODE=realtime node scripts/ocr_eval.mjs
//   node scripts/ocr_eval.mjs "../Two Wheelers=two_wheeler"
//
// Optional ground truth: scripts/ground_truth.json  { "<file name>": "<VIN>" }
// When present, each row is scored as correct / wrong / missed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.NO_LISTEN = "1";
const here = path.dirname(fileURLToPath(import.meta.url));
const { processBatches } = await import("../server.js");

const DEFAULT_FOLDERS = [
  "../Two Wheelers=two_wheeler",
  "../Four Wheelers=four_wheeler",
  "../commercial Vehicles=commercial_vehicle",
  "../IMAGE NOT READ BY PORTAL=four_wheeler",
];
const folders = (process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_FOLDERS)
  .map((arg) => arg.split("="));

const gtPath = path.join(here, "ground_truth.json");
const groundTruth = fs.existsSync(gtPath) ? JSON.parse(fs.readFileSync(gtPath, "utf8")) : {};

const rows = [];
for (const [dir, vehicleType] of folders) {
  const names = fs.readdirSync(dir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f));
  const files = names.map((name) => ({
    originalname: name,
    mimetype: name.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg",
    buffer: fs.readFileSync(path.join(dir, name)),
  }));
  console.log(`\n=== ${dir} (${vehicleType}) — ${files.length} image(s)`);
  const results = await processBatches(files, () => { }, vehicleType, {});

  for (const result of results) {
    const name = result.file.originalname;
    const vin = result.success ? result.aiResult.vin : "";
    const expected = (groundTruth[name] || "").toUpperCase();
    const verdict = !expected ? "" : vin === expected ? "correct" : vin ? "wrong" : "missed";
    rows.push({ folder: path.basename(dir), name, vin, source: result.source, verdict, expected, reason: result.error || "", reads: result.aiResult?.vin_reads || "" });
    console.log(`${result.success ? "OK  " : "FAIL"} ${name} | ${vin || "-"} | ${result.source}${verdict ? ` | ${verdict}` : ""}${result.error ? ` | ${result.error}` : ""}${result.aiResult?.vin_reads ? `
       reads: ${result.aiResult.vin_reads}` : ""}`);
  }
}

const ok = rows.filter((r) => r.vin).length;
console.log(`\nVIN read for ${ok}/${rows.length} image(s).`);
const scored = rows.filter((r) => r.verdict);
if (scored.length) {
  const correct = scored.filter((r) => r.verdict === "correct").length;
  console.log(`Ground truth: ${correct}/${scored.length} correct.`);
}

const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
const csv = ["folder,file,vin,source,verdict,expected,reason,reads", ...rows.map((r) =>
  [r.folder, r.name, r.vin, r.source, r.verdict, r.expected, r.reason, r.reads].map(esc).join(","))].join("\n");
const outPath = path.join(here, `ocr_eval_${new Date().toISOString().replace(/[:.]/g, "-")}.csv`);
fs.writeFileSync(outPath, csv);
console.log(`Results written to ${outPath}`);
process.exit(0);
