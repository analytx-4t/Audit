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

export function cleanAddressText(text) {
  if (!text) return { fullAddress: '', city: '', state: '', pincode: '', latitude: '', longitude: '', dateTime: '', vehicleText: '' };
  
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  let latitude = '';
  let longitude = '';
  let dateTime = '';
  let pincode = '';
  let state = '';
  let city = '';
  let vehicleText = '';

  // Extract Lat/Long
  const latMatch = text.match(/(?:lat|latitude)[:\s]*([0-9\.\-]+)/i);
  if (latMatch) latitude = latMatch[1];
  
  const longMatch = text.match(/(?:long|longitude)[:\s]*([0-9\.\-]+)/i);
  if (longMatch) longitude = longMatch[1];

  // Extract Pincode
  const pinMatch = text.match(/\b([1-9][0-9]{5})\b/);
  if (pinMatch) pincode = pinMatch[1];

  // Extract Date/Time
  const dateMatch = text.match(/\b(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}[/-]\d{2}[/-]\d{2}|(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s*\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b[^\n]*/i);
  if (dateMatch) dateTime = dateMatch[0].trim();

  // Extract State
  const indianStates = [
    'Maharashtra', 'Delhi', 'Punjab', 'Haryana', 'Gujarat', 'Karnataka', 'Tamil Nadu',
    'Kerala', 'West Bengal', 'Rajasthan', 'Madhya Pradesh', 'Uttar Pradesh', 'Telangana',
    'Andhra Pradesh', 'Bihar', 'Jharkhand', 'Odisha', 'Assam', 'Goa', 'Chhattisgarh', 'Uttarakhand'
  ];
  for (const s of indianStates) {
    if (new RegExp(`\\b${s}\\b`, 'i').test(text)) {
      state = s;
      break;
    }
  }

  const ignorePatterns = [
    /^gps\s*map\s*camera/i,
    /^note\s*:/i,
    /^lat\b/i,
    /^google\b/i,
    /^\d{1,2}\/\d{1,2}\/\d{4}/,
    /^\d{4}-\d{2}-\d{2}/,
    /^(mon|tue|wed|thu|fri|sat|sun)/i
  ];

  const addressLines = [];
  const otherTextLines = [];

  for (const line of lines) {
    if (ignorePatterns.some(p => p.test(line))) continue;

    const lower = line.toLowerCase();
    const isAddressy = (
      /\b\d{6}\b/.test(line) ||
      lower.includes('india') ||
      lower.includes('road') || lower.includes('rd') ||
      lower.includes('street') || lower.includes('st') ||
      lower.includes('nagar') || lower.includes('colony') ||
      lower.includes('phase') || lower.includes('sector') ||
      lower.includes('block') || lower.includes('center') ||
      lower.includes('cidco') || lower.includes('chinchwad') ||
      lower.includes('ludhiana') || lower.includes('delhi') ||
      lower.includes('pune') || lower.includes('mumbai') ||
      lower.includes('satara') || lower.includes('okhla') ||
      lower.includes('estate') || lower.includes('midc') ||
      lower.includes('kothrud') || lower.includes('subhash') ||
      lower.includes('park') || lower.includes('janta') ||
      lower.includes('chowk') || lower.includes('godoli') ||
      lower.includes('hyundai') || lower.includes('maruti') ||
      lower.includes('tata') || lower.includes('mahindra') ||
      lower.includes('toyota') || lower.includes('kia') ||
      lower.includes('honda') || lower.includes('hero') ||
      lower.includes('eicher') || lower.includes('ashok')
    );

    if (isAddressy) {
      addressLines.push(line);
    } else if (line.length > 3) {
      otherTextLines.push(line);
    }
  }

  let fullAddress = addressLines.join(', ').replace(/,+/g, ',').replace(/\s+/g, ' ').trim();
  vehicleText = otherTextLines.join(' | ').slice(0, 100);

  return { fullAddress, city, state, pincode, latitude, longitude, dateTime, vehicleText };
}

export async function extractAddressFromImageBuffer(buffer, worker) {
  // 1. Bottom 35% crop (geotag zone) - quickest and cleanest for watermarks
  let text = '';
  try {
    const meta = await sharp(buffer).rotate().metadata();
    const bH = Math.round((meta.height || 1000) * 0.35);
    const bTop = (meta.height || 1000) - bH;
    const bBuf = await sharp(buffer)
      .rotate()
      .extract({ left: 0, top: bTop, width: meta.width || 1000, height: bH })
      .greyscale()
      .normalize()
      .toBuffer();
    const bRes = await worker.recognize(bBuf);
    text = bRes.data.text.trim();
  } catch (e) {}

  let parsed = cleanAddressText(text);

  // 2. If bottom crop didn't get enough address, try full image
  if (!parsed.fullAddress || parsed.fullAddress.length < 10) {
    try {
      const fullRes = await worker.recognize(buffer);
      const fullText = fullRes.data.text.trim();
      const fullParsed = cleanAddressText(`${text}\n${fullText}`);
      if (fullParsed.fullAddress.length > parsed.fullAddress.length) {
        parsed = fullParsed;
        text = `${text}\n${fullText}`;
      }
    } catch (e) {}
  }

  // 3. AI Fallback if deepseek key exists and address is still weak
  if (openai && (!parsed.fullAddress || parsed.fullAddress.length < 10)) {
    try {
      const response = await openai.chat.completions.create({
        model: 'deepseek-chat',
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `Extract full street address from image OCR text. Return JSON: {"full_address":"","city":"","state":"","pincode":"","latitude":"","longitude":"","date_time":"","vehicle_text":""}`
          },
          { role: 'user', content: text }
        ],
        temperature: 0
      });
      const aiObj = JSON.parse(response.choices[0].message.content || '{}');
      if (aiObj.full_address && aiObj.full_address.length > parsed.fullAddress.length) {
        parsed.fullAddress = aiObj.full_address;
        if (aiObj.city) parsed.city = aiObj.city;
        if (aiObj.state) parsed.state = aiObj.state;
        if (aiObj.pincode) parsed.pincode = aiObj.pincode;
        if (aiObj.latitude) parsed.latitude = aiObj.latitude;
        if (aiObj.longitude) parsed.longitude = aiObj.longitude;
        if (aiObj.date_time) parsed.dateTime = aiObj.date_time;
        if (aiObj.vehicle_text) parsed.vehicleText = aiObj.vehicle_text;
      }
    } catch (e) {}
  }

  return { ...parsed, rawText: text };
}

