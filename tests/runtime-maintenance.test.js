import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, realpath, symlink, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { DurableRuntime } from '../electron/runtime/runtime.js';
import { TaskStore } from '../electron/runtime/task-store.js';
import { TaskManager } from '../electron/runtime/task-manager.js';
import { VerificationEngine } from '../electron/runtime/verification-engine.js';
import { normalizeVerificationConfig } from '../electron/runtime/verification-config.js';

async function fixture(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'meihua-maintenance-')); await mkdir(path.join(root, 'workspace'));
  const workspace = await realpath(path.join(root, 'workspace')), runtime = new DurableRuntime(path.join(root, 'runtime'));
  const create = () => runtime.manager.create({ sessionId: 'test-session', workspace, originalPrompt: '完成并验证', mode: 'execute', model: 'mock', provider: 'compatible' });
  try { await fn({ root, workspace, runtime, create }); } finally { await rm(root, { recursive: true, force: true }); }
}
const command = (patch = {}) => ({ id: randomUUID(), name: 'check', command: 'node', args: ['verify.cjs'], cwd: 'sub', timeoutSeconds: 30, expectedOutput: 'passed', outputs: ['sub/result.json'], ...patch });
async function checkpoint(runtime, record, workspace, requested, text, complete = true) {
  const cp = await runtime.checkpoints.begin(record.id, 'test-step', workspace, requested); await writeFile(path.join(workspace, requested), text);
  if (complete) await runtime.checkpoints.complete(cp); return cp;
}
async function ageTask(runtime, record, status = 'completed') {
  await runtime.manager.transition(record.id, 'running');
  if (status === 'paused') await runtime.manager.pause(record.id);
  else await runtime.manager.transition(record.id, status);
  await runtime.manager.mutate(record.id, (task) => { task.completedAt = new Date(Date.now() - 40 * 86400000).toISOString(); });
}

