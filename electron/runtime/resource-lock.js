const conflicts = (a, b) => {
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  if (a.workspace !== b.workspace || a.mode === 'read' && b.mode === 'read') return false;
  if (!a.paths || !b.paths) return true;
  return a.paths.some((left) => b.paths.some((right) => left === right || left.startsWith(right + '/') || right.startsWith(left + '/')));
};
// FIFO among conflicting resources; cancellation removes waiters immediately.
export class ResourceLock {
  constructor() { this.queue = []; this.active = new Set(); }
  run(key, work, signal) {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const item = { key, work, signal, resolve, reject };
      item.abort = () => { this.queue = this.queue.filter((entry) => entry !== item); reject(signal.reason || new Error('任务已停止')); this.drain(); };
      signal?.addEventListener('abort', item.abort, { once: true });
      this.queue.push(item); this.drain();
    });
  }
  drain() {
    for (const item of [...this.queue]) {
      const index = this.queue.indexOf(item);
      if ([...this.active].some((entry) => conflicts(item.key, entry.key)) || this.queue.slice(0, index).some((entry) => conflicts(item.key, entry.key))) continue;
      this.queue.splice(index, 1); item.signal?.removeEventListener('abort', item.abort);
      if (item.signal?.aborted) { item.reject(item.signal.reason || new Error('任务已停止')); continue; }
      this.active.add(item);
      Promise.resolve().then(() => { item.signal?.throwIfAborted(); return item.work(); }).then(item.resolve, item.reject).finally(() => { this.active.delete(item); this.drain(); });
    }
  }
}
