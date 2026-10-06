import path from 'node:path';
import { readdir, readFile, lstat, unlink, rmdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { readJson, saveJson } from '../storage.js';
import { terminalStatuses, taskEvent } from './task-events.js';

const idPattern = /^[a-f0-9-]{36}$/, hashPattern = /^[a-f0-9]{64}$/;
const digest = (value) => createHash('sha256').update(value).digest('hex');
const signature = (info) => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs];
const invalid = () => { throw new Error('备份目录有无法确认的记录，未清理任何内容；请保留原始数据并检查'); };
async function names(directory) {
  try { const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) invalid(); return (await readdir(directory)).sort(); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
function validState(state) {
  return state && typeof state.exists === 'boolean' && Number.isSafeInteger(state.size) && state.size >= 0 &&
    (state.exists ? hashPattern.test(state.hash) : state.hash === null && state.size === 0);
}

// No timer: changing the policy only changes which backups a user may preview and delete.
export class BackupRetention {
  constructor(root, store, manager) { Object.assign(this, { root, store, manager }); this.plans = new Map(); }
  async policy() {
    const saved = await readJson(path.join(this.root, 'backup-policy.json'), { schemaVersion: 1, retainDays: 0 });
    if (saved.schemaVersion !== 1 || ![0, 7, 30, 90].includes(saved.retainDays)) throw new Error('备份保留配置格式不正确');
    return saved;
  }
  async savePolicy(retainDays) {
    if (![0, 7, 30, 90].includes(retainDays)) throw new Error('保留时间只支持永久、7、30 或 90 天');
    const policy = { schemaVersion: 1, retainDays }; await saveJson(path.join(this.root, 'backup-policy.json'), policy);
    this.plans.clear(); return policy;
  }
  async inventory() {
    const tasks = await this.store.list();
    if ([...this.store.warnings.values()].some((warning) => warning.blocksCleanup !== false)) invalid();
    const checkpoints = [], blobs = [];
    for (const taskId of await names(path.join(this.root, 'checkpoints'))) {
      if (!idPattern.test(taskId)) invalid();
      const directory = path.join(this.root, 'checkpoints', taskId);
      for (const name of await names(directory)) {
        if (!name.endsWith('.json') || !idPattern.test(name.slice(0, -5))) invalid();
        const file = path.join(directory, name), info = await lstat(file);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) invalid();
        const raw = await readFile(file); let record;
        try { record = JSON.parse(raw); } catch { invalid(); }
        if (!record || typeof record !== 'object') invalid();
        if (record.schemaVersion !== 1 || record.id !== name.slice(0, -5) || record.taskId !== taskId || !validState(record.before) ||
          !['prepared', 'applied', 'restored', 'unchanged'].includes(record.status) ||
          (record.status === 'prepared' ? record.after !== null : !validState(record.after))) invalid();
        checkpoints.push({ taskId, name, fingerprint: digest(raw), record });
      }
    }
    for (const name of await names(path.join(this.root, 'blobs'))) {
      const info = await lstat(path.join(this.root, 'blobs', name));
      if (!hashPattern.test(name) || !info.isFile() || info.isSymbolicLink()) invalid();
      blobs.push({ name, size: info.size, modifiedAt: info.mtimeMs, signature: signature(info) });
    }
    const fingerprint = digest(JSON.stringify({ tasks: tasks.map(({ id, status, updatedAt, checkpointsExpiredAt, completedAt }) => ({ id, status, updatedAt, checkpointsExpiredAt, completedAt })).sort((a, b) => a.id.localeCompare(b.id)), checkpoints: checkpoints.map(({ record, ...item }) => item), blobs }));
    return { tasks, checkpoints, blobs, fingerprint };
  }
  async preview(now = Date.now()) {
    const { retainDays } = await this.policy(), inventory = await this.inventory();
    const cutoff = now - retainDays * 86400000;
    const eligible = inventory.tasks.filter((task) => (!task.parentId || terminalStatuses.has(inventory.tasks.find((parent) => parent.id === task.parentId)?.status)) && retainDays > 0 && terminalStatuses.has(task.status) && Number.isFinite(Date.parse(task.completedAt)) && Date.parse(task.completedAt) <= cutoff &&
      inventory.checkpoints.some((item) => item.taskId === task.id) && !inventory.checkpoints.some((item) => item.taskId === task.id && item.record.status === 'prepared'));
    const eligibleIds = new Set(eligible.map((task) => task.id));
    const retained = new Set(inventory.checkpoints.filter((item) => !eligibleIds.has(item.taskId)).flatMap(({ record }) => [record.before.hash, record.after?.hash]).filter(Boolean));
    // Include orphaned snapshots only when timed retention was explicitly selected.
    const expiredHashes = new Set(inventory.checkpoints.filter((item) => eligibleIds.has(item.taskId)).flatMap(({ record }) => [record.before.hash, record.after?.hash]).filter(Boolean));
    const removableBlobs = retainDays > 0 ? inventory.blobs.filter((item) => !retained.has(item.name) && (expiredHashes.has(item.name) || item.modifiedAt <= cutoff)) : [];
    const plan = { id: randomUUID(), expiresAt: now + 5 * 60000, retainDays, fingerprint: inventory.fingerprint, tasks: eligible.map(({ id, status, completedAt }) => ({ id, status, completedAt, files: inventory.checkpoints.filter((item) => item.taskId === id).length })), blobs: removableBlobs, checkpointFiles: inventory.checkpoints.filter((item) => eligibleIds.has(item.taskId)).map(({ taskId, name }) => ({ taskId, name })) };
    for (const [id, entry] of this.plans) if (entry.expiresAt <= now) this.plans.delete(id);
    this.plans.set(plan.id, plan);
    return { id: plan.id, expiresAt: new Date(plan.expiresAt).toISOString(), retainDays, tasks: plan.tasks, bytes: removableBlobs.reduce((sum, item) => sum + item.size, 0), blobs: removableBlobs.length, protectedTasks: new Set(inventory.checkpoints.filter((item) => !eligibleIds.has(item.taskId)).map((item) => item.taskId)).size };
  }
  async apply(id, now = Date.now()) {
    const plan = this.plans.get(id); this.plans.delete(id);
    if (!plan || now >= plan.expiresAt) throw new Error('清理预览已过期，请重新预览');
    const inventory = await this.inventory();
    if ((await this.policy()).retainDays !== plan.retainDays || inventory.fingerprint !== plan.fingerprint) throw new Error('任务或备份已变化，请重新预览；未清理任何内容');
    const result = { tasks: 0, blobs: 0, bytes: 0, errors: [] };
    // Persist the loss of restore capability first. An interrupted cleanup can leave safe unused blobs.
    for (const task of plan.tasks) {
      await this.manager.mutate(task.id, (record) => {
        record.checkpointsExpiredAt = new Date(now).toISOString();
        record.events.push(taskEvent(record, 'checkpoint_expired', { retainDays: plan.retainDays }));
      });
      try {
        for (const file of plan.checkpointFiles.filter((item) => item.taskId === task.id)) await unlink(path.join(this.root, 'checkpoints', file.taskId, file.name));
        await rmdir(path.join(this.root, 'checkpoints', task.id)); result.tasks++;
      } catch { result.errors.push(`任务 ${task.id.slice(0, 8)} 的备份未完全清理，残留已保留`); }
    }
    // If metadata removal was incomplete, its blobs remain referenced and must survive.
    if (result.errors.length) return result;
    for (const blob of plan.blobs) {
      try {
        const file = path.join(this.root, 'blobs', blob.name), info = await lstat(file);
        if (!info.isFile() || info.isSymbolicLink() || JSON.stringify(signature(info)) !== JSON.stringify(blob.signature)) throw new Error('changed');
        await unlink(file); result.blobs++; result.bytes += blob.size;
      } catch { result.errors.push('部分备份文件发生变化或无法删除，已保留'); }
    }
    return result;
  }
}
