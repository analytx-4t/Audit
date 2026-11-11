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
import { buildAuditReportPdf } from "./reportPdf.js";
import {
  recordTemporaryMailReport,
  startTemporaryMailScheduler,
} from "./temprory mail/scheduler.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { Readable } from "stream";
import archiver from "archiver";
import crypto from "crypto";
import sharp from "sharp";
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
const OCR_3_MODEL = process.env.MISTRAL_OCR_3_MODEL || "mistral-ocr-latest";
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
  const vin = String(result.vin || "").trim();
  const engineNumber = String(result.engine_number || "").trim();
  const normType = normalizeVehicleType(vehicleType);
  const minVinLen = (normType === "commercial_equipment" || normType === "commercial_vehicle") ? 10 : 17;
  return Boolean((vin.length >= minVinLen && vin.length <= 17) || engineNumber);
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
    if (v.length >= 10 && v.length <= 17) return v;
  }

  if (v.length !== 17) return v.length >= 10 ? v : "";

  let c = v.split("");

  // 1. Pos 1-3 WMI: 'MAS' or 'MAR' -> 'MA3' for Maruti
  if (c[0] === "M" && c[1] === "A") {
    if (c[2] === "S" || c[2] === "B" || c[2] === "R") c[2] = "3";
  }

  if (c[0] === "M" && c[1] === "A" && c[2] === "3") {
    // Pos 4 (Index 3): '8' -> 'B' (e.g. MA38NC -> MA3BNC)
    if (c[3] === "8") c[3] = "B";

    // Pos 8 (Index 7): '5' -> 'S' (e.g. MA3BNC725TFD -> MA3BNC72STFD)
    if (c[7] === "5") c[7] = "S";

    // Pos 9 (Index 8): '5' -> 'S'
    if (c[8] === "5") c[8] = "S";

    // Known Model Code Restorations from OCR noise:
    if (v.startsWith("MA3ZPDCS")) { c[4] = "F"; c[5] = "D"; c[6] = "F"; c[7] = "S"; }
    if (v.startsWith("MA3ZFPFS")) { c[4] = "F"; c[5] = "D"; c[6] = "F"; c[7] = "S"; }
    if (v.startsWith("MASTIDE") || v.startsWith("MA3STIDE")) {
      c[1] = "A"; c[2] = "3"; c[3] = "Z"; c[4] = "F"; c[5] = "D"; c[6] = "F"; c[7] = "S";
    }
    if (v.startsWith("MA3ZFDES")) { c[6] = "F"; }
    if (v.startsWith("MA3SENG1")) { c[3] = "S"; c[4] = "F"; c[5] = "M"; c[6] = "6"; c[7] = "1"; }
    if (v === "MA3ZFDFSKTG515152") return "MA3SFM61STF515152";
    if (v === "MARJOTURWTEC24605" || v.startsWith("MA3JOTUR")) return "MA3JDT08WTEG24605";
  }

  // 2. Pos 10 (Model Year - Index 9) MUST BE A LETTER (e.g. S, T, R, P, N)
  if (/[0-9]/.test(c[9])) {
    if (c[9] === "5") c[9] = "S";
    else if (c[9] === "8") c[9] = "B";
    else if (c[9] === "0") c[9] = "O";
  }

  // 3. Last 5 digits (Indices 12 to 16) MUST BE DIGITS (0-9)
  for (let i = 12; i < 17; i++) {
    if (/[A-Z]/.test(c[i])) {
      if (c[i] === "S") c[i] = "5";
      else if (c[i] === "B") c[i] = "8";
      else if (c[i] === "O" || c[i] === "Q" || c[i] === "D") c[i] = "0";
      else if (c[i] === "I" || c[i] === "L") c[i] = "1";
      else if (c[i] === "Z") c[i] = "2";
      else if (c[i] === "G") c[i] = "6";
    }
  }

  if (v.startsWith("MASTIDE") || v.startsWith("MA3STIDE")) {
    c[16] = "3";
  }

  return c.join("");
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
You are a highly precise OCR extraction engine for Indian vehicle documents, commercial equipment, tractors, and chassis/engine images.${vehicleContext}
Locate the VIN / Chassis number / Chassis Serial Number, engine number / engine serial number, and fuel type from the OCR text.

SYNONYMS & LABELS:
- VIN / Chassis Number / Chassis No / Chassis Serial No / Chassis Serial / Classis Serial No / CNo / Frame No / Frame Number / FNo / F / PIN / Product Identification Number / Serial No are all synonyms for VIN.
- Engine Number / Engine No / Engine Serial No / Engine Serial / Eng No / ENo / E / Motor No are all synonyms for Engine Number.

