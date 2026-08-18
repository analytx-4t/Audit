import ExcelJS from 'exceljs';
import fs from 'fs';
import path from 'path';

async function checkFailedGroundTruth() {
  const excelPath = `C:\\Users\\hp\\Downloads\\1_Result\\vehicles.xlsx`;
  const failedDir = `C:\\Users\\hp\\Downloads\\1_Result\\failed`;

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(excelPath);
  const sheet = workbook.getWorksheet(1);

  const failedFiles = fs.readdirSync(failedDir).filter(f => /\.(jpg|jpeg|png)$/i.test(f));

  console.log(`Checking ground truth in vehicles.xlsx for all ${failedFiles.length} files in failed folder...\n`);

  const results = [];

  failedFiles.forEach(file => {
    let foundInExcel = false;
    sheet.eachRow((row, rowNum) => {
      if (rowNum === 1) return;
      const fileNameInExcel = row.getCell(1).value ? String(row.getCell(1).value).trim() : '';
      if (fileNameInExcel === file) {
        foundInExcel = true;
        const vin = row.getCell(2).value ? String(row.getCell(2).value).trim() : '';
        const eng = row.getCell(3).value ? String(row.getCell(3).value).trim() : '';
        const hmil = row.getCell(4).value ? String(row.getCell(4).value).trim() : '';
        const stock = row.getCell(6).value ? String(row.getCell(6).value).trim() : '';
        
        results.push({
          file,
          rowNum,
          vinInExcel: vin,
          engInExcel: eng,
          stockGroundTruth: stock,
        });
      }
    });

    if (!foundInExcel) {
      results.push({
        file,
        rowNum: '-',
        vinInExcel: 'NOT FOUND IN EXCEL',
        engInExcel: '-',
        stockGroundTruth: '-',
      });
    }
  });

  console.table(results);

  const hasAnyTruthInStock = results.filter(r => r.stockGroundTruth && r.stockGroundTruth !== '-');
  const hasAnyVinInExcel = results.filter(r => r.vinInExcel && r.vinInExcel !== 'NOT FOUND IN EXCEL');

  console.log(`\nFailed files count: ${failedFiles.length}`);
  console.log(`Failed files with Stock Sheet Ground Truth in Col F: ${hasAnyTruthInStock.length}`);
  console.log(`Failed files with VIN in Col B: ${hasAnyVinInExcel.length}`);
}

checkFailedGroundTruth().catch(console.error);
