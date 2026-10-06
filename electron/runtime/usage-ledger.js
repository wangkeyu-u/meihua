import { randomUUID } from 'node:crypto';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { estimateTokens } from './context-manager.js';

const budgetError = (message) => Object.assign(new Error(message), { code: 'BUDGET_EXCEEDED' });
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason || new Error('模型请求已停止')); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}
export class UsageLedger {
  constructor({ config, manager, taskId, calls = [] }) {
    Object.assign(this, { config, manager, taskId }); this.calls = structuredClone(calls); this.pending = Promise.resolve();
    for (const call of this.calls) if (call.status === 'running') {
      Object.assign(call, { status: 'interrupted', totalTokens: call.reservedTokens, costUsd: null, usageSource: 'estimate', budgetSource: 'reservation' });
      if (Number.isFinite(call.reservedCost)) call.estimatedCostUsd = call.reservedCost;
      else delete call.estimatedCostUsd;
    }
  }
  persist() {
    const calls = structuredClone(this.calls);
    this.pending = this.pending.then(() => this.manager.mutate(this.taskId, (record) => { record.modelLedger = calls; }));
    return this.pending;
  }
  totals() {
    return this.calls.reduce((sum, call) => ({ calls: sum.calls + 1, tokens: sum.tokens + (call.status === 'running' ? call.reservedTokens : call.totalTokens || 0), cost: sum.cost + (call.status === 'running' ? call.reservedCost || 0 : call.costUsd ?? call.estimatedCostUsd ?? 0), unknownCost: sum.unknownCost || call.costUsd === null && call.estimatedCostUsd == null && call.status !== 'running' }), { calls: 0, tokens: 0, cost: 0, unknownCost: false });
  }
  reserve(model, context, stage, provider) {
    const inputEstimate = estimateTokens(context), outputReserve = Math.min(model.maxTokens || this.config.maxOutputTokens, this.config.maxOutputTokens), reservedTokens = inputEstimate + outputReserve;
    const totals = this.totals(), rate = this.config.prices[`${provider}:${model.id}`];
    const reservedCost = rate ? (inputEstimate * Math.max(rate.input, rate.cacheRead, rate.cacheWrite) + outputReserve * rate.output) / 1000000 : null;
    if (totals.calls >= this.config.maxCalls) throw budgetError('模型调用次数已达到任务预算');
    if (totals.tokens + reservedTokens > this.config.maxTokens) throw budgetError('剩余 Token 预算不足以启动这次模型调用');
    if (this.config.maxCost !== null && (!rate || totals.unknownCost)) throw budgetError('模型价格未配置，无法执行费用预算；请填写该模型价格或取消费用上限');
    if (this.config.maxCost !== null && totals.cost + reservedCost > this.config.maxCost) throw budgetError('剩余费用预算不足以启动这次模型调用');
    const call = { id: randomUUID(), provider, model: model.id, stage, startedAt: new Date().toISOString(), status: 'running', inputEstimate, reservedTokens, reservedCost, costUsd: null, usageSource: 'unavailable' };
    this.calls.push(call); return { call, rate };
  }
  async finish(call, message, rate) {
    if (call.status !== 'running') return;
    const usage = message?.usage || {}, fields = ['input', 'output', 'cacheRead', 'cacheWrite'];
    const reported = fields.some((key) => Number.isFinite(usage[key]) && usage[key] > 0);
    const counts = Object.fromEntries(fields.map((key) => [key, Number.isFinite(usage[key]) && usage[key] >= 0 ? usage[key] : 0]));
    const outputEstimate = estimateTokens(message?.content || ''), uncertain = !reported && ['error', 'aborted'].includes(message?.stopReason) && call.dispatched;
    Object.assign(call, { status: ['error', 'aborted'].includes(message?.stopReason) ? message.stopReason : 'completed', finishedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(call.startedAt), usageSource: reported ? 'provider' : 'estimate', ...(reported ? { usage: counts } : {}), totalTokens: reported ? fields.reduce((sum, key) => sum + counts[key], 0) : call.inputEstimate + outputEstimate,
      costUsd: reported && rate ? fields.reduce((sum, key) => sum + counts[key] * rate[key], 0) / 1000000 : null });
    if (uncertain) { call.totalTokens = call.reservedTokens; call.budgetSource = 'reservation'; }
    // A configured price plus estimated usage is displayed separately from a provider-backed charge.
    if (!reported && rate) call.estimatedCostUsd = uncertain ? call.reservedCost : (call.inputEstimate * rate.input + outputEstimate * rate.output) / 1000000;
    if (reported) await this.manager.diagnostics(this.taskId, { inputTokens: counts.input, outputTokens: counts.output, cacheReadTokens: counts.cacheRead, cacheWriteTokens: counts.cacheWrite });
    await this.persist();
  }
  track(configured, { stage = 'executor', provider = 'compatible' } = {}) {
    return { ...configured, model: { ...configured.model, maxTokens: Math.min(configured.model.maxTokens || this.config.maxOutputTokens, this.config.maxOutputTokens), contextWindow: Math.min(configured.model.contextWindow || this.config.contextWindow, this.config.contextWindow) }, streamFn: (model, context, options) => {
      const output = createAssistantMessageEventStream();
      void (async () => {
        let reserved, timer, iterator;
        const deadline = new AbortController(), signal = options?.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
        try {
          options?.signal?.throwIfAborted();
          reserved = this.reserve(model, context, stage, provider); await this.persist();
          await this.manager.diagnostics(this.taskId, { modelCalls: 1 });
          options?.signal?.throwIfAborted();
          timer = setTimeout(() => deadline.abort(Object.assign(new Error('模型请求超过时间上限，请检查服务连接或调整模型超时'), { code: 'MODEL_TIMEOUT' })), (this.config.modelTimeoutSeconds ?? 180) * 1000);
          reserved.call.dispatched = true;
          const stream = await abortable(configured.streamFn(model, context, { ...options, signal }), signal);
          iterator = stream[Symbol.asyncIterator]();
          while (true) {
            const next = await abortable(iterator.next(), signal); if (next.done) break;
            const event = next.value;
            if (event.type === 'done' || event.type === 'error') { clearTimeout(timer); await this.finish(reserved.call, event.type === 'done' ? event.message : event.error, reserved.rate); }
            output.push(event);
          }
          const final = await abortable(stream.result(), signal);
          await this.finish(reserved.call, final, reserved.rate);
          output.end(final);
        } catch (error) {
          const message = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, stopReason: options?.signal?.aborted ? 'aborted' : 'error', errorMessage: `${error.code || 'MODEL_FAILED'}：${error.message}`, timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          if (reserved) await this.finish(reserved.call, message, reserved.rate).catch(() => {});
          output.push({ type: 'error', reason: message.stopReason, error: message }); output.end(message);
        } finally { clearTimeout(timer); if (signal.aborted) void Promise.resolve().then(() => iterator?.return?.()).catch(() => {}); }
      })();
      return output;
    } };
  }
}
