import { randomUUID } from 'node:crypto';

export const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);
export const taskStatuses = new Set(['queued', 'planning', 'running', 'waiting_approval', 'paused', 'verifying', ...terminalStatuses]);
export const eventTypes = new Set(['task_created', 'plan_created', 'model_message', 'tool_started', 'tool_completed', 'tool_failed', 'approval_requested', 'approval_accepted', 'approval_rejected', 'approval_cancelled', 'verification_started', 'verification_completed', 'task_paused', 'task_resumed', 'task_completed', 'task_failed', 'task_cancelled', 'checkpoint_created', 'checkpoint_restored', 'checkpoint_expired', 'context_compacted', 'context_compaction_failed', 'plan_revised', 'agent_message']);

export function redact(value) {
  if (typeof value === 'string') return value.replace(/(?:sk-|Bearer\s+)[a-z0-9._-]+/gi, '[REDACTED]').replace(/((?:api[_ -]?key|token|password|secret)\s*[=:]\s*)[^\s,;"}]+/gi, '$1[REDACTED]');
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /secret|password|authorization|api.?key|credential|cookie|^(?:token|access.?token|refresh.?token)$/i.test(key) ? '[REDACTED]' : redact(item)]));
  return value;
}
export function taskEvent(record, type, payload = {}) {
  if (!eventTypes.has(type)) throw new Error(`无效任务事件：${type}`);
  return { id: randomUUID(), sequence: record.events.length + 1, type, timestamp: new Date().toISOString(), payload: redact(payload) };
}
