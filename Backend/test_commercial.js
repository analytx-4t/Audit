import fs from "fs";
import path from "path";
import { config } from "dotenv";
import sharp from "sharp";
import axios from "axios";
import FormData from "form-data";
import OpenAI from "openai";

config();

const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

const openai = new OpenAI({
  apiKey: DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com",
});

const OCR_3_MODEL = "mistral-ocr-latest";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function uploadFileToMistral(buffer, filename, mimetype) {
  const formData = new FormData();
  formData.append("file", buffer, {
    filename: filename,
    contentType: mimetype,
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

async function runOcrStage(fileUrl) {
  const ocrResponse = await axios.post(
    "https://api.mistral.ai/v1/ocr",
    {
      model: OCR_3_MODEL,
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

async function extractVehicleDetailsWithAI(text) {
  try {
    const response = await openai.chat.completions.create({
      model: "deepseek-chat",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `
You are a highly precise OCR extraction engine for Indian vehicle documents and chassis/engine images.
Locate the VIN / Chassis number, engine number, and fuel type from the OCR text.

SYNONYMS & LABELS:
- VIN / Chassis Number / Chassis No / CNo / Frame No / Frame Number / FNo / F: are all synonyms.
- Engine Number / Engine No / Eng No / ENo / E: are all synonyms.

STRICT RULES FOR VIN (CHASSIS NUMBER):
- A valid Indian VIN is EXACTLY 17 characters long, uppercase, alphanumeric.
- It never contains spaces, hyphens, or special characters.
- If the OCR text has noise at the start or end, carefully extract the core 17-character VIN.
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
    return {
      vin: postProcessVin(parsed.vin),
      engine_number: (parsed.engine_number || "").trim(),
      fuel_type: (parsed.fuel_type || "").trim(),
    };
  } catch (error) {
    console.error("LLM fallback extraction failed:", error.message);
    return { vin: "", engine_number: "", fuel_type: "" };
  }
}

async function runSinglePass(originalBuffer, filename, width, height, cropPercent) {
  const cropHeight = Math.round(height * cropPercent);
  const processedBuffer = await sharp(originalBuffer)
    .extract({ left: 0, top: 0, width: width, height: cropHeight })
    .greyscale()
    .normalize()
    .sharpen()
    .jpeg()
    .toBuffer();

  const fileUrl = await uploadFileToMistral(processedBuffer, `cv_${cropPercent}_${filename}`, "image/jpeg");
  const rawOcr = await runOcrStage(fileUrl);
  const cleanedOcr = cleanMarkdown(rawOcr);
  const res = await extractVehicleDetailsWithAI(cleanedOcr);
  return res;
}

async function testAll() {
  const dirPath = "../commercial Vehicles";
  const files = fs.readdirSync(dirPath).filter(f => f.toLowerCase().endsWith(".jpg") || f.toLowerCase().endsWith(".jpeg"));
  
  console.log(`Found ${files.length} commercial vehicle images to test.`);

  const results = [];

  for (const file of files) {
    console.log(`\n--------------------------------------------`);
    console.log(`Processing: ${file}`);
    const filePath = path.join(dirPath, file);
    const originalBuffer = fs.readFileSync(filePath);
    const metadata = await sharp(originalBuffer).metadata();
    const width = metadata.width;
    const height = metadata.height;

    // 1. Try 85% crop
    console.log(`Trying 85% crop...`);
    let res = await runSinglePass(originalBuffer, file, width, height, 0.85);
    let chosenPass = "85%";
    
    // 2. If fails, try 80% crop
    if (!res.vin) {
      console.log(`85% crop failed to get VIN, trying 80% crop...`);
      res = await runSinglePass(originalBuffer, file, width, height, 0.80);
      chosenPass = "80%";
    }

    console.log(`Result (${chosenPass}):`, res);
    results.push({
      file,
      vin: res.vin,
      engine: res.engine_number,
      pass: chosenPass
    });
  }

  console.log("\n================ SUMMARY ================");
  console.table(results);
}

testAll().catch(console.error);