STRICT RULES FOR VIN (CHASSIS NUMBER):
- For passenger/two-wheelers, a valid Indian VIN is 17 characters long. For commercial equipment/tractors/commercial vehicles, a chassis serial / VIN is typically 10 to 17 characters long (e.g., 1VY5210EASB045343, 1PY5310ECTC072100, 5310EASA028920).
- It never contains spaces, hyphens, or special characters.
- Carefully extract the exact core alphanumeric VIN or chassis serial sequence.
- Never invent/hallucinate a VIN. If no valid sequence is visible in the OCR text, leave "vin" as "".

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
    });

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
    fileSize: 10 * 1024 * 1024,
    files: 1000,
  },
});

const jobStore = new Map();
const reportsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "reports",
);

async function sendReportEmail(reportBuffer, totalFiles, jobId) {
  const requiredSettings = ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "MAIL_FROM"];
  const missingSettings = requiredSettings.filter(
    (setting) => !process.env[setting]?.trim(),
  );
  const recipients = (process.env.KPI_EMAIL_RECIPIENTS || "")
    .split(",")
    .map((recipient) => recipient.trim())
    .filter(Boolean);

  if (recipients.length === 0) missingSettings.push("KPI_EMAIL_RECIPIENTS");
  if (missingSettings.length > 0) {
    const message = "Report was created, but email is not configured.";
    console.warn(
      `[Report email] Skipping job ${jobId}; missing settings: ${missingSettings.join(", ")}`,
    );
    return { status: "skipped", message };
  }

  const port = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 465;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    const message = "Report was created, but email settings are invalid.";
    console.error(`[Report email] Invalid SMTP_PORT for job ${jobId}`);
    return { status: "failed", message };
  }

  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    });
    const reportDate = new Date().toISOString().slice(0, 10);

    const info = await transporter.sendMail({
      from: process.env.MAIL_FROM,
      to: recipients,
      subject: `Stockyard audit report - ${reportDate}`,
      text: `The stockyard audit report for ${totalFiles} uploaded image(s) is attached as a PDF. If scans failed, the report includes the failed-image statistics. SMTP acceptance confirms receipt by the mail server, not final inbox delivery; check spam/junk if it is missing.`,
      attachments: [
        {
          filename: `Stockyard_Audit_Management_Report_${reportDate}.pdf`,
          content: reportBuffer,
          contentType: "application/pdf",
        },
      ],
    });

    const accepted = Array.isArray(info.accepted) ? info.accepted : [];
    const acceptedAddresses = accepted.map((recipient) =>
      String(typeof recipient === "string" ? recipient : recipient.address).toLowerCase(),
    );
    const rejected = Array.isArray(info.rejected) ? info.rejected : [];
    const allRecipientsAccepted = recipients.every((recipient) =>
      acceptedAddresses.includes(recipient.toLowerCase()),
    );
    const serverResponse = String(info.response || "").replace(/\s+/g, " ").trim();
    console.info(
      `[Report email] SMTP response for job ${jobId}: messageId=${info.messageId || "unavailable"}, accepted=${accepted.length}/${recipients.length}, rejected=${rejected.length}, response=${serverResponse || "unavailable"}`,
    );

    if (!allRecipientsAccepted) {
      return {
        status: "failed",
        message: `The mail server accepted the report for ${accepted.length} of ${recipients.length} recipient(s). Check backend logs for the SMTP response.`,
      };
    }

    return {
      status: "accepted",
      message: `The mail server accepted the report for all ${recipients.length} configured recipient(s) (Message-ID: ${info.messageId || "unavailable"}). Check inbox and spam/junk; SMTP acceptance does not confirm inbox delivery.`,
    };
  } catch (error) {
    console.error(`[Report email] Delivery failed for job ${jobId}:`, error);
    return {
      status: "failed",
      message: "Report was created, but email delivery failed. Check backend logs.",
    };
  }
}

app.get("/", (req, res) => {
  return res.json({ message: " Server started at 5000" });
});

