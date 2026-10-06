import { DatabaseSync, constants } from 'node:sqlite';

process.once('message', (workerData) => {
let db;
try {
  db = new DatabaseSync(workerData.file, { readOnly: true, allowExtension: false, timeout: 1000 });
  db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF');
  if (typeof db.setAuthorizer !== 'function') throw new Error('当前 SQLite 运行环境不支持查询授权，不会降低权限');
  const allowed = new Set([constants.SQLITE_SELECT, constants.SQLITE_READ, constants.SQLITE_FUNCTION, constants.SQLITE_RECURSIVE]);
  db.setAuthorizer((action, name, functionName) => allowed.has(action) && !(action === constants.SQLITE_FUNCTION && ['load_extension', 'readfile', 'writefile', 'randomblob', 'zeroblob', 'printf', 'format'].includes(String(functionName || name).toLowerCase())) ? constants.SQLITE_OK : constants.SQLITE_DENY);
  const rows = []; let bytes = 0, truncated = false;
  for (const row of db.prepare(workerData.sql).iterate(...workerData.params)) {
    const safe = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'bigint' ? String(value) : value instanceof Uint8Array ? `[binary ${value.byteLength} B]` : value]));
    bytes += JSON.stringify(safe).length; if (rows.length >= 500 || bytes > 100000) { truncated = true; break; } rows.push(safe);
  }
  process.send({ rows, truncated });
} catch (error) { process.send({ error: `只读 SQL 查询失败：${error.message}` }); }
finally { db?.close(); }

});