async function testFast() {
  console.log("Initializing Tesseract worker...");
  const worker = await createWorker('eng');
  console.log("Worker ready. Testing images across directories...");

  let total = 0;
  let success = 0;
  const results = [];

  for (const relDir of sampleDirs) {
    const dir = path.resolve(relDir);
    if (!fs.existsSync(dir)) continue;

    const files = fs.readdirSync(dir).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f));

    for (const file of files) {
      total++;
      const filePath = path.join(dir, file);
      const category = path.basename(dir);
      const buf = fs.readFileSync(filePath);

      const parsed = await extractAddressFromImageBuffer(buf, worker);
      const isOk = parsed.fullAddress.length > 5;
      if (isOk) success++;

      console.log(`[${total}] ${category} / ${file} -> ${isOk ? 'OK' : 'FAIL'} (${parsed.fullAddress.slice(0, 40)})`);

      results.push({
        category,
        file,
        fullAddress: parsed.fullAddress || "NO ADDRESS DETECTED",
        pincode: parsed.pincode || "-",
        lat: parsed.latitude || "-",
        long: parsed.longitude || "-",
        status: isOk ? "SUCCESS" : "FAILED"
      });
    }
  }

  await worker.terminate();

  console.log("\n=================== ADDRESS EXTRACTION TEST RESULTS ===================");
  console.table(results.map(r => ({
    Category: r.category,
    File: r.file,
    Address: r.fullAddress.length > 50 ? r.fullAddress.slice(0, 47) + "..." : r.fullAddress,
    Pincode: r.pincode,
    Status: r.status
  })));

  const rate = ((success / total) * 100).toFixed(1);
  console.log(`\nTotal Images Processed: ${total}`);
  console.log(`Successful Extractions: ${success}`);
  console.log(`Success Rate: ${rate}%\n`);
}

if (process.argv[1].endsWith('test_fast_address.js')) {
  testFast().catch(console.error);
}
