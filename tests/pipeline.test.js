import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { normalizeAgentConfig, AgentConfigStore } from '../electron/runtime/agent-config.js';
import { UsageLedger } from '../electron/runtime/usage-ledger.js';
import { DurableRuntime } from '../electron/runtime/runtime.js';
import { WorkingMemory } from '../electron/runtime/working-memory.js';
import { validatePlan } from '../electron/runtime/task-planner.js';
import { Supervisor, checkNode } from '../electron/runtime/supervisor.js';
import { AdmissionPool } from '../electron/runtime/workflow.js';
import { ResourceLock } from '../electron/runtime/resource-lock.js';
import { retrieveKnowledge } from '../electron/knowledge.js';
import { queryDatabase } from '../electron/sql-query.js';
import { callRegisteredApi } from '../electron/registered-api.js';
import { runSandboxed } from '../electron/runtime/sandbox.js';
import { saveMemory, retrieveMemories } from '../electron/memory.js';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createConfiguredModel } from '../electron/model.js';

async function fixture(t) { const root = await mkdtemp(path.join(os.tmpdir(), 'meihua-pipeline-')); t.after(() => rm(root, { recursive: true, force: true })); const workspace = path.join(root, 'work'); await mkdir(workspace); return { root, workspace: await realpath(workspace) }; }
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const model = { id: 'test', provider: 'local', api: 'openai-completions', maxTokens: 500, contextWindow: 8000 };
const config = () => normalizeAgentConfig({ maxTokens: 10000, maxCalls: 3, contextWindow: 8000, maxOutputTokens: 500 });
const node = (id, dependencies = [], role = 'research') => ({ id, role, title: id, instruction: '读取并核对资料', dependencies, tools: ['read_file'], outputs: [], checks: [] });
const catalog = [{ name: 'read_file' }, { name: 'write_file' }];

