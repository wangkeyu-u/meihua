import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { captureFile, assertFileUnchanged } from '../file-state.js';
import { resolveWorkspacePath } from '../workspace.js';
import { runProcess } from '../process.js';

export class VerificationEngine {
  constructor({ checkpoints, approve, parseDocument, runner = runProcess, config = { mode: 'auto', commands: [] } }) { Object.assign(this, { checkpoints, approve, parseDocument, runner, config }); }
  async runCheck(entry, record, signal, scriptSnapshot = null, script = '') {
    const cwd = await resolveWorkspacePath(record.workspace, entry.cwd || '.'), directory = await stat(cwd);
    if (!directory.isDirectory()) throw new Error('验证子目录不是文件夹');
    const command = [entry.command, ...entry.args.map((arg) => JSON.stringify(arg))].join(' ');
    const detail = { command, workspace: cwd, verification: true, script: script || undefined, expectedOutput: entry.expectedOutput || undefined, outputs: entry.outputs || [] };
    if (!await this.approve('command', detail)) return { name: entry.name, ok: false, error: '用户拒绝验证命令；任务未验证完成', retryable: false };
    signal?.throwIfAborted();
    const latestCwd = await resolveWorkspacePath(record.workspace, entry.cwd || '.'), latestDirectory = await stat(latestCwd);
    if (latestCwd !== cwd || latestDirectory.ino !== directory.ino || latestDirectory.dev !== directory.dev) return { name: entry.name, ok: false, error: '确认期间验证目录已变化，未执行命令', retryable: false };
    if (scriptSnapshot) {
      try { await assertFileUnchanged(record.workspace, 'package.json', scriptSnapshot); }
      catch (error) { return { name: entry.name, ok: false, error: error.message, retryable: false }; }
    }
    const result = await this.runner(entry.command, entry.args, { cwd, signal, timeoutMs: (entry.timeoutSeconds || 120) * 1000, maxOutput: 30000 });
    const stdout = result.stdout ?? result.output ?? '', stderr = result.stderr || '', matched = !entry.expectedOutput || (result.output ?? `${stdout}\n${stderr}`).includes(entry.expectedOutput);
    const check = { name: entry.name, ok: result.code === 0 && matched, exitCode: result.code, stdout, stderr, expectedOutputMatched: matched, summary: result.code !== 0 ? '验证命令失败' : matched ? '通过' : '未找到声明的预期输出', retryable: true, outputFiles: [] };
    if (check.ok) for (const requested of entry.outputs || []) {
      try {
        const output = await captureFile(record.workspace, requested);
        if (/\.json$/i.test(requested)) JSON.parse(await readFile(output.file, 'utf8'));
        else if (/\.(docx|xlsx|pptx|pdf|odt|ods)$/i.test(requested)) await this.parseDocument(output.file);
        check.outputFiles.push({ path: requested, hash: output.hash });
      } catch (error) { check.ok = false; check.error = `预期文件 ${requested}：${error.message}`; break; }
    }
    return check;
  }
  async verify(record, signal) {
    signal?.throwIfAborted();
    const checks = [], allRecords = await this.checkpoints.list(record.id), records = allRecords.filter((item) => item.status === 'applied');
    for (const pending of allRecords.filter((item) => item.status === 'prepared')) checks.push({ name: `checkpoint:${pending.path}`, ok: false, error: '修改在记录结果前被中断，无法确认实际副作用；原始备份保留，请检查文件后新建任务', retryable: false, changedFiles: [pending.path] });
    const latest = new Map(records.map((item) => [item.path, item]));
    for (const [requested, checkpoint] of latest) {
      try {
        const current = await captureFile(record.workspace, requested, { allowMissing: true });
        if (current.hash !== checkpoint.after.hash) throw new Error('写入结果与 checkpoint 的摘要不一致');
        if (current.hash !== null) {
          if (/\.json$/i.test(requested)) JSON.parse(await readFile(current.file, 'utf8'));
          else if (/\.(docx|xlsx|pptx|pdf|odt|ods)$/i.test(requested)) await this.parseDocument(current.file);
        }
        checks.push({ name: `file:${requested}`, ok: true, summary: current.hash === null ? '删除结果已核对' : '存在、内容摘要和支持的格式已核对', changedFiles: [requested] });
      } catch (error) { checks.push({ name: `file:${requested}`, ok: false, error: error.message, retryable: true, changedFiles: [requested] }); }
    }
    for (const step of record.steps.filter((item) => item.process)) checks.push({ name: `process:${step.process.id}`, ok: step.process.status === 'stopped' || step.process.status === 'completed' && step.process.exitCode === 0, exitCode: step.process.exitCode, error: step.process.status === 'running' ? '命令仍在运行，请轮询至结束' : step.process.error, retryable: step.process.status === 'running' });
    const latestTools = new Map(record.steps.filter((step) => step.result && step.metadata.sideEffect).map((step) => [step.operationKey || `${step.tool}:${step.inputSummary}`, step]));
    for (const step of latestTools.values()) {
      if (!step.result.ok) checks.push({ name: `tool:${step.tool}`, ok: false, error: step.result.error?.message || step.result.summary, retryable: step.result.retryable });
      else if (step.tool === 'run_command') checks.push({ name: `command:${step.inputSummary}`, ok: step.result.exitCode === 0 && step.result.expectedOutputMatched !== false, exitCode: step.result.exitCode, stdout: step.result.stdout, stderr: step.result.stderr, summary: '已核对命令退出码及声明的输出条件', retryable: false });
    }
    for (const step of record.steps.filter((item) => item.status === 'interrupted' && item.metadata.sideEffect && !['write_file', 'edit_file', 'export_office'].includes(item.tool))) checks.push({ name: `interrupted:${step.tool}`, ok: false, error: '外部操作在执行期间中断，结果不明确；需要人工核对，不能自动重放', retryable: false });
    const localChanges = latest.size > 0 || record.steps.some((step) => ['run_command', 'start_command'].includes(step.tool));
    let entries = [], scriptSnapshot, project;
    if (localChanges && !['plan', 'ask'].includes(record.mode) && this.config.mode === 'custom') entries = this.config.commands;
    // Project scripts can execute arbitrary code, so automatic verification uses the same human approval gate.
    if ([...latest.keys()].some((file) => /\.(?:[cm]?js|jsx|ts|tsx|json|css|html)$/i.test(file)) && !['plan', 'ask'].includes(record.mode) && this.config.mode === 'auto' && record.allowCommands) {
      try { scriptSnapshot = await captureFile(record.workspace, 'package.json'); project = JSON.parse(await readFile(scriptSnapshot.file, 'utf8')); await assertFileUnchanged(record.workspace, 'package.json', scriptSnapshot); }
      catch (error) { project = undefined; if (error.code !== 'ENOENT') checks.push({ name: 'package.json', ok: false, error: error.message, retryable: true }); }
      entries = ['test', 'build', 'lint', 'typecheck'].filter((name) => typeof project?.scripts?.[name] === 'string').map((name) => ({ name: name === 'test' ? 'npm test' : `npm run ${name}`, command: 'npm', args: name === 'test' ? ['test'] : ['run', name], cwd: '.', timeoutSeconds: 120, scriptName: name }));
    }
    if (record.steps.some((step) => step.process?.status === 'running')) entries = [];
    if (entries.length && !record.allowCommands) checks.push({ name: 'verification-permission', ok: false, error: '当前只读权限不允许运行配置的验证命令，任务未验证完成', retryable: false });
    else for (const entry of entries) {
      try { checks.push(await this.runCheck(entry, record, signal, entry.scriptName ? scriptSnapshot : null, project?.scripts?.[entry.scriptName])); }
      catch (error) { signal?.throwIfAborted(); checks.push({ name: entry.name, ok: false, error: error.message, retryable: !/路径超出|已变化/.test(error.message) }); }
    }
    return { ok: checks.every((check) => check.ok), checks, changedFiles: [...latest.keys()], scope: this.config.mode, warnings: localChanges && this.config.mode === 'files' ? ['按用户配置只核对文件与已执行命令的结果，没有运行项目测试。'] : [], retryable: checks.filter((check) => !check.ok).every((check) => check.retryable !== false), summary: checks.length ? `${checks.filter((check) => check.ok).length}/${checks.length} 项验证通过` : '本轮没有文件变更或命令结果需要验证；模型回复不代表外部操作已完成' };
  }
}
export async function verificationLoop({ verify, repair, onAttempt = async () => {}, maxAttempts = 3, signal }) {
  let result;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    signal?.throwIfAborted(); await onAttempt(attempt, 'started');
    result = await verify(attempt); await onAttempt(attempt, 'completed', result);
    if (result.ok || result.retryable === false) return { ...result, attempts: attempt };
    if (attempt < maxAttempts) { signal?.throwIfAborted(); await repair(result, attempt); }
  }
  return { ...result, ok: false, attempts: maxAttempts, summary: `验证在 ${maxAttempts} 次检查后仍未通过；${result.summary}` };
}
