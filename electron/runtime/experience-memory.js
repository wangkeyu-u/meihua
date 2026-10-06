import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, saveJson } from '../storage.js';
import { captureFile } from '../file-state.js';
import { redact } from './task-events.js';

// Verified task evidence is a candidate, never an automatically trusted instruction.
export class ExperienceMemory {
  constructor(root) { this.file = path.join(root, 'experience-memory.json'); this.pending = Promise.resolve(); }
  async list() { const items = await readJson(this.file, []); if (!Array.isArray(items) || items.some((item) => !item?.id || !['candidate', 'approved', 'rejected'].includes(item.status) || !Array.isArray(item.sources) || typeof item.summary !== 'string')) throw new Error('任务经验文件损坏，原文件保留'); return items; }
  update(work) { const result = this.pending.catch(() => {}).then(async () => { const items = await work(await this.list()); await saveJson(this.file, items); return items; }); this.pending = result; return result; }
  async propose(record, children = []) {
    if (record.status !== 'completed' || !record.verification.at(-1)?.result.ok) return false;
    const sources = (record.workingMemory || []).flatMap((item) => item.sources);
    for (const task of [record, ...children]) for (const step of task.steps) if (step.result?.ok && step.result.data?.path && step.result.data?.hash) sources.push({ path: step.result.data.path, hash: step.result.data.hash });
    const unique = [...new Map(sources.map((item) => [item.path, item])).values()].slice(0, 100);
    if (!unique.length) return false;
    for (const source of unique) if ((await captureFile(record.workspace, source.path, { maxBytes: 100 * 1024 * 1024 })).hash !== source.hash) return false;
    const entry = { id: randomUUID(), taskId: record.id, sessionId: record.sessionId, workspace: record.workspace, summary: redact(record.summary).slice(0, 2000), tools: [...new Set([record, ...children].flatMap((task) => task.steps.filter((step) => step.result?.ok).map((step) => step.tool)))], sources: unique, status: 'candidate', createdAt: new Date().toISOString(), trusted: false };
    await this.update((items) => items.some((item) => item.taskId === record.id) ? items : [...items, entry].slice(-300)); return true;
  }
  async decide(id, status) { if (!['approved', 'rejected'].includes(status)) throw new Error('无效的经验选择'); return this.update((items) => { const item = items.find((entry) => entry.id === id); if (!item) throw new Error('任务经验不存在'); item.status = status; return items; }); }
  async retrieve(workspace, prompt) {
    const tokens = String(prompt).toLowerCase().match(/[a-z0-9_]+|[\u4e00-\u9fff]{2}/g) || [], results = [];
    for (const item of await this.list()) {
      if (item.workspace !== workspace || item.status !== 'approved' || !tokens.some((token) => item.summary.toLowerCase().includes(token))) continue;
      let valid = true; for (const source of item.sources) { try { if ((await captureFile(workspace, source.path, { maxBytes: 100 * 1024 * 1024 })).hash !== source.hash) valid = false; } catch { valid = false; } }
      if (valid) results.push({ summary: item.summary, taskId: item.taskId, sources: item.sources, tools: item.tools, trusted: false });
    }
    return results.slice(-3);
  }
}
