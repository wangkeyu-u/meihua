import path from 'node:path';
import { taskStatuses, eventTypes } from './task-events.js';
import { normalizeAgentConfig } from './agent-config.js';
import { validatePlan } from './task-planner.js';
import { roleTools } from './tool-registry.js';

export const taskSchemaVersion = 2;
const fail = () => { const error = new Error('任务文件格式不完整，原始文件已保留'); error.code = 'TASK_FORMAT_INVALID'; throw error; };
export function validateTask(record, id) {
  if (!record || typeof record !== 'object' || record.id !== id || ![1, taskSchemaVersion].includes(record.schemaVersion)) fail();
  if (!taskStatuses.has(record.status) || typeof record.sessionId !== 'string' || !record.sessionId || typeof record.workspace !== 'string' || !path.isAbsolute(record.workspace)) fail();
  for (const key of ['originalPrompt', 'mode', 'model', 'provider', 'summary']) if (typeof record[key] !== 'string') fail();
  for (const key of ['createdAt', 'updatedAt']) if (typeof record[key] !== 'string' || !Number.isFinite(Date.parse(record[key]))) fail();
  if (!Array.isArray(record.steps) || !Array.isArray(record.events) || !Array.isArray(record.verification) || !record.diagnostics || typeof record.diagnostics !== 'object') fail();
  for (const step of record.steps) if (!step || typeof step.id !== 'string' || typeof step.tool !== 'string' || typeof step.inputSummary !== 'string' || !step.metadata || typeof step.metadata.sideEffect !== 'boolean' || !['running', 'completed', 'failed', 'interrupted'].includes(step.status)) fail();
  for (let index = 0; index < record.events.length; index++) {
    const event = record.events[index];
    if (!event || event.sequence !== index + 1 || !eventTypes.has(event.type) || !Number.isFinite(Date.parse(event.timestamp))) fail();
  }
  for (const entry of record.verification) if (!entry?.result || typeof entry.result.ok !== 'boolean' || !Array.isArray(entry.result.checks)) fail();
  for (const key of ['modelCalls', 'toolCalls', 'retries', 'verificationAttempts', 'failures']) if (!Number.isFinite(record.diagnostics[key]) || record.diagnostics[key] < 0) fail();
  try {
    if (record.agentPolicy) normalizeAgentConfig(record.agentPolicy);
    if (record.parentId && !/^[a-f0-9-]{36}$/.test(record.parentId)) fail();
    if (record.planRevisions && (!Array.isArray(record.planRevisions) || record.planRevisions.length > 5 || record.planRevisions.some((item) => !Number.isSafeInteger(item.round) || !item.previous?.nodes || !Array.isArray(item.issues)))) fail();
    if (record.agentMessages && (!Array.isArray(record.agentMessages) || record.agentMessages.length > 100 || record.agentMessages.some((item) => typeof item.id !== 'string' || typeof item.nodeId !== 'string' || typeof item.text !== 'string' || item.text.length > 8000 || !['user', 'supervisor'].includes(item.source) || !['queued', 'delivered', 'requires-followup'].includes(item.status)))) fail();
    if (record.modelLedger) {
      if (!Array.isArray(record.modelLedger) || record.modelLedger.length > 500) fail();
      for (const call of record.modelLedger) {
        if (!call || typeof call.id !== 'string' || typeof call.model !== 'string' || typeof call.provider !== 'string' || !['running', 'interrupted', 'completed', 'aborted', 'error'].includes(call.status)) fail();
        for (const key of ['totalTokens', 'reservedTokens', 'costUsd', 'estimatedCostUsd', 'reservedCost']) if (call[key] != null && (!Number.isFinite(call[key]) || call[key] < 0)) fail();
      }
    }
    if (record.workflow) {
      validatePlan(record.workflow, [...new Set(Object.values(roleTools).flatMap((tools) => [...tools]))].map((name) => ({ name })));
      for (const node of record.workflow.nodes) if (node.taskId && !/^[a-f0-9-]{36}$/.test(node.taskId) || node.previousTaskId && !/^[a-f0-9-]{36}$/.test(node.previousTaskId) || !['queued', 'running', 'paused', 'blocked', 'completed', 'failed'].includes(node.status) || !Number.isSafeInteger(node.attempts) || node.attempts < 0) fail();
    }
  } catch { fail(); }
  return record;
}
export function upgradeTask(record) {
  if (record.schemaVersion === taskSchemaVersion) return record;
  return { ...record, schemaVersion: taskSchemaVersion, userUpdates: record.userUpdates || [], contextFiles: record.contextFiles || [], checkpointsExpiredAt: record.checkpointsExpiredAt || null };
}
