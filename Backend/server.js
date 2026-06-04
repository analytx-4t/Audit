import express from "express";
import multer from "multer";
import axios from "axios";
import FormData from "form-data";
import { config } from "dotenv";
import cors from "cors";
import morgan from "morgan";
import OpenAI from "openai";
import ExcelJS from "exceljs";
// import path from "path";
import { Readable } from "stream";
import archiver from "archiver";
import crypto from "crypto";
// import fs from "fs";

config();
const app = express();
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "https://audit-tool-one.vercel.app",
      "https://audit-tool-ipri.vercel.app",
      "https://audit-tool-new.vercel.app",
      "https://audit-tool-bfn1.vercel.app",
      "https://audit-eight-tau.vercel.app"
    ],
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true,
  }),
);

app.use(morgan("dev"));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;


// this is good
async function extractVehicleDetailsWithAI(text) {
  // console.log("text", text);

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `
Extract the following details from invoice text and return ONLY JSON:

{
  "vin": "",
  "engine_number": "",
  "hmil": "",
  "invoice_number": "",
  "invoice_date": "",
  "grand_total": "",
  "hyp_hps": "",
  "tag": "",
  "fuel_type": "",
  "city": "",
  "state": "",
  "country": ""
}

Rules:
- VIN must be 17 characters.
- engine_number must match exactly.
- hmil must be 17 characters.
- If hmil is found and vin is empty, set vin = hmil.
- Extract Grand Total: look for fields labeled "Grand Total", "Total", "Amount", or "₹" followed by a number. Extract the LARGEST final amount as a plain number only (no ₹ symbol, no commas). If multiple totals appear (subtotal, tax subtotal, grand total), always take the final grand total.
- If text contains "HYP / HPA" or "HYP/HPA" or "HYP / HPS", extract ONLY the value after the colon. Example: "HYP / HPA: HDFC Bank Ltd" → extract "HDFC Bank Ltd" only.
- If HYP/HPA label is NOT found but bank details section exists, extract the bank name value from "Bank Name :" or "Bank Name:" field. Extract only the bank name string as written, no prefix, no account numbers.

INVOICE NUMBER & DATE EXTRACTION:
- Look for these label patterns (any of them):
  * "Invoice No." or "Invoice No :" or "Invoice No:" → value after it
  * "Invoice Number" → value after it
  * "Invoice No. :" (with spaces) → value right after the colon
- Invoice number can be numeric only (e.g. "250310015290") OR alphanumeric (e.g. "PH/2526/G/0525") — accept both formats.

- For Invoice Date, look for these label patterns (any of them):
  * "Invoice Date :" or "Invoice Date:" → value after it (e.g. "08.01.2026")
  * "Dated" field in the invoice header table → value after it (e.g. "1-Jan-26", "16-Jan-26")
  * Date formats can be: DD.MM.YYYY, DD-Mon-YY, DD/MM/YYYY — accept all.
- Do NOT use "Ack Date" from the IRN/acknowledgement section at the top.

TAG DETECTION for this document type:
- If text contains "Despatch From" AND "Despatch To" AND "Bill to" AND "Ship to" → tag = "purchase" (this is a HMIL dispatch invoice).
- If text contains "Delivery Note" OR "Dispatch Doc No" → tag = "sale".
- Otherwise → tag = "audit_image".

FUEL TYPE & VIN CONSTRUCTION:
- Look for fuel type keywords: "petrol", "diesel", "cng", "electric", "ev", "hybrid" (case-insensitive).
- Set fuel_type to the matched keyword in lowercase. If none found, set fuel_type to "".
- Often the VIN is split across lines. The fuel type keyword (e.g. "PETROL" or "DIESEL") may appear between the partial VIN and the remaining digits. For example:
    VIN: MALFB81BLSM
    PETROL 699169
  Here "MALFB81BLSM" is partial VIN and "699169" after PETROL/DIESEL is the remaining part.
  Concatenate them to form the full 17-char VIN: "MALFB81BLSM699169".
- The fuel type keyword itself (petrol/diesel etc.) is NOT part of the VIN. Only the numbers/alphanumeric characters around it are.
- Final VIN should be exactly 17 alphanumeric characters with NO fuel type suffix.

CRITICAL VIN DETECTION:
- Scan the ENTIRE text for any 17-character alphanumeric string (letters and digits only, no spaces or special chars).
- If you find any such 17-char alphanumeric string ANYWHERE in the text, treat it as the VIN.
- This applies even if it is not labeled as "VIN" or "HMIL" — any standalone 17-char alphanumeric code is a VIN.
- If multiple 17-char codes exist, prefer the one labeled VIN or HMIL. Otherwise use the first one found.
- Ignore alphanumeric strings longer than 17 characters.
- Do NOT trim longer strings to 17 characters.
- Only consider exact 17-character strings as VIN.

IMPORTANT: If the text contains only a single long alphanumeric code (typically 17 characters) and no invoice details, treat that code as the VIN. Set tag = "audit_image" and leave all other fields empty (except fuel_type if detected).

CITY / STATE / COUNTRY EXTRACTION:
- Look for address blocks in "Bill To", "Ship To", "Buyer", "Consignee", or any address section.
- Extract the city name (e.g. "Mumbai", "Delhi", "Pune") into "city".
- Extract the state name (e.g. "Maharashtra", "Karnataka") into "state".
- Extract the country (e.g. "India") into "country". Default to "India" if an address is present but country is not explicitly stated.
- If no address is found, leave all three as empty strings.

Return only valid JSON.
        `,
      },
      {
        role: "user",
        content: text,
      },
    ],
    temperature: 0,
  });

  let result = JSON.parse(response.choices[0].message.content);

  // FALLBACK: If AI didn't find VIN, use regex to find any 17-char alphanumeric string
  if (!result.vin || result.vin.length !== 17) {
    const matches = text.match(/\b[A-Za-z0-9]{17}\b/g);
    if (matches && matches.length > 0) {
      result.vin = matches[0].toUpperCase();
      console.log("Fallback VIN found via regex:", result.vin);
    }
  }

  // Ensure VIN is always uppercase
  if (result.vin) {
    result.vin = result.vin.toUpperCase();
  }

  

  return result;
}


