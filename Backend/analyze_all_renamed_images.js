import ExcelJS from 'exceljs';
import fs from 'fs';
import path from 'path';

async function analyzeAllRenamedImages() {
  const excelPath = `C:\\Users\\hp\\Downloads\\1_Result\\vehicles.xlsx`;
  const renamedDir = `C:\\Users\\hp\\Downloads\\1_Result\\renamed_images`;
  const failedDir = `C:\\Users\\hp\\Downloads\\1_Result\\failed`;

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(excelPath);
  const sheet = workbook.getWorksheet(1);

  const rows = [];
  sheet.eachRow((row, rowNum) => {
    if (rowNum === 1) return;
    const file = row.getCell(1).value ? String(row.getCell(1).value).trim() : '';
    const vin = row.getCell(2).value ? String(row.getCell(2).value).trim() : '';
    const eng = row.getCell(3).value ? String(row.getCell(3).value).trim() : '';
    const stock = row.getCell(6).value ? String(row.getCell(6).value).trim() : '';

    const existsInRenamed = fs.existsSync(path.join(renamedDir, file));
    const existsInFailed = fs.existsSync(path.join(failedDir, file));

    rows.push({
      rowNum,
      file,
      vin,
      eng,
      stock,
      existsInRenamed,
      existsInFailed,
      hasVinInExcel: Boolean(vin),
      hasStockInExcel: Boolean(stock),
    });
  });

  console.log(`Total Excel Rows: ${rows.length}`);
  console.log(`Images present in renamed_images: ${rows.filter(r => r.existsInRenamed).length}`);
  console.log(`Images present in failed folder: ${rows.filter(r => r.existsInFailed).length}`);
  
  console.log("\n--- EXCEL ROWS WITH GROUND TRUTH IN STOCK SHEET (COL F) ---");
  const withStock = rows.filter(r => r.hasStockInExcel);
  console.table(withStock.map(r => ({
    Row: r.rowNum,
    File: r.file,
    CurrentExtractedVIN: r.vin,
    GroundTruthStockSheet: r.stock,
    InFailedDir: r.existsInFailed
  })));

  console.log("\n--- EXCEL ROWS WHERE VIN IS EMPTY/FAILED ---");
  const emptyVin = rows.filter(r => !r.hasVinInExcel);
  console.log(`Total empty VIN rows: ${emptyVin.length}`);
  console.table(emptyVin.slice(0, 25).map(r => ({
    Row: r.rowNum,
    File: r.file,
    Eng: r.eng,
    Stock: r.stock,
    InFailedDir: r.existsInFailed
  })));
}

analyzeAllRenamedImages().catch(console.error);
