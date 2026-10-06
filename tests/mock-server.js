import { createServer } from 'node:http';

const port = Number(process.env.ZHUGE_MOCK_PORT || 17891);
const server = createServer(async (request, response) => {
  if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  const delay = Number(process.env.ZHUGE_MOCK_DELAY_MS || 0);
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  const review = body.messages.some((message) => message.role === 'system' && JSON.stringify(message.content).includes('你是梅花默认的需求检查智能体'));
  const memory = body.messages.some((message) => message.role === 'system' && JSON.stringify(message.content).includes('你只提取用户明确陈述'));
  const hasToolResult = body.messages.some((message) => message.role === 'tool');
  const write = JSON.stringify(body.messages).includes('创建测试');
  const exportPdf = JSON.stringify(body.messages).includes('导出PDF');
  const native = JSON.stringify(body.messages).includes('测试原生应用');
  const chunk = (delta, finishReason) => ({ id: 'zhuge-mock', object: 'chat.completion.chunk', created: 1, model: 'smoke-model', choices: [{ index: 0, delta, finish_reason: finishReason }] });
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  if (memory) {
    response.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: '[]' }, null))}\n\n`);
    response.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`);
  } else if (review) {
    const content = JSON.stringify({ ready: false, gaps: ['尚未说明希望查看哪些项目内容，结果可能过于宽泛。'], question: '要先查看整个项目的结构吗？', recommendation: '先查看顶层目录并总结主要模块。', suggestedPrompt: '先查看工作目录的顶层结构，概括主要模块和下一步。' });
    response.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content }, null))}\n\n`);
    response.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`);
  } else if (hasToolResult) {
    response.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: native ? '本机应用查找完成。' : exportPdf ? 'PDF 已生成。' : write ? '文件任务已完成。' : '目录读取已完成。' }, null))}\n\n`);
    response.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`);
  } else {
    const name = native ? 'list_installed_apps' : exportPdf ? 'export_office' : write ? 'write_file' : 'list_files';
    const args = native ? { query: 'Mail' } : exportPdf ? { source_path: 'report.md', target_path: 'report.pdf' } : write ? { path: 'result.txt', content: '验证成功\n' } : { path: '.' };
    response.write(`data: ${JSON.stringify(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'tool-1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, null))}\n\n`);
    response.write(`data: ${JSON.stringify(chunk({}, 'tool_calls'))}\n\n`);
  }
  response.end('data: [DONE]\n\n');
});
server.listen(port, '127.0.0.1', () => process.stdout.write(`Mock model on ${port}\n`));