const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1000,
  },
});

const jobStore = new Map();
app.get("/", (req, res) => {
  return res.json({ message: " Server started at 5000" });
});




// ─── CONFIG ───────────────────────────────────────────────
const BATCH_SIZE = 5;        // files processed in parallel
const DELAY_BETWEEN_BATCHES = 1000; // ms between batches
const MAX_RETRIES = 3;

// ─── HELPER: sleep ────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── HELPER: upload + OCR one file (with retry) ───────────
async function processOneFile(file, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // STEP 1: Upload to Mistral
      const formData = new FormData();
      formData.append("file", file.buffer, {
        filename: file.originalname,
        contentType: file.mimetype,
      });
      formData.append("purpose", "ocr");

      const uploadResponse = await axios.post(
        "https://api.mistral.ai/v1/files",
        formData,
        {
          headers: {
            ...formData.getHeaders(),
            Authorization: `Bearer ${MISTRAL_API_KEY}`,
          },
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
        }
      );

      const fileId = uploadResponse.data.id;

      // STEP 2: Get Signed URL
      const urlResponse = await axios.get(
        `https://api.mistral.ai/v1/files/${fileId}/url`,
        { headers: { Authorization: `Bearer ${MISTRAL_API_KEY}` } }
      );

      const fileUrl = urlResponse.data.url;

      // STEP 3: OCR
      const ocrResponse = await axios.post(
        "https://api.mistral.ai/v1/ocr",
        {
          model: "mistral-ocr-latest",
          document: { type: "document_url", document_url: fileUrl },
        },
        {
          headers: {
            Authorization: `Bearer ${MISTRAL_API_KEY}`,
            "Content-Type": "application/json",
          },
        }
      );

      const ocrText = ocrResponse.data.pages?.[0]?.markdown || "";

      // STEP 4: AI Extraction
      const aiResult = await extractVehicleDetailsWithAI(ocrText);

      return { file, aiResult, success: true };
    } catch (err) {
      const isLastAttempt = attempt === retries;
      const status = err.response?.status;

      // Don't retry on overflow/payload errors
      if (status === 413 || status === 400) {
        console.error(`[${file.originalname}] Payload error, skipping.`);
        break;
      }

      if (isLastAttempt) {
        console.error(`[${file.originalname}] Failed after ${retries} attempts:`, err.message);
      } else {
        const backoff = attempt * 2000; // 2s, 4s, 6s
        console.warn(`[${file.originalname}] Attempt ${attempt} failed. Retrying in ${backoff}ms...`);
        await sleep(backoff);
      }
    }
  }

  return { file, aiResult: null, success: false };
}

