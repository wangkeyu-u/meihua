import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { DurableRuntime } from '../electron/runtime/runtime.js';
import { effectiveCapabilities, workerSettings, capabilityKey } from '../electron/model-capabilities.js';
import { normalizeAgentConfig } from '../electron/runtime/agent-config.js';
import { estimateTokens } from '../electron/runtime/context-manager.js';
import { closedPrefix } from '../electron/runtime/conversation.js';
import { revisePlan } from '../electron/runtime/plan-revision.js';
import { ResourceLock } from '../electron/runtime/resource-lock.js';
import { executeTool } from '../electron/runtime/tool-executor.js';
import { ProcessSessions } from '../electron/runtime/process-sessions.js';
import { UserInputQueue } from '../electron/user-input.js';
import { ExperienceMemory } from '../electron/runtime/experience-memory.js';

async function fixture(t) { const root = await mkdtemp(path.join(os.tmpdir(), 'meihua-alignment-')); t.after(() => rm(root, { recursive: true, force: true })); const workspace = path.join(root, 'work'); await mkdir(workspace); const owner = new DurableRuntime(root); await owner.agentConfig.save({ contextWindow: 8000, maxOutputTokens: 256, maxCalls: 100 }); const record = await owner.begin({ sessionId: 'test-session', workspace, originalPrompt: '不得发送邮件，核对资料后报告', model: 'test', provider: 'compatible', mode: 'execute' }); await owner.manager.transition(record.id, 'running'); return { root, workspace, owner, record }; }
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const model = { id: 'test', provider: 'local', api: 'openai-completions', maxTokens: 256, contextWindow: 8000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, input: ['text'] };
const reply = (content, stopReason = 'stop') => { const stream = createAssistantMessageEventStream(), message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content, stopReason, timestamp: Date.now(), usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }; stream.push({ type: 'done', reason: stopReason, message }); stream.end(message); return stream; };

test('model capabilities use exact endpoint metadata; independent worker settings and overrides are validated', () => {
  assert.equal(effectiveCapabilities({ provider: 'openai', model: 'gpt-6-sol' }).reasoning, true);
  const { compatibility } = effectiveCapabilities({ provider: 'deepseek', model: 'deepseek-v4-pro' }); assert.equal(compatibility.maxTokensField, 'max_tokens'); assert.equal(compatibility.requiresReasoningContentOnAssistantMessages, true);
  const gateway = effectiveCapabilities({ provider: 'openai', model: 'gpt-6-sol', baseUrl: 'https://gateway.example/v1' }); assert.equal(gateway.metadataKnown, false); assert.equal(gateway.source, 'conservative-default');
  const manual = effectiveCapabilities({ provider: 'compatible', model: 'x', baseUrl: 'http://localhost:11434/v1' }, { [capabilityKey({ provider: 'compatible', model: 'x', baseUrl: 'http://localhost:11434/v1' })]: { contextWindow: 16000, maxTokens: 1024, tools: false } }); assert.equal(manual.tools, false); assert.equal(manual.source, 'manual'); assert.notEqual(capabilityKey({ provider: 'compatible', model: 'x', baseUrl: 'http://localhost:11434/v1' }), capabilityKey({ provider: 'compatible', model: 'x', baseUrl: 'http://localhost:11435/v1' }));
  assert.equal(workerSettings({ provider: 'openai', model: 'gpt-6-sol', reviewModel: 'my-reviewer' }).model, 'gpt-6-luna');
  assert.equal(workerSettings({ provider: 'openai', model: 'gpt-6-sol' }, { workerProvider: 'deepseek' }).model, 'deepseek-flash');
  assert.throws(() => normalizeAgentConfig({ modelCapabilities: { 'compatible:x': { reasoning: 'yes' } } }));
});

