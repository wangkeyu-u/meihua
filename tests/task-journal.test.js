import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, writeFile, appendFile, rm, readdir, stat } from 'node:fs/promises';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { TaskStore } from '../electron/runtime/task-store.js';
import { TaskManager } from '../electron/runtime/task-manager.js';

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'meihua-journal-'));
  const workspace = path.join(root, 'workspace'); await mkdir(workspace);
  const store = new TaskStore(path.join(root, 'runtime')), manager = new TaskManager(store);
  const create = (prompt = '检查资料并生成报告') => manager.create({ sessionId: 'journal-session', workspace, originalPrompt: prompt, mode: 'execute', model: 'fixture', provider: 'compatible' });
  try { await run({ root, workspace, store, manager, create }); } finally { await rm(root, { recursive: true, force: true }); }
}

test('task journal serializes concurrent updates and appends deltas without repeating the full prompt', async () => fixture(async ({ store, manager, create }) => {
  const task = await create('目标'.repeat(6000));
  await Promise.all(Array.from({ length: 24 }, (_, index) => manager.event(task.id, 'model_message', { summary: `节点 ${index}` })));
  const rows = (await readFile(store.journal.file(task.id), 'utf8')).trimEnd().split('\n').map(JSON.parse);
  assert.equal(rows.length, 25); assert.deepEqual(rows.map((row) => row.sequence), Array.from({ length: 25 }, (_, index) => index + 1));
  for (const row of rows.slice(1)) { assert.ok(JSON.stringify(row).length < 1500); assert.ok(!JSON.stringify(row).includes('originalPrompt')); }
  const restored = await new TaskStore(store.root).get(task.id); assert.equal(restored.events.length, 25);
  assert.equal((await stat(store.journal.file(task.id))).mode & 0o777, 0o600);
}));

test('corrupt task projection restores complete tool result and transcript while preserving exact original bytes', async () => fixture(async ({ store, manager, create }) => {
  const task = await create(); await manager.transition(task.id, 'running');
  const step = await manager.startStep(task.id, { tool: 'write_file', inputSummary: 'report.md', metadata: { sideEffect: true } });
  await manager.completeStep(task.id, step, { ok: true, summary: '报告写入一次', changedFiles: ['report.md'] });
  await manager.mutate(task.id, (record) => { record.conversations = { execute: { messages: [{ role: 'user', content: '保留约束' }], sequence: 1 } }; });
  const expected = await store.get(task.id), raw = Buffer.concat([Buffer.from('{坏掉的任务视图'), Buffer.from([0xff, 0xfe])]); await writeFile(store.file(task.id), raw);
  const restarted = new TaskStore(store.root); assert.deepEqual(await restarted.get(task.id), expected);
  const warning = restarted.warnings.get(task.id); assert.equal(warning.kind, 'recovered'); assert.equal(warning.blocksCleanup, false);
  assert.deepEqual(await readFile(warning.file), raw);
  const { _journal, ...view } = JSON.parse(await readFile(store.file(task.id), 'utf8'));
  assert.equal(_journal.schemaVersion, 1); assert.deepEqual(view, expected);
}));

test('journal-only task is discoverable and reconstructs a missing JSON projection', async () => fixture(async ({ store, manager, create }) => {
  const task = await create(); await manager.transition(task.id, 'running'); const expected = await store.get(task.id);
  await rm(store.file(task.id)); const restarted = new TaskStore(store.root);
  assert.deepEqual(await restarted.list(), [expected]);
  assert.equal(JSON.parse(await readFile(store.file(task.id), 'utf8')).status, 'running');
}));

test('incomplete final journal line is preserved and ignored, and later updates retain contiguous history', async () => fixture(async ({ store, manager, create }) => {
  const task = await create(); await manager.transition(task.id, 'running');
  const original = await readFile(store.journal.file(task.id)); await appendFile(store.journal.file(task.id), Buffer.from('{"schemaVersion":1,"未完成'));
  const damaged = await readFile(store.journal.file(task.id)); const restarted = new TaskStore(store.root), next = new TaskManager(restarted);
  assert.equal((await restarted.get(task.id)).status, 'running');
  const notice = restarted.warnings.get(task.id); assert.equal(notice.kind, 'recovered');
  assert.deepEqual(await readFile(notice.file), damaged); assert.deepEqual(await readFile(store.journal.file(task.id)), original);
  await next.event(task.id, 'model_message', { summary: '恢复后的新记录' });
  assert.equal((await new TaskStore(store.root).get(task.id)).events.at(-1).payload.summary, '恢复后的新记录');
}));

