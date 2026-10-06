export const providers = [
  { id: 'openai', name: 'OpenAI', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys', defaultModel: 'gpt-6-sol', reviewModel: 'gpt-6-luna', models: [
    { id: 'gpt-6-astra', name: 'GPT-6 Astra · 复杂任务' },
    { id: 'gpt-6-sol', name: 'GPT-6 Sol · 日常执行' },
    { id: 'gpt-6-luna', name: 'GPT-6 Luna · 低成本检查' },
  ] },
  { id: 'deepseek', name: 'DeepSeek', api: 'openai-completions', baseUrl: 'https://api.deepseek.com', keyUrl: 'https://platform.deepseek.com/api_keys', defaultModel: 'deepseek-v4-pro', reviewModel: 'deepseek-flash', models: [
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro · 复杂任务' },
    { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash · 低成本检查' },
  ] },
  { id: 'glm', name: '智谱 GLM', api: 'openai-completions', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', keyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys', defaultModel: 'glm-5.3', reviewModel: 'glm-5.3-flash', models: [
    { id: 'glm-5.3', name: 'GLM-5.3 · 复杂任务' },
    { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash · 低成本检查' },
    { id: 'glm-4.7-flash', name: 'GLM-4.7-Flash · 免费文本模型' },
  ] },
  { id: 'kimi', name: 'Kimi', api: 'openai-completions', baseUrl: 'https://api.moonshot.cn/v1', keyUrl: 'https://platform.kimi.com/console/api-keys', defaultModel: 'kimi-k3', reviewModel: 'kimi-k2.6', models: [
    { id: 'kimi-k3', name: 'Kimi K3 · 复杂任务' },
    { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code · 编程' },
    { id: 'kimi-k2.6', name: 'Kimi K2.6 · 低成本检查' },
  ] },
  { id: 'anthropic', name: 'Anthropic', api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', keyUrl: 'https://console.anthropic.com/settings/keys', defaultModel: 'claude-sonnet-5', reviewModel: 'claude-haiku-4-5-20251001', models: [
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5 · 日常执行' },
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5 · 复杂任务' },
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5 · 低成本检查' },
  ] },
  { id: 'compatible', name: 'OpenAI 兼容接口 / 本地模型', api: 'openai-completions', baseUrl: '', keyUrl: '', defaultModel: '', reviewModel: '', models: [] },
];

export function providerById(id) {
  const provider = providers.find((item) => item.id === id);
  if (!provider) throw new Error('无效的模型提供方');
  return provider;
}

export function modelProfiles(settings) {
  const profiles = { ...(settings.modelProfiles || {}) };
  const preset = providerById(settings.provider);
  const previous = profiles[settings.provider] || {};
  const sameReviewer = !settings.reviewProvider || settings.reviewProvider === 'same' || settings.reviewProvider === settings.provider;
  const customModels = [...new Set([...(previous.customModels || []), settings.model, sameReviewer ? settings.reviewModel : '']
    .map((item) => String(item || '').trim()).filter((item) => item && !preset.models.some((model) => model.id === item)))].slice(-20);
  profiles[settings.provider] = {
    model: settings.model || previous.model || preset.defaultModel,
    baseUrl: settings.baseUrl || '',
    reviewModel: sameReviewer ? settings.reviewModel || preset.reviewModel || settings.model : previous.reviewModel || preset.reviewModel,
    customModels,
  };
  if (!sameReviewer) {
    const reviewPreset = providerById(settings.reviewProvider);
    const saved = profiles[settings.reviewProvider] || {};
    const reviewModel = String(settings.reviewModel || '').trim();
    profiles[settings.reviewProvider] = {
      model: saved.model || reviewPreset.defaultModel,
      baseUrl: settings.reviewBaseUrl === undefined ? saved.baseUrl || '' : settings.reviewBaseUrl,
      reviewModel: reviewModel || saved.reviewModel || reviewPreset.reviewModel,
      customModels: [...new Set([...(saved.customModels || []), reviewModel].filter((item) => item && !reviewPreset.models.some((model) => model.id === item)))].slice(-20),
    };
  }
  return profiles;
}

export function reviewSettings(settings) {
  const provider = settings.reviewProvider && settings.reviewProvider !== 'same' ? settings.reviewProvider : settings.provider;
  const preset = providerById(provider);
  return {
    provider,
    model: settings.reviewModel?.trim() || preset.reviewModel || settings.model,
    baseUrl: provider === settings.provider ? settings.baseUrl : settings.reviewBaseUrl || '',
  };
}
