import fs from "fs";
import path from "path";
import { config } from "dotenv";
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
  const filePath = path.resolve("../Two Wheelers/Hero Motocorp.jpg");
  const originalBuffer = fs.readFileSync(filePath);

  const url = await uploadFileToMistral(originalBuffer, `orig_Hero Motocorp.jpg`, "image/jpeg");
  const ocrText = await runOcrStage(url);
  console.log("RAW OCR MARKDOWN FOR ORIGINAL HERO MOTOCORP.JPG:");
  console.log(ocrText);
}

test().catch(console.error);
