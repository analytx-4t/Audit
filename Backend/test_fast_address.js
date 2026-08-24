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

function cleanLineNoise(line) {
  if (!line) return '';
  let l = line.trim();
  
  // Replace slashes before address words like /Marg -> Marg
  l = l.replace(/\/([A-Za-z]+)/g, ' $1');

  // Strip leading garbage symbols, lone numbers/letters from map box OCR noise
  l = l.replace(/^[^a-zA-Z0-9\s#\/\-\.\,]+/, '');
  l = l.replace(/^(?:[a-z0-9]{1,4}|[§£©¥\[\]\{\}\(\)\/\\\|\-\s]+)\s+(?=[A-Z])/i, '');
  
  // Clean trailing single letter noise like ", S" or ", p"
  l = l.replace(/,\s*[A-Za-z]$/, '');
  l = l.replace(/[^a-zA-Z0-9\.\,\-\s\(\)]+$/, '');

  return l.trim();
}

const indianStates = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat',
  'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh',
  'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab',
  'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh',
  'Uttarakhand', 'West Bengal', 'Delhi', 'New Delhi', 'Jammu & Kashmir', 'Ladakh',
  'Chandigarh', 'Puducherry', 'Dadra and Nagar Haveli', 'Daman and Diu', 'Lakshadweep', 'Andaman and Nicobar'
];

export function cleanAddressText(text) {
  if (!text) return { fullAddress: '', city: '', state: '', pincode: '', latitude: '', longitude: '', dateTime: '', vehicleText: '' };
  
  const rawLines = text.split('\n').map(l => l.trim()).filter(Boolean);

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
  for (const s of indianStates) {
    if (new RegExp(`\\b${s}\\b`, 'i').test(text)) {
      state = s;
      break;
    }
  }

  // Extract City/District heuristic
  const cityMatch = text.match(/\b(New Delhi|Delhi|Mumbai|Pune|Bengaluru|Bangalore|Hyderabad|Chennai|Kolkata|Ahmedabad|Surat|Jaipur|Lucknow|Kanpur|Nagpur|Indore|Thane|Bhopal|Visakhapatnam|Pimpri-Chinchwad|Patna|Vadodara|Ghaziabad|Ludhiana|Agra|Nashik|Faridabad|Meerut|Rajkot|Varanasi|Srinagar|Aurangabad|Dhanbad|Amritsar|Navi Mumbai|Allahabad|Ranchi|Howrah|Coimbatore|Jabalpur|Gwalior|Vijayawada|Jodhpur|Madurai|Raipur|Kota|Guwahati|Chandigarh|Solapur|Hubli|Tiruchirappalli|Bareilly|Moradabad|Mysore|Tiruppur|Gurgaon|Gurugram|Noida|Jalandhar|Bhubaneswar|Salem|Warangal|Guntur|Bhiwandi|Saharanpur|Gorakhpur|Bikaner|Amravati|Jamshedpur|Bhilai|Cuttack|Firozabad|Kochi|Bhavnagar|Dehradun|Durgapur|Asansol|Nanded|Kolhapur|Ajmer|Gulbarga|Jamnagar|Ujjain|Loni|Siliguri|Jhansi|Ulhasnagar|Nellore|Jammu|Sangli|Belgaum|Mangalore|Ambattur|Tirunelveli|Malegaon|Gaya|Jalgaon|Udaipur|Maheshtala)\b/i);
  if (cityMatch) city = cityMatch[1];

  const ignorePatterns = [
    /^gps\s*map\s*camera/i,
    /^note\s*:/i,
    /^lat\b/i,
    /^latitude/i,
    /^long\b/i,
    /^longitude/i,
    /^google\b/i,
    /^\d{1,2}\/\d{1,2}\/\d{4}/,
    /^\d{4}-\d{2}-\d{2}/,
    /^(mon|tue|wed|thu|fri|sat|sun)/i,
    /^gmt\+[0-9:\.]+/i,
    /captured\s*by/i
  ];

  const addressKeywords = [
    'india', 'road', 'rd', 'street', 'st', 'marg', 'path', 'gali', 'lane', 'drive',
    'nagar', 'colony', 'vihar', 'khera', 'enclave', 'pur', 'puri', 'gram', 'gaon',
    'phase', 'sector', 'block', 'pocket', 'plot', 'h.no', 'house', 'flat', 'bldg',
    'building', 'floor', 'tower', 'complex', 'plaza', 'estate', 'midc', 'cidco',
    'industrial', 'area', 'park', 'society', 'chawl', 'layout', 'chowk', 'bazar',
    'bazaar', 'market', 'mandi', 'near', 'opp', 'opposite', 'behind', 'beside',
    'ludhiana', 'delhi', 'pune', 'mumbai', 'satara', 'okhla', 'kothrud', 'godoli',
    'chinchwad', 'salapur', 'sekhar', 'chandra', 'saheed', 'gurugram', 'gurgaon',
    'noida', 'ghaziabad', 'faridabad', 'hyundai', 'maruti', 'tata', 'mahindra',
    'toyota', 'kia', 'honda', 'hero', 'eicher', 'ashok'
  ];

  const primaryAddressLines = [];
  const fallbackAddressLines = [];
  const otherTextLines = [];

  for (let rawLine of rawLines) {
    const cleaned = cleanLineNoise(rawLine);
    if (!cleaned) continue;

    // Skip pure metadata lines (Lat, Long, Dates, Branding)
    if (ignorePatterns.some(p => p.test(cleaned))) continue;

    const lower = cleaned.toLowerCase();
    const isAddressy = (
      /\b\d{6}\b/.test(cleaned) ||
      addressKeywords.some(kw => new RegExp(`\\b${kw}\\b`, 'i').test(lower))
    );

    if (isAddressy) {
      primaryAddressLines.push(cleaned);
    } else if (cleaned.length > 3) {
      fallbackAddressLines.push(cleaned);
    }
  }

  // Use primary matching lines if sufficient, else fallback to all non-metadata lines
  const finalLines = (primaryAddressLines.join(' ').length >= 10) 
    ? primaryAddressLines 
    : [...primaryAddressLines, ...fallbackAddressLines];

  let fullAddress = finalLines.join(', ').replace(/,+/g, ',').replace(/\s+/g, ' ').trim();
  vehicleText = fallbackAddressLines.join(' | ').slice(0, 100);

  return { fullAddress, city, state, pincode, latitude, longitude, dateTime, vehicleText };
}

export async function extractAddressFromImageBuffer(buffer, worker) {
  let text = '';
  let parsed = { fullAddress: '', city: '', state: '', pincode: '', latitude: '', longitude: '', dateTime: '', vehicleText: '' };
  
  try {
    const meta = await sharp(buffer).rotate().metadata();
    const bH = Math.round((meta.height || 1000) * 0.35);
    const bTop = (meta.height || 1000) - bH;

    // 1a. Try right 75% bottom crop (removes left map box from GPS Map Camera watermarks)
    const leftOffset = Math.round((meta.width || 1000) * 0.25);
    const cropW = (meta.width || 1000) - leftOffset;
    const bBufRight = await sharp(buffer)
      .rotate()
      .extract({ left: leftOffset, top: bTop, width: cropW, height: bH })
      .greyscale()
      .normalize()
      .toBuffer();
    const bResRight = await worker.recognize(bBufRight);
    const parsedRight = cleanAddressText(bResRight.data.text);

    if (parsedRight.fullAddress && parsedRight.fullAddress.length > 10) {
      parsed = parsedRight;
      text = bResRight.data.text.trim();
    } else {
      // 1b. Fallback to full width bottom crop
      const bBufFull = await sharp(buffer)
        .rotate()
        .extract({ left: 0, top: bTop, width: meta.width || 1000, height: bH })
        .greyscale()
        .normalize()
        .toBuffer();
      const bResFull = await worker.recognize(bBufFull);
      parsed = cleanAddressText(bResFull.data.text);
      text = bResFull.data.text.trim();
    }
  } catch (e) {}

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

if (process.argv[1]?.endsWith('test_fast_address.js')) {
  testFast().catch(console.error);
}
