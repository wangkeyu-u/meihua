import { realpath, stat, lstat } from 'node:fs/promises';
import path from 'node:path';

export async function resolveWorkspacePath(workspace, requested, { forWrite = false } = {}) {
  if (!workspace || typeof requested !== 'string' || !requested.trim()) {
    throw new Error('请先选择工作目录，并提供文件路径');
  }
  const root = await realpath(workspace);
  const target = path.resolve(root, requested);
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('路径超出当前工作目录');
  }
  if (!forWrite) return checkInside(root, await realpath(target));
  try {
    return checkInside(root, await realpath(target));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const entry = await lstat(target).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (entry?.isSymbolicLink()) throw new Error('路径超出可写范围：目标是失效的符号链接');
    const parent = path.dirname(target);
    const parentStat = await stat(parent);
    if (!parentStat.isDirectory()) throw new Error('目标文件的父目录不存在');
    checkInside(root, await realpath(parent));
    return target;
  }
}

function checkInside(root, target) {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('路径超出当前工作目录');
  }
  return target;
}
