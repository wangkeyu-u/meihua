import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, symlink, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { updateSession, forkSession, sessionMarkdown } from '../electron/session-actions.js';
import { saveJson, sessionSummaries } from '../electron/storage.js';
import { readDocument, listWorkspaceFiles, workspaceDiff, attachmentContext } from '../electron/files.js';
import { runProcess } from '../electron/process.js';
import { normalizePreferences } from '../electron/preferences.js';

test('session rename, pin, archive and fork preserve independent complete histories', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zhuge-sessions-'));
  try {
    const original = { id: randomUUID(), title: 'original', updatedAt: '2026-01-01', workspace: root, messages: [{ role: 'user', content: 'hidden searchable phrase', attachments: [{ name: 'source.md' }] }, { role: 'tool', name: 'read_file', state: 'done', output: 'evidence' }], transcript: [{ role: 'user', content: 'history' }], pendingReview: 'pending' };
    const changed = updateSession(original, { title: ' renamed ', pinned: true, archived: true, workspace: '/not-allowed' });
    assert.equal(changed.title, 'renamed'); assert.equal(changed.workspace, root); assert.equal(original.title, 'original');
    const fork = forkSession(changed); assert.notEqual(fork.id, original.id); assert.equal(fork.archived, false); assert.equal(fork.pendingReview, 'pending');
    fork.transcript[0].content = 'changed'; assert.equal(original.transcript[0].content, 'history');
    await saveJson(path.join(root, `${changed.id}.json`), changed);
    await saveJson(path.join(root, `${fork.id}.json`), fork);
    const summaries = await sessionSummaries(root);
    assert.equal(summaries[0].id, changed.id); assert.equal(summaries[0].archived, true);
    assert.match(summaries[0].searchText, /hidden searchable phrase/);
    assert.match(sessionMarkdown(original), /source.md/); assert.match(sessionMarkdown(original), /evidence/);
    assert.throws(() => updateSession(original, { title: ' ' }));
    assert.throws(() => updateSession(original, { archived: 'yes' }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('file browser and attachment reading bound text and reject directory escapes and binaries', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'zhuge-filepanel-')));
  try {
    await mkdir(path.join(root, 'sub')); await mkdir(path.join(root, 'node_modules'));
    await writeFile(path.join(root, 'note.md'), '# Context\nhello');
    await writeFile(path.join(root, 'binary'), Buffer.from([0, 1, 2]));
    await symlink(os.tmpdir(), path.join(root, 'outside'));
    const listing = await listWorkspaceFiles(root);
    assert.equal(listing.entries[0].name, 'sub');
    assert.equal(listing.entries.some((entry) => ['outside', 'node_modules'].includes(entry.name)), false);
    await assert.rejects(listWorkspaceFiles(root, '../'));
    const read = await readDocument(path.join(root, 'note.md'), 5);
    assert.deepEqual(read, { text: '# Con', truncated: true });
    await assert.rejects(readDocument(path.join(root, 'binary')), /二进制/);
    await assert.rejects(readDocument(path.join(root, 'sub')), /请选择/);
    assert.match(attachmentContext([{ name: 'note.md', ...read }]), /截断/);
    await assert.rejects(workspaceDiff(root), /不是 Git/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Git panel distinguishes staged and working changes without modifying the repository', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zhuge-diff-'));
  const git = async (...args) => { const out = await runProcess('/usr/bin/git', ['-C', root, ...args]); assert.equal(out.code, 0, out.output); return out.output; };
  try {
    await git('init'); await writeFile(path.join(root, 'file.txt'), 'one\n'); await git('add', 'file.txt');
    await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
    await writeFile(path.join(root, 'file.txt'), 'two\n'); await git('add', 'file.txt'); await writeFile(path.join(root, 'file.txt'), 'three\n');
    const before = await git('status', '--porcelain'); const diff = await workspaceDiff(root);
    assert.match(diff.staged, /\+two/); assert.match(diff.working, /\+three/); assert.match(diff.status, /MM file.txt/);
    assert.equal(await git('status', '--porcelain'), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('appearance and behavior settings accept only supported choices', () => {
  const next = normalizePreferences({ theme: 'dark', fontSize: 'large', sendShortcut: 'mod-enter', completionNotifications: true, preventSleep: true });
  assert.equal(next.theme, 'dark'); assert.equal(next.preventSleep, true);
  for (const value of [{ theme: 'invalid' }, { fontSize: 999 }, { sendShortcut: 'anything' }, { preventSleep: 'true' }, { completionNotifications: 1 }]) assert.throws(() => normalizePreferences(value));
});
