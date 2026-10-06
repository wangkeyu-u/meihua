import { normalizeMcpServer } from './mcp.js';

export const registryUrl = 'https://registry.modelcontextprotocol.io';
const aliases = [
  [/网页|网站|浏览器/, ['fetch', 'playwright']], [/搜索|检索/, ['search']],
  [/文件|目录|文件夹/, ['filesystem']], [/表格|Excel|电子表格/i, ['excel', 'spreadsheet']],
  [/文档|PDF|Word/i, ['document', 'pdf']], [/数据库/, ['postgres', 'sqlite']],
  [/笔记/, ['notion', 'obsidian']], [/邮件/, ['gmail', 'email']],
  [/日历|日程/, ['calendar']], [/网盘|云盘/, ['drive', 'dropbox']],
];

export function registryTerms(query) {
  if (typeof query !== 'string' || !query.trim() || query.length > 120) throw new Error('请输入 1–120 字的服务名称或用途');
  const text = query.trim();
  const english = text.match(/[a-z0-9][a-z0-9._/-]*/gi) || [];
  const mapped = aliases.filter(([pattern]) => pattern.test(text)).flatMap(([, words]) => words);
  return [...new Set([...mapped, ...english].map((word) => word.toLowerCase()))].slice(0, 3).concat(mapped.length || english.length ? [] : [text]);
}

const link = (value) => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined; }
  catch { return undefined; }
};

