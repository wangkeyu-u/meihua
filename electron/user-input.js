import { randomUUID } from 'node:crypto';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';

const validator = new AjvJsonSchemaValidator();
export function validateInputSchema(schema) {
  if (!schema || schema.type !== 'object' || !schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties) || Object.keys(schema.properties).length > 12) throw new Error('填写表单须为最多 12 项的简单字段');
  for (const [name, field] of Object.entries(schema.properties)) {
    if (name.length > 100 || /password|secret|api.?key|token|credential/i.test(name + ' ' + (field.title || '')) || !['string', 'number', 'integer', 'boolean'].includes(field.type) || field.enum && (!Array.isArray(field.enum) || field.enum.length > 50)) throw new Error('此表单包含不支持的字段或敏感凭据，请使用服务的登录配置');
  }
  if (JSON.stringify(schema).length > 16000) throw new Error('填写表单过大');
  return structuredClone(schema);
}
export class UserInputQueue {
  constructor(emit) { this.emit = emit; this.pending = new Map(); }
  request({ server, message, schema, sessionId, taskId }, signal) {
    signal?.throwIfAborted(); schema = validateInputSchema(schema);
    if (this.pending.size >= 20) throw new Error('待填写请求过多');
    return new Promise((resolve) => {
      const id = randomUUID(), finish = (result) => { if (!this.pending.delete(id)) return; clearTimeout(timer); signal?.removeEventListener('abort', abort); this.emit('input-request-closed', { requestId: id }); resolve(result); };
      const abort = () => finish({ action: 'cancel' });
      const timer = setTimeout(abort, 300000);
      this.pending.set(id, { schema, finish, signal }); signal?.addEventListener('abort', abort, { once: true });
      this.emit('input-request', { requestId: id, server, message: String(message || '').slice(0, 4000), schema, sessionId, taskId });
      if (signal?.aborted) abort();
    });
  }
  answer(id, action, content) {
    const item = this.pending.get(id); if (!item || item.signal?.aborted) return false;
    if (!['accept', 'decline', 'cancel'].includes(action)) throw new Error('无效填写结果');
    if (action === 'accept') {
      if (!content || typeof content !== 'object' || Array.isArray(content) || JSON.stringify(content).length > 20000 || Object.keys(content).some((name) => !Object.hasOwn(item.schema.properties, name))) throw new Error('填写内容格式不正确');
      const checked = validator.getValidator(item.schema)(content);
      if (!checked.valid) throw new Error(checked.errorMessage || '请检查必填项和字段格式');
    }
    item.finish({ action, ...(action === 'accept' ? { content } : {}) }); return true;
  }
  cancelAll() { for (const item of [...this.pending.values()]) item.finish({ action: 'cancel' }); }
}