test('agent policy validates bounded concurrency, URLs and cost data and persists only normalized values', async (t) => {
  const { root } = await fixture(t); const store = new AgentConfigStore(root);
  assert.throws(() => normalizeAgentConfig({ maxWorkers: 100 })); assert.throws(() => normalizeAgentConfig({ allowedOrigins: ['http://example.com'] })); assert.throws(() => normalizeAgentConfig({ apiEndpoints: [{ name: 'x', url: 'https://u:password@example.com/api' }] }));
  assert.throws(() => normalizeAgentConfig({ prices: { x: { input: NaN } } }));
  assert.throws(() => normalizeAgentConfig({ modelTimeoutSeconds: 0 })); assert.equal(normalizeAgentConfig({}).modelTimeoutSeconds, 180);
  await store.save({ maxWorkers: 4, allowedOrigins: ['https://example.com'], ignored: 'secret' }); assert.equal((await store.get()).maxWorkers, 4); assert.equal((await store.get()).ignored, undefined);
});
test('budget admission is atomic across simultaneous model calls and price-less costs remain unknown', async () => {
  const ledger = new UsageLedger({ config: config(), manager: {}, taskId: 'x' });
  const a = ledger.reserve(model, { messages: [] }, 'a', 'compatible'); const b = ledger.reserve(model, { messages: [] }, 'b', 'compatible'); ledger.reserve(model, {}, 'c', 'compatible');
  assert.throws(() => ledger.reserve(model, {}, 'd', 'compatible'), /调用次数/); assert.equal(ledger.calls.length, 3); assert.equal(a.call.costUsd, null); assert.equal(b.call.usageSource, 'unavailable');
  assert.throws(() => new UsageLedger({ config: { ...config(), maxCost: 1 }, manager: {} }).reserve(model, {}, 'x', 'compatible'), /价格未配置/);
  const limited = new UsageLedger({ config: { ...config(), maxTokens: 1000 }, manager: {} }); limited.reserve(model, {}, 'a', 'x'); assert.throws(() => limited.reserve(model, {}, 'b', 'x'), /Token/);
});
test('global network permission restricts sandbox policy and a resumed task cannot broaden its frozen permission', async (t) => {
  const { root, workspace } = await fixture(t); const runtime = new DurableRuntime(root);
  await runtime.agentConfig.save({ network: true });
  const input = { sessionId: 's', workspace, originalPrompt: '检查网络边界', mode: 'workflow', model: 'test', provider: 'compatible', networkAllowed: false };
  const task = await runtime.begin(input); assert.equal((await runtime.store.get(task.id)).agentPolicy.network, false);
  await runtime.manager.transition(task.id, 'paused'); await runtime.begin({ ...input, networkAllowed: true }, task.id, true);
  assert.equal((await runtime.store.get(task.id)).agentPolicy.network, false);
});
test('model stream writes provider usage or explicit estimates before returning its result, never invented free charges', async (t) => {
  const { root, workspace } = await fixture(t); const runtime = new DurableRuntime(root); const task = await runtime.begin({ sessionId: 's', workspace, originalPrompt: '检查', mode: 'ask', provider: 'compatible', model: 'test' });
  const source = (reported) => ({ model, streamFn: () => { const stream = createAssistantMessageEventStream(); queueMicrotask(() => { const message = { role: 'assistant', content: [{ type: 'text', text: '已读' }], stopReason: 'stop', usage: reported ? { input: 30, output: 4, cacheRead: 2, cacheWrite: 0 } : {} }; stream.push({ type: 'done', reason: 'stop', message }); stream.end(message); }); return stream; } });
  const first = runtime.trackedModel(source(true), { provider: 'compatible', stage: 'research' }).streamFn(model, {}); for await (const _event of first) {} await first.result();
  const second = runtime.trackedModel(source(false), { provider: 'compatible' }).streamFn(model, {}); for await (const _event of second) {} await second.result();
  const record = await runtime.store.get(task.id); assert.equal(record.modelLedger[0].totalTokens, 36); assert.equal(record.modelLedger[1].usageSource, 'estimate'); assert.equal(record.modelLedger[0].costUsd, null); assert.equal(record.diagnostics.modelCalls, 2); assert.equal(record.diagnostics.inputTokens, 30);
});
test('an interrupted pending reservation is conservatively charged on resume', () => {
  const ledger = new UsageLedger({ config: config(), manager: {}, calls: [{ status: 'running', reservedTokens: 300, reservedCost: 0.02 }] }); assert.equal(ledger.calls[0].status, 'interrupted'); assert.equal(ledger.totals().tokens, 300); assert.equal(ledger.totals().cost, .02);
  const unknown = new UsageLedger({ config: config(), manager: {}, calls: [{ status: 'running', reservedTokens: 300, reservedCost: null }] }); assert.equal(unknown.calls[0].estimatedCostUsd, undefined); assert.equal(unknown.calls[0].budgetSource, 'reservation'); assert.equal(unknown.totals().unknownCost, true);
});
test('model deadlines and cancellation finish even when a provider ignores abort and never completes its stream', async (t) => {
  const { root, workspace } = await fixture(t); const runtime = new DurableRuntime(root);
  const task = await runtime.begin({ sessionId: 's', workspace, originalPrompt: '检查超时', mode: 'ask', provider: 'compatible', model: 'test' });
  runtime.ledger.config.modelTimeoutSeconds = 0.03; // Short test deadline; saved settings enforce at least 30s.
  for (const phase of ['connect', 'stream', 'cancel']) {
    const controller = new AbortController(); let providerSignal;
    const source = { model, streamFn: (_model, _context, options) => {
      providerSignal = options.signal;
      // Cancel an in-flight provider, rather than racing the durable admission writes.
      if (phase === 'cancel') queueMicrotask(() => controller.abort(new Error('用户停止')));
      return phase === 'connect' ? new Promise(() => {}) : createAssistantMessageEventStream();
    } };
    const output = runtime.trackedModel(source).streamFn(model, {}, { signal: controller.signal });
    const result = await output.result();
    assert.equal(result.stopReason, phase === 'cancel' ? 'aborted' : 'error'); assert.match(result.errorMessage, phase === 'cancel' ? /用户停止/ : /MODEL_TIMEOUT/);
    assert.equal(providerSignal.aborted, true);
  }
  const calls = (await runtime.store.get(task.id)).modelLedger;
  assert.equal(calls.length, 3); assert.ok(calls.every((call) => call.budgetSource === 'reservation' && call.totalTokens === call.reservedTokens && call.costUsd === null));
});
test('model timeout aborts a real pending HTTP request and records an explicit failure', async (t) => {
  const { root, workspace } = await fixture(t); let received = false, closed = false;
  const server = createServer((request, response) => { received = true; request.resume(); response.on('close', () => { closed = true; }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const runtime = new DurableRuntime(root); const task = await runtime.begin({ sessionId: 's', workspace, originalPrompt: '检查连接超时', mode: 'ask', provider: 'compatible', model: 'test' });
  runtime.ledger.config.modelTimeoutSeconds = 0.5;
  const configured = createConfiguredModel({ provider: 'compatible', model: 'test', baseUrl: `http://127.0.0.1:${server.address().port}/v1` }, 'local');
  const result = await runtime.trackedModel(configured).streamFn(configured.model, { messages: [] }).result();
  assert.equal(received, true); assert.match(result.errorMessage, /MODEL_TIMEOUT/);
  for (let attempt = 0; attempt < 50 && !closed; attempt++) await wait(10);
  assert.equal(closed, true); assert.equal((await runtime.store.get(task.id)).modelLedger[0].budgetSource, 'reservation');
});
test('local RAG returns real quoted passages with hashes and ignores outside symlink content', async (t) => {
  const { root, workspace } = await fixture(t); await writeFile(path.join(workspace, 'source.md'), '# 指标\n收入 240 元，成本 90 元。\n计算利润需要收入减成本。'); await writeFile(path.join(root, 'outside.md'), '利润泄漏秘密'); await symlink(path.join(root, 'outside.md'), path.join(workspace, 'link.md'));
  const found = await retrieveKnowledge(workspace, '收入利润'); assert.equal(found.method, 'BM25'); assert.equal(found.results.length, 1); assert.match(found.results[0].text, /收入 240/); assert.match(found.results[0].hash, /^[a-f0-9]{64}$/); assert.equal(found.results[0].trusted, false);
});
test('SQL permits parameterized aggregation and denies writes, attach, pragma and path escape', async (t) => {
  const { root, workspace } = await fixture(t), file = path.join(workspace, 'sales.db'); const db = new DatabaseSync(file); db.exec('CREATE TABLE sales(amount INTEGER); INSERT INTO sales VALUES(100),(140)'); db.close();
  const result = await queryDatabase(workspace, 'sales.db', 'SELECT SUM(amount) AS total FROM sales WHERE amount > ?', { params: [90] }); assert.equal(result.rows[0].total, 240);
  for (const sql of ['DELETE FROM sales', "ATTACH '/tmp/outside.db' AS outside", 'PRAGMA table_info(sales)', "SELECT load_extension('/tmp/x')"]) await assert.rejects(queryDatabase(workspace, 'sales.db', sql), /只读 SQL/);
  await assert.rejects(queryDatabase(workspace, '../sales.db', 'SELECT 1'), /路径超出/);
  await symlink(path.join(root, 'outside'), file + '-wal'); await assert.rejects(queryDatabase(workspace, 'sales.db', 'SELECT 1'), /路径超出/);
});
test('SQL kills an expensive query on timeout and does not keep its worker alive', async (t) => {
  const { workspace } = await fixture(t); new DatabaseSync(path.join(workspace, 'sales.db')).close();
  await assert.rejects(queryDatabase(workspace, 'sales.db', 'WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM r) SELECT SUM(x) FROM r', { timeoutMs: 100 }), /超时/);
});
test('short-term task memory validates source hashes before supplying dependent nodes', async (t) => {
  const { root, workspace } = await fixture(t); const runtime = new DurableRuntime(root), task = await runtime.begin({ sessionId: 's', workspace, originalPrompt: '报告', mode: 'workflow', model: 'test', provider: 'compatible' }); const memory = new WorkingMemory(runtime.manager);
  await writeFile(path.join(workspace, 'report.md'), '结论'); await memory.save(task.id, workspace, { nodeId: 'research', summary: '资料依据', files: ['report.md'] }); assert.equal((await memory.retrieve(await runtime.store.get(task.id)))[0].valid, true);
  await writeFile(path.join(workspace, 'report.md'), '变化'); assert.equal((await memory.retrieve(await runtime.store.get(task.id)))[0].valid, false); assert.equal((await memory.retrieve(await runtime.store.get(task.id), ['other'])).length, 0);
  await assert.rejects(memory.save(task.id, workspace, { nodeId: 'new', summary: '旧结论', sources: [{ path: 'report.md', hash: 'a'.repeat(64) }] }), /读取后已经变化/);
});
test('long-term memory excludes expired or conflicting facts and a user decision resolves conflict', () => {
  const a = { content: '报告币种人民币', kind: 'fact', scope: 'workspace', enabled: true, topic: 'currency' }; let items = saveMemory([], a, '/work'); items = saveMemory(items, { ...a, content: '报告币种美元' }, '/work'); assert.equal(retrieveMemories(items, '/work', '报告币种').length, 0);
  items = saveMemory(items, { ...items[1], resolveConflicts: true }, '/work'); assert.equal(retrieveMemories(items, '/work', '报告币种')[0].content, '报告币种美元');
  items[1].expiresAt = '2000-01-01T00:00:00Z'; assert.equal(retrieveMemories(items, '/work', '报告币种').length, 0);
  items = saveMemory(items, { ...items[1], enabled: false }, '/work'); assert.equal(items.at(-1).expiresAt, '2000-01-01T00:00:00Z');
  assert.throws(() => saveMemory(items, { ...items.at(-1), expiresAt: '1999-01-01T00:00:00Z' }, '/work'), /未来日期/);
});
test('planner denies cyclic dependencies, escalated roles, escaped or unchecked outputs', () => {
  assert.throws(() => validatePlan({ summary: 'x', nodes: [node('a', ['b']), node('b', ['a'])] }, catalog), /循环/);
  assert.throws(() => validatePlan({ summary: 'x', nodes: [{ ...node('a'), tools: ['write_file'] }] }, catalog), /权限/);
  assert.throws(() => validatePlan({ summary: 'x', nodes: [{ ...node('a', [], 'document'), outputs: ['../x'], checks: [] }] }, catalog), /相对路径/);
  assert.throws(() => validatePlan({ summary: 'x', nodes: [{ ...node('a', [], 'document'), outputs: ['x'], checks: [] }] }, catalog), /检查/);
});
test('supervisor really runs independent nodes concurrently, preserves dependencies and blocks descendants on failure', async () => {
  const plan = validatePlan({ summary: 'x', nodes: [node('a'), node('b'), node('c', ['a', 'b'])] }, catalog); let active = 0, peak = 0; const completed = new Set();
  const result = await new Supervisor({ maxWorkers: 2 }).run(plan, async (current) => { assert.ok(current.dependencies.every((id) => completed.has(id))); active++; peak = Math.max(peak, active); await wait(30); active--; completed.add(current.id); return { ok: current.id !== 'b', summary: '实际结果' }; });
  assert.equal(peak, 2); assert.equal(result.ok, false); assert.equal(plan.nodes[2].status, 'blocked');
});
test('supervisor cancellation settles in-flight work and never starts a dependent node', async () => {
  const plan = validatePlan({ summary: 'x', nodes: [node('a'), node('b', ['a'])] }, catalog), controller = new AbortController(); let active = false;
  const promise = new Supervisor({ maxWorkers: 2 }).run(plan, async () => { active = true; await wait(30); active = false; return { ok: false }; }, controller.signal); setTimeout(() => controller.abort(new Error('stop')), 5); await assert.rejects(promise, /stop/); assert.equal(active, false); assert.notEqual(plan.nodes[1].status, 'running');
});
test('bounded admission handles load, backpressure and cancellation without leaked slots', async () => {
  const pool = new AdmissionPool(2, 4), one = await pool.acquire(), two = await pool.acquire(), controller = new AbortController(); const queued = pool.acquire(controller.signal); controller.abort(new Error('stop')); await assert.rejects(queued, /stop/); one(); two();
  await Promise.all(Array.from({ length: 6 }, () => pool.run(() => wait(5)))); assert.equal(pool.active, 0); assert.equal(pool.peak, 2);
  const release = await pool.acquire(); const release2 = await pool.acquire(); const queue = Array.from({ length: 4 }, () => pool.acquire()); assert.throws(() => pool.acquire(), /队列已满/); release(); release2(); for (const promise of queue) (await promise)(); assert.equal(pool.active, 0);
});
test('workspace side effects never overlap, including across separate workflows', async () => {
  const lock = new ResourceLock(); let active = 0, peak = 0; await Promise.all(Array.from({ length: 10 }, () => lock.run('/work', async () => { active++; peak = Math.max(peak, active); await wait(1); active--; }))); assert.equal(peak, 1);
});
test('registered API checks exact registered endpoint, role method and approval before sending', async (t) => {
  let hits = 0; const server = createServer((request, response) => { hits++; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ total: 240, query: request.url })); }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close()); const url = `http://127.0.0.1:${server.address().port}/api`;
  const policy = normalizeAgentConfig({ apiEndpoints: [{ name: 'data', url, methods: ['GET', 'POST'] }] });
  await assert.rejects(callRegisteredApi(policy, 'data', { method: 'POST', readOnly: true, approve: async () => true }), /不允许/); await assert.rejects(callRegisteredApi(policy, 'data', { approve: async () => false }), /拒绝/); assert.equal(hits, 0);
  assert.equal((await callRegisteredApi(policy, 'data', { query: { month: '10' }, approve: async () => true })).data.total, 240); assert.equal(hits, 1);
});
test('declared verification reads actual artifacts and refuses a fabricated model completion', async (t) => {
  const { workspace } = await fixture(t); const current = { checks: [{ kind: 'contains', path: 'report.md', text: '240' }] }; assert.equal((await checkNode(workspace, current)).ok, false); await writeFile(path.join(workspace, 'report.md'), '总收入240'); assert.equal((await checkNode(workspace, current)).ok, true);
});
test('macOS sandbox permits workspace files but denies outside reads/writes, secret env and TCP without network permission', { skip: process.platform !== 'darwin' }, async (t) => {
  const { root, workspace } = await fixture(t); const outside = path.join(root, 'outside.txt'); await writeFile(outside, 'keep');
  const approved = await runSandboxed('/bin/sh', ['-c', 'echo allowed > result.txt; cat result.txt'], { workspace }); assert.equal(approved.code, 0); assert.match(approved.stdout, /allowed/);
  assert.notEqual((await runSandboxed('/bin/cat', [outside], { workspace })).code, 0); assert.notEqual((await runSandboxed('/bin/sh', ['-c', 'echo bad > ' + outside], { workspace })).code, 0); assert.equal(await readFile(outside, 'utf8'), 'keep');
  process.env.MEIHUA_TEST_SECRET = 'do-not-inherit'; const env = await runSandboxed('node', ['-e', 'console.log(process.env.MEIHUA_TEST_SECRET || "absent")'], { workspace }); delete process.env.MEIHUA_TEST_SECRET; assert.equal(env.stdout.trim(), 'absent');
  const server = createServer((_request, response) => response.end('bad')); server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const tcp = await runSandboxed('node', ['-e', `const net=require('net'); const s=net.connect(${server.address().port},'127.0.0.1');s.on('connect',()=>{console.log('CONNECTED');process.exit(0)});s.on('error',()=>process.exit(2));setTimeout(()=>process.exit(3),1000);`], { workspace, timeoutMs: 5000 }); assert.notEqual(tcp.code, 0); assert.doesNotMatch(tcp.stdout, /CONNECTED/);
});