const configurableRemoteUrl = (value) => {
  try {
    const url = new URL(value.replace(/\{[a-z0-9_]+\}/gi, 'value'));
    return !url.username && !url.password && !url.search && !url.hash && (url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  } catch { return false; }
};

function optionsFor(server) {
  const options = [];
  for (const [index, remote] of (Array.isArray(server.remotes) ? server.remotes : []).entries()) {
    if (!remote || remote.type !== 'streamable-http' || typeof remote.url !== 'string' || /[?#]/.test(remote.url)) continue;
    if (!configurableRemoteUrl(remote.url) || !Array.isArray(remote.headers || []) || remote.variables && (typeof remote.variables !== 'object' || Array.isArray(remote.variables))) continue;
    options.push({ id: `remote:${index}`, label: '在线服务 · 无需安装本机程序', transport: 'http', remote });
  }
  for (const [index, pkg] of (Array.isArray(server.packages) ? server.packages : []).entries()) {
    if (!pkg || pkg.transport?.type !== 'stdio' || !Array.isArray(pkg.runtimeArguments || []) || (pkg.runtimeArguments || []).some((arg) => !arg || !['-y', '--yes'].includes(arg.value)) || !Array.isArray(pkg.packageArguments || []) || !Array.isArray(pkg.environmentVariables || [])) continue;
    const npm = pkg.registryType === 'npm' && (!pkg.registryBaseUrl || pkg.registryBaseUrl === 'https://registry.npmjs.org') && (!pkg.runtimeHint || pkg.runtimeHint === 'npx') && /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/i.test(pkg.identifier) && /^\d+\.\d+\.\d+(?:[-+][a-z0-9.+-]+)?$/i.test(pkg.version);
    const python = pkg.registryType === 'pypi' && (!pkg.registryBaseUrl || typeof pkg.registryBaseUrl === 'string' && pkg.registryBaseUrl.replace(/\/$/, '') === 'https://pypi.org') && (!pkg.runtimeHint || pkg.runtimeHint === 'uvx') && /^[a-z0-9][a-z0-9._-]*$/i.test(pkg.identifier) && /^[0-9][a-z0-9.+!-]*$/i.test(pkg.version);
    if (npm || python) options.push({ id: `package:${index}`, label: npm ? '本机程序 · 需要 Node.js' : '本机程序 · 需要 uv', transport: 'stdio', pkg });
  }
  return options;
}

export function registryEntry(record) {
  const server = record?.server;
  const status = record?._meta?.['io.modelcontextprotocol.registry/official']?.status;
  if (!server || typeof server.name !== 'string' || !/^[a-z0-9.-]+\/[a-z0-9._-]+$/i.test(server.name) || typeof server.version !== 'string' || status && status !== 'active') return null;
  return { name: server.name, title: String(server.title || server.name.split('/').at(-1)).slice(0, 100), description: String(server.description || '').slice(0, 800), version: server.version, websiteUrl: link(server.websiteUrl), repositoryUrl: link(server.repository?.url), options: optionsFor(server).map(({ id, label, transport }) => ({ id, label, transport })) };
}

// Resolve declared inputs, never guess executable commands or substitute user credentials.
export function configurationPlan(server, optionId, workspace = '') {
  const option = optionsFor(server).find((item) => item.id === optionId);
  if (!option) throw new Error('这个连接方式暂不支持自动配置，请查看服务说明或手动添加');
  const fields = [];
  function field(spec, id, label, required = false) {
    if (fields.length >= 40) throw new Error('此服务需要过多配置，请按服务说明手动添加');
    const definition = { id, label, description: String(spec.description || '').slice(0, 500), required: Boolean(required || spec.isRequired), secret: Boolean(spec.isSecret), defaultValue: spec.isSecret ? '' : String(spec.default || (/^(WORKSPACE_ROOT|WORKSPACE_PATH|ALLOWED_DIRECTORY)$/.test(label) || spec.format === 'filepath' && /dir|folder|workspace|目录|文件夹/i.test(label + ' ' + (spec.description || '')) ? workspace : '')), placeholder: String(spec.placeholder || '').slice(0, 200), choices: Array.isArray(spec.choices) ? spec.choices.filter((choice) => typeof choice === 'string').slice(0, 30) : undefined };
    fields.push(definition);
    return (values) => {
      const value = values[id] ?? definition.defaultValue;
      if (typeof value !== 'string' || value.length > 8000) throw new Error(`请检查 ${label} 的内容`);
      if (!value && definition.required) throw new Error(`请填写 ${label}`);
      if (value && definition.choices?.length && !definition.choices.includes(value)) throw new Error(`请从列表选择 ${label}`);
      return value || undefined;
    };
  }
  function input(spec, id, label, required = false) {
    if (typeof spec.value !== 'string') return field(spec, id, label, required);
    const placeholders = [...new Set([...spec.value.matchAll(/\{([a-z0-9_]+)\}/gi)].map((match) => match[1]))];
    const substitutions = placeholders.map((key) => [key, field({ ...spec.variables?.[key], isSecret: Boolean(spec.isSecret || spec.variables?.[key]?.isSecret || /key|token|secret|password/i.test(key)) }, `${id}:${key}`, key, true)]);
    return (values) => substitutions.reduce((text, [key, resolve]) => text.replaceAll(`{${key}}`, resolve(values)), spec.value);
  }
  function mapInputs(inputs, prefix) {
    if (!Array.isArray(inputs) || inputs.length > 30) throw new Error('服务配置字段格式无效');
    const resolvers = inputs.map((spec, index) => {
      if (!spec || typeof spec.name !== 'string' || !spec.name || spec.name.length > 100 || /[\r\n]/.test(spec.name)) throw new Error('服务配置字段名称无效');
      return [spec.name, input(spec, `${prefix}:${index}`, spec.name)];
    });
    return (values) => Object.fromEntries(resolvers.map(([key, resolve]) => [key, resolve(values)]).filter(([, value]) => value !== undefined));
  }
  let resolve, summary;
  if (option.remote) {
    const remote = option.remote;
    const variables = Object.fromEntries(Object.entries(remote.variables || {}).map(([key, spec]) => {
      if (spec.isSecret || /key|token|secret|password/i.test(key)) throw new Error('此服务将认证放在网址中，请按服务说明手动连接');
      return [key, field(spec, `url:${key}`, key, true)];
    }));
    if (typeof remote.url !== 'string') throw new Error('服务没有提供有效地址');
    const placeholders = [...remote.url.matchAll(/\{([a-z0-9_]+)\}/gi)].map((match) => match[1]);
    if (placeholders.some((key) => !variables[key])) throw new Error('服务地址包含未说明的参数，请查看服务说明');
    const headers = mapInputs(remote.headers || [], 'header');
    summary = remote.url;
    resolve = (values) => ({ transport: 'http', url: Object.entries(variables).reduce((url, [key, get]) => url.replaceAll(`{${key}}`, get(values)), remote.url), headers: headers(values) });
  } else {
    const pkg = option.pkg;
    const env = mapInputs(pkg.environmentVariables || [], 'env');
    const args = (pkg.packageArguments || []).map((spec, index) => {
      if (!['named', 'positional'].includes(spec.type) || spec.isRepeated) throw new Error('此服务参数需要手动配置，请查看说明');
      if (spec.type === 'named' && (typeof spec.name !== 'string' || !/^--?[a-z0-9_-]+$/i.test(spec.name))) throw new Error('服务参数名称无效');
      const get = input(spec, `arg:${index}`, spec.valueHint || spec.name || `参数 ${index + 1}`);
      return (values) => { const value = get(values); return value === undefined ? [] : spec.type === 'named' ? [spec.name, value] : [value]; };
    });
    const npm = pkg.registryType === 'npm';
    const command = npm ? 'npx' : 'uvx';
    const fixedArgs = npm ? ['--yes', '--registry=https://registry.npmjs.org', `${pkg.identifier}@${pkg.version}`] : ['--index-url', 'https://pypi.org/simple', `${pkg.identifier}==${pkg.version}`];
    summary = `${command} ${fixedArgs.join(' ')}（首次连接下载指定版本）`;
    resolve = (values) => ({ transport: 'stdio', command, args: [...fixedArgs, ...args.flatMap((get) => get(values))], env: env(values) });
  }
  return { public: { fields, summary, transport: option.transport, label: option.label, runtimeUrl: option.pkg ? option.pkg.registryType === 'npm' ? 'https://nodejs.org/en/download' : 'https://docs.astral.sh/uv/getting-started/installation/' : undefined }, resolve: (values = {}) => {
    if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).some((key) => !fields.some((item) => item.id === key))) throw new Error('服务配置输入无效，请重新选择服务');
    const draft = { name: serviceName(server.name), enabled: true, ...resolve(values) };
    normalizeMcpServer(draft.name, draft);
    return draft;
  } };
}

export function serviceName(name) { return name.split('/').at(-1).replace(/[^a-z0-9_-]/gi, '-').slice(0, 40) || 'service'; }

function relevance(entry, terms) {
  const name = entry.name.toLowerCase();
  const title = entry.title.toLowerCase();
  const description = entry.description.toLowerCase();
  const score = terms.reduce((total, term) => {
    const word = term.toLowerCase();
    const exact = new RegExp(`(^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');
    return total + (exact.test(title) ? 20 : title.includes(word) ? 8 : 0)
      + (exact.test(name) ? 12 : name.includes(word) ? 5 : 0)
      + (exact.test(description) ? 4 : description.includes(word) ? 1 : 0);
  }, 0);
  return score + (entry.options.length ? 3 : 0);
}

export class McpRegistry {
  constructor(fetcher = fetch) { this.fetcher = fetcher; this.cache = new Map(); }
  async request(route, signal) {
    const response = await this.fetcher(new URL(route, registryUrl), { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)].filter(Boolean)), redirect: 'error', headers: { Accept: 'application/json' } });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`目录请求失败：${response.status}`); }
    let size = 0; const chunks = [];
    if (Number(response.headers.get('content-length')) > 2 * 1024 * 1024) { await response.body?.cancel(); throw new Error('目录响应过大'); }
    for await (const chunk of response.body || []) { size += chunk.byteLength; if (size > 2 * 1024 * 1024) { throw new Error('目录响应过大'); } chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  remember(record) {
    let entry;
    try { entry = registryEntry(record); } catch { return null; }
    if (entry) {
      this.cache.set(`${entry.name}@${entry.version}`, { server: record.server, expires: Date.now() + 10 * 60 * 1000 });
      while (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value);
    }
    return entry;
  }
  async search(query, signal) {
    const terms = registryTerms(query);
    const batches = await Promise.allSettled(terms.map((term) => this.request(`/v0.1/servers?version=latest&limit=30&search=${encodeURIComponent(term)}`, signal)));
    signal?.throwIfAborted();
    const servers = new Map(); let unavailable = 0;
    for (const batch of batches) {
      if (batch.status !== 'fulfilled') { unavailable++; continue; }
      if (!Array.isArray(batch.value.servers)) throw new Error('目录返回格式无效');
      for (const record of batch.value.servers) { const entry = this.remember(record); if (entry) servers.set(entry.name, entry); }
    }
    if (unavailable === batches.length) throw new Error('暂时连接不上 MCP 目录，请稍后重试；也可以手动添加服务');
    const ranked = [...servers.values()].sort((a, b) => relevance(b, terms) - relevance(a, terms) || a.name.localeCompare(b.name));
    return { source: '官方 MCP Registry', query, terms, partial: unavailable > 0, servers: ranked.slice(0, 30) };
  }
  async plan(name, version, optionId, workspace, signal) {
    if (typeof name !== 'string' || !/^[a-z0-9.-]+\/[a-z0-9._-]+$/i.test(name) || name.length > 200 || typeof version !== 'string' || !version || version.length > 255) throw new Error('服务标识或版本无效');
    const key = `${name}@${version}`;
    let saved = this.cache.get(key);
    if (!saved || saved.expires < Date.now()) {
      const record = await this.request(`/v0.1/servers/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`, signal);
      const entry = this.remember(record);
      if (!entry || entry.name !== name || entry.version !== version) throw new Error('目录中的这个版本已经不可用，请重新搜索');
      saved = this.cache.get(key);
    }
    return configurationPlan(saved.server, optionId, workspace);
  }
}
