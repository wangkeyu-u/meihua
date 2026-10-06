import { normalizeMcpServer } from './mcp.js';

export function publicMcpServices(items) {
  return items.map(({ name, transport, command, args, url, enabled, oauth, secret }) => ({ name, transport, command, args, url, enabled, ...(oauth ? { oauth: true } : {}), hasCredentials: Boolean(secret), source: 'app' }));
}

export function saveMcpService(items, draft, encrypt, decrypt) {
  const previous = items.find((item) => item.name === draft.name);
  if (!previous && items.length >= 20) throw new Error('最多添加 20 个 MCP 服务');
  const token = typeof draft.token === 'string' ? draft.token.trim() : '';
  const sameTransport = previous?.transport === draft.transport;
  const previousCredentials = sameTransport && previous.secret && !draft.clearCredentials && decrypt ? JSON.parse(decrypt(previous.secret)) : {};
  const suppliedHeaders = draft.headers === undefined ? previousCredentials : draft.headers;
  const suppliedEnv = draft.env === undefined ? previousCredentials : draft.env;
  const normalized = normalizeMcpServer(draft.name, { ...draft, env: suppliedEnv, headers: token ? { ...suppliedHeaders, Authorization: `Bearer ${token}` } : suppliedHeaders });
  const credentials = normalized.transport === 'http' ? normalized.headers : normalized.env;
  const supplied = Boolean(token || draft.headers !== undefined || draft.env !== undefined);
  const secret = supplied ? Object.keys(credentials).length ? encrypt(JSON.stringify(credentials)) : undefined : draft.clearCredentials ? undefined : sameTransport ? previous?.secret : undefined;
  const { env, headers, ...config } = normalized;
  return [...items.filter((item) => item.name !== draft.name), { name: draft.name, ...config, ...(secret ? { secret } : {}) }];
}

export function resolveMcpServices(items, decrypt, project = {}) {
  const result = { ...project };
  for (const item of items) {
    if (Object.hasOwn(result, item.name)) throw new Error(`MCP 服务标识重复：${item.name}，请在管理页面删除应用配置，并用另一个标识重新添加`);
    const credentials = item.secret ? JSON.parse(decrypt(item.secret)) : {};
    result[item.name] = normalizeMcpServer(item.name, { ...item, ...(item.transport === 'http' ? { headers: credentials } : { env: credentials }) });
  }
  return result;
}