// ─── HELPER: run array in batches ─────────────────────────
async function processBatches(files, onFileProcessed = () => {}) {
  const allResults = [];

  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    console.log(`Processing batch ${Math.ceil(i / BATCH_SIZE) + 1} / ${Math.ceil(files.length / BATCH_SIZE)}`);

    const batchResults = await Promise.all(
      batch.map(async (f) => {
        const result = await processOneFile(f);
        onFileProcessed();
        return result;
      })
    );
    allResults.push(...batchResults);

    if (i + BATCH_SIZE < files.length) {
      await sleep(DELAY_BETWEEN_BATCHES);
    }
  }

  return allResults;
}




app.post("/api/extract", (req, res, next) => {
  upload.array("files")(req, res, (err) => {
    if (err) {
      console.error("Multer error:", err.message);
      return res.status(400).json({ error: err.message || "File upload error" });
    }
    next();
  });
}, (req, res) => {
  const files = req.files;
  if (!files || files.length === 0) {
    return res.status(400).json({ error: "No files uploaded" });
  }
  const jobId = crypto.randomUUID();
  jobStore.set(jobId, { status: "processing", total: files.length, processed: 0, result: null, error: null, clients: [] });
  res.json({ jobId, total: files.length });
  runJob(jobId, files);
});

// ─── SSE PROGRESS ─────────────────────────────────────────
app.get("/api/progress/:jobId", (req, res) => {
  const job = jobStore.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  send({ processed: job.processed, total: job.total, status: job.status });
  job.clients.push(send);

  req.on("close", () => {
    job.clients = job.clients.filter((c) => c !== send);
  });
});

// ─── DOWNLOAD RESULT ──────────────────────────────────────
app.get("/api/result/:jobId", (req, res) => {
  const job = jobStore.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Not found" });
  if (job.status === "error") return res.status(500).json({ error: job.error });
  if (job.status !== "done") return res.status(202).json({ status: job.status });

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", "attachment; filename=result.zip");
  res.send(job.result);

  setTimeout(() => jobStore.delete(req.params.jobId), 60_000);
});

