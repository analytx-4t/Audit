import fs from 'fs';
import path from 'path';
import { createWorker } from 'tesseract.js';
import { extractAddressFromImageBuffer } from './test_fast_address.js';

async function runFourWheelersTest() {
  console.log("Initializing Tesseract OCR worker...");
  const worker = await createWorker('eng');
  
  const dirPath = path.resolve('../Four Wheelers');
  const files = fs.readdirSync(dirPath).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f));

  console.log(`Found ${files.length} Four-Wheeler images. Extracting addresses...\n`);

  const outputList = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const filePath = path.join(dirPath, file);
    const buffer = fs.readFileSync(filePath);

    const result = await extractAddressFromImageBuffer(buffer, worker);

    outputList.push({
      sno: i + 1,
      filename: file,
      textInsideImage: result.vehicleText || "-",
      fullAddress: result.fullAddress || "NO ADDRESS FOUND",
      city: result.city || "-",
      state: result.state || "-",
      pincode: result.pincode || "-",
      latitude: result.latitude || "-",
      longitude: result.longitude || "-",
      dateTime: result.dateTime || "-"
    });
  }

  await worker.terminate();

  console.log(JSON.stringify(outputList, null, 2));
}

runFourWheelersTest().catch(console.error);
