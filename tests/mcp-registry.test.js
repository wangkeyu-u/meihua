import test from 'node:test';
import assert from 'node:assert/strict';
import { McpRegistry, registryEntry, registryTerms, configurationPlan } from '../electron/mcp-registry.js';
import { mcpEnvironment } from '../electron/mcp.js';

const remote = { name: 'io.github.example/search-tools', version: '1.2.3', description: 'Public search service', remotes: [{ type: 'streamable-http', url: 'https://example.com/mcp', headers: [{ name: 'Authorization', isSecret: true, value: 'Bearer {api_key}' }] }] };
const record = (server, status = 'active') => ({ server, _meta: { 'io.modelcontextprotocol.registry/official': { status } } });

test('MCP catalogue search translates common Chinese purposes and bounds keywords', () => {
  assert.deepEqual(registryTerms('帮我读取网页'), ['fetch', 'playwright']);
  assert.deepEqual(registryTerms('Notion'), ['notion']);
  assert.deepEqual(registryTerms('整理 Excel 表格'), ['excel', 'spreadsheet']);
  assert.throws(() => registryTerms(''), /请输入/);
  assert.throws(() => registryTerms('a'.repeat(121)), /120/);
});

test('registry remote plans require and protect declared header credentials without inventing URLs', () => {
  const plan = configurationPlan(remote, 'remote:0');
  assert.equal(plan.public.fields[0].secret, true);
  assert.equal(plan.public.fields[0].required, true);
  assert.throws(() => plan.resolve({}), /api_key/);
  assert.equal(plan.resolve({ 'header:0:api_key': 'private' }).headers.Authorization, 'Bearer private');
  assert.throws(() => plan.resolve({ other: 'injected' }), /输入无效/);
  assert.throws(() => plan.resolve({ 'header:0:api_key': 'a\r\nb' }), /换行/);
  assert.throws(() => configurationPlan({ ...remote, remotes: [{ type: 'streamable-http', url: 'https://example.com/{token}', variables: { token: { isSecret: true } } }] }, 'remote:0'), /认证放在网址/);
  assert.equal(registryEntry(record(remote, 'deprecated')), null);
  assert.equal(registryEntry(record({ ...remote, websiteUrl: 'javascript:alert(1)' })).websiteUrl, undefined);
});

test('registry package plans pin official package versions and resolve paths and flags as separate arguments', () => {
  const local = { name: 'io.github.example/filesystem', version: '1.0.0', packages: [{ registryType: 'npm', identifier: '@example/filesystem', version: '1.0.0', transport: { type: 'stdio' }, packageArguments: [{ type: 'positional', valueHint: '工作目录', isRequired: true, format: 'filepath' }, { type: 'named', name: '--mode', default: 'read-only', choices: ['read-only', 'full'] }], environmentVariables: [{ name: 'API_KEY', isSecret: true }] }] };
  const plan = configurationPlan(local, 'package:0', '/folder with spaces');
  const resolved = plan.resolve();
  assert.deepEqual(resolved.args, ['--yes', '--registry=https://registry.npmjs.org', '@example/filesystem@1.0.0', '/folder with spaces', '--mode', 'read-only']);
  assert.equal(resolved.command, 'npx');
  assert.deepEqual(resolved.env, {});
  assert.throws(() => plan.resolve({ 'arg:1': 'unsafe-option' }), /列表选择/);
  assert.equal(registryEntry(record({ ...local, packages: [{ ...local.packages[0], registryBaseUrl: 'https://unrelated.example' }] })).options.length, 0);
  assert.equal(registryEntry(record({ ...local, packages: [{ ...local.packages[0], version: 'latest' }] })).options.length, 0);
  assert.equal(configurationPlan({ ...local, packages: [{ registryType: 'pypi', identifier: 'example-server', version: '1.2.0', transport: { type: 'stdio' } }] }, 'package:0').resolve().command, 'uvx');
  assert.match(mcpEnvironment({}).PATH, /\/opt\/homebrew\/bin/);
  assert.equal(mcpEnvironment({ PATH: '/custom' }).PATH, '/custom');
});

test('catalogue client filters inactive entries, retains version provenance, and reports real failures', async () => {
  const calls = [];
  const registry = new McpRegistry(async (url, options) => { calls.push({ url: url.href, options }); return Response.json({ servers: [record(remote), record(remote, 'deleted'), record({ ...remote, name: 'io.github.example/old' }, 'deprecated')] }); });
  const found = await registry.search('网页');
  assert.equal(found.servers.length, 1);
  assert.equal(found.servers[0].name, remote.name);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.redirect, 'error');
  assert.ok(calls.every((item) => item.url.startsWith('https://registry.modelcontextprotocol.io/v0.1/servers?')));
  const plan = await registry.plan(remote.name, remote.version, 'remote:0');
  assert.equal(calls.length, 2, 'configuration uses the same searched version');
  assert.equal(plan.public.transport, 'http');
  const unavailable = new McpRegistry(async () => { throw new Error('unreachable'); });
  await assert.rejects(unavailable.search('网页'), /暂时连接不上/);
  const oversized = new McpRegistry(async () => new Response('too large', { headers: { 'content-length': '3000000' } }));
  await assert.rejects(oversized.plan(remote.name, remote.version, 'remote:0'), /响应过大/);
});

test('catalogue ignores malformed records and ranks exact purpose matches above incidental names', async () => {
  const relevant = { ...remote, name: 'io.github.example/fetch', title: 'Fetch', description: 'Retrieve web pages' };
  const incidental = { ...remote, name: 'io.github.example/fetch-payments', title: 'Payment service', description: 'Payments with fetch receipts' };
  const broken = { ...remote, name: 'io.github.example/broken', remotes: [null], packages: [{ registryType: 'pypi', registryBaseUrl: { invalid: true }, transport: { type: 'stdio' } }] };
  const registry = new McpRegistry(async () => Response.json({ servers: [record(incidental), record(broken), record(relevant), record({ ...remote, name: 'io.github.example/no-query', remotes: [{ type: 'streamable-http', url: 'https://example.com/mcp?key=value' }] })] }));
  const found = await registry.search('fetch');
  assert.equal(found.servers[0].name, relevant.name);
  assert.equal(found.servers.find((item) => item.name === broken.name).options.length, 0);
  assert.equal(found.servers.find((item) => item.name === 'io.github.example/no-query').options.length, 0);
});