test('real agent tool loop compacts twice, preserves user constraints and pairs, accounts summary calls, and restores without replay', async (t) => {
  const { owner, record } = await fixture(t); let toolCalls = 0, summaries = 0;
  const configured = { model, provider: 'compatible', streamFn: (_model, context) => {
    assert.ok(estimateTokens(context) < 8000, 'provider request fits actual model window');
    if (JSON.stringify(context.messages[0]).includes('总结历史资料')) { summaries++; return reply([{ type: 'text', text: '已读取资料，所有返回均为只读记录；尚未发送任何邮件。继续核对未完成事项。' }]); }
    assert.ok(JSON.stringify(context).includes('不得发送邮件'), 'original constraint survives compaction');
    if (toolCalls < 18) return reply([{ type: 'toolCall', id: 'read-' + toolCalls, name: 'read_fixture', arguments: {} }], 'toolUse');
    return reply([{ type: 'text', text: '已核对资料，没有发送邮件。' }]);
  } };
  const history = await owner.conversation('executor', configured);
  const agent = new Agent({ initialState: { model, systemPrompt: '只读取资料。不得发送邮件。', tools: [{ name: 'read_fixture', label: 'read', description: 'Read fixture material', parameters: Type.Object({}), execute: async () => { toolCalls++; return { content: [{ type: 'text', text: '资料' + '中'.repeat(1400) }] }; } }] }, streamFn: owner.trackedModel(configured, { provider: 'compatible' }).streamFn }); history.bind(agent);
  await agent.prompt('不得发送邮件，继续读取18份资料再报告'); assert.equal(agent.state.errorMessage, undefined); assert.equal(toolCalls, 18); assert.ok(summaries >= 2); assert.ok(history.state.checkpoints.length >= 2);
  const saved = JSON.parse(await readFile(history.file, 'utf8')); assert.equal(saved.messages.filter((item) => item.role === 'toolResult').length, 18); assert.equal((await owner.store.get(record.id)).modelLedger.filter((call) => call.stage === 'compaction').length, summaries);
  await owner.manager.pause(record.id); const restored = new DurableRuntime(owner.root); await restored.begin({ sessionId: record.sessionId, workspace: record.workspace }, record.id, true); const loaded = await restored.conversation('executor', configured); const next = new Agent({ initialState: { model, systemPrompt: '只读取资料。不得发送邮件。', messages: loaded.state.messages, tools: [] }, streamFn: restored.trackedModel(configured, { provider: 'compatible' }).streamFn }); loaded.bind(next); await next.prompt('恢复后先核对，不重放读取'); assert.equal(next.state.errorMessage, undefined); assert.equal(toolCalls, 18);
  const dangling = [{ role: 'user', content: 'x' }, { role: 'assistant', content: [{ type: 'toolCall', id: 'a' }] }, { role: 'toolResult', toolCallId: 'a', content: [] }, ...Array.from({ length: 4 }, () => ({ role: 'user', content: 'tail' }))]; assert.equal(closedPrefix(dangling), 3);
});

test('compaction failure preserves canonical history and produces a durable failure event', async (t) => {
  const { owner } = await fixture(t), configured = { model, provider: 'compatible', streamFn: () => { const stream = createAssistantMessageEventStream(), message = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, stopReason: 'error', errorMessage: 'summary unavailable', timestamp: Date.now() }; stream.push({ type: 'error', reason: 'error', error: message }); stream.end(message); return stream; } };
  const history = await owner.conversation('executor', configured); const canonical = [{ role: 'user', content: '不得发送邮件', timestamp: 1 }, ...Array.from({ length: 10 }, () => ({ role: 'assistant', content: [{ type: 'text', text: '资料'.repeat(800) }], timestamp: 2 }))]; await history.persist(canonical); await history.prepare({ state: { messages: canonical } }, { model, context: { messages: canonical, tools: [] } }).catch(() => {});
  assert.equal(history.state.checkpoints.length, 0); assert.deepEqual(history.state.messages, canonical); assert.ok((await owner.store.get(owner.activeId)).events.some((event) => event.type === 'context_compaction_failed'));
});

