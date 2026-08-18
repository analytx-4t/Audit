import fs from 'fs';
import path from 'path';
import { createWorker } from 'tesseract.js';
import sharp from 'sharp';

const sampleDirs = [
  '../Two Wheelers',
  '../Four Wheelers',
  '../commercial Vehicles',
  '../CropTest',
  '../IMAGE NOT READ BY PORTAL'
];

async function inspectImages() {
  const worker = await createWorker('eng');

  for (const relDir of sampleDirs) {
    const dir = path.resolve(relDir);
    if (!fs.existsSync(dir)) continue;

    console.log(`\n==================================================`);
    console.log(`DIRECTORY: ${path.basename(dir)}`);
    console.log(`==================================================`);

    const files = fs.readdirSync(dir).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f));

    for (const file of files) {
      const filePath = path.join(dir, file);
      console.log(`\n--- IMAGE: ${file} ---`);

      // 1. Full Image OCR
      const fullRes = await worker.recognize(filePath);
      console.log("[FULL TEXT]:");
      console.log(fullRes.data.text.trim());

      // 2. Bottom 35% OCR (where geotags often reside)
      try {
        const metadata = await sharp(filePath).rotate().metadata();
        const bH = Math.round((metadata.height || 1000) * 0.35);
        const bTop = (metadata.height || 1000) - bH;
        
        const bottomBuffer = await sharp(filePath)
          .rotate()
          .extract({ left: 0, top: bTop, width: metadata.width || 1000, height: bH })
          .greyscale()
          .normalize()
          .toBuffer();

        const bottomRes = await worker.recognize(bottomBuffer);
        console.log("\n[BOTTOM 35% TEXT]:");
        console.log(bottomRes.data.text.trim());
      } catch (e) {
        console.log("[BOTTOM CROP ERR]:", e.message);
      }
    }
  }

  await worker.terminate();
}

inspectImages().catch(console.error);
