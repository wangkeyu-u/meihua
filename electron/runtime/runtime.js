import { TaskStore } from './task-store.js';
import { TaskManager } from './task-manager.js';
import { CheckpointManager } from './checkpoint-manager.js';
import { ContextManager, sourceContext } from './context-manager.js';
import { toolMetadata, approvalMetadata } from './tool-executor.js';
import { VerificationEngine, verificationLoop } from './verification-engine.js';
import { terminalStatuses } from './task-events.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { VerificationConfigStore, normalizeVerificationConfig } from './verification-config.js';
import { BackupRetention } from './backup-retention.js';
import { AgentConfigStore } from './agent-config.js';
import { UsageLedger } from './usage-ledger.js';
import { WorkingMemory } from './working-memory.js';
import { Conversation } from './conversation.js';
import { runSandboxed } from './sandbox.js';

// One execution owner, backed by disk. TaskGate remains the synchronous IPC mutex.
export class DurableRuntime {
  constructor(root, onChange, shared = {}) {
    this.root = root;
    this.store = shared.store || new TaskStore(root);
    this.manager = shared.manager || new TaskManager(this.store, onChange);
    this.checkpoints = new CheckpointManager(root);
    this.context = new ContextManager();
    this.verificationConfig = new VerificationConfigStore(root);
    this.agentConfig = new AgentConfigStore(root);
    this.workingMemory = new WorkingMemory(this.manager);
    this.ledger = shared.ledger || null;
    this.sharedLedger = Boolean(shared.ledger);
    this.backups = new BackupRetention(root, this.store, this.manager);
    this.invocations = new AsyncLocalStorage(); this.activeId = null; this.stepId = null; this.stopReason = null;
  }
  get stepId() { return this.invocations?.getStore()?.stepId ?? this.fallbackStepId ?? null; }
  set stepId(value) { this.fallbackStepId = value; }
  withInvocation(invocation, run) { return this.invocations.run(invocation, run); }
  async begin(input, existingId = null, resume = false) {
    const record = existingId ? await this.store.get(existingId) : await this.manager.create(input);
    if (!record || terminalStatuses.has(record.status)) throw new Error('这个任务已经结束，请发送新任务');
    if (record.sessionId !== input.sessionId || record.workspace !== input.workspace) throw new Error('任务的会话或工作目录不一致');
    this.activeId = record.id; this.stopReason = null;
    const policy = { ...(record.agentPolicy || await this.agentConfig.get()) };
    if (input.networkAllowed === false) policy.network = false;
    this.context.configure(policy.contextWindow, policy.maxOutputTokens);
    if (!record.agentPolicy || record.agentPolicy.network !== policy.network) await this.manager.mutate(record.id, (task) => { task.agentPolicy = policy; });
    if (!this.sharedLedger) this.ledger = new UsageLedger({ config: policy, manager: this.manager, taskId: record.id, calls: record.modelLedger || [] });
    if (!record.verificationPolicy) {
      const policy = await this.verificationConfig.get(record.workspace);
      await this.manager.mutate(record.id, (task) => { task.verificationPolicy = policy; });
    }
    if (resume) {
      for (const checkpoint of await this.checkpoints.list(record.id)) await this.checkpoints.cancelUnchanged(checkpoint);
      await this.manager.resume(record.id);
    }
    else if (!input.deferPlanning) await this.manager.transition(record.id, 'planning');
    return record;
  }
  async conversation(stage, configured, seed = []) {
    const conversation = new Conversation(this, stage, configured);
    await conversation.load(seed); return conversation;
  }
  configureModel(configured) {
    const model = this.trackedModel(configured).model;
    this.context.configure(model.contextWindow, model.maxTokens); return model;
  }
  trackedModel(configured, options) {
    return this.ledger ? this.ledger.track(configured, options) : configured;
  }
  async modelMessage(message) {
    if (!this.activeId) return;
    const text = message.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
    await this.manager.event(this.activeId, 'model_message', { summary: text.slice(0, 2000), stopReason: message.stopReason });
  }
  async approve(kind, detail, queue, signal) {
    const name = approvalMetadata[kind];
    if (!name) throw new Error('未知确认类型');
    const metadata = toolMetadata(name);
    if (!metadata.requiresApproval) throw new Error('工具确认策略不一致');
    const taskId = this.activeId, record = taskId ? await this.store.get(taskId) : null;
    if (signal?.aborted || record && !['running', 'verifying'].includes(record.status)) return false;
    const id = randomUUID();
    if (record) {
      await this.manager.transition(taskId, 'waiting_approval');
      await this.manager.event(taskId, 'approval_requested', { id, kind, stepId: this.stepId, metadata });
    }
    const approved = await queue.request(id, kind, { ...detail, riskLevel: metadata.riskLevel, capabilities: metadata.capabilities }, signal);
    if (record) {
      await this.manager.event(taskId, signal?.aborted ? 'approval_cancelled' : approved ? 'approval_accepted' : 'approval_rejected', { id, kind });
      const latest = await this.store.get(taskId);
      if (latest.status === 'waiting_approval') await this.manager.transition(taskId, record.status);
    }
    return approved === true && !signal?.aborted;
  }
  async beforeFile(workspace, requested) {
    if (!this.activeId || !this.stepId) throw new Error('文件修改必须属于持久任务步骤');
    const checkpoint = await this.checkpoints.begin(this.activeId, this.stepId, workspace, requested);
    await this.manager.event(this.activeId, 'checkpoint_created', { checkpointId: checkpoint.id, stepId: this.stepId, path: checkpoint.path });
    return checkpoint;
  }
  async verify({ agent, signal, approve, parseDocument, allowCommands }) {
    const id = this.activeId;
    const record = await this.store.get(id), config = normalizeVerificationConfig(record.verificationPolicy || await this.verificationConfig.get(record.workspace));
    await this.manager.mutate(id, (record) => { record.allowCommands = allowCommands; record.verificationPolicy = config; });
    const engine = new VerificationEngine({ checkpoints: this.checkpoints, approve, parseDocument, config,
      runner: this.commandRunner || (record.agentPolicy?.sandbox ? (command, args, options) => runSandboxed(command, args, { ...options, workspace: record.workspace, network: record.agentPolicy.network }) : undefined) });
    return verificationLoop({ signal, maxAttempts: 3,
      verify: () => this.store.get(id).then((record) => engine.verify(record, signal)),
      onAttempt: async (attempt, phase, result) => {
        if (phase === 'started') {
          await this.manager.transition(id, 'verifying');
          await this.manager.diagnostics(id, { verificationAttempts: 1 });
          await this.manager.event(id, 'verification_started', { attempt });
        } else {
          await this.manager.mutate(id, (record) => record.verification.push({ attempt, result }));
          await this.manager.event(id, 'verification_completed', { attempt, ...result });
        }
      },
      repair: async (result, attempt) => {
        await this.manager.transition(id, 'running');
        await this.manager.diagnostics(id, { retries: 1 });
        await agent.prompt('验证失败，请检查具体错误并修复，保留用户目标和约束。所有副作用仍需用户确认；不得重复发送邮件等已执行的外部操作。\n' + sourceContext('tool', { category: 'verification', attempt, ...result }));
        if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
      },
    });
  }
  async settle(error, aborted) {
    const id = this.activeId;
    if (!id) return;
    try {
      const record = await this.store.get(id);
      if (!terminalStatuses.has(record.status)) {
        if (aborted && this.stopReason === 'paused') await this.manager.pause(id);
        else if (aborted && this.stopReason === 'interrupted') await this.manager.pause(id, '应用窗口被关闭，任务已中断');
        else if (aborted) await this.manager.cancel(id);
        else if (error) await this.manager.transition(id, 'failed', { error: { code: 'TASK_FAILED', message: error.message }, summary: error.message });
      }
    } finally { await this.store.flush(); this.activeId = null; this.stepId = null; this.stopReason = null; }
  }
}
