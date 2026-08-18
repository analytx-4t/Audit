import fs from 'fs';
import path from 'path';
import { createWorker } from 'tesseract.js';
import sharp from 'sharp';
import dotenv from 'dotenv';
import OpenAI from 'openai';

dotenv.config();

const openai = process.env.DEEPSEEK_API_KEY ? new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com'
}) : null;

const sampleDirs = [
  '../Two Wheelers',
  '../Four Wheelers',
  '../commercial Vehicles',
  '../CropTest',
  '../IMAGE NOT READ BY PORTAL'
];

// Helper to parse address using regex heuristics
function parseAddressFromText(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  
  let latitude = '';
  let longitude = '';
  let dateTime = '';
  let fullAddress = '';

  // Extract Lat/Long
  const latMatch = text.match(/lat(?:itude)?[:\s]*([0-9\.\-]+)/i);
  if (latMatch) latitude = latMatch[1];
  
  const longMatch = text.match(/long(?:itude)?[:\s]*([0-9\.\-]+)/i);
  if (longMatch) longitude = longMatch[1];

  // Extract Date/Time
  const dateMatch = text.match(/\b(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}[/-]\d{2}[/-]\d{2}|(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s*\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b[^\n]*/i);
  if (dateMatch) dateTime = dateMatch[0];

  // Filter lines likely to be address lines
  const addressKeywords = [
    'india', 'road', 'rd', 'street', 'st', 'nagar', 'colony', 'phase', 'sector', 'block',
    'plot', 'p-15', 'center', 'cidco', 'flyover', 'chinchwad', 'pimpri', 'ludhiana', 'delhi',
    'pune', 'mumbai', 'maharashtra', 'punjab', 'haryana', 'gujarat', 'karnataka', 'tamil',
    'sambhajinagar', 'satara', 'okhla', 'estate', 'midc', 'kothrud', 'bhusari', 'jalna',
    'subhash', 'park', 'janta', 'town', 'hub', 'depot', 'plaza', 'chowk', 'godoli'
  ];

  const candidateLines = lines.filter(line => {
    // Ignore lines that are just lat/long or timestamp or camera label
    if (/^gps\s*map\s*camera/i.test(line)) return false;
    if (/^note\s*:/i.test(line)) return false;
    if (/^lat\b/i.test(line) && /long\b/i.test(line)) return false;
    
    const lower = line.toLowerCase();
    const hasPincode = /\b\d{6}\b/.test(line);
    const hasAddressKeyword = addressKeywords.some(kw => lower.includes(kw));
    return hasPincode || hasAddressKeyword || lower.includes('india');
  });

  if (candidateLines.length > 0) {
    fullAddress = candidateLines.join(', ');
  }

  return { fullAddress, latitude, longitude, dateTime };
}

// Optional AI refinement for 100% clean formatting
async function extractAddressAI(rawOcrText) {
  if (!openai) return null;
  try {
    const response = await openai.chat.completions.create({
      model: 'deepseek-chat',
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You are an address extraction expert. From the raw OCR text of a photo (which may contain a GPS Map Camera watermark or location overlay), extract the complete location address and metadata.
Return JSON format:
{
  "full_address": "Complete full street address including locality, city, state, pincode, country",
  "city": "City or District",
  "state": "State",
  "pincode": "6-digit pincode if present else empty",
  "latitude": "Latitude coordinate if present else empty",
  "longitude": "Longitude coordinate if present else empty",
  "date_time": "Timestamp / Date if present else empty"
}`
        },
        {
          role: 'user',
          content: rawOcrText
        }
      ],
      temperature: 0
    });
    return JSON.parse(response.choices[0].message.content || '{}');
  } catch (err) {
    return null;
  }
}

async function runSuite() {
  const worker = await createWorker('eng');
  let totalImages = 0;
  let successCount = 0;
  const results = [];

  for (const relDir of sampleDirs) {
    const dir = path.resolve(relDir);
    if (!fs.existsSync(dir)) continue;

    const files = fs.readdirSync(dir).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f));

    for (const file of files) {
      totalImages++;
      const filePath = path.join(dir, file);
      const category = path.basename(dir);

      // Try multiple angles (0, 90, 180, 270) if needed or crop
      let bestText = '';
      const angles = [0, 90, 270, 180];
      
      for (const angle of angles) {
        let buf;
        if (angle === 0) {
          buf = filePath;
        } else {
          buf = await sharp(filePath).rotate(angle).toBuffer();
        }
        
        const res = await worker.recognize(buf);
        const text = res.data.text.trim();
        
        // Also try bottom 40% crop
        let bottomText = '';
        try {
          const meta = await sharp(filePath).rotate(angle).metadata();
          const bH = Math.round((meta.height || 1000) * 0.40);
          const bTop = (meta.height || 1000) - bH;
          const bBuf = await sharp(filePath)
            .rotate(angle)
            .extract({ left: 0, top: bTop, width: meta.width || 1000, height: bH })
            .greyscale()
            .normalize()
            .toBuffer();
          const bRes = await worker.recognize(bBuf);
          bottomText = bRes.data.text.trim();
        } catch (e) {}

        const combinedText = `${text}\n${bottomText}`;
        if (combinedText.length > bestText.length) {
          bestText = combinedText;
        }

        // If we found pincode or 'india' or 'lat', we have geotag info
        if (/\b\d{6}\b/.test(combinedText) || /india\b/i.test(combinedText) || /lat/i.test(combinedText)) {
          bestText = combinedText;
          break;
        }
      }

      // Parse Regex
      let parsed = parseAddressFromText(bestText);

      // If regex missed fullAddress or pincode, try AI fallback
      if (!parsed.fullAddress || parsed.fullAddress.length < 10) {
        const aiRes = await extractAddressAI(bestText);
        if (aiRes && aiRes.full_address) {
          parsed.fullAddress = aiRes.full_address;
          if (aiRes.latitude) parsed.latitude = aiRes.latitude;
          if (aiRes.longitude) parsed.longitude = aiRes.longitude;
          if (aiRes.date_time) parsed.dateTime = aiRes.date_time;
        }
      }

      const isSuccess = Boolean(parsed.fullAddress && parsed.fullAddress.length > 5);
      if (isSuccess) successCount++;

      results.push({
        category,
        file,
        fullAddress: parsed.fullAddress || "NO ADDRESS FOUND",
        latitude: parsed.latitude || "-",
        longitude: parsed.longitude || "-",
        dateTime: parsed.dateTime || "-",
        status: isSuccess ? "SUCCESS" : "FAILED"
      });
    }
  }

  await worker.terminate();

  console.log(`\n================ FINAL SUITE RESULTS ================`);
  console.table(results.map(r => ({
    Category: r.category,
    File: r.file,
    "Address Extracted": r.fullAddress.length > 60 ? r.fullAddress.slice(0, 57) + '...' : r.fullAddress,
    Status: r.status
  })));

  const rate = ((successCount / totalImages) * 100).toFixed(1);
  console.log(`\nTOTAL IMAGES TESTED: ${totalImages}`);
  console.log(`SUCCESSFUL EXTRACTIONS: ${successCount}`);
  console.log(`SUCCESS RATE: ${rate}%`);
}

runSuite().catch(console.error);
