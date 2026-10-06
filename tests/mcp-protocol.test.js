import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { McpManager } from '../electron/mcp.js';
import { McpOAuthStore, validateCallback } from '../electron/mcp-oauth.js';

test('MCP resources/prompts are real SDK calls, remain untrusted and research denies non-read tools', async (t) => {
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'catalog', version: '1' });
    server.registerTool('read', { inputSchema: z.object({}), annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: 'text', text: 'actual data' }] }));
    server.registerTool('write', { inputSchema: z.object({}) }, async () => ({ content: [{ type: 'text', text: 'bad' }] }));
    server.registerResource('rates', 'data://rates', { mimeType: 'text/plain' }, async (uri) => ({ contents: [{ uri: uri.href, text: '收入240，成本90' }] }));
    server.registerPrompt('report', { argsSchema: z.object({ topic: z.string() }) }, async ({ topic }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `Summarize ${topic}` } }] }));
    return server;
  }, { responseMode: 'json' });
  const server = createServer(async (req, res) => { let body = ''; for await (const c of req) body += c; const response = await handler.fetch(new Request(`http://127.0.0.1:${server.address().port}${req.url}`, { method: req.method, headers: req.headers, ...(body ? { body } : {}) })); res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text()); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const approvals = [];
  const manager = new McpManager('/tmp', { data: { transport: 'http', url: `http://127.0.0.1:${server.address().port}/mcp` } }, async (kind, detail) => { approvals.push({ kind, detail }); return true; }, { readOnly: true });
  t.after(async () => { await manager.close(); server.closeAllConnections(); server.close(); });
  assert.equal(await manager.callTool('data', 'read', {}), 'actual data'); await assert.rejects(manager.callTool('data', 'write', {}), /只读/);
  assert.equal((await manager.catalog('data', 'resources'))[0].uri, 'data://rates'); assert.equal((await manager.readResource('data', 'data://rates'))[0].text, '收入240，成本90');
  const prompt = await manager.getPrompt('data', 'report', { topic: 'sales' }); assert.equal(prompt.trusted, false); assert.equal(prompt.messages[0].content, 'Summarize sales');
  await assert.rejects(manager.readResource('data', 'file:///outside'), /清单/); assert.ok(approvals.some((item) => item.detail.tool === 'resources/read'));
});
test('OAuth callback rejects wrong state and missing code', () => {
  assert.throws(() => validateCallback('expected', new URL('http://localhost/callback?state=wrong&code=x')), /state/); assert.throws(() => validateCallback('expected', new URL('http://localhost/callback?state=expected')), /未授权/);
});
test('OAuth performs real discovery, dynamic registration, state/PKCE exchange and durable issuer-bound storage', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'meihua-oauth-')); let base, challenge, exchanges = 0;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk; const url = new URL(req.url, base);
    const json = (value) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    if (url.pathname.includes('oauth-protected-resource')) return json({ resource: base + '/mcp', authorization_servers: [base], scopes_supported: ['read'] });
    if (url.pathname.includes('oauth-authorization-server') || url.pathname.includes('openid-configuration')) return json({ issuer: base, authorization_endpoint: base + '/authorize', token_endpoint: base + '/token', registration_endpoint: base + '/register', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'] });
    if (url.pathname === '/register') return json({ ...JSON.parse(body), client_id: 'meihua-public-client' });
    if (url.pathname === '/authorize') { challenge = url.searchParams.get('code_challenge'); const callback = new URL(url.searchParams.get('redirect_uri')); callback.searchParams.set('state', url.searchParams.get('state')); callback.searchParams.set('code', 'authorization-code'); callback.searchParams.set('iss', base); res.writeHead(302, { Location: callback.href }).end(); return; }
    if (url.pathname === '/token') { const params = new URLSearchParams(body); if (params.get('grant_type') === 'authorization_code') { assert.equal(createHash('sha256').update(params.get('code_verifier')).digest('base64url'), challenge); assert.equal(params.get('resource'), base + '/mcp'); } exchanges++; return json({ access_token: 'test-access-secret', refresh_token: 'test-refresh-secret', token_type: 'Bearer', expires_in: 3600 }); }
    res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` }).end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); server.close(); await rm(root, { recursive: true, force: true }); });
  const store = new McpOAuthStore(root, { encrypt: (value) => Buffer.from(value).toString('base64'), decrypt: (value) => Buffer.from(value, 'base64').toString(), openExternal: async (url) => { const response = await fetch(url); assert.equal(response.status, 200); } });
  assert.equal(await store.login(base + '/mcp', AbortSignal.timeout(10000)), true); assert.equal(exchanges, 1);
  const provider = await store.provider(base + '/mcp'); assert.equal((await provider.tokens()).access_token, 'test-access-secret'); assert.equal(provider.clientInformation({ issuer: 'https://different.example' }), undefined);
  assert.doesNotMatch(await readFile(path.join(root, 'mcp-oauth.json'), 'utf8'), /test-access-secret|test-refresh-secret/);
  await assert.rejects(provider.redirectToAuthorization(new URL(base + '/authorize')), /点击/); await store.logout(base + '/mcp'); assert.equal((await store.provider(base + '/mcp')).tokens(), undefined);
});

test('MCP validates server tool arguments before approval and completes a real elicitation round trip', async (t) => {
  const { UserInputQueue } = await import('../electron/user-input.js');
  let toolApprovals = 0, forms = 0;
  const queue = new UserInputQueue((type, data) => { if (type === 'input-request') { forms++; queue.answer(data.requestId, 'accept', { copies: 2 }); } });
  const manager = new McpManager('/tmp', { input: { transport: 'stdio', command: process.execPath, args: [path.resolve('tests/fixture-input-mcp-server.js')] } }, async (kind) => { if (kind === 'mcp-call') toolApprovals++; return true; }, { requestInput: (request, signal) => queue.request(request, signal) });
  t.after(() => manager.close());
  await assert.rejects(manager.callTool('input', 'choose', { topic: 42 }), /参数不符合/); assert.equal(toolApprovals, 0);
  const output = JSON.parse(await manager.callTool('input', 'choose', { topic: '报告' })); assert.equal(output.action, 'accept'); assert.equal(output.content.copies, 2); assert.equal(forms, 1); assert.equal(toolApprovals, 1);
});
