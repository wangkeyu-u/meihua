import { readJson, saveJson } from '../storage.js';
import path from 'node:path';
import { normalizeCapabilities } from '../model-capabilities.js';
import { providerById } from '../providers.js';

export const defaultAgentConfig = { schemaVersion: 1, maxWorkers: 3, maxCalls: 60, maxTokens: 600000, maxCost: null, modelTimeoutSeconds: 180, contextWindow: 64000, maxOutputTokens: 4096, prices: {}, workerProvider: 'same', workerModel: '', workerBaseUrl: '', modelCapabilities: {}, maxPlanRevisions: 2, sandbox: true, network: false, apiEndpoints: [], allowedOrigins: [] };
export function normalizeAgentConfig(draft = {}) {
  const value = { ...defaultAgentConfig, ...draft };
  if (value.schemaVersion !== 1) throw new Error('不支持这个 Agent 配置版本');
  for (const [key, min, max] of [['maxWorkers', 1, 8], ['maxCalls', 1, 500], ['maxTokens', 1000, 10000000], ['modelTimeoutSeconds', 30, 900], ['contextWindow', 8000, 1000000], ['maxOutputTokens', 256, 32000]]) if (!Number.isSafeInteger(value[key]) || value[key] < min || value[key] > max) throw new Error(`无效的 ${key} 配置`);
  if (value.maxOutputTokens > value.contextWindow / 2) throw new Error('单次输出上限须小于上下文窗口的一半');
  if (value.maxCost !== null && (!Number.isFinite(value.maxCost) || value.maxCost <= 0)) throw new Error('费用预算须为空或大于零（USD）');
  if (typeof value.sandbox !== 'boolean' || typeof value.network !== 'boolean') throw new Error('无效的隔离设置');
  if (!value.prices || typeof value.prices !== 'object' || Array.isArray(value.prices)) throw new Error('模型价格格式不正确');
  const prices = {};
  for (const [key, rate] of Object.entries(value.prices)) {
    if (key.length > 300 || !rate || ['input', 'output', 'cacheRead', 'cacheWrite'].some((name) => !Number.isFinite(rate[name]) || rate[name] < 0)) throw new Error('价格须填写每百万 Token 的输入、输出、缓存读取和缓存写入 USD 单价');
    prices[key] = { input: rate.input, output: rate.output, cacheRead: rate.cacheRead, cacheWrite: rate.cacheWrite };
  }
  if (value.workerProvider !== 'same') providerById(value.workerProvider);
  if (typeof value.workerModel !== 'string' || value.workerModel.length > 200 || typeof value.workerBaseUrl !== 'string' || value.workerBaseUrl.length > 2000) throw new Error('子代理模型配置不正确');
  if (value.workerBaseUrl) { const url = new URL(value.workerBaseUrl); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('子代理地址不正确'); }
  if (!Number.isSafeInteger(value.maxPlanRevisions) || value.maxPlanRevisions < 0 || value.maxPlanRevisions > 5) throw new Error('重新规划次数须为 0–5');
  if (!value.modelCapabilities || typeof value.modelCapabilities !== 'object' || Array.isArray(value.modelCapabilities) || Object.keys(value.modelCapabilities).length > 100) throw new Error('模型能力配置不正确');
  const modelCapabilities = Object.fromEntries(Object.entries(value.modelCapabilities).map(([key, entry]) => { if (key.length > 2500 || !key.includes(':') || !key.includes('@')) throw new Error('模型能力配置须绑定提供方、模型和 API 地址'); return [key, normalizeCapabilities(entry)]; }));
  if (!Array.isArray(value.allowedOrigins) || value.allowedOrigins.length > 20) throw new Error('最多登记 20 个浏览器来源');
  const validateUrl = (raw) => {
    const url = new URL(raw);
    if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new Error('只允许 HTTPS 或本机回环地址，认证不能写入网址');
    return url;
  };
  const allowedOrigins = value.allowedOrigins.map((raw) => { const url = validateUrl(raw); if (url.pathname !== '/' || url.search) throw new Error('浏览器来源须填写 origin，不含路径和查询参数'); return url.origin; });
  if (!Array.isArray(value.apiEndpoints) || value.apiEndpoints.length > 20) throw new Error('最多登记 20 个 API');
  const apiEndpoints = value.apiEndpoints.map((entry) => {
    if (!entry || !/^[a-zA-Z0-9_-]{1,50}$/.test(entry.name) || typeof entry.url !== 'string') throw new Error('API 需要唯一英文名称和地址');
    const url = validateUrl(entry.url); if (url.search) throw new Error('API 基础地址不含查询参数');
    const methods = entry.methods || ['GET']; if (!Array.isArray(methods) || !methods.length || methods.some((method) => !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method))) throw new Error('API 方法不正确');
    return { name: entry.name, url: url.href, methods: [...new Set(methods)] };
  });
  if (new Set(apiEndpoints.map((entry) => entry.name)).size !== apiEndpoints.length) throw new Error('API 名称重复');
  return { schemaVersion: 1, workerProvider: value.workerProvider, workerModel: value.workerModel.trim(), workerBaseUrl: value.workerBaseUrl.trim(), modelCapabilities, maxPlanRevisions: value.maxPlanRevisions, maxWorkers: value.maxWorkers, maxCalls: value.maxCalls, maxTokens: value.maxTokens, maxCost: value.maxCost, modelTimeoutSeconds: value.modelTimeoutSeconds, contextWindow: value.contextWindow, maxOutputTokens: value.maxOutputTokens, prices, sandbox: value.sandbox, network: value.network, apiEndpoints, allowedOrigins: [...new Set(allowedOrigins)] };
}
export class AgentConfigStore {
  constructor(root) { this.file = path.join(root, 'agent-config.json'); }
  async get() { return normalizeAgentConfig(await readJson(this.file, defaultAgentConfig)); }
  async save(draft) { const config = normalizeAgentConfig(draft); await saveJson(this.file, config); return config; }
}
