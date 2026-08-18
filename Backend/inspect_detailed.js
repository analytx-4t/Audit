import ExcelJS from 'exceljs';
import fs from 'fs';

async function detailedExcelInspection() {
  const excelPath = `C:\\Users\\hp\\Downloads\\1_Result\\vehicles.xlsx`;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(excelPath);

  const sheet = workbook.getWorksheet(1);
  const rows = [];

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // skip header

    const cellA = row.getCell(1);
    const cellB = row.getCell(2);
    const cellC = row.getCell(3);
    const cellF = row.getCell(6);

    const fileName = cellA.value ? String(cellA.value).trim() : '';
    const vinVal = cellB.value ? String(cellB.value).trim() : '';
    const engVal = cellC.value ? String(cellC.value).trim() : '';
    const stockSheetVal = cellF.value ? String(cellF.value).trim() : '';

    // Check font color for cellB
    let fontColor = '';
    if (cellB.font && cellB.font.color) {
      fontColor = JSON.stringify(cellB.font.color);
    }

    rows.push({
      rowNumber,
      fileName,
      vinVal,
      engVal,
      stockSheetVal,
      fontColor,
      isRed: fontColor.includes('FF0000') || fontColor.includes('red') || fontColor.includes('9C0006') || fontColor.includes('FFC7CE')
    });
  });

  console.log(`Total Rows: ${rows.length}`);
  console.log("\nRows with ground truth in Stock Sheet (Col F) or Red Font or Failed VIN:");
  
  const relevantRows = rows.filter(r => r.stockSheetVal || r.vinVal === '' || r.isRed || r.engVal === 'ers Enclave');
  console.table(relevantRows.map(r => ({
    Row: r.rowNumber,
    FileName: r.fileName,
    ExtractedVIN: r.vinVal,
    ExtractedEng: r.engVal,
    StockSheetGroundTruth: r.stockSheetVal,
    IsRed: r.isRed
  })));

  console.log("\n--- All Rows Summary ---");
  console.table(rows.slice(0, 40).map(r => ({
    Row: r.rowNumber,
    FileName: r.fileName,
    ExtractedVIN: r.vinVal,
    ExtractedEng: r.engVal,
    StockSheet: r.stockSheetVal,
  })));
}

detailedExcelInspection().catch(console.error);
