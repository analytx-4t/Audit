import fs from "fs";
import path from "path";
import { config } from "dotenv";
import sharp from "sharp";
import axios from "axios";
import FormData from "form-data";

config();

const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
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

async function test() {
  const images = [
    { name: "Ather Energy.jpg", path: "../Two Wheelers/Ather Energy.jpg" },
    { name: "Hero Motocorp.jpg", path: "../Two Wheelers/Hero Motocorp.jpg" },
    { name: "Honda 2 Wheeler (1).jpeg", path: "../Two Wheelers/Honda 2 Wheeler (1).jpeg" }
  ];

  for (const img of images) {
    console.log(`\n========================================`);
    console.log(`Image: ${img.name}`);
    const originalBuffer = fs.readFileSync(path.resolve(img.path));
    const metadata = await sharp(originalBuffer).metadata();
    const cropHeight = Math.round(metadata.height * 0.80);
    
    // Grayscale + contrast cropped top 80%
    const grayBuffer = await sharp(originalBuffer)
      .extract({ left: 0, top: 0, width: metadata.width, height: cropHeight })
      .greyscale()
      .normalize()
      .sharpen()
      .toBuffer();

    const url = await uploadFileToMistral(grayBuffer, `gray_${img.name}`, "image/jpeg");
    const ocrText = await runOcrStage(url);
    console.log("RAW OCR MARKDOWN:");
    console.log(ocrText);
  }
}

test().catch(console.error);
