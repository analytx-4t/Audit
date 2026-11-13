import express from "express";
import multer from "multer";
import axios from "axios";
import FormData from "form-data";
import { config } from "dotenv";
import cors from "cors";
import morgan from "morgan";
import OpenAI from "openai";
import ExcelJS from "exceljs";
import nodemailer from "nodemailer";
import {
  buildAuditReportPdf,
  calculateAuditMetrics,
  generateAuditReportExplanations,
} from "./reportPdf.js";
import {
  recordTemporaryMailReport,
  startTemporaryMailScheduler,
} from "./temprory mail/scheduler.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendFile, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { Readable } from "stream";
import archiver from "archiver";
import crypto from "crypto";
import sharp from "sharp";
import heicConvert from "heic-convert";
import { createWorker } from "tesseract.js";
import { extractAddressFromImageBuffer } from "./test_fast_address.js";

config();
const app = express();
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://localhost:5174",
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
// Pin the OCR model. "mistral-ocr-latest" is a moving alias (it now resolves to
// OCR 4.1), which silently changed extraction behaviour without a code change.
const OCR_3_MODEL = process.env.MISTRAL_OCR_3_MODEL || "mistral-ocr-2512";
// Vision chat model used as a last-resort reader when OCR text has no valid VIN.
const VISION_MODEL = process.env.MISTRAL_VISION_MODEL || "mistral-medium-latest";
const STICKER_ONLY_INSTRUCTION = "The input is a close-up image of a vehicle identification sticker or manufacturer plate. Ignore unrelated scene content, geotagged metadata, and any non-sticker text. Extract only the requested identification fields.";

let tesseractWorker = null;
createWorker("eng")
  .then(w => {
    tesseractWorker = w;
    console.log("[Tesseract] Global worker initialized successfully");
  })
  .catch(err => {
    console.error("[Tesseract] Global worker initialization failed:", err.message);
  });

function calculateOcrScore(ocrData) {
  if (!ocrData || !ocrData.text) return 0;
  const text = ocrData.text;
  
  // Find all alphanumeric words of length >= 3
  const words = text.split(/[^A-Za-z0-9]+/);
  let score = 0;
  
  for (const word of words) {
    if (word.length >= 3) {
      const hasLetter = /[A-Za-z]/.test(word);
      const hasNumber = /[0-9]/.test(word);
      
      let wordScore = word.length;
      if (hasLetter && hasNumber) {
        wordScore *= 3; // Boost mixed alphanumeric strings (like VIN parts)
      }
      
      score += wordScore;
    }
  }
  
  // Multiply by average confidence
  const conf = ocrData.confidence || 0;
  return score * conf;
}

async function resolve180Ambiguity(buffer, angle1, angle2) {
  if (!tesseractWorker) {
    console.log(`[Tesseract] Worker not initialized, defaulting to angle1: ${angle1}°`);
    return angle1;
  }

  try {
    const evaluateAngle = async (angle) => {
      // 1. Prepare normal image
      const imgNormal = await sharp(buffer)
        .rotate(angle, { background: { r: 255, g: 255, b: 255 } })
        .resize(600, null, { fit: 'inside' })
        .greyscale()
        .normalize()
        .toBuffer();

      const resNormal = await tesseractWorker.recognize(imgNormal);
      const scoreNormal = calculateOcrScore(resNormal.data);
      const confNormal = resNormal.data.confidence || 0;

      // 2. Prepare negated image
      const imgNeg = await sharp(buffer)
        .rotate(angle, { background: { r: 255, g: 255, b: 255 } })
        .resize(600, null, { fit: 'inside' })
        .greyscale()
        .negate()
        .normalize()
        .toBuffer();

      const resNeg = await tesseractWorker.recognize(imgNeg);
      const scoreNeg = calculateOcrScore(resNeg.data);
      const confNeg = resNeg.data.confidence || 0;

      return scoreNormal >= scoreNeg
        ? { score: scoreNormal, confidence: confNormal }
        : { score: scoreNeg, confidence: confNeg };
    };

    const res1 = await evaluateAngle(angle1);
    const res2 = await evaluateAngle(angle2);

    console.log(`[Tesseract Ambiguity] Angle ${angle1}°: Best Score = ${res1.score.toFixed(1)} (conf: ${res1.confidence}%) | Angle ${angle2}°: Best Score = ${res2.score.toFixed(1)} (conf: ${res2.confidence}%)`);

    if (res1.score === 0 && res2.score === 0) {
      if (res1.confidence >= 15 || res2.confidence >= 15) {
        return res1.confidence >= res2.confidence ? angle1 : angle2;
      }
      console.log(`[Tesseract Ambiguity] Neither angle yielded readable text. Defaulting to angle1: ${angle1}°`);
      return angle1;
    }

    return res1.score >= res2.score ? angle1 : angle2;
  } catch (err) {
    console.error(`[Tesseract Ambiguity] Error resolving:`, err.message);
    return angle1;
  }
}


function normalizeVehicleType(vehicleType = "") {
  const normalized = (vehicleType || "").toString().trim().toLowerCase();
  if (normalized.includes("2") || normalized.includes("two")) return "two_wheeler";
  if (normalized.includes("4") || normalized.includes("four")) return "four_wheeler";
  if (normalized.includes("commercial equipment") || normalized.includes("equipment")) return "commercial_equipment";
  if (normalized.includes("commercial vehicle") || normalized.includes("commercial")) return "commercial_vehicle";
  return "general";
}

// Crop height percentage used when preparing an image (rename module) for OCR.
// Mirrors the primary (first) pass the OCR pipeline used to run before cropping moved here.
function getPrimaryCropPercent(vehicleType = "") {
  // Crop the bottom 25% for all vehicle types to permanently discard GPS location watermarks
  return 0.75;
}

