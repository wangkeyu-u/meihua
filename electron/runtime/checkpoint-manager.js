import { readFile, writeFile, mkdir, readdir, stat, rename, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { resolveWorkspacePath } from '../workspace.js';
import { captureFile } from '../file-state.js';
import { readJson, saveJson } from '../storage.js';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const idPattern = /^[a-f0-9-]{36}$/;
export function textDiff(before, after, name, limit = 20000) {
  if (before.includes(0) || after.includes(0)) return '[二进制文件：保留增量备份，不生成文本 diff]';
  const oldLines = before.toString('utf8').split('\n'), newLines = after.toString('utf8').split('\n');
  let start = 0, tail = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  while (tail < oldLines.length - start && tail < newLines.length - start && oldLines.at(-1 - tail) === newLines.at(-1 - tail)) tail++;
  if (start === oldLines.length && start === newLines.length) return '';
  return [`--- a/${name}`, `+++ b/${name}`, `@@ -${start + 1},${oldLines.length - start - tail} +${start + 1},${newLines.length - start - tail} @@`, ...oldLines.slice(start, oldLines.length - tail).map((line) => '-' + line), ...newLines.slice(start, newLines.length - tail).map((line) => '+' + line)].join('\n').slice(0, limit);
}
export class CheckpointManager {
  constructor(root, { maxFileBytes = 15 * 1024 * 1024, maxTaskBytes = 100 * 1024 * 1024 } = {}) { this.root = root; this.maxFileBytes = maxFileBytes; this.maxTaskBytes = maxTaskBytes; }
  directory(taskId) { if (!idPattern.test(taskId)) throw new Error('无效的任务 ID'); return path.join(this.root, 'checkpoints', taskId); }
  blob(hashValue) { if (!/^[a-f0-9]{64}$/.test(hashValue)) throw new Error('无效的备份摘要'); return path.join(this.root, 'blobs', hashValue); }
  async snapshot(workspace, requested) {
    const captured = await captureFile(workspace, requested, { allowMissing: true, maxBytes: this.maxFileBytes });
    if (captured.hash === null) return { exists: false, hash: null, size: 0, mode: null };
    const info = await stat(captured.file), bytes = await readFile(captured.file);
    if (hash(bytes) !== captured.hash) throw new Error('建立 checkpoint 时文件已变化');
    await mkdir(path.join(this.root, 'blobs'), { recursive: true });
    try { await writeFile(this.blob(captured.hash), bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    return { exists: true, hash: captured.hash, size: bytes.length, mode: info.mode & 0o777 };
  }
  async list(taskId) {
    let names;
    try { names = await readdir(this.directory(taskId)); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return (await Promise.all(names.filter((name) => idPattern.test(name.slice(0, -5)) && name.endsWith('.json')).map((name) => readJson(path.join(this.directory(taskId), name), null))))
      .filter(Boolean).sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.sequence - b.sequence);
  }
  async begin(taskId, stepId, workspace, requested) {
    workspace = await realpath(workspace);
    const file = await resolveWorkspacePath(workspace, requested, { forWrite: true });
    const records = await this.list(taskId), captured = await captureFile(workspace, requested, { allowMissing: true, maxBytes: this.maxFileBytes });
    const beforeSize = captured.hash === null ? 0 : (await stat(captured.file)).size;
    // Reserve room for the after snapshot before touching the file, including unknown-size document exports.
    if (records.reduce((sum, item) => sum + item.before.size + (item.after?.size || 0), 0) + beforeSize + this.maxFileBytes > this.maxTaskBytes) throw new Error('本次任务 checkpoint 容量不足，请缩小任务范围');
    const before = await this.snapshot(workspace, requested);
    if (before.hash !== captured.hash) throw new Error('建立 checkpoint 时文件已变化');
    const record = { schemaVersion: 1, id: randomUUID(), taskId, stepId, workspace, path: path.relative(workspace, file), before, after: null, hash: before.hash, timestamp: new Date().toISOString(), sequence: records.length + 1, status: 'prepared' };
    await saveJson(path.join(this.directory(taskId), `${record.id}.json`), record);
    return record;
  }
  async complete(record) {
    record.after = await this.snapshot(record.workspace, record.path);
    record.status = 'applied'; record.completedAt = new Date().toISOString(); record.hash = record.after.hash;
    await saveJson(path.join(this.directory(record.taskId), `${record.id}.json`), record);
    return record;
  }
  async cancelUnchanged(record) {
    if (record.status !== 'prepared') return false;
    if (await realpath(record.workspace) !== record.workspace) throw new Error('工作目录的真实路径已变化');
    const current = await captureFile(record.workspace, record.path, { allowMissing: true, maxBytes: this.maxFileBytes });
    if (current.hash !== record.before.hash) return false;
    record.after = record.before; record.status = 'unchanged'; record.completedAt = new Date().toISOString();
    await saveJson(path.join(this.directory(record.taskId), `${record.id}.json`), record);
    return true;
  }
  async bytes(state) { const bytes = state.exists ? await readFile(this.blob(state.hash)) : Buffer.alloc(0); if (state.exists && hash(bytes) !== state.hash) throw new Error('checkpoint 备份已损坏'); return bytes; }
  async diff(record) { return textDiff(await this.bytes(record.before), await this.bytes(record.after || { exists: false }), record.path); }
  async assertCurrent(record, expected = record.after) {
    if (await realpath(record.workspace) !== record.workspace) throw new Error('工作目录的真实路径已变化');
    if (!expected) throw new Error('这次修改在记录结果前被中断，不能自动覆盖当前文件；原始备份已保留');
    const current = await captureFile(record.workspace, record.path, { allowMissing: true, maxBytes: this.maxFileBytes });
    if (current.hash !== expected.hash) throw new Error(`文件已被其他操作修改，无法撤销：${record.path}`);
    return current;
  }
  async restore(record, expected = record.after) {
    const current = await this.assertCurrent(record, expected);
    if (!record.before.exists) { if (current.hash !== null) await rm(current.file); }
    else {
      const bytes = await this.bytes(record.before);
      const temporary = `${current.file}.meihua-${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, bytes, { flag: 'wx', mode: record.before.mode || 0o600 });
        await this.assertCurrent(record, expected);
        if (current.hash === null) { await writeFile(current.file, bytes, { flag: 'wx', mode: record.before.mode || 0o600 }); }
        else await rename(temporary, current.file);
      } finally { await rm(temporary, { force: true }); }
    }
    record.status = 'restored'; record.restoredAt = new Date().toISOString();
    await saveJson(path.join(this.directory(record.taskId), `${record.id}.json`), record);
    return record.path;
  }
  async undoLatest(taskId) {
    const record = (await this.list(taskId)).filter((item) => item.status === 'applied').at(-1);
    if (!record) throw new Error('没有可撤销的文件修改');
    return [await this.restore(record)];
  }
  async restoreTask(taskId) {
    return this.restoreRecords(await this.list(taskId));
  }
  async restoreRecords(items) {
    const records = items.filter((item) => !['restored', 'unchanged'].includes(item.status));
    const byPath = new Map();
    for (const record of records) { const previous = byPath.get(record.path); byPath.set(record.path, { first: previous?.first || record, last: record }); }
    for (const { last } of byPath.values()) await this.assertCurrent(last);
    const restored = [];
    for (const { first, last } of byPath.values()) {
      await this.restore(first, last.after); restored.push(first.path);
      for (const record of records.filter((item) => item.path === first.path && item.id !== first.id)) { record.status = 'restored'; record.restoredAt = new Date().toISOString(); await saveJson(path.join(this.directory(record.taskId), `${record.id}.json`), record); }
    }
    return restored;
  }
}
