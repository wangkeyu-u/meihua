import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { auth } from '@modelcontextprotocol/client';
import { readJson, saveJson } from './storage.js';
import path from 'node:path';

export function validateCallback(expectedState, url) {
  const state = url.searchParams.get('state') || '';
  if (!expectedState || state.length !== expectedState.length || !timingSafeEqual(Buffer.from(state), Buffer.from(expectedState))) throw new Error('OAuth 回调 state 不匹配');
  const code = url.searchParams.get('code'); if (!code || code.length > 8000 || url.searchParams.has('error')) throw new Error('OAuth 登录未授权');
  return { code, iss: url.searchParams.get('iss') || undefined };
}
export class McpOAuthStore {
  constructor(root, { encrypt, decrypt, openExternal, fetchFn = fetch }) { this.file = path.join(root, 'mcp-oauth.json'); Object.assign(this, { encrypt, decrypt, openExternal, fetchFn }); this.pending = Promise.resolve(); this.logins = new Set(); }
  key(url) { return createHash('sha256').update(new URL(url).href).digest('hex'); }
  async load(url) { const all = await readJson(this.file, {}), saved = all[this.key(url)]; return saved ? JSON.parse(this.decrypt(saved)) : { issuers: {} }; }
  save(url, value) { const operation = this.pending.catch(() => {}).then(async () => { const all = await readJson(this.file, {}); all[this.key(url)] = this.encrypt(JSON.stringify(value)); await saveJson(this.file, all); }); this.pending = operation; return operation; }
  async logout(url) { await this.pending; const all = await readJson(this.file, {}); delete all[this.key(url)]; await saveJson(this.file, all); }
  async provider(url, options = {}) {
    const saved = await this.load(url), store = this;
    if (options.interactive) delete saved.discovery;
    const state = randomBytes(32).toString('hex'); let verifier;
    const issuerKey = (ctx) => String(ctx?.issuer || saved.lastIssuer || 'default');
    const issuerEntry = (ctx) => saved.issuers[issuerKey(ctx)] ||= {};
    return {
      get redirectUrl() { return options.redirectUrl || saved.redirectUrl || 'http://127.0.0.1:1/callback'; },
      get clientMetadata() { return { client_name: '梅花', redirect_uris: [String(this.redirectUrl)], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', application_type: 'native' }; },
      state: () => state,
      clientInformation: (ctx) => issuerEntry(ctx).client,
      saveClientInformation: async (value, ctx) => { issuerEntry(ctx).client = value; saved.lastIssuer = issuerKey(ctx); saved.redirectUrl = String(options.redirectUrl || saved.redirectUrl || ''); await store.save(url, saved); },
      tokens: (ctx) => issuerEntry(ctx).tokens,
      saveTokens: async (value, ctx) => { issuerEntry(ctx).tokens = value; saved.lastIssuer = issuerKey(ctx); await store.save(url, saved); },
      redirectToAuthorization: async (address) => { if (!options.interactive) throw new Error('此 MCP 需要登录，请在扩展工具中点击“登录服务”'); options.signal?.throwIfAborted(); await store.openExternal(address.href); },
      saveCodeVerifier: (value) => { verifier = value; },
      codeVerifier: () => { if (!verifier) throw new Error('OAuth 登录会话已失效，请重新登录'); return verifier; },
      saveDiscoveryState: async (value) => { saved.discovery = value; await store.save(url, saved); },
      discoveryState: () => saved.discovery,
      invalidateCredentials: async (scope) => { if (scope === 'all') { saved.issuers = {}; delete saved.discovery; } else if (scope === 'tokens') delete issuerEntry().tokens; else if (scope === 'client') delete issuerEntry().client; else if (scope === 'discovery') delete saved.discovery; else verifier = undefined; await store.save(url, saved); },
    };
  }
  async safeFetch(input, options = {}) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('OAuth 端点须使用 HTTPS');
    if (url.username || url.password) throw new Error('OAuth 地址不能包含凭据');
    return this.fetchFn(input, { ...options, redirect: 'error', signal: AbortSignal.any([options.signal, AbortSignal.timeout(15000)].filter(Boolean)) });
  }
  async login(url, signal) {
    const key = this.key(url); if (this.logins.has(key)) throw new Error('这个服务正在登录'); this.logins.add(key);
    const server = createServer(); let timer, abort;
    try {
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      const redirectUrl = `http://127.0.0.1:${server.address().port}/callback`, provider = await this.provider(url, { interactive: true, redirectUrl, signal });
      const state = await provider.state();
      const callback = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('OAuth 登录超过 3 分钟，请重试')), 180000);
        abort = () => reject(signal.reason || new Error('登录已取消')); signal?.addEventListener('abort', abort, { once: true });
        server.on('request', (request, response) => {
          try {
            if (request.method !== 'GET' || request.headers.host !== `127.0.0.1:${server.address().port}`) throw new Error('回调地址无效');
            const incoming = new URL(request.url, redirectUrl); if (incoming.pathname !== '/callback') throw new Error('回调路径无效');
            const value = validateCallback(state, incoming); response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end('已收到授权，正在完成登录。可返回梅花。'); resolve(value);
          } catch { response.writeHead(400).end('Invalid OAuth callback'); }
        });
      }); callback.catch(() => {});
      signal?.throwIfAborted();
      const result = await auth(provider, { serverUrl: url, forceReauthorization: true, fetchFn: (input, options) => this.safeFetch(input, options) });
      if (result === 'AUTHORIZED') return true;
      const { code, iss } = await callback; signal?.throwIfAborted();
      const completed = await auth(provider, { serverUrl: url, authorizationCode: code, iss, fetchFn: (input, options) => this.safeFetch(input, options) });
      if (completed !== 'AUTHORIZED') throw new Error('OAuth 登录未完成'); return true;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); this.logins.delete(key); }
  }
}