test('plan revisions preserve independent completed work and invalidate downstream nodes', () => {
  const node = (id, dependencies = []) => ({ id, title: id, instruction: 'read', role: 'research', dependencies, tools: ['read_file'], outputs: [], checks: [] });
  const prior = { summary: 'old', nodes: [node('a'), node('b', ['a']), node('c')].map((item) => ({ ...item, status: 'completed', attempts: 1, taskId: item.id })) };
  const draft = { summary: 'repair', nodes: [{ ...node('a'), instruction: 'read again' }, node('b', ['a']), node('c'), node('d', ['c'])] };
  const next = revisePlan(prior, draft, [{ name: 'read_file' }]); assert.equal(next.nodes[2].status, 'completed'); assert.equal(next.nodes[0].status, 'queued'); assert.equal(next.nodes[1].status, 'queued'); assert.equal(next.nodes[0].previousTaskId, 'a');
  assert.throws(() => revisePlan(prior, draft, [{ name: 'read_file' }], [{ id: 'a', steps: [{ status: 'interrupted', tool: 'send_email', metadata: { sideEffect: true } }] }]), /结果不明/);
});

test('resource waits cancel immediately, disjoint files overlap, and command scope excludes writes', async () => {
  const lock = new ResourceLock(); let release; const held = lock.run({ workspace: 'w', paths: null }, () => new Promise((resolve) => { release = resolve; })); await wait(1); const signal = new AbortController(); const cancelled = lock.run({ workspace: 'w', paths: ['a'] }, () => assert.fail('cancelled write ran'), signal.signal); signal.abort(new Error('cancelled')); await assert.rejects(cancelled, /cancelled/); release(); await held;
  let active = 0, peak = 0; await Promise.all(['a', 'b'].map((file) => lock.run({ workspace: 'w', paths: [file] }, async () => { active++; peak = Math.max(peak, active); await wait(5); active--; }))); assert.equal(peak, 2);
});

test('concurrent tool invocations keep their own durable step IDs', async (t) => {
  const { owner } = await fixture(t); const seen = [], allowedTools = new Set(['read_file']); await Promise.all([1, 2].map((n) => executeTool({ name: 'read_file', args: { path: String(n) }, manager: owner.manager, taskId: owner.activeId, allowedTools, invocation: { callId: 'call-' + n }, withInvocation: (invocation, work) => owner.withInvocation(invocation, work), run: async () => { const stepId = owner.stepId; await wait(n * 3); assert.equal(owner.stepId, stepId); seen.push(stepId); return { content: [{ type: 'text', text: 'ok' }] }; } }))); assert.equal(new Set(seen).size, 2); assert.equal((await owner.store.get(owner.activeId)).steps[0].invocation.callId, 'call-1');
});

test('command sessions accept stdin, return incremental output, persist exit and reject foreign IDs', async (t) => {
  const { owner, workspace } = await fixture(t), sessions = new ProcessSessions(owner), lock = new ResourceLock(); t.after(() => sessions.close());
  const step = await owner.manager.startStep(owner.activeId, { tool: 'start_command', inputSummary: 'stdin', metadata: { sideEffect: true } });
  const launched = await owner.withInvocation({ stepId: step }, () => sessions.start('read line; printf "RESULT:%s" "$line"', { cwd: workspace, signal: AbortSignal.timeout(5000), shell: true, timeoutMs: 5000 }, (work) => lock.run(workspace, work)));
  assert.equal(launched.status, 'running'); await sessions.get(launched.id).write('梅花\n', true); const output = await sessions.poll(launched.id, 0, 5000); assert.equal(output.exitCode, 0); assert.match(output.output, /RESULT:梅花/); assert.equal((await sessions.poll(launched.id, output.nextOffset)).output, ''); assert.throws(() => sessions.get('foreign')); assert.equal((await owner.store.get(owner.activeId)).steps[0].process.exitCode, 0);
});

