import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { readJson, saveJson } from '../storage.js';

export function normalizeVerificationConfig(draft) {
  if (!draft || !['auto', 'custom', 'files'].includes(draft.mode)) throw new Error('请选择自动检测、自定义命令或仅验证文件');
  if (!Array.isArray(draft.commands) || draft.commands.length > 8) throw new Error('最多配置 8 个验证命令');
  const commands = draft.commands.map((entry) => {
    if (!entry || typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 80 || entry.name.includes('\0') || typeof entry.command !== 'string' || !entry.command.trim() || entry.command.length > 500 || entry.command.includes('\0')) throw new Error('验证命令需要名称和可执行程序');
    if (!Array.isArray(entry.args) || entry.args.length > 50 || entry.args.some((arg) => typeof arg !== 'string' || arg.length > 2000 || arg.includes('\0'))) throw new Error('命令参数须为字符串，每项最多 2000 字符');
    const cwd = entry.cwd || '.';
    if (typeof cwd !== 'string' || cwd.length > 500 || cwd.includes('\0') || path.isAbsolute(cwd) || cwd.split(/[\\/]/).includes('..')) throw new Error('验证子目录必须在工作目录内');
    const timeoutSeconds = entry.timeoutSeconds ?? 120;
    if (![30, 120, 300].includes(timeoutSeconds)) throw new Error('验证超时只支持 30、120 或 300 秒');
    const expectedOutput = entry.expectedOutput || '', outputs = entry.outputs || [];
    if (typeof expectedOutput !== 'string' || expectedOutput.length > 2000) throw new Error('预期输出最多 2000 字符');
    if (!Array.isArray(outputs) || outputs.length > 20 || outputs.some((file) => typeof file !== 'string' || !file || file.length > 500 || file.includes('\0') || path.isAbsolute(file) || file.split(/[\\/]/).includes('..'))) throw new Error('预期文件须为工作目录内的相对路径，最多 20 个');
    return { id: entry.id && /^[a-f0-9-]{36}$/.test(entry.id) ? entry.id : randomUUID(), name: entry.name.trim(), command: entry.command.trim(), args: [...entry.args], cwd, timeoutSeconds, expectedOutput, outputs: [...outputs] };
  });
  if (draft.mode === 'custom' && !commands.length) throw new Error('自定义验证至少需要一个命令');
  return { schemaVersion: 1, mode: draft.mode, commands };
}
export class VerificationConfigStore {
  constructor(root) { this.root = root; }
  async identity(workspace) {
    const canonical = await realpath(workspace);
    return { workspace: canonical, file: path.join(this.root, 'verification', createHash('sha256').update(canonical).digest('hex') + '.json') };
  }
  async get(workspace) {
    const identity = await this.identity(workspace), saved = await readJson(identity.file, null);
    if (!saved) return { ...normalizeVerificationConfig({ mode: 'auto', commands: [] }), workspace: identity.workspace };
    if (saved.schemaVersion !== 1 || saved.workspace !== identity.workspace) throw new Error('项目验证配置版本或工作目录不一致，原文件保留');
    return { ...normalizeVerificationConfig(saved), workspace: identity.workspace, updatedAt: saved.updatedAt };
  }
  async save(workspace, draft) {
    const identity = await this.identity(workspace), config = { ...normalizeVerificationConfig(draft), workspace: identity.workspace, updatedAt: new Date().toISOString() };
    await saveJson(identity.file, config); return config;
  }
}
