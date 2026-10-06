import path from 'node:path';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { saveJson } from '../storage.js';
import { validateTask, upgradeTask, taskSchemaVersion } from './task-schema.js';
import { TaskJournal, recordDigest, preserveBytes } from './task-journal.js';

export class TaskStore {
  constructor(root, { project = saveJson } = {}) { this.root = root; this.pending = new Map(); this.warnings = new Map(); this.journal = new TaskJournal(root); this.project = project; }
  file(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效的任务 ID');
    return path.join(this.root, 'tasks', `${id}.json`);
  }
  async read(id) {
    let raw, bytes, projection, projectionError, marker;
    try { bytes = await readFile(this.file(id)); raw = bytes.toString('utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (raw !== undefined) {
      try {
        projection = JSON.parse(raw);
        marker = projection?._journal;
        // A future projection must not be downgraded by an older application.
        if (projection?.schemaVersion > taskSchemaVersion) validateTask(projection, id);
        projection = validateTask(projection, id);
        projection = { ...projection }; delete projection._journal;
      } catch (error) {
        if (!(error instanceof SyntaxError) && error.code !== 'TASK_FORMAT_INVALID') throw error;
        if (projection?.schemaVersion > taskSchemaVersion) throw error;
        projectionError = error;
      }
    }
    const logged = await this.journal.load(id);
    if (marker !== undefined) {
      if (!marker || marker.schemaVersion !== 1 || !Number.isSafeInteger(marker.sequence) || marker.sequence < 1 || !/^[a-f0-9]{64}$/.test(marker.hash) || !/^[a-f0-9]{64}$/.test(marker.recordHash) || !logged || marker.sequence > logged.sequence || marker.sequence === logged.sequence && (marker.hash !== logged.hash || marker.recordHash !== recordDigest(logged.record))) {
        throw Object.assign(new Error('任务视图与追加日志的提交位置不一致，原始数据保留；不能退回旧状态继续执行'), { code: 'TASK_JOURNAL_INVALID' });
      }
    }
    if (logged) {
      if (raw === undefined || projectionError || recordDigest(projection) !== recordDigest(logged.record)) {
        const backup = raw === undefined ? logged.recoveryFile : await preserveBytes(this.root, id, 'projection.json', bytes);
        await this.projectRecord(id, logged.record, { kind: 'recovered', blocksCleanup: false, file: backup || this.journal.file(id), message: '已从追加日志恢复任务记录；原始数据保留，没有重新执行工具。' }, logged);
      } else if (!marker) {
        await this.projectRecord(id, logged.record, null, logged);
      } else if (logged.recoveryFile) this.warnings.set(id, { id, kind: 'recovered', blocksCleanup: false, file: logged.recoveryFile, message: '上次日志末尾未写完，已保留原始副本并恢复完整记录；没有重新执行工具。' });
      else if (this.warnings.get(id)?.kind !== 'recovered') this.warnings.delete(id);
      return structuredClone(logged.record);
    }
    if (projectionError) throw projectionError;
    if (!projection) return null;
    const record = projection;
    if (record.schemaVersion < taskSchemaVersion) {
      const digest = createHash('sha256').update(bytes).digest('hex'), backup = path.join(this.root, 'migrations', `${id}.${digest}.v${record.schemaVersion}.json`);
      await mkdir(path.dirname(backup), { recursive: true });
      try { await writeFile(backup, bytes, { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; if (createHash('sha256').update(await readFile(backup)).digest('hex') !== digest) throw new Error('任务升级备份已损坏，原文件未修改'); }
      const upgraded = validateTask(upgradeTask(record), id);
      const committed = await this.journal.append(id, upgraded);
      await this.projectRecord(id, upgraded, null, committed); return upgraded;
    }
    const committed = await this.journal.append(id, record); await this.projectRecord(id, record, null, committed); return record;
  }
  async projectRecord(id, record, recoveryNotice = null, logged) {
    logged ||= await this.journal.load(id);
    try {
      await this.project(this.file(id), { ...record, _journal: { schemaVersion: 1, sequence: logged.sequence, hash: logged.hash, recordHash: recordDigest(record) } });
      if (recoveryNotice) this.warnings.set(id, { id, ...recoveryNotice });
      else if (this.warnings.get(id)?.kind !== 'recovered') this.warnings.delete(id);
    } catch {
      // The synced journal is authoritative. Failing to update its view must not
      // turn a committed tool result into a failure that could invite a replay.
      this.warnings.set(id, { id, kind: 'projection-pending', blocksCleanup: true, file: this.file(id), message: '任务已保存到追加日志，但任务视图暂时无法更新；原数据保留，下次读取会重建。' });
    }
  }
  serialize(id, operation) {
    this.file(id);
    const previous = this.pending.get(id) || Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.pending.set(id, next);
    next.finally(() => { if (this.pending.get(id) === next) this.pending.delete(id); }).catch(() => {});
    return next;
  }
  get(id) { return this.serialize(id, () => this.read(id)); }
  async list() {
    const names = async (directory) => { try { return await readdir(path.join(this.root, directory)); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
    const [projections, journals] = await Promise.all([names('tasks'), names('journals')]);
    const ids = new Set([...projections.filter((name) => /^[a-f0-9-]{36}\.json$/.test(name)).map((name) => name.slice(0, -5)), ...journals.filter((name) => /^[a-f0-9-]{36}\.jsonl$/.test(name)).map((name) => name.slice(0, -6))]);
    for (const id of this.warnings.keys()) if (!ids.has(id)) this.warnings.delete(id);
    return (await Promise.all([...ids].map(async (id) => {
      try { return await this.get(id); }
      catch (error) {
        if (!(error instanceof SyntaxError) && !['TASK_FORMAT_INVALID', 'TASK_JOURNAL_INVALID'].includes(error.code)) throw error;
        this.warnings.set(id, { id, kind: 'invalid', blocksCleanup: true, file: error.code === 'TASK_JOURNAL_INVALID' ? this.journal.file(id) : this.file(id), message: '任务记录损坏或版本不受支持，原文件保留；其他任务可继续使用' });
        return null;
      }
    })))
      .filter(Boolean).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  mutate(id, change) {
    return this.serialize(id, async () => {
      const record = await this.read(id);
      const logged = await this.journal.load(id);
      const next = JSON.parse(JSON.stringify(await change(record)));
      if (Object.hasOwn(next || {}, '_journal')) throw Object.assign(new Error('任务不能修改日志提交标记'), { code: 'TASK_FORMAT_INVALID' });
      validateTask(next, id); const committed = await this.journal.append(id, next, logged);
      await this.projectRecord(id, next, null, committed);
      return next;
    });
  }
  async flush() { await Promise.all([...this.pending.values()]); }
}