async function hasGeoLocationWatermark(buffer) {
  if (!tesseractWorker) {
    console.warn("[hasGeoLocationWatermark] Worker not initialized yet, defaulting to true");
    return true;
  }
  try {
    const metadata = await sharp(buffer).rotate().metadata();
    const w = metadata.width;
    const h = metadata.height;
    if (!w || !h) return true;

    // Sample bottom 35% of the image at full resolution
    const bH = Math.round(h * 0.35);
    const bTop = h - bH;
    const bottomBuffer = await sharp(buffer)
      .rotate()
      .extract({ left: 0, top: bTop, width: w, height: bH })
      .greyscale()
      .normalize()
      .toBuffer();

    const ocrRes = await tesseractWorker.recognize(bottomBuffer);
    const text = (ocrRes?.data?.text || "").toLowerCase();

    const watermarkPatterns = [
      /\bgps\b/,
      /map\s*camera/,
      /\blat\b|\blatitude\b/,
      /\blong\b|\blongitude\b/,
      /\baltitude\b|\belevation\b|\bspeed:\b|\bindex\s*number\b/,
      /gmt\s*\+\s*\d{2}/,
      /\d{1,3}\.\d{3,}\s*[°]?\s*[nsew]?/,
      /\b\d{2}\.\d{4,}\b/,
      /\b(mon|tue|wed|thu|fri|sat|sun)\b/,
      /\((mon|tue|wed|thu|fri|sat|sun)\)/,
      /\b(am|pm)\b|\((am|pm)\)/,
      /\b\d{4}[/-]\d{2}[/-]\d{2}/,
      /\b[a-z0-9]{4,6}\+[a-z0-9]{2,}\b/,
      /\b(punjab|delhi|maharashtra|uttar pradesh|gujarat|haryana|karnataka|tamil nadu|kerala|west bengal|rajasthan|madhya pradesh)\b/,
      /\b\d{6}\b/,
      /\b(india|google|gmap)\b/,
      /\d{1,3}\s*°/,
      /\b202[4-9]\b/,
      /\b\d{1,2}:\d{2}\b/
    ];

    const isWatermarked = watermarkPatterns.some(p => p.test(text));
    console.log(`[Watermark Check] ${isWatermarked ? "Geo location watermark detected -> cropping bottom 25%" : "No geo location watermark detected -> keeping 100% full image"}`);
    return isWatermarked;
  } catch (err) {
    console.error("[hasGeoLocationWatermark] Error:", err.message);
    return true; // Fallback to cropping if error
  }
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

Perform a complete visual inspection of the entire vehicle image before extracting any information.

Do NOT limit your inspection to the manufacturer sticker.

Carefully inspect:

• Manufacturer sticker
• Dashboard VIN plate
• Windshield
• Rear windshield
• Glass corners
• Dashboard area

Extract

• VIN Number
• Engine Number (only if explicitly written)
• Fuel Type

The VIN may appear in one of two formats.

1. Standard manufacturer VIN
• Exactly 17 alphanumeric characters.
• Highest priority.

2. Manufacturer glass identification number
• A standalone sequence of six large individual embossed/plastic digit blocks attached directly to the windshield or rear glass.
• Usually the only large numeric sequence on the glass.
• The digits are physically mounted, not printed on paper.
• They may be black, white, red or another solid color.
• They may appear through dusty glass, glare or reflections.
• They may not have any nearby label such as "VIN".

Examples

378517
378178

Fuel usually appears as

PETROL
DIESEL
CNG
LPG
EV

Normalize

1CNG → CNG

Extraction Priority

1. Extract the 17-character VIN if present.
2. Otherwise extract the six-digit manufacturer glass identification number.
3. Return exactly what is visible.

Rules

• Never reconstruct missing characters.
• Never merge multiple values.
• Never use barcode values.
• Ignore QR codes.
• Ignore Body Number.
• Ignore Chassis Number unless explicitly labeled VIN.
• Ignore Dealer stickers.
• Ignore GPS overlay.
• Ignore timestamps.
• Ignore random serial numbers.

Before answering verify

✓ Manufacturer sticker inspected
✓ Windshield inspected
✓ Rear windshield inspected
✓ Dashboard inspected
✓ Six-digit physical digit blocks searched

Return

{
"vin_number":"",
"engine_number":"",
"fuel_type":""
}`,
      ocr4Prompt: `You are performing an exhaustive OCR inspection.

Search every visible region of the vehicle image before returning an answer.

Inspect

• Manufacturer sticker
• Dashboard VIN plate
• Entire windshield
• Entire rear windshield
• Glass corners
• Dashboard
• Areas partially hidden by reflections or dust

The VIN may be

• A standard 17-character VIN.
• Covered by a barcode.
• Split across lines.
• Printed vertically.
• Partially faded.
• Near glass markings.

OR

A standalone six-digit manufacturer identification number composed of six large individual embossed/plastic digit blocks attached directly to the windshield or rear glass.

Characteristics of the six-digit identification number

• Large digits
• Individual physical blocks
• Mounted directly on glass
• Usually arranged horizontally
• May be black on red, white on black, white on transparent, or similar
• May have no surrounding text
• May appear through glare or dust

Examples

378517
378178

Required

VIN Number
Engine Number (explicit only)
Fuel Type

Extraction Priority

1. Standard 17-character VIN.
2. If absent, return the six-digit manufacturer glass identification number.

Ignore

PIO
SPEC
Body Number
Dealer Sticker
Barcode
QR Code
GPS overlay
Timestamp
Random serial numbers

Rules

• Never infer missing digits.
• Never combine numbers.
• Never guess hidden characters.
• Return exactly what is visible.
• Do not ignore the six-digit glass identification simply because it is not printed on a sticker.

Before returning JSON confirm

✓ Complete windshield inspected
✓ Complete rear windshield inspected
✓ Dashboard inspected
✓ Manufacturer sticker inspected
✓ Six-digit physical digit blocks searched

Return

{
"vin_number":"",
"engine_number":"",
"fuel_type":""
}`,
      llmPrompt: `You are the final visual verification model.

Previous OCR passes were unable to confidently identify the required information.

Your task is to visually inspect the complete vehicle image.

Do NOT rely only on manufacturer stickers.

Inspect every visible area including

• Dashboard
• Dashboard VIN plate
• Manufacturer sticker
• Windshield
• Rear windshield
• Glass corners

Extract

VIN
Engine Number
Fuel Type

VIN Decision Rules

The VIN may be either

1. A standard manufacturer VIN consisting of exactly 17 alphanumeric characters.

OR

2. A standalone six-digit manufacturer identification number composed of six individual embossed/plastic digit blocks physically attached to the windshield or rear glass.

These six digits

• are large and highly visible
• are mounted directly on the glass
• are not printed on paper
• may be photographed through dusty glass
• may have reflections
• may not have a nearby "VIN" label

Examples

378517
378178

Extraction Priority

1. Always return the 17-character VIN if it exists.
2. Otherwise return the six-digit glass identification number.
3. Return exactly what is visible.

Ignore

• Barcode values
• QR codes
• Dealer stickers
• GPS overlays
• Image timestamps
• Body numbers
• Random serial numbers

Never

• Infer hidden characters.
• Reconstruct missing digits.
• Merge multiple numbers.
• Guess uncertain values.

Before returning verify

✓ Entire windshield inspected
✓ Entire rear windshield inspected
✓ Dashboard inspected
✓ Manufacturer sticker inspected
✓ Six-digit physical digit blocks searched

Return only valid JSON.`,
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
      ocr3Prompt: `You are an OCR extraction engine specialized in commercial equipment, tractors, and heavy machinery identification plates.

${STICKER_ONLY_INSTRUCTION}

Locate the manufacturer identification plate, chassis plate, or engine label.

Extract:
• VIN / Chassis Serial Number
• Engine Serial Number
• Fuel Type

Synonyms for VIN / Chassis Serial Number:
- CHASSIS SERIAL NO / CHASSIS SERIAL NO.
- CHASSIS SERIAL / CHASSIS NO / CHASSIS NUMBER
- CLASSIS SERIAL NO
- SERIAL NO / SERIAL NUMBER
- VIN / VIN NUMBER
- PIN / PRODUCT IDENTIFICATION NUMBER
- FRAME NO / FRAME NUMBER

Synonyms for Engine Serial Number:
- ENGINE SERIAL NO / ENGINE SERIAL NO.
- ENGINE SERIAL / ENGINE NO / ENGINE NUMBER
- ENG NO / MOTOR NO

VIN / Chassis Serial Rules:
- A chassis serial number / VIN is an uppercase alphanumeric identifier (typically 10 to 17 characters long, e.g. 1VY5210EASB045343, 1PY5310ECTC072100, 5310EASA028920).
- Read every visible character carefully.
- Extract exact sequence without extra spaces or symbols.
- If unreadable, return empty string.

Engine Number Rules:
- Extract ONLY when explicitly labelled with any engine serial / engine number synonyms (e.g. PY3029T368274, PY3029U129877).

Fuel Type Rules:
- Commercial equipment typically uses DIESEL. Normalize to PETROL, DIESEL, CNG, LPG, ELECTRIC, EV.

Return ONLY JSON:
{
  "vin_number":"",
  "engine_number":"",
  "fuel_type":""
}`,
      ocr4Prompt: `You are performing an exhaustive OCR inspection on a commercial equipment / tractor identification plate.

Search order:
1. Manufacturer identification plate
2. Chassis serial stamping / label (CHASSIS SERIAL NO, CHASSIS NO, VIN)
3. Engine serial label (ENGINE SERIAL NO, ENGINE NO)

Extract:
- VIN / Chassis Serial Number
- Engine Serial Number
- Fuel Type

Return ONLY JSON:
{
  "vin_number":"",
  "engine_number":"",
  "fuel_type":""
}`,
      llmPrompt: `You are visually verifying a commercial equipment / tractor manufacturer plate.

Locate:
- VIN / Chassis Serial Number (CHASSIS SERIAL NO / VIN)
- Engine Serial Number (ENGINE SERIAL NO / ENGINE NO)
- Fuel Type

Return JSON only.`,
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
  const normType = normalizeVehicleType(vehicleType);

  const chassisMatch = content.match(/(?:chassis\s*(?:serial\s*)?(?:no\.?|number)?|classis\s*serial\s*no\.?|vin|frame\s*no\.?)\s*[:#-]?\s*([A-Za-z0-9]{10,17})/i);
  if (chassisMatch && chassisMatch[1]) {
    result.vin = chassisMatch[1].toUpperCase();
  } else {
    const vinRegex = (normType === "commercial_equipment" || normType === "commercial_vehicle")
      ? /\b[A-Za-z0-9]{10,17}\b/g
      : /\b[A-Za-z0-9]{17}\b/g;
    const vinMatches = content.match(vinRegex) || [];
    if (vinMatches.length > 0) {
      result.vin = vinMatches[0].toUpperCase();
    }
  }

  const hmilMatch = content.match(/\b[A-Za-z0-9]{17}\b/g) || [];
  if (hmilMatch.length > 1) {
    result.hmil = hmilMatch[1]?.toUpperCase() || "";
  }

  const engineMatch = content.match(/(?:engine\b|eng\b)(?!\s*eers|\s*eering)\s*(?:serial\s*)?(?:number|no\.?|no)?\s*[:#-]?\s*([A-Za-z0-9\-\/]{2,30})/i);
  if (engineMatch && engineMatch[1]) {
    const rawEng = engineMatch[1].trim();
    if (!/(?:enclave|engineer|road|street|colony|nagar|india|uttarakhand|delhi|flat|house)/i.test(rawEng)) {
      result.engine_number = rawEng.replace(/\s+/g, " ");
    }
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

function isExtractionSuccessful(result = {}, vehicleType = "") {
  return isPlausibleVin(result.vin, vehicleType);
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

  const vinMatch = candidate.match(/\b[A-Za-z0-9]{10,17}\b/);
  if (vinMatch) result.vin = vinMatch[0].toUpperCase();

  const engineMatch = candidate.match(/(?:engine|eng)\s*(?:serial\s*)?(?:number|no\.?|no)?\s*[:#-]?\s*([A-Za-z0-9\-\/\s]{2,30})/i);
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

function postProcessVin(vin, vehicleType = "") {
  if (!vin) return "";
  let v = vin.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const normType = normalizeVehicleType(vehicleType);

  if (normType === "commercial_equipment" || normType === "commercial_vehicle") {
    if (v.length >= 10 && v.length < 17) return v;
    // 17-character commercial VINs still follow ISO 3779 (no I/O/Q).
    if (v.length === 17) return v.replace(/[IOQ]/g, (ch) => ({ I: "1", O: "0", Q: "0" })[ch]);
  }

  // Stamped chassis numbers are often framed by marker symbols (Honda prints
  // "◻ME4KC407KSG178774◻"), which readers turn into an extra leading/trailing
  // character ("MME4…", "…178774D"). Drop it when that yields a valid VIN.
  if (v.length === 18 || v.length === 19) {
    // Keep a real leading "M" (Indian WMI) unless the read starts with a doubled "MM".
    const keepHead = v[0] === "M" && v[1] !== "M";
    const trims = v.length === 18
      ? (keepHead ? [v.slice(0, 17), v.slice(1)] : [v.slice(1), v.slice(0, 17)])
      : (keepHead ? [v.slice(0, 17), v.slice(1, 18)] : [v.slice(1, 18), v.slice(2), v.slice(0, 17)]);
    const fixed = trims.map((t) => postProcessVin(t, vehicleType)).find((t) => isPlausibleVin(t, vehicleType));
    if (fixed) return fixed;
  }

  if (v.length !== 17) return v.length >= 10 ? v : "";

  // Only apply corrections that are guaranteed by the VIN standard (ISO 3779),
  // never per-model guesses: the old hardcoded prefix/whole-VIN rewrites mapped
  // different vehicles onto the same fixed VIN.
  const c = v.split("");

  // I, O and Q are never used in a VIN.
  const illegal = { I: "1", O: "0", Q: "0" };
  for (let i = 0; i < 17; i++) {
    if (illegal[c[i]]) c[i] = illegal[c[i]];
  }

  // Positions 14-17 (serial tail) are numeric for passenger cars and two-wheelers.
  const toDigit = { S: "5", B: "8", D: "0", L: "1", Z: "2", G: "6", T: "7" };
  for (let i = 13; i < 17; i++) {
    if (toDigit[c[i]]) c[i] = toDigit[c[i]];
  }

  // Indian WMIs are "M" + a letter (MA1, MAT, MBL, MD6, ME4, MZB ...): the
  // second character is never a digit (e.g. TVS "M0626..." is "MD626...").
  const toLetter = { 0: "D", 8: "B", 5: "S", 2: "Z", 6: "G" };
  if (c[0] === "M" && toLetter[c[1]]) c[1] = toLetter[c[1]];

  // Position 10 is the model-year code; "5" is a common misread of "S" (2025).
  if (c[9] === "5") c[9] = "S";

  return c.join("");
}

function isPlausibleVin(vin = "", vehicleType = "") {
  const v = String(vin).trim().toUpperCase();
  const normType = normalizeVehicleType(vehicleType);
  if (normType === "commercial_equipment" || normType === "commercial_vehicle") {
    return /^[A-Z0-9]{10,17}$/.test(v) && /\d/.test(v);
  }
  // 17 chars, no I/O/Q, has both letters and digits, serial tail numeric.
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(v) && /[A-Z]/.test(v) && /^\d{4}$/.test(v.slice(13));
}

async function extractVehicleDetailsWithAI(text, vehicleType = "") {
  const promptBundle = getVehiclePromptBundle(vehicleType);
  const vehicleContext = vehicleType ? `\nVehicle type context: ${promptBundle.label}. Use this context to interpret the document and extract the correct VIN-related details.\n` : "";

  try {
    const response = await withRetry("DeepSeek", () => openai.chat.completions.create({
      model: "deepseek-chat",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `
You are a highly precise OCR extraction engine for Indian vehicle documents, commercial equipment, tractors, and chassis/engine images.${vehicleContext}
Locate the VIN / Chassis number / Chassis Serial Number, engine number / engine serial number, and fuel type from the OCR text.

SYNONYMS & LABELS:
- VIN / Chassis Number / Chassis No / Chassis Serial No / Chassis Serial / Classis Serial No / CNo / Frame No / Frame Number / FNo / F / PIN / Product Identification Number / Serial No are all synonyms for VIN.
- Engine Number / Engine No / Engine Serial No / Engine Serial / Eng No / ENo / E / Motor No are all synonyms for Engine Number.

STRICT RULES FOR VIN (CHASSIS NUMBER):
- For passenger/two-wheelers, a valid Indian VIN is 17 characters long. For commercial equipment/tractors/commercial vehicles, a chassis serial / VIN is typically 10 to 17 characters long (e.g., 1VY5210EASB045343, 1PY5310ECTC072100, 5310EASA028920).
- Indian VINs normally start with "M" (e.g. MA3, MA1, MAL, MAT, MBL, ME3, ME4, MD2, MD6, MZB, MAK, MBH).
- A VIN never contains the letters I, O or Q; if the OCR shows them inside a VIN they are the digits 1, 0, 0.
- OCR often inserts spaces, line breaks, hyphens, "*" or "#" markers inside a VIN, or splits it across two lines. Join the pieces into one sequence and drop the markers. Do NOT drop or add real characters.
- HYUNDAI stickers print the VIN in TWO parts: the first 11 characters after "VIN:" (e.g. "MALB141CLTM") and the last 6 digits in large print on the next line next to the fuel type (e.g. "PETROL 454752"). Join them: "MALB141CLTM454752". The same split can occur on other brands' stickers; if a VIN label is followed by 11 characters and a separate 6-digit number on the next line, join them.
- Prefer the value printed next to a VIN / Chassis / Frame label. If the same VIN appears more than once (label text and sticker print), use the most complete consistent reading.
- These are NOT the VIN: Body No, barcode digits, Model/Spec/PIO codes, colour codes, part numbers, dealer stickers, GPS/map-camera overlay text (address, pincode, Lat/Long, date, time, "GMT").
- Copy characters exactly as read. Never invent/hallucinate characters. If no valid sequence is visible in the OCR text, leave "vin" as "".

STRICT RULES FOR ENGINE NUMBER:
- Extract only if explicitly labelled (e.g., Engine No, ENGINE SERIAL NO, ENGINE SERIAL, ENG NO, E:, etc.). Otherwise leave as "".

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
    }));

    const parsed = JSON.parse(response.choices[0].message.content || "{}");
    const result = {
      vin: postProcessVin(parsed.vin, vehicleType),
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

    if (!isExtractionSuccessful(result, vehicleType)) {
      const regexResult = extractVehicleDetailsFromText(text, vehicleType);
      return {
        ...regexResult,
        ...result,
        vin: postProcessVin(result.vin || regexResult.vin, vehicleType),
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
      vin: postProcessVin(regexResult.vin, vehicleType),
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
    // A single large phone photo must not reject the whole upload.
    fileSize: Number(process.env.MAX_UPLOAD_MB || 30) * 1024 * 1024,
    files: 1000,
  },
});

