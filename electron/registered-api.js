import { redact } from './runtime/task-events.js';

export async function callRegisteredApi(config, name, { method = 'GET', query = {}, body = null, readOnly = false, signal, approve, headers = {} } = {}) {
  const entry = config.apiEndpoints.find((item) => item.name === name);
  if (!entry || !entry.methods.includes(method) || readOnly && method !== 'GET') throw new Error('当前角色或登记配置不允许这个 API 请求');
  if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).length > 30 || Object.values(query).some((value) => !['string', 'number', 'boolean'].includes(typeof value))) throw new Error('API 查询参数格式不正确');
  const url = new URL(entry.url); for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  const payload = body === null ? undefined : JSON.stringify(body); if (payload?.length > 100000) throw new Error('API 请求体过大');
  if (!await approve('api-call', { tool: name, url: url.origin + url.pathname, arguments: redact({ method, query, body }) })) throw new Error('用户拒绝 API 调用');
  signal?.throwIfAborted();
  const response = await fetch(url, { method, headers: { ...(payload ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(payload ? { body: payload } : {}), redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)].filter(Boolean)) });
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body || []) { bytes += chunk.byteLength; if (bytes > 1024 * 1024) { await response.body.cancel().catch(() => {}); throw new Error('API 返回超过 1 MB'); } chunks.push(chunk); }
  if (!response.ok) throw new Error(`API 返回失败：HTTP ${response.status}`);
  const text = Buffer.concat(chunks).toString('utf8'); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data, source: 'web', trusted: false };
}
