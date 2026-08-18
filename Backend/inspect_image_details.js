import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';

async function inspectImageDetails() {
  const file = 'IMG_095.jpeg';
  const filePath = `C:\\Users\\hp\\Downloads\\1_Result\\renamed_images\\${file}`;
  
  const worker = await createWorker('eng');
  const buffer = fs.readFileSync(filePath);
  const metadata = await sharp(buffer).metadata();

  console.log(`Inspecting ${file}:`, metadata);

  // Try 4 quadrant crops: Top-Left, Top-Right, Bottom-Left, Bottom-Right, Center
  const w = metadata.width;
  const h = metadata.height;
  const halfW = Math.round(w / 2);
  const halfH = Math.round(h / 2);

  const crops = [
    { name: 'Full Image', rect: { left: 0, top: 0, width: w, height: h } },
    { name: 'Top Half', rect: { left: 0, top: 0, width: w, height: halfH } },
    { name: 'Bottom Half', rect: { left: 0, top: halfH, width: w, height: halfH } },
    { name: 'Center 50%', rect: { left: Math.round(w * 0.25), top: Math.round(h * 0.25), width: halfW, height: halfH } },
    { name: 'Top-Left', rect: { left: 0, top: 0, width: halfW, height: halfH } },
    { name: 'Top-Right', rect: { left: halfW, top: 0, width: halfW, height: halfH } },
  ];

  for (const c of crops) {
    const croppedBuf = await sharp(buffer)
      .extract(c.rect)
      .greyscale()
      .normalize()
      .sharpen()
      .toBuffer();

    const ocrRes = await worker.recognize(croppedBuf);
    const text = ocrRes.data.text.replace(/\s+/g, ' ').trim();
    console.log(`\n--- Crop: ${c.name} ---`);
    console.log(`Text: "${text.slice(0, 200)}"`);
  }

  await worker.terminate();
}

inspectImageDetails().catch(console.error);
