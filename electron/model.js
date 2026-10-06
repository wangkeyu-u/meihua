import { createModels, createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { providerById } from './providers.js';
import { effectiveCapabilities } from './model-capabilities.js';

export function createConfiguredModel(settings, apiKey, config = {}, fetcher) {
  if (!apiKey && settings.provider !== 'compatible') throw new Error('请先在设置中填写 API Key');
  if (!settings.model?.trim()) throw new Error('请先填写模型名称');
  const provider = providerById(settings.provider);
  const selectedApi = provider.api;
  const baseUrl = settings.baseUrl?.trim() || provider.baseUrl;
  let endpoint;
  try { endpoint = new URL(baseUrl); } catch { throw new Error('请填写有效的 API 地址'); }
  if (!['http:', 'https:'].includes(endpoint.protocol) || !endpoint.hostname || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('API 地址须为不含账号、查询参数和锚点的 HTTP(S) 地址');
  const models = createModels();
  const capabilities = effectiveCapabilities(settings, config.modelCapabilities);
  const model = {
    id: settings.model.trim(), name: settings.model.trim(),
    provider: 'zhuge', api: selectedApi,
    baseUrl, reasoning: capabilities.reasoning, input: capabilities.vision ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: capabilities.contextWindow, maxTokens: capabilities.maxTokens,
    ...(capabilities.compatibility ? { compat: capabilities.compatibility } : {}),
    ...(capabilities.thinkingLevelMap ? { thinkingLevelMap: capabilities.thinkingLevelMap } : {}),
    ...(capabilities.inputLimits ? { inputLimits: capabilities.inputLimits } : {}),
  };
  models.setProvider(createProvider({
    id: 'zhuge', name: 'Meihua configured provider', baseUrl,
    auth: { apiKey: { name: 'Meihua key', resolve: async () => ({ auth: {} }) } },
    models: [model],
    api: selectedApi === 'anthropic-messages' ? anthropicMessagesApi() : selectedApi === 'openai-responses' ? openAIResponsesApi() : openAICompletionsApi(),
  }));
  return {
    capabilities,
    model: models.getModel('zhuge', model.id),
    streamFn: (selected, context, options) => models.streamSimple(selected, context, { ...options, ...(fetcher ? { fetch: fetcher } : {}), apiKey: apiKey || 'local' }),
  };
}
