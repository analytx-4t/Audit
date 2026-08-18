import fs from 'fs';
import path from 'path';
import axios from 'axios';
import FormData from 'form-data';
import { config } from 'dotenv';

config();

const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;

async function uploadFileToMistral(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);
  
  const formData = new FormData();
  formData.append('file', fileBuffer, {
    filename: fileName,
    contentType: 'image/jpeg',
  });
  formData.append('purpose', 'ocr');

  const uploadResponse = await axios.post(
    'https://api.mistral.ai/v1/files',
    formData,
    {
      headers: {
        ...formData.getHeaders(),
        Authorization: `Bearer ${MISTRAL_API_KEY}`,
      },
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
        await new Promise((r) => setTimeout(r, 2000));
      } else {
        throw err;
      }
    }
  }
}

async function runMistralOcr(fileUrl) {
  const ocrResponse = await axios.post(
    'https://api.mistral.ai/v1/ocr',
    {
      model: 'mistral-ocr-latest',
      document: { type: 'document_url', document_url: fileUrl },
    },
    {
      headers: {
        Authorization: `Bearer ${MISTRAL_API_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );

  return ocrResponse.data.pages?.[0]?.markdown || '';
}

async function testMistralRaw() {
  const renamedDir = `C:\\Users\\hp\\Downloads\\1_Result\\renamed_images`;
  const failedDir = `C:\\Users\\hp\\Downloads\\1_Result\\failed`;

  const testFiles = [
    { file: 'IMG_053.jpeg', expected: 'MA3SFM61STF515152', dir: renamedDir },
    { file: 'IMG_092.jpeg', expected: 'MA3ZFDFSKTE486453', dir: renamedDir },
    { file: 'IMG_095.jpeg', expected: 'MA3ZFDFSKTF514249', dir: renamedDir },
    { file: 'IMG_101.jpeg', expected: 'MA3ZFDFSKTF513875', dir: renamedDir },
    { file: 'IMG_109.jpeg', expected: 'MA3ZFDFSKTF497213', dir: renamedDir },
    { file: 'IMG_115.jpeg', expected: 'MA3BNC72STFD29828', dir: renamedDir },
    { file: 'IMG_135.jpeg', expected: 'MA3BNC72STFD22264', dir: renamedDir },
    { file: 'IMG_136.jpeg', expected: 'MA3BNC62STFD22254', dir: renamedDir },
    { file: 'IMG_185.jpeg', expected: 'MA3ZFDFSKTC427216', dir: renamedDir },
    { file: 'IMG_195.jpeg', expected: 'MA3SFM61STC481197', dir: renamedDir },
    { file: 'IMG_230.jpeg', expected: 'MA3JDT08WTEG24605', dir: renamedDir },
    // Also test 3 failed images
    { file: 'IMG_005.jpeg', expected: 'Check raw text', dir: failedDir },
    { file: 'IMG_006.jpeg', expected: 'Check raw text', dir: failedDir },
    { file: 'IMG_054.jpeg', expected: 'Check raw text', dir: failedDir },
  ];

  console.log(`Testing Mistral OCR on raw full-resolution images...\n`);

  for (const item of testFiles) {
    const filePath = path.join(item.dir, item.file);
    if (!fs.existsSync(filePath)) {
      console.log(`Skipping ${item.file} (not found)`);
      continue;
    }

    try {
      console.log(`Processing ${item.file}...`);
      const fileUrl = await uploadFileToMistral(filePath);
      const markdownText = await runMistralOcr(fileUrl);
      console.log(`--- Result for ${item.file} ---`);
      console.log(`Expected VIN: ${item.expected}`);
      console.log(`Mistral OCR Raw Output:\n${markdownText.trim()}\n`);
    } catch (err) {
      console.error(`Error processing ${item.file}:`, err.message);
    }
  }
}

testMistralRaw().catch(console.error);
