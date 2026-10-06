import { readFile } from 'node:fs/promises';
import { Agent } from '@earendil-works/pi-agent-core';

const skillUrl = new URL('./builtin-skills/requirement-review/SKILL.md', import.meta.url);

export function normalizeReview(raw, originalPrompt) {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed;
  try { parsed = JSON.parse(cleaned); }
  catch { throw new Error('需求检查没有返回可用结果，请重试'); }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.ready !== 'boolean' || !Array.isArray(parsed.gaps) || parsed.gaps.some((gap) => typeof gap !== 'string') || typeof parsed.question !== 'string' || typeof parsed.recommendation !== 'string' || typeof parsed.suggestedPrompt !== 'string') {
    throw new Error('需求检查返回格式不完整，请重试');
  }
  const gaps = parsed.gaps.map((gap) => gap.trim().slice(0, 400)).filter(Boolean).slice(0, 3);
  if (!parsed.ready && !gaps.length) throw new Error('需求检查没有说明具体缺口，请重试');
  return {
    ready: parsed.ready,
    gaps: parsed.ready ? [] : gaps,
    question: parsed.question.trim().slice(0, 500) || '要按原需求开始吗？',
    recommendation: parsed.recommendation.trim().slice(0, 800) || '按原需求执行',
    suggestedPrompt: parsed.suggestedPrompt.trim().slice(0, 12000) || originalPrompt,
  };
}

export async function reviewRequirement(configuredModel, prompt, recentMessages = [], onAgent, savedMemoryContext = '') {
  const instructions = await readFile(skillUrl, 'utf8');
  const context = recentMessages.filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(-4).map((message) => `${message.role === 'user' ? '用户' : '梅花'}：${message.content.slice(0, 1000)}`).join('\n');
  const agent = new Agent({
    initialState: { systemPrompt: instructions + savedMemoryContext, model: { ...configuredModel.model, maxTokens: 1000 }, tools: [] },
    streamFn: configuredModel.streamFn,
  });
  onAgent?.(agent);
  await agent.prompt(`先前对话（只用于避免重复追问）：\n${context || '无'}\n\n本次原始需求：\n${prompt}`);
  if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
  const assistant = agent.state.messages.filter((message) => message.role === 'assistant').at(-1);
  if (assistant?.stopReason === 'aborted') throw new Error('需求检查已停止');
  const output = assistant?.content?.filter((block) => block.type === 'text').map((block) => block.text).join('') || '';
  if (!output) throw new Error('需求检查没有返回内容，请重试');
  return normalizeReview(output, prompt);
}