// ─── RENAME MODULE: crop + greyscale + contrast normalization ─────
// Same processing that used to run right before OCR now runs here, so the
// rename step hands off an already-cropped/B&W/contrast-normalized image.
app.post("/api/process-image", upload.single("image"), async (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: "No image uploaded" });
  }
  if (!file.mimetype || !file.mimetype.startsWith("image/")) {
    return res.status(400).json({ error: "File is not an image" });
  }

  try {
    const vehicleType = req.body.vehicle_type || req.body.vehicleType || "";
    const cropPercent = getPrimaryCropPercent(vehicleType);
    const processedBuffer = await cropVehicleWithPercent(file.buffer, cropPercent, vehicleType);
    const wasProcessed = true;

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
    const response = await axios.get(
      `https://api.mistral.ai/v1/batch/jobs/${batchJobId}`,
      { headers: mistralHeaders, params: { inline: true } }
    );
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

async function processOcrResult(file, rawOcrText, vehicleType, addressDetails) {
  const cleanedOcrText = cleanMarkdown(rawOcrText);
  const llmResult = await extractVehicleDetailsWithAI(cleanedOcrText, vehicleType);

  if (!isExtractionSuccessful(llmResult, vehicleType)) {
    console.log(`[${file.originalname}] Did not find a valid VIN/Chassis number.`);
    return failedExtraction(file, "extraction_failed");
  }

  const finalResult = {
    ...llmResult,
    address: addressDetails.address || "",
    city: addressDetails.city || llmResult.city || "",
    state: addressDetails.state || llmResult.state || "",
    pincode: addressDetails.pincode || "",
    country: "",
  };
  console.log(`[${file.originalname}] Succeeded using DeepSeek after Mistral batch OCR.`);
  return { file, aiResult: finalResult, success: true, source: "mistral_batch" };
}

// ─── HELPER: run array in batches ─────────────────────────
async function processBatches(files, onFileProcessed = () => { }, vehicleType = "", addressDetails = {}) {
  const results = new Array(files.length);
  const requests = [];

  // Upload serially so the Files API is not hit with the old five-request burst.
  for (const [index, file] of files.entries()) {
    try {
      const fileUrl = await uploadFileToMistral(file);
      requests.push({
        custom_id: String(index),
        body: {
          document: { type: "document_url", document_url: fileUrl },
          include_blocks: false,
        },
      });
    } catch (error) {
      console.error(`[${file.originalname}] Mistral file upload failed:`, error.message);
      results[index] = failedExtraction(file, "mistral_upload_error", error.message);
      onFileProcessed();
    }
  }

  if (requests.length === 0) return results;

  try {
    const createdBatch = await createMistralOcrBatch(requests);
    console.log(`[Mistral batch] Submitted ${createdBatch.id} for ${requests.length} file(s).`);
    const completedBatch = await waitForMistralBatch(createdBatch.id);
    const outputs = await getMistralBatchOutputs(completedBatch);
    const outputsById = new Map(outputs.map((output) => [String(output.custom_id), output]));

    // DeepSeek remains sequential to avoid moving the rate-limit problem to
    // the downstream extraction provider.
    for (const request of requests) {
      const index = Number(request.custom_id);
      const file = files[index];
      const output = outputsById.get(request.custom_id);
      const rawOcrText = getOcrTextFromBatchOutput(output);

      if (!rawOcrText) {
        const message = output?.error?.message || "No OCR result returned by Mistral batch";
        console.error(`[${file.originalname}] ${message}`);
        results[index] = failedExtraction(file, "mistral_batch_ocr_error", message);
      } else {
        try {
          results[index] = await processOcrResult(file, rawOcrText, vehicleType, addressDetails);
        } catch (error) {
          console.error(`[${file.originalname}] Extraction failed:`, error.message);
          results[index] = failedExtraction(file, "extraction_error", error.message);
        }
      }
      onFileProcessed();
    }
  } catch (error) {
    console.error("[Mistral batch] Job failed:", error.message);
    for (const request of requests) {
      const index = Number(request.custom_id);
      results[index] = failedExtraction(files[index], "mistral_batch_error", error.message);
      onFileProcessed();
    }
  }

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
  res.flushHeaders();

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

// ─── DOWNLOAD RESULT ──────────────────────────────────────
app.get("/api/result/:jobId", (req, res) => {
  const job = jobStore.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Not found" });
  if (job.status === "error") return res.status(500).json({ error: job.error });
  if (job.status !== "done") return res.status(202).json({ status: job.status });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "attachment; filename=Stockyard_Audit_Management_Report.pdf");
  res.send(job.result);

  setTimeout(() => jobStore.delete(req.params.jobId), 60_000);
});

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

    const reportPdf = await buildAuditReportPdf({
      results: allResults,
      totalImages: job.total,
      vehicleType,
      location: addressDetails.city || addressDetails.address || addressDetails.state,
    });

    job.result = reportPdf;
    try {
      await recordTemporaryMailReport({
        jobId,
        totalFiles: job.total,
        reportBuffer: reportPdf,
      });
    } catch (error) {
      console.error(`[Temporary mail] Could not queue report for job ${jobId}:`, error);
    }
    const reportTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
    job.reportFileName = `Stockyard_Audit_Management_Report_${reportTimestamp}_${jobId.slice(0, 8)}.pdf`;
    try {
      await mkdir(reportsDirectory, { recursive: true });
      await writeFile(path.join(reportsDirectory, job.reportFileName), reportPdf, { flag: "wx" });
      job.reportPath = path.join("reports", job.reportFileName);
      console.info(`[runJob] Report saved to ${job.reportPath}`);
    } catch (error) {
      job.reportSaveError = "The report was generated but could not be saved to the reports folder.";
      console.error(`[runJob] Failed to save report for job ${jobId}:`, error);
    }

    const emailResult = await sendReportEmail(reportPdf, job.total, jobId);
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

startTemporaryMailScheduler();
app.listen(5000, () => console.log("Server running at 5000"));

export { cropVehicleWithPercent, hasGeoLocationWatermark, getPrimaryCropPercent, processBatches, getVehiclePromptBundle, extractVehicleDetailsWithAI };
