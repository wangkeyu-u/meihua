import { startProcess } from '../process.js';
import { sandboxLaunch } from './sandbox.js';

export class ProcessSessions {
  constructor(owner) { this.owner = owner; this.sessions = new Map(); }
  get(id) { const session = this.sessions.get(id); if (!session) throw new Error('命令会话不存在，或属于其他任务'); return session; }
  async start(command, options, commit) {
    if ([...this.sessions.values()].filter((item) => item.poll().status === 'running').length >= 1) throw new Error('这个任务已有命令在运行，请先轮询完成或停止；命令会独占工作目录');
    const stepId = this.owner.stepId, taskId = this.owner.activeId;
    let launched, failed; const started = new Promise((resolve, reject) => { launched = resolve; failed = reject; });
    const holding = commit(async () => {
      const launch = options.sandbox ? await sandboxLaunch(command, [], options) : { command, args: [], cwd: options.cwd, env: process.env };
      const session = startProcess(launch.command, launch.args, { ...options, cwd: launch.cwd, env: launch.env, shell: !options.sandbox });
      this.sessions.set(session.id, session);
      session.settled = session.done.then((result) => ({ ...result, ok: result.code === 0, status: 'completed' }), (error) => ({ ok: false, status: 'aborted', error: error.message, code: null }));
      await this.owner.manager.mutate(taskId, (record) => { record.steps.find((step) => step.id === stepId).process = { id: session.id, status: 'running' }; });
      launched(session);
      const result = await session.settled;
      await this.owner.manager.mutate(taskId, (record) => { const step = record.steps.find((step) => step.id === stepId); step.process = { id: session.id, status: session.expectedStop ? 'stopped' : result.status, exitCode: result.code, error: result.error }; if (result.status === 'aborted' && !session.expectedStop) step.status = 'interrupted'; });
      session.recorded = true;
      return result;
    });
    holding.catch(failed); const session = await started; session.holding = holding; return session.poll();
  }
  async poll(id, offset = 0, waitMs = 0) {
    const session = this.get(id); if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 10000) throw new Error('等待时间须为 0–10000 毫秒');
    if (waitMs && session.poll().status === 'running') { let timer; await Promise.race([session.settled, new Promise((resolve) => { timer = setTimeout(resolve, waitMs); })]); clearTimeout(timer); }
    if (session.poll().status !== 'running') await session.holding;
    const result = session.poll(offset); return { ...result, ...(session.expectedStop && result.status === 'aborted' ? { status: 'stopped' } : {}) };
  }
  async stop(id) { const session = this.get(id); session.expectedStop = true; session.stop(); return this.poll(id, 0, 10000); }
  async close() { for (const session of this.sessions.values()) session.stop(); await Promise.allSettled([...this.sessions.values()].map((session) => session.holding)); this.sessions.clear(); }
}
