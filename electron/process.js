import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// Pipe sessions share the same process-group shutdown path as blocking commands.
// They are task scoped; an ID never reconnects to a process after app restart.
export function startProcess(command, args, { cwd, signal, timeoutMs = 120000, shell = false, maxOutput = 60000, env = process.env } = {}) {
  signal?.throwIfAborted();
  const grouped = process.platform !== 'win32', id = randomUUID();
  const child = spawn(command, args, { cwd, shell, env, detached: grouped, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', stdout = '', stderr = '', truncated = false, stopped = '', forceTimer, exit;
  const kill = (termination) => { try { if (grouped && child.pid) process.kill(-child.pid, termination); else child.kill(termination); } catch (error) { if (error.code !== 'ESRCH') child.kill(termination); } };
  const stop = (reason = '已停止') => { if (stopped || exit) return; stopped = reason; kill('SIGTERM'); forceTimer = setTimeout(() => kill('SIGKILL'), 300); };
  const abort = () => stop('已停止'), timer = setTimeout(() => stop('执行超时'), timeoutMs);
  const collect = (chunk, stream) => { const text = chunk.toString('utf8'), remaining = Math.max(0, maxOutput - output.length); output += text.slice(0, remaining); if (stream === 'stdout') stdout += text.slice(0, remaining); else stderr += text.slice(0, remaining); if (text.length > remaining) truncated = true; };
  const cleanup = () => { clearTimeout(timer); clearTimeout(forceTimer); if (stopped) kill('SIGKILL'); signal?.removeEventListener('abort', abort); };
  child.stdout.on('data', (chunk) => collect(chunk, 'stdout')); child.stderr.on('data', (chunk) => collect(chunk, 'stderr'));
  // EPIPE is reflected by write() and process completion, never an uncaught event.
  child.stdin.on('error', () => {});
  signal?.addEventListener('abort', abort, { once: true });
  const done = new Promise((resolve, reject) => {
    child.once('error', (error) => { exit = { status: 'failed', error: error.message }; cleanup(); reject(error); });
    child.once('close', (code, termination) => { exit = { status: stopped ? 'aborted' : 'completed', code, termination }; cleanup(); if (stopped) reject(new Error(stopped)); else resolve({ code, termination, stdout, stderr, truncated, output: output + (truncated ? '\n[输出已截断]' : '') }); });
  });
  done.catch(() => {}); if (signal?.aborted) abort();
  return { id, done, stop, poll: (offset = 0) => { if (!Number.isSafeInteger(offset) || offset < 0 || offset > output.length) throw new Error('命令输出游标无效'); return { id, status: exit?.status || 'running', exitCode: exit?.code ?? null, output: output.slice(offset), nextOffset: output.length, truncated, error: exit?.error || stopped || undefined }; },
    write: async (text, eof = false) => { if (exit || stopped || child.stdin.destroyed) throw new Error('命令已经结束或不接受输入'); if (typeof text !== 'string' || text.length > 8000) throw new Error('单次命令输入不能超过 8000 字符'); await new Promise((resolve, reject) => child.stdin.write(text, (error) => error ? reject(error) : resolve())); if (eof) child.stdin.end(); } };
}
export function runProcess(command, args, options) { const session = startProcess(command, args, options); session.write('', true).catch(() => {}); return session.done; }
export async function runCommand(command, cwd, signal, timeoutSeconds) {
  const { code, termination, output } = await runProcess(command, [], { cwd, signal, shell: true, timeoutMs: timeoutSeconds * 1000 });
  return `exit=${code ?? termination}\n${output}`;
}