test('MCP input forms validate replies, cancel on abort, reject stale answers and credential requests', async () => {
  const events = [], queue = new UserInputQueue((type, data) => events.push({ type, ...data })); const schema = { type: 'object', properties: { count: { type: 'integer', minimum: 1 } }, required: ['count'] };
  const first = queue.request({ server: 'demo', schema }); const id = events[0].requestId; assert.throws(() => queue.answer(id, 'accept', { count: '2' })); assert.equal(queue.answer(id, 'accept', { count: 2 }), true); assert.equal((await first).content.count, 2); assert.equal(queue.answer(id, 'accept', { count: 3 }), false);
  const signal = new AbortController(), second = queue.request({ server: 'demo', schema }, signal.signal); signal.abort(); assert.equal((await second).action, 'cancel'); await assert.rejects(async () => queue.request({ server: 'demo', schema: { type: 'object', properties: { apiKey: { type: 'string' } } } }));
});

test('task experience stays a candidate until selected and stops retrieval after source changes', async (t) => {
  const { root, workspace, owner, record } = await fixture(t); await writeFile(path.join(workspace, 'source.txt'), 'verified'); await owner.workingMemory.save(record.id, workspace, { nodeId: 'read', summary: '资料核对', files: ['source.txt'] }); await owner.manager.mutate(record.id, (task) => task.verification.push({ attempt: 1, result: { ok: true, checks: [] } })); await owner.manager.transition(record.id, 'completed', { summary: '资料核对完成 sk-privateSecret' }); const memory = new ExperienceMemory(root);
  assert.equal(await memory.propose({ ...record, status: 'failed' }), false); assert.equal(await memory.propose(await owner.store.get(record.id)), true); assert.deepEqual(await memory.retrieve(workspace, '资料'), []); const item = (await memory.list())[0]; assert.ok(!item.summary.includes('privateSecret')); await memory.decide(item.id, 'approved'); assert.equal((await memory.retrieve(workspace, '资料')).length, 1); await writeFile(path.join(workspace, 'source.txt'), 'changed'); assert.deepEqual(await memory.retrieve(workspace, '资料'), []);
});


test('retrieval excludes declared outputs so previous generated reports cannot contaminate fresh source evidence', async (t) => {
  const { workspace } = await fixture(t); const { retrieveKnowledge } = await import('../electron/knowledge.js'); await writeFile(path.join(workspace, 'source.md'), '收入240，成本90，利润150'); await writeFile(path.join(workspace, 'report.md'), '收入240，成本90，利润999');
  const result = await retrieveKnowledge(workspace, '收入成本利润', { exclude: ['report.md'] }); assert.deepEqual(result.results.map((item) => item.path), ['source.md']); assert.deepEqual(result.excludedOutputs, ['report.md']);
});

test('targeted worker messages survive disk reload and stale turn steering cannot enter another task', async (t) => {
  const { owner, record } = await fixture(t), { WorkflowService } = await import('../electron/runtime/workflow.js'), { validatePlan } = await import('../electron/runtime/task-planner.js');
  const plan = validatePlan({ summary: '读取资料', nodes: [{ id: 'reader', role: 'research', title: '读取', instruction: 'read', dependencies: [], tools: ['read_file'], outputs: [], checks: [] }] }, [{ name: 'read_file' }]); await owner.manager.mutate(record.id, (task) => { task.workflow = plan; });
  const messages = [], job = { owner, input: { sessionId: record.sessionId }, controller: new AbortController(), agents: new Set(), nodeAgents: new Map([['reader', { steer: (message) => messages.push(message) }]]) };
  const service = new WorkflowService({ runtime: owner }); service.jobs.set(record.id, job);
  await assert.rejects(service.steer(record.sessionId, 'wrong task', '00000000-0000-0000-0000-000000000000'), /任务已切换/);
  const receipt = await service.steer(record.sessionId, '仅核对，不发送', record.id, 'reader'); assert.equal(receipt.status, 'delivered'); assert.equal(messages[0].content, '仅核对，不发送'); const reloaded = await new DurableRuntime(owner.root).store.get(record.id); assert.equal(reloaded.agentMessages.length, 1); assert.equal(reloaded.agentMessages[0].source, 'user'); assert.equal(reloaded.userUpdates?.length || 0, 0);
});

