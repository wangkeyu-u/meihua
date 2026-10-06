import { OPENAI_MODELS } from '@earendil-works/pi-ai/providers/openai.models';
import { ANTHROPIC_MODELS } from '@earendil-works/pi-ai/providers/anthropic.models';
import { DEEPSEEK_MODELS } from '@earendil-works/pi-ai/providers/deepseek.models';
import { MOONSHOTAI_CN_MODELS } from '@earendil-works/pi-ai/providers/moonshotai-cn.models';
import { ZAI_MODELS } from '@earendil-works/pi-ai/providers/zai.models';
import { providerById } from './providers.js';

const catalogs = { openai: OPENAI_MODELS, anthropic: ANTHROPIC_MODELS, deepseek: DEEPSEEK_MODELS, kimi: MOONSHOTAI_CN_MODELS, glm: ZAI_MODELS };
const canonical = (url) => new URL(url).href.replace(/\/$/, '');
export function capabilityKey(settings) { const provider = providerById(settings.provider), endpoint = settings.baseUrl?.trim() || provider.baseUrl; return `${provider.id}:${String(settings.model || '').trim()}@${endpoint ? canonical(endpoint) : ''}`; }
export function normalizeCapabilities(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('模型能力配置格式不正确');
  const result = {};
  for (const [key, min, max] of [['contextWindow', 4096, 2000000], ['maxTokens', 256, 128000]]) {
    if (raw[key] !== undefined) { if (!Number.isSafeInteger(raw[key]) || raw[key] < min || raw[key] > max) throw new Error(`模型 ${key} 超出范围`); result[key] = raw[key]; }
  }
  for (const key of ['reasoning', 'tools', 'vision']) if (raw[key] !== undefined) { if (typeof raw[key] !== 'boolean') throw new Error(`模型 ${key} 须为开关`); result[key] = raw[key]; }
  if (result.contextWindow && result.maxTokens && result.maxTokens > result.contextWindow / 2) throw new Error('模型输出上限超过上下文的一半');
  return result;
}
// Metadata is valid only for an exact model at its official endpoint. A gateway can
// reuse a name while exposing a different model; never inherit capabilities there.
export function effectiveCapabilities(settings, overrides = {}) {
  const provider = providerById(settings.provider), id = String(settings.model || '').trim();
  const baseUrl = settings.baseUrl?.trim() || provider.baseUrl;
  const official = provider.baseUrl && canonical(baseUrl) === canonical(provider.baseUrl);
  const candidate = official ? catalogs[provider.id]?.[id] : null;
  const known = candidate?.api === provider.api && candidate.baseUrl && canonical(candidate.baseUrl) === canonical(baseUrl) ? candidate : null;
  const manual = normalizeCapabilities(overrides[capabilityKey(settings)] || {});
  const base = { contextWindow: known?.contextWindow || 32768, maxTokens: known?.maxTokens || 4096, reasoning: known?.reasoning || false, vision: known?.input?.includes('image') || false, tools: true };
  return { ...base, ...manual, key: capabilityKey(settings), compatibility: known?.compat || (provider.api === 'openai-completions' ? { supportsDeveloperRole: false, supportsStore: false, maxTokensField: 'max_tokens' } : null), thinkingLevelMap: known?.thinkingLevelMap, inputLimits: known?.inputLimits, source: Object.keys(manual).length ? 'manual' : known ? 'sdk-catalog' : 'conservative-default', metadataKnown: Boolean(known), price: known?.cost || null };
}
export function workerSettings(settings, config = {}) {
  const provider = config.workerProvider && config.workerProvider !== 'same' ? config.workerProvider : settings.provider;
  const preset = providerById(provider);
  return { provider, model: config.workerModel?.trim() || preset.reviewModel || settings.model,
    baseUrl: config.workerBaseUrl?.trim() || (provider === settings.provider ? settings.baseUrl : settings.modelProfiles?.[provider]?.baseUrl) || '' };
}
