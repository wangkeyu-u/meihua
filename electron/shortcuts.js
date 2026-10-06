import { randomUUID } from 'node:crypto';

export const BUILTIN_SHORTCUTS = [
  { id: 'douyin', name: '抖音', url: 'https://www.douyin.com/', key: '1', builtin: true },
  { id: 'apple-music', name: 'Apple Music', url: 'https://music.apple.com/', key: '2', builtin: true },
  { id: 'spotify', name: 'Spotify', url: 'https://open.spotify.com/', key: '3', builtin: true },
];

export function normalizeShortcutDraft(draft, custom = []) {
  if (!draft || typeof draft !== 'object') throw new Error('跳转键内容无效');
  const name = String(draft.name || '').trim();
  const url = String(draft.url || '').trim();
  const key = String(draft.key || '').trim();
  if (!name || name.length > 30) throw new Error('名称需要 1 到 30 个字符');
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('请输入完整的 HTTPS 地址'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('跳转键只支持不含账号密码的 HTTPS 地址');
  if (!/^[4-9]$/.test(key)) throw new Error('自定义跳转键使用 4 到 9 的数字键');
  const id = custom.some((item) => item.id === draft.id) ? draft.id : randomUUID();
  if (custom.some((item) => item.id !== id && item.key === key)) throw new Error('这个快捷键已被使用');
  return { id, name, url: parsed.href, key, builtin: false };
}

export function allShortcuts(custom) {
  return [...BUILTIN_SHORTCUTS, ...custom].sort((a, b) => Number(a.key) - Number(b.key));
}
