import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Agent } from '@earendil-works/pi-agent-core';
import { createConfiguredModel } from '../electron/model.js';
import { providers, modelProfiles, reviewSettings } from '../electron/providers.js';

test('official providers expose selectable models and route requirement review to a cheaper model', () => {
  for (const provider of providers.filter((item) => item.id !== 'compatible')) {
    assert.ok(provider.models.some((item) => item.id === provider.defaultModel));
    assert.ok(provider.models.some((item) => item.id === provider.reviewModel));
    const execution = createConfiguredModel({ provider: provider.id, model: provider.defaultModel }, 'test-key');
    assert.equal(execution.model.api, provider.api);
    assert.equal(execution.model.baseUrl, provider.baseUrl);
    const review = reviewSettings({ provider: provider.id, model: provider.defaultModel, reviewProvider: 'same' });
    assert.equal(review.provider, provider.id);
    assert.equal(review.model, provider.reviewModel);
  }
  assert.deepEqual(reviewSettings({ provider: 'deepseek', model: 'deepseek-v4-pro', reviewProvider: 'openai', reviewModel: 'gpt-6-luna' }), {
    provider: 'openai', model: 'gpt-6-luna', baseUrl: '',
  });
  assert.equal(reviewSettings({ provider: 'compatible', model: 'local-model', baseUrl: 'http://127.0.0.1:11434/v1' }).model, 'local-model');
});

test('provider profiles retain legacy custom models and an independent local reviewer', () => {
  const profiles = modelProfiles({
    provider: 'openai', model: 'my-openai-model', baseUrl: 'https://gateway.example/v1',
    reviewProvider: 'compatible', reviewModel: 'local-review', reviewBaseUrl: 'http://127.0.0.1:11434/v1',
    modelProfiles: { deepseek: { model: 'custom-deepseek', baseUrl: '', reviewModel: 'deepseek-flash', customModels: ['custom-deepseek'] } },
  });
  assert.equal(profiles.openai.model, 'my-openai-model');
  assert.equal(profiles.openai.baseUrl, 'https://gateway.example/v1');
  assert.ok(profiles.openai.customModels.includes('my-openai-model'));
  assert.equal(profiles.deepseek.model, 'custom-deepseek');
  assert.equal(profiles.compatible.reviewModel, 'local-review');
  assert.equal(profiles.compatible.baseUrl, 'http://127.0.0.1:11434/v1');
  assert.deepEqual(reviewSettings({ provider: 'openai', model: 'gpt-6-sol', reviewProvider: 'compatible', reviewModel: 'local-review', reviewBaseUrl: profiles.compatible.baseUrl }), {
    provider: 'compatible', model: 'local-review', baseUrl: 'http://127.0.0.1:11434/v1',
  });
});

test('configured OpenAI-compatible endpoint returns a real agent response', async () => {
  let requestBody;
  const server = createServer(async (request, response) => {
    requestBody = await new Promise((resolve) => {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => resolve(JSON.parse(body)));
    });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"id":"test","object":"chat.completion.chunk","created":1,"model":"mock-model","choices":[{"index":0,"delta":{"role":"assistant","content":"模型已连接"},"finish_reason":null}]}\n\n');
    response.write('data: {"id":"test","object":"chat.completion.chunk","created":1,"model":"mock-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
    response.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    const { model, streamFn } = createConfiguredModel({ provider: 'compatible', model: 'mock-model', baseUrl: `http://127.0.0.1:${address.port}/v1` }, 'test-key');
    const agent = new Agent({ initialState: { systemPrompt: 'Answer briefly.', model, tools: [] }, streamFn });
    await agent.prompt('你好');
    const assistant = agent.state.messages.filter((message) => message.role === 'assistant').at(-1);
    assert.equal(assistant.content[0].text, '模型已连接');
    assert.equal(requestBody.model, 'mock-model');
    assert.equal(requestBody.messages.at(-1).content[0].text, '你好');
  } finally { server.close(); }
});
