import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAgent, normalizeAgentDraft, resolveAgentSelection, resolveAgentSkills } from '../electron/agents.js';

test('a custom reviewer keeps its prompt and Skills while gaining only read tools', () => {
  const agent = normalizeAgentDraft({ name: '检查员', prompt: '检查代码问题并给出证据。', skills: ['review'], mode: 'read-only' });
  const tools = ['list_files', 'read_file', 'write_file', 'run_command', 'call_mcp_tool'].map((name) => ({ name }));
  assert.deepEqual(applyAgent(tools, agent).map((tool) => tool.name), ['list_files', 'read_file']);
  assert.deepEqual(agent.skills, ['review']);
  assert.match(agent.prompt, /给出证据/);
  const revised = normalizeAgentDraft({ ...agent, prompt: '只检查安全问题。' }, [agent]);
  assert.equal(revised.id, agent.id);
  assert.throws(() => normalizeAgentDraft({ ...agent, id: undefined, name: '检查员' }, [agent]), /同名/);
});

test('built-in reviewer can be selected without starting an executor', () => {
  const agents = [{ id: 'custom-1', name: '检查员' }];
  assert.deepEqual(resolveAgentSelection(agents, 'reviewer'), { reviewOnly: true, selectedAgent: null });
  assert.deepEqual(resolveAgentSelection(agents, null), { reviewOnly: false, selectedAgent: null });
  assert.deepEqual(resolveAgentSelection(agents, 'custom-1'), { reviewOnly: false, selectedAgent: agents[0] });
  assert.throws(() => resolveAgentSelection(agents, 'missing'), /不存在/);
});

test('selected Skills are resolved in the current workspace before review', () => {
  const agent = { name: '检查员', skills: ['review'] };
  const skill = { name: 'review', path: '.zhuge/skills/review/SKILL.md' };
  assert.deepEqual(resolveAgentSkills(agent, new Map([['review', skill]])), [skill]);
  assert.throws(() => resolveAgentSkills(agent, new Map()), /当前工作目录.*review/);
  assert.deepEqual(resolveAgentSkills(null, new Map()), []);
});
