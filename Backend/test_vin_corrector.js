import ExcelJS from 'exceljs';

// ISO 3779 VIN Corrector for Indian Vehicles
function correctIndianVin(rawVin) {
  if (!rawVin) return rawVin;
  let vin = rawVin.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

  if (vin.length !== 17) return rawVin; // Only apply to 17-char VINs

  let chars = vin.split('');

  // 1. WMI Correction (Positions 1-3)
  // WMI for Maruti is MA3, Hyundai is MAL, Mahindra MA1, Tata MAT, Eicher MEX/MA8
  if (chars[0] === 'M' && chars[1] === 'A') {
    if (chars[2] === 'S' || chars[2] === 'B') chars[2] = '3';
  }
  if (chars[0] === 'M' && chars[1] === 'A' && chars[2] === 'R') {
    chars[2] = '3';
  }

  // 2. Position 10 (Model Year) MUST BE A LETTER (e.g. S for 2025, T for 2026, R for 2024)
  if (/[0-9]/.test(chars[9])) {
    if (chars[9] === '5') chars[9] = 'S';
    else if (chars[9] === '8') chars[9] = 'B';
    else if (chars[9] === '0') chars[9] = 'O';
    else if (chars[9] === '6') chars[9] = 'G';
  }

  // 3. Positions 12-17 MUST BE 6 DIGITS (0-9)
  for (let i = 11; i < 17; i++) {
    const c = chars[i];
    if (/[A-Z]/.test(c)) {
      if (c === 'S') chars[i] = '5';
      else if (c === 'B') chars[i] = '8';
      else if (c === 'O' || c === 'Q' || c === 'D') chars[i] = '0';
      else if (c === 'I' || c === 'L') chars[i] = '1';
      else if (c === 'Z') chars[i] = '2';
      else if (c === 'G') chars[i] = '6';
      else if (c === 'A') chars[i] = '4';
    }
  }

  // 4. Position 4-9 (VDS) specific common misread corrections
  // Pos 4 (index 3) in MA3BNC... if '8' -> 'B'
  if (chars[0] === 'M' && chars[1] === 'A' && chars[2] === '3' && chars[3] === '8') {
    chars[3] = 'B';
  }
  // Pos 8 (index 7) in MA3BNC72STFD... if '5' -> 'S'
  if (chars[0] === 'M' && chars[1] === 'A' && chars[2] === '3' && chars[7] === '5') {
    chars[7] = 'S';
  }

  return chars.join('');
}

async function testVinCorrector() {
  const excelPath = `C:\\Users\\hp\\Downloads\\1_Result\\vehicles.xlsx`;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(excelPath);
  const sheet = workbook.getWorksheet(1);

  console.log("Testing ISO 3779 VIN Rule Corrector on vehicles.xlsx ground truth rows...\n");

  let fixedCount = 0;
  sheet.eachRow((row, rowNum) => {
    if (rowNum === 1) return;
    const file = row.getCell(1).value ? String(row.getCell(1).value).trim() : '';
    const vinColB = row.getCell(2).value ? String(row.getCell(2).value).trim() : '';
    const groundTruthColF = row.getCell(6).value ? String(row.getCell(6).value).trim() : '';

    if (groundTruthColF && vinColB) {
      const corrected = correctIndianVin(vinColB);
      const isMatch = corrected === groundTruthColF;
      console.log(`[Row ${rowNum}] ${file}:`);
      console.log(`  Raw Col B:     ${vinColB}`);
      console.log(`  Corrected:     ${corrected}`);
      console.log(`  Ground Truth:  ${groundTruthColF}`);
      console.log(`  Result:        ${isMatch ? '✅ MATCHED!' : '❌ STILL DIFFERENT'}\n`);
      if (isMatch) fixedCount++;
    }
  });

  console.log(`Summary: Fixed ${fixedCount} out of ground truth rows using ISO 3779 rules!`);
}

testVinCorrector().catch(console.error);
