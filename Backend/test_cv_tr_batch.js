import fs from "fs";
import path from "path";
import { config } from "dotenv";
import { cropVehicleWithPercent, processOneFile } from "./server.js";

config();

async function runBatchTest() {
  const dirPath = "C:\\Users\\hp\\Downloads\\CV_TR";
  const files = fs.readdirSync(dirPath).filter(f => f.toLowerCase().endsWith(".jpeg") || f.toLowerCase().endsWith(".jpg"));

  console.log(`=== PARALLEL BATCH END-TO-END TEST (${files.length} IMAGES) ===\n`);

  const uploadResults = [];
  const batchSize = 5;

  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    console.log(`Batch ${Math.floor(i / batchSize) + 1} / ${Math.ceil(files.length / batchSize)} starting...`);

    const promises = batch.map(async (filename) => {
      const rawBuffer = fs.readFileSync(path.join(dirPath, filename));
      const processedBuffer = await cropVehicleWithPercent(rawBuffer, 0.75, "commercial_equipment");

      const mockFile = {
        originalname: filename,
        mimetype: "image/jpeg",
        buffer: processedBuffer,
      };

      const res = await processOneFile(mockFile, 3, "commercial_equipment", {
        address: "Test Address",
        city: "Test City",
      });

      return {
        file: filename,
        success: res.success,
        vin: res.aiResult?.vin || "",
        engine: res.aiResult?.engine_number || "",
        fuel: res.aiResult?.fuel_type || "",
        source: res.source,
      };
    });

    const batchRes = await Promise.all(promises);
    uploadResults.push(...batchRes);
    batchRes.forEach(r => {
      console.log(`  [${r.file}] Success=${r.success} | VIN="${r.vin}" | Engine="${r.engine}"`);
    });
  }

  console.log("\n================ FULL TEST SUMMARY ================");
  console.table(uploadResults.map(r => ({
    File: r.file,
    VIN: r.vin,
    Engine: r.engine,
    Success: r.success,
  })));

  const totalSuccess = uploadResults.filter(r => r.success && r.vin).length;
  console.log(`\nExtracted VIN & processed successfully on ${totalSuccess}/${files.length} images.`);
}

runBatchTest().catch(console.error);
