import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveWorkspacePath } from '../electron/workspace.js';

test('workspace paths stay inside the selected directory, including symlinks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zhuge-workspace-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'zhuge-outside-'));
  try {
    await mkdir(path.join(root, 'notes'));
    await writeFile(path.join(root, 'notes', 'a.txt'), 'hello');
    await symlink(outside, path.join(root, 'escape'));
    const canonicalRoot = await realpath(root);
    assert.equal(await resolveWorkspacePath(root, 'notes/a.txt'), path.join(canonicalRoot, 'notes', 'a.txt'));
    assert.equal(await resolveWorkspacePath(root, 'notes/new.txt', { forWrite: true }), path.join(canonicalRoot, 'notes', 'new.txt'));
    await assert.rejects(resolveWorkspacePath(root, '../outside.txt', { forWrite: true }), /超出/);
    await assert.rejects(resolveWorkspacePath(root, 'escape/secret.txt', { forWrite: true }), /超出/);
    await assert.rejects(resolveWorkspacePath(root, 'escape', { forWrite: false }), /超出/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
