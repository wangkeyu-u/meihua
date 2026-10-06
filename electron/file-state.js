import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolveWorkspacePath } from './workspace.js';

export async function captureFile(workspace, requested, { allowMissing = false, maxBytes = 15 * 1024 * 1024 } = {}) {
  const file = await resolveWorkspacePath(workspace, requested, { forWrite: allowMissing });
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('目标不是文件');
    if (info.size > maxBytes) throw new Error('文件过大，请使用较小的文件');
    const hash = createHash('sha256').update(await readFile(file)).digest('hex');
    return { file, hash, ino: info.ino, dev: info.dev };
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return { file, hash: null };
    throw error;
  }
}

export async function assertFileUnchanged(workspace, requested, before, options) {
  const after = await captureFile(workspace, requested, options);
  if (after.file !== before.file || after.hash !== before.hash || after.ino !== before.ino || after.dev !== before.dev) {
    throw new Error('确认期间文件或路径已变化，请重新读取后再操作');
  }
  return after.file;
}
