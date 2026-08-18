import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';

async function testPortraitRotations() {
  const renamedDir = `C:\\Users\\hp\\Downloads\\1_Result\\renamed_images`;
  const failedDir = `C:\\Users\\hp\\Downloads\\1_Result\\failed`;

  const worker = await createWorker('eng');

  const problemFiles = [
    { file: 'IMG_095.jpeg', expected: 'MA3ZFDFSKTF514249', dir: renamedDir },
    { file: 'IMG_101.jpeg', expected: 'MA3ZFDFSKTF513875', dir: renamedDir },
    { file: 'IMG_109.jpeg', expected: 'MA3ZFDFSKTF497213', dir: renamedDir },
    { file: 'IMG_115.jpeg', expected: 'MA3BNC72STFD29828', dir: renamedDir },
    { file: 'IMG_135.jpeg', expected: 'MA3BNC72STFD22264', dir: renamedDir },
    { file: 'IMG_136.jpeg', expected: 'MA3BNC62STFD22254', dir: renamedDir },
    { file: 'IMG_185.jpeg', expected: 'MA3ZFDFSKTC427216', dir: renamedDir },
    { file: 'IMG_195.jpeg', expected: 'MA3SFM61STC481197', dir: renamedDir },
    { file: 'IMG_230.jpeg', expected: 'MA3JDT08WTEG24605', dir: renamedDir },
    { file: 'IMG_005.jpeg', expected: 'Check failed', dir: failedDir },
    { file: 'IMG_006.jpeg', expected: 'Check failed', dir: failedDir },
    { file: 'IMG_054.jpeg', expected: 'Check failed', dir: failedDir },
  ];

  console.log("Testing 90°, 180°, 270° rotations on portrait & problem images...\n");

  for (const pf of problemFiles) {
    const filePath = path.join(pf.dir, pf.file);
    if (!fs.existsSync(filePath)) continue;

    const buffer = fs.readFileSync(filePath);
    const meta = await sharp(buffer).metadata();

    console.log(`====================================================`);
    console.log(`FILE: ${pf.file} (${meta.width}x${meta.height}) | Expected: ${pf.expected}`);

    for (const angle of [0, 90, 180, 270]) {
      // 1. Rotate
      const rotImage = await sharp(buffer)
        .rotate(angle)
        .greyscale()
        .normalize()
        .sharpen()
        .toBuffer();

      const res = await worker.recognize(rotImage);
      const text = res.data.text.replace(/\s+/g, ' ');

      // Extract 14-18 char uppercase tokens
      const clean = text.replace(/[^A-Z0-9]/gi, ' ').toUpperCase();
      const tokens = clean.split(/\s+/).filter(t => t.length >= 14 && t.length <= 18);
      const matchesMA3 = tokens.filter(t => t.startsWith('M') || t.startsWith('N') || t.includes('MA3') || t.includes('ZFDF') || t.includes('BNC'));

      if (matchesMA3.length > 0 || tokens.length > 0) {
        console.log(`  [Angle ${angle}°] Tokens:`, tokens);
        if (matchesMA3.length > 0) {
          console.log(`  >>> TARGET VIN CANDIDATE AT ${angle}°:`, matchesMA3);
        }
      }
    }
  }

  await worker.terminate();
}

testPortraitRotations().catch(console.error);
