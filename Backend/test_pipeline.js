import fs from "fs";
import path from "path";
import { config } from "dotenv";
import sharp from "sharp";
import { createWorker } from "tesseract.js";
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
const STICKER_ONLY_INSTRUCTION = "The input is a close-up image of a vehicle identification sticker or manufacturer plate. Ignore unrelated scene content, geotagged metadata, and any non-sticker text. Extract only the requested identification fields.";

// Helper functions copied from server.js
function normalizeVehicleType(vehicleType = "") {
  const normalized = (vehicleType || "").toString().trim().toLowerCase();
  if (normalized.includes("2")) return "two_wheeler";
  if (normalized.includes("4")) return "four_wheeler";
  if (normalized.includes("commercial equipment")) return "commercial_equipment";
  if (normalized.includes("commercial vehicle")) return "commercial_vehicle";
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
      ocr4Prompt: `You are performing a second-pass OCR inspection on a two-wheeler image.`,
      llmPrompt: `You are validating OCR results using visual reasoning.`,
    }
  };
  return bundles[normalizedType] || bundles.two_wheeler;
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
    // fall back
  }

  const vinMatch = candidate.match(/\b[A-Za-z0-9]{17}\b/);
  if (vinMatch) result.vin = vinMatch[0].toUpperCase();

  const engineMatch = candidate.match(/engine(?:\s*number|\s*no\.?|\s*no)?\s*[:#-]?\s*([A-Za-z0-9\-\/\s]{2,30})/i);
  if (engineMatch && engineMatch[1]) result.engine_number = engineMatch[1].trim().replace(/\s+/g, " ");

  const fuelMatch = candidate.match(/\b(petrol|diesel|cng|lpg|electric|ev)\b/i);
  if (fuelMatch && fuelMatch[1]) result.fuel_type = fuelMatch[1].toLowerCase();

  return result;
}

async function extractVehicleDetailsWithAI(text, vehicleType = "") {
  const promptBundle = getVehiclePromptBundle(vehicleType);
  const vehicleContext = `\nVehicle type context: ${promptBundle.label}. Use this context to interpret the document and extract the correct VIN-related details.\n`;

  try {
    const response = await openai.chat.completions.create({
      model: "deepseek-chat",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `
You are a fallback extraction model for vehicle documents.${vehicleContext}

Return only the OCR-stage JSON shape with these fields:
{
  "vin": "",
  "engine_number": "",
  "fuel_type": ""
}

Use this category-specific fallback prompt:
${promptBundle.llmPrompt}

Rules:
- Return only valid JSON.
- VIN should be 17 characters when present.
- If no confident value exists, return an empty string.
- Keep the other final-stage fields empty for later enrichment.
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
  const urlResponse = await axios.get(
    `https://api.mistral.ai/v1/files/${fileId}/url`,
    { headers: { Authorization: `Bearer ${MISTRAL_API_KEY}` } }
  );

  return urlResponse.data.url;
}

async function runOcrStage(fileUrl, modelName, stageName, vehicleType = "") {
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

// Replicate cropping logic
async function cropVehicleImageBuffer(filename, buffer) {
  console.log(`[Cropping] Processing image file: ${filename}`);
  try {
    const image = sharp(buffer);
    const metadata = await image.metadata();
    const width = metadata.width;
    const height = metadata.height;

    // Step 1: Divide image into Working Region (top 75%) and Watermark Region (bottom 25%)
    const workingHeight = Math.round(height * 0.75);

    const workingBuffer = await image
      .clone()
      .extract({ left: 0, top: 0, width: width, height: workingHeight })
      .toBuffer();

    // Step 2: Upscale 2x and preprocess (grayscale + normalize + sharpen) to detect small text
    const preprocessedBuffer = await sharp(workingBuffer)
      .greyscale()
      .resize(width * 2, workingHeight * 2, { kernel: sharp.kernel.lanczos3 })
      .normalize()
      .sharpen()
      .toBuffer();

    const isValidWord = (word) => {
      const cleanText = word.text.replace(/[^A-Za-z0-9]/g, '');
      return cleanText.length >= 2 && word.confidence > 30;
    };

    let minX = width;
    let minY = workingHeight;
    let maxX = 0;
    let maxY = 0;
    let foundValidText = false;

    // Pass 1: Horizontal text (0 degrees)
    console.log(`[Cropping] Running Pass 1 (Horizontal) for ${filename}`);
    const workerH = await createWorker('eng');
    const { data: horizontalData } = await workerH.recognize(preprocessedBuffer, {}, { blocks: true });
    await workerH.terminate();

    if (horizontalData && horizontalData.blocks) {
      for (const block of horizontalData.blocks) {
        if (block.paragraphs) {
          for (const para of block.paragraphs) {
            if (para.lines) {
              for (const line of para.lines) {
                if (line.words) {
                  for (const word of line.words) {
                    if (isValidWord(word)) {
                      const { x0, y0, x1, y1 } = word.bbox;
                      const origX0 = Math.round(x0 / 2);
                      const origY0 = Math.round(y0 / 2);
                      const origX1 = Math.round(x1 / 2);
                      const origY1 = Math.round(y1 / 2);

                      if (origX0 < minX) minX = origX0;
                      if (origY0 < minY) minY = origY0;
                      if (origX1 > maxX) maxX = origX1;
                      if (origY1 > maxY) maxY = origY1;
                      foundValidText = true;
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    // Pass 2: Rotated 90 degrees clockwise
    console.log(`[Cropping] Running Pass 2 (Rotated 90) for ${filename}`);
    const rotated90 = await sharp(preprocessedBuffer).rotate(90).toBuffer();
    const workerRot90 = await createWorker('eng');
    const { data: vert90Data } = await workerRot90.recognize(rotated90, {}, { blocks: true });
    await workerRot90.terminate();

    if (vert90Data && vert90Data.blocks) {
      for (const block of vert90Data.blocks) {
        if (block.paragraphs) {
          for (const para of block.paragraphs) {
            if (para.lines) {
              for (const line of para.lines) {
                if (line.words) {
                  for (const word of line.words) {
                    if (isValidWord(word)) {
                      const { x0: rx0, y0: ry0, x1: rx1, y1: ry1 } = word.bbox;
                      const origRx0 = rx0 / 2;
                      const origRy0 = ry0 / 2;
                      const origRx1 = rx1 / 2;
                      const origRy1 = ry1 / 2;

                      // Map back to original coordinate system
                      const x0 = origRy0;
                      const x1 = origRy1;
                      const y0 = workingHeight - origRx1;
                      const y1 = workingHeight - origRx0;

                      if (x0 < minX) minX = x0;
                      if (y0 < minY) minY = y0;
                      if (x1 > maxX) maxX = x1;
                      if (y1 > maxY) maxY = y1;
                      foundValidText = true;
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    // Pass 3: Rotated 270 degrees clockwise (90 degrees counter-clockwise)
    console.log(`[Cropping] Running Pass 3 (Rotated 270) for ${filename}`);
    const rotated270 = await sharp(preprocessedBuffer).rotate(270).toBuffer();
    const workerRot270 = await createWorker('eng');
    const { data: vert270Data } = await workerRot270.recognize(rotated270, {}, { blocks: true });
    await workerRot270.terminate();

    if (vert270Data && vert270Data.blocks) {
      for (const block of vert270Data.blocks) {
        if (block.paragraphs) {
          for (const para of block.paragraphs) {
            if (para.lines) {
              for (const line of para.lines) {
                if (line.words) {
                  for (const word of line.words) {
                    if (isValidWord(word)) {
                      const { x0: rx0, y0: ry0, x1: rx1, y1: ry1 } = word.bbox;
                      const origRx0 = rx0 / 2;
                      const origRy0 = ry0 / 2;
                      const origRx1 = rx1 / 2;
                      const origRy1 = ry1 / 2;

                      // Map back to original coordinate system
                      const x0 = width - origRy1;
                      const x1 = width - origRy0;
                      const y0 = origRx0;
                      const y1 = origRx1;

                      if (x0 < minX) minX = x0;
                      if (y0 < minY) minY = y0;
                      if (x1 > maxX) maxX = x1;
                      if (y1 > maxY) maxY = y1;
                      foundValidText = true;
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    let cropX, cropY, cropW, cropH;

    if (foundValidText) {
      const padding = 80;
      cropX = Math.max(0, minX - padding);
      cropY = Math.max(0, minY - padding);
      cropW = Math.min(width - cropX, (maxX - minX) + (padding * 2));
      cropH = Math.min(workingHeight - cropY, (maxY - minY) + (padding * 2));
      console.log(`[Cropping] Calculated text bounding box for ${filename}: Left: ${cropX}, Top: ${cropY}, Width: ${cropW}, Height: ${cropH}`);
    } else {
      cropX = 0;
      cropY = 0;
      cropW = width;
      cropH = workingHeight;
      console.log(`[Cropping] No text detected for ${filename}. Using the full working region.`);
    }

    // Step 4: Crop the text region, convert to black & white (grayscale), normalize contrast, sharpen, and export as JPEG
    const finalImageBuffer = await sharp(buffer)
      .extract({ left: cropX, top: cropY, width: cropW, height: cropH })
      .greyscale()
      .normalize()
      .sharpen()
      .jpeg()
      .toBuffer();

    console.log(`[Cropping] Successfully cropped image: ${filename}`);
    return { buffer: finalImageBuffer, cropX, cropY, cropW, cropH };

  } catch (err) {
    console.error(`[Cropping] Error cropping ${filename}:`, err.stack);
    return { buffer, cropX: 0, cropY: 0, cropW: 0, cropH: 0 };
  }
}

async function testImages() {
  const images = [
    { name: "Ather Energy.jpg", path: "../Two Wheelers/Ather Energy.jpg", mime: "image/jpeg" },
    { name: "TVS.jpeg", path: "../Two Wheelers/TVS.jpeg", mime: "image/jpeg" },
    { name: "Yamaha (1).jpeg", path: "../Two Wheelers/Yamaha (1).jpeg", mime: "image/jpeg" }
  ];

  for (const img of images) {
    console.log(`\n========================================`);
    console.log(`Testing image: ${img.name}`);
    const filePath = path.resolve(img.path);
    if (!fs.existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      continue;
    }

    const fileBuffer = fs.readFileSync(filePath);
    
    // Step 1: Crop
    const { buffer: croppedBuffer, cropX, cropY, cropW, cropH } = await cropVehicleImageBuffer(img.name, fileBuffer);
    
    // Save cropped buffer to disk to manually inspect
    const croppedFilename = `cropped_${img.name}`;
    fs.writeFileSync(croppedFilename, croppedBuffer);
    console.log(`Saved cropped image to ${croppedFilename}`);

    // Step 2: Upload to Mistral
    try {
      console.log(`Uploading to Mistral...`);
      const url = await uploadFileToMistral(croppedBuffer, img.name, img.mime);
      console.log(`Signed URL: ${url}`);

      // Step 3: Run OCR
      console.log(`Running Mistral OCR...`);
      const ocrText = await runOcrStage(url, OCR_3_MODEL, "ocr3", "two_wheeler");
      console.log(`OCR Raw Output (first 300 chars):\n${ocrText.slice(0, 300)}...`);

      // Step 4: Parse
      const parsed = normalizeOcrStructuredOutput(ocrText);
      console.log("Parsed OCR:", parsed);

      // Step 5: Fallback LLM if failed
      if (!isExtractionSuccessful(parsed)) {
        console.log("Extraction unsuccessful. Running DeepSeek Fallback...");
        const fallback = await extractVehicleDetailsWithAI(ocrText, "two_wheeler");
        console.log("Fallback Result:", fallback);
      } else {
        console.log("Extraction Successful!");
      }
    } catch (err) {
      console.error(`Error processing ${img.name}:`, err.message);
      if (err.response) {
        console.error("Response data:", err.response.data);
      }
    }
  }
}

testImages().catch(console.error);
