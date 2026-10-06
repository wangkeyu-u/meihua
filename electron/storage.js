import { readFile, readdir, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export async function saveJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temp, file);
  } finally { await rm(temp, { force: true }); }
}

export async function sessionSummaries(dir, onInvalid = () => {}) {
  await mkdir(dir, { recursive: true });
  const files = (await readdir(dir)).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name));
  const sessions = await Promise.all(files.map(async (name) => {
    try {
      const item = await readJson(path.join(dir, name), null);
      if (!item || `${item.id}.json` !== name || typeof item.title !== 'string' || typeof item.updatedAt !== 'string' || !Array.isArray(item.messages)) throw new Error('无效会话');
      return { id: item.id, title: item.title, updatedAt: item.updatedAt, workspace: item.workspace, pinned: Boolean(item.pinned), archived: Boolean(item.archived), searchText: item.messages.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => String(m.content || '')).join(' ' ).slice(0, 100000) };
    } catch (error) {
      if (!(error instanceof SyntaxError) && error.message !== '无效会话') throw error;
      onInvalid(name);
      return null;
    }
  }));
  return sessions.filter(Boolean).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
}
