import { redact } from './task-events.js';

export function taskDiagnostics(record) {
  // Explicit allowlist: no prompts, message content, tool inputs, credentials or raw stdout.
  return redact({ schemaVersion: 1, taskSchemaVersion: record.schemaVersion, checkpointsExpiredAt: record.checkpointsExpiredAt || null, taskId: record.id, status: record.status, mode: record.mode, model: record.model, provider: record.provider,
    createdAt: record.createdAt, updatedAt: record.updatedAt, durationMs: record.startedAt ? Date.parse(record.completedAt || record.updatedAt) - Date.parse(record.startedAt) : 0,
    workflow: record.workflow ? { nodes: record.workflow.nodes.map(({ id, role, status, attempts }) => ({ id, role, status, attempts })), outcome: record.workflowOutcome } : undefined,
    modelLedger: record.modelLedger?.map(({ id, model, provider, stage, status, totalTokens, reservedTokens, usageSource, budgetSource, usage, costUsd, estimatedCostUsd, durationMs }) => ({ id, model, provider, stage, status, totalTokens, reservedTokens, usageSource, budgetSource, usage, costUsd, estimatedCostUsd, durationMs })),
    ...record.diagnostics, error: record.error ? { code: record.error.code || 'TASK_FAILED' } : null,
    steps: record.steps.map((step) => ({ id: step.id, tool: step.tool, status: step.status, durationMs: step.durationMs, exitCode: step.result?.exitCode, errorCode: step.result?.error?.code, changedFiles: step.result?.changedFiles })),
    verification: record.verification.map((item) => ({ attempt: item.attempt, ok: item.result.ok, checks: item.result.checks.map((check) => ({ name: check.name.startsWith('file:') ? 'file-check' : check.name, ok: check.ok, exitCode: check.exitCode })) })) });
}
