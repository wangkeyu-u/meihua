import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

serveStdio(() => {
  const server = new McpServer({ name: 'zhuge-test', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.registerTool('echo', { description: 'Echo supplied text', inputSchema: z.object({ text: z.string() }) }, async ({ text }) => ({ content: [{ type: 'text', text: `echo:${text}` }] }));
  server.registerTool('slow', { description: 'Wait for cancellation', inputSchema: z.object({}) }, async () => { await new Promise((resolve) => setTimeout(resolve, 10000)); return { content: [{ type: 'text', text: 'late' }] }; });
  return server;
});
