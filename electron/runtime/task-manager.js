import { randomUUID } from 'node:crypto';
import { taskEvent, taskStatuses, terminalStatuses, redact } from './task-events.js';
import { taskSchemaVersion } from './task-schema.js';

const transitions = {
  queued: ['planning', 'running', 'paused', 'cancelled', 'failed'],
  planning: ['running', 'waiting_approval', 'paused', 'completed', 'failed', 'cancelled'],
  running: ['planning', 'waiting_approval', 'paused', 'verifying', 'completed', 'failed', 'cancelled'],
  waiting_approval: ['planning', 'running', 'verifying', 'paused', 'completed', 'failed', 'cancelled'],
  verifying: ['running', 'waiting_approval', 'paused', 'completed', 'failed', 'cancelled'],
  paused: ['planning', 'running', 'cancelled', 'failed'],
};
export class TaskManager {
  constructor(store, onChange = () => {}) { this.store = store; this.onChange = onChange; }
  async mutate(id, change) {
    const record = await this.store.mutate(id, (current) => {
      if (!current) throw new Error('任务不存在');
      change(current); current.updatedAt = new Date().toISOString(); return current;
    });
    this.onChange(record); return record;
  }
  async create({ sessionId, workspace, originalPrompt, mode, model, provider, agentId = null, contextFiles = [], parentId = null, nodeId = null }) {
    const now = new Date().toISOString(), id = randomUUID();
    const record = { schemaVersion: taskSchemaVersion, id, sessionId, workspace, originalPrompt, mode, model, provider, agentId, contextFiles, ...(parentId ? { parentId, nodeId } : {}), userUpdates: [], checkpointsExpiredAt: null,
      status: 'queued', createdAt: now, updatedAt: now, startedAt: null, completedAt: null, currentStep: null, error: null, summary: '', interrupted: false,
      steps: [], events: [], verification: [], diagnostics: { modelCalls: 0, toolCalls: 0, retries: 0, verificationAttempts: 0, failures: 0, cancelledReason: null } };
    record.events.push(taskEvent(record, 'task_created', { mode, model, provider }));
    await this.store.mutate(id, () => record); this.onChange(record); return record;
  }
  async transition(id, status, patch = {}) {
    return this.mutate(id, (record) => {
      if (!taskStatuses.has(status) || record.status !== status && !transitions[record.status]?.includes(status)) throw new Error(`任务不能从 ${record.status} 转为 ${status}`);
      if (terminalStatuses.has(record.status)) throw new Error('任务已经结束');
      Object.assign(record, patch, { status });
      if (!record.startedAt && ['planning', 'running'].includes(status)) record.startedAt = new Date().toISOString();
      if (terminalStatuses.has(status)) {
        record.completedAt = new Date().toISOString(); record.currentStep = null;
        record.events.push(taskEvent(record, `task_${status}`, { summary: record.summary, error: record.error }));
        if (status === 'failed') record.diagnostics.failures++;
      }
    });
  }
  event(id, type, payload = {}) { return this.mutate(id, (record) => record.events.push(taskEvent(record, type, payload))); }
  diagnostics(id, patch) { return this.mutate(id, (record) => { for (const [key, value] of Object.entries(patch)) record.diagnostics[key] = typeof value === 'number' ? (record.diagnostics[key] || 0) + value : value; }); }
  async startStep(id, { tool, inputSummary, metadata }) {
    const stepId = randomUUID();
    await this.mutate(id, (record) => {
      if (!['running', 'verifying'].includes(record.status)) throw new Error('任务当前不能执行工具');
      record.currentStep = stepId; record.diagnostics.toolCalls++;
      record.steps.push({ id: stepId, tool, inputSummary: redact(inputSummary), metadata, status: 'running', startedAt: new Date().toISOString(), completedAt: null, durationMs: null, result: null });
      record.events.push(taskEvent(record, 'tool_started', { stepId, tool, inputSummary }));
    });
    return stepId;
  }
  completeStep(id, stepId, result) {
    return this.mutate(id, (record) => {
      const step = record.steps.find((item) => item.id === stepId); if (!step) throw new Error('任务步骤不存在');
      step.status = step.process?.status === 'aborted' ? 'interrupted' : result.ok ? 'completed' : result.error?.code === 'TASK_INTERRUPTED' ? 'interrupted' : 'failed'; step.completedAt = new Date().toISOString(); step.durationMs = Date.parse(step.completedAt) - Date.parse(step.startedAt); step.result = redact(result);
      record.currentStep = null;
      record.events.push(taskEvent(record, result.ok ? 'tool_completed' : 'tool_failed', { stepId, tool: step.tool, summary: result.summary, changedFiles: result.changedFiles, error: result.error }));
    });
  }
  async pause(id, reason = '用户暂停') {
    await this.markInterruptedSteps(id);
    await this.event(id, 'task_paused', { reason }); return this.transition(id, 'paused', { summary: reason });
  }
  markInterruptedSteps(id) { return this.mutate(id, (record) => { record.currentStep = null; for (const step of record.steps) if (step.status === 'running' || step.process?.status === 'running') { step.status = 'interrupted'; step.completedAt = new Date().toISOString(); step.durationMs = Date.parse(step.completedAt) - Date.parse(step.startedAt); } }); }
  async resume(id) {
    const record = await this.store.get(id); if (record?.status !== 'paused') throw new Error('只有暂停或中断的任务可以恢复');
    await this.event(id, 'task_resumed', { interrupted: record.interrupted }); return this.transition(id, 'running', { interrupted: false, error: null });
  }
  async cancel(id, reason = '用户取消') {
    await this.diagnostics(id, { cancelledReason: reason }); return this.transition(id, 'cancelled', { summary: reason });
  }
  async recoverInterrupted() {
    const recovered = [];
    for (const record of await this.store.list()) {
      if (terminalStatuses.has(record.status) || record.status === 'paused') continue;
      await this.markInterruptedSteps(record.id);
      await this.event(record.id, 'task_paused', { reason: '应用上次运行时被中断', previousStatus: record.status });
      recovered.push(await this.transition(record.id, 'paused', { interrupted: true, summary: '这个任务上次运行时被中断；恢复后先检查已有结果，所有操作仍需确认。' }));
    }
    return recovered;
  }
}