const jobStore = new Map();
const reportsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "reports",
);
const previewReportFileName = "Latest_Stockyard_Audit_Management_Report.pdf";
let previewSaveQueue = Promise.resolve();

function saveLatestReportPreview(reportBuffer, jobId) {
  const saveOperation = previewSaveQueue.then(async () => {
    await mkdir(reportsDirectory, { recursive: true });
    const temporaryPath = path.join(reportsDirectory, `.${previewReportFileName}.${jobId}.tmp`);
    const previewPath = path.join(reportsDirectory, previewReportFileName);
    try {
      await writeFile(temporaryPath, reportBuffer, { flag: "wx" });
      await rename(temporaryPath, previewPath);

      const entries = await readdir(reportsDirectory, { withFileTypes: true });
      const previousReports = entries.filter((entry) =>
        entry.isFile()
        && entry.name !== previewReportFileName
        && /^Stockyard_Audit_Management_Report_.*\.pdf$/i.test(entry.name),
      );
      await Promise.all(previousReports.map((entry) =>
        rm(path.join(reportsDirectory, entry.name)),
      ));
      return path.join("reports", previewReportFileName);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  });
  previewSaveQueue = saveOperation.catch(() => {});
  return saveOperation;
}

// ─── REPORT EMAIL ─────────────────────────────────────────
// Reliability rules (emails were "sometimes" missing in production):
//  * transient SMTP errors are retried with backoff;
//  * anything still undelivered is written to reports/outbox and retried
//    every MAIL_RETRY_INTERVAL_MIN minutes and on every server start, so a
//    restart or a mail-server outage no longer loses the report;
//  * every attempt is appended to reports/mail-log.jsonl for diagnosis;
//  * dates use REPORT_TIMEZONE (IST by default), not the droplet's UTC clock.
const REPORT_TIMEZONE = process.env.REPORT_TIMEZONE || "Asia/Kolkata";
const REPORT_EMAIL_MODE = (process.env.REPORT_EMAIL_MODE || "both").toLowerCase(); // immediate | daily | both
const outboxDirectory = path.join(reportsDirectory, "outbox");
const mailLogPath = path.join(reportsDirectory, "mail-log.jsonl");
const MAIL_RETRY_INTERVAL_MS = Number(process.env.MAIL_RETRY_INTERVAL_MIN || 10) * 60 * 1000;
const MAIL_MAX_OUTBOX_ATTEMPTS = Number(process.env.MAIL_MAX_OUTBOX_ATTEMPTS || 144); // ~24h at 10 min

function reportDateString(date = new Date()) {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone: REPORT_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function reportDateTimeString(date = new Date()) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: REPORT_TIMEZONE, dateStyle: "medium", timeStyle: "short" }).format(date);
}

function getMailConfig() {
  const missing = ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "MAIL_FROM"].filter((key) => !process.env[key]?.trim());
  const recipients = (process.env.KPI_EMAIL_RECIPIENTS || "").split(",").map((r) => r.trim()).filter(Boolean);
  if (recipients.length === 0) missing.push("KPI_EMAIL_RECIPIENTS");
  const port = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 465;
  const portValid = Number.isInteger(port) && port >= 1 && port <= 65535;
  return { missing, recipients, port, portValid };
}

function createMailTransport(port) {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 60_000,
  });
}

