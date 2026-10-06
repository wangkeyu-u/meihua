import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { rgPath } from '@vscode/ripgrep';
import { TaskGate, ApprovalQueue } from '../electron/task.js';
import { runCommand, runProcess } from '../electron/process.js';
import { captureFile, assertFileUnchanged } from '../electron/file-state.js';
import { sessionSummaries, saveJson } from '../electron/storage.js';
import { replaceOnce } from '../electron/edit.js';
import { createConfiguredModel } from '../electron/model.js';

test('task preparation is exclusive and a stopped or failed task releases its lock', async () => {
  const gate = new TaskGate();
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const first = gate.run(async (signal) => { await wait; signal.throwIfAborted(); });
  await assert.rejects(gate.run(() => assert.fail('concurrent task started')), /已有任务/);
  gate.stop(); release();
  await assert.rejects(first, /已停止/);
  assert.equal(await gate.run(() => 42), 42);
});

test('approval can be answered synchronously; stopping closes it and rejects stale approval', async () => {
  const events = [];
  const queue = new ApprovalQueue((type, data) => { events.push(type); if (data.id === 'fast' && type === 'approval') queue.answer(data.id, true); });
  assert.equal(await queue.request('fast', 'write', {}), true);
  const controller = new AbortController();
  const pending = queue.request('stop', 'write', {}, controller.signal);
  controller.abort();
  assert.equal(await pending, false);
  assert.equal(queue.answer('stop', true), false);
  assert.equal(await queue.request('late', 'write', {}, controller.signal), false);
  assert.deepEqual(events, ['approval', 'approval-closed', 'approval', 'approval-closed']);
});

test('command timeout and abort terminate descendants; pre-aborted commands never start', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zhuge-process-'));
  try {
    const controller = new AbortController();
    const promise = runCommand('(sleep 1; touch escaped) & wait', root, controller.signal, 5);
    setTimeout(() => controller.abort(), 80);
    await assert.rejects(promise, /已停止/);
    await assert.rejects(runCommand('(sleep 1; touch timed-out) & wait', root, undefined, 0.08), /超时/);
    await assert.rejects(async () => runCommand('touch pre-aborted', root, controller.signal, 1));
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('bundled search works with a minimal Finder PATH and preserves regex errors', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zhuge-search-'));
  try {
    await writeFile(path.join(root, 'note.txt'), 'hello 梅花\n');
    const found = await runProcess(rgPath, ['-n', '--', '梅花', '.'], { cwd: root, env: { PATH: '/usr/bin:/bin' } });
    assert.equal(found.code, 0); assert.match(found.output, /note.txt:1:hello 梅花/);
    const invalid = await runProcess(rgPath, ['--', '[', '.'], { cwd: root });
    assert.equal(invalid.code, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('confirmation detects concurrent edits, new files and replaced symlink parents', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zhuge-confirm-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'zhuge-outside-'));
  try {
    await writeFile(path.join(root, 'note'), 'one');
    const existing = await captureFile(root, 'note');
    await writeFile(path.join(root, 'note'), 'two');
    await assert.rejects(assertFileUnchanged(root, 'note', existing), /已变化/);
    const missing = await captureFile(root, 'new', { allowMissing: true });
    await writeFile(path.join(root, 'new'), 'other writer');
    await assert.rejects(assertFileUnchanged(root, 'new', missing, { allowMissing: true }), /已变化/);
    await mkdir(path.join(root, 'sub'));
    const nested = await captureFile(root, 'sub/new', { allowMissing: true });
    await rm(path.join(root, 'sub'), { recursive: true });
    await symlink(outside, path.join(root, 'sub'));
    await assert.rejects(assertFileUnchanged(root, 'sub/new', nested, { allowMissing: true }));
    assert.deepEqual(await readdir(outside), []);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('one damaged history file does not hide valid sessions and remains recoverable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zhuge-history-'));
  try {
    const id = randomUUID(), bad = `${randomUUID()}.json`;
    await saveJson(path.join(root, `${id}.json`), { id, title: '正常', updatedAt: new Date().toISOString(), messages: [] });
    await writeFile(path.join(root, bad), '{broken');
    const invalid = [];
    const sessions = await sessionSummaries(root, (file) => invalid.push(file));
    assert.equal(sessions.length, 1); assert.equal(sessions[0].id, id);
    assert.deepEqual(invalid, [bad]); assert.equal(await readFile(path.join(root, bad), 'utf8'), '{broken');
    assert.equal((await readdir(root)).some((file) => file.endsWith('.tmp')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('overlapping edit matches and malformed API endpoints fail before execution', () => {
  assert.throws(() => replaceOnce('aaa', 'aa', 'b'), /多次/);
  for (const baseUrl of ['https://', 'file:///tmp/a', 'https://key@example.com/v1', 'https://example.com/v1?token=a']) {
    assert.throws(() => createConfiguredModel({ provider: 'compatible', model: 'local', baseUrl }, 'test'));
  }
});


test('web fetch bounds response size and does not follow HTTPS redirects to HTTP', async () => {
  const { fetchWebpage } = await import('../electron/web.js');
  let calls = 0;
  await assert.rejects(fetchWebpage('https://example.com', undefined, async () => {
    calls++; return new Response(null, { status: 302, headers: { location: 'http://example.com' } });
  }), /HTTPS/);
  assert.equal(calls, 1);
  await assert.rejects(fetchWebpage('https://example.com', undefined, async () => new Response('x'.repeat(2 * 1024 * 1024 + 1))), /超过/);
  assert.equal(await fetchWebpage('https://example.com', undefined, async () => new Response('<h1>hello</h1><script>bad()</script>world')), ' hello world');
});
