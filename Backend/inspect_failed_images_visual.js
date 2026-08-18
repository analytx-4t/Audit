import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';

async function testFailedImagesDetailed() {
  const failedDir = `C:\\Users\\hp\\Downloads\\1_Result\\failed`;
  const files = fs.readdirSync(failedDir).filter(f => /\.(jpg|jpeg|png)$/i.test(f)).slice(0, 10);

  const worker = await createWorker('eng');

  console.log(`Inspecting ${files.length} failed images across all 4 rotations (0°, 90°, 180°, 270°)...\n`);

  for (const file of files) {
    const filePath = path.join(failedDir, file);
    const buf = fs.readFileSync(filePath);
    const meta = await sharp(buf).metadata();

    console.log(`--------------------------------------------------`);
    console.log(`FILE: ${file} | Dimensions: ${meta.width}x${meta.height} | Format: ${meta.format}`);

    for (const angle of [0, 90, 180, 270]) {
      // Rotate and enhance
      const rotBuf = await sharp(buf)
        .rotate(angle)
        .greyscale()
        .normalize()
        .sharpen()
        .toBuffer();

      const ocrRes = await worker.recognize(rotBuf);
      const text = ocrRes.data.text.replace(/\s+/g, ' ').trim();

      // Look for 17-char or 10-20 alphanumeric sequences
      const matches = text.match(/[A-Z0-9]{10,20}/gi) || [];
      const vinMatches = matches.filter(m => m.length >= 14);

      if (vinMatches.length > 0 || (angle === 0 && text.length > 0)) {
        console.log(`  [Rotation ${angle}°]: OCR Text Snippet: "${text.slice(0, 120)}..."`);
        if (vinMatches.length > 0) {
          console.log(`  >>> VIN Candidates at ${angle}°:`, vinMatches);
        }
      }
    }
  }

  await worker.terminate();
}

testFailedImagesDetailed().catch(console.error);
