import PDFDocument from "pdfkit";

const COLORS = {
  navy: "#14233F",
  teal: "#1AA08E",
  tealLight: "#E8F5F2",
  red: "#D84A5B",
  redLight: "#FCEBED",
  orange: "#F2A23A",
  ink: "#1F2D45",
  muted: "#77849A",
  line: "#D7DEE8",
  pale: "#F0F3F7",
  white: "#FFFFFF",
};

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 40;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

function isValidVin(vin, vehicleType) {
  const length = vin.length;
  const isCommercial = vehicleType === "commercial_equipment" || vehicleType === "commercial_vehicle";
  return isCommercial ? length >= 10 && length <= 17 : length === 17;
}

function getLocation(fallback) {
  return String(fallback || "Location not supplied").trim();
}

export function calculateAuditMetrics({ results = [], totalImages = results.length, vehicleType = "", location = "" }) {
  const submitted = totalImages;
  const readResults = results.filter((result) => {
    return result?.success && result.aiResult && String(result.aiResult.vin || "").trim();
  });
  const readableVins = readResults.map((result) => String(result.aiResult.vin).trim().toUpperCase());
  const validCount = readableVins.filter((vin) => isValidVin(vin, vehicleType)).length;
  const invalidCount = readableVins.length - validCount;
  const uniqueVins = new Set(readableVins);
  const duplicatePhotos = readableVins.length - uniqueVins.size;
  const failedImages = Math.max(0, submitted - readResults.length);
  const processingFailures = results.filter((result) => result && !result.success).length
    + Math.max(0, submitted - results.length);
  const noVinAfterScan = results.filter((result) => result?.success && !String(result.aiResult?.vin || "").trim()).length;
  const processingStatus = results
    .map((result) => String(result?.error || "").match(/(?:status code|HTTP)\s*[:=]?\s*(\d{3})/i)?.[1])
    .find(Boolean) || "";
  const locations = new Map();

  for (const result of results) {
    const name = getLocation(location);
    if (!locations.has(name)) {
      locations.set(name, { name, submitted: 0, read: 0, valid: 0, failed: 0 });
    }
    const group = locations.get(name);
    group.submitted++;
    const vin = result?.success ? String(result.aiResult?.vin || "").trim().toUpperCase() : "";
    if (!vin) {
      group.failed++;
    } else {
      group.read++;
      if (isValidVin(vin, vehicleType)) group.valid++;
    }
  }

  if (results.length < submitted) {
    const name = String(location || "Location not supplied").trim();
    if (!locations.has(name)) {
      locations.set(name, { name, submitted: 0, read: 0, valid: 0, failed: 0 });
    }
    locations.get(name).submitted += submitted - results.length;
    locations.get(name).failed += submitted - results.length;
  }

  return {
    submitted,
    read: readResults.length,
    valid: validCount,
    invalid: invalidCount,
    failed: failedImages,
    processingFailures,
    noVinAfterScan,
    processingStatus,
    uniqueVehicles: uniqueVins.size,
    duplicatePhotos,
    readAccuracy: readResults.length ? validCount / readResults.length : 0,
    endToEndAccuracy: submitted ? validCount / submitted : 0,
    locations: [...locations.values()],
  };
}

function drawHeader(doc, pageNumber, date, location) {
  const headerHeight = pageNumber === 1 ? 76 : 58;
  doc.rect(0, 0, PAGE_WIDTH, headerHeight).fill(COLORS.navy);
  doc.rect(0, headerHeight - 3, PAGE_WIDTH, 3).fill(COLORS.teal);
  doc.fillColor(COLORS.white).font("Helvetica-Bold");

  if (pageNumber === 1) {
    doc.fontSize(16).text("Stockyard Audit · AI Management Report", MARGIN, 17, { width: CONTENT_WIDTH });
    doc.font("Helvetica").fontSize(7.5).fillColor("#D7E0EE")
      .text(`Vehicle audit · ${date} · ${location}`, MARGIN, 42, { width: CONTENT_WIDTH });
    doc.text("Prepared from uploaded scan results · Scope: image scan only · No stock register provided", MARGIN, 55, { width: CONTENT_WIDTH });
  } else {
    doc.fontSize(12).text("Stockyard Audit · AI Management Report", MARGIN, 13, { width: CONTENT_WIDTH });
    doc.font("Helvetica").fontSize(8).fillColor("#D7E0EE")
      .text("Analysis & recommendations", MARGIN, 34, { width: CONTENT_WIDTH });
  }
  doc.font("Helvetica").fontSize(7).fillColor(COLORS.muted)
    .text("Confidential · for management use", MARGIN, PAGE_HEIGHT - 25);
  doc.text(`Page ${pageNumber} of 2`, PAGE_WIDTH - MARGIN - 65, PAGE_HEIGHT - 25, { width: 65, align: "right" });
}

