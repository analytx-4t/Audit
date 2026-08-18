import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import ExcelJS from 'exceljs';

// Load vehicles.xlsx ground truth mapping
async function loadGroundTruth() {
  const excelPath = `C:\\Users\\hp\\Downloads\\1_Result\\vehicles.xlsx`;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(excelPath);
  const sheet = workbook.getWorksheet(1);

  const map = new Map();
  sheet.eachRow((row, rowNum) => {
    if (rowNum === 1) return;
    const file = row.getCell(1).value ? String(row.getCell(1).value).trim() : '';
    const colB = row.getCell(2).value ? String(row.getCell(2).value).trim() : '';
    const colF = row.getCell(6).value ? String(row.getCell(6).value).trim() : '';
    
    // Ground truth is in Col F, or if Col F is empty, Col B if valid
    const truth = colF || colB;
    if (file) {
      map.set(file, { colB, colF, truth });
    }
  });
  return map;
}

// Basic regex patterns for Indian VIN / Chassis / Engine numbers
function findVinCandidates(text) {
  if (!text) return [];
  const clean = text.replace(/[^A-Z0-9\s]/gi, ' ').toUpperCase();
  const tokens = clean.split(/\s+/).filter(Boolean);

  const candidates = [];
  // 17-character VIN pattern (Starts with M, N, L, R, P, K, etc. and length 17)
  const vinRegex17 = /\b[A-Z0-9]{17}\b/g;
  let match;
  while ((match = vinRegex17.exec(clean)) !== null) {
    candidates.push(match[0]);
  }

  // Also look for 14-20 length concatenated alphanumeric blocks
  const generalVin = /\b([M][A-Z0-9]{16})\b/g;
  while ((match = generalVin.exec(clean)) !== null) {
    if (!candidates.includes(match[1])) candidates.push(match[1]);
  }

  return candidates;
}

async function runOcrExperiment() {
  const gtMap = await loadGroundTruth();
  const worker = await createWorker('eng');
  
  const failedDir = `C:\\Users\\hp\\Downloads\\1_Result\\failed`;
  const files = fs.readdirSync(failedDir).filter(f => /\.(jpg|jpeg|png)$/i.test(f)).slice(0, 15);

  console.log(`Testing OCR preprocessing on ${files.length} failed sample images...\n`);

  for (const file of files) {
    const filePath = path.join(failedDir, file);
    const buffer = fs.readFileSync(filePath);
    const meta = await sharp(buffer).metadata();

    const gt = gtMap.get(file) || { truth: 'UNKNOWN' };

    console.log(`====================================================`);
    console.log(`IMAGE: ${file} (Dimensions: ${meta.width}x${meta.height})`);
    console.log(`Ground Truth / Excel VIN: ${gt.truth}`);

    // Try several preprocessing techniques
    // 1. Raw image
    const resRaw = await worker.recognize(buffer);
    const candRaw = findVinCandidates(resRaw.data.text);
    console.log(`[Raw] Candidates:`, candRaw.length ? candRaw : 'NONE FOUND');
    if (resRaw.data.text.trim()) {
      console.log(`[Raw Text Sample]: ${resRaw.data.text.replace(/\n+/g, ' | ').slice(0, 150)}`);
    }

    // 2. Deskew / Normalization / High Contrast / Sharpening
    const processedBuf = await sharp(buffer)
      .rotate()
      .greyscale()
      .normalize()
      .linear(1.5, -30) // Increase contrast
      .sharpen({ sigma: 1.5 })
      .toBuffer();

    const resProc = await worker.recognize(processedBuf);
    const candProc = findVinCandidates(resProc.data.text);
    console.log(`[Contrast/Sharpen] Candidates:`, candProc.length ? candProc : 'NONE FOUND');
    if (resProc.data.text.trim()) {
      console.log(`[Proc Text Sample]: ${resProc.data.text.replace(/\n+/g, ' | ').slice(0, 150)}`);
    }

    // 3. Rotations (90, 180, 270 degrees)
    for (const angle of [90, 180, 270]) {
      const rotBuf = await sharp(processedBuf).rotate(angle).toBuffer();
      const resRot = await worker.recognize(rotBuf);
      const candRot = findVinCandidates(resRot.data.text);
      if (candRot.length) {
        console.log(`[Rotated ${angle}°] Candidates:`, candRot);
      }
    }
  }

  await worker.terminate();
}

runOcrExperiment().catch(console.error);
