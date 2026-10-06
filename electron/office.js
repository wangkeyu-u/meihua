import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { parse } from 'csv-parse/sync';
import { OfficeConverter } from 'officeparser';

export async function exportOffice(source, target, renderPdf, { signal, beforeWrite = async () => {} } = {}) {
  const write = async (bytes) => { await beforeWrite(bytes); signal?.throwIfAborted(); await writeFile(target, bytes, { flag: 'wx' }); };
  signal?.throwIfAborted();
  const sourceExt = path.extname(source).toLowerCase();
  const targetExt = path.extname(target).toLowerCase();
  if (sourceExt === '.md' && targetExt === '.docx') {
    const { value } = await OfficeConverter.convert(source, 'docx');
    await write(Buffer.from(value));
    return;
  }
  if (sourceExt === '.md' && targetExt === '.pdf') {
    if (!renderPdf) throw new Error('PDF 导出需要桌面渲染器');
    const { value: html } = await OfficeConverter.convert(source, 'html');
    await write(await renderPdf(html));
    return;
  }
  if (sourceExt === '.csv' && targetExt === '.xlsx') {
    const rows = parse(await readFile(source, 'utf8'), { skip_empty_lines: false, relax_column_count: true });
    if (rows.length > 100000) throw new Error('CSV 超过 100000 行');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('数据');
    rows.forEach((row) => sheet.addRow(row));
    if (rows.length) {
      sheet.getRow(1).font = { bold: true };
      sheet.views = [{ state: 'frozen', ySplit: 1 }];
    }
    sheet.columns.forEach((column) => { column.width = 18; });
    const bytes = await workbook.xlsx.writeBuffer();
    await write(Buffer.from(bytes));
    return;
  }
  throw new Error('支持 Markdown → DOCX/PDF，或 CSV → XLSX');
}