function sectionTitle(doc, text, y) {
  doc.font("Helvetica-Bold").fontSize(10).fillColor(COLORS.ink).text(text, MARGIN, y);
}

function truncateToWidth(doc, text, width) {
  let value = String(text ?? "");
  if (doc.widthOfString(value) <= width) return value;
  while (value.length > 1 && doc.widthOfString(`${value}…`) > width) {
    value = value.slice(0, -1);
  }
  return `${value}…`;
}

function drawTable(doc, { x, y, widths, headers, rows, rowHeight = 19 }) {
  const totalWidth = widths.reduce((sum, width) => sum + width, 0);
  doc.rect(x, y, totalWidth, 19).fill(COLORS.navy);
  let cursorX = x;
  headers.forEach((header, index) => {
    doc.font("Helvetica-Bold").fontSize(7).fillColor(COLORS.white)
      .text(header, cursorX + 5, y + 6, { width: widths[index] - 10, lineBreak: false });
    cursorX += widths[index];
  });

  rows.forEach((row, rowIndex) => {
    const rowY = y + 19 + rowIndex * rowHeight;
    doc.rect(x, rowY, totalWidth, rowHeight)
      .fill(rowIndex % 2 === 0 ? COLORS.pale : COLORS.white);
    cursorX = x;
    row.forEach((value, colIndex) => {
      doc.font(colIndex === 1 && headers[0] === "Metric" ? "Helvetica-Bold" : "Helvetica")
        .fontSize(7).fillColor(COLORS.ink);
      const text = truncateToWidth(doc, value, widths[colIndex] - 10);
      doc.text(text, cursorX + 5, rowY + 6, { width: widths[colIndex] - 10, lineBreak: false });
      cursorX += widths[colIndex];
    });
  });
}

function drawKpis(doc, metrics) {
  const values = [
    { value: String(metrics.submitted), label: "Images submitted", note: "photos in this scan", color: COLORS.navy },
    { value: String(metrics.read), label: "VINs read", note: `${metrics.submitted ? ((metrics.read / metrics.submitted) * 100).toFixed(1) : "0.0"}% of photos`, color: COLORS.teal },
    { value: String(metrics.valid), label: "Format valid", note: `${(metrics.readAccuracy * 100).toFixed(1)}% of VINs read`, color: COLORS.teal },
    { value: String(metrics.invalid), label: "Format review", note: "VINs needing review", color: COLORS.orange },
    { value: String(metrics.failed), label: "No VIN / result", note: "includes processing errors", color: COLORS.red },
    { value: String(metrics.uniqueVehicles), label: "Unique VINs", note: `${metrics.duplicatePhotos} repeat photo(s)`, color: COLORS.navy },
  ];
  const gap = 5;
  const cardWidth = (CONTENT_WIDTH - gap * (values.length - 1)) / values.length;
  const y = 88;
  values.forEach((item, index) => {
    const x = MARGIN + index * (cardWidth + gap);
    doc.rect(x, y, cardWidth, 48).fill("#F0F3F7");
    doc.rect(x, y, 3, 48).fill(item.color);
    doc.font("Helvetica-Bold").fontSize(13).fillColor(item.color).text(item.value, x + 8, y + 6, { width: cardWidth - 11 });
    doc.font("Helvetica-Bold").fontSize(6.6).fillColor(COLORS.ink).text(item.label, x + 8, y + 24, { width: cardWidth - 11 });
    doc.font("Helvetica").fontSize(5.8).fillColor(COLORS.muted).text(item.note, x + 8, y + 35, { width: cardWidth - 11 });
  });
}

