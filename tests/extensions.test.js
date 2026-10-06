import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';
import { installSkillZip, loadSkills } from '../electron/skills.js';
import { loadMcpServers, McpManager } from '../electron/mcp.js';

test('workspace Skills are discovered and symlinks cannot escape the workspace', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zhuge-skills-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'zhuge-skills-outside-'));
  try {
    await mkdir(path.join(root, '.agents/skills/example'), { recursive: true });
    await writeFile(path.join(root, '.agents/skills/example/SKILL.md'), '---\nname: Example\ndescription: Test skill\n---\nDo the task.');
    let skills = await loadSkills(root);
    assert.equal(skills.get('example').description, 'Test skill');
    assert.match(skills.get('example').content, /Do the task/);
    await mkdir(path.join(root, '.zhuge/skills'), { recursive: true });
    await writeFile(path.join(outside, 'SKILL.md'), 'outside');
    await symlink(outside, path.join(root, '.zhuge/skills/escape'));
    skills = await loadSkills(root);
    assert.equal(skills.has('escape'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('Skill ZIP import preserves its files, appears in the list, and never overwrites another Skill', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zhuge-import-'));
  try {
    const archive = path.join(root, 'review.zip');
    const skill = strToU8('---\nname: Review\ndescription: Review files\n---\nInspect carefully.');
    await writeFile(archive, zipSync({ 'review/SKILL.md': skill, 'review/references/guide.md': strToU8('Guide text') }));
    const first = await installSkillZip(root, archive);
    const second = await installSkillZip(root, archive);
    assert.equal(first, 'review');
    assert.equal(second, 'review-2');
    assert.equal((await readFile(path.join(root, '.zhuge/skills/review/references/guide.md'), 'utf8')), 'Guide text');
    assert.equal((await loadSkills(root)).get('review-2').title, 'Review');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Skill ZIP import rejects paths outside the workspace and multiple Skill entrypoints', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zhuge-import-bad-'));
  try {
    const archive = path.join(root, 'bad.zip');
    await writeFile(archive, zipSync({ '../escape/SKILL.md': strToU8('outside') }));
    await assert.rejects(installSkillZip(root, archive), /越界路径/);
    await writeFile(archive, zipSync({ 'a/SKILL.md': strToU8('one'), 'b/SKILL.md': strToU8('two') }));
    await assert.rejects(installSkillZip(root, archive), /只能包含一个 SKILL.md/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('configured local MCP server lists and executes tools with separate approvals', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zhuge-mcp-'));
  const fixture = fileURLToPath(new URL('./fixture-mcp-server.js', import.meta.url));
  try {
    await mkdir(path.join(root, '.zhuge'));
    await writeFile(path.join(root, '.zhuge/mcp.json'), JSON.stringify({ servers: { test: { command: process.execPath, args: [fixture] } } }));
    const servers = await loadMcpServers(root);
    const approvals = [];
    const manager = new McpManager(root, servers, async (kind, detail) => { approvals.push({ kind, detail }); return true; });
    try {
      const tools = await manager.listTools('test');
      assert.equal(tools[0].name, 'echo');
      assert.equal((await manager.callTool('test', 'echo', { text: '你好' })), 'echo:你好');
      assert.deepEqual(approvals.map((item) => item.kind), ['mcp-start', 'mcp-call']);
      const controller = new AbortController();
      const pending = manager.callTool('test', 'slow', {}, controller.signal);
      setTimeout(() => controller.abort(), 50);
      await assert.rejects(pending);
      await assert.rejects(manager.listTools('test', controller.signal));
    } finally { await manager.close(); }
    const denied = new McpManager(root, servers, async () => false);
    await assert.rejects(denied.listTools('test'), /拒绝启动/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
