import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';

async function testTesseractCrops() {
  const renamedDir = `C:\\Users\\hp\\Downloads\\1_Result\\renamed_images`;
  const failedDir = `C:\\Users\\hp\\Downloads\\1_Result\\failed`;

  const worker = await createWorker('eng');

  const testCases = [
    { file: 'IMG_053.jpeg', expected: 'MA3SFM61STF515152', dir: renamedDir },
    { file: 'IMG_095.jpeg', expected: 'MA3ZFDFSKTF514249', dir: renamedDir },
    { file: 'IMG_101.jpeg', expected: 'MA3ZFDFSKTF513875', dir: renamedDir },
    { file: 'IMG_109.jpeg', expected: 'MA3ZFDFSKTF497213', dir: renamedDir },
    { file: 'IMG_115.jpeg', expected: 'MA3BNC72STFD29828', dir: renamedDir },
    { file: 'IMG_135.jpeg', expected: 'MA3BNC72STFD22264', dir: renamedDir },
    { file: 'IMG_136.jpeg', expected: 'MA3BNC62STFD22254', dir: renamedDir },
    { file: 'IMG_185.jpeg', expected: 'MA3ZFDFSKTC427216', dir: renamedDir },
    { file: 'IMG_195.jpeg', expected: 'MA3SFM61STC481197', dir: renamedDir },
    { file: 'IMG_230.jpeg', expected: 'MA3JDT08WTEG24605', dir: renamedDir },
    { file: 'IMG_005.jpeg', expected: 'Check failed img', dir: failedDir },
    { file: 'IMG_006.jpeg', expected: 'Check failed img', dir: failedDir },
  ];

  console.log("Testing multi-crop / multi-pass Tesseract OCR on problem images...\n");

  for (const tc of testCases) {
    const filePath = path.join(tc.dir, tc.file);
    if (!fs.existsSync(filePath)) continue;

    const buffer = fs.readFileSync(filePath);
    const meta = await sharp(buffer).metadata();

    console.log(`====================================================`);
    console.log(`FILE: ${tc.file} (${meta.width}x${meta.height}) | Expected: ${tc.expected}`);

    // Strategy 1: Full Image normalized & sharpened
    const fullProc = await sharp(buffer)
      .rotate()
      .greyscale()
      .normalize()
      .sharpen()
      .toBuffer();

    const resFull = await worker.recognize(fullProc);
    const textFull = resFull.data.text.replace(/\s+/g, ' ');

    console.log(`[Full Image OCR]: ${textFull.slice(0, 150)}`);

    // Strategy 2: Top 80% (remove GPS watermark at bottom)
    const h80 = Math.round(meta.height * 0.8);
    const topProc = await sharp(buffer)
      .rotate()
      .extract({ left: 0, top: 0, width: meta.width, height: h80 })
      .greyscale()
      .normalize()
      .sharpen()
      .toBuffer();

    const resTop = await worker.recognize(topProc);
    const textTop = resTop.data.text.replace(/\s+/g, ' ');

    console.log(`[Top 80% OCR]:   ${textTop.slice(0, 150)}`);

    // Strategy 3: Binarization / High Contrast (Thresholding)
    const threshProc = await sharp(buffer)
      .rotate()
      .greyscale()
      .threshold(128)
      .toBuffer();

    const resThresh = await worker.recognize(threshProc);
    const textThresh = resThresh.data.text.replace(/\s+/g, ' ');

    console.log(`[Threshold OCR]: ${textThresh.slice(0, 150)}`);

    // Strategy 4: Extract 17-char candidates from all passes combined
    const allText = `${textFull} ${textTop} ${textThresh}`;
    const cleanTokens = allText.replace(/[^A-Z0-9]/gi, ' ').toUpperCase().split(/\s+/);
    const candidates = cleanTokens.filter(t => t.length >= 14 && t.length <= 18);

    console.log(`>>> 17-char VIN Candidates Found:`, candidates.length ? candidates : 'NONE');
  }

  await worker.terminate();
}

testTesseractCrops().catch(console.error);
