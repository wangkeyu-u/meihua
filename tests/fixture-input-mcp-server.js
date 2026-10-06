import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
serveStdio(() => {
  const server = new McpServer({ name: 'input-fixture', version: '1' });
  server.registerTool('choose', { inputSchema: z.object({ topic: z.string() }) }, async () => {
    const input = await server.server.elicitInput({ mode: 'form', message: '请选择报告份数', requestedSchema: { type: 'object', properties: { copies: { type: 'integer', minimum: 1, maximum: 5 } }, required: ['copies'] } });
    return { content: [{ type: 'text', text: JSON.stringify(input) }] };
  });
  return server;
});
