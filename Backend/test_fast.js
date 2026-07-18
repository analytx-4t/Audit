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
  
  // Retry loop for getting signed URL
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const urlResponse = await axios.get(
        `https://api.mistral.ai/v1/files/${fileId}/url`,
        { headers: { Authorization: `Bearer ${MISTRAL_API_KEY}` } }
      );
      return urlResponse.data.url;
    } catch (err) {
      if (err.response?.status === 404 && attempt < 5) {
        console.warn(`[Mistral] Signed URL not ready yet (404), retrying in 2s (attempt ${attempt}/5)...`);
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

function normalizeOcrStructuredOutput(text = "") {
  const candidate = (text || "").trim();
  const result = {
    vin: "",
    engine_number: "",
    fuel_type: "",
  };

  if (!candidate) return result;

  // Search for 17-character VIN
  const vinMatch = candidate.match(/\b[A-Za-z0-9]{17}\b/);
  if (vinMatch) result.vin = vinMatch[0].toUpperCase();

  // Search for Engine number
  const engineMatch = candidate.match(/engine(?:\s*number|\s*no\.?|\s*no)?\s*[:#-]?\s*([A-Za-z0-9\-\/\s]{2,30})/i);
  if (engineMatch && engineMatch[1]) result.engine_number = engineMatch[1].trim().replace(/\s+/g, " ");

  const fuelMatch = candidate.match(/\b(petrol|diesel|cng|lpg|electric|ev)\b/i);
  if (fuelMatch && fuelMatch[1]) result.fuel_type = fuelMatch[1].toLowerCase();

  return result;
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
You are an OCR extraction engine specialized in Indian vehicles.
Locate the VIN / Chassis number, engine number, and fuel type from the text.
The VIN is a 17-character alphanumeric code. If you find a chassis number that is slightly shorter (e.g. 15-16 characters) or has minor OCR errors, correct/return it.
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
      vin: parsed.vin || "",
      engine_number: parsed.engine_number || "",
      fuel_type: parsed.fuel_type || "",
    };
  } catch (error) {
    console.error("LLM fallback extraction failed:", error.message);
    return { vin: "", engine_number: "", fuel_type: "" };
  }
}

async function testAll() {
  const dirPath = "../Two Wheelers";
  // Just test first 3 images for speed
  const allFiles = fs.readdirSync(dirPath).filter(f => f.toLowerCase().endsWith(".jpg") || f.toLowerCase().endsWith(".jpeg"));
  const files = allFiles.slice(0, 3);
  
  console.log(`Found ${allFiles.length} images. Testing with first ${files.length} images: ${files.join(", ")}`);

  const results = [];

  for (const file of files) {
    console.log(`\n--------------------------------------------`);
    console.log(`Processing: ${file}`);
    const filePath = path.join(dirPath, file);
    const originalBuffer = fs.readFileSync(filePath);

    // Get metadata
    const metadata = await sharp(originalBuffer).metadata();
    const width = metadata.width;
    const height = metadata.height;
    
    // We crop the top 80% to remove watermark at the bottom
    const cropHeight = Math.round(height * 0.80);

    // Method 1: Top 80% Color
    console.log(`[Method 1] Cropping top 80% in color...`);
    const colorBuffer = await sharp(originalBuffer)
      .extract({ left: 0, top: 0, width: width, height: cropHeight })
      .toBuffer();

    console.log(`[Method 1] Uploading color to Mistral...`);
    const colorUrl = await uploadFileToMistral(colorBuffer, `color_${file}`, "image/jpeg");
    console.log(`[Method 1] Running OCR...`);
    const colorOcr = await runOcrStage(colorUrl);
    const colorParsed = normalizeOcrStructuredOutput(colorOcr);
    let colorFinal = colorParsed;
    if (!colorParsed.vin || colorParsed.vin.length !== 17) {
      colorFinal = await extractVehicleDetailsWithAI(colorOcr);
    }

    // Method 2: Top 80% Grayscale + Contrast
    console.log(`[Method 2] Cropping top 80% in grayscale + contrast...`);
    const grayBuffer = await sharp(originalBuffer)
      .extract({ left: 0, top: 0, width: width, height: cropHeight })
      .greyscale()
      .normalize()
      .sharpen()
      .toBuffer();

    console.log(`[Method 2] Uploading grayscale to Mistral...`);
    const grayUrl = await uploadFileToMistral(grayBuffer, `gray_${file}`, "image/jpeg");
    console.log(`[Method 2] Running OCR...`);
    const grayOcr = await runOcrStage(grayUrl);
    const grayParsed = normalizeOcrStructuredOutput(grayOcr);
    let grayFinal = grayParsed;
    if (!grayParsed.vin || grayParsed.vin.length !== 17) {
      grayFinal = await extractVehicleDetailsWithAI(grayOcr);
    }

    console.log(`RESULTS for ${file}:`);
    console.log(`COLOR PIPELINE:`, colorFinal, `(Chassis Length: ${colorFinal.vin?.length || 0})`);
    console.log(`GRAY PIPELINE:`, grayFinal, `(Chassis Length: ${grayFinal.vin?.length || 0})`);
    
    results.push({
      file,
      color: colorFinal,
      gray: grayFinal
    });
  }

  console.log("\n================ SUMMARY ================");
  console.table(results.map(r => ({
    File: r.file,
    "Color VIN": r.color.vin,
    "Color Engine": r.color.engine_number,
    "Gray VIN": r.gray.vin,
    "Gray Engine": r.gray.engine_number
  })));
}

testAll().catch(console.error);
