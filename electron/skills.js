import { createReadStream } from 'node:fs';
import { readFile, readdir, lstat, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Unzip, UnzipInflate } from 'fflate';
import { resolveWorkspacePath } from './workspace.js';

const MAX_ARCHIVE_BYTES = 15 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 25 * 1024 * 1024;
const MAX_ENTRY_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 250;

export async function loadSkills(workspace) {
  const skills = new Map();
  for (const directory of ['.agents/skills', '.zhuge/skills']) {
    let names;
    try {
      const folder = await resolveWorkspacePath(workspace, directory);
      names = await readdir(folder, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of names.slice(0, 100)) {
      if (!entry.isDirectory()) continue;
      let content;
      try {
        const file = await resolveWorkspacePath(workspace, path.join(directory, entry.name, 'SKILL.md'));
        content = (await readFile(file, 'utf8')).slice(0, 30000);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      const frontmatter = content.startsWith('---\n') ? content.split('---\n', 2)[1] : '';
      const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim() || entry.name;
      const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim() || content.replace(/^---[\s\S]*?---/, '').trim().slice(0, 160);
      skills.set(entry.name, { name: entry.name, title: name, description, content, path: path.join(directory, entry.name, 'SKILL.md') });
    }
  }
  return skills;
}

function validateEntryName(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) {
    throw new Error('ZIP 包含无效路径');
  }
  const parts = name.split('/');
  if (parts.some((part, index) => part === '.' || part === '..' || (!part && index < parts.length - 1))) {
    throw new Error('ZIP 包含越界路径');
  }
  return name;
}

async function readSkillArchive(archivePath) {
  const archive = await stat(archivePath);
  if (!archive.isFile() || archive.size > MAX_ARCHIVE_BYTES || archive.size === 0 || !/\.zip$/i.test(archivePath)) {
    throw new Error('请选择不超过 15 MB 的 Skill ZIP 文件');
  }
  const files = new Map();
  const seen = new Set();
  let unpacked = 0;
  let completed = 0;
  let failure;
  const unzip = new Unzip((file) => {
    try {
      const name = validateEntryName(file.name);
      if (name.endsWith('/') || name.startsWith('__MACOSX/') || name.endsWith('/.DS_Store') || name === '.DS_Store') return;
      if (seen.has(name)) throw new Error('ZIP 包含重复文件');
      seen.add(name);
      if (seen.size > MAX_FILES) throw new Error('Skill ZIP 文件数量超过 250 个');
      if (file.originalSize > MAX_ENTRY_BYTES) throw new Error('Skill ZIP 中有文件超过 10 MB');
      const chunks = [];
      let size = 0;
      file.ondata = (error, chunk, final) => {
        if (failure) return;
        if (error) { failure = error; return; }
        size += chunk.length;
        unpacked += chunk.length;
        if (size > MAX_ENTRY_BYTES || unpacked > MAX_UNPACKED_BYTES) {
          failure = new Error('Skill ZIP 解压后超过大小限制');
          return;
        }
        chunks.push(Buffer.from(chunk));
        if (final) { files.set(name, Buffer.concat(chunks)); completed += 1; }
      };
      file.start();
    } catch (error) { failure = error; }
  });
  unzip.register(UnzipInflate);
  try {
    let previous;
    for await (const chunk of createReadStream(archivePath, { highWaterMark: 64 * 1024 })) {
      if (previous) unzip.push(previous);
      if (failure) throw failure;
      previous = chunk;
    }
    if (!previous) throw new Error('ZIP 文件为空');
    unzip.push(previous, true);
    if (failure) throw failure;
    if (!files.size || completed !== seen.size) throw new Error('ZIP 文件不完整');
    return files;
  } catch (error) {
    throw new Error(`无法导入 Skill ZIP：${error.message}`);
  }
}

async function ensureDirectory(folder) {
  try {
    const info = await lstat(folder);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Skill 目录不能是符号链接');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(folder);
  }
}

function skillSlug(candidate) {
  const normalized = candidate.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_.-]/g, '').replace(/^[_.-]+|[_.-]+$/g, '').toLowerCase();
  return /^[a-z0-9][\w.-]{0,79}$/.test(normalized) ? normalized : `skill-${randomUUID().slice(0, 8)}`;
}

export async function installSkillZip(workspace, archivePath) {
  const root = await resolveWorkspacePath(workspace, '.');
  const files = await readSkillArchive(archivePath);
  const skillFiles = [...files.keys()].filter((name) => name === 'SKILL.md' || name.endsWith('/SKILL.md'));
  if (skillFiles.length !== 1) throw new Error('ZIP 中需要且只能包含一个 SKILL.md');
  const skillFile = skillFiles[0];
  const prefix = skillFile.slice(0, -'SKILL.md'.length);
  const instruction = new TextDecoder('utf-8', { fatal: true }).decode(files.get(skillFile));
  if (!instruction.trim() || instruction.length > 30000) throw new Error('SKILL.md 为空或超过 30000 个字符');
  if ([...files.keys()].some((name) => !name.startsWith(prefix))) throw new Error('ZIP 只能包含同一个 Skill 目录下的文件');

  const zhuge = path.join(root, '.zhuge');
  const skills = path.join(zhuge, 'skills');
  await ensureDirectory(zhuge);
  await ensureDirectory(skills);
  await resolveWorkspacePath(workspace, '.zhuge/skills');
  const preferred = skillSlug(prefix ? path.basename(prefix.slice(0, -1)) : path.basename(archivePath, path.extname(archivePath)));
  const existing = await loadSkills(workspace);
  let slug = preferred;
  let suffix = 2;
  while (existing.has(slug) || await lstat(path.join(skills, slug)).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error; })) {
    slug = `${preferred.slice(0, 70)}-${suffix++}`;
  }

  const staging = path.join(skills, `.import-${randomUUID()}`);
  await mkdir(staging);
  try {
    for (const [name, content] of files) {
      const relative = name.slice(prefix.length);
      const target = path.join(staging, ...relative.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, { flag: 'wx' });
    }
    await rename(staging, path.join(skills, slug));
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return slug;
}
