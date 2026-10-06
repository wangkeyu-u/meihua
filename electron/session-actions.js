import { randomUUID } from 'node:crypto';

export function updateSession(session, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('无效的任务设置');
  const next = { ...session };
  if (patch.title !== undefined) {
    if (typeof patch.title !== 'string' || !patch.title.trim() || patch.title.trim().length > 100) throw new Error('任务名称须为 1–100 个字符');
    next.title = patch.title.trim();
  }
  for (const key of ['pinned', 'archived']) {
    if (patch[key] !== undefined) {
      if (typeof patch[key] !== 'boolean') throw new Error('无效的任务设置');
      next[key] = patch[key];
    }
  }
  return next;
}

export function forkSession(session) {
  return { ...structuredClone(session), id: randomUUID(), title: `${session.title.slice(0, 90)} · 副本`, pinned: false, archived: false, updatedAt: new Date().toISOString() };
}

export function sessionMarkdown(session) {
  return `# ${session.title}\n\n工作目录：${session.workspace || '未设置'}\n\n` + session.messages.map((message) => {
    if (message.role === 'review') return `## 需求检查\n\n${message.recommendation}\n\n${message.suggestedPrompt}\n\n选择：${message.decision || '待决定'}`;
    if (message.role === 'tool') return `## 工具：${message.name}\n\n状态：${message.state}\n\n${message.output || ''}`;
    return `## ${message.role === 'user' ? '用户' : '梅花'}\n\n${message.content}${message.attachments?.length ? '\n\n附件：' + message.attachments.map((file) => file.name + (file.truncated ? '（节选）' : '')).join('、') : ''}`;
  }).join('\n\n---\n\n') + '\n';
}
