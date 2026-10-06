// Acquire synchronously, before any asynchronous task preparation starts.
export class TaskGate {
  constructor(externalBusy = () => false) { this.externalBusy = externalBusy; }
  controller;
  get busy() { return Boolean(this.controller) || Boolean(this.externalBusy()); }
  get signal() { return this.controller?.signal; }
  stop() { this.controller?.abort(new Error('任务已停止')); }
  async run(work) {
    if (this.busy) throw new Error('已有任务正在运行');
    const controller = new AbortController();
    this.controller = controller;
    try { return await work(controller.signal); }
    finally { this.controller = undefined; }
  }
}

export class ApprovalQueue {
  constructor(emit) { this.emit = emit; this.pending = new Map(); }
  request(id, kind, detail, signal) {
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const finish = (approved) => {
        if (!this.pending.delete(id)) return;
        signal?.removeEventListener('abort', abort);
        this.emit('approval-closed', { id });
        resolve(approved === true && !signal?.aborted);
      };
      const abort = () => finish(false);
      this.pending.set(id, finish);
      signal?.addEventListener('abort', abort, { once: true });
      this.emit('approval', { id, kind, detail });
    });
  }
  answer(id, approved) {
    const finish = this.pending.get(id);
    if (!finish) return false;
    finish(approved);
    return true;
  }
  cancel() { for (const finish of this.pending.values()) finish(false); }
}
