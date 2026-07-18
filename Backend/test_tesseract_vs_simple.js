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

function normalizeOcrStructuredOutput(text = "") {
  const candidate = (text || "").trim();
  const result = {
    vin: "",
    engine_number: "",
    fuel_type: "",
  };

  if (!candidate) return result;

  const vinMatch = candidate.match(/\b[A-Za-z0-9]{17}\b/);
  if (vinMatch) result.vin = vinMatch[0].toUpperCase();

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
Locate the VIN / Chassis number, engine number, and fuel type.
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

// 1. Tesseract Cropping method
async function tesseractCropping(filename, buffer) {
  try {
    const image = sharp(buffer);
    const metadata = await image.metadata();
    const width = metadata.width;
    const height = metadata.height;

    const workingHeight = Math.round(height * 0.75);
    const workingBuffer = await image
      .clone()
      .extract({ left: 0, top: 0, width: width, height: workingHeight })
      .toBuffer();

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

    // Pass 1: Horizontal
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

    // Pass 2: Rotated 90
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

    // Pass 3: Rotated 270
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
      cropX = Math.round(Math.max(0, minX - padding));
      cropY = Math.round(Math.max(0, minY - padding));
      cropW = Math.round(Math.min(width - cropX, (maxX - minX) + (padding * 2)));
      cropH = Math.round(Math.min(workingHeight - cropY, (maxY - minY) + (padding * 2)));
    } else {
      cropX = 0;
      cropY = 0;
      cropW = width;
      cropH = workingHeight;
    }

    const finalImageBuffer = await sharp(buffer)
      .extract({ left: cropX, top: cropY, width: cropW, height: cropH })
      .greyscale()
      .normalize()
      .sharpen()
      .jpeg()
      .toBuffer();

    return finalImageBuffer;
  } catch (err) {
    console.error(`[Tesseract Cropping] Error cropping ${filename}:`, err.message);
    return buffer;
  }
}

// 2. Simple Top 85% method
async function simpleCropping(filename, buffer) {
  try {
    const image = sharp(buffer);
    const metadata = await image.metadata();
    const width = metadata.width;
    const height = metadata.height;

    // Crop top 85% to remove bottom watermark
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

  // Let's test first 4 images to get a solid sample (Ather Energy, Hero Motocorp, Honda 2 Wheeler (1), Honda 2 Wheeler (2))
  const filesToTest = files.slice(0, 4);

  for (const file of filesToTest) {
    console.log(`\n--------------------------------------------`);
    console.log(`Processing: ${file}`);
    const filePath = path.join(dirPath, file);
    const originalBuffer = fs.readFileSync(filePath);

    // 1. Tesseract Cropping
    console.log(`[Tesseract Method] Cropping...`);
    const tessBuffer = await tesseractCropping(file, originalBuffer);
    console.log(`[Tesseract Method] Uploading to Mistral...`);
    const tessUrl = await uploadFileToMistral(tessBuffer, `tess_${file}`, "image/jpeg");
    console.log(`[Tesseract Method] Running OCR...`);
    const tessOcr = await runOcrStage(tessUrl);
    const tessParsed = normalizeOcrStructuredOutput(tessOcr);
    let tessFinal = tessParsed;
    if (!tessParsed.vin || tessParsed.vin.length !== 17) {
      tessFinal = await extractVehicleDetailsWithAI(tessOcr);
    }

    // 2. Simple Cropping
    console.log(`[Simple Method] Processing...`);
    const simpBuffer = await simpleCropping(file, originalBuffer);
    console.log(`[Simple Method] Uploading to Mistral...`);
    const simpUrl = await uploadFileToMistral(simpBuffer, `simp_${file}`, "image/jpeg");
    console.log(`[Simple Method] Running OCR...`);
    const simpOcr = await runOcrStage(simpUrl);
    const simpParsed = normalizeOcrStructuredOutput(simpOcr);
    let simpFinal = simpParsed;
    if (!simpParsed.vin || simpParsed.vin.length !== 17) {
      simpFinal = await extractVehicleDetailsWithAI(simpOcr);
    }

    console.log(`RESULTS for ${file}:`);
    console.log(`TESSERACT METHOD:`, tessFinal);
    console.log(`SIMPLE METHOD:   `, simpFinal);

    results.push({
      file,
      tess: tessFinal,
      simp: simpFinal
    });
  }

  console.log("\n================ SUMMARY ================");
  console.table(results.map(r => ({
    File: r.file,
    "Tess VIN": r.tess.vin,
    "Tess Engine": r.tess.engine_number,
    "Simple VIN": r.simp.vin,
    "Simple Engine": r.simp.engine_number
  })));
}

testAll().catch(console.error);
