import { randomUUID } from 'node:crypto';

export function normalizeAgentDraft(draft, existing = []) {
  if (!draft || typeof draft !== 'object') throw new Error('智能体内容无效');
  const name = String(draft.name || '').trim();
  const prompt = String(draft.prompt || '').trim();
  const mode = draft.mode === 'read-only' ? 'read-only' : draft.mode === 'full' ? 'full' : null;
  const skills = Array.isArray(draft.skills) ? [...new Set(draft.skills)] : [];
  if (!name || name.length > 40) throw new Error('智能体名称需要 1 到 40 个字符');
  if (!prompt || prompt.length > 12000) throw new Error('提示词需要 1 到 12000 个字符');
  if (!mode) throw new Error('请选择智能体权限模式');
  if (skills.length > 8 || skills.some((skill) => typeof skill !== 'string' || !/^[\w.-]{1,80}$/.test(skill))) throw new Error('Skill 选择无效');
  const id = draft.id && existing.some((agent) => agent.id === draft.id) ? draft.id : randomUUID();
  if (existing.some((agent) => agent.id !== id && agent.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error('已有同名智能体');
  return { id, name, prompt, skills, mode };
}

export function applyAgent(baseTools, agent) {
  if (!agent || agent.mode === 'full') return baseTools;
  const readTools = new Set(['list_files', 'read_file', 'search_text', 'search_memory', 'search_mcp_servers', 'fetch_webpage', 'read_skill', 'list_installed_apps', 'find_contact', 'retrieve_knowledge', 'query_database']);
  return baseTools.filter((tool) => readTools.has(tool.name));
}

export function resolveAgentSelection(agents, agentId) {
  if (agentId === 'reviewer') return { reviewOnly: true, selectedAgent: null };
  const selectedAgent = agentId ? agents.find((item) => item.id === agentId) : null;
  if (agentId && !selectedAgent) throw new Error('所选智能体不存在');
  return { reviewOnly: false, selectedAgent };
}

export function resolveAgentSkills(agent, availableSkills) {
  if (!agent) return [];
  return (agent.skills || []).map((name) => {
    const skill = availableSkills.get(name);
    if (!skill) throw new Error(`智能体「${agent.name}」所需 Skill 不在当前工作目录：${name}。请导入该 Skill，或在“我的智能体”中取消勾选。`);
    return skill;
  });
}
