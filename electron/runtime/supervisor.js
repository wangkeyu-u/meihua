import { captureFile } from '../file-state.js';
import { readFile } from 'node:fs/promises';

export async function checkNode(workspace, node) {
  const checks = [];
  for (const check of node.checks) {
    try {
      const state = await captureFile(workspace, check.path), text = check.kind === 'exists' ? '' : await readFile(state.file, 'utf8');
      if (check.kind === 'contains' && !text.includes(check.text)) throw new Error('缺少声明的内容');
      if (check.kind === 'json') JSON.parse(text);
      checks.push({ ...check, ok: true, hash: state.hash });
    } catch (error) { checks.push({ ...check, ok: false, error: error.message }); }
  }
  return { ok: checks.every((check) => check.ok), checks };
}
export class Supervisor {
  constructor({ maxWorkers = 3, onUpdate = async () => {}, onProgress = async () => false }) { this.maxWorkers = maxWorkers; this.onUpdate = onUpdate; this.onProgress = onProgress; }
  async run(plan, execute, signal) {
    const running = new Map(), states = new Map(plan.nodes.map((node) => [node.id, node])); let peak = 0;
    // Recover an uncertain node by pausing it; never replay an interrupted side effect automatically.
    for (const node of plan.nodes) if (node.status === 'running') node.status = 'paused';
    try { while (true) {
      signal?.throwIfAborted();
      for (const node of plan.nodes) if (node.status === 'queued' && node.dependencies.some((id) => ['failed', 'blocked', 'paused'].includes(states.get(id).status))) { node.status = 'blocked'; node.summary = '前置节点未完成'; await this.onUpdate(plan); }
      const ready = plan.nodes.filter((node) => node.status === 'queued' && node.dependencies.every((id) => states.get(id).status === 'completed'));
      for (const node of ready.slice(0, Math.max(0, this.maxWorkers - running.size))) {
        node.status = 'running'; node.attempts++; node.startedAt = new Date().toISOString(); await this.onUpdate(plan);
        const work = (async () => {
          try { const result = await execute(node); Object.assign(node, { status: result.ok ? 'completed' : 'failed', summary: result.summary || '', result }); }
          catch (error) { Object.assign(node, { status: signal?.aborted ? 'paused' : 'failed', summary: error.message }); }
          finally { node.finishedAt = new Date().toISOString(); try { await this.onUpdate(plan); } finally { running.delete(node.id); } }
        })();
        running.set(node.id, work); peak = Math.max(peak, running.size);
      }
      if (!running.size) break;
      await Promise.race(running.values());
      if (await this.onProgress(plan)) break;
    } } finally { await Promise.allSettled([...running.values()]); }
    return { ok: plan.nodes.every((node) => node.status === 'completed'), peakWorkers: peak, completed: plan.nodes.filter((node) => node.status === 'completed').length, total: plan.nodes.length };
  }
}