// ─── JOB RUNNER ───────────────────────────────────────────
async function runJob(jobId, files) {
  const job = jobStore.get(jobId);
  try {
    const failedFiles = [];
    const uniqueVehicles = new Set();

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Sheet1");
    worksheet.columns = [
      { header: "File Name",      key: "file_name",       width: 12 },
      { header: "VIN",            key: "vin",              width: 22 },
      { header: "Engine Number",  key: "engine_number",    width: 18 },
      { header: "HMIL",           key: "hmil",             width: 10 },
      { header: "Tag",            key: "tag",              width: 14 },
      { header: "Invoice Number", key: "invoice_number",   width: 18 },
      { header: "Invoice Date",   key: "invoice_date",     width: 14 },
      { header: "Grand Total",    key: "grand_total",      width: 14 },
      { header: "HYP/HPS",        key: "hyp_hps",          width: 10 },
      { header: "City",           key: "city",             width: 14 },
      { header: "State",          key: "state",            width: 16 },
      { header: "Country",        key: "country",          width: 12 },
      { header: "VIN Found",      key: "vin_found",        width: 12 },
    ];

    const headerRow = worksheet.getRow(1);
    headerRow.eachCell((cell) => {
      cell.font = { name: "Arial", bold: true, size: 11, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4472C4" } };
      cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      cell.border = {
        top:    { style: "thin", color: { argb: "FF000000" } },
        left:   { style: "thin", color: { argb: "FF000000" } },
        bottom: { style: "thin", color: { argb: "FF000000" } },
        right:  { style: "thin", color: { argb: "FF000000" } },
      };
    });
    headerRow.height = 20;

    const notify = () => {
      job.processed++;
      const update = { processed: job.processed, total: job.total, status: "processing" };
      job.clients.forEach((send) => send(update));
    };

    const allResults = await processBatches(files, notify);

    for (const { file, aiResult, success } of allResults) {
      if (!success || !aiResult) { failedFiles.push(file); continue; }

      const vin = aiResult.vin?.trim() || "";
      const vinValid = vin.length === 17;
      if (!vinValid) failedFiles.push(file);

      const vehicleKey = `${vin.toLowerCase()}_${aiResult.engine_number.trim().toLowerCase()}`;
      uniqueVehicles.add(vehicleKey);

      const dataRow = worksheet.addRow([
        file.originalname, aiResult.vin, aiResult.engine_number, aiResult.hmil,
        aiResult.tag, aiResult.invoice_number, aiResult.invoice_date, aiResult.grand_total,
        aiResult.hyp_hps, aiResult.city, aiResult.state, aiResult.country,
        vinValid ? "Yes" : "Failed",
      ]);

      const isEven = dataRow.number % 2 === 0;
      dataRow.eachCell((cell) => {
        cell.font = { name: "Arial", size: 10 };
        cell.alignment = { horizontal: "center", vertical: "middle" };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: isEven ? "FFD9E1F2" : "FFFFFFFF" } };
        cell.border = {
          top:    { style: "thin", color: { argb: "FFB8CCE4" } },
          left:   { style: "thin", color: { argb: "FFB8CCE4" } },
          bottom: { style: "thin", color: { argb: "FFB8CCE4" } },
          right:  { style: "thin", color: { argb: "FFB8CCE4" } },
        };
      });

      const vinCell = dataRow.getCell(13);
      if (vinValid) {
        vinCell.font = { name: "Arial", size: 10, bold: true, color: { argb: "FF375623" } };
        vinCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC6EFCE" } };
      } else {
        vinCell.font = { name: "Arial", size: 10, bold: true, color: { argb: "FF9C0006" } };
        vinCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFC7CE" } };
      }
    }

    const excelBuffer = await workbook.xlsx.writeBuffer();

    const zipBuffer = await new Promise((resolve, reject) => {
      const archive = archiver("zip", { zlib: { level: 9 } });
      const buffers = [];
      archive.on("data", (d) => buffers.push(d));
      archive.on("end", () => resolve(Buffer.concat(buffers)));
      archive.on("error", reject);
      archive.append(excelBuffer, { name: "vehicles.xlsx" });
      failedFiles.forEach((f) => archive.append(f.buffer, { name: `failed/${f.originalname}` }));
      archive.finalize();
    });

    job.result = zipBuffer;
    job.status = "done";
    job.clients.forEach((send) => send({ processed: job.total, total: job.total, status: "done" }));
  } catch (error) {
    console.error(error.response?.data || error.message);
    job.status = "error";
    job.error = "OCR Failed";
    job.clients.forEach((send) => send({ status: "error", error: "OCR Failed" }));
  }

  setTimeout(() => jobStore.delete(jobId), 10 * 60_000);
}



// app.post("/api/extract", upload.array("files"), async (req, res) => {
//   try {
//     const files = req.files;
//     const results = [];

//     const workbook = new ExcelJS.Workbook();
//     const filePath = "./vehicles.xlsx";
//     const failedFiles = [];

//     const worksheet = workbook.addWorksheet("Sheet1");
//     worksheet.addRow([
//       "File Name",
//       "VIN",
//       "Engine Number",
//       "HMIL",
//       "Tag",
//       "Invoice Number",
//       "Invoice Date",
//       "Grand Total",
//       "HYP/HPS",
//       "VIN Found",
//     ]);

//     // ✅ Set to track unique VIN + Engine combinations
//     const uniqueVehicles = new Set();

