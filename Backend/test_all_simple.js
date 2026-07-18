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

async function extractVehicleDetailsWithAI(text) {
  try {
    const response = await openai.chat.completions.create({
      model: "deepseek-chat",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `
You are a highly precise OCR extraction engine for Indian vehicle documents and chassis images.
Locate the VIN / Chassis number, engine number, and fuel type from the OCR text.

STRICT RULES FOR VIN (CHASSIS NUMBER):
- A valid Indian VIN is EXACTLY 17 characters long, uppercase, alphanumeric.
- It never contains spaces, hyphens, or special characters.
- If the OCR text has noise at the start or end (e.g., "NXE4KC407KSG1787746" or "AXEL40407KSG178774E"), carefully extract the core 17-character VIN (e.g., "AE4KC407KSG178774").
- Never invent/hallucinate a VIN. If no 17-character sequence (or near sequence that can be corrected to 17 characters) is visible in the OCR text, leave "vin" as "".
- Double check that the "vin" you output is exactly 17 characters long. If it is not 17 characters, do not output it.

STRICT RULES FOR ENGINE NUMBER:
- Extract only if explicitly labelled (e.g., Engine No, ENG NO, etc.). Otherwise leave as "".

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
      vin: (parsed.vin || "").trim().toUpperCase(),
      engine_number: (parsed.engine_number || "").trim(),
      fuel_type: (parsed.fuel_type || "").trim(),
    };
  } catch (error) {
    console.error("LLM fallback extraction failed:", error.message);
    return { vin: "", engine_number: "", fuel_type: "" };
  }
}

async function simpleCropping(filename, buffer) {
  try {
    const image = sharp(buffer);
    const metadata = await image.metadata();
    const width = metadata.width;
    const height = metadata.height;

    // Crop top 85% to remove watermark
    const cropHeight = Math.round(height * 0.85);

    // Keep it grayscale, normalize, sharpen for high contrast
    const processedBuffer = await image
      .extract({ left: 0, top: 0, width: width, height: cropHeight })
      .greyscale()
      .normalize()
      .sharpen()
      .jpeg()
      .toBuffer();

    return processedBuffer;
  } catch (err) {
    console.error(`[Simple Cropping] Error processing ${filename}:`, err.message);
    return buffer;
  }
}

async function testAll() {
  const dirPath = "../Two Wheelers";
  const files = fs.readdirSync(dirPath).filter(f => f.toLowerCase().endsWith(".jpg") || f.toLowerCase().endsWith(".jpeg"));
  
  console.log(`Found ${files.length} images to test.`);

  const results = [];

  for (const file of files) {
    console.log(`\n--------------------------------------------`);
    console.log(`Processing: ${file}`);
    const filePath = path.join(dirPath, file);
    const originalBuffer = fs.readFileSync(filePath);

    const simpBuffer = await simpleCropping(file, originalBuffer);
    const simpUrl = await uploadFileToMistral(simpBuffer, `simp_${file}`, "image/jpeg");
    const simpOcr = await runOcrStage(simpUrl);
    
    // Parse using basic regex first
    const basicParsed = {
      vin: "",
      engine_number: "",
      fuel_type: ""
    };
    const vinMatch = simpOcr.match(/\b[A-Za-z0-9]{17}\b/);
    if (vinMatch) basicParsed.vin = vinMatch[0].toUpperCase();

    const engineMatch = simpOcr.match(/engine(?:\s*number|\s*no\.?|\s*no)?\s*[:#-]?\s*([A-Za-z0-9\-\/\s]{2,30})/i);
    if (engineMatch && engineMatch[1]) basicParsed.engine_number = engineMatch[1].trim().replace(/\s+/g, " ");

    const fuelMatch = simpOcr.match(/\b(petrol|diesel|cng|lpg|electric|ev)\b/i);
    if (fuelMatch && fuelMatch[1]) basicParsed.fuel_type = fuelMatch[1].toLowerCase();

    let finalResult = basicParsed;
    let fallbackUsed = false;
    
    if (!basicParsed.vin || basicParsed.vin.length !== 17) {
      fallbackUsed = true;
      finalResult = await extractVehicleDetailsWithAI(simpOcr);
    }

    console.log(`RESULTS for ${file} (Fallback used: ${fallbackUsed}):`);
    console.log(finalResult);

    results.push({
      file,
      vin: finalResult.vin,
      engine: finalResult.engine_number,
      fallbackUsed
    });
  }

  console.log("\n================ SUMMARY ================");
  console.table(results);
}

testAll().catch(console.error);
