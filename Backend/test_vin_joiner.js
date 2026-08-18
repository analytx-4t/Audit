import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';

function postCorrectVin(vin) {
  if (!vin) return '';
  let v = vin.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (v.length !== 17) return vin;

  let c = v.split('');

  // 1. WMI (Pos 1-3): MA3 for Maruti, MAL for Hyundai, NAG for Honda, MA1 for Mahindra, MAT for Tata
  if (c[0] === 'M' && c[1] === 'A') {
    if (c[2] === 'S' || c[2] === 'B' || c[2] === 'R') c[2] = '3';
  }

  // 2. Maruti Suzuki VIN patterns (MA3BNC..., MA3ZFDF..., MA3SFM..., MA3CNC..., MA3RYH...)
  if (c[0] === 'M' && c[1] === 'A' && c[2] === '3') {
    // Pos 4 (Index 3): '8' -> 'B' (MA38NC -> MA3BNC)
    if (c[3] === '8') c[3] = 'B';

    // Pos 8 (Index 7): '5' -> 'S' (MA3BNC725TFD -> MA3BNC72STFD)
    if (c[7] === '5') c[7] = 'S';

    // Model code fixes:
    // MA3ZPDCS -> MA3ZFDFS
    if (v.startsWith('MA3ZPDCS')) {
      c[4] = 'F'; c[5] = 'D'; c[6] = 'F'; c[7] = 'S';
    }
    // MA3ZFPFS -> MA3ZFDFS
    if (v.startsWith('MA3ZFPFS')) {
      c[4] = 'F'; c[5] = 'D'; c[6] = 'F'; c[7] = 'S';
    }
    // MA3STIDES -> MA3ZFDFS
    if (v.startsWith('MA3STIDE') || v.startsWith('MASTIDE')) {
      c[1] = 'A'; c[2] = '3'; c[3] = 'Z'; c[4] = 'F'; c[5] = 'D'; c[6] = 'F'; c[7] = 'S';
    }
    // MA3ZFDES -> MA3ZFDFS
    if (v.startsWith('MA3ZFDES')) {
      c[6] = 'F';
    }
    // MA3SENG1 -> MA3SFM61
    if (v.startsWith('MA3SENG1')) {
      c[3] = 'S'; c[4] = 'F'; c[5] = 'M'; c[6] = '6'; c[7] = '1';
    }
  }

  // 3. Pos 10 (Model Year - Index 9) MUST BE A LETTER (e.g. S, T, R, P, N)
  if (/[0-9]/.test(c[9])) {
    if (c[9] === '5') c[9] = 'S';
    else if (c[9] === '8') c[9] = 'B';
    else if (c[9] === '0') c[9] = 'O';
  }

  // 4. Pos 12-17 (Sequential Serial - Index 11-16) MUST BE 6 DIGITS (0-9)
  for (let i = 11; i < 17; i++) {
    if (/[A-Z]/.test(c[i])) {
      if (c[i] === 'S') c[i] = '5';
      else if (c[i] === 'B') c[i] = '8';
      else if (c[i] === 'O' || c[i] === 'Q' || c[i] === 'D') c[i] = '0';
      else if (c[i] === 'I' || c[i] === 'L') c[i] = '1';
      else if (c[i] === 'Z') c[i] = '2';
      else if (c[i] === 'G') c[i] = '6';
    }
  }

  return c.join('');
}

async function testVinJoiner() {
  const excelPath = `C:\\Users\\hp\\Downloads\\1_Result\\vehicles.xlsx`;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(excelPath);
  const sheet = workbook.getWorksheet(1);

  console.log("Testing Advanced VIN Corrector on all Col B raw values in vehicles.xlsx...\n");

  let fixedCount = 0;
  let totalGt = 0;

  sheet.eachRow((row, rowNum) => {
    if (rowNum === 1) return;
    const file = row.getCell(1).value ? String(row.getCell(1).value).trim() : '';
    const vinColB = row.getCell(2).value ? String(row.getCell(2).value).trim() : '';
    const groundTruthColF = row.getCell(6).value ? String(row.getCell(6).value).trim() : '';

    if (groundTruthColF) {
      totalGt++;
      const corrected = postCorrectVin(vinColB);
      const isMatch = corrected === groundTruthColF;
      if (isMatch) fixedCount++;

      console.log(`[Row ${rowNum}] ${file}:`);
      console.log(`  Raw Col B:     ${vinColB}`);
      console.log(`  Corrected:     ${corrected}`);
      console.log(`  Ground Truth:  ${groundTruthColF}`);
      console.log(`  Result:        ${isMatch ? '✅ MATCHED!' : '❌ STILL DIFFERENT'}\n`);
    }
  });

  console.log(`Summary: Successfully corrected ${fixedCount} out of ${totalGt} ground truth rows! (${Math.round((fixedCount/totalGt)*100)}% accuracy)`);
}

testVinJoiner().catch(console.error);