function drawSummary(doc, metrics, y) {
  sectionTitle(doc, "Executive summary", y);
  const processingNote = metrics.processingFailures
    ? ` The scan service failed before returning OCR for ${metrics.processingFailures} image(s)${metrics.processingStatus ? ` (HTTP ${metrics.processingStatus})` : ""}.`
    : "";
  const noVinNote = metrics.noVinAfterScan
    ? ` ${metrics.noVinAfterScan} processed image(s) returned no VIN.`
    : "";
  const summary = `The scan received ${metrics.submitted} uploaded photo(s). A VIN was read from ${metrics.read} (${metrics.submitted ? ((metrics.read / metrics.submitted) * 100).toFixed(1) : "0.0"}%); ${metrics.valid} read VIN(s) (${(metrics.readAccuracy * 100).toFixed(1)}%) passed the selected vehicle-type format check. ${metrics.invalid} VIN(s) need format review and ${metrics.failed} photo(s) have no VIN result.${processingNote}${noVinNote} The scan found ${metrics.uniqueVehicles} unique VIN(s) and ${metrics.duplicatePhotos} repeat photo(s). Stock-list coverage, stock age, yard reconciliation, and model breakdown cannot be calculated without a stock register.`;
  const boxY = y + 17;
  const textOptions = { width: CONTENT_WIDTH - 18, lineGap: 1.5 };
  const textHeight = doc.font("Helvetica").fontSize(8).heightOfString(summary, textOptions);
  doc.rect(MARGIN, boxY, CONTENT_WIDTH, textHeight + 14).fill(COLORS.tealLight);
  doc.rect(MARGIN, boxY, 3, textHeight + 14).fill(COLORS.teal);
  doc.fillColor(COLORS.ink).text(summary, MARGIN + 10, boxY + 7, textOptions);
  return boxY + textHeight + 22;
}

function drawPageOne(doc, metrics, { date, location }) {
  drawHeader(doc, 1, date, location);
  drawKpis(doc, metrics);
  let y = drawSummary(doc, metrics, 148);
  sectionTitle(doc, "Scan summary by provided location", y);
  doc.font("Helvetica").fontSize(7).fillColor(COLORS.muted)
    .text("These are scan counts, not stock-list verification or audit coverage.", MARGIN, y + 13);

  const locationRows = metrics.locations.map((group) => [
    group.name,
    String(group.submitted),
    String(group.read),
    String(group.valid),
    String(group.failed),
    `${group.submitted ? ((group.read / group.submitted) * 100).toFixed(1) : "0.0"}%`,
  ]);
  drawTable(doc, {
    x: MARGIN,
    y: y + 28,
    widths: [177, 63, 63, 63, 63, 46],
    headers: ["Provided location", "Photos", "VIN read", "Valid", "No VIN", "Read %"],
    rows: locationRows.length ? locationRows : [["Location not supplied", "0", "0", "0", "0", "0.0%"]],
  });

  const tableY = y + 58 + Math.max(1, locationRows.length) * 19;
  sectionTitle(doc, "Tool performance", tableY);
  const performanceRows = [
    ["Images submitted", String(metrics.submitted), "Uploaded photos included in this report"],
    ["VIN read", `${metrics.read} · ${metrics.submitted ? ((metrics.read / metrics.submitted) * 100).toFixed(1) : "0.0"}%`, "A non-empty VIN was returned"],
    ["No VIN result", `${metrics.failed} · ${metrics.submitted ? ((metrics.failed / metrics.submitted) * 100).toFixed(1) : "0.0"}%`, "Includes scan-service errors"],
    ["Scan-service failures", String(metrics.processingFailures), metrics.processingStatus ? `Service returned HTTP ${metrics.processingStatus}` : "Failed before a VIN result"],
    ["Format-valid VINs", `${metrics.valid} / ${metrics.read} · ${(metrics.readAccuracy * 100).toFixed(1)}%`, "Checked against selected vehicle type"],
    ["End-to-end valid", `${metrics.valid} / ${metrics.submitted} · ${(metrics.endToEndAccuracy * 100).toFixed(1)}%`, "Format-valid VINs / all photos"],
    ["Repeat photos", `${metrics.duplicatePhotos} · ${metrics.read ? ((metrics.duplicatePhotos / metrics.read) * 100).toFixed(1) : "0.0"}%`, `${metrics.uniqueVehicles} unique VIN(s) read`],
    ["Stock-list match", "Not available", "No stock-register file was provided"],
  ];
  drawTable(doc, {
    x: MARGIN,
    y: tableY + 16,
    widths: [130, 120, CONTENT_WIDTH - 250],
    headers: ["Metric", "Result", "Note"],
    rows: performanceRows,
    rowHeight: 18,
  });

  doc.font("Helvetica").fontSize(6).fillColor(COLORS.muted)
    .text("Format validity is a length check only, not a manual confirmation of the VIN or a match against inventory.", MARGIN, 790, { width: CONTENT_WIDTH });
}

