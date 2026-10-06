import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createConfiguredModel } from '../electron/model.js';
import { reviewSettings } from '../electron/providers.js';
import { normalizeReview, reviewRequirement } from '../electron/reviewer.js';

test('default reviewer uses the model to find one decision before task execution', async () => {
  let requestBody;
  let requestPath;
  const server = createServer(async (request, response) => {
    requestPath = request.url;
    let raw = '';
    for await (const chunk of request) raw += chunk;
    requestBody = JSON.parse(raw);
    const content = JSON.stringify({ ready: false, gaps: ['没有指定交付格式。'], question: '最终要什么文件？', recommendation: '先生成 Markdown。', suggestedPrompt: '整理材料，先生成 Markdown。' });
    const chunk = (delta, finishReason) => ({ id: 'review-test', object: 'chat.completion.chunk', created: 1, model: 'mock-model', choices: [{ index: 0, delta, finish_reason: finishReason }] });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content }, null))}\n\n`);
    response.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address();
    const selected = reviewSettings({ provider: 'openai', model: 'gpt-6-sol', reviewProvider: 'deepseek', reviewModel: 'deepseek-flash' });
    const model = createConfiguredModel({ ...selected, baseUrl: `http://127.0.0.1:${port}/v1` }, 'test-key');
    const review = await reviewRequirement(model, '整理材料');
    assert.equal(review.ready, false);
    assert.equal(review.question, '最终要什么文件？');
    assert.equal(review.suggestedPrompt, '整理材料，先生成 Markdown。');
    assert.equal(requestBody.messages.some((message) => message.role === 'system' && JSON.stringify(message.content).includes('需求检查')), true);
    assert.equal(requestBody.tools, undefined);
    assert.equal(requestBody.model, 'deepseek-flash');
    assert.equal(requestPath, '/v1/chat/completions');
  } finally { server.close(); }
});

test('unusable review blocks execution instead of silently skipping the check', () => {
  assert.throws(() => normalizeReview('done', '原需求'), /没有返回可用结果/);
  assert.throws(() => normalizeReview('{"ready":false,"gaps":[],"question":"?","recommendation":"a","suggestedPrompt":"b"}', '原需求'), /没有说明具体缺口/);
});