test('a complete corrupt journal cannot fall back to stale JSON or accept more writes', async () => fixture(async ({ store, manager, create }) => {
  const broken = await create(), healthy = await create();
  await manager.event(broken.id, 'model_message', { summary: '原结果' });
  const raw = (await readFile(store.journal.file(broken.id), 'utf8')).replace('原结果', '伪结果'); await writeFile(store.journal.file(broken.id), raw);
  assert.deepEqual((await store.list()).map((record) => record.id), [healthy.id]);
  assert.equal(store.warnings.get(broken.id).kind, 'invalid');
  await assert.rejects(manager.event(broken.id, 'model_message', { summary: '不能继续写入' }), { code: 'TASK_JOURNAL_INVALID' });
  assert.equal(await readFile(store.journal.file(broken.id), 'utf8'), raw);
}));

test('future journal/projection versions and missing history are preserved without silent downgrade', async () => fixture(async ({ store, create }) => {
  const task = await create(); const journal = store.journal.file(task.id), original = await readFile(journal, 'utf8');
  const malformed = JSON.parse(original); malformed.timestamp = { toString: null };
  for (const raw of [original.replace('"schemaVersion":1', '"schemaVersion":99'), original + original, original.replace('"sequence":1', '"sequence":2'), JSON.stringify(malformed) + '\n']) {
    await writeFile(journal, raw); await assert.rejects(new TaskStore(store.root).get(task.id), { code: 'TASK_JOURNAL_INVALID' });
    assert.equal(await readFile(journal, 'utf8'), raw);
  }
  await writeFile(journal, original);
  const future = JSON.stringify({ ...task, schemaVersion: 99 }); await writeFile(store.file(task.id), future);
  await assert.rejects(new TaskStore(store.root).get(task.id), { code: 'TASK_FORMAT_INVALID' });
  assert.equal(await readFile(store.file(task.id), 'utf8'), future);
}));

test('loss of a committed journal tail or entire journal is detected instead of rewinding a completed tool', async () => fixture(async ({ store, manager, create }) => {
  const task = await create(); await manager.transition(task.id, 'running');
  const step = await manager.startStep(task.id, { tool: 'send_email', inputSummary: 'send once', metadata: { sideEffect: true } });
  const before = await readFile(store.journal.file(task.id));
  await manager.completeStep(task.id, step, { ok: true, summary: 'already sent', changedFiles: [] });
  const projection = await readFile(store.file(task.id));
  await writeFile(store.journal.file(task.id), before);
  await assert.rejects(new TaskStore(store.root).get(task.id), { code: 'TASK_JOURNAL_INVALID' });
  assert.deepEqual(await readFile(store.file(task.id)), projection);
  await rm(store.journal.file(task.id));
  await assert.rejects(new TaskStore(store.root).get(task.id), { code: 'TASK_JOURNAL_INVALID' });
  assert.deepEqual(await readFile(store.file(task.id)), projection);
}));

test('projection write failure does not report a committed tool result as failed, and restart rebuilds it', async () => fixture(async ({ store, manager, create }) => {
  const task = await create(); await manager.transition(task.id, 'running');
  const step = await manager.startStep(task.id, { tool: 'write_file', inputSummary: 'one.txt', metadata: { sideEffect: true } });
  store.project = async () => { throw new Error('simulated ENOSPC in projection'); };
  const completed = await manager.completeStep(task.id, step, { ok: true, summary: '已提交', changedFiles: ['one.txt'] });
  assert.equal(completed.steps[0].status, 'completed'); assert.equal(store.warnings.get(task.id).kind, 'projection-pending');
  const restarted = new TaskStore(store.root), restored = await restarted.get(task.id);
  assert.equal(restored.steps[0].status, 'completed'); assert.equal(restored.events.at(-1).type, 'tool_completed');
  assert.equal(restarted.warnings.get(task.id).kind, 'recovered');
}));