async function appendMailLog(entry) {
  try {
    await mkdir(reportsDirectory, { recursive: true });
    await appendFile(mailLogPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch (error) {
    console.error("[Report email] Could not write mail log:", error.message);
  }
}

function isTransientMailError(error) {
  const code = error?.responseCode;
  if (code && code >= 500) return false; // 5xx = permanent (bad auth, rejected recipient)
  return true; // network errors, timeouts, 4xx (try again later)
}

// Sends one message with retries. Returns { status: "accepted" | "failed", message }.
async function deliverMail(mail, label) {
  const { recipients, port } = getMailConfig();
  const delays = (process.env.MAIL_RETRY_DELAYS_MS || "5000,20000,60000").split(",").map(Number);
  let lastError;
  for (let attempt = 1; attempt <= delays.length + 1; attempt++) {
    try {
      const info = await createMailTransport(port).sendMail({ from: process.env.MAIL_FROM, to: recipients, ...mail });
      const accepted = (Array.isArray(info.accepted) ? info.accepted : [])
        .map((r) => String(typeof r === "string" ? r : r.address).toLowerCase());
      const missingRecipients = recipients.filter((r) => !accepted.includes(r.toLowerCase()));
      const response = String(info.response || "").replace(/\s+/g, " ").trim();
      await appendMailLog({ label, attempt, status: missingRecipients.length ? "partial" : "accepted", messageId: info.messageId, accepted, rejected: missingRecipients, response });
      console.info(`[Report email] ${label}: accepted ${accepted.length}/${recipients.length} on attempt ${attempt} (${info.messageId})`);
      if (missingRecipients.length) {
        return { status: "failed", message: `The mail server rejected: ${missingRecipients.join(", ")}.` };
      }
      return { status: "accepted", message: `Report emailed to ${recipients.length} recipient(s) at ${reportDateTimeString()} (Message-ID: ${info.messageId || "unavailable"}). Check spam/junk if it is missing.` };
    } catch (error) {
      lastError = error;
      await appendMailLog({ label, attempt, status: "error", code: error.code, responseCode: error.responseCode, error: error.message });
      console.error(`[Report email] ${label}: attempt ${attempt} failed: ${error.code || ""} ${error.responseCode || ""} ${error.message}`);
      if (!isTransientMailError(error) || attempt > delays.length) break;
      await sleep(delays[attempt - 1]);
    }
  }
  return { status: "failed", message: `Email failed: ${lastError?.code || ""} ${lastError?.message || "unknown error"}`.trim(), error: lastError };
}

async function queueInOutbox(jobId, mail, attachmentBuffer, attachmentName) {
  await mkdir(outboxDirectory, { recursive: true });
  const base = `${Date.now()}_${jobId.slice(0, 8)}`;
  if (attachmentBuffer) await writeFile(path.join(outboxDirectory, `${base}.pdf`), attachmentBuffer);
  await writeFile(path.join(outboxDirectory, `${base}.json`), JSON.stringify({
    jobId, subject: mail.subject, text: mail.text, attachmentName, attachmentFile: attachmentBuffer ? `${base}.pdf` : "", attempts: 0, createdAt: new Date().toISOString(),
  }, null, 2));
  return base;
}

let outboxRunning = false;
async function processMailOutbox() {
  if (outboxRunning) return;
  outboxRunning = true;
  try {
    const { missing, portValid } = getMailConfig();
    if (missing.length || !portValid) return;
    let entries = [];
    try { entries = (await readdir(outboxDirectory)).filter((name) => name.endsWith(".json")).sort(); } catch { return; }
    for (const name of entries) {
      const metaPath = path.join(outboxDirectory, name);
      const meta = JSON.parse(await readFile(metaPath, "utf8"));
      if (meta.attempts >= MAIL_MAX_OUTBOX_ATTEMPTS) continue;
      const attachments = meta.attachmentFile
        ? [{ filename: meta.attachmentName, content: await readFile(path.join(outboxDirectory, meta.attachmentFile)), contentType: "application/pdf" }]
        : [];
      const result = await deliverMail({ subject: meta.subject, text: meta.text, attachments }, `outbox ${meta.jobId}`);
      if (result.status === "accepted") {
        await unlink(metaPath).catch(() => { });
        if (meta.attachmentFile) await unlink(path.join(outboxDirectory, meta.attachmentFile)).catch(() => { });
        console.info(`[Report email] Delivered queued report for job ${meta.jobId} (queued ${meta.createdAt}).`);
      } else {
        meta.attempts += 1;
        meta.lastError = result.message;
        await writeFile(metaPath, JSON.stringify(meta, null, 2));
      }
    }
  } catch (error) {
    console.error("[Report email] Outbox processing failed:", error.message);
  } finally {
    outboxRunning = false;
  }
}

async function sendReportEmail(reportBuffer, totalFiles, jobId, summary = "") {
  const { missing, portValid } = getMailConfig();
  if (missing.length > 0) {
    console.warn(`[Report email] Skipping job ${jobId}; missing settings: ${missing.join(", ")}`);
    await appendMailLog({ label: `job ${jobId}`, status: "skipped", missing });
    return { status: "skipped", message: "Report was created, but email is not configured." };
  }
  if (!portValid) {
    console.error(`[Report email] Invalid SMTP_PORT for job ${jobId}`);
    return { status: "failed", message: "Report was created, but email settings are invalid (SMTP_PORT)." };
  }

  const reportDate = reportDateString();
  const attachmentName = `Stockyard_Audit_Management_Report_${reportDate}.pdf`;
  const mail = {
    subject: `Stockyard audit report - ${reportDate}`,
    text: [
      `The stockyard audit report for ${totalFiles} uploaded image(s) is attached as a PDF.`,
      summary,
      `Generated: ${reportDateTimeString()} (${REPORT_TIMEZONE}).`,
    ].filter(Boolean).join("\n\n"),
    attachments: reportBuffer
      ? [{ filename: attachmentName, content: reportBuffer, contentType: "application/pdf" }]
      : [],
  };

  const result = await deliverMail(mail, `job ${jobId}`);
  if (result.status === "accepted") return result;

  // Permanent failures (e.g. 535 bad password) will not fix themselves, but
  // still queue so the report goes out once the setting is corrected.
  try {
    await queueInOutbox(jobId, mail, reportBuffer, attachmentName);
    return { status: "queued", message: `${result.message}. The report is queued and will be re-sent automatically every ${Math.round(MAIL_RETRY_INTERVAL_MS / 60000)} min.` };
  } catch (error) {
    console.error(`[Report email] Could not queue job ${jobId}:`, error.message);
    return result;
  }
}

// Startup: check SMTP reachability (DigitalOcean blocks SMTP ports on some
// droplets) and flush anything left in the outbox from before a restart.
if (process.env.NO_LISTEN !== "1") {
  setTimeout(async () => {
    const { missing, port, portValid } = getMailConfig();
    if (missing.length || !portValid) {
      console.warn(`[Report email] Email disabled: missing/invalid settings ${missing.join(", ")}`);
      return;
    }
    try {
      await createMailTransport(port).verify();
      console.info(`[Report email] SMTP ${process.env.SMTP_HOST}:${port} reachable and login OK.`);
    } catch (error) {
      console.error(`[Report email] SMTP check FAILED for ${process.env.SMTP_HOST}:${port}: ${error.code || ""} ${error.message}. ` +
        "If this server is on DigitalOcean, outbound SMTP ports may be blocked; open a support ticket or use an HTTP email API.");
    }
    await processMailOutbox();
  }, 5_000);
  setInterval(processMailOutbox, MAIL_RETRY_INTERVAL_MS).unref();
}

app.get("/", (req, res) => {
  return res.json({ message: " Server started at 5000" });
});

// ─── RENAME MODULE: OCR-safe image normalization ─────
// Only lossless-in-meaning steps are applied: EXIF orientation is baked in and
// oversized photos are downscaled. The previous crop/deskew/greyscale pipeline
// (cropVehicleWithPercent) is no longer used here: its watermark detector fired
// on almost every photo (any 6-digit number, "am"/"pm", a year) and cut the
// bottom 25%, and its rotation guess frequently turned stickers sideways or
// upside down, which made the OCR swap or drop characters.
// ─── HEIC/HEIF (iPhone) support ───────────────────────────
// sharp's prebuilt libvips only decodes AVIF from the HEIF family, so iPhone
// HEIC photos are converted to JPEG with heic-convert first.
function isHeicLike(buffer, name = "", mimetype = "") {
  if (/\.(heic|heif)$/i.test(name) || /hei[cf]/i.test(mimetype)) return true;
  if (!buffer || buffer.length < 12) return false;
  if (buffer.toString("ascii", 4, 8) !== "ftyp") return false;
  const brand = buffer.toString("ascii", 8, 12).toLowerCase();
  return ["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].includes(brand);
}

// Returns a buffer sharp can decode: the original, or a JPEG converted from HEIC.
// Throws if the image cannot be decoded either way.
async function toDecodableImage(buffer, name = "", mimetype = "") {
  try {
    await sharp(buffer).metadata();
    await sharp(buffer).resize(8).toBuffer(); // metadata alone can succeed on undecodable HEVC
    return { buffer, converted: false };
  } catch (sharpError) {
    if (!isHeicLike(buffer, name, mimetype)) throw sharpError;
    const jpeg = Buffer.from(await heicConvert({ buffer, format: "JPEG", quality: 0.92 }));
    return { buffer: jpeg, converted: true };
  }
}

async function prepareImageForOcr(buffer, name = "", mimetype = "") {
  try {
    const decodable = (await toDecodableImage(buffer, name, mimetype)).buffer;
    return await sharp(decodable)
      .rotate() // apply EXIF orientation only
      .resize({ width: 3000, height: 3000, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 92 })
      .toBuffer();
  } catch (err) {
    console.error("[prepareImageForOcr] Falling back to original buffer:", err.message);
    return null;
  }
}

app.post("/api/process-image", upload.single("image"), async (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: "No image uploaded" });
  }
  // Browsers often report HEIC photos with an empty type, so also accept by extension.
  const looksLikeImage = file.mimetype?.startsWith("image/")
    || /\.(jpe?g|png|webp|tiff?|bmp|gif|heic|heif|avif)$/i.test(file.originalname || "")
    || isHeicLike(file.buffer);
  if (!looksLikeImage) {
    return res.status(400).json({ error: "File is not an image" });
  }

  try {
    const processedBuffer = await prepareImageForOcr(file.buffer, file.originalname, file.mimetype);
    if (!processedBuffer) {
      // Could not decode: hand the original back unchanged (not marked processed).
      res.setHeader("Content-Type", file.mimetype || "application/octet-stream");
      res.setHeader("X-Image-Processed", "false");
      return res.send(file.buffer);
    }

    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("X-Image-Processed", "true");
    res.send(processedBuffer);
  } catch (err) {
    console.error("[process-image] Failed to process image:", err.message);
    res.status(500).json({ error: "Failed to process image" });
  }
});

// ─── ADDRESS EXTRACTION MODULE ─────────────────────────────

app.post("/api/extract-address", upload.array("images", 100), async (req, res) => {
  try {
    const files = req.files;
    if (!files || files.length === 0) {
      return res.status(400).json({ error: "No images provided" });
    }

    const results = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const parsed = await extractAddressFromImageBuffer(file.buffer, tesseractWorker);
      results.push({
        id: `img_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`,
        filename: file.originalname,
        fullAddress: parsed.fullAddress || "",
        city: parsed.city || "",
        state: parsed.state || "",
        pincode: parsed.pincode || "",
        latitude: parsed.latitude || "",
        longitude: parsed.longitude || "",
        dateTime: parsed.dateTime || "",
        vehicleText: parsed.vehicleText || "",
        rawText: parsed.rawText || ""
      });
    }

    return res.json({ success: true, count: results.length, results });
  } catch (err) {
    console.error("[extract-address] Error:", err);
    return res.status(500).json({ error: "Address extraction failed", details: err.message });
  }
});

app.post("/api/export-address-excel", upload.array("failedImages", 100), async (req, res) => {
  try {
    const itemsRaw = req.body.items;
    let items = [];
    if (typeof itemsRaw === "string") {
      try {
        items = JSON.parse(itemsRaw);
      } catch (e) {}
    } else if (Array.isArray(itemsRaw)) {
      items = itemsRaw;
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "No items provided to export" });
    }

    const failedFiles = req.files || [];

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Extracted Addresses");

    const headerFill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF0F766E" },
    };
    const headerFont = {
      name: "Arial",
      size: 11,
      bold: true,
      color: { argb: "FFFFFFFF" },
    };
    const borderStyle = {
      top: { style: "thin", color: { argb: "FFE2E8F0" } },
      left: { style: "thin", color: { argb: "FFE2E8F0" } },
      bottom: { style: "thin", color: { argb: "FFE2E8F0" } },
      right: { style: "thin", color: { argb: "FFE2E8F0" } },
    };

    sheet.columns = [
      { header: "S.No", key: "sno", width: 8 },
      { header: "Image File Name", key: "filename", width: 30 },
      { header: "Status", key: "status", width: 14 },
      { header: "Text Inside Image / Vehicle Info", key: "vehicleText", width: 40 },
      { header: "Full Address", key: "fullAddress", width: 60 },
      { header: "City / District", key: "city", width: 20 },
      { header: "State", key: "state", width: 20 },
      { header: "Pincode", key: "pincode", width: 15 },
      { header: "Latitude", key: "latitude", width: 16 },
      { header: "Longitude", key: "longitude", width: 16 },
      { header: "Date / Timestamp", key: "dateTime", width: 25 },
    ];

    const headerRow = sheet.getRow(1);
    headerRow.height = 28;
    headerRow.eachCell((cell) => {
      cell.fill = headerFill;
      cell.font = headerFont;
      cell.alignment = { vertical: "middle", horizontal: "center" };
    });

    items.forEach((item, index) => {
      const isFailed = !item.fullAddress || item.fullAddress.trim() === "" || item.fullAddress === "NO ADDRESS DETECTED" || item.status === "FAILED";
      const row = sheet.addRow({
        sno: index + 1,
        filename: item.filename || "",
        status: isFailed ? "FAILED" : "SUCCESS",
        vehicleText: item.vehicleText || "",
        fullAddress: item.fullAddress || "",
        city: item.city || "",
        state: item.state || "",
        pincode: item.pincode || "",
        latitude: item.latitude || "",
        longitude: item.longitude || "",
        dateTime: item.dateTime || "",
      });

      row.height = 24;
      row.eachCell((cell, colNumber) => {
        cell.border = borderStyle;
        cell.alignment = {
          vertical: "middle",
          horizontal: colNumber === 1 || colNumber === 3 || colNumber === 8 ? "center" : "left",
          wrapText: true,
        };
        if (colNumber === 3) {
          cell.font = isFailed ? { color: { argb: "FFDC2626" }, bold: true } : { color: { argb: "FF16A34A" }, bold: true };
        }
      });
    });

    const excelBuffer = await workbook.xlsx.writeBuffer();

    // If no failed images provided, return excel directly
    if (failedFiles.length === 0) {
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader(
        "Content-Disposition",
        "attachment; filename=Extracted_Image_Addresses.xlsx"
      );
      return res.send(excelBuffer);
    }

    // When there ARE failed images, package Excel + failed_images/ folder into ZIP archive
    const archive = archiver("zip", { zlib: { level: 9 } });

    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=Extracted_Addresses_Package.zip"
    );

    archive.pipe(res);

    // Append Excel file at root
    archive.append(excelBuffer, { name: "Extracted_Addresses.xlsx" });

    // Append failed images inside folder `failed_images/`
    failedFiles.forEach((file) => {
      archive.append(file.buffer, { name: `failed_images/${file.originalname}` });
    });

    await archive.finalize();
  } catch (err) {
    console.error("[export-address-excel] Error:", err);
    res.status(500).json({ error: "Failed to export excel package" });
  }
});




// ─── CONFIG ───────────────────────────────────────────────
// Mistral Batch API settings. OCR work is submitted as one asynchronous job,
// rather than issuing one real-time /v1/ocr call per image.
const MISTRAL_BATCH_POLL_INTERVAL_MS = Number(process.env.MISTRAL_BATCH_POLL_INTERVAL_MS || 2000);
const MISTRAL_BATCH_TIMEOUT_MS = Number(process.env.MISTRAL_BATCH_TIMEOUT_MS || 30 * 60 * 1000);

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

