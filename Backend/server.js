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
import sharp from "sharp";
import { createWorker } from "tesseract.js";

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
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com",
});

const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const OCR_3_MODEL = process.env.MISTRAL_OCR_3_MODEL || "mistral-ocr-latest";
const STICKER_ONLY_INSTRUCTION = "The input is a close-up image of a vehicle identification sticker or manufacturer plate. Ignore unrelated scene content, geotagged metadata, and any non-sticker text. Extract only the requested identification fields.";

function normalizeVehicleType(vehicleType = "") {
  const normalized = (vehicleType || "").toString().trim().toLowerCase();
  if (normalized.includes("2") || normalized.includes("two")) return "two_wheeler";
  if (normalized.includes("4") || normalized.includes("four")) return "four_wheeler";
  if (normalized.includes("commercial equipment") || normalized.includes("equipment")) return "commercial_equipment";
  if (normalized.includes("commercial vehicle") || normalized.includes("commercial")) return "commercial_vehicle";
  return "general";
}

function getVehiclePromptBundle(vehicleType = "") {
  const normalizedType = normalizeVehicleType(vehicleType);
  const bundles = {
    two_wheeler: {
      key: "two_wheeler",
      label: "2 Wheeler",
      ocr3Prompt: `You are an OCR extraction engine specialized in Indian two-wheelers.

${STICKER_ONLY_INSTRUCTION}

Your task is to extract exactly three fields from the image.

Step 1
Locate the manufacturer identification sticker, chassis sticker, engraved frame VIN, or manufacturer plate.

Step 2
Extract:

• VIN Number
• Engine Number (only if explicitly written)
• Fuel Type

VIN Rules

- VIN is usually a 17-character uppercase alphanumeric identifier.
- Read every visible character carefully.
- Preserve the exact sequence.
- Never replace uncertain characters.
- Never infer hidden characters.
- If any VIN character cannot be confidently read, return an empty string.

Engine Number Rules

Extract ONLY when an explicit field such as

ENGINE NO
ENGINE NUMBER
ENG NO

exists.

Do not derive the engine number from any other identifier.

Fuel Rules

Normalize to one of

PETROL
DIESEL
CNG
LPG
ELECTRIC

Examples

1CNG → CNG

Ignore every other field.

Return ONLY

{
  "vin_number":"",
  "engine_number":"",
  "fuel_type":""
}`,
      ocr4Prompt: `You are performing a second-pass OCR inspection on a two-wheeler image.

The previous OCR may have missed important fields.

Search the image methodically.

Search Order

1. Manufacturer sticker
2. White label
3. Chassis engraving
4. Frame tube
5. QR sticker area
6. Rotated text
7. Vertical text

Required fields

VIN Number

Engine Number (explicitly written only)

Fuel Type

VIN may

• be vertical
• be engraved
• be rotated
• be beside a QR code
• be partially faded

Read the complete VIN before returning.

Do not stop after the first candidate.

If multiple VIN-like strings exist, choose the one explicitly associated with VIN or chassis.

Engine Number

Return only when explicitly labelled.

Fuel

Return

PETROL

DIESEL

CNG

LPG

ELECTRIC

Output

{
"vin_number":"",
"engine_number":"",
"fuel_type":""
}`,
      llmPrompt: `You are validating OCR results using visual reasoning.

${STICKER_ONLY_INSTRUCTION}

The OCR system was unable to confidently extract one or more required fields.

Inspect the entire image carefully.

Reason internally about

• manufacturer labels
• frame engraving
• sticker layout
• text alignment

Locate

VIN Number

Engine Number (explicitly labelled)

Fuel Type

Rules

Never guess hidden characters.

Never complete a partial VIN.

Never invent an engine number.

If confidence is insufficient, return an empty string.

Return only

{
"vin_number":"",
"engine_number":"",
"fuel_type":""
}`,
      schema: {
        type: "object",
        properties: {
          vin: { type: "string" },
          engine_number: { type: "string" },
          fuel_type: { type: "string" },
        },
        required: ["vin", "engine_number", "fuel_type"],
      },
    },
    four_wheeler: {
      key: "four_wheeler",
      label: "4 Wheeler",
      ocr3Prompt: `You are an OCR extraction engine for Indian passenger vehicles.

Locate the factory identification sticker.

Extract

VIN Number

Engine Number (only if explicitly written)

Fuel Type

VIN usually follows

VIN:

Fuel usually appears as

PETROL

DIESEL

CNG

LPG

EV

Normalize

1CNG → CNG

Rules

Return the VIN exactly as printed.

Never reconstruct missing characters.

Never use barcode values.

Ignore every other identifier.

Return

{
"vin_number":"",
"engine_number":"",
"fuel_type":""
}`,
      ocr4Prompt: `You are performing an exhaustive OCR inspection.

The VIN may be

• covered by a barcode
• split across two lines
• printed vertically
• partially faded
• near glass markings

Inspect the complete manufacturer sticker before answering.

Required

VIN Number

Engine Number (explicit only)

Fuel Type

If multiple serial numbers exist

Prefer the value explicitly associated with

VIN

Ignore

PIO

SPEC

Body Number

Barcode

QR

Dealer Sticker

Return

{
"vin_number":"",
"engine_number":"",
"fuel_type":""
}`,
      llmPrompt: `You are the final visual verification model.

Previous OCR passes were unable to confidently identify

VIN

Engine Number

Fuel Type

Inspect the complete sticker visually.

Focus on

VIN field

Fuel field

Engine Number field

Never use unrelated serial numbers.

Never infer hidden VIN characters.

Return empty strings for uncertain values.

Return only JSON.`,
      schema: {
        type: "object",
        properties: {
          vin: { type: "string" },
          engine_number: { type: "string" },
          fuel_type: { type: "string" },
        },
        required: ["vin", "engine_number", "fuel_type"],
      },
    },
    commercial_equipment: {
      key: "commercial_equipment",
      label: "Commercial Equipment",
      ocr3Prompt: `You are extracting identification data from commercial equipment.

Required

VIN Number

Engine Number

Fuel Type

Locate the manufacturer identification plate.

Read only fields explicitly labelled

VIN

ENGINE NO

ENGINE NUMBER

FUEL

Ignore

Model

Approval Numbers

Weights

Ratings

Return

{
"vin_number":"",
"engine_number":"",
"fuel_type":""
}`,
      ocr4Prompt: `Perform a complete inspection of the manufacturer plate.

Inspect engraved text.

Inspect faded regions.

Inspect rotated labels.

Locate

VIN

Engine Number

Fuel Type

Return only values that can be confidently read.

Otherwise return empty strings.

Output JSON only.`,
      llmPrompt: `Visually inspect the identification plate.

Recover

VIN

Engine Number

Fuel Type

Do not infer hidden characters.

Only return values with high confidence.

Return JSON.`,
      schema: {
        type: "object",
        properties: {
          vin: { type: "string" },
          engine_number: { type: "string" },
          fuel_type: { type: "string" },
        },
        required: ["vin", "engine_number", "fuel_type"],
      },
    },
    commercial_vehicle: {
      key: "commercial_vehicle",
      label: "Commercial Vehicles",
      ocr3Prompt: `You are an OCR engine specialized in commercial vehicle identification plates.

Examples include

Eicher

Tata

Ashok Leyland

BharatBenz

Mahindra

Extract only

VIN Number

Engine Number

Fuel Type

Commercial plates contain many unrelated numbers.

Ignore

CMVR

GVW

GCW

FAW

RAW

MFG YEAR

MODEL

Approval Number

Weight Ratings

Locate

VIN

ENGINE NO

Fuel

Return only

{
"vin_number":"",
"engine_number":"",
"fuel_type":""
}`,
      ocr4Prompt: `Perform an exhaustive inspection of the commercial vehicle plate.

Search the complete plate before answering.

VIN may be engraved with low contrast.

Engine Number may be engraved below the manufacturing year.

Fuel may appear separately.

Ignore all weight values.

Return only

VIN

Engine Number

Fuel Type

Return JSON.`,
      llmPrompt: `You are verifying a commercial vehicle manufacturer plate.

OCR was unable to confidently extract the required information.

Visually inspect the plate.

Locate

VIN

Engine Number

Fuel Type

Never confuse

CMVR

Weight

Model

Approval Number

with VIN.

Return empty strings when uncertain.

Return only JSON.`,
      schema: {
        type: "object",
        properties: {
          vin: { type: "string" },
          engine_number: { type: "string" },
          fuel_type: { type: "string" },
        },
        required: ["vin", "engine_number", "fuel_type"],
      },
    },
    general: {
      key: "general",
      label: "General",
      ocr3Prompt: `TODO: Add OCR 3 prompt for general vehicle documents here.\n\n${STICKER_ONLY_INSTRUCTION}`,
      ocr4Prompt: `TODO: Add OCR 4 prompt for general vehicle documents here.`,
      llmPrompt: `TODO: Add LLM fallback prompt for general vehicle documents here.\n\n${STICKER_ONLY_INSTRUCTION}`,
      schema: {
        type: "object",
        properties: {
          vin: { type: "string" },
          engine_number: { type: "string" },
          fuel_type: { type: "string" },
        },
        required: ["vin", "engine_number", "fuel_type"],
      },
    },
  };

  return bundles[normalizedType] || bundles.general;
}