function drawOutcomePanel(doc, metrics, x, y, width, title) {
  doc.font("Helvetica-Bold").fontSize(9).fillColor(COLORS.ink).text(title, x, y, { width, align: "center" });
  const barY = y + 28;
  const barWidth = width - 18;
  const segments = [
    { value: metrics.valid, color: COLORS.teal, label: "Valid" },
    { value: metrics.invalid, color: COLORS.orange, label: "Review" },
    { value: metrics.failed, color: COLORS.red, label: "No result" },
  ];
  doc.rect(x + 9, barY, barWidth, 16).fill(COLORS.pale);
  let offset = 0;
  for (const segment of segments) {
    const segmentWidth = metrics.submitted ? barWidth * (segment.value / metrics.submitted) : 0;
    if (segmentWidth > 0) {
      doc.rect(x + 9 + offset, barY, segmentWidth, 16).fill(segment.color);
      offset += segmentWidth;
    }
  }
  const labelY = barY + 29;
  segments.forEach((segment, index) => {
    const columnX = x + 7 + index * ((width - 14) / 3);
    doc.circle(columnX + 3, labelY + 4, 3).fill(segment.color);
    doc.font("Helvetica-Bold").fontSize(7).fillColor(COLORS.ink)
      .text(String(segment.value), columnX + 10, labelY, { width: (width - 14) / 3 - 10 });
    doc.font("Helvetica").fontSize(6).fillColor(COLORS.muted)
      .text(segment.label, columnX + 10, labelY + 11, { width: (width - 14) / 3 - 10 });
  });
}

function drawUnavailablePanel(doc, x, y, width, title, explanation) {
  doc.font("Helvetica-Bold").fontSize(9).fillColor(COLORS.ink).text(title, x, y, { width, align: "center" });
  doc.roundedRect(x + 8, y + 26, width - 16, 68, 4).fill(COLORS.pale);
  doc.font("Helvetica-Bold").fontSize(9).fillColor(COLORS.muted)
    .text("Not available", x + 15, y + 38, { width: width - 30, align: "center" });
  doc.font("Helvetica").fontSize(7).fillColor(COLORS.ink)
    .text(explanation, x + 15, y + 56, { width: width - 30, align: "center", lineGap: 1 });
}

function drawFinding(doc, index, title, description, y) {
  doc.font("Helvetica-Bold").fontSize(8).fillColor(COLORS.teal).text(String(index), MARGIN, y, { width: 13 });
  doc.font("Helvetica-Bold").fontSize(8).fillColor(COLORS.ink).text(title, MARGIN + 16, y, { continued: true });
  doc.font("Helvetica").fontSize(8).fillColor(COLORS.ink).text(` ${description}`, { width: CONTENT_WIDTH - 16, lineGap: 1 });
  return doc.y + 5;
}

function drawActionTable(doc, y, actions) {
  drawTable(doc, {
    x: MARGIN,
    y,
    widths: [24, 236, 185, 41],
    headers: ["#", "Action", "Why", "Priority"],
    rows: actions.map((action, index) => [String(index + 1), action.action, action.why, ""]),
    rowHeight: 32,
  });
  actions.forEach((action, index) => {
    const priorityColor = action.priority === "High" ? COLORS.red : action.priority === "Medium" ? COLORS.orange : COLORS.muted;
    const rowY = y + 19 + index * 32;
    doc.font("Helvetica-Bold").fontSize(7).fillColor(priorityColor)
      .text(action.priority, MARGIN + 24 + 236 + 185 + 4, rowY + 11, { width: 37, lineBreak: false });
  });
}