//     for (const file of files) {
//       // STEP 1: Upload to Mistral
//       const formData = new FormData();
//       formData.append("file", file.buffer, {
//         filename: file.originalname,
//         contentType: file.mimetype,
//       });

//       formData.append("purpose", "ocr");

//       const uploadResponse = await axios.post(
//         "https://api.mistral.ai/v1/files",
//         formData,
//         {
//           headers: {
//             ...formData.getHeaders(),
//             Authorization: `Bearer ${MISTRAL_API_KEY}`,
//           },
//         },
//       );

//       const fileId = uploadResponse.data.id;

//       // STEP 2: Get Signed URL
//       const urlResponse = await axios.get(
//         `https://api.mistral.ai/v1/files/${fileId}/url`,
//         {
//           headers: {
//             Authorization: `Bearer ${MISTRAL_API_KEY}`,
//           },
//         },
//       );

//       const fileUrl = urlResponse.data.url;

//       // STEP 3: OCR
//       const ocrResponse = await axios.post(
//         "https://api.mistral.ai/v1/ocr",
//         {
//           model: "mistral-ocr-latest",
//           document: {
//             type: "document_url",
//             document_url: fileUrl,
//           },
//         },
//         {
//           headers: {
//             Authorization: `Bearer ${MISTRAL_API_KEY}`,
//             "Content-Type": "application/json",
//           },
//         },
//       );

//       const ocrText = ocrResponse.data.pages?.[0]?.markdown || "";

//       // STEP 4: AI Extraction

//       const aiResult = await extractVehicleDetailsWithAI(ocrText);

//       const vinFoundone = aiResult.vin && aiResult.vin.trim() !== "";

      
//       if (!vinFoundone) {
//         failedFiles.push(file);
//       }


//       // console.log("airesult",aiResult)

//       // ❌ Skip if VIN or Engine missing
//       // if (!aiResult.vin || !aiResult.engine_number) {
//       //   console.log("Missing VIN or Engine, skipped:", file.originalname);
//       //   continue;
//       // }

//       // 🔑 Create unique key using VIN + Engine
//       const vehicleKey = `${aiResult.vin.trim().toLowerCase()}_${aiResult.engine_number
//         .trim()
//         .toLowerCase()}`;

//       // ❌ Skip duplicate
//       if (uniqueVehicles.has(vehicleKey)) {
//         console.log("Duplicate Vehicle skipped:", vehicleKey);
//         continue;
//       }

//       // ✅ Add to Set
//       uniqueVehicles.add(vehicleKey);

//       // // STEP 5: Tag Detection
//       // const lowerText = ocrText.toLowerCase();
//       // let tag = "audit_image";

//       // if (lowerText.includes("ship to")) {
//       //   tag = "purchase";
//       // } else if (lowerText.includes("delivery note")) {
//       //   tag = "invoice";
//       // }
//       const vinFound = aiResult.vin && aiResult.vin.trim() !== "" ? "Yes" : "No";

//       results.push({
//         fileName: file.originalname,
//         vin: aiResult.vin,
//         engine_number: aiResult.engine_number,
//         hmil: aiResult.hmil,
//         tag: aiResult.tag,
//         invoice_number: aiResult.invoice_number,
//         invoice_date: aiResult.invoice_date,
//         grand_total: aiResult.grand_total,
//         hyp_hps: aiResult.hyp_hps,
//         vin_found: vinFound,
//       });

//       // worksheet.addRow([
//       //   file.originalname,
//       //   aiResult.vin,
//       //   aiResult.engine_number,
//       //   aiResult.hmil,
//       //   aiResult.tag,
//       //   aiResult.tag === "purchase" ? aiResult.invoice_number : "",
//       //   aiResult.tag === "purchase" ? aiResult.invoice_date : "",
//       //   aiResult.tag === "purchase" ? aiResult.grand_total : "",
//       //   aiResult.tag === "purchase" ? aiResult.hyp_hps : "",
//       //   vinFound
//       // ]);