function extractVehicleDetailsFromText(text = "", vehicleType = "") {
  const result = {
    vin: "",
    engine_number: "",
    hmil: "",
    invoice_number: "",
    invoice_date: "",
    grand_total: "",
    hyp_hps: "",
    tag: "audit_image",
    fuel_type: "",
    city: "",
    state: "",
    country: "",
  };

  const content = text || "";
  const vinMatches = content.match(/\b[A-Za-z0-9]{17}\b/g) || [];
  if (vinMatches.length > 0) {
    result.vin = vinMatches[0].toUpperCase();
  }

  const hmilMatch = content.match(/\b[A-Za-z0-9]{17}\b/g) || [];
  if (hmilMatch.length > 1) {
    result.hmil = hmilMatch[1]?.toUpperCase() || "";
  }

  const engineMatch = content.match(/engine(?:\s*number|\s*no\.?|\s*no)?\s*[:#-]?\s*([A-Za-z0-9\-\/\s]{2,30})/i);
  if (engineMatch && engineMatch[1]) {
    result.engine_number = engineMatch[1].trim().replace(/\s+/g, " ");
  }

  const invoiceNumberMatch = content.match(/invoice\s*(?:no\.?|number)\s*[:#-]?\s*([A-Za-z0-9\-\/]{2,30})/i);
  if (invoiceNumberMatch && invoiceNumberMatch[1]) {
    result.invoice_number = invoiceNumberMatch[1].trim();
  }

  const invoiceDateMatch = content.match(/invoice\s*date\s*[:#-]?\s*([0-9]{1,2}[\/.\-][0-9]{1,2}[\/.\-][0-9]{2,4})/i);
  if (invoiceDateMatch && invoiceDateMatch[1]) {
    result.invoice_date = invoiceDateMatch[1].trim();
  }

  const grandTotalMatch = content.match(/grand\s+total[^0-9]*([0-9,\.]+)/i) || content.match(/total[^0-9]*([0-9,\.]+)/i);
  if (grandTotalMatch && grandTotalMatch[1]) {
    result.grand_total = grandTotalMatch[1].replace(/,/g, "");
  }

  if (/dispatch from/i.test(content) && /dispatch to/i.test(content) && /bill to/i.test(content) && /ship to/i.test(content)) {
    result.tag = "purchase";
  } else if (/delivery note/i.test(content) || /dispatch doc no/i.test(content)) {
    result.tag = "sale";
  }

  const fuelTypeMatch = content.match(/\b(petrol|diesel|cng|electric|ev|hybrid)\b/i);
  if (fuelTypeMatch && fuelTypeMatch[1]) {
    result.fuel_type = fuelTypeMatch[1].toLowerCase();
  }

  if (vehicleType) {
    result.tag = result.tag === "audit_image" ? "audit_image" : result.tag;
  }

  if (!result.vin && result.hmil) {
    result.vin = result.hmil;
  }

  return result;
}

function isExtractionSuccessful(result = {}) {
  const vin = String(result.vin || "").trim();
  const engineNumber = String(result.engine_number || "").trim();
  return Boolean(vin.length === 17 || engineNumber);
}

function normalizeOcrStructuredOutput(text = "") {
  const candidate = (text || "").trim();
  const result = {
    vin: "",
    engine_number: "",
    fuel_type: "",
  };

  if (!candidate) return result;

  try {
    const jsonMatch = candidate.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      result.vin = parsed.vin_number || parsed.vin || "";
      result.engine_number = parsed.engine_number || parsed.engineNo || parsed.engine || "";
      result.fuel_type = parsed.fuel_type || parsed.fuel || "";
      return result;
    }
  } catch (error) {
    // fall back to regex-based extraction below
  }

  const vinMatch = candidate.match(/\b[A-Za-z0-9]{17}\b/);
  if (vinMatch) result.vin = vinMatch[0].toUpperCase();

  const engineMatch = candidate.match(/engine(?:\s*number|\s*no\.?|\s*no)?\s*[:#-]?\s*([A-Za-z0-9\-\/\s]{2,30})/i);
  if (engineMatch && engineMatch[1]) result.engine_number = engineMatch[1].trim().replace(/\s+/g, " ");

  const fuelMatch = candidate.match(/\b(petrol|diesel|cng|lpg|electric|ev)\b/i);
  if (fuelMatch && fuelMatch[1]) result.fuel_type = fuelMatch[1].toLowerCase();

  return result;
}

function cleanMarkdown(text) {
  if (!text) return "";
  let cleaned = text.replace(/!\[.*?\]\(.*?\)/gi, "");
  cleaned = cleaned.replace(/\[.*?\]\(.*?\)/gi, "");
  return cleaned;
}

function postProcessVin(vin) {
  if (!vin) return "";
  const cleaned = vin.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (cleaned.length === 17) return cleaned;
  return "";
}

async function extractVehicleDetailsWithAI(text, vehicleType = "") {
  const promptBundle = getVehiclePromptBundle(vehicleType);
  const vehicleContext = vehicleType ? `\nVehicle type context: ${promptBundle.label}. Use this context to interpret the document and extract the correct VIN-related details.\n` : "";

  try {
    const response = await openai.chat.completions.create({
      model: "deepseek-chat",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `
You are a highly precise OCR extraction engine for Indian vehicle documents and chassis/engine images.${vehicleContext}
Locate the VIN / Chassis number, engine number, and fuel type from the OCR text.

SYNONYMS & LABELS:
- VIN / Chassis Number / Chassis No / CNo / Frame No / Frame Number / FNo / F: are all synonyms.
- Engine Number / Engine No / Eng No / ENo / E: are all synonyms.

STRICT RULES FOR VIN (CHASSIS NUMBER):
- A valid Indian VIN is EXACTLY 17 characters long, uppercase, alphanumeric.
- It never contains spaces, hyphens, or special characters.
- If the OCR text has noise at the start or end (e.g., "NXE4KC407KSG1787746" or "AXEL40407KSG178774E" or "F: MD626AM10S1H01985 2025"), carefully extract the core 17-character VIN (e.g., "AE4KC407KSG178774" or "MD626AM10S1H01985").
- Never invent/hallucinate a VIN. If no 17-character sequence (or near sequence that can be corrected to 17 characters by removing noise/spaces) is visible in the OCR text, leave "vin" as "".
- Double check that the "vin" you output is exactly 17 characters long after removing spaces. If it is not 17 characters, do not output it.

STRICT RULES FOR ENGINE NUMBER:
- Extract only if explicitly labelled (e.g., Engine No, ENG NO, E:, etc.). Otherwise leave as "".

Return only valid JSON in the format:
{
  "vin": "",
  "engine_number": "",
  "fuel_type": ""
}
          `,
        },
        {
          role: "user",
          content: text,
        },
      ],
      temperature: 0,
    });

    const parsed = JSON.parse(response.choices[0].message.content || "{}");
    const result = {
      vin: postProcessVin(parsed.vin),
      engine_number: parsed.engine_number || "",
      hmil: "",
      invoice_number: "",
      invoice_date: "",
      grand_total: "",
      hyp_hps: "",
      tag: "audit_image",
      fuel_type: parsed.fuel_type || "",
      city: "",
      state: "",
      country: "",
    };

    if (!isExtractionSuccessful(result)) {
      const regexResult = extractVehicleDetailsFromText(text, vehicleType);
      return {
        ...regexResult,
        ...result,
        vin: postProcessVin(result.vin || regexResult.vin),
        engine_number: result.engine_number || regexResult.engine_number || "",
        fuel_type: result.fuel_type || regexResult.fuel_type || "",
      };
    }

    return result;
  } catch (error) {
    console.error("LLM fallback extraction failed:", error.message);
    const regexResult = extractVehicleDetailsFromText(text, vehicleType);
    return {
      ...regexResult,
      vin: postProcessVin(regexResult.vin),
      hmil: "",
      invoice_number: "",
      invoice_date: "",
      grand_total: "",
      hyp_hps: "",
      tag: "audit_image",
      city: "",
      state: "",
      country: "",
    };
  }
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
async function uploadFileToMistral(file) {
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
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const urlResponse = await axios.get(
        `https://api.mistral.ai/v1/files/${fileId}/url`,
        { headers: { Authorization: `Bearer ${MISTRAL_API_KEY}` } }
      );
      return urlResponse.data.url;
    } catch (err) {
      if (err.response?.status === 404 && attempt < 5) {
        await sleep(2000);
      } else {
        throw err;
      }
    }
  }
}

async function runOcrStage(fileUrl, modelName, stageName, vehicleType = "") {
  const promptBundle = getVehiclePromptBundle(vehicleType);
  const promptText = stageName === "ocr3" ? promptBundle.ocr3Prompt : promptBundle.ocr4Prompt;
  console.log(`[${stageName}] Using ${modelName} for ${promptBundle.label}`);
  // TODO: inject your vehicle-specific OCR prompt and JSON schema here for the selected Mistral OCR model.
  console.log(`[${stageName}] Prompt placeholder: ${promptText}`);

  const ocrResponse = await axios.post(
    "https://api.mistral.ai/v1/ocr",
    {
      model: modelName,
      document: { type: "document_url", document_url: fileUrl },
    },
    {
      headers: {
        Authorization: `Bearer ${MISTRAL_API_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );

  return ocrResponse.data.pages?.[0]?.markdown || "";
}

async function cropVehicleWithPercent(buffer, cropPercent) {
  if (!cropPercent || cropPercent >= 1.0) {
    return buffer;
  }
  try {
    const image = sharp(buffer);
    const metadata = await image.metadata();
    const width = metadata.width;
    const height = metadata.height;
    
    const cropHeight = Math.round(height * cropPercent);
    return await image
      .extract({ left: 0, top: 0, width: width, height: cropHeight })
      .greyscale()
      .normalize()
      .sharpen()
      .jpeg()
      .toBuffer();
  } catch (err) {
    console.error(`[Cropping] Sharp error:`, err.message);
    return buffer;
  }
}

async function processOneFile(file, retries = MAX_RETRIES, vehicleType = "", addressDetails = {}) {
  const isImage = file.mimetype && file.mimetype.startsWith("image/");
  const originalBuffer = file.buffer;

  // Decide the crop passes based on vehicle type
  const normalized = normalizeVehicleType(vehicleType);
  const passes = [];

  if (isImage) {
    if (normalized === "two_wheeler" || normalized === "commercial_vehicle" || normalized === "commercial_equipment") {
      passes.push(0.85, 0.80);
    } else {
      // For general documents and 4 wheelers (which are often invoices), try 100% height first, and fall back to 85% crop
      passes.push(1.0, 0.85);
    }
  } else {
    passes.push(null);
  }

  for (let passIndex = 0; passIndex < passes.length; passIndex++) {
    const cropPercent = passes[passIndex];
    console.log(`[${file.originalname}] Pass ${passIndex + 1}/${passes.length} (Crop: ${cropPercent ? (cropPercent * 100) + '%' : 'None'})`);

    let currentBuffer = originalBuffer;
    if (isImage && cropPercent !== null) {
      try {
        currentBuffer = await cropVehicleWithPercent(originalBuffer, cropPercent);
      } catch (cropErr) {
        console.error(`[Cropping] Failed to crop file ${file.originalname}:`, cropErr.message);
      }
    }

    let passSuccess = false;
    let resultData = null;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        // Create a temporary file object with the cropped buffer
        const tempFile = {
          ...file,
          buffer: currentBuffer
        };

        const fileUrl = await uploadFileToMistral(tempFile);
        const rawOcrText = await runOcrStage(fileUrl, OCR_3_MODEL, "ocr3", vehicleType);
        const cleanedOcrText = cleanMarkdown(rawOcrText);

        const llmResult = await extractVehicleDetailsWithAI(cleanedOcrText, vehicleType);

        if (isExtractionSuccessful(llmResult)) {
          const finalResult = {
            ...llmResult,
            address: addressDetails.address || "",
            city: addressDetails.city || llmResult.city || "",
            state: addressDetails.state || llmResult.state || "",
            pincode: addressDetails.pincode || "",
            country: "",
          };
          console.log(`[${file.originalname}] Pass ${passIndex + 1} succeeded using DeepSeek!`);
          resultData = { file, aiResult: finalResult, success: true, source: `pass_${passIndex + 1}` };
          passSuccess = true;
          break;
        } else {
          console.log(`[${file.originalname}] Pass ${passIndex + 1} did not find a valid 17-character VIN.`);
          resultData = {
            file,
            aiResult: {
              vin: "",
              engine_number: "",
              hmil: "",
              invoice_number: "",
              invoice_date: "",
              grand_total: "",
              hyp_hps: "",
              tag: "audit_image",
              fuel_type: "",
              address: addressDetails.address || "",
              city: addressDetails.city || "",
              state: addressDetails.state || "",
              pincode: addressDetails.pincode || "",
              country: "",
            },
            success: false,
            source: "failed"
          };
          break; // Don't retry the same pass if OCR and LLM completed but didn't find the VIN. Move to next pass!
        }
      } catch (err) {
        const isLastAttempt = attempt === retries;
        const status = err.response?.status;

        if (status === 413 || status === 400) {
          console.error(`[${file.originalname}] Payload error, skipping.`);
          break;
        }

        if (isLastAttempt) {
          console.error(`[${file.originalname}] Attempt ${attempt} failed on pass ${passIndex + 1}:`, err.message);
        } else {
          const backoff = attempt * 2000;
          console.warn(`[${file.originalname}] Attempt ${attempt} failed on pass ${passIndex + 1}. Retrying in ${backoff}ms...`);
          await sleep(backoff);
        }
      }
    }

    if (passSuccess) {
      return resultData;
    }

    // If it's the last pass and it failed, return the failed resultData
    if (passIndex === passes.length - 1) {
      return resultData;
    }
  }

  return { file, aiResult: null, success: false };
}

// ─── HELPER: run array in batches ─────────────────────────
async function processBatches(files, onFileProcessed = () => {}, vehicleType = "", addressDetails = {}) {
  const allResults = [];

  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    console.log(`Processing batch ${Math.ceil(i / BATCH_SIZE) + 1} / ${Math.ceil(files.length / BATCH_SIZE)}`);

    const batchResults = await Promise.all(
      batch.map(async (f) => {
        const TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes per file
        let timer;
        const processingPromise = processOneFile(f, MAX_RETRIES, vehicleType, addressDetails).then((r) => {
          clearTimeout(timer);
          return r;
        }).catch((err) => {
          clearTimeout(timer);
          throw err;
        });

        const timeoutPromise = new Promise((resolve) => {
          timer = setTimeout(() => {
            console.warn(`[Timeout] File ${f.originalname} exceeded ${TIMEOUT_MS}ms`);
            resolve({ file: f, aiResult: { timeout: "timeout" }, success: false, source: "timeout" });
          }, TIMEOUT_MS);
        });

        const result = await Promise.race([processingPromise, timeoutPromise]);
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
  const vehicleType = req.body.vehicle_type || req.body.vehicleType || "";
  const addressDetails = {
    address: req.body.address || "",
    city: req.body.city || "",
    state: req.body.state || "",
    pincode: req.body.pincode || "",
  };
  if (!files || files.length === 0) {
    return res.status(400).json({ error: "No files uploaded" });
  }
  const jobId = crypto.randomUUID();
  jobStore.set(jobId, { status: "processing", total: files.length, processed: 0, result: null, error: null, clients: [] });
  res.json({ jobId, total: files.length });
  runJob(jobId, files, vehicleType, addressDetails);
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
async function runJob(jobId, files, vehicleType = "", addressDetails = {}) {
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
      { header: "Address",        key: "address",          width: 24 },
      { header: "City",           key: "city",             width: 14 },
      { header: "State",          key: "state",            width: 16 },
      { header: "Pincode",        key: "pincode",          width: 12 },
      { header: "Country",        key: "country",          width: 12 },
      { header: "VIN Found",      key: "vin_found",        width: 12 },
      { header: "Timeout",        key: "timeout",          width: 12 },
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

    const allResults = await processBatches(files, notify, vehicleType, addressDetails);

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
        aiResult.hyp_hps, aiResult.address || "", aiResult.city || "", aiResult.state || "", aiResult.pincode || "", aiResult.country || "",
        vinValid ? "Yes" : "Failed",
        aiResult.timeout || "",
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

      const vinCell = dataRow.getCell(15);
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
    console.error("runJob error:", error);
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
    // capture address details if provided
    const addressDetails = {
      address: req.body.address || "",
      city: req.body.city || "",
      state: req.body.state || "",
      pincode: req.body.pincode || "",
    };
    console.log('[Upload] Starting job', jobId, 'vehicleType=', vehicleType, 'address=', addressDetails);
    runJob(jobId, files, vehicleType, addressDetails);
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