function drawPageTwo(doc, metrics) {
  drawHeader(doc, 2, "", "");
  const panelGap = 18;
  const panelWidth = (CONTENT_WIDTH - panelGap) / 2;
  drawOutcomePanel(doc, metrics, MARGIN, 84, panelWidth, "Scan outcome by VIN format");
  drawUnavailablePanel(
    doc,
    MARGIN + panelWidth + panelGap,
    84,
    panelWidth,
    "Inventory verification",
    "A current stock register is needed to verify vehicles.",
  );
  doc.moveTo(MARGIN, 210).lineTo(PAGE_WIDTH - MARGIN, 210).strokeColor(COLORS.line).lineWidth(0.7).stroke();

  sectionTitle(doc, "Key findings", 226);
  let y = 246;
  const processingNote = metrics.processingFailures
    ? `${metrics.processingFailures} scan(s) failed before OCR returned results${metrics.processingStatus ? ` (HTTP ${metrics.processingStatus})` : ""}.`
    : "";
  y = drawFinding(doc, 1, `${metrics.read} of ${metrics.submitted} photos returned a VIN.`, `${processingNote}${metrics.noVinAfterScan ? ` ${metrics.noVinAfterScan} processed photo(s) returned no VIN.` : ""}`, y);
  y = drawFinding(doc, 2, `${metrics.valid} read VIN(s) passed the selected format check.`, `${metrics.invalid} read VIN(s) did not pass and should be confirmed manually.`, y);
  y = drawFinding(doc, 3, `${metrics.uniqueVehicles} unique VIN(s) were identified.`, `${metrics.duplicatePhotos} photo(s) repeat a VIN already seen in this scan.`, y);
  y = drawFinding(doc, 4, "Stock coverage cannot be assessed from photos alone.", "No stock list was supplied to identify verified, missing, or unlisted vehicles.", y);
  y = drawFinding(doc, 5, "Stock age, model, and yard breakdowns are unavailable.", "The scan output does not include a stock register with invoice dates, models, and registered locations.", y);

  const actionsY = Math.max(420, y + 11);
  sectionTitle(doc, "What to do next", actionsY - 19);
  const actions = [];
  if (metrics.processingFailures) {
    actions.push({
      action: "Restore scan service, then rerun the affected images.",
      why: `${metrics.processingFailures} image(s) failed before OCR${metrics.processingStatus ? ` (HTTP ${metrics.processingStatus})` : ""}`,
      priority: "High",
    });
  }
  if (metrics.noVinAfterScan) {
    actions.push({
      action: "Review processed photos with no VIN.",
      why: `${metrics.noVinAfterScan} photo(s) returned no VIN`,
      priority: "High",
    });
  }
  actions.push(
    {
      action: "Confirm format-invalid VINs manually.",
      why: `${metrics.invalid} VIN(s) did not pass the selected format check`,
      priority: metrics.invalid ? "High" : "Medium",
    },
    {
      action: "Match unique VINs against the stock register.",
      why: "Photos alone cannot establish stock coverage",
      priority: "High",
    },
    {
      action: "Provide stock data for age, model, and location analysis.",
      why: "Required for inventory coverage breakdowns",
      priority: "Medium",
    },
  );
  drawActionTable(doc, actionsY, actions);

  doc.font("Helvetica").fontSize(6).fillColor(COLORS.muted)
    .text("Scope: scan results only. Format accuracy is based on VIN length; no manual VIN validation or stock-list comparison was performed.", MARGIN, 790, { width: CONTENT_WIDTH });
}

export function buildAuditReportPdf({ results, totalImages, vehicleType, location = "", generatedAt = new Date() }) {
  const metrics = calculateAuditMetrics({ results, totalImages, vehicleType, location });
  const date = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" }).format(generatedAt);
  const doc = new PDFDocument({ size: "A4", margin: 0, bufferPages: false, info: { Title: "Stockyard Audit - AI Management Report" } });
  const chunks = [];

  return new Promise((resolve, reject) => {
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    drawPageOne(doc, metrics, {
      date,
      location: location || "Location not supplied",
    });
    doc.addPage({ size: "A4", margin: 0 });
    drawPageTwo(doc, metrics);
    doc.end();
  });
}