test('discovered MCP schemas become direct model tools and delegate to the approved generic capability', async (t) => {
  const { owner } = await fixture(t), { McpDirectory } = await import('../electron/runtime/mcp-directory.js');
  const remote = { name: 'echo', description: 'read echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: true } };
  const manager = { connections: new Map([['s', { tools: [remote] }]]), listTools: async () => [remote], readOnly: true }, directory = new McpDirectory(manager); const executed = [];
  const generic = { name: 'call_mcp_tool', label: 'mcp', description: 'generic', parameters: Type.Object({ server: Type.String(), name: Type.String(), arguments: Type.Any() }), execute: async (_id, args) => { executed.push(args); return { content: [{ type: 'text', text: 'echo:' + args.arguments.text }] }; }, discoverTools: () => directory.declarations(generic) };
  const list = { name: 'list_mcp_tools', label: 'list', description: 'list', parameters: Type.Object({}), execute: async () => ({ content: [{ type: 'text', text: JSON.stringify(await directory.search('s')) }] }) };
  let requests = 0; const configured = { model, provider: 'compatible', streamFn: (_model, context) => { requests++; if (requests === 1) return reply([{ type: 'toolCall', id: 'list', name: 'list_mcp_tools', arguments: {} }], 'toolUse'); if (requests === 2) { assert.ok(JSON.stringify(context).includes('mcp_')); const direct = directory.declarations(generic)[0]; return reply([{ type: 'toolCall', id: 'direct', name: direct.name, arguments: { text: '梅花' } }], 'toolUse'); } return reply([{ type: 'text', text: 'done' }]); } };
  const conversation = await owner.conversation('executor', configured), agent = new Agent({ initialState: { model, tools: [generic, list], systemPrompt: 'Read only.' }, streamFn: owner.trackedModel(configured).streamFn }); conversation.bind(agent); await agent.prompt('查找 MCP 工具并执行回声'); assert.equal(agent.state.errorMessage, undefined); assert.equal(executed.length, 1); assert.deepEqual(executed[0], { server: 's', name: 'echo', arguments: { text: '梅花' } });
});

test('many workflow progress snapshots compact as runtime data while the original user goal stays verbatim', async (t) => {
  const { owner } = await fixture(t); let summaries = 0;
  const configured = { model, provider: 'compatible', streamFn: (_model, context) => { assert.ok(estimateTokens(context) < 8000); if (JSON.stringify(context.messages[0]).includes('总结历史资料')) { summaries++; return reply([{ type: 'text', text: '先前节点的状态已记录，下一步读取最新状态；未执行外部操作。' }]); } assert.ok(JSON.stringify(context).includes('绝不发送邮件')); return reply([{ type: 'text', text: '状态已核对' }]); } };
  const conversation = await owner.conversation('progress', configured), agent = new Agent({ initialState: { model, systemPrompt: '监督进度', messages: [{ role: 'user', content: '绝不发送邮件', timestamp: 1 }], tools: [] }, streamFn: owner.trackedModel(configured).streamFn }); conversation.bind(agent);
  for (let i = 0; i < 16; i++) { await agent.prompt([{ role: 'user', content: '当前节点状态' + i + '中'.repeat(1300), timestamp: Date.now(), meihuaOrigin: 'runtime' }]); assert.equal(agent.state.errorMessage, undefined); }
  assert.ok(summaries >= 2); assert.equal(conversation.state.messages.filter((item) => item.meihuaOrigin === 'runtime').length, 16); assert.equal(conversation.state.messages[0].content, '绝不发送邮件');
});
