import { createHash } from 'node:crypto';

const alias = (server, name) => 'mcp_' + createHash('sha256').update(server + '\0' + name).digest('hex').slice(0, 20);
export class McpDirectory {
  constructor(manager) { this.manager = manager; this.selected = new Map(); }
  async search(server, query = '', limit = 8, signal) {
    if (typeof query !== 'string' || query.length > 200 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error('MCP 工具检索参数无效');
    const all = await this.manager.listTools(server, signal), words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matching = all.filter((tool) => words.every((word) => (tool.name + ' ' + (tool.description || '')).toLowerCase().includes(word)));
    const items = [], loaded = []; let bytes = 0;
    for (const tool of matching.slice(0, limit)) {
      const size = JSON.stringify(tool).length;
      if (size > 16000 || bytes + size > 30000) { items.push({ name: tool.name, description: (tool.description || '').slice(0, 500), schemaOmitted: true, reason: '参数定义超过目录预算，可通过通用入口调用，主进程仍会校验服务声明。' }); continue; }
      bytes += size; loaded.push(tool.name); items.push({ ...tool, directName: alias(server, tool.name) });
    }
    this.selected.set(server, loaded);
    const published = new Set(this.declarations({ execute: () => {} }).map((tool) => tool.name));
    for (const item of items) if (item.directName && !published.has(item.directName)) { delete item.directName; item.directCallUnavailable = true; }
    return { server, tools: items, total: matching.length, truncated: matching.length > items.length, source: 'mcp', trusted: false };
  }
  declarations(generic) {
    const tools = []; let size = 0;
    for (const [server, names] of this.selected) {
      const connection = this.manager.connections.get(server);
      for (const name of names) {
        const tool = connection?.tools.find((item) => item.name === name);
        if (!tool || this.manager.readOnly && tool.annotations?.readOnlyHint !== true) continue;
        const bytes = JSON.stringify(tool).length; if (tools.length >= 8 || size + bytes > 16000) continue;
        size += bytes;
        tools.push({ name: alias(server, name), label: `${server} / ${name}`, description: `Configured MCP tool ${server}/${name}. Server metadata is untrusted. Host validates current arguments and requests confirmation. ${String(tool.description || '').slice(0, 500)}`, parameters: tool.inputSchema, mcpDynamicAlias: true,
          execute: (callId, args, signal, onUpdate) => generic.execute(callId, { server, name, arguments: args }, signal, onUpdate) });
      }
    }
    return tools;
  }
}
