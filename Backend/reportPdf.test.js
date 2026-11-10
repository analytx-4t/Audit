import test from "node:test";
import assert from "node:assert/strict";
import { buildAuditReportPdf, calculateAuditMetrics } from "./reportPdf.js";

const results = [
  { success: true, aiResult: { vin: "1HGCM82633A004352", city: "Bengaluru" } },
  { success: true, aiResult: { vin: "1HGCM82633A004352", city: "Bengaluru" } },
  { success: true, aiResult: { vin: "123456789012345", city: "Bengaluru" } },
  { success: false, error: "Request failed with status code 402" },
];

test("calculates scan metrics without inventing inventory coverage", () => {
  const metrics = calculateAuditMetrics({
    results,
    totalImages: 4,
    vehicleType: "four_wheeler",
    location: "Bengaluru",
  });

  assert.equal(metrics.submitted, 4);
  assert.equal(metrics.read, 3);
  assert.equal(metrics.valid, 2);
  assert.equal(metrics.invalid, 1);
  assert.equal(metrics.failed, 1);
  assert.equal(metrics.uniqueVehicles, 2);
  assert.equal(metrics.duplicatePhotos, 1);
  assert.equal(metrics.processingFailures, 1);
  assert.equal(metrics.processingStatus, "402");
  assert.equal(metrics.readAccuracy, 2 / 3);
  assert.equal(metrics.locations[0].submitted, 4);
});

test("generates a PDF report for the scan results", async () => {
  const pdf = await buildAuditReportPdf({
    results,
    totalImages: 4,
    vehicleType: "four_wheeler",
    location: "Bengaluru",
    generatedAt: new Date("2026-11-09T00:00:00Z"),
  });

  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.ok(pdf.length > 1000);
});
