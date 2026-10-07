import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { queryDatabase } from '../electron/sql-query.js';

for (const [label, params] of [
  ['NaN', [NaN]],
  ['positive infinity', [Infinity]],
  ['negative infinity', [-Infinity]],
  ['empty array slot', Array(1)],
  ['interior array slot', [0, , 1]],
]) {
  test(`rejects ${label} before accessing a missing workspace or database`, async () => {
    await assert.rejects(
      queryDatabase('/missing-sql-parameter-workspace', 'missing.sqlite', 'SELECT ?', { params }),
      { message: 'SQL 查询或参数格式不正确' },
    );
  });
}

test('valid parameters preserve values through the real SQL subprocess without changing the database', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'meihua-sql-parameters-'));
  try {
    const file = path.join(directory, 'fixture.sqlite');
    const db = new DatabaseSync(file);
    try { db.exec('CREATE TABLE records (id INTEGER PRIMARY KEY); INSERT INTO records VALUES (1), (2)'); }
    finally { db.close(); }
    const before = await readFile(file);
    const workspace = directory;
    const result = await queryDatabase(workspace, 'fixture.sqlite', 'SELECT ? AS absent, ? AS label, ? AS amount, ? AS fraction, ? AS huge', {
      params: [null, '中文 $& </script>', 0, -0.25, 1e300],
    });
    assert.deepEqual(result.rows.map((row) => ({ ...row })), [{ absent: null, label: '中文 $& </script>', amount: 0, fraction: -0.25, huge: 1e300 }]);
    const filtered = await queryDatabase(workspace, 'fixture.sqlite', 'SELECT id FROM records WHERE (? IS NULL OR id = ?) ORDER BY id', { params: [2, 2] });
    assert.deepEqual(filtered.rows.map((row) => ({ ...row })), [{ id: 2 }]);
    const unfiltered = await queryDatabase(workspace, 'fixture.sqlite', 'SELECT id FROM records WHERE (? IS NULL OR id = ?) ORDER BY id', { params: [null, null] });
    assert.deepEqual(unfiltered.rows.map((row) => ({ ...row })), [{ id: 1 }, { id: 2 }]);
    const empty = await queryDatabase(workspace, 'fixture.sqlite', 'SELECT 42 AS answer');
    assert.deepEqual(empty.rows.map((row) => ({ ...row })), [{ answer: 42 }]);
    assert.deepEqual(await readFile(file), before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