const mistralHeaders = {
  Authorization: `Bearer ${MISTRAL_API_KEY}`,
  "Content-Type": "application/json",
};

async function createMistralOcrBatch(requests) {
  const response = await axios.post(
    "https://api.mistral.ai/v1/batch/jobs",
    {
      endpoint: "/v1/ocr",
      model: OCR_3_MODEL,
      requests,
      metadata: { source: "audit2", type: "vehicle_ocr" },
    },
    { headers: mistralHeaders }
  );

  return response.data;
}

async function waitForMistralBatch(batchJobId) {
  const deadline = Date.now() + MISTRAL_BATCH_TIMEOUT_MS;

  while (Date.now() < deadline) {
    // `inline=true` returns inline results when supported and avoids a
    // separate output-file download for small interactive uploads.
    const response = await withRetry("Mistral batch poll", () => axios.get(
      `https://api.mistral.ai/v1/batch/jobs/${batchJobId}`,
      { headers: mistralHeaders, params: { inline: true } }
    ));
    const batchJob = response.data;

    console.log(
      `[Mistral batch] ${batchJob.id}: ${batchJob.status} ` +
      `(${batchJob.completed_requests || 0}/${batchJob.total_requests || 0})`
    );

    if (batchJob.status === "SUCCESS") return batchJob;
    if (!["QUEUED", "RUNNING"].includes(batchJob.status)) {
      const detail = batchJob.errors?.map((error) => error.message).filter(Boolean).join("; ");
      throw new Error(`Mistral batch ${batchJob.status}${detail ? `: ${detail}` : ""}`);
    }

    await sleep(MISTRAL_BATCH_POLL_INTERVAL_MS);
  }

  throw new Error(`Mistral batch ${batchJobId} timed out after ${MISTRAL_BATCH_TIMEOUT_MS}ms`);
}

