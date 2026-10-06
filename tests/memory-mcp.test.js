import test from 'node:test';
import assert from 'node:assert/strict';
import { saveMemory, retrieveMemories, memoryContext, normalizeMemoryExtraction } from '../electron/memory.js';
import { normalizeMcpServer, McpManager } from '../electron/mcp.js';
import { publicMcpServices, saveMcpService, resolveMcpServices } from '../electron/mcp-services.js';
import { startHttpMcpServer } from './http-mcp-server.js';

test('memories retain scope, deduplicate, retrieve relevant facts and exclude disabled notes', () => {
  let items = saveMemory([], { content: '报告先给结论', kind: 'preference', scope: 'global' }, '/project-a');
  items = saveMemory(items, { content: '项目使用 PostgreSQL 数据库', kind: 'fact', scope: 'workspace' }, '/project-a');
  items = saveMemory(items, { content: '客户使用 Oracle 数据库', kind: 'fact', scope: 'workspace' }, '/project-b');
  items = saveMemory(items, { content: '报告先给结论', kind: 'preference', scope: 'global' }, '/project-a');
  assert.equal(items.length, 3);
  assert.equal(retrieveMemories(items, '/project-a', '数据库迁移').length, 2);
  assert.ok(!memoryContext(retrieveMemories(items, '/project-a', '数据库')).includes('Oracle'));
  assert.equal(retrieveMemories(items, '/project-a', '做一张照片').length, 1);
  const fact = items.find((item) => item.kind === 'fact' && item.workspace === '/project-a');
  items = saveMemory(items, { ...fact, enabled: false }, '/project-a');
  assert.equal(retrieveMemories(items, '/project-a', '数据库').length, 1);
  const disabledItems = items;
  items = saveMemory(items, { content: fact.content, kind: fact.kind, scope: fact.scope, enabled: true }, '/project-a', { source: 'conversation', sessionId: 'new-session' });
  assert.equal(items, disabledItems, 'automatic extraction must not reactivate a disabled memory or replace its provenance');
  assert.throws(() => saveMemory(items, { content: 'x', kind: 'fact', scope: 'workspace' }, ''), /目录/);
});

test('automatic memories require exact user evidence and exclude secrets, guesses and opt-out prompts', () => {
  const prompt = '以后报告先写结论。我的密码是 secret-value。';
  const raw = JSON.stringify([{ kind: 'preference', evidence: '以后报告先写结论' }, { kind: 'fact', evidence: '用户喜欢蓝色' }, { kind: 'fact', evidence: '我的密码是 secret-value' }]);
  assert.deepEqual(normalizeMemoryExtraction(raw, prompt), [{ content: '以后报告先写结论', kind: 'preference', scope: 'workspace', enabled: true }]);
  assert.deepEqual(normalizeMemoryExtraction(raw, '不要记住。' + prompt), []);
});

test('MCP managed credentials are hidden, preserved on edit, cleared and cannot override project services', () => {
  const encrypt = (value) => ({ value: Buffer.from(value).toString('base64') });
  const decrypt = (secret) => Buffer.from(secret.value, 'base64').toString();
  let items = saveMcpService([], { name: 'remote', transport: 'http', url: 'https://example.com/mcp', token: 'private-token', enabled: true }, encrypt);
  assert.ok(!JSON.stringify(publicMcpServices(items)).includes('private-token'));
  const oldSecret = items[0].secret;
  items = saveMcpService(items, { name: 'remote', transport: 'http', url: 'https://example.com/mcp', enabled: false }, encrypt);
  assert.deepEqual(items[0].secret, oldSecret);
  assert.equal(resolveMcpServices(items, decrypt).remote.headers.Authorization, 'Bearer private-token');
  items = saveMcpService(items, { name: 'remote', transport: 'http', url: 'https://example.com/mcp', headers: { 'X-Workspace': 'team-a' } }, encrypt, decrypt);
  items = saveMcpService(items, { name: 'remote', transport: 'http', url: 'https://example.com/mcp', token: 'rotated-token' }, encrypt, decrypt);
  assert.deepEqual(resolveMcpServices(items, decrypt).remote.headers, { 'X-Workspace': 'team-a', Authorization: 'Bearer rotated-token' });
  assert.throws(() => resolveMcpServices(items, decrypt, { remote: {} }), /重复/);
  items = saveMcpService(items, { ...items[0], clearCredentials: true }, encrypt);
  assert.equal(items[0].secret, undefined);
  assert.throws(() => normalizeMcpServer('remote', { transport: 'http', url: 'http://example.com/mcp' }), /HTTPS/);
  assert.throws(() => normalizeMcpServer('remote', { transport: 'http', url: 'https://example.com/mcp?token=key' }), /认证/);
});

test('Streamable HTTP MCP lists and calls real SDK tools with bearer auth and separate approvals', async () => {
  const fixture = await startHttpMcpServer();
  const approvals = [];
  const manager = new McpManager(process.cwd(), { remote: normalizeMcpServer('remote', { transport: 'http', url: fixture.url, headers: { Authorization: 'Bearer local-test-token' } }) }, async (kind, detail) => { approvals.push({ kind, detail }); return true; });
  try {
    assert.equal((await manager.listTools('remote'))[0].name, 'echo');
    assert.equal(await manager.callTool('remote', 'echo', { text: '梅花' }), 'http:梅花');
    assert.deepEqual(approvals.map((item) => item.kind), ['mcp-start', 'mcp-call']);
    assert.ok(!JSON.stringify(approvals).includes('local-test-token'));
    assert.ok(fixture.authorizations.every((value) => value === 'Bearer local-test-token'));
  } finally { await manager.close(); await fixture.close(); }
});
