import ExcelJS from 'exceljs';
import path from 'path';
import fs from 'fs';

async function inspectVehiclesExcel() {
  const excelPath = `C:\\Users\\hp\\Downloads\\1_Result\\vehicles.xlsx`;
  if (!fs.existsSync(excelPath)) {
    console.error("Excel file not found at:", excelPath);
    return;
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(excelPath);

  const sheet = workbook.getWorksheet(1);
  console.log(`Worksheet name: ${sheet.name}, Total rows: ${sheet.rowCount}`);

  const rowsData = [];
  sheet.eachRow((row, rowNumber) => {
    // Column A: Filename, Column B: Extracted/Raw, Column F: Ground Truth
    const colA = row.getCell(1).value;
    const colB = row.getCell(2).value;
    const colC = row.getCell(3).value;
    const colD = row.getCell(4).value;
    const colE = row.getCell(5).value;
    const colF = row.getCell(6).value;

    rowsData.push({
      rowNumber,
      colA: colA ? String(colA).trim() : '',
      colB: colB ? String(colB).trim() : '',
      colC: colC ? String(colC).trim() : '',
      colD: colD ? String(colD).trim() : '',
      colE: colE ? String(colE).trim() : '',
      colF: colF ? String(colF).trim() : '',
    });
  });

  console.log("Header row:", rowsData[0]);
  console.log("\nSample Data Rows (First 15):");
  console.table(rowsData.slice(0, 20));

  // Count red / incorrect or failed rows
  let failedCount = 0;
  let mismatchCount = 0;
  for (let i = 1; i < rowsData.length; i++) {
    const r = rowsData[i];
    if (!r.colB || r.colB.includes("FAILED") || r.colB === "-" || r.colB === "") {
      failedCount++;
    }
    if (r.colF && r.colF !== r.colB) {
      mismatchCount++;
    }
  }

  console.log(`\nTotal Data Rows: ${rowsData.length - 1}`);
  console.log(`Failed Rows in Col B: ${failedCount}`);
  console.log(`Mismatched Rows (Col B vs Col F): ${mismatchCount}`);
}

inspectVehiclesExcel().catch(console.error);
