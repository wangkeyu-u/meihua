import { captureFile } from '../file-state.js';
import { randomUUID } from 'node:crypto';

export class WorkingMemory {
  constructor(manager) { this.manager = manager; }
  async save(taskId, workspace, { nodeId, summary, files = [], facts = [], sources: observed = [] }) {
    if (typeof summary !== 'string' || summary.length > 12000 || !Array.isArray(files) || files.length > 30 || !Array.isArray(facts) || facts.length > 50 || !Array.isArray(observed) || observed.length > 200) throw new Error('工作记忆格式或大小不正确');
    const sources = [];
    for (const source of observed) { const state = await captureFile(workspace, source.path, { maxBytes: 100 * 1024 * 1024 }); if (state.hash !== source.hash) throw new Error('资料读取后已经变化，无法把旧结论传给后续节点'); if (!sources.some((item) => item.path === source.path)) sources.push({ path: source.path, hash: source.hash }); }
    for (const requested of files) { const state = await captureFile(workspace, requested); sources.push({ path: requested, hash: state.hash }); }
    const entry = { id: randomUUID(), nodeId, summary, facts: facts.map((fact) => String(fact).slice(0, 2000)), sources, timestamp: new Date().toISOString(), trusted: false };
    await this.manager.mutate(taskId, (record) => { const items = record.workingMemory || []; record.workingMemory = [...items.filter((item) => item.nodeId !== nodeId), entry].slice(-30); });
    return entry;
  }
  async retrieve(record, nodeIds = null) {
    const entries = [];
    for (const entry of record.workingMemory || []) {
      if (nodeIds && !nodeIds.includes(entry.nodeId)) continue;
      let valid = true;
      for (const source of entry.sources) { try { if ((await captureFile(record.workspace, source.path, { maxBytes: 100 * 1024 * 1024 })).hash !== source.hash) valid = false; } catch { valid = false; } }
      entries.push({ ...entry, valid, ...(valid ? {} : { warning: '来源文件已变化，需要重新读取核对' }) });
    }
    return entries;
  }
}
