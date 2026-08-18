import fs from 'fs';
import path from 'path';
import axios from 'axios';
import FormData from 'form-data';
import { config } from 'dotenv';
import ExcelJS from 'exceljs';

config();

const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;

function postCorrectVin(vin) {
  if (!vin) return '';
  let v = vin.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (v.length !== 17) return vin;

  let c = v.split('');

  // 1. WMI (Pos 1-3)
  if (c[0] === 'M' && c[1] === 'A') {
    if (c[2] === 'S' || c[2] === 'B' || c[2] === 'R') c[2] = '3';
  }

  // 2. Pos 4 (Index 3) in Maruti MA3BNC -> if '8', make 'B'
  if (c[0] === 'M' && c[1] === 'A' && c[2] === '3' && c[3] === '8') {
    c[3] = 'B';
  }

  // 3. Pos 8 (Index 7) in MA3BNC72STFD... if '5', make 'S'
  if (c[0] === 'M' && c[1] === 'A' && c[2] === '3' && c[7] === '5') {
    c[7] = 'S';
  }

  // 4. Pos 10 (Model Year - Index 9) MUST BE A LETTER (e.g. S, T, R, P, N)
  if (/[0-9]/.test(c[9])) {
    if (c[9] === '5') c[9] = 'S';
    else if (c[9] === '8') c[9] = 'B';
    else if (c[9] === '0') c[9] = 'O';
  }

  // 5. Pos 12-17 (Sequential Serial - Index 11-16) MUST BE 6 DIGITS (0-9)
  for (let i = 11; i < 17; i++) {
    if (/[A-Z]/.test(c[i])) {
      if (c[i] === 'S') c[i] = '5';
      else if (c[i] === 'B') c[i] = '8';
      else if (c[i] === 'O' || c[i] === 'Q' || c[i] === 'D') c[i] = '0';
      else if (c[i] === 'I' || c[i] === 'L') c[i] = '1';
      else if (c[i] === 'Z') c[i] = '2';
      else if (c[i] === 'G') c[i] = '6';
    }
  }

  return c.join('');
}

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

function extractVinFromMarkdown(markdownText) {
  if (!markdownText) return '';
  const cleanText = markdownText.replace(/[^A-Z0-9]/gi, ' ').toUpperCase();
  const tokens = cleanText.split(/\s+/).filter(t => t.length >= 14 && t.length <= 18);
  
  // Find candidates starting with M, N, L, P, R, etc.
  for (const t of tokens) {
    if (t.length === 17) return postCorrectVin(t);
  }
  return tokens[0] ? postCorrectVin(tokens[0]) : '';
}

async function testMistralGtCorrector() {
  const excelPath = `C:\\Users\\hp\\Downloads\\1_Result\\vehicles.xlsx`;
  const renamedDir = `C:\\Users\\hp\\Downloads\\1_Result\\renamed_images`;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(excelPath);
  const sheet = workbook.getWorksheet(1);

  const problemRows = [];
  sheet.eachRow((row, rowNum) => {
    if (rowNum === 1) return;
    const file = row.getCell(1).value ? String(row.getCell(1).value).trim() : '';
    const vinColB = row.getCell(2).value ? String(row.getCell(2).value).trim() : '';
    const groundTruthColF = row.getCell(6).value ? String(row.getCell(6).value).trim() : '';

    if (groundTruthColF) {
      problemRows.push({ rowNum, file, vinColB, groundTruthColF });
    }
  });

  console.log(`Testing Mistral OCR + Post Corrector on all ${problemRows.length} ground truth problem rows...\n`);

  let matched = 0;
  for (const item of problemRows) {
    const filePath = path.join(renamedDir, item.file);
    if (!fs.existsSync(filePath)) {
      console.log(`Skipping ${item.file} (not found)`);
      continue;
    }

    try {
      const fileUrl = await uploadFileToMistral(filePath);
      const markdownText = await runMistralOcr(fileUrl);
      const extracted = extractVinFromMarkdown(markdownText);
      const isMatch = extracted === item.groundTruthColF;

      if (isMatch) matched++;

      console.log(`[Row ${item.rowNum}] ${item.file}:`);
      console.log(`  Current Excel (Col B): ${item.vinColB}`);
      console.log(`  Mistral+Corrector:     ${extracted}`);
      console.log(`  Ground Truth (Col F):  ${item.groundTruthColF}`);
      console.log(`  Status:                ${isMatch ? '✅ MATCHED!' : '❌ MISMATCH'}\n`);
    } catch (err) {
      console.error(`Error on ${item.file}:`, err.message);
    }
  }

  console.log(`Summary: Matched ${matched} out of ${problemRows.length} problem rows!`);
}

testMistralGtCorrector().catch(console.error);
