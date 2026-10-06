import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import ExcelJS from 'exceljs';
import { OfficeParser } from 'officeparser';
import { exportOffice } from '../electron/office.js';

test('exports a Word document from Markdown without overwriting it', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zhuge-office-'));
  try {
    const source = path.join(dir, 'summary.md');
    const target = path.join(dir, 'summary.docx');
    await writeFile(source, '# 项目摘要\n\n这是一份测试文档。');
    await exportOffice(source, target);
    const text = (await (await OfficeParser.parseOffice(target)).to('text')).value;
    assert.match(text, /测试文档/);
    await assert.rejects(exportOffice(source, target), /EEXIST/);
    assert.match(await readFile(source, 'utf8'), /项目摘要/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('exports CSV to an XLSX workbook with the same cell text', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zhuge-office-'));
  try {
    const source = path.join(dir, 'data.csv');
    const target = path.join(dir, 'data.xlsx');
    await writeFile(source, '姓名,编号\n张三,0012\n');
    await exportOffice(source, target);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(target);
    assert.equal(workbook.worksheets[0].getCell('B2').value, '0012');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('PDF export delegates rendering to the desktop engine', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zhuge-office-'));
  try {
    const source = path.join(dir, 'summary.md');
    const target = path.join(dir, 'summary.pdf');
    await writeFile(source, '# 中文报告\n\n这是一段中文内容。');
    let renderedHtml = '';
    await exportOffice(source, target, async (html) => {
      renderedHtml = html;
      return Buffer.from('%PDF-mock');
    });
    assert.equal((await readFile(target)).subarray(0, 5).toString(), '%PDF-');
    assert.match(renderedHtml, /中文内容/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('pausing while a document is rendered prevents the final file write', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'meihua-export-pause-'));
  try {
    const source = path.join(dir, 'source.md'), target = path.join(dir, 'paused.pdf'), controller = new AbortController();
    await writeFile(source, '# Report');
    await assert.rejects(exportOffice(source, target, async () => { controller.abort(new Error('paused')); return Buffer.from('%PDF-test'); }, { signal: controller.signal }), /paused/);
    await assert.rejects(readFile(target), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
