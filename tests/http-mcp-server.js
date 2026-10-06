import { createServer } from 'node:http';
import { once } from 'node:events';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { z } from 'zod';

export async function startHttpMcpServer() {
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'meihua-http-test', version: '1.0.0' });
    server.registerTool('echo', { description: 'Echo supplied text over HTTP', inputSchema: z.object({ text: z.string() }), annotations: { readOnlyHint: true } }, async ({ text }) => ({ content: [{ type: 'text', text: `http:${text}` }] }));
    return server;
  }, { responseMode: 'json' });
  const authorizations = [];
  const server = createServer(async (request, response) => {
    try {
      authorizations.push(request.headers.authorization);
      if (request.headers.authorization !== 'Bearer local-test-token') { response.writeHead(403); response.end('Forbidden'); return; }
      let raw = ''; for await (const chunk of request) raw += chunk;
      const headers = Object.fromEntries(Object.entries(request.headers).filter(([, value]) => typeof value === 'string'));
      const incoming = new Request(`http://127.0.0.1:${server.address().port}${request.url}`, { method: request.method, headers, ...(raw ? { body: raw } : {}) });
      const result = await handler.fetch(incoming);
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(await result.text());
    } catch (error) { response.writeHead(500); response.end(error.message); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, authorizations, close: async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } };
}