async function getMistralBatchOutputs(batchJob) {
  if (Array.isArray(batchJob.outputs)) return batchJob.outputs;
  if (!batchJob.output_file) throw new Error("Mistral batch completed without an output file");

  const response = await axios.get(
    `https://api.mistral.ai/v1/files/${batchJob.output_file}/content`,
    { headers: { Authorization: `Bearer ${MISTRAL_API_KEY}` }, responseType: "text" }
  );

  return String(response.data)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function getOcrTextFromBatchOutput(output) {
  if (output?.error) return "";
  const body = output?.response?.body || output?.body || output?.response || output;
  const pages = body?.pages || body?.data?.pages || [];
  return pages.map((page) => page?.markdown || "").filter(Boolean).join("\n");
}

async function detectSkew(normalizedBuffer, vehicleType = "") {
  try {
    const normalizedType = normalizeVehicleType(vehicleType);
    const canBeVertical = (normalizedType === "two_wheeler" || normalizedType === "general");
    const metadata = await sharp(normalizedBuffer).metadata();
    const width = metadata.width;
    const height = metadata.height;

    // Crop top 75% and remove 15% border on left/right and 5% on top/bottom for clean sampling
    const workingHeight = Math.round(height * 0.75);
    const borderX = Math.round(width * 0.15);
    const borderY = Math.round(workingHeight * 0.05);
    const cropW = width - (borderX * 2);
    const cropH = workingHeight - (borderY * 2);

    if (cropW <= 0 || cropH <= 0) return 0;

    // Force crop order by converting to buffer first
    const croppedBuffer = await sharp(normalizedBuffer)
      .extract({ left: borderX, top: borderY, width: cropW, height: cropH })
      .toBuffer();

    // Clean buffer (top 75% height, full width) for Tesseract OCR to avoid cropping VIN text
    const cleanOcrBuffer = await sharp(normalizedBuffer)
      .extract({ left: 0, top: 0, width: width, height: workingHeight })
      .toBuffer();

    const sourceW = 500;
    const sourceH = 400;

    // 1. Horizontal source
    const sourceImage = await sharp(croppedBuffer)
      .greyscale()
      .resize(sourceW, sourceH, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const srcData = sourceImage.data;

    // 2. Vertical source (rotate 90 first, then resize)
    const sourceImageRot = await sharp(croppedBuffer)
      .greyscale()
      .rotate(90)
      .resize(sourceW, sourceH, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const srcDataRot = sourceImageRot.data;

    // Target dimensions for safe rotated region
    const targetW = 300;
    const targetH = 200;
    const centerX = sourceW / 2;
    const centerY = sourceH / 2;
    const targetCenterX = targetW / 2;
    const targetCenterY = targetH / 2;

    let bestHorizAngle = 0;
    let maxHorizVariance = -1;

    for (let angle = -30; angle <= 30; angle += 1) {
      const rad = -angle * Math.PI / 180;
      const cosVal = Math.cos(rad);
      const sinVal = Math.sin(rad);

      const targetData = new Uint8Array(targetW * targetH);

      for (let y = 0; y < targetH; y++) {
        const dy = y - targetCenterY;
        for (let x = 0; x < targetW; x++) {
          const dx = x - targetCenterX;
          
          const srcX = Math.round(cosVal * dx - sinVal * dy + centerX);
          const srcY = Math.round(sinVal * dx + cosVal * dy + centerY);

          const clampedX = Math.min(Math.max(srcX, 0), sourceW - 1);
          const clampedY = Math.min(Math.max(srcY, 0), sourceH - 1);

          targetData[y * targetW + x] = srcData[clampedY * sourceW + clampedX];
        }
      }

      // Calculate vertical gradients of target
      const rowGrads = new Array(targetH).fill(0);
      for (let y = 1; y < targetH; y++) {
        let sum = 0;
        for (let x = 0; x < targetW; x++) {
          const diff = Math.abs(targetData[y * targetW + x] - targetData[(y - 1) * targetW + x]);
          sum += diff > 20 ? diff : 0;
        }
        rowGrads[y] = sum;
      }

      const mean = rowGrads.reduce((a, b) => a + b, 0) / targetH;
      const variance = rowGrads.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / targetH;

      if (variance > maxHorizVariance) {
        maxHorizVariance = variance;
        bestHorizAngle = angle;
      }
    }

    let bestVertAngle = 0;
    let maxVertVariance = -1;

    if (canBeVertical) {
      for (let angle = -30; angle <= 30; angle += 1) {
        const rad = -angle * Math.PI / 180;
        const cosVal = Math.cos(rad);
        const sinVal = Math.sin(rad);

        const targetData = new Uint8Array(targetW * targetH);

        for (let y = 0; y < targetH; y++) {
          const dy = y - targetCenterY;
          for (let x = 0; x < targetW; x++) {
            const dx = x - targetCenterX;
            
            const srcX = Math.round(cosVal * dx - sinVal * dy + centerX);
            const srcY = Math.round(sinVal * dx + cosVal * dy + centerY);

            const clampedX = Math.min(Math.max(srcX, 0), sourceW - 1);
            const clampedY = Math.min(Math.max(srcY, 0), sourceH - 1);

            targetData[y * targetW + x] = srcDataRot[clampedY * sourceW + clampedX];
          }
        }

        // Calculate vertical gradients of target
        const rowGrads = new Array(targetH).fill(0);
        for (let y = 1; y < targetH; y++) {
          let sum = 0;
          for (let x = 0; x < targetW; x++) {
            const diff = Math.abs(targetData[y * targetW + x] - targetData[(y - 1) * targetW + x]);
            sum += diff > 20 ? diff : 0;
          }
          rowGrads[y] = sum;
        }

        const mean = rowGrads.reduce((a, b) => a + b, 0) / targetH;
        const variance = rowGrads.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / targetH;

        if (variance > maxVertVariance) {
          maxVertVariance = variance;
          bestVertAngle = angle;
        }
      }
    }

    const isVertical = canBeVertical && (maxVertVariance > maxHorizVariance);
    if (isVertical) {
      const angle1 = 270 + bestVertAngle;
      const angle2 = 90 + bestVertAngle;
      console.log(`[Deskew] Detected Vertical Axis. Candidates: ${angle1}° vs ${angle2}°`);
      const chosenAngle = await resolve180Ambiguity(cleanOcrBuffer, angle1, angle2);
      return chosenAngle;
    } else {
      const angle1 = bestHorizAngle;
      const angle2 = (bestHorizAngle + 180) % 360;
      console.log(`[Deskew] Detected Horizontal Axis. Candidates: ${angle1}° vs ${angle2}°`);
      const chosenAngle = await resolve180Ambiguity(cleanOcrBuffer, angle1, angle2);
      return chosenAngle;
    }
  } catch (err) {
    console.error(`Error in detectSkew:`, err.message);
    return 0;
  }
}

async function cropVehicleWithPercent(buffer, cropPercent = 0.75, vehicleType = "") {
  try {
    // 0. Normalize EXIF orientation to avoid coordinate mapping issues
    const normalizedBuffer = await sharp(buffer).rotate().toBuffer();
    const metadata = await sharp(normalizedBuffer).metadata();
    const width = metadata.width;
    const height = metadata.height;

    // Check if image has a geo location watermark before deciding whether to crop
    const hasWatermark = await hasGeoLocationWatermark(normalizedBuffer);
    const effectiveCropPercent = hasWatermark ? (cropPercent || 0.75) : 1.0;
    if (!hasWatermark) {
      console.log(`[Watermark] Image does NOT have geo location watermark. Skipping bottom crop (effective crop: 100%).`);
    } else {
      console.log(`[Watermark] Image HAS geo location watermark. Applying bottom crop (effective crop: ${Math.round(effectiveCropPercent * 100)}%).`);
    }

    // 1. Detect Skew
    const bestAngle = await detectSkew(normalizedBuffer, vehicleType);
    console.log(`[Deskew] Best angle detected: ${bestAngle}°`);

    // 2. Separate main image and watermark if effectiveCropPercent < 1.0 (removing watermark)
    if (effectiveCropPercent && effectiveCropPercent < 1.0) {
      const workingHeight = Math.round(height * effectiveCropPercent);

      const mainBuffer = await sharp(normalizedBuffer)
        .extract({ left: 0, top: 0, width: width, height: workingHeight })
        .toBuffer();

      // 3. Rotate main image and apply processing (greyscale, normalize, sharpen)
      const rotatedMainImage = await sharp(mainBuffer)
        .rotate(bestAngle, { background: { r: 255, g: 255, b: 255 } })
        .greyscale()
        .normalize()
        .sharpen()
        .jpeg()
        .toBuffer();

      return rotatedMainImage;
    } else {
      // Rotate the entire image and apply processing
      return await sharp(normalizedBuffer)
        .rotate(bestAngle, { background: { r: 255, g: 255, b: 255 } })
        .greyscale()
        .normalize()
        .sharpen()
        .jpeg()
        .toBuffer();
    }
  } catch (err) {
    console.error(`[Cropping/Deskewing] Error:`, err.message);
    // Fallback: simple processing
    try {
      const normalizedBuffer = await sharp(buffer).rotate().toBuffer();
      const metadata = await sharp(normalizedBuffer).metadata();
      const cropHeight = cropPercent ? Math.round(metadata.height * cropPercent) : metadata.height;
      return await sharp(normalizedBuffer)
        .extract({ left: 0, top: 0, width: metadata.width, height: cropHeight })
        .greyscale()
        .normalize()
        .sharpen()
        .jpeg()
        .toBuffer();
    } catch (fallbackErr) {
      console.error(`[Cropping/Deskewing] Fallback also failed:`, fallbackErr.message);
      return buffer;
    }
  }
}



function failedExtraction(file, source, error = "") {
  return { file, aiResult: null, success: false, source, error };
}

// ─── Resilience helpers ───────────────────────────────────
// The batch rewrite dropped all retries, so a single 429/5xx from Mistral or
// DeepSeek sent a perfectly readable image straight to the failed list.
const MAX_RETRIES = Number(process.env.OCR_MAX_RETRIES || 4);
const OCR_MODE = (process.env.MISTRAL_OCR_MODE || "auto").toLowerCase(); // "auto" | "batch" | "realtime"

function isRetryableError(err) {
  const status = err?.response?.status ?? err?.status;
  if (!status) return true; // network error / timeout
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

async function withRetry(label, fn, attempts = MAX_RETRIES) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const status = err?.response?.status ?? err?.status;
      if (attempt === attempts || !isRetryableError(err)) break;
      const retryAfter = Number(err?.response?.headers?.["retry-after"]);
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(2000 * 2 ** (attempt - 1), 20000);
      console.warn(`[${label}] attempt ${attempt} failed (${status || err.message}); retrying in ${backoff}ms`);
      await sleep(backoff);
    }
  }
  throw lastError;
}

function isAccountError(err) {
  const status = err?.response?.status ?? err?.status;
  return status === 401 || status === 402 || status === 403;
}

function describeError(err) {
  const status = err?.response?.status ?? err?.status;
  const detail = err?.response?.data?.message || err?.response?.data?.detail || err?.message || String(err);
  return status ? `HTTP ${status}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : detail;
}

function toOcrDocument(url, mimetype = "") {
  return mimetype === "application/pdf"
    ? { type: "document_url", document_url: url }
    : { type: "image_url", image_url: url };
}

async function runRealtimeOcr(file) {
  const dataUrl = `data:${file.mimetype || "image/jpeg"};base64,${file.buffer.toString("base64")}`;
  const response = await withRetry(`${file.originalname} ocr`, () => axios.post(
    "https://api.mistral.ai/v1/ocr",
    { model: OCR_3_MODEL, document: toOcrDocument(dataUrl, file.mimetype) },
    { headers: mistralHeaders, timeout: 120000 }
  ));
  return (response.data?.pages || []).map((page) => page?.markdown || "").filter(Boolean).join("\n");
}

// ─── Multi-read consensus ─────────────────────────────────
// Measured on the sample images: no single reader (Mistral OCR, mistral-medium,
// mistral-large, any orientation) is reliable on its own — each one drops or
// swaps characters on some photos, especially vertical/stamped 2-wheeler
// chassis numbers. Their mistakes are mostly independent, so a VIN that two or
// more independent reads agree on is very likely correct.
const VISION_MODEL_STRONG = process.env.MISTRAL_VISION_MODEL_STRONG || "mistral-large-latest";
const ROUND2_BUDGET_MS = Number(process.env.OCR_ROUND2_BUDGET_SEC || 120) * 1000;

function visionPrompt(vehicleType) {
  const normType = normalizeVehicleType(vehicleType);
  const lengthRule = normType === "commercial_equipment" || normType === "commercial_vehicle"
    ? "a 10 to 17 character chassis / VIN / product identification number"
    : "a 17-character code, usually starting with \"M\" for vehicles made in India";
  return `Find the vehicle VIN / chassis / frame number in this photo (${lengthRule}).
It may be printed on a sticker or label, engraved or stamped into metal, vertical, rotated or upside down.
Read it character by character and copy every character exactly; do not skip or add characters.
Some stickers (e.g. Hyundai) split the VIN over two lines: 11 characters after "VIN:" and the last 6 digits in large print on the next line beside the fuel type (e.g. "VIN: MALB141CLTM" / "PETROL 454752" = "MALB141CLTM454752"). Always return the full joined VIN.
Carefully distinguish 8/B, 0/D, 5/S, 6/G, 1/I, 2/Z, M/W.
Do NOT return the body number, model/spec code, engine number, barcode digits, or any text from the GPS/map camera overlay (address, pincode, Lat/Long, date, time).
Also return the engine number only if it is explicitly labelled, and the fuel type only if written.
Respond with JSON only: {"vin": "", "engine_number": "", "fuel_type": ""}`;
}

async function rotatedBuffer(buffer, rotation) {
  return rotation ? sharp(buffer).rotate(rotation).jpeg({ quality: 92 }).toBuffer() : buffer;
}

async function visionRead(file, vehicleType, model, rotation = 0) {
  const buffer = await rotatedBuffer(file.buffer, rotation);
  const dataUrl = `data:image/jpeg;base64,${buffer.toString("base64")}`;
  const isReasoningModel = /large/.test(model); // rejects temperature=0, returns content blocks
  const response = await withRetry(`${file.originalname} ${model}@${rotation}`, () => axios.post(
    "https://api.mistral.ai/v1/chat/completions",
    {
      model,
      ...(isReasoningModel ? {} : { temperature: 0 }),
      response_format: { type: "json_object" },
      messages: [{
        role: "user",
        content: [
          { type: "text", text: visionPrompt(vehicleType) },
          { type: "image_url", image_url: dataUrl },
        ],
      }],
    },
    { headers: mistralHeaders, timeout: isReasoningModel ? 90000 : 60000 }
  ), isReasoningModel ? 2 : MAX_RETRIES);

  let content = response.data?.choices?.[0]?.message?.content || "{}";
  if (Array.isArray(content)) {
    content = content.filter((block) => block?.type === "text").map((block) => block.text).join("");
  }
  const parsed = normalizeOcrStructuredOutput(String(content));
  return {
    source: `${model.replace(/-latest$/, "")}@${rotation}`,
    vin: postProcessVin(parsed.vin, vehicleType),
    engine_number: parsed.engine_number || "",
    fuel_type: parsed.fuel_type || "",
  };
}

// Joins VINs printed in two parts, e.g. Hyundai "VIN: MALB141CLTM" + "PETROL 454752".
function findSplitVins(text = "", vehicleType = "") {
  const flat = cleanMarkdown(text).toUpperCase().replace(/[|*#_]/g, " ");
  const pattern = /\bVIN\b\s*(?:NO\.?)?\s*[:.\-]?\s*([A-Z0-9]{11})\b[\s\S]{0,40}?\b(\d{6})\b/g;
  const found = [];
  for (const match of flat.matchAll(pattern)) {
    const vin = postProcessVin(match[1] + match[2], vehicleType);
    if (isPlausibleVin(vin, vehicleType)) found.push(vin);
  }
  return found;
}

// Mistral OCR on a rotated copy; VIN candidates are taken straight from the text.
async function rotatedOcrRead(file, vehicleType, rotation) {
  const buffer = await rotatedBuffer(file.buffer, rotation);
  const text = await runRealtimeOcr({ ...file, buffer, mimetype: "image/jpeg" });
  const tokens = cleanMarkdown(text).toUpperCase().replace(/[^A-Z0-9\s]/g, " ").split(/\s+/);
  const vins = [
    ...findSplitVins(text, vehicleType),
    ...tokens.map((token) => postProcessVin(token, vehicleType)).filter((vin) => isPlausibleVin(vin, vehicleType)),
  ];
  return { source: `ocr@${rotation}`, vin: vins[0] || "", engine_number: "", fuel_type: "" };
}

function pickConsensus(reads, vehicleType) {
  const valid = reads.filter((read) => isPlausibleVin(read.vin, vehicleType));
  if (valid.length === 0) return null;

  const bySupport = new Map();
  for (const read of valid) bySupport.set(read.vin, [...(bySupport.get(read.vin) || []), read.source]);
  const ranked = [...bySupport.entries()].sort((a, b) => b[1].length - a[1].length);
  const [topVin, topSources] = ranked[0];
  const runnerUp = ranked[1]?.[1].length || 0;

  if (topSources.length >= 2 && topSources.length > runnerUp) {
    return { vin: topVin, confidence: topSources.length >= 3 ? "high" : "medium", support: topSources };
  }

  // No exact agreement: per-character majority over same-length reads.
  const length = topVin.length;
  const sameLength = valid.filter((read) => read.vin.length === length);
  if (sameLength.length >= 3) {
    let voted = "";
    let contested = 0;
    for (let i = 0; i < length; i++) {
      const tally = {};
      for (const read of sameLength) tally[read.vin[i]] = (tally[read.vin[i]] || 0) + 1;
      const [ch, n] = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
      if (n * 2 <= sameLength.length) contested++;
      voted += ch;
    }
    if (contested === 0 && isPlausibleVin(voted, vehicleType)) {
      return { vin: voted, confidence: "low", support: sameLength.map((read) => read.source) };
    }
  }

  return { vin: topVin, confidence: "low", support: topSources };
}

function buildSuccess(file, details, addressDetails, source) {
  const aiResult = {
    vin: details.vin,
    engine_number: details.engine_number || "",
    hmil: "",
    invoice_number: "",
    invoice_date: "",
    grand_total: "",
    hyp_hps: "",
    tag: "audit_image",
    fuel_type: details.fuel_type || "",
    address: addressDetails.address || "",
    city: addressDetails.city || details.city || "",
    state: addressDetails.state || details.state || "",
    pincode: addressDetails.pincode || "",
    country: "",
    confidence: details.confidence || "",
    vin_reads: details.vin_reads || "",
  };
  return { file, aiResult, success: true, source };
}

// OCR text (may be empty) + vision reads -> consensus VIN. Never throws.
async function processOcrResult(file, rawOcrText, vehicleType, addressDetails, ocrError = "") {
  const reasons = [];
  const reads = [];
  if (ocrError) reasons.push(`OCR: ${ocrError}`);

  const settle = async (label, promise) => {
    try {
      const read = await promise;
      reads.push(read);
    } catch (error) {
      reasons.push(`${label}: ${describeError(error)}`);
    }
  };

  // Round 1: OCR text -> DeepSeek, and one vision read of the photo as taken.
  const cleanedOcrText = cleanMarkdown(rawOcrText || "").trim();
  const splitVin = findSplitVins(cleanedOcrText, vehicleType)[0];
  if (splitVin) reads.push({ source: "ocr_join", vin: splitVin, engine_number: "", fuel_type: "" });
  await Promise.all([
    cleanedOcrText
      ? settle("text extraction", extractVehicleDetailsWithAI(cleanedOcrText, vehicleType)
        .then((result) => ({ ...result, source: "ocr_text" })))
      : Promise.resolve(),
    settle("vision", visionRead(file, vehicleType, VISION_MODEL, 0)),
  ]);

  // Quick accept only when two INDEPENDENT readers agree (OCR-derived vs vision).
  const visionFirst = reads.find((r) => !r.source.startsWith("ocr"));
  const ocrMatch = visionFirst && isPlausibleVin(visionFirst.vin, vehicleType)
    ? reads.find((r) => r.source.startsWith("ocr") && r.vin === visionFirst.vin)
    : null;
  let consensus = ocrMatch
    ? { vin: visionFirst.vin, confidence: "high", support: [ocrMatch.source, visionFirst.source] }
    : null;

  // Round 2 (only when round 1 disagrees): more independent reads.
  if (!consensus) {
    // Time budget: a slow/hung read must never hold up the image (or the job).
    let budgetTimer;
    const budget = new Promise((resolve) => { budgetTimer = setTimeout(resolve, ROUND2_BUDGET_MS); });
    await Promise.race([
      Promise.all([
        settle("vision@90", visionRead(file, vehicleType, VISION_MODEL, 90)),
        settle("vision@270", visionRead(file, vehicleType, VISION_MODEL, 270)),
        settle("vision strong", visionRead(file, vehicleType, VISION_MODEL_STRONG, 0)),
        settle("ocr@90", rotatedOcrRead(file, vehicleType, 90)),
        settle("ocr@270", rotatedOcrRead(file, vehicleType, 270)),
        // Small photos: one extra read on a 2x-enlarged copy (fixed tiny sticker text).
        file.upscaled
          ? settle("vision upscaled", visionRead({ ...file, buffer: file.upscaled }, vehicleType, VISION_MODEL, 0)
            .then((read) => ({ ...read, source: `${read.source}x2` })))
          : Promise.resolve(),
      ]),
      budget,
    ]);
    clearTimeout(budgetTimer);
    consensus = pickConsensus([...reads], vehicleType);
  }

  const readSummary = reads.filter((r) => r.vin).map((r) => `${r.source}=${r.vin}`).join(", ");
  if (consensus) {
    const extras = reads.find((r) => r.engine_number || r.fuel_type) || {};
    console.log(`[${file.originalname}] VIN ${consensus.vin} (${consensus.confidence}; ${consensus.support.join("+")}) reads: ${reads.map((r) => `${r.source}=${r.vin || "-"}`).join(", ")}`);
    return buildSuccess(file, {
      vin: consensus.vin,
      engine_number: reads.find((r) => r.source === "ocr_text")?.engine_number || extras.engine_number || "",
      fuel_type: reads.find((r) => r.source === "ocr_text")?.fuel_type || extras.fuel_type || "",
      confidence: consensus.confidence,
      vin_reads: readSummary,
    }, addressDetails, `consensus_${consensus.confidence}`);
  }

  reasons.push(readSummary ? `no read produced a valid VIN (${readSummary})` : "no VIN-like text found by any reader");
  const reason = reasons.join("; ");
  console.log(`[${file.originalname}] FAILED: ${reason}`);
  return failedExtraction(file, "extraction_failed", reason);
}

async function runBatchOcr(files) {
  // Returns Map<index, {text, error}> for every file that went through batch.
  const outcomes = new Map();
  const requests = [];

  for (const [index, file] of files.entries()) {
    try {
      const fileUrl = await withRetry(`${file.originalname} upload`, () => uploadFileToMistral(file));
      requests.push({ custom_id: String(index), body: { document: toOcrDocument(fileUrl, file.mimetype) } });
    } catch (error) {
      outcomes.set(index, { text: "", error: `upload ${describeError(error)}` });
    }
  }
  if (requests.length === 0) return outcomes;

  try {
    const createdBatch = await withRetry("Mistral batch create", () => createMistralOcrBatch(requests));
    console.log(`[Mistral batch] Submitted ${createdBatch.id} for ${requests.length} file(s).`);
    const completedBatch = await waitForMistralBatch(createdBatch.id);
    const outputs = await withRetry("Mistral batch output", () => getMistralBatchOutputs(completedBatch));
    const outputsById = new Map(outputs.map((output) => [String(output.custom_id), output]));

    for (const request of requests) {
      const output = outputsById.get(request.custom_id);
      const text = getOcrTextFromBatchOutput(output);
      const statusCode = output?.response?.status_code;
      const error = text ? "" : (output?.error?.message || (statusCode && statusCode !== 200 ? `HTTP ${statusCode}` : "no batch output"));
      outcomes.set(Number(request.custom_id), { text, error });
    }
  } catch (error) {
    console.error("[Mistral batch] Job failed, falling back to real-time OCR:", describeError(error));
    for (const request of requests) {
      outcomes.set(Number(request.custom_id), { text: "", error: `batch ${describeError(error)}` });
    }
  }
  return outcomes;
}

// ─── HELPER: run array in batches ─────────────────────────
// Images processed at the same time. Each image makes up to ~7 Mistral calls,
// so keep this modest; withRetry absorbs any 429s.
const OCR_CONCURRENCY = Math.max(1, Number(process.env.OCR_CONCURRENCY || 4));
// Batch OCR is cheaper but can queue for a long time at Mistral, which delays
// the report and email. Small/medium uploads use real-time OCR.
const BATCH_MIN_FILES = Number(process.env.MISTRAL_BATCH_MIN_FILES || 100);
const MIN_OCR_EDGE = Number(process.env.OCR_MIN_EDGE_PX || 2000);

async function prepareFileForOcr(file) {
  if (!file.mimetype?.startsWith("image/") && !/\.(jpe?g|png|webp|tiff?|bmp|gif|heic|heif|avif)$/i.test(file.originalname || "")) {
    return { file, error: `unsupported file type "${file.mimetype || "unknown"}"` };
  }
  try {
    const { buffer: decodable } = await toDecodableImage(file.buffer, file.originalname, file.mimetype);
    const oriented = await sharp(decodable).rotate().toBuffer();
    const { width = 0, height = 0 } = await sharp(oriented).metadata();
    const longest = Math.max(width, height);
    // Small (e.g. WhatsApp-compressed) photos: sticker text is only a few
    // pixels tall and gets misread (Toyota "WF13" -> "WE13"). Upscaling to
    // ~2000px fixed this in testing; large photos are capped at 3000px.
    // Upscaling every small image hurt stamped/engraved text in testing, so the
    // enlarged copy is only used as ONE extra vote in round 2 (see processOcrResult).
    const buffer = await sharp(oriented)
      .resize({ width: 3000, height: 3000, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 92 })
      .toBuffer();
    const upscaled = longest && longest < MIN_OCR_EDGE
      ? await sharp(oriented).resize({ width: MIN_OCR_EDGE, height: MIN_OCR_EDGE, fit: "inside", kernel: "lanczos3" }).jpeg({ quality: 95 }).toBuffer()
      : null;
    return { file: { ...file, buffer, upscaled, mimetype: "image/jpeg" }, error: "" };
  } catch (err) {
    const isHeic = isHeicLike(file.buffer, file.originalname, file.mimetype);
    return {
      file,
      error: isHeic
        ? `HEIC/HEIF photo could not be decoded (${err.message}); please upload it as JPEG (set the phone camera to 'Most Compatible')`
        : `image could not be decoded (${err.message})`,
    };
  }
}

async function runPool(count, concurrency, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, count) }, async () => {
    while (next < count) {
      const index = next++;
      await worker(index);
    }
  });
  await Promise.all(runners);
}

async function processBatches(files, onFileProcessed = () => { }, vehicleType = "", addressDetails = {}) {
  const results = new Array(files.length);
  const startedAt = Date.now();
  let notified = 0;
  const finish = (index, result) => {
    if (results[index]) return; // never count an image twice
    results[index] = { ...result, file: files[index] };
    notified++;
    onFileProcessed();
  };

  // 1. Normalize every image (EXIF orientation, size cap, JPEG).
  const prepared = new Array(files.length);
  await runPool(files.length, OCR_CONCURRENCY, async (index) => {
    const { file, error } = await prepareFileForOcr(files[index]);
    prepared[index] = file;
    if (error) {
      console.error(`[${files[index].originalname}] ${error}`);
      finish(index, failedExtraction(files[index], "unsupported_image", error));
    }
  });

  // 2. Optional batch OCR for large uploads (only for images that decoded).
  const pending = prepared.map((_, index) => index).filter((index) => !results[index]);
  const useBatch = OCR_MODE === "batch" || (OCR_MODE === "auto" && pending.length >= BATCH_MIN_FILES);
  const batchOutcomes = new Map();
  if (useBatch && pending.length) {
    const outcomes = await runBatchOcr(pending.map((index) => prepared[index]));
    pending.forEach((index, position) => {
      if (outcomes.has(position)) batchOutcomes.set(index, outcomes.get(position));
    });
  }

  // 3. Per-image OCR + consensus, several images at a time.
  let accountError = ""; // 401/402/403: key or billing problem, retrying cannot help
  await runPool(pending.length, OCR_CONCURRENCY, async (position) => {
    const index = pending[position];
    const file = prepared[index];
    try {
      let { text = "", error = "" } = batchOutcomes.get(index) || {};

      if (!text && accountError) {
        finish(index, failedExtraction(files[index], "mistral_account_error", accountError));
        return;
      }

      if (!text) {
        try {
          text = await runRealtimeOcr(file);
          error = text ? "" : error;
        } catch (realtimeError) {
          error = [error, `realtime ${describeError(realtimeError)}`].filter(Boolean).join(" | ");
          if (isAccountError(realtimeError)) {
            accountError = `Mistral account/API key error, check MISTRAL_API_KEY and billing: ${describeError(realtimeError)}`;
            console.error(`[OCR] ${accountError}`);
            finish(index, failedExtraction(files[index], "mistral_account_error", accountError));
            return;
          }
        }
      }

      finish(index, await processOcrResult(file, text, vehicleType, addressDetails, text ? "" : error));
    } catch (unexpected) {
      finish(index, failedExtraction(files[index], "processing_error", describeError(unexpected)));
    }
  });

  // 4. Invariant: exactly one result per uploaded image, in upload order.
  for (let index = 0; index < files.length; index++) {
    if (!results[index]) finish(index, failedExtraction(files[index], "not_processed", "image was not processed (internal error)"));
  }
  console.log(`[processBatches] ${files.length} image(s) in, ${results.filter(Boolean).length} result(s) out, ` +
    `${results.filter((r) => r.success).length} with VIN, ${Math.round((Date.now() - startedAt) / 1000)}s`);
  if (notified !== files.length) console.error(`[processBatches] progress count ${notified} != ${files.length}`);

  return results;
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
  res.setHeader("X-Accel-Buffering", "no"); // stop nginx buffering the stream
  res.flushHeaders();

  // Heartbeat comment every 15s so proxies/browsers don't drop a quiet stream
  // while a slow image is being read (EventSource ignores comment lines).
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
  req.on("close", () => clearInterval(heartbeat));

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  send({
    processed: job.processed,
    total: job.total,
    status: job.status,
    emailStatus: job.emailStatus,
    emailMessage: job.emailMessage,
    reportPath: job.reportPath,
    reportSaveError: job.reportSaveError,
  });
  job.clients.push(send);

  req.on("close", () => {
    job.clients = job.clients.filter((c) => c !== send);
  });
});

// ─── PER-IMAGE RESULTS (JSON) ─────────────────────────────
app.get("/api/result/:jobId/details", (req, res) => {
  const job = jobStore.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Not found" });
  if (job.status !== "done") return res.status(202).json({ status: job.status });
  res.json({ total: job.total, results: job.details || [] });
});

// ─── DOWNLOAD RESULT ──────────────────────────────────────
app.get("/api/result/:jobId", (req, res) => {
  const job = jobStore.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Not found" });
  if (job.status === "error") return res.status(500).json({ error: job.error });
  if (job.status !== "done") return res.status(202).json({ status: job.status });

  if (!job.result) return res.status(500).json({ error: job.resultError || job.reportSaveError || "Result could not be generated" });

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", "attachment; filename=Stockyard_Audit_Result.zip");
  res.send(job.result);

  setTimeout(() => jobStore.delete(req.params.jobId), 60_000);
});

// PDF report on its own (the same PDF is also inside the ZIP).
app.get("/api/result/:jobId/pdf", (req, res) => {
  const job = jobStore.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Not found" });
  if (job.status !== "done") return res.status(202).json({ status: job.status });
  if (!job.pdf) return res.status(500).json({ error: job.reportSaveError || "Report could not be generated" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "attachment; filename=Stockyard_Audit_Management_Report.pdf");
  res.send(job.pdf);
});

// ─── RESULT ZIP: vehicles.xlsx + PDF + failed/ + needs_review/ ─────
async function buildResultZip(files, allResults, addressDetails, reportPdf) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Sheet1");
  worksheet.columns = [
    { header: "File Name", key: "file_name", width: 34 },
    { header: "VIN", key: "vin", width: 22 },
    { header: "Engine Number", key: "engine_number", width: 18 },
    { header: "Fuel Type", key: "fuel_type", width: 12 },
    { header: "Confidence", key: "confidence", width: 12 },
    { header: "Status", key: "status", width: 14 },
    { header: "Failure Reason", key: "reason", width: 50 },
    { header: "Address", key: "address", width: 24 },
    { header: "City", key: "city", width: 14 },
    { header: "State", key: "state", width: 16 },
    { header: "Pincode", key: "pincode", width: 12 },
  ];

  const headerRow = worksheet.getRow(1);
  headerRow.eachCell((cell) => {
    cell.font = { name: "Arial", bold: true, size: 11, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4472C4" } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = {
      top: { style: "thin", color: { argb: "FF000000" } },
      left: { style: "thin", color: { argb: "FF000000" } },
      bottom: { style: "thin", color: { argb: "FF000000" } },
      right: { style: "thin", color: { argb: "FF000000" } },
    };
  });
  headerRow.height = 20;

  const failedFiles = [];
  const reviewFiles = [];

  files.forEach((file, index) => {
    const result = allResults[index];
    const ai = result?.success ? result.aiResult || {} : {};
    const confidence = result?.success ? ai.confidence || "" : "";
    let status = "Failed";
    if (result?.success) status = confidence === "low" ? "Needs review" : "OK";
    if (status === "Failed") failedFiles.push(file);
    if (status === "Needs review") reviewFiles.push(file);

    const row = worksheet.addRow({
      file_name: file.originalname,
      vin: ai.vin || "",
      engine_number: ai.engine_number || "",
      fuel_type: ai.fuel_type || "",
      confidence,
      status,
      reason: status === "Failed" ? String(result?.error || result?.source || "No VIN found") : "",
      address: addressDetails.address || ai.address || "",
      city: addressDetails.city || ai.city || "",
      state: addressDetails.state || ai.state || "",
      pincode: addressDetails.pincode || ai.pincode || "",
    });

    const isEven = row.number % 2 === 0;
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.font = { name: "Arial", size: 10 };
      cell.alignment = { horizontal: "center", vertical: "middle" };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: isEven ? "FFD9E1F2" : "FFFFFFFF" } };
      cell.border = {
        top: { style: "thin", color: { argb: "FFB8CCE4" } },
        left: { style: "thin", color: { argb: "FFB8CCE4" } },
        bottom: { style: "thin", color: { argb: "FFB8CCE4" } },
        right: { style: "thin", color: { argb: "FFB8CCE4" } },
      };
    });
    row.getCell("reason").alignment = { horizontal: "left", vertical: "middle", wrapText: true };

    const statusCell = row.getCell("status");
    const statusStyle = {
      OK: { font: "FF375623", fill: "FFC6EFCE" },
      "Needs review": { font: "FF9C5700", fill: "FFFFEB9C" },
      Failed: { font: "FF9C0006", fill: "FFFFC7CE" },
    }[status];
    statusCell.font = { name: "Arial", size: 10, bold: true, color: { argb: statusStyle.font } };
    statusCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: statusStyle.fill } };
  });

  const excelBuffer = await workbook.xlsx.writeBuffer();

  // Unique names inside a folder: "a.jpg", "a_2.jpg", "a_3.jpg"...
  const uniqueName = (used, name) => {
    const safe = String(name || "image").replace(/[\\/]/g, "_");
    if (!used.has(safe.toLowerCase())) { used.add(safe.toLowerCase()); return safe; }
    const dot = safe.lastIndexOf(".");
    const base = dot > 0 ? safe.slice(0, dot) : safe;
    const ext = dot > 0 ? safe.slice(dot) : "";
    for (let n = 2; ; n++) {
      const candidate = `${base}_${n}${ext}`;
      if (!used.has(candidate.toLowerCase())) { used.add(candidate.toLowerCase()); return candidate; }
    }
  };

  return new Promise((resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 9 } });
    const buffers = [];
    archive.on("data", (d) => buffers.push(d));
    archive.on("end", () => resolve(Buffer.concat(buffers)));
    archive.on("error", reject);
    archive.append(Buffer.from(excelBuffer), { name: "vehicles.xlsx" });
    if (reportPdf) archive.append(reportPdf, { name: "Stockyard_Audit_Management_Report.pdf" });
    const usedFailed = new Set();
    failedFiles.forEach((f) => archive.append(f.buffer, { name: `failed/${uniqueName(usedFailed, f.originalname)}` }));
    const usedReview = new Set();
    reviewFiles.forEach((f) => archive.append(f.buffer, { name: `needs_review/${uniqueName(usedReview, f.originalname)}` }));
    archive.finalize();
  });
}

// ─── JOB RUNNER ───────────────────────────────────────────
async function runJob(jobId, files, vehicleType = "", addressDetails = {}) {
  const job = jobStore.get(jobId);
  try {
    const notify = () => {
      job.processed++;
      const update = { processed: job.processed, total: job.total, status: "processing" };
      job.clients.forEach((send) => send(update));
    };

    let allResults;
    try {
      allResults = await processBatches(files, notify, vehicleType, addressDetails);
    } catch (error) {
      console.error("[runJob] Scan pipeline failed; generating a failed-scan report:", error);
      allResults = files.map((file) => failedExtraction(file, "job_error", error.message));
      while (job.processed < job.total) notify();
    }

    job.details = allResults.map((r, index) => ({
      index,
      file: r?.file?.originalname || files[index]?.originalname || "",
      vin: r?.success ? r.aiResult.vin : "",
      engine_number: r?.success ? r.aiResult.engine_number : "",
      confidence: r?.success ? r.aiResult.confidence || "" : "",
      source: r?.source || "",
      error: r?.error || "",
    }));
    const withVin = allResults.filter((r) => r?.success);
    const needsReview = withVin.filter((r) => r.aiResult?.confidence === "low");
    const failed = allResults.filter((r) => !r?.success);
    const summary = [
      `Images uploaded: ${job.total}. Results: ${allResults.length}. VIN read: ${withVin.length}. Not read: ${failed.length}.`,
      needsReview.length
        ? `Please verify ${needsReview.length} low-confidence VIN(s):\n${needsReview.map((r) => `  - ${r.file.originalname}: ${r.aiResult.vin}`).join("\n")}`
        : "",
      failed.length
        ? `Images without a VIN:\n${failed.map((r) => `  - ${r.file?.originalname}: ${String(r.error || r.source).slice(0, 160)}`).join("\n")}`
        : "",
    ].filter(Boolean).join("\n\n");

    const reportInput = {
      results: allResults,
      totalImages: job.total,
      vehicleType,
      location: addressDetails.city || addressDetails.address || addressDetails.state,
    };
    let reportPdf = null;
    try {
      // AI explanations (DeepSeek); falls back to metrics-only text if unavailable.
      let reportExplanations = null;
      try {
        reportExplanations = await generateAuditReportExplanations(calculateAuditMetrics(reportInput), openai);
      } catch (error) {
        console.error(`[runJob] DeepSeek report explanation failed for job ${jobId}; using a metrics-only fallback:`, error);
      }
      reportPdf = await buildAuditReportPdf({ ...reportInput, explanations: reportExplanations });
    } catch (error) {
      // Still email the summary so the client is never left without a report.
      console.error(`[runJob] PDF generation failed for job ${jobId}:`, error);
      job.reportSaveError = "The PDF report could not be generated; the email contains the text summary.";
    }

    // Download = ZIP (Excel + PDF + failed/ + needs_review/), built from the
    // ORIGINAL uploaded files. The email still attaches only the PDF.
    job.pdf = reportPdf;
    try {
      job.result = await buildResultZip(files, allResults, addressDetails, reportPdf);
    } catch (error) {
      console.error(`[runJob] Result ZIP generation failed for job ${jobId}:`, error);
      job.result = null;
      job.resultError = "The result ZIP could not be generated. Check backend logs.";
    }
    if (reportPdf) {
      // Daily 9:00 AM delivery queue (temporary mail feature).
      if (REPORT_EMAIL_MODE !== "immediate") {
        try {
          await recordTemporaryMailReport({ jobId, totalFiles: job.total, reportBuffer: reportPdf });
        } catch (error) {
          console.error(`[Temporary mail] Could not queue report for job ${jobId}:`, error);
        }
      }
      try {
        job.reportPath = await saveLatestReportPreview(reportPdf, jobId);
        console.info(`[runJob] Report saved to ${job.reportPath}`);
      } catch (error) {
        job.reportSaveError = "The report was generated but could not be saved to the reports folder.";
        console.error(`[runJob] Failed to save report for job ${jobId}:`, error);
      }
    }

    // REPORT_EMAIL_MODE: "immediate" = email right after the scan,
    // "daily" = only the 9:00 AM batch the next morning, "both" = both (previous behaviour).
    const emailResult = REPORT_EMAIL_MODE === "daily"
      ? { status: "scheduled", message: "The report is queued and will be emailed at 9:00 AM tomorrow." }
      : await sendReportEmail(reportPdf, job.total, jobId, summary);
    job.emailStatus = emailResult.status;
    job.emailMessage = emailResult.message;
    job.status = "done";
    job.clients.forEach((send) => send({
      processed: job.total,
      total: job.total,
      status: "done",
      emailStatus: job.emailStatus,
      emailMessage: job.emailMessage,
      reportPath: job.reportPath,
      reportSaveError: job.reportSaveError,
    }));
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

if (process.env.NO_LISTEN !== "1") {
  if (REPORT_EMAIL_MODE !== "immediate") startTemporaryMailScheduler();
  const PORT = Number(process.env.PORT || 5000);
  app.listen(PORT, () => console.log(`Server running at ${PORT}`));
}

export { cropVehicleWithPercent, hasGeoLocationWatermark, getPrimaryCropPercent, processBatches, getVehiclePromptBundle, extractVehicleDetailsWithAI, postProcessVin, isPlausibleVin, prepareImageForOcr, sendReportEmail, processMailOutbox };
