import { spawn } from 'node:child_process';
import { captureFile, assertFileUnchanged } from './file-state.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function queryDatabase(workspace, requested, sql, { signal, timeoutMs = 5000, params = [] } = {}) {
  if (typeof sql !== 'string' || !sql.trim() || sql.length > 10000 || !Array.isArray(params) || params.length > 100 || params.some((value) => value !== null && !['string', 'number'].includes(typeof value))) throw new Error('SQL 查询或参数格式不正确');
  if (!/\.(sqlite|sqlite3|db)$/i.test(requested)) throw new Error('请选择工作目录内的 SQLite 数据库');
  signal?.throwIfAborted(); const snapshot = await captureFile(workspace, requested, { maxBytes: 100 * 1024 * 1024 });
  const sidecars = await Promise.all(['-wal', '-shm', '-journal'].map(async (suffix) => ({ path: requested + suffix, state: await captureFile(workspace, requested + suffix, { allowMissing: true, maxBytes: 100 * 1024 * 1024 }) })));
  // A worker thread cannot interrupt a native SQLite step. A separate process can be killed reliably.
  const child = spawn(process.execPath, ['--max-old-space-size=64', path.join(path.dirname(fileURLToPath(import.meta.url)), 'sql-worker.js')], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], detached: process.platform !== 'win32', env: { ELECTRON_RUN_AS_NODE: '1', PATH: '/usr/bin:/bin' } });
  const rows = await new Promise((resolve, reject) => {
    let settled = false, answer, failure;
    const kill = () => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); } };
    const finish = (error, data) => { if (settled) return; settled = true; failure = error; answer = data; clearTimeout(timer); signal?.removeEventListener('abort', abort); kill(); };
    const abort = () => finish(signal.reason || new Error('SQL 查询已停止'));
    const timer = setTimeout(() => finish(new Error('SQL 查询超时')), timeoutMs);
    child.once('message', (result) => result.error ? finish(new Error(result.error)) : finish(null, result));
    child.once('error', (error) => { finish(error); reject(error); });
    child.once('exit', (code) => { if (!settled) finish(new Error(`SQL 工作进程提前退出：${code}`)); failure ? reject(failure) : resolve(answer); });
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    if (!settled) child.send({ file: snapshot.file, sql, params }, (error) => { if (error) finish(error); });
  });
  await assertFileUnchanged(workspace, requested, snapshot);
  // -shm is SQLite's coordination file; its bytes can change during a read. Guard its path, not its transient lock bytes.
  for (const sidecar of sidecars.filter((entry) => !entry.path.endsWith('-shm'))) await assertFileUnchanged(workspace, sidecar.path, sidecar.state, { allowMissing: true, maxBytes: 100 * 1024 * 1024 });
  await captureFile(workspace, requested + '-shm', { allowMissing: true, maxBytes: 100 * 1024 * 1024 });
  return { ...rows, path: requested, hash: snapshot.hash, source: 'file', trusted: false };
}