test('v1 migration preserves exact bytes and serializes a simultaneous update', async () => fixture(async ({ runtime, create }) => {
  const record = await create(), file = runtime.store.file(record.id);
  await rm(runtime.store.journal.file(record.id)); // This fixture represents a pre-journal application.
  const legacy = { ...record, schemaVersion: 1 }; delete legacy.userUpdates; delete legacy.checkpointsExpiredAt;
  const raw = JSON.stringify(legacy, null, 1) + '\n'; await writeFile(file, raw);
  const restarted = new TaskStore(runtime.store.root), manager = new TaskManager(restarted);
  await Promise.all([restarted.get(record.id), manager.event(record.id, 'model_message', { summary: 'after migration' }), restarted.get(record.id)]);
  const saved = await restarted.get(record.id); assert.equal(saved.schemaVersion, 2); assert.equal(saved.events.at(-1).payload.summary, 'after migration');
  const backups = await readdir(path.join(restarted.root, 'migrations')); assert.equal(backups.length, 1);
  assert.equal(await readFile(path.join(restarted.root, 'migrations', backups[0]), 'utf8'), raw);
  await restarted.get(record.id); assert.equal((await readdir(path.join(restarted.root, 'migrations'))).length, 1);
}));
test('malformed and unsupported tasks are isolated, preserved and never silently migrated', async () => fixture(async ({ runtime, create }) => {
  const valid = await create(), bad = randomUUID(), future = randomUUID();
  await writeFile(runtime.store.file(bad), '{"secret":"do-not-show",');
  const futureRaw = JSON.stringify({ ...valid, id: future, schemaVersion: 99 }); await writeFile(runtime.store.file(future), futureRaw);
  assert.deepEqual((await runtime.manager.recoverInterrupted()).map((task) => task.id), [valid.id]);
  assert.equal(runtime.store.warnings.size, 2); assert.doesNotMatch(JSON.stringify([...runtime.store.warnings.values()]), /do-not-show/);
  assert.equal(await readFile(runtime.store.file(future), 'utf8'), futureRaw);
  await assert.rejects(runtime.backups.preview(), /无法确认/);
  await rm(runtime.store.file(bad)); await rm(runtime.store.file(future)); await runtime.store.list(); assert.equal(runtime.store.warnings.size, 0);
}));
test('verification configuration persists per canonical workspace and freezes before a paused task resumes', async () => fixture(async ({ root, runtime, workspace, create }) => {
  const config = { mode: 'custom', commands: [command()] };
  await runtime.verificationConfig.save(workspace, config);
  const alias = path.join(root, 'alias'); await symlink(workspace, alias);
  assert.equal((await runtime.verificationConfig.get(alias)).mode, 'custom');
  const record = await create(); await runtime.begin({ sessionId: record.sessionId, workspace }, record.id); await runtime.manager.pause(record.id);
  runtime.activeId = null; await runtime.verificationConfig.save(workspace, { mode: 'files', commands: [] });
  await runtime.begin({ sessionId: record.sessionId, workspace }, record.id, true);
  assert.equal((await runtime.store.get(record.id)).verificationPolicy.mode, 'custom');
  for (const patch of [{ cwd: '../outside' }, { outputs: ['/tmp/file'] }, { args: ['bad\0arg'] }, { command: 'bad\0executable' }]) assert.throws(() => normalizeVerificationConfig({ mode: 'custom', commands: [command(patch)] }));
}));
test('custom verification runs real argv in a child directory and checks text plus declared JSON output', async () => fixture(async ({ runtime, workspace, create }) => {
  await mkdir(path.join(workspace, 'sub'));
  await writeFile(path.join(workspace, 'sub', 'verify.cjs'), "require('fs').writeFileSync('result.json', JSON.stringify({ok: true})); console.log(process.argv[2]);");
  const record = await create(); await checkpoint(runtime, record, workspace, 'readme.txt', 'updated');
  const approvals = [], config = { mode: 'custom', commands: [command({ command: process.execPath, args: ['verify.cjs', 'passed'] })] };
  const engine = new VerificationEngine({ checkpoints: runtime.checkpoints, config, approve: async (_kind, detail) => { approvals.push(detail); return true; } });
  const result = await engine.verify({ ...record, allowCommands: true });
  assert.equal(result.ok, true); assert.equal(result.scope, 'custom'); assert.match(result.checks.at(-1).stdout, /passed/);
  assert.equal(result.checks.at(-1).outputFiles[0].path, 'sub/result.json'); assert.equal(approvals[0].workspace, path.join(workspace, 'sub'));
  config.commands[0].expectedOutput = 'missing'; assert.equal((await engine.verify({ ...record, allowCommands: true })).ok, false);
  const denied = await engine.verify({ ...record, allowCommands: false }); assert.equal(denied.ok, false); assert.equal(denied.retryable, false);
}));
test('verification refuses changed approved directory, outside symlink and npm script changes', async () => fixture(async ({ root, runtime, workspace, create }) => {
  const record = await create(); await checkpoint(runtime, record, workspace, 'code.js', 'changed'); await mkdir(path.join(workspace, 'sub'));
  let runs = 0;
  const engine = new VerificationEngine({ checkpoints: runtime.checkpoints, config: { mode: 'custom', commands: [command()] }, runner: async () => { runs++; return { code: 0 }; }, approve: async () => { await rename(path.join(workspace, 'sub'), path.join(workspace, 'previous')); await mkdir(path.join(workspace, 'sub')); return true; } });
  assert.equal((await engine.verify({ ...record, allowCommands: true })).ok, false); assert.equal(runs, 0);
  await rm(path.join(workspace, 'sub'), { recursive: true }); await symlink(root, path.join(workspace, 'sub'));
  assert.equal((await engine.verify({ ...record, allowCommands: true })).ok, false); assert.equal(runs, 0);
  await writeFile(path.join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'original' } }));
  engine.config = { mode: 'auto', commands: [] }; engine.approve = async (_kind, detail) => { assert.equal(detail.script, 'original'); await writeFile(path.join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'changed' } })); return true; };
  const result = await engine.verify({ ...record, allowCommands: true }); assert.equal(result.ok, false); assert.equal(result.retryable, false); assert.equal(runs, 0);
}));
test('file-only verification reports its limited scope and rejects broken declared artifacts', async () => fixture(async ({ runtime, workspace, create }) => {
  const record = await create(); await checkpoint(runtime, record, workspace, 'note.txt', 'changed');
  const engine = new VerificationEngine({ checkpoints: runtime.checkpoints, config: { mode: 'files', commands: [] }, approve: async () => { throw new Error('must not run'); } });
  const result = await engine.verify(record); assert.equal(result.ok, true); assert.equal(result.warnings.length, 1);
  await mkdir(path.join(workspace, 'sub')); await writeFile(path.join(workspace, 'sub', 'result.json'), '{broken');
  engine.config = { mode: 'custom', commands: [command({ expectedOutput: '' })] }; engine.approve = async () => true; engine.runner = async () => ({ code: 0 });
  assert.equal((await engine.verify({ ...record, allowCommands: true })).ok, false);
}));
test('backup cleanup is opt-in, protects paused and uncertain tasks, and preserves shared blobs and work files', async () => fixture(async ({ runtime, workspace, create }) => {
  const old = await create(), paused = await create(), uncertain = await create();
  const oldCp = await checkpoint(runtime, old, workspace, 'old.txt', 'shared'); await ageTask(runtime, old);
  const pausedCp = await checkpoint(runtime, paused, workspace, 'paused.txt', 'shared'); await ageTask(runtime, paused, 'paused');
  const pending = await checkpoint(runtime, uncertain, workspace, 'uncertain.txt', 'unique-uncertain', false); await ageTask(runtime, uncertain, 'failed');
  assert.equal((await runtime.backups.preview()).tasks.length, 0);
  await runtime.backups.savePolicy(30); const preview = await runtime.backups.preview(); assert.deepEqual(preview.tasks.map((item) => item.id), [old.id]); assert.equal(preview.protectedTasks, 2);
  await runtime.backups.apply(preview.id);
  assert.equal(await readFile(path.join(workspace, 'old.txt'), 'utf8'), 'shared');
  assert.equal(await readFile(runtime.checkpoints.blob(oldCp.after.hash), 'utf8'), 'shared');
  assert.equal((await runtime.checkpoints.list(paused.id))[0].id, pausedCp.id); assert.equal((await runtime.checkpoints.list(uncertain.id))[0].id, pending.id);
  assert.ok((await runtime.store.get(old.id)).checkpointsExpiredAt); assert.equal((await runtime.store.get(old.id)).events.at(-1).type, 'checkpoint_expired');
}));
test('backup preview refuses stale state, expires, is single-use and removes only unshared expired snapshots', async () => fixture(async ({ runtime, workspace, create }) => {
  const record = await create(); await writeFile(path.join(workspace, 'note.txt'), 'before-unique');
  const cp = await checkpoint(runtime, record, workspace, 'note.txt', 'after-unique'); await ageTask(runtime, record);
  await runtime.backups.savePolicy(7); let preview = await runtime.backups.preview();
  await runtime.manager.event(record.id, 'model_message', { summary: 'changed history' }); await assert.rejects(runtime.backups.apply(preview.id), /已变化/);
  assert.equal((await runtime.checkpoints.list(record.id)).length, 1);
  preview = await runtime.backups.preview(); await assert.rejects(runtime.backups.apply(preview.id, Date.now() + 6 * 60000), /过期/);
  preview = await runtime.backups.preview(); const result = await runtime.backups.apply(preview.id); assert.equal(result.tasks, 1); assert.equal(result.blobs, 2);
  await assert.rejects(readFile(runtime.checkpoints.blob(cp.before.hash)), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(workspace, 'note.txt'), 'utf8'), 'after-unique'); await assert.rejects(runtime.backups.apply(preview.id), /过期/);
}));
test('backup cleanup refuses corrupt metadata or symlinks and retains all original files', async () => fixture(async ({ root, runtime, workspace, create }) => {
  const record = await create(), cp = await checkpoint(runtime, record, workspace, 'note.txt', 'original'); await ageTask(runtime, record); await runtime.backups.savePolicy(7);
  const file = path.join(runtime.checkpoints.directory(record.id), `${cp.id}.json`), raw = await readFile(file);
  await writeFile(file, '{}'); await assert.rejects(runtime.backups.preview(), /无法确认/); assert.equal(await readFile(path.join(workspace, 'note.txt'), 'utf8'), 'original');
  await writeFile(file, raw); await rm(file); await symlink(path.join(workspace, 'note.txt'), file); await assert.rejects(runtime.backups.preview(), /无法确认/);
  await rm(file); await writeFile(file, raw);
  const outside = path.join(root, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'keep'), 'keep');
  await rename(path.join(runtime.store.root, 'blobs'), path.join(runtime.store.root, 'saved-blobs')); await symlink(outside, path.join(runtime.store.root, 'blobs'));
  await assert.rejects(runtime.backups.preview(), /无法确认/); assert.equal(await readFile(path.join(outside, 'keep'), 'utf8'), 'keep');
}));
