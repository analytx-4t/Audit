import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';

const INPUT_DIRS = [
  '../Two Wheelers',
  '../commercial Vehicles'
];
const OUTPUT_DIR = './results';

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Function to run Tesseract OCR on a buffer and return word bounding boxes
async function detectText(buffer) {
  const worker = await createWorker('eng');
  const { data: { words } } = await worker.recognize(buffer);
  await worker.terminate();
  return words || [];
}

async function processImage(filePath) {
  const filename = path.basename(filePath);
  console.log(`\n==================================================`);
  console.log(`Processing: ${filename}`);

  try {
    const image = sharp(filePath);
    const metadata = await image.metadata();
    const width = metadata.width;
    const height = metadata.height;

    console.log(`Dimensions: ${width}x${height}`);

    // Step 1: Divide image into Working Region (top 75%) and Watermark Region (bottom 25%)
    const workingHeight = Math.round(height * 0.75);
    const watermarkHeight = height - workingHeight;

    const workingBuffer = await image
      .clone()
      .extract({ left: 0, top: 0, width: width, height: workingHeight })
      .toBuffer();

    // Step 2: Create preprocessed buffer for OCR (grayscale + normalize + sharpen)
    const preprocessedBuffer = await sharp(workingBuffer)
      .greyscale()
      .normalize()
      .sharpen()
      .toBuffer();

    // Step 3: Run horizontal and vertical text detection (relaxed debug rules)
    console.log(`Running horizontal text detection on ${filename}...`);
    const horizontalWords = await detectText(preprocessedBuffer);
    
    console.log(`Running vertical text detection (rotated 90deg)...`);
    const rotatedBuffer = await sharp(preprocessedBuffer)
      .rotate(90)
      .toBuffer();
    const verticalWords = await detectText(rotatedBuffer);

    // Step 4: Merge bounding boxes
    let minX = width;
    let minY = workingHeight;
    let maxX = 0;
    let maxY = 0;
    let foundValidText = false;

    // Filter rule (relaxed): length >= 2, confidence > 30%
    const isValidWord = (word) => {
      const cleanText = word.text.replace(/[^A-Za-z0-9]/g, '');
      return cleanText.length >= 2 && word.confidence > 30;
    };

    horizontalWords.forEach(word => {
      if (isValidWord(word)) {
        const { x0, y0, x1, y1 } = word.bbox;
        console.log(`  [Horizontal] "${word.text}" (Conf: ${Math.round(word.confidence)}%) -> [${x0}, ${y0}, ${x1}, ${y1}]`);
        if (x0 < minX) minX = x0;
        if (y0 < minY) minY = y0;
        if (x1 > maxX) maxX = x1;
        if (y1 > maxY) maxY = y1;
        foundValidText = true;
      }
    });

    verticalWords.forEach(word => {
      if (isValidWord(word)) {
        const { x0: rx0, y0: ry0, x1: rx1, y1: ry1 } = word.bbox;
        
        // Map back to original coordinate system
        const x0 = width - ry1;
        const x1 = width - ry0;
        const y0 = rx0;
        const y1 = rx1;

        console.log(`  [Vertical mapped] "${word.text}" (Conf: ${Math.round(word.confidence)}%) -> [${x0}, ${y0}, ${x1}, ${y1}]`);
        if (x0 < minX) minX = x0;
        if (y0 < minY) minY = y0;
        if (x1 > maxX) maxX = x1;
        if (y1 > maxY) maxY = y1;
        foundValidText = true;
      }
    });

    let cropX, cropY, cropW, cropH;

    if (foundValidText) {
      const padding = 80;
      cropX = Math.max(0, minX - padding);
      cropY = Math.max(0, minY - padding);
      cropW = Math.min(width - cropX, (maxX - minX) + (padding * 2));
      cropH = Math.min(workingHeight - cropY, (maxY - minY) + (padding * 2));
      console.log(`Text Area: Left: ${cropX}, Top: ${cropY}, Width: ${cropW}, Height: ${cropH}`);
    } else {
      // Fallback: Use the entire working region
      cropX = 0;
      cropY = 0;
      cropW = width;
      cropH = workingHeight;
      console.log(`No text detected. Using the full working region.`);
    }

    // Step 5: Crop the text region
    const croppedTextBuffer = await sharp(filePath)
      .extract({ left: cropX, top: cropY, width: cropW, height: cropH })
      .toBuffer();

    // Step 6: Crop the GPS watermark region (full width of original image)
    const watermarkBuffer = await sharp(filePath)
      .extract({ left: 0, top: workingHeight, width: width, height: watermarkHeight })
      .toBuffer();

    // Step 7: Combine cropped text and watermark vertically
    const compositeHeight = cropH + watermarkHeight;
    console.log(`Combining vertically. Final dimensions: ${width}x${compositeHeight}`);

    const outputPath = path.join(OUTPUT_DIR, filename);
    await sharp({
      create: {
        width: width,
        height: compositeHeight,
        channels: 3,
        background: { r: 0, g: 0, b: 0 } // Black background padding on sides of the cropped text
      }
    })
    .composite([
      { input: croppedTextBuffer, top: 0, left: Math.round((width - cropW) / 2) }, // Centered text at top
      { input: watermarkBuffer, top: cropH, left: 0 }                           // Watermark at bottom
    ])
    .toFile(outputPath);

    console.log(`Successfully saved combined cropped image to: ${outputPath}`);

  } catch (err) {
    console.error(`Error processing ${filename}:`, err.message);
  }
}

async function main() {
  for (const dir of INPUT_DIRS) {
    const absoluteDir = path.resolve(dir);
    if (!fs.existsSync(absoluteDir)) {
      console.log(`Directory does not exist: ${absoluteDir}`);
      continue;
    }

    console.log(`Scanning directory: ${absoluteDir}`);
    const files = fs.readdirSync(absoluteDir);
    const imageFiles = files.filter(f => {
      const ext = path.extname(f).toLowerCase();
      return ['.jpg', '.jpeg', '.png'].includes(ext);
    });

    for (const file of imageFiles) {
      const fullPath = path.join(absoluteDir, file);
      await processImage(fullPath);
    }
  }
  console.log(`\nAll done! You can find the results in: ${path.resolve(OUTPUT_DIR)}`);
}

main();
