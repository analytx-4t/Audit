import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import { config } from 'dotenv';
import { createWorker } from 'tesseract.js';
import sharp from 'sharp';
import ExcelJS from 'exceljs';

config();

const openai = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com',
});

// ISO 3779 Post-correction helper
function postCorrectVin(vin) {
  if (!vin) return '';
  let v = vin.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (v.length !== 17) return v;

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

  // 4. Pos 10 (Model Year - Index 9) MUST BE A LETTER (e.g., S, T, R, P, N)
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

async function refineOcrWithDeepSeek(rawOcrText) {
  const prompt = `You are an expert Indian Vehicle Identification (VIN) Auditor.
Extract the 17-character Vehicle Identification Number (VIN / Chassis Number) and Engine Number from noisy OCR text.

Rules:
1. Indian VINs are 17 characters long (e.g., starting with MA3, MAL, NAG, MA1, MAT, ME4, etc.).
2. Pay close attention to subtle OCR misreads:
   - '8' vs 'B' (e.g. MA38NC -> MA3BNC)
   - '5' vs 'S' (e.g. STFD22264 vs 5TFD22264)
   - '3' vs 'S' (e.g. MASZFDF -> MA3ZFDF)
   - 'ES' vs 'FS' (e.g. MA3ZFDESK -> MA3ZFDFSK)
   - 'SENG' vs 'SFM61' (e.g. MA3SENG1 -> MA3SFM61)
   - 'MARJOTUR' vs 'MA3JDT08'
3. Return ONLY a strict JSON object:
{
  "vin": "17-CHARACTER-VIN-OR-EMPTY",
  "engine_number": "ENGINE-NUMBER-OR-EMPTY"
}`;

  try {
    const response = await openai.chat.completions.create({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: `Raw OCR Text:\n${rawOcrText}` },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    });

    const parsed = JSON.parse(response.choices[0].message.content);
    return {
      vin: postCorrectVin(parsed.vin || ''),
      engine_number: parsed.engine_number || '',
    };
  } catch (err) {
    console.error('DeepSeek Error:', err.message);
    return { vin: '', engine_number: '' };
  }
}

async function testDeepSeekPipeline() {
  const excelPath = `C:\\Users\\hp\\Downloads\\1_Result\\vehicles.xlsx`;
  const renamedDir = `C:\\Users\\hp\\Downloads\\1_Result\\renamed_images`;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(excelPath);
  const sheet = workbook.getWorksheet(1);

  const worker = await createWorker('eng');

  console.log("Testing Multi-pass OCR + DeepSeek Refinement + ISO 3779 Corrector...\n");

  let matchCount = 0;
  let totalGtCount = 0;

  for (let rowNum = 2; rowNum <= sheet.rowCount; rowNum++) {
    const row = sheet.getRow(rowNum);
    const file = row.getCell(1).value ? String(row.getCell(1).value).trim() : '';
    const colB = row.getCell(2).value ? String(row.getCell(2).value).trim() : '';
    const colF = row.getCell(6).value ? String(row.getCell(6).value).trim() : '';

    if (!colF && !colB) continue; // Skip empty rows for now

    const expectedVin = colF || colB;
    totalGtCount++;

    const filePath = path.join(renamedDir, file);
    if (!fs.existsSync(filePath)) continue;

    const buffer = fs.readFileSync(filePath);
    const meta = await sharp(buffer).metadata();

    // Multi-pass OCR: Normal, Inverted, Upscaled
    const procNormal = await sharp(buffer).rotate().greyscale().normalize().sharpen().toBuffer();
    const procInv = await sharp(buffer).rotate().greyscale().negate().normalize().sharpen().toBuffer();

    const resNorm = await worker.recognize(procNormal);
    const resInv = await worker.recognize(procInv);

    const combinedOcrText = `Pass 1 (Normal):\n${resNorm.data.text}\n\nPass 2 (Inverted):\n${resInv.data.text}`;

    const deepSeekResult = await refineOcrWithDeepSeek(combinedOcrText);

    const isExactMatch = deepSeekResult.vin === expectedVin;
    if (isExactMatch) matchCount++;

    console.log(`[Row ${rowNum}] ${file}:`);
    console.log(`  Raw Col B:     ${colB}`);
    console.log(`  Extracted VIN: ${deepSeekResult.vin}`);
    console.log(`  Expected VIN:  ${expectedVin}`);
    console.log(`  Match Status:  ${isExactMatch ? '✅ MATCH' : '❌ MISMATCH'}\n`);

    if (totalGtCount >= 15) break; // Test first 15 for speed
  }

  await worker.terminate();
  console.log(`Matched ${matchCount} out of ${totalGtCount} tested rows!`);
}

testDeepSeekPipeline().catch(console.error);
