import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';

async function testAdvancedEnhancements() {
  const renamedDir = `C:\\Users\\hp\\Downloads\\1_Result\\renamed_images`;
  const worker = await createWorker('eng');

  const targetFiles = [
    { file: 'IMG_053.jpeg', expected: 'MA3SFM61STF515152' },
    { file: 'IMG_092.jpeg', expected: 'MA3ZFDFSKTE486453' },
    { file: 'IMG_095.jpeg', expected: 'MA3ZFDFSKTF514249' },
    { file: 'IMG_101.jpeg', expected: 'MA3ZFDFSKTF513875' },
    { file: 'IMG_109.jpeg', expected: 'MA3ZFDFSKTF497213' },
    { file: 'IMG_115.jpeg', expected: 'MA3BNC72STFD29828' },
    { file: 'IMG_135.jpeg', expected: 'MA3BNC72STFD22264' },
    { file: 'IMG_136.jpeg', expected: 'MA3BNC62STFD22254' },
    { file: 'IMG_185.jpeg', expected: 'MA3ZFDFSKTC427216' },
    { file: 'IMG_195.jpeg', expected: 'MA3SFM61STC481197' },
    { file: 'IMG_230.jpeg', expected: 'MA3JDT08WTEG24605' },
  ];

  console.log("Testing 2x Upscaling + Advanced Contrast/Threshold Enhancements...\n");

  for (const item of targetFiles) {
    const filePath = path.join(renamedDir, item.file);
    if (!fs.existsSync(filePath)) continue;

    const buffer = fs.readFileSync(filePath);
    const meta = await sharp(buffer).metadata();

    console.log(`====================================================`);
    console.log(`FILE: ${item.file} | Expected: ${item.expected}`);

    // Focus on top 75% to remove GPS bottom watermark
    const topH = Math.round(meta.height * 0.75);

    // Technique A: 2x Upscale + Greyscale + Sharpen
    const procA = await sharp(buffer)
      .extract({ left: 0, top: 0, width: meta.width, height: topH })
      .resize({ width: meta.width * 2 })
      .greyscale()
      .normalize()
      .sharpen({ sigma: 2 })
      .toBuffer();

    const resA = await worker.recognize(procA);
    const textA = resA.data.text.replace(/\s+/g, ' ');

    // Technique B: 2x Upscale + Negate (Invert Colors for light text on dark metallic background)
    const procB = await sharp(buffer)
      .extract({ left: 0, top: 0, width: meta.width, height: topH })
      .resize({ width: meta.width * 2 })
      .greyscale()
      .negate()
      .normalize()
      .sharpen({ sigma: 2 })
      .toBuffer();

    const resB = await worker.recognize(procB);
    const textB = resB.data.text.replace(/\s+/g, ' ');

    // Technique C: 2x Upscale + Gamma / High Contrast Threshold
    const procC = await sharp(buffer)
      .extract({ left: 0, top: 0, width: meta.width, height: topH })
      .resize({ width: meta.width * 2 })
      .greyscale()
      .gamma(1.8)
      .linear(2.0, -50)
      .toBuffer();

    const resC = await worker.recognize(procC);
    const textC = resC.data.text.replace(/\s+/g, ' ');

    const combinedText = `${textA} ${textB} ${textC}`.replace(/[^A-Z0-9]/gi, ' ').toUpperCase();
    const tokens = combinedText.split(/\s+/).filter(t => t.length >= 14 && t.length <= 18);

    console.log(`[Text Sample A]: ${textA.slice(0, 150)}`);
    console.log(`[Text Sample B]: ${textB.slice(0, 150)}`);
    console.log(`[Text Sample C]: ${textC.slice(0, 150)}`);
    console.log(`>>> 17-char Candidates:`, tokens.length ? tokens : 'NONE');
  }

  await worker.terminate();
}

testAdvancedEnhancements().catch(console.error);
