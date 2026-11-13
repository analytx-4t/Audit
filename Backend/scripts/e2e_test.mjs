// End-to-end test against a RUNNING server (same HTTP flow as the frontend).
// Usage (from Backend/, with the server running on BASE):
//   node scripts/e2e_test.mjs
// Uploads each folder with its vehicle type, follows the SSE progress stream,
// downloads the result ZIP, and checks: every image has exactly one result,
// results are in upload order (no mix-ups), progress reached the total, the ZIP
// holds vehicles.xlsx (one row per image) + the PDF + failed/ and needs_review/
// copies, and VINs match scripts/ground_truth.json where a label exists.
// E2E_ONLY="dir=type;dir=type" runs only those suites.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import ExcelJS from "exceljs";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE || "http://localhost:5000";
const groundTruth = JSON.parse(fs.readFileSync(path.join(here, "ground_truth.json"), "utf8"));
const SUITES = process.env.E2E_ONLY ? process.env.E2E_ONLY.split(";").map((s) => s.split("=")) : [
  ...(process.env.E2E_EXTRA ? [process.env.E2E_EXTRA.split("=")] : []),
  ["../Two Wheelers", "two_wheeler"],
  ["../Four Wheelers", "four_wheeler"],
  ["../commercial Vehicles", "commercial_vehicle"],
  ["../IMAGE NOT READ BY PORTAL", "four_wheeler"],
];

async function followProgress(jobId) {
  const res = await fetch(`${BASE}/api/progress/${jobId}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let maxProcessed = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error("progress stream closed before done");
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const event = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      if (!event.startsWith("data: ")) continue; // heartbeat comment
      const data = JSON.parse(event.replace(/^data: /, ""));
      maxProcessed = Math.max(maxProcessed, data.processed || 0);
      if (data.status === "error") throw new Error(`job error: ${data.error}`);
      if (data.status === "done") { reader.cancel(); return { ...data, maxProcessed }; }
    }
  }
}

let totalImages = 0, totalResults = 0, correct = 0, wrong = 0, missed = 0, unlabelled = 0;
const problems = [];

for (const [dir, vehicleType] of SUITES) {
  const names = fs.readdirSync(dir).filter((f) => /\.(jpe?g|png|webp|heic)$/i.test(f));
  const form = new FormData();
  for (const name of names) form.append("files", new Blob([fs.readFileSync(path.join(dir, name))], { type: "image/jpeg" }), name);
  form.append("vehicle_type", vehicleType);
  const started = Date.now();
  const upload = await fetch(`${BASE}/api/extract`, { method: "POST", body: form });
  if (!upload.ok) throw new Error(`upload failed ${upload.status}: ${await upload.text()}`);
  const { jobId, total } = await upload.json();
  const done = await followProgress(jobId);
  const details = await (await fetch(`${BASE}/api/result/${jobId}/details`)).json();
  const zipBuf = Buffer.from(await (await fetch(`${BASE}/api/result/${jobId}`)).arrayBuffer());
  const pdf = Buffer.from(await (await fetch(`${BASE}/api/result/${jobId}/pdf`)).arrayBuffer());
  let zipInfo = "not a zip";
  if (zipBuf.subarray(0, 2).toString() !== "PK") {
    problems.push(`${dir}: result is not a ZIP`);
  } else {
    const zip = await JSZip.loadAsync(zipBuf);
    const entries = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
    const failedEntries = entries.filter((n) => n.startsWith("failed/"));
    const reviewEntries = entries.filter((n) => n.startsWith("needs_review/"));
    const expectFailed = details.results.filter((r) => !r.vin).length;
    const expectReview = details.results.filter((r) => r.vin && r.confidence === "low").length;
    if (!entries.includes("vehicles.xlsx")) problems.push(`${dir}: ZIP has no vehicles.xlsx`);
    if (!entries.includes("Stockyard_Audit_Management_Report.pdf")) problems.push(`${dir}: ZIP has no PDF report`);
    if (failedEntries.length !== expectFailed) problems.push(`${dir}: failed/ has ${failedEntries.length}, expected ${expectFailed}`);
    if (reviewEntries.length !== expectReview) problems.push(`${dir}: needs_review/ has ${reviewEntries.length}, expected ${expectReview}`);
    let rows = 0;
    if (entries.includes("vehicles.xlsx")) {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(await zip.file("vehicles.xlsx").async("nodebuffer"));
      const ws = wb.worksheets[0];
      rows = ws.rowCount - 1;
      if (rows !== names.length) problems.push(`${dir}: vehicles.xlsx has ${rows} rows for ${names.length} images`);
      for (let i = 0; i < names.length; i++) {
        const cellName = String(ws.getRow(i + 2).getCell(1).value || "");
        const cellVin = String(ws.getRow(i + 2).getCell(2).value || "");
        if (cellName !== names[i]) problems.push(`${dir}: xlsx row ${i + 2} is "${cellName}", expected "${names[i]}"`);
        if (cellVin !== (details.results[i]?.vin || "")) problems.push(`${dir}: xlsx VIN for ${names[i]} differs from details`);
      }
    }
    zipInfo = `ZIP ${entries.length} entries (xlsx rows ${rows}, failed/ ${failedEntries.length}, needs_review/ ${reviewEntries.length})`;
  }
  const seconds = Math.round((Date.now() - started) / 1000);

  console.log(`\n=== ${path.basename(dir)} (${vehicleType}) — uploaded ${names.length}, server total ${total}, progress ${done.maxProcessed}/${done.total}, results ${details.results.length}, ${zipInfo}, PDF ${pdf.subarray(0, 4).toString()} ${pdf.length}B, email ${done.emailStatus}, ${seconds}s`);
  if (total !== names.length) problems.push(`${dir}: server saw ${total} of ${names.length} uploads`);
  if (details.results.length !== names.length) problems.push(`${dir}: ${details.results.length} results for ${names.length} images`);
  if (done.maxProcessed !== names.length) problems.push(`${dir}: progress ended at ${done.maxProcessed}`);
  if (pdf.subarray(0, 4).toString() !== "%PDF") problems.push(`${dir}: report is not a PDF`);

  totalImages += names.length;
  totalResults += details.results.length;
  details.results.forEach((r, i) => {
    if (r.file !== names[i]) problems.push(`${dir}: result ${i} is for "${r.file}" but upload ${i} was "${names[i]}"`);
    const expected = groundTruth[r.file];
    let verdict = "unlabelled";
    if (expected) verdict = r.vin === expected ? "correct" : r.vin ? "WRONG" : "MISSED";
    if (verdict === "correct") correct++; else if (verdict === "WRONG") wrong++; else if (verdict === "MISSED") missed++; else unlabelled++;
    console.log(`${verdict.padEnd(10)} ${r.file} | ${r.vin || "-"} | ${r.confidence || r.source}${expected && verdict !== "correct" ? ` | expected ${expected}` : ""}${r.error ? ` | ${r.error.slice(0, 120)}` : ""}`);
  });
}

console.log(`\nImages uploaded: ${totalImages}, results returned: ${totalResults}`);
console.log(`Ground truth: ${correct} correct, ${wrong} wrong, ${missed} missed (${unlabelled} unlabelled)`);
console.log(problems.length ? `PROBLEMS:\n- ${problems.join("\n- ")}` : "No dropped, duplicated or mixed-up images.");
process.exit(problems.length || wrong || missed ? 1 : 0);