test('failure before journal commit leaves the projection and previous committed state unchanged', async () => fixture(async ({ store, manager, create }) => {
  const task = await create(), projection = await readFile(store.file(task.id)), journal = await readFile(store.journal.file(task.id));
  const append = store.journal.append.bind(store.journal); store.journal.append = async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
  await assert.rejects(manager.event(task.id, 'model_message', { summary: '未保存' }), { code: 'ENOSPC' });
  assert.deepEqual(await readFile(store.file(task.id)), projection); assert.deepEqual(await readFile(store.journal.file(task.id)), journal);
  store.journal.append = append; assert.deepEqual(await store.get(task.id), task);
}));

test('journal cache is isolated from returned objects and preserves arbitrary JSON keys safely', async () => fixture(async ({ store, manager, create }) => {
  const task = await create();
  await manager.mutate(task.id, (record) => { record.extra = JSON.parse('{"__proto__":{"polluted":"no"},"nested":{"first":1,"second":2,"remove":1},"list":[1,2]}'); });
  await manager.mutate(task.id, (record) => { record.extra.nested = { second: 2, first: 1 }; record.extra.list = [3]; record.extra.__proto__.polluted = 'safe'; });
  const returned = await store.get(task.id); returned.extra.list.push(99); returned.events.length = 0;
  const restarted = await new TaskStore(store.root).get(task.id);
  assert.deepEqual(restarted.extra.list, [3]); assert.deepEqual(restarted.extra.nested, { first: 1, second: 2 }); assert.equal(restarted.extra.__proto__.polluted, 'safe');
  assert.equal({}.polluted, undefined); assert.equal(restarted.events.length, 1);
}));

test('killed process after committed tool result recovers to pause without replaying the actual file write', async () => fixture(async ({ root, workspace, store }) => {
  const childFile = path.join(root, 'writer.mjs');
  await writeFile(childFile, `import { TaskStore } from ${JSON.stringify(new URL('../electron/runtime/task-store.js', import.meta.url).href)};
import { TaskManager } from ${JSON.stringify(new URL('../electron/runtime/task-manager.js', import.meta.url).href)};
import { appendFile } from 'node:fs/promises';
const [root, workspace] = process.argv.slice(2), store = new TaskStore(root), manager = new TaskManager(store);
const task = await manager.create({ sessionId:'child', workspace, originalPrompt:'write once', mode:'execute', model:'fixture', provider:'compatible' });
await manager.transition(task.id, 'running');
const step = await manager.startStep(task.id, { tool:'write_file', inputSummary:'once.txt', metadata:{sideEffect:true} });
await appendFile(workspace + '/once.txt', 'write\u0020once\\n');
store.project = async () => { throw new Error('projection unavailable'); };
await manager.completeStep(task.id, step, { ok:true, summary:'actual write committed', changedFiles:['once.txt'] });
process.stdout.write(task.id + '\\n'); setInterval(() => {}, 1000);
`);
  const child = spawn(process.execPath, [childFile, store.root, workspace], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', (value) => { stderr += value; });
  const exit = once(child, 'exit'); let timer;
  try {
    const id = await Promise.race([new Promise((resolve) => { let output = ''; child.stdout.on('data', (value) => { output += value; if (output.includes('\n')) resolve(output.trim()); }); }), exit.then(() => { throw new Error(stderr || 'writer ended before commit'); }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('writer timed out')), 10000); })]);
    child.kill('SIGKILL'); await exit;
    const restarted = new TaskStore(store.root), manager = new TaskManager(restarted);
    const recovered = await manager.recoverInterrupted(); assert.equal(recovered[0].id, id); assert.equal(recovered[0].status, 'paused');
    assert.equal(recovered[0].steps[0].status, 'completed'); assert.equal(recovered[0].steps[0].result.ok, true);
    assert.equal(await readFile(path.join(workspace, 'once.txt'), 'utf8'), 'write once\n');
    assert.equal(recovered[0].events.filter((event) => event.type === 'tool_completed').length, 1);
  } finally { clearTimeout(timer); child.kill('SIGKILL'); }
}));