//       worksheet.addRow([
//   file.originalname,
//   aiResult.vin,
//   aiResult.engine_number,
//   aiResult.hmil,
//   aiResult.tag,
//   aiResult.invoice_number,   // removed tag condition
//   aiResult.invoice_date,     // removed tag condition
//   aiResult.grand_total,      // removed tag condition
//   aiResult.hyp_hps,          // removed tag condition
//   vinFound
// ]);
//     }

//     // 👉 Excel buffer 
//     const excelBuffer = await workbook.xlsx.writeBuffer();

//     // 👉 Create ZIP
//     res.setHeader("Content-Type", "application/zip");
//     res.setHeader("Content-Disposition", "attachment; filename=result.zip");

//     const archive = archiver("zip", { zlib: { level: 9 } });

//     archive.pipe(res);

//     // ✅ Add Excel inside ZIP
//     archive.append(excelBuffer, { name: "vehicles.xlsx" });

//     // ❌ Add failed images
//     failedFiles.forEach((file) => {
//       archive.append(file.buffer, { name: `failed/${file.originalname}` });
//     });

//     await archive.finalize();
//   } catch (error) {
//     console.error(error.response?.data || error.message);
//     res.status(500).json({ error: "OCR Failed" });
//   }
// });

app.post(
  "/api/upload",
  upload.fields([
    { name: "customFile", maxCount: 1 },
    { name: "masterFile", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const customFile = req.files["customFile"]?.[0];
      const masterFile = req.files["masterFile"]?.[0];

      if (!customFile || !masterFile) {
        return res.status(400).json({ error: "Both files required" });
      }

      const customWorkbook = new ExcelJS.Workbook();
      const masterWorkbook = new ExcelJS.Workbook();

      // Load Custom File
      if (customFile.mimetype === "text/csv") {
        await customWorkbook.csv.read(Readable.from(customFile.buffer));
      } else {
        await customWorkbook.xlsx.load(customFile.buffer);
      }

      // Load Master File
      if (masterFile.mimetype === "text/csv") {
        await masterWorkbook.csv.read(Readable.from(masterFile.buffer));
      } else {
        await masterWorkbook.xlsx.load(masterFile.buffer);
      }

      const customSheet = customWorkbook.worksheets[0];
      const masterSheet = masterWorkbook.worksheets[0];

      // 🔎 Detect Required Columns in Custom
      let vinCol, tagCol, invoiceCol, dateCol, totalCol, hypCol, cityCol, stateCol, countryCol;

      customSheet.getRow(1).eachCell((cell, colNumber) => {
        const header = cell.value?.toString().trim().toUpperCase();

        if (header === "VIN") vinCol = colNumber;
        if (header === "TAG") tagCol = colNumber;
        if (header === "INVOICE NUMBER") invoiceCol = colNumber;
        if (header === "INVOICE DATE") dateCol = colNumber;
        if (header === "GRAND TOTAL") totalCol = colNumber;
        if (header === "HYP/HPS" || header === "HYP/HPA") hypCol = colNumber;
        if (header === "CITY") cityCol = colNumber;
        if (header === "STATE") stateCol = colNumber;
        if (header === "COUNTRY") countryCol = colNumber;
      });

      console.log("Detected columns in custom file:", { vinCol, tagCol, invoiceCol, dateCol, totalCol, hypCol, cityCol, stateCol, countryCol });

      if (!vinCol) {
        return res
          .status(400)
          .json({ error: "VIN column not found in Custom file" });
      }

      // 🔎 Detect CHASSIS_NO in Master
      let chassisCol;

      masterSheet.getRow(1).eachCell((cell, colNumber) => {
        const header = cell.value?.toString().trim().toUpperCase();
        if (header === "CHASSIS_NO") chassisCol = colNumber;
      });

      if (!chassisCol) {
        return res
          .status(400)
          .json({ error: "CHASSIS_NO column not found in Master file" });
      }

      // 🔹 Create VIN Map (Store full purchase data)
      const vinMap = new Map();

      customSheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;

        const vin = row.getCell(vinCol).value;
        if (!vin) return;

        const cleanVin = vin.toString().trim().toLowerCase();

        vinMap.set(cleanVin, {
          tag:
            row.getCell(tagCol)?.value?.toString().trim().toLowerCase() || "",
          invoice_number: row.getCell(invoiceCol)?.value || "",
          invoice_date: row.getCell(dateCol)?.value || "",
          grand_total: row.getCell(totalCol)?.value || "",
          hyp: row.getCell(hypCol)?.value || "",
          city: row.getCell(cityCol)?.value || "",
          state: row.getCell(stateCol)?.value || "",
          country: row.getCell(countryCol)?.value || "",
        });
      });

      // Debug: show first vinMap entry
      if (vinMap.size > 0) {
        const [sampleVin, sampleData] = vinMap.entries().next().value;
        console.log("Sample vinMap entry:", { vin: sampleVin, city: sampleData.city, state: sampleData.state, country: sampleData.country });
      }

      // 🔥 Add New Columns in Master
      const foundCol = masterSheet.columnCount + 1;
      const matchedCol = masterSheet.columnCount + 2;
      const purchaseVerifiedCol = masterSheet.columnCount + 3;
      const invoiceColMaster = masterSheet.columnCount + 4;
      const invoiceDateColMaster = masterSheet.columnCount + 5;
      const totalColMaster = masterSheet.columnCount + 6;
      const hypColMaster = masterSheet.columnCount + 7;
      const cityColMaster = masterSheet.columnCount + 8;
      const stateColMaster = masterSheet.columnCount + 9;
      const countryColMaster = masterSheet.columnCount + 10;

      masterSheet.getRow(1).getCell(foundCol).value = "Found (YES OR NO)";
      masterSheet.getRow(1).getCell(matchedCol).value = "Matched_CHASSIS_NO";
      masterSheet.getRow(1).getCell(purchaseVerifiedCol).value = "Purchase_Verified";
      masterSheet.getRow(1).getCell(invoiceColMaster).value = "Invoice Number";
      masterSheet.getRow(1).getCell(invoiceDateColMaster).value = "Invoice Date";
      masterSheet.getRow(1).getCell(totalColMaster).value = "Grand Total";
      masterSheet.getRow(1).getCell(hypColMaster).value = "HYP/HPA";
      masterSheet.getRow(1).getCell(cityColMaster).value = "City";
      masterSheet.getRow(1).getCell(stateColMaster).value = "State";
      masterSheet.getRow(1).getCell(countryColMaster).value = "Country";

      // 🔎 Compare Data
      masterSheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;

        const chassisVal = row.getCell(chassisCol).value;
        const cleanVal = chassisVal
          ? chassisVal.toString().trim().toLowerCase()
          : "";
        const lookupKey = cleanVal;

        if (vinMap.has(lookupKey)) {
          const customData = vinMap.get(lookupKey);

          row.getCell(foundCol).value = "YES";
          row.getCell(matchedCol).value = chassisVal;

          row.getCell(cityColMaster).value = customData.city;
          row.getCell(stateColMaster).value = customData.state;
          row.getCell(countryColMaster).value = customData.country;

          if (customData.tag === "purchase") {
            row.getCell(purchaseVerifiedCol).value = "YES";
            row.getCell(invoiceColMaster).value = customData.invoice_number;
            row.getCell(invoiceDateColMaster).value = customData.invoice_date;
            row.getCell(totalColMaster).value = customData.grand_total;
            row.getCell(hypColMaster).value = customData.hyp;
          } else {
            row.getCell(purchaseVerifiedCol).value = "NO";
          }
        } else {
          row.getCell(foundCol).value = "NO";
          row.getCell(purchaseVerifiedCol).value = "NO";
        }
      });

      // 🔥 Return Updated Master File
      const finalWorkbook = new ExcelJS.Workbook();
      const finalSheet = finalWorkbook.addWorksheet("Master_Data");

      masterSheet.eachRow((row) => {
        finalSheet.addRow(row.values);
      });

      const buffer = await finalWorkbook.xlsx.writeBuffer();

      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );

      res.setHeader(
        "Content-Disposition",
        "attachment; filename=Master_Compared_Result.xlsx",
      );

      res.send(buffer);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Comparison Failed" });
    }
  },
);

app.listen(5000, () => console.log("Server running at 5000"));
