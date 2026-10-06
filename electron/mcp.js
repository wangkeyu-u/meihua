import { readFile } from 'node:fs/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import { validateInputSchema } from './user-input.js';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { resolveWorkspacePath } from './workspace.js';
import path from 'node:path';
import os from 'node:os';

export function mcpEnvironment(env = {}) {
  return { ...process.env, ...env, PATH: env.PATH || [...new Set([...(process.env.PATH || '').split(path.delimiter), path.join(os.homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean))].join(path.delimiter) };
}

export async function loadMcpServers(workspace) {
  let file;
  try { file = await resolveWorkspacePath(workspace, '.zhuge/mcp.json'); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  const config = JSON.parse(await readFile(file, 'utf8'));
  if (!config || typeof config !== 'object' || !config.servers || typeof config.servers !== 'object' || Array.isArray(config.servers)) {
    throw new Error('.zhuge/mcp.json 需要包含 servers 对象');
  }
  const servers = Object.create(null);
  if (Object.keys(config.servers).length > 20) throw new Error('每个工作目录最多配置 20 个 MCP 服务');
  for (const [name, item] of Object.entries(config.servers)) servers[name] = normalizeMcpServer(name, item);
  return servers;
}

export function normalizeMcpServer(name, item) {
  if (!/^[a-zA-Z0-9_-]{1,50}$/.test(name) || !item || typeof item !== 'object') throw new Error('服务标识只能使用 1–50 个英文字母、数字、下划线或连字符');
  if (item.enabled !== undefined && typeof item.enabled !== 'boolean') throw new Error('无效的 MCP 开关');
  const transport = item.transport || (item.url ? 'http' : 'stdio');
  if (!['stdio', 'http'].includes(transport)) throw new Error('MCP 支持本地 stdio 或远程 Streamable HTTP');
  const stringMap = (value) => {
    if (!value) return {};
    if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 30 || Object.entries(value).some(([key, text]) => !key || typeof text !== 'string' || key.length > 100 || text.length > 8000 || /[\r\n]/.test(key))) throw new Error('MCP 环境变量或请求头格式无效');
    return { ...value };
  };
  if (transport === 'stdio') {
    if (typeof item.command !== 'string' || !item.command.trim() || item.command.length > 1000 || !Array.isArray(item.args) || item.args.length > 50 || item.args.some((arg) => typeof arg !== 'string' || arg.length > 2000)) throw new Error(`本地 MCP 命令或参数无效：${name}`);
    return { transport, command: item.command.trim(), args: [...item.args], env: stringMap(item.env), enabled: item.enabled !== false };
  }
  let url;
  try { url = new URL(item.url); } catch { throw new Error('请填写有效的 MCP 服务地址'); }
  if (url.username || url.password || url.hash || url.search || !['http:', 'https:'].includes(url.protocol) || (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('远程 MCP 须使用 HTTPS；本机服务可使用 HTTP，认证请填写令牌');
  const headers = stringMap(item.headers);
  if (Object.values(headers).some((value) => /[\r\n]/.test(value))) throw new Error('MCP 请求头不能包含换行');
  if (item.oauth !== undefined && typeof item.oauth !== 'boolean') throw new Error('无效的 OAuth 开关');
  return { transport, url: url.href, headers, ...(item.oauth ? { oauth: true } : {}), enabled: item.enabled !== false };
}

export class McpManager {
  constructor(workspace, servers, approve, { readOnly = false, authProvider = null, sandboxCommand = null, requestInput = null, fetcher = null } = {}) {
    this.workspace = workspace;
    this.servers = servers;
    this.approve = approve;
    this.connections = new Map();
    Object.assign(this, { readOnly, authProvider, sandboxCommand, requestInput, fetcher }); this.connecting = new Map(); this.validator = new AjvJsonSchemaValidator();
  }

  names() { return Object.keys(this.servers).filter((name) => this.servers[name].enabled !== false); }

  connection(name, signal) {
    signal?.throwIfAborted();
    if (this.connections.has(name)) return Promise.resolve(this.connections.get(name));
    if (this.connecting.has(name)) return this.connecting.get(name);
    const pending = this.connect(name, signal).finally(() => this.connecting.delete(name));
    this.connecting.set(name, pending); return pending;
  }
  async connect(name, signal) {
    signal?.throwIfAborted();
    if (!Object.hasOwn(this.servers, name)) throw new Error(`未配置 MCP 服务器：${name}`);
    if (this.connections.has(name)) return this.connections.get(name);
    const options = this.servers[name];
    if (options.enabled === false) throw new Error('这个 MCP 服务已停用');
    if (!await this.approve('mcp-start', { server: name, command: options.command, args: options.args, url: options.url })) throw new Error('用户拒绝启动 MCP 服务器');
    const client = new Client({ name: 'meihua-agent', version: '0.1.0' }, { capabilities: this.requestInput ? { elicitation: { form: {} } } : {} });
    if (this.requestInput) client.setRequestHandler('elicitation/create', async (request, context) => {
      if (request.params.mode && request.params.mode !== 'form') return { action: 'decline' };
      const schema = validateInputSchema(request.params.requestedSchema);
      return this.requestInput({ server: name, message: request.params.message, schema }, context.signal && signal ? AbortSignal.any([context.signal, signal]) : context.signal || signal);
    });
    const launch = options.transport === 'stdio' && this.sandboxCommand ? await this.sandboxCommand(options) : options;
    const transport = options.transport === 'http'
      ? new StreamableHTTPClientTransport(new URL(options.url), { requestInit: { headers: options.headers, redirect: 'error' }, ...(this.fetcher ? { fetch: this.fetcher } : {}), ...(options.oauth && this.authProvider ? { authProvider: await this.authProvider(name, options) } : {}) })
      : new StdioClientTransport({ command: launch.command, args: launch.args, cwd: this.workspace, env: this.sandboxCommand ? launch.env : mcpEnvironment(options.env) });
    try {
      const connectSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
      connectSignal.throwIfAborted();
      const connect = () => client.connect(transport, { signal: connectSignal });
      await (this.executeEffect && options.transport === 'stdio' && !this.readOnly ? this.executeEffect(connect) : connect());
      const tools = [];
      let cursor;
      for (let page = 0; client.getServerCapabilities()?.tools && page < 10; page++) {
        const batch = await client.listTools(cursor ? { cursor } : undefined, { signal: connectSignal });
        tools.push(...batch.tools);
        cursor = batch.nextCursor;
        if (!cursor) break;
      }
      const connection = { client, tools };
      this.connections.set(name, connection);
      return connection;
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  }

  async listTools(name, signal) {
    const connection = await this.connection(name, signal);
    if (connection.client.getServerCapabilities()?.tools) {
      const tools = []; let cursor;
      for (let page = 0; page < 10; page++) { const batch = await connection.client.listTools(cursor ? { cursor } : undefined, { signal }); tools.push(...batch.tools); cursor = batch.nextCursor; if (!cursor) break; }
      connection.tools = tools;
    }
    return connection.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations }));
  }

  async callTool(server, name, args, signal) {
    const connection = await this.connection(server, signal);
    await this.listTools(server, signal);
    if (!connection.tools.some((tool) => tool.name === name)) throw new Error(`MCP 工具不存在：${name}`);
    if (this.readOnly && !connection.tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint) throw new Error('研究角色只允许服务明确标注为只读的 MCP 工具');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('MCP 工具参数需要是对象');
    const tool = connection.tools.find((item) => item.name === name);
    const validated = this.validator.getValidator(tool.inputSchema)(args);
    if (!validated.valid) throw new Error('MCP 参数不符合服务声明：' + validated.errorMessage);
    if (!await this.approve('mcp-call', { server, tool: name, arguments: args, readOnly: tool.annotations?.readOnlyHint === true })) throw new Error('用户拒绝调用 MCP 工具');
    signal?.throwIfAborted();
    const call = () => connection.client.callTool({ name, arguments: args }, { signal });
    const response = await (this.executeEffect && tool.annotations?.readOnlyHint !== true ? this.executeEffect(call) : call());
    const content = response.content.map((block) => block.type === 'text' ? block.text : `[${block.type} 内容]`).join('\n');
    if (response.isError) throw new Error(content || 'MCP 工具调用失败');
    return (content || JSON.stringify(response.structuredContent || {})).slice(0, 50000);
  }

  async catalog(server, kind, signal) {
    const { client } = await this.connection(server, signal), capability = kind === 'resources' ? 'resources' : 'prompts';
    if (!client.getServerCapabilities()?.[capability]) return [];
    const items = []; let cursor;
    for (let page = 0; page < 10; page++) { const response = await (kind === 'resources' ? client.listResources(cursor ? { cursor } : undefined, { signal }) : client.listPrompts(cursor ? { cursor } : undefined, { signal })); items.push(...response[kind]); cursor = response.nextCursor; if (!cursor) break; }
    return items;
  }
  async readResource(server, uri, signal) {
    const listed = await this.catalog(server, 'resources', signal);
    if (!listed.some((resource) => resource.uri === uri)) throw new Error('资源须先从该服务的资源清单选择');
    if (!await this.approve('mcp-call', { server, tool: 'resources/read', arguments: { uri } })) throw new Error('用户拒绝读取 MCP 资源');
    const { client } = await this.connection(server, signal), response = await client.readResource({ uri }, { signal });
    return response.contents.map((item) => ({ uri: item.uri, mimeType: item.mimeType, text: typeof item.text === 'string' ? item.text.slice(0, 30000) : '[二进制资源，未自动执行或解析]' }));
  }
  async getPrompt(server, name, args, signal) {
    const listed = await this.catalog(server, 'prompts', signal);
    if (!listed.some((prompt) => prompt.name === name)) throw new Error('提示模板须先从该服务清单选择');
    if (!await this.approve('mcp-call', { server, tool: 'prompts/get', arguments: { name, ...args } })) throw new Error('用户拒绝读取 MCP 提示模板');
    const { client } = await this.connection(server, signal), response = await client.getPrompt({ name, arguments: args }, { signal });
    return { description: response.description, messages: response.messages.map((message) => ({ role: message.role, content: message.content.type === 'text' ? message.content.text.slice(0, 30000) : '[非文本内容]' })), trusted: false };
  }

  async close() {
    await Promise.allSettled([...this.connecting.values()]);
    await Promise.allSettled([...this.connections.values()].map(({ client }) => client.close()));
    this.connections.clear();
  }
}
